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

export interface StoreData {
  fired: Record<string, FiredRecord>;
}

export type Store = Low<StoreData>;

export const firedId = (trigger: Hex, epoch: string) => `${trigger}|${epoch}`;

/** Local job store: a JSON file per worker identity under DATA_DIR (a GCS volume on Cloud Run). */
export async function openStore(dataDir: string, workerName: string): Promise<Store> {
  mkdirSync(dataDir, { recursive: true });
  return JSONFilePreset<StoreData>(join(dataDir, `${workerName}.json`), { fired: {} });
}
