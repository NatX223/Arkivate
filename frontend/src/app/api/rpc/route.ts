import { RpcMeter, TIRAMISU_RPC_HTTP, meterExchange, readCostHeaders, rpcShape, type CostHeaders } from "@arkivate/core";

/**
 * Read-only JSON-RPC proxy to Tiramisu. The keyless RPC is rate-limited per IP, so browser reads
 * come through here and pick up the server-side access key, which never reaches the client.
 * Writes are not proxied: the visitor's wallet signs and sends them itself.
 *
 * Quota (arkiv/friction.md F20): identical reads within CACHE_MS share one upstream call, and on
 * a 429 the last answer for that exact request is served instead of an error. List pages don't
 * come here at all; they read the shared `/api/snapshot`.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED = new Set([
  "eth_chainId",
  "net_version",
  "eth_blockNumber",
  "eth_getBalance",
  "eth_getTransactionCount",
  "eth_getTransactionReceipt",
  "eth_getTransactionByHash",
  "eth_getBlockByNumber",
  "eth_getBlockByHash",
  "eth_call",
  "eth_estimateGas",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_feeHistory",
  "arkiv_query",
  "arkiv_getEntityCount",
  "arkiv_getBlockTiming",
]);

/** Deterministic reads safe to share for a few seconds. Never nonces, receipts or gas: tx flows need them fresh. */
const CACHEABLE = new Set(["eth_chainId", "net_version", "eth_blockNumber", "eth_getBalance", "arkiv_query", "arkiv_getEntityCount", "arkiv_getBlockTiming"]);
const CACHE_MS = 10_000;
const CACHE_MAX = 500;

interface Cached {
  at: number;
  /** Results in call order (ids stripped), so a hit can answer with the caller's ids. */
  results: unknown[];
  contentType: string;
}
const cache = new Map<string, Cached>();

const cacheKey = (calls: RpcCall[]) => JSON.stringify(calls.map((c) => [c.method, (c as { params?: unknown }).params ?? []]));

function remember(k: string, calls: RpcCall[], text: string, contentType: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return;
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  if (list.length !== calls.length || list.some((r) => !r || typeof r !== "object" || "error" in r)) return;
  // Batch answers may come back in any order: line them up with the calls by id.
  const byId = new Map(list.map((r) => [JSON.stringify((r as { id?: unknown }).id), r as { result?: unknown }]));
  const results = calls.map((c) => byId.get(JSON.stringify(c.id))?.result);
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(k, { at: Date.now(), results, contentType });
}

function replay(hit: Cached, calls: RpcCall[], single: boolean, stale: boolean) {
  const out = calls.map((c, i) => ({ jsonrpc: "2.0", id: c.id ?? null, result: hit.results[i] }));
  return new Response(JSON.stringify(single ? out[0] : out), {
    headers: { "content-type": hit.contentType, "x-rpc-cache": stale ? "stale" : "hit" },
  });
}

const MAX_BODY = 64 * 1024;
const MAX_BATCH = 20;

interface RpcCall {
  jsonrpc?: string;
  id?: unknown;
  method?: unknown;
}

// Per server instance: calls and response bytes by method and query shape (arkiv/friction.md F20).
const meter = new RpcMeter();
const METER_LOG_MS = 60_000;
let meterLoggedAt = Date.now();

function logUsage(calls: RpcCall[], status: number, text: string, cost: CostHeaders) {
  meterExchange(meter, calls, status, text, cost);
  console.log(JSON.stringify({ rpc: calls.map(rpcShape), status, bytes: text.length, units: cost.cost ?? 0, quota: cost.quotaUsedPercent }));
  if (Date.now() - meterLoggedAt >= METER_LOG_MS) {
    meterLoggedAt = Date.now();
    console.log(JSON.stringify({ rpcUsage: meter.snapshot() }));
  }
}

const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

export async function POST(req: Request) {
  const text = await req.text();
  if (text.length > MAX_BODY) return Response.json(rpcError(null, -32600, "request too large"), { status: 413 });

  let body: RpcCall | RpcCall[];
  try {
    body = JSON.parse(text) as RpcCall | RpcCall[];
  } catch {
    return Response.json(rpcError(null, -32700, "parse error"), { status: 400 });
  }
  const calls = Array.isArray(body) ? body : [body];
  if (calls.length === 0 || calls.length > MAX_BATCH) return Response.json(rpcError(null, -32600, "bad batch size"), { status: 400 });
  const blocked = calls.find((c) => typeof c.method !== "string" || !ALLOWED.has(c.method));
  if (blocked) {
    return Response.json(rpcError(blocked.id, -32601, `method not allowed through the read proxy: ${String(blocked.method)}`), {
      status: 403,
    });
  }

  const cacheable = calls.every((c) => CACHEABLE.has(c.method as string));
  const ck = cacheable ? cacheKey(calls) : undefined;
  const hit = ck ? cache.get(ck) : undefined;
  if (hit && Date.now() - hit.at < CACHE_MS) return replay(hit, calls, !Array.isArray(body), false);

  const key = process.env.ARKIV_ACCESS_KEY;
  const upstream = await fetch(process.env.ARKIV_RPC_HTTP || TIRAMISU_RPC_HTTP, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { "X-API-KEY": key } : {}) },
    body: text,
    cache: "no-store",
  }).catch(() => undefined);
  if (!upstream) return Response.json(rpcError(null, -32603, "Arkiv RPC unreachable"), { status: 502 });

  const headers = new Headers({ "content-type": upstream.headers.get("content-type") ?? "application/json" });
  const retryAfter = upstream.headers.get("retry-after");
  if (retryAfter) headers.set("retry-after", retryAfter);
  const out = await upstream.text();
  logUsage(calls, upstream.status, out, readCostHeaders(upstream.headers));
  if (upstream.status === 429) {
    // Quota spent: an older answer beats an error. Otherwise tell the client how long to wait.
    if (hit) return replay(hit, calls, !Array.isArray(body), true);
    if (!retryAfter) headers.set("retry-after", "60");
  } else if (upstream.ok && ck) {
    remember(ck, calls, out, headers.get("content-type") ?? "application/json");
  }
  return new Response(out, { status: upstream.status, headers });
}
