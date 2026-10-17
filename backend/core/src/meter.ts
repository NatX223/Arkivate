/**
 * RPC metering: calls and response bytes by method and by query shape. Browser-safe.
 *
 * Arkiv bills access keys in cost units that track response size, not just call count, so the
 * numbers that matter are bytes per shape. A shape is the query with its literals blanked out,
 * plus what it selects and its page size, e.g.
 *   select=key,payload where=project = "?" && entity_type = "?" limit=200
 */

import type { FetchFn } from "./ratelimit.js";

interface RpcBody {
  method?: unknown;
  params?: unknown;
}

/** Group key for one JSON-RPC call. Non-query methods are their own shape. */
export function rpcShape(call: RpcBody): string {
  const method = typeof call.method === "string" ? call.method : "?";
  const params = Array.isArray(call.params) ? call.params : [];
  if (method === "arkiv_query") {
    const [query, opts] = params as [unknown, { select?: Record<string, unknown>; limit?: string; atBlock?: string; cursor?: unknown } | undefined];
    const sel = Object.entries(opts?.select ?? {})
      .flatMap(([k, v]) => (v === true ? [k] : v && typeof v === "object" ? [`attributes{${Object.keys(v).join(",")}}`] : []))
      .join(",");
    const limit = opts?.limit ? Number(opts.limit) : "∞";
    return `arkiv_query select=${sel} where=${blank(String(query))} limit=${limit}${opts?.atBlock ? " atBlock" : ""}${opts?.cursor ? " +page" : ""}`;
  }
  if (method === "arkiv_getEntityCount") {
    const q = (params[0] as { query?: unknown } | undefined)?.query;
    return `arkiv_getEntityCount where=${q === undefined ? "(all)" : blank(String(q))}`;
  }
  return method;
}

/** Blank out literals so queries that differ only in values group together. */
function blank(q: string): string {
  return q
    .replace(/"(?:[^"\\]|\\.)*"/g, '"?"')
    .replace(/0x[0-9a-fA-F]+/g, "0x…")
    .replace(/\b\d+\b/g, "N")
    // Candidate batches: `$key = 0x… || $key = 0x… || …` → one group regardless of chunk size.
    .replace(/(\$key = 0x…)( \|\| \$key = 0x…)+/g, "$key IN (…)");
}

export interface MeterRow {
  calls: number;
  bytes: number;
  limited: number;
}

export interface MeterSnapshot {
  sinceSeconds: number;
  calls: number;
  bytes: number;
  limited: number;
  callsPerMinute: number;
  bytesPerMinute: number;
  byMethod: Record<string, MeterRow & { callsPerMinute: number }>;
  /** Top shapes by bytes. */
  topShapes: Array<{ shape: string } & MeterRow>;
}

export class RpcMeter {
  private readonly started: number;
  private readonly methods = new Map<string, MeterRow>();
  private readonly shapes = new Map<string, MeterRow>();

  constructor(private readonly now: () => number = Date.now) {
    this.started = now();
  }

  record(call: RpcBody, bytes: number, limited = false) {
    const method = typeof call.method === "string" ? call.method : "?";
    for (const [map, k] of [
      [this.methods, method],
      [this.shapes, rpcShape(call)],
    ] as const) {
      const row = map.get(k) ?? { calls: 0, bytes: 0, limited: 0 };
      row.calls++;
      row.bytes += bytes;
      if (limited) row.limited++;
      map.set(k, row);
    }
  }

  snapshot(top = 5): MeterSnapshot {
    const secs = Math.max(1, (this.now() - this.started) / 1000);
    let calls = 0;
    let bytes = 0;
    let limited = 0;
    for (const r of this.methods.values()) {
      calls += r.calls;
      bytes += r.bytes;
      limited += r.limited;
    }
    return {
      sinceSeconds: Math.round(secs),
      calls,
      bytes,
      limited,
      callsPerMinute: +((calls * 60) / secs).toFixed(1),
      bytesPerMinute: Math.round((bytes * 60) / secs),
      byMethod: Object.fromEntries(
        [...this.methods]
          .sort((a, b) => b[1].bytes - a[1].bytes)
          .map(([m, r]) => [m, { ...r, callsPerMinute: +((r.calls * 60) / secs).toFixed(1) }]),
      ),
      topShapes: [...this.shapes]
        .sort((a, b) => b[1].bytes - a[1].bytes)
        .slice(0, top)
        .map(([shape, r]) => ({ shape, ...r })),
    };
  }
}

/** Parse a JSON-RPC request body (single or batch); undefined if it isn't one. */
export function parseRpcBody(body: unknown): RpcBody[] | undefined {
  if (typeof body !== "string") return undefined;
  try {
    const v = JSON.parse(body) as RpcBody | RpcBody[];
    return Array.isArray(v) ? v : [v];
  } catch {
    return undefined;
  }
}

/**
 * Record a response against its request. Batch responses are split per call (by each element's
 * own size); anything else is charged to its single call.
 */
export function meterExchange(meter: RpcMeter, calls: RpcBody[], status: number, text: string) {
  const limited = status === 429;
  if (calls.length === 1) return meter.record(calls[0]!, text.length, limited);
  let parts: unknown[] | undefined;
  try {
    const v = JSON.parse(text) as unknown;
    if (Array.isArray(v) && v.length === calls.length) parts = v;
  } catch {
    // fall through: split evenly
  }
  calls.forEach((c, i) => meter.record(c, parts ? JSON.stringify(parts[i]).length : Math.round(text.length / calls.length), limited));
}

/** A `fetch` that meters every JSON-RPC exchange. Reads a clone, so the caller's body is untouched. */
export function meteredFetch(meter: RpcMeter, base: FetchFn = fetch): FetchFn {
  return (async (input: Parameters<FetchFn>[0], init?: Parameters<FetchFn>[1]) => {
    const res = await base(input, init);
    const calls = parseRpcBody(init?.body);
    if (calls) {
      void res
        .clone()
        .text()
        .then((t) => meterExchange(meter, calls, res.status, t))
        .catch(() => undefined);
    }
    return res;
  }) as FetchFn;
}
