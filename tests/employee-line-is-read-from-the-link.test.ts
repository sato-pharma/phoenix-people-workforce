import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  EMPLOYEE_AREA_SELECT,
  EMPLOYEE_LINE_SELECT,
  EMPLOYEE_ORG_SELECT,
  resolveEmployeeAreaName,
  resolveEmployeeDepartmentName,
  resolveEmployeeLineName,
} from "../src/lib/employees/employee-org-labels.ts";

/**
 * An employee's line comes from the LINK. `employees.line_name` is a dead label.
 *
 * MEASURED ON PRODUCTION 2026-09-29: 1 of 198 employees carries `line_name`, and 181 carry a real
 * `line_id`. A read that takes the label alone therefore reports almost the whole company as having
 * no line — and reports it as a BLANK, which reads as a fact about the person rather than as a
 * broken read. The organogram was already burned by the identical defect on the same table
 * (`employees.team_name`, 0 of 107 populated), which is why this one is pinned rather than trusted
 * to a comment.
 *
 * 🔴 AND THE SAME SELECT HID A WORSE ONE. `app/api/report-it/submit/route.ts` asked `employees` for
 * `name`, `area` and `department` — three columns that do not exist; the table has `full_name`,
 * `area_name` and `department_name`. PostgREST answers a missing column with an ERROR rather than a
 * null, so the whole lookup came back empty and every field resolved to null: an adverse-event
 * report would have been filed with no submitter name, no department, no line and no area on it,
 * with a 201 and nothing in the logs. Report It is patient data. No report had been submitted yet
 * (0 rows), so nothing needed repairing — this is the first one being fixed before it happens.
 *
 * What is asserted here is the resolver's ORDER, and that the reads which had this defect carry the
 * link in their select. A select is a string: nothing else in the system checks that one names a
 * column that exists, which is the whole reason the report-it defect survived.
 */

const REPORT_IT = "app/api/report-it/submit/route.ts";
const VACATION_OPTIONS = "src/lib/vacation/company-vacation-report-options.ts";
const VACATION_REPORT = "src/lib/vacation/company-vacation-report.ts";
const EMAIL = "src/lib/notifications/email.ts";
/**
 * The reads that show a person's AREA. `area_name` is the half-alive label — 145 of 198 rows carry
 * one, so a read that takes it looks like it works, which is what kept these three out of the first
 * pass. Against the link: 29 have a link and no label (a blank area on screen), 4 disagree with it
 * (a STALE area on screen), and 0 have a label without a link — so preferring the link loses
 * nothing. Two of the four still read "Fayoum-Beni Suef", the territory's name from before the
 * split.
 */
const AREA_READS = [
  "src/lib/recruitment/manager-cv-engagement.ts",
  "src/lib/marketing-requests/request-report-service.ts",
  "src/lib/direct-orders/rep-counters.ts",
];

function read(relative: string): string {
  return readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");
}

