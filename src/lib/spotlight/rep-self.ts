// Spotlight — the medical rep's own sheet.
//
// The admin Spotlight (service.ts) reads every rep, district and line with no scope narrowing and is
// a publishing right held by the Super Admin and the CEO alone. This module is the OPPOSITE end: one
// medical representative, looking at nobody but himself, over a window he chooses, and allowed to
// print the sheet only when he has actually earned it.
//
// TWO RULES THE OWNER SET (2026-09-30):
//
//   1. ANY PERIOD, not just a calendar window. A rep may ask for a single month, a quarter, a
//      semester, or any run of months in between — a free-form [from, to] range. This is why the
//      rep path does NOT go through `gateWindow`/`selectableWindows`, which only speak the four
//      calendar shapes: it resolves the months itself and folds them the same way the admin sheet
//      does.
//
//   2. THE PIC OR PDF IS GENERATED ONLY AT 90% AND ABOVE, measured against the PUBLISHED monthly
//      closing. A spotlight is a published number (period.ts), and a rep's is stricter still: a
//      month counts only once its line's Monthly Closing has been PUBLISHED — never a live,
//      unclosed figure, and never an approved direct order dragging an unfinished month onto the
//      sheet. So the range is intersected with the published months for the rep's line, the
//      achievement is computed over that intersection, and the eligibility gate rests on exactly the
//      number the sheet prints.
//
// THE ARITHMETIC IS THE CLOSING'S OWN, reused verbatim. `bucketRows`/`summariseMonths` (rank.ts)
// implement the SUMIF(target>0, sales)/SUM(target) rule the Monthly Closing and /sales/targets both
// follow (owner ruling 2026-09-05, graded ÷ target over the months that carried a target, summed and
// never averaged). Feeding those functions only the rep's published months makes the sheet's figure
// equal, to the piastre, the published closing the rest of the system quotes for him — which is what
// "gate on the published monthly-closing achievement" means.
//
// SELF-SCOPE IS ENFORCED BY THE CALLER, NEVER BY A REQUEST FIELD. The route resolves the rep's own
// HR id from the access context and hands it here; this module never reads an HR id off the wire. A
// rep therefore cannot ask for anyone else's sheet — there is no argument in which to name them.

import { currentCairoDateParts } from "@/lib/i18n/format";
import { loadMonthlyAchievement } from "@/lib/sales/monthly-targets";
import { loadPublishedPeriodKeys } from "@/lib/sales/vs-target";

import { loadSpotlightOrg, type SpotlightOrgIndex } from "./org";
import { isRegionalManagerHeldDistrict } from "@/lib/org/sales-only-seats";
import { SPOTLIGHT_FLOOR } from "./period";
import { bucketRows, hrKey, rowsFromBuckets, type Bucket } from "./rank";
import type { PeriodKey, SpotlightResult, SpotlightRow, SpotlightSelection } from "./types";

/** The floor for a rep's own achievement — his sheet exists only at this and above. Owner, 2026-09-30. */
export const REP_SPOTLIGHT_MIN_ACHIEVEMENT = 90;

/**
 * The widest range a rep may ask for, in months. A year is more than any recognition window needs and
 * bounds the per-request work: every month is a separate ~17,000-cell read of the achievement engine,
 * folded and dropped, and an unbounded range would let one request stream the whole history.
 */
export const REP_SPOTLIGHT_MAX_MONTHS = 12;

/** The first published month in the business. Below it nothing can be published, so nothing counts. */
const PUBLICATION_FLOOR: PeriodKey = "2026-07";

const PERIOD_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export class RepSpotlightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepSpotlightError";
  }
}

export type RepSpotlightRange = { from: PeriodKey; to: PeriodKey };

/**
 * Parse and validate a free-form [from, to] month range off the wire.
 *
 * Strict on purpose: the sheet it feeds looks exactly as authoritative wrong as right. A single
 * month is `from === to`.
 */
export function parseRepSpotlightRange(body: unknown): RepSpotlightRange {
  if (!body || typeof body !== "object") throw new RepSpotlightError("Choose a period.");
  const input = body as Record<string, unknown>;
  const from = typeof input.from === "string" ? input.from.trim() : "";
  const to = typeof input.to === "string" ? input.to.trim() : "";

  if (!PERIOD_PATTERN.test(from) || !PERIOD_PATTERN.test(to)) {
    throw new RepSpotlightError("A period is a run of months, each written as 2026-08.");
  }
  if (from > to) {
    throw new RepSpotlightError("The first month cannot come after the last.");
  }
  if (from < SPOTLIGHT_FLOOR) {
    throw new RepSpotlightError(`The sales data starts in ${monthLabel(SPOTLIGHT_FLOOR)}; choose a later first month.`);
  }
  if (monthsBetween(from, to).length > REP_SPOTLIGHT_MAX_MONTHS) {
    throw new RepSpotlightError(`A spotlight covers at most ${REP_SPOTLIGHT_MAX_MONTHS} months at a time.`);
  }
  return { from, to };
}

