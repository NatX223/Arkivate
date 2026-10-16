import { key, str } from "@arkiv-network/sdk/attr";
import { eq } from "@arkiv-network/sdk/query";
import type { Hex } from "viem";
import { ENTITY_TYPES, PROJECT } from "./constants.js";
import type { Reader } from "./reader.js";
import { PublicTriggerSpec, type PublicTriggerSpec as Spec } from "./spec.js";

/** Read-side helpers for Arkivate entities. Browser-safe: they only need a Reader. */

const ns = (type: string) => [eq("project", str(PROJECT)), eq("entity_type", str(type))];

export interface TriggerRecord {
  key: Hex;
  creator: Hex;
  createdAt: bigint;
  expiresAt: bigint;
  status: string;
  spec: Spec;
}

export interface InvalidTrigger {
  key: Hex;
  error: string;
}

/**
 * Every live public trigger with the given status. Anyone can post one, so each payload is
 * re-validated; invalid ones are returned separately rather than thrown.
 */
export async function loadTriggers(
  reader: Reader,
  status: "active" | "paused" = "active",
): Promise<{ triggers: TriggerRecord[]; invalid: InvalidTrigger[] }> {
  const triggers: TriggerRecord[] = [];
  const invalid: InvalidTrigger[] = [];
  const query = reader
    .select({ key: true, creator: true, createdAt: true, expiresAt: true, payload: true })
    .where(...ns(ENTITY_TYPES.trigger), eq("status", str(status)))
    .limit(200);
  for await (const e of query) {
    let raw: unknown;
    try {
      raw = e.toJson();
    } catch {
      invalid.push({ key: e.key, error: "payload is not JSON" });
      continue;
    }
    const parsed = PublicTriggerSpec.safeParse(raw);
    if (!parsed.success) {
      invalid.push({ key: e.key, error: parsed.error.issues[0]?.message ?? "invalid spec" });
      continue;
    }
    triggers.push({
      key: e.key,
      creator: e.creator,
      createdAt: e.createdAt,
      expiresAt: e.expiresAt,
      status,
      spec: parsed.data,
    });
  }
  return { triggers, invalid };
}

export interface ReceiptRef {
  key: Hex;
  creator: Hex;
  firedBlock: bigint | undefined;
}

/** Receipts written for (trigger, epoch), by anyone. Callers decide whose receipts they trust. */
export async function findReceipts(reader: Reader, trigger: Hex, epoch: string): Promise<ReceiptRef[]> {
  const page = await reader
    .select({ key: true, creator: true, attributes: { fired_block: true } })
    .where(...ns(ENTITY_TYPES.receipt), eq("trigger", key(trigger)), eq("epoch", str(epoch)))
    .limit(50)
    .fetch();
  return page.entities.map((e) => {
    const fired = e.attributes.fired_block;
    return {
      key: e.key,
      creator: e.creator,
      firedBlock: fired && typeof fired.value === "bigint" ? fired.value : undefined,
    };
  });
}

export interface WorkerRecord {
  key: Hex;
  creator: Hex;
  expiresAt: bigint;
  name: string;
  endpoint: string;
}

/** Live worker registrations. A worker whose entity expired (missed heartbeats) is gone. */
export async function listWorkers(reader: Reader): Promise<WorkerRecord[]> {
  const out: WorkerRecord[] = [];
  const query = reader
    .select({ key: true, creator: true, expiresAt: true, payload: true })
    .where(...ns(ENTITY_TYPES.worker))
    .limit(200);
  for await (const e of query) {
    let body: { name?: unknown; endpoint?: unknown } = {};
    try {
      body = e.toJson();
    } catch {
      // keep the registration; the payload is informational only
    }
    out.push({
      key: e.key,
      creator: e.creator,
      expiresAt: e.expiresAt,
      name: typeof body.name === "string" ? body.name : "",
      endpoint: typeof body.endpoint === "string" ? body.endpoint : "",
    });
  }
  return out;
}
