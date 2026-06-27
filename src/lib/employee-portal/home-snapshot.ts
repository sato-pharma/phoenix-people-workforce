import { normalizeHrId, type AccessContext } from "@/lib/auth/permissions";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { devSafePromiseAllSettled } from "@/lib/utils/dev-safe-promise-all";
import { getVacationBalancePeriod } from "@/lib/vacation/calculations";
import {
  getDsmTeamPerformance,
  getEmployeePortalShellData,
  getNsmDsmPerformance,
  type EmployeePortalShellData,
} from "@/lib/employee-portal/service";
import { approvedMarketingRequestStatuses, getMarketingOverview, type MarketingOverviewMetrics } from "@/lib/marketing-requests/service";
import { getAwaitingMyActionItems } from "@/lib/action-center/service";

export type UpcomingMarketingActivity = { id: string; requestCode: string; payDate: string; estimatedCost: number };

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
  /** Product / Group Product Manager only: the PM's own marketing requests still in flight + upcoming pay dates. */
  pmMarketing: { myPendingRequests: number; upcoming: UpcomingMarketingActivity[] } | null;
  /** Marketing Manager only: company-wide approval/validation pipeline counts + upcoming pay dates (company-wide). */
  mmOverview: (MarketingOverviewMetrics & { upcoming: UpcomingMarketingActivity[] }) | null;
  /** District Manager only: the DSM's own med-rep team, current period, + team approvals awaiting the DSM. */
  dsmTeam:
    | { achievementPercent: number; memberCount: number; totalSales: number; totalTarget: number; pendingApprovals: number }
    | null;
  /** National Sales Manager only: the NSM's line, rolled up by DSM, + approvals awaiting the NSM. */
  nsmNational:
    | { achievementPercent: number; dsmCount: number; totalSales: number; totalTarget: number; pendingApprovals: number }
    | null;
  plansAwaitingManagerApproval: number | null;
};

type RoleSpecificExtras = Pick<PortalHomeSnapshot, "pmMarketing" | "mmOverview" | "dsmTeam" | "nsmNational">;

const emptyRoleExtras: RoleSpecificExtras = {
  pmMarketing: null,
  mmOverview: null,
  dsmTeam: null,
  nsmNational: null,
};

/** Cheap, single-query "what's paying out soon" — real pay_date rows, no recomputation. */
async function getUpcomingMarketingActivity(requesterHrId?: string): Promise<UpcomingMarketingActivity[]> {
  const supabase = getSupabaseAdmin();
  const today = new Date().toISOString().slice(0, 10);
  let query = supabase
    .from("marketing_requests")
    .select("id, request_code, pay_date, estimated_cost")
    .in("status", approvedMarketingRequestStatuses)
    .gte("pay_date", today)
    .order("pay_date", { ascending: true })
    .limit(5);
  if (requesterHrId) {
    query = query.eq("requester_hr_id", requesterHrId.toUpperCase());
  }
  const { data, error } = await query;
  if (error || !data) return [];
  return data
    .filter((row): row is { id: string; request_code: string; pay_date: string; estimated_cost: number } => Boolean(row.pay_date))
    .map((row) => ({
      id: row.id,
      requestCode: row.request_code,
      payDate: row.pay_date,
      estimatedCost: Number(row.estimated_cost ?? 0),
    }));
}

/** One lightweight, role-gated query/aggregate — never throws, never blocks the rest of the snapshot. */
async function getRoleSpecificExtras(access: AccessContext, role: string, hrId: string): Promise<RoleSpecificExtras> {
  try {
    if (role === "Product Manager" || role === "Group Product Manager") {
      if (!hrId) return emptyRoleExtras;
      const supabase = getSupabaseAdmin();
      const [{ count }, upcoming] = await Promise.all([
        supabase
          .from("marketing_requests")
          .select("id", { count: "exact", head: true })
          .eq("requester_hr_id", hrId.toUpperCase())
          .in("status", ["draft", "pending_approval", "returned"]),
        getUpcomingMarketingActivity(hrId),
      ]);
      return { ...emptyRoleExtras, pmMarketing: { myPendingRequests: count ?? 0, upcoming } };
    }
    if (role === "Marketing Manager") {
      const [overview, upcoming] = await Promise.all([getMarketingOverview(access), getUpcomingMarketingActivity()]);
      return { ...emptyRoleExtras, mmOverview: { ...overview, upcoming } };
    }
    if (role === "District Manager") {
      const [team, approvals] = await Promise.all([
        getDsmTeamPerformance(access, {}),
        getAwaitingMyActionItems(access, "portal").catch(() => []),
      ]);
      if (!team) return emptyRoleExtras;
      return {
        ...emptyRoleExtras,
        dsmTeam: {
          achievementPercent: team.teamAchievementPercent,
          memberCount: team.teamMemberCount,
          totalSales: team.teamTotalSales,
          totalTarget: team.teamTotalTarget,
          pendingApprovals: approvals.length,
        },
      };
    }
    if (role === "National Sales Manager") {
      const [national, approvals] = await Promise.all([
        getNsmDsmPerformance(access, {}),
        getAwaitingMyActionItems(access, "portal").catch(() => []),
      ]);
      if (!national) return emptyRoleExtras;
      return {
        ...emptyRoleExtras,
        nsmNational: {
          achievementPercent: national.lineAchievementPercent,
          dsmCount: national.dsmCount,
          totalSales: national.lineTotalSales,
          totalTarget: national.lineTotalTarget,
          pendingApprovals: approvals.length,
        },
      };
    }
  } catch {
    // Non-fatal — the role-specific widget falls back to its own empty state.
  }
  return emptyRoleExtras;
}

