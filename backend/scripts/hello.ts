// Phase 0 smoke test: chain → balance → create → read → query → create+burn → live events.
import { ExpirationTime, jsonToPayload } from "@arkiv-network/sdk";
import { u64 } from "@arkiv-network/sdk/attr";
import { eq } from "@arkiv-network/sdk/query";
import { formatEther, type Hex } from "viem";
import { CHAIN_ID, DEAD, PROJECT, txUrl } from "@arkivate/core";
import { loadConfig, makeReader, makeWallet, makeWsReader } from "@arkivate/core/server";

const step = (n: number, msg: string) => console.log(`\n[${n}/7] ${msg}`);
const ok = (msg: string) => console.log(`  ✓ ${msg}`);
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

const helloAttrs = () => ({ project: PROJECT, entity_type: "hello", created_at: u64(Date.now()) });

async function main() {
  const env = loadConfig(["OWNER_PRIVATE_KEY"]);
  const reader = makeReader(env);
  const wallet = makeWallet(env.OWNER_PRIVATE_KEY as Hex, env);
  const owner = wallet.account.address;

  step(1, "Chain check");
  const chainId = await reader.getChainId();
  assert(chainId === CHAIN_ID, `chain id ${chainId} !== ${CHAIN_ID}`);
  ok(`chain id ${chainId}, head block ${await reader.getBlockNumber()}`);

  step(2, "Balance check");
  const balance = await reader.getBalance({ address: owner });
  ok(`owner ${owner} has ${formatEther(balance)} GLM`);
  if (balance === 0n) {
    console.error(`  ✗ fund this address at the faucet: https://hub.arkiv.network/faucet`);
    process.exit(1);
  }

  step(3, "Create entity");
  const created = await wallet.createEntity({
    payload: jsonToPayload({ hello: "arkivate" }),
    contentType: "application/json",
    attributes: helloAttrs(),
    expires: ExpirationTime.fromMinutes(10),
  });
  ok(`key ${created.entityKey}`);
  ok(`tx  ${created.txHash}`);
  ok(`    ${txUrl(created.txHash)}`);

  step(4, "Read back");
  const entity = await reader.getEntity(created.entityKey);
  ok(`owner ${entity.owner}, creator ${entity.creator}, expiresAt block ${entity.expiresAt}`);
  ok(`payload ${JSON.stringify(entity.toJson())}`);

  step(5, "Query");
  const page = await reader
    .select({ key: true })
    .where(eq("project", PROJECT), eq("entity_type", "hello"))
    .createdBy(owner)
    .limit(5)
    .fetch();
  const keys = page.entities.map((e) => e.key);
  ok(`${keys.length} result(s) at block ${page.blockNumber}: ${keys.join(", ")}`);
  assert(keys.includes(created.entityKey), "query result must include the new key");

  step(6, "Create + burn batch");
  const [predicted] = await reader.predictEntityKeys({ owner, count: 1 });
  assert(predicted, "predictEntityKeys returned nothing");
  const batch = await wallet.executeBatch({
    creates: [
      {
        salt: predicted.salt,
        payload: jsonToPayload({ hello: "burned" }),
        contentType: "application/json",
        attributes: helloAttrs(),
        expires: ExpirationTime.fromMinutes(10),
        flags: { readonly: true },
      },
    ],
    ownershipChanges: [{ entityKey: predicted.key, newOwner: DEAD }],
  });
  ok(`key ${predicted.key}`);
  ok(`tx  ${batch.txHash}`);
  ok(`    ${txUrl(batch.txHash)}`);
  assert(batch.createdEntities.includes(predicted.key), "predicted key must match created key");
  const burned = await reader.getEntity(predicted.key);
  ok(`owner ${burned.owner}, creator ${burned.creator}`);
  assert(burned.owner.toLowerCase() === DEAD.toLowerCase(), "owner must be the dead address");
  assert(burned.creator.toLowerCase() === owner.toLowerCase(), "creator must be the owner wallet");

  step(7, "Live events over WebSocket");
  const ws = makeWsReader(env);
  const seen = new Set<string>();
  let resolveSeen: (k: string) => void = () => {};
  const unwatch = ws.watchEntityEvents({
    onEntityCreated: (e) => {
      seen.add(e.entityKey);
      resolveSeen(e.entityKey);
    },
    onError: (err) => console.error(`  ! watcher error: ${err.message}`),
  });
  try {
    const live = await wallet.createEntity({
      payload: jsonToPayload({ hello: "live" }),
      contentType: "application/json",
      attributes: helloAttrs(),
      expires: ExpirationTime.fromMinutes(10),
    });
    ok(`created ${live.entityKey} (tx ${live.txHash}), waiting for EntityCreated…`);
    const arrived = await new Promise<boolean>((resolve) => {
      if (seen.has(live.entityKey)) return resolve(true);
      resolveSeen = (k) => k === live.entityKey && resolve(true);
      setTimeout(() => resolve(false), 30_000);
    });
    assert(arrived, "EntityCreated event did not arrive within 30 s");
    ok(`EntityCreated received for ${live.entityKey}`);
  } finally {
    unwatch(); // the WS socket itself is closed by process.exit below
  }

  console.log("\nAll 7 steps passed.");
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
