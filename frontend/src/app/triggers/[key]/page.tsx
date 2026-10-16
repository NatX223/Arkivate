"use client";

import { ExpirationTime, jsonToPayload } from "@arkiv-network/sdk";
import { str } from "@arkiv-network/sdk/attr";
import { DEAD, commit, revealAttributes, snapshotWatch, type Destination, type SealedTriggerSpec } from "@arkivate/core";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { Hex } from "viem";
import { DownloadIcon } from "@/components/icons";
import { TxProgress } from "@/components/TxProgress";
import {
  Badge,
  CopyButton,
  Empty,
  ErrorState,
  ExpiryBar,
  Field,
  HashChip,
  JsonBlock,
  Loading,
  explorerAddress,
  expiryView,
  type Tone,
} from "@/components/ui";
import { getReader } from "@/lib/arkiv";
import {
  loadAcceptances,
  loadHead,
  loadReceipts,
  loadReveals,
  loadTriggerEntity,
  loadWatched,
  loadWorkers,
  workerLabel,
  type PublicTrigger,
  type Receipt,
  type SealedTrigger,
  type Worker,
} from "@/lib/data";
import { actionLabel, describeSpec, watchInfo } from "@/lib/describe";
import { blocksToSeconds, fmtBlock, fmtDuration, jsonStringify, relBlocks, sameAddr, short } from "@/lib/format";
import { HandoffError, sendHandoff } from "@/lib/handoff";
import { useHead, usePoll } from "@/lib/poll";
import { receiptLabel } from "@/lib/receipts";
import { downloadSealed, parseSealedFile, readSealed, saveSealed, type SealedFile } from "@/lib/sealedStore";
import { useTx } from "@/lib/tx";
import { useWallet } from "@/lib/wallet";

const isKey = (k: string) => /^0x[0-9a-fA-F]{64}$/.test(k);

async function loadDetail(k: Hex) {
  const [entity, receipts, workers] = await Promise.all([loadTriggerEntity(k), loadReceipts({ trigger: k, max: 300 }), loadWorkers(true)]);
  const sealedLike = entity.kind === "sealed" || entity.kind === "gone";
  const [acceptances, reveals] = sealedLike ? await Promise.all([loadAcceptances(k), loadReveals(k)]) : [[], []];
  let watched: Awaited<ReturnType<typeof loadWatched>> | null = null;
  let matched: { key: Hex; expiresAt: bigint }[] = [];
  if (entity.kind === "public" && "watch" in entity.trigger.spec.cond) {
    const watch = entity.trigger.spec.cond.watch;
    if ("entity_key" in watch) watched = (await loadWatched(watch.entity_key as Hex)) ?? null;
    else matched = (await snapshotWatch(getReader(), watch, await loadHead())).slice(0, 6) as { key: Hex; expiresAt: bigint }[];
  }
  return { entity, receipts, workers, acceptances, reveals, watched, matched };
}

export default function TriggerDetailPage() {
  const params = useParams<{ key: string }>();
  const k = (params.key ?? "") as Hex;
  const valid = isKey(k);
  const detail = usePoll(() => (valid ? loadDetail(k) : Promise.reject(new Error("not a 32-byte entity key"))), 12_000, k);
  const head = useHead().data;
  const d = detail.data;

  return (
    <main className="page">
      <div aria-hidden="true" className="arc opacity-45" style={{ right: -220, top: 20, width: 560, height: 560 }} />
      <nav aria-label="Breadcrumb" className="relative flex items-center gap-2 text-sm font-medium text-subtle">
        <Link href="/triggers" className="link-plain">
          Triggers
        </Link>
        <span>/</span>
        <span className="font-mono text-fg">{short(k)}</span>
      </nav>
      {!valid ? (
        <Empty title="That isn't a trigger key.">Trigger keys are 0x followed by 64 hex characters.</Empty>
      ) : !d ? (
        detail.error ? <ErrorState error={detail.error} onRetry={detail.refresh} /> : <Loading />
      ) : d.entity.kind === "public" ? (
        <PublicDetail t={d.entity.trigger} d={d} head={head} onChange={detail.refresh} />
      ) : d.entity.kind === "sealed" ? (
        <SealedDetail s={d.entity.sealed} d={d} head={head} onChange={detail.refresh} />
      ) : d.entity.kind === "gone" && d.acceptances.length > 0 ? (
        <Empty title="This sealed trigger has expired.">
          Its acceptance is still on Arkiv, so a dispute can still be checked.{" "}
          <Link href={`/verify/${k}`}>Verify it ›</Link>
        </Empty>
      ) : d.entity.kind === "gone" ? (
        <Empty title="No live trigger with this key.">It expired, was deleted, or never existed. Arkiv can&apos;t tell which (friction F13).</Empty>
      ) : (
        <Empty title="Not a trigger.">{d.entity.error}</Empty>
      )}
    </main>
  );
}

