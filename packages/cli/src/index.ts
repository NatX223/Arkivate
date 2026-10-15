#!/usr/bin/env -S npx tsx
import { Command } from "commander";

const program = new Command()
  .name("arkivate")
  .description("If-this-then-that for Arkiv data: create, seal and verify triggers.")
  .version("0.0.1");

const notImplemented = (name: string) => () => {
  console.error(`arkivate ${name}: not implemented yet`);
  process.exitCode = 1;
};

program.command("create").description("Create a public trigger from a spec file").action(notImplemented("create"));
program.command("pause").description("Pause or resume a public trigger").action(notImplemented("pause"));
program.command("seal").description("Publish a sealed trigger commitment").action(notImplemented("seal"));
program.command("handoff").description("Send a sealed spec privately to a worker").action(notImplemented("handoff"));
program.command("reveal").description("Reveal a sealed spec to open a dispute").action(notImplemented("reveal"));
program.command("verify").description("Verify whether a worker skipped a sealed job").action(notImplemented("verify"));
program.command("demo-feed").description("Emit synthetic demo_feed entities").action(notImplemented("demo-feed"));

await program.parseAsync();
