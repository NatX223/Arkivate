"use client";

import { GRACE_BLOCKS, TIRAMISU_RPC_HTTP, arkivVerifyReads, verifySealed, type Step, type VerifyResult } from "@arkivate/core";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { Hex } from "viem";
import { getReader } from "@/lib/arkiv";
import { loadReveals, loadWorkers, type Reveal, type Worker } from "@/lib/data";
import { describeSpec } from "@/lib/describe";
import { fmtBlock, sameAddr, short } from "@/lib/format";
import { BanIcon, CheckIcon, LinkIcon, LockIcon, RefreshIcon, WarningIcon, XIcon } from "./icons";
import { Badge, CopyButton, ErrorState, HashChip, explorerAddress, useCopy } from "./ui";

const isKey = (k: string) => /^0x[0-9a-fA-F]{64}$/.test(k);

const TITLES = [
  "Commitment found",
  "Reveal matches commitment",
  "Worker accepted the job",
  "Condition was met",
  "Receipt from the worker within the grace window",
];

interface Extra {
  workers: Worker[];
  reveal?: Reveal;
}

export function VerifyView({ initialKey }: { initialKey?: string }) {
  const router = useRouter();
  const [input, setInput] = useState(initialKey ?? "");
  const k = initialKey && isKey(initialKey) ? (initialKey as Hex) : undefined;
  const [result, setResult] = useState<VerifyResult>();
  const [extra, setExtra] = useState<Extra>();
  const [error, setError] = useState<unknown>();
  const [tick, setTick] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval>>(undefined);

  const animate = useCallback(() => {
    clearInterval(timer.current);
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return setTick(5);
    setTick(0);
    // ~300 ms per step: a dramatic but quick reveal.
    timer.current = setInterval(() => setTick((t) => (t >= 5 ? (clearInterval(timer.current), 5) : t + 1)), 300);
  }, []);

  const run = useCallback(async () => {
    if (!k) return;
    setError(undefined);
    setResult(undefined);
    setTick(0);
    try {
      const reader = getReader();
      const [r, workers] = await Promise.all([verifySealed(k, arkivVerifyReads(reader), TIRAMISU_RPC_HTTP), loadWorkers(true)]);
      const creator = r.steps[0]?.evidence.creator;
      const reveal = (await loadReveals(k)).find((x) => creator && sameAddr(x.creator, creator));
      setResult(r);
      setExtra({ workers, reveal });
      animate();
    } catch (e) {
      setError(e);
    }
  }, [k, animate]);

  useEffect(() => {
    void run();
    return () => clearInterval(timer.current);
  }, [run]);

  const done = !!result && tick >= 5;
  const inputBad = input.trim() !== "" && !isKey(input.trim());

  return (
    <main className="page">
      <div aria-hidden="true" className="arc opacity-60" style={{ right: -260, top: 40, width: 640, height: 640, background: "radial-gradient(circle at 35% 60%, var(--orb), transparent 62%)" }} />
      <div aria-hidden="true" className="hairline" style={{ top: 280, transform: "rotate(-7deg)" }} />

      <div className="relative flex flex-col gap-3.5">
        <div className="eyebrow">Verify a sealed trigger</div>
        <h1 className="display-lg m-0">Did the worker fire?</h1>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const v = input.trim();
            if (!isKey(v)) return;
            if (v.toLowerCase() === k?.toLowerCase()) void run();
            else router.push(`/verify/${v}`);
          }}
          className="mt-1.5 flex max-w-[820px] flex-wrap gap-3"
        >
          <label className="flex min-w-0 flex-[1_1_300px] flex-col gap-1.5">
            <span className="text-sm font-medium">Sealed trigger key</span>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="0x… (64 hex characters)"
              aria-invalid={inputBad}
              className="input input-mono h-12! text-ellipsis"
              spellCheck={false}
            />
            {inputBad && <span className="text-[13px] text-danger">That isn&apos;t a 32-byte entity key.</span>}
          </label>
          <button type="submit" disabled={!isKey(input.trim())} className="btn btn-primary self-end px-6">
            Verify
          </button>
        </form>
      </div>

      {!k ? (
        <div className="card relative flex flex-col gap-3 p-8 text-muted">
          <span className="heading text-fg">Paste a sealed-trigger key to check it.</span>
          <span className="text-[15px]">
            Verification uses only public reads, so anyone can run it and anyone can repeat it. Find sealed keys on the{" "}
            <Link href="/triggers">Triggers</Link> page.
          </span>
        </div>
      ) : (
        <>
          <div aria-live="polite" className="relative">
            {error ? (
              <ErrorState error={error} onRetry={run} />
            ) : !done ? (
              <div className="card flex flex-col gap-3.5 rounded-3xl! p-[clamp(28px,5vw,48px)]">
                <span className="flex items-center gap-2.5 text-[13px] font-bold tracking-[0.08em] text-info uppercase">
                  <span className="box-border h-3.5 w-3.5 animate-spin-ark rounded-full border-2 border-info border-r-transparent" />
                  Checking
                </span>
                <div className="display-md text-muted">{result ? `Resolving verdict, step ${Math.min(tick + 1, 5)} of 5` : "Reading the evidence from Arkiv…"}</div>
              </div>
            ) : (
              <VerdictCard r={result} extra={extra} />
            )}
          </div>

          <div className="relative flex flex-wrap items-start gap-6">
            <section aria-label="Verification steps" className="card box-border flex min-w-0 flex-[2_1_560px] flex-col p-[clamp(20px,4vw,40px)]">
              <div className="mb-6 flex items-center justify-between gap-3">
                <h2 className="heading m-0">Evidence checklist</h2>
                <button type="button" onClick={() => (result ? animate() : void run())} className="btn btn-secondary btn-sm bg-transparent!">
                  <RefreshIcon size={14} /> Replay
                </button>
              </div>
              {TITLES.map((title, i) => (
                <CheckStep key={title} i={i} title={title} step={result?.steps[i]} verdict={result?.verdict} shown={!!result && i < tick} running={!!result ? i === tick && tick < 5 : i === 0 && !error} />
              ))}
            </section>
            <aside className="flex min-w-0 flex-[1_1_320px] flex-col gap-6">
              <TriggerAside r={result} extra={extra} sealedKey={k} />
            </aside>
          </div>

          {result && <Recheck r={result} />}
        </>
      )}
    </main>
  );
}

