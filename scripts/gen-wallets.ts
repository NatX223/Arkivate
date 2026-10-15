import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

// Prints fresh keypairs to stdout only. Never writes a file.
const roles = ["OWNER", "SEALED_OWNER", "WORKER_A", "WORKER_B"] as const;
const wallets = roles.map((role) => {
  const pk = generatePrivateKey();
  return { role, pk, address: privateKeyToAccount(pk).address };
});

console.log("# --- paste into .env (keep secret) ---");
for (const w of wallets) console.log(`${w.role}_PRIVATE_KEY=${w.pk}`);
console.log("\n# --- paste into WALLETS.md (public) ---");
for (const w of wallets) console.log(`| ${w.role.toLowerCase()} | ${w.address} |`);
