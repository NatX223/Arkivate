import { execFileSync } from "node:child_process";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import express from "express";
import type { Logger } from "pino";
import { formatEther, type Hex } from "viem";
import { CHAIN_ID, RateGate, gatedFetch, txUrl, type Reader } from "@arkivate/core";
import { makeReader, makeWallet, makeWsReader, type Env, type Wallet } from "@arkivate/core/server";
import { ChainWriter } from "./chain.js";
import { cors } from "./cors.js";
import { deliver } from "./deliver.js";
import { Engine } from "./engine.js";
import { handoffRouter } from "./handoff.js";
import { openStore } from "./store.js";
import { FatalBootError, Status, bootWithBackoff } from "./supervisor.js";

const HEARTBEAT_MS = 6 * 60 * 60_000;
const FUNDING_CHECK_MS = 60_000;

/** Short commit of the running checkout; GIT_SHA when git or the .git dir isn't there. */
function codeVersion(fallback: string | undefined): string {
  try {
    const repo = fileURLToPath(new URL("../../..", import.meta.url));
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return fallback ?? "unknown";
  }
}

/** Everything that talks to the network, injectable so tests can run the real startup path. */
export interface WorkerDeps {
  gate?: RateGate;
  reader?: Reader;
  wsReader?: Reader;
  wallet?: Wallet;
  sleep?: (ms: number) => Promise<void>;
  engine?: Partial<Pick<ConstructorParameters<typeof Engine>[0], "pollMs" | "sweepMs" | "refreshMs" | "flushMs">>;
}

export interface RunningWorker {
  status: Status;
  engine: Engine;
  server: Server;
  /** Resolves when boot has completed (live or dry-run). Rejects only on a fatal error. */
  booted: Promise<void>;
  stop(): Promise<void>;
}

/**
 * Start the worker. Order matters: the HTTP server listens before the first Arkiv read, so
 * `/health` always answers, even while startup is backing off from a 429.
 */