type Detail = Awaited<ReturnType<typeof loadDetail>>;

// ---- public ----------------------------------------------------------------------------------

function PublicDetail({ t, d, head, onChange }: { t: PublicTrigger; d: Detail; head?: bigint; onChange(): void }) {
  const w = useWallet();
  const tx = useTx();
  const isOwner = sameAddr(w.address, t.creator);
  const act = actionLabel(t.spec.action);
  const extended = d.receipts.filter((r) => r.outcome === "extended").length;
  const nextStatus = t.status === "active" ? "paused" : "active";

  useEffect(() => {
    if (tx.stage === "done") onChange();
  }, [tx.stage, onChange]);

  const pause = () =>
    tx.run((wallet) => wallet.patchEntity({ entityKey: t.key, set: { status: str(nextStatus) } }));

  const events: TimelineEvent[] = [
    ...d.receipts.map((r) => receiptEvent(r, d.workers, t)),
    { title: `Created by ${short(t.creator)}`, block: t.createdAt, tone: "neutral" as const },
  ];

  return (
    <>
      <div className="relative flex flex-wrap items-start justify-between gap-8">
        <div className="flex min-w-0 flex-[1_1_640px] flex-col gap-[18px]">
          <div className="flex flex-wrap gap-2">
            <Badge tone="neutral" className="border border-line-strong bg-surface! text-fg!">
              Public
            </Badge>
            {t.status === "paused" ? <Badge tone="neutral">Ⅱ Paused</Badge> : <Badge tone="success">● Active</Badge>}
            <Badge tone={act.kind === "reactivate" ? "accent" : act.kind === "alert" ? "warm" : "neutral"} square>
              {act.text}
            </Badge>
          </div>
          <h1 className="m-0 max-w-[880px] font-serif text-[clamp(34px,4.5vw,52px)] leading-[1.1] font-normal tracking-[-0.02em] text-pretty">
            {describeSpec(t.spec)}
          </h1>
          <Meta k={t.key} creator={t.creator} created={t.createdAt} expires={t.expiresAt} head={head} />
        </div>
        {isOwner && (
          <OwnerPanel hint="Pausing signs a small update in your wallet. Workers stop firing until you resume.">
            <button type="button" disabled={tx.busy} onClick={pause} className="btn btn-secondary bg-raised!">
              {tx.busy ? "Waiting for wallet…" : t.status === "active" ? "Ⅱ Pause trigger" : "▶ Resume trigger"}
            </button>
            <TxProgress stage={tx.stage} hash={tx.hash} error={tx.error} />
          </OwnerPanel>
        )}
      </div>

      <div className="flex flex-wrap items-start gap-6">
        <div className="flex min-w-0 flex-[2_1_600px] flex-col gap-6">
          <Timeline events={events} head={head} count={d.receipts.length} />
          <JsonBlock title="Raw spec" note="arkivate trigger v1" json={jsonStringify(t.spec)} />
        </div>
        <aside className="flex min-w-0 flex-[1_1_320px] flex-col gap-6">
          <WatchedPanel t={t} d={d} head={head} extended={extended} />
        </aside>
      </div>
    </>
  );
}

