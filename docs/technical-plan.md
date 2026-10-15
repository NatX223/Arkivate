# Arkivate — Technical Plan

*Working name. Rename freely.*

**Hackathon:** Arkiv: Global Tour Stop · **Deadline:** Sun 18 Oct 2026, 23:59 London/Lagos
**Tracks:** Open Source + Censorship Resistance + Privacy
**Network:** Tiramisu testnet · chain ID `7738577`
- HTTP: `https://rpc.tiramisu.db-chain.testnet.arkiv.network`
- WS: `wss://rpc.tiramisu.db-chain.testnet.arkiv.network`

---

## 0. The story in plain words

Arkivate is **"if this, then that" for Arkiv data, run by independent workers instead of one company's server.**

- Arkiv data is public and queryable, but nothing *happens* when it changes. Expiration emits no event, so apps must poll or sweep deadlines themselves.
- That's why every team in this hackathon built its own private watcher: Door Ledger's poller, Lapse's re-query loop, Arkiv Canary's cron CLI, Fine Print's snapshotter. Arkivate is the shared one.

**One promise per track:**
- **Open Source:** a reusable trigger engine + worker any Arkiv app can plug into.
- **Censorship Resistance:** anyone can run a worker, and every firing leaves a public receipt, so a *skipped* job is provable.
- **Privacy:** your automations reveal your intentions ("alert me if Binance halts SOL withdrawals" = "I hold SOL on Binance"). Sealed triggers put only a salted hash on Arkiv. The real spec goes privately to your chosen worker. If it skips your job, you reveal and prove it. *Private by default, provable on demand.*

---

## 1. Arkiv facts that shape the design (SDK 0.8.1, Tiramisu)

| Fact | Consequence |
|---|---|
| Writes are native entity operations sent to `0x4400000000000000000000000000000000000044`. No user-deployed contracts. | All "on-chain logic" = schema design + off-chain verification. No Solidity. |
| Write gas is paid in testnet GLM (Hub faucet). | Fund every wallet. Unfunded writes fail with a vague "Execution error without revert data". |
| `flags: { readonly, permissionlessExtension }` default to false and are immutable. A readonly entity can still be transferred, extended or deleted by its owner. | For evidence that must never vanish, burn ownership to `0x…dEaD`. |
| `executeBatch` is atomic; the order is always creates → patches → deletes → extensions → ownership changes. | Create + burn in one tx via `predictEntityKeys`. |
| `$owner` = current owner (changeable); `$creator` = creating wallet (immutable). | Authenticate with `.createdBy(addr)`. `project`/`entity_type` are namespaces, not auth. |
| Events: `EntityCreated`, `EntityPatched`, `ExpiryExtended`, `OwnershipTransferred`, `EntityDeleted`. The watcher sees ALL Arkiv ops, not your namespace. **No expiration event.** | Workers = WS events for creates + polling for silence/counts. |
| Bare number = `i32`, bigint = `u256`; timestamps/blocks must be `u64(...)` in writes AND queries. | Spec format uses explicit typed literals. |
| `ne`, `exists`, `hasType` are exported but rejected by the node. Supported: `eq`, `gt/gte/lt/lte`, `and/or/not`, `startsWith`. | Conditions use only supported predicates. |
| Results come newest-first by creation block; max page 200; pin `.atBlock()` for multi-page walks. | "Latest matching entity" = `limit(1)`. |
| Filtered count only via raw `arkiv_getEntityCount` with `{ query, block }`; SDK `getEntityCount()` is chain-wide. | `on_count` uses the raw RPC call. |
| Attribute names: lowercase snake_case, ≤32 bytes; ≤30 user attributes on create. | Schema follows this. |
| ~2 s blocks; `ExpirationTime.fromHours(1)` ≈ 1800 blocks. | All windows in blocks. |
| Keyless RPC ≈ 100 queries/hour/IP, then silent long `Retry-After` waits. | Server-side access key for workers + web proxy. Never in the browser. |
| Historical reads have short retention. | Disputes verify against evidence still live at head. |

---

## 2. Architecture

```
 CLI (create/seal/reveal/verify) ──signed spec, HTTPS──► Worker A / Worker B ──webhook──► Telegram/URL
        │ writes                                         │ writes receipts, reads + WS events
        ▼                                                ▼
   ───────────────────────── ARKIV (Tiramisu) ─────────────────────────
        ▲ reads (via server proxy with access key)
   Web (Next.js): triggers, receipts, workers, dispute verifier
```

