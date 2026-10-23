import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  ASSURANCE_DIRECTORY_MAX_STALE_MS,
  RecipientAssuranceUnavailableError,
  createAssuranceDirectoryReader,
} from "../src/lib/email/recipient-assurance.ts";
import { RECIPIENT_ASSURANCE_UNAVAILABLE_REASON } from "../src/lib/email/send-phoenix-email.ts";
import { CREDENTIAL_EMAIL_KINDS, shouldMirrorEmailToAdminTelegram } from "../src/lib/email/transactional-types.ts";
import { classifyOutboxSkip } from "../src/lib/notifications/email.ts";

/**
 * TWO EMAIL SAFETY RULES (23 Oct 2026).
 *
 * 1. CREDENTIAL EMAILS ARE NOT MIRRORED TO THE ADMIN TELEGRAM (owner, by multiple choice: "Skip
 *    credential emails"). The reset code and the set-your-password link are stamped `credentialEmail`
 *    where they are built, and only that stamp withholds the Telegram twin. Every other email keeps it.
 * 2. THE RECIPIENT ASSURANCE GUARD FAILS CLOSED (audit, Pass 5). A directory read failure used to send
 *    the email unguarded. Now the last good copy (up to a day old) stands in, and with none the email is
 *    held back with a TRANSIENT reason, so a queued row is retried rather than lost.
 */
export async function runCredentialEmailMirrorTests() {
  // ── 1. the mirror decision ──────────────────────────────────────────────────────────────────────
  assert.deepEqual([...CREDENTIAL_EMAIL_KINDS], ["password_reset_code", "password_setup_link"], "exactly the two credential kinds he named");
  for (const kind of CREDENTIAL_EMAIL_KINDS) {
    assert.equal(shouldMirrorEmailToAdminTelegram({ credentialEmail: kind, testingRedirectActive: false }), false, `${kind} is not mirrored`);
  }
  assert.equal(shouldMirrorEmailToAdminTelegram({ credentialEmail: null, testingRedirectActive: false }), true, "every other email keeps its mirror");
  assert.equal(shouldMirrorEmailToAdminTelegram({ testingRedirectActive: false }), true);
  assert.equal(shouldMirrorEmailToAdminTelegram({ credentialEmail: "payslip", testingRedirectActive: false }), true, "an unknown stamp never withholds the mirror");
  assert.equal(shouldMirrorEmailToAdminTelegram({ credentialEmail: null, testingRedirectActive: true }), false, "testing redirect: no mirror, as before");

  const send = readFileSync("src/lib/email/send-phoenix-email.ts", "utf8");
  assert.match(
    send,
    /if \(shouldMirrorEmailToAdminTelegram\(\{ credentialEmail: input\.credentialEmail, testingRedirectActive: Boolean\(testingRecipients\) \}\)\) \{\s*void mirrorEmailToAdminTelegram\(/,
    "the Telegram twin is gated by the decision above",
  );
  // The stamp is set where the credential is built, and it survives the queue.
  const setup = readFileSync("src/lib/auth/password-setup.ts", "utf8");
  assert.match(setup, /credentialEmail: "password_setup_link"/, "the set-your-password link is stamped");
  assert.match(setup, /credentialEmail: "password_reset_code"/, "the reset code is stamped");
  const system = readFileSync("src/lib/notifications/system.ts", "utf8");
  assert.match(system, /credentialEmail: input\.email\?\.credentialEmail \?\? null,/, "the notification layer carries the stamp into the email input");
  const outbox = readFileSync("src/lib/notifications/email.ts", "utf8");
  assert.match(outbox, /payload: \{ \.\.\.input, originEnvironment: enqueueOriginEnvironment\(\) \}/, "the whole input — stamp included — is the outbox payload");
  assert.equal((outbox.match(/credentialEmail: input\.credentialEmail \?\? null,/g) ?? []).length, 2, "both send paths (templated and direct) pass it on");
  const templates = readFileSync("src/lib/email-templates/service.ts", "utf8");
  assert.match(templates, /credentialEmail: input\.credentialEmail \?\? null/, "and the templated path hands it to sendPhoenixEmail");

  // ── 2. the guard fails closed ───────────────────────────────────────────────────────────────────
  let clock = 1_000_000;
  let fail = false;
  const entries = [{ email: "a@satopharma.com", hrId: "B-1" }];
  const read = createAssuranceDirectoryReader(
    async () => {
      if (fail) throw new Error("directory read timed out");
      return entries;
    },
    () => clock,
  );
  await assert.rejects(
    () =>
      createAssuranceDirectoryReader(
        async () => {
          throw new Error("down");
        },
        () => clock,
      )(),
    RecipientAssuranceUnavailableError,
    "with no copy at all the guard cannot run — it throws, so the email is NOT sent",
  );
  assert.deepEqual(await read(), entries);
  fail = true;
  clock += 60 * 60 * 1000;
  assert.deepEqual(await read(), entries, "a short outage is covered by the last good copy");
  clock += ASSURANCE_DIRECTORY_MAX_STALE_MS;
  await assert.rejects(() => read(), RecipientAssuranceUnavailableError, "a copy older than a day is not trusted");

  const guardCatch = send.slice(send.indexOf("} catch (assuranceError) {"));
  assert.match(
    guardCatch.slice(0, 1_400),
    /return \{ reason: RECIPIENT_ASSURANCE_UNAVAILABLE_REASON, skipped: true \};/,
    "a guard that cannot run holds the email back — it never sends unguarded",
  );
  assert.doesNotMatch(guardCatch.slice(0, 1_400), /sending unguarded/);
  assert.equal(classifyOutboxSkip(RECIPIENT_ASSURANCE_UNAVAILABLE_REASON).terminal, false, "the reason is transient, so the queued email is retried, never closed");
}
