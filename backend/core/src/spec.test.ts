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
    if (spec.cond.type !== "on_silence") throw new Error("unreachable");
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

const KEY = `0x${"ab".repeat(32)}`;
const queryWatch = { where: [["eq", "kind", { str: "listing" }]], created_by: TRUSTED };
const keepAlive = {
  v: 1,
  cond: { type: "on_expiring", watch: { entity_key: KEY }, lead_blocks: 40 },
  action: { type: "extend", extend_blocks: 120, max_extensions: 2 },
};

describe("expiry conditions", () => {
  it("accepts every new condition with a single-entity watch", () => {
    for (const cond of [
      { type: "on_expiring", watch: { entity_key: KEY }, lead_blocks: 40 },
      { type: "on_expire", watch: { entity_key: KEY } },
      { type: "on_extend", watch: { entity_key: KEY } },
      { type: "on_delete", watch: { entity_key: KEY } },
    ]) {
      expect(parseSpec(PublicTriggerSpec, { v: 1, cond, action: { type: "notice" } }).cond.type).toBe(cond.type);
    }
  });

  it("accepts a query watch", () => {
    const spec = parseSpec(PublicTriggerSpec, {
      v: 1,
      cond: { type: "on_expire", watch: queryWatch },
      action: { type: "notice" },
    });
    expect(spec.cond.type === "on_expire" && "where" in spec.cond.watch).toBe(true);
  });

  it("defaults deadline to follow and accepts pinned", () => {
    const follow = parseSpec(PublicTriggerSpec, { v: 1, cond: { type: "on_expire", watch: { entity_key: KEY } }, action: { type: "notice" } });
    expect(follow.cond.type === "on_expire" && follow.cond.deadline).toBe("follow");
    const pinned = parseSpec(PublicTriggerSpec, { v: 1, cond: { type: "on_expire", watch: { entity_key: KEY }, deadline: "pinned" }, action: { type: "notice" } });
    expect(pinned.cond.type === "on_expire" && pinned.cond.deadline).toBe("pinned");
  });

  it("requires lead_blocks for on_expiring", () => {
    expect(() =>
      parseSpec(PublicTriggerSpec, { v: 1, cond: { type: "on_expiring", watch: { entity_key: KEY } }, action: { type: "notice" } }),
    ).toThrow(/lead_blocks/);
  });

  it("rejects a watch that mixes entity_key and where, or has neither", () => {
    for (const watch of [{ entity_key: KEY, where: queryWatch.where }, {}, { entity_key: "0x1234" }]) {
      expect(() =>
        parseSpec(PublicTriggerSpec, { v: 1, cond: { type: "on_delete", watch }, action: { type: "notice" } }),
      ).toThrow();
    }
  });

  it("rejects unknown deadline modes and extra fields on on_extend / on_delete", () => {
    expect(() =>
      parseSpec(PublicTriggerSpec, { v: 1, cond: { type: "on_expire", watch: { entity_key: KEY }, deadline: "latest" }, action: { type: "notice" } }),
    ).toThrow();
    expect(() =>
      parseSpec(PublicTriggerSpec, { v: 1, cond: { type: "on_extend", watch: { entity_key: KEY }, lead_blocks: 5 }, action: { type: "notice" } }),
    ).toThrow();
  });
});

describe("extend action (Reactivate)", () => {
  it("accepts on_expiring + extend, with an entity or a query watch", () => {
    expect(parseSpec(PublicTriggerSpec, keepAlive).action.type).toBe("extend");
    expect(parseSpec(PublicTriggerSpec, { ...keepAlive, cond: { ...keepAlive.cond, watch: queryWatch } }).action.type).toBe("extend");
  });

  it("requires extend_blocks and max_extensions, and caps max_extensions at 100", () => {
    expect(() => parseSpec(PublicTriggerSpec, { ...keepAlive, action: { type: "extend", extend_blocks: 120 } })).toThrow(/max_extensions/);
    expect(() => parseSpec(PublicTriggerSpec, { ...keepAlive, action: { type: "extend", max_extensions: 2 } })).toThrow(/extend_blocks/);
    expect(() => parseSpec(PublicTriggerSpec, { ...keepAlive, action: { ...keepAlive.action, max_extensions: 101 } })).toThrow();
    expect(parseSpec(PublicTriggerSpec, { ...keepAlive, action: { ...keepAlive.action, max_extensions: 100 } }).action.type).toBe("extend");
  });

  it("rejects on_extend + extend as a loop", () => {
    expect(() =>
      parseSpec(PublicTriggerSpec, { ...keepAlive, cond: { type: "on_extend", watch: { entity_key: KEY } } }),
    ).toThrow(/loop/);
  });

  it("rejects extend after the fact (on_expire, on_delete) and with non-expiry conditions", () => {
    for (const cond of [
      { type: "on_expire", watch: { entity_key: KEY } },
      { type: "on_delete", watch: { entity_key: KEY } },
      onCreate.cond,
    ]) {
      expect(() => parseSpec(PublicTriggerSpec, { ...keepAlive, cond })).toThrow(/only valid with on_expiring/);
    }
  });

  it("is enforced on the general TriggerSpec too", () => {
    expect(() => parseSpec(TriggerSpec, { ...keepAlive, cond: { type: "on_extend", watch: { entity_key: KEY } } })).toThrow(/loop/);
  });
});
