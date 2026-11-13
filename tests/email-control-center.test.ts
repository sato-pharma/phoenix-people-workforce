import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { notificationRoleKeys } from "../src/lib/notifications/role-recipients.ts";
import { emailNotificationTypes } from "../src/lib/notifications/email.ts";
import { emailTemplateKeys } from "../src/lib/email-templates/service.ts";

export function runEmailControlCenterTests() {
  const aggregatorSource = readFileSync("src/lib/notifications/email-control-center.ts", "utf8");
  const dailyRouteSource = readFileSync("app/api/cron/daily/_lib/daily-job-runners.ts", "utf8");
  const outstationServiceSource = readFileSync("src/lib/outstation/service.ts", "utf8");
  const marketingServiceSource = readFileSync("src/lib/marketing-requests/service.ts", "utf8");

  assert.equal(notificationRoleKeys.length, 23, "expected 23 role-recipients keys (approval_whatsapp_reminder + 11 of the 12 original — ireports360_sync_notify left with the retired vendor sync, 6 Nov 2026 — + marketing_sla_reminder + resignation_workflow_alert + employee_import_alert + payroll_workflow_alert + marketing_invoice_overdue_alert + distributor_upload_overdue_alert + retention_risk_alert + new_hire_mailbox_alert + service_milestone_notice + activity_inactivity_digest + accepted_offer_alert; crm_account_setup_alert left with the retired iReports360 account notice, 7 Nov 2026)");
  // The retired iReports360 account-setup audience must not come back to the control center's list.
  assert.doesNotMatch(aggregatorSource, /crm_account_setup_alert/, "the retired crm_account_setup_alert audience must not be mapped in the control center");
  assert.equal(emailNotificationTypes.length, 9, "expected 9 email-notification policy types (8 original + probation_milestone, added 2026-09-29 so the Day 30/60/75 emails have their own toggle)");
  assert.ok(emailTemplateKeys.length > 0, "expected at least one email template key");

  // The admin Email Notification Center is a CLIENT component and src/lib/notifications/email.ts is
  // server-side, so it hand-copies this union. Adding `probation_milestone` to the source and not to
  // the copy on 2026-09-29 turned the required `checks` job red on Typecheck — the only thing that
  // sees the drift, and only after a full CI cycle. Pin the two together so it fails here instead,
  // in seconds, with an instruction.
  const centerSource = readFileSync("src/components/admin/email-notification-center.tsx", "utf8");
  const centerUnion = (centerSource.match(/type EmailNotificationType =([\s\S]*?);/)?.[1] ?? "")
    .split("|")
    .map((part) => part.trim().replace(/^"|"$/g, ""))
    .filter(Boolean)
    .sort();
  assert.deepEqual(
    centerUnion,
    [...emailNotificationTypes].sort(),
    "src/components/admin/email-notification-center.tsx re-declares EmailNotificationType — add the new type to that copy too, or the admin page fails to typecheck",
  );

  // Every role-recipients key and email-notification type must have an explicit module-mapping
  // entry in the aggregator, so it lands in a real dashboard group instead of "undefined". Both
  // maps are typed as exhaustive Records (a missing key is a compile error), but this
  // test-runner type-strips rather than type-checks (see tests/alias-loader.mjs), so this loop
  // is the real enforcement for `pnpm run test` specifically.
  for (const key of notificationRoleKeys) {
    assert.match(
      aggregatorSource,
      new RegExp(`\\b${key}:\\s*(?:"[^"]+"|SYSTEM_HEALTH_MODULE)`),
      `email-control-center.ts is missing a module mapping for role-recipients key "${key}"`,
    );
  }
  for (const type of emailNotificationTypes) {
    assert.match(
      aggregatorSource,
      new RegExp(`\\b${type}:\\s*"[^"]+"`),
      `email-control-center.ts is missing a module mapping for email-notification type "${type}"`,
    );
  }

  // The digests disabled 2026-07-22 (335437cc) must be restored as real calls, not stubs. The
  // probation weekly digest was later RETIRED outright (2026-08-02, owner request) — a deliberate
  // removal, distinct from the 2026-07-22 stubbing this guard exists to prevent recurring.
  assert.doesNotMatch(dailyRouteSource, /Disabled 2026-07-22/, "the owner-disabled digests must be restored, not still stubbed");
  assert.match(dailyRouteSource, /runMarketingSlaDaily\(\)/, "daily route must call the real marketing SLA function");
  assert.doesNotMatch(dailyRouteSource, /processProbationWeeklyDigest\(/, "probation weekly digest was retired 2026-08-02 — it must not be re-wired");
  assert.match(dailyRouteSource, /runOutstationSlaDaily\(\)/, "daily route must call the real outstation SLA function");

  // Each restored digest's master "enabled" switch must be checked before any data is scanned —
  // for probation_weekly_dv_digest and marketing_sla_reminder this is the ONLY thing that
  // achieves a true off (see the hybrid-recipient / per-request-routing notes in role-recipients.ts
  // and email-control-center.ts); for outstation_sla_reminder it's a redundant-but-cheap
  // perf/consistency win since an empty roles array already no-ops it correctly.
  // The probation weekly digest's own enabled-flag check went with probation-emails.ts, deleted
  // 2026-08-02 after the digest was retired. marketing_sla_reminder below is the remaining
  // hybrid-recipient case this guard exists for.
  assert.match(
    marketingServiceSource,
    /resolveNotificationRoleEnabled\("marketing_sla_reminder"\)/,
    "marketing SLA reminder must check its own enabled flag before scanning any data (recipients are per-request, not role-configurable)",
  );
  assert.match(
    outstationServiceSource,
    /resolveNotificationRoleEnabled\("outstation_sla_reminder"\)/,
    "outstation SLA reminder should short-circuit on the enabled flag before scanning any data",
  );
}
