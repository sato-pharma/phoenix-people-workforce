import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { isNonDeliverableEmail, pickDeliverableEmail } from "../src/lib/email/email-safety.ts";

/**
 * Password setup/reset links must be addressed from the EMPLOYEE's real mailbox, never from the
 * synthetic Supabase-auth login key.
 *
 * Production incident (2026-07-30): sendPasswordSetupLink gated the email send on
 * `app_auth_users.email` alone. That column is an optional override set for 2 of 112 active users;
 * the real address lives on `employees.work_email` (109 set). Result: 107 active users were refused
 * with "does not have an email address" while their @satopharma.com mailbox was on file the whole
 * time, and every bulk password reset had to fall back to copy-the-link-by-hand.
 *
 * The near-miss worth pinning: `app_auth_users.auth_email` IS populated for all of them, so an
 * obvious-looking "just fall back to auth_email" fix would have made every run report success while
 * mailing password links to phx-<hex>@auth.phoenix.local — a non-routable address that hard-bounces
 * and damages sending-domain reputation. Silent success is worse than the loud failure it replaced.
 */
export function runPasswordSetupEmailResolutionTests() {
  // ── The synthetic auth identity is never deliverable ──────────────────────────────────
  assert.equal(
    isNonDeliverableEmail("phx-41392d39@auth.phoenix.local"),
    true,
    "the Supabase-auth login key is a login identifier, not a mailbox — it must never be emailed",
  );
  assert.equal(
    pickDeliverableEmail(null, "phx-41392d39@auth.phoenix.local"),
    null,
    "a synthetic auth address must not be selected even when it is the only candidate present",
  );
  assert.equal(
    pickDeliverableEmail(null, "omar.gawish@satopharma.com"),
    "omar.gawish@satopharma.com",
    "a real work mailbox is selected when the override column is empty — the 107-user case",
  );
  assert.equal(
    pickDeliverableEmail("override@satopharma.com", "work@satopharma.com"),
    "override@satopharma.com",
    "the explicit app_auth_users.email override wins over the employee work email when both are real",
  );

  // ── The sender actually uses that resolution ──────────────────────────────────────────
  const source = readFileSync("src/lib/auth/password-setup.ts", "utf8");

  assert.match(
    source,
    /pickDeliverableEmail/,
    "password-setup must resolve recipients through pickDeliverableEmail, not a raw column read",
  );
  assert.match(
    source,
    /from\("employees"\)[\s\S]{0,160}work_email/,
    "password-setup must fall back to employees.work_email — app_auth_users.email is set for almost nobody",
  );
  assert.doesNotMatch(
    source,
    /pickDeliverableEmail\([^)]*auth_email/,
    "auth_email must never be offered as a delivery candidate: it is phx-<hex>@auth.phoenix.local and would hard-bounce",
  );

  // The send path must address the RESOLVED mailbox. Reverting any of these to `user.email` silently
  // reintroduces the bug — recipients would be empty, and the success message would interpolate
  // undefined into "link sent to ...".
  for (const field of ["candidateEmail", "recipients", "sent_to_email", "sentTo"]) {
    assert.doesNotMatch(
      source,
      new RegExp(`${field}:[^,\\n]*user\\.email`),
      `${field} must use the resolved deliverable address, not the raw app_auth_users.email column`,
    );
  }
  assert.match(
    source,
    /link sent to \$\{deliverableEmail\}/,
    "the success message must report the address actually used, otherwise it prints undefined",
  );
}
