import { createPublicClient, type PublicArkivClient } from "@arkiv-network/sdk";
import { tiramisu } from "@arkiv-network/sdk/chains";
import { http, webSocket, type Transport } from "viem";
import { TIRAMISU_RPC_HTTP, TIRAMISU_RPC_WS } from "./constants.js";
import type { FetchFn } from "./ratelimit.js";

export type Reader = PublicArkivClient<Transport, typeof tiramisu>;

export interface ReaderOptions {
  rpcHttp?: string;
  /** Server-side only. Never pass an access key from browser code. */
  accessKey?: string;
  /** Wraps every HTTP call (rate-limit gate, metering). */
  fetchFn?: FetchFn;
  /**
   * viem's automatic retries (default 3). Readers that poll pass 0: viem retries a 429 too, and
   * every retry spends quota. The next poll is the retry.
   */
  retryCount?: number;
}

// The SDK has no notion of access keys; they ride on the viem HTTP transport as a header.
export function arkivHttp({ rpcHttp = TIRAMISU_RPC_HTTP, accessKey, fetchFn, retryCount }: ReaderOptions = {}): Transport {
  const headers: Record<string, string> = accessKey ? { "X-API-KEY": accessKey } : {};
  return http(rpcHttp, {
    fetchOptions: { headers },
    ...(fetchFn ? { fetchFn } : {}),
    ...(retryCount !== undefined ? { retryCount } : {}),
  });
}

/** Read-only client over HTTP. `cacheTime: 0` so block numbers are never stale. Browser-safe. */
export function createReader(opts: ReaderOptions = {}): Reader {
  return createPublicClient({ chain: tiramisu, cacheTime: 0, transport: arkivHttp(opts) });
}

/** Read-only client over WebSocket, for `watchEntityEvents` push subscriptions. */
export function createWsReader(rpcWs: string = TIRAMISU_RPC_WS): Reader {
  return createPublicClient({ chain: tiramisu, transport: webSocket(rpcWs) });
}
