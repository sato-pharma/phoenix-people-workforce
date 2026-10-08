import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// /admin/private-calendars must reach EVERY employee.
//
// Owner instruction, 2026-10-08: "make me able to filter on any emp here /admin/private-calendars".
//
// Before this, the page built its own shortlist before any filter ran: an employee was listed only
// if a job-function role resolved to National Sales Manager, Product Manager, Group Product Manager
// or Training Manager, OR the employee had no area and was not a Medical Rep / District Manager /
// Regional Manager. Every field rep and every district manager was therefore unreachable from this
// desk — not by a permission rule, but by a hard-coded list in the page.
//
// That shortlist was never the security boundary and removing it grants nothing. The boundary is
// two layers down and unchanged:
//   • canUsePrivateCalendarAdminSurface() gates the whole page on isPrivateCalendarGlobalViewer —
//     system scope, CEO, Super Admin, or an HR id in PHOENIX_PRIVATE_CALENDAR_GLOBAL_HR_IDS.
//   • getPrivateCalendarWorkspace() calls assertPermission for employee_profile:read and
//     attendance:read, then filters the directory through canReadPrivateCalendarEmployee, which
//     returns true for ANY employee when the viewer is a global viewer.
// So a viewer who can open this page could already read any employee's calendar by URL. The
// shortlist only hid them from the picker.
//
// What this test pins, because each one wrong is a specific regression:
//   1. NO ROLE SHORTLIST comes back. The named roles and the head-office-by-absent-area heuristic
//      are the exact construct that hid the field, and the obvious-looking "tidy the picker" change
//      is to reintroduce one.
//   2. EVERY FILTER DIMENSION the page offers is read from searchParams AND applied, so adding a
//      control without wiring it (or wiring one without a control) is caught.
//   3. THE SELECTED EMPLOYEE RESOLVES AGAINST THE WHOLE DIRECTORY, not the filtered list — or
//      changing a filter would invalidate an open calendar link and a leaver could never be opened.
//   4. THE LIST FITS THE SCREEN. The whole company lands in this table now, so it is table-fixed
//      with a colgroup and grants no sideways scroll (the fits-the-screen golden rule, AGENTS.md §4).
// ─────────────────────────────────────────────────────────────────────────────

const PAGE_PATH = "app/(admin)/admin/private-calendars/page.tsx";

export function runPrivateCalendarsAdminAnyEmployeeTests() {
  const raw = readFileSync(PAGE_PATH, "utf8");
  const source = stripComments(raw);

  // 1. No role shortlist, in any of its spellings.
  assert.ok(
    !/ELIGIBLE_ROLES/.test(source),
    "the ELIGIBLE_ROLES shortlist is back — every employee must be reachable from this desk",
  );
  assert.ok(
    !/resolveJobFunctionRole/.test(source),
    "the page resolves a job-function role again, which is how the field was hidden from the picker",
  );
  for (const role of [
    "National Sales Manager",
    "Product Manager",
    "Group Product Manager",
    "Training Manager",
  ]) {
    assert.ok(
      !source.includes(role),
      `the page names the role "${role}" again — a role allow-list here hides every other employee`,
    );
  }
  assert.ok(
    !/isHeadOffice/.test(source),
    "the head-office-by-absent-area heuristic is back; areaName === null must not decide who is listed",
  );

  // The pool is the directory itself.
  assert.ok(
    /const pool = statusFilter === "all" \? allEmployees : allEmployees\.filter\(isWorking\)/.test(source),
    "the candidate pool must be the whole directory, narrowed only by the employment-status choice",
  );

  // 2. Every filter is both offered and applied.
  const filters: Array<{ key: string; applied: RegExp }> = [
    { key: "name", applied: /if \(nameFilter && !matchesName\(emp\)\) return false;/ },
    { key: "line", applied: /if \(lineFilter && emp\.lineName !== lineFilter\) return false;/ },
    { key: "region", applied: /if \(regionFilter && emp\.areaName !== regionFilter\) return false;/ },
    {
      key: "department",
      applied: /if \(departmentFilter && emp\.departmentName !== departmentFilter\) return false;/,
    },
    { key: "title", applied: /if \(titleFilter && !\(emp\.jobTitle \?\? ""\)\.toLowerCase\(\)\.includes\(titleFilter\)\) return false;/ },
    { key: "status", applied: /statusFilter === "all"/ },
  ];

  for (const filter of filters) {
    assert.ok(
      source.includes(`getString("${filter.key}")`),
      `the "${filter.key}" filter is not read from searchParams`,
    );
    assert.ok(
      source.includes(`name="${filter.key}"`),
      `the "${filter.key}" filter has no control in the form, so it can only be set by hand-editing the URL`,
    );
    assert.ok(
      filter.applied.test(source),
      `the "${filter.key}" filter is read and rendered but never applied to the list`,
    );
    assert.ok(
      source.includes(`${filter.key}:`),
      `the "${filter.key}" filter is not carried on the row links, so it is lost when a calendar opens`,
    );
  }

  // The name search must reach the nickname and the HR id, not the legal name alone.
  for (const field of ["emp.displayName", "emp.fullName", "emp.nickname", "emp.hrId"]) {
    assert.ok(
      new RegExp(field.replace(".", "\\.")).test(source),
      `the name search must also match ${field}`,
    );
  }

  // 3. The selected employee resolves against the whole directory.
  assert.ok(
    /const selectedEmployee = selectedHrId \? allEmployees\.find/.test(source),
    "the selected employee must resolve against the whole directory, never the filtered list",
  );
  assert.ok(
    !/const selectedEmployee = selectedHrId \? (?:eligible|filtered|pool)\.find/.test(source),
    "resolving the selected employee from a narrowed list breaks an open calendar link when a filter changes",
  );

  // A failed workspace read says so rather than silently falling back to the list.
  assert.ok(
    /selectedEmployee && !workspace/.test(source),
    "a failed calendar read must render an explicit message, not drop back to the list",
  );

  // 4. The list fits the screen.
  assert.ok(
    /<table className="w-full table-fixed border-collapse text-left">/.test(source),
    "the employee table must be table-fixed — the whole company lands in it now",
  );
  assert.ok(/<colgroup>/.test(source), "a table-fixed table needs an explicit colgroup");
  for (const scroller of ["overflow-x-auto", "overflow-x-scroll", "overflow-auto", "overflow-scroll"]) {
    assert.ok(
      !source.includes(scroller),
      `"${scroller}" grants a sideways scroll on this page — fit by merging columns instead (AGENTS.md §4)`,
    );
  }
  // The three middle columns merge into the employee cell on a phone rather than being squeezed.
  assert.equal(
    (source.match(/hidden px-5 py-3 sm:table-cell/g) ?? []).length,
    3,
    "the three middle header cells must hide below sm so five columns are not squeezed into 375px",
  );
  assert.ok(
    /sm:hidden/.test(source),
    "the phone view must carry the hidden columns' content merged into the employee cell",
  );

  // No ellipsis truncation anywhere on the page (standing owner rule).
  assert.ok(!/…|\btruncate\b|text-ellipsis/.test(source), "this page must not truncate text");
}

if (process.argv[1] && process.argv[1].endsWith("private-calendars-admin-any-employee.test.ts")) {
  runPrivateCalendarsAdminAnyEmployeeTests();
  console.log("private-calendars-admin-any-employee: ok");
}
