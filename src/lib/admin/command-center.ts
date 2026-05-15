import type { AccessContext } from "@/lib/auth/permissions";
import { getEmployeeDirectory, type EmployeeDirectoryData } from "@/lib/employees/employee-directory";
import { isMissingRequiredManager } from "@/lib/employees/hierarchy-governance";
import { getPayrollDashboard } from "@/lib/payroll/service";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DataHealthMetrics = {
  employeeHealthRate: number;
  healthyEmployees: number;
  totalEmployees: number;
  missingManager: number;
  missingJobTitle: number;
  salesLinkageRate: number;
  salesLinkageBatch: string | null;
};

/** Flat snapshot that AdminCommandCenter renders — avoids OverviewDashboardData entirely. */
export type AdminCommandCenterData = {
  overview: {
    hr: {
      activeEmployees: number;
      totalEmployees: number;
      uniqueLines: number;
      uniqueAreas: number;
      employeesWithoutManagers: number;
    };
    payroll: {
      batchLabel: string;
      employees: number;
      gross: number;
      net: number;
      flags: number;
    };
    sales: {
      salesValue: number;
      targetValue: number;
      achievementRate: number;
      activeProducts: number;
    };
    expenses: {
      approvedAmount: number;
      totalAmount: number;
      totalRows: number;
      reportCount: number;
    };
    recruitment: {
      totalOffers: number;
      pendingOffers: number;
      acceptedOffers: number;
      rejectedOffers: number;
      acceptanceRate: number;
    };
    risk: {
      expiringContracts: number;
      probationEndings: number;
    };
  };
  health: DataHealthMetrics;
  payrollEligibleCount: number;
  dataUnavailable: string[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

async function readAllRows<T = Record<string, unknown>>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  buildQuery: () => any,
  pageSize = 1000,
): Promise<T[]> {
  const rows: T[] = [];
  let offset = 0;

  while (true) {
    const { data, error } = await buildQuery().range(offset, offset + pageSize - 1);
    if (error) throw error;
    const pageRows = (Array.isArray(data) ? data : []) as T[];
    rows.push(...pageRows);
    if (pageRows.length < pageSize) break;
    offset += pageSize;
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Data health queries (uses Supabase JS client — safe)
// ---------------------------------------------------------------------------

async function fetchSalesHealthCounts(): Promise<{
  error: string | null;
  linkedRows: number;
  totalRows: number;
}> {
  const supabase = getSupabaseAdmin();
  try {
    const [totalResult, linkedResult] = await Promise.all([
      supabase.from("sales_records").select("*", { count: "exact", head: true }),
      supabase.from("sales_records").select("*", { count: "exact", head: true }).eq("link_status", "linked"),
    ]);
    if (totalResult.error) throw totalResult.error;
    if (linkedResult.error) throw linkedResult.error;
    return {
      error: null,
      linkedRows: linkedResult.count ?? 0,
      totalRows: totalResult.count ?? 0,
    };
  } catch {
    return { error: "Sales linkage data unavailable.", linkedRows: 0, totalRows: 0 };
  }
}

function buildDataHealth(
  directory: EmployeeDirectoryData | null,
  salesCounts: { linkedRows: number; totalRows: number },
): DataHealthMetrics {
  const employees = directory?.employees ?? [];
  const activeEmployees = employees.filter((employee) =>
    String(employee.employmentStatus ?? "").trim().toLowerCase() !== "inactive"
  );
  const missingManager = activeEmployees.filter(isMissingRequiredManager).length;
  const missingJobTitle = activeEmployees.filter((employee) => !employee.jobTitle && !employee.positionTitle).length;
  const healthyEmployees = Math.max(0, activeEmployees.length - missingManager - missingJobTitle);
  const employeeHealthRate = activeEmployees.length > 0 ? (healthyEmployees / activeEmployees.length) * 100 : 100;
  const salesLinkageRate = salesCounts.totalRows > 0 ? (salesCounts.linkedRows / salesCounts.totalRows) * 100 : 100;

  return {
    employeeHealthRate,
    healthyEmployees,
    missingJobTitle,
    missingManager,
    salesLinkageBatch: null,
    salesLinkageRate,
    totalEmployees: activeEmployees.length,
  };
}

async function fetchPayrollEligibleCount(): Promise<{ count: number; error: string | null }> {
  const supabase = getSupabaseAdmin();
  try {
    const { count, error } = await supabase
      .from("v_payroll_eligible_employees")
      .select("*", { count: "exact", head: true });
    if (error) throw error;
    return { count: count ?? 0, error: null };
  } catch {
    return { count: 0, error: "Payroll eligible count unavailable." };
  }
}

async function fetchPayrollSummary(): Promise<AdminCommandCenterData["overview"]["payroll"] & {
  batch: { month: number; year: number } | null;
  error: string | null;
}> {
  const supabase = getSupabaseAdmin();
  const empty = { batch: null, batchLabel: "—", employees: 0, error: null, flags: 0, gross: 0, net: 0 };

  try {
    const { data: batch, error: batchError } = await supabase
      .from("salary_batches")
      .select("id,month,year")
      .order("year", { ascending: false })
      .order("month", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (batchError) throw batchError;
    if (!batch?.id) return empty;

    const batchId = String(batch.id);
    const [records, flagsResult] = await Promise.all([
      readAllRows<Record<string, unknown>>(() =>
        supabase
          .from("salary_records")
          .select("gross_salary,net_salary")
          .eq("batch_id", batchId),
      ),
      supabase
        .from("salary_flags")
        .select("*", { count: "exact", head: true })
        .eq("batch_id", batchId),
    ]);
    if (flagsResult.error) throw flagsResult.error;

    return {
      batch: {
        month: safeNumber(batch.month),
        year: safeNumber(batch.year),
      },
      batchLabel: `${safeNumber(batch.month)}/${safeNumber(batch.year)}`,
      employees: records.length,
      error: null,
      flags: flagsResult.count ?? 0,
      gross: records.reduce((sum, row) => sum + safeNumber(row.gross_salary), 0),
      net: records.reduce((sum, row) => sum + safeNumber(row.net_salary), 0),
    };
  } catch {
    return { ...empty, error: "Payroll data unavailable." };
  }
}

function canUseCompanyPayrollSummary(accessContext: AccessContext) {
  return (
    accessContext.scope === "system" ||
    accessContext.scope === "company" ||
    accessContext.role === "Super Admin" ||
    accessContext.role === "CEO" ||
    accessContext.role === "HR Specialist" ||
    accessContext.role === "Finance Manager"
  );
}

async function fetchScopedPayrollSummary(accessContext: AccessContext): Promise<AdminCommandCenterData["overview"]["payroll"] & {
  batch: { month: number; year: number } | null;
  error: string | null;
}> {
  try {
    const dashboard = await getPayrollDashboard(undefined, accessContext);
    return {
      batch: dashboard.batch ? { month: dashboard.batch.month, year: dashboard.batch.year } : null,
      batchLabel: dashboard.batch ? `${dashboard.batch.month}/${dashboard.batch.year}` : "—",
      employees: dashboard.summary.totalEmployees,
      error: null,
      flags: dashboard.flags.length,
      gross: dashboard.summary.totalGross,
      net: dashboard.summary.totalNet,
    };
  } catch {
    return { batch: null, batchLabel: "—", employees: 0, error: "Payroll data unavailable.", flags: 0, gross: 0, net: 0 };
  }
}

function salesBatchSortValue(row: Record<string, unknown>) {
  const statusPriority: Record<string, number> = {
    approved: 3,
    validated: 2,
    needs_review: 1,
    staged: 0,
  };
  return [
    String(statusPriority[String(row.status)] ?? 0).padStart(2, "0"),
    String(row.approved_at ?? ""),
    String(row.created_at ?? ""),
    String(row.version ?? 0).padStart(6, "0"),
  ].join("|");
}

async function fetchSalesSummary(): Promise<AdminCommandCenterData["overview"]["sales"] & { error: string | null }> {
  const supabase = getSupabaseAdmin();
  const empty = { achievementRate: 0, activeProducts: 0, error: null, salesValue: 0, targetValue: 0 };

  try {
    const batchRows = await readAllRows<Record<string, unknown>>(() =>
      supabase
        .from("sales_import_batches")
        .select("id,line,month,year,status,approved_at,created_at,version,replaced_by_batch_id")
        .is("replaced_by_batch_id", null),
    );
    const activeBatches = batchRows.filter((batch) => {
      const status = String(batch.status ?? "");
      return status !== "rejected" && status !== "replaced" && !batch.replaced_by_batch_id;
    });
    const activeBatchIds = activeBatches.map((batch) => String(batch.id)).filter(Boolean);
    if (activeBatchIds.length === 0) return empty;

    const records = await readAllRows<Record<string, unknown>>(() =>
      supabase
        .from("sales_records")
        .select("batch_id,line,month,year,product,sales_value,target_value,validation_state")
        .in("batch_id", activeBatchIds),
    );
    const activeBatchMap = new Map(activeBatches.map((batch) => [String(batch.id), batch] as const));
    const latestBatchByRecordPeriod = new Map<string, Record<string, unknown>>();

    records.forEach((record) => {
      const batch = activeBatchMap.get(String(record.batch_id));
      if (!batch || record.validation_state === "failed") return;
      const key = `${String(batch.line || record.line)}::${safeNumber(record.year)}::${safeNumber(record.month)}`;
      const current = latestBatchByRecordPeriod.get(key);
      if (!current || salesBatchSortValue(batch) > salesBatchSortValue(current)) {
        latestBatchByRecordPeriod.set(key, batch);
      }
    });

    const approvedRecords = records.filter((record) => {
      const batch = activeBatchMap.get(String(record.batch_id));
      if (!batch || record.validation_state === "failed") return false;
      const key = `${String(batch.line || record.line)}::${safeNumber(record.year)}::${safeNumber(record.month)}`;
      return latestBatchByRecordPeriod.get(key)?.id === batch.id;
    });
    const salesValue = approvedRecords.reduce((sum, row) => sum + safeNumber(row.sales_value), 0);
    const targetValue = approvedRecords.reduce((sum, row) => sum + safeNumber(row.target_value), 0);

    return {
      achievementRate: targetValue > 0 ? salesValue / targetValue : 0,
      activeProducts: new Set(approvedRecords.map((row) => String(row.product ?? "")).filter(Boolean)).size,
      error: null,
      salesValue,
      targetValue,
    };
  } catch {
    return { ...empty, error: "Sales data unavailable." };
  }
}

async function fetchExpenseSummary(): Promise<{
  approvedAmount: number;
  totalAmount: number;
  totalRows: number;
  reportCount: number;
  error: string | null;
}> {
  const supabase = getSupabaseAdmin();
  const empty = { approvedAmount: 0, totalAmount: 0, totalRows: 0, reportCount: 0, error: null };

  try {
    // Fetch a capped set of expense rows — total and approved amounts
    const { data: rows, error: rowErr } = await supabase
      .from("payroll_expenses")
      .select("total,hr_approved")
      .limit(5000);
    if (rowErr) throw rowErr;

    const expenseRows = rows ?? [];
    const totalAmount = expenseRows.reduce((s, r) => s + safeNumber(r.total), 0);
    const approvedAmount = expenseRows
      .filter((r) => r.hr_approved)
      .reduce((s, r) => s + safeNumber(r.total), 0);

    // Count expense reports separately
    const { count: reportCount, error: reportErr } = await supabase
      .from("payroll_expense_reports")
      .select("*", { count: "exact", head: true });
    if (reportErr) throw reportErr;

    return {
      approvedAmount,
      totalAmount,
      totalRows: expenseRows.length,
      reportCount: reportCount ?? 0,
      error: null,
    };
  } catch {
    return { ...empty, error: "Expense data unavailable." };
  }
}

async function fetchRecruitmentSummary(): Promise<{
  totalOffers: number;
  pendingOffers: number;
  acceptedOffers: number;
  rejectedOffers: number;
  acceptanceRate: number;
  error: string | null;
}> {
  const supabase = getSupabaseAdmin();
  const empty = {
    totalOffers: 0,
    pendingOffers: 0,
    acceptedOffers: 0,
    rejectedOffers: 0,
    acceptanceRate: 0,
    error: null,
  };

  try {
    const { data: rows, error } = await supabase
      .from("job_offers")
      .select("status")
      .limit(5000);
    if (error) throw error;

    const offers = rows ?? [];
    const totalOffers = offers.length;
    const acceptedOffers = offers.filter((r) => r.status === "accepted").length;
    const rejectedOffers = offers.filter((r) => r.status === "rejected").length;
    const pendingOffers = offers.filter((r) => r.status === "sent" || r.status === "pending").length;
    const finalised = acceptedOffers + rejectedOffers;
    const acceptanceRate = finalised > 0 ? acceptedOffers / finalised : 0;

    return { totalOffers, pendingOffers, acceptedOffers, rejectedOffers, acceptanceRate, error: null };
  } catch {
    return { ...empty, error: "Recruitment data unavailable." };
  }
}

async function fetchRiskSummary(): Promise<{
  expiringContracts: number;
  probationEndings: number;
  error: string | null;
}> {
  const supabase = getSupabaseAdmin();
  const empty = { expiringContracts: 0, probationEndings: 0, error: null };

  try {
    const now = new Date();
    const in30Days = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const in15Days = new Date(now.getTime() + 15 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const today = now.toISOString().slice(0, 10);

    const [contractResult, probationResult] = await Promise.all([
      supabase
        .from("employee_contracts")
        .select("id", { count: "exact", head: true })
        .gt("contract_renewal_date", today)
        .lte("contract_renewal_date", in30Days),
      supabase
        .from("employee_probation")
        .select("id", { count: "exact", head: true })
        .gt("probation_end_date", today)
        .lte("probation_end_date", in15Days),
    ]);

    return {
      expiringContracts: contractResult.count ?? 0,
      probationEndings: probationResult.count ?? 0,
      error: null,
    };
  } catch {
    return { ...empty, error: "Risk data unavailable." };
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function getAdminCommandCenterData(accessContext: AccessContext): Promise<AdminCommandCenterData> {
  const dataUnavailable: string[] = [];

  // Run all fetches in parallel — each is isolated so a single failure doesn't cascade
  const [payrollResult, salesResult, employeesResult, expensesResult, recruitmentResult, riskResult, salesHealthResult, eligibleResult] =
    await Promise.allSettled([
      canUseCompanyPayrollSummary(accessContext)
        ? fetchPayrollSummary()
        : fetchScopedPayrollSummary(accessContext),
      fetchSalesSummary(),
      getEmployeeDirectory(),
      fetchExpenseSummary(),
      fetchRecruitmentSummary(),
      fetchRiskSummary(),
      fetchSalesHealthCounts(),
      fetchPayrollEligibleCount(),
    ]);

  // ── Payroll ──────────────────────────────────────────────────────────────
  let payroll: AdminCommandCenterData["overview"]["payroll"] = {
    batchLabel: "—",
    employees: 0,
    gross: 0,
    net: 0,
    flags: 0,
  };
  if (payrollResult.status === "fulfilled") {
    const p = payrollResult.value;
    if (p.error) dataUnavailable.push(p.error);
    payroll = {
      batchLabel: p.batch ? `${p.batch.month}/${p.batch.year}` : "—",
      employees: p.employees,
      gross: p.gross,
      net: p.net,
      flags: p.flags,
    };
  } else {
    dataUnavailable.push("Payroll data unavailable.");
  }

  // ── Sales ────────────────────────────────────────────────────────────────
  let sales: AdminCommandCenterData["overview"]["sales"] = {
    salesValue: 0,
    targetValue: 0,
    achievementRate: 0,
    activeProducts: 0,
  };
  if (salesResult.status === "fulfilled") {
    const s = salesResult.value;
    if (s.error) dataUnavailable.push(s.error);
    sales = {
      salesValue: s.salesValue,
      targetValue: s.targetValue,
      achievementRate: s.achievementRate,
      activeProducts: s.activeProducts,
    };
  } else {
    dataUnavailable.push("Sales data unavailable.");
  }

  // ── HR / Employees ───────────────────────────────────────────────────────
  let hr: AdminCommandCenterData["overview"]["hr"] = {
    activeEmployees: 0,
    totalEmployees: 0,
    uniqueLines: 0,
    uniqueAreas: 0,
    employeesWithoutManagers: 0,
  };
  if (employeesResult.status === "fulfilled") {
    const e = employeesResult.value.summary;
    hr = {
      activeEmployees: e.activeEmployees,
      totalEmployees: e.totalEmployees,
      uniqueLines: e.uniqueLines,
      uniqueAreas: e.uniqueAreas,
      employeesWithoutManagers: e.employeesWithoutManagers,
    };
  } else {
    dataUnavailable.push("Employee directory unavailable.");
  }

  // ── Expenses ─────────────────────────────────────────────────────────────
  let expenses: AdminCommandCenterData["overview"]["expenses"] = {
    approvedAmount: 0,
    totalAmount: 0,
    totalRows: 0,
    reportCount: 0,
  };
  if (expensesResult.status === "fulfilled") {
    const ex = expensesResult.value;
    if (ex.error) dataUnavailable.push(ex.error);
    else expenses = { approvedAmount: ex.approvedAmount, totalAmount: ex.totalAmount, totalRows: ex.totalRows, reportCount: ex.reportCount };
  } else {
    dataUnavailable.push("Expense data unavailable.");
  }

  // ── Recruitment ──────────────────────────────────────────────────────────
  let recruitment: AdminCommandCenterData["overview"]["recruitment"] = {
    totalOffers: 0,
    pendingOffers: 0,
    acceptedOffers: 0,
    rejectedOffers: 0,
    acceptanceRate: 0,
  };
  if (recruitmentResult.status === "fulfilled") {
    const r = recruitmentResult.value;
    if (r.error) dataUnavailable.push(r.error);
    else recruitment = { totalOffers: r.totalOffers, pendingOffers: r.pendingOffers, acceptedOffers: r.acceptedOffers, rejectedOffers: r.rejectedOffers, acceptanceRate: r.acceptanceRate };
  } else {
    dataUnavailable.push("Recruitment data unavailable.");
  }

  // ── Risk ─────────────────────────────────────────────────────────────────
  let risk: AdminCommandCenterData["overview"]["risk"] = {
    expiringContracts: 0,
    probationEndings: 0,
  };
  if (riskResult.status === "fulfilled") {
    const rv = riskResult.value;
    if (rv.error) dataUnavailable.push(rv.error);
    else risk = { expiringContracts: rv.expiringContracts, probationEndings: rv.probationEndings };
  } else {
    dataUnavailable.push("Risk data unavailable.");
  }

  // ── Health ───────────────────────────────────────────────────────────────
  const salesHealth = salesHealthResult.status === "fulfilled"
    ? salesHealthResult.value
    : { error: "Sales linkage data unavailable.", linkedRows: 0, totalRows: 0 };
  if (salesHealth.error) dataUnavailable.push(salesHealth.error);
  const health = buildDataHealth(
    employeesResult.status === "fulfilled" ? employeesResult.value : null,
    salesHealth,
  );

  // ── Payroll eligible count ────────────────────────────────────────────────
  const payrollEligibleCount =
    eligibleResult.status === "fulfilled" ? eligibleResult.value.count : 0;
  if (eligibleResult.status === "fulfilled" && eligibleResult.value.error) {
    dataUnavailable.push(eligibleResult.value.error);
  } else if (eligibleResult.status === "rejected") {
    dataUnavailable.push("Payroll eligible count unavailable.");
  }

  return {
    overview: { hr, payroll, sales, expenses, recruitment, risk },
    health,
    payrollEligibleCount,
    dataUnavailable,
  };
}

