# Friction report

SDK: @arkiv-network/sdk@0.8.1 · viem@2.56.3 · Node 22.22.0 · Network: Tiramisu (7738577)
Tooling: pnpm 9.15.9 · TypeScript 5.9.3 · Windows 11 (Git Bash)

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
- **Repro:** pnpm workspace; `pnpm add -Dw typescript` (gets 7.x) → `pnpm --filter pkg add @arkiv-network/sdk@0.8.1 viem@2.56.3` → `pnpm add -Dw typescript@5 @arkiv-network/sdk@0.8.1` → import `u64` in root and pass to a client made in `pkg`.
- **Workaround:** Root `package.json`: `"pnpm": { "overrides": { "typescript": "5.9.3" } }`, then `pnpm install`, which collapses to one SDK instance.
- **Suggestion:** Brand with a string-keyed property (e.g. `__arkivValidated: true`) instead of a
  `unique symbol`, or validate at runtime only, so duplicate installs stay type-compatible. Mention
  "keep a single SDK instance in monorepos" in the docs.

## F2 — No access-key option in the SDK; header must be wired through viem by hand
- **When:** 2026-10-15 23:40 BST
- **What I did:** Read `dist/index.d.ts` for how to pass the Hub access key to `createPublicClient` / `createWalletClient`.
- **Expected:** An `accessKey` option, or a JSDoc example showing the header (the keyless RPC is rate-limited to ≈100 queries/hour/IP).
- **Actual:** There is no mention of access keys anywhere in `dist/` (`grep -ri "api-key\|apikey\|access.key"` finds nothing). Every example uses bare `http()`.
- **Repro:** `grep -rni "api-key\|apikey\|access" node_modules/@arkiv-network/sdk/dist/*.d.ts`
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
- **Repro:** `import { tiramisu } from "@arkiv-network/sdk/chains"; console.log(tiramisu.blockExplorers) // undefined`
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
- **Repro:** `client.request({ method: "arkiv_getEntityCount", params: [{ nonsense: 1 }] })`
- **Workaround:** Call the raw RPC with exactly `[{ query, atBlock }]`, built from the SDK's `render()`, and sanity-check that the result is below the unfiltered count.
- **Suggestion:** Expose `getEntityCount({ where, atBlock })` in the SDK, add the params to `ArkivRpcSchema`, and have the node reject unknown keys.

## F5 — Query result order is undocumented
- **When:** 2026-10-16 ~15:00 BST
- **What I did:** Needed "the newest entity from creator X" for the `on_silence` condition. Searched the SDK source (`query/engine.ts`, `queryResult.ts`, `queryBuilder.ts`) and README for ordering.
- **Expected:** A documented sort order (or an `orderBy`), since `$createdAt` cannot be used in a predicate (it is "returned in query results but carries no index").
- **Actual:** No mention of ordering anywhere in the SDK. Observed on Tiramisu: results come back newest-first by creation block (two triggers created ~5 blocks apart; three `demo_feed` events), but nothing guarantees it.
- **Repro:** `client.select({ key: true, createdAt: true }).where(eq("project", "arkivate")).limit(5).fetch()` and inspect `createdAt`.
- **Workaround:** Fetch a page (limit 50) and take the max `createdAt` in JavaScript instead of trusting `limit(1)`.
- **Suggestion:** Document the order as part of the query contract, or add `orderBy("$createdAt", "desc")`.

## F6 — Faucet cooldown makes funding a multi-wallet project take hours
- **When:** 2026-10-16, while funding wallets for Phase 1 (worker-2) and Phase 2 (`sealed_owner`)
- **What I did:** Funded our four wallets (owner, sealed_owner, worker-1, worker-2) at https://hub.arkiv.network/faucet. Each claim needs a SIWE sign-in and a captcha.
- **Expected:** Fund all four wallets in one sitting. A multi-party design like ours, or any app that separates identities as the "trust = `$creator`" model encourages, needs several funded addresses on day one.
- **Actual:** After a claim, the next one is locked for about **1 hour**. Funding worker-2 was blocked mid-session; the two-worker test waited on the cooldown, and `sealed_owner` is still waiting for its turn. Each claim gives 10 GLM, yet our whole Phase 1 test run cost worker-1 about 0.001 GLM, so one claim is worth thousands of writes. The limit is about frequency, not amount.
- **Repro:** Claim for address A, then immediately try address B from the same Hub account.
- **Workaround:** Plan claims around the cooldown, and fund the wallets that write first (owner, then workers). Better: send GLM from an already-funded wallet with a plain viem `sendTransaction`, since one 10 GLM claim covers every wallet we have.
- **Suggestion:** Let one claim split across several addresses, or document the cooldown and the "transfer between your own wallets" pattern on the faucet page.

