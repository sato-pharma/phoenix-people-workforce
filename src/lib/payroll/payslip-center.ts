import {
  getPayrollScope,
  HR_ADVISORY_COMPENSATION_JOB_TITLES,
  type AccessContext,
} from "@/lib/auth/permissions";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * WHO A VIEWER MAY SEE IN THE PAYSLIPS CENTER.
 *
 * Until 2026-09-01 this page had exactly two answers: company-wide, or nothing. The owner's
 * instruction that day opened it to the HR Business Partner with a named, narrower audience —
 * "you will make her able to see the district managers, the Medicare reps, and herself only in
 * the payslips" — so the guard now returns an AUDIENCE rather than a yes/no, and every reader
 * below filters by it.
 *
 * Measured on production the day it was written: 796 published payslip rows in total, of which
 * 676 (144 people) are District Sales Managers and Medical Representatives. The other 120 rows —
 * every manager above district, HR, finance, SFE, marketing — are what this audience WITHHOLDS.
 * That gap is the whole point of the change; if a later edit makes her count read 796, the filter
 * has stopped working.
 */
export type PayslipCenterAudience =
  | { kind: "company" }
  /**
   * A named set of job titles, plus optionally the viewer's own record. `selfHrId` is separate
   * from the titles on purpose: her own title is NOT in the list, and folding it in would widen
   * the audience to every other HR Business Partner the company ever employs.
   */
  | { jobTitles: readonly string[]; kind: "job-titles"; selfHrId: string | null };

/**
 * The two job titles the HR Business Partner may see. ONE list, shared with the Employee
 * Directory's salary columns — see HR_ADVISORY_COMPENSATION_JOB_TITLES in permissions.ts for why
 * the same sentence has to govern both screens, and for the case-insensitivity rule.
 *
 * Verified against production the day it was written: "Medical Representative" 553 rows / 119
 * people, "District Sales Manager" 123 rows / 25 people, both spelled exactly like this in
 * `salary_records.job_title`.
 */
export const HR_ADVISORY_PAYSLIP_JOB_TITLES = HR_ADVISORY_COMPENSATION_JOB_TITLES;

