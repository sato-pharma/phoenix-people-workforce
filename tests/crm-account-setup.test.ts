import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import * as accountSetupWords from "../src/lib/crm/account-setup-messages.ts";
import {
  NOT_RECORDED,
  crmAccountSetupDetails,
  formatHireDate,
  type CrmAccountSetupSubject,
} from "../src/lib/crm/account-setup-messages.ts";
import { isCrmAccountSetupSchemaMissing, needsCrmAccount } from "../src/lib/crm/account-setup.ts";
import {
  DEFAULT_NOTIFICATION_ROLE_POLICIES,
  notificationRoleKeys,
} from "../src/lib/notifications/role-recipients.ts";
import { stripComments } from "./support/comment-strip.ts";

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
 * The New Hire CRM Setup tab, and the retirement of the notice that used to fill it.
 *
 * The notice the owner asked for on 2026-09-07 — tell the SFE Manager to give each new field hire an
 * iReports360 account — was RETIRED on 2026-11-07 with the vendor CRM (6 Nov 2026), together with its
 * daily reminder and its audience; nobody can be given an iReports360 account any more. What stays is
 * the tab and its queue (history and the 38 tasks still open on 7 Nov 2026), so the assertions about
 * what a card SHOWS still hold: a blank field is stated rather than dropped, nothing is truncated,
 * the hiring date keeps its calendar day. The routing assertions now pin that NO create path opens a
 * task or announces anyone (tests/crm-account-setup-reminder.test.ts pins the rest of the retirement).
 */
