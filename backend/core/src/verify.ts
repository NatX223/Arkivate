import { NoEntityFoundError } from "@arkiv-network/sdk";
import { addr, key as keyValue, str } from "@arkiv-network/sdk/attr";
import { and, eq, render, type Expression } from "@arkiv-network/sdk/query";
import type { Hex } from "viem";
import { commit } from "./commit.js";
import { ENTITY_TYPES, PROJECT, TIRAMISU_RPC_HTTP } from "./constants.js";
import { readLive } from "./expiry.js";
import { conditionExpression } from "./query.js";
import type { Reader } from "./reader.js";
import { sealedEpoch } from "./sealed.js";
import { SealedTriggerSpec, type SealedTriggerSpec as Spec } from "./spec.js";

/**
 * Dispute verification (docs/technical-plan.md §6). Pure reads, so the CLI and the web page share
 * it. Every step returns its evidence (keys + blocks) so anyone can re-check with curl.
 */

export type Verdict =
  | "FIRED"
  | "SKIPPED"
  | "PENDING"
  | "INVALID_REVEAL"
  | "NOT_ACCEPTED"
  | "NOT_TRIGGERED"
  | "INCONCLUSIVE"
  | "NOT_FOUND";

/** Blocks a worker has to land its receipt after the condition is met (~5 min). */
export const GRACE_BLOCKS = 150n;

export interface Step {
  name: string;
  ok: boolean;
  detail: string;
  evidence: Record<string, string>;
}

export interface VerifyResult {
  verdict: Verdict;
  sealedKey: Hex;
  head: bigint;
  steps: Step[];
  /** Copy-paste JSON-RPC calls that reproduce each read. */
  recheck: string[];
}

export interface SealedRecord {
  key: Hex;
  creator: Hex;
  worker: Hex;
  commitment: Hex;
}
export interface AcceptanceRecord {
  key: Hex;
  creator: Hex;
  commitment: Hex;
  sealedCreator: Hex;
  acceptedBlock: bigint;
}
export interface RevealRecord {
  key: Hex;
  creator: Hex;
  spec: unknown;
  salt: Hex;
}
export interface SealedReceiptRecord {
  key: Hex;
  creator: Hex;
  epoch: string;
  firedBlock: bigint;
}
export interface ConditionHit {
  epoch: string;
  metBlock: bigint;
  matchedKey?: Hex;
}
export type Evaluation =
  | { status: "met"; hits: ConditionHit[]; detail: string; query?: string }
  | { status: "not_met"; detail: string; query?: string }
  | { status: "inconclusive"; detail: string };

/** Everything verification reads. Swappable for tests. */
export interface VerifyReads {
  head(): Promise<bigint>;
  sealed(sealedKey: Hex): Promise<SealedRecord | undefined>;
  acceptances(sealedKey: Hex): Promise<AcceptanceRecord[]>;
  reveals(sealedKey: Hex, creator: Hex): Promise<RevealRecord[]>;
  evaluate(spec: Spec, since: bigint, head: bigint): Promise<Evaluation>;
  receipts(sealedKey: Hex, worker: Hex): Promise<SealedReceiptRecord[]>;
}

const lower = (a: string) => a.toLowerCase();
const short = (h: string) => `${h.slice(0, 10)}…`;

