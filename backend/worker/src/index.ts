#!/usr/bin/env -S npx tsx
import { fileURLToPath } from "node:url";
import express from "express";
import pino from "pino";
import { formatEther, type Hex } from "viem";
import { CHAIN_ID, txUrl } from "@arkivate/core";
import { loadConfig, makeReader, makeWallet, makeWsReader } from "@arkivate/core/server";
import { ChainWriter } from "./chain.js";
import { Engine } from "./engine.js";
import { openStore } from "./store.js";

const log = pino({ name: "arkivate-worker" });
const HEARTBEAT_MS = 6 * 60 * 60_000;
const FUNDING_CHECK_MS = 60_000;

async function main() {
  log.info("worker starting");
  const env = loadConfig(["WORKER_PRIVATE_KEY"]);
  const port = env.PORT ?? env.WORKER_PORT;
  const dataDir = env.DATA_DIR ?? fileURLToPath(new URL("../data", import.meta.url));
  log.info(
    {
      worker: env.WORKER_NAME,
      rpc: env.ARKIV_RPC_HTTP,
      port,
      dataDir,
      accessKey: env.ARKIV_ACCESS_KEY ? "set" : "missing",
      endpoint: env.PUBLIC_ENDPOINT ?? "(none)",
      triggerCreators: env.TRIGGER_CREATORS.length > 0 ? env.TRIGGER_CREATORS : "any",
      maxReceiptsPerTriggerPerHour: env.MAX_RECEIPTS_PER_TRIGGER_PER_HOUR,
    },
    "config validated",
  );

  const reader = makeReader(env);
  const chainId = await reader.getChainId();
  if (chainId !== CHAIN_ID) throw new Error(`wrong chain: ${chainId}, expected ${CHAIN_ID}`);
  log.info({ chainId, head: (await reader.getBlockNumber()).toString() }, "connected to Tiramisu");

  const wallet = makeWallet(env.WORKER_PRIVATE_KEY as Hex, env);
  const chain = new ChainWriter(reader, wallet);
  const address = wallet.account.address;
  const store = await openStore(dataDir, env.WORKER_NAME);

  // Unfunded writes fail with an opaque "Execution error", so stay read-only until funded.
  let live = false;
  let workerKey: Hex | undefined;
  const goLive = async () => {
    const balance = await reader.getBalance({ address });
    if (balance === 0n) return false;
    const reg = await chain.register(
      { name: env.WORKER_NAME, endpoint: env.PUBLIC_ENDPOINT ?? "" },
      ["public"],
    );
    workerKey = reg.key;
    live = true;
    log.info({ address, balance: formatEther(balance), workerKey, tx: txUrl(reg.tx), action: reg.action }, "LIVE: registered");
    return true;
  };
  if (!(await goLive())) {
    log.warn({ address }, "DRY RUN: worker wallet has 0 GLM; evaluating triggers without writing. Fund it at https://hub.arkiv.network/faucet");
    const t = setInterval(() => {
      goLive()
        .then((ok) => ok && clearInterval(t))
        .catch((e: unknown) => log.error({ err: String(e) }, "go-live check failed"));
    }, FUNDING_CHECK_MS);
  }
  setInterval(() => {
    if (!workerKey) return;
    chain
      .heartbeat(workerKey)
      .then((r) => log.info({ tx: txUrl(r.txHash) }, "heartbeat: worker entity extended"))
      .catch((e: unknown) => log.error({ err: String(e) }, "heartbeat failed"));
  }, HEARTBEAT_MS);

  const engine = new Engine({
    reader,
    wsReader: makeWsReader(env),
    store,
    log,
    address,
    writer: () => (live ? chain : null),
    triggerCreators: env.TRIGGER_CREATORS,
    maxReceiptsPerTriggerPerHour: env.MAX_RECEIPTS_PER_TRIGGER_PER_HOUR,
  });
  await engine.start();

  const app = express();
  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      name: env.WORKER_NAME,
      address,
      chainId,
      mode: live ? "live" : "dry-run",
      workerKey: workerKey ?? null,
      triggers: engine.triggerCount,
      watchedEntities: engine.watchedCount,
      triggerCreators: env.TRIGGER_CREATORS.length > 0 ? env.TRIGGER_CREATORS : "any",
      maxReceiptsPerTriggerPerHour: env.MAX_RECEIPTS_PER_TRIGGER_PER_HOUR,
      stats: engine.stats,
    });
  });
  // TODO(phase 2): POST /sealed hand-off — see technical-plan §5.
  app.listen(port, () => log.info({ port }, "listening"));

  const shutdown = () => {
    log.info("shutting down");
    engine.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err: unknown) => {
  log.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