**Kept off-chain by design:** sealed specs (worker's local store only), alert destinations (webhook URLs, chat IDs), all keys.

---

## 3. Entity schema (→ `/arkiv/schema.md`)

All entities carry `project="arkivate"` + `entity_type`. Attribute names are snake_case. Trust comes from `$creator`.

| Entity | Creator | Key attributes | Payload | Flags / ownership | Expiry |
|---|---|---|---|---|---|
| `worker` | worker | `version`, `modes` | `{name, endpoint}` | mutable | 1 day, extended every ~6h (dead workers vanish) |
| `trigger` (public) | owner | `cond_type`, `status`, `created_at:u64` | spec JSON, action always `notice` | `permissionlessExtension:true` | owner picks, default 7d |
| `sealed` | owner (fresh wallet) | `commitment`, `worker` (addr), `created_at:u64` | none | `readonly` | spec life + dispute window |
| `acceptance` | worker | `sealed` (key), `commitment`, `accepted_block:u64` | none | readonly + permissionlessExtension, **burned to dEaD** | 30d |
| `receipt` | worker | `trigger` (key), `mode`, `epoch`, `fired_block:u64`, `evidence_block:u64` | public: `{matched_keys, summary}` · sealed: `{result_hash}` only | readonly + permissionlessExtension, **burned** | 30d |
| `reveal` | sealed's creator | `sealed` (key) | `{spec, salt}` | readonly, **burned** | 30d |

How the commitment works:
- `commitment = keccak256(canonical_json(spec) ‖ salt32)`.
- The spec covers the **condition + action type only**. The webhook URL / chat ID is never in it and never touches Arkiv, not even hashed (hashed secrets = DQ).
- Acceptance is burned so a worker can't delete its promise to escape a dispute.

**What we deliberately keep OFF Arkiv:** sealed specs before reveal, all alert destinations, any identity, signing keys and access keys.

---

## 4. Trigger spec + conditions

```jsonc
{
  "v": 1,
  "cond": {
    "type": "on_create",                 // on_create | on_silence | on_count
    "where": [
      ["eq", "project", {"str": "door_ledger"}],
      ["eq", "entity_type", {"str": "halt"}]
    ],
    "created_by": "0xTRUSTED…",          // → .createdBy()
    "silence_blocks": 1800,              // on_silence only (~1h)
    "count_op": "lte", "count_value": 0  // on_count only
  },
  "action": { "type": "notice" }         // public: notice | sealed: webhook | telegram
}
```

Typed literals (`{"u64": "123"}`, `{"str": "x"}`) map to SDK `u64()` / `str()`, so we never hit the silent `i32` mismatch.

| Condition | Fires when | Dedupe epoch |
|---|---|---|
| `on_create` | A new matching entity appears | `trigger:matched_key` |
| `on_silence` | The newest matching entity *created by X* is older than N blocks | `trigger:last_seen_key` (one firing per silence episode) |
| `on_count` | Filtered count crosses the threshold (raw RPC) | `trigger:block_bucket` |

**Extension-attack defence:** anyone can extend anyone's entity, so `on_silence` never asks "did it expire?". It checks the creation block of the newest entity *from the trusted creator*. An attacker extending an old heartbeat changes nothing.

---

## 5. Worker loop

```
start:
  register/extend worker entity
  load active public triggers + accepted sealed jobs (local store)
  WS watchEntityEvents → EntityCreated:
      cheap owner filter → getEntity → eval on_create
  every 30 s: eval on_silence + on_count (pinned atBlock)
  every 5 min: catch-up query (dropped WS) + refresh trigger list
  every 6 h: extend own worker entity

fire(trigger, epoch, evidence):
  if receipt exists for (trigger, epoch): skip        ← another worker won
  sleep(jitter by worker rank, 0–8 s); re-check
  act (notice = receipt only; webhook = POST with Idempotency-Key: epoch)
  executeBatch: create receipt + changeOwnership → 0x…dEaD
```

**`POST /sealed` hand-off** — body `{ sealed_key, spec, salt, destination, signature }`. The worker:
1. Reads the `sealed` entity.
2. Checks `keccak(canonical(spec)‖salt) == commitment`.
3. Checks `recoverMessageAddress(signature) == sealed.$creator`.
4. Checks `sealed.worker == me`.
5. Stores the job locally.
6. Writes the burned `acceptance` (create + burn in one batch).

**Honest race note:** two workers can both fire inside the jitter window. The first receipt by block is canonical; the idempotency key lets receivers drop duplicates. Say this in the README.

---

## 6. Dispute verification (`arkivate verify <sealed_key>` + web page)

1. Load `sealed` → commitment, chosen worker, creator.
2. Load `reveal` (same creator) → recompute hash. Mismatch = invalid reveal.
3. Load the worker's `acceptance`. None = worker never accepted, no fault.
4. Re-run the condition over entities created after `accepted_block`.
5. Match at block B with no receipt from that worker within the grace window → **SKIPPED: provable censorship.**

Output: a verdict + every entity key and block, so anyone can re-check with curl.

**Limitation (state it):** historical reads depend on provider retention, so verify against evidence still live at head (readonly/burned records).

---

## 7. All on-chain transactions

All are Arkiv native entity ops (txs to `0x44…44`, gas in testnet GLM). **No smart contracts, no other chains.**

| # | Transaction | Signer | SDK call | When |
|---|---|---|---|---|
| 1 | Register worker | worker | `createEntity` | First start |
| 2 | Worker heartbeat | worker | `extendEntity` | Every ~6h |
| 3 | Create public trigger | owner | `createEntity` | User action |
| 4 | Pause/resume trigger | owner | `patchEntity` (`status`) | User action |
| 5 | Keep a trigger alive | anyone | `extendEntity` | Optional |
| 6 | Seal commitment | owner (fresh wallet) | `createEntity` | User action |
| 7 | Accept sealed job | worker | `executeBatch` (create + `changeOwnership`→dEaD) | After valid hand-off |
| 8 | Fire receipt | worker | `executeBatch` (create + burn) | Each firing |
| 9 | Reveal | owner | `executeBatch` (create + burn) | Disputes only |
| 10 | Demo feed events | demo wallet | `createEntity` | Video only |

**Off-chain:** webhook/Telegram delivery, the sealed spec hand-off (HTTPS), all reads (queries + WS events cost access-key quota, not gas).

---

## 8. Stack, environment, packages

**Language:** TypeScript end to end. **Runtime:** Node 22 LTS. **Package manager:** pnpm workspaces.

```
arkivate/
├─ packages/core    # spec types (zod), canonical hash, spec → query, verify logic
├─ packages/worker  # daemon: WS + pollers + POST /sealed   → npx arkivate-worker
├─ packages/cli     # create | pause | seal | handoff | reveal | verify | demo-feed
├─ apps/web         # Next.js: triggers, receipts, workers, verifier
├─ arkiv/schema.md · arkiv/friction.md
└─ LICENSE (MIT) · README.md · WALLETS.md
```

| Need | Package |
|---|---|
| Arkiv | `@arkiv-network/sdk@0.8.1` (pin exact). `ExpirationTime`/`jsonToPayload` from root; `str`/`u64`/`addr`/`key` from `/attr`; `eq`/`and`/`render` from `/query`; `tiramisu` from `/chains` |
| EVM utils | `viem@2.56.3` (pin exact; pairing others tested with 0.8): `keccak256`, `concat`, `toBytes`, `recoverMessageAddress`, `privateKeyToAccount`, `http`, `webSocket` |
| Canonical JSON | `canonicalize` (RFC 8785 → identical hashes across machines) |
| Validation / CLI | `zod`, `commander` |
| Worker HTTP | Express (comfort zone) or `hono` — only `POST /sealed` + `/health` |
| Worker store | `lowdb` JSON file (avoids native sqlite builds) |
| Dev | `tsx`, `typescript`, `vitest`, `dotenv`, `pino` |
| Web | Next.js 15 + Tailwind; server route = allowlisted read proxy holding the access key + short cache |
| Alerts | Telegram Bot API via plain `fetch` |

**`.env` (never committed):**
```
ARKIV_RPC_HTTP=https://rpc.tiramisu.db-chain.testnet.arkiv.network
ARKIV_RPC_WS=wss://rpc.tiramisu.db-chain.testnet.arkiv.network
ARKIV_ACCESS_KEY=...          # server-side only
WORKER_PRIVATE_KEY=0x...
OWNER_PRIVATE_KEY=0x...
TELEGRAM_BOT_TOKEN=...
PUBLIC_ENDPOINT=https://worker-a...
```

**Deploy (must stay up until 23 Oct):**
- Web on Vercel.
- Worker A on Railway or Fly.io (always-on).
- Worker B on a *different* host, to prove independence.
- Avoid free tiers that sleep.

**Setup checklist (tonight):**
1. Create 4 wallets: owner, fresh-owner, worker A, worker B. Add Tiramisu to MetaMask.
2. Faucet each (Hub → Faucet, SIWE + captcha). Log friction.
3. Get an access key (Hub → Access Keys).
4. Hello-world: create → read → select → WS events.

---

## 9. Code shapes (confirm against installed `.d.ts`; mismatches = friction entries)

```ts
import { createPublicClient, createWalletClient, ExpirationTime, jsonToPayload } from "@arkiv-network/sdk";
import { tiramisu } from "@arkiv-network/sdk/chains";
import { str, u64, key } from "@arkiv-network/sdk/attr";
import { eq } from "@arkiv-network/sdk/query";
import { http, keccak256, concat, stringToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import canonicalize from "canonicalize";

const headers = { "X-API-KEY": process.env.ARKIV_ACCESS_KEY! };
export const reader = createPublicClient({ chain: tiramisu, cacheTime: 0,
  transport: http(process.env.ARKIV_RPC_HTTP, { fetchOptions: { headers } }) });
export const wallet = createWalletClient({ chain: tiramisu,
  transport: http(process.env.ARKIV_RPC_HTTP, { fetchOptions: { headers } }),
  account: privateKeyToAccount(process.env.WORKER_PRIVATE_KEY as `0x${string}`) });

// commitment — both parts hex: concat([Uint8Array, hexString]) silently drops the salt
// (caught by packages/core/src/commit.test.ts; see packages/core/src/commit.ts)
export const commit = (spec: unknown, salt32: `0x${string}`) =>
  keccak256(concat([stringToHex(canonicalize(spec)!), salt32]));

// create + burn atomically (acceptance / receipt / reveal)
const DEAD = "0x000000000000000000000000000000000000dEaD";
const [{ key: k, salt }] = await reader.predictEntityKeys({ owner: wallet.account.address, count: 1 });
await wallet.executeBatch({
  creates: [{ salt, payload: jsonToPayload(body), contentType: "application/json",
    attributes: { project: "arkivate", entity_type: "receipt", trigger: key(triggerKey),
                  epoch, fired_block: u64(head) },
    expires: ExpirationTime.fromDays(30),
    flags: { readonly: true, permissionlessExtension: true } }],
  ownershipChanges: [{ entityKey: k, newOwner: DEAD }],
});

// newest matching entity from a trusted creator (on_silence)
const page = await reader.select({ key: true, attributes: true })
  .where(eq("project", str("demo_feed")), eq("entity_type", str("heartbeat")))
  .createdBy(trusted).limit(1).fetch();
```

---

## 10. Demo (≤3 min)

1. **(0:00) Hook:** "Seven teams built seven private watchers; Arkiv emits nothing on expiry. This is the shared one."
2. **(0:20) Public trigger fires:** receipt in the web feed + Telegram alert.
3. **(0:50) Kill worker A:** worker B still fires; the receipt's `$creator` changes.
4. **(1:20) Sealed trigger:** Arkiv shows only a hash, yet the alert still arrives.
5. **(1:50) Worker B "censors" a sealed job:** the owner reveals → verifier shows **SKIPPED: provable**.
6. **(2:30) Close:** on vs off Arkiv, the extension-attack defence, MIT, one-command workers.

Use the synthetic `demo_feed` for controllable timing. Before relying on Door Ledger data, read their `arkiv/schema.md` so your `where` clause matches their attribute names and types exactly.

---

## 11. Build schedule

| When | Deliverable |
|---|---|
| **Thu night** | Wallets, faucet, access key, hello-world. Start `friction.md`. Repo + MIT + monorepo skeleton. |
| **Fri** | `core` + public-mode worker (WS, pollers, receipts, dedupe) + CLI `create`/`demo-feed`. **Public trigger firing end-to-end.** |
| **Sat** | Sealed mode (`seal`, hand-off, acceptance, Telegram) + `reveal`/`verify` CLI + web app + deploy both workers + web. |
| **Sun** | Fixes, video, `schema.md`, README, WALLETS.md, submission answers. **Submit by ~18:00.** |

**Cut order if behind:**
1. Web verifier page (keep the CLI verify).
2. `on_count`.
3. Telegram (use a request bin instead).

**Never cut:** the friction report, sealed commit + receipts, two workers.

---

## 12. Gate checklist

- [ ] Public deployment openable without access (web + verifier)
- [ ] Reproducible steps in README (run a worker, create a trigger, seal, verify)
- [ ] Public repo, MIT
- [ ] `/arkiv/schema.md`, `/arkiv/friction.md` (numbered, with repro + versions)
- [ ] Wallet addresses that create entities (WALLETS.md + submission form)
- [ ] Demo video ≤3 min
- [ ] All entities synthetic; no personal data; no secrets (destinations never on-chain)
- [ ] No git history rewrite after the deadline; deployments up until 23 Oct
