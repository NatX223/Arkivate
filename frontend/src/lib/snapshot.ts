import { key as keyValue, str } from "@arkiv-network/sdk/attr";
import { eq, or } from "@arkiv-network/sdk/query";
import {
  ENTITY_TYPES,
  PROJECT,
  PublicTriggerSpec,
  SealedTriggerSpec as SealedTriggerSpecSchema,
  fetchPayloads,
  pruneCache,
  type PayloadCache,
  type Reader,
  type WorkerRecord,
} from "@arkivate/core";
import type { Hex } from "viem";
import type { Acceptance, FeedEntity, PublicTrigger, Receipt, Reveal, SealedTrigger, WatchedEntity } from "./data";

/**
 * The site's whole read model in one object, built server-side by `/api/snapshot` and shared by
 * every visitor (and the CDN). Every `arkiv_query` costs a flat 100 units whatever it returns
 * (arkiv/friction.md F20), and all of Arkivate is under 200 entities, so one query lists
 * everything; payloads come from a cache and are only fetched for new or patched entities.
 */
export interface Snapshot {
  head: bigint;
  /** ms since the head was read, at serve time (the client extrapolates from it). */
  headAgeMs: number;
  builtAt: number;
  /** Arkivate entities listed: the free `arkiv_getEntityCount` compares against this. */
  count: number;
  pub: PublicTrigger[];
  invalid: number;
  sealed: SealedTrigger[];
  /** Every live receipt (they live 30 days), newest first. */
  receipts: Receipt[];
  acceptances: Acceptance[];
  reveals: Reveal[];
  /** One registration per worker address (the longest-lived), by name. Health is the client's job. */
  workers: WorkerRecord[];
  feed: FeedEntity[];
  /** Single-entity watches of public triggers, by lowercased key. null = not live. */
  watched: Record<string, WatchedEntity | null>;
}

// ---- codec: bigints survive JSON ------------------------------------------------------------

export const encodeSnapshot = (s: Snapshot) => JSON.stringify(s, (_k, v) => (typeof v === "bigint" ? { $big: v.toString() } : v));

export const decodeSnapshot = (text: string) =>
  JSON.parse(text, (_k, v) => (v && typeof v === "object" && typeof v.$big === "string" && Object.keys(v).length === 1 ? BigInt(v.$big) : v)) as Snapshot;

// ---- builder (server) -----------------------------------------------------------------------

type AttrMap = Record<string, { value: unknown } | undefined>;
const attrStr = (a: AttrMap, n: string) => (a[n]?.value === undefined ? undefined : String(a[n]!.value));
const attrHex = (a: AttrMap, n: string) => attrStr(a, n) as Hex | undefined;
const attrBig = (a: AttrMap, n: string) => (typeof a[n]?.value === "bigint" ? (a[n]!.value as bigint) : undefined);

const MAX_WATCHED = 100;
const newestFirst = (x: { createdAt: bigint }, y: { createdAt: bigint }) => (x.createdAt > y.createdAt ? -1 : x.createdAt < y.createdAt ? 1 : 0);

/** Payloads by key across builds (one server instance). */
const payloads: PayloadCache = new Map();

/** The filter `count` is measured against: every Arkivate entity. */
export const allArkivate = () => eq("project", str(PROJECT));

