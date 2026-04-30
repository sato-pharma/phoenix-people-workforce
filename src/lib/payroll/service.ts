import { getSupabaseAdmin } from "@/lib/supabase/server";
import type { SalaryValidationIssue, SalaryValidationRow } from "@/lib/payroll/salary-import";
import type { PayrollDashboardData, SalaryBatch, SalaryFlag, SalaryRecord } from "@/lib/payroll/types";

const emptyPayrollDashboard: PayrollDashboardData = {
  batch: null,
  batches: [],
  flags: [],
  previousRecords: [],
  records: [],
  scope: "all_time",
  summary: {
    anomalyCount: 0,
    readinessRate: 1,
    totalAdditions: 0,
    totalEmployees: 0,
    totalGovernmentDeductions: 0,
    totalGross: 0,
    totalNet: 0,
  },
};

function payrollErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "object" && error && "message" in error) {
    return String((error as { message?: unknown }).message ?? "");
  }

  return String(error);
}

export function isPayrollSchemaMissing(error: unknown) {
  const message = payrollErrorMessage(error).toLowerCase();

  return (
    message.includes("salary_batches") ||
    message.includes("salary_records") ||
    message.includes("salary_flags") ||
    message.includes("could not find the table") ||
    message.includes("schema cache") ||
    (message.includes("relation") && message.includes("does not exist"))
  );
}

function mapBatch(row: Record<string, unknown>): SalaryBatch {
  return {
    id: String(row.id),
    fileName: String(row.file_name ?? ""),
    month: Number(row.month),
    year: Number(row.year),
    status: String(row.status) as SalaryBatch["status"],
    uploadedBy: row.uploaded_by ? String(row.uploaded_by) : null,
    approvedBy: row.approved_by ? String(row.approved_by) : null,
    approvedAt: row.approved_at ? new Date(String(row.approved_at)).toISOString() : null,
    lockedAt: row.locked_at ? new Date(String(row.locked_at)).toISOString() : null,
    rejectedReason: row.rejected_reason ? String(row.rejected_reason) : null,
    createdAt: new Date(String(row.created_at)).toISOString(),
  };
}

function mapRecord(row: Record<string, unknown>): SalaryRecord {
  return {
    id: String(row.id),
    batchId: String(row.batch_id),
    employeeCode: String(row.employee_code ?? ""),
    fullName: String(row.full_name ?? ""),
    line: String(row.line ?? ""),
    area: String(row.area ?? ""),
    jobTitle: String(row.job_title ?? ""),
    grossSalary: Number(row.gross_salary ?? 0),
    expenses: Number(row.expenses ?? 0),
    incentive: Number(row.incentive ?? 0),
    overtime: Number(row.overtime ?? 0),
    bonus: Number(row.bonus ?? 0),
    extraCostOfLiving: Number(row.extra_cost_of_living ?? 0),
    fuelAllowance: Number(row.fuel_allowance ?? 0),
    otherAdditions: Number(row.other_additions ?? 0),
    totalAdditions: Number(row.total_additions ?? 0),
    socialInsurance: Number(row.social_insurance ?? 0),
    employmentIncomeTax: Number(row.employment_income_tax ?? 0),
    crm: Number(row.crm ?? 0),
    fingerPrint: Number(row.finger_print ?? 0),
    unpaidVacations: Number(row.unpaid_vacations ?? 0),
    medicalInsurance: Number(row.medical_insurance ?? 0),
    loans: Number(row.loans ?? 0),
    otherDeductions: Number(row.other_deductions ?? 0),
    totalDeductions: Number(row.total_deductions ?? 0),
    netSalary: Number(row.net_salary ?? 0),
    firstPart: Number(row.first_part ?? 0),
    secondPart: Number(row.second_part ?? 0),
  };
}

function mapFlag(row: Record<string, unknown>): SalaryFlag {
  return {
    id: String(row.id),
    batchId: String(row.batch_id),
    employeeCode: row.employee_code ? String(row.employee_code) : null,
    flagType: String(row.flag_type ?? ""),
    severity: String(row.severity ?? "info") as SalaryFlag["severity"],
    message: String(row.message ?? ""),
    createdAt: new Date(String(row.created_at)).toISOString(),
  };
}

export async function listSalaryBatches(): Promise<SalaryBatch[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("salary_batches")
    .select("*")
    .order("year", { ascending: false })
    .order("month", { ascending: false });

  if (error) {
    if (isPayrollSchemaMissing(error)) {
      return [];
    }

    throw error;
  }

  return (data ?? []).map((row) => mapBatch(row as Record<string, unknown>));
}

