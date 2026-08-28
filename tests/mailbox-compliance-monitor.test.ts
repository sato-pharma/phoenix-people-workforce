import assert from "node:assert/strict";

import {
  isRolePermissionWithinHardBoundary,
  permissionMatrix,
  permissionResources,
  phoenixRoles,
} from "../src/lib/auth/permissions.ts";
import { findAccessRegistryEntry } from "../src/lib/security/access-registry.ts";
import {
  SecretBoxError,
  isSealed,
  openSecret,
  sealSecret,
  sealedFingerprint,
  secretsEqual,
} from "../src/lib/security/secret-box.ts";

const TEST_SECRET = "mailbox-monitor-unit-test-secret-please-rotate-0123456789";

function withSecret<T>(secret: string | undefined, run: () => T): T {
  const previous = process.env.MAILBOX_MONITOR_SECRET;
  if (secret === undefined) delete process.env.MAILBOX_MONITOR_SECRET;
  else process.env.MAILBOX_MONITOR_SECRET = secret;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.MAILBOX_MONITOR_SECRET;
    else process.env.MAILBOX_MONITOR_SECRET = previous;
  }
}

export function runMailboxComplianceMonitorTests() {
  // ── secret-box: the at-rest seal for app passwords ─────────────────────────────
  withSecret(TEST_SECRET, () => {
    const plaintext = "an-employee-mailbox-app-password";

    // Round-trip recovers the exact plaintext.
    const sealed = sealSecret(plaintext);
    assert.equal(openSecret(sealed), plaintext, "seal→open must recover the original app password");
    assert.ok(isSealed(sealed), "a sealed value must be recognised as sealed");
    assert.equal(isSealed(plaintext), false, "raw plaintext must not read as sealed");
    assert.equal(sealed.startsWith("v1:"), true, "sealed blob must carry the v1 version tag");
    assert.equal(sealed.includes(plaintext), false, "the plaintext must never appear inside the blob");

    // Fresh salt + IV per call: two seals of the same plaintext differ, yet both open.
    const sealedAgain = sealSecret(plaintext);
    assert.notEqual(sealed, sealedAgain, "two seals of the same secret must differ (random salt/iv)");
    assert.equal(openSecret(sealedAgain), plaintext, "the second seal must also open to the original");

    // A stable, non-reversible fingerprint tells "did the credential change?" without opening two blobs.
    assert.equal(sealedFingerprint(sealed), sealedFingerprint(sealedAgain), "same plaintext → same fingerprint");
    assert.notEqual(
      sealedFingerprint(sealSecret("a-different-password")),
      sealedFingerprint(sealed),
      "different plaintext → different fingerprint",
    );
    assert.equal(sealedFingerprint(sealed).includes(plaintext), false, "the fingerprint must not reveal the plaintext");

    // Tampering is detected (authenticated encryption), not silently decrypted to garbage.
    const parts = sealed.split(":");
    parts[4] = parts[4].startsWith("A") ? `B${parts[4].slice(1)}` : `A${parts[4].slice(1)}`;
    assert.throws(() => openSecret(parts.join(":")), SecretBoxError, "a mutated ciphertext must fail the auth tag");

    // Malformed input is rejected, never coerced.
    assert.throws(() => sealSecret(""), SecretBoxError, "sealing empty plaintext must throw");
    assert.throws(() => openSecret("not-a-sealed-value"), SecretBoxError, "opening a non-blob must throw");
    assert.throws(() => openSecret("v1:only:three:parts"), SecretBoxError, "opening a short blob must throw");

    // Constant-time equality helper.
    assert.equal(secretsEqual(plaintext, plaintext), true, "identical secrets compare equal");
    assert.equal(secretsEqual(plaintext, "other"), false, "different secrets compare unequal");
  });

  // A blob sealed under one key cannot be opened under another.
  const sealedUnderA = withSecret(TEST_SECRET, () => sealSecret("cross-key-check"));
  withSecret(`${TEST_SECRET}-DIFFERENT`, () => {
    assert.throws(() => openSecret(sealedUnderA), SecretBoxError, "a different env secret must not open the blob");
  });

  // A missing/short env secret refuses to seal — a config error, never a weak-key fallback.
  withSecret(undefined, () => {
    assert.throws(() => sealSecret("x"), SecretBoxError, "no MAILBOX_MONITOR_SECRET → refuse to seal");
  });
  withSecret("too-short", () => {
    assert.throws(() => sealSecret("x"), SecretBoxError, "a short MAILBOX_MONITOR_SECRET → refuse to seal");
  });

  // ── permission gate: Super Admin only, forever ─────────────────────────────────
  assert.equal(permissionResources.includes("mailbox_monitor"), true, "mailbox_monitor must be a registered resource");
  assert.ok(permissionMatrix["Super Admin"].mailbox_monitor?.includes("read"), "Super Admin can read the mailbox monitor");
  assert.ok(permissionMatrix["Super Admin"].mailbox_monitor?.includes("update"), "Super Admin can manage the mailbox monitor");
  assert.ok(isRolePermissionWithinHardBoundary("Super Admin", "mailbox_monitor", "read"), "Super Admin read is within the hard boundary");
  assert.ok(isRolePermissionWithinHardBoundary("Super Admin", "mailbox_monitor", "update"), "Super Admin update is within the hard boundary");

  for (const role of phoenixRoles.filter((candidate) => candidate !== "Super Admin")) {
    assert.equal(
      permissionMatrix[role].mailbox_monitor?.includes("read") ?? false,
      false,
      `${role} must not read the mailbox monitor`,
    );
    assert.equal(
      permissionMatrix[role].mailbox_monitor?.includes("update") ?? false,
      false,
      `${role} must not manage the mailbox monitor`,
    );
    // Hard boundary caps every non-Super-Admin role to no actions — even a stray DB override cannot grant it.
    assert.equal(
      isRolePermissionWithinHardBoundary(role, "mailbox_monitor", "read"),
      false,
      `${role} read must be outside the mailbox_monitor hard boundary`,
    );
  }

  // ── access registry: every route has its own guarded, audited entry ────────────
  const readRoutes = [
    "/api/admin/mailbox-monitor",
    "/api/admin/mailbox-monitor/:id",
    "/api/admin/mailbox-monitor/:id/messages",
    "/api/admin/mailbox-monitor/:id/message",
  ];
  for (const route of readRoutes) {
    const entry = findAccessRegistryEntry(route, "GET");
    assert.equal(entry?.pattern, route, `${route} GET must resolve to its own entry, not a blanket`);
    assert.deepEqual(entry?.permission, { resource: "mailbox_monitor", action: "read" }, `${route} GET requires mailbox_monitor:read`);
    assert.equal(entry?.audit.classification, "access-read", `${route} GET must be classified as a read`);
  }

  for (const [route, method] of [
    ["/api/admin/mailbox-monitor", "POST"],
    ["/api/admin/mailbox-monitor/:id", "PATCH"],
    ["/api/admin/mailbox-monitor/:id", "DELETE"],
  ] as const) {
    const entry = findAccessRegistryEntry(route, method);
    assert.equal(entry?.pattern, route, `${method} ${route} must resolve to its own entry`);
    assert.deepEqual(entry?.permission, { resource: "mailbox_monitor", action: "update" }, `${method} ${route} requires mailbox_monitor:update`);
    assert.equal(entry?.audit.classification, "mutation", `${method} ${route} must be classified as a mutation`);
    assert.equal(entry?.csrf.required, true, `${method} ${route} must require CSRF`);
  }

  // The deeper message route must not be swallowed by the /:id entry (longest-match).
  assert.notEqual(
    findAccessRegistryEntry("/api/admin/mailbox-monitor/:id/message", "GET")?.pattern,
    "/api/admin/mailbox-monitor/:id",
    "the message route must not fall through to the /:id entry",
  );
}
