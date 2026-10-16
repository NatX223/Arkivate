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
  return {
    project: PROJECT,
    entity_type: ENTITY_TYPES.trigger,
    cond_type: str(spec.cond.type),
    status: str(status),
    created_at: u64(Date.now()),
  };
}

export type ReceiptMode = "public" | "sealed";

export interface ReceiptFields {
  trigger: Hex;
  mode: ReceiptMode;
  epoch: string;
  firedBlock: bigint;
  evidenceBlock: bigint;
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

export type DemoFeedKind = "heartbeat" | "event";

export function demoFeedAttributes(kind: DemoFeedKind, seq: number) {
  return {
    project: PROJECT,
    entity_type: ENTITY_TYPES.demo_feed,
    kind: str(kind),
    seq: u64(seq),
    created_at: u64(Date.now()),
  };
}
