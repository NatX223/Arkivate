import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import { localMatch, type CandidateRow } from "./query.js";
import type { Reader } from "./reader.js";
import { fetchCandidates } from "./conditions.js";
import { findReceipts } from "./records.js";

const ME = "0x1111111111111111111111111111111111111111" as Hex;
const row: CandidateRow = {
  key: `0x${"a".repeat(64)}` as Hex,
  creator: ME,
  createdAt: 100n,
  expiresAt: 200n,
  attributes: {
    project: { type: "str", value: "arkivate" },
    kind: { type: "str", value: "heartbeat" },
    seq: { type: "u64", value: 7n },
    owner_ref: { type: "addr", value: ME.toUpperCase().replace("0X", "0x") },
  },
};

describe("localMatch", () => {
  it("matches typed equality, prefixes and numeric ranges like the node", () => {
    expect(localMatch(row, { where: [["eq", "project", { str: "arkivate" }], ["gte", "seq", { u64: "7" }]] })).toBe(true);
    expect(localMatch(row, { where: [["starts_with", "kind", { str: "heart" }]] })).toBe(true);
    expect(localMatch(row, { where: [["eq", "owner_ref", { addr: ME }]] })).toBe(true);
    expect(localMatch(row, { where: [["lt", "seq", { u64: "7" }]] })).toBe(false);
  });

  it("never matches across types (a bare number is i32, not u64)", () => {
    expect(localMatch(row, { where: [["eq", "seq", { i32: 7 }]] })).toBe(false);
  });

  it("checks the trusted creator, and a missing attribute never matches", () => {
    expect(localMatch(row, { where: [["eq", "kind", { str: "heartbeat" }]], created_by: "0x2222222222222222222222222222222222222222" })).toBe(false);
    expect(localMatch(row, { where: [["eq", "nope", { str: "x" }]] })).toBe(false);
  });

  it("defers to the node when local semantics aren't certain (string ordering)", () => {
    expect(localMatch(row, { where: [["gt", "kind", { str: "a" }]] })).toBeUndefined();
    // …but a definite miss elsewhere still decides it.
    expect(localMatch(row, { where: [["gt", "kind", { str: "a" }], ["eq", "project", { str: "other" }]] })).toBe(false);
  });
});

describe("findReceipts", () => {
  it("asks the free count first and skips the billed query when there are none", async () => {
    const calls: string[] = [];
    const reader = {
      getBlockNumber: async () => 10n,
      request: async ({ method }: { method: string }) => {
        calls.push(method);
        return 0;
      },
      select: () => {
        calls.push("arkiv_query");
        throw new Error("should not query");
      },
    } as unknown as Reader;
    expect(await findReceipts(reader, `0x${"b".repeat(64)}` as Hex, "create:x")).toEqual([]);
    expect(calls).toEqual(["arkiv_getEntityCount"]);
  });
});

describe("fetchCandidates (WS flush)", () => {
  it("makes no billed query when the free count says none of the new keys match", async () => {
    const calls: string[] = [];
    const reader = {
      request: async ({ method }: { method: string }) => {
        calls.push(method);
        return 0;
      },
      select: () => {
        calls.push("arkiv_query");
        throw new Error("should not query");
      },
    } as unknown as Reader;
    const keys = [`0x${"c".repeat(64)}`, `0x${"d".repeat(64)}`] as Hex[];
    expect(await fetchCandidates(reader, keys, [{ where: [["eq", "kind", { str: "heartbeat" }]] }], 10n)).toEqual([]);
    expect(calls).toEqual(["arkiv_getEntityCount"]);
  });

  it("skips everything when no trigger could match", async () => {
    const reader = {} as Reader;
    expect(await fetchCandidates(reader, [`0x${"c".repeat(64)}` as Hex], [], 10n)).toEqual([]);
  });
});
