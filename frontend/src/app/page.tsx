"use client";

import Link from "next/link";
import { useRef } from "react";
import type { Hex } from "viem";
import { CodeIcon, LockIcon, ShieldAlertIcon, ShieldIcon } from "@/components/icons";
import { ErrorState, LiveDot, expiryView, ExpiryBar, Mono } from "@/components/ui";
import {
  loadDemoFeed,
  loadHead,
  loadPublicTriggers,
  loadReceipts,
  loadSealedTriggers,
  loadWorkers,
  workerLabel,
  type FeedEntity,
  type Receipt,
} from "@/lib/data";
import { fmtBlock, relBlocks, short } from "@/lib/format";
import { useHead, usePoll } from "@/lib/poll";
import { byKey, receiptLabel } from "@/lib/receipts";
import { GITHUB_URL } from "@/components/Footer";

const DAY_BLOCKS = 43_200n; // 24 h at ~2 s blocks
const SHOWN_KINDS = ["listing", "canary", "heartbeat", "event"];

async function loadOverview() {
  const head = await loadHead();
  const [feed, receipts, pub, sealed] = await Promise.all([
    loadDemoFeed(),
    loadReceipts({ sinceBlock: head > DAY_BLOCKS ? head - DAY_BLOCKS : 0n, max: 400 }),
    loadPublicTriggers(),
    loadSealedTriggers(),
  ]);
  return { head, feed, receipts, pub: pub.triggers, sealed };
}

