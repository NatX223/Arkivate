"use client";

import Link from "next/link";
import { useMemo } from "react";
import { Badge, Empty, ErrorState, HashChip, LiveDot, Loading, PageHeader, explorerAddress } from "@/components/ui";
import { loadAcceptances, loadHead, loadReceipts, loadWorkers, type Worker } from "@/lib/data";
import { blocksToSeconds, fmtBlock, fmtDuration } from "@/lib/format";
import { useHead, usePoll } from "@/lib/poll";

const DAY_BLOCKS = 43_200n;

async function loadBoard() {
  const head = await loadHead();
  const [workers, receipts, acceptances] = await Promise.all([
    loadWorkers(true),
    loadReceipts({ sinceBlock: head > DAY_BLOCKS ? head - DAY_BLOCKS : 0n, max: 600 }),
    loadAcceptances(),
  ]);
  return { workers, receipts, acceptances };
}

export default function WorkersPage() {
  // Health comes from the workers themselves (not an Arkiv read), so it can refresh with the snapshot.
  const board = usePoll(loadBoard, 20_000);
  const head = useHead().data;
  const d = board.data;
  const stats = useMemo(() => {
    const m = new Map<string, { receipts: number; accepted: number }>();
    const get = (a: string) => m.get(a.toLowerCase()) ?? (m.set(a.toLowerCase(), { receipts: 0, accepted: 0 }), m.get(a.toLowerCase())!);
    for (const r of d?.receipts ?? []) get(r.creator).receipts++;
    for (const a of d?.acceptances ?? []) get(a.creator).accepted++;
    return m;
  }, [d]);
  const online = d?.workers.filter((w) => w.health.state === "online").length ?? 0;

  return (
    <main className="page">
      <PageHeader
        eyebrow={
          <>
            <LiveDot />
            Registered on Arkiv
          </>
        }
        title="Workers"
        aside={
          <Link href="/docs" className="btn btn-secondary">
            Run a worker ›
          </Link>
        }
      >
        <p className="m-0 max-w-[680px] text-lg leading-[1.55] text-muted">
          {d ? (
            <>
              <span className="font-semibold text-success">{online} online</span> of {d.workers.length} registered.{" "}
            </>
          ) : null}
          Each worker keeps a short-lived registration alive on Arkiv. Stop heartbeating and it disappears on its own.
        </p>
      </PageHeader>

      {!!board.error && !d && <ErrorState error={board.error} onRetry={board.refresh} />}
      {!d && !board.error && <Loading />}
      {d && d.workers.length === 0 && (
        <div className="card">
          <Empty title="No worker is registered right now.">
            Start one with <code className="font-mono text-fg">pnpm worker</code>. <Link href="/docs">How to run a worker ›</Link>
          </Empty>
        </div>
      )}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,460px),1fr))] gap-6">
        {d?.workers.map((w) => <WorkerCard key={w.creator} w={w} head={head} stats={stats.get(w.creator.toLowerCase())} />)}
      </div>
      <span className="text-[13px] text-subtle">
        Health is read from each worker&apos;s public <code className="font-mono">/health</code> endpoint by your browser. Receipts count the last 24 h.
      </span>
    </main>
  );
}

function WorkerCard({ w, head, stats }: { w: Worker; head?: bigint; stats?: { receipts: number; accepted: number } }) {
  const h = w.health;
  const online = h.state === "online";
  const left = head !== undefined && w.expiresAt > head ? w.expiresAt - head : 0n;
  return (
    <article
      aria-label={`${w.name || "worker"} ${online ? "online" : "offline"}`}
      className={`relative flex flex-col gap-6 overflow-hidden rounded-2xl border bg-surface p-8 transition-colors duration-[400ms] ${online ? "border-line" : "border-danger"}`}
    >
      {!online && <div aria-hidden="true" className="absolute inset-0 bg-danger-soft" />}
      <div className="relative flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-2">
          <span className="font-serif text-[clamp(28px,3vw,36px)] leading-none">{w.name || "unnamed worker"}</span>
          <HashChip value={w.creator} label="worker address" href={explorerAddress(w.creator)} />
        </div>
        {online ? (
          <Badge tone="success" className="h-8! px-3.5! text-sm!">
            <span className="inline-block h-2 w-2 animate-pulse-live rounded-full bg-success" />
            Online
          </Badge>
        ) : h.state === "offline" ? (
          <Badge tone="danger" className="h-8! px-3.5! text-sm!">
            <span className="box-border inline-block h-2 w-2 rounded-full border-[1.5px] border-current" />
            Offline
          </Badge>
        ) : (
          <Badge tone="neutral" className="h-8! px-3.5! text-sm!">
            No endpoint
          </Badge>
        )}
      </div>
      <div className="relative grid grid-cols-[repeat(auto-fit,minmax(120px,1fr))] gap-px overflow-hidden rounded-xl border border-line bg-line">
        <Cell label="Receipts · 24h" value={stats?.receipts ?? 0} />
        <Cell label="Sealed jobs accepted" value={stats?.accepted ?? 0} />
        <Cell label="Triggers watched" value={online ? h.health.triggers ?? "—" : "—"} />
        <Cell label="Registration" value={left > 0n ? fmtDuration(blocksToSeconds(left)) : "lapsing"} sub={fmtBlock(w.expiresAt)} />
      </div>
      <div className="relative flex flex-wrap items-center justify-between gap-3 text-[13px] text-muted">
        <span className="flex min-w-0 items-center gap-2">
          Endpoint{" "}
          {w.endpoint ? (
            <a href={`${w.endpoint.replace(/\/$/, "")}/health`} target="_blank" rel="noreferrer" className="truncate font-mono">
              {w.endpoint}
            </a>
          ) : (
            <span className="font-mono">none registered</span>
          )}
        </span>
        <span className="font-mono">
          {online ? `${h.health.mode ?? "live"} · telegram ${h.health.telegram ?? "?"}` : h.state === "offline" ? `health: ${h.reason}` : ""}
        </span>
      </div>
    </article>
  );
}

function Cell({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div className="flex flex-col gap-2 bg-sunken px-4 py-4">
      <span className="text-xs text-subtle">{label}</span>
      <span className="num font-serif! text-[30px] leading-none">{value}</span>
      {sub && <span className="font-mono text-xs text-subtle">{sub}</span>}
    </div>
  );
}
