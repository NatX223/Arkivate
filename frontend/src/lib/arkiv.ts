import { createReader, type Reader } from "@arkivate/core";

let reader: Reader | undefined;

/**
 * Browser reader. Reads go through `/api/rpc`, which adds the server-side access key; the key
 * itself never reaches the browser. Only call from client code. `retryCount: 0`: viem would retry
 * a 429 three times within a second; `usePoll` backs off instead.
 */
export function getReader(): Reader {
  if (!reader) reader = createReader({ rpcHttp: `${window.location.origin}/api/rpc`, retryCount: 0 });
  return reader;
}
