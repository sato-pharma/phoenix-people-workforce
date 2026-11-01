// Spotlight — turning achievement rows into a ranked shortlist.
//
// Pure. No database, no clock, no React. Everything it needs arrives as arguments, which is what
// makes every rule below testable against a fixture instead of against production.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE TWO ARITHMETIC RULES THAT MUST NOT DRIFT
//
// 1. A PERCENTAGE IS COMPUTED ONCE, FROM THE SUMS — never averaged. Averaging monthly percentages
//    across different denominators is not an approximation of the right answer, it is a different
//    number: a rep at 200% of a 100k target and 50% of a 900k target averages to 125% and actually
//    achieved 65%. The same rule is why `rollupAchievementByRep` in monthly-targets.ts sums first.
//
// 2. ACROSS MONTHS, ONLY THE MONTHS THAT CARRY A TARGET COUNT — both sides of the fraction. This is
//    the closing's own "ALL MONTHS" rule, `SUMIF(target,">0",sales)/SUM(target)`, copied here rather
//    than reasoned about afresh because /sales/targets and the Monthly Closing must print the same
//    percentage for the same subject and month. Measured over Jan–Sep on the three tracked lines,
//    ignoring it reads 77.55% where the closing's own rule reads 35.26%, because Mar–Jun carry sales
//    and no target at all. Inside a single month everything counts, untargeted areas included.
//
// A consequence worth stating because it looks like a bug: `actualValue` (every pound delivered) can
// exceed the achievement's own numerator (pounds delivered in months this subject was targeted in).
// That is the rule working — but describing it here was not enough. Both the numerator (`gradedValue`)
// and the months it covers (`targetedPeriods`) are now CARRIED ON THE ROW, because a renderer that
// has only the window's months and the all-months total cannot state the fraction honestly: it ends
// up printing a figure beside a target that does not divide into the percentage above them, and
// naming months a target was never set for. Whoever prints the percentage must be able to print
// its own two sides.
//
// 🔴 NOTHING HERE EVER SUMS UNITS. A unit total is valid for one product code only; above that the
// only honest aggregate is VALUE. `actual_units` is deliberately not carried through this module.

import type { AchievementRow } from "@/lib/sales/monthly-targets";
import { isRegionalManagerHeldDistrict } from "@/lib/org/sales-only-seats";

import type {
  PeriodKey,
  SpotlightFilters,
  SpotlightRankBy,
  SpotlightRankDirection,
  SpotlightRow,
  SpotlightSubjectKind,
} from "./types";

/** One chair in `au.v_org_tree`. */
export type OrgSeat = {
  seatId: string;
  parentSeatId: string | null;
  tier: string;
  lineCode: string | null;
  lineName: string | null;
  regionCode: string | null;
  regionName: string | null;
  areaCode: string | null;
  areaName: string | null;
  occupantHrId: string | null;
  isVacant: boolean;
  displayLabel: string;
};

export type OrgPerson = {
  hrId: string;
  fullName: string;
  nameAr: string | null;
  jobTitle: string | null;
};

/**
 * The org, indexed for lookup.
 *
 * 🔴 BOTH MAPS ARE KEYED LOWER-CASE. HR ids are mixed case in this database — one plain `.eq` once
 * hid 28% of reps' own orders, and on `au.occupancy_history` the loss was total. Every lookup here
 * goes through `hrKey()` so a `B-122` row and a `b-122` filter are the same person.
 */
export type SpotlightOrg = {
  seats: Map<string, OrgSeat>;
  /** Keyed by lower-cased HR id. */
  people: Map<string, OrgPerson>;
};

export function hrKey(hrId: string | null | undefined): string {
  return (hrId ?? "").trim().toLowerCase();
}

/** The three lines the company actually tracks. Head Office is not one of them, by golden rule. */
export const TRACKED_LINES = ["cns", "pedia", "anti_infective"] as const;

const TIER_ROLE_LABEL: Record<string, string> = {
  NSM: "National Sales Manager",
  RSM: "Regional Sales Manager",
  DM: "District Sales Manager",
  ACTING_DM: "Acting District Manager",
  REP: "Medical Representative",
  CEO: "Chief Executive Officer",
};

const SUBJECT_TIER: Partial<Record<SpotlightSubjectKind, string[]>> = {
  rep: ["REP"],
  dm: ["DM", "ACTING_DM"],
  rsm: ["RSM"],
  nsm: ["NSM"],
};

