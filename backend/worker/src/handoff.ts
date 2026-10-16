import { NoEntityFoundError } from "@arkiv-network/sdk";
import { key as keyValue, str } from "@arkiv-network/sdk/attr";
import { eq } from "@arkiv-network/sdk/query";
import {
  ENTITY_TYPES,
  PROJECT,
  SealedTriggerSpec,
  commit,
  destinationDigest,
  handoffMessage,
  type Reader,
} from "@arkivate/core";
import express, { type Request, type Response, type Router } from "express";
import type { Logger } from "pino";
import { recoverMessageAddress, type Hex } from "viem";
import { z } from "zod";
import type { ChainWriter } from "./chain.js";
import type { Store } from "./store.js";

const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const Body = z.object({
  sealed_key: hex32,
  spec: z.unknown(),
  salt: hex32,
  destination: z.discriminatedUnion("type", [
    z.object({ type: z.literal("webhook"), value: z.url({ protocol: /^https?$/ }).max(2048) }),
    z.object({ type: z.literal("telegram"), value: z.string().regex(/^(-?\d{1,20}|@[A-Za-z0-9_]{5,32})$/) }),
  ]),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
});

class HandoffError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface HandoffDeps {
  reader: Reader;
  store: Store;
  log: Logger;
  address: Hex;
  writer: () => ChainWriter | null;
  corsOrigins: string;
  onAccepted: (sealedKey: Hex) => Promise<void>;
}

/**
 * `POST /sealed`: the private hand-off. The body (spec, salt, destination) is stored locally and
 * never logged; only the burned acceptance goes on Arkiv.
 */
export function handoffRouter(d: HandoffDeps): Router {
  const router = express.Router();
  const allowed = d.corsOrigins.split(",").map((o) => o.trim()).filter(Boolean);
  router.use("/sealed", (req, res, next) => {
    const origin = req.headers.origin;
    if (allowed.includes("*")) res.setHeader("access-control-allow-origin", "*");
    else if (origin && allowed.includes(origin)) {
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("vary", "origin");
    }
    res.setHeader("access-control-allow-methods", "POST, OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type");
    if (req.method === "OPTIONS") return void res.sendStatus(204);
    next();
  });

  // Concurrent identical hand-offs share one acceptance write.
  const inflight = new Map<string, Promise<{ status: number; body: unknown }>>();

  router.post("/sealed", express.json({ limit: "64kb" }), async (req: Request, res: Response) => {
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) {
      return void res.status(400).json({ error: `bad request: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}` });
    }
    const k = parsed.data.sealed_key.toLowerCase() as Hex;
    let p = inflight.get(k);
    if (!p) {
      p = accept(d, parsed.data).finally(() => inflight.delete(k));
      inflight.set(k, p);
    }
    try {
      const r = await p;
      res.status(r.status).json(r.body);
    } catch (e) {
      if (e instanceof HandoffError) return void res.status(e.status).json({ error: e.message });
      d.log.error({ sealed: k, err: e instanceof Error ? e.message : String(e) }, "hand-off failed");
      res.status(500).json({ error: "internal error" });
    }
  });
  return router;
}

async function accept(d: HandoffDeps, b: z.infer<typeof Body>): Promise<{ status: number; body: unknown }> {
  const sealedKey = b.sealed_key as Hex;
  const writer = d.writer();
  if (!writer) throw new HandoffError(503, "worker is not funded yet; it can't write an acceptance");

  // 1. The sealed entity exists, is live, and names this worker.
  let sealed;
  try {
    sealed = await d.reader.getEntity(sealedKey);
  } catch (e) {
    if (e instanceof NoEntityFoundError) throw new HandoffError(404, "sealed entity not found (expired, deleted or never existed)");
    throw e;
  }
  const attrs = sealed.attributes as Record<string, { value: unknown } | undefined>;
  if (attrs.entity_type?.value !== ENTITY_TYPES.sealed || attrs.project?.value !== PROJECT) {
    throw new HandoffError(400, "that key is not an Arkivate sealed entity");
  }
  const worker = String(attrs.worker?.value ?? "");
  if (worker.toLowerCase() !== d.address.toLowerCase()) throw new HandoffError(403, "this sealed job names a different worker");
  const commitment = String(attrs.commitment?.value ?? "") as Hex;

  // 2. The spec + salt open the commitment (hash exactly what was sent).
  if (commit(b.spec, b.salt as Hex).toLowerCase() !== commitment.toLowerCase()) {
    throw new HandoffError(400, "commitment mismatch: spec/salt don't hash to the sealed commitment");
  }

  // 3. Signed by the sealed entity's creator, over this exact request.
  const message = handoffMessage({
    sealedKey,
    commitment,
    workerAddress: d.address,
    destinationDigest: destinationDigest(b.destination),
  });
  let signer: Hex;
  try {
    signer = await recoverMessageAddress({ message, signature: b.signature as Hex });
  } catch {
    throw new HandoffError(401, "signature does not parse");
  }
  if (signer.toLowerCase() !== sealed.creator.toLowerCase()) {
    throw new HandoffError(401, "signature is not from the sealed entity's creator");
  }

  // 4. A valid sealed TriggerSpec.
  const spec = SealedTriggerSpec.safeParse(b.spec);
  if (!spec.success) throw new HandoffError(400, `invalid sealed spec: ${spec.error.issues[0]?.message}`);

  // 5. Idempotent: an existing acceptance (local, or on-chain if the store was lost) is returned.
  const existing = d.store.data.sealed[sealedKey];
  if (existing) return { status: 200, body: { acceptance_key: existing.acceptanceKey, tx: existing.acceptanceTx, idempotent: true } };
  const onChain = await d.reader
    .select({ key: true, attributes: { accepted_block: true } })
    .where(eq("project", str(PROJECT)), eq("entity_type", str(ENTITY_TYPES.acceptance)), eq("sealed", keyValue(sealedKey)))
    .createdBy(d.address)
    .limit(1)
    .fetch();

  let acceptanceKey: Hex;
  let tx: Hex;
  let acceptedBlock: bigint;
  const prior = onChain.entities[0];
  if (prior) {
    acceptanceKey = prior.key;
    tx = "0x" as Hex;
    const v = prior.attributes.accepted_block?.value;
    acceptedBlock = typeof v === "bigint" ? v : await d.reader.getBlockNumber();
  } else {
    acceptedBlock = await d.reader.getBlockNumber();
    const w = await writer.writeAcceptance(sealedKey, commitment, sealed.creator, acceptedBlock);
    acceptanceKey = w.key;
    tx = w.tx;
  }

  d.store.data.sealed[sealedKey] = {
    spec: spec.data,
    salt: b.salt as Hex,
    destination: b.destination,
    commitment,
    creator: sealed.creator,
    acceptanceKey,
    acceptanceTx: tx,
    acceptedBlock: acceptedBlock.toString(),
  };
  await d.store.write();
  // Spec and destination deliberately not logged.
  d.log.info({ sealed: sealedKey, acceptance: acceptanceKey }, "sealed job accepted");
  // Start the job in the background; the owner gets the acceptance without waiting on it.
  void d.onAccepted(sealedKey).catch((e: unknown) =>
    d.log.error({ sealed: sealedKey, err: e instanceof Error ? e.message : String(e) }, "activating sealed job failed"),
  );
  return { status: prior ? 200 : 201, body: { acceptance_key: acceptanceKey, tx, idempotent: Boolean(prior) } };
}
