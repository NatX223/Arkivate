import { key, str, u64 } from "@arkiv-network/sdk/attr";
import type { Hex } from "viem";
import { ENTITY_TYPES, PROJECT } from "./constants.js";
import type { TriggerSpec } from "./spec.js";

/**
 * Attribute builders for every Arkivate entity — the single source of truth for arkiv/schema.md.
 * Names are lowercase snake_case; numbers that are blocks or timestamps are always u64.
 */

export type TriggerStatus = "active" | "paused";

export function triggerAttributes(spec: TriggerSpec, status: TriggerStatus = "active") {
  const watch = "watch" in spec.cond ? spec.cond.watch : undefined;
  return {
    project: PROJECT,
    entity_type: ENTITY_TYPES.trigger,
    cond_type: str(spec.cond.type),
    action_type: str(spec.action.type),
    status: str(status),
    created_at: u64(Date.now()),
    // Lets anyone find every trigger watching a given entity.
    ...(watch && "entity_key" in watch ? { watch_key: key(watch.entity_key as Hex) } : {}),
  };
}

export type ReceiptMode = "public" | "sealed";

/** Result of a Reactivate (`extend`) action. Absent for `notice` receipts. */
export type ReceiptOutcome = "extended" | "not_extendable" | "cap_reached";

export interface ReceiptFields {
  trigger: Hex;
  mode: ReceiptMode;
  epoch: string;
  firedBlock: bigint;
  evidenceBlock: bigint;
  /** The watched entity this firing is about (expiry-family conditions). */
  subject?: Hex | undefined;
  outcome?: ReceiptOutcome | undefined;
  oldExpiresAt?: bigint | undefined;
  newExpiresAt?: bigint | undefined;
}

export function receiptAttributes(r: ReceiptFields) {
  return {
    project: PROJECT,
    entity_type: ENTITY_TYPES.receipt,
    trigger: key(r.trigger),
    mode: str(r.mode),
    epoch: str(r.epoch),
    fired_block: u64(r.firedBlock),
    evidence_block: u64(r.evidenceBlock),
    ...(r.subject ? { subject: key(r.subject) } : {}),
    ...(r.outcome ? { outcome: str(r.outcome) } : {}),
    ...(r.oldExpiresAt !== undefined ? { old_expires_at: u64(r.oldExpiresAt) } : {}),
    ...(r.newExpiresAt !== undefined ? { new_expires_at: u64(r.newExpiresAt) } : {}),
  };
}

/** Public receipt payload. Sealed receipts carry only `{ result_hash }` (phase 2). */
export interface PublicReceiptPayload {
  matched_keys: Hex[];
  summary: string;
}

export function workerAttributes(version: string, modes: readonly string[]) {
  return {
    project: PROJECT,
    entity_type: ENTITY_TYPES.worker,
    version: str(version),
    modes: str(modes.join(",")),
  };
}

/** Worker payload. `endpoint` is the public hand-off URL (or "" when not deployed). */
export interface WorkerPayload {
  name: string;
  endpoint: string;
}

/**
 * heartbeat / event: Phase 1 conditions. listing: short-lived and extendable by anyone (the
 * keep-alive demo). canary: short-lived and *not* extendable, so it will expire.
 */
export type DemoFeedKind = "heartbeat" | "event" | "listing" | "canary";
export const DEMO_FEED_KINDS = ["heartbeat", "event", "listing", "canary"] as const;

export function demoFeedAttributes(kind: DemoFeedKind, seq: number) {
  return {
    project: PROJECT,
    entity_type: ENTITY_TYPES.demo_feed,
    kind: str(kind),
    seq: u64(seq),
    created_at: u64(Date.now()),
  };
}
