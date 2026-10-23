import { getPayrollDashboard } from "@/lib/payroll/service";
import { getPayrollExpenseDashboardData } from "@/lib/outstation/expenses";
import { payrollExpensePeriodKey } from "@/lib/outstation/expense-metrics";
import { getSalesDashboard } from "@/lib/sales/service";
import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
import { getOperationalRecentActivity } from "@/lib/operations/events";
import { getPlatformMetrics, type UncomputedRate } from "@/lib/platform/metrics";
import {
  canAccess,
  filterEmployeeDirectoryForAccess,
  type AccessContext,
} from "@/lib/auth/permissions";

export type OverviewDashboardData = {
  attendance: {
    activeMappings: number;
    activePolicies: number;
    currentMonthWorkingDays: number;
    mappingReadinessRate: UncomputedRate;
    missingDeviceMappings: number;
    policyCoverageRate: UncomputedRate;
    totalDeviceMappings: number;
    totalPolicies: number;
  };
  leave: {
    approvedRequests: number;
    managerDecisionActions: number;
    paidDays: number;
    pendingRequests: number;
    rejectedRequests: number;
    totalRequests: number;
    unpaidDays: number;
  };
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
    employeeHealthRate: UncomputedRate;
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
    readinessRate: UncomputedRate;
    distribution: Array<{ name: string; value: number; color: string; percent: number }>;
  };
  sales: {
    achievementRate: UncomputedRate;
    activeProducts: number;
    dataQualityRate: UncomputedRate;
    salesValue: number;
    targetValue: number;
    trend: Array<{ period: string; sales: number; target: number }>;
    distribution: Array<{ name: string; value: number; color: string; percent: number }>;
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
    /** Activity sources that could not be read — named, so an outage never reads as a quiet day. */
    staleSources: string[];
  };
  vacancies: {
    openVacancies: number;
  };
};

