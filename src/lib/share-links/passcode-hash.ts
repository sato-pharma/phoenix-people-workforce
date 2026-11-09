import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

// ─────────────────────────────────────────────────────────────────────────────
// The passcode on a live report share link (Direct Orders and Marketing Requests).
//
// A passcode is chosen by a person, so it may be a password they use elsewhere. It is stored as a
// slow, salted scrypt hash — `scrypt$<salt>$<hash>` — so a copy of the table does not hand back a
// reusable password at the speed of SHA-256.
//
// Links minted before 9 Nov 2026 carry the old hash: hex SHA-256 of `<token>:<passcode>`. Those still
// verify, so no link already sent stops working; a link lives at most 180 days, after which no old
// hash is left and `legacyHash` can go.
// ─────────────────────────────────────────────────────────────────────────────

const SCRYPT_PREFIX = "scrypt$";
const SCRYPT_KEY_LENGTH = 32;

function scryptHash(passcode: string, token: string, salt: Buffer): Buffer {
  // The token is still part of the input, so two links sharing a passcode do not share a hash.
  return scryptSync(`${token}:${passcode.trim()}`, salt, SCRYPT_KEY_LENGTH);
}

function legacyHash(passcode: string, token: string): Buffer {
  return createHash("sha256").update(`${token}:${passcode.trim()}`).digest();
}

/** The value written to `passcode_hash` for a new link. */
export function hashPasscode(passcode: string, token: string): string {
  const salt = randomBytes(16);
  return `${SCRYPT_PREFIX}${salt.toString("base64url")}$${scryptHash(passcode, token, salt).toString("hex")}`;
}

/** Whether a typed passcode matches the stored hash — either format, compared in constant time. */
export function passcodeMatches(input: string, token: string, expected: string | null): boolean {
  if (!expected) return true;
  let candidate: Buffer;
  let known: Buffer;
  if (expected.startsWith(SCRYPT_PREFIX)) {
    const [salt, hash] = expected.slice(SCRYPT_PREFIX.length).split("$");
    if (!salt || !hash) return false;
    known = Buffer.from(hash, "hex");
    candidate = scryptHash(input, token, Buffer.from(salt, "base64url"));
  } else {
    known = Buffer.from(expected, "hex");
    candidate = legacyHash(input, token);
  }
  // Constant-time: a length-varying compare leaks the prefix to a patient caller.
  if (candidate.length !== known.length) return false;
  return timingSafeEqual(candidate, known);
}