/** Walk up the seat tree until a seat of one of `tiers` is found. Null when the chain does not reach one. */
function climbTo(org: SpotlightOrg, seatId: string | null, tiers: string[]): OrgSeat | null {
  let current = seatId ? org.seats.get(seatId) ?? null : null;
  // The tree is six deep at most; the bound is a guard against a cycle, not a depth limit.
  for (let hops = 0; current && hops < 12; hops += 1) {
    if (tiers.includes(current.tier)) return current;
    current = current.parentSeatId ? org.seats.get(current.parentSeatId) ?? null : null;
  }
  return null;
}

/**
 * Which subject a row belongs to, and how to describe it.
 *
 * Returns null when the row cannot be attributed to a subject of this kind at all — an unmapped
 * row, or an RSM ranking on a line that has no RSM seat. A null is DROPPED, never bucketed into
 * an "other" subject, because an "other" row would then compete for a place on the sheet.
 */
function subjectOf(
  row: AchievementRow,
  kind: SpotlightSubjectKind,
  org: SpotlightOrg,
): { key: string; seat: OrgSeat | null } | null {
  if (kind === "line") {
    return row.lineCode ? { key: row.lineCode, seat: null } : null;
  }
  if (kind === "region") {
    if (!row.lineCode || !row.regionCode) return null;
    return { key: `${row.lineCode}:${row.regionCode}`, seat: null };
  }
  if (kind === "area") {
    if (!row.lineCode || !row.areaCode) return null;
    return { key: `${row.lineCode}:${row.areaCode}`, seat: null };
  }

  const tiers = SUBJECT_TIER[kind]!;
  // A district a Regional Manager holds himself counts to him, and he is not a district manager.
  if (kind === "dm" && isRegionalManagerHeldDistrict(row.dmSeatId)) return null;
  // A rep row already names its own seat; everything above it is reached by climbing, so an
  // NSM ranking picks up the rep rows under vacant district seats too.
  const start = kind === "rep" ? row.repSeatId : row.dmSeatId ?? row.repSeatId;
  const seat = kind === "rep"
    ? (row.repSeatId ? org.seats.get(row.repSeatId) ?? null : null)
    : climbTo(org, start, tiers);
  if (!seat) return null;
  if (kind === "rep" && seat.tier !== "REP") return null;
  return { key: seat.seatId, seat };
}

function lowerSet(values: string[] | undefined): Set<string> | null {
  if (!values || values.length === 0) return null;
  return new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean));
}

/** Row-level filters. Applied BEFORE aggregation so a filtered-out area never reaches a total. */
export function rowPassesFilters(row: AchievementRow, filters: SpotlightFilters): boolean {
  const lines = lowerSet(filters.lines) ?? new Set<string>(TRACKED_LINES);
  if (!row.lineCode || !lines.has(row.lineCode.toLowerCase())) return false;

  const regions = lowerSet(filters.regions);
  if (regions && !(row.regionCode && regions.has(row.regionCode.toLowerCase()))) return false;

  const areas = lowerSet(filters.areas);
  if (areas && !(row.areaCode && areas.has(row.areaCode.toLowerCase()))) return false;

  return true;
}

export type Bucket = {
  key: string;
  seat: OrgSeat | null;
  lineCodes: Set<string>;
  regionCodes: Set<string>;
  areaCodes: Set<string>;
  /** period → running actual and target for this subject. */
  months: Map<PeriodKey, { actual: number; target: number }>;
};

/**
 * Fold rows into one bucket per subject.
 *
 * `rows` may span several periods; the period is taken from each row, so a quarter is simply three
 * months of rows handed in together.
 */
