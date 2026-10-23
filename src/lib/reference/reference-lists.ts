/**
 * The four reference lists - employees, lines, areas, departments - read once a minute per process.
 *
 * WHY (2026-10-23 performance audit). Postgres is idle here: 9.9% of one core over 28 hours, a
 * 98.99% cache hit ratio, one or two active queries at the busiest minute. What the pages wait on is
 * the Supabase API toll in front of it - 130-180 ms at three in the morning for reads Postgres
 * answers in 0.06 to 3.5 ms, and that toll RISES with load (81 ms at the median under 300 calls a
 * minute, 213 ms over 900). These four lists were measured at about 55,000 calls and 18,900
 * API-seconds a day, `employees` alone at 39,349 calls averaging 229 ms. They are also the four
 * smallest and least volatile tables in the system: 220 employees, 143 areas, 11 departments and 4
 * lines, counted on production on 2026-10-23.
 *
 * So every full-list read of them now goes through one accessor over `getOrLoadShared`, on the
 * freshness the owner chose on 2026-10-16: a copy up to one minute old, dropped at once by a write
 * this process makes. Forty readers that each paid their own round trip pay at most one between them.
 *
 * WHAT MAY NOT COME THROUGH HERE. The cache's own contract (`src/lib/cache/shared-read.ts`): a read
 * that decides money, a deduction, an approval or a notification never comes through it. So payroll,
 * automated payroll, deductions and daily deductions, attendance, notifications, approvals,
 * marketing requests, sales and closing, direct orders, auth and the employee importer keep their
 * own fresh reads - and the superset below deliberately carries NO money column at all: no
 * `base_salary`, no `social_insurance_wage`, no `payment_mode`, no `payroll_eligible`. A column that
 * decides a payment cannot be read a minute late from here, because it cannot be read from here at
 * all. `tests/reference-list-cache.test.ts` pins both halves - the adopter list and the columns - so
 * a payroll reader cannot quietly join.
 *
 * ONE NAMESPACE PER TABLE. A shared namespace would mean an employee upsert also dropped the
 * four-row line list, which is the opposite of the point.
 *
 * ONE SUPERSET SELECT PER TABLE, AND EVERY COLUMN IN IT MUST EXIST. PostgREST answers a select
 * naming an absent column with 42703 and fails THE WHOLE READ, not that one field - the trap
 * `src/lib/employees/missing-column.ts` was written to record. Every column below was read off
 * production (`ozucdzovmcqvepbozvqf`, resolved with `list_projects`) on 2026-10-23 before it was
 * named here. Adding one means checking it there first.
 *
 * A READ THAT EMBEDS ITS PARENTS (`lines(name)`, `departments(name)`) IS NOT A FULL-LIST READ OF
 * THIS SHAPE and keeps its own query - the organogram source and the company vacation report. They
 * can be folded in later by joining the cached parents by id; that is a change of shape in those
 * callers, not of this module.
 *
 * THESE LOADERS THROW. An empty reference list reads as a fact about the company - "nobody is on
 * this line", "this person has no department" - which is the failure mode this repo has been burned
 * by more than once. A caller that previously ignored its own read error keeps that posture at its
 * own call site, in the open, rather than having it hidden in here.
 */

import { bumpSharedReadGeneration, getOrLoadShared } from "@/lib/cache/shared-read";
import { isMissingColumnError } from "@/lib/employees/missing-column";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/** One namespace per table, so a write to one list never drops another. */
export const REFERENCE_EMPLOYEES = "reference:employees";
export const REFERENCE_LINES = "reference:lines";
export const REFERENCE_AREAS = "reference:areas";
export const REFERENCE_DEPARTMENTS = "reference:departments";

/**
 * Identity, placement and lifecycle - never compensation. Read off production on 2026-10-23;
 * `hr_id` is the primary key and so the keyset cursor.
 */
export const REFERENCE_EMPLOYEE_COLUMNS =
  "hr_id,full_name,nickname,name_ar,job_title,employment_status,manager_hr_id," +
  "department_id,line_id,area_id,team_id,position_id,hire_date,last_working_date," +
  "crm_id,crm_username,work_email,mobile_number,work_half,region_name,region_code," +
  "organogram_visible,contract_type,contract_renewal_date,updated_at";

export const REFERENCE_LINE_COLUMNS = "id,code,name,department_id,is_active,updated_at";
export const REFERENCE_AREA_COLUMNS = "id,code,name,line_id,is_active,updated_at";
export const REFERENCE_DEPARTMENT_COLUMNS = "id,code,name,is_active,updated_at";

export type ReferenceEmployee = {
  hr_id: string | null;
  full_name: string | null;
  nickname: string | null;
  name_ar: string | null;
  job_title: string | null;
  employment_status: string | null;
  manager_hr_id: string | null;
  department_id: number | null;
  line_id: number | null;
  area_id: number | null;
  team_id: number | null;
  position_id: number | null;
  hire_date: string | null;
  last_working_date: string | null;
  crm_id: string | null;
  crm_username: string | null;
  work_email: string | null;
  mobile_number: string | null;
  work_half: string | null;
  region_name: string | null;
  region_code: string | null;
  organogram_visible: boolean | null;
  contract_type: string | null;
  contract_renewal_date: string | null;
  updated_at: string | null;
};

