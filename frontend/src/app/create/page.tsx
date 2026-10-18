"use client";

import { ExpirationTime, jsonToPayload } from "@arkiv-network/sdk";
import {
  PublicTriggerSpec,
  SealedTriggerSpec,
  commit,
  randomSalt,
  sealedAttributes,
  triggerAttributes,
  type ComparisonOp,
  type TriggerSpec,
} from "@arkivate/core";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Hex } from "viem";
import { CheckIcon, DownloadIcon, LockIcon, PinIcon, TerminalIcon } from "@/components/icons";
import { Badge, CopyButton, Field, JsonBlock, Segmented, Steps, explorerTx, expiryView, ExpiryBar, type StepItem, type StepState } from "@/components/ui";
import { getReader } from "@/lib/arkiv";
import { loadWatched, loadWorkers, markChanged, type Worker } from "@/lib/data";
import { describeSpec } from "@/lib/describe";
import { minutesToBlocks, short } from "@/lib/format";
import { HandoffError, sendHandoff } from "@/lib/handoff";
import { useHead, usePoll } from "@/lib/poll";
import { downloadSealed, saveSealed, type SealedFile } from "@/lib/sealedStore";
import { shortError } from "@/lib/tx";
import { useWallet, walletClientFor, walletErrorKind } from "@/lib/wallet";

// ---- form model ------------------------------------------------------------------------------

type Mode = "public" | "sealed";
type CondType = TriggerSpec["cond"]["type"];
type ActionType = "notice" | "extend" | "telegram" | "webhook";

interface Form {
  mode: Mode;
  watchKind: "entity" | "query";
  entityKey: string;
  project: string;
  entityType: string;
  attrName: string;
  attrValue: string;
  createdBy: string;
  cond: CondType;
  leadMin: number;
  deadline: "follow" | "pinned";
  silenceMin: number;
  countOp: ComparisonOp;
  countValue: number;
  action: ActionType;
  extendMin: number;
  maxExt: number;
  worker: string;
  /** Hand-off URL for a worker that registered none (e.g. one running locally), like the CLI's --endpoint. */
  endpoint: string;
  destination: string;
  days: number;
}

const DEFAULT: Form = {
  mode: "public",
  watchKind: "query",
  entityKey: "",
  project: "arkivate",
  entityType: "demo_feed",
  attrName: "kind",
  attrValue: "listing",
  createdBy: "",
  cond: "on_expiring",
  leadMin: 2,
  deadline: "follow",
  silenceMin: 2,
  countOp: "gt",
  countValue: 10,
  action: "extend",
  extendMin: 4,
  maxExt: 2,
  worker: "",
  endpoint: "",
  destination: "",
  days: 7,
};

const ACTIVITY: CondType[] = ["on_silence", "on_create", "on_count"];
const EXPIRY: CondType[] = ["on_expiring", "on_expire", "on_extend", "on_delete"];

const PRESETS: { label: string; patch: Partial<Form> }[] = [
  {
    label: "Keep my listing alive",
    patch: { mode: "public", watchKind: "query", entityType: "demo_feed", attrName: "kind", attrValue: "listing", cond: "on_expiring", leadMin: 2, deadline: "follow", action: "extend", extendMin: 4, maxExt: 2 },
  },
  {
    label: "Alert me when this canary expires",
    patch: { mode: "sealed", watchKind: "query", entityType: "demo_feed", attrName: "kind", attrValue: "canary", cond: "on_expire", deadline: "pinned", action: "telegram" },
  },
  {
    label: "Heartbeat goes quiet",
    patch: { mode: "public", watchKind: "query", entityType: "demo_feed", attrName: "kind", attrValue: "heartbeat", cond: "on_silence", silenceMin: 2, action: "notice" },
  },
  {
    label: "New event from a trusted creator",
    patch: { mode: "sealed", watchKind: "query", entityType: "demo_feed", attrName: "kind", attrValue: "event", cond: "on_create", action: "telegram" },
  },
];

const COND_OPTIONS: { group: string; items: { value: CondType; label: string }[] }[] = [
  {
    group: "Expiry",
    items: [
      { value: "on_expiring", label: "About to expire" },
      { value: "on_expire", label: "Expired" },
      { value: "on_extend", label: "Renewed" },
      { value: "on_delete", label: "Deleted" },
    ],
  },
  {
    group: "Activity",
    items: [
      { value: "on_silence", label: "Went quiet" },
      { value: "on_create", label: "New entity appears" },
      { value: "on_count", label: "Count above / below" },
    ],
  },
];

/** The raw spec this form describes; validated by core's zod schemas, never trusted as-is. */
function buildSpec(f: Form): unknown {
  const where: unknown[] = [
    ["eq", "project", { str: f.project.trim() }],
    ["eq", "entity_type", { str: f.entityType.trim() }],
  ];
  if (f.attrName.trim() && f.attrValue.trim()) where.push(["eq", f.attrName.trim(), { str: f.attrValue.trim() }]);
  const createdBy = f.createdBy.trim() || undefined;
  const query = { where, ...(createdBy ? { created_by: createdBy } : {}) };
  const watch = f.watchKind === "entity" ? { entity_key: f.entityKey.trim() } : query;

  let cond: Record<string, unknown>;
  switch (f.cond) {
    case "on_expiring":
      cond = { type: f.cond, watch, lead_blocks: minutesToBlocks(f.leadMin), deadline: f.deadline };
      break;
    case "on_expire":
      cond = { type: f.cond, watch, deadline: f.deadline };
      break;
    case "on_extend":
    case "on_delete":
      cond = { type: f.cond, watch };
      break;
    case "on_silence":
      cond = { type: f.cond, ...query, silence_blocks: minutesToBlocks(f.silenceMin) };
      break;
    case "on_create":
      cond = { type: f.cond, ...query };
      break;
    case "on_count":
      cond = { type: f.cond, ...query, count_op: f.countOp, count_value: f.countValue };
      break;
  }
  const action =
    f.action === "extend"
      ? { type: "extend", extend_blocks: minutesToBlocks(f.extendMin), max_extensions: f.maxExt }
      : { type: f.action };
  return { v: 1, cond, action };
}

