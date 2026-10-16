import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

// Prints fresh keypairs to stdout only. Never writes a file.
const roles = ["owner", "sealed_owner", "worker_a", "worker_b"] as const;
const wallets = roles.map((role) => {
  const pk = generatePrivateKey();
  return { role, pk, address: privateKeyToAccount(pk).address };
});
const [owner, sealedOwner, workerA, workerB] = wallets;

console.log("# --- paste into local .env (keep secret) ---");
console.log(`OWNER_PRIVATE_KEY=${owner!.pk}`);
console.log(`SEALED_OWNER_PRIVATE_KEY=${sealedOwner!.pk}`);
console.log("\n# --- worker keys: one per deployment, set as WORKER_PRIVATE_KEY (Secret Manager) ---");
console.log(`# worker-a (secret worker-a-key)\nWORKER_PRIVATE_KEY=${workerA!.pk}`);
console.log(`# worker-b (secret worker-b-key)\nWORKER_PRIVATE_KEY=${workerB!.pk}`);
console.log("\n# --- paste into WALLETS.md (public) ---");
for (const w of wallets) console.log(`| ${w.role} | ${w.address} | |`);
