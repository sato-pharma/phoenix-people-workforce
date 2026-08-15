import { getPayrollScope, type AccessContext } from "@/lib/auth/permissions";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * Function-level access guard (defense-in-depth) for the company-wide Payslips
 * Center reads. The admin page already redirects non-COMPANY scopes, but the data
 * functions must not be callable by a non-company-scope caller. System scope (the
 * service role) is allowed for internal/admin use. Throws a Forbidden-prefixed
 * error so route handlers map it to 403 via the shared isForbiddenError helper.
 */
function assertPayslipCenterAccess(access: AccessContext) {
  if (access.scope === "system") return;
  if (getPayrollScope(access) !== "COMPANY") {
    throw new Error("Forbidden: Payslips Center requires company-scope payroll access.");
  }
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
  assertPayslipCenterAccess(access);
  const supabase = getSupabaseAdmin();
  const initialResult = await supabase
    .from("salary_records")
    .select("hr_id,full_name,line,area,job_title,salary_batches!inner(status)")
    .in("salary_batches.status", publishedPayslipStatuses)
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

async function querySalaryRecords(column: "full_name" | "hr_id", query: string) {
  const supabase = getSupabaseAdmin();
  const base = supabase
    .from("salary_records")
    .select("id,batch_id,hr_id,full_name,line,area,job_title,gross_salary,total_additions,total_deductions,net_salary,salary_batches!inner(status)")
    .in("salary_batches.status", publishedPayslipStatuses);

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
  assertPayslipCenterAccess(access);
  const query = cleanSearch(search);
  if (!query) {
    return {
      employees: [] as PayslipCenterEmployee[],
      query,
      rows: [] as PayslipCenterRow[],
    };
  }

  const recordResults = await Promise.all([
    querySalaryRecords("full_name", query),
    querySalaryRecords("hr_id", query),
  ]);
  const records = uniqueRows(recordResults.flat());
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
