import { describe, expect, it } from "vitest";
import { parseEnv } from "./config.js";

const HEX = "ab".repeat(32);

describe("parseEnv", () => {
  it("accepts private keys with or without 0x", () => {
    expect(parseEnv({ WORKER_PRIVATE_KEY: HEX }).WORKER_PRIVATE_KEY).toBe(`0x${HEX}`);
    expect(parseEnv({ WORKER_PRIVATE_KEY: `0x${HEX}` }).WORKER_PRIVATE_KEY).toBe(`0x${HEX}`);
    expect(parseEnv({ WORKER_PRIVATE_KEY: ` ${HEX} ` }).WORKER_PRIVATE_KEY).toBe(`0x${HEX}`);
  });

  it("rejects a malformed key without echoing it", () => {
    expect(() => parseEnv({ WORKER_PRIVATE_KEY: "0x1234" })).toThrow(/WORKER_PRIVATE_KEY/);
    expect(() => parseEnv({ WORKER_PRIVATE_KEY: "0x1234deadbeef" })).not.toThrow(/deadbeef/);
  });

  it("defaults CORS_ORIGINS to the local web app", () => {
    expect(parseEnv({}).CORS_ORIGINS).toEqual(["http://localhost:3000"]);
  });

  it("splits CORS_ORIGINS and strips trailing slashes", () => {
    expect(parseEnv({ CORS_ORIGINS: "https://a.example.app/, http://localhost:3000" }).CORS_ORIGINS).toEqual([
      "https://a.example.app",
      "http://localhost:3000",
    ]);
  });

  it("rejects wildcards and paths in CORS_ORIGINS", () => {
    expect(() => parseEnv({ CORS_ORIGINS: "*" })).toThrow(/CORS_ORIGINS/);
    expect(() => parseEnv({ CORS_ORIGINS: "https://a.example.app/app" })).toThrow(/CORS_ORIGINS/);
  });

  it("treats blank values as unset", () => {
    const env = parseEnv({ WORKER_PORT: "", CORS_ORIGINS: " ", MAX_RECEIPTS_PER_TRIGGER_PER_HOUR: "", ARKIV_RPC_HTTP: "" });
    expect(env.WORKER_PORT).toBe(8787);
    expect(env.CORS_ORIGINS).toEqual(["http://localhost:3000"]);
    expect(env.MAX_RECEIPTS_PER_TRIGGER_PER_HOUR).toBe(12);
    expect(env.ARKIV_RPC_HTTP).toMatch(/^https:/);
  });

  it("keeps an absolute DATA_DIR as is", () => {
    const abs = process.platform === "win32" ? "C:\\var\\lib\\arkivate" : "/var/lib/arkivate";
    expect(parseEnv({ DATA_DIR: abs }).DATA_DIR).toBe(abs);
  });
});
