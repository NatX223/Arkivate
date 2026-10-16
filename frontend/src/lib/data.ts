import { NoEntityFoundError } from "@arkiv-network/sdk";
import { key as keyValue, str, u64 } from "@arkiv-network/sdk/attr";
import { eq, gt, type Expression } from "@arkiv-network/sdk/query";
import {
  ENTITY_TYPES,
  PROJECT,
  PublicTriggerSpec,
  SealedTriggerSpec as SealedTriggerSpecSchema,
  type SealedTriggerSpec,
  listWorkers,
  loadTriggers,
  type TriggerRecord,
  type WorkerRecord,
} from "@arkivate/core";
import type { Hex } from "viem";
import { getReader } from "./arkiv";

/**
 * Browser read models. Each one is a handful of `arkiv_query` calls, so pages poll them rather
 * than subscribe: Arkiv has no expiry event (friction F12), so polling is needed anyway.
 */

type AttrMap = Record<string, { value: unknown } | undefined>;
const attrStr = (a: AttrMap, n: string) => (a[n]?.value === undefined ? undefined : String(a[n]!.value));
const attrHex = (a: AttrMap, n: string) => attrStr(a, n) as Hex | undefined;
const attrBig = (a: AttrMap, n: string) => (typeof a[n]?.value === "bigint" ? (a[n]!.value as bigint) : undefined);

const ns = (type: string): Expression[] => [eq("project", str(PROJECT)), eq("entity_type", str(type))];

/** Drain an async iterator of query results, stopping at `max` (pages are fetched lazily). */
async function collect<T>(it: AsyncIterable<T>, max: number): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) {
    out.push(x);
    if (out.length >= max) break;
  }
  return out;
}

// ---- head ------------------------------------------------------------------------------------

export const loadHead = () => getReader().getBlockNumber();

// ---- triggers --------------------------------------------------------------------------------

export interface PublicTrigger extends TriggerRecord {
  mode: "public";
  status: "active" | "paused";
}

export async function loadPublicTriggers(): Promise<{ triggers: PublicTrigger[]; invalid: number }> {
  const reader = getReader();
  const [a, p] = await Promise.all([loadTriggers(reader, "active"), loadTriggers(reader, "paused")]);
  const triggers = [
    ...a.triggers.map((t) => ({ ...t, mode: "public" as const, status: "active" as const })),
    ...p.triggers.map((t) => ({ ...t, mode: "public" as const, status: "paused" as const })),
  ].sort((x, y) => (x.createdAt > y.createdAt ? -1 : 1));
  return { triggers, invalid: a.invalid.length + p.invalid.length };
}

export interface SealedTrigger {
  mode: "sealed";
  key: Hex;
  creator: Hex;
  createdAt: bigint;
  expiresAt: bigint;
  commitment: Hex;
  worker: Hex;
}

export async function loadSealedTriggers(): Promise<SealedTrigger[]> {
  const q = getReader()
    .select({ key: true, creator: true, createdAt: true, expiresAt: true, attributes: true })
    .where(...ns(ENTITY_TYPES.sealed))
    .limit(200);
  const rows = await collect(q, 200);
  return rows
    .map((e) => {
      const a = e.attributes as AttrMap;
      return {
        mode: "sealed" as const,
        key: e.key,
        creator: e.creator,
        createdAt: e.createdAt,
        expiresAt: e.expiresAt,
        commitment: (attrHex(a, "commitment") ?? "0x") as Hex,
        worker: (attrHex(a, "worker") ?? "0x") as Hex,
      };
    })
    .sort((x, y) => (x.createdAt > y.createdAt ? -1 : 1));
}

// ---- receipts --------------------------------------------------------------------------------

export interface Receipt {
  key: Hex;
  creator: Hex;
  createdAt: bigint;
  trigger: Hex;
  mode: "public" | "sealed";
  epoch: string;
  firedBlock: bigint;
  evidenceBlock?: bigint;
  subject?: Hex;
  outcome?: string;
  oldExpiresAt?: bigint;
  newExpiresAt?: bigint;
  summary?: string;
  resultHash?: Hex;
}

export interface ReceiptFilter {
  /** Only receipts fired after this block. */
  sinceBlock?: bigint;
  trigger?: Hex;
  max?: number;
}

