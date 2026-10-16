#!/usr/bin/env -S npx tsx
import { readFileSync } from "node:fs";
import { ExpirationTime, jsonToPayload } from "@arkiv-network/sdk";
import { str } from "@arkiv-network/sdk/attr";
import { Command, InvalidArgumentError } from "commander";
import type { Hex } from "viem";
import {
  DEMO_FEED_KINDS,
  PublicTriggerSpec,
  demoFeedAttributes,
  readLive,
  loadTriggers,
  parseSpec,
  triggerAttributes,
  txUrl,
} from "@arkivate/core";
import { loadConfig, makeReader, makeWallet } from "@arkivate/core/server";

const program = new Command()
  .name("arkivate")
  .description("If-this-then-that for Arkiv data: create, seal and verify triggers.")
  .version("0.0.1");

const notImplemented = (name: string) => () => {
  console.error(`arkivate ${name}: not implemented yet`);
  process.exitCode = 1;
};

const positiveInt = (v: string) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new InvalidArgumentError("must be a positive integer");
  return n;
};

const entityKey = (v: string) => {
  if (!/^0x[0-9a-fA-F]{64}$/.test(v)) throw new InvalidArgumentError("must be a 0x-prefixed 32-byte key");
  return v as Hex;
};

function ownerWallet() {
  const env = loadConfig(["OWNER_PRIVATE_KEY"]);
  return makeWallet(env.OWNER_PRIVATE_KEY as Hex, env);
}

program
  .command("create")
  .description("Create a public trigger from a spec file")
  .argument("<spec-file>", "path to a TriggerSpec JSON file (see backend/cli/examples)")
  .option("--days <n>", "trigger lifetime in days", positiveInt, 7)
  .option("--watch-key <key>", "expiry conditions: watch this one entity instead of the spec's watch", entityKey)
  .action(async (file: string, opts: { days: number; watchKey?: Hex }) => {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { cond?: Record<string, unknown> };
    if (opts.watchKey) {
      if (!raw.cond || !("watch" in raw.cond)) throw new InvalidArgumentError("--watch-key needs an expiry condition (one with `watch`)");
      raw.cond.watch = { entity_key: opts.watchKey };
    }
    const spec = parseSpec(PublicTriggerSpec, raw);
    const wallet = ownerWallet();
    const { entityKey, txHash } = await wallet.createEntity({
      payload: jsonToPayload(spec),
      contentType: "application/json",
      attributes: triggerAttributes(spec),
      expires: ExpirationTime.fromDays(opts.days),
      // Anyone (e.g. a subscriber) may keep a useful public trigger alive.
      flags: { permissionlessExtension: true },
    });
    console.log(`trigger ${entityKey}`);
    const watch = "watch" in spec.cond ? spec.cond.watch : undefined;
    console.log(`  ${spec.cond.type} → ${spec.action.type}, creator ${wallet.account.address}, expires in ${opts.days}d`);
    if (watch && "entity_key" in watch) console.log(`  watching ${watch.entity_key}`);
    console.log(`  tx ${txUrl(txHash)}`);
  });

program
  .command("pause")
  .description("Pause or resume a public trigger")
  .argument("<trigger-key>", "trigger entity key", entityKey)
  .option("--resume", "set the trigger back to active")
  .action(async (key: Hex, opts: { resume?: boolean }) => {
    const status = opts.resume ? "active" : "paused";
    const { txHash } = await ownerWallet().patchEntity({ entityKey: key, set: { status: str(status) } });
    console.log(`trigger ${key} → ${status}`);
    console.log(`  tx ${txUrl(txHash)}`);
  });

program
  .command("list")
  .description("List live public triggers")
  .option("--paused", "list paused triggers instead of active ones")
  .action(async (opts: { paused?: boolean }) => {
    const { triggers, invalid } = await loadTriggers(makeReader(), opts.paused ? "paused" : "active");
    for (const t of triggers) {
      console.log(`${t.key}  ${t.spec.cond.type.padEnd(10)}  creator ${t.creator}  expires @${t.expiresAt}`);
    }
    for (const i of invalid) console.log(`${i.key}  INVALID: ${i.error}`);
    console.log(`${triggers.length} trigger(s), ${invalid.length} invalid`);
  });

program.command("seal").description("Publish a sealed trigger commitment").action(notImplemented("seal"));
program.command("handoff").description("Send a sealed spec privately to a worker").action(notImplemented("handoff"));
program.command("reveal").description("Reveal a sealed spec to open a dispute").action(notImplemented("reveal"));
program.command("verify").description("Verify whether a worker skipped a sealed job").action(notImplemented("verify"));

program
  .command("demo-feed")
  .description("Emit synthetic demo_feed entities, or extend/delete one (signed by the owner wallet)")
  .option("--kind <kind>", DEMO_FEED_KINDS.join(" | "), "event")
  .option("--count <n>", "how many entities to emit", positiveInt, 1)
  .option("--interval <s>", "seconds between entities", positiveInt, 10)
  .option("--ttl <min>", "heartbeat/event lifetime in minutes", positiveInt, 60)
  .option("--blocks <n>", "listing/canary lifetime, or --extend amount, in blocks (~2 s each)", positiveInt, 120)
  .option("--extend <key>", "extend this entity by --blocks (owner)", entityKey)
  .option("--delete <key>", "delete this entity (owner)", entityKey)
  .action(
    async (opts: {
      kind: string;
      count: number;
      interval: number;
      ttl: number;
      blocks: number;
      extend?: Hex;
      delete?: Hex;
    }) => {
      const wallet = ownerWallet();
      if (opts.extend) {
        const live = await readLive(makeReader(), opts.extend);
        if (!live) throw new Error(`${opts.extend} is not live (expired, deleted or never existed)`);
        // Absolute target, per the SDK's guidance: a duration would count from now, not from expiry.
        const target = live.expiresAt + BigInt(opts.blocks);
        const { txHash } = await wallet.extendEntity({ entityKey: opts.extend, expires: ExpirationTime.atBlock(target) });
        console.log(`extended ${opts.extend}: block ${live.expiresAt} → ${target}  ${txUrl(txHash)}`);
        return;
      }
      if (opts.delete) {
        const { txHash } = await wallet.deleteEntity({ entityKey: opts.delete });
        console.log(`deleted ${opts.delete}  ${txUrl(txHash)}`);
        return;
      }
      const kind = DEMO_FEED_KINDS.find((k) => k === opts.kind);
      if (!kind) throw new InvalidArgumentError(`--kind must be one of ${DEMO_FEED_KINDS.join(", ")}, got "${opts.kind}"`);
      const shortLived = kind === "listing" || kind === "canary";
      for (let seq = 1; seq <= opts.count; seq++) {
        const { entityKey, txHash } = await wallet.createEntity({
          payload: jsonToPayload({ kind, seq, synthetic: true }),
          contentType: "application/json",
          attributes: demoFeedAttributes(kind, seq),
          expires: shortLived ? ExpirationTime.fromBlocks(opts.blocks) : ExpirationTime.fromMinutes(opts.ttl),
          // listing: anyone (a worker) may keep it alive. canary: nobody but the owner can.
          ...(kind === "listing" ? { flags: { permissionlessExtension: true } } : {}),
        });
        const life = shortLived ? `${opts.blocks} blocks` : `${opts.ttl} min`;
        console.log(`${kind} #${seq} ${entityKey}  (${life})  ${txUrl(txHash)}`);
        if (seq < opts.count) await new Promise((r) => setTimeout(r, opts.interval * 1000));
      }
    },
  );

try {
  await program.parseAsync();
} catch (err) {
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
