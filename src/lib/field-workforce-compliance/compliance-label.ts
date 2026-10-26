/**
 * How a compliance percentage reads on screen. Shared by the admin workspace and the portal Team
 * Calendar so both say the same thing about the same person.
 *
 * A person with no eligible day in the month has NO percentage — not 0%. Someone hired after the
 * month (or later in it than today) reads "Starts <hire date>"; anyone else with no judged day
 * yet reads "—" (owner, 2026-10-26).
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-11-01" → "1 Nov 2026". Built by hand so the server and the browser print the same bytes. */
export function formatComplianceStartDate(dateIso: string): string {
  const [year, month, day] = dateIso.slice(0, 10).split("-");
  const monthName = MONTHS[Number(month) - 1];
  if (!year || !monthName || !day) return dateIso;
  return `${Number(day)} ${monthName} ${year}`;
}

export function complianceLabel(
  employee: {
    compliancePercent: number | null;
    hiringDateIso: string | null;
    timeline: ReadonlyArray<{ isPreHire: boolean }>;
  },
  formatPercent: (value: number) => string = (value) => `${Math.round(value)}%`,
): string {
  if (employee.compliancePercent !== null) return formatPercent(employee.compliancePercent);
  // A pre-hire day in this month means the start date falls inside or after it.
  const startsLater = Boolean(employee.hiringDateIso) && employee.timeline.some((cell) => cell.isPreHire);
  return startsLater && employee.hiringDateIso ? `Starts ${formatComplianceStartDate(employee.hiringDateIso)}` : "—";
}
