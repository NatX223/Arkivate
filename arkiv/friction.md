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
