# Dispute verification: what it can and can't prove

`arkivate verify <sealed_key>` (and the web verifier) answer one question: **did the worker that
accepted this sealed job skip it?** It uses only reads that anyone can repeat; every step prints the
`arkiv_query` call that reproduces it.

## Steps and verdicts

| Step | Reads | Fails as |
|---|---|---|
| 1. Commitment found | the `sealed` entity, or (once it has expired) its burned `acceptance`, which copies the commitment and creator | `NOT_FOUND` |
| 2. Reveal matches | a burned `reveal` created by the sealed creator; `keccak256(canonical(spec) ‖ salt)` must equal the commitment | `PENDING` (no reveal yet) / `INVALID_REVEAL` |
| 3. Worker accepted | a burned `acceptance` from the chosen worker with the same commitment | `NOT_ACCEPTED` (no fault: it never took the job) |
| 4. Condition met | re-run the revealed condition for blocks after `accepted_block` | `NOT_TRIGGERED` / `INCONCLUSIVE` |
| 5. Receipt present | a sealed receipt from that worker whose epoch is `keccak256(salt ‖ raw_epoch)` and whose `fired_block ≤ met_block + 150` | `SKIPPED` (provable censorship); `PENDING` while the 150-block grace window is open; otherwise `FIRED` |

## Limitation: evidence must still be live at head

Arkiv's historical reads have short retention, so verification can only use evidence that is still
queryable at the current head:

- **Long-lived by design:** acceptances, receipts and reveals are readonly and burned (30-day expiry,
  extendable by anyone), so neither side can delete them.
- **The watched data must still be live.** Step 4 replays the condition against entities that exist
  now. `on_create` and `on_silence` replay well while the matching entities are alive. When the
  evidence has expired or been deleted, the verdict is **`INCONCLUSIVE`** rather than a guess. This
  applies to most expiry conditions, `on_count` (no historical counts), pinned deadlines (recorded
  only by the worker), and anything whose entities are gone, because Arkiv can't tell "expired" from
  "deleted" (`arkiv/friction.md` F13).
- **Practical rule:** dispute while the evidence is fresh, within the lifetime of the entities the
  trigger watched. A public receipt from another trigger on the same entity, or extending the
  watched entities (they're often `permissionlessExtension`), keeps evidence alive.

## What stays private

Before a reveal, Arkiv holds only the commitment, the chosen worker, the acceptance, and salted
receipts (`keccak256(salt ‖ epoch)`, `{ result_hash }`). An observer can see *that* and *when*
(`evidence_block`) a sealed trigger fired, not *what* it watches. The destination (webhook URL or
chat ID) never touches Arkiv, before or after a reveal.