export async function verifySealed(
  sealedKey: Hex,
  reads: VerifyReads,
  rpcUrl: string = TIRAMISU_RPC_HTTP,
): Promise<VerifyResult> {
  const steps: Step[] = [];
  const recheck: string[] = [];
  const head = await reads.head();
  const done = (verdict: Verdict): VerifyResult => ({ verdict, sealedKey, head, steps, recheck });
  const q = (expr: Expression | string, select: Record<string, unknown>) =>
    recheck.push(rpcCurl(rpcUrl, typeof expr === "string" ? expr : render(expr), select));

  // 1. Commitment found (the sealed entity, or the data its acceptance preserved).
  const [sealed, acceptances] = await Promise.all([reads.sealed(sealedKey), reads.acceptances(sealedKey)]);
  q(eq("$key", keyValue(sealedKey)), { key: true, creator: true, attributes: true });
  let base: SealedRecord | undefined = sealed;
  let source = "sealed entity";
  if (!base && acceptances[0]) {
    const a = acceptances[0];
    base = { key: sealedKey, creator: a.sealedCreator, worker: a.creator, commitment: a.commitment };
    source = `acceptance ${a.key} (the sealed entity has expired)`;
  }
  if (!base) {
    steps.push({ name: "commitment found", ok: false, detail: "no sealed entity and no acceptance for this key", evidence: {} });
    return done("NOT_FOUND");
  }
  steps.push({
    name: "commitment found",
    ok: true,
    detail: `from ${source}`,
    evidence: { sealed: sealedKey, creator: base.creator, worker: base.worker, commitment: base.commitment },
  });

  // 2. Reveal matches.
  const reveals = await reads.reveals(sealedKey, base.creator);
  q(revealExpr(sealedKey, base.creator), { key: true, creator: true, payload: true });
  const reveal = reveals[0];
  if (!reveal) {
    steps.push({ name: "reveal matches", ok: false, detail: `no reveal by the sealed creator ${base.creator} yet`, evidence: {} });
    return done("PENDING");
  }
  // Any reveal by the creator that opens the commitment counts; report the first if none does.
  const opening = reveals.find((r) => lower(commit(r.spec, r.salt)) === lower(base.commitment)) ?? reveal;
  const recomputed = commit(opening.spec, opening.salt);
  const parsed = SealedTriggerSpec.safeParse(opening.spec);
  if (lower(recomputed) !== lower(base.commitment) || !parsed.success) {
    steps.push({
      name: "reveal matches",
      ok: false,
      detail: !parsed.success
        ? "revealed spec is not a valid sealed TriggerSpec"
        : "keccak256(canonical(spec) ‖ salt) does not equal the commitment",
      evidence: { reveal: opening.key, recomputed, commitment: base.commitment },
    });
    return done("INVALID_REVEAL");
  }
  steps.push({
    name: "reveal matches",
    ok: true,
    detail: `keccak256(canonical(spec) ‖ salt) = commitment; condition ${parsed.data.cond.type}`,
    evidence: { reveal: opening.key, recomputed },
  });

  // 3. The chosen worker accepted (burned acceptance, same commitment).
  q(acceptanceExpr(sealedKey), { key: true, creator: true, owner: true, attributes: true });
  const acc = acceptances.find(
    (a) => lower(a.creator) === lower(base.worker) && lower(a.commitment) === lower(base.commitment),
  );
  if (!acc) {
    steps.push({ name: "worker accepted", ok: false, detail: `no acceptance from ${base.worker}; the worker never took the job (no fault)`, evidence: {} });
    return done("NOT_ACCEPTED");
  }
  steps.push({
    name: "worker accepted",
    ok: true,
    detail: `accepted at block ${acc.acceptedBlock}`,
    evidence: { acceptance: acc.key, worker: acc.creator, accepted_block: acc.acceptedBlock.toString() },
  });

  // 4. Condition met after acceptance.
  const ev = await reads.evaluate(parsed.data, acc.acceptedBlock, head);
  if ("query" in ev && ev.query) q(ev.query, { key: true, createdAt: true });
  if (ev.status === "inconclusive") {
    steps.push({ name: "condition met", ok: false, detail: ev.detail, evidence: {} });
    return done("INCONCLUSIVE");
  }
  if (ev.status === "not_met") {
    steps.push({ name: "condition met", ok: false, detail: ev.detail, evidence: {} });
    return done("NOT_TRIGGERED");
  }
  steps.push({
    name: "condition met",
    ok: true,
    detail: ev.detail,
    evidence: Object.fromEntries(ev.hits.map((h, i) => [`hit_${i + 1}`, `${h.epoch} @ block ${h.metBlock}`])),
  });

  // 5. A sealed receipt from that worker within the grace window, for every hit.
  const receipts = await reads.receipts(sealedKey, base.worker);
  q(receiptExpr(sealedKey, base.worker), { key: true, creator: true, owner: true, attributes: true });
  const missing: ConditionHit[] = [];
  const open: ConditionHit[] = [];
  const found: Record<string, string> = {};
  for (const h of ev.hits) {
    const want = lower(sealedEpoch(h.epoch));
    const r = receipts.find((x) => lower(x.epoch) === want && x.firedBlock <= h.metBlock + GRACE_BLOCKS);
    if (r) found[short(h.epoch)] = `${r.key} fired @ block ${r.firedBlock}`;
    else if (head <= h.metBlock + GRACE_BLOCKS) open.push(h);
    else missing.push(h);
  }
  if (missing.length > 0) {
    steps.push({
      name: "receipt present",
      ok: false,
      detail: `${missing.length} hit(s) with no receipt from ${base.worker} within ${GRACE_BLOCKS} blocks: provable censorship`,
      evidence: Object.fromEntries(
        missing.map((h, i) => [`skipped_${i + 1}`, `${h.epoch} met @ ${h.metBlock}, deadline ${h.metBlock + GRACE_BLOCKS}, sealed epoch ${sealedEpoch(h.epoch)}`]),
      ),
    });
    return done("SKIPPED");
  }
  if (open.length > 0) {
    steps.push({
      name: "receipt present",
      ok: false,
      detail: `grace window still open until block ${open[0]!.metBlock + GRACE_BLOCKS} (head ${head})`,
      evidence: found,
    });
    return done("PENDING");
  }
  steps.push({ name: "receipt present", ok: true, detail: `${ev.hits.length} hit(s), all receipted in time`, evidence: found });
  return done("FIRED");
}

