# CLAUDE.md — Arkivate kickoff spec

You are helping build **Arkivate**, an open-source trigger engine for Arkiv data, for the
*Arkiv: Global Tour Stop* hackathon. Deadline: **Sun 18 Oct 2026, 23:59 London time** (judges
record the repo SHA at the deadline). Full design lives in `docs/technical-plan.md`. Read it
before writing feature code.

This file covers **Phase 0: setup, scaffolding and a working hello-world.** Do not start
feature work until every Phase 0 acceptance check passes.

---

## 1. Ground rules (read every session)

1. **Verify the SDK before using it.** The Arkiv docs online are partly stale (SDK 0.6 / Kaolin
   examples). Before calling any SDK function, open the installed declarations in
   `node_modules/@arkiv-network/sdk/dist/**/*.d.ts` and confirm the exact name, argument shape
   and return type. If reality differs from `docs/technical-plan.md`, follow reality and log it
   (rule 2).
2. **Log every friction point** in `arkiv/friction.md` the moment it happens, using the
   template in §7. Judges score this file (25 points). Never batch them for later.
3. **Network:** Tiramisu testnet only. Chain ID `7738577`. Import the chain from
   `@arkiv-network/sdk/chains` (`tiramisu`).
4. **Attributes:** lowercase `snake_case` names only (the node rejects uppercase even though the
   SDK accepts it). Every entity gets `project: "arkivate"` and `entity_type`.
5. **Typed numbers:** any timestamp or block number is `u64(...)` in writes **and** queries. A
   bare JS number becomes `i32` and silently matches nothing.
6. **Trust = `$creator`.** Filter with `.createdBy(addr)`. Never treat `$owner`, `project` or
   `entity_type` as authentication.
7. **Never put on Arkiv:** private keys, access keys, webhook URLs, Telegram chat IDs, emails,
   names, or any real personal data, in plaintext **or hashed**. All demo data is synthetic.
   Violating this disqualifies the project.
8. **Secrets** live only in `.env` (gitignored). The Arkiv access key is server-side only; never
   import it into browser code.
9. **No contracts, no Solidity.** All writes are Arkiv native entity operations through the SDK.
10. **Never rewrite git history** (no force-push, no rebase of pushed commits). Small, frequent
    commits with clear messages.
11. **License:** MIT on everything.

---

## 2. Environment

| Tool | Version |
|---|---|
| Node | 22 LTS (`.nvmrc` = `22`) |
| pnpm | 9.x (`corepack enable`) |
| TypeScript | 5.x, `strict: true`, ESM (`"type": "module"`) |
| OS | Any; scripts must not assume macOS |

---

## 3. Repository layout to scaffold

```
arkivate/
├─ CLAUDE.md                     # this file
├─ README.md                     # placeholder: one-paragraph pitch + "setup coming"
├─ LICENSE                       # MIT, current year, author: Sinachi
├─ WALLETS.md                    # table of public addresses (filled in by human)
├─ .gitignore                    # node_modules, dist, .env*, *.local, data/, .next
├─ .env.example                  # every var, no values
├─ .nvmrc                        # 22
├─ package.json                  # root, private, workspaces scripts
├─ pnpm-workspace.yaml           # packages/*, apps/*
├─ tsconfig.base.json
├─ docs/
│  └─ technical-plan.md          # copy of the design doc
├─ arkiv/
│  ├─ schema.md                  # stub with the six entity types as headings
│  └─ friction.md                # template header (see §7)
├─ scripts/
│  ├─ hello.ts                   # Phase 0 smoke test (see §6)
│  └─ gen-wallets.ts             # prints 4 fresh keypairs (see §5)
├─ packages/
│  ├─ core/                      # @arkivate/core
│  │  ├─ package.json
│  │  ├─ tsconfig.json
│  │  └─ src/
│  │     ├─ index.ts             # re-exports
│  │     ├─ config.ts            # env loading + validation (zod)
│  │     ├─ clients.ts           # reader/wallet factories (Tiramisu, access-key header)
│  │     ├─ constants.ts         # PROJECT="arkivate", DEAD address, entity_type names
│  │     ├─ spec.ts              # TODO stub: TriggerSpec zod schema
│  │     └─ commit.ts            # TODO stub: canonical hash commitment
│  ├─ worker/                    # @arkivate/worker  (bin: arkivate-worker)
│  │  ├─ package.json
│  │  ├─ tsconfig.json
│  │  └─ src/index.ts            # stub: logs "worker starting" + reads config
│  └─ cli/                       # @arkivate/cli  (bin: arkivate)
│     ├─ package.json
│     ├─ tsconfig.json
│     └─ src/index.ts            # commander skeleton; subcommands print "not implemented"
└─ apps/
   └─ web/                       # Next.js 15 app router + Tailwind; one page: "Arkivate"
```

Packages reference `@arkivate/core` via `"workspace:*"`. Packages run from source with `tsx`
during the hackathon; a build step is optional.

---

## 4. Packages to install

Pin the Arkiv SDK and viem **exactly**; they are known to work together.

**`packages/core`**
```
pnpm --filter @arkivate/core add --save-exact @arkiv-network/sdk@0.8.1 viem@2.56.3
pnpm --filter @arkivate/core add zod canonicalize dotenv
```

**`packages/worker`**
```
pnpm --filter @arkivate/worker add @arkivate/core@workspace:* express lowdb pino
pnpm --filter @arkivate/worker add -D @types/express
```

**`packages/cli`**
```
pnpm --filter @arkivate/cli add @arkivate/core@workspace:* commander
```

