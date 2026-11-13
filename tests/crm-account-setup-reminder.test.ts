import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import { notificationRoleKeys } from "../src/lib/notifications/role-recipients.ts";
import { DAILY_JOBS } from "../src/lib/scheduled-jobs/daily-jobs.ts";

/**
 * 🔴 THE iREPORTS360 ACCOUNT-SETUP NOTICE AND ITS DAILY REMINDER ARE RETIRED (2026-11-07).
 *
 * From 2026-09-07 every new field hire opened a task and told the SFE Manager and HR Operations, by
 * email and in-app, to give that person an iReports360 account; from 2026-09-28 a daily reminder
 * (in-app and Telegram, 06:36 Cairo) chased every task older than two days. The vendor CRM was retired
 * on 6 Nov 2026 (crm_cutover.vendor_sync_retired_at) and Phoenix CRM is the only source of field work —
 * the owner: "ANY SINGLE SOURCE OF FIELD WORK IS NOW THE PHOENIX CRM WIRE IT EVERY WHERE". Nobody can be
 * given an iReports360 account any more, so the reminder was asking for something that cannot be done:
 * on 7 Nov 2026 it had 38 people "waiting", the newest opened the evening before.
 *
 * What this pins — that it can never fire again from any door:
 *   1. the sender and the reminder modules are gone;
 *   2. the daily job neither imports nor runs the reminder, and still counts its passes truthfully;
 *   3. none of the three employee-create doors announces a new hire for an iReports360 account;
 *   4. the `crm_account_setup_alert` audience and the `crm_account_setup.*` policy row are gone, so the
 *      recipients screen and the email control center no longer list it.
 *
 * The bell category "crm" deliberately stays (src/lib/notifications/recipients.ts): the reminders
 * already sent are history, and history is never hidden.
 */
export function runCrmAccountSetupReminderTests(): void {
  const source = (path: string) => stripComments(readFileSync(path, "utf8"));

  // ── 1. The sender and the reminder are gone ───────────────────────────────────────────────────
  {
    assert.equal(existsSync("src/lib/crm/account-setup-reminder.ts"), false, "the daily iReports360 reminder module must stay deleted");
    assert.equal(existsSync("src/lib/crm/account-setup-notify.ts"), false, "the new-hire iReports360 notice module must stay deleted");
    const words = source("src/lib/crm/account-setup-messages.ts");
    for (const gone of ["CRM_ACCOUNT_SETUP_AUDIENCE", "CRM_ACCOUNT_SETUP_CHANNELS", "crmAccountSetupTitle", "crmAccountSetupMessage", "crmAccountSetupEmailSummary", "CRM_ACCOUNT_SETUP_CTA_LABEL"]) {
      assert.ok(!words.includes(gone), `${gone} was only the retired notice's words — it must not come back`);
    }
    assert.ok(!/iReports360/i.test(words), "nothing the tab still shows may ask for an iReports360 account");
  }

  // ── 2. No morning job runs it ───────────────────────────────────────────────────────────────
  {
    // Since 13 Nov 2026 each morning job has its own schedule: the runners hold every call, the
    // registry every job. The hand-kept `totalJobs` this used to pin went with the old fan-out.
    const daily = source("app/api/cron/daily/_lib/daily-job-runners.ts");
    assert.ok(!/account-setup-reminder/.test(daily), "the morning jobs must not import the retired reminder");
    assert.ok(!/runCrmAccountSetupReminder|crmAccountSetupReminder|crm-account-setup-reminder/.test(daily), "the morning jobs must neither run nor name the retired reminder");
    assert.ok(
      !DAILY_JOBS.some((job) => /account-setup/.test(job.key)),
      "the retired reminder must not come back as a morning job of its own",
    );
  }

  // ── 3. No employee-create door announces a new hire for an iReports360 account ───────────────
  {
    for (const path of ["app/api/employees/route.ts", "app/api/imports/employees/confirm/route.ts", "src/lib/offers/joining-form-service.ts"]) {
      const code = source(path);
      assert.ok(!/openAndAnnounceCrmAccountSetup|account-setup-notify/.test(code), `${path} must not announce a new hire for an iReports360 account`);
      assert.ok(!/openCrmAccountSetupTasks\(/.test(code), `${path} must not open a CRM account task on its own either`);
      assert.ok(/openAndAnnounceNewHireMailboxes\(/.test(code), `${path} still runs the new-hire mailbox follow-up — only the iReports360 ask left`);
    }
  }

  // ── 4. The audience and the policy row are gone ─────────────────────────────────────────────────
  {
    assert.ok(
      !(notificationRoleKeys as readonly string[]).includes("crm_account_setup_alert"),
      "the crm_account_setup_alert audience must not be offered on the recipients screen any more",
    );
    assert.ok(!/crm_account_setup_alert/.test(source("src/lib/notifications/email-control-center.ts")), "the email control center must not list the retired audience");
    assert.ok(!/"crm_account_setup\.\*"/.test(source("src/lib/notifications/policy.ts")), "the crm_account_setup.* policy row must stay retired");
  }
}