// ---- Arkiv-backed reads ---------------------------------------------------------------------

const ns = (type: string) => [eq("project", str(PROJECT)), eq("entity_type", str(type))];
const revealExpr = (k: Hex, creator: Hex) =>
  and(...ns(ENTITY_TYPES.reveal), eq("sealed", keyValue(k)), eq("$creator", addr(creator)));
const acceptanceExpr = (k: Hex) => and(...ns(ENTITY_TYPES.acceptance), eq("sealed", keyValue(k)));
const receiptExpr = (k: Hex, worker: Hex) =>
  and(...ns(ENTITY_TYPES.receipt), eq("trigger", keyValue(k)), eq("mode", str("sealed")), eq("$creator", addr(worker)));

type AttrMap = Record<string, { value: unknown } | undefined>;
const attrHex = (a: AttrMap, n: string) => String(a[n]?.value ?? "") as Hex;
const attrBig = (a: AttrMap, n: string) => (typeof a[n]?.value === "bigint" ? (a[n]!.value as bigint) : 0n);

export function arkivVerifyReads(reader: Reader): VerifyReads {
  return {
    head: () => reader.getBlockNumber(),

    async sealed(k) {
      try {
        const e = await reader.getEntity(k);
        const a = e.attributes as AttrMap;
        if (a.entity_type?.value !== ENTITY_TYPES.sealed) return undefined;
        return { key: e.key, creator: e.creator, worker: attrHex(a, "worker"), commitment: attrHex(a, "commitment") };
      } catch (err) {
        if (err instanceof NoEntityFoundError) return undefined;
        throw err;
      }
    },

    async acceptances(k) {
      const page = await reader.select({ key: true, creator: true, attributes: true }).where(acceptanceExpr(k)).limit(50).fetch();
      return page.entities.map((e) => {
        const a = e.attributes as AttrMap;
        return {
          key: e.key,
          creator: e.creator,
          commitment: attrHex(a, "commitment"),
          sealedCreator: attrHex(a, "sealed_creator"),
          acceptedBlock: attrBig(a, "accepted_block"),
        };
      });
    },

    async reveals(k, creator) {
      const page = await reader
        .select({ key: true, creator: true, payload: true })
        .where(...ns(ENTITY_TYPES.reveal), eq("sealed", keyValue(k)))
        .createdBy(creator)
        .limit(10)
        .fetch();
      const out: RevealRecord[] = [];
      for (const e of page.entities) {
        try {
          const body = e.toJson() as { spec?: unknown; salt?: unknown };
          if (typeof body.salt === "string") out.push({ key: e.key, creator: e.creator, spec: body.spec, salt: body.salt as Hex });
        } catch {
          // not JSON: not a usable reveal
        }
      }
      return out;
    },

    async receipts(k, worker) {
      const page = await reader
        .select({ key: true, creator: true, attributes: true })
        .where(...ns(ENTITY_TYPES.receipt), eq("trigger", keyValue(k)), eq("mode", str("sealed")))
        .createdBy(worker)
        .limit(200)
        .fetch();
      return page.entities.map((e) => {
        const a = e.attributes as AttrMap;
        return { key: e.key, creator: e.creator, epoch: String(a.epoch?.value ?? ""), firedBlock: attrBig(a, "fired_block") };
      });
    },

    evaluate: (spec, since, head) => evaluateSince(reader, spec, since, head),
  };
}

