import {
  createPublicClient,
  createWalletClient,
  type PublicArkivClient,
  type WalletArkivClient,
} from "@arkiv-network/sdk";
import { tiramisu } from "@arkiv-network/sdk/chains";
import { http, webSocket, type Account, type Hex, type Transport } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadConfig, type Env } from "./config.js";

export type Reader = PublicArkivClient<Transport, typeof tiramisu>;
export type Wallet = WalletArkivClient<Transport, typeof tiramisu, Account>;

// The SDK has no notion of access keys; they ride on the viem HTTP transport as a header.
function httpTransport(env: Env): Transport {
  const headers: Record<string, string> = env.ARKIV_ACCESS_KEY
    ? { "X-API-KEY": env.ARKIV_ACCESS_KEY }
    : {};
  return http(env.ARKIV_RPC_HTTP, { fetchOptions: { headers } });
}

/** Read-only client over HTTP. `cacheTime: 0` so block numbers are never stale. */
export function makeReader(env: Env = loadConfig()): Reader {
  return createPublicClient({ chain: tiramisu, cacheTime: 0, transport: httpTransport(env) });
}

/** Read-only client over WebSocket, for `watchEntityEvents` push subscriptions. */
export function makeWsReader(env: Env = loadConfig()): Reader {
  return createPublicClient({ chain: tiramisu, transport: webSocket(env.ARKIV_RPC_WS) });
}

export function makeWallet(privateKey: Hex, env: Env = loadConfig()): Wallet {
  return createWalletClient({
    chain: tiramisu,
    transport: httpTransport(env),
    account: privateKeyToAccount(privateKey),
  });
}
