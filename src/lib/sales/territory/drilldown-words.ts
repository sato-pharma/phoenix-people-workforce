// The words of the Sales Drilldown (`/employee-portals/territory-drilldown`): the region → area →
// block → brick → pharmacy tree, its month chips and its data sync panel. Pure, so a test can work
// every sentence by hand. It never computes a sales figure — the pharmacy sums come from the area
// route and the region and area totals from the closing engine — it only decides how each is said.

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "1 pharmacy" / "12 pharmacies" / "1,204 rows" — a count is spelled out with its noun, never "row(s)". */
export function countOf(count: number, singular: string, plural: string = `${singular}s`): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? singular : plural}`;
}

export function pharmacyCount(count: number): string {
  return countOf(count, "pharmacy", "pharmacies");
}

export type MonthChip = {
  period: string;
  /** What the chip prints: the month, with its year on the window's first chip and on each January. */
  label: string;
  /** What a screen reader hears, with no colour needed: "Jul 2026: bought". */
  spoken: string;
};

function monthParts(period: string): { year: string; month: number } | null {
  const match = /^(\d{4})-(\d{2})$/.exec(period.trim());
  if (!match) return null;
  const month = Number(match[2]);
  return month >= 1 && month <= 12 ? { year: match[1], month } : null;
}

/**
 * One chip per month of the window. A bare "Jan" is ambiguous once the window crosses a year (it can
 * run to twelve months), so the first chip and each January carry the year: "Nov 2025", "Dec",
 * "Jan 2026", "Feb". The old chips cut the month's name to three letters and kept the year in a hover
 * title only, which a phone cannot show.
 */
export function monthChips(months: ReadonlyArray<{ period: string; hasSales: boolean }>): MonthChip[] {
  return months.map((month, index) => {
    const parts = monthParts(month.period);
    if (!parts) return { period: month.period, label: month.period, spoken: `${month.period}: ${month.hasSales ? "bought" : "no purchase"}` };
    const name = SHORT_MONTHS[parts.month - 1];
    const full = `${name} ${parts.year}`;
    const label = index === 0 || parts.month === 1 ? full : name;
    return { period: month.period, label, spoken: `${full}: ${month.hasSales ? "bought" : "no purchase"}` };
  });
}

/** Said once over the pharmacy cards, so the chips' two colours are never left to be guessed. */
export const MONTH_CHIP_LEGEND = "Orange months: the pharmacy bought. Grey months: no purchase.";

/**
 * The pharmacy figure on an area header, labelled. The header also carries the area's published
 * closing total, and the two used to sit side by side with only one of them named. `reconciled` is
 * the area route's check that its pharmacies add up to the area's uploaded sheets.
 */
export function pharmacySheetsLine(money: string, reconciled: boolean | null): string {
  const base = `Pharmacies on the uploaded sheets: ${money}`;
  if (reconciled === null) return base;
  return reconciled ? `${base}, adds up to the area's sheets` : `${base}, differs from the area's sheets total`;
}

/** The structural counts on a header: "3 blocks · 41 pharmacies". */
export function structureLine(parts: { blocks?: number; bricks?: number; pharmacies?: number | null; areas?: number }): string {
  const out: string[] = [];
  if (parts.areas != null) out.push(countOf(parts.areas, "area"));
  if (parts.blocks != null) out.push(countOf(parts.blocks, "block"));
  if (parts.bricks != null) out.push(countOf(parts.bricks, "brick"));
  if (parts.pharmacies != null) out.push(pharmacyCount(parts.pharmacies));
  return out.join(" · ");
}

/** An area that could not be loaded, in the viewer's words — never an HTTP code. */
export function areaLoadFailedText(status: number | null): string {
  if (status === 401 || status === 403) return "Your session has ended. Refresh the page and sign in again.";
  return "This area could not be loaded just now. Refresh the page to try again.";
}

/** What the sync does, for every role that can press it (a Medical Rep included). */
export const SYNC_DESCRIPTION =
  "Puts every sale on the area its pharmacy belongs to today, rebuilds the figures on this page, and checks that each line still adds up to its uploaded sheets. A month whose closing is published is never changed.";

/** "Moved 1,204 rows · rebuilt 3 files · 4.2 seconds" — what a finished run did. */
export function syncRunLine(report: { restampedRows: number; refreshedBatches: number; durationMs: number }): string {
  const seconds = Math.max(0, report.durationMs) / 1000;
  return [
    `Moved ${countOf(report.restampedRows, "row")}`,
    `rebuilt ${countOf(report.refreshedBatches, "file")}`,
    `${seconds.toFixed(1)} seconds`,
  ].join(" · ");
}

export type LineSummaryInput = {
  mismatched: number;
  geoMismatchRows: number;
  unrollupRows: number;
  geographyChecked: boolean;
};

/**
 * What a line's badge says after its name. Spelled out rather than a bare count, so a dropped row and
 * a row sitting on the wrong area are told apart. Never truncated.
 */
export function lineSummaryDetail(line: LineSummaryInput): string {
  if (!line.geographyChecked) return " · areas not checked";
  const parts: string[] = [];
  if (line.geoMismatchRows > 0) parts.push(`${countOf(line.geoMismatchRows, "row")} on the wrong area`);
  if (line.unrollupRows > 0) parts.push(`${countOf(line.unrollupRows, "row")} missing from the totals`);
  if (parts.length === 0 && line.mismatched > 0) parts.push(`${countOf(line.mismatched, "month")} not adding up`);
  return parts.length > 0 ? ` · ${parts.join(" · ")}` : "";
}

/** The run's verdict, in words. */
export function syncVerdict(allReconciled: boolean): string {
  return allReconciled ? "Every line adds up to its uploaded sheets." : "Some months do not add up to their uploaded sheets.";
}

/** The month's own short name, read from the period ("2026-07" → "Jul"), never cut from a sentence. */
export function shortMonthName(period: string): string {
  const parts = monthParts(period);
  return parts ? SHORT_MONTHS[parts.month - 1] : period;
}

/** What a screen reader hears for a pharmacy's trend bars: "Sales value by month, Jul 2026 to Dec 2026". */
export function trendChartLabel(periods: readonly string[]): string {
  if (periods.length === 0) return "Sales value by month, no months to show";
  const name = (period: string) => {
    const parts = monthParts(period);
    return parts ? `${SHORT_MONTHS[parts.month - 1]} ${parts.year}` : period;
  };
  const first = name(periods[0]);
  const last = name(periods[periods.length - 1]);
  return first === last ? `Sales value by month, ${first}` : `Sales value by month, ${first} to ${last}`;
}
