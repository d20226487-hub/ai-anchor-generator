#!/usr/bin/env node
/**
 * Launches Next.js with `--use-system-ca` exported through NODE_OPTIONS.
 *
 * Why this wrapper exists
 * -----------------------
 * Antivirus/enterprise HTTPS scanning (Avast Web/Mail Shield, Kaspersky, ESET, Zscaler…)
 * terminates outbound TLS and re-signs it with its own root certificate. That root is
 * installed in the WINDOWS certificate store, which Node does not read by default — it
 * ships its own CA bundle. Every provider call therefore dies before leaving the machine:
 *
 *     fetch failed  (cause: UNABLE_TO_VERIFY_LEAF_SIGNATURE)
 *
 * `--use-system-ca` makes Node trust the OS store and fixes it. But passing it as a CLI
 * flag to `next dev` is NOT enough: Next spawns the actual request-handling worker
 * (`next/dist/server/lib/start-server.js`) as a CHILD process, and Node does not propagate
 * command-line flags to children. NODE_OPTIONS *is* inherited, so it has to go there.
 * Verified both ways — CLI flag: child fails; NODE_OPTIONS: child succeeds.
 *
 * If your Node predates the flag (< 22.15) we skip it rather than refuse to boot; set
 * NODE_EXTRA_CA_CERTS to your scanner's root .pem instead.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const FLAG = "--use-system-ca";

function supportsSystemCa() {
  const [maj, min] = process.versions.node.split(".").map(Number);
  return maj > 22 || (maj === 22 && min >= 15);
}

const require = createRequire(import.meta.url);
const nextBin = require.resolve("next/dist/bin/next");

const existing = process.env.NODE_OPTIONS ?? "";
const env = { ...process.env };
if (supportsSystemCa() && !existing.includes(FLAG)) {
  env.NODE_OPTIONS = `${existing} ${FLAG}`.trim();
}

const child = spawn(process.execPath, [nextBin, ...process.argv.slice(2)], {
  stdio: "inherit",
  env,
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
