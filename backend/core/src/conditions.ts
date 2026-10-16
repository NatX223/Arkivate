import { key as keyValue } from "@arkiv-network/sdk/attr";
import { eq, or, render, type Expression } from "@arkiv-network/sdk/query";
import type { Hex } from "viem";
import { compare, conditionExpression } from "./query.js";
import type { Reader } from "./reader.js";
import type { OnCount, OnCreate, OnSilence } from "./spec.js";
import type { z } from "zod";

type OnCreateCond = z.infer<typeof OnCreate>;
type OnSilenceCond = z.infer<typeof OnSilence>;
type OnCountCond = z.infer<typeof OnCount>;

/** A decision to fire. `epoch` is the dedupe key: one receipt per (trigger, epoch). */
export interface Firing {
  epoch: string;
  evidenceBlock: bigint;
  matchedKeys: Hex[];
  summary: string;
}

export interface Match {
  key: Hex;
  createdAt: bigint;
}

const CANDIDATE_CHUNK = 50;

/**
 * on_create, push path: of these freshly created keys (from `EntityCreated` events), which match?
 * The node evaluates the filter, so we only ever send one query per chunk of candidates.
 */
export async function matchCandidates(
  reader: Reader,
  cond: OnCreateCond,
  candidates: readonly Hex[],
): Promise<Match[]> {
  const out: Match[] = [];
  for (let i = 0; i < candidates.length; i += CANDIDATE_CHUNK) {
    const chunk = candidates.slice(i, i + CANDIDATE_CHUNK);
    const keys = or(chunk.map((k) => eq("$key", keyValue(k))));
    const page = await reader
      .select({ key: true, createdAt: true })
      .where(conditionExpression(cond, [keys]))
      .limit(CANDIDATE_CHUNK)
      .fetch();
    for (const e of page.entities) out.push({ key: e.key, createdAt: e.createdAt });
  }
  return out;
}

/**
 * on_create, pull path (catch-up for dropped WS events): the newest matches created after
 * `sinceBlock`. Bounded to one page — anything older is assumed handled by earlier passes.
 */
export async function recentMatches(
  reader: Reader,
  cond: OnCreateCond,
  sinceBlock: bigint,
  limit = 50,
): Promise<Match[]> {
  const page = await reader
    .select({ key: true, createdAt: true })
    .where(conditionExpression(cond))
    .limit(limit)
    .fetch();
  return page.entities
    .map((e) => ({ key: e.key, createdAt: e.createdAt }))
    .filter((m) => m.createdAt > sinceBlock);
}

export const onCreateFiring = (m: Match): Firing => ({
  epoch: `create:${m.key}`,
  evidenceBlock: m.createdAt,
  matchedKeys: [m.key],
  summary: `new matching entity ${m.key} at block ${m.createdAt}`,
});

/**
 * on_silence: fires when the newest matching entity *created by the trusted creator* is older than
 * `silence_blocks` (or none is live). Uses creation block, never expiry, so anyone extending an old
 * heartbeat cannot mask silence (extension-attack defence).
 *
 * Result order is not documented by the SDK, so take the max createdAt over a page rather than
 * trusting `limit(1)` to be the newest.
 */
export async function evalOnSilence(
  reader: Reader,
  cond: OnSilenceCond,
  head: bigint,
): Promise<Firing | undefined> {
  const page = await reader
    .select({ key: true, createdAt: true })
    .where(conditionExpression(cond))
    .limit(50)
    .atBlock(head)
    .fetch();
  let newest: Match | undefined;
  for (const e of page.entities) {
    if (!newest || e.createdAt > newest.createdAt) newest = { key: e.key, createdAt: e.createdAt };
  }
  if (newest && head - newest.createdAt <= BigInt(cond.silence_blocks)) return undefined;
  return {
    // One firing per silence episode: the episode is identified by the last thing we heard.
    epoch: `silence:${newest?.key ?? "none"}`,
    evidenceBlock: head,
    matchedKeys: newest ? [newest.key] : [],
    summary: newest
      ? `silent for ${head - newest.createdAt} blocks (> ${cond.silence_blocks}); last ${newest.key} at block ${newest.createdAt}`
      : `no live matching entity from ${cond.created_by}`,
  };
}

/**
 * Filtered entity count via the raw `arkiv_getEntityCount` RPC — the SDK's `getEntityCount()` is
 * chain-wide only. Param shape must be exactly `[{ query, atBlock }]`: an unknown key is silently
 * ignored and returns the chain-wide count (arkiv/friction.md F4).
 */
export async function countMatching(reader: Reader, expr: Expression, atBlock: bigint): Promise<number> {
  const request = reader.request as unknown as (args: {
    method: string;
    params: unknown[];
  }) => Promise<number | string>;
  const result = await request({
    method: "arkiv_getEntityCount",
    params: [{ query: render(expr), atBlock: `0x${atBlock.toString(16)}` }],
  });
  return Number(result);
}

/** Blocks per on_count epoch: while the threshold holds, fire at most once per bucket (~1 h). */
export const COUNT_BUCKET_BLOCKS = 1800n;

export async function evalOnCount(
  reader: Reader,
  cond: OnCountCond,
  head: bigint,
): Promise<Firing | undefined> {
  const count = await countMatching(reader, conditionExpression(cond), head);
  if (!compare(count, cond.count_op, cond.count_value)) return undefined;
  return {
    epoch: `count:${head / COUNT_BUCKET_BLOCKS}`,
    evidenceBlock: head,
    matchedKeys: [],
    summary: `count ${count} ${cond.count_op} ${cond.count_value} at block ${head}`,
  };
}
