import { getOfferDashboard } from "@/lib/offers/service";
import { getPayrollDashboard } from "@/lib/payroll/service";
import { listPayrollExpenseReports, listPayrollExpenses } from "@/lib/payroll/expenses";
import { getSalesDashboard } from "@/lib/sales/service";
import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
import {
  canAccess,
  filterEmployeeDirectoryForAccess,
  type AccessContext,
} from "@/lib/auth/permissions";

export type OverviewDashboardData = {
  expenses: {
    approvedAmount: number;
    reportCount: number;
    totalAmount: number;
    totalRows: number;
    trend: Array<{ period: string; amount: number }>;
    breakdown: Array<{ name: string; val: number; breakdown: string }>;
  };
  hr: {
    activeEmployees: number;
    employeeHealthRate: number;
    employeesWithoutManagers: number;
    totalEmployees: number;
    uniqueAreas: number;
    uniqueLines: number;
    statusDistribution: Array<{ name: string; value: number; color: string; percent: number }>;
    hireExitTrend: Array<{ m: string; h: number; e: number }>;
  };
  payroll: {
    additions: number;
    batchLabel: string;
    employees: number;
    flags: number;
    gross: number;
    governmentDeductions: number;
    net: number;
    readinessRate: number;
    distribution: Array<{ name: string; value: number; color: string; percent: number }>;
  };
  sales: {
    achievementRate: number;
    activeProducts: number;
    dataQualityRate: number;
    salesValue: number;
    targetValue: number;
    trend: Array<{ period: string; sales: number; target: number }>;
    distribution: Array<{ name: string; value: number; color: string; percent: number }>;
  };
  recruitment: {
    acceptanceRate: number;
    totalOffers: number;
    pendingOffers: number;
    acceptedOffers: number;
    rejectedOffers: number;
    pipeline: Array<{ name: string; value: number; color: string }>;
  };
  risk: {
    expiringContracts: number;
    probationEndings: number;
    alerts: Array<{ type: "contract" | "probation"; name: string; date: string; days: number }>;
  };
  financial: {
    revenue: number;
    peopleCost: number;
    grossMargin: number;
    trend: Array<{ month: string; revenue: number; cost: number }>;
  };
  activity: {
    recent: Array<{ 
      description: string; 
      details?: string; 
      module: string; 
      status: string; 
      timestamp: string; 
      userName: string; 
    }>;
  };
  vacancies: {
    openVacancies: number;
  };
};

type OverviewContractRow = {
  contract_renewal_date?: string | null;
  full_name?: string | null;
};

type OverviewProbationRow = {
  days_remaining?: number | null;
  full_name?: string | null;
  probation_end_date?: string | null;
};

type OverviewSalaryBatchActivityRow = {
  approved_at?: string | null;
  approved_by?: string | null;
  created_at?: string | null;
  month?: number | null;
  status?: string | null;
  updated_at?: string | null;
  uploaded_by?: string | null;
  year?: number | null;
};

type OverviewSalesAuditRow = {
  action?: string | null;
  actor_display_name?: string | null;
  actor_username?: string | null;
  created_at?: string | null;
  line?: string | null;
  period?: string | null;
};

type OverviewOfferAuditRow = {
  action?: string | null;
  actor_reference?: string | null;
  actor_type?: string | null;
  created_at?: string | null;
  details?: Record<string, unknown> | null;
};

const databaseQueryTimeoutMs = 8000;

function getRequiredEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function supabaseRest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const url = getRequiredEnv("NEXT_PUBLIC_SUPABASE_URL").replace(/\/+$/g, "");
  const serviceRoleKey = getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), databaseQueryTimeoutMs);

  try {
    const response = await fetch(`${url}/rest/v1/${path}`, {
      ...init,
      cache: "no-store",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
      signal: controller.signal,
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : null;

    if (!response.ok) {
      throw new Error(
        typeof payload?.message === "string"
          ? payload.message
          : `Supabase request failed with ${response.status}.`,
      );
    }

    return payload as T;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Supabase request timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function sum<T>(items: T[], fn: (item: T) => number) {
  return items.reduce((acc, item) => acc + (fn(item) || 0), 0);
}

function isValidDate(date: unknown): boolean {
  if (!date) return false;
  if (!(typeof date === "string" || typeof date === "number" || date instanceof Date)) {
    return false;
  }
  const d = new Date(date);
  return d instanceof Date && !isNaN(d.getTime());
}

function daysBetween(date1: Date, date2: Date): number {
  const diffTime = date1.getTime() - date2.getTime();
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}

function isWithinFutureDays(date: string | Date, days: number): boolean {
  if (!isValidDate(date)) return false;
  const now = new Date();
  const targetDate = new Date(date);
  const diff = daysBetween(targetDate, now);
  return diff > 0 && diff <= days;
}

function monthKey(dateStr: string) {
  const date = new Date(dateStr);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function asNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function asString(value: unknown) {
  return typeof value === "string" ? value : String(value ?? "");
}

function periodKeyFromMonthYear(month: number, year: number) {
  return `${year}-${String(month).padStart(2, "0")}`;
}

function periodLabel(period: string) {
  const [year, month] = period.split("-");
  const date = new Date(Number(year), Math.max(Number(month) - 1, 0), 1);
  return date.toLocaleString("en-US", { month: "short" });
}

function expensePeriodKey(row: { payoutMonth: number; payoutYear: number; date: string }) {
  if (row.payoutMonth && row.payoutYear) {
    return periodKeyFromMonthYear(row.payoutMonth, row.payoutYear);
  }
  return monthKey(row.date);
}

function payrollActivityDescription(row: OverviewSalaryBatchActivityRow) {
  const period = row.month && row.year ? `${row.month}/${row.year}` : "the selected period";
  if (row.status === "approved") return `Payroll approved for ${period}`;
  if (row.status === "locked") return `Payroll locked for ${period}`;
  if (row.status === "rejected") return `Payroll rejected for ${period}`;
  return `Payroll uploaded for ${period}`;
}

function salesActivityDescription(row: OverviewSalesAuditRow) {
  switch (row.action) {
    case "import.approved":
      return `Sales batch approved for ${row.period ?? "the selected period"}`;
    case "import.rejected":
      return `Sales batch rejected for ${row.period ?? "the selected period"}`;
    case "import.replaced":
      return `Sales batch replaced for ${row.period ?? "the selected period"}`;
    case "import.deleted":
      return `Sales batch deleted for ${row.period ?? "the selected period"}`;
    default:
      return `Sales activity recorded for ${row.period ?? row.line ?? "the selected scope"}`;
  }
}

function offerActivityDescription(row: OverviewOfferAuditRow) {
  switch (row.action) {
    case "offer_sent":
      return "Job offer sent";
    case "offer_accepted":
      return "Job offer accepted";
    case "offer_rejected":
      return "Job offer rejected";
    case "offer_expired":
    case "offer_expired_on_click":
      return "Job offer expired";
    default:
      return "Offer activity recorded";
  }
}

export async function getOverviewDashboard(
  accessContext: AccessContext,
): Promise<OverviewDashboardData> {
  const [
    canReadEmployees,
    canReadExpenses,
    canReadOffers,
    canReadPayroll,
    canReadSales,
    canReadVacancies,
    canReadContracts,
    canReadProbation,
  ] = await Promise.all([
    canAccess(accessContext, "employees", "read"),
    canAccess(accessContext, "expenses", "read"),
    canAccess(accessContext, "offers", "read"),
    canAccess(accessContext, "payroll", "read"),
    canAccess(accessContext, "sales", "read"),
    canAccess(accessContext, "vacancies", "read"),
    canAccess(accessContext, "contracts", "read"),
    canAccess(accessContext, "probation", "read"),
  ]);

  const [
    payroll,
    sales,
    employees,
    expenses,
    expenseReports,
    offersData,
    contracts,
    probations,
    salaryBatchActivity,
    salesAuditActivity,
    offerAuditActivity,
  ] = await Promise.all([
    canReadPayroll ? getPayrollDashboard(undefined, accessContext) : Promise.resolve(null),
    canReadSales ? getSalesDashboard({}, accessContext) : Promise.resolve(null),
    canReadEmployees
      ? getEmployeeDirectory().then((directory) => filterEmployeeDirectoryForAccess(directory, accessContext))
      : Promise.resolve(null),
    canReadExpenses
      ? listPayrollExpenses(undefined, undefined, undefined, accessContext)
      : Promise.resolve([]),
    canReadExpenses
      ? listPayrollExpenseReports(accessContext)
      : Promise.resolve([]),
    canReadOffers ? getOfferDashboard() : Promise.resolve(null),
    canReadContracts
      ? supabaseRest<OverviewContractRow[]>("v_lifecycle_dashboard").catch(() => [])
      : Promise.resolve([]),
    canReadProbation
      ? supabaseRest<OverviewProbationRow[]>("v_probation_tracker").catch(() => [])
      : Promise.resolve([]),
    canReadPayroll
      ? supabaseRest<OverviewSalaryBatchActivityRow[]>(
          `salary_batches?${new URLSearchParams({
            order: "updated_at.desc",
            select: "month,year,status,uploaded_by,approved_by,approved_at,created_at,updated_at",
          })}`,
        ).catch(() => [])
      : Promise.resolve([]),
    canReadSales
      ? supabaseRest<OverviewSalesAuditRow[]>(
          `sales_audit_logs?${new URLSearchParams({
            limit: "5",
            order: "created_at.desc",
            select: "action,actor_username,actor_display_name,line,period,created_at",
          })}`,
        ).catch(() => [])
      : Promise.resolve([]),
    canReadOffers
      ? supabaseRest<OverviewOfferAuditRow[]>(
          `job_offer_audit_logs?${new URLSearchParams({
            limit: "5",
            order: "created_at.desc",
            select: "action,actor_type,actor_reference,details,created_at",
          })}`,
        ).catch(() => [])
      : Promise.resolve([]),
  ]);

  const payrollRecords = payroll?.records ?? [];
  const expenseRows = Array.isArray(expenses) ? expenses : [];
  const salesSummary = sales?.summary ?? {};
  const salesLinePerformance = Array.isArray(sales?.linePerformance)
    ? (sales.linePerformance as Array<Record<string, unknown>>)
    : [];
  const salesTrend = Array.isArray(sales?.trend)
    ? (sales.trend as Array<Record<string, unknown>>)
    : [];
  const activeEmployees = employees?.summary.activeEmployees ?? 0;
  const totalEmployees = employees?.summary.totalEmployees ?? 0;
  const totalExpenses = sum(expenseRows, (row) => row.total);
  const approvedExpenses = sum(expenseRows.filter((row) => row.hrApproved), (row) => row.total);
  
  const statusDistribution = Array.from(
    (employees?.employees ?? []).reduce((map, emp) => {
      const status = emp.employmentStatus || "Unknown";
      map.set(status, (map.get(status) || 0) + 1);
      return map;
    }, new Map<string, number>())
  ).map(([name, value]) => ({
    name,
    value,
    percent: totalEmployees ? Math.round((value / totalEmployees) * 100) : 0,
    color: name === "Active" ? "#10B981" : name === "On Leave" ? "#3B82F6" : name === "Probation" ? "#F97316" : "#EF4444"
  }));

  const payrollByDept = Array.from(
    payrollRecords.reduce((map, row) => {
      const key = row.line || "Unassigned";
      map.set(key, (map.get(key) || 0) + row.netSalary);
      return map;
    }, new Map<string, number>())
  )
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value);

  const totalPayrollValue = sum(payrollByDept, (d) => d.value);
  const payrollDistribution = payrollByDept.slice(0, 5).map((d, i) => ({
    ...d,
    percent: totalPayrollValue ? Number(((d.value / totalPayrollValue) * 100).toFixed(1)) : 0,
    color: ["#F97316", "#3B82F6", "#10B981", "#EF4444", "#94A3B8"][i] || "#94A3B8"
  }));

  const expenseBreakdown = Array.from(
    expenseRows.reduce((map, row) => {
      const category = row.requestType || row.tripType || "Others";
      map.set(category, (map.get(category) || 0) + row.total);
      return map;
    }, new Map<string, number>())
  )
    .map(([name, val]) => ({ 
      name, 
      val,
      breakdown: `Total for ${name}`
    }))
    .sort((a, b) => b.val - a.val)
    .slice(0, 5);

  const salesByProduct = salesLinePerformance.slice(0, 4).map((lp, i) => ({
    name: asString(lp.line) || `Product ${String.fromCharCode(65 + i)}`,
    value: asNumber(lp.salesValue),
    percent: lp.achievementRate ? Math.round(asNumber(lp.achievementRate) * 100) : 0,
    color: ["#F97316", "#3B82F6", "#10B981", "#8B5CF6"][i] || "#94A3B8"
  }));

  const totalSalesValue = sum(salesByProduct, (s) => s.value);
  const salesDistribution = salesByProduct.map((s) => ({
    ...s,
    percent: totalSalesValue ? Number(((s.value / totalSalesValue) * 100).toFixed(1)) : 0
  }));

  const hireExitTrend = Array.from(
    (employees?.employees ?? []).reduce((map, emp) => {
      if (emp.hireDate) {
        const key = monthKey(emp.hireDate);
        const current = map.get(key) ?? { m: key, h: 0, e: 0 };
        current.h += 1;
        map.set(key, current);
      }
      if (emp.employmentStatus === "Inactive" && emp.updatedAt) {
        const key = monthKey(emp.updatedAt);
        const current = map.get(key) ?? { m: key, h: 0, e: 0 };
        current.e += 1;
        map.set(key, current);
      }
      return map;
    }, new Map<string, { m: string; h: number; e: number }>())
  )
    .map(([, row]) => ({
      ...row,
      m: row.m.split("-")[1] === "01" ? "Jan" : row.m.split("-")[1] === "02" ? "Feb" : row.m.split("-")[1] === "03" ? "Mar" : row.m.split("-")[1] === "04" ? "Apr" : row.m.split("-")[1] === "05" ? "May" : row.m.split("-")[1] === "06" ? "Jun" : row.m.split("-")[1] === "07" ? "Jul" : row.m.split("-")[1] === "08" ? "Aug" : row.m.split("-")[1] === "09" ? "Sep" : row.m.split("-")[1] === "10" ? "Oct" : row.m.split("-")[1] === "11" ? "Nov" : "Dec"
    }))
    .sort((a, b) => a.m.localeCompare(b.m))
    .slice(-6);

  const expenseTrend = Array.from(
    expenseRows.reduce((map, row) => {
      if (row.date) {
        const key = expensePeriodKey(row);
        map.set(key, (map.get(key) || 0) + row.total);
      }
      return map;
    }, new Map<string, number>())
  )
    .map(([period, amount]) => ({ period, amount }))
    .sort((a, b) => a.period.localeCompare(b.period))
    .slice(-6);

  const totalRevenue = Number(salesSummary.totalApprovedSales ?? 0);
  const latestPayrollPeriod = payroll?.batch
    ? periodKeyFromMonthYear(payroll.batch.month, payroll.batch.year)
    : null;
  const currentPeriodExpenses = latestPayrollPeriod
    ? expenseRows
        .filter((row) => expensePeriodKey(row) === latestPayrollPeriod)
        .reduce((total, row) => total + row.total, 0)
    : 0;
  const peopleCost = (payroll?.summary.totalNet ?? 0) + currentPeriodExpenses;

  const visiblePayrollBatches = (payroll?.batches ?? []).slice(0, 6);
  const payrollTrendDashboards = await Promise.all(
    visiblePayrollBatches.map((batch) =>
      payroll?.batch?.id === batch.id ? payroll : getPayrollDashboard(batch.id, accessContext),
    ),
  );

  const payrollCostByPeriod = new Map<string, number>();
  payrollTrendDashboards.forEach((dashboard) => {
    if (!dashboard.batch) return;
    payrollCostByPeriod.set(
      periodKeyFromMonthYear(dashboard.batch.month, dashboard.batch.year),
      dashboard.summary.totalNet,
    );
  });

  const revenueByPeriod = new Map<string, number>();
  salesTrend.forEach((row) => {
    revenueByPeriod.set(asString(row.period), asNumber(row.sales));
  });

  const expenseCostByPeriod = new Map<string, number>();
  expenseRows.forEach((row) => {
    if (!row.date) return;
    const key = expensePeriodKey(row);
    expenseCostByPeriod.set(key, (expenseCostByPeriod.get(key) ?? 0) + row.total);
  });

  const financialPeriods = Array.from(
    new Set([
      ...Array.from(revenueByPeriod.keys()),
      ...Array.from(payrollCostByPeriod.keys()),
      ...Array.from(expenseCostByPeriod.keys()),
    ]),
  )
    .sort((a, b) => a.localeCompare(b))
    .slice(-6);

  const financialTrend = financialPeriods.map((period) => ({
    month: periodLabel(period),
    revenue: revenueByPeriod.get(period) ?? 0,
    cost: (payrollCostByPeriod.get(period) ?? 0) + (expenseCostByPeriod.get(period) ?? 0),
  }));

  // Risk calculation
  const now = new Date();
  const riskAlerts: OverviewDashboardData["risk"]["alerts"] = [];
  
  (contracts || []).forEach((c) => {
    const renewalDateValue = c.contract_renewal_date ?? null;
    if (renewalDateValue && isWithinFutureDays(renewalDateValue, 30)) {
      const renewalDate = new Date(renewalDateValue);
      riskAlerts.push({
        type: "contract",
        name: c.full_name ?? "Unknown employee",
        date: renewalDateValue,
        days: daysBetween(renewalDate, now)
      });
    }
  });

  (probations || []).forEach((p) => {
    const probationEndDateValue = p.probation_end_date ?? null;
    if (probationEndDateValue && isWithinFutureDays(probationEndDateValue, 30)) {
      const endDate = new Date(probationEndDateValue);
      riskAlerts.push({
        type: "probation",
        name: p.full_name ?? "Unknown employee",
        date: probationEndDateValue,
        days: typeof p.days_remaining === 'number' ? p.days_remaining : daysBetween(endDate, now)
      });
    }
  });

  const openVacancies = canReadVacancies
    ? (
        await supabaseRest<Array<{ id: number }>>(
          `position_vacancies?${new URLSearchParams({ select: "id", status: "eq.open" })}`,
        ).catch(() => [])
      ).length
    : 0;

  const recentActivity = [
    ...salaryBatchActivity.slice(0, 3).map((row) => ({
      description: payrollActivityDescription(row),
      module: "Payroll",
      status: asString(row.status ?? "uploaded"),
      timestamp: asString(row.updated_at ?? row.created_at ?? new Date().toISOString()),
      userName: asString(row.approved_by ?? row.uploaded_by ?? "system"),
    })),
    ...salesAuditActivity.slice(0, 3).map((row) => ({
      description: salesActivityDescription(row),
      module: "Sales",
      status: asString(row.action ?? "recorded").replace(/^import\./, ""),
      timestamp: asString(row.created_at ?? new Date().toISOString()),
      userName: asString(row.actor_display_name ?? row.actor_username ?? "system"),
    })),
    ...offerAuditActivity.slice(0, 3).map((row) => ({
      description: offerActivityDescription(row),
      module: "Recruitment",
      status: asString(row.action ?? "recorded").replace(/^offer_/, ""),
      timestamp: asString(row.created_at ?? new Date().toISOString()),
      userName: asString(row.actor_reference ?? row.actor_type ?? "system"),
    })),
  ]
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
    .slice(0, 5);

  return {
    expenses: {
      approvedAmount: approvedExpenses,
      reportCount: Array.isArray(expenseReports) ? expenseReports.length : 0,
      totalAmount: totalExpenses,
      totalRows: expenseRows.length,
      trend: expenseTrend,
      breakdown: expenseBreakdown,
    },
    hr: {
      activeEmployees,
      employeeHealthRate: totalEmployees ? activeEmployees / totalEmployees : 1,
      employeesWithoutManagers: employees?.summary.employeesWithoutManagers ?? 0,
      totalEmployees,
      uniqueAreas: employees?.summary.uniqueAreas ?? 0,
      uniqueLines: employees?.summary.uniqueLines ?? 0,
      statusDistribution,
      hireExitTrend,
    },
    payroll: {
      additions: payroll?.summary.totalAdditions ?? 0,
      batchLabel: payroll?.batch ? `${payroll.batch.month}/${payroll.batch.year}` : "No batch",
      employees: payroll?.summary.totalEmployees ?? 0,
      flags: payroll?.flags.length ?? 0,
      gross: payroll?.summary.totalGross ?? 0,
      governmentDeductions: payroll?.summary.totalGovernmentDeductions ?? 0,
      net: payroll?.summary.totalNet ?? 0,
      readinessRate: payroll?.summary.readinessRate ?? 1,
      distribution: payrollDistribution,
    },
    sales: {
      achievementRate: Number(salesSummary.achievementRate ?? 0),
      activeProducts: Number(salesSummary.activeProducts ?? 0),
      dataQualityRate: Number(salesSummary.dataQualityRate ?? 1),
      salesValue: totalRevenue,
      targetValue: Number(salesSummary.totalApprovedTarget ?? 0),
      trend: salesTrend.map((row) => ({
        period: asString(row.period),
        sales: asNumber(row.sales),
        target: asNumber(row.target),
      })),
      distribution: salesDistribution,
    },
    recruitment: {
      acceptanceRate: offersData?.summary.acceptanceRate ?? 0,
      totalOffers: offersData?.summary.totalOffers ?? 0,
      pendingOffers: offersData?.summary.pendingOffers ?? 0,
      acceptedOffers: offersData?.summary.acceptedOffers ?? 0,
      rejectedOffers: offersData?.summary.rejectedOffers ?? 0,
      pipeline: [
        { name: "Accepted", value: offersData?.summary.acceptedOffers ?? 0, color: "#10B981" },
        { name: "Pending", value: offersData?.summary.pendingOffers ?? 0, color: "#3B82F6" },
        { name: "Rejected", value: offersData?.summary.rejectedOffers ?? 0, color: "#EF4444" },
      ]
    },
    risk: {
      expiringContracts: riskAlerts.filter(a => a.type === "contract").length,
      probationEndings: riskAlerts.filter(a => a.type === "probation").length,
      alerts: riskAlerts.sort((a, b) => a.days - b.days),
    },
    financial: {
      revenue: totalRevenue,
      peopleCost: peopleCost,
      grossMargin: totalRevenue ? (totalRevenue - peopleCost) / totalRevenue : 0,
      trend: financialTrend,
    },
    activity: {
      recent: recentActivity,
    },
    vacancies: {
      openVacancies,
    },
  };
}
