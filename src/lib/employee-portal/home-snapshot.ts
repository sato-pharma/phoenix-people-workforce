import { normalizeHrId, type AccessContext } from "@/lib/auth/permissions";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { devSafePromiseAllSettled } from "@/lib/utils/dev-safe-promise-all";
import { getVacationBalancePeriod } from "@/lib/vacation/calculations";
import { getEmployeePortalShellData, type EmployeePortalShellData } from "@/lib/employee-portal/service";

export type PortalHomeSnapshot = {
  shell: EmployeePortalShellData;
  role: string;
  pendingVacationCount: number;
  pendingExcuseCount: number;
  latestPayslip: { month: string; netSalary: number } | null;
  leaveEntitlementDays: number | null;
  mrSalesAchievement: { achievementPercent: number; salesValue: number; targetValue: number } | null;
  monthlySalesTrend: Array<{ year: number; month: number; achievementPercent: number; salesValue: number; targetValue: number }> | null;
  doubleVisitPulse: { daysSinceLastDv: number | null; dvsThisMonth: number; dvsLast90Days: number } | null;
  mrPendingExpenseCount: number | null;
};

const wrapPromise = <T,>(thenable: PromiseLike<T>): Promise<T> =>
  new Promise((resolve, reject) => thenable.then(resolve, reject));

