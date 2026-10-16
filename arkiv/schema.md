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
| `demo_feed` | demo wallet (owner) | demo wallet | none | `--ttl` minutes (default 60) | ✅ shipped |
| `sealed` | fresh owner wallet | owner | `readonly` | spec life + dispute window | phase 2 |
| `acceptance` | worker wallet | **`0x…dEaD`** | `readonly` + `permissionlessExtension` | 30 days | phase 2 |
| `reveal` | sealed's creator | **`0x…dEaD`** | `readonly` | 30 days | phase 2 |

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
| `cond_type` | str | `on_create` \| `on_silence` \| `on_count` |
| `status` | str | `active` \| `paused` (only the owner can patch it) |
| `created_at` | u64 | ms since epoch |

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

Public payload: `{ "matched_keys": ["0x…"], "summary": "new matching entity 0x… at block 648210" }`.
Sealed receipts (phase 2) will carry only `{ "result_hash": "0x…" }`.

Epochs (one receipt per `(trigger, epoch)` across all workers):

| Condition | Epoch | Meaning |
|---|---|---|
| `on_create` | `create:<matched_key>` | one firing per matching entity created after the trigger |
| `on_silence` | `silence:<last_seen_key>` or `silence:none` | one firing per silence episode |
| `on_count` | `count:<head / 1800>` | at most one firing per ~1 h bucket while the threshold holds |

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
| `kind` | str | `heartbeat` \| `event` |
| `seq` | u64 | 1, 2, … within one run |
| `created_at` | u64 | ms since epoch |

Payload: `{ "kind": "event", "seq": 1, "synthetic": true }`.

## sealed

_Phase 2._ Commitment `keccak256(canonical_json(spec) ‖ salt32)` plus the chosen worker's address.
No payload.

## acceptance

_Phase 2._ A worker's burned promise to run a sealed job.

## reveal

_Phase 2._ `{ spec, salt }`, burned, published only to open a dispute.
