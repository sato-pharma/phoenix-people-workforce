import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  isRolePermissionWithinHardBoundary,
  permissionMatrix,
  permissionResources,
  phoenixRoles,
} from "../src/lib/auth/permissions.ts";
import { findAccessRegistryEntry } from "../src/lib/security/access-registry.ts";
import {
  MAX_FAILURE_REASON_LENGTH,
  describeImapError,
  failureDetail,
  normalizeAppPassword,
} from "../src/lib/mailbox-monitor/imap-error.ts";
import { parseRecruitmentEmailInboxesConfig } from "../src/lib/recruitment/inbound/email-mailboxes-config.ts";
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

  // ── connection step: app-password normalisation + human-readable failure reasons ────
  // Yahoo/Turbify shows an app password as four space-separated blocks; the IMAP LOGIN needs the
  // 16 characters with no spaces. Stripping the spaces is the actual fix for "Command failed".
  assert.equal(normalizeAppPassword("abcd efgh ijkl mnop"), "abcdefghijklmnop", "spaces inside an app password must be stripped");
  assert.equal(normalizeAppPassword("  padded  "), "padded", "leading/trailing whitespace must be stripped too");
  assert.equal(normalizeAppPassword("\tno\nline\r\n breaks "), "nolinebreaks", "tabs and newlines count as whitespace");
  assert.equal(normalizeAppPassword("nospaces"), "nospaces", "a clean password is unchanged");

  // A rejected LOGIN (imapflow's generic "Command failed") must surface as an auth problem, and
  // carry the server's own text when present — never the opaque "Command failed".
  const authErr = Object.assign(new Error("Command failed"), {
    authenticationFailed: true,
    responseStatus: "NO",
    responseText: "[AUTHENTICATIONFAILED] (#MBR1240) Incorrect username or password.",
    serverResponseCode: "AUTHENTICATIONFAILED",
  });
  const authMsg = describeImapError(authErr);
  assert.ok(/rejected the app password/i.test(authMsg), "an auth failure must say the app password was rejected");
  assert.ok(authMsg.includes("Incorrect username or password"), "the server's own reason must be carried through");
  assert.equal(authMsg.includes("Command failed"), false, "the opaque 'Command failed' must not be the surfaced reason");

  // A bare auth failure (no server text) still names the cause and tells the admin what to do.
  const authNoText = describeImapError(Object.assign(new Error("Command failed"), { authenticationFailed: true }));
  assert.ok(/no spaces/i.test(authNoText), "a bare auth failure must hint to paste the password with no spaces");

  // Network-level failures report the socket reason, not an auth problem.
  assert.ok(
    describeImapError(Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" })).includes("host was not found"),
    "ENOTFOUND must read as a host problem",
  );
  assert.ok(
    describeImapError(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })).includes("refused the connection"),
    "ECONNREFUSED must read as a refused connection",
  );

  // Fallbacks: a plain error keeps its message; a non-error is handled without throwing.
  assert.equal(describeImapError(new Error("boom")), "boom", "a plain error falls back to its message");
  assert.equal(describeImapError(null), "IMAP connection failed.", "a null error yields a safe default");

  // ── one-click import of the already-configured company mailboxes ───────────────────
  // The import reuses the recruitment intake config, so that parser is the contract it depends on.
  const configured = parseRecruitmentEmailInboxesConfig(
    JSON.stringify([
      { host: "imap.mail.yahoo.com", label: "Careers", password: "app-password-one", port: 993, secure: true, user: "Careers@satopharma.com" },
      { host: "imap.mail.yahoo.com", label: "HR", password: "app-password-two", port: 993, secure: true, user: "hr@satopharma.com" },
      { host: "imap.mail.yahoo.com", label: "Broken", port: 993, secure: true, user: "no-password@satopharma.com" },
    ]),
  );
  assert.equal(configured.length, 2, "an entry with no password must be dropped, not imported half-configured");
  assert.deepEqual(
    configured.map((box) => box.user),
    ["Careers@satopharma.com", "hr@satopharma.com"],
    "the configured mailboxes are the ones the import offers",
  );
  // The import lower-cases the address before de-duplicating against what is already monitored,
  // so a mixed-case configured address cannot be imported twice.
  const importAddresses = configured.map((box) => box.user.trim().toLowerCase());
  assert.deepEqual(importAddresses, ["careers@satopharma.com", "hr@satopharma.com"], "addresses normalise to lower case");
  assert.equal(new Set(importAddresses).size, importAddresses.length, "normalised addresses must be unique");

  // Malformed or absent config disables the import instead of throwing.
  assert.deepEqual(parseRecruitmentEmailInboxesConfig(undefined), [], "no config → nothing to import");
  assert.deepEqual(parseRecruitmentEmailInboxesConfig("{not json"), [], "invalid JSON → nothing to import");

  // ── failureDetail: the audit trail must record WHY, not only THAT ──────────────────
  // Two failed enrolments on 2026-08-28 left `{ emailAddress, failed: true }` and nothing else.
  // A refused mailbox creates no monitor row (so there is no last_error) and a MailboxMonitorError
  // is returned as a plain 4xx the error monitor never sees — so the reason existed only inside the
  // HTTP response, and once that browser tab was closed it was gone. This is the fix for that.
  const addFailure = failureDetail("the mailbox rejected the app password", { emailAddress: "someone@satopharma.com" });
  assert.equal(addFailure.failed, true, "a failure detail must still mark the row as failed");
  assert.equal(addFailure.reason, "the mailbox rejected the app password", "the reason must reach the audit trail");
  assert.equal(addFailure.emailAddress, "someone@satopharma.com", "caller context must survive alongside the reason");

  // The describeImapError output is what gets stored, so the common rejection must be readable
  // from the access log on its own, with no other source needed.
  assert.equal(
    failureDetail(describeImapError(Object.assign(new Error("Command failed"), { authenticationFailed: true }))).reason,
    "the mailbox rejected the app password (generate a fresh app password and paste it with no spaces)",
    "a rejected app password must be diagnosable from the access log alone",
  );

  // An absent or blank reason is stored as null — never the string "undefined", which would read
  // like a recorded reason while carrying none.
  assert.equal(failureDetail(undefined).reason, null, "an absent reason is null");
  assert.equal(failureDetail("   ").reason, null, "a whitespace-only reason is null");
  assert.equal(failureDetail(new Error("not a string")).reason, null, "a non-string reason is not coerced into text");

  // A chatty server response cannot bloat the jsonb column.
  const cappedReason = failureDetail("x".repeat(MAX_FAILURE_REASON_LENGTH + 250)).reason as string;
  assert.equal(cappedReason.length, MAX_FAILURE_REASON_LENGTH, "the reason is capped at MAX_FAILURE_REASON_LENGTH");

  // `extra` is spread first, so a caller can never blank the two fields the audit depends on.
  const hostile = failureDetail("the real reason", { failed: false, reason: "spoofed" });
  assert.equal(hostile.failed, true, "extra must not be able to unset failed");
  assert.equal(hostile.reason, "the real reason", "extra must not be able to overwrite the reason");

  // Source pin: the helper passing on its own proves nothing if the service stops calling it.
  // Containment checks, not a byte window — a fixed offset false-fails the moment the file shifts.
  const serviceSource = readFileSync(new URL("../src/lib/mailbox-monitor/service.ts", import.meta.url), "utf8");
  assert.ok(
    serviceSource.includes("detail: failureDetail(test.error, { emailAddress: email })"),
    "addMonitor's connection-failure log must carry the IMAP reason",
  );
  assert.ok(
    serviceSource.includes("detail: test.ok ? { ok: true } : failureDetail(test.error, { ok: false })"),
    "recheckMonitor must record why a connection test failed",
  );
  assert.ok(
    serviceSource.includes("detail: failureDetail(message)"),
    "a failed mailbox read must record why it failed",
  );
  assert.equal(
    /detail: { failed: true }/.test(serviceSource),
    false,
    "no access-log call may record a bare failed:true with no reason",
  );
}