export function bucketRows(
  rows: AchievementRow[],
  kind: SpotlightSubjectKind,
  org: SpotlightOrg,
  filters: SpotlightFilters,
  /**
   * An existing accumulator to fold into.
   *
   * WHY THIS EXISTS. A half-year window is six months of achievement rows, and one month of CNS
   * alone was 17,281 cells. Concatenating six months before folding holds every one of them in
   * memory at once for no reason — the fold is associative, so each month can be folded and
   * dropped. On a single-replica container that difference is the whole cost of the feature.
   */
  into?: Map<string, Bucket>,
): Map<string, Bucket> {
  const buckets = into ?? new Map<string, Bucket>();
  for (const row of rows) {
    if (!rowPassesFilters(row, filters)) continue;
    const subject = subjectOf(row, kind, org);
    if (!subject) continue;

    let bucket = buckets.get(subject.key);
    if (!bucket) {
      bucket = {
        key: subject.key,
        seat: subject.seat,
        lineCodes: new Set(),
        regionCodes: new Set(),
        areaCodes: new Set(),
        months: new Map(),
      };
      buckets.set(subject.key, bucket);
    }
    if (row.lineCode) bucket.lineCodes.add(row.lineCode);
    if (row.regionCode) bucket.regionCodes.add(row.regionCode);
    if (row.areaCode) bucket.areaCodes.add(row.areaCode);

    const month = bucket.months.get(row.period) ?? { actual: 0, target: 0 };
    month.actual += row.actualValue;
    month.target += row.targetValue ?? 0;
    bucket.months.set(row.period, month);
  }
  return buckets;
}

/**
 * The two rules, applied. See the header.
 *
 * `graded` is the achievement's numerator; `actual` is every pound. They differ exactly when the
 * window contains a month this subject was not targeted in.
 */
export function summariseMonths(months: Map<PeriodKey, { actual: number; target: number }>): {
  actual: number;
  graded: number;
  target: number | null;
  achievement: number | null;
  targetedPeriods: PeriodKey[];
  targetedMonths: number;
  activeMonths: number;
} {
  let actual = 0;
  let graded = 0;
  let target = 0;
  let activeMonths = 0;
  const targetedPeriods: PeriodKey[] = [];

  for (const [period, month] of months) {
    actual += month.actual;
    if (month.actual !== 0) activeMonths += 1;
    if (month.target > 0) {
      graded += month.actual;
      target += month.target;
      targetedPeriods.push(period);
    }
  }

  // `YYYY-MM` sorts chronologically as text, and the rows arrive in whatever order the query
  // returned them — so this is sorted here rather than trusted, because a caller naming these
  // months in a sentence would otherwise print them out of order.
  targetedPeriods.sort();

  return {
    actual,
    graded,
    target: targetedPeriods.length > 0 ? target : null,
    achievement: target > 0 ? (graded / target) * 100 : null,
    targetedPeriods,
    targetedMonths: targetedPeriods.length,
    activeMonths,
  };
}

function describe(
  bucket: Bucket,
  kind: SpotlightSubjectKind,
  org: SpotlightOrg,
  lineNames: Map<string, string>,
  regionNames: Map<string, string>,
  areaNames: Map<string, string>,
): Pick<SpotlightRow, "title" | "titleAr" | "roleLabel" | "territory" | "lineName" | "hrId" | "isVacant"> {
  const oneLine = bucket.lineCodes.size === 1 ? [...bucket.lineCodes][0]! : null;
  const lineName = oneLine ? lineNames.get(oneLine) ?? oneLine : null;

  if (kind === "line") {
    return {
      title: lineNames.get(bucket.key) ?? bucket.key,
      titleAr: null,
      roleLabel: "Product Line",
      territory: "Egypt",
      lineName: lineNames.get(bucket.key) ?? bucket.key,
      hrId: null,
      isVacant: false,
    };
  }
  if (kind === "region" || kind === "area") {
    const code = bucket.key.split(":")[1] ?? bucket.key;
    const name = kind === "region" ? regionNames.get(code) ?? code : areaNames.get(code) ?? code;
    return {
      title: name,
      titleAr: null,
      roleLabel: kind === "region" ? "District" : "Territory",
      territory: name,
      lineName,
      hrId: null,
      isVacant: false,
    };
  }

  const seat = bucket.seat;
  const person = seat?.occupantHrId ? org.people.get(hrKey(seat.occupantHrId)) ?? null : null;
  // A VACANT SEAT IS NEVER GIVEN A NAME. 43 of 111 rep seats are empty and they still sell, so the
  // territory stands in for the person rather than the row being dropped or, far worse, labelled
  // with whoever used to sit there.
  const territory = seat?.areaName ?? seat?.regionName ?? "Egypt";
  return {
    title: person?.fullName ?? `${territory} — vacant seat`,
    titleAr: person?.nameAr ?? null,
    roleLabel: TIER_ROLE_LABEL[seat?.tier ?? ""] ?? "Sales",
    territory,
    lineName: seat?.lineName ?? lineName,
    hrId: person?.hrId ?? null,
    isVacant: !person,
  };
}

