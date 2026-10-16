import { destinationDigest, handoffMessage, type Destination } from "@arkivate/core";
import type { Hex } from "viem";
import type { SealedFile } from "./sealedStore";
import type { Wallet } from "./wallet";

export interface HandoffResult {
  acceptance_key?: Hex;
  tx?: Hex;
  idempotent?: boolean;
}

export class HandoffError extends Error {
  constructor(
    message: string,
    readonly unreachable: boolean,
  ) {
    super(message);
  }
}

/**
 * The private hand-off, same as `arkivate seal`: the sealed creator signs a message binding the
 * sealed key, commitment, worker and destination digest, then POSTs spec + salt + destination
 * straight to the worker. None of it touches Arkiv; the worker answers with its acceptance.
 */
export async function sendHandoff(f: SealedFile, destination: Destination, wallet: Wallet, onSigned?: () => void): Promise<HandoffResult> {
  const signature = await wallet.signMessage({
    account: wallet.account,
    message: handoffMessage({
      sealedKey: f.sealed_key,
      commitment: f.commitment,
      workerAddress: f.worker,
      destinationDigest: destinationDigest(destination),
    }),
  });
  onSigned?.();
  let res: Response;
  try {
    res = await fetch(`${f.endpoint.replace(/\/$/, "")}/sealed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sealed_key: f.sealed_key, spec: f.spec, salt: f.salt, destination, signature }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new HandoffError(`couldn't reach ${f.endpoint}`, true);
  }
  const body = (await res.json().catch(() => ({}))) as HandoffResult & { error?: string };
  if (!res.ok) throw new HandoffError(`worker refused the hand-off (${res.status}): ${body.error ?? "no reason given"}`, res.status >= 502);
  return body;
}
