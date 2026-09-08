/**
 * The weekly export designs' key. Owner instruction, 2026-09-08: the weekly BI export and the
 * weekly NSM/DSM export are *"never change unless set this password"*.
 *
 *   pnpm run weekly-design:password   — set (or change) the password that guards both designs.
 *   pnpm run weekly-design:unlock     — prove you hold it, then re-pin both to the current code.
 *
 * WHY A VERIFIER AND NOT A PASSWORD, the same reasoning the Office golden rule was built on. What
 * gets committed is a scrypt verifier: a random 16-byte salt and the 64-byte derived key at N=2^17.
 * The password cannot be read back out of it, so the repository, its clones, its CI logs and every
 * AI session that reads this file hold something that can CHECK the password and never one that can
 * supply it. A plaintext passphrase in a committed file was tried here on 2026-07-31 and removed for
 * exactly that reason — it authenticated nobody.
 *
 * FAIL CLOSED. If no verifier has been set, `unlock` REFUSES; it does not fall through to "no
 * password configured, go ahead". An unarmed lock is still a lock.
 *
 * 🔴 WHAT THIS PROTECTS AGAINST is not a malicious actor — it is a session, or a person, meeting a
 * red design test and reaching for the fastest way to green. Re-pinning is the wrong answer to that
 * red, and before this existed the pins were plain literals in a test file that anyone could edit in
 * five seconds. Now the only path that rewrites them asks for something the repository does not
 * contain.
 *
 * 🔴 NEVER RUN THIS AS `pnpm run …` FROM A WORKTREE — AGENTS.md §5's pnpm rule applies and this is
 * its worst case: pnpm runs its deps check first, sees the moved lockfile, and offers to delete the
 * PRIMARY's node_modules. Invoke node directly from the folder holding the change:
 *   node --experimental-strip-types --experimental-specifier-resolution=node \
 *     --experimental-loader ./tests/alias-loader.mjs scripts/weekly-export-design-unlock.ts --unlock
 * The FOLDER matters: run it in the primary while the edit sits in a worktree and it re-pins the
 * UNCHANGED source — a silent no-op that prints success.
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { LOCKED_EXPORTS } from "./weekly-export-design-fixtures.ts";
import { designFingerprint, describeDrift } from "./weekly-export-design-fingerprint.ts";

const VERIFIER_PATH = fileURLToPath(new URL("../src/lib/sales/weekly/export-design.lock.json", import.meta.url));
const PINS_PATH = fileURLToPath(new URL("../src/lib/sales/weekly/export-design.pins.json", import.meta.url));

// N=2^17 with r=8 needs ~128 MB of scratch, so raise the default 32 MB ceiling. Deliberately slow:
// a wrong guess costs the guesser ~1s, and the whole verifier is one derivation.
const SCRYPT = { N: 131_072, r: 8, p: 1, keyLength: 64, maxmem: 256 * 1024 * 1024 } as const;

type Verifier = {
  algorithm: "scrypt"; N: number; r: number; p: number; keyLength: number;
  salt: string; verifier: string; setAt: string;
};

const derive = (password: string, salt: Buffer, params: { N: number; r: number; p: number; keyLength: number }) =>
  scryptSync(password.normalize("NFKC"), salt, params.keyLength, {
    N: params.N, r: params.r, p: params.p, maxmem: SCRYPT.maxmem,
  });

/** Read a line from the terminal without echoing it. */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let shown = false;
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => {
      if (!shown) {
        process.stdout.write(question);
        shown = true;
      }
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

function loadVerifier(): Verifier | null {
  if (!existsSync(VERIFIER_PATH)) return null;
  return JSON.parse(readFileSync(VERIFIER_PATH, "utf8")) as Verifier;
}

function check(password: string, v: Verifier): boolean {
  const expected = Buffer.from(v.verifier, "hex");
  const actual = derive(password, Buffer.from(v.salt, "hex"), v);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Build both workbooks and fingerprint them. */
async function currentPins() {
  const out: Record<string, unknown> = {};
  for (const item of LOCKED_EXPORTS) {
    out[item.key] = await designFingerprint(await item.build());
  }
  return out;
}

async function setPassword(): Promise<void> {
  const existing = loadVerifier();
  if (existing) {
    const current = await promptHidden("Current password: ");
    if (!check(current, existing)) {
      console.error("\nWrong password. Nothing changed.");
      process.exit(1);
    }
  }
  const next = await promptHidden(existing ? "New password: " : "Password: ");
  if (next.trim().length < 6) {
    console.error("\nToo short. Nothing changed.");
    process.exit(1);
  }
  const again = await promptHidden("Repeat: ");
  if (next !== again) {
    console.error("\nThey do not match. Nothing changed.");
    process.exit(1);
  }
  const salt = randomBytes(16);
  const verifier: Verifier = {
    algorithm: "scrypt",
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, keyLength: SCRYPT.keyLength,
    salt: salt.toString("hex"),
    verifier: derive(next, salt, SCRYPT).toString("hex"),
    setAt: new Date().toISOString(),
  };
  writeFileSync(VERIFIER_PATH, `${JSON.stringify(verifier, null, 2)}\n`, "utf8");
  console.log("\nSet. The verifier is at src/lib/sales/weekly/export-design.lock.json — commit it.");
  console.log("The password itself is stored nowhere and cannot be recovered from this repository.");
}

async function unlock(): Promise<void> {
  const v = loadVerifier();
  if (!v) {
    // FAIL CLOSED — see the header. No verifier is not permission.
    console.error("No password has been set for the weekly export designs, so there is nothing to");
    console.error("unlock with. Run the password command first. Refusing rather than re-pinning.");
    process.exit(1);
  }
  const password = await promptHidden("Password: ");
  if (!check(password, v)) {
    console.error("\nWrong password. The pins are unchanged.");
    process.exit(1);
  }

  const built = await currentPins();
  const before = existsSync(PINS_PATH) ? JSON.parse(readFileSync(PINS_PATH, "utf8")) : null;

  // Say what is actually being changed, so a no-op is visible rather than reassuring. Running this
  // in the wrong folder re-pins unchanged source and prints success; naming the drift is the tell.
  let changed = false;
  for (const item of LOCKED_EXPORTS) {
    const drift = before?.[item.key] ? describeDrift(before[item.key], built[item.key] as never) : ["no previous pin — recording the current design"];
    if (drift.length === 0) {
      console.log(`  ${item.label}: unchanged`);
      continue;
    }
    changed = true;
    console.log(`  ${item.label}:`);
    for (const line of drift) console.log(`    - ${line}`);
  }
  if (!changed) {
    console.log("\nNothing to re-pin: both designs already match what is pinned.");
    console.log("If you expected a change, check you are in the folder that holds it.");
    return;
  }

  writeFileSync(PINS_PATH, `${JSON.stringify(built, null, 2)}\n`, "utf8");
  console.log("\nRe-pinned. Commit src/lib/sales/weekly/export-design.pins.json with the change it describes.");
}

const mode = process.argv[2];
if (mode === "--set-password") await setPassword();
else if (mode === "--unlock") await unlock();
else {
  console.error("Usage: weekly-export-design-unlock.ts --set-password | --unlock");
  process.exit(1);
}
