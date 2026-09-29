import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
/** The admin-bindable email tokens, three of which name a label that no longer exists. */
const CUSTOM_VARIABLES = "src/lib/email-templates/custom-variables.ts";
/** The DDL half of the third drop: it rebuilds the one view that named the label, then drops it. */
const AREA_DROP_MIGRATION = "supabase/migrations/20260929173000_drop_employee_area_name_label.sql";
const VACATION_OPTIONS = "src/lib/vacation/company-vacation-report-options.ts";
const VACATION_REPORT = "src/lib/vacation/company-vacation-report.ts";
const EMAIL = "src/lib/notifications/email.ts";
/**
 * The reads that show a person's AREA. `area_name` was the half-alive label — 145 of 198 rows
 * carried one, so a read that took it looked like it worked, which is what kept these three out of
 * the first pass. Against the link: 29 had a link and no label (a blank area on screen), 4
 * disagreed with it (a STALE area on screen), and 0 had a label without a link — so the label could
 * never answer where the link could not. Two of the four still read "Fayoum-Beni Suef", the
 * territory's name from before the split. The column was dropped on 2026-09-29, so these reads now
 * have nothing but the link.
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

  // 🔴 THE LABELS ARE GONE FROM THE TABLE, AND NO SELECT MAY NAME ONE. `line_name`,
  // `department_name` and now `area_name` have all been DROPPED from `employees`, and PostgREST
  // answers a missing column with an error rather than a null — so a select that still asks for one
  // is not a blank field, it is a 42703 that fails the WHOLE read. This is what keeps the code half
  // of that sequence honest: the name must be gone from the fragment, not merely unused.
  assert.ok(
    !EMPLOYEE_LINE_SELECT.includes("line_name"),
    "EMPLOYEE_LINE_SELECT must not name line_name: the column is gone, and a select that asks for " +
      "it breaks every employee read that uses this fragment",
  );
  for (const dropped of ["line_name", "department_name", "area_name"]) {
    assert.ok(
      !EMPLOYEE_ORG_SELECT.includes(dropped),
      `EMPLOYEE_ORG_SELECT must not name ${dropped} — that column no longer exists on employees`,
    );
  }
  assert.ok(
    !EMPLOYEE_AREA_SELECT.includes("area_name"),
    "EMPLOYEE_AREA_SELECT must not name area_name: it was the last of the three labels and it was " +
      "dropped on 2026-09-29, with 0 of 198 rows carrying one the link could not answer for",
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
  // The AREA resolves from its link alone now too. A row can no longer carry a label at all, so a
  // resolver that still preferred one would only ever be reading something a caller invented.
  assert.equal(resolveEmployeeAreaName({ areas: [{ name: "Cairo West" }] }), "Cairo West");
  assert.equal(resolveEmployeeAreaName({ areas: { name: "Cairo West" } }), "Cairo West");
  assert.equal(
    resolveEmployeeAreaName({ areas: null } as Parameters<typeof resolveEmployeeAreaName>[0]),
    null,
    "no link is no area: there is no label left to fall back to",
  );
  // And a stray label on the object must NOT resurrect the old behaviour. 4 of the 145 labels
  // disagreed with the link when the column went — two of them a territory name from before the
  // split — so a resolver that read one again would put a stale area back on screen.
  assert.equal(
    resolveEmployeeAreaName({ area_name: "Fayoum-Beni Suef" } as unknown as Parameters<
      typeof resolveEmployeeAreaName
    >[0]),
    null,
    "a label on the row must be ignored, not preferred — that is the stale value the drop removed",
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

  // ── 3c. NO SELECT ON `employees` ANYWHERE MAY NAME A DROPPED COLUMN ───────────────────────
  // 🔴 THIS IS THE ASSERTION THE DDL DEPENDS ON. `line_name`, `department_name` and `area_name` are
  // gone from the table; a select that still asks for one is a 42703, and PostgREST fails the WHOLE
  // read rather than returning a null for that field. The type system catches an object that READS
  // the field — it caught two while this was being written, including a Line dropdown built from the
  // dead label — but it cannot see a column name inside a select STRING, which is why this is a text
  // scan and not a type.
  //
  // 🔴 AND IT SCANS THE WHOLE TREE, NOT A LIST. The first version of this test carried a curated
  // list of files, and the list is exactly what failed: three more hand-written selects in
  // notifications/email.ts named `line_name` and went red in CI after the PR was green locally. A
  // new read added next month would not be on any list either.
  //
  // Other tables have their own real `line_name` and `area_name` — vacation requests, probation
  // rows, seats, `source_of_sales_areas`, `au_v_line_area_map`, the org-placement view — so the scan
  // is anchored to a `.from("employees")` within a few lines, never to the column name alone.
  // 🔴 NOT ONLY THE DROPPED LABELS. Probing all 99 distinct employees selects in the tree against
  // production on 2026-09-29 turned up a SECOND live 42703 that had nothing to do with this change:
  // `support-requests/service.ts` asked for `position_title`, which has never been a column on this
  // table. That read THROWS, so every support ticket's HR notification fell through to the
  // Super-Admin fallback — HR Advisory and HR Operations were never notified at all. Same defect as
  // the Report It submit route (`name`, `area`, `department`). These names are what the last three
  // of those defects were made of; a name here is one this table does not have.
  const DROPPED_LABELS = /\bline_name\b|\bdepartment_name\b|\barea_name\b|\bposition_title\b|\bteam_title\b/;
  const offenders: string[] = [];
  let scanned = 0;
  const roots = [new URL("../src/", import.meta.url), new URL("../app/", import.meta.url)];
  const stack = [...roots];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        stack.push(new URL(`${entry.name}/`, dir));
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      const fileUrl = new URL(entry.name, dir);
      const source = readFileSync(fileUrl, "utf8");
      scanned += 1;
      if (!source.includes('from("employees")')) continue;
      const pattern = /from\("employees"\)[\s\S]{0,400}?\.select\(([^)]*)\)/g;
      for (const match of source.matchAll(pattern)) {
        const argument = (match[1] ?? "").trim();
        // 🔴 A SELECT IS OFTEN A CONSTANT, NOT A LITERAL. `admin/test-accounts.ts` passed
        // `EMPLOYEE_COLUMNS`, and a scan that only read the argument saw an identifier with no
        // column names in it and called the file clean — while the constant it names held
        // `area_name`. Resolve one level: an identifier is looked up as a const in the same file.
        const resolved = /^[A-Za-z_$][\w$]*$/.test(argument)
          ? (new RegExp(`const\\s+${argument}\\s*(?::[^=]+)?=\\s*([\\s\\S]{0,600}?);`).exec(source)?.[1] ?? argument)
          : argument;
        if (DROPPED_LABELS.test(resolved)) {
          offenders.push(`${fileURLToPath(fileUrl).split(/[\\/]/).slice(-2).join("/")}: ${resolved.trim()}`);
        }
      }
    }
  }
  // A filter that silently matches nothing is how a sweep reports a clean tree it never looked at.
  assert.ok(
    scanned > 1500,
    `the scan must actually reach the source tree — it read ${scanned} files, which is too few to ` +
      "be src/ plus app/, so an empty result would prove nothing",
  );
  assert.deepEqual(
    offenders,
    [],
    "a select on employees still names a dropped column — that read is a 42703 in production: " +
      `${offenders.join(" | ")}`,
  );

  // ── 3d. A BINDABLE EMAIL TOKEN MUST NOT NAME A COLUMN THAT IS GONE ────────────────────────
  // An admin can bind a custom {{token}} to an employees column (owner request, 2026-07-22), and
  // the allowlist offers "Line", "Area" and "Department" — all three of which were dead labels and
  // are now dropped columns. The catalogue keys stay (they are what a stored row holds), so each
  // one must be mapped to its LINK in the resolver, or the whole read 42703s and every custom token
  // in that send renders empty. Nothing is bound on production today (0 rows) — this is the guard
  // that keeps the first binding from being the one that finds out.
  const customVariables = read(CUSTOM_VARIABLES);
  const catalogue = /EMPLOYEE_VARIABLE_SOURCES[\s\S]*?\n\];/.exec(customVariables)?.[0] ?? "";
  assert.ok(catalogue.includes("full_name"), "the variable catalogue must be found to be checked");
  const linkedBlock = /LINKED_SOURCES[\s\S]*?\n\};/.exec(customVariables)?.[0] ?? "";
  for (const dropped of ["line_name", "department_name", "area_name"]) {
    if (!catalogue.includes(`"${dropped}"`)) continue;
    assert.ok(
      new RegExp(`${dropped}:\\s*\\{`).test(linkedBlock),
      `${dropped} is offered as an email variable source but is not mapped to its link — that ` +
        "column no longer exists, so the resolve would fail the entire read",
    );
  }

  // ── 3e. THE MIGRATION REBUILDS THE SEAT-DRIFT VIEW BEFORE IT DROPS THE COLUMN ─────────────
  // `public.au_v_employee_seat_drift` selected `e.area_name`, so the column could not be dropped
  // while the view still named it — and a `drop column ... cascade` would have deleted the view
  // instead of saying so. The rebuild also drops `area_name_drifted`, which fired on 16 of the 94
  // seated actives while `area_id_drifted` fired on 0: every one of the 16 a missing or stale label
  // on a person whose seat and area link agree.
  // The checks run on the SQL with `--` comments stripped: the comments in this migration discuss
  // the column and the flag by name, and a scan that counted those would be asserting on prose.
  const migration = read(AREA_DROP_MIGRATION);
  const sql = migration
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
  assert.ok(
    sql.indexOf("drop view if exists public.au_v_employee_seat_drift") <
      sql.indexOf("drop column if exists area_name"),
    "the view must be rebuilt BEFORE the column is dropped, or the DDL fails on the dependency",
  );
  assert.ok(
    !/\be\.area_name\b/.test(sql),
    "the rebuilt view must not select employees.area_name — that is the dependency that blocks the drop",
  );
  assert.ok(
    !/as\s+area_name_drifted/.test(sql),
    "the label-derived flag must go with the label: it fired on 16 seated actives where the link " +
      "check fired on 0",
  );
  assert.ok(
    /as\s+area_id_drifted/.test(sql),
    "the LINK comparison must survive the rebuild — that is the real area check",
  );
  assert.ok(
    !/\bcascade\b/i.test(sql),
    "no CASCADE: it would drop whatever depends on the column silently instead of refusing",
  );
  assert.ok(
    /grant select on public\.au_v_employee_seat_drift to service_role/.test(sql) &&
      /revoke all on public\.au_v_employee_seat_drift from public, anon, authenticated/.test(sql),
    "a recreated view is born with default grants — the rebuild must restore the original ones, or " +
      "a service-role-only view becomes readable by anon",
  );

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
