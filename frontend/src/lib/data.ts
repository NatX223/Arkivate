import { NoEntityFoundError } from "@arkiv-network/sdk";
import { key as keyValue, str } from "@arkiv-network/sdk/attr";
import { eq, type Expression } from "@arkiv-network/sdk/query";
import {
  ENTITY_TYPES,
  PROJECT,
  PublicTriggerSpec,
  SealedTriggerSpec as SealedTriggerSpecSchema,
  backoffMs,
  fetchPayloads,
  isRateLimited,
  type PayloadCache,
  type SealedTriggerSpec,
  type TriggerRecord,
  type WorkerRecord,
} from "@arkivate/core";
import type { Hex } from "viem";
import { getReader } from "./arkiv";
import { BLOCK_SECONDS } from "./format";
import { decodeSnapshot, type Snapshot } from "./snapshot";

/**
 * Browser read models. List data comes from one shared server-side snapshot (`/api/snapshot`),
 * fetched at most every SNAPSHOT_TTL_MS by this tab, whatever page or component asks. Only
 * one-entity reads (an unknown key, a key you just changed) go to Arkiv through `/api/rpc`.
 * Every `arkiv_query` costs the access key 100 units (arkiv/friction.md F20).
 */

type AttrMap = Record<string, { value: unknown } | undefined>;
const attrStr = (a: AttrMap, n: string) => (a[n]?.value === undefined ? undefined : String(a[n]!.value));
const attrHex = (a: AttrMap, n: string) => attrStr(a, n) as Hex | undefined;
const attrBig = (a: AttrMap, n: string) => (typeof a[n]?.value === "bigint" ? (a[n]!.value as bigint) : undefined);

const ns = (type: string): Expression[] => [eq("project", str(PROJECT)), eq("entity_type", str(type))];

// ---- snapshot --------------------------------------------------------------------------------

const SNAPSHOT_TTL_MS = 20_000;

let snap: { data: Snapshot; at: number; headAt: number } | undefined;
let inflight: Promise<Snapshot> | undefined;
let failures = 0;
let retryAt = 0;
let lastError: unknown;

async function fetchSnapshot(): Promise<Snapshot> {
  const res = await fetch("/api/snapshot", { cache: "no-store" });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw Object.assign(new Error(`${res.status}: ${body.error ?? res.statusText}`), { status: res.status });
  }
  const data = decodeSnapshot(await res.text());
  // A CDN copy is `Age` seconds older than the server's headAgeMs says.
  const age = Number(res.headers.get("age") ?? 0) * 1000;
  snap = { data, at: Date.now(), headAt: Date.now() - data.headAgeMs - (Number.isFinite(age) ? age : 0) };
  failures = 0;
  retryAt = 0;
  return data;
}

/**
 * The shared snapshot: from memory if fresh, else one fetch for every caller. On failure it
 * backs off 30 s → 60 s → … 10 min (never a tight loop) and keeps serving the last good copy;
 * it only throws when there has never been one.
 */
export async function loadSnapshot(): Promise<Snapshot> {
  const now = Date.now();
  if (snap && now - snap.at < SNAPSHOT_TTL_MS) return snap.data;
  if (now < retryAt) {
    if (snap) return snap.data;
    throw lastError;
  }
  inflight ??= fetchSnapshot()
    .catch((e: unknown) => {
      failures++;
      lastError = e;
      retryAt = Date.now() + (isRateLimited(e) || (e as { status?: number }).status === 429 ? backoffMs(failures) : Math.min(backoffMs(failures), 60_000));
      if (snap) return snap.data;
      throw e;
    })
    .finally(() => (inflight = undefined));
  return inflight;
}

/** Keys this tab just wrote to: read them from Arkiv directly for a while, not the snapshot. */
const dirty = new Map<string, number>();
const DIRTY_MS = 3 * 60_000;
export function markChanged(k: Hex) {
  dirty.set(k.toLowerCase(), Date.now() + DIRTY_MS);
}
const isDirty = (k: Hex | undefined) => !!k && (dirty.get(k.toLowerCase()) ?? 0) > Date.now();

// ---- head ------------------------------------------------------------------------------------

/** The head, extrapolated from the snapshot's at ~1 block per BLOCK_SECONDS: no extra reads. */
export async function loadHead(): Promise<bigint> {
  const s = await loadSnapshot();
  const elapsed = snap ? Math.max(0, Date.now() - snap.headAt) : 0;
  return s.head + BigInt(Math.floor(elapsed / (BLOCK_SECONDS * 1000)));
}

// ---- triggers --------------------------------------------------------------------------------

export interface PublicTrigger extends TriggerRecord {
  mode: "public";
  status: "active" | "paused";
}

export async function loadPublicTriggers(): Promise<{ triggers: PublicTrigger[]; invalid: number }> {
  const s = await loadSnapshot();
  return { triggers: s.pub, invalid: s.invalid };
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
  return (await loadSnapshot()).sealed;
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

/** Receipts are readonly: each payload (summary or result hash) is fetched once, ever. */
const receiptPayloads: PayloadCache = new Map();

/** Receipts for one trigger straight from Arkiv (just after a change in this tab). */
async function rpcReceipts(trigger: Hex, max: number): Promise<Receipt[]> {
  const reader = getReader();
  const page = await reader
    .select({ key: true, creator: true, createdAt: true, attributes: true })
    .where(...ns(ENTITY_TYPES.receipt), eq("trigger", keyValue(trigger)))
    .limit(Math.min(max, 200))
    .fetch();
  await fetchPayloads(reader, page.entities.map((e) => ({ key: e.key })), receiptPayloads);
  return page.entities.map((e): Receipt => {
    const a = e.attributes as AttrMap;
    const body = (receiptPayloads.get(e.key)?.json ?? {}) as { summary?: unknown; result_hash?: unknown };
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
      summary: mode === "public" && typeof body.summary === "string" ? body.summary : undefined,
      resultHash: typeof body.result_hash === "string" ? (body.result_hash as Hex) : undefined,
    };
  });
}

