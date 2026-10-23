import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { ACTIVE_EMPLOYMENT_STATUSES_IN_LIST } from "../src/lib/auth/session-lifecycle.ts";

/**
 * Item B: five hand-rolled "terminal employment status" filters (four supabase-js
 * `.not("employment_status", "in", "(resigned,terminated,inactive)")` builders plus one raw
 * PostgREST query-string variant) previously diverged from the canonical
 * `ACTIVE_EMPLOYMENT_STATUSES` set in two ways: they were missing `not_renewed` from the
 * denylist, and `.not(col, "in", (...))` excludes NULL rows in Postgres (`NULL NOT IN (...)`
 * is NULL, not true) so legacy rows with an unset employment_status were silently dropped.
 * This test locks in the migration to the shared `ACTIVE_EMPLOYMENT_STATUSES_IN_LIST` +
 * null-safe `.or(...)` pattern across all five call sites, plus the roster.ts local
 * Set/helper collapse onto `isTerminalEmploymentStatus`.
 */
export function runEmployeeStatusFilterConsolidationTests() {
  // (1) The canonical constant is derived from ACTIVE_EMPLOYMENT_STATUSES, so it can never
  // drift from the Set that isTerminalEmploymentStatus() itself checks against.
  assert.equal(
    ACTIVE_EMPLOYMENT_STATUSES_IN_LIST,
    "(active,on_leave)",
    "ACTIVE_EMPLOYMENT_STATUSES_IN_LIST must be the literal PostgREST in-list form of the active statuses",
  );

  const deviceUserMappingSource = readFileSync("src/lib/attendance/device-user-mapping.ts", "utf8");
  const policiesSource = readFileSync("src/lib/attendance/policies.ts", "utf8");
  const emailSource = readFileSync("src/lib/notifications/email.ts", "utf8");
  const employeeDirectorySource = readFileSync("src/lib/employees/employee-directory.ts", "utf8");
  const rosterSource = readFileSync("src/lib/attendance/roster.ts", "utf8");

  const supabaseBuilderFiles: Record<string, string> = {
    "device-user-mapping.ts": deviceUserMappingSource,
    "email.ts": emailSource,
    "employee-directory.ts": employeeDirectorySource,
    "policies.ts": policiesSource,
  };

  // (2) Each of the four hand-rolled supabase-js/raw-query files must import the shared
  // constant from the canonical session-lifecycle module.
  //
  // The constant may share its import statement with other names from that same module — what is
  // pinned here is WHERE the constant comes from, never that the file imports nothing else beside
  // it. Spelled as one exact line, this went red on 2026-10-23 for `employee-directory.ts` adding
  // `hasDepartedEmployment` (the notice-period fix) to the very same import.
  for (const [name, source] of Object.entries(supabaseBuilderFiles)) {
    assert.match(
      source,
      /import \{[^}]*\bACTIVE_EMPLOYMENT_STATUSES_IN_LIST\b[^}]*\} from "@\/lib\/auth\/session-lifecycle";/,
      `${name} must import ACTIVE_EMPLOYMENT_STATUSES_IN_LIST from the canonical session-lifecycle module`,
    );
  }

  // The stale literal (missing not_renewed, NULL-unsafe) must be gone from all 5 touched files.
  const allTouchedFiles: Record<string, string> = {
    ...supabaseBuilderFiles,
    "roster.ts": rosterSource,
  };
  for (const [name, source] of Object.entries(allTouchedFiles)) {
    assert.doesNotMatch(
      source,
      /\(resigned,terminated,inactive\)/,
      `${name} must no longer contain the stale hand-rolled terminal-status literal`,
    );
  }

  // device-user-mapping.ts and policies.ts: the null-safe .or(...) replacement.
  const nullSafeOrFragment = "employment_status.is.null,employment_status.in.${ACTIVE_EMPLOYMENT_STATUSES_IN_LIST}";
  assert.ok(
    deviceUserMappingSource.includes(nullSafeOrFragment),
    "device-user-mapping.ts must use the null-safe ACTIVE_EMPLOYMENT_STATUSES_IN_LIST .or(...) filter",
  );
  assert.ok(
    policiesSource.includes(nullSafeOrFragment),
    "policies.ts must use the null-safe ACTIVE_EMPLOYMENT_STATUSES_IN_LIST .or(...) filter",
  );

  // email.ts had TWO occurrences of the stale filter — both call sites must be fixed.
  const emailOrMatches = emailSource.split(nullSafeOrFragment).length - 1;
  assert.equal(emailOrMatches, 2, "email.ts must fix BOTH hand-rolled terminal-status filters");

  // employee-directory.ts: the raw PostgREST query-string variant must be converted to an
  // `or=(...)` fragment while preserving the leading `&` and the manager_hr_id scoping filter
  // that came before it in the original string.
  // The local the hr id is read from may be called anything — the filter's SHAPE is what is pinned.
  assert.match(
    employeeDirectorySource,
    /`employees\?manager_hr_id=eq\.\$\{[A-Za-z_$][\w$]*\}&or=\(employment_status\.is\.null,employment_status\.in\.\$\{ACTIVE_EMPLOYMENT_STATUSES_IN_LIST\}\)`/,
    "employee-directory.ts manager-reassignment PATCH filter must preserve manager_hr_id scoping and use the canonical or= null-safe filter",
  );

  // (3) roster.ts must delegate to the canonical predicate and drop its own local Set/helper.
  assert.match(
    rosterSource,
    /import \{[^}]*\bisTerminalEmploymentStatus\b[^}]*\} from "@\/lib\/auth\/session-lifecycle";/,
    "roster.ts must import isTerminalEmploymentStatus from the canonical session-lifecycle module",
  );
  assert.match(
    rosterSource,
    /isTerminalEmploymentStatus\(employee\.employment_status\)/,
    "roster.ts must call the canonical isTerminalEmploymentStatus predicate at its one call site",
  );
  assert.doesNotMatch(
    rosterSource,
    /const activeStatuses = new Set/,
    "roster.ts must no longer declare its own local activeStatuses Set",
  );
  assert.doesNotMatch(
    rosterSource,
    /function normalizeStatus/,
    "roster.ts must no longer declare its own local normalizeStatus helper",
  );
}
