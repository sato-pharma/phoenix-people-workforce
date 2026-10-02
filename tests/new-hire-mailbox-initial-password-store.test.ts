/**
 * The initial mailbox password store — what this file protects.
 *
 * This is the one password in the system that is recoverable rather than hashed, because the System
 * Administrator has to read it to hand it to the new joiner. That makes the role gate the entire
 * security boundary: a company mailbox password opens that person's mail, so a leak here is not a
 * configuration embarrassment, it is reading an employee's correspondence.
 *
 * So the headline assertion is that NO role other than Super Admin ever receives a plaintext
 * password — not HR Advisory, not HR Operations, not the CEO, not an unauthenticated caller (which
 * in this app presents as `Employee`, never as null, so a falsy-role check would be dead code).
 *
 * The second thing pinned here: the role is checked BEFORE the seal is opened, so a forbidden
 * request never decrypts anything at all.
 */

import assert from "node:assert/strict";

import {
  InitialPasswordForbiddenError,
  InitialPasswordUnusableError,
  NEW_HIRE_INITIAL_PASSWORD_SECRET_CONTEXT,
  assertCanReadInitialPassword,
  canReadInitialPassword,
  initialPasswordRecord,
  revealInitialPassword,
  sealInitialPassword,
} from "../src/lib/new-hire-mailbox/initial-password-store.ts";
import { openSecret, sealSecret } from "../src/lib/security/secret-box.ts";

/** A pattern shaped like the owner's own, used only as test input. */
const PATTERN = "Testco@9931";
/** Secret-box reads its key from the environment at call time, so the fixture brings its own. */
const TEST_SECRET = "test-only-key-for-the-initial-password-store-0123456789";

export function runNewHireMailboxInitialPasswordStoreTests(): void {
  const previous = process.env.MAILBOX_MONITOR_SECRET;
  process.env.MAILBOX_MONITOR_SECRET = TEST_SECRET;
  try {
    runCases();
  } finally {
    if (previous === undefined) delete process.env.MAILBOX_MONITOR_SECRET;
    else process.env.MAILBOX_MONITOR_SECRET = previous;
  }
}

function runCases(): void {
  // Sealing produces something that is NOT the plaintext — the point of storing it sealed.
  const sealed = sealInitialPassword(PATTERN);
  assert.notEqual(sealed, PATTERN);
  assert.equal(sealed.includes(PATTERN), false, "the plaintext must not appear inside the sealed value");

  // The System Administrator gets it back, byte for byte.
  assert.equal(revealInitialPassword(sealed, "Super Admin"), PATTERN);
  assert.equal(canReadInitialPassword("Super Admin"), true);

  // 🔴 THE HEADLINE ASSERTION. Nobody else ever receives a password. These are the roles that look
  // plausible and must still be refused — HR owns the hiring flow but not the person's mailbox.
  const refused = [
    "HR Advisory", "HR Operations", "CEO", "Employee", "Medical Rep", "SFE Manager",
    "National Sales Manager", "District Manager", "Training Manager", "Marketing Manager",
    "", "super admin", "SUPER ADMIN", "Super  Admin", "Super Admin ",
  ];
  for (const role of refused) {
    assert.equal(canReadInitialPassword(role), false, `"${role}" must not be able to read a mailbox password`);
    assert.throws(
      () => revealInitialPassword(sealed, role),
      (error: unknown) => {
        assert.ok(error instanceof InitialPasswordForbiddenError, `"${role}" must be refused the password`);
        assert.match(error.message, /System Administrator only/);
        assert.match(error.message, /Nothing was read/);
        return true;
      },
      `"${role}" must never receive a mailbox password`,
    );
  }

  // An unauthenticated caller presents as `Employee` in this app, never as null — but null and
  // undefined are refused too, so no path can slip through on a missing value.
  for (const role of [null, undefined]) {
    assert.equal(canReadInitialPassword(role), false);
    assert.throws(() => revealInitialPassword(sealed, role), InitialPasswordForbiddenError);
  }

  // The gate throws rather than returning, so a caller cannot check and then read anyway.
  assert.throws(() => assertCanReadInitialPassword("HR Operations"), InitialPasswordForbiddenError);
  assert.doesNotThrow(() => assertCanReadInitialPassword("Super Admin"));

  // 🔴 The role is checked BEFORE the seal is opened: a forbidden request given a value that is not
  // even a valid seal still fails on the ROLE, never on decryption. If this ever reported a crypto
  // error instead, the gate would be running after the decrypt.
  assert.throws(
    () => revealInitialPassword("not-a-sealed-value-at-all", "HR Operations"),
    (error: unknown) => {
      assert.ok(error instanceof InitialPasswordForbiddenError, "the role must be checked before the seal is opened");
      return true;
    },
  );

  // A mailbox with nothing recorded says so, rather than returning an empty string a caller would
  // hand to somebody as their password.
  assert.throws(() => revealInitialPassword("", "Super Admin"), InitialPasswordUnusableError);
  assert.throws(() => revealInitialPassword("   ", "Super Admin"), InitialPasswordUnusableError);

  // A password Turbify would reject is refused at SEAL time — recording one would store a password
  // that never opened the mailbox, discovered only when a new hire said it did not work.
  assert.throws(() => sealInitialPassword("short1!"), InitialPasswordUnusableError);
  assert.throws(() => sealInitialPassword("alllower123!"), InitialPasswordUnusableError);
  assert.throws(() => sealInitialPassword("Has Space1!"), InitialPasswordUnusableError);

  // The record names exactly the three columns the migration added, and seals the value.
  const record = initialPasswordRecord({ actor: "system:turbify-joiner-robot", at: "2026-10-02T15:00:00Z", plaintext: PATTERN });
  assert.deepEqual(Object.keys(record).sort(), [
    "initial_password_set_at", "initial_password_set_by_hr_id", "sealed_initial_password",
  ]);
  assert.equal(record.initial_password_set_by_hr_id, "system:turbify-joiner-robot");
  assert.equal(record.initial_password_set_at, "2026-10-02T15:00:00Z");
  assert.notEqual(record.sealed_initial_password, PATTERN);
  assert.equal(revealInitialPassword(record.sealed_initial_password, "Super Admin"), PATTERN);

  // 🔴 CONTEXT SEPARATION. Three kinds of mailbox credential live in this database now. A blob
  // sealed for the initial password must be unreadable by the monitor's context-free openSecret,
  // and a monitor blob must be unreadable here — so a value copied between tables decrypts nowhere
  // rather than quietly opening under the wrong key.
  assert.equal(NEW_HIRE_INITIAL_PASSWORD_SECRET_CONTEXT, "new-hire-initial-password");
  assert.throws(
    () => openSecret(sealed),
    "a monitor-style read with no context must not open an initial-password blob",
  );
  const monitorBlob = sealSecret("monitor-password");
  assert.throws(
    () => revealInitialPassword(monitorBlob, "Super Admin"),
    "an initial-password read must not open a monitor blob",
  );
}
