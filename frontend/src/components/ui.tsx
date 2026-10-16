"use client";

import { EXPLORER_URL } from "@arkivate/core";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { blocksToSeconds, errMessage, fmtBlock, fmtDuration, isRateLimited, short } from "@/lib/format";
import { ChevronDown, CopyIcon, ExternalIcon, RefreshIcon, WarningIcon } from "./icons";

// ---- copy ------------------------------------------------------------------------------------

export function useCopy(ms = 1400) {
  const [copied, setCopied] = useState(false);
  const t = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(t.current), []);
  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).catch(() => {});
    setCopied(true);
    clearTimeout(t.current);
    t.current = setTimeout(() => setCopied(false), ms);
  };
  return { copied, copy };
}

export function CopyButton({ text, label = "Copy", className = "" }: { text: string; label?: string; className?: string }) {
  const { copied, copy } = useCopy();
  return (
    <button type="button" onClick={() => copy(text)} className={`btn btn-secondary btn-sm ${className}`}>
      <CopyIcon size={13} />
      {copied ? "Copied ✓" : label}
    </button>
  );
}

// ---- hashes and addresses --------------------------------------------------------------------

export const explorerAddress = (a: string) => `${EXPLORER_URL}/address/${a}`;
export const explorerTx = (h: string) => `${EXPLORER_URL}/tx/${h}`;

/** Middle-truncated hash with copy (full value via title + clipboard) and optional explorer link. */
export function HashChip({ value, href, label, head = 6, tail = 4 }: { value: string; href?: string; label?: string; head?: number; tail?: number }) {
  const { copied, copy } = useCopy();
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-lg border border-line bg-sunken py-1 pr-1 pl-3">
      <span title={value} className="mr-1.5 truncate font-mono text-sm text-fg">
        {short(value, head, tail)}
      </span>
      <button
        type="button"
        onClick={() => copy(value)}
        aria-label={`Copy full ${label ?? "value"}`}
        title={copied ? "Copied" : "Copy"}
        className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-md border-none bg-transparent text-muted hover:bg-raised hover:text-fg"
      >
        {copied ? <span className="text-success">✓</span> : <CopyIcon size={15} />}
      </button>
      {href && (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          aria-label="Open in explorer"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted hover:bg-raised hover:text-fg"
        >
          <ExternalIcon size={15} />
        </a>
      )}
    </span>
  );
}

/** Small inline mono key, copyable on click. */
export function Mono({ value, head = 6, tail = 4, className = "" }: { value: string; head?: number; tail?: number; className?: string }) {
  const { copied, copy } = useCopy();
  return (
    <button
      type="button"
      title={copied ? "Copied" : `${value} (click to copy)`}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        copy(value);
      }}
      className={`cursor-copy border-none bg-transparent p-0 font-mono text-inherit ${className}`}
    >
      {copied ? "copied ✓" : short(value, head, tail)}
    </button>
  );
}

// ---- status ----------------------------------------------------------------------------------

export type Tone = "success" | "danger" | "warning" | "info" | "sealed" | "neutral" | "accent" | "warm";

const TONE: Record<Tone, string> = {
  success: "bg-success-soft text-success",
  danger: "bg-danger-soft text-danger",
  warning: "bg-warning-soft text-warning",
  info: "bg-info-soft text-info",
  sealed: "bg-sealed-soft text-sealed",
  neutral: "bg-sunken text-muted",
  accent: "bg-accent-soft text-accent-text",
  warm: "bg-warm-soft text-warm",
};

