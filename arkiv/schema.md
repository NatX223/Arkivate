# Arkivate entity schema

All entities carry `project = "arkivate"` and `entity_type`. Attribute names are lowercase
snake_case. Trust comes from `$creator` (filter with `.createdBy(addr)`), never from `$owner`,
`project` or `entity_type`. Timestamps and block numbers are always `u64`.

Network: Tiramisu (chain ID 7738577). Attribute builders live in
[`backend/core/src/entities.ts`](../backend/core/src/entities.ts); read helpers in
[`backend/core/src/records.ts`](../backend/core/src/records.ts).

| Entity | Creator | Owner | Flags | Expiry | Status |
|---|---|---|---|---|---|
| `worker` | worker wallet | worker | none (mutable) | 1 day, extended every 6 h | ✅ shipped |
| `trigger` | trigger owner | trigger owner | `permissionlessExtension` | owner picks (default 7 days) | ✅ shipped |
| `receipt` | worker wallet | **`0x…dEaD`** (burned) | `readonly` + `permissionlessExtension` | 30 days | ✅ shipped (public mode) |
| `demo_feed` | demo wallet (owner) | demo wallet | `listing`: `permissionlessExtension` | `--ttl` minutes, or `--blocks` for listing/canary | ✅ shipped |
| `sealed` | fresh owner wallet | owner | `readonly` | job lifetime (`--days`, default 7) | ✅ shipped |
| `acceptance` | worker wallet | **`0x…dEaD`** | `readonly` + `permissionlessExtension` | 30 days | ✅ shipped |
| `reveal` | sealed's creator | **`0x…dEaD`** | `readonly` | 30 days | ✅ shipped |

Burned = created and transferred to `0x000000000000000000000000000000000000dEaD` in the same atomic
`executeBatch`, so nobody (including its creator) can ever delete or modify it.

## worker

A worker announces itself so others can find it, rank themselves for dedupe and trust its receipts.
If it stops sending heartbeats, the entity expires and the worker disappears.

| Attribute | Type | Example |
|---|---|---|
| `project` | str | `arkivate` |
| `entity_type` | str | `worker` |
| `version` | str | `0.1.0` |
| `modes` | str | `public` (later `public,sealed`) |

Payload (`application/json`): `{ "name": "worker-1", "endpoint": "https://…" }`. `endpoint` is the
public hand-off URL, or `""` when running locally.

## trigger

A public "if this, then that" rule. The payload is the full spec, so anyone can audit what a
worker should do.

| Attribute | Type | Example |
|---|---|---|
| `project` | str | `arkivate` |
| `entity_type` | str | `trigger` |
| `cond_type` | str | `on_create` \| `on_silence` \| `on_count` \| `on_expiring` \| `on_expire` \| `on_extend` \| `on_delete` |
| `action_type` | str | `notice` \| `extend` |
| `status` | str | `active` \| `paused` (only the owner can patch it) |
| `created_at` | u64 | ms since epoch |
| `watch_key` | key | only when an expiry condition watches one entity: lets anyone find every trigger on it |

Payload: a TriggerSpec v1 (validated by `PublicTriggerSpec` in `backend/core/src/spec.ts`). The
action of a public trigger is always `notice`, meaning the only effect is a receipt.

```json
{
  "v": 1,
  "cond": {
    "type": "on_silence",
    "where": [["eq", "entity_type", { "str": "demo_feed" }], ["eq", "kind", { "str": "heartbeat" }]],
    "created_by": "0xa81415E8Fa827099BbEb5eA11199533D2e2967eA",
    "silence_blocks": 60
  },
  "action": { "type": "notice" }
}
```

- `where`: predicates `[op, attribute, typed_literal]`. `op` is `eq | gt | gte | lt | lte | starts_with`
  (only the operators the node accepts). Literals are typed: `{str}`, `{u64}`, `{i32}`, `{addr}`,
  `{key}`, `{bool}`.
