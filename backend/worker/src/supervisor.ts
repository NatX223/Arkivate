import { backoffMs, isRateLimited, type RateGate } from "@arkivate/core";
import type { Logger } from "pino";

export type Mode = "starting" | "rate_limited" | "dry-run" | "live";

/** Thrown for problems no retry can fix (wrong chain). Everything else is retried. */
export class FatalBootError extends Error {
  override name = "FatalBootError";
}

/**
 * What `/health` reports. The HTTP server starts before the first Arkiv read, so this is always
 * answerable: `starting` until boot completes, `rate_limited` while backing off from a 429.
 */
export class Status {
  /** Set once boot has completed: `live` (registered) or `dry-run` (unfunded). */
  base: "starting" | "dry-run" | "live" = "starting";
  lastError: string | undefined;
  private bootRetryAt = 0;

  constructor(
    private readonly gate: RateGate,
    private readonly now: () => number = Date.now,
  ) {}

  /** Boot is waiting out a non-rate-limit failure (e.g. RPC unreachable). */
  waitBoot(ms: number) {
    this.bootRetryAt = this.now() + ms;
  }

  get mode(): Mode {
    return this.gate.blocked ? "rate_limited" : this.base;
  }

  get retryInSeconds(): number | null {
    const ms = Math.max(this.gate.retryInMs, this.base === "starting" ? this.bootRetryAt - this.now() : 0);
    return ms > 0 ? Math.ceil(ms / 1000) : null;
  }
}

export interface BootOptions {
  status: Status;
  gate: RateGate;
  log: Logger;
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Run `boot` until it succeeds. A 429 backs off per the gate (Retry-After, else 30 s, 60 s, …
 * capped at 10 min); any other error backs off the same way. Only `FatalBootError` escapes.
 * Never exits the process: a crash here used to make systemd restart us every 5 s, and every
 * restart re-read Arkiv.
 */
export async function bootWithBackoff(boot: () => Promise<void>, o: BootOptions): Promise<void> {
  const sleep = o.sleep ?? realSleep;
  let failures = 0;
  for (;;) {
    try {
      await boot();
      o.status.lastError = undefined;
      return;
    } catch (e) {
      if (e instanceof FatalBootError) throw e;
      failures++;
      const msg = e instanceof Error ? e.message.split("\n")[0]! : String(e);
      o.status.lastError = msg;
      let wait: number;
      if (o.gate.note(e) || isRateLimited(e)) {
        wait = Math.max(o.gate.retryInMs, 1);
        o.log.warn({ retryInSeconds: Math.ceil(wait / 1000), consecutive: o.gate.consecutive }, "rate limited during startup; backing off");
      } else {
        wait = backoffMs(failures);
        o.status.waitBoot(wait);
        o.log.error({ err: msg, retryInSeconds: Math.ceil(wait / 1000) }, "startup failed; retrying");
      }
      await sleep(wait);
    }
  }
}