export function runCrmAccountSetupTests() {
  // ── the seven facts he named, plus the two that make them addressable ──────────────────────
  const details = crmAccountSetupDetails(subject());
  const labels = details.map((detail) => detail.label);
  for (const required of ["Line", "Hiring date", "Region", "Area", "Manager", "Work email", "Mobile number"]) {
    assert.ok(labels.includes(required), `the CRM setup card must carry "${required}" — the owner named it explicitly`);
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

  // ── 🔴 the notice is RETIRED: no words, no channels, no audience (2026-11-07) ─────────────────
  // The vendor CRM was retired on 6 Nov 2026 and nobody can be given an iReports360 account any more,
  // so the notice's own words left with its sender. What the tab still needs stays.
  for (const gone of [
    "CRM_ACCOUNT_SETUP_AUDIENCE",
    "CRM_ACCOUNT_SETUP_CHANNELS",
    "CRM_ACCOUNT_SETUP_CTA_LABEL",
    "crmAccountSetupHref",
    "crmAccountSetupTitle",
    "crmAccountSetupMessage",
    "crmAccountSetupEmailSummary",
  ]) {
    assert.equal(gone in accountSetupWords, false, `${gone} belonged only to the retired iReports360 notice and must not come back`);
  }
  assert.ok(
    !(notificationRoleKeys as readonly string[]).includes("crm_account_setup_alert"),
    "the retired notice's audience must not be offered on the recipients screen",
  );
  assert.equal("crm_account_setup_alert" in DEFAULT_NOTIFICATION_ROLE_POLICIES, false, "and it has no default policy");

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

  // ── 🔴 NO create path opens a task or announces anyone any more (retired 2026-11-07) ──────────
  // Every door that creates an employee used to open a CRM account task and tell the SFE Manager.
  // With the vendor CRM retired there is no account to create, so a door that still opened a task
  // would put a new hire on a queue nobody can ever clear — read comment-stripped, so the retirement
  // note left in each file cannot satisfy or trip this.
  const employeesRoute = stripComments(readFileSync(join(ROOT, "app/api/employees/route.ts"), "utf8"));
  const importRoute = stripComments(readFileSync(join(ROOT, "app/api/imports/employees/confirm/route.ts"), "utf8"));
  const joiningForm = stripComments(readFileSync(join(ROOT, "src/lib/offers/joining-form-service.ts"), "utf8"));
  for (const [label, source] of [["employees", employeesRoute], ["employee import", importRoute], ["joining form", joiningForm]] as const) {
    assert.ok(!/openAndAnnounceCrmAccountSetup/.test(source), `the ${label} door must not announce a new hire for an iReports360 account`);
    assert.ok(!/openCrmAccountSetupTasks\(/.test(source), `the ${label} door must not open a CRM account task on its own either`);
  }
  // The create signal itself is unchanged — the new-hire mailbox follow-up still rides it.
  assert.match(
    employeesRoute,
    /const isNewEmployee = !payload\.employee\.originalHrId\?\.trim\(\);/,
    "the create signal must stay the same field upsertEmployee derives its own isUpdate from",
  );
  assert.match(
    importRoute,
    /openAndAnnounceNewHireMailboxes\(\{[\s\S]{0,300}?dryRunResult\.rowsToInsert\.map\(\(record\) => record\.hrId\)/,
    "the import still announces only the rows it INSERTED to the mailbox follow-up",
  );

  // ── FIELD ROLES ONLY (owner, 2026-09-08) ─────────────────────────────────────────────────
  // Every title below is a real one from the production roster on 2026-09-08, with the headcount
  // it carried. Inventing titles here would prove nothing: the whole risk in a title-based rule is
  // the titles people actually type, and "Regulatory Affairs Supervisior" is in this list spelled
  // exactly as production spells it.
  const liveRoster: Array<{ inScope: boolean; people: number; title: string }> = [
    { inScope: true, people: 77, title: "Medical Representative" },
    { inScope: true, people: 19, title: "District Sales Manager" },
    { inScope: true, people: 4, title: "National Sales Manager" },
    { inScope: true, people: 2, title: "Product Manager" },
    { inScope: true, people: 1, title: "Group Product Manager" },
    { inScope: true, people: 1, title: "Regional Sales Manager" },
    { inScope: true, people: 1, title: "Marketing Manager" },
    { inScope: true, people: 1, title: "Training Manager" },
    { inScope: true, people: 1, title: "SFE Manager" },
    { inScope: false, people: 2, title: "Admin Assistant" },
    { inScope: false, people: 1, title: "Admin Assist" },
    { inScope: false, people: 1, title: "Buffet" },
    { inScope: false, people: 1, title: "CEO" },
    { inScope: false, people: 1, title: "Finance and Admin Manager" },
    { inScope: false, people: 1, title: "Financial Advisor" },
    { inScope: false, people: 1, title: "HR Business Partner" },
    { inScope: false, people: 1, title: "HR Generalist" },
    { inScope: false, people: 1, title: "HR Section Head" },
    { inScope: false, people: 1, title: "QPPV" },
    { inScope: false, people: 1, title: "R&D Manager" },
    { inScope: false, people: 1, title: "Regulatory Affairs Supervisior" },
  ];

  let inScopeHeadcount = 0;
  let skippedHeadcount = 0;
  for (const row of liveRoster) {
    assert.equal(
      needsCrmAccount({ jobTitle: row.title, positionTitle: null }),
      row.inScope,
      `"${row.title}" (${row.people} on the live roster) is on the wrong side of the field-role rule`,
    );
    if (row.inScope) inScopeHeadcount += row.people;
    else skippedHeadcount += row.people;
  }
  assert.equal(inScopeHeadcount, 107, "the field half of the roster changed — re-measure before moving this number");
  assert.equal(skippedHeadcount, 13, "the head-office half of the roster changed — re-measure before moving this number");

  // A BLANK title is IN, not out: it means "nobody has said yet", and a missed rep is invisible
  // field work while a wrongly-included person is one click.
  assert.equal(needsCrmAccount({ jobTitle: null, positionTitle: null }), true, "an unknown title must not be silently skipped");
  assert.equal(needsCrmAccount({ jobTitle: "   ", positionTitle: null }), true, "a whitespace-only title is still unknown");
  // The POSITION title is a second chance at the same question — a blank job title with a real
  // position must be judged on the position rather than waved through as unknown.
  assert.equal(needsCrmAccount({ jobTitle: null, positionTitle: "Medical Representative" }), true);
  assert.equal(needsCrmAccount({ jobTitle: null, positionTitle: "HR Generalist" }), false);

  // It DELEGATES rather than restating the titles — a second copy of "who is field workforce"
  // drifts from the first within a year.
  const service = readFileSync(join(ROOT, "src/lib/crm/account-setup.ts"), "utf8");
  assert.match(
    service,
    /isFieldWorkforceComplianceEligibleTitle\(/,
    "needsCrmAccount must delegate to the existing field-workforce predicate, never hold its own title list",
  );
  // Comments are stripped first. The rule's own doc-comment explains at length WHY area is not the
  // test, and a bare substring check would fail on the explanation rather than on the code — the
  // same shape as pinning `truncate` in the panel below.
  const serviceCode = stripComments(service);
  assert.ok(
    !serviceCode.includes("areaId") && !serviceCode.includes("area_id"),
    "area must NOT gate this queue: every head-office employee carries an area_id, because Head office IS an area",
  );
  // POSITIVE CONTROL on the two lines above. Stripping comments is what makes that check mean
  // anything, and a strip that quietly removed too much would let it pass against any file at all —
  // an empty result and a clean result are indistinguishable without this.
  assert.ok(
    serviceCode.includes("isFieldWorkforceComplianceEligibleTitle"),
    "the comment strip removed real code, so the area check above proves nothing",
  );

  // ── the queue survives its own deploy window ─────────────────────────────────────────────
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
