import {
  expiryEpoch,
  isExpiryCondition,
  matchWatchCandidates,
  readLive,
  snapshotWatch,
  type ExpiryCondition,
  type Firing,
  type LiveEntity,
  type Reader,
  type TriggerRecord,
} from "@arkivate/core";
import type { Logger } from "pino";
import type { Hex } from "viem";
import { pinId, type Store, type WatchState } from "./store.js";

type ExpiryTrigger = TriggerRecord & { spec: { cond: ExpiryCondition } };
const isExpiryTrigger = (t: TriggerRecord): t is ExpiryTrigger => isExpiryCondition(t.spec.cond);

interface Entry {
  expiresAt: bigint;
  lastSeenBlock: bigint;
  state: WatchState;
  deleteSeen: boolean;
}

export type Fire = (t: TriggerRecord, f: Firing) => Promise<void>;

/**
 * The expiry engine. Arkiv emits no expiration event, so this keeps an index of every watched
 * entity's deadline and sweeps it against the head; WS `ExpiryExtended` / `EntityDeleted` /
 * `EntityCreated` keep the index fresh between 5-minute rebuilds.
 */
export class ExpiryWatcher {
  private entries = new Map<Hex, Entry>();
  private byTrigger = new Map<Hex, { trigger: ExpiryTrigger; keys: Set<Hex> }>();
  private dirty = false;

  constructor(
    private readonly reader: Reader,
    private readonly store: Store,
    private readonly log: Logger,
    private readonly fire: Fire,
  ) {
    for (const [k, r] of Object.entries(store.data.watched)) {
      this.entries.set(k as Hex, {
        expiresAt: BigInt(r.expiresAt),
        lastSeenBlock: BigInt(r.lastSeenBlock),
        state: r.state,
        deleteSeen: r.deleteSeen,
      });
    }
  }

  get watchedCount() {
    return this.entries.size;
  }

  /** Query watches, so the WS prefilter knows which creators matter. */
  queryWatchCreators(): Set<string> | null {
    const out = new Set<string>();
    for (const { trigger } of this.byTrigger.values()) {
      const w = trigger.spec.cond.watch;
      if ("entity_key" in w) continue;
      if (!w.created_by) return null;
      out.add(w.created_by.toLowerCase());
    }
    return out;
  }

  /** Rebuild from the trigger list: index every watched entity at one pinned block. */
  async rebuild(triggers: readonly TriggerRecord[], head: bigint) {
    const next = new Map<Hex, { trigger: ExpiryTrigger; keys: Set<Hex> }>();
    for (const t of triggers) {
      if (!isExpiryTrigger(t)) continue;
      const prev = this.byTrigger.get(t.key)?.keys ?? new Set<Hex>();
      const keys = new Set<Hex>(prev);
      const snap = await snapshotWatch(this.reader, t.spec.cond.watch, head);
      const seen = new Set<Hex>();
      for (const s of snap) {
        seen.add(s.key);
        keys.add(s.key);
        await this.observe(s.key, s.expiresAt, head);
        this.pin(t.key, s.key, s.expiresAt);
      }
      const w = t.spec.cond.watch;
      if ("entity_key" in w) {
        keys.add(w.entity_key as Hex);
        if (!seen.has(w.entity_key as Hex) && !this.entries.has(w.entity_key as Hex)) {
          this.log.warn({ trigger: t.key, entity: w.entity_key }, "watched entity is not live and was never seen");
        }
      }
      next.set(t.key, { trigger: t, keys });
      // Known keys that vanished before their deadline can only have been deleted.
      for (const k of keys) {
        const e = this.entries.get(k);
        if (!seen.has(k) && e?.state === "live" && head + 1n < e.expiresAt) await this.onDeleted(k, head);
      }
    }
    this.byTrigger = next;
    await this.persist();
  }

  /** Record a live sighting. A later expiresAt than we knew means we missed an extension. */
  private async observe(k: Hex, expiresAt: bigint, block: bigint) {
    const e = this.entries.get(k);
    if (!e) {
      this.entries.set(k, { expiresAt, lastSeenBlock: block, state: "live", deleteSeen: false });
      this.dirty = true;
      return;
    }
    e.lastSeenBlock = block;
    if (e.state !== "live") e.state = "live";
    if (expiresAt > e.expiresAt) await this.onExtended(k, expiresAt, block);
    this.dirty = true;
  }

  private pin(trigger: Hex, k: Hex, expiresAt: bigint) {
    const id = pinId(trigger, k);
    if (this.store.data.pinned[id] === undefined) {
      this.store.data.pinned[id] = expiresAt.toString();
      this.dirty = true;
    }
  }

  private pinned(trigger: Hex, k: Hex): bigint | undefined {
    const v = this.store.data.pinned[pinId(trigger, k)];
    return v === undefined ? undefined : BigInt(v);
  }

  private watchers(k: Hex) {
    return [...this.byTrigger.values()].filter((w) => w.keys.has(k)).map((w) => w.trigger);
  }

  /** `ExpiryExtended` (WS), a missed extension found on rebuild, or our own Reactivate. */
  async onExtended(k: Hex, newExpiresAt: bigint, block: bigint) {
    const e = this.entries.get(k);
    if (!e || newExpiresAt <= e.expiresAt) return;
    const old = e.expiresAt;
    e.expiresAt = newExpiresAt;
    e.state = "live";
    e.lastSeenBlock = block;
    this.dirty = true;
    for (const t of this.watchers(k)) {
      if (t.spec.cond.type !== "on_extend") continue;
      await this.fire(t, {
        epoch: expiryEpoch.extend(k, newExpiresAt),
        evidenceBlock: block,
        matchedKeys: [k],
        subject: k,
        summary: `expiry of ${k} extended from block ${old} to ${newExpiresAt}`,
      });
    }
    // on_expiring re-arms by itself: its epoch is keyed by the (new) deadline.
  }