function payrollPeriodSortValue(batch: Pick<SalaryBatch, "month" | "year">) {
  return batch.year * 12 + batch.month;
}

export async function getLatestSalaryRecordsBefore(
  month: number,
  year: number,
): Promise<SalaryRecord[]> {
  const supabase = getSupabaseAdmin();
  const targetPeriod = year * 12 + month;
  const batches = await listSalaryBatches();
  const previousBatch = batches
    .filter((batch) => payrollPeriodSortValue(batch) < targetPeriod)
    .sort((left, right) => payrollPeriodSortValue(right) - payrollPeriodSortValue(left))[0];

  if (!previousBatch) {
    return [];
  }

  const { data, error } = await supabase
    .from("salary_records")
    .select("*")
    .eq("batch_id", previousBatch.id);

  if (error) {
    if (isPayrollSchemaMissing(error)) {
      return [];
    }

    throw error;
  }

  return (data ?? []).map((row) => mapRecord(row as Record<string, unknown>));
}

export async function getPayrollDashboard(batchId?: string): Promise<PayrollDashboardData> {
  const supabase = getSupabaseAdmin();

  const batches = await listSalaryBatches();
  const scope: PayrollDashboardData["scope"] = batchId ? "batch" : "all_time";
  const batch = batchId ? batches.find((b) => b.id === batchId) ?? batches[0] : batches[0];

  if (!batch) {
    return {
      ...emptyPayrollDashboard,
      batches,
      scope,
    };
  }

  const batchIds = batches.map((item) => item.id);
  const recordsQuery = supabase.from("salary_records").select("*");
  const flagsQuery = supabase.from("salary_flags").select("*");
  const scopedRecordsQuery =
    scope === "batch" ? recordsQuery.eq("batch_id", batch.id) : recordsQuery.in("batch_id", batchIds);
  const scopedFlagsQuery =
    scope === "batch" ? flagsQuery.eq("batch_id", batch.id) : flagsQuery.in("batch_id", batchIds);

  const [recordsResult, flagsResult] = await Promise.all([
    scopedRecordsQuery,
    scopedFlagsQuery,
  ]);

  if (recordsResult.error) {
    if (isPayrollSchemaMissing(recordsResult.error)) {
      return {
        ...emptyPayrollDashboard,
        batches,
        scope,
      };
    }

    throw recordsResult.error;
  }

  if (flagsResult.error) {
    if (isPayrollSchemaMissing(flagsResult.error)) {
      return {
        ...emptyPayrollDashboard,
        batches,
        scope,
      };
    }

    throw flagsResult.error;
  }

  const records = (recordsResult.data ?? []).map((row) => mapRecord(row as Record<string, unknown>));
  const flags = (flagsResult.data ?? []).map((row) => mapFlag(row as Record<string, unknown>));

  // Load previous period for delta comparison when the dashboard is scoped to one batch.
  const prevBatch = batches.find((b) => b.id !== batch.id);
  let previousRecords: SalaryRecord[] = [];
  if (scope === "batch" && prevBatch) {
    const prevResult = await supabase.from("salary_records").select("*").eq("batch_id", prevBatch.id);

    if (prevResult.error) {
      if (isPayrollSchemaMissing(prevResult.error)) {
        previousRecords = [];
      } else {
        throw prevResult.error;
      }
    }

    previousRecords = (prevResult.data ?? []).map((row) => mapRecord(row as Record<string, unknown>));
  }

  const totalGross = records.reduce((sum, r) => sum + r.grossSalary, 0);
  const totalNet = records.reduce((sum, r) => sum + r.netSalary, 0);
  const totalAdditions = records.reduce((sum, r) => sum + r.totalAdditions, 0);
  const totalGovtDeductions = records.reduce((sum, r) => sum + r.socialInsurance + r.employmentIncomeTax, 0);
  const avgNet = records.length > 0 ? totalNet / records.length : 0;
  const anomalies = records.filter((r) => r.netSalary > avgNet * 2.25);
  const readinessRate = records.length > 0 ? (records.length - anomalies.length) / records.length : 1;

  return {
    batch,
    batches,
    records,
    flags,
    previousRecords,
    scope,
    summary: {
      totalEmployees: records.length,
      totalGross,
      totalNet,
      totalAdditions,
      totalGovernmentDeductions: totalGovtDeductions,
      anomalyCount: anomalies.length,
      readinessRate,
    },
  };
}

