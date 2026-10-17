import { key, str } from "@arkiv-network/sdk/attr";
import { and, eq, or } from "@arkiv-network/sdk/query";
import type { Hex } from "viem";
import { countMatching } from "./conditions.js";
import { ENTITY_TYPES, PROJECT } from "./constants.js";
import type { Reader } from "./reader.js";
import { PublicTriggerSpec, type TriggerSpec } from "./spec.js";

/** Read-side helpers for Arkivate entities. Browser-safe: they only need a Reader. */

const ns = (type: string) => [eq("project", str(PROJECT)), eq("entity_type", str(type))];

/**
 * Payloads by entity key, so list reads never re-download a payload they already have. Payloads
 * are the bulk of a response and Arkiv bills by response size (arkiv/friction.md F20).
 * A payload only changes with a patch, which moves `updatedAt`; readonly entities (receipts,
 * acceptances, reveals) never change, so for them the key alone is enough.
 */
export type PayloadCache = Map<Hex, CachedPayload>;

export interface CachedPayload {
  /** Undefined for immutable (readonly) entities. */
  updatedAt?: bigint | undefined;
  /** Parsed JSON, or undefined if the payload isn't JSON. */
  json: unknown;
}

const PAYLOAD_CHUNK = 50;

/**
 * Fill `cache` for these rows, fetching only payloads that are missing or stale. One query per
 * 50 keys, selecting just key + updatedAt + payload.
 */
export async function fetchPayloads(
  reader: Reader,
  rows: readonly { key: Hex; updatedAt?: bigint | undefined }[],
  cache: PayloadCache,
): Promise<PayloadCache> {
  const need = rows.filter((r) => {
    const c = cache.get(r.key);
    return !c || (r.updatedAt !== undefined && c.updatedAt !== r.updatedAt);
  });
  for (let i = 0; i < need.length; i += PAYLOAD_CHUNK) {
    const chunk = need.slice(i, i + PAYLOAD_CHUNK);
    const page = await reader
      .select({ key: true, updatedAt: true, payload: true })
      .where(or(chunk.map((r) => eq("$key", key(r.key)))))
      .limit(PAYLOAD_CHUNK)
      .fetch();
    const tracked = new Map(chunk.map((r) => [r.key.toLowerCase(), r.updatedAt !== undefined]));
    for (const e of page.entities) {
      let json: unknown;
      try {
        json = e.toJson();
      } catch {
        json = undefined;
      }
      cache.set(e.key, { updatedAt: tracked.get(e.key.toLowerCase()) ? e.updatedAt : undefined, json });
    }
  }
  return cache;
}

/** Drop cached payloads for keys no longer listed (expired or deleted). */
export function pruneCache(cache: PayloadCache, live: Iterable<Hex>) {
  const keep = new Set([...live].map((k) => k.toLowerCase()));
  for (const k of cache.keys()) if (!keep.has(k.toLowerCase())) cache.delete(k);
}

export interface TriggerRecord {
  key: Hex;
  creator: Hex;
  createdAt: bigint;
  expiresAt: bigint;
  status: string;
  spec: TriggerSpec;
  /** `sealed`: a private job this worker accepted (key = the sealed entity's key). */
  mode?: "public" | "sealed";
}

export interface InvalidTrigger {
  key: Hex;
  error: string;
}

/**
 * Every live public trigger with the given status. Anyone can post one, so each payload is
 * re-validated; invalid ones are returned separately rather than thrown.
 *
 * Two reads: the list (no payloads), then payloads only for triggers that are new or were patched
 * since `cache` saw them. Pass the same cache every time; without one, every payload is fetched.
 */
