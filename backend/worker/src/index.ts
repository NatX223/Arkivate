#!/usr/bin/env -S npx tsx
import pino from "pino";
import { loadConfig } from "@arkivate/core/server";
import { startWorker } from "./worker.js";

const log = pino({ name: "arkivate-worker" });

async function main() {
  log.info("worker starting");
  const env = loadConfig(["WORKER_PRIVATE_KEY"]);
  const worker = await startWorker(env, log);

  const shutdown = () => {
    log.info("shutting down");
    void worker.stop().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Rate limits and RPC outages are retried inside; only config / wrong-chain errors end up here.
  await worker.booted;
}

main().catch((err: unknown) => {
  log.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
