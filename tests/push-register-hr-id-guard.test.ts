import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { shouldReportPushSubscription } from "../src/lib/notifications/onesignal-client.ts";
import { pushSubscriptionSkipReason } from "../src/lib/notifications/settings.ts";

// Regression guard for the 2026-08-24 push-register 500, observed in production and root-caused
// against the live database, not theorised.
//
// Every page load mounts OneSignalProvider, which POSTs the browser's subscription state to
// /api/notifications/push/register. For a session with an employee behind it that is a quiet 200.
// For the `admin-HR` system-administrator console login it was a 500, every single time, because:
//
//   1. that identity carries hr_id = NULL by design and cannot be given one (creating a fake
//      employee row to satisfy the FK is explicitly forbidden);
//   2. the guard asked only for `loginId ?? hrId`, which that session satisfies on its login id;
//   3. so the upsert ran with hr_id: null against a NOT NULL column with no default.
//
// Proven with a non-committing DO-block probe on production:
//   ERROR: 23502: null value in column "hr_id" of relation "push_subscriptions"
//                 violates not-null constraint
//
// The row was never worth writing. Sends target include_aliases.external_id built from hr_id and
// hasActivePushSubscription queries by hr_id, so a null-hr_id row is unreachable even if it lands.
// Skipping is the correct outcome; the 500 was the schema refusing a write the code should not
// have attempted.
//
// This suite tests the decision as a pure function so it needs no database and can never touch
// one. The last section is what stops the fix being quietly undone: it pins that
// upsertPushSubscription still asks the question BEFORE it reaches for a Supabase client.
const employeeSession = { hrId: "B-13", loginId: "b-13" };
const systemAdminSession = { hrId: null, loginId: "admin-HR" };

function settingsFunctionSource(name: string) {
  const source = readFileSync(
    new URL("../src/lib/notifications/settings.ts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf(`export async function ${name}`);
  assert.notEqual(start, -1, `${name} must still be exported from the notification settings module`);
  const rest = source.slice(start + 1);
  const nextDeclaration = rest.search(/\n(?:export )?(?:async )?function /);
  return nextDeclaration === -1 ? rest : rest.slice(0, nextDeclaration);
}

export async function runPushRegisterHrIdGuardTests() {
  // 1. The ordinary case must still register, or this guard would have silenced push for everyone.
  assert.equal(
    pushSubscriptionSkipReason(employeeSession, "os-sub-1111"),
    null,
    "a signed-in employee with a real subscription id must still be recorded in push_subscriptions",
  );

  // 2. The headline. A session with no employee behind it is skipped, and skipped FOR THE HR ID —
  //    not incidentally because some other field happened to be missing.
  assert.equal(
    pushSubscriptionSkipReason(systemAdminSession, "os-sub-2222"),
    "no-hr-id",
    "the system-administrator console session (hr_id NULL by design) must be skipped, not written: push_subscriptions.hr_id is NOT NULL, so the write is a guaranteed 23502 and a 500 on every page load",
  );

  // 3. Whitespace is not an HR ID. The column would reject "" just as it rejects null, and an
  //    empty external_id matches no push audience either.
  assert.equal(
    pushSubscriptionSkipReason({ hrId: "   ", loginId: "admin-HR" }, "os-sub-3333"),
    "no-hr-id",
    "a blank hr_id must be treated as absent — trimming it leaves nothing the schema or a send could use",
  );

  // 4. The pre-existing guards must survive unchanged.
  assert.equal(
    pushSubscriptionSkipReason(employeeSession, "   "),
    "no-subscription-id",
    "a browser that reported no subscription id has nothing to key a row on",
  );
  assert.equal(
    pushSubscriptionSkipReason({ hrId: null, loginId: null }, "os-sub-4444"),
    "no-user",
    "an unidentified caller must be skipped before anything else is considered",
  );

  // 5. Casing must not change the verdict — hr_id is stored uppercased, so a lowercase session
  //    is a real employee, not a missing one.
  assert.equal(
    pushSubscriptionSkipReason({ hrId: "ai-0002", loginId: "ai-0002" }, "os-sub-5555"),
    null,
    "hr_id is normalised to upper case before storage, so a lowercase session id must still register",
  );

  // 6. Source lock. The guard only helps if upsertPushSubscription actually consults it, and
  //    consults it before it opens a database connection.
  const upsertSource = settingsFunctionSource("upsertPushSubscription");
  const guardAt = upsertSource.indexOf("pushSubscriptionSkipReason");
  const supabaseAt = upsertSource.indexOf("getSupabaseAdmin");
  assert.notEqual(
    guardAt,
    -1,
    "upsertPushSubscription must decide with pushSubscriptionSkipReason — an inline `!userId || !subscriptionId` check is the exact shape that let hr_id: null through and 500ed every page load",
  );
  assert.notEqual(supabaseAt, -1, "upsertPushSubscription must still be the function that writes push_subscriptions");
  assert.ok(
    guardAt < supabaseAt,
    "the skip check must run BEFORE getSupabaseAdmin — asking after the write has already been attempted is not a guard",
  );

  // 7. A session the server gave NO push identity never sends the register at all (27–28 Oct 2026:
  //    a test account's browser POSTed it on every page it opened and was refused 8 times, each
  //    refusal photographed). /api/notifications/push/context answers hrId null for a test account,
  //    View as Seat and the console login.
  assert.equal(
    shouldReportPushSubscription(true, { data: { appId: "app", hrId: null }, success: true }),
    false,
    "a test account (push context hrId null) must not POST /api/notifications/push/register — it is refused on every page",
  );
  assert.equal(
    shouldReportPushSubscription(true, { data: { appId: "app", hrId: "B-13" }, success: true }),
    true,
    "a real employee must still mirror the subscription, or push_subscriptions goes stale for everyone",
  );
  // Only a definite "no identity" stops it — a failed or unreadable context read keeps reporting.
  assert.equal(shouldReportPushSubscription(false, { error: "forbidden" }), true, "a failed context read keeps the old behaviour");
  assert.equal(shouldReportPushSubscription(true, null), true, "an unreadable context body keeps the old behaviour");
  assert.equal(shouldReportPushSubscription(true, { data: {} }), true, "a body without hrId is not a definite no-identity");

  // 8. And the provider consults it before it reports anything.
  const provider = readFileSync(new URL("../src/components/notifications/onesignal-provider.tsx", import.meta.url), "utf8");
  const decideAt = provider.indexOf("reportsSubscription = shouldReportPushSubscription(");
  const stopAt = provider.indexOf("if (!reportsSubscription) return;");
  const firstReportAt = provider.indexOf("reportSubscriptionState(OneSignal.User");
  assert.notEqual(decideAt, -1, "the OneSignal provider must decide with shouldReportPushSubscription from the push context answer");
  assert.ok(stopAt > decideAt && stopAt < firstReportAt, "the provider must stop BEFORE it reports the subscription state");

}
