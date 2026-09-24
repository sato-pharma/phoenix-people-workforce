/**
 * The Turbify second-factor code generator — pinned to the RFC 6238 published test vectors.
 *
 * The robot signs into a two-step-verified admin console by generating the authenticator code
 * itself from a stored seed. If that maths is wrong by one digit the sign-in fails every time and
 * the robot silently does nothing — indistinguishable, from the register's point of view, from a
 * console that had no leavers to act on. So the generator is not trusted from inspection: it is run
 * against the six SHA-1 vectors Appendix B of RFC 6238 publishes, at the exact times given.
 *
 * The vectors use the 20-byte ASCII secret "12345678901234567890", whose base32 form is
 * GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ. RFC 6238 prints 8-digit codes; a 6-digit authenticator code is
 * the low six digits of the same number, which the default-options cases check.
 */

import assert from "node:assert/strict";

import { decodeBase32, generateTotp, currentTurbifyTotp } from "../src/lib/mailbox-offboarding/robot/totp.ts";

const RFC_SECRET_B32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

// [unix seconds, published 8-digit code] — RFC 6238 Appendix B, SHA-1 rows.
const VECTORS_8: Array<[number, string]> = [
  [59, "94287082"],
  [1111111109, "07081804"],
  [1111111111, "14050471"],
  [1234567890, "89005924"],
  [2000000000, "69279037"],
  [20000000000, "65353130"],
];

export function runMailboxOffboardingTotpTests(): void {
  // The base32 the vectors are built on really decodes to the ASCII secret.
  assert.equal(decodeBase32(RFC_SECRET_B32).toString("ascii"), "12345678901234567890");

  // Every RFC vector, at 8 digits, at its exact time.
  for (const [seconds, expected] of VECTORS_8) {
    const code = generateTotp(RFC_SECRET_B32, { atMs: seconds * 1000, digits: 8 });
    assert.equal(code, expected, `RFC 6238 vector at t=${seconds}s expected ${expected}, got ${code}`);
  }

  // A 6-digit authenticator code is the low six digits of the same number.
  assert.equal(generateTotp(RFC_SECRET_B32, { atMs: 59 * 1000 }), "287082");
  assert.equal(generateTotp(RFC_SECRET_B32, { atMs: 1234567890 * 1000 }), "005924");

  // Default options give a 6-digit numeric code for "now".
  const now = generateTotp(RFC_SECRET_B32);
  assert.match(now, /^\d{6}$/);

  // The seed is tolerated as displayed: spaces, dashes and lower case decode identically.
  assert.equal(
    generateTotp("gezd gnbv gy3t qojq gezd gnbv gy3t qojq", { atMs: 59 * 1000, digits: 8 }),
    "94287082",
  );

  // A non-base32 character is refused rather than decoded to the wrong bytes.
  assert.throws(() => decodeBase32("NOTBASE32!!!1"), /non-base32/);
  assert.throws(() => decodeBase32("   "), /empty/);

  // currentTurbifyTotp reads the environment: null when unset, a 6-digit code when set.
  assert.equal(currentTurbifyTotp(""), null);
  assert.equal(currentTurbifyTotp(undefined), null);
  assert.match(currentTurbifyTotp(RFC_SECRET_B32) ?? "", /^\d{6}$/);
}
