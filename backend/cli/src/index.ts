#!/usr/bin/env -S npx tsx
import { readFileSync } from "node:fs";
import { ExpirationTime, jsonToPayload } from "@arkiv-network/sdk";
import { str } from "@arkiv-network/sdk/attr";
import { Command, InvalidArgumentError } from "commander";
import type { Hex } from "viem";
import {
  PublicTriggerSpec,
  demoFeedAttributes,
  loadTriggers,
  parseSpec,
  triggerAttributes,
  txUrl,
  type DemoFeedKind,
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
  .action(async (file: string, opts: { days: number }) => {
    const spec = parseSpec(PublicTriggerSpec, JSON.parse(readFileSync(file, "utf8")));
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
    console.log(`  ${spec.cond.type}, creator ${wallet.account.address}, expires in ${opts.days}d`);
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
  .description("Emit synthetic demo_feed entities (signed by the owner wallet)")
  .option("--kind <kind>", "heartbeat | event", "event")
  .option("--count <n>", "how many entities to emit", positiveInt, 1)
  .option("--interval <s>", "seconds between entities", positiveInt, 10)
  .option("--ttl <min>", "entity lifetime in minutes", positiveInt, 60)
  .action(async (opts: { kind: string; count: number; interval: number; ttl: number }) => {
    if (opts.kind !== "heartbeat" && opts.kind !== "event") {
      throw new InvalidArgumentError(`--kind must be heartbeat or event, got "${opts.kind}"`);
    }
    const kind: DemoFeedKind = opts.kind;
    const wallet = ownerWallet();
    for (let seq = 1; seq <= opts.count; seq++) {
      const { entityKey, txHash } = await wallet.createEntity({
        payload: jsonToPayload({ kind, seq, synthetic: true }),
        contentType: "application/json",
        attributes: demoFeedAttributes(kind, seq),
        expires: ExpirationTime.fromMinutes(opts.ttl),
      });
      console.log(`${kind} #${seq} ${entityKey}  ${txUrl(txHash)}`);
      if (seq < opts.count) await new Promise((r) => setTimeout(r, opts.interval * 1000));
    }
  });

try {
  await program.parseAsync();
} catch (err) {
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