export type ReferenceLine = {
  id: number | null;
  code: string | null;
  name: string | null;
  department_id: number | null;
  is_active: boolean | null;
  updated_at: string | null;
};

export type ReferenceArea = {
  id: number | null;
  code: string | null;
  name: string | null;
  line_id: number | null;
  is_active: boolean | null;
  updated_at: string | null;
};

export type ReferenceDepartment = {
  id: number | null;
  code: string | null;
  name: string | null;
  is_active: boolean | null;
  updated_at: string | null;
};

/**
 * Row budgets, each several times today's count (220 / 143 / 11 / 4 on production, 2026-10-23), so
 * growth never silently stops the sharing: `getOrLoadShared` SERVES a load over its budget and
 * simply does not keep it. One entry per namespace, because there is one list per table.
 */
const EMPLOYEE_LIMITS = { maxEntries: 1, maxRowsTotal: 20_000 };
const ORG_LIMITS = { maxEntries: 1, maxRowsTotal: 5_000 };

/**
 * A full-table keyset walk. The cursor is the table's own primary key, so a row written while the
 * walk runs cannot shift a page the way an offset walk does, and nothing caps the row count - the
 * two failures `src/lib/supabase/paginated.ts` exists to prevent.
 */
async function readAll<Row extends object>(
  table: string,
  columns: string,
  cursorColumn: "id" | "hr_id",
): Promise<Row[]> {
  const supabase = getSupabaseAdmin();
  return fetchAllRowsKeyset<Row>(() => supabase.from(table).select(columns), {
    cursorColumn,
    cursorOf: (row) =>
      (row as Record<string, number | string | null | undefined>)[cursorColumn] ?? null,
  });
}

/**
 * `departments.is_active` is read with the fallback the employee importer already carried: a
 * database without that column answers 42703 and the WHOLE read fails, not just that field.
 * Production has the column today, so this is defensive - but it lives here once, so no caller has
 * to know. The check is by error CODE naming that exact column (`isMissingColumnError`), never a
 * substring of the message: a constraint violation that merely mentions `is_active` must not be read
 * as "the column is not there".
 */
async function readDepartments(): Promise<ReferenceDepartment[]> {
  try {
    return await readAll<ReferenceDepartment>("departments", REFERENCE_DEPARTMENT_COLUMNS, "id");
  } catch (error) {
    if (!isMissingColumnError(error, "is_active")) throw error;
    const rows = await readAll<Omit<ReferenceDepartment, "is_active">>(
      "departments",
      REFERENCE_DEPARTMENT_COLUMNS.replace(",is_active", ""),
      "id",
    );
    return rows.map((row) => ({ ...row, is_active: null }));
  }
}

/** The whole employee list, at most a minute old. Identity and placement - never compensation. */
export async function loadReferenceEmployees(): Promise<ReferenceEmployee[]> {
  const { rows } = await getOrLoadShared<ReferenceEmployee>(
    REFERENCE_EMPLOYEES,
    "employees",
    () => readAll<ReferenceEmployee>("employees", REFERENCE_EMPLOYEE_COLUMNS, "hr_id"),
    EMPLOYEE_LIMITS,
  );
  return rows ?? [];
}

/** Every line. */
export async function loadReferenceLines(): Promise<ReferenceLine[]> {
  const { rows } = await getOrLoadShared<ReferenceLine>(
    REFERENCE_LINES,
    "lines",
    () => readAll<ReferenceLine>("lines", REFERENCE_LINE_COLUMNS, "id"),
    ORG_LIMITS,
  );
  return rows ?? [];
}

/** Every area. */
export async function loadReferenceAreas(): Promise<ReferenceArea[]> {
  const { rows } = await getOrLoadShared<ReferenceArea>(
    REFERENCE_AREAS,
    "areas",
    () => readAll<ReferenceArea>("areas", REFERENCE_AREA_COLUMNS, "id"),
    ORG_LIMITS,
  );
  return rows ?? [];
}

/** Every department. */
export async function loadReferenceDepartments(): Promise<ReferenceDepartment[]> {
  const { rows } = await getOrLoadShared<ReferenceDepartment>(
    REFERENCE_DEPARTMENTS,
    "departments",
    readDepartments,
    ORG_LIMITS,
  );
  return rows ?? [];
}

/**
 * An app path wrote employees: the next read sees it.
 *
 * The employee importer writes the departments, then the lines, then the employees, and reads the
 * lists back inside the SAME request to resolve what it has just created - so these bumps are
 * correctness, not polish. For a write another process makes (the worker, direct SQL) the
 * one-minute lifetime is the backstop, which is the freshness the owner chose.
 */
export function forgetReferenceEmployees(reason: string): void {
  bumpSharedReadGeneration(REFERENCE_EMPLOYEES, reason);
}

/** An app path wrote lines. */
export function forgetReferenceLines(reason: string): void {
  bumpSharedReadGeneration(REFERENCE_LINES, reason);
}

/** An app path wrote areas. */
export function forgetReferenceAreas(reason: string): void {
  bumpSharedReadGeneration(REFERENCE_AREAS, reason);
}

/** An app path wrote departments. */
export function forgetReferenceDepartments(reason: string): void {
  bumpSharedReadGeneration(REFERENCE_DEPARTMENTS, reason);
}
