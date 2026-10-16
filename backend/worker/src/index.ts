#!/usr/bin/env -S npx tsx
import { fileURLToPath } from "node:url";
import express from "express";
import pino from "pino";
import { CHAIN_ID } from "@arkivate/core";
import { loadConfig, makeReader } from "@arkivate/core/server";

const log = pino({ name: "arkivate-worker" });

async function main() {
  log.info("worker starting");
  const env = loadConfig();
  const port = env.PORT ?? env.WORKER_PORT;
  const dataDir = env.DATA_DIR ?? fileURLToPath(new URL("../data", import.meta.url));
  log.info(
    {
      worker: env.WORKER_NAME,
      rpc: env.ARKIV_RPC_HTTP,
      port,
      dataDir,
      accessKey: env.ARKIV_ACCESS_KEY ? "set" : "missing",
      workerKey: env.WORKER_PRIVATE_KEY ? "set" : "missing",
    },
    "config validated",
  );

  const reader = makeReader(env);
  const chainId = await reader.getChainId();
  if (chainId !== CHAIN_ID) throw new Error(`wrong chain: ${chainId}, expected ${CHAIN_ID}`);
  log.info({ chainId, head: (await reader.getBlockNumber()).toString() }, "connected to Tiramisu");

  // TODO(phase 1): register worker entity, WS watcher, pollers, POST /sealed — see technical-plan §5.
  const app = express();
  app.get("/health", (_req, res) => {
    res.json({ ok: true, name: env.WORKER_NAME, chainId });
  });
  app.listen(port, () => log.info({ port }, "listening"));
}

main().catch((err: unknown) => {
  log.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
