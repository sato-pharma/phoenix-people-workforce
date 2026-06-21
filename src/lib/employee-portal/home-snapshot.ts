import { normalizeHrId, type AccessContext } from "@/lib/auth/permissions";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { getVacationBalancePeriod } from "@/lib/vacation/calculations";
import { getEmployeePortalShellData, type EmployeePortalShellData } from "@/lib/employee-portal/service";

export type PortalHomeSnapshot = {
  shell: EmployeePortalShellData;
  pendingVacationCount: number;
  pendingExcuseCount: number;
  latestPayslip: { month: string; netSalary: number } | null;
  leaveEntitlementDays: number | null;
};

export async function getPortalHomeSnapshot(access: AccessContext): Promise<PortalHomeSnapshot> {
  const shell = await getEmployeePortalShellData(access);
  const hrId = normalizeHrId(access.hrId) ?? "";
  const today = new Date().toISOString().slice(0, 10);
  const supabase = getSupabaseAdmin();

  // All three fire in parallel: pending leave count, pending excuse count, latest payroll batch.
  const [vacationResult, excuseResult, batchResult] = await Promise.allSettled([
    supabase
      .from("v2_vacation_requests")
      .select("id", { count: "exact", head: true })
      .ilike("employee_hr_id", hrId)
      .in("status", ["pending_manager", "pending_hr"]),
    supabase
      .from("v2_excuse_requests")
      .select("id", { count: "exact", head: true })
      .ilike("employee_hr_id", hrId)
      .eq("status", "pending_manager"),
    supabase
      .from("salary_batches")
      .select("id, year, month")
      .order("year", { ascending: false })
      .order("month", { ascending: false })
      .limit(1)
      .maybeSingle(),
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
      .ilike("hr_id", hrId)
      .maybeSingle();
    if (record?.net_salary) {
      latestPayslip = {
        month: `${batch.year}-${String(batch.month).padStart(2, "0")}`,
        netSalary: Number(record.net_salary),
      };
    }
  }

  // Pure calculation — no DB.
  const balance = getVacationBalancePeriod({ hireDate: shell.hrContract.hireDate, referenceDate: today });

  return {
    shell,
    pendingVacationCount,
    pendingExcuseCount,
    latestPayslip,
    leaveEntitlementDays: balance?.entitlementDays ?? null,
  };
}
