import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  CRM_ACCOUNT_SETUP_AUDIENCE,
  CRM_ACCOUNT_SETUP_CHANNELS,
  CRM_ACCOUNT_SETUP_EVENT_TYPE,
  CRM_ACCOUNT_SETUP_MODULE,
  NOT_RECORDED,
  crmAccountSetupDetails,
  crmAccountSetupEmailSummary,
  crmAccountSetupHref,
  crmAccountSetupMessage,
  crmAccountSetupTitle,
  formatHireDate,
  type CrmAccountSetupSubject,
} from "../src/lib/crm/account-setup-messages.ts";
import { isCrmAccountSetupSchemaMissing } from "../src/lib/crm/account-setup.ts";
import {
  DEFAULT_NOTIFICATION_ROLE_POLICIES,
  notificationRoleKeys,
} from "../src/lib/notifications/role-recipients.ts";
import { resolveNotificationPolicy } from "../src/lib/notifications/policy.ts";

const ROOT = process.cwd();

function subject(overrides: Partial<CrmAccountSetupSubject> = {}): CrmAccountSetupSubject {
  return {
    areaName: "Cairo 1",
    displayName: "Test Rep",
    hireDate: "2026-09-01",
    hrId: "B-999",
    jobTitle: "Medical Representative",
    lineName: "CNS",
    managerName: "Test Manager",
    mobileNumber: "01000000000",
    regionName: "Cairo",
    workEmail: "test.rep@satopharma.com",
    ...overrides,
  };
}

/**
 * The notice the owner asked for on 2026-09-07, and the screen it lands on.
 *
 * The assertions that matter are about CONTENT and ROUTING, not about the database: what the
 * message carries, which channels it may use, that a blank field is stated rather than dropped,
 * and that only the CREATE path fires it. Every one of those is a thing that could regress in a
 * later edit and be completely invisible in production — a notice that reaches nobody, or reaches
 * everybody on every employee edit, looks identical to a working one from inside the code.
 */