// Stats-only snapshot for the MR streaming path (called after the fast shell render)
export type MrHomeStats = {
  pendingVacationCount: number;
  pendingExcuseCount: number;
  latestPayslip: { month: string; netSalary: number } | null;
  leaveEntitlementDays: number | null;
  mrSalesAchievement: { achievementPercent: number; salesValue: number; targetValue: number } | null;
};

export async function getMrHomeStats(
  access: AccessContext,
  shell: EmployeePortalShellData,
): Promise<MrHomeStats> {
  const hrId = normalizeHrId(access.hrId) ?? "";
  const today = new Date().toISOString().slice(0, 10);
  const supabase = getSupabaseAdmin();
  const now = new Date();

  const mrSalesPromise = hrId
    ? supabase
        .from("v_employee_portal_sales")
        .select("sales_value, target_value")
        .or(`hr_id.eq.${hrId.toUpperCase()},employee_hr_id.eq.${hrId.toUpperCase()}`)
        .eq("year", now.getFullYear())
        .eq("month", now.getMonth() + 1)
    : Promise.resolve(null);

  const [vacationResult, excuseResult, batchResult] = await Promise.allSettled([
    supabase
      .from("v2_vacation_requests")
      .select("id", { count: "exact", head: true })
      .eq("employee_hr_id", hrId.toUpperCase())
      .in("status", ["pending_manager", "pending_hr"]),
    supabase
      .from("v2_excuse_requests")
      .select("id", { count: "exact", head: true })
      .eq("employee_hr_id", hrId.toUpperCase())
      .eq("status", "pending_manager"),
    supabase
      .from("salary_batches")
      .select("id, year, month")
      .in("status", ["approved", "locked"])
      .order("year", { ascending: false })
      .order("month", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const pendingVacationCount =
    vacationResult.status === "fulfilled" ? (vacationResult.value.count ?? 0) : 0;
  const pendingExcuseCount =
    excuseResult.status === "fulfilled" ? (excuseResult.value.count ?? 0) : 0;

  let latestPayslip: MrHomeStats["latestPayslip"] = null;
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

  let mrSalesAchievement: MrHomeStats["mrSalesAchievement"] = null;
  try {
    const mrResult = await mrSalesPromise;
    if (mrResult && "data" in mrResult && Array.isArray(mrResult.data) && mrResult.data.length > 0) {
      const rows = mrResult.data as Array<{ sales_value?: number | null; target_value?: number | null }>;
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

  const balance = getVacationBalancePeriod({ hireDate: shell.hrContract.hireDate, referenceDate: today });

  return {
    pendingVacationCount,
    pendingExcuseCount,
    latestPayslip,
    leaveEntitlementDays: balance?.entitlementDays ?? null,
    mrSalesAchievement,
  };
}

const wrapPromise = <T,>(thenable: PromiseLike<T>): Promise<T> =>
  new Promise((resolve, reject) => thenable.then(resolve, reject));

export async function getPortalHomeSnapshot(access: AccessContext): Promise<PortalHomeSnapshot> {
  const shell = await getEmployeePortalShellData(access);
  const hrId = normalizeHrId(access.hrId) ?? "";
  const role = access.role ?? "";
  const today = new Date().toISOString().slice(0, 10);
  const supabase = getSupabaseAdmin();
  const isMr = role.toLowerCase() === "medical rep";

  // Start MR sales query + the role-specific KPI extras immediately so they run in parallel
  // with the batch below. getRoleSpecificExtras never throws — it resolves emptyRoleExtras
  // for roles it doesn't recognize and on any internal failure.
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
  const roleExtrasPromise = getRoleSpecificExtras(access, role, hrId);

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

  // Plans waiting for this user's manager approval (non-MR portal managers only).
  const managerPlanCountPromise =
    !isMr && hrId
      ? wrapPromise(
          supabase
            .from("weekly_plans")
            .select("id", { count: "exact", head: true })
            .eq("manager_hr_id", hrId.toUpperCase())
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

  // Await all MR + manager promises together (they've been in-flight since the start).
  const [mrSalesResult, trendResult, dvResult, expenseResult, managerPlanResult] = await Promise.allSettled([
    mrSalesPromise,
    trendPromise,
    dvPromise,
    expensePromise,
    managerPlanCountPromise,
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

  // Plans awaiting this manager's approval.
  let plansAwaitingManagerApproval: PortalHomeSnapshot["plansAwaitingManagerApproval"] = null;
  try {
    const mpData = managerPlanResult.status === "fulfilled" ? managerPlanResult.value : null;
    if (mpData && "count" in mpData && mpData.count !== null) {
      plansAwaitingManagerApproval = mpData.count;
    }
  } catch {
    // null on failure
  }

  // Pure calculation — no DB.
  const balance = getVacationBalancePeriod({ hireDate: shell.hrContract.hireDate, referenceDate: today });
  const roleExtras = await roleExtrasPromise;

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
    ...roleExtras,
    plansAwaitingManagerApproval,
  };
}