/** Status always travels with an icon and a label, never colour alone. */
export function Badge({ tone, children, square = false, className = "" }: { tone: Tone; children: ReactNode; square?: boolean; className?: string }) {
  return (
    <span
      className={`inline-flex h-7 w-max items-center gap-1.5 px-3 text-[13px] leading-none font-semibold whitespace-nowrap ${square ? "rounded-lg" : "rounded-full"} ${TONE[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

export const Dot = ({ className = "" }: { className?: string }) => <span className={`inline-block h-[7px] w-[7px] shrink-0 rounded-full bg-current ${className}`} />;

export const LiveDot = () => <span className="inline-block h-2 w-2 shrink-0 animate-pulse-live rounded-full bg-success" />;

export const Spinner = ({ size = 16, className = "" }: { size?: number; className?: string }) => (
  <span
    className={`inline-block shrink-0 animate-spin-ark rounded-full border-2 border-current border-r-transparent ${className}`}
    style={{ width: size, height: size }}
    aria-hidden="true"
  />
);

// ---- expiry ----------------------------------------------------------------------------------

export interface ExpiryView {
  left: bigint;
  pct: number;
  text: string;
  expired: boolean;
  warn: boolean;
}

/** Remaining life of an entity created at `from`, expiring at `to`, seen from `head`. */
export function expiryView(from: bigint, to: bigint, head: bigint | undefined): ExpiryView | undefined {
  if (head === undefined) return undefined;
  const total = to > from ? to - from : 1n;
  const left = to > head ? to - head : 0n;
  const pct = Math.max(0, Math.min(100, (Number(left) / Number(total)) * 100));
  return { left, pct, expired: left === 0n, warn: left > 0n && pct < 10, text: left === 0n ? "Expired" : fmtDuration(blocksToSeconds(left)) };
}

export function ExpiryBar({ view, height = 4, showBlock, to }: { view: ExpiryView | undefined; height?: number; showBlock?: boolean; to?: bigint }) {
  if (!view) return <div className="rounded-full bg-line" style={{ height }} />;
  const color = view.expired ? "var(--danger)" : view.warn ? "var(--warning)" : "var(--accent)";
  return (
    <div className="flex flex-col gap-1.5">
      {showBlock && (
        <div className={`num flex justify-between text-[13px] ${view.warn ? "text-warning" : view.expired ? "text-subtle" : ""}`}>
          <span>{view.warn ? `⚠ ${view.text}` : view.text}</span>
          <span className="text-subtle">{fmtBlock(to)}</span>
        </div>
      )}
      <div className="overflow-hidden rounded-full bg-line" style={{ height }}>
        <div
          className="h-full rounded-full transition-[width,background] duration-700 ease-ark"
          style={{ width: `${view.pct.toFixed(1)}%`, background: color }}
        />
      </div>
    </div>
  );
}

// ---- JSON ------------------------------------------------------------------------------------

export function JsonBlock({ title, note, json, defaultOpen = false }: { title: string; note?: string; json: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="overflow-hidden rounded-2xl border border-line bg-sunken">
      <div className="flex items-center justify-between gap-3 border-b border-line py-2.5 pr-2.5 pl-5">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex h-9 cursor-pointer items-center gap-2 border-none bg-transparent p-0 text-[15px] font-semibold text-fg"
        >
          <span className="flex transition-transform duration-[250ms] ease-ark" style={{ transform: open ? "none" : "rotate(-90deg)" }}>
            <ChevronDown size={15} />
          </span>
          {title}
          {note && <span className="font-mono text-xs font-normal text-subtle">{note}</span>}
        </button>
        <CopyButton text={json} />
      </div>
      {open && <pre className="m-0 px-5 py-4 font-mono text-[13px] leading-[1.75] break-all whitespace-pre-wrap text-muted">{json}</pre>}
    </section>
  );
}

// ---- page states -----------------------------------------------------------------------------

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const limited = isRateLimited(error);
  return (
    <div role="alert" className="flex flex-col gap-3 rounded-2xl border border-warning bg-warning-soft p-6">
      <span className="flex items-center gap-2 text-[15px] font-semibold text-warning">
        <WarningIcon size={16} />
        {limited ? "Read quota exhausted" : "Couldn't read from Arkiv"}
      </span>
      <p className="m-0 text-sm text-muted">
        {limited
          ? "The Arkiv RPC is rate-limiting reads right now. The page keeps retrying on its own."
          : errMessage(error).split("\n")[0]}
      </p>
      {onRetry && (
        <button type="button" onClick={onRetry} className="btn btn-secondary btn-sm w-max">
          <RefreshIcon size={14} /> Retry now
        </button>
      )}
    </div>
  );
}

export function Loading({ label = "Reading from Arkiv…" }: { label?: string }) {
  return (
    <div className="flex items-center gap-3 p-6 text-sm text-muted">
      <Spinner size={16} className="text-accent" />
      {label}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2.5 px-6 py-16 text-center">
      <span className="heading">{title}</span>
      {children && <div className="max-w-[520px] text-sm text-muted">{children}</div>}
    </div>
  );
}

// ---- steps -----------------------------------------------------------------------------------

export type StepState = "done" | "current" | "fail" | "warn" | "todo";

export interface StepItem {
  label: string;
  detail?: ReactNode;
  state: StepState;
}

/** Vertical transaction stepper (Create, Pause, Reveal). */
export function Steps({ items }: { items: StepItem[] }) {
  return (
    <ol className="m-0 flex list-none flex-col p-0">
      {items.map((s, i) => (
        <li key={s.label} className="flex gap-3.5">
          <div className="flex flex-col items-center">
            <StepDot state={s.state} />
            {i < items.length - 1 && (
              <span className="my-1 min-h-3.5 w-0.5 flex-1" style={{ background: s.state === "done" ? "var(--success)" : "var(--border)" }} />
            )}
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1 pt-0.5 pb-4">
            <span className={`text-[15px] leading-[1.35] font-semibold ${s.state === "todo" ? "text-muted" : "text-fg"}`}>{s.label}</span>
            {s.detail && s.state !== "todo" && (
              <span
                className={`font-mono text-[13px] leading-[1.45] break-all ${
                  s.state === "fail" ? "text-danger" : s.state === "warn" ? "text-warning" : s.state === "current" ? "text-accent-text" : "text-subtle"
                }`}
              >
                {s.detail}
              </span>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

export function StepDot({ state, size = 24 }: { state: StepState; size?: number }) {
  const box = { width: size, height: size };
  if (state === "done")
    return (
      <span style={box} className="flex shrink-0 items-center justify-center rounded-full bg-success text-bg">
        <svg width={size / 2} height={size / 2} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M5 12l5 5 9-10" />
        </svg>
      </span>
    );
  if (state === "fail")
    return (
      <span style={box} className="flex shrink-0 items-center justify-center rounded-full bg-danger text-bg">
        <svg width={size / 2.2} height={size / 2.2} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" aria-hidden="true">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </span>
    );
  if (state === "warn")
    return (
      <span style={box} className="flex shrink-0 items-center justify-center rounded-full bg-warning text-[13px] font-extrabold text-bg">
        !
      </span>
    );
  if (state === "current")
    return <span style={box} className="box-border shrink-0 animate-spin-ark rounded-full border-2 border-accent border-r-transparent" />;
  return <span style={box} className="box-border shrink-0 rounded-full border-2 border-line-strong" />;
}

// ---- layout bits -----------------------------------------------------------------------------

export function PageHeader({ eyebrow, title, children, aside }: { eyebrow: ReactNode; title: ReactNode; children?: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-6">
      <div className="flex flex-col gap-3">
        <div className="eyebrow flex items-center gap-2.5">{eyebrow}</div>
        <h1 className="display-lg m-0">{title}</h1>
        {children}
      </div>
      {aside}
    </div>
  );
}

export function Field({ label, help, error, children }: { label: string; help?: ReactNode; error?: string; children: ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="text-sm font-medium text-fg">{label}</span>
      {children}
      {error ? (
        <span className="flex items-center gap-1.5 text-[13px] font-medium text-danger">
          <WarningIcon size={13} />
          {error}
        </span>
      ) : (
        help && <span className="text-[13px] text-subtle">{help}</span>
      )}
    </label>
  );
}

/** Pill segmented control (Public / Sealed, mode filters). */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  size = "md",
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode; count?: number }[];
  label: string;
  size?: "md" | "lg";
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex w-max rounded-full border border-line bg-surface p-1">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.value)}
            className={`flex cursor-pointer items-center gap-1.5 rounded-full border-none font-semibold transition-colors duration-150 ${
              size === "lg" ? "h-11 px-[22px] text-[15px]" : "h-[38px] px-4 text-sm"
            } ${on ? "bg-accent text-on-accent" : "bg-transparent text-muted hover:text-fg"}`}
          >
            {o.label}
            {o.count !== undefined && <span className="font-mono text-xs opacity-80">{o.count}</span>}
          </button>
        );
      })}
    </div>
  );
}
