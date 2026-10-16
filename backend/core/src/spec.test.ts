import { render } from "@arkiv-network/sdk/query";
import { getAddress } from "viem";
import { describe, expect, it } from "vitest";
import { compare, conditionExpression } from "./query.js";
import { PublicTriggerSpec, TriggerSpec, parseSpec } from "./spec.js";

const TRUSTED = "0x00000000000000000000000000000000000000aa";

const onCreate = {
  v: 1,
  cond: {
    type: "on_create",
    where: [
      ["eq", "project", { str: "arkivate" }],
      ["eq", "entity_type", { str: "demo_feed" }],
      ["eq", "kind", { str: "event" }],
    ],
  },
  action: { type: "notice" },
};

describe("TriggerSpec", () => {
  it("accepts a minimal on_create spec", () => {
    expect(parseSpec(PublicTriggerSpec, onCreate).cond.type).toBe("on_create");
  });

  it("requires created_by and silence_blocks for on_silence", () => {
    const spec = { ...onCreate, cond: { type: "on_silence", where: onCreate.cond.where } };
    expect(() => parseSpec(TriggerSpec, spec)).toThrow(/created_by|silence_blocks/);
  });

  it("rejects uppercase attribute names and $system names", () => {
    for (const name of ["Project", "$creator", "entity-type"]) {
      const spec = { ...onCreate, cond: { type: "on_create", where: [["eq", name, { str: "x" }]] } };
      expect(() => parseSpec(TriggerSpec, spec)).toThrow(/snake_case/);
    }
  });

  it("rejects untyped literals (the silent i32 trap)", () => {
    const spec = { ...onCreate, cond: { type: "on_create", where: [["gt", "seq", 5]] } };
    expect(() => parseSpec(TriggerSpec, spec)).toThrow();
  });

  it("rejects operators the node does not support", () => {
    const spec = { ...onCreate, cond: { type: "on_create", where: [["ne", "kind", { str: "x" }]] } };
    expect(() => parseSpec(TriggerSpec, spec)).toThrow();
  });

  it("only allows notice for public triggers", () => {
    expect(() => parseSpec(PublicTriggerSpec, { ...onCreate, action: { type: "webhook" } })).toThrow();
    expect(parseSpec(TriggerSpec, { ...onCreate, action: { type: "webhook" } }).action.type).toBe("webhook");
  });
});

describe("conditionExpression", () => {
  it("renders typed literals and the trusted creator", () => {
    const spec = parseSpec(TriggerSpec, {
      v: 1,
      cond: {
        type: "on_silence",
        where: [
          ["eq", "kind", { str: "heartbeat" }],
          ["gte", "seq", { u64: "10" }],
          ["starts_with", "name", { str: "it's" }],
        ],
        created_by: TRUSTED,
        silence_blocks: 30,
      },
      action: { type: "notice" },
    });
    expect(render(conditionExpression(spec.cond))).toBe(
      `kind = str('heartbeat') AND seq >= u64(10) AND name STARTSWITH str('it''s') AND $creator = addr(${getAddress(TRUSTED)})`,
    );
  });
});

describe("compare", () => {
  it("applies each operator", () => {
    expect(compare(0, "lte", 0)).toBe(true);
    expect(compare(1, "lt", 1)).toBe(false);
    expect(compare(3, "gte", 3)).toBe(true);
    expect(compare(4, "gt", 3)).toBe(true);
    expect(compare(2, "eq", 3)).toBe(false);
  });
});
