"use client";

import type { TxError, TxStage } from "@/lib/tx";
import { short } from "@/lib/format";
import { explorerTx } from "./ui";

/** Compact horizontal stepper for one-transaction owner actions (pause, reveal). */
export function TxProgress({ stage, hash, error }: { stage: TxStage; hash?: string; error?: TxError }) {
  if (stage === "idle") return null;
  const order: TxStage[] = ["sign", "submit", "done"];
  const pos = stage === "error" ? order.indexOf(error?.at === "submit" ? "submit" : "sign") : stage === "connect" || stage === "network" ? 0 : order.indexOf(stage);
  const labels = ["Sign", "Submit", "Confirmed"];
  return (
    <div className="flex animate-in-fast flex-col gap-2.5">
      <div className="grid grid-cols-3 gap-1.5">
        {labels.map((label, i) => {
          const done = stage === "done" || i < pos;
          const failed = stage === "error" && i === pos;
          const cur = !done && !failed && i === pos;
          const color = done ? "var(--success)" : failed ? "var(--danger)" : cur ? "var(--accent)" : "var(--border-strong)";
          const text = done ? "text-success" : failed ? "text-danger" : cur ? "text-accent-text" : "text-subtle";
          return (
            <div key={label} className="flex flex-col gap-1.5">
              <span className="h-1 rounded-full" style={{ background: color }} />
              <span className={`text-xs leading-[1.2] font-semibold ${text}`}>
                {failed ? "✕ Failed" : cur && i === 0 ? (stage === "network" ? "Switching network…" : stage === "connect" ? "Connecting…" : "Signing…") : label}
              </span>
            </div>
          );
        })}
      </div>
      {hash && (
        <a href={explorerTx(hash)} target="_blank" rel="noreferrer" className="font-mono text-xs">
          tx {short(hash)} ↗
        </a>
      )}
      {error && (
        <span className="text-xs leading-[1.45] text-danger">
          {error.kind === "rejected"
            ? "Rejected in your wallet. Nothing was sent."
            : error.kind === "funds"
              ? "Not enough testnet GLM for this write."
              : error.message}
        </span>
      )}
    </div>
  );
}
