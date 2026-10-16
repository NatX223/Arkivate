"use client";

import { createWalletClient, type WalletArkivClient } from "@arkiv-network/sdk";
import { tiramisu } from "@arkiv-network/sdk/chains";
import { CHAIN_ID, EXPLORER_URL, TIRAMISU_RPC_HTTP } from "@arkivate/core";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { custom, numberToHex, type Account, type EIP1193Provider, type Hex, type Transport } from "viem";
import { errMessage } from "./format";

declare global {
  interface Window {
    ethereum?: EIP1193Provider & {
      on?: (event: string, fn: (...args: never[]) => void) => void;
      removeListener?: (event: string, fn: (...args: never[]) => void) => void;
    };
  }
}

export type Wallet = WalletArkivClient<Transport, typeof tiramisu, Account>;

const CHAIN_HEX = numberToHex(CHAIN_ID);

/** Methods the visitor's wallet must answer itself: accounts, chain, and anything that signs. */
const WALLET_METHODS = new Set([
  "eth_requestAccounts",
  "eth_accounts",
  "eth_chainId",
  "eth_sendTransaction",
  "personal_sign",
  "eth_sign",
  "eth_signTypedData_v4",
]);

let rpcId = 0;

/**
 * Signing goes to the browser wallet; every read (gas, receipts, arkiv_query) goes through our
 * keyed read proxy, so the SDK's receipt polling doesn't hit the wallet's keyless RPC.
 */
function routedTransport(provider: EIP1193Provider, onSent?: (hash: Hex) => void): Transport {
  return custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      if (WALLET_METHODS.has(method) || method.startsWith("wallet_")) {
        const out = await provider.request({ method, params } as Parameters<EIP1193Provider["request"]>[0]);
        // The wallet returns the hash once the visitor has signed: signing is done, inclusion isn't.
        if (method === "eth_sendTransaction") onSent?.(out as Hex);
        return out;
      }
      const res = await fetch("/api/rpc", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params: params ?? [] }),
      });
      if (res.status === 429) throw new Error("429: Arkiv read quota exhausted, try again shortly");
      const body = (await res.json()) as { result?: unknown; error?: { code: number; message: string } };
      if (body.error) throw Object.assign(new Error(body.error.message), { code: body.error.code });
      return body.result;
    },
  });
}

export type WalletErrorKind = "rejected" | "funds" | "network" | "other";

export function walletErrorKind(e: unknown): WalletErrorKind {
  const err = e as { code?: number; name?: string; cause?: { code?: number } };
  const msg = errMessage(e);
  if (err?.code === 4001 || err?.cause?.code === 4001 || err?.name === "UserRejectedRequestError" || /user (rejected|denied)|rejected the request/i.test(msg)) {
    return "rejected";
  }
  if (/insufficient funds|exceeds balance|gas required exceeds/i.test(msg)) return "funds";
  if (/chain|network/i.test(msg) && /mismatch|does not match|switch/i.test(msg)) return "network";
  return "other";
}

interface WalletState {
  /** A browser wallet (EIP-1193) is installed. */
  available: boolean;
  address?: Hex;
  chainId?: number;
  onTiramisu: boolean;
  connect(): Promise<Hex>;
  switchToTiramisu(): Promise<void>;
  /** Connect if needed and make sure the wallet is on Tiramisu. Resolves to the signing address. */
  ensureReady(onStage?: (s: "connect" | "network") => void): Promise<Hex>;
}

/** An Arkiv wallet client that signs with the browser wallet as `address`. */
export function walletClientFor(address: Hex, onSent?: (hash: Hex) => void): Wallet {
  const p = window.ethereum;
  if (!p) throw new Error("No browser wallet found");
  return createWalletClient({
    chain: tiramisu,
    account: address,
    transport: routedTransport(p, onSent),
    pollingInterval: 1_500,
  }) as unknown as Wallet;
}

const Ctx = createContext<WalletState | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const [available, setAvailable] = useState(false);
  const [address, setAddress] = useState<Hex>();
  const [chainId, setChainId] = useState<number>();

  useEffect(() => {
    const p = window.ethereum;
    if (!p) return;
    setAvailable(true);
    // Silent: only picks up an existing connection, never prompts.
    void p.request({ method: "eth_accounts" }).then((a) => setAddress((a as Hex[])[0])).catch(() => {});
    void p.request({ method: "eth_chainId" }).then((c) => setChainId(Number(c))).catch(() => {});
    const onAccounts = (a: Hex[]) => setAddress(a[0]);
    const onChain = (c: string) => setChainId(Number(c));
    p.on?.("accountsChanged", onAccounts as never);
    p.on?.("chainChanged", onChain as never);
    return () => {
      p.removeListener?.("accountsChanged", onAccounts as never);
      p.removeListener?.("chainChanged", onChain as never);
    };
  }, []);

  const connect = useCallback(async () => {
    const p = window.ethereum;
    if (!p) throw new Error("No browser wallet found. Install MetaMask (or any EIP-1193 wallet) to sign.");
    const accounts = (await p.request({ method: "eth_requestAccounts" })) as Hex[];
    const c = Number(await p.request({ method: "eth_chainId" }));
    setChainId(c);
    if (!accounts[0]) throw new Error("The wallet returned no account");
    setAddress(accounts[0]);
    return accounts[0];
  }, []);

  const switchToTiramisu = useCallback(async () => {
    const p = window.ethereum;
    if (!p) throw new Error("No browser wallet found");
    try {
      await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_HEX }] });
    } catch (e) {
      const code = (e as { code?: number; data?: { originalError?: { code?: number } } }).code;
      const nested = (e as { data?: { originalError?: { code?: number } } }).data?.originalError?.code;
      if (code !== 4902 && nested !== 4902) throw e;
      await p.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: CHAIN_HEX,
            chainName: "Arkiv Tiramisu testnet",
            nativeCurrency: tiramisu.nativeCurrency,
            rpcUrls: [TIRAMISU_RPC_HTTP],
            blockExplorerUrls: [EXPLORER_URL],
          },
        ],
      });
    }
    setChainId(Number(await p.request({ method: "eth_chainId" })));
  }, []);

  const ensureReady = useCallback(
    async (onStage?: (s: "connect" | "network") => void): Promise<Hex> => {
      const p = window.ethereum;
      if (!p) throw new Error("No browser wallet found. Install MetaMask (or any EIP-1193 wallet) to sign.");
      // Ask the wallet directly: React state may lag a just-made connection or chain switch.
      let addr = ((await p.request({ method: "eth_accounts" })) as Hex[])[0];
      if (!addr) {
        onStage?.("connect");
        addr = await connect();
      }
      if (Number(await p.request({ method: "eth_chainId" })) !== CHAIN_ID) {
        onStage?.("network");
        await switchToTiramisu();
      }
      return addr;
    },
    [connect, switchToTiramisu],
  );

  const value = useMemo<WalletState>(
    () => ({ available, address, chainId, onTiramisu: chainId === CHAIN_ID, connect, switchToTiramisu, ensureReady }),
    [available, address, chainId, connect, switchToTiramisu, ensureReady],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWallet(): WalletState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useWallet outside WalletProvider");
  return v;
}
