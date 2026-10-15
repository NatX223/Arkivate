import { describe, expect, it } from "vitest";
import { commit } from "./commit.js";

const salt = `0x${"ab".repeat(32)}` as const;

describe("commit", () => {
  it("is independent of object key order (RFC 8785 canonical JSON)", () => {
    const a = { v: 1, cond: { type: "on_create" }, action: { type: "notice" } };
    const b = { action: { type: "notice" }, cond: { type: "on_create" }, v: 1 };
    expect(commit(a, salt)).toBe(commit(b, salt));
  });

  it("changes with the salt", () => {
    const spec = { v: 1 };
    expect(commit(spec, salt)).not.toBe(commit(spec, `0x${"cd".repeat(32)}`));
  });
});

describe("commit encoding", () => {
  it("hashes exactly utf8(canonical) ‖ salt bytes", async () => {
    const { keccak256, toBytes } = await import("viem");
    const bytes = new Uint8Array([...toBytes('{"v":1}'), ...toBytes(salt)]);
    expect(commit({ v: 1 }, salt)).toBe(keccak256(bytes));
  });
});
