import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { ENTITY_TYPES, PROJECT, type Reader } from "@arkivate/core";
import express from "express";
import pino from "pino";
import type { Hex } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChainWriter } from "./chain.js";
import { cors } from "./cors.js";
import { handoffRouter } from "./handoff.js";
import type { Store } from "./store.js";

const APP = "https://arkivate.example.app";
const EVIL = "https://evil.example.com";
const WORKER = "0x1111111111111111111111111111111111111111" as Hex;
const ALLOWED_CREATOR = "0x2222222222222222222222222222222222222222" as Hex;
const OTHER_CREATOR = "0x3333333333333333333333333333333333333333" as Hex;
const KEY_ALLOWED = `0x${"a".repeat(64)}` as Hex;
const KEY_OTHER = `0x${"b".repeat(64)}` as Hex;

// Sealed entities: both name a different worker, so an allowlisted creator gets past the
// allowlist and stops at the next check instead.
const entities: Record<string, { creator: Hex; attributes: Record<string, { value: unknown }> }> = {
  [KEY_ALLOWED]: { creator: ALLOWED_CREATOR, attributes: sealedAttrs() },
  [KEY_OTHER]: { creator: OTHER_CREATOR, attributes: sealedAttrs() },
};
function sealedAttrs() {
  return {
    project: { value: PROJECT },
    entity_type: { value: ENTITY_TYPES.sealed },
    worker: { value: "0x9999999999999999999999999999999999999999" },
  };
}

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(
    handoffRouter({
      reader: { getEntity: async (k: Hex) => entities[k] } as unknown as Reader,
      store: { data: { sealed: {} } } as unknown as Store,
      log: pino({ level: "silent" }),
      address: WORKER,
      writer: () => ({}) as ChainWriter,
      corsOrigins: [APP, "http://localhost:3000"],
      triggerCreators: [ALLOWED_CREATOR.toLowerCase()],
      onAccepted: async () => {},
    }),
  );
  app.get("/health", cors([APP], "GET"), (_req, res) => void res.json({ ok: true }));
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise((r) => server.close(r)));

const handoff = (sealedKey: Hex, origin = APP) =>
  fetch(`${base}/sealed`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({
      sealed_key: sealedKey,
      spec: {},
      salt: `0x${"c".repeat(64)}`,
      destination: { type: "webhook", value: "https://hooks.example.com/x" },
      signature: "0x00",
    }),
  });

describe("CORS", () => {
  it("echoes an allowed origin on /health", async () => {
    const r = await fetch(`${base}/health`, { headers: { origin: APP } });
    expect(r.status).toBe(200);
    expect(r.headers.get("access-control-allow-origin")).toBe(APP);
    expect(r.headers.get("vary")).toMatch(/origin/i);
  });

  it("sends no CORS header to a denied origin on /health", async () => {
    const r = await fetch(`${base}/health`, { headers: { origin: EVIL } });
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("matches origins exactly", async () => {
    const r = await fetch(`${base}/health`, { headers: { origin: `${APP}.evil.com` } });
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("answers an allowed preflight on /sealed", async () => {
    const r = await fetch(`${base}/sealed`, {
      method: "OPTIONS",
      headers: { origin: "http://localhost:3000", "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
    });
    expect(r.status).toBe(204);
    expect(r.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    expect(r.headers.get("access-control-allow-methods")).toContain("POST");
    expect(r.headers.get("access-control-allow-headers")).toContain("content-type");
  });

  it("rejects a denied preflight on /sealed", async () => {
    const r = await fetch(`${base}/sealed`, {
      method: "OPTIONS",
      headers: { origin: EVIL, "access-control-request-method": "POST" },
    });
    expect(r.status).toBe(403);
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("sends no CORS header on a POST from a denied origin", async () => {
    const r = await handoff(KEY_ALLOWED, EVIL);
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("POST /sealed creator allowlist", () => {
  it("rejects a sealed entity whose creator is not in TRIGGER_CREATORS", async () => {
    const r = await handoff(KEY_OTHER);
    expect(r.status).toBe(403);
    const body = (await r.json()) as { error: string };
    expect(body.error).toContain("TRIGGER_CREATORS");
    expect(body.error).toContain(OTHER_CREATOR);
  });

  it("lets an allowlisted creator through to the next check", async () => {
    const r = await handoff(KEY_ALLOWED);
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: string }).error).toBe("this sealed job names a different worker");
  });
});