/**
 * Re-run a revealed condition for blocks after `since`, using only what is still queryable at
 * head. Creation-based conditions can be replayed from live entities; counts and most expiry cases
 * can't be reconstructed (no history, and `NoEntityFoundError` hides why an entity is gone), so
 * they come back `inconclusive` rather than guessed.
 */
export async function evaluateSince(reader: Reader, spec: Spec, since: bigint, head: bigint): Promise<Evaluation> {
  const c = spec.cond;
  switch (c.type) {
    case "on_create": {
      const expr = conditionExpression(c);
      const hits: ConditionHit[] = [];
      for await (const e of reader.select({ key: true, createdAt: true }).where(expr).limit(200)) {
        if (e.createdAt > since) hits.push({ epoch: `create:${e.key}`, metBlock: e.createdAt, matchedKey: e.key });
      }
      hits.sort((a, b) => (a.metBlock < b.metBlock ? -1 : 1));
      return hits.length > 0
        ? { status: "met", hits, detail: `${hits.length} matching entit${hits.length === 1 ? "y" : "ies"} created after block ${since}`, query: render(expr) }
        : { status: "not_met", detail: `no live matching entity created after block ${since}`, query: render(expr) };
    }
    case "on_silence": {
      const expr = conditionExpression(c);
      const page = await reader.select({ key: true, createdAt: true }).where(expr).limit(50).fetch();
      let newest: { key: Hex; createdAt: bigint } | undefined;
      for (const e of page.entities) if (!newest || e.createdAt > newest.createdAt) newest = { key: e.key, createdAt: e.createdAt };
      const from = newest && newest.createdAt > since ? newest.createdAt : since;
      const metBlock = from + BigInt(c.silence_blocks) + 1n;
      if (head < metBlock) return { status: "not_met", detail: `silent only since block ${from}; fires at ${metBlock}`, query: render(expr) };
      return {
        status: "met",
        hits: [{ epoch: `silence:${newest?.key ?? "none"}`, metBlock, matchedKey: newest?.key }],
        detail: `no matching entity from ${c.created_by} for ${c.silence_blocks} blocks after block ${from}`,
        query: render(expr),
      };
    }
    case "on_expiring":
    case "on_expire": {
      if (!("entity_key" in c.watch)) return { status: "inconclusive", detail: `${c.type} with a query watch can't be replayed from head` };
      if (c.deadline === "pinned") return { status: "inconclusive", detail: "pinned deadlines are recorded by the worker, not on Arkiv" };
      const k = c.watch.entity_key as Hex;
      const live = await readLive(reader, k);
      if (!live) return { status: "inconclusive", detail: `${k} is no longer live; its last deadline isn't queryable (expired and deleted look the same)` };
      if (c.type === "on_expire") return { status: "not_met", detail: `${k} is still live until block ${live.expiresAt}` };
      const metBlock = live.expiresAt - BigInt(c.lead_blocks);
      if (head < metBlock) return { status: "not_met", detail: `${k} expires at ${live.expiresAt}; lead window opens at ${metBlock}` };
      return {
        status: "met",
        hits: [{ epoch: `expiring:${k}:${live.expiresAt}`, metBlock, matchedKey: k }],
        detail: `${k} expires at ${live.expiresAt}; within ${c.lead_blocks} blocks since ${metBlock}`,
      };
    }
    default:
      return { status: "inconclusive", detail: `${c.type} can't be re-evaluated from data still live at head` };
  }
}

/** A curl command reproducing one `arkiv_query`. */
function rpcCurl(rpcUrl: string, query: string, select: Record<string, unknown>): string {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "arkiv_query", params: [query, { select }] });
  return `curl -s ${rpcUrl} -H 'content-type: application/json' -d '${body.replaceAll("'", "'\\''")}'`;
}