export async function loadTriggers(
  reader: Reader,
  status: "active" | "paused" = "active",
  cache: PayloadCache = new Map(),
): Promise<{ triggers: TriggerRecord[]; invalid: InvalidTrigger[] }> {
  const triggers: TriggerRecord[] = [];
  const invalid: InvalidTrigger[] = [];
  const rows = [];
  const query = reader
    .select({ key: true, creator: true, createdAt: true, updatedAt: true, expiresAt: true })
    .where(...ns(ENTITY_TYPES.trigger), eq("status", str(status)))
    .limit(200);
  for await (const e of query) rows.push(e);
  await fetchPayloads(reader, rows, cache);
  for (const e of rows) {
    const raw = cache.get(e.key)?.json;
    if (raw === undefined) {
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

/**
 * Free change detection (`arkiv_getEntityCount` costs nothing; a query costs 100 units): how many
 * live triggers with this status, and worker registrations, exist. A worker compares these with
 * what it last loaded and only re-lists when they differ.
 */
export async function countTriggers(reader: Reader, status: "active" | "paused", atBlock: bigint): Promise<number> {
  return countMatching(reader, and([...ns(ENTITY_TYPES.trigger), eq("status", str(status))]), atBlock);
}

export async function countWorkers(reader: Reader, atBlock: bigint): Promise<number> {
  return countMatching(reader, and(ns(ENTITY_TYPES.worker)), atBlock);
}

export interface ReceiptRef {
  key: Hex;
  creator: Hex;
  firedBlock: bigint | undefined;
}

/**
 * Receipts written for (trigger, epoch), by anyone. Callers decide whose receipts they trust.
 * Asks the (free) filtered count first: almost always there is no receipt yet, and then no
 * billed query is made at all.
 */
export async function findReceipts(reader: Reader, trigger: Hex, epoch: string): Promise<ReceiptRef[]> {
  const filter = [...ns(ENTITY_TYPES.receipt), eq("trigger", key(trigger)), eq("epoch", str(epoch))];
  if ((await countMatching(reader, and(filter), await reader.getBlockNumber())) === 0) return [];
  const page = await reader
    .select({ key: true, creator: true, attributes: { fired_block: true } })
    .where(...filter)
    // One receipt per (trigger, epoch) is the norm; a few more only after a race.
    .limit(10)
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

/**
 * Receipts for one watched entity under one trigger with a given outcome, e.g. every `extended`
 * receipt so far, to enforce `max_extensions` across all workers.
 */
export async function findSubjectReceipts(
  reader: Reader,
  trigger: Hex,
  subject: Hex,
  outcome: string,
): Promise<ReceiptRef[]> {
  const out: ReceiptRef[] = [];
  const filter = [
    ...ns(ENTITY_TYPES.receipt),
    eq("trigger", key(trigger)),
    eq("subject", key(subject)),
    eq("outcome", str(outcome)),
  ];
  // Free count first; the billed query only runs when there is something to list.
  if ((await countMatching(reader, and(filter), await reader.getBlockNumber())) === 0) return out;
  const query = reader
    .select({ key: true, creator: true, attributes: { fired_block: true } })
    .where(...filter)
    .limit(200);
  for await (const e of query) {
    const fired = e.attributes.fired_block;
    out.push({ key: e.key, creator: e.creator, firedBlock: fired && typeof fired.value === "bigint" ? fired.value : undefined });
  }
  return out;
}

export interface WorkerRecord {
  key: Hex;
  creator: Hex;
  expiresAt: bigint;
  name: string;
  endpoint: string;
}

/**
 * Live worker registrations. A worker whose entity expired (missed heartbeats) is gone.
 * Payloads (name, endpoint) come from `cache` unless the registration was patched since.
 */
export async function listWorkers(reader: Reader, cache: PayloadCache = new Map()): Promise<WorkerRecord[]> {
  const rows = [];
  const query = reader
    .select({ key: true, creator: true, updatedAt: true, expiresAt: true })
    .where(...ns(ENTITY_TYPES.worker))
    .limit(200);
  for await (const e of query) rows.push(e);
  await fetchPayloads(reader, rows, cache);
  return rows.map((e) => {
    // The payload is informational only: keep the registration even if it isn't JSON.
    const body = (cache.get(e.key)?.json ?? {}) as { name?: unknown; endpoint?: unknown };
    return {
      key: e.key,
      creator: e.creator,
      expiresAt: e.expiresAt,
      name: typeof body.name === "string" ? body.name : "",
      endpoint: typeof body.endpoint === "string" ? body.endpoint : "",
    };
  });
}