/** Every month in [from, to] inclusive, ascending. Both bounds are assumed already validated. */
export function monthsBetween(from: PeriodKey, to: PeriodKey): PeriodKey[] {
  const out: PeriodKey[] = [];
  let year = Number(from.slice(0, 4));
  let month = Number(from.slice(5, 7));
  const end = Number(to.slice(0, 4)) * 12 + (Number(to.slice(5, 7)) - 1);
  for (let cursor = year * 12 + (month - 1); cursor <= end; cursor += 1) {
    year = Math.floor(cursor / 12);
    month = (cursor % 12) + 1;
    out.push(`${year}-${String(month).padStart(2, "0")}`);
  }
  return out;
}

function monthLabel(period: PeriodKey): string {
  const [year, month] = period.split("-");
  return `${MONTH_NAMES[Number(month) - 1] ?? period} ${year}`;
}

/**
 * A concise label for a span — "March 2026" for one month, "March – July 2026" within a year,
 * "November 2025 – February 2026" across the boundary. Never an abbreviation (owner rule).
 */
function spanLabel(periods: PeriodKey[]): string {
  if (periods.length === 0) return "";
  const first = periods[0]!;
  const last = periods.at(-1)!;
  if (first === last) return monthLabel(first);
  const sameYear = first.slice(0, 4) === last.slice(0, 4);
  if (sameYear) {
    const [, firstMonth] = first.split("-");
    return `${MONTH_NAMES[Number(firstMonth) - 1]} – ${monthLabel(last)}`;
  }
  return `${monthLabel(first)} – ${monthLabel(last)}`;
}

/**
 * The seats a person may hold a self spotlight for, and which subject each one is measured as.
 *
 * A REP is measured as himself. A DISTRICT MANAGER is measured as his DISTRICT — that is what a DM's
 * achievement IS, here and in the Monthly Closing (`rollupAchievementByDm` grades the same way), so
 * the sheet totals the reps under his seat rather than inventing a personal territory for him.
 * `ACTING_DM` rides the DM subject for the same reason: the owner's rule is that an acting district
 * manager sees exactly what a district manager sees.
 */
const SELF_SEAT_SUBJECT: Readonly<Record<string, "rep" | "dm">> = {
  REP: "rep",
  DM: "dm",
  ACTING_DM: "dm",
};

/** Find the caller's own seat by occupant HR id. Null when the person holds no spotlightable chair. */
function findSelfSeat(org: SpotlightOrgIndex, hrId: string) {
  const key = hrKey(hrId);
  for (const seat of org.seats.values()) {
    if (isRegionalManagerHeldDistrict(seat.seatId)) continue;
    if (SELF_SEAT_SUBJECT[seat.tier] && hrKey(seat.occupantHrId) === key) return seat;
  }
  return null;
}

export type RepSpotlight = {
  hrId: string;
  /** The requested range, exactly as asked. */
  from: PeriodKey;
  to: PeriodKey;
  rangeLabel: string;
  /** Every month in the requested range. */
  requestedPeriods: PeriodKey[];
  /** The months whose closing is PUBLISHED for the rep's line — the only ones measured. */
  publishedPeriods: PeriodKey[];
  /** Months in the range whose closing is not published yet, and so were left out. */
  pendingPeriods: PeriodKey[];
  /** The rep's achievement over the published months, as a PERCENT. Null when no target was set. */
  achievement: number | null;
  /** Whether the sheet may be generated: a published, targeted window at or above the floor. */
  eligible: boolean;
  /** The floor the gate uses, so the UI and the sheet quote the same number. */
  threshold: number;
  /** In words, why the sheet is not available — null when it is. */
  reason: string | null;
  /** The sheet's own result. Present whenever the rep has a row in the published months. */
  result: SpotlightResult | null;
};

export type RepSpotlightOptions = {
  loadOrg?: () => Promise<SpotlightOrgIndex>;
  loadPeriod?: (period: string) => Promise<Awaited<ReturnType<typeof loadMonthlyAchievement>>>;
  loadPublished?: (from: string, to: string) => Promise<Set<string>>;
};

/**
 * Build one medical rep's own spotlight over [from, to].
 *
 * `hrId` is the caller's OWN id, resolved from the access context by the route — never a wire field.
 */
