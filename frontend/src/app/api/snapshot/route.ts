import { RateGate, RpcMeter, TIRAMISU_RPC_HTTP, countMatching, createReader, gatedFetch, isRateLimited, meteredFetch } from "@arkivate/core";
import { allArkivate, buildSnapshot, encodeSnapshot, type Snapshot } from "@/lib/snapshot";

/**
 * GET /api/snapshot: every list page's data, built server-side and shared by all visitors.
 *
 * Budget (arkiv/friction.md F20): an `arkiv_query` costs 100 units, `arkiv_getEntityCount` and
 * `eth_blockNumber` cost nothing. So at most every FRESH_MS this asks the free count whether
 * anything was created or removed; only then, or every MAX_AGE_MS to catch patches and
 * extensions, does it rebuild (one list query plus payloads for what changed). The CDN caches the
 * response for FRESH_MS too, so a crowd of visitors costs the same as one. On a 429 the last
 * snapshot keeps being served.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FRESH_MS = 20_000;
/** Patches and extensions don't change the count; they show within this. Own edits bypass it (markChanged). */
const MAX_AGE_MS = 300_000;

const gate = new RateGate();
const meter = new RpcMeter();
const reader = createReader({
  rpcHttp: process.env.ARKIV_RPC_HTTP || TIRAMISU_RPC_HTTP,
  accessKey: process.env.ARKIV_ACCESS_KEY,
  retryCount: 0,
  fetchFn: gatedFetch(gate, meteredFetch(meter)),
});

let current: { snap: Snapshot; headAt: number; checkedAt: number } | undefined;
let inflight: Promise<void> | undefined;

async function refresh() {
  const now = Date.now();
  if (current && now - current.snap.builtAt < MAX_AGE_MS) {
    const head = await reader.getBlockNumber();
    const count = await countMatching(reader, allArkivate(), head);
    if (count === current.snap.count) {
      current = { snap: { ...current.snap, head }, headAt: Date.now(), checkedAt: Date.now() };
      logUsage(false);
      return;
    }
  }
  const snap = await buildSnapshot(reader);
  current = { snap, headAt: snap.builtAt, checkedAt: Date.now() };
  logUsage(true);
}

/** Cumulative for this server instance: calls, cost units, bytes, top shapes (arkiv/friction.md F20). */
function logUsage(rebuilt: boolean) {
  console.log(JSON.stringify({ snapshot: { rebuilt, entities: current?.snap.count, rpc: meter.snapshot(5) } }));
}

function respond(stale: boolean) {
  const c = current!;
  const body = encodeSnapshot({ ...c.snap, headAgeMs: Date.now() - c.headAt });
  return new Response(body, {
    headers: {
      "content-type": "application/json",
      // Shared by every visitor through the CDN; stale copies bridge a rebuild or a 429.
      "cache-control": `public, max-age=0, s-maxage=${FRESH_MS / 1000}, stale-while-revalidate=${MAX_AGE_MS / 1000}`,
      ...(stale ? { "x-snapshot-stale": "1" } : {}),
    },
  });
}

export async function GET() {
  if (current && Date.now() - current.checkedAt < FRESH_MS) return respond(false);
  if (gate.blocked) {
    if (current) return respond(true);
    return Response.json(
      { error: "Arkiv read quota exhausted; retrying shortly" },
      { status: 429, headers: { "retry-after": String(Math.ceil(gate.retryInMs / 1000)) } },
    );
  }
  inflight ??= refresh().finally(() => (inflight = undefined));
  try {
    await inflight;
    return respond(false);
  } catch (e) {
    gate.note(e);
    console.error(JSON.stringify({ snapshotError: e instanceof Error ? e.message.split("\n")[0] : String(e) }));
    if (current) return respond(true);
    const limited = isRateLimited(e);
    return Response.json(
      { error: limited ? "Arkiv read quota exhausted; retrying shortly" : "couldn't read from Arkiv" },
      { status: limited ? 429 : 502, headers: { "retry-after": String(Math.max(30, Math.ceil(gate.retryInMs / 1000))) } },
    );
  }
}
