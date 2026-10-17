# Deploy a worker on a GCP e2-micro VM

Step-by-step guide for the two reference workers. Everything is done in the GCP console and its
browser SSH window; no `gcloud` or local Docker needed. Each worker is plain Node 22 under systemd,
behind Caddy, which serves HTTPS on a free `sslip.io` hostname. Overview, cost and teardown:
[deployment.md](deployment.md).

| | worker-1 | worker-2 |
|---|---|---|
| VM name | `arkivate-worker-1` | `arkivate-worker-2` |
| Region / zone | `us-central1` (e.g. `us-central1-a`) | `us-east1` (e.g. `us-east1-b`) |
| Wallet | `worker-1` row in [WALLETS.md](../WALLETS.md) | `worker-2` row |
| Env file | `worker-1.env` | `worker-2.env` |
| Hostname (live) | `34-136-53-253.sslip.io` | `34-74-197-9.sslip.io` |
| `/health` | https://34-136-53-253.sslip.io/health | https://34-74-197-9.sslip.io/health |

The two workers share nothing but Arkiv: separate VMs, regions, wallets and job stores.

## 0. Before you start

- Both worker wallets are funded on Tiramisu (https://hub.arkiv.network/faucet). An unfunded worker
  runs, but stays in read-only `dry-run` mode.
- An Arkiv access key (https://hub.arkiv.network/api-keys). One key can serve both workers.
- Optional: a list of creator addresses to accept (`TRIGGER_CREATORS`, a gas guard). The reference
  workers leave it empty during judging, so they accept every creator.
- The frontend URL is not needed yet; you add it in step 7.

## 1. Reserve a static IP (per worker)

The hostname embeds the IP, so it must not change on reboot.

**VPC network → IP addresses → Reserve external static IP address.** Name `arkivate-worker-1-ip`,
Network Service Tier *Standard* or *Premium*, IPv4, **Regional**, region `us-central1`. Note the
address, e.g. `34.123.45.67`.

Your hostname is the IP with dashes plus `.sslip.io`: `34-123-45-67.sslip.io`. sslip.io resolves
it to that IP; no DNS setup needed.

## 2. Create the VM (per worker)

**Compute Engine → VM instances → Create instance.**

| Field | Value |
|---|---|
| Name | `arkivate-worker-1` |
| Region / zone | `us-central1` / `us-central1-a` |
| Machine type | **e2-micro** (General purpose, E2) |
| Boot disk | **Debian GNU/Linux 12 (bookworm)**, *Standard persistent disk*, 10–30 GB |
| Firewall | Tick **Allow HTTP traffic** and **Allow HTTPS traffic** |
| Networking → network interface → External IPv4 | the static IP from step 1 |

Leave everything else at the default and click **Create**. Port 8787 stays closed: the worker
listens on `127.0.0.1` only, and Caddy (ports 80/443) is the only way in. Port 80 must be open for
Caddy to get its certificate.

## 3. Write the env file (on your machine)

Copy [`deploy/vm/worker.env.example`](../deploy/vm/worker.env.example) to `worker-1.env`
**outside the repo** (or anywhere gitignored) and fill in:

```
WORKER_PRIVATE_KEY=<worker-1 key>
WORKER_NAME=worker-1
PUBLIC_ENDPOINT=https://34-123-45-67.sslip.io
ARKIV_ACCESS_KEY=<access key>
TRIGGER_CREATORS=
CORS_ORIGINS=http://localhost:3000
```

Leave the rest blank (defaults apply). An empty `TRIGGER_CREATORS` accepts every creator; set it
to comma-separated `0x` addresses only if you want the gas guard. `PUBLIC_ENDPOINT` is `https://` + the hostname, no trailing
slash. `CORS_ORIGINS` gets the Vercel URL in step 7.

## 4. Run setup (per worker)

1. In **VM instances**, click **SSH** next to the VM. A browser terminal opens.
2. In that window, click **Upload file** (top bar) and upload `worker-1.env`. It lands in your home
   directory.
3. Run:

   ```bash
   curl -fsSLO https://raw.githubusercontent.com/NatX223/Arkivate/main/deploy/vm/setup.sh
   sudo bash setup.sh 34-123-45-67.sslip.io ~/worker-1.env
   ```

`setup.sh` installs git, Node 22, pnpm (via corepack) and Caddy; adds a 1 GB swapfile; creates the
`arkivate` system user; clones the repo into `/opt/arkivate`; installs the worker's dependencies;
moves your env file to `/opt/arkivate/.env` (mode 600, and deletes the uploaded copy); creates the
job store `/var/lib/arkivate`; starts `arkivate-worker.service`; configures Caddy for the hostname;
and finally prints the service status and `GET https://<hostname>/health`. It takes a few minutes on
an e2-micro, most of it `pnpm install`.

It is idempotent. Re-run it with a new env file to change config, or without one
(`sudo bash setup.sh <hostname>`) to keep the existing `/opt/arkivate/.env`.

## 5. Check the worker

From anywhere:

```bash
curl -s https://34-123-45-67.sslip.io/health
```

Expect `"ok": true`, `"name": "worker-1"`, the worker-1 `address`, `"mode": "live"`, `version`
equal to the commit you deployed, and `uptimeSeconds` counting up. `"mode": "dry-run"` means the
wallet has no GLM; fund it and the worker goes live within a minute, no restart needed.

On start the worker registers (or updates) its `worker` entity on Arkiv with `PUBLIC_ENDPOINT`. It
finds its existing entity by `$creator`, so restarts never create a second registration.

## 6. Repeat for worker-2

Steps 1–5 with `arkivate-worker-2`, region `us-east1`, the worker-2 key, `WORKER_NAME=worker-2` and
its own hostname.

## 7. Allow the frontend's origin

After the frontend is deployed on Vercel (see [deployment.md](deployment.md#web-app-vercel)), on
**each** VM:

```bash
sudoedit /opt/arkivate/.env
# CORS_ORIGINS=https://<your-app>.vercel.app,http://localhost:3000
sudo systemctl restart arkivate-worker
```

Origins match exactly: scheme + host (+ port), no trailing slash, no `*`, no paths. Vercel preview
URLs are different origins; add any you need. Without this, the browser blocks the Workers page's
`/health` reads and the Create page's sealed hand-off (`POST /sealed`); `curl` is unaffected.

Then open the web app's **Workers** page: both workers should show as online.

## Day-to-day

| Task | Command (on the VM) |
|---|---|
| Deploy the latest `main` | `sudo bash /opt/arkivate/deploy/vm/update.sh` |
| Logs (follow) | `sudo journalctl -u arkivate-worker -f` |
| Restart | `sudo systemctl restart arkivate-worker` |
| Status | `systemctl status arkivate-worker` |
| Change config | `sudoedit /opt/arkivate/.env`, then restart |
| Caddy logs | `sudo journalctl -u caddy -n 100 --no-pager` |

`update.sh` runs `git pull --ff-only` and the filtered install as `arkivate`, refreshes the
systemd unit if it changed, restarts the worker and prints `/health`. It never touches `.env` or
the Caddyfile.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `setup.sh` ends with "no answer yet" | Give it a minute: Caddy is still getting the certificate, or the worker is still connecting. Re-run the `curl`. Then check the logs above. |
| Caddy log shows ACME / challenge errors | HTTP (80) or HTTPS (443) firewall not allowed on the VM, or the hostname doesn't match the VM's IP. Caddy falls back to ZeroSSL if Let's Encrypt refuses. |
| `502` from Caddy | The worker isn't listening. `journalctl -u arkivate-worker`: usually a config error, which names the variable (never the value). |
| `Invalid environment configuration` | Fix the named variable in `/opt/arkivate/.env`. Private keys are 64 hex chars, `0x` optional. |
| `"mode": "dry-run"` | Fund the worker address at the faucet. |
| Browser: CORS error on `/health` or `/sealed` | The page's origin is not in `CORS_ORIGINS` exactly (step 7). |
| `POST /sealed` → 403 "TRIGGER_CREATORS allowlist" | `TRIGGER_CREATORS` is set and the sealed trigger's creator isn't on it. Empty it to accept everyone. |
| `pnpm install` killed | Out of memory; check the swapfile exists (`swapon --show`) and re-run `setup.sh`. |

## Teardown (after 23 Oct 2026)

1. **Compute Engine → VM instances:** delete `arkivate-worker-1` and `arkivate-worker-2` (their
   boot disks go with them by default).
2. **VPC network → IP addresses:** release both static IPs. A reserved IP that isn't attached to
   a running VM is billed.
3. Optional: sweep the worker wallets' leftover GLM back to the owner wallet; it is testnet only.

The workers' `worker` entities expire on their own within a day once the heartbeats stop.
