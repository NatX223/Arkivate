export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-6 px-4 py-16">
      <h1 className="text-4xl font-semibold tracking-tight">Arkivate</h1>
      <p className="text-lg opacity-80">
        If-this-then-that for Arkiv data, run by independent workers. Every firing leaves a
        public, burned receipt on Arkiv, so a skipped job is provable.
      </p>
      <ul className="list-disc space-y-1 pl-5 text-sm opacity-70">
        <li>Triggers: coming soon</li>
        <li>Receipts: coming soon</li>
        <li>Workers: coming soon</li>
        <li>Dispute verifier: coming soon</li>
      </ul>
      <p className="text-xs opacity-50">Tiramisu testnet · chain 7738577 · MIT</p>
    </main>
  );
}
