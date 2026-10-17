# Run Arkivate locally

Everything runs from source with `tsx`; there is no build step. All writes go to the Tiramisu
testnet (chain ID 7738577).

## Prerequisites

- Node 22 (`.nvmrc`), pnpm 9 (`corepack enable`)
- Any OS. Scripts don't assume macOS; we developed on Windows 11.
- Testnet GLM from https://hub.arkiv.network/faucet (SIWE sign-in and captcha; about one claim per
  hour, `arkiv/friction.md` F6)
- An Arkiv access key from https://hub.arkiv.network/api-keys (optional, strongly recommended for a
  worker: the keyless RPC allows ~100 queries/hour/IP)

## 1. Install and check

```bash
git clone https://github.com/NatX223/Arkivate.git && cd Arkivate
corepack enable && pnpm install
pnpm typecheck
pnpm test          # 39 tests in 3 files
```

## 2. Wallets and `.env`

```bash
pnpm wallets       # prints owner, sealed_owner, worker_a, worker_b keys + addresses; writes nothing
cp .env.example .env
```

Paste the keys into `.env` (it is gitignored) and fund the addresses you will write from. One
faucet claim (10 GLM) covers thousands of writes, so you can fund one wallet and send GLM to the
others with a plain transfer.

| Variable | Used by | Required? |
|---|---|---|
| `ARKIV_RPC_HTTP`, `ARKIV_RPC_WS` | all | No (default: Tiramisu) |
| `ARKIV_ACCESS_KEY` | all; web read proxy | Recommended |
| `OWNER_PRIVATE_KEY` | CLI `create`, `pause`, `demo-feed`; `pnpm hello` | For those commands |
| `SEALED_OWNER_PRIVATE_KEY` | CLI `seal`, `handoff`, `reveal` | For sealed triggers |
| `WORKER_PRIVATE_KEY` | worker | **Yes**, for `pnpm worker` |
| `WORKER_NAME` | worker | Recommended (default `worker-local`) |
| `WORKER_PORT` | worker | No (default `8787`) |
| `PUBLIC_ENDPOINT` | worker | For sealed hand-offs (locally: `http://localhost:8787`) |
| `DATA_DIR` | worker | No (default `backend/worker/data`, gitignored; absolute paths work) |
| `HOST` | worker | No (default `0.0.0.0`; `127.0.0.1` when `NODE_ENV=production`) |
| `TRIGGER_CREATORS` | worker | No (empty = accept public triggers and sealed hand-offs from any creator) |
| `MAX_RECEIPTS_PER_TRIGGER_PER_HOUR` | worker | No (default `12`) |
| `CORS_ORIGINS` | worker | No (default `http://localhost:3000`; exact origins, comma-separated, no `*`) |
| `TELEGRAM_BOT_TOKEN` | worker | For Telegram delivery |
| `SKIP_SEALED` | worker | No. Demo switch only: accepts sealed jobs and never fires them |

`verify` and `list` need no key at all. Config errors name the variable and the rule it broke,
never the value. One worker identity per `.env`: a duplicated key silently overrides the first
(F11), so give a second local worker its values in the shell instead.

## 3. Smoke test

```bash
pnpm hello
```

Checks the chain ID and balance, creates, reads back and queries an entity, creates and burns one in
a single batch, and waits for the live `EntityCreated` event over WebSocket.

## 4. Run a worker, a trigger and some data

Terminal 1:
```bash
pnpm worker        # logs "worker starting", "config validated", "LIVE: registered"
```

Terminal 2. The example specs name our owner wallet in `created_by`; replace it with your own
`OWNER_PRIVATE_KEY` address first, or the trigger will ignore the data you emit.
```bash
# keep-alive (Reactivate): extend every owner `listing` 40 blocks before expiry, by 120 blocks, at most twice
pnpm cli create backend/cli/examples/keep-alive.json
pnpm cli demo-feed --kind listing --blocks 120

# a canary that is left to expire
pnpm cli create backend/cli/examples/canary-expired.json
pnpm cli demo-feed --kind canary --blocks 60

pnpm cli list
```

`GET http://localhost:8787/health` shows what the worker is doing. Receipts appear on Arkiv as
burned `receipt` entities created by the worker's wallet.

A second worker on the same machine: run another terminal with `WORKER_NAME`, `WORKER_PRIVATE_KEY`,
`WORKER_PORT` and `DATA_DIR` set in the shell. The two rank themselves by address; only one writes
each receipt.

## 5. Sealed trigger and verification

```bash
pnpm cli seal --spec backend/cli/examples/sealed-event-webhook.json \
  --worker worker-local --endpoint http://localhost:8787 --webhook https://<your test receiver>
pnpm cli demo-feed --kind event --ttl 1440
pnpm cli reveal <sealed-key>       # only if you want to open a dispute
pnpm cli verify <sealed-key>
```

The salt is written to `~/.arkivate/sealed/<sealed-key>.json` and nowhere else. Without it you
can't reveal. To fail on purpose, copy that file, change one field in `spec`, and run
`pnpm cli reveal <sealed-key> --file <copy>` on a sealed job you haven't revealed yet: `verify`
returns `INVALID_REVEAL`.

To stage a provable skip, run a second worker with `SKIP_SEALED=true`, seal a job to it, emit an
event, wait 150 blocks (~5 minutes), reveal, and verify: `SKIPPED`. Use a long `--ttl` on the event,
because `verify` replays at head (see `docs/verification.md`).

## 6. Web app

```bash
pnpm web           # http://localhost:3000
```

The web app reads the root `.env` for `ARKIV_RPC_HTTP` and `ARKIV_ACCESS_KEY` only (never the
private keys) and serves the read proxy at `/api/rpc`. Writes are signed in your own wallet; add
Tiramisu (chain ID 7738577) to MetaMask when prompted.