// ---- checklist -------------------------------------------------------------------------------

type Look = "ok" | "fail" | "warn" | "wait" | "na";

function stepLook(step: Step | undefined, verdict: VerifyResult["verdict"] | undefined): Look {
  if (!step) return "na";
  if (step.ok) return "ok";
  if (verdict === "PENDING") return "wait";
  if (verdict === "INVALID_REVEAL" || verdict === "INCONCLUSIVE" || verdict === "NOT_TRIGGERED") return "warn";
  return "fail";
}

const LOOK: Record<Look, { label: string; color: string; chipBg: string; chipFg: string }> = {
  ok: { label: "✓ Passed", color: "var(--success)", chipBg: "var(--bg-sunken)", chipFg: "var(--text-muted)" },
  fail: { label: "✕ Failed", color: "var(--danger)", chipBg: "var(--danger-soft)", chipFg: "var(--danger)" },
  warn: { label: "! Not proven", color: "var(--warning)", chipBg: "var(--warning-soft)", chipFg: "var(--warning)" },
  wait: { label: "🔒 Waiting", color: "var(--sealed)", chipBg: "var(--sealed-soft)", chipFg: "var(--sealed)" },
  na: { label: "Not run", color: "var(--text-subtle)", chipBg: "var(--bg-sunken)", chipFg: "var(--text-muted)" },
};

const chipValue = (v: string) => v.replace(/0x[0-9a-fA-F]{40,}/g, (h) => short(h));