export async function startWorker(env: Env, log: Logger, deps: WorkerDeps = {}): Promise<RunningWorker> {
  const port = env.PORT ?? env.WORKER_PORT;
  const host = env.HOST ?? (env.NODE_ENV === "production" ? "127.0.0.1" : "0.0.0.0");
  const version = codeVersion(env.GIT_SHA);
  const dataDir = env.DATA_DIR ?? fileURLToPath(new URL("../data", import.meta.url));
  log.info(
    {
      worker: env.WORKER_NAME,
      version,
      rpc: env.ARKIV_RPC_HTTP,
      host,
      port,
      dataDir,
      corsOrigins: env.CORS_ORIGINS,
      accessKey: env.ARKIV_ACCESS_KEY ? "set" : "missing",
      endpoint: env.PUBLIC_ENDPOINT ?? "(none)",
      triggerCreators: env.TRIGGER_CREATORS.length > 0 ? env.TRIGGER_CREATORS : "any",
      maxReceiptsPerTriggerPerHour: env.MAX_RECEIPTS_PER_TRIGGER_PER_HOUR,
    },
    "config validated",
  );

  const gate = deps.gate ?? new RateGate();
  // retryCount 0: viem would retry a 429 within milliseconds; our loops are the retry.
  const hooks = { fetchFn: gatedFetch(gate), retryCount: 0 };
  const reader = deps.reader ?? makeReader(env, hooks);
  const wallet = deps.wallet ?? makeWallet(env.WORKER_PRIVATE_KEY as Hex, env, hooks);
  const chain = new ChainWriter(reader, wallet);
  const address = wallet.account.address;
  const store = await openStore(dataDir, env.WORKER_NAME);
  const status = new Status(gate);

  // Unfunded writes fail with an opaque "Execution error", so stay read-only until funded.
  let live = false;
  let chainId: number | undefined;
  let workerKey: Hex | undefined;
  const engine = new Engine({
    reader,
    wsReader: deps.wsReader ?? makeWsReader(env),
    store,
    log,
    address,
    writer: () => (live ? chain : null),
    triggerCreators: env.TRIGGER_CREATORS,
    maxReceiptsPerTriggerPerHour: env.MAX_RECEIPTS_PER_TRIGGER_PER_HOUR,
    skipSealed: env.SKIP_SEALED,
    deliver: (d, a) => deliver(d, a, env.TELEGRAM_BOT_TOKEN),
    gate,
    ...deps.engine,
  });

  const app = express();
  app.use(
    handoffRouter({
      reader,
      store,
      log,
      address,
      writer: () => (live ? chain : null),
      corsOrigins: env.CORS_ORIGINS,
      triggerCreators: env.TRIGGER_CREATORS,
      onAccepted: (k) => engine.activateSealed(k),
    }),
  );
  // Public status only; the web app's Workers page reads it from the browser, so CORS_ORIGINS applies.
  app.get("/health", cors(env.CORS_ORIGINS, "GET"), (_req, res) => {
    res.json({
      ok: true,
      name: env.WORKER_NAME,
      version,
      uptimeSeconds: Math.floor(process.uptime()),
      address,
      chainId: chainId ?? null,
      mode: status.mode,
      retryInSeconds: status.retryInSeconds,
      ...(status.base === "starting" && status.lastError ? { lastError: status.lastError } : {}),
      workerKey: workerKey ?? null,
      triggers: engine.triggerCount,
      watchedEntities: engine.watchedCount,
      sealedJobs: engine.sealedJobCount,
      skipSealed: env.SKIP_SEALED,
      telegram: env.TELEGRAM_BOT_TOKEN ? "configured" : "not configured",
      triggerCreators: env.TRIGGER_CREATORS.length > 0 ? env.TRIGGER_CREATORS : "any",
      maxReceiptsPerTriggerPerHour: env.MAX_RECEIPTS_PER_TRIGGER_PER_HOUR,
      stats: engine.stats,
    });
  });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(port, host, () => resolve(s));
  });
  log.info({ host, port }, "listening");

  const timers: NodeJS.Timeout[] = [];
  const goLive = async () => {
    const balance = await reader.getBalance({ address });
    if (balance === 0n) return false;
    const reg = await chain.register({ name: env.WORKER_NAME, endpoint: env.PUBLIC_ENDPOINT ?? "" }, ["public"]);
    workerKey = reg.key;
    live = true;
    log.info({ address, balance: formatEther(balance), workerKey, tx: txUrl(reg.tx), action: reg.action }, "LIVE: registered");
    return true;
  };
  let fundingWatch = false;
  const watchFunding = () => {
    if (fundingWatch) return;
    fundingWatch = true;
    log.warn({ address }, "DRY RUN: worker wallet has 0 GLM; evaluating triggers without writing. Fund it at https://hub.arkiv.network/faucet");
    const t = setInterval(() => {
      if (live) return void clearInterval(t);
      if (gate.blocked) return;
      goLive()
        .then((ok) => {
          if (!ok) return;
          clearInterval(t);
          status.base = "live";
        })
        .catch((e: unknown) => {
          if (!gate.note(e)) log.error({ err: String(e) }, "go-live check failed");
        });
    }, FUNDING_CHECK_MS);
    timers.push(t);
  };

  const booted = bootWithBackoff(
    async () => {
      if (chainId === undefined) {
        const id = await reader.getChainId();
        if (id !== CHAIN_ID) throw new FatalBootError(`wrong chain: ${id}, expected ${CHAIN_ID}`);
        chainId = id;
        log.info({ chainId, head: (await reader.getBlockNumber()).toString() }, "connected to Tiramisu");
      }
      if (!live && !(await goLive())) watchFunding();
      await engine.start();
      status.base = live ? "live" : "dry-run";
      log.info({ mode: status.base }, "worker running");
    },
    { status, gate, log, ...(deps.sleep ? { sleep: deps.sleep } : {}) },
  );

  timers.push(
    setInterval(() => {
      if (!workerKey) return;
      chain
        .heartbeat(workerKey)
        .then((r) => log.info({ tx: txUrl(r.txHash) }, "heartbeat: worker entity extended"))
        .catch((e: unknown) => {
          if (!gate.note(e)) log.error({ err: String(e) }, "heartbeat failed");
          else log.warn("heartbeat rate limited; the worker entity lives 1 day, the next heartbeat retries");
        });
    }, HEARTBEAT_MS),
  );

  if (env.SKIP_SEALED) {
    log.warn("SKIP_SEALED=true: DEMO SWITCH ON. Sealed jobs are accepted but will never fire.");
  }

  return {
    status,
    engine,
    server,
    booted,
    stop: async () => {
      engine.stop();
      for (const t of timers) clearInterval(t);
      await new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections();
      });
    },
  };
}
