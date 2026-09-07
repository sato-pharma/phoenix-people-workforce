import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  RETENTION_RISK_AUDIENCE,
  RETENTION_RISK_CHANNELS,
  RETENTION_RISK_EVENT_TYPE,
  RETENTION_RISK_MODULE,
  RETENTION_RISK_PRE_PAYROLL_EVENT_TYPE,
  formatRetentionRiskDate,
  prePayrollPeriodLabel,
  retentionRiskMessage,
  retentionRiskPrePayrollMessage,
  retentionRiskTitle,
  roleHrefsForSubject,
} from "../src/lib/retention-risk/messages.ts";
import {
  DEFAULT_NOTIFICATION_ROLE_POLICIES,
  notificationRoleKeys,
} from "../src/lib/notifications/role-recipients.ts";
import { isRetentionRiskSubjectTitle } from "../src/lib/retention-risk/eligibility.ts";
import { resolveNotificationPolicy } from "../src/lib/notifications/policy.ts";
import { JOB_SCHEDULES } from "../src/lib/observability/job-schedule.ts";
import type { RetentionRiskSignal } from "../src/lib/retention-risk/types.ts";

const ROOT = process.cwd();

function signal(overrides: Partial<RetentionRiskSignal> = {}): RetentionRiskSignal {
  return {
    areaName: "Cairo 1",
    bridgedDates: ["2026-09-04"],
    displayName: "Test Rep",
    endDate: "2026-09-07",
    hrId: "B-999",
    jobTitle: "Medical Representative",
    lastCrmActivityDate: "2026-08-31",
    lineName: "CNS",
    managerHrId: "B-100",
    managerName: "Test Manager",
    ongoing: true,
    startDate: "2026-09-01",
    trigger: "crm_silence",
    workingDays: 6,
    ...overrides,
  };
}