export default function Home() {
  const overview = usePoll(loadOverview, 20_000);
  const workers = usePoll(() => loadWorkers(true), 30_000);
  const head = useHead().data ?? overview.data?.head;
  const d = overview.data;
  const online = workers.data?.filter((w) => w.health.state === "online").length;
  const activeTriggers = d ? d.pub.filter((t) => t.status === "active").length + d.sealed.length : undefined;

  return (
    <div className="relative">
      {/* decoration, behind content */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
        <div
          className="arc"
          style={{ right: -260, top: 60, width: 760, height: 760, background: "radial-gradient(circle at 35% 60%, var(--orb), transparent 62%)" }}
        />
        <div className="arc opacity-40" style={{ right: -60, top: 260, width: 420, height: 420 }} />
        <div
          className="absolute rounded-full"
          style={{ left: "5%", top: 200, width: 520, height: 520, background: "radial-gradient(circle, rgba(110,86,207,0.2), transparent 70%)", filter: "blur(40px)" }}
        />
        <div className="hairline" style={{ top: 560, transform: "rotate(-11deg)" }} />
        <div className="hairline" style={{ top: 300, transform: "rotate(-38deg)" }} />
      </div>

      <section className="relative mx-auto box-border flex max-w-[1200px] flex-wrap items-center gap-[clamp(40px,5vw,64px)] px-[clamp(16px,3vw,24px)] pt-[clamp(48px,8vw,104px)] pb-[clamp(48px,6vw,80px)]">
        <div className="flex min-w-0 flex-[1_1_480px] flex-col gap-6">
          <div className="eyebrow">✦ Zapier for expiring data</div>
          <h1 className="display-xl m-0">
            Arkiv data expires. <em className="text-accent-text italic">Arkivate reacts.</em>
          </h1>
          <p className="body-lg m-0 max-w-[540px]">
            Warn, alert or reactivate your data before it dies, run by independent workers nobody can switch off, with a public
            receipt for every reaction.
          </p>
          <div className="mt-2 flex flex-wrap gap-3">
            <Link href="/create" className="btn btn-pill">
              Create a trigger <span className="text-xl leading-none">›</span>
            </Link>
            <Link href="/verify" className="btn btn-secondary h-[52px]">
              <ShieldIcon size={18} />
              Verify a sealed trigger
            </Link>
          </div>
        </div>
        <LiveExpiry feed={d?.feed} receipts={d?.receipts} head={head} error={overview.error} />
      </section>

      <section aria-label="Live stats" className="relative mx-auto box-border max-w-[1200px] px-[clamp(16px,3vw,24px)]">
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,200px),1fr))] gap-px overflow-hidden rounded-2xl border border-line bg-line">
          <Stat href="/workers" label="Workers online" value={online} dot />
          <Stat href="/triggers" label="Active triggers" value={activeTriggers} />
          <Stat href="/receipts" label="Receipts · last 24h" value={d ? (d.receipts.length >= 400 ? "400+" : d.receipts.length) : undefined} />
          <Stat label="Latest block · Tiramisu" value={head === undefined ? undefined : Number(head).toLocaleString("en-US")} />
        </div>
      </section>

      <ReceiptTicker receipts={d?.receipts} pubByKey={byKey(d?.pub)} workers={workers.data} head={head} />

      <section className="relative mx-auto box-border flex max-w-[1200px] flex-col gap-10 px-[clamp(16px,3vw,24px)] pb-[clamp(64px,9vw,112px)]">
        <div className="flex max-w-[720px] flex-col gap-3">
          <div className="eyebrow text-warm!">How it works</div>
          <h2 className="display-lg m-0">Watch. Fire. Prove.</h2>
        </div>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,300px),1fr))] gap-px overflow-hidden rounded-2xl border border-line bg-line">
          {[
            ["01", "Watch", "Workers follow the entities and queries you choose and track exactly when each one will expire."],
            ["02", "Fire", "When the condition hits, they warn, alert or reactivate, renewing the data before it's gone."],
            ["03", "Prove", "Every firing writes a public receipt. A skipped sealed job becomes verifiable evidence."],
          ].map(([n, t, body]) => (
            <div key={n} className="flex flex-col gap-4 bg-surface p-[clamp(28px,4vw,40px)]">
              <span className="font-mono text-[15px] text-accent-text">{n}</span>
              <span className="font-serif text-[clamp(26px,3vw,34px)] leading-[1.1]">{t}</span>
              <p className="m-0 text-[17px] leading-[1.55] text-muted">{body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="relative mx-auto box-border flex max-w-[1200px] flex-col gap-10 px-[clamp(16px,3vw,24px)] pb-[clamp(64px,9vw,112px)]">
        <div className="flex max-w-[720px] flex-col gap-3">
          <div className="eyebrow">Three promises</div>
          <h2 className="display-lg m-0">Infrastructure you can check.</h2>
        </div>
        <div className="flex flex-wrap gap-6">
          <PromiseCard tone="accent" icon={<CodeIcon size={26} />} title="Open source">
            Anyone can read the worker code, run one, and check what it does.
          </PromiseCard>
          <PromiseCard tone="warm" icon={<ShieldAlertIcon size={26} />} title="Censorship-resistant">
            If a worker skips a job it accepted, the owner can prove it in public.
          </PromiseCard>
          <PromiseCard tone="sealed" icon={<LockIcon size={26} weight={1.6} />} title="Private by default">
            Sealed triggers publish only a hash. Alert destinations never go on-chain.
          </PromiseCard>
        </div>
      </section>

      <section className="relative mx-auto box-border max-w-[1200px] px-[clamp(16px,3vw,24px)] pb-[clamp(64px,8vw,96px)]">
        <div className="relative flex flex-col items-center gap-4 overflow-hidden rounded-3xl px-[clamp(20px,4vw,32px)] py-[clamp(56px,8vw,96px)] text-center" style={{ background: "var(--gradient-hero)" }}>
          <div aria-hidden="true" className="absolute h-px w-[130%] bg-white/20" style={{ left: "-10%", top: "22%", transform: "rotate(-10deg)" }} />
          <div aria-hidden="true" className="absolute h-px w-[130%] bg-white/20" style={{ left: "-10%", top: "74%", transform: "rotate(15deg)" }} />
          <div aria-hidden="true" className="absolute rounded-full border border-white/30" style={{ left: -180, bottom: -280, width: 520, height: 520 }} />
          <div className="relative text-[15px] font-medium text-[#F2C879]">✦ No accounts. No logins.</div>
          <h2 className="display-lg relative m-0 max-w-[760px] text-white">Keep Arkiv data alive. Or prove who let it die.</h2>
          <div className="relative mt-3 flex flex-wrap justify-center gap-3">
            <Link href="/docs" className="btn h-[52px] rounded-full bg-white px-[26px] text-[#1C1C1A] hover:opacity-90">
              Run a worker <span className="text-xl leading-none">›</span>
            </Link>
            <Link href="/verify" className="btn h-[52px] rounded-full border border-white/60 bg-transparent px-6 text-white hover:bg-white/10">
              Verify a sealed trigger
            </Link>
          </div>
        </div>
      </section>
      <span className="sr-only">
        Source at <a href={GITHUB_URL}>GitHub</a>
      </span>
    </div>
  );
}

function Stat({ label, value, href, dot }: { label: string; value: number | string | undefined; href?: string; dot?: boolean }) {
  const body = (
    <>
      <span className="flex items-center gap-2 text-sm font-medium text-muted">
        {dot && <span className="h-[7px] w-[7px] rounded-full bg-success" />}
        {label}
      </span>
      <span className="num font-serif! text-[clamp(40px,4.5vw,56px)] leading-none tracking-[-0.02em]">{value ?? "…"}</span>
    </>
  );
  const cls = "flex flex-col gap-2.5 bg-bg px-7 py-6 text-fg no-underline";
  return href ? (
    <Link href={href} className={`${cls} transition-colors duration-150 hover:bg-surface hover:text-fg`}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

function PromiseCard({ tone, icon, title, children }: { tone: "accent" | "warm" | "sealed"; icon: React.ReactNode; title: string; children: React.ReactNode }) {
  const tile = { accent: "bg-accent-soft text-accent-text", warm: "bg-warm-soft text-warm", sealed: "bg-sealed-soft text-sealed" }[tone];
  return (
    <div className="card box-border flex flex-[1_1_300px] flex-col gap-6 p-[clamp(28px,4vw,48px)]">
      <div className={`flex h-14 w-14 items-center justify-center rounded-xl ${tile}`}>{icon}</div>
      <div className="flex flex-col gap-2.5">
        <div className="heading">{title}</div>
        <p className="m-0 text-lg leading-[1.55] text-muted">{children}</p>
      </div>
    </div>
  );
}

// ---- live expiry visual ----------------------------------------------------------------------

interface Gone extends FeedEntity {
  goneAt: bigint;
  reason: "expired" | "deleted";
}

/**
 * Live demo_feed entities counting down. Arkiv never announces an expiry, so an entity that
 * disappears is remembered here for a minute and shown as expired (or deleted, if it vanished
 * before its deadline).
 */
function LiveExpiry({ feed, receipts, head, error }: { feed?: FeedEntity[]; receipts?: Receipt[]; head?: bigint; error: unknown }) {
  const seen = useRef(new Map<string, FeedEntity>());
  const gone = useRef(new Map<string, Gone>());

  if (feed && head !== undefined) {
    const live = new Set(feed.map((e) => e.key.toLowerCase()));
    for (const [k, e] of seen.current) {
      if (!live.has(k) && !gone.current.has(k)) gone.current.set(k, { ...e, goneAt: head, reason: head >= e.expiresAt ? "expired" : "deleted" });
    }
    seen.current = new Map(feed.map((e) => [e.key.toLowerCase(), e]));
    for (const [k, g] of gone.current) if (head - g.goneAt > 45n) gone.current.delete(k);
  }

  const latestFor = (k: Hex) => receipts?.find((r) => r.subject?.toLowerCase() === k.toLowerCase());
  const rows = [
    ...[...gone.current.values()].map((g) => ({ e: g as FeedEntity, gone: g })),
    ...(feed ?? [])
      .filter((e) => SHOWN_KINDS.includes(e.kind))
      .sort((a, b) => SHOWN_KINDS.indexOf(a.kind) - SHOWN_KINDS.indexOf(b.kind) || (a.expiresAt < b.expiresAt ? -1 : 1))
      .map((e) => ({ e, gone: undefined as Gone | undefined })),
  ].slice(0, 4);

  return (
    <div
      aria-label="Live expiry"
      className="box-border flex min-w-0 flex-[1_1_420px] flex-col gap-1.5 rounded-3xl border border-line bg-surface p-[clamp(20px,3vw,28px)] shadow-[0_40px_80px_-40px_rgba(0,0,0,0.5)]"
    >
      <div className="flex items-center justify-between gap-3 border-b border-line pb-3">
        <span className="flex items-center gap-2.5 text-sm font-semibold">
          <LiveDot />
          Watching on Arkiv
        </span>
        <span className="num text-[13px] text-subtle">{fmtBlock(head)}</span>
      </div>
      {error && !feed ? (
        <ErrorState error={error} />
      ) : !feed ? (
        Array.from({ length: 3 }, (_, i) => <div key={i} className="my-3 h-[52px] animate-pulse rounded-lg bg-sunken" />)
      ) : rows.length === 0 ? (
        <div className="flex flex-col gap-2 py-6 text-sm text-muted">
          <span className="heading text-fg">Nothing counting down right now.</span>
          <span>
            Bring an entity of your own, or emit one with <code className="font-mono text-[13px] text-fg">pnpm cli demo-feed --kind listing</code>.
          </span>
        </div>
      ) : (
        rows.map(({ e, gone }) => {
          const r = latestFor(e.key);
          const view = gone ? { left: 0n, pct: 0, expired: true, warn: false, text: gone.reason === "expired" ? "Expired" : "Deleted" } : expiryView(e.createdAt, e.expiresAt, head);
          const note = gone
            ? `✕ ${gone.reason === "expired" ? "Expired" : "Deleted"}${r ? ` · receipt ${short(r.key)}` : ""}`
            : r?.outcome === "extended"
              ? `↻ Reactivated · receipt ${short(r.key)}`
              : undefined;
          return (
            <div key={e.key} className="flex flex-col gap-2.5 border-b border-line py-4 transition-opacity duration-[400ms]" style={{ opacity: gone ? 0.55 : 1 }}>
              <div className="flex items-baseline justify-between gap-3">
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className="text-[15px] leading-[1.2] font-semibold">{e.kind}</span>
                  <Mono value={e.key} className="text-xs text-subtle" />
                </span>
                <span className={`num shrink-0 text-[13px] font-medium ${view?.expired ? "text-danger" : view?.warn ? "text-warning" : "text-fg"}`}>
                  {view ? (view.warn ? `⚠ ${view.text}` : view.text) : "…"}
                </span>
              </div>
              <ExpiryBar view={view} height={6} />
              {note && <span className={`animate-in-fast text-[13px] font-semibold ${gone ? "text-danger" : "text-accent-text"}`}>{note}</span>}
            </div>
          );
        })
      )}
      <span className="pt-2 text-[13px] text-subtle">Arkiv never announces an expiry. Workers do.</span>
    </div>
  );
}

// ---- receipts ticker -------------------------------------------------------------------------

function ReceiptTicker({
  receipts,
  pubByKey,
  workers,
  head,
}: {
  receipts?: Receipt[];
  pubByKey: ReturnType<typeof byKey<import("@/lib/data").PublicTrigger>>;
  workers?: import("@/lib/data").Worker[];
  head?: bigint;
}) {
  const rows = (receipts ?? []).slice(0, 14);
  return (
    <section aria-label="Live receipts" className="relative flex flex-col gap-4 pt-12 pb-[clamp(64px,9vw,112px)]">
      <div className="mx-auto box-border flex w-full max-w-[1200px] items-center justify-between gap-4 px-[clamp(16px,3vw,24px)]">
        <span className="flex items-center gap-2.5 text-sm font-semibold">
          <LiveDot />
          Live receipts
        </span>
        <Link href="/receipts" className="text-sm font-semibold">
          All receipts ›
        </Link>
      </div>
      {rows.length === 0 ? (
        <div className="mx-auto box-border w-full max-w-[1200px] px-[clamp(16px,3vw,24px)]">
          <div className="card px-6 py-5 text-sm text-muted">{receipts ? "No receipts in the last 24 hours yet." : "Reading receipts…"}</div>
        </div>
      ) : (
        <div className="overflow-hidden [mask-image:linear-gradient(90deg,transparent,#000_10%,#000_90%,transparent)]">
          <div className={`flex w-max gap-3 ${rows.length > 3 ? "animate-marquee hover:[animation-play-state:paused]" : "px-6"}`}>
            {(rows.length > 3 ? [...rows, ...rows] : rows).map((r, i) => {
              const t = pubByKey.get(r.trigger.toLowerCase());
              const label = receiptLabel(r, t);
              const toneCls =
                label.tone === "accent" ? "bg-accent-soft text-accent-text" : label.tone === "sealed" ? "bg-sealed-soft text-sealed" : label.tone === "warning" ? "bg-warning-soft text-warning" : "bg-sunken text-muted";
              return (
                <Link
                  key={`${r.key}-${i}`}
                  href={`/triggers/${r.trigger}`}
                  aria-hidden={i >= rows.length ? true : undefined}
                  tabIndex={i >= rows.length ? -1 : undefined}
                  className="flex h-[52px] shrink-0 items-center gap-3 rounded-xl border border-line bg-surface px-4 text-fg no-underline hover:bg-raised hover:text-fg"
                >
                  <span className="font-mono text-[13px] font-medium">{workerLabel(workers, r.creator) ?? short(r.creator)}</span>
                  <span className={`flex h-[26px] items-center rounded-lg px-2.5 text-xs font-semibold ${toneCls}`}>{label.text}</span>
                  <span className="font-mono text-[13px] text-muted">{r.mode === "sealed" ? short(r.trigger) : r.subject ? short(r.subject) : short(r.trigger)}</span>
                  <span className="num text-[13px] text-subtle">{fmtBlock(r.firedBlock)}</span>
                  <span className="text-[13px] text-subtle">{relBlocks(r.firedBlock, head)}</span>
                </Link>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
