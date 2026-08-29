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
  failureReason,
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

  // Only a genuinely ABSENT reason is null — never the string "undefined", which would read like a
  // recorded reason while carrying none.
  assert.equal(failureDetail(undefined).reason, null, "an absent reason is null");
  assert.equal(failureDetail(null).reason, null, "a null reason is null");
  assert.equal(failureDetail("   ").reason, null, "a whitespace-only reason is null");

  // …and "absent" does NOT mean "not a string". `reason` is typed `unknown` precisely so that
  // failureDetail(error) works, because that is the call a maintainer writes from inside a catch
  // block. This assertion previously demanded the opposite — that an Error be discarded to null —
  // which rebuilt the exact `failed: true` and nothing else state the helper exists to prevent, at
  // the one call site most likely to be written, with a green test blessing it.
  assert.equal(failureDetail(new Error("boom")).reason, "boom", "an Error's message must reach the audit trail");
  assert.equal(
    failureDetail(Object.assign(new Error("Command failed"), { authenticationFailed: true })).reason,
    "the mailbox rejected the app password (generate a fresh app password and paste it with no spaces)",
    "an imapflow rejection handed over raw must still be described, not dropped",
  );
  assert.equal(failureDetail(504).reason, "504", "a primitive reason is recorded as text");
  // An object with nothing readable on it still beats null: a generic reason says the failure was
  // seen and could not be described, where null says nothing was ever captured.
  assert.equal(
    failureDetail(new Error("   ")).reason,
    "IMAP connection failed.",
    "an unreadable error still records a reason rather than null",
  );
  // The cap applies to a described reason too, not only to one handed in as a string.
  assert.equal(
    (failureDetail(new Error("y".repeat(MAX_FAILURE_REASON_LENGTH + 100))).reason as string).length,
    MAX_FAILURE_REASON_LENGTH,
    "a described reason is capped like any other",
  );

  // A chatty server response cannot bloat the jsonb column.
  const cappedReason = failureDetail("x".repeat(MAX_FAILURE_REASON_LENGTH + 250)).reason as string;
  assert.equal(cappedReason.length, MAX_FAILURE_REASON_LENGTH, "the reason is capped at MAX_FAILURE_REASON_LENGTH");

  // `extra` is spread first, so a caller can never blank the two fields the audit depends on.
  const hostile = failureDetail("the real reason", { failed: false, reason: "spoofed" });
  assert.equal(hostile.failed, true, "extra must not be able to unset failed");
  assert.equal(hostile.reason, "the real reason", "extra must not be able to overwrite the reason");

  // ── Source pins — by SHAPE, not by exact expression ───────────────────────────────
  // The helper passing on its own proves nothing if the service stops calling it. What stood here
  // was three exact expressions — `detail: failureDetail(test.error, { emailAddress: email })` and
  // friends — and each went red the moment that call moved into refuseAdd, a refactor that strictly
  // IMPROVED the thing being pinned (it made three more refusals audited, not fewer). A pin that
  // cannot survive its own subject being improved teaches the next session to delete it rather than
  // fix it. So: extract the calls and check their shape.
  const serviceSource = readFileSync(new URL("../src/lib/mailbox-monitor/service.ts", import.meta.url), "utf8");

  /**
   * Every `<callee>(...)` in `source`, as source text, matched by counting parentheses.
   * Naive about parentheses inside string literals — fine here, and a call it fails to close
   * would show up as an obviously wrong assertion message rather than a silent pass.
   */
  const callsTo = (source: string, callee: string): string[] => {
    const found: string[] = [];
    let from = 0;
    for (;;) {
      const at = source.indexOf(`${callee}(`, from);
      if (at === -1) break;
      let depth = 0;
      let end = source.length - 1;
      for (let i = at + callee.length; i < source.length; i += 1) {
        if (source[i] === "(") depth += 1;
        else if (source[i] === ")") {
          depth -= 1;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      found.push(source.slice(at, end + 1));
      from = end + 1;
    }
    return found;
  };

  /** A top-level function's body, from its declaration to the closing brace in column 0. */
  const topLevelBody = (source: string, declaration: string): string => {
    const start = source.indexOf(declaration);
    assert.notEqual(start, -1, `could not find ${declaration}`);
    const end = source.indexOf("\n}\n", start);
    assert.notEqual(end, -1, `could not find the end of ${declaration}`);
    return source.slice(start, end);
  };

  // Every audited failure carries a reason, and `failed` is owned by failureDetail alone. The old
  // anti-pin only rejected the one literal `detail: { failed: true }`; this rejects hand-writing the
  // flag in any shape, which is the actual rule.
  const auditCalls = callsTo(serviceSource, "await logAccess");
  assert.ok(auditCalls.length >= 6, `expected at least 6 logAccess calls in the service, found ${auditCalls.length}`);
  for (const call of auditCalls) {
    if (!call.includes("detail:")) continue; // a success row carries no detail, by design
    const detail = call.slice(call.indexOf("detail:"));
    assert.ok(
      detail.includes("failureDetail(") || detail.includes("{ ok: true }"),
      `every logAccess detail must be built by failureDetail — this one is not:\n${call}`,
    );
    assert.equal(
      /\bfailed:/.test(detail),
      false,
      `no access-log call may hand-write a failed flag; failureDetail owns it:\n${call}`,
    );
  }

  // ...and each of the three failure paths is still one of them. A loop over the calls that happen
  // to exist cannot notice that a path stopped writing one.
  for (const [label, declaration] of [
    ["a refused enrolment", "async function refuseAdd("],
    ["a failed connection test", "export async function recheckMonitor("],
    ["a failed mailbox read", "async function withMonitorRead<T>("],
  ] as const) {
    assert.ok(
      topLevelBody(serviceSource, declaration).includes("failureDetail("),
      `${label} must record WHY in the access log, not merely THAT it failed`,
    );
  }

  // The audit row is written before the throw, not after it. Reversed, a refusal throws its way out
  // of the function and the row is never written at all.
  const refuseAddBody = topLevelBody(serviceSource, "async function refuseAdd(");
  assert.ok(
    refuseAddBody.indexOf("await logAccess(") < refuseAddBody.indexOf("throw new MailboxMonitorError("),
    "refuseAdd must write the audit row BEFORE it throws",
  );

  // ── Every enrolment refusal is audited, not just the connection test ───────────────────
  // Only the connection-test refusal ever wrote a row. A typo'd address, a too-short password and a
  // mailbox already monitored each left NO record — strictly worse than the bare `failed: true` this
  // change set out to improve on, because nothing was written that could even be counted.
  const addMonitorBody = topLevelBody(serviceSource, "export async function addMonitor(");
  assert.ok(
    (addMonitorBody.match(/await refuseAdd\(/g) ?? []).length >= 4,
    "each of addMonitor's four refusals must go through refuseAdd, so each one leaves a row",
  );
  for (const thrown of callsTo(addMonitorBody, "new MailboxMonitorError")) {
    assert.ok(
      thrown.includes("diagnostic: true"),
      `addMonitor may throw MailboxMonitorError directly only for an internal fault; a refusal goes ` +
        `through refuseAdd so it is audited first:\n${thrown}`,
    );
  }

  // ── Every write in this module must READ the error PostgREST hands back ─────────────────
  // supabase-js RESOLVES a rejected insert/update with `{ error }` instead of throwing it, so a
  // bare `try { await insert(...) } catch {}` sees nothing at all when a row is refused. The
  // access-log insert was in exactly that state: an RLS denial, a constraint, or a `detail` payload
  // postgres will not accept as jsonb would drop the row — and with it the failure reason — leaving
  // no signal anywhere. That is the same "it failed and we cannot say why" hole the reason field
  // was added to close, one layer further down. Structural rather than a literal pin, so a write
  // added later is covered too.
  const supabaseStatements = (source: string): string[] => {
    const found: string[] = [];
    const marker = /await\s+db\(\)/g;
    let match: RegExpExecArray | null;
    while ((match = marker.exec(source)) !== null) {
      const lineStart = source.lastIndexOf("\n", match.index) + 1;
      const semicolon = source.indexOf(";", match.index);
      found.push(source.slice(lineStart, semicolon === -1 ? source.length : semicolon + 1));
    }
    return found;
  };
  const writes = supabaseStatements(serviceSource).filter((statement) =>
    /\.(insert|update|delete)\s*\(/.test(statement),
  );
  // A floor, not an equality — adding a write is fine, failing to check its error is not. Without
  // this the loop below would pass vacuously the day the extraction stops matching.
  assert.ok(writes.length >= 4, `expected at least 4 supabase writes in the service, found ${writes.length}`);
  for (const write of writes) {
    assert.ok(
      /^\s*const\s*\{[^}]*\berror\b[^}]*\}\s*=\s*await\s+db\(\)/.test(write),
      `every mailbox-monitor write must capture the error PostgREST returns — this one does not:\n${write}`,
    );
  }

  // ── The audit row is written BEFORE the health update, in both failure paths ────────────
  // markHealth can throw: the supabase client turns its own 15s abort into a thrown "Supabase
  // request timed out." (src/lib/supabase/server.ts). Awaited first, that throw skipped the
  // access-log row entirely AND replaced the 502 carrying the IMAP reason with an opaque timeout —
  // losing the reason in exactly the slow-database case the row exists for. Compared by index, so
  // reformatting the file cannot false-fail this the way an exact-expression pin would.
  const assertAuditBeforeHealth = (label: string, fromAnchor: string, toAnchor: string): void => {
    const start = serviceSource.indexOf(fromAnchor);
    const end = serviceSource.indexOf(toAnchor);
    assert.notEqual(start, -1, `${label}: could not anchor the start of the path`);
    assert.notEqual(end, -1, `${label}: could not anchor the end of the path`);
    assert.ok(start < end, `${label}: the path anchors were found in the wrong order`);
    const body = serviceSource.slice(start, end);
    const auditAt = body.indexOf("logAccess(");
    const healthAt = body.indexOf("markHealth(");
    assert.notEqual(auditAt, -1, `${label}: writes no access-log row at all`);
    assert.notEqual(healthAt, -1, `${label}: updates no health status at all`);
    assert.ok(auditAt < healthAt, `${label}: the access-log row must be written before the health update`);
  };
  assertAuditBeforeHealth(
    "recheckMonitor",
    "const test = await testMailboxConnection(connectionFromRow(row));",
    "const refreshed = await loadRow(id);",
  );
  assertAuditBeforeHealth("withMonitorRead's catch", '"Mailbox read failed."', "Could not read the mailbox");

  // ── markHealth must not be able to throw ────────────────────────────────────────────────
  // Ordering alone is not the whole defence. A health update is metadata ABOUT an operation, never
  // the operation the caller asked for, so its failure must never surface as the caller's error.
  const markHealthStart = serviceSource.indexOf("async function markHealth(");
  const markHealthEnd = serviceSource.indexOf("export async function listMonitors(");
  assert.notEqual(markHealthStart, -1, "could not find markHealth");
  assert.notEqual(markHealthEnd, -1, "could not find the end of markHealth");
  const markHealthBody = serviceSource.slice(markHealthStart, markHealthEnd);
  assert.ok(
    /\btry\s*\{/.test(markHealthBody) && /\bcatch\s*\(/.test(markHealthBody),
    "markHealth must guard its write — an unguarded throw pre-empts both the audit row and the caller's error",
  );

  // ── last_error goes through the SAME gate as the audit reason ────────────────────────
  // A reason has two sinks and only one of them was capped or sanitised. last_error is the copy a
  // human actually reads — the admin dashboard renders it on a single non-wrapping line — so the
  // protection was missing from exactly the place it was written for.
  const lastErrorAssignment = markHealthBody
    .split("\n")
    .find((line) => line.includes("update.last_error") && line.includes("patch.error"));
  assert.ok(lastErrorAssignment, "markHealth must set last_error from patch.error");
  assert.ok(
    (lastErrorAssignment ?? "").includes("failureReason("),
    `markHealth must send last_error through the same gate as the audit reason: ${lastErrorAssignment}`,
  );

  // ── failureReason: the one gate, and what it has to survive ──────────────────────
  // Control characters first, because this one is not cosmetic: postgres refuses a NUL byte in
  // text and in jsonb alike, so a server response carrying one made the audit INSERT fail outright.
  // An audit write that fails is the exact silence this whole change exists to end.
  assert.equal(failureReason("line one\nline two"), "line one line two", "a newline reaches neither sink");
  assert.equal(
    failureReason(`before${String.fromCharCode(0)}after`),
    "before after",
    "a NUL byte would be refused by postgres — it must never reach the insert",
  );
  assert.equal(failureReason("  spaced   out  "), "spaced out", "runs of whitespace collapse to one space");

  // Lone surrogates cannot be encoded as UTF-8 and postgres rejects them as jsonb outright. A
  // well-formed PAIR is one code point and must be left alone — dropping it would corrupt ordinary
  // text to defend against a case that only arises from already-broken input.
  assert.equal(failureReason(`bad${String.fromCharCode(0xd800)}half`), "badhalf", "a lone surrogate is dropped");
  assert.equal(failureReason("café ☕"), "café ☕", "well-formed non-ASCII text is untouched");
  assert.equal(failureReason("emoji \u{1f600}"), "emoji \u{1f600}", "a well-formed surrogate pair survives");

  // The cap counts CODE POINTS and marks the cut. Silently clipped, a reason reads as the server's
  // complete answer; and a naive slice() over a string of emoji would cut a pair in half, producing
  // exactly the lone surrogate the rule above exists to remove.
  const cappedLong = failureReason("z".repeat(MAX_FAILURE_REASON_LENGTH + 50)) as string;
  assert.equal([...cappedLong].length, MAX_FAILURE_REASON_LENGTH, "the cap counts code points");
  assert.ok(cappedLong.endsWith("…"), "a truncated reason must say that it was truncated");
  const cappedEmoji = failureReason("\u{1f600}".repeat(MAX_FAILURE_REASON_LENGTH + 10)) as string;
  // Ordered deliberately: a UTF-16 slice fails BOTH of these, and whichever runs first is the
  // message someone reads. "you cut an emoji in half" names the defect; "the count is 201" does not.
  assert.equal(
    [...cappedEmoji].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 0xd800 && code <= 0xdfff;
    }),
    false,
    "capping must never leave half a surrogate pair behind",
  );
  assert.equal([...cappedEmoji].length, MAX_FAILURE_REASON_LENGTH, "an emoji reason is capped by code point too");

  assert.equal(failureReason(undefined), null, "an absent reason is null");
  assert.equal(failureReason("\t\n  "), null, "a reason that sanitises away to nothing is null");

  // failureDetail must DELEGATE rather than keep its own copy of the cap — two copies is how the
  // two sinks drifted apart in the first place.
  const imapSource = readFileSync(new URL("../src/lib/mailbox-monitor/imap-error.ts", import.meta.url), "utf8");
  const failureDetailBody = topLevelBody(imapSource, "export function failureDetail(");
  assert.ok(
    failureDetailBody.includes("failureReason("),
    "failureDetail must go through the one gate, not re-implement the cap beside it",
  );

  // ── Every route funnels its catch through the one helper ───────────────────────
  // Each handler caught its own failure and returned a client-safe body, so the real cause went
  // nowhere: not to app_error_events, and not to instrumentation.ts's onRequestError either, which
  // only fires on errors a handler lets ESCAPE. A mailbox that stopped answering produced a 502 in
  // the browser and no trace at all on the server. Six identical catch blocks is how that happens.
  for (const relativePath of [
    "../app/api/admin/mailbox-monitor/route.ts",
    "../app/api/admin/mailbox-monitor/[id]/route.ts",
    "../app/api/admin/mailbox-monitor/[id]/messages/route.ts",
    "../app/api/admin/mailbox-monitor/[id]/message/route.ts",
  ]) {
    const routeSource = readFileSync(new URL(relativePath, import.meta.url), "utf8");
    const catchBlocks = (routeSource.match(/\}\s*catch\s*\(/g) ?? []).length;
    assert.ok(catchBlocks >= 1, `${relativePath}: expected at least one catch block, found ${catchBlocks}`);
    assert.equal(
      (routeSource.match(/mailboxMonitorErrorResponse\(\{/g) ?? []).length,
      catchBlocks,
      `${relativePath}: every catch must funnel through mailboxMonitorErrorResponse, or that route's `
        + `failures go unrecorded again`,
    );
    assert.equal(
      routeSource.includes("status: 500"),
      false,
      `${relativePath}: a hand-rolled 500 is a failure that leaves no trace — return the shared helper`,
    );
  }

  // The helper records the unclassified failures and stays silent about the expected ones. Routing
  // a typo'd address to the error monitor would bury the real faults among them.
  const routeErrorsSource = readFileSync(
    new URL("../src/lib/mailbox-monitor/route-errors.ts", import.meta.url),
    "utf8",
  );
  assert.ok(routeErrorsSource.includes("logAppError("), "the shared catch must record the failure somewhere durable");
  assert.ok(
    routeErrorsSource.includes("describeThrown(error)"),
    "a supabase throw is a plain object, so String(error) would record '[object Object]' and prove nothing",
  );
  const diagnosticCheckAt = routeErrorsSource.indexOf("error.diagnostic");
  const logAppErrorAt = routeErrorsSource.indexOf("await logAppError(");
  assert.notEqual(diagnosticCheckAt, -1, "the helper must consult MailboxMonitorError.diagnostic");
  assert.notEqual(logAppErrorAt, -1, "the helper must call logAppError");
  assert.ok(
    diagnosticCheckAt < logAppErrorAt,
    "an expected refusal must return BEFORE anything is recorded, or the real faults drown in them",
  );
}
