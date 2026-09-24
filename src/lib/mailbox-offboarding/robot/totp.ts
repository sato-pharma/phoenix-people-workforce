/**
 * Time-based one-time passwords (RFC 6238) for the Turbify admin sign-in.
 *
 * WHY THIS EXISTS. The Turbify admin account enforces two-step verification: after the password it
 * demands a 6-digit code. A code sent to a phone cannot reach a headless robot on the server, so the
 * account's second factor is set to an AUTHENTICATOR APP, and the same seed the owner scans into his
 * own authenticator is stored server-side as `PHOENIX_TURBIFY_ADMIN_TOTP_SECRET`. This module turns
 * that seed into the current code, exactly as the authenticator app on a phone would, so the robot
 * can answer the challenge itself.
 *
 * The seed is a shared secret — anyone holding it can generate a valid second factor. It lives only
 * in the server environment, is never logged, and this module never accepts it as an argument that
 * could be printed by a caller: `currentTurbifyTotp()` reads it straight from the environment.
 *
 * Implemented on `node:crypto` (HMAC-SHA1) with no new dependency, and pinned against the RFC 6238
 * published test vectors in tests/mailbox-offboarding-totp.test.ts.
 */

import { createHmac } from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * Decode an RFC 4648 base32 secret (the "manual entry" key an authenticator app shows) to bytes.
 *
 * Spaces and lower case are tolerated because that is how the key is displayed — in groups, and
 * sometimes lower-cased by a copy. Padding `=` is ignored. A character outside the alphabet throws,
 * rather than silently decoding to the wrong bytes and producing codes that never match.
 */
export function decodeBase32(secret: string): Buffer {
  const clean = secret.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
  if (clean.length === 0) throw new Error("TOTP secret is empty after cleaning.");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) throw new Error(`TOTP secret has a non-base32 character: ${JSON.stringify(char)}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

export type TotpOptions = {
  /** Unix time in MILLISECONDS the code is generated for. Defaults to now. */
  atMs?: number;
  /** Seconds per code. RFC default 30; Yahoo/authenticator apps use 30. */
  stepSeconds?: number;
  /** Number of digits. RFC default and authenticator apps use 6. */
  digits?: number;
};

/**
 * The TOTP code for a base32 secret at a moment in time.
 *
 * `atMs` and `stepSeconds` are parameters so the RFC test vectors can pin the maths at fixed times;
 * production callers pass neither and get the current 30-second, 6-digit code.
 */
export function generateTotp(secretBase32: string, options: TotpOptions = {}): string {
  const { atMs = Date.now(), stepSeconds = 30, digits = 6 } = options;
  const key = decodeBase32(secretBase32);

  const counter = Math.floor(atMs / 1000 / stepSeconds);
  // 8-byte big-endian counter. `>>> 0` keeps the low word unsigned; the high word carries the rest,
  // which matters for the RFC vectors above 2^32 / 30 (e.g. time 20000000000).
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x1_0000_0000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);

  const hmac = createHmac("sha1", key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  const code = binary % 10 ** digits;
  return code.toString().padStart(digits, "0");
}

/**
 * The current Turbify second-factor code, read from the environment.
 *
 * Returns null when no seed is configured, so the caller can refuse with a clear message rather than
 * feed an empty code into the challenge. Never accepts the seed as an argument and never logs it.
 */
export function currentTurbifyTotp(
  secret: string | undefined = process.env.PHOENIX_TURBIFY_ADMIN_TOTP_SECRET,
): string | null {
  const seed = String(secret ?? "").trim();
  if (!seed) return null;
  return generateTotp(seed);
}
