/**
 * The Office golden rule's key. Two commands, both interactive, neither of which ever writes the
 * password anywhere:
 *
 *   pnpm run office-rule:password   — set (or change) the password that guards the rule.
 *   pnpm run office-rule:unlock     — prove you hold it, then re-pin the rule to the current code.
 *
 * WHY A VERIFIER AND NOT A PASSWORD. What gets committed is a scrypt verifier: a random 16-byte
 * salt and the 64-byte derived key, at N=2^17. The password cannot be read back out of it, so the
 * repository, its clones, its CI logs and every AI session that reads this file all hold something
 * that can CHECK the password and never one that can supply it. A plaintext passphrase in a
 * committed file was tried here on 2026-07-31 and removed for exactly that reason: it authenticated
 * nobody. This is the version that works.
 *
 * FAIL CLOSED. If no verifier has been set yet, `unlock` refuses — it does not fall through to
 * "no password configured, go ahead". An unarmed lock is still a lock.
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { behaviourFingerprint, sourceFingerprint } from "./check-office-golden-rule.ts";

const VERIFIER_PATH = fileURLToPath(new URL("../src/lib/sales/office-golden-rule.lock.json", import.meta.url));
const RULE_PATH = fileURLToPath(new URL("../src/lib/sales/office-golden-rule.ts", import.meta.url));

// N=2^17 with r=8 needs ~128 MB of scratch, so raise the default 32 MB ceiling. Deliberately slow:
// a wrong guess costs the guesser ~1s, and the whole verifier is one derivation.
const SCRYPT = { N: 131_072, r: 8, p: 1, keyLength: 64, maxmem: 256 * 1024 * 1024 } as const;

type Verifier = { algorithm: "scrypt"; N: number; r: number; p: number; keyLength: number; salt: string; verifier: string; setAt: string };

const derive = (password: string, salt: Buffer, params: { N: number; r: number; p: number; keyLength: number }) =>
  scryptSync(password.normalize("NFKC"), salt, params.keyLength, { N: params.N, r: params.r, p: params.p, maxmem: SCRYPT.maxmem });

/** Read a line from the terminal without echoing it. */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // Swallow the echo but keep the prompt itself visible.
    let shown = false;
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
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

function checkPassword(password: string, v: Verifier): boolean {
  const salt = Buffer.from(v.salt, "hex");
  const expected = Buffer.from(v.verifier, "hex");
  const actual = derive(password, salt, v);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function setPassword() {
  const existing = loadVerifier();
  if (existing) {
    console.log("A password is already set for the Office golden rule. Prove the current one first.\n");
    const current = await promptHidden("Current password: ");
    if (!checkPassword(current, existing)) {
      console.error("\nWrong password. Nothing changed.");
      process.exit(1);
    }
  } else {
    console.log("No password is set for the Office golden rule yet. Setting one arms the unlock path.\n");
  }
  const next = await promptHidden("New password: ");
  const again = await promptHidden("Repeat it:    ");
  if (next !== again) {
    console.error("\nThe two entries do not match. Nothing changed.");
    process.exit(1);
  }
  if (next.length < 8) {
    console.error("\nToo short — use at least 8 characters. Nothing changed.");
    process.exit(1);
  }
  const salt = randomBytes(16);
  const verifier: Verifier = {
    algorithm: "scrypt",
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    keyLength: SCRYPT.keyLength,
    salt: salt.toString("hex"),
    verifier: derive(next, salt, SCRYPT).toString("hex"),
    setAt: new Date().toISOString(),
  };
  writeFileSync(VERIFIER_PATH, `${JSON.stringify(verifier, null, 2)}\n`, "utf8");
  console.log(`\nSet. The verifier is at src/lib/sales/office-golden-rule.lock.json — commit it.`);
  console.log("Your password is not stored anywhere and cannot be recovered from that file.");
}

function repin(): { source: string; behaviour: string } {
  const source = sourceFingerprint();
  const behaviour = behaviourFingerprint();
  const before = readFileSync(RULE_PATH, "utf8");
  const after = before
    .replace(/OFFICE_RULE_SOURCE_FINGERPRINT\s*=\s*"[^"]*"/, `OFFICE_RULE_SOURCE_FINGERPRINT =\n  "${source}"`)
    .replace(/OFFICE_RULE_BEHAVIOUR_FINGERPRINT\s*=\s*"[^"]*"/, `OFFICE_RULE_BEHAVIOUR_FINGERPRINT =\n  "${behaviour}"`);
  if (after === before) throw new Error("Could not find the fingerprint constants to re-pin in office-golden-rule.ts.");
  writeFileSync(RULE_PATH, after, "utf8");
  return { source, behaviour };
}

async function unlock() {
  const v = loadVerifier();
  if (!v) {
    console.error("The Office golden rule has no password set, so it cannot be unlocked.");
    console.error("The owner sets one with:  pnpm run office-rule:password");
    process.exit(1);
  }
  console.log("Re-pinning the Office golden rule to the code as it stands right now.");
  console.log("This is the owner's rule. Do not run it on his behalf without him asking.\n");
  const password = await promptHidden("Owner password: ");
  if (!checkPassword(password, v)) {
    console.error("\nWrong password. The rule is unchanged.");
    process.exit(1);
  }
  const pinned = repin();
  console.log("\nUnlocked and re-pinned:");
  console.log(`  source fingerprint    ${pinned.source}`);
  console.log(`  behaviour fingerprint ${pinned.behaviour}`);
  console.log("\nCommit src/lib/sales/office-golden-rule.ts. Then run `pnpm run check:office-rule` to confirm.");
}

const mode = process.argv[2];
if (mode === "--set-password") await setPassword();
else if (mode === "--unlock") await unlock();
else {
  console.error("Usage:\n  pnpm run office-rule:password   set or change the password\n  pnpm run office-rule:unlock     re-pin the rule (needs the password)");
  process.exit(1);
}
