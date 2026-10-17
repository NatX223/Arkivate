import { describe, expect, it } from "vitest";
import { RpcMeter, meterExchange, rpcShape } from "./meter.js";

const query = (q: string, select: Record<string, unknown>, limit?: number) => ({
  method: "arkiv_query",
  params: [q, { select, ...(limit ? { limit: `0x${limit.toString(16)}` } : {}) }],
});

describe("rpc meter", () => {
  it("groups queries that differ only in literals", () => {
    const a = query(`(project = "arkivate" && trigger = 0xabc && fired_block > 12345)`, { key: true, payload: true }, 200);
    const b = query(`(project = "other" && trigger = 0xdef && fired_block > 9)`, { key: true, payload: true }, 200);
    expect(rpcShape(a)).toBe(rpcShape(b));
    expect(rpcShape(a)).toBe(`arkiv_query select=key,payload where=(project = "?" && trigger = 0x… && fired_block > N) limit=200`);
  });

  it("names selected attributes and collapses $key candidate lists", () => {
    const s = rpcShape(query(`($key = 0x1 || $key = 0x2 || $key = 0x3)`, { key: true, attributes: { fired_block: true } }, 50));
    expect(s).toBe("arkiv_query select=key,attributes{fired_block} where=($key IN (…)) limit=50");
  });

  it("sums calls and bytes per method and shape, splitting batch responses", () => {
    let t = 0;
    const m = new RpcMeter(() => t);
    meterExchange(m, [{ method: "eth_blockNumber" }], 200, '{"result":"0x1"}');
    meterExchange(m, [{ method: "eth_blockNumber" }, { method: "eth_chainId" }], 200, '[{"result":"0x1"},{"result":"0x761451"}]');
    t = 60_000;
    const snap = m.snapshot();
    expect(snap.calls).toBe(3);
    expect(snap.byMethod.eth_blockNumber).toMatchObject({ calls: 2, callsPerMinute: 2 });
    expect(snap.byMethod.eth_chainId!.bytes).toBe('{"result":"0x761451"}'.length);
  });
});
