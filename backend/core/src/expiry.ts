import { NoEntityFoundError } from "@arkiv-network/sdk";
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

/** One entity by key, or `undefined` if no live entity has it (deleted, expired or never existed). */
export async function readLive(reader: Reader, entityKey: Hex): Promise<LiveEntity | undefined> {
  try {
    const e = await reader.getEntity(entityKey);
    return {
      key: e.key,
      owner: e.owner,
      expiresAt: e.expiresAt,
      permissionlessExtension: e.creationFlags.permissionlessExtension,
    };
  } catch (err) {
    if (err instanceof NoEntityFoundError) return undefined;
    throw err;
  }
}

export interface WatchedSnapshot {
  key: Hex;
  expiresAt: bigint;
}

/** Every live entity a watch covers, read at one pinned block so pages are consistent. */
export async function snapshotWatch(reader: Reader, watch: Watch, atBlock: bigint): Promise<WatchedSnapshot[]> {
  if ("entity_key" in watch) {
    const e = await readLive(reader, watch.entity_key as Hex);
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
