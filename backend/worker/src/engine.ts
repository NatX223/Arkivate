import {
  evalOnCount,
  evalOnSilence,
  findReceipts,
  findSubjectReceipts,
  listWorkers,
  loadTriggers,
  matchCandidates,
  onCreateFiring,
  readLive,
  recentMatches,
  resultHash,
  sealedEpoch,
  type Destination,
  type Firing,
  type Reader,
  type ReceiptOutcome,
  type TriggerRecord,
} from "@arkivate/core";
import type { Logger } from "pino";
import type { Hex } from "viem";
import type { ChainWriter } from "./chain.js";
import type { Alert } from "./deliver.js";
import { ExpiryWatcher } from "./expiry.js";
import { firedId, type Store } from "./store.js";

export interface EngineOptions {
  reader: Reader;
  wsReader: Reader;
  store: Store;
  log: Logger;
  /** This worker's address (receipts it wrote count as handled). */
  address: Hex;
  /** Null while unfunded: the engine evaluates everything and logs "would fire" instead. */
  writer: () => ChainWriter | null;
  /** Lowercased trigger creators to accept. Empty = accept all. */
  triggerCreators: readonly string[];
  /** Receipts (each one costs gas) this worker writes per trigger per hour. */
  maxReceiptsPerTriggerPerHour: number;
  /** DEMO SWITCH: accept sealed jobs but never fire them. */
  skipSealed: boolean;
  /** Sends a sealed alert to its private destination. */
  deliver: (d: Destination, a: Alert) => Promise<void>;
  pollMs?: number;
  sweepMs?: number;
  refreshMs?: number;
  flushMs?: number;
}

const lower = (a: string) => a.toLowerCase();
const HOUR_MS = 60 * 60_000;

/**
 * Head start per rank. Must exceed detect → write → mined (~5–7 s measured on Tiramisu), or a
 * backup worker re-checks before the primary's receipt lands and fires a duplicate.
 */
const FIRE_SLOT_MS = 12_000;
const MAX_FIRE_DELAY_MS = 36_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ReactivatePlan {
  outcome: ReceiptOutcome;
  oldExpiresAt?: bigint;
  newExpiresAt?: bigint;
}

export class Engine {
  private triggers = new Map<Hex, TriggerRecord>();
  /** Lowercased creators whose receipts we accept for dedupe: live registered workers + us. */
  private trustedWorkers = new Set<string>();
  private rank = 0;
  private pending = new Set<Hex>();
  private inflight = new Set<string>();
  /** Dry-run firings, kept in memory only so they still fire for real once funded. */
  private dryFired = new Set<string>();
  /** Per-trigger timestamps of receipts we wrote in the last hour (gas cap). */
  private recent = new Map<Hex, number[]>();
  private timers: NodeJS.Timeout[] = [];
  private unwatch: (() => void) | undefined;
  private readonly expiry: ExpiryWatcher;
  readonly stats = {
    firedSelf: 0,
    skippedPeer: 0,
    wouldFire: 0,
    skippedByCap: 0,
    sealedSkippedOnPurpose: 0,
    deliveryFailures: 0,
    triggersNotAllowed: 0,
    errors: 0,
  };

  constructor(private readonly o: EngineOptions) {
    this.expiry = new ExpiryWatcher(o.reader, o.store, o.log, (t, f) => this.fire(t, f));
  }

  get triggerCount() {
    return this.triggers.size;
  }

  get watchedCount() {
    return this.expiry.watchedCount;
  }

  get sealedJobCount() {
    return [...this.triggers.values()].filter((t) => t.mode === "sealed").length;
  }

  /** Accepted sealed jobs whose `sealed` entity is still live, as engine triggers. */
  private async loadSealedJobs(): Promise<TriggerRecord[]> {
    const out: TriggerRecord[] = [];
    for (const [k, job] of Object.entries(this.o.store.data.sealed)) {
      const live = await readLive(this.o.reader, k as Hex);
      if (!live) continue; // the owner's sealed entity expired: the job is over
      out.push({
        key: k as Hex,
        creator: job.creator,
        // Conditions count from acceptance: that's what the worker promised, and what verify checks.
        createdAt: BigInt(job.acceptedBlock),
        expiresAt: live.expiresAt,
        status: "active",
        spec: job.spec,
        mode: "sealed",
      });
    }
    return out;
  }