function CheckStep({ i, title, step, verdict, shown, running }: { i: number; title: string; step?: Step; verdict?: VerifyResult["verdict"]; shown: boolean; running: boolean }) {
  const look = stepLook(step, verdict);
  const m = LOOK[look];
  const chips = step ? Object.entries(step.evidence).map(([n, v]) => `${n.replace(/_/g, " ")} ${chipValue(v)}`) : [];
  const circle = "flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full";
  return (
    <div className="flex gap-4">
      <div className="flex flex-col items-center">
        {shown && look === "ok" ? (
          <span className={`${circle} bg-success text-bg`}>
            <CheckIcon size={15} weight={3} />
          </span>
        ) : shown && look === "fail" ? (
          <span className={`${circle} bg-danger text-bg`}>
            <XIcon size={14} weight={3} />
          </span>
        ) : shown && look === "warn" ? (
          <span className={`${circle} bg-warning text-[15px] font-extrabold text-bg`}>!</span>
        ) : running ? (
          <span className={`${circle} box-border animate-spin-ark border-2 border-accent border-r-transparent`} />
        ) : (
          <span className={`${circle} box-border border-2 border-line-strong font-mono text-xs font-semibold text-subtle`}>{look === "wait" && shown ? <LockIcon size={13} /> : i + 1}</span>
        )}
        {i < 4 && <span className="my-1.5 min-h-5 w-0.5 flex-1 bg-line" />}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2.5 pt-1 pb-[26px]">
        <div className="flex flex-wrap justify-between gap-x-3 gap-y-1">
          <span className={`text-[17px] leading-[1.35] font-semibold ${shown && look !== "na" ? "text-fg" : "text-muted"}`}>{title}</span>
          <span className="text-[13px] leading-[1.6] font-semibold" style={{ color: shown ? m.color : "var(--accent-text)" }}>
            {shown ? m.label : running ? "Checking…" : ""}
          </span>
        </div>
        {shown && step && (
          <div className="flex animate-in-fast flex-col gap-2">
            <span className="text-sm text-muted">{chipValue(step.detail)}</span>
            {chips.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {chips.map((c) => (
                  <span key={c} className="max-w-full rounded-md px-2 py-1 font-mono text-[13px] leading-[1.4] break-all" style={{ background: m.chipBg, color: m.chipFg }}>
                    {c}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ---- verdict ---------------------------------------------------------------------------------

const blockIn = (s: string | undefined) => {
  const m = s?.match(/@ block (\d+)/);
  return m ? BigInt(m[1]!) : undefined;
};

function VerdictCard({ r, extra }: { r: VerifyResult; extra?: Extra }) {
  const { copied, copy } = useCopy();
  const workerAddr = r.steps[0]?.evidence.worker;
  const workerName = (workerAddr && extra?.workers.find((w) => sameAddr(w.creator, workerAddr))?.name) || (workerAddr ? short(workerAddr) : "the worker");
  const link = typeof window !== "undefined" ? window.location.href : "";

  if (r.verdict === "SKIPPED") {
    const accepted = r.steps[2]?.evidence.accepted_block;
    const met = blockIn(Object.values(r.steps[3]?.evidence ?? {})[0]);
    return (
      <div className="relative flex animate-in flex-col gap-5 overflow-hidden rounded-3xl border-2 border-danger bg-danger-soft p-[clamp(28px,5vw,48px)]">
        <div aria-hidden="true" className="absolute h-px w-[130%] bg-danger opacity-20" style={{ left: "-10%", top: "58%", transform: "rotate(-5deg)" }} />
        <div aria-hidden="true" className="absolute rounded-full border border-danger opacity-25" style={{ right: -140, top: -160, width: 420, height: 420 }} />
        <span className="relative flex items-center gap-2.5 text-sm font-bold tracking-[0.1em] text-danger uppercase">
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-danger text-bg">
            <XIcon size={14} weight={3} />
          </span>
          Verdict · Skipped
        </span>
        <div className="relative font-serif text-[clamp(48px,7.5vw,96px)] leading-[0.98] tracking-[-0.03em] text-balance">Provable censorship.</div>
        <p className="relative m-0 max-w-[760px] text-[clamp(17px,1.8vw,20px)] leading-[1.55] text-muted">
          <span className="font-semibold text-fg">{workerName}</span> accepted this sealed job, the condition was met on-chain, and no receipt appeared before the
          grace window closed. Anyone can re-check every step below.
        </p>
        <div className="relative grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-px overflow-hidden rounded-2xl border border-line-strong bg-line-strong">
          <Fact label="Accepted by" value={workerName} sub={accepted ? fmtBlock(BigInt(accepted)) : ""} />
          <Fact label="Condition met" value={fmtBlock(met)} sub="from the revealed spec" />
          <Fact label="Grace window" value={`${GRACE_BLOCKS} blocks`} sub={met !== undefined ? `closed ${fmtBlock(met + GRACE_BLOCKS)}` : ""} />
          <Fact
            label="Receipts found"
            value={
              <span className="flex items-center gap-2 text-danger">
                <XIcon size={14} weight={3} />0
              </span>
            }
            sub="none in window"
          />
        </div>
        <div className="relative flex flex-wrap gap-3">
          <button type="button" onClick={() => copy(link)} className="btn h-11 bg-danger px-[18px] text-[15px] text-bg">
            <LinkIcon size={16} />
            {copied ? "Copied ✓" : "Copy verdict link"}
          </button>
          <a href="#recheck" className="btn btn-secondary h-11 px-[18px] text-[15px]">
            Re-check it yourself ›
          </a>
        </div>
      </div>
    );
  }

  const simple: Record<string, { tone: string; label: ReactNode; title: string; body: ReactNode; glow?: boolean }> = {
    FIRED: {
      tone: "border-success bg-success-soft",
      label: (
        <span className="flex items-center gap-2 text-success">
          <CheckIcon size={16} weight={2.6} />
          Verdict · Fired
        </span>
      ),
      title: "Fired honestly.",
      body: `${workerName} posted a sealed receipt for every hit within the ${GRACE_BLOCKS}-block grace window.`,
      glow: true,
    },
    NOT_ACCEPTED: {
      tone: "border-line-strong bg-surface",
      label: (
        <span className="flex items-center gap-2 text-muted">
          <BanIcon size={16} weight={2.4} />
          Verdict · Not accepted
        </span>
      ),
      title: "Never accepted.",
      body: `${workerName} never took this job, so it owed nothing. No fault can be assigned.`,
    },
    INVALID_REVEAL: {
      tone: "border-warning bg-warning-soft",
      label: (
        <span className="flex items-center gap-2 text-warning">
          <WarningIcon size={16} weight={2.4} />
          Verdict · Invalid reveal
        </span>
      ),
      title: "Hash mismatch.",
      body: "The revealed spec doesn't hash to the published commitment, so it can't be used as evidence.",
    },
    PENDING: {
      tone: "border-line bg-sealed-soft",
      label: <span className="flex items-center gap-2 text-sealed">🔒 Verdict · Pending</span>,
      title: r.steps[1]?.ok ? "Grace window still open." : "Still sealed.",
      body: r.steps[1]?.ok ? `The condition was met, and ${workerName} still has time to post its receipt. Check again shortly.` : "No reveal has been posted yet, so the spec is private. Only the owner can reveal it.",
    },
    NOT_TRIGGERED: {
      tone: "border-line bg-info-soft",
      label: <span className="flex items-center gap-2 text-info">◌ Verdict · Not triggered</span>,
      title: "Nothing to fire yet.",
      body: "The revealed condition hasn't been met since the worker accepted, so no receipt was owed.",
    },
    INCONCLUSIVE: {
      tone: "border-warning bg-warning-soft",
      label: (
        <span className="flex items-center gap-2 text-warning">
          <WarningIcon size={16} weight={2.4} />
          Verdict · Inconclusive
        </span>
      ),
      title: "Can't tell from live data.",
      body: "The evidence this condition needs is no longer queryable at head (expired or deleted entities look the same). Dispute while the evidence is fresh.",
    },
    NOT_FOUND: {
      tone: "border-line-strong bg-surface",
      label: <span className="flex items-center gap-2 text-muted">Verdict · Not found</span>,
      title: "No such sealed trigger.",
      body: "There's no sealed entity and no acceptance for this key. Check the key, or it may never have existed.",
    },
  };
  const v = simple[r.verdict]!;
  return (
    <div className={`relative flex animate-in flex-col gap-4 overflow-hidden rounded-3xl border p-[clamp(28px,5vw,48px)] ${v.tone}`}>
      {v.glow && <div aria-hidden="true" className="absolute rounded-full opacity-40" style={{ right: -120, top: -140, width: 420, height: 420, background: "var(--gradient-hero)", filter: "blur(70px)" }} />}
      <span className="relative text-sm font-bold tracking-[0.1em] uppercase">{v.label}</span>
      <div className="relative font-serif text-[clamp(48px,7.5vw,96px)] leading-[0.98] tracking-[-0.03em]">{v.title}</div>
      <p className="relative m-0 max-w-[760px] text-[clamp(17px,1.8vw,20px)] leading-[1.55] text-muted">{v.body}</p>
      <div className="relative">
        <button type="button" onClick={() => copy(link)} className="btn btn-secondary h-11 text-[15px]">
          <LinkIcon size={16} />
          {copied ? "Copied ✓" : "Copy verdict link"}
        </button>
      </div>
    </div>
  );
}

function Fact({ label, value, sub }: { label: string; value: ReactNode; sub: string }) {
  return (
    <div className="flex flex-col gap-2 bg-sunken px-5 py-[18px]">
      <span className="text-[13px] text-subtle">{label}</span>
      <span className="font-mono text-base leading-[1.2] font-medium">{value}</span>
      <span className="font-mono text-[13px] text-muted">{sub}</span>
    </div>
  );
}

// ---- aside -----------------------------------------------------------------------------------

function TriggerAside({ r, extra, sealedKey }: { r?: VerifyResult; extra?: Extra; sealedKey: Hex }) {
  const ev = r?.steps[0]?.evidence;
  const worker = ev?.worker ? extra?.workers.find((w) => sameAddr(w.creator, ev.worker!)) : undefined;
  return (
    <>
      <div className="card flex flex-col gap-[18px] p-7">
        <div className="flex items-center justify-between gap-3">
          <span className="title">Trigger</span>
          <Badge tone="sealed">🔒 Sealed</Badge>
        </div>
        <div className="flex flex-col gap-2">
          <span className="text-[13px] text-subtle">Sealed key</span>
          <HashChip value={sealedKey} label="sealed key" />
        </div>
        {ev?.commitment && (
          <div className="flex flex-col gap-2">
            <span className="text-[13px] text-subtle">Commitment hash</span>
            <HashChip value={ev.commitment} label="commitment hash" />
          </div>
        )}
        {ev?.creator && (
          <div className="flex flex-col gap-2">
            <span className="text-[13px] text-subtle">Owner</span>
            <HashChip value={ev.creator} label="owner address" href={explorerAddress(ev.creator)} />
          </div>
        )}
        {ev?.worker && (
          <div className="flex flex-col gap-2">
            <span className="text-[13px] text-subtle">Assigned worker</span>
            <Link
              href="/workers"
              className="flex items-center justify-between gap-3 rounded-xl border border-line bg-sunken px-3.5 py-3 text-fg no-underline hover:border-line-strong hover:text-fg"
            >
              <span className="flex flex-col gap-1">
                <span className="font-mono text-[15px] font-medium">{worker?.name || short(ev.worker)}</span>
                <span className="font-mono text-xs text-subtle">{short(ev.worker)}</span>
              </span>
              {!worker ? (
                <Badge tone="danger">○ Not registered</Badge>
              ) : worker.health.state === "online" ? (
                <Badge tone="success">● Online</Badge>
              ) : (
                <Badge tone="danger">○ Offline</Badge>
              )}
            </Link>
          </div>
        )}
        {!r && <span className="text-sm text-muted">Reading…</span>}
      </div>
      {extra?.reveal && (
        <div className="card flex flex-col gap-3.5 p-7">
          <div className="flex items-center justify-between gap-3">
            <span className="title">Revealed spec</span>
            <span className="font-mono text-xs text-subtle">{fmtBlock(extra.reveal.createdAt)}</span>
          </div>
          {extra.reveal.spec && <p className="m-0 font-serif text-[clamp(20px,2.2vw,24px)] leading-[1.3]">{describeSpec(extra.reveal.spec)}</p>}
          <div className="flex items-start gap-2.5 rounded-[10px] bg-sunken px-3.5 py-3 text-[13px] leading-normal text-muted">
            <LockIcon size={16} weight={1.8} className="mt-px shrink-0 text-sealed" />
            The alert destination was sent only to the worker and is never part of the reveal.
          </div>
        </div>
      )}
    </>
  );
}

// ---- recheck ---------------------------------------------------------------------------------

function Recheck({ r }: { r: VerifyResult }) {
  const cmds = [
    "# Re-run the whole check with the CLI",
    `$ pnpm cli verify ${r.sealedKey}`,
    "",
    "# Or query Arkiv directly (the exact reads this page ran)",
    ...r.recheck.map((c) => `$ ${c}`),
  ].join("\n");
  return (
    <section id="recheck" className="relative overflow-hidden rounded-2xl border border-line bg-sunken">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line py-3 pr-3 pl-6">
        <div className="flex flex-col gap-1">
          <span className="text-base font-semibold">Re-check it yourself</span>
          <span className="text-[13px] text-muted">
            Plain <code className="font-mono">arkiv_query</code> calls against the public Tiramisu RPC. No Arkivate server involved.
          </span>
        </div>
        <CopyButton text={cmds} label="Copy all" />
      </div>
      <pre className="m-0 px-6 py-5 font-mono text-[13px] leading-[1.8] break-all whitespace-pre-wrap text-muted">{cmds}</pre>
    </section>
  );
}
