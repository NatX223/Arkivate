import {
  evalOnCount,
  evalOnSilence,
  findReceipts,
  listWorkers,
  loadTriggers,
  matchCandidates,
  onCreateFiring,
  recentMatches,
  type Firing,
  type Reader,
  type TriggerRecord,
} from "@arkivate/core";
import type { Logger } from "pino";
import type { Hex } from "viem";
import type { ChainWriter } from "./chain.js";
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
  pollMs?: number;
  refreshMs?: number;
  flushMs?: number;
}

const lower = (a: string) => a.toLowerCase();

/**
 * Head start per rank. Must exceed detect → write → mined (~5–7 s measured on Tiramisu), or a
 * backup worker re-checks before the primary's receipt lands and fires a duplicate.
 */
const FIRE_SLOT_MS = 12_000;
const MAX_FIRE_DELAY_MS = 36_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Engine {
  private triggers = new Map<Hex, TriggerRecord>();
  /** Lowercased creators whose receipts we accept for dedupe: live registered workers + us. */
  private trustedWorkers = new Set<string>();
  private rank = 0;
  private pending = new Set<Hex>();
  private inflight = new Set<string>();
  /** Dry-run firings, kept in memory only so they still fire for real once funded. */
  private dryFired = new Set<string>();
  private timers: NodeJS.Timeout[] = [];
  private unwatch: (() => void) | undefined;
  readonly stats = { firedSelf: 0, skippedPeer: 0, wouldFire: 0, errors: 0 };

  constructor(private readonly o: EngineOptions) {}

  get triggerCount() {
    return this.triggers.size;
  }

  async start() {
    await this.refresh();
    this.watch();
    const every = (ms: number, fn: () => Promise<void>) =>
      this.timers.push(setInterval(() => void fn().catch((e) => this.fail("timer", e)), ms));
    every(this.o.flushMs ?? 2_000, () => this.flush());
    every(this.o.pollMs ?? 30_000, () => this.poll());
    every(this.o.refreshMs ?? 5 * 60_000, () => this.refresh());
    await this.poll();
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.unwatch?.();
  }

  /** Reload triggers + worker set, then run the on_create catch-up for anything WS missed. */
  async refresh() {
    const { triggers, invalid } = await loadTriggers(this.o.reader, "active");
    this.triggers = new Map(triggers.map((t) => [t.key, t]));
    for (const i of invalid) this.o.log.debug({ trigger: i.key, error: i.error }, "ignoring invalid trigger");

    const workers = await this.refreshWorkers();
    this.o.log.info(
      { triggers: this.triggers.size, invalid: invalid.length, workers, rank: this.rank },
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

  /** WS push path: buffer created keys, flushed in batches so each trigger costs one query. */
  private watch() {
    this.unwatch = this.o.wsReader.watchEntityEvents({
      onEntityCreated: (e) => {
        // Cheap prefilter: if every on_create trigger names a creator, ignore everyone else.
        // At creation the event's owner is the creator (a burn shows up as a later transfer).
        const creators = this.onCreateCreators();
        if (creators && !creators.has(lower(e.owner))) return;
        this.pending.add(e.entityKey);
      },
      onError: (err) => this.fail("ws", err),
    });
  }

  private onCreateCreators(): Set<string> | null {
    const out = new Set<string>();
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

  /** Has this (trigger, epoch) already got a receipt from a worker we trust? */
  private async peerReceipt(trigger: Hex, epoch: string) {
    const receipts = await findReceipts(this.o.reader, trigger, epoch);
    const trusted = () => receipts.find((r) => this.trustedWorkers.has(lower(r.creator)));
    // A receipt from an unknown creator may be a worker that registered since our last refresh.
    if (receipts.length > 0 && !trusted()) await this.refreshWorkers();
    return trusted();
  }

  private async fire(t: TriggerRecord, f: Firing) {
    const id = firedId(t.key, f.epoch);
    if (this.o.store.data.fired[id] || this.inflight.has(id) || this.dryFired.has(id)) return;
    this.inflight.add(id);
    const log = this.o.log.child({ trigger: t.key, epoch: f.epoch });
    try {
      let peer = await this.peerReceipt(t.key, f.epoch);
      if (!peer) {
        // Lower-ranked workers go first; the rest wait, then re-check before spending gas.
        if (this.rank > 0) await sleep(Math.min(this.rank * FIRE_SLOT_MS, MAX_FIRE_DELAY_MS) + Math.random() * 1_000);
        peer = await this.peerReceipt(t.key, f.epoch);
      }
      if (peer) {
        this.stats.skippedPeer++;
        this.o.store.data.fired[id] = { by: "peer", receipt: peer.key, at: new Date().toISOString() };
        await this.o.store.write();
        log.info({ receipt: peer.key, by: peer.creator }, "already fired by a worker; skipping");
        return;
      }

      const writer = this.o.writer();
      if (!writer) {
        this.stats.wouldFire++;
        this.dryFired.add(id);
        log.warn({ summary: f.summary }, "WOULD FIRE (dry run: worker wallet unfunded)");
        return;
      }

      const head = await this.o.reader.getBlockNumber();
      const receipt = await writer.writeReceipt(
        { trigger: t.key, mode: "public", epoch: f.epoch, firedBlock: head, evidenceBlock: f.evidenceBlock },
        { matched_keys: f.matchedKeys, summary: f.summary },
      );
      this.stats.firedSelf++;
      this.o.store.data.fired[id] = { by: "self", receipt: receipt.key, tx: receipt.tx, at: new Date().toISOString() };
      await this.o.store.write();
      log.info({ receipt: receipt.key, tx: receipt.tx, summary: f.summary }, "FIRED");
    } catch (e) {
      this.fail(`fire ${id}`, e);
    } finally {
      this.inflight.delete(id);
    }
  }

  private fail(where: string, e: unknown) {
    this.stats.errors++;
    this.o.log.error({ where, err: e instanceof Error ? e.message : String(e) }, "error");
  }
}
