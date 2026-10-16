# Arkivate: Arkiv data expires. Arkivate reacts.

Open-source triggers for Arkiv data, run by an open network of workers that leave a burned, public
receipt for every reaction, so a skipped job can be proven.

| | |
|---|---|
| **Network** | Arkiv Tiramisu testnet, chain ID `7738577` |
| **Tracks** | Open Source · Censorship Resistance · Privacy |
| **Live app** | TODO: Vercel URL |
| **worker-1 `/health`** | TODO: Cloud Run URL |
| **worker-2 `/health`** | TODO: Cloud Run URL |
| **Demo video** | TODO: link |
| **License** | [MIT](LICENSE) |

> Testnet only. All data is synthetic.

## TL;DR

- **Problem:** every Arkiv entity expires, but Arkiv emits no expiry event, so every app writes its
  own watcher, and the automation that does exist runs on one operator who can skip a job silently
  and sees everything you automate.
- **What it does:** you post a trigger ("when X happens on Arkiv, do Y"); any worker in an open
  network watches for it, and the first to act writes a readonly receipt burned to `0x…dEaD`, so
  nobody can delete it, the worker included.
- **Reactivate:** a trigger can keep data alive. The worker extends the entity and writes its receipt
  in one atomic transaction, up to a cap you set.
- **Sealed triggers:** only a salted hash of your trigger goes on Arkiv. The spec and the alert
  destination go privately to one worker you choose; the destination never touches Arkiv, not even
  hashed.
- **Provable censorship:** if that worker skips your sealed job, you reveal the spec and anyone can
  run `verify` and get `SKIPPED`, using public reads only.

## Contents