export function runRetentionRiskNotifyTests() {
  // ── In-app and Telegram, and nothing else ──────────────────────────────────────────────────
  //
  // He asked for email on 2026-09-06 and REMOVED IT IN REVIEW on 2026-09-07: "remove email keep
  // in-app and telegram". Both of the excluded channels leave a trace this alert must not leave —
  // email a durable copy of "possible resignation risk" against a named colleague sitting in four
  // inboxes, push that same sentence on a lock screen anyone holding the handset can read.
  assert.deepEqual(
    [...RETENTION_RISK_CHANNELS],
    ["in_app", "telegram"],
    "email was removed on the owner's instruction 2026-09-07; do not add it back without asking him",
  );
  assert.ok(
    !RETENTION_RISK_CHANNELS.includes("email"),
    "stated separately from the deepEqual so a reordering of the list can never quietly restore email",
  );
  assert.ok(
    !RETENTION_RISK_CHANNELS.includes("push"),
    "push would put a named employee on a lock screen, and it was never asked for",
  );

  // The policy table is the INDEPENDENT layer: the call site passes these same channels
  // explicitly and an explicit list wins, so these rows are what still holds if that argument is
  // ever dropped. With no row at all the bare default applies — and that default carries email
  // but omits Telegram, which would silently drop the channel that reaches an HR seat in the
  // field.
  for (const eventType of [RETENTION_RISK_EVENT_TYPE, RETENTION_RISK_PRE_PAYROLL_EVENT_TYPE]) {
    const channels = resolveNotificationPolicy({ eventType, module: RETENTION_RISK_MODULE }).channels;
    assert.ok(
      !channels.includes("email"),
      `${eventType} must not carry email in the policy table — the bare default DOES, so a row that kept it would restore email the moment the call site's explicit list was dropped`,
    );
    assert.ok(channels.includes("telegram"), `${eventType} must keep Telegram — the bare default omits it`);
    assert.ok(channels.includes("in_app"), `${eventType} must keep in-app`);
    assert.ok(
      !channels.includes("push"),
      `${eventType} must not gain push from the policy table — see the lock-screen note above`,
    );
  }

  // ── MEDICAL REPS ONLY, on BOTH rules ───────────────────────────────────────────────────────
  //
  // Owner, 2026-09-07, looking at the live board: "medical reps only i said". The silence rule was
  // always scoped this way; the LEAVE rule was not, because his first instruction said "every single
  // employee". Three of the board's seven rows were then the Finance & Admin Manager, the National
  // Sales Manager and the Marketing Manager, each on five days of ordinary approved leave — a
  // holiday, already on the vacation report, and not a retention signal.
  //
  // Behavioural, by the real titles that appeared on that board. An earlier version of this check
  // read the service SOURCE for the filter and was worthless: the regex matched the pre-fix shape
  // just as happily, so it passed while the bug was present. Proven by breaking it, which is the
  // only reason it is trusted now.
  assert.equal(isRetentionRiskSubjectTitle("Medical Representative"), true, "the board is about reps");
  assert.equal(isRetentionRiskSubjectTitle("Medical Rep"), true, "the short title is the same person");
  for (const title of [
    "Finance and Admin Manager",
    "National Sales Manager",
    "Marketing Manager",
    "District Sales Manager",
    "Regional Sales Manager",
    "Group Product Manager",
    "Product Manager",
    "Training Manager",
    "SFE Manager",
    "Admin Assistant",
  ]) {
    assert.equal(
      isRetentionRiskSubjectTitle(title),
      false,
      `${title} must never reach this board — on the silence rule their CRM row is written by somebody else, and on the leave rule five days off is a holiday`,
    );
  }
  assert.equal(isRetentionRiskSubjectTitle(null, null), false, "a blank title is not a rep");

  // ── The audience is registered and editable without a deploy ───────────────────────────────
  assert.ok(
    (notificationRoleKeys as readonly string[]).includes(RETENTION_RISK_AUDIENCE),
    "an unregistered key cannot be retargeted from /admin/notification-recipients",
  );
  const policy = DEFAULT_NOTIFICATION_ROLE_POLICIES[RETENTION_RISK_AUDIENCE];
  assert.ok(policy, "the key needs a default policy, which is also the fallback when the DB row is missing");
  assert.deepEqual(
    [...policy.roles].sort(),
    ["HR Advisory", "HR Operations", "SFE Manager", "Super Admin"],
    "the four the owner picked on 2026-09-06 when asked directly",
  );
  assert.equal(policy.enabled, true);

  // The seed migration must match that record byte for byte, or applying it changes behaviour on
  // deploy day rather than being the no-op it claims to be.
  const migration = readFileSync(
    join(ROOT, "supabase/migrations/20260907061500_notification_role_policies_retention_risk_key.sql"),
    "utf8",
  );
  assert.ok(
    migration.includes("'retention_risk_alert'"),
    "the CHECK constraint has to allow the key, or the first admin edit is rejected by the database",
  );
  assert.ok(
    migration.includes("array['HR Operations', 'HR Advisory', 'Super Admin', 'SFE Manager']"),
    "the seeded roles must equal DEFAULT_NOTIFICATION_ROLE_POLICIES, so the migration is a no-op against the fallback",
  );

  // ── A date-only value must render on its own calendar day ──────────────────────────────────
  //
  // These are DATES, not instants. Formatting one in Africa/Cairo is how a UI ends up printing
  // the wrong day: the value parses as UTC midnight, and a timezone that moves it backwards shows
  // the day before. UTC here is the absence of a timezone, not a choice of one.
  assert.equal(formatRetentionRiskDate("2026-09-01"), "1 September 2026");
  assert.equal(formatRetentionRiskDate("2026-01-01"), "1 January 2026", "a year boundary is where this breaks first");

  // ── The message reports, it never accuses ──────────────────────────────────────────────────
  //
  // The backtest puts the hit rate at roughly one in five, so four of every five people named
  // here are staying. This text reaches HR and the person's own line manager; an accusation would
  // do real harm to someone who was simply ill.
  const message = retentionRiskMessage(signal());
  for (const forbidden of ["resign", "quit", "escape", "flight risk", "suspect", "abscond", "steal"]) {
    assert.ok(
      !message.toLowerCase().includes(forbidden),
      `the message must not contain "${forbidden}" — it states a measurement, never a motive`,
    );
  }
  assert.ok(message.includes("Test Rep"), "human-readable name, never a bare HR code");
  assert.ok(message.includes("B-999"), "the code is there too, so the person is unambiguous");
  assert.ok(message.includes("6 consecutive working days"), "working days, never calendar days");
  assert.ok(message.includes("31 August 2026"), "the last CRM entry is the fact that makes the gap checkable");
  assert.ok(message.includes("Test Manager"), "the manager is named so somebody knows who to ask");
  assert.ok(
    message.includes("early warning, not a conclusion"),
    "the caveat is part of the message, not a nicety to be trimmed",
  );

  // A rep with no entry at all in the period must not print an empty date.
  const noHistory = retentionRiskMessage(signal({ lastCrmActivityDate: null }));
  assert.ok(
    noHistory.includes("No CRM entry was recorded at any point in the period reviewed."),
    "a null last-entry date must read as a sentence, never as a blank",
  );

  // ── Titles say what happened, in working days ──────────────────────────────────────────────
  assert.equal(retentionRiskTitle(signal()), "No CRM activity for 6 working days — Test Rep");
  assert.equal(
    retentionRiskTitle(signal({ trigger: "extended_leave", workingDays: 5 })),
    "5 consecutive leave working days — Test Rep",
  );
  assert.equal(
    retentionRiskTitle(signal({ workingDays: 1 })),
    "No CRM activity for 1 working day — Test Rep",
    "singular, because a title that reads '1 working days' looks like a broken template",
  );

  // ── Every recipient gets an address their own shell actually serves ────────────────────────
  //
  // Employee 360 exists at three addresses, one per shell, and the admin-group layout sends a
  // portal-mode viewer to the portal HOME before the page runs. portal-twins.ts carries no rule
  // for this route, so a District Manager handed the bare /employee-360/... link loses their place
  // entirely — and the District Manager is the whole reason the line manager is a recipient.
  const hrefs = roleHrefsForSubject("b-999");
  assert.equal(hrefs["District Manager"], "/employee-portals/employee-360/B-999");
  assert.equal(hrefs["Regional Manager"], "/employee-portals/employee-360/B-999");
  assert.equal(hrefs["National Sales Manager"], "/employee-portals/employee-360/B-999");
  assert.equal(hrefs["HR Operations"], "/hr/employee-360/B-999");
  assert.equal(hrefs["HR Advisory"], "/hr/employee-360/B-999");
  assert.ok(
    Object.values(hrefs).every((href) => !href.startsWith("/employee-360/")),
    "no role in this map may be sent to the admin-shell address — the map exists only for the roles that cannot use it",
  );
  assert.ok(
    hrefs["District Manager"].includes("B-999"),
    "the id is upper-cased for display: the mirror stores mixed case and a lower-cased path reads as a different person",
  );

  // ── The pre-payroll notice says something even when nobody is flagged ──────────────────────
  //
  // A notice that only ever appears when there is bad news cannot be told apart from one that has
  // silently stopped working — which is exactly how the outbox drain ran clean and delivered
  // nothing for thirteen days.
  const quiet = retentionRiskPrePayrollMessage([], "scheduled");
  assert.ok(quiet.includes("No employee is currently flagged"), "silence has to be stated, not implied");
  assert.ok(quiet.includes("Payroll for this month is close."));

  const afterPart1 = retentionRiskPrePayrollMessage([signal()], "part1_confirmed");
  assert.ok(afterPart1.includes("Payroll Part 1 has just been confirmed."));
  assert.ok(afterPart1.includes("1 with no CRM activity"), "the digest counts each trigger separately");
  assert.ok(afterPart1.includes("Test Rep (B-999)"));
  assert.ok(
    afterPart1.includes("a measurement, not a verdict"),
    "the same caveat rides the digest — this is the message that arrives while money is moving",
  );

  const both = retentionRiskPrePayrollMessage(
    [signal(), signal({ displayName: "On Leave", hrId: "B-998", trigger: "extended_leave", workingDays: 5 })],
    "scheduled",
  );
  assert.ok(both.includes("2 employees are currently flagged"));
  assert.ok(both.includes("1 on five or more consecutive leave days"));

  assert.equal(
    prePayrollPeriodLabel(new Date("2026-09-25T09:00:00Z")),
    "September 2026",
    "the 25th of September warns about September's payroll, which pays at the start of October",
  );

  // ── Both jobs are declared, or the dead-man's-switch cannot tell stranded from absent ───────
  const slugs = JOB_SCHEDULES.map((job) => job.slug);
  assert.ok(slugs.includes("phoenix-retention-risk-sweep"), "an undeclared job is never reported as stranded");
  assert.ok(slugs.includes("phoenix-retention-risk-pre-payroll"));
  const prePayroll = JOB_SCHEDULES.find((job) => job.slug === "phoenix-retention-risk-pre-payroll");
  assert.equal(
    prePayroll?.schedule,
    "45 7 25 * *",
    "the 25th, so there are working days left to check on somebody before Part 1 pays",
  );

  // ── Both routes are registered, or the access-registry CI gate fails ───────────────────────
  const registrySource = readFileSync(join(ROOT, "src/lib/security/access-registry.ts"), "utf8");
  for (const route of ["/api/cron/retention-risk-sweep", "/api/cron/retention-risk-pre-payroll"]) {
    assert.ok(
      registrySource.includes(`pattern: "${route}"`),
      `${route} must be registered — an unregistered route fails the access-registry CI gate`,
    );
  }
  assert.ok(
    registrySource.includes('pattern: "/api/cron/retention-risk-sweep", reason:')
      && /retention-risk-sweep[\s\S]{0,2000}?authMode: "cron-secret"|authMode: "cron-secret"[\s\S]{0,400}?retention-risk-sweep/.test(registrySource),
    "the sweep is guarded by CRON_SECRET, like every other cron route",
  );
}
