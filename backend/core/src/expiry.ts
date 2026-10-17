import { key as keyValue } from "@arkiv-network/sdk/attr";
import { eq, or } from "@arkiv-network/sdk/query";
import type { Hex } from "viem";
import { conditionExpression, type QueryFilter } from "./query.js";
import type { Reader } from "./reader.js";
import type { Watch } from "./spec.js";

/**
 * Read helpers for the expiry family (on_expiring / on_expire / on_extend / on_delete).
 *
 * Arkiv emits no expiration event, so expiry is detected by comparing deadlines with the head and
 * re-reading. A read that finds nothing cannot say *why* (never existed, deleted or expired: all
 * `NoEntityFoundError`), so callers combine it with what they saw: a `EntityDeleted` event, or the
 * timing (an entity gone *before* its `expiresAt` cannot have expired, so it was deleted).
 */

export interface LiveEntity {
  key: Hex;
  owner: Hex;
  expiresAt: bigint;
  permissionlessExtension: boolean;
}

/**
 * One entity by key, or `undefined` if no live entity has it (deleted, expired or never existed).
 * A projected query, not `getEntity`: that one always selects `*`, payload included, and this
 * runs on every expiry sweep.
 */
export async function readLive(reader: Reader, entityKey: Hex): Promise<LiveEntity | undefined> {
  const page = await reader
    .select({ key: true, owner: true, expiresAt: true, creationFlags: true })
    .where(eq("$key", keyValue(entityKey)))
    .limit(1)
    .fetch();
  const e = page.entities[0];
  if (!e) return undefined;
  return {
    key: e.key,
    owner: e.owner,
    expiresAt: e.expiresAt,
    permissionlessExtension: e.creationFlags.permissionlessExtension,
  };
}

/**
 * Many entities by key in one query per 50 keys (each `arkiv_query` costs the same 100 units
 * whether it returns one entity or fifty). Keys missing from the result are not live.
 */
export async function readLiveMany(reader: Reader, keys: Iterable<Hex>, atBlock?: bigint): Promise<Map<Hex, LiveEntity>> {
  const out = new Map<Hex, LiveEntity>();
  const all = [...new Set([...keys].map((k) => k.toLowerCase() as Hex))];
  for (let i = 0; i < all.length; i += 50) {
    const chunk = all.slice(i, i + 50);
    let q = reader
      .select({ key: true, owner: true, expiresAt: true, creationFlags: true })
      .where(or(chunk.map((k) => eq("$key", keyValue(k)))))
      .limit(50);
    if (atBlock !== undefined) q = q.atBlock(atBlock);
    const page = await q.fetch();
    for (const e of page.entities) {
      out.set(e.key.toLowerCase() as Hex, {
        key: e.key,
        owner: e.owner,
        expiresAt: e.expiresAt,
        permissionlessExtension: e.creationFlags.permissionlessExtension,
      });
    }
  }
  return out;
}

export interface WatchedSnapshot {
  key: Hex;
  expiresAt: bigint;
}

/**
 * Every live entity a watch covers, read at one pinned block so pages are consistent. Pass
 * `known` (from one `readLiveMany` over every entity-key watch) to skip the per-key read.
 */
export async function snapshotWatch(
  reader: Reader,
  watch: Watch,
  atBlock: bigint,
  known?: Map<Hex, LiveEntity>,
): Promise<WatchedSnapshot[]> {
  if ("entity_key" in watch) {
    const k = watch.entity_key.toLowerCase() as Hex;
    const e = known ? known.get(k) : await readLive(reader, k);
    return e ? [{ key: e.key, expiresAt: e.expiresAt }] : [];
  }
  const out: WatchedSnapshot[] = [];
  const query = reader
    .select({ key: true, expiresAt: true })
    .where(conditionExpression(watch))
    .atBlock(atBlock)
    .limit(200);
  for await (const e of query) out.push({ key: e.key, expiresAt: e.expiresAt });
  return out;
}

/** Of these freshly created keys, which does a query watch cover? (WS `EntityCreated` path.) */
export async function matchWatchCandidates(
  reader: Reader,
  watch: QueryFilter,
  candidates: readonly Hex[],
): Promise<WatchedSnapshot[]> {
  const out: WatchedSnapshot[] = [];
  for (let i = 0; i < candidates.length; i += 50) {
    const chunk = candidates.slice(i, i + 50);
    const page = await reader
      .select({ key: true, expiresAt: true })
      .where(conditionExpression(watch, [or(chunk.map((k) => eq("$key", keyValue(k))))]))
      .limit(50)
      .fetch();
    for (const e of page.entities) out.push({ key: e.key, expiresAt: e.expiresAt });
  }
  return out;
}

/** Dedupe epochs for the expiry family: one receipt per (trigger, epoch). */
export const expiryEpoch = {
  expiring: (k: Hex, deadline: bigint) => `expiring:${k}:${deadline}`,
  expire: (k: Hex, deadline: bigint) => `expire:${k}:${deadline}`,
  extend: (k: Hex, newExpiresAt: bigint) => `extend:${k}:${newExpiresAt}`,
  delete: (k: Hex) => `delete:${k}`,
};
