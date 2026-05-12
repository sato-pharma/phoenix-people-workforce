import type { AccessContext } from "@/lib/auth/permissions";
import { getDataHealthStats } from "@/lib/admin/service";
import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
import { getPayrollDashboard } from "@/lib/payroll/service";
import { getSalesDashboard } from "@/lib/sales/service";
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

// ---------------------------------------------------------------------------
// Data health queries (uses Supabase JS client — safe)
// ---------------------------------------------------------------------------

async function fetchDataHealth(): Promise<{ health: DataHealthMetrics; errors: string[] }> {
  const errors: string[] = [];
  try {
    const stats = await getDataHealthStats();
    const totalSalesRows = Object.values(stats.salesClassification).reduce((sum, item) => sum + item.records, 0);
    const salesLinkageRate =
      totalSalesRows > 0
        ? ((totalSalesRows - stats.summary.unresolvedSalesExceptions) / totalSalesRows) * 100
        : 100;

    return {
      health: {
        employeeHealthRate: stats.summary.healthRate,
        healthyEmployees: stats.summary.healthyEmployees,
        missingJobTitle: stats.employeeIssues.filter((issue) => issue.health_status === "missing_job_title").length,
        missingManager: stats.employeeIssues.filter((issue) => issue.health_status === "missing_manager").length,
        salesLinkageBatch: null,
        salesLinkageRate,
        totalEmployees: stats.summary.activeEmployees,
      },
      errors,
    };
  } catch {
    errors.push("Classified data health data unavailable.");
    return {
      health: {
        employeeHealthRate: 0,
        healthyEmployees: 0,
        missingJobTitle: 0,
        missingManager: 0,
        salesLinkageBatch: null,
        salesLinkageRate: 0,
        totalEmployees: 0,
      },
      errors,
    };
  }
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
  const [payrollResult, salesResult, employeesResult, expensesResult, recruitmentResult, riskResult, healthResult, eligibleResult] =
    await Promise.allSettled([
      getPayrollDashboard(undefined, accessContext),
      getSalesDashboard(),
      getEmployeeDirectory(),
      fetchExpenseSummary(),
      fetchRecruitmentSummary(),
      fetchRiskSummary(),
      fetchDataHealth(),
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
    payroll = {
      batchLabel: p.batch ? `${p.batch.month}/${p.batch.year}` : "—",
      employees: p.summary.totalEmployees,
      gross: p.summary.totalGross,
      net: p.summary.totalNet,
      flags: p.flags.length,
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
    const s = salesResult.value.summary as Record<string, unknown>;
    sales = {
      salesValue: safeNumber(s.totalApprovedSales),
      targetValue: safeNumber(s.totalApprovedTarget),
      achievementRate: safeNumber(s.achievementRate),
      activeProducts: safeNumber(s.activeProducts),
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
  const health =
    healthResult.status === "fulfilled"
      ? healthResult.value.health
      : buildEmptyHealth();
  if (healthResult.status === "fulfilled") {
    dataUnavailable.push(...healthResult.value.errors);
  } else {
    dataUnavailable.push("Health data unavailable.");
  }

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

// ---------------------------------------------------------------------------
// Empty fallbacks
// ---------------------------------------------------------------------------

function buildEmptyHealth(): DataHealthMetrics {
  return {
    employeeHealthRate: 0,
    healthyEmployees: 0,
    totalEmployees: 0,
    missingManager: 0,
    missingJobTitle: 0,
    salesLinkageRate: 0,
    salesLinkageBatch: null,
  };
}