/** One spelling of a free-text title or a mixed-case HR_ID, for comparison only. */
function payslipMatchKey(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

/**
 * What this viewer may see, or null if the Payslips Center is not theirs at all.
 *
 * Ordered widest-first so a role that holds both routes keeps the wider one.
 */
export function resolvePayslipCenterAudience(
  access: Pick<AccessContext, "hrId" | "role" | "scope">,
): PayslipCenterAudience | null {
  if (access.scope === "system") return { kind: "company" };
  if (getPayrollScope(access) === "COMPANY") return { kind: "company" };
  // The HR Business Partner. Deliberately NOT a widening of getPayrollScope, which is consulted by
  // /payroll and the batch screens too — this grants sight of one page's rows for two job titles,
  // not company payroll standing. Her own row is included by HR_ID because she has none today (she
  // joined 2026-09-01), and an audience that silently excluded her own future payslip would be a
  // bug nobody could see until her first pay run.
  if (access.role === "HR Advisory") {
    return {
      jobTitles: HR_ADVISORY_PAYSLIP_JOB_TITLES,
      kind: "job-titles",
      selfHrId: access.hrId ?? null,
    };
  }
  return null;
}

/**
 * THE BOUNDARY. Every row handed to a caller passes through this, in JavaScript, after the query.
 *
 * The SQL narrowing below is an optimisation and nothing more — a `.or()` string is easy to get
 * subtly wrong, and this repo has shipped a PostgREST filter that returned everything with no
 * error. So the predicate is applied again here, where it is testable without a database.
 */
export function isPayslipRowVisibleToAudience(
  audience: PayslipCenterAudience,
  row: { hrId: string | null | undefined; jobTitle: string | null | undefined },
): boolean {
  if (audience.kind === "company") return true;
  const titleKey = payslipMatchKey(row.jobTitle);
  if (audience.jobTitles.some((title) => payslipMatchKey(title) === titleKey)) return true;
  // HR ids are MIXED CASE in this database and a plain equality has under-returned by 28%
  // elsewhere, so both sides are lowered before they are compared.
  const selfKey = payslipMatchKey(audience.selfHrId);
  return selfKey.length > 0 && payslipMatchKey(row.hrId) === selfKey;
}

/**
 * The same predicate as a PostgREST filter, so a restricted viewer never FETCHES what she may not
 * see. Both readers cap at a row limit, and filtering after the cap would let an unrelated row
 * consume her budget and truncate her own list — the misleading-empty-page failure this repo's
 * rules forbid.
 *
 * `ilike` with no wildcard is an exact, case-insensitive match, which is precisely the comparison
 * isPayslipRowVisibleToAudience makes. No value here contains a comma, which is what would
 * otherwise break the or-string.
 */
function payslipAudienceOrFilter(audience: PayslipCenterAudience): string | null {
  if (audience.kind === "company") return null;
  const terms = audience.jobTitles.map((title) => `job_title.ilike.${title}`);
  if (audience.selfHrId) terms.push(`hr_id.ilike.${audience.selfHrId}`);
  return terms.join(",");
}

/**
 * Function-level access guard (defense-in-depth) for the Payslips Center reads. The admin page
 * already redirects a viewer with no audience, but the data functions must not be callable by
 * one either. System scope (the service role) is allowed for internal/admin use. Throws a
 * Forbidden-prefixed error so route handlers map it to 403 via the shared isForbiddenError helper.
 *
 * RETURNS the audience — callers must filter by it rather than treating this as a boolean.
 */
function assertPayslipCenterAccess(access: AccessContext): PayslipCenterAudience {
  const audience = resolvePayslipCenterAudience(access);
  if (!audience) {
    throw new Error("Forbidden: Payslips Center requires company-scope payroll access.");
  }
  return audience;
}

/**
 * Who may generate and download the rendered PDF payslip DOCUMENT for another employee.
 *
 * Deliberately narrower than assertPayslipCenterAccess above: reading the figures on screen and
 * carrying a signed-looking document out of the building are different acts. The CEO passes the
 * Center's own guard and must NOT pass this one.
 *
 * Finance Manager added 2026-08-10 (owner) — he already holds payslips:["read","export"] and
 * getPayrollScope returns COMPANY, so the Center's data was already fully open to him; the PDF was
 * the one thing still hardcoded to Super Admin.
 *
 * Exported and used by BOTH the API route and the admin page, which is the point: those two used to
 * carry the same `access.role === "Super Admin"` literal in two files, and a literal duplicated
 * across a boundary is how a UI button and its route drift apart.
 */
export function canExportPayslipDocument(access: Pick<AccessContext, "role">): boolean {
  return access.role === "Super Admin" || access.role === "Finance Manager";
}

type SalaryRecordLookupRow = {
  area: string | null;
  batch_id: string;
  full_name: string | null;
  gross_salary: number | null;
  hr_id: string | null;
  id: string | number;
  job_title: string | null;
  line: string | null;
  net_salary: number | null;
  total_additions: number | null;
  total_deductions: number | null;
};

type SalaryBatchLookupRow = {
  created_at: string;
  id: string;
  month: number;
  status: string;
  year: number;
};

export type PayslipCenterRow = {
  area: string;
  batchId: string;
  employeeCode: string;
  fullName: string;
  grossSalary: number;
  hrId: string;
  jobTitle: string;
  line: string;
  month: number;
  netSalary: number;
  recordId: string;
  status: string;
  totalAdditions: number;
  totalDeductions: number;
  uploadedAt: string;
  year: number;
};

export type PayslipCenterEmployee = {
  area: string;
  employeeCode: string;
  fullName: string;
  hrId: string;
  jobTitle: string;
  line: string;
  payslips: PayslipCenterRow[];
};

export type PayslipCenterEmployeeOption = {
  employeeCode: string;
  fullName: string;
  hrId: string;
  label: string;
  value: string;
};

function cleanSearch(value: string | string[] | undefined) {
  const raw = Array.isArray(value) ? value[0] : value;
  return String(raw ?? "").trim();
}

function normalizeKey(value: string) {
  return value.trim().toLowerCase();
}

function uniqueRows(rows: SalaryRecordLookupRow[]) {
  const byId = new Map<string, SalaryRecordLookupRow>();
  rows.forEach((row) => byId.set(String(row.id), row));
  return [...byId.values()];
}

const publishedPayslipStatuses = ["approved", "locked"] as const;

export async function getPayslipCenterEmployeeOptions(access: AccessContext) {
  const audience = assertPayslipCenterAccess(access);
  const supabase = getSupabaseAdmin();
  // A PICKER IS NEVER WIDER THAN ITS VIEWER (owner's rule). This list is the names on the page
  // before any search is typed, so filtering only the results would still have handed a restricted
  // viewer the name of every employee in the company.
  const audienceFilter = payslipAudienceOrFilter(audience);
  const baseQuery = supabase
    .from("salary_records")
    .select("hr_id,full_name,line,area,job_title,salary_batches!inner(status)")
    .in("salary_batches.status", publishedPayslipStatuses);
  const initialResult = await (audienceFilter ? baseQuery.or(audienceFilter) : baseQuery)
    .order("full_name", { ascending: true })
    .limit(2000);
  const data: unknown[] | null = initialResult.data;
  const error: unknown = initialResult.error;

  if (error) throw error;

  const optionsByKey = new Map<string, PayslipCenterEmployeeOption>();
  ((data ?? []) as Array<Partial<Pick<SalaryRecordLookupRow, "area" | "full_name" | "hr_id" | "job_title" | "line">>>).forEach((row) => {
    const hrId = String(row.hr_id ?? "").trim();
    const fullName = String(row.full_name ?? "").trim();
    const value = hrId;
    if (!value || !fullName) return;
    // The boundary, re-applied after the query — see isPayslipRowVisibleToAudience.
    if (!isPayslipRowVisibleToAudience(audience, { hrId, jobTitle: row.job_title })) return;

    const key = normalizeKey(value);
    if (optionsByKey.has(key)) return;

    const secondary = [
      hrId,
      row.job_title,
      row.line,
      row.area,
    ].filter(Boolean).join(" - ");

    optionsByKey.set(key, {
      employeeCode: hrId,
      fullName,
      hrId,
      label: `${fullName}${secondary ? ` (${secondary})` : ""}`,
      value,
    });
  });

  return [...optionsByKey.values()].sort((left, right) => left.fullName.localeCompare(right.fullName));
}

async function querySalaryRecords(
  column: "full_name" | "hr_id",
  query: string,
  audience: PayslipCenterAudience,
) {
  const supabase = getSupabaseAdmin();
  const audienceFilter = payslipAudienceOrFilter(audience);
  const scoped = supabase
    .from("salary_records")
    .select("id,batch_id,hr_id,full_name,line,area,job_title,gross_salary,total_additions,total_deductions,net_salary,salary_batches!inner(status)")
    .in("salary_batches.status", publishedPayslipStatuses);
  const base = audienceFilter ? scoped.or(audienceFilter) : scoped;

  // ID columns require exact match — ilike on hr_id would match A-5, A-50, A-51, A-500, etc.
  const initialResult = await (column === "full_name"
    ? base.ilike(column, `%${query}%`)
    : base.eq(column, query)
  ).limit(120);
  const data: unknown[] | null = initialResult.data;
  const error: unknown = initialResult.error;

  if (error) throw error;
  return (data ?? []) as SalaryRecordLookupRow[];
}

export async function searchPayslipCenter(access: AccessContext, search: string | string[] | undefined) {
  const audience = assertPayslipCenterAccess(access);
  const query = cleanSearch(search);
  if (!query) {
    return {
      employees: [] as PayslipCenterEmployee[],
      query,
      rows: [] as PayslipCenterRow[],
    };
  }

  const recordResults = await Promise.all([
    querySalaryRecords("full_name", query, audience),
    querySalaryRecords("hr_id", query, audience),
  ]);
  // Filtered in SQL above and again here: the query narrowing is an optimisation, this is the
  // boundary. A name search is the one path where a viewer chooses the input, so a row that
  // slipped past a malformed or-string would be a row she picked out by name herself.
  const records = uniqueRows(recordResults.flat()).filter((record) =>
    isPayslipRowVisibleToAudience(audience, { hrId: record.hr_id, jobTitle: record.job_title }),
  );
  const batchIds = [...new Set(records.map((record) => record.batch_id).filter(Boolean))];
  const batchesById = new Map<string, SalaryBatchLookupRow>();

  if (batchIds.length > 0) {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("salary_batches")
      .select("id,month,year,status,created_at")
      .in("id", batchIds)
      .in("status", publishedPayslipStatuses);

    if (error) throw error;
    ((data ?? []) as SalaryBatchLookupRow[]).forEach((batch) => {
      batchesById.set(batch.id, batch);
    });
  }

  const rows = records
    .map((record): PayslipCenterRow | null => {
      const batch = batchesById.get(record.batch_id);
      if (!batch) return null;
      if (!publishedPayslipStatuses.includes(batch.status as (typeof publishedPayslipStatuses)[number])) return null;

      return {
        area: record.area ?? "Unassigned",
        batchId: record.batch_id,
        employeeCode: record.hr_id ?? "",
        fullName: record.full_name ?? "Unknown employee",
        grossSalary: Number(record.gross_salary ?? 0),
        hrId: record.hr_id ?? "",
        jobTitle: record.job_title ?? "Unassigned",
        line: record.line ?? "Unassigned",
        month: Number(batch.month),
        netSalary: Number(record.net_salary ?? 0),
        recordId: String(record.id),
        status: batch.status,
        totalAdditions: Number(record.total_additions ?? 0),
        totalDeductions: Number(record.total_deductions ?? 0),
        uploadedAt: batch.created_at,
        year: Number(batch.year),
      };
    })
    .filter((row): row is PayslipCenterRow => Boolean(row))
    .sort((left, right) => {
      if (right.year !== left.year) return right.year - left.year;
      if (right.month !== left.month) return right.month - left.month;
      return right.uploadedAt.localeCompare(left.uploadedAt);
    });

  const employeeMap = new Map<string, PayslipCenterEmployee>();
  rows.forEach((row) => {
    const key = normalizeKey(row.hrId || row.employeeCode || row.fullName);
    const current = employeeMap.get(key);
    if (current) {
      current.payslips.push(row);
      return;
    }

    employeeMap.set(key, {
      area: row.area,
      employeeCode: row.employeeCode,
      fullName: row.fullName,
      hrId: row.hrId,
      jobTitle: row.jobTitle,
      line: row.line,
      payslips: [row],
    });
  });

  return {
    employees: [...employeeMap.values()],
    query,
    rows,
  };
}