export function runEmployeeLineIsReadFromTheLinkTests() {
  // ── 1. THE LINE COMES FROM THE LINK, AND ONLY FROM THE LINK ───────────────────────────────
  assert.equal(
    resolveEmployeeLineName({ lines: { name: "Pedia" } }),
    "Pedia",
    "a linked row must resolve its line — this is the 181-of-198 case",
  );
  // PostgREST returns an embed as an object or a one-element array depending on the shape of the
  // query; both must resolve, or the fix works on one screen and not the next.
  assert.equal(resolveEmployeeLineName({ lines: [{ name: "Pedia" }] }), "Pedia");
  assert.equal(resolveEmployeeLineName({ lines: [] }), null, "no link is no line");
  assert.equal(resolveEmployeeLineName(null), null);

  // 🔴 THE LABEL IS NO LONGER A FALLBACK, AND THE SELECT MUST NOT NAME IT. `line_name` and
  // `department_name` are being DROPPED from the table, and while any read still ASKS for the
  // column the drop cannot happen: PostgREST answers a missing column with an error, so the DDL
  // would turn every employee read into a 42703 the moment it ran. This is what keeps the code
  // half of that sequence honest — the name must be gone from the fragment, not merely unused.
  assert.ok(
    !EMPLOYEE_LINE_SELECT.includes("line_name"),
    "EMPLOYEE_LINE_SELECT must not name line_name: the column is being dropped, and a select that " +
      "asks for it breaks every employee read the moment it goes",
  );
  assert.ok(
    !EMPLOYEE_ORG_SELECT.includes("line_name") && !EMPLOYEE_ORG_SELECT.includes("department_name"),
    "EMPLOYEE_ORG_SELECT must not name either dropped label",
  );
  // area_name is the exception and stays: 145 of 198 rows carry it, and that column is NOT going.
  assert.ok(
    EMPLOYEE_ORG_SELECT.includes("area_name") && EMPLOYEE_AREA_SELECT.includes("area_name"),
    "area_name must stay in the selects — that label is alive and its column is not being dropped",
  );

  // ── 2. THE READS THAT HAD THE DEFECT ASK FOR THE LINK ─────────────────────────────────────
  for (const path of [REPORT_IT, VACATION_OPTIONS, VACATION_REPORT]) {
    const source = read(path);
    assert.ok(
      /EMPLOYEE_(LINE|ORG)_SELECT/.test(source),
      `${path} must select through a shared fragment, not by naming line_name itself`,
    );
    assert.ok(
      source.includes("resolveEmployeeLineName"),
      `${path} must resolve the line through the shared helper`,
    );
  }
  assert.ok(
    EMPLOYEE_LINE_SELECT.includes("lines(name)"),
    "the shared select fragment must embed the linked line",
  );
  for (const embed of ["lines(name)", "departments(name)", "areas(name)"]) {
    assert.ok(
      EMPLOYEE_ORG_SELECT.includes(embed),
      `the placement fragment must embed ${embed}: department_name is 0 of 198 on production, so a ` +
        "read without the link files every person with no department at all",
    );
  }

  // The department resolves from its link alone, like the line — its label is going too.
  assert.equal(resolveEmployeeDepartmentName({ departments: { name: "Sales" } }), "Sales");
  assert.equal(resolveEmployeeDepartmentName({ departments: null }), null);
  // The AREA still has both, and the link still wins: that column stays, so the fallback stays.
  assert.equal(resolveEmployeeAreaName({ area_name: "STALE", areas: [{ name: "Cairo West" }] }), "Cairo West");
  assert.equal(
    resolveEmployeeAreaName({ area_name: "Down town", areas: null }),
    "Down town",
    "area_name is the one label with real content (145 of 198) and must still answer without a link",
  );

  // ── 3. THE REPORT-IT SELECT NAMES COLUMNS THAT EXIST ──────────────────────────────────────
  const reportIt = read(REPORT_IT);
  assert.ok(
    reportIt.includes("full_name") && reportIt.includes("EMPLOYEE_ORG_SELECT"),
    "the submitter lookup must ask for the real column names and the linked placement",
  );
  for (const dead of [`select("name,`, "emp?.name", "emp?.area ", "emp?.department "]) {
    assert.ok(
      !reportIt.includes(dead),
      `the submitter lookup must not read \`${dead.trim()}\` — that column does not exist on employees, ` +
        "and PostgREST answers a missing column with an error, so the whole lookup returns nothing",
    );
  }
  // And the failure must be visible. Swallowing it silently is what let a broken select live.
  assert.ok(
    /empError/.test(reportIt) && /console\.error/.test(reportIt),
    "a failed submitter lookup must be logged — the report is still filed, but the failure cannot " +
      "be silent again",
  );

  // ── 3b. THE AREA READS TAKE THE LINK TOO ──────────────────────────────────────────────────
  assert.ok(
    EMPLOYEE_AREA_SELECT.includes("areas(name)"),
    "the area fragment must embed the linked area",
  );
  for (const path of AREA_READS) {
    const source = read(path);
    assert.ok(
      source.includes("EMPLOYEE_AREA_SELECT"),
      `${path} must select the area through the shared fragment`,
    );
    assert.ok(
      source.includes("resolveEmployeeAreaName"),
      `${path} must resolve the area through the shared helper`,
    );
    // The tell that one was missed: reading the label straight off the row. `region_name` beside it
    // is a different column on `employees` and stays.
    assert.ok(
      !/\bdir\.area_name\b|employee\?\.area_name|text\(requester, "area_name"\)/.test(source),
      `${path} must not read employees.area_name directly — 29 people have no label and 4 have a ` +
        "stale one, and neither shows up as an error",
    );
  }

  // ── 4. ONE RESOLVER, NOT FOUR ─────────────────────────────────────────────────────────────
  const email = read(EMAIL);
  assert.ok(
    email.includes("resolveEmployeeLineName"),
    "the notifications reader must use the shared resolver too",
  );
  assert.ok(
    !/contact\?\.line_name \|\| relation\?\.name/.test(email),
    "the old label-first expression must be gone, not merely shadowed",
  );
}
