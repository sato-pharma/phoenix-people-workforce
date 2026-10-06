import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { readUsdToEgpRate } from "@/lib/production-planning/fx-rate-reader.ts";
import { JOB_SCHEDULES } from "@/lib/observability/job-schedule.ts";

/**
 * The reorder email sends NOTHING until the owner arms it, and this is what says so.
 *
 * Standing rule: never fire a bulk email, a test send, or any real outbound email from a business
 * system. So the module ships with the sweep built, the recipients recorded and the sending OFF —
 * four independent switches, each fail-safe on its own, and none of them a default:
 *
 *   1. `prodplan_settings.alarm_enabled` must be explicitly `true`
 *   2. `prodplan_settings.alarm_dry_run` must be explicitly `false`
 *   3. the `production_planning_reorder` template's `is_active` — it ships `false`
 *   4. `EMAIL_NOTIFICATIONS_ENABLED`, which every send in this app passes through
 *
 * Read as SOURCE rather than by importing the sweep: `reorder-sweep.ts` pulls in the email service
 * and the Supabase admin client, neither of which belongs in a unit test (the same reason
 * tests/email-control-center.test.ts reads service.ts as text). The arming helpers' own behaviour
 * is pinned separately, in tests/production-planning-engine.test.ts.
 *
 * What would otherwise go wrong quietly: a gate removed here does not fail anything. The template
 * would simply become active, the dry run would stop returning early, and the first anyone would
 * know is four people receiving an email nobody authorised.
 */