  /** Start a just-accepted sealed job now instead of at the next 5-minute refresh. */
  async activateSealed(sealedKey: Hex) {
    const job = (await this.loadSealedJobs()).find((t) => t.key === sealedKey);
    if (!job) return;
    this.triggers.set(job.key, job);
    await this.expiry.rebuild([...this.triggers.values()], await this.o.reader.getBlockNumber());
    if (job.spec.cond.type === "on_create") {
      for (const m of await recentMatches(this.o.reader, job.spec.cond, job.createdAt)) await this.fire(job, onCreateFiring(m));
    }
  }

  async start() {
    await this.refresh();
    this.watch();
    const every = (ms: number, fn: () => Promise<void>) =>
      this.timers.push(setInterval(() => void fn().catch((e) => this.fail("timer", e)), ms));
    every(this.o.flushMs ?? 2_000, () => this.flush());
    every(this.o.pollMs ?? 30_000, () => this.poll());
    every(this.o.sweepMs ?? 10_000, () => this.sweep());
    every(this.o.refreshMs ?? 5 * 60_000, () => this.refresh());
    await this.poll();
    await this.sweep();
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.unwatch?.();
  }

  /** Reload triggers + worker set + expiry index, then catch up on_create for anything WS missed. */
  async refresh() {
    const { triggers, invalid } = await loadTriggers(this.o.reader, "active");
    const allow = this.o.triggerCreators;
    const accepted = allow.length === 0 ? triggers : triggers.filter((t) => allow.includes(lower(t.creator)));
    this.stats.triggersNotAllowed = triggers.length - accepted.length;
    const sealed = await this.loadSealedJobs();
    this.triggers = new Map([...accepted, ...sealed].map((t) => [t.key, t]));
    for (const i of invalid) this.o.log.debug({ trigger: i.key, error: i.error }, "ignoring invalid trigger");

    const workers = await this.refreshWorkers();
    const head = await this.o.reader.getBlockNumber();
    await this.expiry.rebuild([...this.triggers.values()], head);
    this.o.log.info(
      {
        triggers: this.triggers.size,
        notAllowed: this.stats.triggersNotAllowed,
        invalid: invalid.length,
        watched: this.expiry.watchedCount,
        workers,
        rank: this.rank,
      },
      "refreshed",
    );

    for (const t of this.triggers.values()) {
      if (t.spec.cond.type !== "on_create") continue;
      const matches = await recentMatches(this.o.reader, t.spec.cond, t.createdAt);
      for (const m of matches) await this.fire(t, onCreateFiring(m));
    }
  }

  private async refreshWorkers(): Promise<number> {
    const workers = await listWorkers(this.o.reader);
    const addrs = [...new Set([...workers.map((w) => lower(w.creator)), lower(this.o.address)])].sort();
    this.trustedWorkers = new Set(addrs);
    this.rank = Math.max(0, addrs.indexOf(lower(this.o.address)));
    return workers.length;
  }

  /** WS push path. Created keys are buffered and flushed in batches (one query per trigger). */
  private watch() {
    const guard = (where: string, p: Promise<void>) => void p.catch((e) => this.fail(where, e));
    this.unwatch = this.o.wsReader.watchEntityEvents({
      onEntityCreated: (e) => {
        // Cheap prefilter: if every query names a creator, ignore everyone else.
        // At creation the event's owner is the creator (a burn shows up as a later transfer).
        const creators = this.createdCreators();
        if (creators && !creators.has(lower(e.owner))) return;
        this.pending.add(e.entityKey);
      },
      onExpiryExtended: (e) => guard("ws extend", this.expiry.onExtended(e.entityKey, e.expiresAt, e.blockNumber)),
      onEntityDeleted: (e) => guard("ws delete", this.expiry.onDeleted(e.entityKey, e.blockNumber)),
      onError: (err) => this.fail("ws", err),
    });
  }

  private createdCreators(): Set<string> | null {
    const out = this.expiry.queryWatchCreators();
    if (!out) return null;
    for (const t of this.triggers.values()) {
      if (t.spec.cond.type !== "on_create") continue;
      if (!t.spec.cond.created_by) return null;
      out.add(lower(t.spec.cond.created_by));
    }
    return out;
  }

  private async flush() {
    if (this.pending.size === 0) return;
    const keys = [...this.pending];
    this.pending.clear();
    for (const t of this.triggers.values()) {
      if (t.spec.cond.type !== "on_create") continue;
      const matches = await matchCandidates(this.o.reader, t.spec.cond, keys);
      for (const m of matches) {
        if (m.createdAt > t.createdAt) await this.fire(t, onCreateFiring(m));
      }
    }
    await this.expiry.onCreated(keys, await this.o.reader.getBlockNumber());
  }

