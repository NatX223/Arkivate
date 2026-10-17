"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Badge, Empty, ErrorState, LiveDot, Loading, Mono, PageHeader, Segmented } from "@/components/ui";
import { loadHead, loadPublicTriggers, loadReceipts, loadWorkers, workerLabel } from "@/lib/data";
import { describeSpec } from "@/lib/describe";
import { fmtBlock, relBlocks, short } from "@/lib/format";
import { useHead, usePoll } from "@/lib/poll";
import { byKey, receiptLabel } from "@/lib/receipts";

const WINDOWS = { "1h": 1_800n, "24h": 43_200n, "7d": 302_400n } as const;
type Window = keyof typeof WINDOWS;

export default function ReceiptsPage() {
  const [win, setWin] = useState<Window>("24h");
  const [mode, setMode] = useState<"all" | "public" | "sealed">("all");
  const [worker, setWorker] = useState("all");
  const feed = usePoll(
    async () => {
      const head = await loadHead();
      const span = WINDOWS[win];
      const [receipts, pub, workers] = await Promise.all([
        loadReceipts({ sinceBlock: head > span ? head - span : 0n, max: 600 }),
        loadPublicTriggers(),
        loadWorkers(false),
      ]);
      return { receipts, pub: byKey(pub.triggers), workers };
    },
    20_000,
    win,
  );
  const head = useHead().data;
  const d = feed.data;

  const rows = useMemo(
    () =>
      (d?.receipts ?? []).filter((r) => (mode === "all" || r.mode === mode) && (worker === "all" || r.creator.toLowerCase() === worker)),
    [d, mode, worker],
  );
  const creators = useMemo(() => [...new Set((d?.receipts ?? []).map((r) => r.creator.toLowerCase()))], [d]);

  return (
    <main className="page">
      <PageHeader
        eyebrow={
          <>
            <LiveDot />
            Live from Arkiv
          </>
        }
        title="Receipts"
      >
        <p className="m-0 max-w-[680px] text-lg leading-[1.55] text-muted">
          Every firing writes a readonly, burned receipt that nobody (not even the worker) can delete. Sealed receipts carry only a salted result hash.
        </p>
      </PageHeader>

      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          label="Mode"
          value={mode}
          onChange={setMode}
          options={[
            { value: "all", label: "All" },
            { value: "public", label: "Public" },
            { value: "sealed", label: "🔒 Sealed" },
          ]}
        />
        <Segmented label="Window" value={win} onChange={setWin} options={(Object.keys(WINDOWS) as Window[]).map((w) => ({ value: w, label: w }))} />
        <div className="flex-1" />
        <label className="flex items-center gap-2 text-sm font-medium text-muted">
          Worker
          <select value={worker} onChange={(e) => setWorker(e.target.value)} className="h-[38px] rounded-lg border border-line-strong bg-sunken px-2.5 text-sm font-medium text-fg">
            <option value="all">All workers</option>
            {creators.map((c) => (
              <option key={c} value={c}>
                {workerLabel(d?.workers, c) ?? short(c)}
              </option>
            ))}
          </select>
        </label>
      </div>

      {!!feed.error && !d && <ErrorState error={feed.error} onRetry={feed.refresh} />}

      <div className="card overflow-x-auto">
        <div role="table" aria-label="Receipts" className="min-w-[980px]">
          <div role="row" className="label-caps grid h-12 grid-cols-[minmax(0,1fr)_minmax(0,2.2fr)_minmax(0,1fr)_minmax(0,0.9fr)_minmax(0,0.9fr)_minmax(0,0.9fr)] items-center gap-4 border-b border-line px-6">
            {["Receipt", "Trigger", "Outcome", "Worker", "Fired", "When"].map((h) => (
              <span key={h} role="columnheader">
                {h}
              </span>
            ))}
          </div>
          {!d && !feed.error && <Loading />}
          {d && rows.length === 0 && <Empty title={`No receipts in the last ${win}.`}>Receipts appear here the moment a worker fires.</Empty>}
          {rows.map((r) => {
            const t = d?.pub.get(r.trigger.toLowerCase());
            const label = receiptLabel(r, t);
            return (
              <Link
                role="row"
                key={r.key}
                href={`/triggers/${r.trigger}`}
                className="box-border grid min-h-[60px] animate-in-fast grid-cols-[minmax(0,1fr)_minmax(0,2.2fr)_minmax(0,1fr)_minmax(0,0.9fr)_minmax(0,0.9fr)_minmax(0,0.9fr)] items-center gap-4 border-b border-line px-6 py-2.5 text-fg no-underline transition-colors duration-150 hover:bg-raised hover:text-fg"
              >
                <Mono value={r.key} className="text-left text-sm" />
                <span className="flex min-w-0 flex-col gap-1">
                  {r.mode === "sealed" ? (
                    <span className="flex items-center gap-2 text-sm">
                      <Badge tone="sealed" className="h-6! text-xs!">
                        🔒 Sealed
                      </Badge>
                      <span className="font-mono text-[13px] text-muted">{short(r.trigger)}</span>
                    </span>
                  ) : (
                    <>
                      <span className="truncate text-sm font-medium">{t ? describeSpec(t.spec) : `trigger ${short(r.trigger)}`}</span>
                      {r.summary && <span className="truncate font-mono text-xs text-subtle">{r.summary}</span>}
                    </>
                  )}
                </span>
                <span>
                  <Badge tone={label.tone} square className="h-[26px]! text-xs!">
                    {label.text}
                  </Badge>
                </span>
                <span className="font-mono text-[13px] font-medium">{workerLabel(d?.workers, r.creator) ?? short(r.creator)}</span>
                <span className="num text-[13px]">{fmtBlock(r.firedBlock)}</span>
                <span className="text-[13px] text-subtle">{relBlocks(r.firedBlock, head)}</span>
              </Link>
            );
          })}
        </div>
      </div>
      <div className="flex flex-wrap justify-between gap-4 text-[13px] text-subtle">
        <span>
          {rows.length} receipt{rows.length === 1 ? "" : "s"} · last {win} · read at {fmtBlock(head)}
          {d && d.receipts.length >= 600 && " · showing the first 600"}
        </span>
        <span>Fired blocks are when the worker acted; Arkiv records who wrote each receipt.</span>
      </div>
    </main>
  );
}