function sum<T>(items: T[], fn: (item: T) => number) {
  return items.reduce((acc, item) => acc + (fn(item) || 0), 0);
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

export async function getOverviewDashboard(
  accessContext: AccessContext,
): Promise<OverviewDashboardData> {
  const [
    canReadEmployees,
    canReadExpenses,
    canReadPayroll,
    canReadSales,
  ] = await Promise.all([
    canAccess(accessContext, "employees", "read"),
    canAccess(accessContext, "expenses", "read"),
    canAccess(accessContext, "payroll", "read"),
    canAccess(accessContext, "sales", "read"),
  ]);

  const [
    platformMetrics,
    payroll,
    sales,
    employees,
    expenseDashboard,
    operationalActivity,
  ] = await Promise.all([
    getPlatformMetrics(accessContext),
    canReadPayroll ? getPayrollDashboard(undefined, accessContext) : Promise.resolve(null),
    canReadSales ? getSalesDashboard({}, accessContext) : Promise.resolve(null),
    canReadEmployees
      ? getEmployeeDirectory().then((directory) => filterEmployeeDirectoryForAccess(directory, accessContext))
      : Promise.resolve(null),
    canReadExpenses
      ? getPayrollExpenseDashboardData(accessContext)
      : Promise.resolve(null),
    getOperationalRecentActivity(accessContext, { limit: 5 }).catch(() => ({
      failureCount24h: 0,
      lastEventAt: null,
      recent: [],
      staleSources: ["Operational activity unavailable."],
      totalEvents24h: 0,
    })),
  ]);

  const payrollRecords = payroll?.records ?? [];
  const expenseRows = expenseDashboard?.expenses ?? [];
  const salesLinePerformance = Array.isArray(sales?.linePerformance)
    ? (sales.linePerformance as Array<Record<string, unknown>>)
    : [];
  const salesTrend = Array.isArray(sales?.trend)
    ? (sales.trend as Array<Record<string, unknown>>)
    : [];
  const totalEmployees = platformMetrics.workforce.totalEmployees;
  
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

  const expenseBreakdown = expenseDashboard?.breakdown ?? [];

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

  const expenseTrend = (expenseDashboard?.trend ?? []).map((row) => ({
    amount: row.amount,
    period: row.period,
  }));

  const totalRevenue = platformMetrics.sales.salesValue;
  const latestPayrollPeriod = payroll?.batch
    ? periodKeyFromMonthYear(payroll.batch.month, payroll.batch.year)
    : null;
  const currentPeriodExpenses = latestPayrollPeriod
    ? expenseRows
        .filter((row) => payrollExpensePeriodKey(row) === latestPayrollPeriod)
        .reduce((total, row) => total + row.total, 0)
    : 0;
  const peopleCost = platformMetrics.payroll.net + currentPeriodExpenses;

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
    const key = payrollExpensePeriodKey(row);
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

  const riskAlerts = platformMetrics.lifecycleRisk.alerts.map((alert) => ({
    date: alert.date,
    days: alert.days,
    name: alert.name,
    type: alert.type,
  }));

  return {
    attendance: {
      activeMappings: platformMetrics.attendance.activeMappings,
      activePolicies: platformMetrics.attendance.activePolicies,
      currentMonthWorkingDays: platformMetrics.attendance.currentMonthWorkingDays,
      mappingReadinessRate: platformMetrics.attendance.mappingReadinessRate,
      missingDeviceMappings: platformMetrics.attendance.missingDeviceMappings,
      policyCoverageRate: platformMetrics.attendance.policyCoverageRate,
      totalDeviceMappings: platformMetrics.attendance.totalDeviceMappings,
      totalPolicies: platformMetrics.attendance.totalPolicies,
    },
    leave: {
      approvedRequests: platformMetrics.leave.approvedRequests,
      managerDecisionActions: platformMetrics.leave.managerDecisionActions,
      paidDays: platformMetrics.leave.paidDays,
      pendingRequests: platformMetrics.leave.pendingRequests,
      rejectedRequests: platformMetrics.leave.rejectedRequests,
      totalRequests: platformMetrics.leave.totalRequests,
      unpaidDays: platformMetrics.leave.unpaidDays,
    },
    expenses: {
      approvedAmount: platformMetrics.expenses.approvedAmount,
      reportCount: platformMetrics.expenses.reportCount,
      totalAmount: platformMetrics.expenses.totalAmount,
      totalRows: platformMetrics.expenses.totalRows,
      trend: expenseTrend,
      breakdown: expenseBreakdown,
    },
    hr: {
      activeEmployees: platformMetrics.workforce.activeEmployees,
      employeeHealthRate: platformMetrics.workforce.employeeHealthRate,
      employeesWithoutManagers: platformMetrics.workforce.employeesWithoutManagers,
      totalEmployees: platformMetrics.workforce.totalEmployees,
      uniqueAreas: platformMetrics.workforce.uniqueAreas,
      uniqueLines: platformMetrics.workforce.uniqueLines,
      statusDistribution,
      hireExitTrend,
    },
    payroll: {
      additions: platformMetrics.payroll.additions,
      batchLabel: platformMetrics.payroll.batchLabel,
      employees: platformMetrics.payroll.employees,
      flags: platformMetrics.payroll.flags,
      gross: platformMetrics.payroll.gross,
      governmentDeductions: platformMetrics.payroll.governmentDeductions,
      net: platformMetrics.payroll.net,
      readinessRate: platformMetrics.payroll.readinessRate,
      distribution: payrollDistribution,
    },
    sales: {
      achievementRate: platformMetrics.sales.achievementRate,
      activeProducts: platformMetrics.sales.activeProducts,
      dataQualityRate: platformMetrics.sales.dataQualityRate,
      salesValue: platformMetrics.sales.salesValue,
      targetValue: platformMetrics.sales.targetValue,
      trend: salesTrend.map((row) => ({
        period: asString(row.period),
        sales: asNumber(row.sales),
        target: asNumber(row.target),
      })),
      distribution: salesDistribution,
    },
    risk: {
      expiringContracts: platformMetrics.lifecycleRisk.expiringContracts,
      probationEndings: platformMetrics.lifecycleRisk.probationEndings,
      alerts: riskAlerts,
    },
    financial: {
      revenue: totalRevenue,
      peopleCost: peopleCost,
      grossMargin: totalRevenue ? (totalRevenue - peopleCost) / totalRevenue : 0,
      trend: financialTrend,
    },
    activity: {
      recent: operationalActivity.recent,
      staleSources: operationalActivity.staleSources,
    },
    vacancies: {
      openVacancies: platformMetrics.workforce.openVacancies,
    },
  };
}