  /** Pollers for conditions no event can signal: silence and counts. */
  private async poll() {
    const head = await this.o.reader.getBlockNumber();
    for (const t of this.triggers.values()) {
      const c = t.spec.cond;
      try {
        const firing =
          c.type === "on_silence"
            ? await evalOnSilence(this.o.reader, c, head)
            : c.type === "on_count"
              ? await evalOnCount(this.o.reader, c, head)
              : undefined;
        if (firing) await this.fire(t, firing);
      } catch (e) {
        this.fail(`poll ${t.key}`, e);
      }
    }
  }

  /** Expiry sweep (~5 blocks): Arkiv has no expiration event, so deadlines are checked here. */
  private async sweep() {
    await this.expiry.sweep(await this.o.reader.getBlockNumber());
  }

  /** Has this (trigger, epoch) already got a receipt from a worker we trust? */
  private async peerReceipt(trigger: Hex, epoch: string) {
    const receipts = await findReceipts(this.o.reader, trigger, epoch);
    const trusted = () => receipts.find((r) => this.trustedWorkers.has(lower(r.creator)));
    // A receipt from an unknown creator may be a worker that registered since our last refresh.
    if (receipts.length > 0 && !trusted()) await this.refreshWorkers();
    return trusted();
  }

  /** Gas cap: true if we may write another receipt for this trigger now. */
  private underCap(trigger: Hex): boolean {
    const now = Date.now();
    const times = (this.recent.get(trigger) ?? []).filter((t) => now - t < HOUR_MS);
    this.recent.set(trigger, times);
    return times.length < this.o.maxReceiptsPerTriggerPerHour;
  }

  /**
   * Reactivate: decide what an `extend` firing does. Undefined = target is gone; write nothing.
   * The cap counts `extended` receipts from every trusted worker, not just ours.
   */
  private async planReactivate(t: TriggerRecord, subject: Hex): Promise<ReactivatePlan | undefined> {
    const action = t.spec.action;
    if (action.type !== "extend") return undefined;
    const live = await readLive(this.o.reader, subject);
    if (!live) return undefined;
    if (!live.permissionlessExtension && lower(live.owner) !== lower(this.o.address)) {
      return { outcome: "not_extendable", oldExpiresAt: live.expiresAt };
    }
    const prior = await findSubjectReceipts(this.o.reader, t.key, subject, "extended");
    const counted = prior.filter((r) => this.trustedWorkers.has(lower(r.creator))).length;
    if (counted >= action.max_extensions) return { outcome: "cap_reached", oldExpiresAt: live.expiresAt };
    return {
      outcome: "extended",
      oldExpiresAt: live.expiresAt,
      newExpiresAt: live.expiresAt + BigInt(action.extend_blocks),
    };
  }

