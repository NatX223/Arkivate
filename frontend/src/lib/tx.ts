"use client";

import { useCallback, useRef, useState } from "react";
import type { Hex } from "viem";
import { errMessage } from "./format";
import { useWallet, walletClientFor, walletErrorKind, type Wallet, type WalletErrorKind } from "./wallet";

export type TxStage = "idle" | "connect" | "network" | "sign" | "submit" | "done" | "error";

export interface TxError {
  kind: WalletErrorKind;
  message: string;
  /** The stage that was running when it failed. */
  at: TxStage;
}

/** First line of a viem / SDK error, preferring viem's short message. */
export function shortError(e: unknown): string {
  const s = (e as { shortMessage?: string })?.shortMessage;
  return (s ?? errMessage(e)).split("\n")[0]!.slice(0, 240);
}

/**
 * One wallet transaction with visible stages: connect → network → sign (wallet prompt) →
 * submit (waiting for inclusion) → done. `fn` gets an Arkiv wallet client for the signer.
 */
export function useTx() {
  const w = useWallet();
  const [stage, setStageState] = useState<TxStage>("idle");
  const [hash, setHash] = useState<Hex>();
  const [error, setError] = useState<TxError>();
  const current = useRef<TxStage>("idle");
  const setStage = (s: TxStage) => {
    current.current = s;
    setStageState(s);
  };

  const run = useCallback(
    async <T>(fn: (wallet: Wallet, address: Hex) => Promise<T>): Promise<T | undefined> => {
      setError(undefined);
      setHash(undefined);
      try {
        const addr = await w.ensureReady(setStage);
        setStage("sign");
        const wallet = walletClientFor(addr, (h) => {
          setHash(h);
          setStage("submit");
        });
        const out = await fn(wallet, addr);
        setStage("done");
        return out;
      } catch (e) {
        setError({ kind: walletErrorKind(e), message: shortError(e), at: current.current });
        setStage("error");
        return undefined;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [w.ensureReady],
  );

  const reset = useCallback(() => {
    setStage("idle");
    setHash(undefined);
    setError(undefined);
  }, []);

  return { stage, hash, error, run, reset, busy: stage !== "idle" && stage !== "done" && stage !== "error" };
}
