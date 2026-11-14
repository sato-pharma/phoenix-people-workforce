#!/usr/bin/env node
/**
 * Makes the passwords of the explorer's STAGING-only logins, on the machine that runs the explorer.
 *
 *   node scripts/phoenix-inspect/make-persona-secrets.mjs [--module kpi-reports] [--rotate]
 *
 * Writes ~/.phoenix-inspect/staging-personas.json ({ "<login>": "<password>" }) on THIS machine, and
 * prints ONLY { "<login>": "<bcrypt hash>" } to stdout. The hash is what goes into staging's
 * app_auth_users.password_hash; the password itself never leaves this machine, never reaches a chat,
 * a log, a commit or another computer.
 *
 * An existing password is kept (so a re-run prints the same logins' hashes again, freshly salted, and
 * never locks the explorer out) unless --rotate is given. Cost 12, the app's own
 * (src/lib/auth/change-password.ts).
 */
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import bcrypt from "bcryptjs";

import { KPIS_MODULE } from "./modules/kpis.mjs";

import { refuseUnknownFlags } from "../lib/refuse-arguments.mjs";

// A flag this script does not know is refused before anything runs (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "make-persona-secrets",
  entry: import.meta.url,
  known: ["--module", "--rotate"],
  hints: ["node scripts/phoenix-inspect/make-persona-secrets.mjs [--module kpi-reports] [--rotate]"],
});

const MODULES = { "kpi-reports": KPIS_MODULE };
const argv = process.argv.slice(2);
const moduleId = argv.includes("--module") ? argv[argv.indexOf("--module") + 1] : "kpi-reports";
const rotate = argv.includes("--rotate");
const spec = MODULES[moduleId];
if (!spec) {
  console.error(`unknown module ${moduleId}`);
  process.exit(2);
}

const dir = path.join(os.homedir(), ".phoenix-inspect");
const file = path.join(dir, "staging-personas.json");
mkdirSync(dir, { recursive: true });
const held = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};

const hashes = {};
for (const persona of spec.personas) {
  if (rotate || typeof held[persona.login] !== "string" || held[persona.login].length < 24) {
    // 30 random bytes as base64url: 40 characters, letters, digits, "-" and "_".
    held[persona.login] = randomBytes(30).toString("base64url");
  }
  hashes[persona.login] = await bcrypt.hash(held[persona.login], 12);
}
writeFileSync(file, `${JSON.stringify(held, null, 2)}\n`, { mode: 0o600 });
try {
  chmodSync(file, 0o600);
} catch {
  // Windows keeps the file inside the user's own profile, which only that user can read.
}
console.log(JSON.stringify(hashes));
