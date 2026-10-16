import { recoverMessageAddress, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { commit, randomSalt } from "./commit.js";
import { destinationDigest, handoffMessage, sealedEpoch } from "./sealed.js";
import { SealedTriggerSpec, parseSpec } from "./spec.js";
import {
  GRACE_BLOCKS,
  verifySealed,
  type AcceptanceRecord,
  type Evaluation,
  type SealedRecord,
  type SealedReceiptRecord,
  type VerifyReads,
} from "./verify.js";

const OWNER = "0x00000000000000000000000000000000000000aa" as Hex;
const WORKER = "0x00000000000000000000000000000000000000bb" as Hex;
const SEALED = `0x${"11".repeat(32)}` as Hex;
const MATCH = `0x${"22".repeat(32)}` as Hex;

const spec = parseSpec(SealedTriggerSpec, {
  v: 1,
  cond: { type: "on_create", where: [["eq", "kind", { str: "event" }]], created_by: OWNER },
  action: { type: "webhook" },
});

describe("commitment + salt", () => {
  it("is stable across key order", () => {
    const salt = randomSalt();
    const reordered = { action: spec.action, cond: { created_by: OWNER, where: spec.cond.type === "on_create" ? spec.cond.where : [], type: "on_create" }, v: 1 };
    expect(commit(reordered, salt)).toBe(commit(spec, salt));
  });

  it("produces unique 32-byte salts", () => {
    const salts = new Set(Array.from({ length: 500 }, randomSalt));
    expect(salts.size).toBe(500);
    for (const s of salts) expect(s).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("hand-off signature (EIP-191)", () => {
  it("recovers the signer, and binds the destination", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const fields = {
      sealedKey: SEALED,
      commitment: commit(spec, randomSalt()),
      workerAddress: WORKER,
      destinationDigest: destinationDigest({ type: "webhook", value: "https://example.invalid/hook" }),
    };
    const signature = await account.signMessage({ message: handoffMessage(fields) });
    expect(await recoverMessageAddress({ message: handoffMessage(fields), signature })).toBe(account.address);
    const swapped = { ...fields, destinationDigest: destinationDigest({ type: "webhook", value: "https://attacker.invalid" }) };
    expect(await recoverMessageAddress({ message: handoffMessage(swapped), signature })).not.toBe(account.address);
  });
});

// ---- verdict state machine with mocked reads -------------------------------------------------

function setup(over: Partial<{
  head: bigint;
  sealed: SealedRecord | undefined;
  acceptances: AcceptanceRecord[];
  reveal: { spec: unknown; salt: Hex } | undefined;
  evaluation: Evaluation;
  receipts: SealedReceiptRecord[];
}> = {}) {
  const salt = randomSalt();
  const commitment = commit(spec, salt);
  const d = {
    head: 1_000n,
    sealed: { key: SEALED, creator: OWNER, worker: WORKER, commitment } as SealedRecord | undefined,
    acceptances: [{ key: `0x${"33".repeat(32)}` as Hex, creator: WORKER, commitment, sealedCreator: OWNER, acceptedBlock: 100n }],
    reveal: { spec, salt } as { spec: unknown; salt: Hex } | undefined,
    evaluation: { status: "met", hits: [{ epoch: `create:${MATCH}`, metBlock: 200n, matchedKey: MATCH }], detail: "1 match" } as Evaluation,
    receipts: [] as SealedReceiptRecord[],
    ...over,
  };
  const reads: VerifyReads = {
    head: async () => d.head,
    sealed: async () => d.sealed,
    acceptances: async () => d.acceptances,
    reveals: async () => (d.reveal ? [{ key: `0x${"44".repeat(32)}` as Hex, creator: OWNER, ...d.reveal }] : []),
    evaluate: async () => d.evaluation,
    receipts: async () => d.receipts,
  };
  return { reads, commitment, salt };
}

const receiptFor = (epoch: string, firedBlock: bigint): SealedReceiptRecord => ({
  key: `0x${"55".repeat(32)}` as Hex,
  creator: WORKER,
  epoch: sealedEpoch(epoch),
  firedBlock,
});

describe("verifySealed", () => {
  it("NOT_FOUND without a sealed entity or acceptance", async () => {
    const { reads } = setup({ sealed: undefined, acceptances: [] });
    expect((await verifySealed(SEALED, reads)).verdict).toBe("NOT_FOUND");
  });

  it("PENDING before any reveal", async () => {
    const { reads } = setup({ reveal: undefined });
    expect((await verifySealed(SEALED, reads)).verdict).toBe("PENDING");
  });

  it("INVALID_REVEAL when the revealed spec was edited", async () => {
    const { reads, salt } = setup();
    const tampered = { ...spec, action: { type: "telegram" } };
    const r = await verifySealed(SEALED, { ...reads, reveals: async () => [{ key: SEALED, creator: OWNER, spec: tampered, salt }] });
    expect(r.verdict).toBe("INVALID_REVEAL");
  });

  it("INVALID_REVEAL with the wrong salt", async () => {
    const { reads } = setup({ reveal: { spec, salt: randomSalt() } });
    expect((await verifySealed(SEALED, reads)).verdict).toBe("INVALID_REVEAL");
  });

  it("NOT_ACCEPTED when only another worker accepted", async () => {
    const { reads, commitment } = setup();
    const other = [{ key: SEALED, creator: OWNER, commitment, sealedCreator: OWNER, acceptedBlock: 100n }];
    expect((await verifySealed(SEALED, { ...reads, acceptances: async () => other })).verdict).toBe("NOT_ACCEPTED");
  });

  it("NOT_TRIGGERED when the condition never held", async () => {
    const { reads } = setup({ evaluation: { status: "not_met", detail: "nothing" } });
    expect((await verifySealed(SEALED, reads)).verdict).toBe("NOT_TRIGGERED");
  });

  it("INCONCLUSIVE when the condition can't be replayed", async () => {
    const { reads } = setup({ evaluation: { status: "inconclusive", detail: "no history" } });
    expect((await verifySealed(SEALED, reads)).verdict).toBe("INCONCLUSIVE");
  });

  it("FIRED with a receipt from the worker inside the grace window", async () => {
    const { reads } = setup({ receipts: [receiptFor(`create:${MATCH}`, 205n)] });
    const r = await verifySealed(SEALED, reads);
    expect(r.verdict).toBe("FIRED");
    expect(r.steps.map((s) => s.ok)).toEqual([true, true, true, true, true]);
  });

  it("SKIPPED when the grace window passed with no receipt", async () => {
    const { reads } = setup({ head: 200n + GRACE_BLOCKS + 1n });
    expect((await verifySealed(SEALED, reads)).verdict).toBe("SKIPPED");
  });

  it("SKIPPED when the only receipt is too late", async () => {
    const { reads } = setup({ receipts: [receiptFor(`create:${MATCH}`, 200n + GRACE_BLOCKS + 1n)] });
    expect((await verifySealed(SEALED, reads)).verdict).toBe("SKIPPED");
  });

  it("PENDING while the grace window is still open", async () => {
    const { reads } = setup({ head: 210n });
    expect((await verifySealed(SEALED, reads)).verdict).toBe("PENDING");
  });

  it("falls back to the acceptance once the sealed entity has expired", async () => {
    const { reads } = setup({ sealed: undefined, receipts: [receiptFor(`create:${MATCH}`, 201n)] });
    const r = await verifySealed(SEALED, reads);
    expect(r.verdict).toBe("FIRED");
    expect(r.steps[0]!.detail).toMatch(/acceptance/);
  });

  it("emits re-check commands for every read it made", async () => {
    const { reads } = setup({ receipts: [receiptFor(`create:${MATCH}`, 205n)] });
    const r = await verifySealed(SEALED, reads);
    expect(r.recheck.length).toBeGreaterThanOrEqual(4);
    expect(r.recheck[0]).toMatch(/^curl -s https:\/\/rpc\.tiramisu/);
  });
});
