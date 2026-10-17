import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import type { Reader } from "./reader.js";
import { fetchPayloads, pruneCache, type PayloadCache } from "./records.js";

const K1 = `0x${"1".repeat(64)}` as Hex;
const K2 = `0x${"2".repeat(64)}` as Hex;

/** Fake reader: answers payload queries from `chain`, and records which keys each query asked for. */
function fakeReader(chain: Record<Hex, { updatedAt: bigint; body: unknown }>) {
  const asked: Hex[][] = [];
  const reader = {
    select: () => {
      let keys: Hex[] = [];
      const q = {
        where: (expr: unknown) => {
          keys = [...String(expr).matchAll(/0x[0-9a-f]{64}/g)].map((m) => m[0] as Hex);
          return q;
        },
        limit: () => q,
        fetch: async () => {
          asked.push(keys);
          return {
            entities: keys.map((k) => ({ key: k, updatedAt: chain[k]!.updatedAt, toJson: () => chain[k]!.body })),
          };
        },
      };
      return q;
    },
  } as unknown as Reader;
  return { reader, asked };
}

describe("payload cache", () => {
  it("fetches a payload once, and again only after a patch moves updatedAt", async () => {
    const chain = { [K1]: { updatedAt: 10n, body: { v: 1 } }, [K2]: { updatedAt: 20n, body: { v: 2 } } };
    const { reader, asked } = fakeReader(chain);
    const cache: PayloadCache = new Map();

    await fetchPayloads(reader, [{ key: K1, updatedAt: 10n }, { key: K2, updatedAt: 20n }], cache);
    expect(asked).toEqual([[K1, K2]]);

    await fetchPayloads(reader, [{ key: K1, updatedAt: 10n }, { key: K2, updatedAt: 20n }], cache);
    expect(asked).toHaveLength(1); // nothing new: no query at all

    chain[K2] = { updatedAt: 25n, body: { v: 3 } };
    await fetchPayloads(reader, [{ key: K1, updatedAt: 10n }, { key: K2, updatedAt: 25n }], cache);
    expect(asked[1]).toEqual([K2]);
    expect(cache.get(K2)?.json).toEqual({ v: 3 });
  });

  it("treats rows without updatedAt as immutable (receipts): fetched once, ever", async () => {
    const { reader, asked } = fakeReader({ [K1]: { updatedAt: 10n, body: { summary: "x" } } });
    const cache: PayloadCache = new Map();
    await fetchPayloads(reader, [{ key: K1 }], cache);
    await fetchPayloads(reader, [{ key: K1 }], cache);
    expect(asked).toHaveLength(1);
  });

  it("prunes keys that are no longer live", () => {
    const cache: PayloadCache = new Map([
      [K1, { json: 1 }],
      [K2, { json: 2 }],
    ]);
    pruneCache(cache, [K2]);
    expect([...cache.keys()]).toEqual([K2]);
  });
});