type CreateSalaryBatchInput = {
  fileName: string;
  month: number;
  records: SalaryValidationRow[];
  validationWarnings: SalaryValidationIssue[];
  year: number;
};

function salaryRecordPayload(batchId: string, row: SalaryValidationRow) {
  return {
    area: row.area,
    batch_id: batchId,
    bonus: row.bonus,
    employee_code: row.employeeCode,
    employment_income_tax: row.employmentIncomeTax,
    expenses: row.expenses,
    extra_cost_of_living: row.extraCostOfLiving,
    finger_print: row.fingerPrint,
    first_part: row.firstPart,
    fuel_allowance: row.fuelAllowance,
    full_name: row.fullName,
    gross_salary: row.grossSalary,
    incentive: row.incentive,
    job_title: row.jobTitle,
    line: row.line,
    loans: row.loans,
    medical_insurance: row.medicalInsurance,
    net_salary: row.netSalary,
    other_additions: row.otherAdditions,
    other_deductions: row.otherDeductions,
    overtime: row.overtime,
    second_part: row.secondPart,
    social_insurance: row.socialInsurance,
    total_additions: row.totalAdditions,
    total_deductions: row.totalDeductions,
    unpaid_vacations: row.unpaidVacations,
  };
}

function salaryFlagPayload(batchId: string, warning: SalaryValidationIssue) {
  return {
    batch_id: batchId,
    employee_code: warning.employeeCode ?? null,
    flag_type: warning.code,
    message: `Row ${warning.row}${warning.column ? ` / ${warning.column}` : ""}: ${warning.message}`,
    severity: "warning",
  };
}

async function cleanupSalaryBatch(batchId: string) {
  const supabase = getSupabaseAdmin();
  await supabase.from("salary_batches").delete().eq("id", batchId);
}

export async function createSalaryBatch(input: CreateSalaryBatchInput) {
  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();

  const { data: batchData, error: batchError } = await supabase
    .from("salary_batches")
    .insert({
      file_name: input.fileName,
      month: input.month,
      status: "uploaded",
      updated_at: now,
      uploaded_by: "admin",
      year: input.year,
    })
    .select()
    .single();

  if (batchError || !batchData) {
    throw batchError ?? new Error("Payroll batch could not be created.");
  }

  const batch = mapBatch(batchData as Record<string, unknown>);

  try {
    const recordPayloads = input.records.map((row) =>
      salaryRecordPayload(batch.id, row),
    );

    if (recordPayloads.length > 0) {
      const { error } = await supabase.from("salary_records").insert(recordPayloads);

      if (error) {
        throw error;
      }
    }

    const flagPayloads = input.validationWarnings.map((warning) =>
      salaryFlagPayload(batch.id, warning),
    );

    if (flagPayloads.length > 0) {
      const { error } = await supabase.from("salary_flags").insert(flagPayloads);

      if (error) {
        throw error;
      }
    }

    return {
      batch,
      importedRecords: recordPayloads.length,
      governanceWarnings: flagPayloads.length,
    };
  } catch (error) {
    await cleanupSalaryBatch(batch.id);
    throw error;
  }
}

export async function deleteSalaryBatch(batchId: string) {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("salary_batches").delete().eq("id", batchId);

  if (error) {
    throw error;
  }

  return true;
}

export async function runPayrollWorkflow(
  batchId: string,
  action: "mark_review" | "approve" | "lock" | "reject" | "reopen",
  actorName: string,
  rejectedReason?: string
): Promise<SalaryBatch | null> {
  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();

  const updates: Record<string, unknown> = { updated_at: now };

  switch (action) {
    case "mark_review":
      updates.status = "under_review";
      break;
    case "approve":
      updates.status = "approved";
      updates.approved_by = actorName;
      updates.approved_at = now;
      break;
    case "lock":
      updates.status = "locked";
      updates.locked_at = now;
      break;
    case "reject":
      updates.status = "rejected";
      updates.rejected_reason = rejectedReason ?? "No reason provided.";
      break;
    case "reopen":
      updates.status = "uploaded";
      updates.rejected_reason = null;
      break;
  }

  const { data, error } = await supabase
    .from("salary_batches")
    .update(updates)
    .eq("id", batchId)
    .select()
    .maybeSingle();

  if (error || !data) return null;
  return mapBatch(data as Record<string, unknown>);
}
