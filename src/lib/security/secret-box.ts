// Security — authenticated symmetric encryption for secrets that must live in the database
// (mailbox app passwords, and any future at-rest credential Phoenix has to keep).
//
// WHY THIS EXISTS. Most Phoenix secrets are env vars, read at runtime and never persisted. A few
// features need a credential the OWNER pastes in at runtime and Phoenix must store and reuse — the
// mailbox compliance monitor is the first. Storing such a value in plaintext in Supabase would mean
// a single DB read (a leaked service-role key, an anon-readable backup table, a careless dump) hands
// over live mailbox passwords. So every stored secret is sealed here first.
//
// DESIGN. AES-256-GCM (authenticated: tampering is detected on open, not silently decrypted to
// garbage), a fresh random IV per value, and a fresh random salt per value so two identical
// plaintexts never seal to the same blob. The 256-bit key is scrypt-derived from a single
// server-only env secret (MAILBOX_MONITOR_SECRET); the derivation salt travels inside the blob, so
// the env holds one human-manageable passphrase rather than raw key bytes. The env secret NEVER
// appears in the repo, in a migration, or in any row — only on Railway.
//
// FORMAT (all parts base64url, joined by ":"): `v1:<salt>:<iv>:<tag>:<ciphertext>`. The version tag
// lets the scheme rotate later without a flag-day: a future opener switches on the prefix.

import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const VERSION = "v1";
const KEY_LENGTH = 32; // AES-256
const IV_LENGTH = 12; // GCM standard nonce
const SALT_LENGTH = 16;
const TAG_LENGTH = 16;

/** Thrown for every failure — a missing key, a malformed blob, or a failed authentication tag.
 *  Callers surface a generic message; the specifics stay server-side. */
export class SecretBoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretBoxError";
  }
}

/** The server-only env secret a key is derived from. MAILBOX_MONITOR_SECRET unless a caller names another. */
export type SecretBoxKeyEnv = "MAILBOX_MONITOR_SECRET" | "PHOENIX_AUTH_SECRET";

function envSecret(keyEnv: SecretBoxKeyEnv = "MAILBOX_MONITOR_SECRET"): string {
  const raw = process.env[keyEnv];
  if (typeof raw !== "string" || raw.trim().length < 16) {
    // A short or absent secret is a configuration error, not a runtime edge case: refuse to seal
    // or open rather than fall back to a weak or predictable key.
    throw new SecretBoxError(
      `${keyEnv} is not set (or is too short). Set a long random value on the server before storing credentials.`,
    );
  }
  return raw;
}

/**
 * Which feature a sealed value belongs to. Omitted, the key is exactly the one every existing blob
 * was sealed under — so the mailbox monitor's stored passwords open unchanged.
 *
 * WHY A CONTEXT EXISTS. The personal mailbox (src/lib/personal-mailbox/) stores each employee's OWN
 * app password, and the owner's rule is that no one else can open that mailbox through Phoenix — the
 * compliance monitor least of all. Separate tables already keep the two apart in code; the context
 * makes it hold in the cryptography too. A value sealed under "personal-mailbox" derives a different
 * key, so the monitor's openSecret(sealed) fails the GCM tag check on it instead of decrypting it,
 * even if a blob were ever copied from one table into the other.
 */
export type SecretBoxOptions = {
  context?: string;
  /**
   * Which env secret the key comes from. Omitted, MAILBOX_MONITOR_SECRET, as every existing blob.
   * The email outbox seals a queued reset code or set-your-password link under PHOENIX_AUTH_SECRET,
   * the secret those credentials already depend on, so a server that can mint them can always send them.
   */
  keyEnv?: SecretBoxKeyEnv;
};

function keyMaterial(options?: SecretBoxOptions): string {
  const secret = envSecret(options?.keyEnv);
  const context = options?.context?.trim();
  // NUL cannot appear in an env value, so no secret+context pair can collide with a bare secret.
  return context ? `${secret}\u0000${context}` : secret;
}

function deriveKey(secret: string, salt: Buffer): Buffer {
  // scrypt with library defaults (N=16384, r=8, p=1) — comfortably fast for the handful of
  // seal/open calls this feature makes, and far past brute-force reach for a strong passphrase.
  return scryptSync(secret, salt, KEY_LENGTH);
}

function toB64(buffer: Buffer): string {
  return buffer.toString("base64url");
}

