export const PROJECT = "arkivate";
export const CHAIN_ID = 7738577;

/** Burn address: entities transferred here can never be deleted or modified again. */
export const DEAD = "0x000000000000000000000000000000000000dEaD" as const;

/** Arkiv native entity-operation precompile (all writes are txs to this address). */
export const ARKIV_PRECOMPILE = "0x4400000000000000000000000000000000000044" as const;

export const EXPLORER_URL = "https://tiramisu.explorer.arkiv.network";
export const txUrl = (hash: string) => `${EXPLORER_URL}/tx/${hash}`;

export const ENTITY_TYPES = {
  worker: "worker",
  trigger: "trigger",
  sealed: "sealed",
  acceptance: "acceptance",
  receipt: "receipt",
  reveal: "reveal",
} as const;
export type EntityType = (typeof ENTITY_TYPES)[keyof typeof ENTITY_TYPES];