export async function getPortalHomeSnapshot(access: AccessContext): Promise<PortalHomeSnapshot> {
  const shell = await getEmployeePortalShellData(access);
  const hrId = normalizeHrId(access.hrId) ?? "";
  const role = access.role ?? "";
  const today = new Date().toISOString().slice(0, 10);
  const supabase = getSupabaseAdmin();
  const isMr = role.toLowerCase() === "medical rep";

  // All three MR-only queries start immediately so they run in parallel with the
  // vacation/excuse/batch block below.
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const mrSalesPromise =
    isMr && hrId
      ? wrapPromise(
          supabase
            .from("v_employee_portal_sales")
            .select("sales_value, target_value")
            .or(`hr_id.eq.${hrId.toUpperCase()},employee_hr_id.eq.${hrId.toUpperCase()}`)
            .eq("year", currentYear)
            .eq("month", currentMonth),
        )
      : Promise.resolve(null);

  // Last 4 months of per-row sales data; aggregated client-side into trend buckets.
  const trendPromise =
    isMr && hrId
      ? wrapPromise(
          supabase
            .from("v_employee_portal_sales")
            .select("year, month, sales_value, target_value")
            .or(`hr_id.eq.${hrId.toUpperCase()},employee_hr_id.eq.${hrId.toUpperCase()}`)
            .order("year", { ascending: false })
            .order("month", { ascending: false })
            .limit(200),
        )
      : Promise.resolve(null);

  // Double-visit rows for this MR — most recent first so [0] is the latest visit.
  const dvPromise =
    isMr && hrId
      ? wrapPromise(
          supabase
            .from("double_visit_rows")
            .select("activity_date")
            .eq("visited_employee_hr_id", hrId.toUpperCase())
            .order("activity_date", { ascending: false })
            .limit(500),
        )
      : Promise.resolve(null);

  // Submitted (pending reimbursement) expense count — lightweight head-only query.
  const expensePromise =
    isMr && hrId
      ? wrapPromise(
          supabase
            .from("outstation_expense_requests")
            .select("id", { count: "exact", head: true })
            .eq("employee_hr_id", hrId.toUpperCase())
            .eq("status", "submitted"),
        )
      : Promise.resolve(null);

  // All three fire in parallel (sequential in dev to protect Turbopack workers).
  const [vacationResult, excuseResult, batchResult] = await devSafePromiseAllSettled([
    () =>
      wrapPromise(
        supabase
          .from("v2_vacation_requests")
          .select("id", { count: "exact", head: true })
          .eq("employee_hr_id", hrId.toUpperCase())
          .in("status", ["pending_manager", "pending_hr"]),
      ),
    () =>
      wrapPromise(
        supabase
          .from("v2_excuse_requests")
          .select("id", { count: "exact", head: true })
          .eq("employee_hr_id", hrId.toUpperCase())
          .eq("status", "pending_manager"),
      ),
    () =>
      wrapPromise(
        supabase
          .from("salary_batches")
          .select("id, year, month")
          .in("status", ["approved", "locked"])
          .order("year", { ascending: false })
          .order("month", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ),
  ]);

  const pendingVacationCount =
    vacationResult.status === "fulfilled" ? (vacationResult.value.count ?? 0) : 0;
  const pendingExcuseCount =
    excuseResult.status === "fulfilled" ? (excuseResult.value.count ?? 0) : 0;

  // One fast lookup: employee's record in the latest batch.
  let latestPayslip: PortalHomeSnapshot["latestPayslip"] = null;
  if (batchResult.status === "fulfilled" && batchResult.value.data && hrId) {
    const batch = batchResult.value.data;
    const { data: record } = await supabase
      .from("salary_records")
      .select("net_salary")
      .eq("batch_id", batch.id)
      .eq("hr_id", hrId.toUpperCase())
      .maybeSingle();
    if (record?.net_salary) {
      latestPayslip = {
        month: `${batch.year}-${String(batch.month).padStart(2, "0")}`,
        netSalary: Number(record.net_salary),
      };
    }
  }

  // Await all four MR promises together (they've been in-flight since the start).
  const [mrSalesResult, trendResult, dvResult, expenseResult] = await Promise.allSettled([
    mrSalesPromise,
    trendPromise,
    dvPromise,
    expensePromise,
  ]);

  // Current-month achievement.
  let mrSalesAchievement: PortalHomeSnapshot["mrSalesAchievement"] = null;
  try {
    const mrData = mrSalesResult.status === "fulfilled" ? mrSalesResult.value : null;
    if (mrData && "data" in mrData && Array.isArray(mrData.data) && mrData.data.length > 0) {
      const rows = mrData.data as Array<{ sales_value?: number | null; target_value?: number | null }>;
      const totalSales = rows.reduce((s, r) => s + Number(r.sales_value ?? 0), 0);
      const totalTarget = rows.reduce((s, r) => s + Number(r.target_value ?? 0), 0);
      mrSalesAchievement = {
        achievementPercent: totalTarget > 0 ? (totalSales / totalTarget) * 100 : 0,
        salesValue: totalSales,
        targetValue: totalTarget,
      };
    }
  } catch {
    // null on failure
  }

  // Last 4 distinct (year, month) buckets — newest first.
  let monthlySalesTrend: PortalHomeSnapshot["monthlySalesTrend"] = null;
  try {
    const trendData = trendResult.status === "fulfilled" ? trendResult.value : null;
    if (trendData && "data" in trendData && Array.isArray(trendData.data)) {
      type TrendRow = { year: number; month: number; sales_value?: number | null; target_value?: number | null };
      const rows = trendData.data as TrendRow[];
      const buckets = new Map<string, { year: number; month: number; salesValue: number; targetValue: number }>();
      for (const row of rows) {
        const key = `${row.year}-${row.month}`;
        const b = buckets.get(key) ?? { year: row.year, month: row.month, salesValue: 0, targetValue: 0 };
        b.salesValue += Number(row.sales_value ?? 0);
        b.targetValue += Number(row.target_value ?? 0);
        buckets.set(key, b);
      }
      monthlySalesTrend = Array.from(buckets.values())
        .sort((a, b) => b.year - a.year || b.month - a.month)
        .slice(0, 4)
        .map((m) => ({
          ...m,
          achievementPercent: m.targetValue > 0 ? Math.round((m.salesValue / m.targetValue) * 100) : 0,
        }));
    }
  } catch {
    // null on failure
  }

  // Double-visit pulse for this MR.
  let doubleVisitPulse: PortalHomeSnapshot["doubleVisitPulse"] = null;
  try {
    const dvData = dvResult.status === "fulfilled" ? dvResult.value : null;
    if (dvData && "data" in dvData && Array.isArray(dvData.data)) {
      const rows = dvData.data as Array<{ activity_date: string }>;
      const thisMonthPrefix = `${currentYear}-${String(currentMonth).padStart(2, "0")}`;
      if (rows.length === 0) {
        doubleVisitPulse = { daysSinceLastDv: null, dvsThisMonth: 0, dvsLast90Days: 0 };
      } else {
        const lastDate = new Date(rows[0].activity_date);
        const daysSinceLastDv = Math.floor((now.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24));
        const dvsThisMonth = rows.filter((r) => r.activity_date.startsWith(thisMonthPrefix)).length;
        const dvsLast90Days = rows.filter((r) => r.activity_date >= ninetyDaysAgo).length;
        doubleVisitPulse = { daysSinceLastDv, dvsThisMonth, dvsLast90Days };
      }
    }
  } catch {
    // null on failure
  }

  // Pending submitted expenses count.
  let mrPendingExpenseCount: PortalHomeSnapshot["mrPendingExpenseCount"] = null;
  try {
    const expData = expenseResult.status === "fulfilled" ? expenseResult.value : null;
    if (expData && "count" in expData && expData.count !== null) {
      mrPendingExpenseCount = expData.count;
    }
  } catch {
    // null on failure
  }

  // Pure calculation — no DB.
  const balance = getVacationBalancePeriod({ hireDate: shell.hrContract.hireDate, referenceDate: today });

  return {
    shell,
    role,
    pendingVacationCount,
    pendingExcuseCount,
    latestPayslip,
    leaveEntitlementDays: balance?.entitlementDays ?? null,
    mrSalesAchievement,
    monthlySalesTrend,
    doubleVisitPulse,
    mrPendingExpenseCount,
  };
}
