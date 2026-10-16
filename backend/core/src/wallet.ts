import { createWalletClient, type WalletArkivClient } from "@arkiv-network/sdk";
import { tiramisu } from "@arkiv-network/sdk/chains";
import type { Account, Hex, Transport } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadConfig, type Env } from "./config.js";
import { arkivHttp, createReader, createWsReader, type Reader } from "./reader.js";

export type Wallet = WalletArkivClient<Transport, typeof tiramisu, Account>;

/** Reader configured from env, including the server-side access key. */
export function makeReader(env: Env = loadConfig()): Reader {
  return createReader({ rpcHttp: env.ARKIV_RPC_HTTP, accessKey: env.ARKIV_ACCESS_KEY });
}

export function makeWsReader(env: Env = loadConfig()): Reader {
  return createWsReader(env.ARKIV_RPC_WS);
}

export function makeWallet(privateKey: Hex, env: Env = loadConfig()): Wallet {
  return createWalletClient({
    chain: tiramisu,
    transport: arkivHttp({ rpcHttp: env.ARKIV_RPC_HTTP, accessKey: env.ARKIV_ACCESS_KEY }),
    account: privateKeyToAccount(privateKey),
  });
}
