import { normalizeHrId, type AccessContext } from "@/lib/auth/permissions";
import { getSupabaseAdmin } from "@/lib/supabase/server";
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
};

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

export async function getPortalHomeSnapshot(access: AccessContext): Promise<PortalHomeSnapshot> {
  const shell = await getEmployeePortalShellData(access);
  const hrId = normalizeHrId(access.hrId) ?? "";
  const role = access.role ?? "";
  const today = new Date().toISOString().slice(0, 10);
  const supabase = getSupabaseAdmin();
  const isMr = role.toLowerCase() === "medical rep";

  // Start MR sales query immediately so it runs in parallel with the batch below.
  const now = new Date();
  const mrSalesPromise =
    isMr && hrId
      ? supabase
          .from("v_employee_portal_sales")
          .select("sales_value, target_value")
          .or(`hr_id.eq.${hrId.toUpperCase()},employee_hr_id.eq.${hrId.toUpperCase()}`)
          .eq("year", now.getFullYear())
          .eq("month", now.getMonth() + 1)
      : Promise.resolve(null);

  // All three fire in parallel: pending leave count, pending excuse count, latest payroll batch.
  const [vacationResult, excuseResult, batchResult] = await Promise.allSettled([
    Promise.resolve(
      supabase
        .from("v2_vacation_requests")
        .select("id", { count: "exact", head: true })
        .eq("employee_hr_id", hrId.toUpperCase())
        .in("status", ["pending_manager", "pending_hr"]),
    ),
    Promise.resolve(
      supabase
        .from("v2_excuse_requests")
        .select("id", { count: "exact", head: true })
        .eq("employee_hr_id", hrId.toUpperCase())
        .eq("status", "pending_manager"),
    ),
    Promise.resolve(
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

  // Resolve MR achievement (null for all other roles).
  let mrSalesAchievement: PortalHomeSnapshot["mrSalesAchievement"] = null;
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
    // null on failure — non-fatal
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
  };
}