export function runProductionPlanningSilentUntilArmedTests() {
  const emailService = readFileSync("src/lib/email-templates/service.ts", "utf8");
  const sweep = readFileSync("src/lib/production-planning/reorder-sweep.ts", "utf8");
  const fxSweep = readFileSync("src/lib/production-planning/fx-sweep.ts", "utf8");
  const reorderRoute = readFileSync("app/api/cron/production-planning-reorder/route.ts", "utf8");
  const fxRoute = readFileSync("app/api/cron/production-planning-fx/route.ts", "utf8");
  const migration = readFileSync("supabase/migrations/20261005214007_production_planning.sql", "utf8");

  // --- Switch 3: the template ships inactive -----------------------------------------
  const templateStart = emailService.indexOf("\n  production_planning_reorder: {\n    bodyHtml");
  assert.notEqual(templateStart, -1, "templateDefaults is missing the production_planning_reorder entry");
  const templateBlock = emailService.slice(templateStart, emailService.indexOf("\n  },\n", templateStart));
  assert.match(
    templateBlock,
    /isActive: false,/,
    "the production_planning_reorder template must ship INACTIVE — an active template is one of the four " +
      "switches, and arming it is the owner's click, not a deployment",
  );

  // --- The recipients are the four people he named, by address, not by role ----------
  // Roles cannot express this: Dr. Sahar's app role is `Manager`, which the QPPV also holds, so
  // routing by role would mail someone this is none of.
  const rulesStart = emailService.indexOf("\n  production_planning_reorder: {\n    bccRoles:");
  assert.notEqual(rulesStart, -1, "defaultRules is missing the production_planning_reorder entry");
  const rulesBlock = emailService.slice(rulesStart, emailService.indexOf("\n  },\n", rulesStart));
  for (const [field, address] of [
    ["toStaticEmails", "sahar.khalil@satopharma.com"],
    ["ccStaticEmails", "anwar.gaweesh@satopharma.com"],
    ["ccStaticEmails", "ahmed.elmaraghy@satopharma.com"],
    ["bccStaticEmails", "omar.anwar@satopharma.com"],
  ] as const) {
    assert.ok(
      rulesBlock.includes(address),
      `the reorder email's ${field} must still carry ${address} — the owner named each recipient on 2026-10-05`,
    );
  }
  for (const roleField of ["toRoles: []", "ccRoles: []", "bccRoles: []"]) {
    assert.ok(
      rulesBlock.includes(roleField),
      `the reorder email must route by address only (${roleField}) — a role would reach the whole of that role`,
    );
  }

  // --- Switch 1: a disabled sweep writes nothing and says which it was ---------------
  assert.match(
    sweep,
    /if \(!data\.settings\.alarmEnabled\) return \{ \.\.\.base, skipped: "disabled" \};/,
    "the sweep must return skipped: \"disabled\" when it is not armed — \"0 sent\" and \"switched off\" were " +
      "indistinguishable during a 13-day outbox freeze",
  );

  // --- Switch 2: the dry run returns BEFORE the send ---------------------------------
  const dryRunGate = sweep.indexOf("  if (dryRun) {");
  const sendCall = sweep.indexOf("await sendTemplatedEmail(");
  assert.notEqual(dryRunGate, -1, "the sweep must still have a dry-run gate");
  assert.notEqual(sendCall, -1, "the sweep must still be the thing that sends the email");
  assert.ok(
    dryRunGate < sendCall,
    "the dry-run gate must come BEFORE sendTemplatedEmail — a dry run that reaches the send is not a dry run",
  );
  assert.match(
    sweep,
    /dry_run: dryRun,/,
    "every alarm row must record which mode produced it, or a dry run cannot be told from a real one",
  );
  assert.match(
    sweep,
    /\.eq\("dry_run", false\)/,
    "only real rows may ever be marked as sent",
  );

  // --- The database refuses the combination the gates exist to prevent ---------------
  assert.match(
    migration,
    /check \(dry_run = false or email_sent = false\)/,
    "prodplan_alarm_events must keep its CHECK that a dry run cannot be marked as sent — it is the one gate " +
      "a code change cannot talk its way past",
  );

  // --- Both crons are authorised, watched, and declared --------------------------------
  for (const [name, source, slug, job] of [
    ["reorder", reorderRoute, "phoenix-production-planning-reorder", "cron/production-planning-reorder"],
    ["fx", fxRoute, "phoenix-production-planning-fx", "cron/production-planning-fx"],
  ] as const) {
    assert.ok(
      source.includes(`assertCronAuthorized(request, "${job}")`),
      `the ${name} cron route must call assertCronAuthorized with its own job name`,
    );
    assert.ok(
      source.includes(`withDeadMansSwitch("${slug}"`),
      `the ${name} cron route must report its heartbeat under ${slug}, or its silence is invisible`,
    );
    assert.ok(
      JOB_SCHEDULES.some((declaration) => declaration.slug === slug),
      `${slug} must be declared in JOB_SCHEDULES, or nothing watches it`,
    );
  }

  // --- The FX sweep cannot overwrite a good rate with nothing -------------------------
  assert.match(
    fxSweep,
    /fetch_ok: false/,
    "a failed rate read must record the failure rather than a rate",
  );
  // The KEY, with its colon, so the comment beside the branch recording this very rule cannot
  // satisfy the check it describes.
  const failureBranch = fxSweep.slice(
    fxSweep.indexOf("  if (rate === null) {"),
    fxSweep.indexOf("  const { error } = await db.from(PRODPLAN_TABLES.fx).upsert("),
  );
  assert.ok(failureBranch.length > 0, "the FX sweep must still have a separate failure path");
  assert.doesNotMatch(
    failureBranch,
    /fetched_usd_to_egp:/,
    "the failure path must NOT write fetched_usd_to_egp — overwriting a good rate with null is the one thing " +
      "a failed fetch must never do",
  );
  assert.match(
    failureBranch,
    /fetch_error: failure/,
    "the failure path must record WHY it failed, or a silent source reads as a quiet day",
  );

  // --- What counts as a rate, and what does not ---------------------------------------
  assert.equal(readUsdToEgpRate({ rates: { EGP: "48.5" } }), "48.5", "a published decimal string is read verbatim");
  assert.equal(readUsdToEgpRate({ rates: { EGP: 48.5 } }), "48.5", "a JSON number is read as its own text");
  assert.equal(readUsdToEgpRate({ rates: { EGP: 0 } }), null, "zero is not a rate");
  assert.equal(readUsdToEgpRate({ rates: { EGP: -3 } }), null, "a negative is not a rate");
  assert.equal(readUsdToEgpRate({ rates: { EGP: "abc" } }), null, "a word is not a rate");
  assert.equal(readUsdToEgpRate({ rates: { EGP: null } }), null, "a null is not a rate");
  assert.equal(readUsdToEgpRate({ rates: {} }), null, "a body with no EGP is not a rate");
  assert.equal(readUsdToEgpRate({}), null, "a body with no rates is not a rate");
  assert.equal(readUsdToEgpRate(null), null, "nothing is not a rate");
  assert.equal(readUsdToEgpRate("48.5"), null, "a bare string body is not a rate");
}