  private async fire(t: TriggerRecord, f: Firing) {
    const id = firedId(t.key, f.epoch);
    if (this.o.store.data.fired[id] || this.inflight.has(id) || this.dryFired.has(id)) return;
    const sealed = t.mode === "sealed";
    // Sealed receipts carry a hashed epoch: the raw one would say what matched.
    const epoch = sealed ? sealedEpoch(f.epoch) : f.epoch;
    if (sealed && this.o.skipSealed) {
      if (!this.dryFired.has(id)) {
        this.dryFired.add(id);
        this.stats.sealedSkippedOnPurpose++;
        this.o.log.warn({ trigger: t.key, epoch }, "SKIP_SEALED: intentionally skipping (demo switch)");
      }
      return;
    }
    this.inflight.add(id);
    const log = this.o.log.child({ trigger: t.key, epoch });
    try {
      let peer = await this.peerReceipt(t.key, epoch);
      if (!peer && !sealed) {
        // Lower-ranked workers go first; the rest wait, then re-check before spending gas.
        if (this.rank > 0) await sleep(Math.min(this.rank * FIRE_SLOT_MS, MAX_FIRE_DELAY_MS) + Math.random() * 1_000);
        peer = await this.peerReceipt(t.key, epoch);
      }
      if (peer) {
        this.stats.skippedPeer++;
        this.o.store.data.fired[id] = { by: "peer", receipt: peer.key, at: new Date().toISOString() };
        await this.o.store.write();
        log.info({ receipt: peer.key, by: peer.creator }, "already fired by a worker; skipping");
        return;
      }

      if (!this.underCap(t.key)) {
        // Not marked handled: it fires once the hourly window has room.
        this.stats.skippedByCap++;
        log.warn({ cap: this.o.maxReceiptsPerTriggerPerHour }, "receipt cap reached for this trigger; skipping");
        return;
      }

      let plan: ReactivatePlan | undefined;
      if (t.spec.action.type === "extend") {
        if (!f.subject) throw new Error("extend firing has no subject entity");
        plan = await this.planReactivate(t, f.subject);
        if (!plan) {
          log.warn({ subject: f.subject }, "extend target is no longer live; nothing to do");
          return;
        }
      }

      const writer = this.o.writer();
      if (!writer) {
        this.stats.wouldFire++;
        this.dryFired.add(id);
        log.warn({ summary: sealed ? "(sealed)" : f.summary, outcome: plan?.outcome }, "WOULD FIRE (dry run: worker wallet unfunded)");
        return;
      }

      const head = await this.o.reader.getBlockNumber();
      if (sealed) {
        await this.fireSealed(t, f, id, sealedEpoch(f.epoch), head, writer, log);
        return;
      }
      const summary = plan ? `${plan.outcome}: ${f.summary}` : f.summary;
      const receipt = await writer.writeReceipt(
        {
          trigger: t.key,
          mode: "public",
          epoch: f.epoch,
          firedBlock: head,
          evidenceBlock: f.evidenceBlock,
          subject: f.subject,
          outcome: plan?.outcome,
          oldExpiresAt: plan?.oldExpiresAt,
          newExpiresAt: plan?.newExpiresAt,
        },
        { matched_keys: f.matchedKeys, summary },
        plan?.outcome === "extended" && f.subject && plan.newExpiresAt !== undefined
          ? { entityKey: f.subject, expiresAt: plan.newExpiresAt }
          : undefined,
      );
      this.recent.get(t.key)?.push(Date.now());
      this.stats.firedSelf++;
      this.o.store.data.fired[id] = { by: "self", receipt: receipt.key, tx: receipt.tx, at: new Date().toISOString() };
      await this.o.store.write();
      log.info({ receipt: receipt.key, tx: receipt.tx, outcome: plan?.outcome, summary: f.summary }, "FIRED");
      // Our own extension: update the index now rather than waiting for the WS event.
      if (plan?.outcome === "extended" && f.subject && plan.newExpiresAt !== undefined) {
        await this.expiry.onExtended(f.subject, plan.newExpiresAt, head);
      }
    } catch (e) {
      this.fail(`fire ${id}`, e);
    } finally {
      this.inflight.delete(id);
    }
  }

  /** Sealed: deliver privately first, then the receipt (payload `{ result_hash }` only). */
  private async fireSealed(
    t: TriggerRecord,
    f: Firing,
    id: string,
    epoch: Hex,
    head: bigint,
    writer: ChainWriter,
    log: typeof this.o.log,
  ) {
    const job = this.o.store.data.sealed[t.key];
    if (!job) throw new Error("sealed job missing from the local store");
    if (!this.o.store.data.delivered[id]) {
      try {
        await this.o.deliver(job.destination, {
          sealedKey: t.key,
          epoch,
          firedBlock: head,
          evidenceBlock: f.evidenceBlock,
          matchedKeys: f.matchedKeys,
          summary: f.summary,
        });
      } catch (e) {
        this.stats.deliveryFailures++;
        throw e; // no receipt without delivery; retried on a later pass
      }
      this.o.store.data.delivered[id] = true;
      await this.o.store.write();
    }
    const receipt = await writer.writeReceipt(
      { trigger: t.key, mode: "sealed", epoch, firedBlock: head, evidenceBlock: f.evidenceBlock },
      { result_hash: resultHash(f.epoch, f.matchedKeys[0]) },
    );
    this.recent.get(t.key)?.push(Date.now());
    this.stats.firedSelf++;
    this.o.store.data.fired[id] = { by: "self", receipt: receipt.key, tx: receipt.tx, at: new Date().toISOString() };
    await this.o.store.write();
    log.info({ receipt: receipt.key, tx: receipt.tx }, "FIRED (sealed): delivered + receipt");
  }

  private fail(where: string, e: unknown) {
    this.stats.errors++;
    this.o.log.error({ where, err: e instanceof Error ? e.message : String(e) }, "error");
  }
}
