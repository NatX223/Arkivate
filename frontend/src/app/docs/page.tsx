import Link from "next/link";
import { GITHUB_URL } from "@/components/Footer";
import { CopyButton } from "@/components/ui";

export const metadata = { title: "Run a worker" };

const QUICKSTART = `git clone ${GITHUB_URL}.git && cd Arkivate
corepack enable && pnpm install
pnpm wallets          # prints fresh keys + addresses; writes nothing
cp .env.example .env  # WORKER_NAME, WORKER_PRIVATE_KEY, ARKIV_ACCESS_KEY, PUBLIC_ENDPOINT
# fund the worker address with testnet GLM: https://hub.arkiv.network/faucet
pnpm worker`;

const CLI = [
  ["pnpm cli create <spec.json>", "Publish a public trigger (the spec is the payload)."],
  ["pnpm cli pause <key> [--resume]", "Pause or resume a public trigger you created."],
  ["pnpm cli seal --spec <file> --worker <name> --telegram <id>", "Publish only a salted commitment and hand the spec to one worker."],
  ["pnpm cli handoff <sealed-key> --telegram <id>", "Re-send a sealed hand-off (idempotent)."],
  ["pnpm cli reveal <sealed-key>", "Publish { spec, salt }, burned, so anyone can verify."],
  ["pnpm cli verify <sealed-key>", "FIRED, SKIPPED (provable censorship), PENDING, …"],
  ["pnpm cli demo-feed --kind listing", "Emit synthetic short-lived entities to watch."],
] as const;

const ON_ARKIV = [
  ["Public triggers", "The full spec: what is watched, the condition and the action."],
  ["Receipts", "Readonly and burned, so nobody can delete them, the worker included. Public ones carry a summary; sealed ones carry only a salted result hash."],
  ["Sealed commitments", "keccak256(spec ‖ salt) and the chosen worker's address. Nothing else."],
  ["Acceptances", "The worker's burned promise to run a sealed job, with the block it accepted."],
  ["Worker registrations", "Name, version and public hand-off URL. They expire unless the worker keeps heartbeating."],
  ["Reveals (only in a dispute)", "{ spec, salt } for one sealed trigger, published by its owner."],
];

const PRIVATE = [
  ["Alert destinations", "Telegram chat IDs and webhook URLs go only to the chosen worker, never on-chain, not even hashed."],
  ["Sealed specs before a reveal", "Only the owner and the assigned worker know what a sealed trigger watches."],
  ["The salt", "Kept in the owner's browser (or ~/.arkivate). Without it, a commitment can't be brute-forced."],
  ["Keys", "Workers sign with their own key. On this site, you sign in your own wallet; Arkivate never holds keys."],
  ["The Arkiv access key", "Server-side only. The site's read proxy adds it; your browser never sees it."],
];

export default function DocsPage() {
  return (
    <main className="page">
      <div aria-hidden="true" className="arc opacity-50" style={{ right: -220, top: -40, width: 560, height: 560 }} />
      <div className="relative flex max-w-[760px] flex-col gap-3">
        <div className="eyebrow">Docs</div>
        <h1 className="display-lg m-0">Run a worker.</h1>
        <p className="body-lg m-0">
          Workers are the open-source engine behind Arkivate. Anyone can run one; each one is just an address that writes receipts. More independent workers
          means nobody can switch the system off.
        </p>
      </div>

      <section className="relative overflow-hidden rounded-2xl border border-line bg-sunken">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line py-3 pr-3 pl-6">
          <span className="text-base font-semibold">Quickstart · Node 22, pnpm 9</span>
          <CopyButton text={QUICKSTART} label="Copy all" />
        </div>
        <pre className="m-0 overflow-x-auto px-6 py-5 font-mono text-[13px] leading-[1.8] text-fg">{QUICKSTART}</pre>
      </section>

      <section className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,300px),1fr))] gap-px overflow-hidden rounded-2xl border border-line bg-line">
        {[
          ["01", "Registers", "Writes a worker entity with its name and public hand-off URL, and keeps it alive with heartbeats. A dead worker simply disappears."],
          ["02", "Watches", "Loads every live public trigger and its accepted sealed jobs, follows entity events over WebSocket, and sweeps for expiries, which Arkiv never announces."],
          ["03", "Fires and proves", "Posts a notice, reactivates (extends) the watched entity, or delivers a private alert. Every firing writes a burned receipt that anyone can check."],
        ].map(([n, t, body]) => (
          <div key={n} className="flex flex-col gap-4 bg-surface p-[clamp(28px,4vw,40px)]">
            <span className="font-mono text-[15px] text-accent-text">{n}</span>
            <span className="font-serif text-[clamp(26px,3vw,34px)] leading-[1.1]">{t}</span>
            <p className="m-0 text-base leading-[1.55] text-muted">{body}</p>
          </div>
        ))}
      </section>

      <section className="flex flex-col gap-6">
        <div className="flex flex-col gap-3">
          <div className="eyebrow text-warm!">Transparency</div>
          <h2 className="display-md m-0">What&apos;s on Arkiv, and what stays private.</h2>
        </div>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,420px),1fr))] gap-6">
          <Column title="On Arkiv · public" tone="accent" rows={ON_ARKIV} />
          <Column title="Never on Arkiv" tone="sealed" rows={PRIVATE} />
        </div>
        <span className="text-[13px] text-subtle">
          Trust on Arkiv is the creator address: workers and the verifier only trust entities by who wrote them, never by labels like project or type.
        </span>
      </section>

      <section className="flex flex-col gap-6">
        <h2 className="display-md m-0">The CLI</h2>
        <div className="card overflow-x-auto">
          {CLI.map(([cmd, what]) => (
            <div key={cmd} className="grid min-w-[640px] grid-cols-[1.2fr_1fr] items-center gap-6 border-b border-line px-6 py-4 last:border-b-0">
              <code className="font-mono text-[13px] text-fg">{cmd}</code>
              <span className="text-sm text-muted">{what}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="flex flex-wrap gap-3">
        <a href={GITHUB_URL} target="_blank" rel="noreferrer" className="btn btn-primary">
          Source on GitHub ›
        </a>
        <a href={`${GITHUB_URL}/blob/main/arkiv/schema.md`} target="_blank" rel="noreferrer" className="btn btn-secondary">
          Entity schema
        </a>
        <a href={`${GITHUB_URL}/blob/main/docs/verification.md`} target="_blank" rel="noreferrer" className="btn btn-secondary">
          How verification works
        </a>
        <a href={`${GITHUB_URL}/blob/main/arkiv/friction.md`} target="_blank" rel="noreferrer" className="btn btn-secondary">
          Friction report
        </a>
        <Link href="/workers" className="btn btn-secondary">
          Live workers
        </Link>
      </section>
    </main>
  );
}

function Column({ title, tone, rows }: { title: string; tone: "accent" | "sealed"; rows: (readonly string[])[] }) {
  return (
    <div className="card flex flex-col gap-1 p-7">
      <span className={`mb-3 text-sm font-bold tracking-[0.08em] uppercase ${tone === "accent" ? "text-accent-text" : "text-sealed"}`}>
        {tone === "sealed" ? "🔒 " : ""}
        {title}
      </span>
      {rows.map(([name, body]) => (
        <div key={name} className="flex flex-col gap-1 border-t border-line py-3.5">
          <span className="text-[15px] font-semibold">{name}</span>
          <span className="text-sm leading-normal text-muted">{body}</span>
        </div>
      ))}
    </div>
  );
}
