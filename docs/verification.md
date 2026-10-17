# Dispute verification: what it can and can't prove

`arkivate verify <sealed_key>` (and the web verifier at `/verify/<sealed_key>`) answer one question:
**did the worker that accepted this sealed job skip it?** It uses only reads that anyone can repeat;
every step prints the `arkiv_query` call that reproduces it. The code is
[`backend/core/src/verify.ts`](../backend/core/src/verify.ts), shared by the CLI and the web app.

## Steps and verdicts

| Step | Reads | Fails as |
|---|---|---|
| 1. Commitment found | the `sealed` entity, or (once it has expired) its burned `acceptance`, which copies the commitment and creator | `NOT_FOUND` |
| 2. Reveal matches | a burned `reveal` created by the sealed creator; `keccak256(canonical(spec) ‖ salt)` must equal the commitment | `PENDING` (no reveal yet) / `INVALID_REVEAL` |
| 3. Worker accepted | a burned `acceptance` from the chosen worker with the same commitment | `NOT_ACCEPTED` (no fault: it never took the job) |
| 4. Condition met | re-run the revealed condition for blocks after `accepted_block` | `NOT_TRIGGERED` / `INCONCLUSIVE` |
| 5. Receipt present | a sealed receipt from that worker whose epoch is `keccak256(salt ‖ raw_epoch)` and whose `fired_block ≤ met_block + 150` | `SKIPPED` (provable censorship); `PENDING` while the 150-block grace window is open; otherwise `FIRED` |

## From our test runs (16 Oct)

Historical evidence only: the watched entities have expired, and the sealed entities expire too.
To see a verdict yourself, create your own sealed trigger (README → Try it yourself, step 5).

| Sealed key | Worker | What happened | Verdict |
|---|---|---|---|
| `0x24087b8f…` | worker-2 (`SKIP_SEALED=true`, the staged censorship demo) | accepted @ 655806; matching event `0xb9e5ac49…` created @ 655860; no receipt by the deadline 656010; owner revealed @ 655904 | `SKIPPED` while the event was live (replayed `atBlock` 656100: every step passes, step 5 fails). **Today: `NOT_TRIGGERED`**, see the limitation below |
| `0x6c982fb4…` | worker-1 | accepted @ 656116; event `0xfe27d4b9…` @ 656136; receipt `0x2987b6ab…` fired @ 656148 | `FIRED` while the event was live (replayed `atBlock` 656300). Today: `NOT_TRIGGERED` |
| `0xe90e2e92…` | worker-1 | the published reveal does not hash to the commitment | `INVALID_REVEAL` (doesn't depend on the watched evidence) |
| `0xcc7c310e…` | worker-1 | no reveal published | `PENDING` |

## Limitation: verify replays at head, so evidence has to be live

Step 4 replays the condition against entities that exist **at the current head**. Arkiv keeps
history (`atBlock` reads still returned expired entities 13,300 blocks later, see
`arkiv/friction.md` F19), but its retention is undocumented and our verifier doesn't use it yet.

- **Long-lived by design:** acceptances, receipts and reveals are readonly and burned (30-day expiry,
  extendable by anyone), so neither side can delete them.
- **The watched data must still be live.** `on_create` and `on_silence` replay correctly while the
  matching entities are alive. Once they expire:
  - `on_create` returns **`NOT_TRIGGERED`**, because "never created" and "created, then expired"
    look the same at head. This is the case for both examples above, whose `demo_feed` events had a
    60-minute lifetime. Treat `NOT_TRIGGERED` on an old job as unproven, not as an acquittal.
  - Expiry conditions (`on_expiring` / `on_expire` with a query watch, pinned deadlines, a watched
    entity that is gone), `on_count`, `on_extend` and `on_delete` return **`INCONCLUSIVE`** rather
    than a guess. Arkiv can't tell "expired" from "deleted" (F13), keeps no historical counts in a
    form we query, and pinned deadlines are recorded only by the worker.
- **Practical rule:** dispute while the evidence is fresh, within the lifetime of the entities the
  trigger watched. Extending the watched entities (they're often `permissionlessExtension`) keeps
  the evidence alive.
- **Planned fix:** evaluate step 4 `atBlock` the reveal's creation block instead of at head. The
  owner reveals while the evidence is live, so the replay sees what the worker saw. The replays in
  the table above use exactly that technique.

## What stays private

Before a reveal, Arkiv holds only the commitment, the chosen worker, the acceptance, and salted
receipts (`keccak256(salt ‖ epoch)`, `{ result_hash }`). An observer can see *that* and *when*
(`evidence_block`) a sealed trigger fired, not *what* it watches. The destination (webhook URL or
chat ID) never touches Arkiv, before or after a reveal.