  /** `EntityDeleted` (WS), or a key that vanished before its deadline. */
  async onDeleted(k: Hex, block: bigint) {
    const e = this.entries.get(k);
    if (!e || e.state === "deleted") return;
    e.state = "deleted";
    e.deleteSeen = true;
    this.dirty = true;
    for (const t of this.watchers(k)) {
      if (t.spec.cond.type !== "on_delete") continue;
      await this.fire(t, {
        epoch: expiryEpoch.delete(k),
        evidenceBlock: block,
        matchedKeys: [k],
        subject: k,
        summary: `${k} was deleted by its owner (deadline was block ${e.expiresAt})`,
      });
    }
  }

  /** `EntityCreated` (WS): add new entities that a query watch covers. */
  async onCreated(candidates: readonly Hex[], head: bigint) {
    for (const { trigger, keys } of this.byTrigger.values()) {
      const w = trigger.spec.cond.watch;
      if ("entity_key" in w) continue;
      for (const s of await matchWatchCandidates(this.reader, w, candidates)) {
        keys.add(s.key);
        await this.observe(s.key, s.expiresAt, head);
        this.pin(trigger.key, s.key, s.expiresAt);
      }
    }
  }

  /** Compare every deadline with the head (every ~5 blocks). */
  async sweep(head: bigint) {
    const reads = new Map<Hex, LiveEntity | undefined>();
    const reread = async (k: Hex) => {
      if (!reads.has(k)) reads.set(k, await readLive(this.reader, k));
      return reads.get(k);
    };

    for (const { trigger: t, keys } of this.byTrigger.values()) {
      const c = t.spec.cond;
      if (c.type !== "on_expiring" && c.type !== "on_expire") continue;
      for (const k of keys) {
        const e = this.entries.get(k);
        if (!e || e.state === "deleted") continue;
        const pinned = c.deadline === "pinned" ? this.pinned(t.key, k) : undefined;
        const deadline = pinned ?? e.expiresAt;

        if (c.type === "on_expiring") {
          if (e.state === "live" && head >= e.expiresAt) {
            // Past the deadline (e.g. we were down): settle it rather than warn about the past.
            const now = await reread(k);
            if (now && now.expiresAt > head) await this.observe(k, now.expiresAt, head);
            else await this.settleGone(k, head);
            continue;
          }
          if (e.state === "live" && head >= deadline - BigInt(c.lead_blocks)) {
            await this.fire(t, {
              epoch: expiryEpoch.expiring(k, deadline),
              evidenceBlock: head,
              matchedKeys: [k],
              subject: k,
              summary: `${k} expires at block ${deadline} (${c.deadline}); head ${head}, lead ${c.lead_blocks}`,
            });
          }
          continue;
        }

        // on_expire
        if (head < deadline) continue;
        if (c.deadline === "pinned") {
          // The promised deadline passed. An extension (by anyone) doesn't move it.
          const now = e.state === "live" ? await reread(k) : undefined;
          if (now === undefined && e.state === "live") await this.settleGone(k, head);
          if (this.entries.get(k)?.state === "deleted") continue;
          await this.fire(t, {
            epoch: expiryEpoch.expire(k, deadline),
            evidenceBlock: head,
            matchedKeys: [k],
            subject: k,
            summary: now
              ? `pinned deadline ${deadline} passed; ${k} was extended and now expires at ${now.expiresAt}`
              : `${k} expired (pinned deadline ${deadline})`,
          });
          continue;
        }
        // follow: confirm it is really gone; a live entity means we missed an extension.
        if (e.state === "live") {
          const now = await reread(k);
          if (now && now.expiresAt > head) {
            await this.observe(k, now.expiresAt, head);
            continue;
          }
          await this.settleGone(k, head);
        }
        if (this.entries.get(k)?.state !== "expired") continue;
        await this.fire(t, {
          epoch: expiryEpoch.expire(k, deadline),
          evidenceBlock: head,
          matchedKeys: [k],
          subject: k,
          summary: `${k} expired at block ${deadline} (no extension, no delete seen)`,
        });
      }
    }
    await this.persist();
  }

  /**
   * The entity is gone. `NoEntityFoundError` can't say why, so: a delete we saw, or gone before
   * its known expiresAt (expiry can't come early) → deleted; otherwise → expired.
   */
  private async settleGone(k: Hex, head: bigint) {
    const e = this.entries.get(k);
    if (!e) return;
    if (!e.deleteSeen && head + 1n < e.expiresAt) {
      await this.onDeleted(k, head);
      return;
    }
    if (e.deleteSeen) {
      e.state = "deleted";
    } else {
      e.state = "expired";
      this.log.info({ entity: k, expiresAt: e.expiresAt.toString(), head: head.toString() }, "entity expired");
    }
    this.dirty = true;
  }

  private async persist() {
    if (!this.dirty) return;
    for (const [k, e] of this.entries) {
      this.store.data.watched[k] = {
        expiresAt: e.expiresAt.toString(),
        lastSeenBlock: e.lastSeenBlock.toString(),
        state: e.state,
        deleteSeen: e.deleteSeen,
      };
    }
    await this.store.write();
    this.dirty = false;
  }
}