function fromB64(value: string, label: string): Buffer {
  try {
    return Buffer.from(value, "base64url");
  } catch {
    throw new SecretBoxError(`Sealed value has an unreadable ${label} segment.`);
  }
}

/**
 * Encrypt a plaintext secret into a self-describing sealed string.
 * Returns the `v1:…` blob; store it verbatim.
 */
export function sealSecret(plaintext: string, options?: SecretBoxOptions): string {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new SecretBoxError("Nothing to seal — plaintext is empty.");
  }
  const secret = keyMaterial(options);
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const key = deriveKey(secret, salt);

  // Explicit for the same reason as the opener: it pins the tag this seal produces at 128 bits
  // rather than relying on the default staying 128 bits. Same value as the default, so blobs
  // sealed before and after this line are byte-compatible.
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_LENGTH });
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [VERSION, toB64(salt), toB64(iv), toB64(tag), toB64(ciphertext)].join(":");
}

/**
 * Decrypt a sealed string back to plaintext. Throws SecretBoxError if the blob is malformed, the
 * key is wrong, or the authentication tag does not verify (tampering / corruption).
 */
export function openSecret(sealed: string, options?: SecretBoxOptions): string {
  if (typeof sealed !== "string" || sealed.length === 0) {
    throw new SecretBoxError("Nothing to open — sealed value is empty.");
  }
  const parts = sealed.split(":");
  if (parts.length !== 5 || parts[0] !== VERSION) {
    throw new SecretBoxError("Sealed value is not in the expected v1 format.");
  }
  const [, saltB64, ivB64, tagB64, ctB64] = parts;
  const salt = fromB64(saltB64, "salt");
  const iv = fromB64(ivB64, "iv");
  const tag = fromB64(tagB64, "tag");
  const ciphertext = fromB64(ctB64, "ciphertext");
  if (salt.length !== SALT_LENGTH || iv.length !== IV_LENGTH || tag.length !== TAG_LENGTH) {
    throw new SecretBoxError("Sealed value has a segment of the wrong length.");
  }

  const key = deriveKey(keyMaterial(options), salt);
  // `authTagLength` is passed explicitly so NODE enforces the 128-bit tag, not just the length
  // check above. GCM permits truncated tags (96, 64, even 32 bits), and a shorter tag is
  // exponentially easier to forge — at 32 bits a blind forgery succeeds about 1 attempt in 4
  // billion, which is reachable. Without this option `setAuthTag` accepts whatever length it is
  // handed, so the ONLY thing rejecting a truncated tag would be the `tag.length !== TAG_LENGTH`
  // check five lines up: correct today, but it reads as input validation rather than as a
  // load-bearing crypto guarantee, and is exactly the kind of line a tidy-up deletes. Stating it
  // here puts the guarantee at the point of use. 16 bytes is also GCM's default, so this changes
  // nothing about which existing blobs open — pinned by the pre-change fixture in
  // tests/secret-box.test.ts.
  const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_LENGTH });
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    // Wrong key or tampered ciphertext — GCM final() throws. Do not leak which.
    throw new SecretBoxError("Could not open sealed value — wrong key or corrupted data.");
  }
}

/** True when `sealed` is a well-formed v1 blob (does not attempt to decrypt). */
export function isSealed(value: unknown): boolean {
  return typeof value === "string" && value.startsWith(`${VERSION}:`) && value.split(":").length === 5;
}

/**
 * A stable, NON-reversible fingerprint of a sealed secret's plaintext, for detecting "did this
 * credential actually change?" without opening two blobs to compare. Uses the derived-key HMAC-free
 * approach: we simply seal-open is avoided; instead callers compare the fingerprints. Kept short and
 * safe to log. (Two different plaintexts collide with negligible probability.)
 */
export function sealedFingerprint(sealed: string): string {
  // Deterministic tag over the plaintext, keyed by the env secret. Never reveals the plaintext.
  const plaintext = openSecret(sealed);
  const key = deriveKey(envSecret(), Buffer.alloc(SALT_LENGTH, 7)); // fixed salt → deterministic
  const cipher = createCipheriv("aes-256-gcm", key, Buffer.alloc(IV_LENGTH, 11), {
    authTagLength: TAG_LENGTH,
  });
  cipher.update(plaintext, "utf8");
  cipher.final();
  return cipher.getAuthTag().toString("hex").slice(0, 16);
}

/** Constant-time equality for two secret strings (e.g. confirming a re-paste matches). */
export function secretsEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