## F7 — No atomic "create if absent", so multi-worker dedupe is timing-based (and we shipped duplicate receipts once)
- **When:** 2026-10-16 ~17:30 BST
- **What I did:** Ran two independent workers on the same public trigger. Each checks for an existing receipt for `(trigger, epoch)` before writing; the backup worker waited 2 s and re-checked.
- **Expected:** Some way to make "exactly one receipt per epoch" hold across writers: a uniqueness constraint on attributes, a conditional create, or a deterministic key that two writers would collide on.
- **Actual:** None of these exists. Entity keys come from the *creator's* nonce (`predictEntityKeys({ owner })`), so two workers never collide, and nothing rejects a second receipt with the same attributes. Measured on Tiramisu: worker-1's receipt was mined **9.2 s** after the event's block (≈2 s detection + query + `executeBatch` waiting for the receipt). worker-2 re-checked at about +5–7 s, saw nothing, and wrote a duplicate, mined at +13.0 s. Both receipts are burned, so the duplicate is permanent: receipts `0x644479c6…` and `0x6728e06d…` for epoch `create:0xd8efa591…`.
- **Repro:** Two wallets each run `findReceipts → (none) → executeBatch(create+burn)` for the same attributes within ~5 s of each other.
- **Workaround:** Workers rank themselves by address and rank *n* waits *n* × 12 s before re-checking. After that change, 4/4 concurrent firings produced exactly one receipt. It is still probabilistic: a primary that stalls past its slot causes a duplicate, so consumers must treat `(trigger, epoch)` as idempotent.
- **Suggestion:** A conditional create (`createEntity({ …, ifAbsent: where(...) })`), or a key derived from caller-chosen content (e.g. `keccak(namespace ‖ id)`) that rejects a second create, would make cross-writer dedupe exact. Publishing typical inclusion latency would also help.

## F8 — The event watcher can't be filtered, and creation time isn't queryable
- **When:** 2026-10-16 ~16:30 BST
- **What I did:** Built the `on_create` path: react to new entities matching a filter (`project`, `entity_type`, `kind`, creator).
- **Expected:** Subscribe to `EntityCreated` filtered by creator or attributes, or at least poll "matching entities created after block N".
- **Actual:**
  - `watchEntityEvents` delivers every entity operation on the chain. `EntityCreated` carries only `entityKey`, `owner`, `expiresAt` and `creationFlags`, with no attributes, so each candidate needs a follow-up query to know whether it matters.
  - `$createdAt` can't be used in a predicate (it "carries no index"), so a catch-up for missed events can't ask "created since block N". It can only fetch a page of matches and filter in JavaScript, which misses anything that fell off the page.
- **Repro:** `watchEntityEvents({ onEntityCreated })` on Tiramisu and count events against your own writes; `eq("$createdAt", u64(1))` → `InvalidPredicateError: "$createdAt" is returned in query results but carries no index`.
- **Workaround:** Pre-filter events by `owner` (the creator at creation time) when every trigger names a creator. Buffer keys for 2 s and send one query per trigger: `<filter> AND ($key = … OR $key = …)`. Catch up every 5 min with the newest 50 matches, filtered to `createdAt > trigger.createdAt`.
- **Suggestion:** Index `$createdAt` (it is already an ordered `u64`), and/or allow a server-side filter on the event subscription (creator, `project` / `entity_type` attributes).

## F9 — (local tooling, not Arkiv) Windows locks prevented renaming workspace folders
- **When:** 2026-10-16 morning, restructuring `packages/*` + `apps/web` into `backend/*` + `frontend`
- **What I did:** `git mv packages/core backend/core`
- **Expected:** A directory rename.
- **Actual:** `fatal: renaming 'packages/core' failed: Permission denied`, even with no node processes running. VS Code held handles on the folders. Removing pnpm's `node_modules` (thousands of junctions) took over 2 minutes and the rename still failed.
- **Workaround:** `git mv` each tracked file individually into the new tree (history is kept as renames), then `pnpm install`.
- **Suggestion:** None for Arkiv. Noted because it cost about 15 minutes.

## F10 — (local tooling, not Arkiv) Private key pasted without the `0x` prefix
- **When:** 2026-10-16, first `pnpm hello` run
- **What I did:** Pasted the owner key from a wallet export into `.env`.
- **Expected:** The key works.
- **Actual:** Our config validation rejected it: `OWNER_PRIVATE_KEY: must be a 0x-prefixed 32-byte hex private key`. The export had 64 hex characters without `0x`, which wallet exports often omit but viem's `privateKeyToAccount` requires.
- **Workaround:** Added `0x`. Our validator names the variable without printing the value, which made this a one-minute fix.
- **Suggestion:** Arkiv docs and Hub pages that show keys could state the expected `0x…` format next to every key example.