export function runCrmAccountSetupTests() {
  // ── the seven facts he named, plus the two that make them addressable ──────────────────────
  const details = crmAccountSetupDetails(subject());
  const labels = details.map((detail) => detail.label);
  for (const required of ["Line", "Hiring date", "Region", "Area", "Manager", "Work email", "Mobile number"]) {
    assert.ok(labels.includes(required), `the CRM setup notice must carry "${required}" — the owner named it explicitly`);
  }
  assert.ok(labels.includes("Employee"), "the notice must name who it is about");
  assert.equal(
    details.find((detail) => detail.label === "Employee")?.value,
    "Test Rep (B-999)",
    "the employee is named by their display name AND the code they are filed under",
  );

  // ── a missing value is STATED, never silently dropped ──────────────────────────────────────
  // This is the failure mode that makes a queue useless: the notice exists to get a CRM account
  // created, and "no line recorded" is itself something the reader has to see. An empty cell reads
  // as a rendering fault and gets ignored; a stated blank gets fixed.
  const sparse = crmAccountSetupDetails(
    subject({ areaName: null, hireDate: null, lineName: null, managerName: null, mobileNumber: null, regionName: null, workEmail: null }),
  );
  assert.equal(sparse.length, details.length, "a sparse employee record must still produce every row");
  for (const label of ["Line", "Hiring date", "Region", "Area", "Manager", "Work email", "Mobile number"]) {
    assert.equal(
      sparse.find((detail) => detail.label === label)?.value,
      NOT_RECORDED,
      `"${label}" must print as "${NOT_RECORDED}" when the employee record has no value for it`,
    );
  }

  // ── nothing is ever truncated with an ellipsis (standing owner rule) ───────────────────────
  const everyString = [
    crmAccountSetupTitle(subject()),
    crmAccountSetupMessage(subject()),
    crmAccountSetupEmailSummary(subject()),
    ...details.map((detail) => `${detail.label}${detail.value}`),
    ...sparse.map((detail) => `${detail.label}${detail.value}`),
  ];
  for (const text of everyString) {
    assert.ok(!text.includes("…"), `the notice must never truncate with an ellipsis: ${text}`);
    assert.ok(!/\.\.\.$/.test(text.trim()), `the notice must never truncate with a trailing "...": ${text}`);
  }

  // ── the hiring date keeps its own calendar day ────────────────────────────────────────────
  // `employees.hire_date` is a DATE column. Rendered in Africa/Cairo it would be parsed as UTC
  // midnight and pushed forward, and on the inverse case a date renders on the wrong day
  // altogether — so the New Year's Day case below is the one that would catch a "fix" to Cairo.
  assert.equal(formatHireDate("2026-01-01"), "1 January 2026", "a date-only value must stay on its own calendar day");
  assert.equal(formatHireDate("2026-12-31"), "31 December 2026", "a date-only value must stay on its own calendar day");
  assert.equal(formatHireDate(null), NOT_RECORDED, "a missing hiring date is stated, not blank");
  assert.equal(formatHireDate("not a date"), NOT_RECORDED, "an unparseable hiring date is stated, not rendered as Invalid Date");

  // ── the deep link carries the person and lands on the tab that asks for the two values ─────
  assert.ok(
    crmAccountSetupHref("B-999").startsWith("/admin/crm?view=account_setup"),
    "the notice must link to the New Hire CRM Setup tab",
  );
  assert.ok(crmAccountSetupHref("B-999").includes("hrId=B-999"), "the link must carry the person it is about");
  assert.equal(crmAccountSetupHref(null), "/admin/crm?view=account_setup", "with no HR ID the link still opens the queue");
  assert.ok(
    crmAccountSetupHref("B/9").includes("hrId=B%2F9"),
    "an HR ID is URL-encoded, so a stray separator cannot break the link",
  );

  // ── email AND in-app, and NEITHER telegram NOR push ───────────────────────────────────────
  // The owner asked for both of the first two by name. The other two are excluded on purpose: this
  // notice carries a named new hire's mobile number and work email, and push is the channel that
  // puts those on a lock screen.
  assert.deepEqual(
    [...CRM_ACCOUNT_SETUP_CHANNELS].sort(),
    ["email", "in_app"],
    "the CRM setup notice is email + in-app only",
  );
  const policy = resolveNotificationPolicy({
    eventType: CRM_ACCOUNT_SETUP_EVENT_TYPE,
    module: CRM_ACCOUNT_SETUP_MODULE,
  });
  assert.deepEqual(
    [...policy.channels].sort(),
    ["email", "in_app"],
    "policy.ts must agree with the call site's channel list — two values that must agree are exactly what drifts",
  );
  assert.equal(policy.telegramAllowed, false, "the CRM setup notice must never be allowed on Telegram");
  assert.equal(policy.actionUrlRequired, true, "the whole point of the notice is the link it carries");

  // ── the audience is admin-editable, and defaults to the SFE Manager alone ─────────────────
  assert.ok(
    (notificationRoleKeys as readonly string[]).includes(CRM_ACCOUNT_SETUP_AUDIENCE),
    "the CRM setup audience must be a registered notification role key, or it cannot be retargeted without a deploy",
  );
  assert.deepEqual(
    DEFAULT_NOTIFICATION_ROLE_POLICIES[CRM_ACCOUNT_SETUP_AUDIENCE].roles,
    ["SFE Manager"],
    "the owner named the SFE Manager, and one recipient is the point",
  );
  assert.equal(
    DEFAULT_NOTIFICATION_ROLE_POLICIES[CRM_ACCOUNT_SETUP_AUDIENCE].enabled,
    true,
    "the notice ships switched on",
  );

  // ── a missing TABLE degrades; a missing COLUMN does not ───────────────────────────────────
  // A missing table answers PGRST205 through PostgREST and 42P01 through the driver, so a guard
  // written for one of them fires never. A missing COLUMN must stay a REAL error: reading it as
  // "not provisioned yet" would turn a projection bug into a silently empty queue.
  assert.equal(isCrmAccountSetupSchemaMissing(new Error("PGRST205: Could not find the table")), true);
  assert.equal(isCrmAccountSetupSchemaMissing(new Error('relation "crm_account_setup_tasks" does not exist (42P01)')), true);
  assert.equal(
    isCrmAccountSetupSchemaMissing(new Error("Could not find the 'resolved_by_hr_id' column of 'crm_account_setup_tasks' in the schema cache")),
    false,
    "a missing COLUMN is a code bug and must surface, never degrade to an empty queue",
  );
  assert.equal(isCrmAccountSetupSchemaMissing(null), false);

  // ── only the CREATE path fires it ─────────────────────────────────────────────────────────
  // An employee SAVE and an employee CREATE go through the same route and the same upsert. If the
  // notice ever moved outside the create branch, every phone-number edit would re-announce that
  // person as a new hire — and nothing about the code would look wrong.
  const employeesRoute = readFileSync(join(ROOT, "app/api/employees/route.ts"), "utf8");
  assert.match(
    employeesRoute,
    /const isNewEmployee = !payload\.employee\.originalHrId\?\.trim\(\);/,
    "the create signal must stay the same field upsertEmployee derives its own isUpdate from",
  );
  assert.match(
    employeesRoute,
    /if \(isNewEmployee\) \{[\s\S]*?openCrmAccountSetupTasks\([\s\S]*?notifyNewEmployeesNeedCrmAccount\(/,
    "both the task and the notice must sit inside the isNewEmployee branch",
  );

  const importRoute = readFileSync(join(ROOT, "app/api/imports/employees/confirm/route.ts"), "utf8");
  assert.match(
    importRoute,
    /dryRunResult\.rowsToInsert\.map\(\(record\) => record\.hrId\)[\s\S]*?openCrmAccountSetupTasks/,
    "the import must announce the rows it INSERTED, never the rows it updated",
  );
  assert.ok(
    !/rowsToUpdate[\s\S]{0,200}notifyNewEmployeesNeedCrmAccount/.test(importRoute),
    "an employee the import merely updated is not a new hire and must never be announced",
  );

  // ── the queue survives its own deploy window ─────────────────────────────────────────────
  const service = readFileSync(join(ROOT, "src/lib/crm/account-setup.ts"), "utf8");
  assert.match(
    service,
    /export async function openCrmAccountSetupTasks[\s\S]*?catch \(error\)/,
    "opening a task must swallow its own failure — the employee is already saved by then",
  );
  assert.match(
    service,
    /await setEmployeeCrmIdentity\(\{[\s\S]*?\}\);\s*\n\s*try \{\s*\n\s*await markTask/,
    "the employee row is written BEFORE the task is closed, so a refused CRM id leaves the person on the queue",
  );

  // ── the board obeys the fits-the-screen golden rule ──────────────────────────────────────
  const panel = readFileSync(join(ROOT, "src/components/crm/crm-account-setup-panel.tsx"), "utf8");
  assert.ok(
    !panel.includes("PortalDesktopTable"),
    "a board bound by the fits-the-screen rule must not use PortalDesktopTable — it scrolls over a min-width floor",
  );
  assert.ok(!/min-w-\[|minWidth=/.test(panel), "no min-width floor: the rule is fit, not scroll");
  assert.match(panel, /<table className="w-full table-fixed">/, "the resolved table is w-full table-fixed");
  assert.match(panel, /<colgroup>/, "a table-fixed table needs a colgroup to own its widths");
  // Matched inside className strings only. The word itself appears in the comments explaining WHY
  // it is absent, and a bare substring check would fail on the explanation rather than on the code.
  const classNames = [...panel.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)]
    .map((match) => match[1] ?? match[2] ?? "")
    .join(" ");
  assert.ok(!/\brounded(?:-[a-z0-9-]+)?\b/.test(classNames), "the square-edge golden rule: no rounded corners anywhere");
  assert.ok(!/\btruncate\b|\btext-ellipsis\b/.test(classNames), "the ellipsis ban is absolute — wrap instead");
  assert.ok(/\bbreak-words\b/.test(classNames), "long values must wrap, which is what makes the ellipsis ban survivable");
}
