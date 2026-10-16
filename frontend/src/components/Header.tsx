"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { fmtBlock, short } from "@/lib/format";
import { useHead } from "@/lib/poll";
import { useWallet } from "@/lib/wallet";
import { MenuIcon, MoonIcon, SunIcon, WalletIcon, WarningIcon } from "./icons";

const NAV = [
  ["/", "Overview"],
  ["/triggers", "Triggers"],
  ["/create", "Create"],
  ["/receipts", "Receipts"],
  ["/workers", "Workers"],
  ["/verify", "Verify"],
  ["/docs", "Docs"],
] as const;

const isActive = (path: string, href: string) => (href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`));

export function Header() {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const head = useHead();
  useEffect(() => setOpen(false), [path]);

  return (
    <header className="relative z-20 border-b border-line bg-bg">
      <div className="mx-auto flex max-w-[1200px] items-center justify-between gap-5 px-4 py-3.5 sm:px-6">
        <Link href="/" className="flex shrink-0 items-center gap-2 font-serif text-[26px] leading-none text-fg no-underline">
          <span className="text-accent-text">✦</span>Arkivate
        </Link>
        <nav aria-label="Primary" className="hidden flex-wrap gap-1 min-[1080px]:flex">
          {NAV.map(([href, label]) => {
            const on = isActive(path, href);
            return (
              <Link
                key={href}
                href={href}
                aria-current={on ? "page" : undefined}
                className={`flex h-10 items-center rounded-lg px-3 text-base font-medium no-underline transition-colors duration-150 hover:bg-surface hover:text-fg ${
                  on ? "bg-accent-soft text-accent-text" : "text-muted"
                }`}
              >
                {label}
              </Link>
            );
          })}
        </nav>
        <div className="flex shrink-0 items-center gap-2.5">
          <span
            title="Latest Tiramisu block"
            className="num hidden h-9 items-center gap-2 rounded-full border border-line px-3 text-[13px] text-muted min-[1080px]:flex"
          >
            {head.error && head.data === undefined ? (
              <>
                <span className="h-[7px] w-[7px] rounded-full border-[1.5px] border-danger" />
                offline
              </>
            ) : (
              <>
                <span className="h-[7px] w-[7px] animate-pulse-live rounded-full bg-success" />
                {head.data === undefined ? "…" : fmtBlock(head.data)}
              </>
            )}
          </span>
          <ThemeToggle />
          <WalletButton />
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-label="Menu"
            aria-expanded={open}
            className="flex h-11 w-11 cursor-pointer items-center justify-center rounded-xl border border-line-strong bg-surface text-fg min-[1080px]:hidden"
          >
            <MenuIcon size={20} />
          </button>
        </div>
      </div>
      {open && (
        <nav aria-label="Primary" className="flex animate-in-fast flex-col border-t border-line px-4 pt-2 pb-4 min-[1080px]:hidden">
          {NAV.map(([href, label]) => (
            <Link
              key={href}
              href={href}
              className={`flex h-[52px] items-center justify-between border-b border-line px-2 text-lg font-medium no-underline ${
                isActive(path, href) ? "text-accent-text" : "text-muted"
              }`}
            >
              {label}
              <span className="text-subtle">›</span>
            </Link>
          ))}
          <span className="num flex items-center gap-2 px-2 pt-4 text-[13px] text-muted">
            <span className="h-[7px] w-[7px] rounded-full bg-success" />
            Tiramisu · {head.data === undefined ? "…" : fmtBlock(head.data)}
          </span>
        </nav>
      )}
    </header>
  );
}

function WalletButton() {
  const w = useWallet();
  const [busy, setBusy] = useState(false);
  const base =
    "flex h-11 cursor-pointer items-center gap-2 rounded-xl border px-3.5 text-[15px] font-semibold whitespace-nowrap transition-colors duration-150";

  if (!w.address) {
    return (
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          if (!w.available) return window.open("https://metamask.io/download/", "_blank", "noreferrer");
          setBusy(true);
          try {
            await w.connect();
          } catch {
            // rejected: stay disconnected
          } finally {
            setBusy(false);
          }
        }}
        className={`${base} border-line-strong bg-surface text-fg hover:bg-raised`}
      >
        <WalletIcon size={18} />
        <span className="hidden sm:inline">{w.available ? "Connect wallet" : "Get a wallet"}</span>
        <span className="sm:hidden">Connect</span>
      </button>
    );
  }
  if (!w.onTiramisu) {
    return (
      <button
        type="button"
        onClick={() => void w.switchToTiramisu().catch(() => {})}
        className={`${base} border-warning bg-warning-soft text-sm text-warning`}
        title="Switch your wallet to the Arkiv Tiramisu testnet"
      >
        <WarningIcon size={16} />
        <span className="hidden sm:inline">Wrong network</span>
        <span className="sm:hidden">Network</span>
      </button>
    );
  }
  return (
    <span aria-label={`Connected wallet ${w.address}`} title={w.address} className={`${base} cursor-default border-line-strong bg-surface text-fg`}>
      <span className="h-2 w-2 rounded-full bg-success" />
      <span className="font-mono text-sm font-medium">{short(w.address)}</span>
    </span>
  );
}

function ThemeToggle() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  useEffect(() => {
    setTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark");
  }, []);
  const flip = () => {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("arkivate.theme", next);
    } catch {
      // storage blocked: theme lasts for this page view
    }
    setTheme(next);
  };
  return (
    <button
      type="button"
      onClick={flip}
      aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
      className="flex h-11 w-11 cursor-pointer items-center justify-center rounded-xl border border-line bg-transparent text-muted hover:bg-surface hover:text-fg"
    >
      {theme === "dark" ? <SunIcon size={18} /> : <MoonIcon size={18} />}
    </button>
  );
}
