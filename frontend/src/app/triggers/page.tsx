"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { Hex } from "viem";
import { Badge, Empty, ErrorState, LiveDot, Loading, Mono, PageHeader, Segmented, expiryView } from "@/components/ui";
import {
  loadHead,
  loadPublicTriggers,
  loadReceipts,
  loadSealedTriggers,
  loadWatched,
  loadWorkers,
  workerLabel,
  type PublicTrigger,
  type SealedTrigger,
} from "@/lib/data";
import { CONDITION_GROUP, CONDITION_LABEL, actionLabel, conditionArg, watchInfo } from "@/lib/describe";
import { fmtBlock, relBlocks, short } from "@/lib/format";
import { useHead, usePoll } from "@/lib/poll";

const WEEK_BLOCKS = 302_400n;

async function loadList() {
  const head = await loadHead();
  const [pub, sealed, receipts, workers] = await Promise.all([
    loadPublicTriggers(),
    loadSealedTriggers(),
    loadReceipts({ sinceBlock: head > WEEK_BLOCKS ? head - WEEK_BLOCKS : 0n, max: 600 }),
    loadWorkers(false),
  ]);
  // Live expiry of single-entity watches (query watches cover many entities; see the detail page).
  const keys = [
    ...new Set(
      pub.triggers.flatMap((t) => {
        const c = t.spec.cond;
        return "watch" in c && "entity_key" in c.watch ? [c.watch.entity_key.toLowerCase()] : [];
      }),
    ),
  ].slice(0, 30);
  const watched = new Map(
    await Promise.all(keys.map(async (k) => [k.toLowerCase(), await loadWatched(k as Hex).catch(() => undefined)] as const)),
  );
  return { pub: pub.triggers, invalid: pub.invalid, sealed, receipts, workers, watched };
}

type Mode = "all" | "public" | "sealed";
type Row = PublicTrigger | SealedTrigger;

const CONDS = [
  ["all", "Any condition"],
  ["expiring", "Expiring"],
  ["expired", "Expired"],
  ["renewed", "Renewed"],
  ["deleted", "Deleted"],
  ["quiet", "Quiet"],
  ["new", "New"],
  ["count", "Count"],
] as const;