export type BuildOptions = {
  kind: SpotlightSubjectKind;
  org: SpotlightOrg;
  filters: SpotlightFilters;
  lineNames: Map<string, string>;
  regionNames: Map<string, string>;
  areaNames: Map<string, string>;
};

/** Every subject that survives the filters, unranked and uncut. */
export function buildRows(rows: AchievementRow[], options: BuildOptions): SpotlightRow[] {
  const { kind, org, filters } = options;
  return rowsFromBuckets(bucketRows(rows, kind, org, filters), options);
}

/** The second half of `buildRows`, for a caller that folded the months itself. */
export function rowsFromBuckets(buckets: Map<string, Bucket>, options: BuildOptions): SpotlightRow[] {
  const { kind, org, filters, lineNames, regionNames, areaNames } = options;

  // Subject-level filters. These cannot be applied to a row, because a row does not know which
  // person it will end up under until the seat tree has been climbed.
  const hrIds = lowerSet(filters.hrIds);
  const seatIds = lowerSet(filters.seatIds);

  const out: SpotlightRow[] = [];
  for (const bucket of buckets.values()) {
    const described = describe(bucket, kind, org, lineNames, regionNames, areaNames);
    if (seatIds && !seatIds.has(bucket.key.toLowerCase())) continue;
    if (hrIds && !(described.hrId && hrIds.has(hrKey(described.hrId)))) continue;
    // Checked HERE, not on the row: a row does not know whether the seat it climbs to is occupied
    // until the tree has been walked and the occupant looked up.
    if (filters.excludeVacant && described.isVacant) continue;

    const summary = summariseMonths(bucket.months);
    out.push({
      key: bucket.key,
      ...described,
      actualValue: summary.actual,
      gradedValue: summary.graded,
      targetValue: summary.target,
      achievement: summary.achievement,
      varianceValue: summary.target === null ? null : summary.graded - summary.target,
      targetedPeriods: summary.targetedPeriods,
      targetedMonths: summary.targetedMonths,
      activeMonths: summary.activeMonths,
    });
  }
  return out;
}

/**
 * Order and cut.
 *
 * 🔴 A SUBJECT WITH NO TARGET IS DROPPED FROM AN ACHIEVEMENT RANKING, not sorted last. "Others"
 * carries real money and no target on every line — 834,365 EGP on CNS in August alone — so a null
 * treated as zero would park real sales at the bottom of the sheet under a red arrow, and a null
 * treated as infinity would crown it. It is not a competitor in that race; the caller is told how
 * many were set aside so the sheet can say so.
 *
 * Ranking BY VALUE keeps them: money is money whether or not anyone set a target for it.
 */
export function rankRows(
  rows: SpotlightRow[],
  rankBy: SpotlightRankBy,
  direction: SpotlightRankDirection,
  limit: number | null,
): { ranked: SpotlightRow[]; considered: number; untargeted: number } {
  const untargeted = rows.filter((row) => row.achievement === null).length;
  const pool = rankBy === "achievement" ? rows.filter((row) => row.achievement !== null) : rows;

  const sorted = [...pool].sort((a, b) => {
    const left = rankBy === "achievement" ? a.achievement ?? 0 : a.actualValue;
    const right = rankBy === "achievement" ? b.achievement ?? 0 : b.actualValue;
    if (left !== right) return direction === "top" ? right - left : left - right;
    // A stable tie-break, so two subjects on identical numbers do not swap places between two
    // exports of the same selection and make the sheet look wrong.
    return a.title.localeCompare(b.title);
  });

  const ranked = limit && limit > 0 ? sorted.slice(0, limit) : sorted;
  return { ranked, considered: pool.length, untargeted };
}

/** Totals for the shortlist, recomputed from sums. Never the mean of the printed percentages. */
export function summariseShortlist(rows: SpotlightRow[]): {
  actualValue: number;
  targetValue: number | null;
  achievement: number | null;
} {
  let actualValue = 0;
  let target = 0;
  let graded = 0;
  let anyTarget = false;

  for (const row of rows) {
    actualValue += row.actualValue;
    if (row.targetValue !== null) {
      anyTarget = true;
      target += row.targetValue;
      // Read the numerator off the row. This used to be reconstructed from the variance
      // (graded − target), which was arithmetically right and one refactor away from being wrong.
      graded += row.gradedValue;
    }
  }

  return {
    actualValue,
    targetValue: anyTarget ? target : null,
    achievement: target > 0 ? (graded / target) * 100 : null,
  };
}