## F11 — (local tooling, not Arkiv) A duplicated `.env` block silently blanked the worker key
- **When:** 2026-10-16 ~16:45 BST
- **What I did:** Added a second worker's block to `.env` (same variable names, empty key) to prepare the two-worker test.
- **Expected:** worker-1 keeps working.
- **Actual:** `dotenv` keeps the last value of a duplicated key, so the empty `WORKER_PRIVATE_KEY=` overrode the real one and the worker exited with `Missing required environment variable(s): WORKER_PRIVATE_KEY`.
- **Workaround:** Renamed the second block to `WORKER_2_*` (a local convenience the code never reads). For the test run, worker-2's values were set in the shell, which takes precedence over `.env`.
- **Suggestion:** None for Arkiv. For us: one worker identity per `.env`, and set extra identities per process.

## F12 — No expiration event: expiry has to be detected by sweeping
- **When:** 2026-10-16 ~15:00 BST (Phase 1b, expiry engine)
- **What I did:** Built `on_expiring` / `on_expire`: "tell me when entity X is about to expire / has expired". Reacting to expiry is the core of Arkivate.
- **Expected:** An `EntityExpired` event alongside `EntityCreated`, `EntityPatched`, `ExpiryExtended`, `OwnershipTransferred` and `EntityDeleted`.
- **Actual:** `ENTITY_EVENTS_ABI` has no expiry event, and expiry happens without a transaction, so there is no log to watch. Every app that cares about expiry must keep its own index of deadlines and poll. Measured on Tiramisu: an entity with `expiresAt = 655058` was already absent at head `655058`, so **`expiresAt` is the first block the entity is gone**, not the last block it lives (also undocumented). Our sweep runs every ~5 blocks: canary `C1` (`expiresAt 654834`) was confirmed expired at head `654838`.
- **Repro:** Create an entity with `ExpirationTime.fromBlocks(60)`, `watchEntityEvents({ onEvent })`, and wait past `expiresAt`: nothing arrives.
- **Workaround:** The worker keeps an index `key → expiresAt` (persisted, so expiries during downtime are still caught), sweeps it every 10 s against the head, and re-reads at the deadline to confirm.
- **Suggestion:** Emit `EntityExpired` from the node (even as a synthetic log per block), or offer a subscription such as "entities expiring within N blocks". Document whether `expiresAt` is inclusive.

## F13 — `NoEntityFoundError` can't tell expired from deleted (or never existed)
- **When:** 2026-10-16 ~15:00 BST
- **What I did:** At a deadline, re-read the watched entity to decide between `on_expire` and `on_delete`.
- **Expected:** A read that distinguishes "expired at block N" from "deleted at block N" from "unknown key".
- **Actual:** `getEntity` throws `NoEntityFoundError` for all three. The SDK source says so ("no live entity has that key — it never existed, or it was deleted or has expired"), and query results simply omit the entity. Historical reads (`atBlock`) have short retention, so you can't reliably look back either.
- **Repro:** `getEntity(k)` after `deleteEntity(k)`, and after `k` expires: identical errors.
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
- **Repro:** `extendEntity({ entityKey, expires: ExpirationTime.fromBlocks(10) })` on an entity with 100 blocks left → rejected.
- **Workaround:** Always extend to an absolute block, `ExpirationTime.atBlock(live.expiresAt + n)`. For pinned deadlines, record `expiresAt` at first sight and never move it, whoever extends.
- **Suggestion:** Add `ExpirationTime.by(n)` (relative to the current expiry), or rename the action to `setExpiry`. Include the transaction sender (`extendedBy`) in `ExpiryExtended`.

## F15 — Write latency varies a lot (2.7 s to 15.6 s) on ~2 s blocks
- **When:** 2026-10-16 ~15:00 BST
- **What I did:** Created 15 entities sequentially from one process during test setup, timing each `createEntity` call (send plus wait for receipt).
- **Expected:** Roughly 1–2 blocks per write.
- **Actual:** 8.7, 2.7, 6.6, 6.6, 6.4, 3.5, 15.4, 11.7, 15.6, 8.3, 11.8, 7.1, 5.2, 9.0 and 6.7 s. That is a spread of 1 to 8 blocks for identical writes from an idle wallet. It matters for anything time-boxed: our multi-worker dedupe slot (F7) and the expiry lead time (`lead_blocks`) both have to absorb the worst case.
- **Repro:** Time `await wallet.createEntity(...)` in a loop on Tiramisu.
- **Workaround:** 12 s per-rank dedupe slots; we recommend `lead_blocks ≥ 20` for Reactivate so an extension lands well before the deadline.
- **Suggestion:** Publish expected inclusion latency for Tiramisu, and say whether the SDK's receipt wait adds polling delay (the default poll interval may be part of the spread).
