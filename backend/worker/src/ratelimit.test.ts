import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHAIN_ID, RateGate, backoffMs, gatedFetch, isRateLimited, parseRetryAfter, type Reader } from "@arkivate/core";
import { parseEnv, type Wallet } from "@arkivate/core/server";
import pino from "pino";
import type { Hex } from "viem";
import { afterAll, describe, expect, it, vi } from "vitest";
import { startWorker, type RunningWorker } from "./worker.js";

/** What viem throws for an HTTP 429 (HttpRequestError): status + the response headers. */
const http429 = (retryAfter?: string) =>
  Object.assign(new Error("HTTP request failed.\n\nStatus: 429"), {
    status: 429,
    headers: new Headers(retryAfter ? { "retry-after": retryAfter } : {}),
  });

/** A query builder whose every step chains, and which yields no entities. */
function emptyQuery(): unknown {
  const q: Record<string | symbol, unknown> = {};
  for (const m of ["where", "createdBy", "ownedBy", "limit", "atBlock", "orderBy"]) q[m] = () => q;
  q.fetch = async () => ({ entities: [], cursor: undefined });
  q[Symbol.asyncIterator] = async function* () {};
  return q;
}

describe("rate-limit helpers", () => {
  it("backs off 30 s, 60 s, 120 s … capped at 10 min", () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(backoffMs)).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000]);
  });

  it("recognises 429s however they are wrapped", () => {
    expect(isRateLimited(http429())).toBe(true);
    expect(isRateLimited(new Error("outer", { cause: http429() }))).toBe(true);
    expect(isRateLimited(Object.assign(new Error("x"), { code: 429 }))).toBe(true);
    expect(isRateLimited(new Error("execution reverted"))).toBe(false);
  });

  it("parses Retry-After seconds and dates", () => {
    expect(parseRetryAfter("90")).toBe(90_000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 0)).toBe(10_000);
    expect(parseRetryAfter(null)).toBeUndefined();
  });

  it("gate honours Retry-After, slows ×4 after 3 in a row, and resets on success", async () => {
    let t = 0;
    const gate = new RateGate(() => t);
    const responses = [429, 429, 429, 200];
    const f = gatedFetch(gate, async () => new Response("{}", { status: responses.shift()!, headers: { "retry-after": "5" } }));
    await f("http://x");
    expect(gate.retryInMs).toBe(5_000);
    expect(gate.slowdown).toBe(1);
    await f("http://x");
    await f("http://x");
    expect(gate.slowdown).toBe(4);
    await f("http://x");
    expect(gate.slowdown).toBe(1);
    expect(gate.blocked).toBe(false);
  });
});

describe("worker startup under a 429", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "arkivate-ratelimit-"));
  let worker: RunningWorker | undefined;
  afterAll(async () => {
    await worker?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("serves /health while backing off, never exits, and goes rate_limited → live", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    // Fake clock: the controllable sleep advances it, so backoff windows elapse on demand.
    let t = 1_000_000;
    const gate = new RateGate(() => t);
    const wakeups: Array<() => void> = [];
    const sleeps: number[] = [];
    const sleep = (ms: number) =>
      new Promise<void>((r) => {
        sleeps.push(ms);
        wakeups.push(() => {
          t += ms;
          r();
        });
      });

    let chainCalls = 0;
    const address = "0x1111111111111111111111111111111111111111" as Hex;
    const reader = {
      getChainId: async () => {
        if (++chainCalls <= 2) throw http429();
        return CHAIN_ID;
      },
      getBlockNumber: async () => 1000n,
      getBalance: async () => 10n ** 18n,
      select: () => emptyQuery(),
    } as unknown as Reader;
    const wallet = {
      account: { address },
      createEntity: async () => ({ entityKey: `0x${"c".repeat(64)}`, txHash: `0x${"d".repeat(64)}` }),
    } as unknown as Wallet;
    const wsReader = { watchEntityEvents: () => () => {} } as unknown as Reader;

    const env = parseEnv({ WORKER_NAME: "test-worker", HOST: "127.0.0.1", DATA_DIR: dataDir });
    // Port 0 (ephemeral) isn't a valid env value, so set it after validation.
    worker = await startWorker({ ...env, WORKER_PORT: 0 }, pino({ level: "silent" }), {
      gate,
      reader,
      wsReader,
      wallet,
      sleep,
    });
    const port = (worker.server.address() as { port: number }).port;
    const health = async () => (await fetch(`http://127.0.0.1:${port}/health`)).json() as Promise<Record<string, unknown>>;
    const nextSleep = async () => {
      while (wakeups.length === 0) await new Promise((r) => setTimeout(r, 5));
      return wakeups.shift()!;
    };

    // 1st 429: /health already answers (server is up before the first read), backing off 30 s.
    const wake1 = await nextSleep();
    expect(await health()).toMatchObject({ ok: true, mode: "rate_limited", retryInSeconds: 30, chainId: null });

    // 2nd 429: 60 s.
    wake1();
    const wake2 = await nextSleep();
    expect(await health()).toMatchObject({ mode: "rate_limited", retryInSeconds: 60 });

    // Then the read succeeds: boot completes and the worker is live.
    wake2();
    await worker.booted;
    expect(await health()).toMatchObject({ mode: "live", retryInSeconds: null, chainId: CHAIN_ID });
    expect(sleeps).toEqual([30_000, 60_000]);
    expect(chainCalls).toBe(3);
    expect(exit).not.toHaveBeenCalled();
    exit.mockRestore();
  });
});
