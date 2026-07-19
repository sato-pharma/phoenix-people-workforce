// DV Planner "Date Check" — pure match logic for the per-rep planned-date picker, kept out of
// the client component so it's unit tested directly, per this repo's domain-first convention
// (mirrors how the DV Planner tool this replaced tested its own rep/date match logic).

export type DateCheckResult =
  | { status: "confirmed"; visitorNames: string[] }
  | { status: "future" }
  | { status: "not-recorded" }
  | { status: "outside-range" };

/**
 * Was a double visit recorded for this rep on the date the manager planned? `visits` is the
 * rep's already-loaded rows for the currently selected period — no separate fetch. Returns null
 * when no date has been picked yet (nothing to check).
 */
export function checkPlannedDate(params: {
  dateFrom: string;
  dateTo: string;
  plannedDate: string;
  today: string;
  visits: readonly { activityDate: string; doubleVisitorName: string | null }[];
}): DateCheckResult | null {
  const { dateFrom, dateTo, plannedDate, today, visits } = params;
  if (!plannedDate) return null;
  if (plannedDate > today) return { status: "future" };
  if (plannedDate < dateFrom || plannedDate > dateTo) return { status: "outside-range" };

  const matches = visits.filter((visit) => visit.activityDate === plannedDate);
  if (matches.length === 0) return { status: "not-recorded" };

  const visitorNames = Array.from(
    new Set(matches.map((visit) => visit.doubleVisitorName).filter((name): name is string => Boolean(name))),
  );
  return { status: "confirmed", visitorNames };
}
