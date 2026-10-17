import {
  conditionExpression,
  countMatching,
  countTriggers,
  countWorkers,
  evalOnCount,
  evalOnSilence,
  fetchCandidates,
  findReceipts,
  findSubjectReceipts,
  listWorkers,
  loadTriggers,
  matchRows,
  onCreateFiring,
  pruneCache,
  readLive,
  readLiveMany,
  recentMatches,
  resultHash,
  sealedEpoch,
  type Destination,
  type Firing,
  type PayloadCache,
  type QueryFilter,
  type RateGate,
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
  /** Shared 429 state: loops skip while it is backing off, and slow ×4 after repeated 429s. */
  gate?: RateGate;
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
/** Billed backstop re-check for a trigger that is already silent (~10 min at 2 s blocks). */
const SILENT_RECHECK_BLOCKS = 300;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ReactivatePlan {
  outcome: ReceiptOutcome;
  oldExpiresAt?: bigint;
  newExpiresAt?: bigint;
}

export class Engine {
  private triggers = new Map<Hex, TriggerRecord>();
  /** Trigger and worker payloads, refetched only when `updatedAt` moves (a patch). */
  private triggerPayloads: PayloadCache = new Map();
  private workerPayloads: PayloadCache = new Map();
  /** Lowercased creators whose receipts we accept for dedupe: live registered workers + us. */
  private trustedWorkers = new Set<string>();
  private rank = 0;
  private pending = new Set<Hex>();
  private inflight = new Set<string>();
  /** Dry-run firings, kept in memory only so they still fire for real once funded. */
  private dryFired = new Set<string>();
  /**
   * on_silence: the first block at which each trigger could be silent. Nothing can change that
   * before then except a newer heartbeat, which only moves it later, so no query is needed.
   */
  private silenceDue = new Map<Hex, bigint>();
  /** Already-silent triggers: the (free) count of matching entities when silence was handled. */
  private silenceCount = new Map<Hex, number>();
  /** What the last refresh listed, compared with free counts each poll (see `changed`). */
  private listed = { triggers: -1, workers: -1 };
  private workerKeys = new Set<string>();
  private refreshTimer: NodeJS.Timeout | undefined;
  /** Per-trigger timestamps of receipts we wrote in the last hour (gas cap). */
  private recent = new Map<Hex, number[]>();
  private timers = new Set<NodeJS.Timeout>();
  private started = false;
  private stopped = false;
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
    rateLimited: 0,
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
    const jobs = Object.entries(this.o.store.data.sealed);
    const alive = jobs.length > 0 ? await readLiveMany(this.o.reader, jobs.map(([k]) => k as Hex)) : new Map();
    for (const [k, job] of jobs) {
      const live = alive.get(k.toLowerCase() as Hex);
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

  /** Start a just-accepted sealed job now instead of at the next refresh. */
  async activateSealed(sealedKey: Hex) {
    const job = (await this.loadSealedJobs()).find((t) => t.key === sealedKey);
    if (!job) return;
    this.triggers.set(job.key, job);
    await this.expiry.rebuild([...this.triggers.values()], await this.o.reader.getBlockNumber());
    if (job.spec.cond.type === "on_create") {
      for (const m of await recentMatches(this.o.reader, job.spec.cond, job.createdAt)) await this.fire(job, onCreateFiring(m));
    }
  }

  /**
   * Initial load, then the loops. Safe to call again after it throws (boot retries it): the
   * loops and the WS watcher are only set up once the first refresh has succeeded.
   */
  async start() {
    if (this.started) return;
    await this.refresh();
    this.started = true;
    this.watch();
    this.loop("flush", this.o.flushMs ?? 5_000, () => this.flush());
    this.loop("poll", this.o.pollMs ?? 30_000, () => this.poll());
    this.loop("sweep", this.o.sweepMs ?? 30_000, () => this.sweep());
    // Safety net only: changes are picked up from free counts (each poll) and EntityPatched.
    this.loop("refresh", this.o.refreshMs ?? 30 * 60_000, () => this.refresh());
    await this.poll().catch((e) => this.fail("poll", e));
    await this.sweep().catch((e) => this.fail("sweep", e));
  }

  /**
   * Run `fn` every `ms`, never overlapping. While the gate is backing off from a 429 the tick is
   * skipped; after repeated 429s the interval is ×4 until a read succeeds.
   */
  private loop(name: string, ms: number, fn: () => Promise<void>) {
    const gate = this.o.gate;
    const schedule = (delay: number) => {
      if (this.stopped) return;
      const t = setTimeout(() => {
        this.timers.delete(t);
        void tick();
      }, delay);
      this.timers.add(t);
    };
    const tick = async () => {
      if (!gate?.blocked) await fn().catch((e) => this.fail(name, e));
      schedule(Math.max(ms * (gate?.slowdown ?? 1), gate?.retryInMs ?? 0));
    };
    schedule(ms);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.refreshTimer);
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.unwatch?.();
  }

  /** Reload triggers + worker set + expiry index, then catch up on_create for anything WS missed. */
  async refresh() {
    const { triggers, invalid } = await loadTriggers(this.o.reader, "active", this.triggerPayloads);
    pruneCache(this.triggerPayloads, [...triggers.map((t) => t.key), ...invalid.map((i) => i.key)]);
    const allow = this.o.triggerCreators;
    const accepted = allow.length === 0 ? triggers : triggers.filter((t) => allow.includes(lower(t.creator)));
    this.stats.triggersNotAllowed = triggers.length - accepted.length;
    this.listed.triggers = triggers.length + invalid.length;
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
    const workers = await listWorkers(this.o.reader, this.workerPayloads);
    pruneCache(this.workerPayloads, workers.map((w) => w.key));
    this.listed.workers = workers.length;
    this.workerKeys = new Set(workers.map((w) => lower(w.key)));
    const addrs = [...new Set([...workers.map((w) => lower(w.creator)), lower(this.o.address)])].sort();
    this.trustedWorkers = new Set(addrs);
    this.rank = Math.max(0, addrs.indexOf(lower(this.o.address)));
    return workers.length;
  }

  /** WS push path. Created keys are buffered and flushed in batches (one query per batch). */
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
      onExpiryExtended: (e) => {
        // A trigger's own lifetime moved: keep the cached record's deadline current.
        const t = this.triggers.get(e.entityKey);
        if (t && e.expiresAt > t.expiresAt) t.expiresAt = e.expiresAt;
        guard("ws extend", this.expiry.onExtended(e.entityKey, e.expiresAt, e.blockNumber));
      },
      // A trigger's spec or status, or a worker's registration, changed: reload soon. A patch
      // keeps the counts the same, so this is the only way to see it before the safety refresh.
      onEntityPatched: (e) => {
        if (this.triggers.has(e.entityKey) || this.workerKeys.has(lower(e.entityKey))) this.refreshSoon();
      },
      onEntityDeleted: (e) => guard("ws delete", this.expiry.onDeleted(e.entityKey, e.blockNumber)),
      onError: (err) => this.fail("ws", err),
    });
  }

  /** Debounced refresh (a burst of patches costs one reload). */
  private refreshSoon(ms = 5_000) {
    if (this.refreshTimer || this.stopped) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      if (this.o.gate?.blocked) return this.refreshSoon(this.o.gate.retryInMs + 1_000);
      void this.refresh().catch((e) => this.fail("refresh", e));
    }, ms);
  }

  /**
   * Did triggers or workers appear, disappear, pause or resume since the last refresh? Two free
   * counts instead of two billed lists. (Patches are caught by EntityPatched instead.)
   */
  private async changed(head: bigint): Promise<boolean> {
    if (this.listed.triggers < 0) return true;
    const [t, w] = await Promise.all([countTriggers(this.o.reader, "active", head), countWorkers(this.o.reader, head)]);
    return t !== this.listed.triggers || w !== this.listed.workers;
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

  /**
   * One query fetches every buffered key's attributes; each on_create trigger and query watch is
   * then matched locally (falling back to the node only where local matching isn't exact).
   * Before: one query per trigger per batch.
   */
  private async flush() {
    if (this.pending.size === 0) return;
    const onCreate = [...this.triggers.values()].filter((t) => t.spec.cond.type === "on_create");
    if (onCreate.length === 0 && !this.expiry.hasQueryWatches) {
      this.pending.clear(); // nothing could match: don't spend a query finding out
      return;
    }
    const keys = [...this.pending];
    this.pending.clear();
    const filters = [...onCreate.map((t) => t.spec.cond as QueryFilter), ...this.expiry.queryWatchFilters()];
    let rows;
    let head: bigint;
    try {
      head = await this.o.reader.getBlockNumber();
      rows = await fetchCandidates(this.o.reader, keys, filters, head);
    } catch (e) {
      for (const k of keys) this.pending.add(k); // keep them for the next flush (e.g. after a 429)
      throw e;
    }
    if (rows.length === 0) return;
    for (const t of onCreate) {
      if (t.spec.cond.type !== "on_create") continue;
      for (const m of await matchRows(this.o.reader, t.spec.cond, rows)) {
        if (m.createdAt > t.createdAt) await this.fire(t, onCreateFiring(m));
      }
    }
    await this.expiry.onCreated(rows, head);
  }

  /** Pollers for conditions no event can signal: silence and counts. */
  private async poll() {
    const head = await this.o.reader.getBlockNumber();
    if (await this.changed(head)) {
      this.o.log.info("triggers or workers changed (free count); refreshing");
      await this.refresh();
    }
    for (const t of this.triggers.values()) {
      if (this.o.gate?.blocked) return; // rate limited mid-pass: the rest waits for the next tick
      const c = t.spec.cond;
      try {
        let firing: Firing | undefined;
        if (c.type === "on_silence") {
          if (head < (this.silenceDue.get(t.key) ?? 0n)) {
            // Silent and handled: a resumed heartbeat changes the free count; only then re-check.
            const known = this.silenceCount.get(t.key);
            if (known === undefined || (await countMatching(this.o.reader, conditionExpression(c), head)) === known) continue;
          }
          const r = await evalOnSilence(this.o.reader, c, head);
          // Heard recently: the next possible silence is newest + silence_blocks.
          if (!r.firing) {
            this.silenceDue.set(t.key, r.dueAt);
            this.silenceCount.delete(t.key);
            continue;
          }
          await this.fire(t, r.firing);
          // Silent and handled: watch the free count, with a billed re-check at least every
          // 10 min (a heartbeat landing as another expires keeps the count equal). Not handled
          // (error, cap): retry next poll.
          if (this.handled(t.key, r.firing.epoch)) {
            this.silenceCount.set(t.key, await countMatching(this.o.reader, conditionExpression(c), head));
            this.silenceDue.set(t.key, head + BigInt(Math.max(c.silence_blocks, SILENT_RECHECK_BLOCKS)));
          }
          continue;
        } else if (c.type === "on_count") {
          firing = await evalOnCount(this.o.reader, c, head); // a filtered count: free
        }
        if (firing) await this.fire(t, firing);
      } catch (e) {
        this.fail(`poll ${t.key}`, e);
      }
    }
  }

  /** Expiry sweep (every 30 s by default, ~15 blocks): Arkiv has no expiration event, so deadlines are checked here. */
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

  /** Fired by us or a trusted peer, or settled in dry run. */
  private handled(trigger: Hex, epoch: string): boolean {
    const id = firedId(trigger, epoch);
    return Boolean(this.o.store.data.fired[id]) || this.dryFired.has(id);
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
    // An expired trigger is over, even if the safety refresh hasn't dropped it yet.
    if (f.evidenceBlock >= t.expiresAt) return;
    if (this.o.store.data.fired[id] || this.inflight.has(id) || this.dryFired.has(id)) return;
    const sealed = t.mode === "sealed";
    const job = sealed ? this.o.store.data.sealed[t.key] : undefined;
    if (sealed && !job) return;
    // Sealed receipts carry a salted, hashed epoch: the raw one would say what matched.
    const epoch = job ? sealedEpoch(job.salt, f.epoch) : f.epoch;
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
        await this.fireSealed(t, f, id, sealedEpoch(job!.salt, f.epoch), head, writer, log);
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
      { result_hash: resultHash(job.salt, f.epoch, f.matchedKeys[0]) },
    );
    this.recent.get(t.key)?.push(Date.now());
    this.stats.firedSelf++;
    this.o.store.data.fired[id] = { by: "self", receipt: receipt.key, tx: receipt.tx, at: new Date().toISOString() };
    await this.o.store.write();
    log.info({ receipt: receipt.key, tx: receipt.tx }, "FIRED (sealed): delivered + receipt");
  }

  private fail(where: string, e: unknown) {
    if (this.o.gate?.note(e)) {
      this.stats.rateLimited++;
      this.o.log.warn(
        { where, retryInSeconds: Math.ceil(this.o.gate.retryInMs / 1000), consecutive: this.o.gate.consecutive },
        "rate limited; backing off",
      );
      return;
    }
    this.stats.errors++;
    this.o.log.error({ where, err: e instanceof Error ? e.message : String(e) }, "error");
  }
}
