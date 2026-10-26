// Words the Vacation Report prints around its numbers — display only. Nothing here decides a
// balance, a payment or an approval; the figures come from the vacation service unchanged.

function formatCount(value: number): string {
  return `${Number(value.toFixed(2))}`;
}

/** "1 day", "0.5 days", "3 days" — never "1 days". */
export function vacationDaysLabel(days: number): string {
  const shown = formatCount(days);
  return `${shown} ${Number(shown) === 1 ? "day" : "days"}`;
}

/** "1 warning", "2 warnings" — never "1 warning(s)". */
export function overlapWarningsLabel(count: number): string {
  return `${count} ${count === 1 ? "warning" : "warnings"}`;
}

/**
 * The "Daily SLA run" card reports a background job's last run — an HR operations fact with no
 * meaning to a manager reading their team's leave. Only a viewer who can manage vacation records
 * (Super Admin and HR) sees it; the queue, overdue and evidence counters beside it stay as they are.
 */
export function showsDailySlaRunCard(viewer: { canAdminManage: boolean; isSelfView: boolean }): boolean {
  return viewer.canAdminManage && !viewer.isSelfView;
}
