"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { backoffMs, isRateLimited } from "@arkivate/core";
import { loadHead } from "./data";

export interface Poll<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  /** Stable across renders, so it is safe in effect dependencies. */
  refresh(): void;
}

/**
 * Run `fn` now and every `intervalMs` while the tab is visible. Keeps the last good data on a
 * failed refresh, so a transient RPC error doesn't blank the page. `key` restarts the poll.
 * A rate-limit error backs the poll off 30 s → 60 s → … 10 min; it never retries in a loop.
 */
export function usePoll<T>(fn: () => Promise<T>, intervalMs: number, key: unknown = null): Poll<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<unknown>();
  const [loading, setLoading] = useState(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const seq = useRef(0);
  const failures = useRef(0);
  const retryAt = useRef(0);

  const run = useCallback(async () => {
    const my = ++seq.current;
    try {
      const d = await fnRef.current();
      if (my !== seq.current) return;
      failures.current = 0;
      retryAt.current = 0;
      setData(d);
      setError(undefined);
    } catch (e) {
      if (my !== seq.current) return;
      if (isRateLimited(e)) retryAt.current = Date.now() + backoffMs(++failures.current);
      setError(e);
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const seqRef = seq;
    setData(undefined);
    setLoading(true);
    void run();
    const due = () => document.visibilityState === "visible" && Date.now() >= retryAt.current;
    const t = setInterval(() => due() && void run(), intervalMs);
    const onVisible = () => due() && void run();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
      // Invalidate in-flight runs so a stale response can't land after a key change.
      seqRef.current++;
    };
  }, [key, intervalMs, run]);

  const refresh = useCallback(() => void run(), [run]);
  return { data, error, loading, refresh };
}

const HeadCtx = createContext<Poll<bigint> | null>(null);

/**
 * The chain head, shared by every countdown on the page. Extrapolated from the shared snapshot
 * (~1 block per 2 s), so ticking it costs no reads; the snapshot itself refreshes every 20 s.
 */
export function HeadProvider({ children }: { children: ReactNode }) {
  const head = usePoll(loadHead, 4_000);
  return <HeadCtx.Provider value={head}>{children}</HeadCtx.Provider>;
}

export function useHead(): Poll<bigint> {
  const v = useContext(HeadCtx);
  if (!v) throw new Error("useHead outside HeadProvider");
  return v;
}