export async function loadReceipts(f: ReceiptFilter = {}): Promise<Receipt[]> {
  const where = [...ns(ENTITY_TYPES.receipt)];
  if (f.trigger) where.push(eq("trigger", keyValue(f.trigger)));
  if (f.sinceBlock !== undefined) where.push(gt("fired_block", u64(f.sinceBlock)));
  const q = getReader()
    .select({ key: true, creator: true, createdAt: true, attributes: true, payload: true })
    .where(...where)
    .limit(200);
  const rows = await collect(q, f.max ?? 400);
  return rows
    .map((e): Receipt => {
      const a = e.attributes as AttrMap;
      let body: { summary?: unknown; result_hash?: unknown } = {};
      try {
        body = e.toJson() ?? {};
      } catch {
        // payload is informational; keep the receipt
      }
      const mode = attrStr(a, "mode") === "sealed" ? "sealed" : "public";
      return {
        key: e.key,
        creator: e.creator,
        createdAt: e.createdAt,
        trigger: (attrHex(a, "trigger") ?? "0x") as Hex,
        mode,
        epoch: attrStr(a, "epoch") ?? "",
        firedBlock: attrBig(a, "fired_block") ?? e.createdAt,
        evidenceBlock: attrBig(a, "evidence_block"),
        subject: attrHex(a, "subject"),
        outcome: attrStr(a, "outcome"),
        oldExpiresAt: attrBig(a, "old_expires_at"),
        newExpiresAt: attrBig(a, "new_expires_at"),
        // A sealed receipt's payload is only a result hash; never show anything else for it.
        summary: mode === "public" && typeof body.summary === "string" ? body.summary : undefined,
        resultHash: typeof body.result_hash === "string" ? (body.result_hash as Hex) : undefined,
      };
    })
    .sort((x, y) => (x.firedBlock > y.firedBlock ? -1 : x.firedBlock < y.firedBlock ? 1 : 0));
}

// ---- acceptances -----------------------------------------------------------------------------

export interface Acceptance {
  key: Hex;
  creator: Hex;
  sealed: Hex;
  commitment: Hex;
  acceptedBlock: bigint;
}

export async function loadAcceptances(sealedKey?: Hex): Promise<Acceptance[]> {
  const where = [...ns(ENTITY_TYPES.acceptance)];
  if (sealedKey) where.push(eq("sealed", keyValue(sealedKey)));
  const q = getReader().select({ key: true, creator: true, createdAt: true, attributes: true }).where(...where).limit(200);
  const rows = await collect(q, 400);
  return rows.map((e) => {
    const a = e.attributes as AttrMap;
    return {
      key: e.key,
      creator: e.creator,
      sealed: (attrHex(a, "sealed") ?? "0x") as Hex,
      commitment: (attrHex(a, "commitment") ?? "0x") as Hex,
      acceptedBlock: attrBig(a, "accepted_block") ?? e.createdAt,
    };
  });
}

export interface Reveal {
  key: Hex;
  creator: Hex;
  createdAt: bigint;
  /** The revealed spec, if it parses as a sealed TriggerSpec. Whether it opens the commitment is Verify's job. */
  spec?: SealedTriggerSpec;
}

/** Reveal entities for a sealed key, by anyone; callers keep only the sealed creator's. */
export async function loadReveals(sealedKey: Hex): Promise<Reveal[]> {
  const page = await getReader()
    .select({ key: true, creator: true, createdAt: true, payload: true })
    .where(...ns(ENTITY_TYPES.reveal), eq("sealed", keyValue(sealedKey)))
    .limit(20)
    .fetch();
  return page.entities.map((e) => {
    let spec: SealedTriggerSpec | undefined;
    try {
      const parsed = SealedTriggerSpecSchema.safeParse((e.toJson() as { spec?: unknown }).spec);
      if (parsed.success) spec = parsed.data;
    } catch {
      // not JSON
    }
    return { key: e.key, creator: e.creator, createdAt: e.createdAt, spec };
  });
}

// ---- workers ---------------------------------------------------------------------------------

export interface WorkerHealth {
  ok: boolean;
  name?: string;
  mode?: string;
  triggers?: number;
  watchedEntities?: number;
  sealedJobs?: number;
  telegram?: string;
}

export type HealthState = { state: "online"; health: WorkerHealth } | { state: "offline"; reason: string } | { state: "no-endpoint" };

export interface Worker extends WorkerRecord {
  health: HealthState;
}

/** GET {endpoint}/health straight from the browser (workers send CORS headers on it). */
export async function checkHealth(endpoint: string): Promise<HealthState> {
  if (!endpoint) return { state: "no-endpoint" };
  try {
    const res = await fetch(`${endpoint.replace(/\/$/, "")}/health`, { signal: AbortSignal.timeout(5000), cache: "no-store" });
    if (!res.ok) return { state: "offline", reason: `HTTP ${res.status}` };
    const body = (await res.json()) as WorkerHealth;
    return body.ok ? { state: "online", health: body } : { state: "offline", reason: "reported not ok" };
  } catch (e) {
    return { state: "offline", reason: e instanceof DOMException && e.name === "TimeoutError" ? "timed out" : "unreachable" };
  }
}

