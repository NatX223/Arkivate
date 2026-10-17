# Friction report

SDK: @arkiv-network/sdk@0.8.1 · viem@2.56.3 · Node 22.22.0 · Network: Tiramisu (7738577)
Tooling: pnpm 9.15.9 · TypeScript 5.9.3 · Windows 11 (Git Bash)

Entries are numbered in the order we hit them, and the numbers are cited from code comments and
commits, so they stay fixed. Index, Arkiv entries first:

| Area | Entries |
|---|---|
| **Arkiv: SDK** | [F1](#f1--duplicate-sdk-copies-make-u64--expirationtime-values-not-assignable-to-the-sdks-own-types) duplicate SDK copies break branded types · [F2](#f2--no-access-key-option-in-the-sdk-header-must-be-wired-through-viem-by-hand) no access-key option · [F3](#f3--tiramisu-chain-object-has-no-blockexplorers) no `blockExplorers` · [F14](#f14--extendentity-sets-an-expiry-rather-than-adding-to-it-and-expiryextended-doesnt-say-who-extended) `extendEntity` sets rather than adds · [F16](#f16--entities-with-nothing-to-store-still-need-a-payload-and-a-content-type) payload required |
| **Arkiv: node / RPC** | [F4](#f4--filtered-arkiv_getentitycount-is-undocumented-and-an-unknown-param-silently-returns-the-chain-wide-count) filtered count undocumented, unknown params ignored · [F5](#f5--query-result-order-is-undocumented) result order undocumented · [F7](#f7--no-atomic-create-if-absent-so-multi-worker-dedupe-is-timing-based-and-we-shipped-duplicate-receipts-once) no conditional create · [F8](#f8--the-event-watcher-cant-be-filtered-and-creation-time-isnt-queryable) unfiltered events, `$createdAt` not queryable · [F12](#f12--no-expiration-event-expiry-has-to-be-detected-by-sweeping) no expiry event · [F13](#f13--noentityfounderror-cant-tell-expired-from-deleted-or-never-existed) expired vs deleted · [F15](#f15--write-latency-varies-a-lot-27-s-to-156-s-on-2-s-blocks) write latency spread · [F19](#f19--historical-reads-work-but-their-retention-is-undocumented-so-dispute-evidence-has-no-known-shelf-life) history retention undocumented |
| **Arkiv: privacy model** | [F17](#f17--our-design-worth-a-line-in-arkivs-privacy-docs-hashes-of-public-data-arent-private-on-arkiv) hashes of public data aren't private |
| **Arkiv: Hub / faucet** | [F6](#f6--faucet-cooldown-makes-funding-a-multi-wallet-project-take-hours) faucet cooldown · [F20](#f20--the-access-key-quota-ran-out-without-warning-mid-deploy-and-a-429-at-startup-crash-looped-the-workers) quota ran out without warning; every query costs 100 units |
| **[tooling]** (not Arkiv) | [F9](#f9--tooling-windows-locks-prevented-renaming-workspace-folders) Windows folder locks · [F10](#f10--tooling-private-key-pasted-without-the-0x-prefix) key without `0x` · [F11](#f11--tooling-a-duplicated-env-block-silently-blanked-the-worker-key) duplicated `.env` key · [F18](#f18--tooling-nextjs-turbopack-cant-import-a-workspace-package-written-as-esm-typescript) Turbopack and `.js` imports |

Common setup for the SDK snippets below (`npx tsx repro.ts`, Node 22.22.0):

```ts
import { createPublicClient, createWalletClient, ExpirationTime, jsonToPayload } from "@arkiv-network/sdk";
import { tiramisu } from "@arkiv-network/sdk/chains";
import { key, str, u64 } from "@arkiv-network/sdk/attr";
import { eq } from "@arkiv-network/sdk/query";
import { http, webSocket } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RPC = "https://rpc.tiramisu.db-chain.testnet.arkiv.network";
const client = createPublicClient({ chain: tiramisu, transport: http(RPC) });
const wsClient = createPublicClient({ chain: tiramisu, transport: webSocket("wss://rpc.tiramisu.db-chain.testnet.arkiv.network") });
const wallet = createWalletClient({ chain: tiramisu, transport: http(RPC), account: privateKeyToAccount(process.env.KEY as `0x${string}`) });
```

## F1 — Duplicate SDK copies make `u64()` / `ExpirationTime` values "not assignable" to the SDK's own types
- **When:** 2026-10-15 23:45 BST
- **What I did:** In a pnpm workspace, added `@arkiv-network/sdk@0.8.1` to `backend/core` (then `packages/core`) while the
  root had TypeScript 7.0.2, then pinned root TypeScript to 5.9.3 and imported the SDK from a root
  script as well. Ran `tsc -b`.
- **Expected:** `createEntity({ attributes: { created_at: u64(Date.now()) }, expires: ExpirationTime.fromMinutes(10) })` typechecks.
- **Actual:** pnpm installed two copies of the SDK because its install path is suffixed with
  the resolved TypeScript peer: `@arkiv-network+sdk@0.8.1_typescript@5.9.3_…` and
  `…_typescript@7.0.2_…`. Values created by one copy are rejected by the other:
  `error TS2322: Type 'U64Value' is not assignable to type 'ValueInput'. Property '[validated]' is missing in type ... but required in type ...`
  and `error TS2741: Property '[validated]' is missing in type 'Lifetime' but required in type 'Expiry'.`
  The SDK brands values with a `declare const validated: unique symbol`, so each copy has its own
  incompatible brand. The error never mentions duplication. You only find it by reading the
  `node_modules/.pnpm/...` paths in the message.
- **Versions:** `@arkiv-network/sdk@0.8.1` · `viem@2.56.3` · pnpm 9.15.9 · TypeScript 7.0.2 and 5.9.3 · Node 22.22.0
- **Steps to reproduce:**
  1. In a pnpm 9 workspace with a package `pkg`, run `pnpm add -Dw typescript` (resolved to 7.0.2 on the day).
  2. `pnpm --filter pkg add --save-exact @arkiv-network/sdk@0.8.1 viem@2.56.3`.
  3. `pnpm add -Dw typescript@5.9.3 @arkiv-network/sdk@0.8.1`.
  4. `ls node_modules/.pnpm | grep arkiv-network+sdk` lists two copies, one suffixed `_typescript@5.9.3_…` and one `_typescript@7.0.2_…`.
  5. In a root script, build `{ created_at: u64(Date.now()) }` with `u64` from `@arkiv-network/sdk/attr`, pass it as `attributes` to `createEntity` on a wallet created inside `pkg`, and run `tsc -b`: TS2322 / TS2741 as above.
- **Workaround:** Root `package.json`: `"pnpm": { "overrides": { "typescript": "5.9.3" } }`, then `pnpm install`, which collapses to one SDK instance.
- **Suggestion:** Brand with a string-keyed property (e.g. `__arkivValidated: true`) instead of a
  `unique symbol`, or validate at runtime only, so duplicate installs stay type-compatible. Mention
  "keep a single SDK instance in monorepos" in the docs.

## F2 — No access-key option in the SDK; header must be wired through viem by hand
- **When:** 2026-10-15 23:40 BST
- **What I did:** Read `dist/index.d.ts` for how to pass the Hub access key to `createPublicClient` / `createWalletClient`.
- **Expected:** An `accessKey` option, or a JSDoc example showing the header (the keyless RPC is rate-limited to ≈100 queries/hour/IP; measured in [F20](#f20--the-access-key-quota-ran-out-without-warning-mid-deploy-and-a-429-at-startup-crash-looped-the-workers): 10,000 units/hour at 100 units per query).
- **Actual:** There is no mention of access keys anywhere in `dist/` (`grep -ri "api-key\|apikey\|access.key"` finds nothing). Every example uses bare `http()`.
- **Versions:** `@arkiv-network/sdk@0.8.1` · `viem@2.56.3` · Node 22.22.0 · Tiramisu (7738577)
- **Steps to reproduce:**
  1. `pnpm add --save-exact @arkiv-network/sdk@0.8.1 viem@2.56.3`.
  2. `grep -rniE "api-key|apikey|access.?key|x-api" node_modules/@arkiv-network/sdk/dist/` returns nothing.
  3. Look for a key option on `createPublicClient` / `createWalletClient` in `dist/index.d.ts`: there is none; only viem's `http(url, { fetchOptions: { headers } })` can carry it.
- **Workaround:** `http(url, { fetchOptions: { headers: { "X-API-KEY": key } } })` in `backend/core/src/reader.ts`. The browser `WebSocket` / Node 22 global `WebSocket` cannot set custom headers, so it is still unclear how the key applies to the WS transport used by `watchEntityEvents`.
  **Update 2026-10-16:** `pnpm hello` step 7 passed with a plain `webSocket(url)` and no key: the
  `EntityCreated` event arrived. So WS subscriptions currently work keyless, but whether they count
  against the keyless rate limit, or get cut off under load, is undocumented.
- **Suggestion:** Export a helper such as `arkivTransport({ accessKey })` for HTTP and WS, and document the header name and the WS story on the Hub API-keys page.

## F3 — `tiramisu` chain object has no `blockExplorers`
- **When:** 2026-10-15 23:50 BST
- **What I did:** Tried to build explorer links from `tiramisu.blockExplorers.default.url`.
- **Expected:** viem chain definitions normally include the explorer, so `viem` utilities and wallets can link to transactions.
- **Actual:** `defineChain({ id: 7738577, name: "Tiramisu", ... })` in `dist/chains-*.js` sets no `blockExplorers` (the field is `undefined`).
- **Versions:** `@arkiv-network/sdk@0.8.1` · `viem@2.56.3` · Node 22.22.0 · Tiramisu (7738577)
- **Steps to reproduce:**
  1. Run `import { tiramisu } from "@arkiv-network/sdk/chains"; console.log(tiramisu.blockExplorers)`: prints `undefined`.
  2. `grep -c blockExplorers node_modules/@arkiv-network/sdk/dist/chains*.js` prints `0`.
- **Workaround:** Hardcoded `https://tiramisu.explorer.arkiv.network` in `backend/core/src/constants.ts`.
- **Suggestion:** Add `blockExplorers: { default: { name: "Arkiv Explorer", url: "https://tiramisu.explorer.arkiv.network" } }`.

## F4 — Filtered `arkiv_getEntityCount` is undocumented, and an unknown param silently returns the chain-wide count
- **When:** 2026-10-16 ~14:00 BST
- **What I did:** Needed a filtered count for the `on_count` condition. `client.getEntityCount()` takes no arguments, and `ArkivRpcSchema` declares `arkiv_getEntityCount` with `Parameters?: []`. Probed the raw RPC.
- **Expected:** Either a documented filtered form, or a clear error for unsupported params.
- **Actual:** A filtered form exists but is undocumented. Results against Tiramisu, compared with a full `select()` walk of the same query (9 entities):
  - `params: []` → `9570` (chain-wide)
  - `params: ["<query>"]` → `Invalid parameters were provided to the RPC method.`
  - `params: [{ query }]` → `9` ✓
  - `params: [{ query, atBlock: "0x…" }]` → `9` ✓
  - `params: [{ query, block: "0x…" }]` (the shape our design doc assumed) → `Invalid parameters…`
  - `params: [{ nonsense: 1 }]` → `9572`, **the chain-wide count, with no error**. A typo in the key name (`querry`) turns "count matching" into "count everything" silently.
- **Versions:** `@arkiv-network/sdk@0.8.1` · `viem@2.56.3` · Node 22.22.0 · Tiramisu (7738577)
- **Steps to reproduce:**
  1. With the common setup, `const query = render(eq("project", str("arkivate")))` (`render` from `@arkiv-network/sdk/query`).
  2. Cast `client.request` to an untyped function (the SDK's `ArkivRpcSchema` declares `arkiv_getEntityCount` with `Parameters?: []`).
  3. Call `arkiv_getEntityCount` with each of: `[]`, `[query]`, `[{ query }]`, `[{ query, atBlock: "0x…" }]`, `[{ query, block: "0x…" }]`, `[{ nonsense: 1 }]`.
  4. Compare with the length of a full `client.select({ key: true }).where(...)` walk of the same query. Results on Tiramisu are listed under **Actual**.
- **Workaround:** Call the raw RPC with exactly `[{ query, atBlock }]`, built from the SDK's `render()`, and sanity-check that the result is below the unfiltered count.
- **Suggestion:** Expose `getEntityCount({ where, atBlock })` in the SDK, add the params to `ArkivRpcSchema`, and have the node reject unknown keys.

## F5 — Query result order is undocumented
- **When:** 2026-10-16 ~15:00 BST
- **What I did:** Needed "the newest entity from creator X" for the `on_silence` condition. Searched the SDK source (`query/engine.ts`, `queryResult.ts`, `queryBuilder.ts`) and README for ordering.
- **Expected:** A documented sort order (or an `orderBy`), since `$createdAt` cannot be used in a predicate (it is "returned in query results but carries no index").
- **Actual:** No mention of ordering anywhere in the SDK. Observed on Tiramisu: results come back newest-first by creation block (two triggers created ~5 blocks apart; three `demo_feed` events), but nothing guarantees it.
- **Versions:** `@arkiv-network/sdk@0.8.1` · `viem@2.56.3` · Node 22.22.0 · Tiramisu (7738577)
- **Steps to reproduce:**
  1. From one wallet, create three entities a few blocks apart with `attributes: { project: "f5", seq: u64(i) }`.
  2. `client.select({ key: true, createdAt: true }).where(eq("project", str("f5"))).limit(5).fetch()` and print each `createdAt`: newest first.
  3. `grep -rni "order" node_modules/@arkiv-network/sdk/dist/*.d.ts` and the SDK README: no documented order and no `orderBy`.
- **Workaround:** Fetch a page (limit 50) and take the max `createdAt` in JavaScript instead of trusting `limit(1)`.
- **Suggestion:** Document the order as part of the query contract, or add `orderBy("$createdAt", "desc")`.

## F6 — Faucet cooldown makes funding a multi-wallet project take hours
- **When:** 2026-10-16, while funding wallets for Phase 1 (worker-2) and Phase 2 (`sealed_owner`)
- **What I did:** Funded our four wallets (owner, sealed_owner, worker-1, worker-2) at https://hub.arkiv.network/faucet. Each claim needs a SIWE sign-in and a captcha.
- **Expected:** Fund all four wallets in one sitting. A multi-party design like ours, or any app that separates identities as the "trust = `$creator`" model encourages, needs several funded addresses on day one.
- **Actual:** After a claim, the next one is locked for about **1 hour**. Funding worker-2 was blocked mid-session; the two-worker test waited on the cooldown, and `sealed_owner` is still waiting for its turn. Each claim gives 10 GLM, yet our whole Phase 1 test run cost worker-1 about 0.001 GLM, so one claim is worth thousands of writes. The limit is about frequency, not amount.
- **Versions:** Arkiv Hub faucet (https://hub.arkiv.network/faucet), 2026-10-16 · MetaMask SIWE sign-in
- **Steps to reproduce:**
  1. Sign in at the faucet with SIWE, solve the captcha, and claim for address A (10 GLM arrive).
  2. Immediately request a claim for address B from the same Hub session.
  3. The claim is refused until about an hour after the first one.
- **Workaround:** Plan claims around the cooldown, and fund the wallets that write first (owner, then workers). Better: send GLM from an already-funded wallet with a plain viem `sendTransaction`, since one 10 GLM claim covers every wallet we have.
- **Suggestion:** Let one claim split across several addresses, or document the cooldown and the "transfer between your own wallets" pattern on the faucet page.

## F7 — No atomic "create if absent", so multi-worker dedupe is timing-based (and we shipped duplicate receipts once)
- **When:** 2026-10-16 ~17:30 BST
- **What I did:** Ran two independent workers on the same public trigger. Each checks for an existing receipt for `(trigger, epoch)` before writing; the backup worker waited 2 s and re-checked.
- **Expected:** Some way to make "exactly one receipt per epoch" hold across writers: a uniqueness constraint on attributes, a conditional create, or a deterministic key that two writers would collide on.
- **Actual:** None of these exists. Entity keys come from the *creator's* nonce (`predictEntityKeys({ owner })`), so two workers never collide, and nothing rejects a second receipt with the same attributes. Measured on Tiramisu: worker-1's receipt was mined **9.2 s** after the event's block (≈2 s detection + query + `executeBatch` waiting for the receipt). worker-2 re-checked at about +5–7 s, saw nothing, and wrote a duplicate, mined at +13.0 s. Both receipts are burned, so the duplicate is permanent: receipts `0x644479c6…` and `0x6728e06d…` for epoch `create:0xd8efa591…`.
- **Versions:** `@arkiv-network/sdk@0.8.1` · `viem@2.56.3` · Node 22.22.0 · Tiramisu (7738577)
- **Steps to reproduce:**
  1. Fund two wallets W1 and W2 and pick one trigger key `T` and epoch string `E`.
  2. In two processes, at the same moment: `client.select({ key: true }).where(eq("entity_type", str("receipt")), eq("trigger", key(T)), eq("epoch", str(E))).fetch()` returns no entities.
  3. W1 at once, W2 two seconds later: `const [p] = await client.predictEntityKeys({ owner, count: 1 })`, then `executeBatch({ creates: [{ salt: p.salt, payload: jsonToPayload({}), contentType: "application/json", attributes: { entity_type: "receipt", trigger: key(T), epoch: str(E) }, expires: ExpirationTime.fromDays(30), flags: { readonly: true } }], ownershipChanges: [{ entityKey: p.key, newOwner: "0x000000000000000000000000000000000000dEaD" }] })`.
  4. Both batches succeed, and the query from step 2 now returns two entities. On Tiramisu: receipts `0x644479c6…` (block 650284) and `0x6728e06d…` (block 650286), epoch `create:0xd8efa591…`.
- **Workaround:** Workers rank themselves by address and rank *n* waits *n* × 12 s before re-checking. After that change, 4/4 concurrent firings produced exactly one receipt. It is still probabilistic: a primary that stalls past its slot causes a duplicate, so consumers must treat `(trigger, epoch)` as idempotent.
- **Suggestion:** A conditional create (`createEntity({ …, ifAbsent: where(...) })`), or a key derived from caller-chosen content (e.g. `keccak(namespace ‖ id)`) that rejects a second create, would make cross-writer dedupe exact. Publishing typical inclusion latency would also help.

## F8 — The event watcher can't be filtered, and creation time isn't queryable
- **When:** 2026-10-16 ~16:30 BST
- **What I did:** Built the `on_create` path: react to new entities matching a filter (`project`, `entity_type`, `kind`, creator).
- **Expected:** Subscribe to `EntityCreated` filtered by creator or attributes, or at least poll "matching entities created after block N".
- **Actual:**
  - `watchEntityEvents` delivers every entity operation on the chain. `EntityCreated` carries only `entityKey`, `owner`, `expiresAt` and `creationFlags`, with no attributes, so each candidate needs a follow-up query to know whether it matters.
  - `$createdAt` can't be used in a predicate (it "carries no index"), so a catch-up for missed events can't ask "created since block N". It can only fetch a page of matches and filter in JavaScript, which misses anything that fell off the page.
- **Versions:** `@arkiv-network/sdk@0.8.1` · `viem@2.56.3` · Node 22.22.0 · Tiramisu (7738577)
- **Steps to reproduce:**
  1. `wsClient.watchEntityEvents({ onEntityCreated: (e) => console.log(e) })`.
  2. Create one entity from your wallet: its event carries `entityKey`, `owner`, `expiresAt` and `creationFlags` only, and events from every other wallet on the chain arrive too.
  3. `client.select({ key: true }).where(eq("$createdAt", u64(1))).fetch()` throws `InvalidPredicateError: "$createdAt" is returned in query results but carries no index`.
- **Workaround:** Pre-filter events by `owner` (the creator at creation time) when every trigger names a creator. Buffer keys for 2 s and send one query per trigger: `<filter> AND ($key = … OR $key = …)`. Catch up every 5 min with the newest 50 matches, filtered to `createdAt > trigger.createdAt`. **Update 18 Oct ([F20](#f20--the-access-key-quota-ran-out-without-warning-mid-deploy-and-a-429-at-startup-crash-looped-the-workers)):** one query per batch for all triggers, gated by a free `arkiv_getEntityCount` of `$key IN (batch) AND (filter OR …)`, because a trigger without a creator lets every new entity on the chain through the pre-filter.
- **Suggestion:** Index `$createdAt` (it is already an ordered `u64`), and/or allow a server-side filter on the event subscription (creator, `project` / `entity_type` attributes).

## F9 — [tooling] Windows locks prevented renaming workspace folders
- **When:** 2026-10-16 morning, restructuring `packages/*` + `apps/web` into `backend/*` + `frontend`
- **What I did:** `git mv packages/core backend/core`
- **Expected:** A directory rename.
- **Actual:** `fatal: renaming 'packages/core' failed: Permission denied`, even with no node processes running. VS Code held handles on the folders. Removing pnpm's `node_modules` (thousands of junctions) took over 2 minutes and the rename still failed.
- **Versions:** Windows 11 Pro · Git 2.40.0.windows.1 · pnpm 9.15.9 · VS Code with the repo open
- **Steps to reproduce:**
  1. Open the repo in VS Code after `pnpm install`.
  2. `git mv packages/core backend/core` fails with `Permission denied`.
  3. Stop all node processes, delete `node_modules` (over 2 minutes), and retry: the same error.
- **Workaround:** `git mv` each tracked file individually into the new tree (history is kept as renames), then `pnpm install`.
- **Suggestion:** None for Arkiv. Noted because it cost about 15 minutes.

## F10 — [tooling] Private key pasted without the `0x` prefix
- **When:** 2026-10-16, first `pnpm hello` run
- **What I did:** Pasted the owner key from a wallet export into `.env`.
- **Expected:** The key works.
- **Actual:** Our config validation rejected it: `OWNER_PRIVATE_KEY: must be a 0x-prefixed 32-byte hex private key`. The export had 64 hex characters without `0x`, which wallet exports often omit but viem's `privateKeyToAccount` requires.
- **Versions:** `viem@2.56.3` · our zod config validator · Node 22.22.0
- **Steps to reproduce:**
  1. Export a private key from a wallet that shows it as 64 hex characters without `0x`.
  2. Put it in `.env` as `OWNER_PRIVATE_KEY=<64 hex>`.
  3. `pnpm hello` stops with `OWNER_PRIVATE_KEY: must be a 0x-prefixed 32-byte hex private key`.
- **Workaround:** Added `0x`. Our validator names the variable without printing the value, which made this a one-minute fix.
- **Suggestion:** Arkiv docs and Hub pages that show keys could state the expected `0x…` format next to every key example.

## F11 — [tooling] A duplicated `.env` block silently blanked the worker key
- **When:** 2026-10-16 ~16:45 BST
- **What I did:** Added a second worker's block to `.env` (same variable names, empty key) to prepare the two-worker test.
- **Expected:** worker-1 keeps working.
- **Actual:** `dotenv` keeps the last value of a duplicated key, so the empty `WORKER_PRIVATE_KEY=` overrode the real one and the worker exited with `Missing required environment variable(s): WORKER_PRIVATE_KEY`.
- **Versions:** `dotenv@18.0.8` · Node 22.22.0
- **Steps to reproduce:**
  1. In `.env`, set `WORKER_PRIVATE_KEY=0x<key>`, then lower in the file add a second block that repeats `WORKER_PRIVATE_KEY=` with no value.
  2. `pnpm worker` exits with `Missing required environment variable(s): WORKER_PRIVATE_KEY`.
- **Workaround:** Renamed the second block to `WORKER_2_*` (a local convenience the code never reads). For the test run, worker-2's values were set in the shell, which takes precedence over `.env`.
- **Suggestion:** None for Arkiv. For us: one worker identity per `.env`, and set extra identities per process.

## F12 — No expiration event: expiry has to be detected by sweeping
- **When:** 2026-10-16 ~15:00 BST (Phase 1b, expiry engine)
- **What I did:** Built `on_expiring` / `on_expire`: "tell me when entity X is about to expire / has expired". Reacting to expiry is the core of Arkivate.
- **Expected:** An `EntityExpired` event alongside `EntityCreated`, `EntityPatched`, `ExpiryExtended`, `OwnershipTransferred` and `EntityDeleted`.
- **Actual:** `ENTITY_EVENTS_ABI` has no expiry event, and expiry happens without a transaction, so there is no log to watch. Every app that cares about expiry must keep its own index of deadlines and poll. Measured on Tiramisu: an entity with `expiresAt = 655058` was already absent at head `655058`, so **`expiresAt` is the first block the entity is gone**, not the last block it lives (also undocumented). Our sweep runs every ~5 blocks: canary `C1` (`expiresAt 654834`) was confirmed expired at head `654838`.
- **Versions:** `@arkiv-network/sdk@0.8.1` · `viem@2.56.3` · Node 22.22.0 · Tiramisu (7738577)
- **Steps to reproduce:**
  1. `wsClient.watchEntityEvents({ onEvent: (e) => console.log(e) })`.
  2. `const { entityKey } = await wallet.createEntity({ payload: jsonToPayload({}), contentType: "application/json", attributes: { project: "f12" }, expires: ExpirationTime.fromBlocks(60) })`, then read `expiresAt` with `client.getEntity(entityKey)`.
  3. Wait until the head passes `expiresAt` (about 2 minutes): no event for the key arrives, and `ENTITY_EVENTS_ABI` in the SDK has no expiry event.
  4. `client.getEntity(entityKey)` with the head equal to `expiresAt` already throws `NoEntityFoundError`.
- **Workaround:** The worker keeps an index `key → expiresAt` (persisted, so expiries during downtime are still caught), sweeps it every 10 s against the head (30 s since F20), and re-reads at the deadline to confirm.
- **Suggestion:** Emit `EntityExpired` from the node (even as a synthetic log per block), or offer a subscription such as "entities expiring within N blocks". Document whether `expiresAt` is inclusive.

## F13 — `NoEntityFoundError` can't tell expired from deleted (or never existed)
- **When:** 2026-10-16 ~15:00 BST
- **What I did:** At a deadline, re-read the watched entity to decide between `on_expire` and `on_delete`.
- **Expected:** A read that distinguishes "expired at block N" from "deleted at block N" from "unknown key".
- **Actual:** `getEntity` throws `NoEntityFoundError` for all three. The SDK source says so ("no live entity has that key — it never existed, or it was deleted or has expired"), and query results simply omit the entity. Historical reads (`atBlock`) have short retention, so you can't reliably look back either.
  **Update 2026-10-16 23:15:** the retention claim was an assumption. `atBlock` reads still worked 13,300 blocks back (see F19); how far back they work is undocumented.
- **Versions:** `@arkiv-network/sdk@0.8.1` · `viem@2.56.3` · Node 22.22.0 · Tiramisu (7738577)
- **Steps to reproduce:**
  1. Create entities A and B, each with `ExpirationTime.fromBlocks(30)`.
  2. `wallet.deleteEntity({ entityKey: A })`.
  3. Wait until the head passes B's `expiresAt`.
  4. `client.getEntity(A)`, `client.getEntity(B)` and `client.getEntity(<random 32-byte key>)` all throw `NoEntityFoundError` with the same message.
- **Workaround:** Combine evidence. A seen `EntityDeleted` event, or the entity vanishing *before* its known `expiresAt` (expiry can't come early), means deleted; otherwise expired. Tested: owner-deleted canary `C3` fired `on_delete`, and its `on_expire` trigger correctly never fired.
- **Suggestion:** A tombstone read such as `getEntityStatus(k) → { state: "expired" | "deleted", atBlock }`, or a `reason` field on `NoEntityFoundError`.

## F14 — `extendEntity` sets an expiry rather than adding to it, and `ExpiryExtended` doesn't say who extended
- **When:** 2026-10-16 ~15:00 BST
- **What I did:** Built the Reactivate action ("extend the entity by `extend_blocks` before it expires") and pinned deadlines (immune to third-party extensions).
- **Expected:** `extendEntity({ expires: ExpirationTime.fromBlocks(120) })` to add 120 blocks to the current expiry; the extension event to identify the extender.
- **Actual:**
  - Despite its name, `extendEntity` **sets** a new expiry, and durations count from *now*, not from the current expiry. The JSDoc says so, but the name invites the opposite reading: `fromBlocks(120)` on an entity with 200 blocks left is rejected ("would not move the expiry later") rather than adding 120.
  - `ExpiryExtendedEvent.owner` is the entity's owner, not the account that extended it. With `permissionlessExtension`, an observer can't tell an owner renewal from a third party's without fetching the transaction.
  - Positive: `ExpirationTime.atBlock(current + n)` was exact. The returned `expiresAt` matched the target in every case (`654927 → 655027`, `654852 → 654952`), and a non-owner (worker-2's wallet) extended a `permissionlessExtension` listing without issue.
- **Versions:** `@arkiv-network/sdk@0.8.1` · `viem@2.56.3` · Node 22.22.0 · Tiramisu (7738577)
- **Steps to reproduce:**
  1. Create E with `ExpirationTime.fromBlocks(100)` and `flags: { permissionlessExtension: true }`; read its `expiresAt`.
  2. `wallet.extendEntity({ entityKey: E, expires: ExpirationTime.fromBlocks(10) })` is rejected ("would not move the expiry later").
  3. `wallet.extendEntity({ entityKey: E, expires: ExpirationTime.atBlock(expiresAt + 100n) })` succeeds, and `getEntity(E).expiresAt` is exactly `expiresAt + 100n`.
  4. Extend E the same way from a second wallet while `watchEntityEvents({ onExpiryExtended })` runs: the event's `owner` is E's owner, and nothing in it names the second wallet.
- **Workaround:** Always extend to an absolute block, `ExpirationTime.atBlock(live.expiresAt + n)`. For pinned deadlines, record `expiresAt` at first sight and never move it, whoever extends.
- **Suggestion:** Add `ExpirationTime.by(n)` (relative to the current expiry), or rename the action to `setExpiry`. Include the transaction sender (`extendedBy`) in `ExpiryExtended`.

## F15 — Write latency varies a lot (2.7 s to 15.6 s) on ~2 s blocks
- **When:** 2026-10-16 ~15:00 BST
- **What I did:** Created 15 entities sequentially from one process during test setup, timing each `createEntity` call (send plus wait for receipt).
- **Expected:** Roughly 1–2 blocks per write.
- **Actual:** 8.7, 2.7, 6.6, 6.6, 6.4, 3.5, 15.4, 11.7, 15.6, 8.3, 11.8, 7.1, 5.2, 9.0 and 6.7 s. That is a spread of 1 to 8 blocks for identical writes from an idle wallet. It matters for anything time-boxed: our multi-worker dedupe slot (F7) and the expiry lead time (`lead_blocks`) both have to absorb the worst case.
- **Versions:** `@arkiv-network/sdk@0.8.1` · `viem@2.56.3` · Node 22.22.0 · Tiramisu (7738577)
- **Steps to reproduce:**
  1. From one funded, idle wallet: `for (let i = 0; i < 15; i++) { const t = performance.now(); await wallet.createEntity({ payload: jsonToPayload({ i }), contentType: "application/json", attributes: { project: "f15" }, expires: ExpirationTime.fromMinutes(10) }); console.log((performance.now() - t) / 1000) }`.
  2. Compare the 15 timings with the 2 s block time. Ours are listed under **Actual**.
- **Workaround:** 12 s per-rank dedupe slots; we recommend `lead_blocks ≥ 20` for Reactivate so an extension lands well before the deadline.
- **Suggestion:** Publish expected inclusion latency for Tiramisu, and say whether the SDK's receipt wait adds polling delay (the default poll interval may be part of the spread).

## F16 — Entities with nothing to store still need a payload and a content type
- **When:** 2026-10-16 ~15:30 BST (Phase 2, sealed triggers)
- **What I did:** Created the `sealed` and `acceptance` entities. All their meaning is in attributes (commitment, worker, block); there is no body.
- **Expected:** `payload` / `contentType` optional for attribute-only entities.
- **Actual:** `CreateEntityParameters` requires both (`payload: Uint8Array`, `contentType: MimeType | string`). Passing `new Uint8Array()` with `"application/octet-stream"` works on Tiramisu, but nothing documents that an empty payload is allowed, and the type suggests it isn't optional.
- **Versions:** `@arkiv-network/sdk@0.8.1` · `viem@2.56.3` · Node 22.22.0 · Tiramisu (7738577)
- **Steps to reproduce:**
  1. `wallet.createEntity({ attributes: { project: "f16" }, expires: ExpirationTime.fromMinutes(10) })`: TypeScript reports that property `payload` is missing.
  2. Add `payload: new Uint8Array(), contentType: "application/octet-stream"`: it typechecks and the create succeeds on Tiramisu.
- **Workaround:** `payload: new Uint8Array(), contentType: "application/octet-stream"`.
- **Suggestion:** Make `payload` / `contentType` optional (default empty / `application/octet-stream`), or document that empty payloads are fine.

## F17 — (our design; worth a line in Arkiv's privacy docs) Hashes of public data aren't private on Arkiv
- **When:** 2026-10-16 ~15:40 BST
- **What I did:** For sealed receipts we published `epoch = keccak256("create:" + matched_entity_key)` instead of the raw epoch, to hide which entity matched.
- **Expected:** An observer can't tell what a sealed trigger watches.
- **Actual:** Two different sealed jobs on the same event produced **identical** epochs and result hashes on-chain. Every entity key is public and enumerable via `arkiv_query`, so anyone can hash `"create:" + key` for each entity created near `evidence_block` and recover the match. Arkiv's openness makes every hash of public, low-entropy data reversible.
- **Versions:** `@arkiv-network/sdk@0.8.1` · `viem@2.56.3` · Node 22.22.0 · Tiramisu (7738577) · Arkivate at commit `c91e66d` (before the fix in `06003de`)
- **Steps to reproduce:**
  1. Check out `c91e66d` and start a worker (`pnpm worker`).
  2. Run `pnpm cli seal --spec backend/cli/examples/sealed-event-webhook.json --worker <worker> --webhook <url>` twice, giving two sealed jobs with the same spec.
  3. `pnpm cli demo-feed --kind event`.
  4. Read both sealed receipts' `epoch` attribute: identical. On Tiramisu: receipts `0x591e449e…` and `0x33aba737…`, both `epoch 0xf36cb83d…`, evidence block 655860.
  5. For each entity created at that block, compute `keccak256(stringToHex("create:" + key))`: one of them equals the epoch.
- **Workaround:** Mix the job's secret salt in: `epoch = keccak256(salt ‖ raw_epoch)` and `result_hash = keccak256(epoch ‖ matched_key)`. Re-tested live: same spec, same event → different epochs, and `verify` still recomputes them after a reveal.
- **Suggestion:** Arkiv's privacy guidance could say plainly: "anything you hash on-chain can be brute-forced if its inputs are public or guessable; always add a secret salt". The hackathon rules already ban hashed personal data; the same reasoning applies to app data.

## F18 — [tooling] Next.js Turbopack can't import a workspace package written as ESM TypeScript
- **When:** 2026-10-16 (web app)
- **What I did:** `next dev --turbopack` with `transpilePackages: ["@arkivate/core"]`. Core is NodeNext TypeScript, so its imports end in `.js` (`export * from "./commit.js"`), the form `tsx` and `tsc` require.
- **Expected:** The bundler resolves `./commit.js` to `./commit.ts`, as `tsc`, `tsx` and Vitest do.
- **Actual:** `Module not found: Can't resolve './commit.js'` for every re-export, then `The module has no exports at all`. Turbopack has no equivalent of webpack's `resolve.extensionAlias`.
- **Versions:** Next.js 15.5.28 · pnpm 9.15.9 · TypeScript 5.9.3 · Node 22.22.0
- **Steps to reproduce:**
  1. Create a workspace package whose `src/index.ts` contains `export * from "./commit.js"`, with the source in `commit.ts`.
  2. Import it from a Next.js app that lists it in `transpilePackages`.
  3. `next dev --turbopack` fails with `Module not found: Can't resolve './commit.js'`.
  4. `next dev` (webpack) with `config.resolve.extensionAlias = { ".js": [".ts", ".tsx", ".js"] }` works.
- **Workaround:** Build the web app with webpack (`next dev` / `next build` without `--turbopack`) and set `config.resolve.extensionAlias = { ".js": [".ts", ".tsx", ".js"] }` in `next.config.ts`.
- **Suggestion:** Not Arkiv's to fix. But an Arkiv starter that pairs a shared TS package with a Next.js front end would hit this on day one; the Arkiv templates could ship with the webpack alias already set.

## F19 — Historical reads work, but their retention is undocumented, so dispute evidence has no known shelf life
- **When:** 2026-10-16 ~23:10 BST, while collecting evidence for the docs
- **What I did:** Re-ran `arkivate verify` on the staged censorship case: sealed `0x24087b8f…`, accepted by worker-2 at block 655806, matching event `0xb9e5ac49…` created at 655860, no receipt from worker-2 by the deadline 656010.
- **Expected:** `SKIPPED`, as it was while the event entity was alive.
- **Actual:** `NOT_TRIGGERED`. The `demo_feed` event had a 60-minute lifetime and had expired, and our `on_create` replay only queries live entities at head. The same query with `.atBlock(655870)`, at head 669155 (13,300 blocks, ~7.4 h later), still returned `0xb9e5ac49…@655860`, and a replay at block 656100 gives `SKIPPED` with every step passing. So Arkiv kept the history; our verifier didn't ask for it, because nothing documents how long `atBlock` history is kept and we had assumed "short".
- **Versions:** `@arkiv-network/sdk@0.8.1` · `viem@2.56.3` · Node 22.22.0 · Tiramisu (7738577)
- **Steps to reproduce:**
  1. Create an entity with `attributes: { project: "f19" }` and `ExpirationTime.fromMinutes(5)`; note its creation block N.
  2. After it expires, `client.select({ key: true, createdAt: true }).where(eq("project", str("f19"))).fetch()` returns no entities.
  3. The same query with `.atBlock(N + 10n)` returns it. On Tiramisu, `.atBlock(655870n)` at head 669155 still returned `0xb9e5ac49…`, created at 655860.
  4. Search the SDK and the Arkiv docs for how long `atBlock` history is kept: nothing says.
- **Workaround:** None shipped yet. The fix on our side is to replay the condition `atBlock` the reveal's creation block (the owner reveals while the evidence is fresh) instead of at head. Until then, a dispute has to be verified while the watched entities are still live (see `docs/verification.md`).
- **Suggestion:** Document `atBlock` retention for Tiramisu and mainnet (blocks or hours), and return a distinct error when a requested block is beyond it, so verifiers can tell "no data then" from "history pruned".

## F20 — The access-key quota ran out without warning, mid-deploy, and a 429 at startup crash-looped the workers
- **When:** 2026-10-17, evening, while deploying the reference workers and the web app; again about an hour after the cap was raised.
- **What I did:** Ran two deployed workers (worker-1, worker-2) and the live web app's read proxy on one Arkiv access key, sent as `X-API-KEY`.
- **Expected:** A warning before the monthly cap (Hub, email or a response header), a documented price per call, and a rate-limit error the SDK can recognise.
- **Actual:**
  - The key hit its 1,000,000 cost-unit monthly cap with no warning. Arkiv raised it to 2,000,000, and that was gone within about an hour. The Hub showed **~2,000,000 units over 37,244 calls ≈ 54 units per call**.
  - A spent key answers `HTTP 429` with body `{"error":"QUOTA_EXCEEDED","message":"quota exhausted"}`, header `Arkiv-Quota-Used-Percent: 100`, and **no `Retry-After`**.
  - Both workers then crash-looped: a startup read got the 429, the process exited with status 1, systemd restarted it every 5 s, and every restart re-read Arkiv (restart counters 14 and 17). The web app retried in a tight loop behind "Read quota exhausted", so every open tab kept spending.
- **What we measured afterwards** (Tiramisu, 17–18 Oct; every response carries the cost in an `Arkiv-Cost` header):
  - Every `arkiv_query` costs a **flat 100 units**, whatever it returns: an empty 69-byte result and a 72 KB page of 200 receipts with payloads both cost 100. `arkiv_getEntityCount`, `eth_blockNumber`, `eth_getBalance` and `eth_chainId` carry no cost and still answer at 100% quota. That explains the Hub's 54 units/call: about 54% of our calls were queries.
  - So the quota is a budget of **queries**, not bytes. Selecting fewer fields saves bandwidth, not units.
  - Keyed responses carry `Arkiv-Quota-Used-Percent`. The keyless endpoint carries `RateLimit: limit=600, …` (a short window) and a second **10,000 units/hour per IP** limit (`RateLimit: limit=10000`, with `Retry-After`), i.e. 100 queries/hour. None of these headers is documented.
- **Before / after** (10-minute runs on the keyless endpoint, so no service key was spent; one worker on a fresh throwaway wallet, plus the site with one tab open; units = billed `arkiv_query` × 100):

  | | Before (`81bf439`, same polling as the deployed `c868c47`) | After (`357fe51`) |
  |---|---|---|
  | One worker | 63 queries / 10.3 min ≈ **36,000 units/h** (6.1 queries/min) | 10 queries, all in the first minute (startup), then **0** for 9.3 min; ≈ 1,000 units/h projected (30-min safety refresh) |
  | Site, one open tab | 331 queries / 10.3 min ≈ **193,000 units/h** (32 queries/min) | 13 queries / 26 min ≈ **3,000 units/h** for *all* visitors together (shared, CDN-cached snapshot) |
  | Deployment (2 workers + 1 tab) | ≈ 265,000 units/h | ≈ 5,000 units/h (**~50× fewer**; ~400× fewer than the 2M/h we saw) |

  Top costs before: the site's trigger, demo-feed, sealed and receipt lists (every 10 s, ~180,000 units/h together) and the worker's per-trigger checks of new entities from WebSocket events.
- **Steps to reproduce:**
  1. `curl -si -X POST https://rpc.tiramisu.db-chain.testnet.arkiv.network -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"arkiv_query","params":["project = str('"'"'nothing'"'"')",{"select":{"key":true},"limit":"0x1"}]}' | grep -i 'arkiv-cost\|ratelimit'` prints `arkiv-cost: 100` for an empty result.
  2. Repeat with `"limit":"0xc8"` and `"select":{"key":true,"attributes":true,"payload":true}` on `project = str('arkivate') AND entity_type = str('receipt')`: 72 KB, still `arkiv-cost: 100`.
  3. Send `arkiv_getEntityCount` (`"params":[{"query":"project = str('arkivate')"}]`) or `eth_blockNumber`: no `arkiv-cost` header, and both still succeed on a key at 100%.
  4. With a spent key (`-H 'X-API-KEY: …'`), the query in step 1 returns `429 {"error":"QUOTA_EXCEEDED"}` with `arkiv-quota-used-percent: 100` and no `Retry-After`.
- **Workaround:**
  - 429 is never fatal: backoff 30 s → 60 s → … 10 min (honouring `Retry-After` when present), `/health` up before the first read with `"mode": "rate_limited"`, polling ×4 slower after 3 consecutive 429s, systemd `RestartSec=30` + `StartLimitIntervalSec=0`. A free call succeeding doesn't end a query backoff ([`core/src/ratelimit.ts`](../backend/core/src/ratelimit.ts), [`worker/src/supervisor.ts`](../backend/worker/src/supervisor.ts)).
  - Spend free calls instead of queries: filtered counts gate every receipt lookup, every batch of new entities, the refresh of triggers and workers, and silent heartbeats; batched `$key IN (…)` reads ([`worker/src/engine.ts`](../backend/worker/src/engine.ts), [`core/src/conditions.ts`](../backend/core/src/conditions.ts)).
  - The site reads one shared snapshot (one query lists all ~90 Arkivate entities) that is rebuilt only when the free count changes, or every 5 min ([`app/api/snapshot/route.ts`](../frontend/src/app/api/snapshot/route.ts)).
  - Metering by method and query shape, in cost units, logged every minute and in `/health` ([`core/src/meter.ts`](../backend/core/src/meter.ts)); warnings at 80% and 95% from `Arkiv-Quota-Used-Percent`.
  - One access key per service (worker-1, worker-2, frontend).
- **Suggestion:**
  - Usage warnings at 80% and 95% of the cap, in the Hub and by email.
  - Document `Arkiv-Quota-Used-Percent`, `Arkiv-Cost` and `RateLimit` (they exist but appear nowhere in the docs), and send `Retry-After` on `QUOTA_EXCEEDED` too.
  - Publish the unit cost per method (and whether response size ever matters), so builders can budget polling.
  - A typed rate-limit error in the SDK (`RateLimitError` with `retryAfterMs` and `quotaUsedPercent`), instead of a generic `HttpRequestError`.
  - An expiry event ([F12](#f12--no-expiration-event-expiry-has-to-be-detected-by-sweeping)), which would remove most of the remaining polling.
