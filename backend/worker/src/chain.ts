import { ExpirationTime, jsonToPayload } from "@arkiv-network/sdk";
import { eq } from "@arkiv-network/sdk/query";
import { str } from "@arkiv-network/sdk/attr";
import {
  DEAD,
  ENTITY_TYPES,
  PROJECT,
  WORKER_VERSION,
  receiptAttributes,
  workerAttributes,
  type PublicReceiptPayload,
  type ReceiptFields,
  type Reader,
  type WorkerPayload,
} from "@arkivate/core";
import type { Wallet } from "@arkivate/core/server";
import type { Hex } from "viem";

/**
 * Every write the worker makes. Writes are serialised through one queue: `predictEntityKeys` is
 * derived from the account nonce, so two concurrent create+burn batches would predict the same
 * key and the second would burn the wrong entity (or fail).
 */
export class ChainWriter {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly reader: Reader,
    private readonly wallet: Wallet,
  ) {}

  get address(): Hex {
    return this.wallet.account.address;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Create-or-refresh our `worker` registration (1-day life; heartbeat extends it). */
  register(payload: WorkerPayload, modes: readonly string[]) {
    return this.serial(async () => {
      const page = await this.reader
        .select({ key: true, payload: true })
        .where(eq("project", str(PROJECT)), eq("entity_type", str(ENTITY_TYPES.worker)))
        .createdBy(this.address)
        .limit(1)
        .fetch();
      const existing = page.entities[0];
      if (!existing) {
        const created = await this.wallet.createEntity({
          payload: jsonToPayload(payload),
          contentType: "application/json",
          attributes: workerAttributes(WORKER_VERSION, modes),
          expires: ExpirationTime.fromDays(1),
        });
        return { key: created.entityKey, tx: created.txHash, action: "created" as const };
      }
      // Keep payload/attributes current (endpoint may change between deploys), then extend.
      await this.wallet.patchEntity({
        entityKey: existing.key,
        payload: jsonToPayload(payload),
        set: workerAttributes(WORKER_VERSION, modes),
      });
      const ext = await this.wallet.extendEntity({
        entityKey: existing.key,
        expires: ExpirationTime.fromDays(1),
      });
      return { key: existing.key, tx: ext.txHash, action: "extended" as const };
    });
  }

  heartbeat(workerKey: Hex) {
    return this.serial(() =>
      this.wallet.extendEntity({ entityKey: workerKey, expires: ExpirationTime.fromDays(1) }),
    );
  }

  /**
   * Receipt = readonly create + ownership burn to 0x…dEaD, atomically, so it can never vanish.
   * With `extension` (Reactivate), the extend rides in the same batch: the entity is extended if
   * and only if the receipt exists.
   */
  writeReceipt(
    fields: ReceiptFields,
    body: PublicReceiptPayload,
    extension?: { entityKey: Hex; expiresAt: bigint },
  ) {
    return this.serial(async () => {
      const [predicted] = await this.reader.predictEntityKeys({ owner: this.address, count: 1 });
      if (!predicted) throw new Error("predictEntityKeys returned nothing");
      const batch = await this.wallet.executeBatch({
        creates: [
          {
            salt: predicted.salt,
            payload: jsonToPayload(body),
            contentType: "application/json",
            attributes: receiptAttributes(fields),
            expires: ExpirationTime.fromDays(30),
            flags: { readonly: true, permissionlessExtension: true },
          },
        ],
        ...(extension
          ? { extensions: [{ entityKey: extension.entityKey, expires: ExpirationTime.atBlock(extension.expiresAt) }] }
          : {}),
        ownershipChanges: [{ entityKey: predicted.key, newOwner: DEAD }],
      });
      if (!batch.createdEntities.includes(predicted.key)) {
        throw new Error(`receipt key mismatch: predicted ${predicted.key}, got ${batch.createdEntities.join(",")}`);
      }
      return { key: predicted.key, tx: batch.txHash };
    });
  }
}
