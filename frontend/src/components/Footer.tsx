import Link from "next/link";

export const GITHUB_URL = "https://github.com/NatX223/Arkivate";

export function Footer() {
  return (
    <footer className="relative border-t border-line">
      <div className="mx-auto box-border flex max-w-[1200px] flex-wrap items-center justify-between gap-4 px-4 py-8 sm:px-6">
        <span className="flex items-center gap-2 font-serif text-[22px] leading-none">
          <span className="text-accent-text">✦</span>Arkivate
        </span>
        <div className="flex flex-wrap gap-6 text-sm">
          <Link href="/docs" className="link-plain">
            Docs
          </Link>
          <a href={GITHUB_URL} className="link-plain" target="_blank" rel="noreferrer">
            GitHub
          </a>
          <a href={`${GITHUB_URL}/blob/main/arkiv/schema.md`} className="link-plain" target="_blank" rel="noreferrer">
            Schema
          </a>
          <a href={`${GITHUB_URL}/blob/main/LICENSE`} className="link-plain" target="_blank" rel="noreferrer">
            MIT
          </a>
        </div>
        <span className="text-sm text-subtle">Built on Arkiv · Tiramisu testnet</span>
      </div>
    </footer>
  );
}
