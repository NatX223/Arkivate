import { TIRAMISU_RPC_HTTP } from "@arkivate/core";

/**
 * Read-only JSON-RPC proxy to Tiramisu. The keyless RPC allows ~100 queries/hour/IP, so browser
 * reads come through here and pick up the server-side access key, which never reaches the client.
 * Writes are not proxied: the visitor's wallet signs and sends them itself.
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

const MAX_BODY = 64 * 1024;
const MAX_BATCH = 20;

interface RpcCall {
  jsonrpc?: string;
  id?: unknown;
  method?: unknown;
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
  return new Response(await upstream.text(), { status: upstream.status, headers });
}
