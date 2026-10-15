#!/usr/bin/env -S npx tsx
import pino from "pino";
import { loadConfig, makeReader, CHAIN_ID } from "@arkivate/core";

const log = pino({ name: "arkivate-worker" });

async function main() {
  log.info("worker starting");
  const env = loadConfig();
  log.info(
    {
      rpc: env.ARKIV_RPC_HTTP,
      port: env.WORKER_PORT,
      accessKey: env.ARKIV_ACCESS_KEY ? "set" : "missing",
      workerA: env.WORKER_A_PRIVATE_KEY ? "set" : "missing",
      workerB: env.WORKER_B_PRIVATE_KEY ? "set" : "missing",
    },
    "config validated",
  );

  // TODO(phase 1): register worker entity, WS watcher, pollers, POST /sealed — see technical-plan §5.
  const reader = makeReader(env);
  const chainId = await reader.getChainId();
  if (chainId !== CHAIN_ID) throw new Error(`wrong chain: ${chainId}, expected ${CHAIN_ID}`);
  log.info({ chainId, head: (await reader.getBlockNumber()).toString() }, "connected to Tiramisu");
}

main().catch((err: unknown) => {
  log.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