function validate(f: Form): { spec?: TriggerSpec; errors: string[] } {
  const schema = f.mode === "sealed" ? SealedTriggerSpec : PublicTriggerSpec;
  const parsed = schema.safeParse(buildSpec(f));
  if (parsed.success) return { spec: parsed.data, errors: [] };
  return { errors: parsed.error.issues.map((i) => `${i.path.join(".") || "spec"}: ${i.message}`) };
}

// ---- page ------------------------------------------------------------------------------------

export default function CreatePage() {
  const w = useWallet();
  const [f, setF] = useState<Form>(DEFAULT);
  const [open, setOpen] = useState(1);
  const [salt, setSalt] = useState<Hex>();
  const workers = usePoll(() => loadWorkers(true), 30_000);
  const set = (patch: Partial<Form>) => setF((x) => normalise({ ...x, ...patch }));

  useEffect(() => setSalt(randomSalt()), []);
  // Silence requires a trusted creator, so default it to the connected wallet; drop that default
  // again if the user switches to a condition where the creator is optional.
  const autoCreator = useRef<string>(undefined);
  useEffect(() => {
    setF((x) => {
      if (x.cond === "on_silence" && !x.createdBy && w.address) {
        autoCreator.current = w.address;
        return { ...x, createdBy: w.address };
      }
      if (x.cond !== "on_silence" && autoCreator.current && x.createdBy === autoCreator.current) {
        autoCreator.current = undefined;
        return { ...x, createdBy: "" };
      }
      return x;
    });
  }, [f.cond, w.address]);
  // Default the worker to the first one that's online.
  useEffect(() => {
    const pick = workers.data?.find((x) => x.health.state === "online") ?? workers.data?.find((x) => x.health.state === "no-endpoint");
    if (pick) setF((x) => (x.worker ? x : { ...x, worker: pick.creator }));
  }, [workers.data]);

  const { spec, errors } = useMemo(() => validate(f), [f]);
  const worker = workers.data?.find((x) => x.creator.toLowerCase() === f.worker.toLowerCase());
  const commitment = spec && salt && f.mode === "sealed" ? commit(spec, salt) : undefined;
  const destOk = f.mode === "public" || (f.destination.trim().length > 0 && (f.action !== "webhook" || /^https?:\/\//.test(f.destination.trim())));
  const endpoint = worker?.endpoint || f.endpoint.trim();
  const workerOk = f.mode === "public" || (!!worker && /^https?:\/\/\S+$/.test(endpoint));
  const ready = Boolean(spec) && destOk && workerOk;

  return (
    <main className="page">
      <div aria-hidden="true" className="hairline" style={{ top: 250, transform: "rotate(-5deg)" }} />
      <div className="relative flex flex-wrap items-end justify-between gap-6">
        <div className="flex flex-col gap-3">
          <div className="eyebrow">Create trigger</div>
          <h1 className="display-lg m-0">{f.mode === "sealed" ? "New sealed trigger" : "New public trigger"}</h1>
        </div>
        <div className="flex flex-col items-start gap-2 sm:items-end">
          <Segmented
            label="Trigger mode"
            size="lg"
            value={f.mode}
            onChange={(mode) => set({ mode })}
            options={[
              { value: "public", label: "Public" },
              {
                value: "sealed",
                label: (
                  <>
                    <LockIcon size={14} weight={2.2} />
                    Sealed
                  </>
                ),
              },
            ]}
          />
          <span className="text-[13px] text-muted">
            {f.mode === "sealed" ? "Only a commitment hash goes on Arkiv." : "The whole spec is public, and so is every receipt."}
          </span>
        </div>
      </div>

      <div className="relative flex flex-wrap items-start gap-6">
        <div className="flex min-w-0 flex-[2_1_620px] flex-col gap-3">
          <StepCard n={1} title="What to watch" open={open === 1} onOpen={() => setOpen(1)} done={watchSummary(f)} ok={stepOk(f, 1)}>
            <WatchStep f={f} set={set} next={() => setOpen(2)} />
          </StepCard>
          <StepCard n={2} title="When to fire" open={open === 2} onOpen={() => setOpen(2)} done={condSummary(f)} ok={stepOk(f, 2)}>
            <WhenStep f={f} set={set} next={() => setOpen(3)} />
          </StepCard>
          <StepCard n={3} title="Action" open={open === 3} onOpen={() => setOpen(3)} done={actionSummary(f, worker)} ok={stepOk(f, 3) && destOk && workerOk}>
            <ActionStep f={f} set={set} workers={workers.data} next={() => setOpen(4)} />
          </StepCard>
          <ReviewStep f={f} spec={spec} errors={errors} commitment={commitment} worker={worker} open={open === 4} onOpen={() => setOpen(4)} />
        </div>
        <aside className="sticky top-6 flex min-w-0 flex-[1_1_320px] flex-col gap-4">
          <SignPanel
            f={f}
            spec={spec}
            salt={salt}
            worker={worker}
            endpoint={endpoint}
            ready={ready}
            blocker={!spec ? "Fix the spec errors first." : !workerOk ? "Pick a worker, and give its hand-off URL if it registered none." : !destOk ? "Enter where the alert should go." : undefined}
            onSealed={() => setSalt(randomSalt())}
            onReset={() => {
              setF((x) => ({ ...x, destination: "" }));
              setOpen(1);
            }}
          />
        </aside>
      </div>
    </main>
  );
}

/** Keep the form inside what the schema allows as the user toggles things. */
function normalise(f: Form): Form {
  const out = { ...f };
  if (ACTIVITY.includes(out.cond)) out.watchKind = "query";
  if (out.mode === "public" && (out.action === "telegram" || out.action === "webhook")) out.action = out.cond === "on_expiring" ? "extend" : "notice";
  if (out.mode === "sealed" && (out.action === "notice" || out.action === "extend")) out.action = "telegram";
  if (out.action === "extend" && out.cond !== "on_expiring") out.action = "notice";
  return out;
}

function stepOk(f: Form, step: 1 | 2 | 3): boolean {
  if (step === 1) {
    if (f.watchKind === "entity") return /^0x[0-9a-fA-F]{64}$/.test(f.entityKey.trim());
    return Boolean(f.project.trim() && f.entityType.trim()) && (!f.createdBy.trim() || /^0x[0-9a-fA-F]{40}$/.test(f.createdBy.trim()));
  }
  if (step === 2) return f.cond !== "on_silence" || /^0x[0-9a-fA-F]{40}$/.test(f.createdBy.trim());
  return true;
}

const watchSummary = (f: Form) =>
  f.watchKind === "entity" ? (
    <>
      Single entity <span className="font-mono text-sm">{short(f.entityKey) || "—"}</span>
    </>
  ) : (
    <>
      Query · {[f.entityType, f.attrValue].filter(Boolean).join(" · ")}
      <span className="text-muted"> · {f.createdBy ? `from ${short(f.createdBy)}` : "any creator"}</span>
    </>
  );

const condSummary = (f: Form) => {
  const label = COND_OPTIONS.flatMap((g) => g.items).find((i) => i.value === f.cond)?.label;
  return (
    <span className="flex flex-wrap items-center gap-2.5">
      {EXPIRY.includes(f.cond) ? "Expiry" : "Activity"} · {label}
      {f.cond === "on_expiring" && <span className="text-muted">· {f.leadMin} min before</span>}
      {f.cond === "on_silence" && <span className="text-muted">· {f.silenceMin} min</span>}
      {(f.cond === "on_expiring" || f.cond === "on_expire") && f.deadline === "pinned" && (
        <Badge tone="accent" className="h-[26px]! text-xs!">
          <PinIcon size={12} weight={2.4} />
          Pinned deadline
        </Badge>
      )}
    </span>
  );
};

const actionSummary = (f: Form, worker?: Worker) =>
  f.action === "extend" ? (
    <>
      Reactivate · +{f.extendMin} min, up to {f.maxExt}×
    </>
  ) : f.action === "notice" ? (
    <>Public notice · receipt only</>
  ) : (
    <>
      Alert · {f.action === "telegram" ? "Telegram" : "Webhook"} via <span className="font-mono text-sm">{worker?.name || short(f.worker) || "—"}</span>
      <span className="text-muted"> · {f.destination ? "destination entered" : "no destination yet"}</span>
    </>
  );

// ---- steps -----------------------------------------------------------------------------------

function StepCard({ n, title, open, onOpen, done, ok, children }: { n: number; title: string; open: boolean; onOpen(): void; done: ReactNode; ok: boolean; children: ReactNode }) {
  if (!open) {
    return (
      <div className="card flex flex-wrap items-center gap-[18px] px-6 py-5">
        <span className={`flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full ${ok ? "bg-success text-bg" : "border-2 border-warning text-warning"}`}>
          {ok ? <CheckIcon size={15} weight={3} /> : <span className="text-sm font-extrabold">!</span>}
        </span>
        <div className="flex min-w-0 flex-[1_1_280px] flex-col gap-1.5">
          <span className="label-caps text-[13px]!">
            {n} · {title}
          </span>
          <span className="text-base leading-[1.4] font-medium">{done}</span>
        </div>
        <button type="button" onClick={onOpen} className="cursor-pointer border-none bg-transparent text-sm font-semibold text-link">
          Edit
        </button>
      </div>
    );
  }
  return (
    <section aria-label={title} className="card flex animate-in-fast flex-col gap-6 border-line-strong! p-[clamp(20px,4vw,40px)]">
      <div className="flex items-center gap-[18px]">
        <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full bg-accent text-sm font-bold text-on-accent">{n}</span>
        <span className="label-caps text-[13px]! text-accent-text!">
          {n} · {title}
        </span>
      </div>
      {children}
    </section>
  );
}

const Continue = ({ onClick, disabled }: { onClick(): void; disabled?: boolean }) => (
  <button type="button" onClick={onClick} disabled={disabled} className="btn btn-primary w-max">
    Continue
  </button>
);

function Choice({ on, onClick, children, disabled, title }: { on: boolean; onClick(): void; children: ReactNode; disabled?: boolean; title?: string }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={`h-10 cursor-pointer rounded-lg border px-3.5 text-sm font-semibold whitespace-nowrap disabled:cursor-not-allowed disabled:opacity-40 ${
        on ? "border-accent bg-accent-soft text-accent-text" : "border-line bg-transparent text-muted hover:text-fg"
      }`}
    >
      {children}
    </button>
  );
}

function WatchStep({ f, set, next }: { f: Form; set(p: Partial<Form>): void; next(): void }) {
  const head = useHead().data;
  const key = f.entityKey.trim();
  const validKey = /^0x[0-9a-fA-F]{64}$/.test(key);
  const live = usePoll(() => (validKey ? loadWatched(key as Hex) : Promise.resolve(undefined)), 30_000, validKey ? key : null);
  const activity = ACTIVITY.includes(f.cond);
  const addrBad = !!f.createdBy.trim() && !/^0x[0-9a-fA-F]{40}$/.test(f.createdBy.trim());

  return (
    <>
      <div className="flex flex-col gap-2.5">
        <span className="text-sm font-medium text-muted">Start from a preset</span>
        <div className="flex flex-wrap gap-2">
          {PRESETS.map((p) => (
            <button key={p.label} type="button" onClick={() => set(p.patch)} className="btn btn-secondary btn-sm h-10! text-sm!">
              {p.label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Choice on={f.watchKind === "entity"} onClick={() => set({ watchKind: "entity" })} disabled={activity} title={activity ? "Activity conditions watch a query" : undefined}>
          A single entity
        </Choice>
        <Choice on={f.watchKind === "query"} onClick={() => set({ watchKind: "query" })}>
          A query
        </Choice>
      </div>
      {f.watchKind === "entity" ? (
        <div className="flex flex-col gap-3">
          <Field label="Entity key" help="Paste the key of the Arkiv entity to watch." error={key && !validKey ? "Must be 0x followed by 64 hex characters" : undefined}>
            <input className="input input-mono" value={f.entityKey} onChange={(e) => set({ entityKey: e.target.value })} placeholder="0x…" aria-invalid={!!key && !validKey} />
          </Field>
          {validKey && (
            <div className="flex flex-col gap-2 rounded-xl border border-line bg-sunken p-4">
              {live.loading ? (
                <span className="text-sm text-muted">Looking it up…</span>
              ) : live.data ? (
                <>
                  <div className="flex flex-wrap justify-between gap-2 text-sm">
                    <span className="font-semibold">{live.data.label}</span>
                    <span className={live.data.extendable ? "text-success" : "text-warning"}>{live.data.extendable ? "renewable by anyone" : "only its owner can renew it"}</span>
                  </div>
                  <ExpiryBar view={expiryView(live.data.createdAt, live.data.expiresAt, head)} showBlock to={live.data.expiresAt} />
                </>
              ) : (
                <span className="text-sm text-warning">No live entity with this key (expired, deleted or never existed).</span>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,200px),1fr))] gap-4">
          <Field label="Project">
            <input className="input" value={f.project} onChange={(e) => set({ project: e.target.value })} />
          </Field>
          <Field label="Entity type">
            <input className="input" value={f.entityType} onChange={(e) => set({ entityType: e.target.value })} />
          </Field>
          <Field label="Attribute (optional)" help="Lowercase snake_case.">
            <input className="input input-mono" value={f.attrName} onChange={(e) => set({ attrName: e.target.value })} placeholder="kind" />
          </Field>
          <Field label="Equals">
            <input className="input" value={f.attrValue} onChange={(e) => set({ attrValue: e.target.value })} placeholder="listing" />
          </Field>
        </div>
      )}
      {f.watchKind === "query" && (
        <Field
          label={f.cond === "on_silence" ? "Only from this creator (required)" : "Only from this creator (optional)"}
          help="Trust on Arkiv is the creator address. Without it, anyone can write matching entities."
          error={addrBad ? "Must be a 0x address (40 hex characters)" : f.cond === "on_silence" && !f.createdBy.trim() ? "Silence needs a trusted creator" : undefined}
        >
          <input className="input input-mono" value={f.createdBy} onChange={(e) => set({ createdBy: e.target.value })} placeholder="0x" aria-invalid={addrBad} />
        </Field>
      )}
      <Continue onClick={next} disabled={!stepOk(f, 1)} />
    </>
  );
}

function WhenStep({ f, set, next }: { f: Form; set(p: Partial<Form>): void; next(): void }) {
  return (
    <>
      {COND_OPTIONS.map((g) => (
        <div key={g.group} className="flex flex-col gap-2.5">
          <span className="text-sm font-medium text-muted">{g.group}</span>
          <div className="flex flex-wrap gap-2">
            {g.items.map((i) => (
              <Choice key={i.value} on={f.cond === i.value} onClick={() => set({ cond: i.value })}>
                {i.label}
              </Choice>
            ))}
          </div>
        </div>
      ))}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,200px),1fr))] gap-4">
        {f.cond === "on_expiring" && (
          <Field label="Minutes before expiry" help={`= ${minutesToBlocks(f.leadMin)} blocks (~2 s each)`}>
            <input type="number" min={1} className="input num" value={f.leadMin} onChange={(e) => set({ leadMin: Math.max(1, Number(e.target.value) || 1) })} />
          </Field>
        )}
        {f.cond === "on_silence" && (
          <Field label="Quiet for (minutes)" help={`= ${minutesToBlocks(f.silenceMin)} blocks`}>
            <input type="number" min={1} className="input num" value={f.silenceMin} onChange={(e) => set({ silenceMin: Math.max(1, Number(e.target.value) || 1) })} />
          </Field>
        )}
        {f.cond === "on_count" && (
          <>
            <Field label="Count is">
              <select className="input" value={f.countOp} onChange={(e) => set({ countOp: e.target.value as ComparisonOp })}>
                <option value="gt">above (&gt;)</option>
                <option value="gte">at least (≥)</option>
                <option value="lt">below (&lt;)</option>
                <option value="lte">at most (≤)</option>
                <option value="eq">exactly (=)</option>
              </select>
            </Field>
            <Field label="Value">
              <input type="number" min={0} className="input num" value={f.countValue} onChange={(e) => set({ countValue: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} />
            </Field>
          </>
        )}
      </div>
      {(f.cond === "on_expiring" || f.cond === "on_expire") && (
        <div className="flex flex-col gap-2.5">
          <span className="text-sm font-medium text-muted">Deadline mode</span>
          <div className="flex flex-wrap gap-2">
            <Choice on={f.deadline === "follow"} onClick={() => set({ deadline: "follow" })}>
              Follow renewals
            </Choice>
            <Choice on={f.deadline === "pinned"} onClick={() => set({ deadline: "pinned" })}>
              <span className="flex items-center gap-1.5">
                <PinIcon size={13} /> Pinned
              </span>
            </Choice>
          </div>
          <span className="text-[13px] text-subtle">
            {f.deadline === "pinned" ? "Pinned ignores later extensions, so no one can delay it." : "If someone renews the entity, the deadline moves with it."}
          </span>
        </div>
      )}
      <Continue onClick={next} disabled={!stepOk(f, 2)} />
    </>
  );
}

function ActionStep({ f, set, workers, next }: { f: Form; set(p: Partial<Form>): void; workers?: Worker[]; next(): void }) {
  return (
    <>
      <div className="flex flex-wrap gap-2">
        {f.mode === "public" ? (
          <>
            <Choice on={f.action === "extend"} onClick={() => set({ action: "extend" })} disabled={f.cond !== "on_expiring"} title={f.cond !== "on_expiring" ? "Reactivate works with “About to expire”" : undefined}>
              ↻ Reactivate
            </Choice>
            <Choice on={f.action === "notice"} onClick={() => set({ action: "notice" })}>
              Public notice
            </Choice>
          </>
        ) : (
          <>
            <Choice on={f.action === "telegram"} onClick={() => set({ action: "telegram" })}>
              ⚑ Telegram alert
            </Choice>
            <Choice on={f.action === "webhook"} onClick={() => set({ action: "webhook" })}>
              ⚑ Webhook
            </Choice>
          </>
        )}
      </div>
      {f.mode === "public" && f.cond !== "on_expiring" && <span className="text-[13px] text-subtle">Reactivate only applies before expiry, so it pairs with “About to expire”.</span>}
      {f.mode === "public" && <span className="text-[13px] text-subtle">Private alerts (Telegram, webhook) are sealed-only, so their destination never touches a public spec.</span>}

      {f.action === "extend" && (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,200px),1fr))] gap-4">
          <Field label="Renew by (minutes)" help={`= ${minutesToBlocks(f.extendMin)} blocks`}>
            <input type="number" min={1} className="input num" value={f.extendMin} onChange={(e) => set({ extendMin: Math.max(1, Number(e.target.value) || 1) })} />
          </Field>
          <Field label="Up to (times)" help="Cap: 100">
            <input type="number" min={1} max={100} className="input num" value={f.maxExt} onChange={(e) => set({ maxExt: Math.min(100, Math.max(1, Math.floor(Number(e.target.value) || 1))) })} />
          </Field>
        </div>
      )}
      {f.action === "extend" && <span className="text-[13px] text-subtle">Workers can only renew entities created with “renewable by anyone”; otherwise they post a receipt saying so.</span>}

      {f.mode === "sealed" && (
        <>
          <div className="flex flex-col gap-2.5">
            <span className="text-sm font-medium text-fg">Worker</span>
            {!workers ? (
              <span className="text-sm text-muted">Reading live workers…</span>
            ) : workers.length === 0 ? (
              <span className="text-sm text-warning">No worker is registered on Arkiv right now.</span>
            ) : (
              <div className="flex flex-col gap-2">
                {workers.map((wk) => {
                  const on = wk.creator.toLowerCase() === f.worker.toLowerCase();
                  // Offline workers can't accept a hand-off; endpoint-less ones can, given a URL below.
                  const usable = wk.health.state !== "offline";
                  return (
                    <button
                      key={wk.creator}
                      type="button"
                      aria-pressed={on}
                      disabled={!usable}
                      onClick={() => set({ worker: wk.creator })}
                      className={`flex cursor-pointer items-center justify-between gap-3 rounded-xl border px-4 py-3 text-left disabled:cursor-not-allowed disabled:opacity-50 ${
                        on ? "border-accent bg-accent-soft" : "border-line bg-sunken hover:border-line-strong"
                      }`}
                    >
                      <span className="flex flex-col gap-1">
                        <span className="font-mono text-[15px] font-medium text-fg">{wk.name || short(wk.creator)}</span>
                        <span className="font-mono text-xs text-subtle">{short(wk.creator)}</span>
                      </span>
                      {wk.health.state === "online" ? (
                        <Badge tone="success">● Online</Badge>
                      ) : wk.health.state === "offline" ? (
                        <Badge tone="danger">○ Offline</Badge>
                      ) : (
                        <Badge tone="neutral">No endpoint</Badge>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          {(() => {
            const sel = workers?.find((x) => x.creator.toLowerCase() === f.worker.toLowerCase());
            if (!sel || sel.endpoint) return null;
            const bad = !!f.endpoint.trim() && !/^https?:\/\/\S+$/.test(f.endpoint.trim());
            return (
              <Field
                label="Worker hand-off URL"
                help={`${sel.name || "This worker"} registered no public endpoint. If you run it yourself, enter its URL (e.g. http://localhost:8787).`}
                error={bad ? "Must be an http(s) URL" : undefined}
              >
                <input className="input input-mono" value={f.endpoint} onChange={(e) => set({ endpoint: e.target.value })} placeholder="http://localhost:8787" aria-invalid={bad} />
              </Field>
            );
          })()}
          <Field
            label={f.action === "telegram" ? "Telegram chat ID" : "Webhook URL"}
            error={f.action === "webhook" && f.destination.trim() && !/^https?:\/\//.test(f.destination.trim()) ? "Must start with http:// or https://" : undefined}
            help={
              <span className="flex items-start gap-2 font-semibold text-sealed">
                <LockIcon size={14} className="mt-0.5 shrink-0" />
                This is sent only to the worker you choose. It never goes on-chain, and this site doesn&apos;t store it.
              </span>
            }
          >
            <input
              className="input input-mono"
              value={f.destination}
              onChange={(e) => set({ destination: e.target.value })}
              placeholder={f.action === "telegram" ? "e.g. 123456789" : "https://example.com/hook"}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
        </>
      )}
      <Field label="Trigger lifetime (days)" help={f.mode === "sealed" ? "How long the sealed job runs." : "The trigger entity is renewable by anyone, so subscribers can keep it alive."}>
        <input type="number" min={1} max={30} className="input num w-32!" value={f.days} onChange={(e) => set({ days: Math.min(30, Math.max(1, Math.floor(Number(e.target.value) || 1))) })} />
      </Field>
      <Continue onClick={next} />
    </>
  );
}

function ReviewStep({
  f,
  spec,
  errors,
  commitment,
  worker,
  open,
  onOpen,
}: {
  f: Form;
  spec?: TriggerSpec;
  errors: string[];
  commitment?: Hex;
  worker?: Worker;
  open: boolean;
  onOpen(): void;
}) {
  const [cli, setCli] = useState(false);
  const json = spec ? JSON.stringify(spec, null, 2) : "";
  const workerName = worker?.name || "<worker-name>";
  const command =
    f.mode === "sealed"
      ? `cat > trigger.json <<'EOF'\n${json}\nEOF\npnpm cli seal --spec trigger.json --worker ${workerName} --${f.action === "webhook" ? "webhook <url>" : "telegram <chat-id>"} --days ${f.days}`
      : `cat > trigger.json <<'EOF'\n${json}\nEOF\npnpm cli create trigger.json --days ${f.days}`;

  if (!open) {
    return (
      <div className="card flex flex-wrap items-center gap-[18px] px-6 py-5">
        <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full border-2 border-line-strong text-sm font-bold text-muted">4</span>
        <span className="label-caps flex-1 text-[13px]!">4 · Review &amp; sign</span>
        <button type="button" onClick={onOpen} className="btn btn-primary btn-sm">
          Review
        </button>
      </div>
    );
  }
  return (
    <section aria-label="Review and sign" className="card flex animate-in-fast flex-col gap-7 border-line-strong! p-[clamp(20px,4vw,40px)]">
      <div className="flex items-center gap-[18px]">
        <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full bg-accent text-sm font-bold text-on-accent">4</span>
        <span className="label-caps text-[13px]! text-accent-text!">4 · Review &amp; sign</span>
      </div>
      {spec ? (
        <p className="m-0 max-w-[760px] font-serif text-[clamp(26px,3vw,36px)] leading-[1.2] tracking-[-0.01em] text-pretty">
          {describeSpec(spec)}
          {f.mode === "sealed" && (
            <span className="text-accent-text">
              {" "}
              {worker?.name || "The worker"} {f.action === "telegram" ? "messages you on Telegram" : "calls your webhook"}.
            </span>
          )}
        </p>
      ) : (
        <div role="alert" className="flex flex-col gap-2 rounded-xl border border-danger bg-danger-soft p-4">
          <span className="text-sm font-semibold text-danger">This spec isn&apos;t valid yet</span>
          {errors.map((e) => (
            <span key={e} className="font-mono text-[13px] text-danger">
              {e}
            </span>
          ))}
        </div>
      )}

      {f.mode === "sealed" && commitment && (
        <div className="relative flex flex-col gap-4 overflow-hidden rounded-3xl bg-sealed-soft p-[clamp(20px,4vw,32px)] shadow-glow">
          <div aria-hidden="true" className="arc opacity-50" style={{ right: -120, top: -160, width: 360, height: 360 }} />
          <div className="relative flex flex-wrap items-center justify-between gap-3">
            <span className="flex items-center gap-2.5 text-sm font-bold tracking-[0.08em] text-sealed uppercase">
              <LockIcon size={18} weight={2.2} />
              Only this hash goes public
            </span>
            <CopyButton text={commitment} />
          </div>
          <div className="relative font-mono text-[clamp(16px,2vw,22px)] leading-normal font-medium break-all">{commitment}</div>
          <div className="relative flex flex-wrap gap-x-6 gap-y-2 text-sm leading-normal text-muted">
            <span className="font-mono">keccak256(spec ‖ salt)</span>
            <span>The spec, target and alert destination never leave your browser except to {worker?.name || "the worker"}.</span>
          </div>
        </div>
      )}

      {spec && <JsonBlock title="Spec JSON" note={f.mode === "sealed" ? "private · hashed locally" : "public · posted as the payload"} json={json} defaultOpen />}

      <div className="flex flex-col gap-3">
        <button
          type="button"
          onClick={() => setCli((c) => !c)}
          className="flex min-h-11 w-max cursor-pointer items-center gap-2 border-none bg-transparent p-0 text-sm font-semibold text-link underline underline-offset-[3px]"
        >
          <TerminalIcon size={15} />
          Prefer the terminal? {cli ? "Hide" : "Show"} the CLI command
        </button>
        {cli && spec && (
          <div className="relative animate-in-fast rounded-xl border border-line bg-sunken py-4 pr-[110px] pl-5">
            <CopyButton text={command} className="absolute top-2.5 right-2.5" />
            <pre className="m-0 font-mono text-[13px] leading-[1.7] break-all whitespace-pre-wrap">{command}</pre>
          </div>
        )}
      </div>
    </section>
  );
}

// ---- signing ---------------------------------------------------------------------------------

type Phase = "idle" | "connect" | "network" | "sign" | "submit" | "confirmed" | "handoff-sign" | "handoff" | "accepted" | "done";
type FailKind = "rejected" | "funds" | "network" | "worker" | "other";

interface Result {
  entityKey: Hex;
  txHash: Hex;
  acceptanceKey?: Hex;
}

function SignPanel({
  f,
  spec,
  salt,
  worker,
  endpoint,
  ready,
  blocker,
  onSealed,
  onReset,
}: {
  f: Form;
  spec?: TriggerSpec;
  salt?: Hex;
  worker?: Worker;
  endpoint: string;
  ready: boolean;
  blocker?: string;
  onSealed(): void;
  onReset(): void;
}) {
  const w = useWallet();
  const [phase, setPhaseState] = useState<Phase>("idle");
  const [fail, setFail] = useState<{ at: Phase; kind: FailKind; message: string }>();
  const [tx, setTx] = useState<Hex>();
  const [result, setResult] = useState<Result>();
  const [file, setFile] = useState<SealedFile>();
  const phaseRef = useRef<Phase>("idle");
  const setPhase = (p: Phase) => {
    phaseRef.current = p;
    setPhaseState(p);
  };
  const sealed = f.mode === "sealed";
  const busy = !["idle", "done", "accepted"].includes(phase) && !fail;

  const failWith = (e: unknown) => {
    const kind: FailKind = e instanceof HandoffError ? "worker" : walletErrorKind(e);
    setFail({ at: phaseRef.current, kind, message: shortError(e) });
  };

  const handoff = async (sf: SealedFile, address: Hex) => {
    setPhase("handoff-sign");
    const r = await sendHandoff(sf, { type: f.action as "telegram" | "webhook", value: f.destination.trim() }, walletClientFor(address), () => setPhase("handoff"));
    setResult((x) => (x ? { ...x, acceptanceKey: r.acceptance_key } : x));
    setPhase("accepted");
  };

  const start = async () => {
    if (!spec || !ready) return;
    setFail(undefined);
    setTx(undefined);
    try {
      const address = await w.ensureReady((s) => setPhase(s));
      if ((await getReader().getBalance({ address })) === 0n) throw new Error("insufficient funds: this address has 0 GLM on Tiramisu");
      setPhase("sign");
      const wallet = walletClientFor(address, (h) => {
        setTx(h);
        setPhase("submit");
      });
      if (!sealed) {
        const r = await wallet.createEntity({
          payload: jsonToPayload(spec),
          contentType: "application/json",
          attributes: triggerAttributes(spec),
          expires: ExpirationTime.fromDays(f.days),
          // Anyone (e.g. a subscriber) may keep a useful public trigger alive.
          flags: { permissionlessExtension: true },
        });
        // Brand new: its detail page reads it from Arkiv, not the (up to 20 s old) snapshot.
      markChanged(r.entityKey);
      setResult({ entityKey: r.entityKey, txHash: r.txHash });
        setPhase("done");
        return;
      }
      if (!worker || !endpoint || !salt) throw new Error("pick a worker and its hand-off URL first");
      // Commit to the normalised spec (zod defaults filled in): that exact JSON is sent and revealed.
      const commitment = commit(spec, salt);
      const r = await wallet.createEntity({
        payload: new Uint8Array(),
        contentType: "application/octet-stream",
        attributes: sealedAttributes(commitment, worker.creator),
        expires: ExpirationTime.fromDays(f.days),
        flags: { readonly: true },
      });
      const sf: SealedFile = {
        sealed_key: r.entityKey,
        spec,
        salt,
        commitment,
        worker: worker.creator,
        endpoint,
        created_at: new Date().toISOString(),
      };
      // The salt exists nowhere else: keep it before anything else can fail.
      saveSealed(sf);
      setFile(sf);
      // Brand new: its detail page reads it from Arkiv, not the (up to 20 s old) snapshot.
      markChanged(r.entityKey);
      setResult({ entityKey: r.entityKey, txHash: r.txHash });
      onSealed();
      setPhase("confirmed");
      await handoff(sf, address);
    } catch (e) {
      failWith(e);
    }
  };

  const retryHandoff = async () => {
    if (!file) return;
    setFail(undefined);
    try {
      const address = await w.ensureReady();
      await handoff(file, address);
    } catch (e) {
      failWith(e);
    }
  };

  const reset = () => {
    setPhase("idle");
    setFail(undefined);
    setTx(undefined);
    setResult(undefined);
    setFile(undefined);
    onReset();
  };

  const order: Phase[] = sealed
    ? ["connect", "network", "sign", "submit", "confirmed", "handoff-sign", "handoff", "accepted"]
    : ["connect", "network", "sign", "submit", "done"];
  const finished = phase === "done" || phase === "accepted";
  const pos = finished ? order.length : phase === "idle" ? -1 : order.indexOf(phase);
  const workerName = worker?.name || "worker";
  const detail: Record<string, ReactNode> = {
    connect: w.address ? short(w.address) : "Approve the connection in your wallet",
    network: "Arkiv Tiramisu · chain 7738577",
    sign: "Approve the transaction in your wallet…",
    submit: tx ? (
      <a href={explorerTx(tx)} target="_blank" rel="noreferrer">
        tx {short(tx)} ↗
      </a>
    ) : (
      "Waiting for inclusion…"
    ),
    confirmed: result ? `entity ${short(result.entityKey)}` : "",
    done: result ? `trigger ${short(result.entityKey)}` : "",
    "handoff-sign": "Sign the hand-off message (free, no gas)",
    handoff: `spec + destination → ${hostOf(endpoint) ?? workerName}`,
    accepted: result?.acceptanceKey ? `acceptance ${short(result.acceptanceKey)}` : "",
  };
  const labels: Record<Phase, string> = {
    idle: "",
    connect: "Connect wallet",
    network: "Network: Tiramisu",
    sign: sealed ? "Sign commitment" : "Sign in your wallet",
    submit: "Submit to Arkiv",
    confirmed: "Confirmed · salt saved",
    done: "Confirmed",
    "handoff-sign": "Sign hand-off",
    handoff: `Handing off to ${workerName}…`,
    accepted: phase === "accepted" ? `${workerName} accepted ✓` : "Worker accepted",
  };
  const items: StepItem[] = order.map((p, i) => {
    let state: StepState = i < pos ? "done" : i === pos ? "current" : "todo";
    if (fail && i === order.indexOf(fail.at)) state = fail.kind === "network" || fail.at === "network" ? "warn" : "fail";
    if (fail && i > order.indexOf(fail.at)) state = "todo";
    if (state === "done" && p === "connect" && !w.address) state = "todo";
    return { label: labels[p], state, detail: fail && i === order.indexOf(fail.at) ? failText(fail.kind, fail.message, workerName) : detail[p] };
  });

  return (
    <div className="card flex flex-col gap-5 p-7">
      <div className="flex items-center justify-between gap-3">
        <span className="title">{sealed ? "Sign & seal" : "Sign & publish"}</span>
        <span className="font-mono text-xs text-subtle">Tiramisu</span>
      </div>
      <Steps items={items} />

      {fail?.at === "network" || fail?.kind === "network" ? (
        <Alert tone="warning" title="Your wallet isn't on Arkiv Tiramisu.">
          <button type="button" onClick={start} className="btn h-11 bg-warning text-bg">
            Add Tiramisu
          </button>
        </Alert>
      ) : fail?.kind === "rejected" ? (
        <Alert tone="danger" title={fail.at.startsWith("handoff") ? "Hand-off signature rejected. Your commitment is on-chain; you can retry." : "Signature rejected in your wallet. Nothing was sent."}>
          <button type="button" onClick={fail.at.startsWith("handoff") ? retryHandoff : start} className="btn btn-secondary h-11">
            Try again
          </button>
        </Alert>
      ) : fail?.kind === "funds" ? (
        <Alert tone="danger" title="Insufficient GLM for the Arkiv write. Fund this address with testnet GLM.">
          <a href="https://hub.arkiv.network/faucet" target="_blank" rel="noreferrer" className="flex min-h-11 items-center text-sm font-semibold">
            Get testnet GLM from the faucet ›
          </a>
        </Alert>
      ) : fail?.kind === "worker" ? (
        <Alert tone="danger" title={`${workerName} didn't accept. Your commitment is on-chain, but no worker holds the spec yet.`}>
          <span className="font-mono text-xs text-danger">{fail.message}</span>
          <button type="button" onClick={retryHandoff} className="btn btn-secondary h-11">
            Retry hand-off
          </button>
          {result && (
            <Link href={`/triggers/${result.entityKey}`} className="text-sm font-semibold">
              Or retry later from the trigger page ›
            </Link>
          )}
        </Alert>
      ) : fail ? (
        <Alert tone="danger" title="Something went wrong.">
          <span className="font-mono text-xs break-all text-danger">{fail.message}</span>
          <button type="button" onClick={fail.at.startsWith("handoff") && file ? retryHandoff : start} className="btn btn-secondary h-11">
            Try again
          </button>
        </Alert>
      ) : null}

      {file && (
        <div className="flex flex-col gap-2.5 rounded-xl border border-sealed bg-sealed-soft p-4">
          <span className="text-sm font-semibold text-sealed">⚠ This browser holds the only copy of your salt.</span>
          <span className="text-[13px] text-muted">Without it you can&apos;t reveal, so you can&apos;t prove censorship. Download a backup (it works with <code className="font-mono">arkivate reveal --file</code>).</span>
          <button type="button" onClick={() => downloadSealed(file)} className="btn btn-secondary btn-sm w-max">
            <DownloadIcon size={14} /> Download backup
          </button>
        </div>
      )}

      {phase === "idle" && !fail && (
        <>
          <button type="button" onClick={start} disabled={!ready || busy} className="btn btn-primary h-[52px]">
            {sealed && <LockIcon size={17} weight={2.2} />}
            {sealed ? "Sign & seal" : "Sign & publish"}
          </button>
          {!ready && blocker && <span className="text-[13px] text-warning">{blocker}</span>}
        </>
      )}
      {finished && result && (
        <div className="flex animate-in flex-col gap-2.5">
          <Link href={`/triggers/${result.entityKey}`} className="btn btn-primary h-[52px]">
            View trigger ›
          </Link>
          <a href={explorerTx(result.txHash)} target="_blank" rel="noreferrer" className="text-center font-mono text-xs">
            tx {short(result.txHash)} ↗
          </a>
          <button type="button" onClick={reset} className="btn h-11 bg-transparent text-sm text-muted hover:text-fg">
            Create another
          </button>
        </div>
      )}
      <span className="text-[13px] leading-normal text-subtle">Signed in your own wallet. Arkivate never holds keys.</span>
      {w.address && <span className="font-mono text-xs text-subtle">Signer {short(w.address)}</span>}
    </div>
  );
}

function hostOf(url: string | undefined): string | undefined {
  try {
    return url ? new URL(url).host : undefined;
  } catch {
    return undefined;
  }
}

function failText(kind: FailKind, message: string, worker: string): string {
  if (kind === "rejected") return "Rejected in wallet";
  if (kind === "funds") return "Insufficient GLM";
  if (kind === "network") return "Wrong network: add Tiramisu";
  if (kind === "worker") return `${worker} unreachable or refused`;
  return message;
}

function Alert({ tone, title, children }: { tone: "warning" | "danger"; title: string; children: ReactNode }) {
  return (
    <div role="alert" className={`flex flex-col gap-3 rounded-xl border p-4 ${tone === "warning" ? "border-warning bg-warning-soft" : "border-danger bg-danger-soft"}`}>
      <span className={`text-sm leading-[1.4] font-semibold ${tone === "warning" ? "text-warning" : "text-danger"}`}>{title}</span>
      {children}
    </div>
  );
}