export async function loadWorkers(withHealth = true): Promise<Worker[]> {
  const list = await listWorkers(getReader());
  // One registration per worker address: keep the longest-lived if a worker re-registered.
  const byAddr = new Map<string, WorkerRecord>();
  for (const w of list) {
    const prev = byAddr.get(w.creator.toLowerCase());
    if (!prev || w.expiresAt > prev.expiresAt) byAddr.set(w.creator.toLowerCase(), w);
  }
  const unique = [...byAddr.values()].sort((a, b) => a.name.localeCompare(b.name));
  const health = await Promise.all(
    unique.map((w) => (withHealth ? checkHealth(w.endpoint) : Promise.resolve<HealthState>({ state: "no-endpoint" }))),
  );
  return unique.map((w, i) => ({ ...w, health: health[i]! }));
}

export const workerLabel = (workers: readonly WorkerRecord[] | undefined, addr: string) =>
  workers?.find((w) => w.creator.toLowerCase() === addr.toLowerCase())?.name || undefined;

// ---- demo feed (home page live expiry visual) -------------------------------------------------

export interface FeedEntity {
  key: Hex;
  creator: Hex;
  createdAt: bigint;
  expiresAt: bigint;
  kind: string;
}

export async function loadDemoFeed(): Promise<FeedEntity[]> {
  const q = getReader()
    .select({ key: true, creator: true, createdAt: true, expiresAt: true, attributes: true })
    .where(...ns(ENTITY_TYPES.demo_feed))
    .limit(200);
  const rows = await collect(q, 200);
  return rows.map((e) => ({
    key: e.key,
    creator: e.creator,
    createdAt: e.createdAt,
    expiresAt: e.expiresAt,
    kind: attrStr(e.attributes as AttrMap, "kind") ?? "entity",
  }));
}

// ---- single entities -------------------------------------------------------------------------

export interface WatchedEntity {
  key: Hex;
  owner: Hex;
  createdAt: bigint;
  expiresAt: bigint;
  extendable: boolean;
  label: string;
}

/** A live entity (anything a trigger might watch), or undefined if gone. */
export async function loadWatched(k: Hex): Promise<WatchedEntity | undefined> {
  try {
    const e = await getReader().getEntity(k);
    const a = (e.attributes ?? {}) as AttrMap;
    const label = [attrStr(a, "project"), attrStr(a, "kind") ?? attrStr(a, "entity_type")].filter(Boolean).join(" · ");
    return {
      key: e.key!,
      owner: e.owner!,
      createdAt: e.createdAt!,
      expiresAt: e.expiresAt!,
      extendable: Boolean(e.creationFlags?.permissionlessExtension),
      label: label || "entity",
    };
  } catch (err) {
    if (err instanceof NoEntityFoundError) return undefined;
    throw err;
  }
}

export type TriggerEntity =
  | { kind: "public"; trigger: PublicTrigger }
  | { kind: "sealed"; sealed: SealedTrigger }
  | { kind: "invalid"; error: string }
  | { kind: "gone" };

/** Look up a trigger or sealed entity by key. `gone` = expired, deleted or never existed. */
export async function loadTriggerEntity(k: Hex): Promise<TriggerEntity> {
  let e;
  try {
    e = await getReader().getEntity(k);
  } catch (err) {
    if (err instanceof NoEntityFoundError) return { kind: "gone" };
    throw err;
  }
  const a = (e.attributes ?? {}) as AttrMap;
  if (attrStr(a, "project") !== PROJECT) return { kind: "invalid", error: "not an Arkivate entity" };
  const type = attrStr(a, "entity_type");
  if (type === ENTITY_TYPES.sealed) {
    return {
      kind: "sealed",
      sealed: {
        mode: "sealed",
        key: e.key!,
        creator: e.creator!,
        createdAt: e.createdAt!,
        expiresAt: e.expiresAt!,
        commitment: (attrHex(a, "commitment") ?? "0x") as Hex,
        worker: (attrHex(a, "worker") ?? "0x") as Hex,
      },
    };
  }
  if (type !== ENTITY_TYPES.trigger) return { kind: "invalid", error: `this is a ${type ?? "unknown"} entity, not a trigger` };
  let raw: unknown;
  try {
    raw = e.toJson();
  } catch {
    return { kind: "invalid", error: "trigger payload is not JSON" };
  }
  const parsed = PublicTriggerSpec.safeParse(raw);
  if (!parsed.success) return { kind: "invalid", error: parsed.error.issues[0]?.message ?? "invalid spec" };
  return {
    kind: "public",
    trigger: {
      key: e.key!,
      creator: e.creator!,
      createdAt: e.createdAt!,
      expiresAt: e.expiresAt!,
      status: attrStr(a, "status") === "paused" ? "paused" : "active",
      spec: parsed.data,
      mode: "public",
    },
  };
}
