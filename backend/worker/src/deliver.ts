import type { Destination } from "@arkivate/core";
import type { Hex } from "viem";

/**
 * Delivery of sealed alerts. Errors are rewritten so they never contain the webhook URL, the chat
 * ID or the bot token: these strings must not reach logs (or, worse, Arkiv).
 */

export interface Alert {
  sealedKey: Hex;
  /** On-chain (hashed) epoch: also the Idempotency-Key, so receivers can drop duplicates. */
  epoch: Hex;
  firedBlock: bigint;
  evidenceBlock: bigint;
  matchedKeys: Hex[];
  summary: string;
}

const TIMEOUT_MS = 10_000;

export async function deliver(d: Destination, a: Alert, telegramToken: string | undefined): Promise<void> {
  if (d.type === "webhook") return webhook(d.value, a);
  if (!telegramToken) throw new Error("telegram delivery needs TELEGRAM_BOT_TOKEN on this worker");
  return telegram(telegramToken, d.value, a);
}

async function webhook(url: string, a: Alert) {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": a.epoch },
      body: JSON.stringify({
        sealed_key: a.sealedKey,
        epoch: a.epoch,
        fired_block: a.firedBlock.toString(),
        evidence_block: a.evidenceBlock.toString(),
        matched_keys: a.matchedKeys,
        summary: a.summary,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(`webhook unreachable (${e instanceof Error ? e.name : "error"})`);
  }
  if (!res.ok) throw new Error(`webhook responded ${res.status}`);
}

async function telegram(token: string, chatId: string, a: Alert) {
  // Only what the owner already knows: which of their sealed triggers fired, and when.
  const text = `Arkivate: your sealed trigger ${a.sealedKey.slice(0, 10)}… fired at block ${a.firedBlock}`;
  let res: Response;
  try {
    res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(`telegram unreachable (${e instanceof Error ? e.name : "error"})`);
  }
  if (!res.ok) throw new Error(`telegram responded ${res.status}`);
}
