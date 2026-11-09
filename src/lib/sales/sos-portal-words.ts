// The words and rounding of the employee portal's Source of Sales page (`/employee-portals/source-of-sales`):
// the pharmacy action lists, the weekly month pace and the distributor dashboard under them. Pure, so a
// test can work every figure by hand. It never computes a sales figure — those come from the published
// closing and the server's own comparison — it only decides how a figure is said.
//
// The one rule behind most of it: a percentage NEVER rounds across a line. 99.6% of target is not
// "100%", and a pharmacy down 29.6% is not "down 30%" on a list whose rule is "30% or more". Every
// percentage here is cut toward zero, so it can only understate.

/** A fraction as a percentage cut toward zero to `decimals` places: 0.996 → 99, -0.296 → -29. */
export function percentTowardZero(fraction: number | null | undefined, decimals = 0): number {
  if (fraction == null || !Number.isFinite(fraction) || fraction === 0) return 0;
  const scale = 10 ** decimals;
  const abs = Math.abs(fraction) * 100 * scale;
  // The small nudge keeps 0.29 * 100 (28.999…) from reading 28.
  const cut = Math.floor(abs + 1e-9) / scale;
  return cut === 0 ? 0 : Math.sign(fraction) * cut;
}

/** "89%" — a whole percentage that never rounds up across a line. */
export function wholePercentText(fraction: number | null | undefined): string {
  return `${percentTowardZero(fraction, 0)}%`;
}

/** "12.4%" — a share or a direct share, one decimal, cut toward zero. */
export function sharePercentText(fraction: number | null | undefined): string {
  return `${percentTowardZero(fraction, 1).toFixed(1)}%`;
}

export type DeltaTone = "up" | "down" | "flat";

/**
 * A month-on-month change: "+12.4%" in green, "-3.1%" in red. A change too small to show at one
 * decimal reads "0.0%" in grey — never a green "+0.0%" or a red "-0.0%" that says a direction the
 * figure does not have.
 */
