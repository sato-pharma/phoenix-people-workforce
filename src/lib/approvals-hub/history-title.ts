import { utcDate } from "@/lib/format/cairo-datetime";
import { vacationTypeLabel } from "@/lib/vacation/calculations";
import { planPeriodShortLabel } from "@/lib/weekly-planning/plan-labels";

// The title of a row on the Approvals Hub history tabs (`getAll…DecisionsCompanyWide` in service.ts).
//
// The tab already names the module ("Leave", "Excuse", "Plans"), so a title never repeats it, never
// prints a stored code ("sick_leave", "morning") and never an ISO date ("2026-10-18"). A request's day
// is a date-only value, which `utcDate` renders as it was written — a Cairo date, never shifted.
// Pure, so a test can hold every title.

function dayLabel(value: string | null | undefined): string {
  const label = utcDate(value);
  return label === "—" ? "" : label;
}

function joined(parts: Array<string | null | undefined>): string {
  return parts.map((part) => String(part ?? "").trim()).filter(Boolean).join(" · ");
}

/** `Annual · 18 Oct 2026` — the vacation type by its own name, then the first day. */
export function leaveHistoryTitle(vacationType: string | null | undefined, startDate: string | null | undefined): string {
  return joined([vacationTypeLabel(vacationType), dayLabel(startDate)]);
}

/** `Morning · 18 Oct 2026` — which half of the day, then the day. */
export function excuseHistoryTitle(excuseType: string | null | undefined, excuseDate: string | null | undefined): string {
  const half = String(excuseType ?? "").trim().toLowerCase() === "morning" ? "Morning" : "Afternoon";
  return joined([half, dayLabel(excuseDate)]);
}

/** `Week of 18 Oct` for a weekly plan, `Aug 2026` for a monthly one — never the week code. */
export function planHistoryTitle(plan: { periodKey?: string | null; periodStartDate?: string | null; planKind?: string | null }): string {
  return planPeriodShortLabel({
    periodKey: String(plan.periodKey ?? ""),
    periodStartDate: plan.periodStartDate ?? null,
    planKind: String(plan.planKind ?? "weekly"),
  });
}
