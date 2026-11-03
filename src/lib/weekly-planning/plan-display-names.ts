import { namesByHrId, type EmployeeNameIndex } from "@/lib/employees/names-by-hr-id";

/**
 * 🔒 A PLAN PRINTS PEOPLE BY THEIR DISPLAY NAME (owner, 2026-11-03).
 *
 * `employee_plan_headers.employee_name` and `manager_name` are snapshots and stay raw on WRITE. They
 * are resolved at READ, by HR id, for whatever a person reads: a notification, an email, a calendar
 * chip. An id nobody knows keeps the stored name, and a failed name read keeps every stored name,
 * because a failed name read must never fail the page or swallow a notice.
 */
type PlanNameFields = {
  employee_hr_id?: string | null;
  employee_name?: string | null;
  manager_hr_id?: string | null;
  manager_name?: string | null;
};

/** Pure, so a test can hold it. A row read without `manager_hr_id` keeps its stored manager name. */
export function overlayPlanDisplayNames<T extends PlanNameFields>(
  plans: readonly T[],
  names: Pick<EmployeeNameIndex, "get">,
): T[] {
  return plans.map((plan) => ({
    ...plan,
    employee_name: names.get(plan.employee_hr_id) ?? plan.employee_name,
    manager_name: names.get(plan.manager_hr_id) ?? plan.manager_name,
  }));
}

export async function plansWithDisplayNames<T extends PlanNameFields>(plans: readonly T[]): Promise<T[]> {
  try {
    const names = await namesByHrId(plans.flatMap((plan) => [plan.employee_hr_id, plan.manager_hr_id]));
    return overlayPlanDisplayNames(plans, names);
  } catch {
    return [...plans];
  }
}

export async function planWithDisplayNames<T extends PlanNameFields>(plan: T): Promise<T> {
  const [named] = await plansWithDisplayNames([plan]);
  return named;
}