export function deltaWords(delta: number): { text: string; tone: DeltaTone } {
  const value = percentTowardZero(delta, 1);
  if (value === 0) return { text: "0.0%", tone: "flat" };
  return value > 0 ? { text: `+${value.toFixed(1)}%`, tone: "up" } : { text: `${value.toFixed(1)}%`, tone: "down" };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-09" → "Sep 2026". Worked out from the text, never through a Date, so no timezone moves it. */
export function monthName(period: string | null | undefined): string {
  if (!period) return "—";
  const match = /^(\d{4})-(\d{2})$/.exec(period.trim());
  if (!match) return period;
  const month = Number(match[2]);
  if (month < 1 || month > 12) return period;
  return `${MONTHS[month - 1]} ${match[1]}`;
}

/** What a change is measured against, named: "vs Sep 2026". */
export function versusMonth(previousPeriod: string | null | undefined): string {
  return previousPeriod ? `vs ${monthName(previousPeriod)}` : "vs the month before";
}

function monthIndex(period: string): number | null {
  const match = /^(\d{4})-(\d{2})$/.exec(period.trim());
  return match ? Number(match[1]) * 12 + Number(match[2]) - 1 : null;
}

/**
 * The trend card's title, from the months it really draws. The trend is the six newest published
 * months PLUS the month the viewer picked, so a picked month older than those six sits apart from
 * them: the title says so instead of claiming "last 6 months".
 */
export function trendTitle(periods: string[], selected: string | null): string {
  const sorted = [...new Set(periods)].sort();
  if (sorted.length === 0) return "Value trend";
  if (sorted.length === 1) return `Value trend · ${monthName(sorted[0])}`;
  const first = sorted[0];
  const second = sorted[1];
  const last = sorted[sorted.length - 1];
  const a = monthIndex(first);
  const b = monthIndex(second);
  const apart = selected === first && a != null && b != null && b - a > 1;
  if (apart) {
    const rest = sorted.length === 2 ? monthName(second) : `${monthName(second)} to ${monthName(last)}`;
    return `Value trend · ${rest}, and ${monthName(first)}`;
  }
  return `Value trend · ${monthName(first)} to ${monthName(last)}`;
}

export type PaceRowInput = {
  soFarValue: number;
  targetValue: number | null;
  progress: number | null;
  expectedByToday: number | null;
  onPace: boolean | null;
};

/**
 * One area's month pace, said in words a phone can read without a hover: how far it is, where it
 * should be by today, and how much it is short. Both percentages are cut the same way, so "On pace"
 * never sits beside a figure below the mark.
 */
export function paceWords(row: PaceRowInput): {
  progressText: string | null;
  expectedText: string | null;
  badge: "On pace" | "Behind" | null;
  shortBy: number | null;
} {
  const hasTarget = row.targetValue != null && row.targetValue > 0;
  const progressText = row.progress == null ? null : `${wholePercentText(row.progress)} of target`;
  const expectedText =
    hasTarget && row.expectedByToday != null ? `expected ${wholePercentText(row.expectedByToday / (row.targetValue as number))} by today` : null;
  const badge = row.onPace == null ? null : row.onPace ? "On pace" : "Behind";
  const shortBy =
    row.onPace === false && row.expectedByToday != null && row.expectedByToday > row.soFarValue ? row.expectedByToday - row.soFarValue : null;
  return { progressText, expectedText, badge, shortBy };
}

/** "the closing before the latest" / "the 3 closings before the latest" — the window really compared. */
export function earlierClosings(count: number): string {
  return count === 1 ? "the closing before the latest" : `the ${count} closings before the latest`;
}

/** The sentence over the pharmacy tiles: which closing, compared with which, and what is missing. */
export function closingIntro(input: {
  line: string | null;
  latestPeriod: string | null;
  priorPeriods: string[];
  historyComplete: boolean;
}): string {
  const subject = input.line ? `The ${input.line} closing` : "The closing";
  const latest = monthName(input.latestPeriod);
  if (input.priorPeriods.length === 0) {
    return `${subject} for ${latest} is the first published month, so there is nothing to compare it with yet.`;
  }
  const earlier = [...input.priorPeriods].sort().map(monthName).join(", ");
  const count = input.priorPeriods.length;
  const gap = input.historyComplete
    ? ""
    : ` Only ${count} earlier closing${count === 1 ? " is" : "s are"} published, so "New" may include pharmacies that bought before them.`;
  return `${subject} for ${latest}, compared with ${earlier}. Published closings only.${gap}`;
}

/** The distributor upload state, in words shown at every width (it was hidden on a phone). */
export function uploadWords(
  status: { uploadedCount: number; expectedCount: number; awaitingCount: number } | null | undefined,
): { text: string; tone: "done" | "waiting" } | null {
  if (!status || status.expectedCount <= 0) return null;
  const base = `${status.uploadedCount} of ${status.expectedCount} distributors uploaded`;
  return status.awaitingCount > 0
    ? { text: `${base} · ${status.awaitingCount} still to come`, tone: "waiting" }
    : { text: base, tone: "done" };
}

/** The page's own words when the distributor dashboard cannot load. Never the raw error text. */
export const DASHBOARD_UNAVAILABLE =
  "The distributor dashboard could not be loaded just now. Reload the page in a minute to try again.";

/** Said above the figures when a filter change could not be loaded, so old figures never pass as new. */
export const REFRESH_FAILED =
  "That selection could not be loaded. The figures below are still for your previous selection.";

/**
 * A chart label broken into lines of at most `maxChars`, on word boundaries, never cut and never
 * ended with an ellipsis. A single word longer than the limit keeps its own whole line.
 */
export function wrapAxisLabel(label: string, maxChars: number): string[] {
  const words = label.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (!current) current = word;
    else if (current.length + 1 + word.length <= maxChars) current = `${current} ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  lines.push(current);
  return lines;
}

/** Line height of a wrapped chart label, in px, at the 11px chart type. */
export const AXIS_LINE_HEIGHT = 13;

/**
 * Height of a horizontal bar chart whose labels wrap: each bar gets room for its own label's lines,
 * and the chart never falls below the 240px the cards were drawn at.
 */
export function rankedChartHeight(lineCounts: number[], minHeight = 240): number {
  const rows = lineCounts.reduce((sum, lines) => sum + Math.max(28, lines * AXIS_LINE_HEIGHT + 12), 0);
  return Math.max(minHeight, rows + 8);
}