**`apps/web`**
```
pnpm create next-app@latest apps/web --ts --tailwind --app --eslint --src-dir --use-pnpm --no-import-alias
pnpm --filter web add @arkivate/core@workspace:*
```

**Root (dev)**
```
pnpm add -Dw typescript tsx vitest @types/node
```

After installing, record the exact resolved versions of `@arkiv-network/sdk` and `viem` at the
top of `arkiv/friction.md`.

---

## 5. Config and wallets

`.env.example`:
```
ARKIV_RPC_HTTP=https://rpc.tiramisu.db-chain.testnet.arkiv.network
ARKIV_RPC_WS=wss://rpc.tiramisu.db-chain.testnet.arkiv.network
ARKIV_ACCESS_KEY=
OWNER_PRIVATE_KEY=
SEALED_OWNER_PRIVATE_KEY=
WORKER_A_PRIVATE_KEY=
WORKER_B_PRIVATE_KEY=
WORKER_PORT=8787
PUBLIC_ENDPOINT=
TELEGRAM_BOT_TOKEN=
```

`packages/core/src/config.ts`: load with `dotenv`, validate with zod. Private keys must match
`^0x[0-9a-fA-F]{64}$`. Fail fast with a clear message naming the missing variable (never print
the value).

`scripts/gen-wallets.ts`: use viem `generatePrivateKey` + `privateKeyToAccount` to print four
labelled `KEY=value` lines (owner, sealed_owner, worker_a, worker_b) plus their addresses, so the
human can paste keys into `.env` and addresses into `WALLETS.md`. The script must not write any
file itself.

**Human steps (Claude cannot do these; print them as a checklist at the end of Phase 0):**
1. Run `pnpm tsx scripts/gen-wallets.ts`, paste the output into `.env` and the addresses into `WALLETS.md`.
2. Fund each address at https://hub.arkiv.network/faucet (needs SIWE sign-in + captcha).
3. Create an access key at https://hub.arkiv.network/api-keys and put it in `.env`.

---

## 6. `scripts/hello.ts`: the Phase 0 smoke test

Uses `@arkivate/core` clients and the `OWNER_PRIVATE_KEY`. Steps, each printing a clear line:

1. **Chain check:** `getChainId()` must equal `7738577`; print the head block number.
2. **Balance check:** print the owner's balance; if zero, stop with "fund this address at the
   faucet" (unfunded writes fail with an unhelpful error).
3. **Create:** one entity with payload `{ hello: "arkivate" }`, attributes
   `{ project: "arkivate", entity_type: "hello", created_at: u64(Date.now()) }`, expiry 10
   minutes, default flags. Print entity key + tx hash + explorer link
   `https://tiramisu.explorer.arkiv.network/tx/<hash>`.
4. **Read back:** `getEntity(key)`; print owner, creator, expiresAt and decoded payload.
5. **Query:** `select(...)` with `eq("project","arkivate")`, `eq("entity_type","hello")`,
   `.createdBy(owner)`, `.limit(5)`; print the count and keys. It must include the new key.
6. **Create + burn batch:** use `predictEntityKeys` to get one key/salt, then `executeBatch` with
   a readonly create and an `ownershipChanges` entry to
   `0x000000000000000000000000000000000000dEaD`. Read it back; owner must be the dead address and
   creator must still be the owner wallet.
7. **Live events:** start the SDK's entity-event watcher over WebSocket, create one more
   `hello` entity, and confirm an `EntityCreated` event for that key arrives within 30 s. Then
   unwatch and exit 0.

Run with `pnpm hello` (root script → `tsx scripts/hello.ts`). Any deviation from expected SDK
behaviour goes straight into `arkiv/friction.md`.

---

## 7. `arkiv/friction.md` template

```
# Friction report

SDK: @arkiv-network/sdk@<x.y.z> · viem@<x.y.z> · Node <ver> · Network: Tiramisu (7738577)

## F1 — <short title>
- **When:** <date/time>
- **What I did:** <exact call / command>
- **Expected:** <…>
- **Actual:** <exact error text or behaviour>
- **Repro:** <minimal snippet or command>
- **Workaround:** <what we did>
- **Suggestion:** <what Arkiv could change>
```

Number entries F1, F2, … in order. Include faucet, docs and tooling friction, not just SDK bugs.

---

## 8. Root scripts

```json
{
  "scripts": {
    "hello": "tsx scripts/hello.ts",
    "wallets": "tsx scripts/gen-wallets.ts",
    "worker": "tsx packages/worker/src/index.ts",
    "cli": "tsx packages/cli/src/index.ts",
    "web": "pnpm --filter web dev",
    "typecheck": "tsc -b",
    "test": "vitest run"
  }
}
```

---

## 9. Phase 0 acceptance checks

- [ ] `pnpm install` succeeds from a clean clone
- [ ] `pnpm typecheck` passes
- [ ] `pnpm cli --help` lists: create, pause, seal, handoff, reveal, verify, demo-feed
- [ ] `pnpm worker` starts, validates config and logs "worker starting"
- [ ] `pnpm web` serves a page titled "Arkivate"
- [ ] `pnpm hello` completes all 7 steps against Tiramisu (after the human funds the wallet)
- [ ] `arkiv/friction.md` has the version header and at least the entries hit during setup
- [ ] `.env` is gitignored; `git grep -i "PRIVATE_KEY=0x"` finds nothing
- [ ] LICENSE (MIT), README stub, WALLETS.md, `docs/technical-plan.md` committed
- [ ] Initial commits pushed to a **public** GitHub repo

When all boxes are ticked, stop and report: what passed, the entity keys/tx hashes from
`hello`, and every friction entry added. Phase 1 (public trigger engine) starts only after the
human confirms.
