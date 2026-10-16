import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { JSONFilePreset } from "lowdb/node";
import type { Low } from "lowdb";
import type { Hex } from "viem";

/** One (trigger, epoch) we have handled — fired ourselves, or saw a trusted peer fire. */
export interface FiredRecord {
  by: "self" | "peer";
  receipt: Hex;
  tx?: Hex;
  at: string;
}

export type WatchState = "live" | "expired" | "deleted";

/** Persisted expiry-index entry (bigints as decimal strings). */
export interface WatchedRecord {
  expiresAt: string;
  lastSeenBlock: string;
  state: WatchState;
  deleteSeen: boolean;
}

export interface StoreData {
  fired: Record<string, FiredRecord>;
  /** Expiry index, by entity key. Survives restarts so expiries during downtime are still caught. */
  watched: Record<string, WatchedRecord>;
  /** `trigger|key` → the deadline when the trigger first saw the entity. Never moved. */
  pinned: Record<string, string>;
}

export type Store = Low<StoreData>;

export const firedId = (trigger: Hex, epoch: string) => `${trigger}|${epoch}`;
export const pinId = (trigger: Hex, key: Hex) => `${trigger}|${key}`;

/** Local job store: a JSON file per worker identity under DATA_DIR (a GCS volume on Cloud Run). */
export async function openStore(dataDir: string, workerName: string): Promise<Store> {
  mkdirSync(dataDir, { recursive: true });
  const db = await JSONFilePreset<StoreData>(join(dataDir, `${workerName}.json`), {
    fired: {},
    watched: {},
    pinned: {},
  });
  // Stores written by an older version lack the newer sections.
  db.data.watched ??= {};
  db.data.pinned ??= {};
  return db;
}
