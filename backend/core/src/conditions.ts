import { key as keyValue } from "@arkiv-network/sdk/attr";
import { and, eq, or, render, type Expression } from "@arkiv-network/sdk/query";
import type { Hex } from "viem";
import { compare, conditionExpression, localMatch, type CandidateRow, type QueryFilter } from "./query.js";
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
  /** The watched entity (expiry family). The Reactivate action extends this one. */
  subject?: Hex;
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
 * The rows, among a batch of freshly created keys, that match at least one of `filters`, with
 * everything `localMatch` needs. One fetch serves every on_create trigger and query watch.
 *
 * Gated by the free filtered count: most of the chain's new entities match nothing we watch,
 * and then no billed query is made at all. (A trigger without `created_by` lets every new entity
 * on the chain into the batch.)
 */
export async function fetchCandidates(
  reader: Reader,
  candidates: readonly Hex[],
  filters: readonly QueryFilter[],
  atBlock: bigint,
): Promise<CandidateRow[]> {
  const out: CandidateRow[] = [];
  if (filters.length === 0) return out;
  const any = or(filters.map((f) => conditionExpression(f)));
  for (let i = 0; i < candidates.length; i += CANDIDATE_CHUNK) {
    const chunk = candidates.slice(i, i + CANDIDATE_CHUNK);
    const expr = and([or(chunk.map((k) => eq("$key", keyValue(k)))), any]);
    if ((await countMatching(reader, expr, atBlock)) === 0) continue;
    const page = await reader
      .select({ key: true, creator: true, createdAt: true, expiresAt: true, attributes: true })
      .where(expr)
      .limit(CANDIDATE_CHUNK)
      .fetch();
    for (const e of page.entities) {
      out.push({
        key: e.key,
        creator: e.creator,
        createdAt: e.createdAt,
        expiresAt: e.expiresAt,
        attributes: e.attributes as CandidateRow["attributes"],
      });
    }
  }
  return out;
}

/**
 * Which of these rows match `filter`? Decided locally where that's exact; for the rest, one
 * query to the node (the old per-trigger path), so the answer is always the node's.
 */
export async function matchRows(reader: Reader, filter: QueryFilter, rows: readonly CandidateRow[]): Promise<CandidateRow[]> {
  const yes: CandidateRow[] = [];
  const unsure: CandidateRow[] = [];
  for (const r of rows) {
    const m = localMatch(r, filter);
    if (m === true) yes.push(r);
    else if (m === undefined) unsure.push(r);
  }
  for (let i = 0; i < unsure.length; i += CANDIDATE_CHUNK) {
    const chunk = unsure.slice(i, i + CANDIDATE_CHUNK);
    const page = await reader
      .select({ key: true })
      .where(conditionExpression(filter, [or(chunk.map((r) => eq("$key", keyValue(r.key))))]))
      .limit(CANDIDATE_CHUNK)
      .fetch();
    const hit = new Set(page.entities.map((e) => e.key.toLowerCase()));
    yes.push(...chunk.filter((r) => hit.has(r.key.toLowerCase())));
  }
  return yes;
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
): Promise<{ firing: Firing | undefined; dueAt: bigint }> {
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
  const silence = BigInt(cond.silence_blocks);
  // The first block at which this could be silent, if nothing newer arrives.
  const dueAt = newest ? newest.createdAt + silence + 1n : head;
  if (newest && head - newest.createdAt <= silence) return { firing: undefined, dueAt };
  return {
    dueAt,
    firing: {
      // One firing per silence episode: the episode is identified by the last thing we heard.
      epoch: `silence:${newest?.key ?? "none"}`,
      evidenceBlock: head,
      matchedKeys: newest ? [newest.key] : [],
      summary: newest
        ? `silent for ${head - newest.createdAt} blocks (> ${cond.silence_blocks}); last ${newest.key} at block ${newest.createdAt}`
        : `no live matching entity from ${cond.created_by}`,
    },
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