1. [The problem, and who has it](#the-problem-and-who-has-it)
2. [How Arkivate works](#how-arkivate-works)
3. [Conditions and actions](#conditions-and-actions)
4. [Why this pillar](#why-this-pillar)
5. [Why Arkiv](#why-arkiv)
6. [How Arkivate uses Arkiv](#how-arkivate-uses-arkiv)
7. [Try it yourself (for judges)](#try-it-yourself-for-judges)
8. [What works, and what doesn't yet](#what-works-and-what-doesnt-yet)
9. [Key decisions and trade-offs](#key-decisions-and-trade-offs)
10. [Entity schema](#entity-schema)
11. [Friction report](#friction-report)
12. [Code tour](#code-tour)
13. [Tests](#tests)
14. [Deployment](#deployment)
15. [Run it locally](#run-it-locally)
16. [Wallets](#wallets)
17. [Tech stack and credits](#tech-stack-and-credits)
18. [How this was built](#how-this-was-built)
19. [Roadmap](#roadmap)
20. [Acknowledgments and license](#acknowledgments-and-license)

## The problem, and who has it

**Expiry is silent.** Every Arkiv entity has a lifespan, and when it ends the entity is simply gone.
The event stream has `EntityCreated`, `EntityPatched`, `ExpiryExtended`, `OwnershipTransferred` and
`EntityDeleted`, but no expiry event, because expiry happens without a transaction
([F12](arkiv/friction.md#f12--no-expiration-event-expiry-has-to-be-detected-by-sweeping)). A read
of a missing entity can't even say whether it expired or was deleted
([F13](arkiv/friction.md#f13--noentityfounderror-cant-tell-expired-from-deleted-or-never-existed)).

**Every team writes its own watcher.** Apps built on Arkiv, for example Door Ledger, Lapse, Arkiv
Canary and Fine Print Ledger, need some form of "notice when this changes, renew it before it
expires, alert me when it dies", and each implements it inside its own app.

**Automation today has one operator.** Whoever runs the cron job or the bot can skip a job and
nobody can prove it, can be pressured to stop, and sees every rule you automate, including the ones
that reveal what you hold or care about.

**Intended users:**

- Arkiv app builders who need reactions to their data without running watcher infrastructure.
- People who need data kept alive (a listing, a registration, a record) past its default lifetime.
- Anyone who needs an alert when public data changes, goes quiet or dies, without telling the world
  what they are watching.

## How Arkivate works

[![Arkivate architecture](docs/assets/architecture.png)](docs/assets/architecture.png)

A trigger owner posts a trigger (public) or a commitment (sealed). Workers watch Arkiv, react, and
write receipts back to Arkiv. Sealed specs and alert destinations travel only over HTTPS to one
chosen worker. Anyone can verify what happened from public reads.

### Flow 1: Reactivate (keep-alive)

Real run on Tiramisu: listing **L1** `0x132af2af…` (`demo_feed`, `kind = listing`, created with
`permissionlessExtension`), keep-alive trigger `0xd4ce919d…` with `lead_blocks 40`,
`extend_blocks 120`, `max_extensions 2` ([spec](backend/cli/examples/keep-alive.json)).

1. **Post** the trigger: a `trigger` entity whose payload is the full spec
   ([tx `0x92c875e1…`](https://tiramisu.explorer.arkiv.network/tx/0x92c875e15eb26af4342f2817feaa8d5acfdde8181be9f832687351a12da61e7c), block 654706).
2. **Index** the deadline: every worker indexes L1's `expiresAt` (654818) and sweeps it against the
   head every 10 s.
3. **Fire** at `654818 − 40`: at block 654778 the head enters the lead window. worker-1 (rank 0)
   checks that no registered worker has a receipt for this epoch yet.
4. **Extend and receipt, atomically:** one `executeBatch` extends L1 to `ExpirationTime.atBlock(654938)`,
   creates a readonly receipt (`outcome = extended`, `old_expires_at 654818`, `new_expires_at 654938`)
   and transfers it to `0x…dEaD`. L1 is extended if and only if the receipt exists
   ([tx `0xc96671e0…`](https://tiramisu.explorer.arkiv.network/tx/0xc96671e0142a42133a1ae09978c56ad9ee050b461aa64e795c6b88fc4a865501), block 654781).
5. **Repeat** for the new deadline: 654938 → 655058
   ([tx `0x90d93bbb…`](https://tiramisu.explorer.arkiv.network/tx/0x90d93bbb2360bab050080415e387a25ab8ff4cccf502b606bec8da68eb95d299), block 654901).
6. **Stop at the cap:** two `extended` receipts exist (counted across all registered workers, not
   just this one), so the third firing writes `outcome = cap_reached` and leaves L1 to expire at 655058
   ([tx `0x8c414a7d…`](https://tiramisu.explorer.arkiv.network/tx/0x8c414a7d2031a9ff1e5eb121313da56275225c2a407407953117d3dc599a24d4), block 655021).

If the target isn't extendable by the worker (no `permissionlessExtension`, not owned by it), the
receipt says `not_extendable` and nothing else happens
([tx `0x5fa6ff10…`](https://tiramisu.explorer.arkiv.network/tx/0x5fa6ff10dfb91170fc0c00b266b611b935585a47a8944f354727fde2885200a3)).

### Flow 2: Expire, renew, delete

The expiry engine ([`backend/worker/src/expiry.ts`](backend/worker/src/expiry.ts)) keeps a persisted
index `entity key → expiresAt` for everything a trigger watches, rebuilt every 5 minutes at one
pinned block and kept fresh by WebSocket events in between.

| Event | How a worker detects it | Real run |
|---|---|---|
| **Expired** | 10 s sweep: head ≥ `expiresAt`, then re-read; gone and no delete seen → expired | canary `0x89538f96…`, `expiresAt 654834`, confirmed at head 654838, receipt mined at 654841 |
| **Renewed** | `ExpiryExtended` over WebSocket, or a later `expiresAt` found on rebuild | `on_extend` fired for `0xbd8b1748…` at 654773; the `on_expiring` trigger on the same entity re-armed for the new deadline and fired at 654988 |
| **Deleted** | `EntityDeleted` over WebSocket, or the entity vanishing **before** its known `expiresAt` | `on_delete` fired for `0x5a06771e…` at 654775; the `on_expire` trigger on the same entity never fired |

`NoEntityFoundError` is the same for "expired", "deleted" and "never existed". The engine tells them
apart from evidence it already holds: a seen delete event, or a disappearance before the deadline
(expiry can't come early), means deleted; otherwise expired.

### Flow 3: Sealed trigger

1. **Commit:** the owner computes `commitment = keccak256(canonical_json(spec) ‖ salt32)` locally and
   posts a `sealed` entity holding only the commitment and the chosen worker's address, from a
   separate wallet ([tx `0xa75c6e40…`](https://tiramisu.explorer.arkiv.network/tx/0xa75c6e4005441d5f1dcaa9317789eedf6bc5dfef37e422eabd964aed9f9a040c)).
2. **Hand off:** the owner sends `{ spec, salt, destination }` to the worker's `POST /sealed`, signed
   with EIP-191 over the sealed key, commitment, worker address and a local-only digest of the
   destination. The worker checks the entity names it, the spec and salt open the commitment, and
   the signer is the sealed entity's `$creator`.
3. **Accept:** the worker writes a burned `acceptance` (commitment, sealed creator, `accepted_block`),
   so it can't withdraw the promise later
   ([tx `0x7adc6a94…`](https://tiramisu.explorer.arkiv.network/tx/0x7adc6a94b9d9d5d65f0767c374b60d424ca02adfbbb1220dff5d67ade12dabfd)).
4. **Fire:** when the condition holds, the worker delivers to the webhook or Telegram chat, then
   writes a burned receipt whose `epoch` is `keccak256(salt ‖ raw_epoch)` and whose payload is only
   `{ result_hash }` ([example tx `0x5e552402…`](https://tiramisu.explorer.arkiv.network/tx/0x5e552402804fb769ed6c567b075d181357c95ecc62f827720a7e4bc7b7ee0ec4)).

### Flow 4: Provable censorship

Real run: sealed `0x24087b8f…` names **worker-2**, which ran with the demo switch `SKIP_SEALED=true`
(accept sealed jobs, never fire them).

1. worker-2 **accepted** at block 655806.
2. A matching event `0xb9e5ac49…` was **created** at block 655860
   ([tx `0x62576981…`](https://tiramisu.explorer.arkiv.network/tx/0x625769815b1b1493eecad5bf066fe0e29bc2e365e3a438d3ee2e3101ca85183e)).
   worker-1's sealed jobs on the same event fired within 4–6 blocks.
3. The **deadline** passed at 655860 + 150 = **656010** with no sealed receipt from worker-2.
4. The owner **revealed** `{ spec, salt }` in a burned `reveal` at 655904
   ([tx `0x734f711f…`](https://tiramisu.explorer.arkiv.network/tx/0x734f711f49f36c40f1d43274c809b12ba113421ca254de4a7da001cc48eb7979)).
5. **`verify`** recomputes the commitment, finds worker-2's burned acceptance, replays the condition
   (hit at 655860), finds no receipt whose epoch matches `keccak256(salt ‖ "create:0xb9e5ac49…")`
   by 656010, and returns **`SKIPPED`**.

Honest caveat: the event had a 60-minute lifetime, and `verify` replays the condition at the current
head, so today the same command returns `NOT_TRIGGERED`. Replaying at block 656100 returns `SKIPPED`
with every step passing. See [What works, and what doesn't yet](#what-works-and-what-doesnt-yet) and
[`docs/verification.md`](docs/verification.md).

### The worker network

**Anyone runs a worker.** A worker is the same open-source process on any host, with its own
wallet. It announces itself with a `worker` entity (name, version, public hand-off endpoint), signed
by that wallet, with a 1-day lifetime that it extends every 6 hours. A worker that stops simply
drops out when its entity expires.

**Dedupe for N workers.** Each worker lists the live `worker` entities and sorts their creator
addresses; its position is its rank. Rank 0 fires immediately; rank *n* waits *n* × 12 s (capped at
36 s), then re-checks Arkiv for a receipt from any registered worker for the same `(trigger, epoch)`
and skips if one exists. First receipt wins; everyone else skips. Receipts from addresses without a
live `worker` entity are ignored, so they can't be used to suppress firings.

**Failover, measured with the reference workers** (block time is 2 s):

| Case | Event block → receipt mined | Source |
|---|---|---|
| worker-1 (rank 0) fires | 3–4 blocks (6–8 s) in most firings | public receipts by `0xBd9d…` |
| worker-1 down, worker-2 (rank 1) fires | 650462 → 650472: 10 blocks (20 s), about the 12 s slot more | receipt `0xda13afc2…` by `0xDE94…` |
| worker-1 up, worker-2 sees its receipt and skips | 5 epochs skipped by worker-2 as a peer; the one duplicate came from the earlier 2 s slot (F7) | worker-2 job store, receipts on Arkiv |

**`$creator` shows who acted.** Each worker signs with its own wallet, so every receipt's `$creator`
is the worker that fired it, and nobody else can write a receipt in its name.

### Join the network

```bash
git clone https://github.com/NatX223/Arkivate.git && cd Arkivate
corepack enable && pnpm install
pnpm wallets                 # prints fresh keys + addresses; writes nothing
cp .env.example .env         # WORKER_NAME, WORKER_PRIVATE_KEY, ARKIV_ACCESS_KEY
# fund the worker address: https://hub.arkiv.network/faucet
pnpm worker
```

What it needs:

- **A funded wallet** (testnet GLM). Unfunded, the worker runs in read-only dry-run mode and logs
  what it would fire.
- **An Arkiv access key** (recommended): a worker polls constantly and the keyless RPC allows about
  100 queries per hour per IP.
- **Optional:** `PUBLIC_ENDPOINT` to accept sealed hand-offs, `TRIGGER_CREATORS` to run only public
  triggers from addresses you choose (a gas guard), `TELEGRAM_BOT_TOKEN` for Telegram delivery.

The worker isn't published to npm yet, so there is no `npx` one-liner; it runs from a clone. Hosting
on Cloud Run is in [`docs/deployment.md`](docs/deployment.md).

## Conditions and actions

| Condition | Fires when | One receipt per (epoch) | Detected by |
|---|---|---|---|
| `on_create` | a new entity matching `where` (and `created_by`, if set) is created after the trigger | matched entity: `create:<key>` | `EntityCreated` over WebSocket, batched every 2 s; 5-minute catch-up query |
| `on_silence` | the newest matching entity from the trusted `created_by` is older than `silence_blocks`, or none is live | silence episode: `silence:<last key>` | 30 s poll (uses creation block, so extending an old heartbeat can't mask silence) |
| `on_count` | the filtered count satisfies `count_op count_value` | ~1 h bucket: `count:<head / 1800>` | 30 s poll via raw `arkiv_getEntityCount` |
| `on_expiring` | head ≥ deadline − `lead_blocks` | deadline: `expiring:<subject>:<deadline>` | 10 s sweep of the expiry index |
| `on_expire` | the deadline has passed and the entity is gone (`follow`), or the pinned deadline has passed (`pinned`) | deadline: `expire:<subject>:<deadline>` | 10 s sweep, then a re-read |
| `on_extend` | the entity's expiry moved later | new expiry: `extend:<subject>:<new_expires_at>` | `ExpiryExtended`, or a later `expiresAt` on rebuild |
| `on_delete` | the entity was deleted | once: `delete:<subject>` | `EntityDeleted`, or gone before its deadline |

Expiry conditions watch one entity (`watch: { entity_key }`) or every entity matching a query
(`watch: { where, created_by? }`). Literals are typed (`{str}`, `{u64}`, `{addr}`, …) so a spec can
never fall into the bare-number-is-`i32` trap. Spec reference: [`arkiv/schema.md`](arkiv/schema.md#trigger).

| Action | Usable in | What happens |
|---|---|---|
| `extend` (Reactivate) | public triggers, with `on_expiring` only | extend to `old_expires_at + extend_blocks` in the same batch as the receipt; `max_extensions` ≤ 100, counted across all registered workers; outcomes `extended` / `not_extendable` / `cap_reached` |
| `notice` | public triggers | the burned receipt is the whole effect: a public, permanent "this happened" |
| `webhook` | sealed triggers | `POST` JSON to the private URL, with `Idempotency-Key` = the hashed epoch |
| `telegram` | sealed triggers | a bot message to the private chat; needs `TELEGRAM_BOT_TOKEN` on the worker |

`on_extend` + `extend` is rejected as a loop, and `extend` after `on_expire` / `on_delete` is rejected
because there is nothing left to extend.

**Follow vs pinned deadlines.** `follow` (default) measures against the entity's current
`expiresAt`, so a renewal moves the deadline and re-arms `on_expiring`. `pinned` records `expiresAt`
the first time the trigger sees the entity and never moves it. Pinned exists because
`ExpiryExtended` doesn't say who extended
([F14](arkiv/friction.md#f14--extendentity-sets-an-expiry-rather-than-adding-to-it-and-expiryextended-doesnt-say-who-extended)):
with `permissionlessExtension`, anyone can keep postponing a `follow` deadline. Real run on
`0xa84e0021…`, extended 654852 → 654952: the pinned `on_expire` fired at 654853, the follow one at
654953.

## Why this pillar

### Censorship Resistance

*Who is harmed if automation is censored or shut down?* The person whose listing lapses, whose alert
never arrives, whose deadline passes unnoticed. With a single operator, the operator can be
pressured to drop a job, or skip it, and there is no record either way.

Here every firing is a public receipt that nobody can delete, signed by the worker that acted. Any
number of independent workers can run the same trigger, and if one goes down the next fires. For a
sealed job assigned to one worker, a skip is provable: the acceptance is burned, the reveal is
burned, and `verify` turns "it never fired" into `SKIPPED` from public reads.

### Privacy

*Who is harmed if automations leak?* An automation reveals intent: "alert me if X halts" says "I
hold X" or "I depend on X". On a public chain, a public trigger tells everyone.

A sealed trigger puts only `keccak256(spec ‖ salt)` and the chosen worker on Arkiv. Alert
destinations (webhook URLs, Telegram chat IDs) go only to that worker and never touch Arkiv, not
even hashed. We found and fixed a leak in our own design
([F17](arkiv/friction.md#f17--our-design-worth-a-line-in-arkivs-privacy-docs-hashes-of-public-data-arent-private-on-arkiv)):
sealed receipts first published `keccak256("create:" + matched_key)`, which anyone can brute-force
over public entity keys (two sealed jobs on the same event produced identical epochs,
receipts `0x591e449e…` and `0x33aba737…`). The epoch now mixes in the job's secret salt.

Residual leak, stated plainly: a sealed receipt reveals **that** a sealed trigger fired and **when**
(`evidence_block`), and which worker ran it. It never reveals **what** it watched or **where** the
alert went.

### Open Source

*Who is harmed if the trigger engine is closed?* Every Arkiv app that has to write, host and trust
its own watcher. Arkivate is one MIT-licensed engine with a shared spec any Arkiv app can post to,
and an open worker network anyone can join with one command and their own wallet. Receipts,
acceptances and worker registrations are all plain Arkiv entities, so other apps can read and build
on them without our code.

## Why Arkiv

| Built on… | What would break |
|---|---|
| Postgres behind our API | The operator could edit or delete receipts; "it never fired" would be our word against yours. |
| IPFS | Content is immutable, but there is no queryable "receipts for trigger T, epoch E", no expiry, and no native notion of who wrote it. |
| A subgraph or indexer | Another party to trust for every read, and a lag between the chain and the answer. |
| Arkiv | Entities have a lifespan (the thing we react to), receipts can be made readonly and ownerless, attribute queries answer "has anyone fired this epoch?" directly, and `$creator` authenticates every write. |

**Kept off Arkiv on purpose:** alert destinations (URLs, chat IDs), sealed specs before a reveal, the
destination digest the hand-off signature covers, private keys, access keys, and any real identity.
Our sealed-flow test scanned every live `project = arkivate` entity (attributes and payloads, plain
and hex) for the test destinations and their digests: 0 hits.

## How Arkivate uses Arkiv

| Arkiv feature | Where in code | Why |
|---|---|---|
| Entity expiration | every write; `worker` 1 day ([`chain.ts`](backend/worker/src/chain.ts)), receipts 30 days | the lifespan is what triggers react to; a dead worker drops out by itself |
| `ExpirationTime.atBlock` | Reactivate extension in [`chain.ts`](backend/worker/src/chain.ts) `writeReceipt`; CLI `demo-feed --extend` | extend to an exact block; durations count from now, not from the current expiry (F14) |
| `extendEntity` | worker heartbeat and re-registration ([`chain.ts`](backend/worker/src/chain.ts)) | keeps the worker's registration alive |
| `permissionlessExtension` | triggers ([`cli`](backend/cli/src/index.ts) `create`), receipts, acceptances, `listing` demo data | lets a worker (or anyone) keep useful data alive; checked before Reactivate ([`engine.ts`](backend/worker/src/engine.ts)) |
| `readonly` | receipts, acceptances, sealed, reveals | evidence can't be edited |
| Ownership transfer to `0x…dEaD` (`ownershipChanges`) | [`chain.ts`](backend/worker/src/chain.ts), CLI `reveal`, web reveal | burned evidence can't be deleted, even by its creator |
| `executeBatch` + `predictEntityKeys` | [`chain.ts`](backend/worker/src/chain.ts) | create + burn (+ extend) in one atomic transaction; writes are serialised per wallet because predicted keys are nonce-derived |
| `$creator` trust via `.createdBy` / `$creator = addr(…)` | [`query.ts`](backend/core/src/query.ts), [`verify.ts`](backend/core/src/verify.ts), [`handoff.ts`](backend/worker/src/handoff.ts) | the only authentication Arkiv offers; `project` / `entity_type` / `$owner` are never trusted |
| Typed `u64` attributes | [`entities.ts`](backend/core/src/entities.ts), typed literals in [`spec.ts`](backend/core/src/spec.ts) | blocks and timestamps compare correctly; a bare number would be `i32` and match nothing |
| Live events: `EntityCreated`, `ExpiryExtended`, `EntityDeleted` | [`engine.ts`](backend/worker/src/engine.ts) `watchEntityEvents` | push path for `on_create`, `on_extend`, `on_delete` and the expiry index |
| Filtered count via raw `arkiv_getEntityCount` | [`conditions.ts`](backend/core/src/conditions.ts) `countMatching` | `on_count`; the SDK's `getEntityCount()` is chain-wide only (F4) |
| Pinned `atBlock` pagination | [`expiry.ts`](backend/core/src/expiry.ts) `snapshotWatch`, [`conditions.ts`](backend/core/src/conditions.ts) `evalOnSilence` | consistent multi-page snapshots of the watched set |
| `patchEntity` | trigger pause/resume (`status`), worker endpoint update | mutable state only where it belongs |

**Measurements** (Tiramisu, 16 Oct 2026; block time 2 s):

| Metric | Value | Source |
|---|---|---|
| Gas per write | 105k–169k gas = 0.00011–0.00017 GLM at 1 gwei. Public receipt 138,488; Reactivate (receipt + extend + burn) 168,952; sealed receipt 136,600; acceptance 130,384; seal 105,384; reveal 120,424 | `eth_getTransactionReceipt` on the txs in this README |
| Write latency (send → receipt) | 2.7–15.6 s for identical writes | [F15](arkiv/friction.md#f15--write-latency-varies-a-lot-27-s-to-156-s-on-2-s-blocks) |
| Event → receipt mined (rank 0) | 3–4 blocks typical; up to 18 when one worker fires many triggers at once (writes are serialised per wallet) | `evidence_block` vs creation block of every public receipt |
| Expiry detection lag | 4 blocks (`expiresAt 654834`, confirmed at 654838) | [F12](arkiv/friction.md#f12--no-expiration-event-expiry-has-to-be-detected-by-sweeping) |
| Failover delay | ~12 s rank slot; measured 20 s event → receipt with worker-2 alone vs 6–8 s for rank 0 | receipts above |

## Try it yourself (for judges)

You need MetaMask on Tiramisu (the site offers to add the network) and testnet GLM from
https://hub.arkiv.network/faucet. Reading and verifying need no wallet at all.

1. **See a Reactivate run.** Open TODO: live URL `/triggers/0xd4ce919d7651b3ecf926360b660a893dfe1c73265d72a918027f8f62aaf9aa19`:
   two `extended` receipts and one `cap_reached`, each created by worker-1 and owned by `0x…dEaD`.
   TODO: this trigger expires at block 697906; extend it (it is `permissionlessExtension`) before
   judging, or point to a fresh one.
2. **Create a keep-alive trigger.** Create → preset **Keep my listing alive** → sign. Watch the
   trigger page: a worker's receipt appears in the lead window, with the new expiry. Note: the
   reference workers only run public triggers from allowlisted creators (`TRIGGER_CREATORS`, see
   [What works](#what-works-and-what-doesnt-yet)); TODO: confirm which path judges take.
3. **Seal a trigger.** Create → mode **Sealed** → choose a worker → enter a webhook URL or Telegram
   chat ID → sign. Arkiv gets only the commitment; download the salt backup when offered. The trigger
   page shows the worker's burned acceptance.
4. **Verify a skip.** Open TODO: live URL `/verify/<sealed key>` for a SKIPPED example. TODO: the
   staged example `0x24087b8f…` now returns `NOT_TRIGGERED` because its evidence expired; re-stage
   it with long-lived evidence before judging.
5. **Fail on purpose.** Open TODO: live URL `/verify/0xe90e2e92de1c06a236927da947483bf2d7dcf46ac9c3466ceec6227108739f6a`:
   its published reveal doesn't hash to the commitment, so the verdict is `INVALID_REVEAL`. To make
   your own: seal with the CLI, edit one field of `spec` in a copy of `~/.arkivate/sealed/<key>.json`,
   then `pnpm cli reveal <key> --file <copy>` and `pnpm cli verify <key>`.

**Verify without the UI.** These run against the public RPC with no key. Receipts of the keep-alive
trigger (expect three, owner `0x…dead`, outcomes `extended`, `extended`, `cap_reached`):

```bash
curl -s https://rpc.tiramisu.db-chain.testnet.arkiv.network -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"arkiv_query","params":["project = str('"'"'arkivate'"'"') AND entity_type = str('"'"'receipt'"'"') AND trigger = key(0xd4ce919d7651b3ecf926360b660a893dfe1c73265d72a918027f8f62aaf9aa19)",{"select":{"key":true,"creator":true,"owner":true,"attributes":true}}]}'
```

worker-2's receipts for the skipped sealed job (expect `"data":[]`):

```bash
curl -s https://rpc.tiramisu.db-chain.testnet.arkiv.network -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"arkiv_query","params":["project = str('"'"'arkivate'"'"') AND entity_type = str('"'"'receipt'"'"') AND trigger = key(0x24087b8fb21b1f4e4571a4fd3a6d03170e967176a165fefcc2c9133b07973ec7) AND $creator = addr(0xDE94088D98368A81079a897a2278cc52BEeC3D1C)",{"select":{"key":true}}]}'
```

The matching event, read at block 655870 (`0xa01fe`) although it has since expired (expect
`0xb9e5ac49…`, `createdAt 0xa01f4` = 655860):

```bash
curl -s https://rpc.tiramisu.db-chain.testnet.arkiv.network -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"arkiv_query","params":["project = str('"'"'arkivate'"'"') AND entity_type = str('"'"'demo_feed'"'"')",{"select":{"key":true,"createdAt":true},"atBlock":"0xa01fe"}]}'
```

`pnpm cli verify <sealed-key>` prints a curl command like these for every read it makes.

**One real transaction per step:**

| Step | Transaction |
|---|---|
| worker-1 registers | [`0x00aaedd1…`](https://tiramisu.explorer.arkiv.network/tx/0x00aaedd115e0ccbca221e87e2cb54f9c5031cc9098aa4439102471b0eda1bcc1) |
| worker-2 registers | [`0x6f220b70…`](https://tiramisu.explorer.arkiv.network/tx/0x6f220b70ce8e00c230a0a8267e8deffb0e21b0d37b1e820815adbbb14b354200) |
| Post a keep-alive trigger | [`0x92c875e1…`](https://tiramisu.explorer.arkiv.network/tx/0x92c875e15eb26af4342f2817feaa8d5acfdde8181be9f832687351a12da61e7c) |
| Reactivate: extend + receipt + burn | [`0xc96671e0…`](https://tiramisu.explorer.arkiv.network/tx/0xc96671e0142a42133a1ae09978c56ad9ee050b461aa64e795c6b88fc4a865501) |
| Reactivate: `cap_reached` | [`0x8c414a7d…`](https://tiramisu.explorer.arkiv.network/tx/0x8c414a7d2031a9ff1e5eb121313da56275225c2a407407953117d3dc599a24d4) |
| Seal (commitment only) | [`0xa75c6e40…`](https://tiramisu.explorer.arkiv.network/tx/0xa75c6e4005441d5f1dcaa9317789eedf6bc5dfef37e422eabd964aed9f9a040c) |
| Worker accepts (burned) | [`0x7adc6a94…`](https://tiramisu.explorer.arkiv.network/tx/0x7adc6a94b9d9d5d65f0767c374b60d424ca02adfbbb1220dff5d67ade12dabfd) |
| Matching event | [`0x62576981…`](https://tiramisu.explorer.arkiv.network/tx/0x625769815b1b1493eecad5bf066fe0e29bc2e365e3a438d3ee2e3101ca85183e) |
| Sealed receipt (`result_hash` only) | [`0x5e552402…`](https://tiramisu.explorer.arkiv.network/tx/0x5e552402804fb769ed6c567b075d181357c95ecc62f827720a7e4bc7b7ee0ec4) |
| Reveal (burned) | [`0x734f711f…`](https://tiramisu.explorer.arkiv.network/tx/0x734f711f49f36c40f1d43274c809b12ba113421ca254de4a7da001cc48eb7979) |

## What works, and what doesn't yet

**Works, tested on Tiramisu:**

- All seven conditions, with receipts on Arkiv; Reactivate including `not_extendable` and
  `cap_reached`; expired vs deleted; follow vs pinned; a restart mid-countdown still fires.
- Multi-worker dedupe and failover with the reference workers.
- Sealed triggers end to end: commit, signed hand-off, burned acceptance, webhook delivery, salted
  receipt and reveal. `verify` verdicts: all eight are unit-tested; `SKIPPED`, `FIRED`,
  `INVALID_REVEAL`, `PENDING` and `NOT_TRIGGERED` have been seen against Tiramisu data.
- Web app: browse triggers, receipts and workers; create public and sealed triggers signed in
  MetaMask; reveal and verify.

**Doesn't, or only partly:**

- **`verify` replays at the current head, so old evidence decays.** Once the watched entities expire,
  an `on_create` job verifies as `NOT_TRIGGERED` (our staged SKIPPED example does today), and
  expiry conditions, `on_count`, `on_extend` and `on_delete` return `INCONCLUSIVE`. Arkiv can't
  tell expired from deleted, and its history retention is undocumented
  ([F19](arkiv/friction.md#f19--historical-reads-work-but-their-retention-is-undocumented-so-dispute-evidence-has-no-known-shelf-life)).
  `atBlock` reads still worked 13,300 blocks back, so the fix is to replay at the reveal's block.
- **The reference workers are allowlisted.** They run with `TRIGGER_CREATORS` set so strangers can't
  drain their gas with spam triggers. Open use needs owner-funded triggers (roadmap) or your own
  worker. The allowlist doesn't cover sealed hand-offs yet; the per-trigger hourly receipt cap does.
- **Dedupe is timing-based.** Arkiv has no conditional create
  ([F7](arkiv/friction.md#f7--no-atomic-create-if-absent-so-multi-worker-dedupe-is-timing-based-and-we-shipped-duplicate-receipts-once)),
  so a primary that stalls past its slot causes a duplicate receipt. We shipped one with a 2 s slot
  (receipts `0x644479c6…` and `0x6728e06d…`); after moving to 12 s slots, 4 of 4 concurrent firings
  produced exactly one receipt. Consumers should treat `(trigger, epoch)` as idempotent.
- **No `npx` worker yet**: run it from a clone.
- **Workers advertise `modes = public`** even though they accept sealed jobs; the attribute isn't
  read by anything yet.

## Key decisions and trade-offs

1. **No contracts.** Rules live in the schema, and correctness is checked off-chain by workers and
   by `verify` from public reads.
   *Cost:* nothing on-chain enforces "one receipt per epoch" or "the worker must fire"; we prove
   violations instead of preventing them.
2. **Burn to `0x…dEaD` rather than `readonly` alone.** `readonly` stops edits but the owner could
   still delete; transferring ownership to the dead address in the same batch removes that.
   *Cost:* nobody can ever clean up a mistaken receipt, so a duplicate (F7) is permanent.
3. **Follow vs pinned deadlines.** Both, because "renewals count" and "nobody may postpone this" are
   both real needs and `ExpiryExtended` can't tell them apart.
   *Cost:* pinned deadlines live in the worker's local store, so `verify` can't replay them.
4. **Receipts are the dedupe source of truth.** Workers coordinate only through receipts on Arkiv,
   with rank-based backoff; no gossip, no leader.
   *Cost:* a 12 s delay per rank on failover, and a small duplicate risk under inclusion latency.
5. **Destinations stay off-chain.** URLs and chat IDs exist only on the owner's machine and the
   chosen worker's store.
   *Cost:* you must trust that one worker with the destination; a dispute proves a skip, not what was
   delivered.
6. **Cap delays instead of dropping.** A trigger over its hourly receipt cap is skipped for now and
   fires once the window has room, rather than being marked handled.
   *Cost:* a noisy trigger is late, not silenced, and keeps costing gas.
7. **Run TypeScript from source.** `tsx` everywhere, Next transpiles the shared core; no build step.
   *Cost:* cold starts compile on the fly, and the web app needs the webpack `.js` → `.ts` alias (F18).

## Entity schema

| Entity | Creator | Owner | Flags | Lifetime |
|---|---|---|---|---|
| `worker` | worker wallet | worker | none | 1 day, extended every 6 h |
| `trigger` | trigger owner | trigger owner | `permissionlessExtension` | owner's choice (CLI default 7 days) |
| `receipt` | worker | `0x…dEaD` | `readonly` + `permissionlessExtension` | 30 days |
| `sealed` | sealed owner (separate wallet) | sealed owner | `readonly` | job lifetime (default 7 days) |
| `acceptance` | worker | `0x…dEaD` | `readonly` + `permissionlessExtension` | 30 days |
| `reveal` | sealed creator | `0x…dEaD` | `readonly` | 30 days |
| `demo_feed` | demo wallet | demo wallet | `listing`: `permissionlessExtension` | minutes or blocks |

Every entity carries `project = "arkivate"` and `entity_type`. Full attribute tables, epochs and
payloads: [`arkiv/schema.md`](arkiv/schema.md).

## Friction report

19 entries, each with a repro: [`arkiv/friction.md`](arkiv/friction.md). The ones that shaped the
design:

- [F12](arkiv/friction.md#f12--no-expiration-event-expiry-has-to-be-detected-by-sweeping): no expiry event; expiry must be detected by sweeping deadlines.
- [F13](arkiv/friction.md#f13--noentityfounderror-cant-tell-expired-from-deleted-or-never-existed): `NoEntityFoundError` can't tell expired from deleted.
- [F14](arkiv/friction.md#f14--extendentity-sets-an-expiry-rather-than-adding-to-it-and-expiryextended-doesnt-say-who-extended): `extendEntity` sets an expiry rather than adding to it, and `ExpiryExtended` doesn't say who extended.
- [F7](arkiv/friction.md#f7--no-atomic-create-if-absent-so-multi-worker-dedupe-is-timing-based-and-we-shipped-duplicate-receipts-once): no conditional create, so multi-writer dedupe is timing-based.
- [F4](arkiv/friction.md#f4--filtered-arkiv_getentitycount-is-undocumented-and-an-unknown-param-silently-returns-the-chain-wide-count): filtered `arkiv_getEntityCount` is undocumented, and a typo in its params silently counts the whole chain.
- [F17](arkiv/friction.md#f17--our-design-worth-a-line-in-arkivs-privacy-docs-hashes-of-public-data-arent-private-on-arkiv): hashes of public data aren't private on Arkiv; salt everything.

## Code tour

```
backend/
├─ core/src/              @arkivate/core: shared by worker, CLI and web
│  ├─ index.ts            browser-safe exports (no env, no keys)
│  ├─ server.ts           server-only exports: config + wallets
│  ├─ spec.ts             TriggerSpec v1 (zod): conditions, actions, combination rules
│  ├─ query.ts            spec → Arkiv query expression, typed literals, $creator
│  ├─ conditions.ts       on_create / on_silence / on_count evaluators, filtered count RPC
│  ├─ expiry.ts           live reads, watch snapshots at a pinned block, expiry epochs
│  ├─ entities.ts         attribute builders for every entity (source of truth for the schema)
│  ├─ records.ts          read helpers: triggers, receipts, workers
│  ├─ commit.ts           commitment = keccak256(canonical JSON ‖ salt), random salt
│  ├─ sealed.ts           hand-off message, salted sealed epochs, sealed entity attributes
│  ├─ verify.ts           dispute verification (verdict state machine + curl re-checks)
│  ├─ config.ts           env loading + validation; errors name the variable, never the value
│  ├─ reader.ts           Tiramisu clients with the access-key header
│  └─ wallet.ts           wallet clients from env
├─ worker/src/            @arkivate/worker: one process per worker identity
│  ├─ index.ts            boot, registration, heartbeat, GET /health
│  ├─ engine.ts           trigger loop: events, pollers, rank backoff, dedupe, firing
│  ├─ expiry.ts           expiry index + 10 s sweep, expired vs deleted, pinned deadlines
│  ├─ chain.ts            every write: register, acceptance, receipt (+ extend) as burned batches
│  ├─ handoff.ts          POST /sealed: verify signature + commitment, write acceptance
│  ├─ deliver.ts          webhook / Telegram delivery, errors scrubbed of secrets
│  └─ store.ts            local lowdb job store (fired epochs, index, sealed jobs)
├─ cli/src/index.ts       arkivate CLI: create, pause, list, seal, handoff, reveal, verify, demo-feed
├─ cli/examples/          ready-to-post specs for every condition
└─ scripts/               hello.ts (Phase 0 smoke test), gen-wallets.ts
frontend/src/             Next.js 15 app: triggers, receipts, workers, create, verify, docs
├─ app/api/rpc/route.ts   read-only RPC proxy that adds the access key server-side
└─ lib/                   data loading, wallet (MetaMask), sealed salt storage, hand-off
arkiv/                    schema.md, friction.md (judge-required)
docs/                     technical plan, verification, deployment, local setup, structure, assets
```

## Tests

```bash
pnpm test        # vitest: 39 tests in 3 files, all passing
pnpm typecheck   # tsc -b across all packages, clean
pnpm hello       # Phase 0 smoke test against Tiramisu (needs a funded owner wallet)
```

Unit tests cover the pure logic in `backend/core`. Behaviour that depends on the chain or timing was
checked with live runs on Tiramisu, and the evidence is on Arkiv.

| Invariant | Checked by |
|---|---|
| Commitment is key-order independent | `commit` › "is independent of object key order (RFC 8785 canonical JSON)"; `commitment + salt` › "is stable across key order" |
| Commitment hashes exactly `utf8(canonical) ‖ salt` | `commit encoding` › "hashes exactly utf8(canonical) ‖ salt bytes" |
| Sealed epochs don't link jobs | `sealed epoch privacy` › "differs across jobs for the same matched entity (salted), and is stable per job" |
| Hand-off signature binds the destination | `hand-off signature (EIP-191)` › "recovers the signer, and binds the destination" |
| Every verdict | `verifySealed` › 13 cases, NOT_FOUND through SKIPPED, including "SKIPPED when the only receipt is too late" and "falls back to the acceptance once the sealed entity has expired" |
| Untyped literals are rejected | `TriggerSpec` › "rejects untyped literals (the silent i32 trap)" |
| Only node-supported operators | `TriggerSpec` › "rejects operators the node does not support" |
| No Reactivate loops | `extend action (Reactivate)` › "rejects on_extend + extend as a loop" |
| One receipt per epoch across workers | live run: 4/4 concurrent firings, one receipt each (commit `b4c2fb7`); worker-2 skipped 5 epochs worker-1 had fired |
| Pinned deadline survives restart | live run "restart mid-countdown" (commit `88b5294`); the pinned map is persisted in the job store |
| Reactivate is atomic and capped | live run L1 above: two `extended`, then `cap_reached` |

There are no automated tests for the worker loop or the web app.

## Deployment

The web app runs on Vercel; the reference workers worker-1 and worker-2 run on Google Cloud Run in
different regions (TODO: regions), each with its own wallet, secret and storage bucket. Any operator
can add more workers the same way, or on any host with Node 22.

- Web app: TODO: live URL
- worker-1: TODO: `https://…/health`
- worker-2: TODO: `https://…/health`

Commands, flags and env tables: [`docs/deployment.md`](docs/deployment.md).

## Run it locally

```bash
corepack enable && pnpm install
pnpm wallets && cp .env.example .env     # paste keys; fund at https://hub.arkiv.network/faucet
pnpm hello                               # smoke test
pnpm worker                              # terminal 1
pnpm cli create backend/cli/examples/keep-alive.json   # terminal 2 (set created_by to your owner address)
pnpm cli demo-feed --kind listing --blocks 120
pnpm web                                 # http://localhost:3000
```

| Variable | Worker | CLI | Web |
|---|---|---|---|
| `WORKER_PRIVATE_KEY` | **Required** | | |
| `WORKER_NAME` | Recommended | | |
| `ARKIV_ACCESS_KEY` | Recommended | Optional | Recommended (server-only) |
| `PUBLIC_ENDPOINT` | For sealed hand-offs | | |
| `TELEGRAM_BOT_TOKEN` | For Telegram delivery | | |
| `TRIGGER_CREATORS`, `MAX_RECEIPTS_PER_TRIGGER_PER_HOUR`, `CORS_ORIGINS`, `DATA_DIR`, `WORKER_PORT` | Optional | | |
| `SKIP_SEALED` | Demo switch only | | |
| `OWNER_PRIVATE_KEY` | | For `create`, `pause`, `demo-feed` | |
| `SEALED_OWNER_PRIVATE_KEY` | | For `seal`, `handoff`, `reveal` | |
| `ARKIV_RPC_HTTP`, `ARKIV_RPC_WS` | Optional (Tiramisu default) | Optional | Optional |

Full guide: [`docs/run-locally.md`](docs/run-locally.md).

## Wallets

The four addresses that create entities on Tiramisu, with their roles: [`WALLETS.md`](WALLETS.md).

## Tech stack and credits

| Component | Version | License | Used for |
|---|---|---|---|
| [Arkiv SDK](https://www.npmjs.com/package/@arkiv-network/sdk) `@arkiv-network/sdk` | 0.8.1 | MIT | every read and write |
| [viem](https://viem.sh) | 2.56.3 | MIT | transports, signing, hashing |
| [Next.js](https://nextjs.org) + React | 15.5.28 / 19.1.0 | MIT | web app |
| [Tailwind CSS](https://tailwindcss.com) | 4.3.3 | MIT | web styling |
| [Express](https://expressjs.com) | 5.3.0 | MIT | worker HTTP (`/health`, `/sealed`) |
| [zod](https://zod.dev) | 4.6.7 | MIT | spec and env validation |
| [canonicalize](https://www.npmjs.com/package/canonicalize) | 5.1.0 | Apache-2.0 | RFC 8785 canonical JSON for commitments |
| [lowdb](https://github.com/typicode/lowdb) | 7.0.1 | MIT | worker job store |
| [pino](https://getpino.io) | 10.4.0 | MIT | worker logs |
| [commander](https://github.com/tj/commander.js) | 15.0.0 | MIT | CLI |
| [dotenv](https://github.com/motdotla/dotenv) | 18.0.8 | BSD-2-Clause | local env loading |
| [tsx](https://tsx.is), TypeScript, Vitest | 4.23.15 / 5.9.3 / 5.0.5 | MIT / Apache-2.0 / MIT | run from source, typecheck, tests |

## How this was built

Solo build for the hackathon, AI-assisted with Claude Code. Design decisions, the trade-offs above
and all testing were done by hand against the Tiramisu testnet; every number and transaction in this
README comes from those runs. Friction was logged as it happened, not reconstructed afterwards.

## Roadmap

- **Preserve:** archive an entity's payload and attributes before it expires (a new action).
- **Owner-funded triggers:** the trigger owner pays for its own receipts, so workers can drop the
  allowlist and accept anyone.
- **Replay at the reveal block** in `verify`, so disputes don't decay with the evidence (F19).
- **More delivery targets** for sealed triggers (email relay, Matrix, Discord), still off-chain.
- **A shared cross-app trigger schema** so any Arkiv app can post triggers without Arkivate's code.
- **Worker reputation** computed from public data: receipts written vs provable skips per worker.
- **Publish the worker to npm** for a one-command `npx` start.

## Acknowledgments and license

Built for **Arkiv: Global Tour Stop**. Thanks to the Arkiv team for the SDK, the Tiramisu testnet and
the faucet. This project is independent; no endorsement by Arkiv is implied.

MIT licensed: see [LICENSE](LICENSE).