export async function loadRepSpotlight(
  hrId: string,
  range: RepSpotlightRange,
  options: RepSpotlightOptions = {},
): Promise<RepSpotlight> {
  const { from, to } = range;
  const requestedPeriods = monthsBetween(from, to);
  const threshold = REP_SPOTLIGHT_MIN_ACHIEVEMENT;

  const org = await (options.loadOrg ?? loadSpotlightOrg)();
  const seat = findSelfSeat(org, hrId);
  if (!seat) {
    throw new RepSpotlightError(
      "This spotlight is for medical representatives and district managers — no sales seat is on file for you.",
    );
  }
  const subject = SELF_SEAT_SUBJECT[seat.tier]!;
  const lineCode = (seat.lineCode ?? "").toLowerCase();

  // Published months for the rep's line. The publication ledger begins at 2026-07, and
  // loadPublishedPeriodKeys returns nothing for a `from` below that floor, so clamp the query up to
  // it — nothing earlier can be published, so no key is lost.
  const publishedFrom = from < PUBLICATION_FLOOR ? PUBLICATION_FLOOR : from;
  const publishedKeys = await (options.loadPublished ?? loadPublishedPeriodKeys)(publishedFrom, to);
  // Keys are `${lineCode}|${period}`; compare lower-cased on both sides so a casing difference between
  // the org tree and the closing ledger never silently reads a published month as pending.
  const publishedLower = new Set([...publishedKeys].map((entry) => entry.toLowerCase()));
  const publishedPeriods = requestedPeriods.filter((period) => publishedLower.has(`${lineCode}|${period}`));
  const pendingPeriods = requestedPeriods.filter((period) => !publishedPeriods.includes(period));

  const base = {
    hrId,
    from,
    to,
    rangeLabel: spanLabel(requestedPeriods),
    requestedPeriods,
    publishedPeriods,
    pendingPeriods,
    threshold,
  };

  if (publishedPeriods.length === 0) {
    return {
      ...base,
      achievement: null,
      eligible: false,
      result: null,
      reason:
        "None of these months has a published closing yet, so there is nothing to measure."
        + " Choose a period whose months are already closed and published.",
    };
  }

  // Fold only the published months — a spotlight is a published number.
  const loadPeriod = options.loadPeriod ?? loadMonthlyAchievement;
  const buckets = new Map<string, Bucket>();
  const filters = { hrIds: [hrId] };
  // FETCHED TOGETHER (2026-10-01, "slow to transfer between page and page"): each published month is
  // its own read and none depends on another, so they all load at once instead of one after another.
  // They are still folded strictly in month order, and awaited in that order, so the buckets — and,
  // should a read fail, which month's failure surfaces — are what the one-by-one loop produced. The
  // no-op handlers only keep a later month's failure from surfacing unhandled while an earlier month
  // is still being awaited.
  const monthLoads = publishedPeriods.map((period) => loadPeriod(period));
  for (const load of monthLoads) load.catch(() => undefined);
  for (const load of monthLoads) {
    bucketRows(await load, subject, org, filters, buckets);
  }

  const rows = rowsFromBuckets(buckets, {
    kind: subject,
    org,
    filters,
    lineNames: org.lineNames,
    regionNames: org.regionNames,
    areaNames: org.areaNames,
  });
  const row = rows.find((candidate) => hrKey(candidate.hrId) === hrKey(hrId)) ?? null;

  if (!row) {
    return {
      ...base,
      achievement: null,
      eligible: false,
      result: null,
      reason: "You have no sales recorded in the published months of this period.",
    };
  }

  const achievement = row.achievement;
  const result = buildResult(row, publishedPeriods, subject);

  if (achievement === null) {
    return {
      ...base,
      achievement: null,
      eligible: false,
      result,
      reason: "No target was set for you in the published months of this period, so there is no achievement to measure.",
    };
  }
  if (achievement < threshold) {
    return {
      ...base,
      achievement,
      eligible: false,
      result,
      reason:
        `Your achievement over ${spanLabel(publishedPeriods)} is ${achievement.toFixed(1)}%.`
        + ` The spotlight sheet is available at ${threshold}% and above.`,
    };
  }

  return { ...base, achievement, eligible: true, result, reason: null };
}

/**
 * Wrap the rep's single row in a `SpotlightResult` for the sheet renderer. Kept minimal and honest:
 * the periods are the published months actually measured, the totals are the row's own, and there is
 * no company ranking — a rep's own sheet does not compare him to anyone.
 */
function buildResult(
  row: SpotlightRow,
  publishedPeriods: PeriodKey[],
  subject: "rep" | "dm",
): SpotlightResult {
  const cairo = currentCairoDateParts();
  const generatedAtCairo = new Date(Date.UTC(cairo.year, cairo.month - 1, cairo.day))
    .toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric", timeZone: "UTC" });

  const selection: SpotlightSelection = {
    // A placeholder window — the rep path never gates on it, and the renderer reads `periods` and
    // `windowLabel` below, never `selection.window`.
    window: { kind: "month", key: publishedPeriods[0]! },
    subject,
    filters: { hrIds: [row.hrId ?? ""] },
    rankBy: "achievement",
    direction: "top",
    limit: 1,
    layout: "heroes",
    headline: null,
    subheadline: null,
  };

  return {
    selection,
    periods: publishedPeriods,
    windowLabel: spanLabel(publishedPeriods),
    headline: "Sato Spotlight",
    subheadline: spanLabel(publishedPeriods),
    rows: [row],
    totalSubjects: 1,
    shortlistActualValue: row.actualValue,
    shortlistTargetValue: row.targetValue,
    shortlistAchievement: row.achievement,
    untargetedSubjects: row.achievement === null ? 1 : 0,
    generatedAtCairo,
  };
}
