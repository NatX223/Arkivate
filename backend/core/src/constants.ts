export const PROJECT = "arkivate";
export const CHAIN_ID = 7738577;

export const TIRAMISU_RPC_HTTP = "https://rpc.tiramisu.db-chain.testnet.arkiv.network";
export const TIRAMISU_RPC_WS = "wss://rpc.tiramisu.db-chain.testnet.arkiv.network";

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
  /** Synthetic data feed for demos and tests (`arkivate demo-feed`). */
  demo_feed: "demo_feed",
} as const;
export type EntityType = (typeof ENTITY_TYPES)[keyof typeof ENTITY_TYPES];

/** Version string written on worker entities. */
export const WORKER_VERSION = "0.1.0";
