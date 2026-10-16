"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { loadHead } from "./data";

export interface Poll<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  refresh(): void;
}

/**
 * Run `fn` now and every `intervalMs` while the tab is visible. Keeps the last good data on a
 * failed refresh, so a transient RPC error doesn't blank the page. `key` restarts the poll.
 */
export function usePoll<T>(fn: () => Promise<T>, intervalMs: number, key: unknown = null): Poll<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<unknown>();
  const [loading, setLoading] = useState(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const seq = useRef(0);

  const run = useCallback(async () => {
    const my = ++seq.current;
    try {
      const d = await fnRef.current();
      if (my !== seq.current) return;
      setData(d);
      setError(undefined);
    } catch (e) {
      if (my !== seq.current) return;
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
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void run();
    }, intervalMs);
    const onVisible = () => document.visibilityState === "visible" && void run();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
      // Invalidate in-flight runs so a stale response can't land after a key change.
      seqRef.current++;
    };
  }, [key, intervalMs, run]);

  return { data, error, loading, refresh: () => void run() };
}

const HeadCtx = createContext<Poll<bigint> | null>(null);

/** The chain head, shared by every countdown on the page. */
export function HeadProvider({ children }: { children: ReactNode }) {
  const head = usePoll(loadHead, 4_000);
  return <HeadCtx.Provider value={head}>{children}</HeadCtx.Provider>;
}

export function useHead(): Poll<bigint> {
  const v = useContext(HeadCtx);
  if (!v) throw new Error("useHead outside HeadProvider");
  return v;
}
