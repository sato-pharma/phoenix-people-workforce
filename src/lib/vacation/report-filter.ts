import type { VacationReportFilters } from "./types";

/**
 * Pure, dependency-free mirror of the WHERE clause inside the `phx_vacation_report_rows` Postgres
 * function. It lives in its own module (not in the 5,000-line `service.ts`, which pulls in exceljs,
 * the Supabase server client, and the whole vacation write graph) for two reasons:
 *
 *  1. It can be unit-tested in the plain-node harness without loading that graph — see
 *     `tests/vacation-report-filter-equivalence.test.ts`, which pins it against md5 fingerprints
 *     captured from the LIVE production RPC across a 36-combo filter × scope matrix.
 *  2. It carries no runtime imports at all (the only import is a type, fully erased), so nothing here
 *     adds weight to any bundle that reaches it.
 *
 * `service.ts` reads the ~300-row `v2_vacation_requests` table ONCE per revalidation window
 * (`loadAllVacationRequestRowsCached`) and then calls `filterVacationRowsInMemory` per request,
 * instead of hitting the RPC ~779×/hour. These functions must stay byte-faithful to that SQL — any
 * divergence changes what a report shows. The equivalence test is the guard.
 */

/**
 * The minimal row shape the filter reads. The full DB row (`VacationRequestDbRow` in service.ts) is
 * structurally assignable to this, and `filterVacationRowsInMemory` is generic so callers keep their
 * own concrete row type on the way out.
 */
export type VacationFilterableRow = {
  id: string;
  employee_hr_id: string | null;
  employee_name: string | null;
  manager_hr_id: string | null;
  manager_name: string | null;
  department_name: string | null;
  line_name: string | null;
  vacation_type: string | null;
  status: string | null;
  payment_status: string | null;
  start_date: string | null;
};

/**
 * Compile a Postgres ILIKE pattern to an anchored, case-insensitive RegExp with identical
 * semantics: `%` matches any run of characters (newlines included), `_` matches exactly one, a
 * backslash escapes the next character, every other character matches literally, and the whole
 * subject must match.
 */
export function vacationIlikePatternToRegExp(pattern: string): RegExp {
  const escapeLiteral = (char: string) => char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let out = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === "\\") {
      const next = pattern[i + 1];
      if (next === undefined) { out += "\\\\"; break; }
      out += escapeLiteral(next);
      i += 1;
    } else if (ch === "%") {
      out += "[\\s\\S]*";
    } else if (ch === "_") {
      out += "[\\s\\S]";
    } else {
      out += escapeLiteral(ch);
    }
  }
  return new RegExp(`^${out}$`, "i");
}

/** concat_ws(' ', …) over the exact columns and order the RPC searches — NULLs skipped entirely
 * (never separated), empty strings kept, matching Postgres concat_ws. */
function buildVacationSearchHaystack(row: VacationFilterableRow): string {
  return [
    row.id, row.employee_hr_id, row.employee_name, row.manager_hr_id, row.manager_name,
    row.department_name, row.line_name, row.vacation_type, row.status, row.payment_status,
  ].filter((value) => value != null).join(" ");
}

/** null/empty => inactive (mirrors `nullif(p_filters->>'key','') is null`). */
function activeVacationFilterValue(value: string | null | undefined): string | null {
  if (value == null) return null;
  return value === "" ? null : value;
}

/** As above, but 'all' is also inactive (mirrors the status/paymentStatus/vacationType clauses). */
function activeVacationEnumFilter(value: string | null | undefined): string | null {
  const active = activeVacationFilterValue(value);
  return active === "all" ? null : active;
}

/**
 * Apply the vacation report filters in memory with EXACTLY the semantics of the SQL WHERE clause
 * inside phx_vacation_report_rows: case-sensitive equality for status/paymentStatus/vacationType/
 * department/line, ILIKE for employee/manager, `id::text =` for requestId, a start_date range for
 * dateFrom/dateTo, and a concat_ws(' ', …) ILIKE '%search%' free-text match. A NULL column never
 * satisfies an active predicate, mirroring SQL three-valued logic. Order is preserved, so a caller
 * that pre-sorted (created_at desc) keeps that order.
 */
export function filterVacationRowsInMemory<T extends VacationFilterableRow>(
  rows: T[],
  filters: VacationReportFilters,
): T[] {
  const status = activeVacationEnumFilter(filters.status);
  const paymentStatus = activeVacationEnumFilter(filters.paymentStatus);
  const vacationType = activeVacationEnumFilter(filters.vacationType);
  const employee = activeVacationFilterValue(filters.employee);
  const manager = activeVacationFilterValue(filters.manager);
  const department = activeVacationFilterValue(filters.department);
  const line = activeVacationFilterValue(filters.line);
  const dateFrom = activeVacationFilterValue(filters.dateFrom);
  const dateTo = activeVacationFilterValue(filters.dateTo);
  const requestId = activeVacationFilterValue(filters.requestId);
  const search = activeVacationFilterValue(filters.search);

  const employeeRe = employee != null ? vacationIlikePatternToRegExp(employee) : null;
  const managerRe = manager != null ? vacationIlikePatternToRegExp(manager) : null;
  const searchRe = search != null ? vacationIlikePatternToRegExp(`%${search}%`) : null;

  return rows.filter((row) => {
    if (status != null && row.status !== status) return false;
    if (paymentStatus != null && row.payment_status !== paymentStatus) return false;
    if (vacationType != null && row.vacation_type !== vacationType) return false;
    if (employeeRe != null && !(row.employee_hr_id != null && employeeRe.test(row.employee_hr_id))) return false;
    if (managerRe != null && !(row.manager_hr_id != null && managerRe.test(row.manager_hr_id))) return false;
    if (department != null && row.department_name !== department) return false;
    if (line != null && row.line_name !== line) return false;
    if (dateFrom != null && !(row.start_date != null && row.start_date >= dateFrom)) return false;
    if (dateTo != null && !(row.start_date != null && row.start_date <= dateTo)) return false;
    if (requestId != null && String(row.id) !== requestId) return false;
    if (searchRe != null && !searchRe.test(buildVacationSearchHaystack(row))) return false;
    return true;
  });
}