function WatchedPanel({ t, d, head, extended }: { t: PublicTrigger; d: Detail; head?: bigint; extended: number }) {
  const info = watchInfo(t.spec.cond);
  const action = t.spec.action;
  const max = action.type === "extend" ? action.max_extensions : 0;

  if (!("watch" in t.spec.cond)) {
    return (
      <div className="card flex flex-col gap-4 p-7">
        <span className="title">Watched query</span>
        <span className="text-[15px] font-semibold">{info.label}</span>
        <span className="text-sm text-muted">{info.createdBy ? `Only entities created by ${short(info.createdBy)}.` : "Entities from any creator."}</span>
      </div>
    );
  }

  if (info.key) {
    const e = d.watched;
    const v = e ? expiryView(e.createdAt, e.expiresAt, head) : undefined;
    return (
      <div className="card flex flex-col gap-5 p-7">
        <div className="flex items-center justify-between gap-3">
          <span className="title">Watched entity</span>
          {e ? <Badge tone="success">● Live</Badge> : <Badge tone="danger">✕ Gone</Badge>}
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-[15px] font-semibold">{e?.label ?? "entity"}</span>
          <HashChip value={info.key} label="entity key" />
        </div>
        {e && v ? (
          <>
            <div className="flex flex-col gap-2.5">
              <span className="text-[13px] text-subtle">Expires in</span>
              <span className={`num font-serif! text-[clamp(44px,5vw,64px)] leading-none tracking-[-0.02em] ${v.warn ? "text-warning" : ""}`}>{v.text}</span>
              <ExpiryBar view={v} height={6} />
              <div className="num flex justify-between text-[13px] text-muted">
                <span>{Number(v.left).toLocaleString("en-US")} blocks</span>
                <span>{fmtBlock(e.expiresAt)}</span>
              </div>
            </div>
            {!e.extendable && action.type === "extend" && (
              <span className="rounded-lg bg-warning-soft px-3 py-2 text-[13px] text-warning">
                ⚠ This entity doesn&apos;t allow renewal by others, so workers can&apos;t reactivate it.
              </span>
            )}
          </>
        ) : (
          <div className="flex flex-col gap-1.5 rounded-xl bg-sunken p-4">
            <span className="font-serif text-[28px] leading-[1.1]">Gone</span>
            <span className="font-mono text-[13px] text-muted">expired or deleted (Arkiv can&apos;t say which)</span>
          </div>
        )}
        {max > 0 && <Renewals done={extended} max={max} />}
      </div>
    );
  }

  return (
    <div className="card flex flex-col gap-5 p-7">
      <div className="flex items-center justify-between gap-3">
        <span className="title">Watched entities</span>
        <Badge tone="neutral">{d.matched.length} live</Badge>
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-[15px] font-semibold">{info.label}</span>
        <span className="font-mono text-[13px] text-subtle">{info.createdBy ? `from ${short(info.createdBy)}` : "from anyone"}</span>
      </div>
      {d.matched.length === 0 ? (
        <span className="text-sm text-muted">No matching entity is live right now.</span>
      ) : (
        <div className="flex flex-col gap-4">
          {d.matched.map((m) => {
            const left = head !== undefined && m.expiresAt > head ? m.expiresAt - head : 0n;
            return (
              <div key={m.key} className="flex flex-col gap-1.5">
                <div className="flex justify-between gap-3 font-mono text-[13px]">
                  <span title={m.key}>{short(m.key)}</span>
                  <span className={left === 0n ? "text-danger" : "num"}>{left === 0n ? "Expired" : fmtDuration(blocksToSeconds(left))}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {max > 0 && <Renewals done={extended} max={max} />}
    </div>
  );
}

function Renewals({ done, max }: { done: number; max: number }) {
  return (
    <>
      <div className="h-px bg-line" />
      <div className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between">
          <span className="text-[15px] font-semibold">Reactivated {done}×</span>
          <span className="font-mono text-[13px] text-subtle">
            {done} / {max}
          </span>
        </div>
        <div aria-hidden="true" className="grid gap-[3px]" style={{ gridTemplateColumns: `repeat(${Math.min(max, 24)}, 1fr)` }}>
          {Array.from({ length: Math.min(max, 24) }, (_, i) => (
            <span key={i} className="h-3.5 rounded-[3px]" style={{ background: i < done ? "var(--accent)" : "var(--border)" }} />
          ))}
        </div>
      </div>
    </>
  );
}

// ---- sealed ----------------------------------------------------------------------------------

function SealedDetail({ s, d, head, onChange }: { s: SealedTrigger; d: Detail; head?: bigint; onChange(): void }) {
  const w = useWallet();
  const isOwner = sameAddr(w.address, s.creator);
  const worker = d.workers.find((x) => sameAddr(x.creator, s.worker));
  const workerName = worker?.name || short(s.worker);
  const acc = d.acceptances.find((a) => sameAddr(a.creator, s.worker) && a.commitment.toLowerCase() === s.commitment.toLowerCase());
  const reveal = d.reveals.find((r) => sameAddr(r.creator, s.creator));
  const workerReceipts = d.receipts.filter((r) => sameAddr(r.creator, s.worker));

  const events: TimelineEvent[] = [
    ...(reveal ? [{ title: "Spec revealed by owner", block: reveal.createdAt, tone: "sealed" as const, chip: reveal.key }] : []),
    ...workerReceipts.map((r) => receiptEvent(r, d.workers)),
    ...(acc ? [{ title: `Accepted by ${workerName}`, block: acc.acceptedBlock, tone: "sealed" as const, worker: workerName, chip: acc.key }] : []),
    { title: "Sealed commitment created", block: s.createdAt, tone: "sealed" as const, chip: s.key },
  ].sort((a, b) => (a.block > b.block ? -1 : 1));

  return (
    <>
      <div className="relative flex flex-wrap items-start justify-between gap-8">
        <div className="flex min-w-0 flex-[1_1_640px] flex-col gap-[18px]">
          <div className="flex flex-wrap gap-2">
            <Badge tone="sealed" className="font-bold">
              🔒 Sealed
            </Badge>
            {acc ? <Badge tone="success">✓ Accepted by {workerName}</Badge> : <Badge tone="info">◌ Awaiting acceptance</Badge>}
          </div>
          <h1 className="m-0 max-w-[880px] font-serif text-[clamp(34px,4.5vw,52px)] leading-[1.1] font-normal tracking-[-0.02em]">
            {reveal ? "Sealed trigger, revealed by its owner." : "The spec is private."}
          </h1>
          <Meta k={s.key} creator={s.creator} created={s.createdAt} expires={s.expiresAt} head={head} />
        </div>
        {isOwner && <SealedOwnerPanel s={s} accepted={!!acc} revealed={!!reveal} workerEndpoint={worker?.endpoint ?? ""} onChange={onChange} />}
      </div>

      <div className="flex flex-wrap items-start gap-6">
        <div className="flex min-w-0 flex-[2_1_600px] flex-col gap-6">
          <div className="card flex flex-col gap-5 p-8">
            <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-5">
              <div className="flex flex-col gap-2">
                <span className="text-[13px] text-subtle">Commitment hash</span>
                <HashChip value={s.commitment} label="commitment hash" />
              </div>
              <div className="flex flex-col gap-2">
                <span className="text-[13px] text-subtle">Assigned worker</span>
                <Link href="/workers" className="flex items-center gap-2 font-mono text-[15px] font-medium text-fg no-underline">
                  {workerName} <HealthBadge w={worker} />
                </Link>
              </div>
              <div className="flex flex-col gap-2">
                <span className="text-[13px] text-subtle">Acceptance</span>
                {acc ? (
                  <span className="font-mono text-[15px] font-medium text-success">✓ {fmtBlock(acc.acceptedBlock)}</span>
                ) : (
                  <span className="font-mono text-[15px] font-medium text-muted">none yet</span>
                )}
              </div>
            </div>
            {reveal ? (
              <div className="flex flex-col gap-3.5 rounded-xl border border-line bg-sunken p-5">
                <div className="flex flex-wrap justify-between gap-3">
                  <span className="text-sm font-semibold text-accent-text">Revealed at {fmtBlock(reveal.createdAt)}</span>
                  <span className="font-mono text-xs text-subtle">hash check runs in Verify</span>
                </div>
                {reveal.spec && <p className="m-0 font-serif text-[clamp(22px,2.4vw,28px)] leading-[1.25]">{describeSpec(reveal.spec)}</p>}
                <Link href={`/verify/${s.key}`} className="btn btn-primary w-max">
                  Verify this trigger ›
                </Link>
              </div>
            ) : (
              <div className="flex gap-3 rounded-xl bg-sealed-soft p-4 text-[15px] leading-normal text-muted">
                <span className="text-sealed">🔒</span>The spec is private. Only its hash is on Arkiv, and only {workerName} knows what it watches.
              </div>
            )}
          </div>
          <Timeline events={events} head={head} count={workerReceipts.length} />
        </div>
        <aside className="flex min-w-0 flex-[1_1_320px] flex-col gap-6">
          <div className="card flex flex-col gap-5 p-7">
            <div className="flex items-center justify-between gap-3">
              <span className="title">Watched entity</span>
              <Badge tone="sealed">🔒 Sealed</Badge>
            </div>
            <span className="text-[15px] font-semibold">{reveal?.spec ? watchInfo(reveal.spec.cond).label : "Hidden until reveal"}</span>
            <span className="text-sm text-muted">
              {reveal ? "The revealed spec names what it watches; Verify replays the condition." : "Nobody but the owner and the assigned worker can see what this trigger watches."}
            </span>
            {acc && (
              <span className="font-mono text-[13px] text-subtle">
                {workerReceipts.length} sealed receipt{workerReceipts.length === 1 ? "" : "s"} from {workerName}
              </span>
            )}
          </div>
        </aside>
      </div>
    </>
  );
}

function SealedOwnerPanel({
  s,
  accepted,
  revealed,
  workerEndpoint,
  onChange,
}: {
  s: SealedTrigger;
  accepted: boolean;
  revealed: boolean;
  workerEndpoint: string;
  onChange(): void;
}) {
  const tx = useTx();
  const [file, setFile] = useState<SealedFile>();
  const [fileErr, setFileErr] = useState<string>();
  useEffect(() => setFile(readSealed(s.key)), [s.key]);
  useEffect(() => {
    if (tx.stage === "done") onChange();
  }, [tx.stage, onChange]);

  const opens = file ? commit(file.spec, file.salt).toLowerCase() === s.commitment.toLowerCase() : false;

  const reveal = () =>
    tx.run(async (wallet, address) => {
      if (!file || !opens) throw new Error("the saved spec and salt don't open this commitment");
      const [p] = await getReader().predictEntityKeys({ owner: address, count: 1 });
      if (!p) throw new Error("predictEntityKeys returned nothing");
      // Readonly reveal, burned in the same batch so nobody (us included) can delete the evidence.
      return wallet.executeBatch({
        creates: [
          {
            salt: p.salt,
            payload: jsonToPayload({ spec: file.spec, salt: file.salt }),
            contentType: "application/json",
            attributes: revealAttributes(s.key),
            expires: ExpirationTime.fromDays(30),
            flags: { readonly: true },
          },
        ],
        ownershipChanges: [{ entityKey: p.key, newOwner: DEAD }],
      });
    });

  return (
    <OwnerPanel
      hint={revealed ? "Revealed. Anyone can now verify this trigger." : "Revealing publishes the spec and salt so anyone can verify. Your alert destination stays private."}
    >
      {!revealed && file && (
        <button type="button" disabled={tx.busy || !opens} onClick={reveal} className="btn btn-primary">
          🔓 Reveal spec
        </button>
      )}
      {!revealed && !file && (
        <Field label="Spec + salt backup" help="This browser has no copy. Load the backup file saved when you sealed it." error={fileErr}>
          <input
            type="file"
            accept="application/json,.json"
            className="text-sm text-muted file:mr-3 file:h-9 file:cursor-pointer file:rounded-lg file:border file:border-line-strong file:bg-surface file:px-3 file:text-fg"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              try {
                const parsed = parseSealedFile(await f.text());
                if (parsed.sealed_key.toLowerCase() !== s.key.toLowerCase()) throw new Error("that backup is for a different sealed trigger");
                if (commit(parsed.spec, parsed.salt).toLowerCase() !== s.commitment.toLowerCase()) throw new Error("that spec and salt don't open this commitment");
                saveSealed(parsed);
                setFile(parsed);
                setFileErr(undefined);
              } catch (err) {
                setFileErr(err instanceof Error ? err.message : String(err));
              }
            }}
          />
        </Field>
      )}
      {file && !opens && <span className="text-xs text-danger">The saved spec and salt don&apos;t hash to this commitment.</span>}
      {file && (
        <button type="button" onClick={() => downloadSealed(file)} className="btn btn-secondary btn-sm w-max">
          <DownloadIcon size={14} /> Download backup
        </button>
      )}
      <TxProgress stage={tx.stage} hash={tx.hash} error={tx.error} />
      {revealed && (
        <Link href={`/verify/${s.key}`} className="btn btn-primary">
          Verify ›
        </Link>
      )}
      {!accepted && file && <RetryHandoff file={{ ...file, endpoint: file.endpoint || workerEndpoint }} onDone={onChange} />}
    </OwnerPanel>
  );
}

/** Re-send the private hand-off (idempotent on the worker), e.g. after it was unreachable. */
function RetryHandoff({ file, onDone }: { file: SealedFile; onDone(): void }) {
  const tx = useTx();
  const type = ((file.spec as SealedTriggerSpec)?.action?.type ?? "telegram") as Destination["type"];
  const [value, setValue] = useState("");
  const [msg, setMsg] = useState<string>();
  const send = () =>
    tx.run(async (wallet) => {
      setMsg(undefined);
      try {
        const r = await sendHandoff(file, { type, value: value.trim() }, wallet);
        setMsg(`Accepted ✓ ${r.acceptance_key ? short(r.acceptance_key) : ""}`);
        setValue("");
        onDone();
      } catch (e) {
        setMsg(e instanceof HandoffError ? e.message : String(e));
        throw e;
      }
    });
  return (
    <div className="flex flex-col gap-2.5 border-t border-line pt-3">
      <span className="text-[13px] font-semibold text-fg">No acceptance yet. Re-send the hand-off?</span>
      <input
        className="input input-mono"
        aria-label={type === "telegram" ? "Telegram chat ID" : "Webhook URL"}
        placeholder={type === "telegram" ? "Telegram chat ID" : "https://…"}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        autoComplete="off"
      />
      <button type="button" disabled={tx.busy || !value.trim() || !file.endpoint} onClick={send} className="btn btn-secondary btn-sm w-max">
        {tx.busy ? "Signing…" : "Sign & hand off"}
      </button>
      <span className="text-xs text-subtle">Sent only to the worker. It never goes on-chain.</span>
      {msg && <span className="text-xs text-muted">{msg}</span>}
    </div>
  );
}

// ---- shared pieces ---------------------------------------------------------------------------

function OwnerPanel({ hint, children }: { hint: string; children: ReactNode }) {
  return (
    <div className="card flex min-w-[260px] flex-[0_1_320px] flex-col gap-3 p-5">
      <span className="flex items-center gap-2 text-[13px] font-semibold text-muted">
        <span className="h-[7px] w-[7px] rounded-full bg-success" />
        You created this trigger
      </span>
      {children}
      <span className="text-xs leading-[1.45] text-subtle">{hint}</span>
    </div>
  );
}

function Meta({ k, creator, created, expires, head }: { k: Hex; creator: Hex; created: bigint; expires: bigint; head?: bigint }) {
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-3 text-sm text-subtle">
      <span className="flex items-center gap-2">
        Key <HashChip value={k} label="trigger key" />
      </span>
      <span className="flex items-center gap-2">
        Creator <HashChip value={creator} label="creator address" href={explorerAddress(creator)} />
      </span>
      <span>
        Created <span className="font-mono text-muted">{fmtBlock(created)}</span>
      </span>
      <span>
        Lives until <span className="font-mono text-muted">{fmtBlock(expires)}</span>
        {head !== undefined && expires > head && <span className="text-subtle"> ({fmtDuration(blocksToSeconds(expires - head))})</span>}
      </span>
    </div>
  );
}

function HealthBadge({ w }: { w?: Worker }) {
  if (!w) return <Badge tone="danger">○ Not registered</Badge>;
  if (w.health.state === "online") return <Badge tone="success">● Online</Badge>;
  if (w.health.state === "offline") return <Badge tone="danger">○ Offline</Badge>;
  return <Badge tone="neutral">No endpoint</Badge>;
}

interface TimelineEvent {
  title: string;
  block: bigint;
  tone: Tone;
  worker?: string;
  chip?: string;
}

function receiptEvent(r: Receipt, workers: Worker[], t?: PublicTrigger): TimelineEvent {
  const label = receiptLabel(r, t);
  const ext = r.outcome === "extended" && r.oldExpiresAt !== undefined && r.newExpiresAt !== undefined ? ` · ${fmtBlock(r.oldExpiresAt)} → ${fmtBlock(r.newExpiresAt)}` : "";
  return {
    title: r.mode === "sealed" ? "Sealed receipt (result hash only)" : `${label.text}${ext}`,
    block: r.firedBlock,
    tone: r.mode === "sealed" ? "sealed" : label.tone === "warning" ? "warning" : "success",
    worker: workerLabel(workers, r.creator) ?? short(r.creator),
    chip: r.key,
  };
}

const DOT: Record<string, [string, string]> = {
  success: ["var(--success)", "var(--success-soft)"],
  danger: ["var(--danger)", "var(--danger-soft)"],
  sealed: ["var(--sealed)", "var(--sealed-soft)"],
  warning: ["var(--warning)", "var(--warning-soft)"],
  accent: ["var(--accent)", "var(--accent-soft)"],
};

function Timeline({ events, head, count }: { events: TimelineEvent[]; head?: bigint; count: number }) {
  const sorted = useMemo(() => [...events].sort((a, b) => (a.block > b.block ? -1 : 1)), [events]);
  return (
    <section aria-label="Receipt timeline" className="card flex flex-col p-8">
      <div className="mb-6 flex items-center justify-between gap-3">
        <h2 className="heading m-0">Receipt timeline</h2>
        <span className="text-[13px] text-subtle">
          {count} receipt{count === 1 ? "" : "s"}
        </span>
      </div>
      {sorted.map((e, i) => {
        const [dot, ring] = DOT[e.tone] ?? ["var(--text-subtle)", "var(--border)"];
        return (
          <div key={`${e.title}-${e.block}-${i}`} className="flex gap-4">
            <div className="flex flex-col items-center">
              <span className="mt-[5px] h-3 w-3 shrink-0 rounded-full" style={{ background: dot, boxShadow: `0 0 0 4px ${ring}` }} />
              {i < sorted.length - 1 && <span className="mt-2 w-0.5 flex-1 bg-line" />}
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-2 pb-6">
              <div className="flex flex-wrap justify-between gap-x-4 gap-y-1">
                <span className={`text-base leading-[1.4] font-semibold ${e.tone === "danger" ? "text-danger" : ""}`}>{e.title}</span>
                <span className="num text-[13px] leading-[1.6] text-subtle">
                  {fmtBlock(e.block)} · {relBlocks(e.block, head)}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {e.worker && <span className="rounded-md bg-sunken px-2 py-1 font-mono text-xs font-medium">{e.worker}</span>}
                {e.chip && (
                  <span className="flex items-center gap-1 rounded-md bg-sunken py-0.5 pr-0.5 pl-2 font-mono text-xs text-muted" title={e.chip}>
                    {short(e.chip)}
                    <CopyButton text={e.chip} label="" className="h-6! border-none! bg-transparent! px-1.5!" />
                  </span>
                )}
              </div>
            </div>
          </div>
        );
      })}
      {sorted.length === 0 && <span className="text-sm text-muted">Nothing yet.</span>}
    </section>
  );
}