export async function loadReceipts(f: ReceiptFilter = {}): Promise<Receipt[]> {
  const max = f.max ?? 400;
  if (f.trigger && isDirty(f.trigger)) {
    const rows = await rpcReceipts(f.trigger, max);
    return rows.sort((x, y) => (x.firedBlock > y.firedBlock ? -1 : x.firedBlock < y.firedBlock ? 1 : 0));
  }
  const t = f.trigger?.toLowerCase();
  return (await loadSnapshot()).receipts
    .filter((r) => (!t || r.trigger.toLowerCase() === t) && (f.sinceBlock === undefined || r.firedBlock > f.sinceBlock))
    .slice(0, max);
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
  if (sealedKey && isDirty(sealedKey)) {
    const page = await getReader()
      .select({ key: true, creator: true, createdAt: true, attributes: { sealed: true, commitment: true, accepted_block: true } })
      .where(...ns(ENTITY_TYPES.acceptance), eq("sealed", keyValue(sealedKey)))
      .limit(50)
      .fetch();
    return page.entities.map((e) => {
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
  const all = (await loadSnapshot()).acceptances;
  return sealedKey ? all.filter((x) => x.sealed.toLowerCase() === sealedKey.toLowerCase()) : all;
}

export interface Reveal {
  key: Hex;
  creator: Hex;
  createdAt: bigint;
  sealed?: Hex;
  /** The revealed spec, if it parses as a sealed TriggerSpec. Whether it opens the commitment is Verify's job. */
  spec?: SealedTriggerSpec;
}

const revealPayloads: PayloadCache = new Map();

/** Reveal entities for a sealed key, by anyone; callers keep only the sealed creator's. */
export async function loadReveals(sealedKey: Hex): Promise<Reveal[]> {
  if (!isDirty(sealedKey)) {
    return (await loadSnapshot()).reveals.filter((r) => r.sealed?.toLowerCase() === sealedKey.toLowerCase());
  }
  const reader = getReader();
  const page = await reader
    .select({ key: true, creator: true, createdAt: true })
    .where(...ns(ENTITY_TYPES.reveal), eq("sealed", keyValue(sealedKey)))
    .limit(20)
    .fetch();
  // Reveals are readonly: fetch each payload once.
  await fetchPayloads(reader, page.entities.map((e) => ({ key: e.key })), revealPayloads);
  return page.entities.map((e) => {
    const parsed = SealedTriggerSpecSchema.safeParse((revealPayloads.get(e.key)?.json as { spec?: unknown } | undefined)?.spec);
    return { key: e.key, creator: e.creator, createdAt: e.createdAt, sealed: sealedKey, spec: parsed.success ? parsed.data : undefined };
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

/** GET {endpoint}/health straight from the browser (workers send CORS headers on it). Not an Arkiv read. */
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

/** Registrations from the snapshot (one per worker address), with live health if asked. */
export async function loadWorkers(withHealth = true): Promise<Worker[]> {
  const unique = (await loadSnapshot()).workers;
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
  return (await loadSnapshot()).feed;
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

/**
 * A live entity (anything a trigger might watch), or undefined if gone. From the snapshot when
 * a public trigger watches it; otherwise one projected query (no payload: it isn't shown).
 */
export async function loadWatched(k: Hex): Promise<WatchedEntity | undefined> {
  if (!isDirty(k)) {
    const s = await loadSnapshot().catch(() => undefined);
    const hit = s?.watched[k.toLowerCase()];
    if (hit !== undefined) return hit ?? undefined;
  }
  const page = await getReader()
    .select({
      key: true,
      owner: true,
      createdAt: true,
      expiresAt: true,
      creationFlags: true,
      attributes: { project: true, kind: true, entity_type: true },
    })
    .where(eq("$key", keyValue(k)))
    .limit(1)
    .fetch();
  const e = page.entities[0];
  if (!e) return undefined;
  const a = (e.attributes ?? {}) as AttrMap;
  const label = [attrStr(a, "project"), attrStr(a, "kind") ?? attrStr(a, "entity_type")].filter(Boolean).join(" · ");
  return {
    key: e.key,
    owner: e.owner,
    createdAt: e.createdAt,
    expiresAt: e.expiresAt,
    extendable: Boolean(e.creationFlags?.permissionlessExtension),
    label: label || "entity",
  };
}

export type TriggerEntity =
  | { kind: "public"; trigger: PublicTrigger }
  | { kind: "sealed"; sealed: SealedTrigger }
  | { kind: "invalid"; error: string }
  | { kind: "gone" };

/**
 * Look up a trigger or sealed entity by key. `gone` = expired, deleted or never existed.
 * From the snapshot when it's there and this tab hasn't just changed it; otherwise from Arkiv.
 */
export async function loadTriggerEntity(k: Hex): Promise<TriggerEntity> {
  if (!isDirty(k)) {
    const s = await loadSnapshot();
    const lk = k.toLowerCase();
    const pub = s.pub.find((t) => t.key.toLowerCase() === lk);
    if (pub) return { kind: "public", trigger: pub };
    const sealed = s.sealed.find((t) => t.key.toLowerCase() === lk);
    if (sealed) return { kind: "sealed", sealed };
  }
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