- `created_by`: the trusted creator, rendered as `$creator = addr(…)`. Required for `on_silence`.
- Expiry conditions (`on_expiring`, `on_expire`, `on_extend`, `on_delete`) take
  `watch: { "entity_key": "0x…" }` (one entity) or `watch: { "where": […], "created_by"?: "0x…" }`
  (every matching entity). `on_expiring` needs `lead_blocks`. `on_expiring` / `on_expire` take
  `deadline: "follow"` (default; the entity's current `expiresAt`) or `"pinned"` (its `expiresAt`
  when the trigger first saw it, which nobody's extension can move).
- `action: { "type": "extend", "extend_blocks": n, "max_extensions": m ≤ 100 }` (Reactivate) is
  only valid with `on_expiring`. `on_extend` + `extend` is rejected as a loop.
- Workers re-validate every trigger, because anyone can post one.

## receipt

Proof that a worker fired a trigger for one epoch. Burned, so it can never vanish. That is what
makes a skipped firing provable.

| Attribute | Type | Example |
|---|---|---|
| `project` | str | `arkivate` |
| `entity_type` | str | `receipt` |
| `trigger` | key | trigger entity key |
| `mode` | str | `public` (later `sealed`) |
| `epoch` | str | dedupe key, see below |
| `fired_block` | u64 | head block when the receipt was written |
| `evidence_block` | u64 | block of the evidence (matched entity, or the evaluation head) |
| `subject` | key | expiry conditions: the watched entity this firing is about |
| `outcome` | str | `extend` action only: `extended` \| `not_extendable` \| `cap_reached` |
| `old_expires_at` | u64 | `extend` action: the entity's expiry block before |
| `new_expires_at` | u64 | `extend` action, `extended` only: the expiry block after |

Reactivate outcomes:

| `outcome` | Meaning | On-chain effect |
|---|---|---|
| `extended` | The target was extended to `old_expires_at + extend_blocks` (an absolute block) | The extension and the burned receipt are **one atomic batch**: extended if and only if the receipt exists |
| `not_extendable` | The target lacks `permissionlessExtension` and isn't owned by the worker | Receipt only |
| `cap_reached` | `max_extensions` `extended` receipts already exist for this (trigger, subject), counted across all registered workers | Receipt only; the target is left to expire |

Public payload: `{ "matched_keys": ["0x…"], "summary": "new matching entity 0x… at block 648210" }`.
Sealed receipts (phase 2) will carry only `{ "result_hash": "0x…" }`.

Epochs (one receipt per `(trigger, epoch)` across all workers):

| Condition | Epoch | Meaning |
|---|---|---|
| `on_create` | `create:<matched_key>` | one firing per matching entity created after the trigger |
| `on_silence` | `silence:<last_seen_key>` or `silence:none` | one firing per silence episode |
| `on_count` | `count:<head / 1800>` | at most one firing per ~1 h bucket while the threshold holds |
| `on_expiring` | `expiring:<subject>:<deadline>` | once per deadline; an extension (with `follow`) re-arms it |
| `on_expire` | `expire:<subject>:<deadline>` | once per deadline |
| `on_extend` | `extend:<subject>:<new_expires_at>` | once per extension |
| `on_delete` | `delete:<subject>` | once |

Expired vs deleted: Arkiv has no expiration event, and a read of a missing entity
(`NoEntityFoundError`) can't say why it is missing. Workers decide: a seen `EntityDeleted` event,
or the entity vanishing **before** its known `expiresAt` (expiry can't come early) → deleted;
otherwise → expired.

Dedupe: before writing, a worker looks up receipts for `(trigger, epoch)` and skips if one exists
from a **registered worker** (a creator with a live `worker` entity). Receipts from unregistered
addresses are ignored, so they can't be used to suppress firings.

Workers rank themselves by sorted address among live `worker` entities. Rank 0 fires at once; rank
*n* waits *n* × 12 s (max 36 s) and re-checks first. The slot has to exceed detect → write → mined,
which measured ~5–7 s on Tiramisu: with a 2 s slot, two workers both fired the same epoch. Two
workers can still both fire if the primary stalls just past its slot. The first receipt by block
is canonical, and consumers should treat `(trigger, epoch)` as idempotent.

## demo_feed

Synthetic data emitted by `arkivate demo-feed` to drive triggers in demos and tests. No real data.

| Attribute | Type | Example |
|---|---|---|
| `project` | str | `arkivate` |
| `entity_type` | str | `demo_feed` |
| `kind` | str | `heartbeat` \| `event` \| `listing` (short-lived, `permissionlessExtension`) \| `canary` (short-lived, not extendable by others) |
| `seq` | u64 | 1, 2, … within one run |
| `created_at` | u64 | ms since epoch |

Payload: `{ "kind": "event", "seq": 1, "synthetic": true }`.

## sealed

A private trigger's public footprint: a commitment and the chosen worker. Created from a fresh
`sealed_owner` wallet, so it isn't linked to the owner's other activity.

| Attribute | Type | Example |
|---|---|---|
| `project` | str | `arkivate` |
| `entity_type` | str | `sealed` |
| `commitment` | bytes32 | `keccak256(canonical_json(spec) ‖ salt32)` |
| `worker` | addr | the worker chosen to run it |
| `created_at` | u64 | ms since epoch |

No payload (empty). Flags `readonly`; the owner keeps it. Its lifetime is how long the job runs
(`seal --days`, default 7). The spec is the RFC 8785 canonical JSON of the **normalized** spec
(condition, watch, action type and params). The destination is never part of it.

## acceptance

A worker's promise to run one sealed job, written after a valid private hand-off (`POST /sealed`).
Burned in the same batch as its creation, so the worker can never withdraw it to escape a dispute.

| Attribute | Type | Example |
|---|---|---|
| `project` | str | `arkivate` |
| `entity_type` | str | `acceptance` |
| `sealed` | key | the sealed entity |
| `commitment` | bytes32 | copied from the sealed entity |
| `sealed_creator` | addr | the sealed entity's creator |
| `accepted_block` | u64 | the job's conditions count from here |

No payload. `readonly` + `permissionlessExtension`, owner `0x…dEaD`, 30 days. `commitment` and
`sealed_creator` are duplicated here on purpose: a dispute can still be verified after the `sealed`
entity has expired.

## receipt (sealed mode)

Same entity type as public receipts, with `mode = "sealed"` and `trigger` = the sealed key. To
avoid revealing what matched:

- `epoch` = `keccak256(salt ‖ raw_epoch)`, not the raw `create:<matched_key>`. An unsalted hash
  can be brute-forced over public entity keys (two sealed jobs on the same event produced
  identical unsalted epochs in our tests), so the job's secret salt is mixed in. The worker and,
  after a reveal, any verifier can recompute it.
- Payload: only `{ "result_hash": keccak256(epoch ‖ matched_key) }`.
- No `subject` / `outcome` attributes.

`evidence_block` remains, so an observer learns *when* a sealed trigger fired, though not *what* it
watched.

## reveal

Published only to open a dispute. Burned, so it can't be withdrawn either.

| Attribute | Type | Example |
|---|---|---|
| `project` | str | `arkivate` |
| `entity_type` | str | `reveal` |
| `sealed` | key | the sealed entity |

Payload: `{ "spec": { … }, "salt": "0x…" }`. Must be created by the sealed entity's creator
(checked via `$creator`). `readonly`, owner `0x…dEaD`, 30 days.

## Never on Arkiv

Webhook URLs, Telegram chat IDs, the destination digest that the hand-off signature covers, sealed
specs before reveal, private keys, access keys. Our Phase 2 test scanned every live
`project = arkivate` entity (attributes and payloads, plain and hex) for the test destinations and
their digests: 0 hits.