export default function TriggersPage() {
  const list = usePoll(loadList, 15_000);
  const head = useHead().data;
  const [mode, setMode] = useState<Mode>("all");
  const [cond, setCond] = useState<string>("all");
  const [status, setStatus] = useState<"all" | "active" | "paused">("all");
  const d = list.data;

  const rows = useMemo<Row[]>(() => {
    if (!d) return [];
    const all: Row[] = [...d.pub, ...d.sealed].sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1));
    return all.filter((r) => {
      if (mode !== "all" && r.mode !== mode) return false;
      if (cond !== "all" && (r.mode === "sealed" || CONDITION_GROUP[r.spec.cond.type] !== cond)) return false;
      if (status !== "all" && (r.mode === "sealed" ? status !== "active" : r.status !== status)) return false;
      return true;
    });
  }, [d, mode, cond, status]);

  const lastFired = useMemo(() => {
    const m = new Map<string, bigint>();
    for (const r of d?.receipts ?? []) {
      const k = r.trigger.toLowerCase();
      if (!m.has(k) || r.firedBlock > m.get(k)!) m.set(k, r.firedBlock);
    }
    return m;
  }, [d]);
  const receiptCount = (k: string) => d?.receipts.filter((r) => r.trigger.toLowerCase() === k.toLowerCase()).length ?? 0;

  const nPub = d?.pub.length ?? 0;
  const nSeal = d?.sealed.length ?? 0;

  return (
    <main className="page">
      <PageHeader
        eyebrow={
          <>
            <LiveDot />
            Live from Arkiv
          </>
        }
        title="Triggers"
        aside={
          <Link href="/create" className="btn btn-primary">
            <span className="text-xl leading-none">+</span>Create trigger
          </Link>
        }
      >
        <p className="m-0 text-lg leading-[1.55] text-muted">
          <span className="font-semibold text-fg">{d ? nPub : "…"} public</span> and <span className="font-semibold text-sealed">{d ? nSeal : "…"} sealed</span>{" "}
          triggers being watched by {d ? d.workers.length : "…"} worker{d?.workers.length === 1 ? "" : "s"}.
        </p>
      </PageHeader>

      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          label="Mode"
          value={mode}
          onChange={setMode}
          options={[
            { value: "all", label: "All", count: nPub + nSeal },
            { value: "public", label: "Public", count: nPub },
            { value: "sealed", label: "🔒 Sealed", count: nSeal },
          ]}
        />
        <div className="hidden h-7 w-px bg-line sm:block" />
        <div className="flex flex-wrap gap-1.5">
          {CONDS.map(([k, label]) => (
            <button
              key={k}
              type="button"
              aria-pressed={cond === k}
              onClick={() => setCond(k)}
              className={`h-9 cursor-pointer rounded-lg border px-3 text-[13px] font-semibold whitespace-nowrap ${
                cond === k ? "border-line-strong bg-raised text-fg" : "border-line bg-transparent text-muted hover:text-fg"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <label className="flex items-center gap-2 text-sm font-medium text-muted">
          Status
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as typeof status)}
            className="h-[38px] rounded-lg border border-line-strong bg-sunken px-2.5 text-sm font-medium text-fg"
          >
            <option value="all">All</option>
            <option value="active">Active</option>
            <option value="paused">Paused</option>
          </select>
        </label>
      </div>

      {!!list.error && !d && <ErrorState error={list.error} onRetry={list.refresh} />}

      <div className="card overflow-x-auto">
        <div role="table" aria-label="Triggers" className="min-w-[1100px]">
          <div
            role="row"
            className="label-caps grid h-12 grid-cols-[minmax(0,1.25fr)_minmax(0,1.2fr)_minmax(0,1.35fr)_minmax(0,0.75fr)_minmax(0,0.95fr)_minmax(0,0.9fr)_minmax(0,1fr)] items-center gap-4 border-b border-line px-6"
          >
            {["Condition", "Action", "Watches", "Status", "Creator", "Last fired", "Watched expiry"].map((h) => (
              <span key={h} role="columnheader">
                {h}
              </span>
            ))}
          </div>
          {!d && !list.error && <Loading />}
          {d && rows.length === 0 && (
            <Empty title={d.pub.length + d.sealed.length === 0 ? "No triggers on Arkiv yet." : "No triggers match these filters."}>
              {d.pub.length + d.sealed.length === 0 ? (
                <Link href="/create">Create the first one ›</Link>
              ) : (
                <button
                  type="button"
                  className="btn btn-secondary mt-2"
                  onClick={() => {
                    setMode("all");
                    setCond("all");
                    setStatus("all");
                  }}
                >
                  Clear filters
                </button>
              )}
            </Empty>
          )}
          {rows.map((r) =>
            r.mode === "sealed" ? (
              <SealedRow key={r.key} t={r} worker={workerLabel(d?.workers, r.worker) ?? short(r.worker)} receipts={receiptCount(r.key)} />
            ) : (
              <PublicRow key={r.key} t={r} head={head} last={lastFired.get(r.key.toLowerCase())} watched={d?.watched} />
            ),
          )}
        </div>
      </div>
      <div className="flex flex-wrap justify-between gap-4 text-[13px] text-subtle">
        <span>
          Showing {rows.length} of {nPub + nSeal} · read via Arkiv RPC at {fmtBlock(head)}
          {d && d.invalid > 0 && ` · ${d.invalid} malformed trigger${d.invalid === 1 ? "" : "s"} ignored`}
        </span>
        <span>Sealed triggers reveal nothing but a hash until their owner chooses to.</span>
      </div>
    </main>
  );
}

const rowCls =
  "grid min-h-[68px] grid-cols-[minmax(0,1.25fr)_minmax(0,1.2fr)_minmax(0,1.35fr)_minmax(0,0.75fr)_minmax(0,0.95fr)_minmax(0,0.9fr)_minmax(0,1fr)] items-center gap-4 border-b border-line px-6 py-2.5 box-border text-fg no-underline transition-colors duration-150 hover:bg-raised hover:text-fg";

function PublicRow({ t, head, last, watched }: { t: PublicTrigger; head?: bigint; last?: bigint; watched?: Map<string, Awaited<ReturnType<typeof loadWatched>>> }) {
  const c = t.spec.cond;
  const w = watchInfo(c);
  const act = actionLabel(t.spec.action);
  const tone = act.kind === "reactivate" ? "accent" : act.kind === "alert" ? "warm" : "neutral";
  let exp: React.ReactNode = <span className="text-[13px] text-subtle">query · many</span>;
  if (w.key) {
    const e = watched?.get(w.key.toLowerCase());
    const v = e ? expiryView(e.createdAt, e.expiresAt, head) : undefined;
    exp = !e ? (
      <span className="num text-[13px] text-subtle">Gone</span>
    ) : (
      <span className="flex flex-col gap-1.5">
        <span className={`num text-[13px] font-medium ${v?.warn ? "text-warning" : ""}`}>{v ? (v.warn ? `⚠ ${v.text}` : v.text) : "…"}</span>
        <span className="h-1 overflow-hidden rounded-full bg-line">
          <span className="block h-full rounded-full" style={{ width: `${v?.pct ?? 0}%`, background: v?.warn ? "var(--warning)" : "var(--accent)" }} />
        </span>
      </span>
    );
  } else if (c.type === "on_create" || c.type === "on_silence" || c.type === "on_count") {
    exp = <span className="text-[13px] text-subtle">—</span>;
  }
  return (
    <Link role="row" href={`/triggers/${t.key}`} className={rowCls}>
      <span className="flex min-w-0 flex-col gap-1.5">
        <span className="text-[15px] leading-[1.2] font-semibold">{CONDITION_LABEL[c.type]}</span>
        <span className="font-mono text-xs text-subtle">{conditionArg(c)}</span>
      </span>
      <span>
        <Badge tone={tone} square>
          {act.text}
        </Badge>
      </span>
      <span className="flex min-w-0 flex-col gap-1.5">
        <span className="truncate text-[15px] leading-[1.2] font-medium">{w.key ? "single entity" : w.label}</span>
        <span className="font-mono text-xs text-subtle">{w.key ? short(w.key) : w.createdBy ? `from ${short(w.createdBy)}` : "query"}</span>
      </span>
      <span>
        {t.status === "paused" ? (
          <Badge tone="neutral">Ⅱ Paused</Badge>
        ) : (
          <Badge tone="success">● Active</Badge>
        )}
      </span>
      <Mono value={t.creator} className="text-left text-[13px] text-muted" />
      <span className="flex flex-col gap-1.5">
        <span className="num text-[13px]">{last ? fmtBlock(last) : "—"}</span>
        <span className="text-xs text-subtle">{last ? relBlocks(last, head) : "never"}</span>
      </span>
      {exp}
    </Link>
  );
}

function SealedRow({ t, worker, receipts }: { t: SealedTrigger; worker: string; receipts: number }) {
  return (
    <Link role="row" href={`/triggers/${t.key}`} className={rowCls}>
      <span>
        <Badge tone="sealed" className="font-bold">
          🔒 Sealed
        </Badge>
      </span>
      <span className="col-span-2 flex min-w-0 items-center gap-3">
        <span title={t.commitment} className="shrink-0 rounded-md border border-line bg-sunken px-2 py-1 font-mono text-[13px]">
          {short(t.commitment)}
        </span>
        <span
          aria-hidden="true"
          className="h-3.5 flex-1 rounded border border-sealed-soft"
          style={{ background: "repeating-linear-gradient(135deg, var(--sealed-soft) 0 6px, transparent 6px 12px)" }}
        />
      </span>
      <span className="col-span-2 flex items-center gap-2">
        <span className="text-xs text-subtle">Worker</span>
        <span className="font-mono text-[13px] font-medium">{worker}</span>
      </span>
      <span className="font-mono text-[13px] font-medium text-muted">
        {receipts} receipt{receipts === 1 ? "" : "s"}
      </span>
      <span className="text-[13px] text-subtle">Private</span>
    </Link>
  );
}
