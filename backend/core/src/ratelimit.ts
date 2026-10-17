/**
 * Rate-limit handling shared by the worker and the web app. Browser-safe.
 *
 * When the access key's quota runs out, Arkiv answers HTTP 429 (sometimes with `Retry-After`).
 * That is never fatal: callers back off 30 s → 60 s → 120 s … capped at 10 min, and slow their
 * polling while it keeps happening. viem's own retries are turned off for this (see `createReader`),
 * because a retry 150 ms later only spends more quota.
 */

export const BACKOFF_BASE_MS = 30_000;
export const BACKOFF_MAX_MS = 10 * 60_000;
/** After this many 429s in a row, every poll interval is multiplied by `SLOWDOWN`. */
export const SLOWDOWN_AFTER = 3;
export const SLOWDOWN = 4;

/** 30 s, 60 s, 120 s, … for the n-th consecutive failure (n ≥ 1), capped at 10 min. */
export function backoffMs(n: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, n - 1), BACKOFF_MAX_MS);
}

const RATE_LIMIT_TEXT = /\b429\b|rate.?limit|too many requests|quota/i;

/** Walk an error's `cause` chain (viem and the SDK wrap transport errors several levels deep). */
function* chain(e: unknown): Generator<Record<string, unknown>> {
  let cur = e;
  for (let depth = 0; cur != null && typeof cur === "object" && depth < 8; depth++) {
    yield cur as Record<string, unknown>;
    cur = (cur as { cause?: unknown }).cause;
  }
}

/** Is this a quota / rate-limit rejection (HTTP 429, JSON-RPC code 429, or its wording)? */
export function isRateLimited(e: unknown): boolean {
  if (typeof e === "string") return RATE_LIMIT_TEXT.test(e);
  for (const link of chain(e)) {
    if (link.status === 429 || link.code === 429) return true;
    for (const f of ["message", "shortMessage", "details"] as const) {
      if (typeof link[f] === "string" && RATE_LIMIT_TEXT.test(link[f])) return true;
    }
  }
  return false;
}

/** `Retry-After` in ms: delta-seconds or an HTTP date. Undefined if absent or unparseable. */
export function parseRetryAfter(v: string | null | undefined, now = Date.now()): number | undefined {
  if (!v) return undefined;
  const s = v.trim();
  if (/^\d+$/.test(s)) return Number(s) * 1000;
  const at = Date.parse(s);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/** The server's requested delay, if the error carries the response headers (viem's HttpRequestError does). */
export function retryAfterMs(e: unknown): number | undefined {
  for (const link of chain(e)) {
    const h = link.headers as { get?: (n: string) => string | null } | undefined;
    const v = typeof h?.get === "function" ? parseRetryAfter(h.get("retry-after")) : undefined;
    if (v !== undefined) return v;
    if (typeof link.retryAfterMs === "number") return link.retryAfterMs;
  }
  return undefined;
}

/**
 * One per process (or per access key). Fed by every HTTP response through `gatedFetch`, so any
 * read anywhere updates it; loops consult it before reading.
 */
export class RateGate {
  /** 429s in a row; any successful response resets it. */
  consecutive = 0;
  total = 0;
  private until = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** Record a 429. The delay is the server's `Retry-After` when given, else exponential. */
  limited(retryAfter?: number): number {
    this.consecutive++;
    this.total++;
    const delay = Math.min(retryAfter ?? backoffMs(this.consecutive), BACKOFF_MAX_MS);
    this.until = Math.max(this.until, this.now() + delay);
    return delay;
  }

  ok() {
    this.consecutive = 0;
    this.until = 0;
  }

  /** Record a thrown error if it is a rate limit the transport didn't already see. */
  note(e: unknown): boolean {
    if (!isRateLimited(e)) return false;
    if (!this.blocked) this.limited(retryAfterMs(e));
    return true;
  }

  /** True while backing off: skip reads until then. */
  get blocked(): boolean {
    return this.now() < this.until;
  }

  get retryInMs(): number {
    return Math.max(0, this.until - this.now());
  }

  /** Poll-interval multiplier: ×4 after 3 consecutive 429s, until a read succeeds. */
  get slowdown(): number {
    return this.consecutive >= SLOWDOWN_AFTER ? SLOWDOWN : 1;
  }
}

export type FetchFn = typeof fetch;

/** Methods Arkiv bills (`Arkiv-Cost`); everything else is free and keeps working at 100% quota. */
const BILLED = new Set(["arkiv_query"]);

function billed(body: unknown): boolean {
  if (typeof body !== "string") return true;
  try {
    const v = JSON.parse(body) as { method?: unknown } | { method?: unknown }[];
    return (Array.isArray(v) ? v : [v]).some((c) => typeof c.method === "string" && BILLED.has(c.method));
  } catch {
    return true;
  }
}

/**
 * A `fetch` for viem's http transport that reports every response's status to `gate`.
 * Only a successful billed call clears a backoff: with the quota spent, `eth_blockNumber` and
 * `arkiv_getEntityCount` still succeed while every `arkiv_query` gets 429, so their success says
 * nothing about whether queries work again.
 */
export function gatedFetch(gate: RateGate, base: FetchFn = fetch): FetchFn {
  return (async (input: Parameters<FetchFn>[0], init?: Parameters<FetchFn>[1]) => {
    const res = await base(input, init);
    if (res.status === 429) gate.limited(parseRetryAfter(res.headers.get("retry-after")));
    else if (res.ok && (gate.consecutive === 0 || billed(init?.body))) gate.ok();
    return res;
  }) as FetchFn;
}
