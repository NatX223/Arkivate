# Deployment

Three deployables from one repo: the web app, and the two reference workers (worker-1, worker-2).
The reference workers are not special. Any operator can deploy more workers the same way, or on any
other host that runs Node 22; see [Add your own worker](#add-your-own-worker).

| What | Where | Status |
|---|---|---|
| Web app (`frontend/`) | Vercel | https://arkivate.vercel.app |
| worker-1 | GCP e2-micro VM, `us-central1` | https://34-136-53-253.sslip.io/health |
| worker-2 | GCP e2-micro VM, `us-east1` | https://34-74-197-9.sslip.io/health |

Each worker has its own VM, region, wallet (see [`WALLETS.md`](../WALLETS.md)), job store and
secrets. They share nothing but Arkiv.

## Order

1. **Workers** ([deploy-vm.md](deploy-vm.md)), with `CORS_ORIGINS=http://localhost:3000` for now.
   Each one registers its `PUBLIC_ENDPOINT` on Arkiv, which is how the web app finds it.
2. **Frontend** on Vercel (below). Note its production URL.
3. **`CORS_ORIGINS`**: on each VM, add the Vercel origin to `/opt/arkivate/.env`.
4. **Restart** each worker (`sudo systemctl restart arkivate-worker`), then check the web app's
   Workers page shows both online.

## Web app (Vercel)

1. Import the GitHub repo in Vercel. **Root Directory:** `frontend`. Framework: Next.js (detected).
   Leave install and build commands at their defaults: Vercel finds the root `pnpm-lock.yaml`,
   installs the pnpm workspace (so `@arkivate/core` resolves), and runs `next build`, which in
   Next 15 uses webpack (`arkiv/friction.md` F18; `next.config.ts` maps core's `.js` imports to
   `.ts`). No `vercel.json` is needed. Keep "Include files outside the Root Directory" enabled (the
   default): the build reads `backend/core`.
2. Environment variables. These are the only ones the frontend reads, both server-side in the
   `/api/rpc` read proxy. It reads no `NEXT_PUBLIC_*` variables.

   | Variable | Required? | Purpose |
   |---|---|---|
   | `ARKIV_ACCESS_KEY` | Recommended | Server-only. The proxy adds it as `X-API-KEY`; without it, reads share the keyless limit (~100 queries/hour/IP). Never exposed to the browser: do **not** prefix it with `NEXT_PUBLIC_`. |
   | `ARKIV_RPC_HTTP` | No | Defaults to the Tiramisu RPC. |

3. Deploy. The site holds no private keys: visitors sign writes in their own wallet (MetaMask), and
   the proxy forwards only read methods. Workers are discovered from their `worker` entities on
   Arkiv, so no worker URL is configured in Vercel.

## Workers (GCP e2-micro VMs)

Each reference worker is a Debian 12 e2-micro VM running the worker as plain Node 22 under systemd
(`arkivate-worker.service`), with Caddy in front serving HTTPS for `<ip-with-dashes>.sslip.io`
(certificate obtained automatically). No Docker and no build step: the worker runs its TypeScript
with `tsx` from a clone in `/opt/arkivate`.

The step-by-step console guide is **[deploy-vm.md](deploy-vm.md)**. The files it uses live in
[`deploy/vm/`](../deploy/vm/):

| File | What it does |
|---|---|
| `setup.sh <hostname> <env-file>` | Idempotent provisioning of a fresh VM: packages, swap, `arkivate` user, clone, install, `.env`, service, Caddy, then prints `/health`. |
| `update.sh` | `git pull --ff-only`, filtered install, restart, print `/health`. |
| `arkivate-worker.service` | systemd unit: `User=arkivate`, `NODE_ENV=production`, `DATA_DIR=/var/lib/arkivate`, `Restart=always`. |
| `Caddyfile.template` | `{{HOST}} { reverse_proxy 127.0.0.1:8787 }`. |
| `worker.env.example` | Every worker variable, commented. |

Why this shape:

| Choice | Reason |
|---|---|
| Always-on VM | A worker holds a WebSocket subscription, a 10 s expiry sweep and 30 s pollers; it must never scale to zero. |
| One VM per wallet | Two processes with one key would race on nonces (`predictEntityKeys` is nonce-derived) and could double-fire. |
| Two regions | The censorship-resistance story needs workers that fail independently. |
| Job store on local disk (`/var/lib/arkivate`) | Survives restarts: expiries that happen while the worker is down are still caught, and pinned deadlines never move. |
| Worker binds `127.0.0.1`, Caddy on 80/443 | Only HTTPS is exposed. The web app is served over HTTPS, so browsers need HTTPS workers for `/health` and `POST /sealed`. |
| CORS in the worker, not Caddy | One exact-match allowlist (`CORS_ORIGINS`), tested in `backend/worker/src/http.test.ts`. |
| `sslip.io` | A real hostname (needed for a certificate) without buying or configuring DNS. |
| `.env` mode 600, owned by `arkivate` | The private key lives only on the VM, never in the repo or the image. |

`backend/worker/Dockerfile` and `cloudbuild.yaml` remain as an optional path for container hosts.
The reference deployment doesn't use them.

### Worker environment

| Variable | Required? | Default | Purpose |
|---|---|---|---|
| `WORKER_PRIVATE_KEY` | **Yes** | | The worker's own wallet: 64 hex chars, `0x` optional. Must hold testnet GLM, or the worker stays in read-only dry-run mode. |
| `WORKER_NAME` | Recommended | `worker-local` | Name in the `worker` entity, and the job-store file name. |
| `ARKIV_ACCESS_KEY` | Recommended | | Sent as `X-API-KEY`. A worker polls constantly; the keyless limit is ~100 queries/hour/IP. |
| `PUBLIC_ENDPOINT` | For sealed jobs | | Public URL published in the `worker` entity (on the VMs: `https://<hostname>`). |
| `CORS_ORIGINS` | For the web app | `http://localhost:3000` | Exact browser origins (comma-separated, no `*`) allowed on `GET /health` and `POST /sealed`. Denied preflights get 403. |
| `TRIGGER_CREATORS` | No | empty = any | Optional gas guard: comma-separated addresses whose **public triggers and sealed hand-offs** this worker accepts. When set, other sealed hand-offs get 403. Empty on the reference workers. |
| `MAX_RECEIPTS_PER_TRIGGER_PER_HOUR` | No | `12` | Gas guard: receipts per trigger per hour from this worker. |
| `TELEGRAM_BOT_TOKEN` | For Telegram delivery | | Bot used to deliver sealed alerts. Without it, Telegram jobs fail delivery and write no receipt. |
| `PORT` / `WORKER_PORT` | No | `8787` | Listen port; `PORT` wins if set. The Caddyfile proxies to 8787. |
| `HOST` | No | `127.0.0.1` if `NODE_ENV=production`, else `0.0.0.0` | Bind address. |
| `DATA_DIR` | No | `backend/worker/data` | Job store, absolute or relative path. The systemd unit sets `/var/lib/arkivate`. |
| `GIT_SHA` | No | | `/health` `version` when `git rev-parse` fails (e.g. no `.git`). |
| `ARKIV_RPC_HTTP` / `ARKIV_RPC_WS` | No | Tiramisu | RPC endpoints. |
| `SKIP_SEALED` | No | `false` | **Demo switch only.** Accepts sealed jobs but never fires them, to stage a provable skip. Never enable on a worker people should trust. |

Blank values count as unset, so a copied template with empty lines falls back to the defaults.
`GET /health` reports `version` (short commit) and `uptimeSeconds` alongside the worker's status.

### Gas guards on the reference workers

Every write costs the worker gas (about 0.00017 GLM at 1 gwei for the largest, a Reactivate
receipt), and anyone can post a public trigger. During judging the reference workers run **open**:
`TRIGGER_CREATORS` is empty on both VMs, so anyone's public triggers and sealed hand-offs are
accepted. What limits the cost, stated plainly:

- `MAX_RECEIPTS_PER_TRIGGER_PER_HOUR=12` caps how often one trigger can make a worker write.
- Each reference worker holds about 10 GLM, enough for tens of thousands of writes. A flood of
  distinct triggers could still drain it over time; nothing else stops that today.
- `TRIGGER_CREATORS` remains an optional gas guard. An operator who sets it runs only the listed
  creators' public triggers and refuses other sealed hand-offs with 403 before anything is written.

Owner-funded triggers (the owner pays for its own receipts) are on the roadmap and would make the
guard unnecessary.

## Cost

| Item | Estimate |
|---|---|
| 2 × e2-micro (us-central1, us-east1) | The GCP free tier covers one e2-micro-month in these regions per billing account, so roughly one VM is billed: about $7/month list price. |
| 2 × external IPv4 | About $3–4/month each while in use. |
| Disks, egress | Within the free tier for 10–30 GB standard disks and this traffic. |
| Vercel | Hobby plan, free. |

For the hackathon window (until 23 Oct) that is a few dollars in total. Check the estimate the VM
create form shows; prices vary by region and account.

## Teardown (after 23 Oct 2026)

Delete both VMs, then release both static IPs (an unattached reserved IP is still billed). Steps:
[deploy-vm.md § Teardown](deploy-vm.md#teardown-after-23-oct-2026). The workers' `worker`
entities expire on Arkiv within a day once heartbeats stop; receipts and acceptances expire on
their own TTLs. The Vercel project can stay or be deleted.

## Add your own worker

Any operator can join the network. A worker needs a funded wallet, ideally an Arkiv access key, and
a host that keeps a process running.

```bash
git clone https://github.com/NatX223/Arkivate.git && cd Arkivate
corepack enable && pnpm install
pnpm wallets                 # prints fresh keys + addresses; writes nothing
cp .env.example .env         # set WORKER_NAME, WORKER_PRIVATE_KEY, ARKIV_ACCESS_KEY
# fund the worker address at https://hub.arkiv.network/faucet
pnpm worker
```

The worker registers a `worker` entity signed by its wallet, extends it every 6 hours, and drops out
of the network when it stops (the entity expires after 1 day). It ranks itself among live workers by
address for dedupe (see the README). To accept sealed hand-offs, give it a public HTTPS URL, set
`PUBLIC_ENDPOINT`, and add the web app's origin to `CORS_ORIGINS`. On a Debian VM,
`deploy/vm/setup.sh` does all of it ([deploy-vm.md](deploy-vm.md)); fork the repo first if you want
it to clone your copy.

The worker package is not published to npm yet, so there is no `npx` one-liner; it runs from a
clone with `pnpm worker` (TypeScript via `tsx`, no build step).

## Smoke test after deploying

1. `curl https://<worker>/health` on each worker: `ok: true`, `mode: "live"`, the expected
   `address`, the deployed `version`, `triggers > 0`.
2. The web app's Workers page lists both workers with their health (needs `CORS_ORIGINS`).
3. `pnpm cli demo-feed --kind listing --blocks 120` and watch a keep-alive trigger extend it
   (receipt with `outcome = extended` on the trigger page).
4. Sealed path: `pnpm cli seal --spec backend/cli/examples/sealed-event-webhook.json --worker worker-1 --webhook <your test URL>`,
   then `pnpm cli demo-feed --kind event --ttl 1440`, then `pnpm cli verify <sealed-key>` after a
   `reveal`. Use a long `--ttl` so the evidence outlives judging (see `docs/verification.md`). If the
   worker sets `TRIGGER_CREATORS`, the sealed owner's address must be on it.