/** Build a full snapshot: one list query (+1 per 200 entities), payloads for what changed, watched entities. */
export async function buildSnapshot(reader: Reader): Promise<Snapshot> {
  const head = await reader.getBlockNumber();
  const headAt = Date.now();
  const q = reader
    .select({ key: true, owner: true, creator: true, createdAt: true, updatedAt: true, expiresAt: true, creationFlags: true, attributes: true })
    .where(allArkivate())
    .limit(200);
  const rows: Awaited<ReturnType<typeof q.fetch>>["entities"][number][] = [];
  for await (const e of q) rows.push(e);

  const typeOf = (e: (typeof rows)[number]) => attrStr(e.attributes as AttrMap, "entity_type");
  // Triggers and workers change by patch (updatedAt); receipts and reveals are readonly.
  const mutable = new Set<string>([ENTITY_TYPES.trigger, ENTITY_TYPES.worker]);
  const withPayload = new Set<string>([ENTITY_TYPES.trigger, ENTITY_TYPES.worker, ENTITY_TYPES.receipt, ENTITY_TYPES.reveal]);
  const need = rows.filter((e) => withPayload.has(typeOf(e) ?? ""));
  await fetchPayloads(reader, need.map((e) => ({ key: e.key, updatedAt: mutable.has(typeOf(e)!) ? e.updatedAt : undefined })), payloads);
  pruneCache(payloads, need.map((e) => e.key));
  const json = (k: Hex) => payloads.get(k)?.json;

  const pub: PublicTrigger[] = [];
  let invalid = 0;
  const sealed: SealedTrigger[] = [];
  const receipts: Receipt[] = [];
  const acceptances: Acceptance[] = [];
  const reveals: Reveal[] = [];
  const feed: FeedEntity[] = [];
  const workersByAddr = new Map<string, WorkerRecord>();
  const byKey = new Map<string, WatchedEntity>();

  for (const e of rows) {
    const a = e.attributes as AttrMap;
    const type = typeOf(e);
    byKey.set(e.key.toLowerCase(), {
      key: e.key,
      owner: e.owner,
      createdAt: e.createdAt,
      expiresAt: e.expiresAt,
      extendable: Boolean(e.creationFlags?.permissionlessExtension),
      label: [PROJECT, attrStr(a, "kind") ?? type].filter(Boolean).join(" · "),
    });
    switch (type) {
      case ENTITY_TYPES.trigger: {
        const status = attrStr(a, "status");
        if (status !== "active" && status !== "paused") break;
        const parsed = PublicTriggerSpec.safeParse(json(e.key));
        if (!parsed.success) {
          invalid++;
          break;
        }
        pub.push({ key: e.key, creator: e.creator, createdAt: e.createdAt, expiresAt: e.expiresAt, status, spec: parsed.data, mode: "public" });
        break;
      }
      case ENTITY_TYPES.sealed:
        sealed.push({
          mode: "sealed",
          key: e.key,
          creator: e.creator,
          createdAt: e.createdAt,
          expiresAt: e.expiresAt,
          commitment: (attrHex(a, "commitment") ?? "0x") as Hex,
          worker: (attrHex(a, "worker") ?? "0x") as Hex,
        });
        break;
      case ENTITY_TYPES.receipt: {
        const body = (json(e.key) ?? {}) as { summary?: unknown; result_hash?: unknown };
        const mode = attrStr(a, "mode") === "sealed" ? "sealed" : "public";
        receipts.push({
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
        });
        break;
      }
      case ENTITY_TYPES.acceptance:
        acceptances.push({
          key: e.key,
          creator: e.creator,
          sealed: (attrHex(a, "sealed") ?? "0x") as Hex,
          commitment: (attrHex(a, "commitment") ?? "0x") as Hex,
          acceptedBlock: attrBig(a, "accepted_block") ?? e.createdAt,
        });
        break;
      case ENTITY_TYPES.reveal: {
        const parsed = SealedTriggerSpecSchema.safeParse((json(e.key) as { spec?: unknown } | undefined)?.spec);
        reveals.push({ key: e.key, creator: e.creator, createdAt: e.createdAt, sealed: attrHex(a, "sealed"), spec: parsed.success ? parsed.data : undefined });
        break;
      }
      case ENTITY_TYPES.worker: {
        const body = (json(e.key) ?? {}) as { name?: unknown; endpoint?: unknown };
        const w: WorkerRecord = {
          key: e.key,
          creator: e.creator,
          expiresAt: e.expiresAt,
          name: typeof body.name === "string" ? body.name : "",
          endpoint: typeof body.endpoint === "string" ? body.endpoint : "",
        };
        // One registration per worker address: keep the longest-lived if a worker re-registered.
        const prev = workersByAddr.get(e.creator.toLowerCase());
        if (!prev || w.expiresAt > prev.expiresAt) workersByAddr.set(e.creator.toLowerCase(), w);
        break;
      }
      case ENTITY_TYPES.demo_feed:
        feed.push({ key: e.key, creator: e.creator, createdAt: e.createdAt, expiresAt: e.expiresAt, kind: attrStr(a, "kind") ?? "entity" });
        break;
    }
  }

  // Watched entities outside Arkivate: one query per 50 keys.
  const wanted = [
    ...new Set(pub.flatMap((t) => ("watch" in t.spec.cond && "entity_key" in t.spec.cond.watch ? [t.spec.cond.watch.entity_key.toLowerCase()] : []))),
  ].slice(0, MAX_WATCHED);
  const outside = wanted.filter((k) => !byKey.has(k)) as Hex[];
  for (let i = 0; i < outside.length; i += 50) {
    const chunk = outside.slice(i, i + 50);
    const page = await reader
      .select({ key: true, owner: true, createdAt: true, expiresAt: true, creationFlags: true, attributes: { project: true, kind: true, entity_type: true } })
      .where(or(chunk.map((k) => eq("$key", keyValue(k)))))
      .limit(50)
      .fetch();
    for (const e of page.entities) {
      const a = (e.attributes ?? {}) as AttrMap;
      const label = [attrStr(a, "project"), attrStr(a, "kind") ?? attrStr(a, "entity_type")].filter(Boolean).join(" · ");
      byKey.set(e.key.toLowerCase(), {
        key: e.key,
        owner: e.owner,
        createdAt: e.createdAt,
        expiresAt: e.expiresAt,
        extendable: Boolean(e.creationFlags?.permissionlessExtension),
        label: label || "entity",
      });
    }
  }

  return {
    head,
    headAgeMs: Date.now() - headAt,
    builtAt: headAt,
    count: rows.length,
    pub: pub.sort(newestFirst),
    invalid,
    sealed: sealed.sort(newestFirst),
    receipts: receipts.sort((x, y) => (x.firedBlock > y.firedBlock ? -1 : x.firedBlock < y.firedBlock ? 1 : 0)),
    acceptances,
    reveals,
    workers: [...workersByAddr.values()].sort((a, b) => a.name.localeCompare(b.name)),
    feed,
    watched: Object.fromEntries(wanted.map((k) => [k, byKey.get(k) ?? null])),
  };
}
