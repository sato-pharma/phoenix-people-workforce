import { strict as assert } from "node:assert";

// secret-box seals the only credentials Phoenix stores rather than reads from the environment —
// today the mailbox monitor's app passwords. This file exists because the module had NO test at
// all, which was found when Semgrep (restored 2026-09-08) flagged `gcm-no-tag-length` on its
// `createDecipheriv` call.
//
// WHAT THE FINDING ACTUALLY WAS, AND WHY IT WAS WORTH FIXING ANYWAY. GCM permits truncated
// authentication tags — 96, 64, even 32 bits — and a shorter tag is exponentially easier to forge.
// Without an explicit `authTagLength`, `setAuthTag` accepts whatever length it is handed, so the
// only thing rejecting a truncated tag was the `tag.length !== TAG_LENGTH` guard a few lines above
// the call. That guard was correct, so this was never exploitable; but it reads as ordinary input
// validation rather than as a load-bearing crypto guarantee, and it sits far enough from the call
// to be deleted by a tidy-up that has no idea what it is holding up. The option moves the
// guarantee to the point of use, where Node enforces it.
//
// THE RISK IN THAT CHANGE IS NOT THE CRYPTO, IT IS THE STORED DATA. Anything that alters what a
// sealed blob decodes to would strand every credential already in the database, with no migration
// path and no error until someone tries to use one. 16 bytes is GCM's default, so it changes
// nothing — but "should change nothing" is exactly the claim that deserves a fixture rather than a
// paragraph. OLD_BLOB below was produced by the code as it stood BEFORE the option was added, and
// is checked byte-for-byte here. If a future change to this module breaks it, the failure is a
// production data problem, not a test problem: do not regenerate the fixture to make it pass.

const TEST_SECRET = "phoenix-secret-box-test-key-do-not-use-in-production";

/** Sealed on 2026-09-08 by the PRE-authTagLength code, under TEST_SECRET. Never regenerate. */
const OLD_BLOB =
  "v1:u9yPu97lpzVjqDakDBO-Rw:yPrc6nNxue2Zi3Gb:L-lp145wdocl1BFTvPHOuA:8H8ciltVtGC8zWIy8_pb2mo2uaCD1d85HcyTBA";
const OLD_PLAINTEXT = "correct horse battery staple";
/** sealedFingerprint(OLD_BLOB) as it read before the change. */
const OLD_FINGERPRINT = "59dfa03a0a17dc11";

export async function runSecretBoxTests() {
  // The module reads MAILBOX_MONITOR_SECRET at call time, so the fixture needs its own key. Set it
  // for the duration and restore afterwards: the suite runs with real credentials loaded, and
  // leaving this set would change what any later test in the same process sees.
  const previous = process.env.MAILBOX_MONITOR_SECRET;
  process.env.MAILBOX_MONITOR_SECRET = TEST_SECRET;

  try {
    const { sealSecret, openSecret, sealedFingerprint, isSealed, secretsEqual, SecretBoxError } =
      await import("../src/lib/security/secret-box.ts");

    // 1. THE ONE THAT MATTERS. A blob sealed before the change must still open.
    assert.equal(
      openSecret(OLD_BLOB),
      OLD_PLAINTEXT,
      "a secret sealed by the pre-authTagLength code must still open — every stored credential " +
        "predates that change, and a failure here means production data is unreadable",
    );
    assert.equal(
      sealedFingerprint(OLD_BLOB),
      OLD_FINGERPRINT,
      "sealedFingerprint must be stable across the change — it is the 'did this credential " +
        "change?' signal, so a shift would report every unchanged secret as changed",
    );

    // 2. Round trip, and the tag really is 128 bits.
    const sealed = sealSecret(OLD_PLAINTEXT);
    assert.equal(openSecret(sealed), OLD_PLAINTEXT, "seal then open must return the plaintext");
    const tag = Buffer.from(sealed.split(":")[3], "base64url");
    assert.equal(tag.length, 16, "the authentication tag must be a full 128 bits, never truncated");

    // A fresh salt and IV per seal: two seals of one plaintext must not collide, or equal
    // credentials would be identifiable from the stored blobs alone.
    assert.notEqual(sealSecret(OLD_PLAINTEXT), sealSecret(OLD_PLAINTEXT), "each seal must be unique");

    // 3. A TRUNCATED TAG MUST BE REFUSED. This is the shape the finding was about: re-sealing the
    // same value with a shortened tag must not open, whichever guard catches it.
    const parts = sealed.split(":");
    const truncated = [parts[0], parts[1], parts[2], Buffer.from(tag.subarray(0, 8)).toString("base64url"), parts[4]].join(":");
    assert.throws(
      () => openSecret(truncated),
      SecretBoxError,
      "a blob carrying a 64-bit tag must be refused, not opened on a weaker guarantee",
    );

    // 4. Tampering is detected — the whole point of an authenticated mode.
    const flipped = Buffer.from(parts[4], "base64url");
    flipped[0] ^= 0xff;
    const tampered = [parts[0], parts[1], parts[2], parts[3], flipped.toString("base64url")].join(":");
    assert.throws(() => openSecret(tampered), SecretBoxError, "modified ciphertext must fail to open");

    // 5. Malformed input fails loudly rather than returning something.
    assert.throws(() => openSecret("not-a-blob"), SecretBoxError, "a non-v1 string must be refused");
    assert.throws(() => openSecret(""), SecretBoxError, "an empty string must be refused");
    assert.throws(() => sealSecret(""), SecretBoxError, "sealing nothing must be refused");

    // 6. The cheap helpers.
    assert.equal(isSealed(sealed), true, "a real blob must be recognised as sealed");
    assert.equal(isSealed("plain text"), false, "a plaintext must not be mistaken for a blob");
    assert.equal(secretsEqual("abc", "abc"), true);
    assert.equal(secretsEqual("abc", "abd"), false);
    assert.equal(secretsEqual("abc", "abcd"), false, "different lengths must compare false, not throw");
  } finally {
    if (previous === undefined) delete process.env.MAILBOX_MONITOR_SECRET;
    else process.env.MAILBOX_MONITOR_SECRET = previous;
  }
}
