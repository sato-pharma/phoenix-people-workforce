// Spotlight — what a selection IS.
//
// The module exists to answer one shape of question: "show me these people, over this window,
// ranked this way, and give me a sheet I can put in front of the company." Everything below is
// the vocabulary for that question. Nothing here touches the database or renders anything.
//
// WHY A SELECTION IS ONE OBJECT rather than a pile of arguments. The owner's own examples cross
// every axis at once — "the Giza district managers for the three lines", "a certain area's medical
// reps for the three lines", "the top 10 reps in one line or in two" — so the filters are not a
// hierarchy that can be walked, they are a SET INTERSECTION. Modelling them as one object with
// independent optional filters is what makes those three examples the same code path instead of
// three special cases.

/** Period key as used throughout the sales code: `YYYY-MM`. */
export type PeriodKey = string;

/**
 * The window a spotlight covers.
 *
 * A month, a calendar quarter, a calendar half, or a calendar year — all four the owner named, and
 * all four ones the rest of the codebase already speaks: quarters come from the business review's
 * `quartersInWindow` and halves from `src/lib/incentives/semester.ts`, which is where the payout
 * curve gets its own window. A free-form range is deliberately NOT offered: an award over "March to
 * some other month" has no meaning anyone could defend, and every extra window shape is another
 * denominator to get wrong.
 */
export type SpotlightWindowKind = "month" | "quarter" | "semester" | "year";

export type SpotlightWindow = {
  kind: SpotlightWindowKind;
  /** `2026-08` for a month, `2026-Q3` for a quarter, `2026-S2` for a half, `2026` for a year. */
  key: string;
};

/**
 * WHAT each row and each hero page represents.
 *
 * Seat tiers come from `au.v_org_tree`, which the owner has ruled is the source of truth for org
 * structure and vacancy. Keying on the SEAT and not the person is deliberate and load-bearing: a
 * vacant area still sells, so a spotlight keyed on people would silently drop that area's money,
 * and 43 of 111 rep seats are vacant. The occupant is looked up for display only, and a vacant
 * seat prints its area rather than inventing a name.
 *
 * `region` is the district — one DM's patch on one line. The `teams` table is deliberately NOT the
 * source: a `teams` row belongs to an AREA but is NAMED for a REGION, one area can sit in different
 * regions on different lines, and `team_name` is dead in 107 of 107 rows. The org tree answers the
 * same question without any of that.
 */
export type SpotlightSubjectKind =
  | "rep"
  | "dm"
  | "rsm"
  | "nsm"
  | "area"
  | "region"
  | "line";

/** How the shortlist is ordered, and therefore who gets spotlighted. */
export type SpotlightRankBy = "achievement" | "value";

/** Top of the list or bottom of it. Bottom is for the owner's own eyes; it is never a celebration. */
export type SpotlightRankDirection = "top" | "bottom";

/**
 * What comes out of the printer.
 *
 * Owner's decision: BOTH by default — a ranked leaderboard page, then one hero sheet per subject —
 * with the switch available per export. A leaderboard alone gives no one their own certificate; hero
 * pages alone give no picture of the group; and the comparison cases ("Giza across the three lines")
 * are only legible on the leaderboard.
 */
export type SpotlightLayout = "leaderboard" | "heroes" | "both";

/**
 * The filters. Every one is an INTERSECTION and every one is optional; an empty or absent filter
 * means "no restriction on this axis", never "none".
 *
 * 🔴 `lines` DEFAULTS TO THE THREE TRACKED LINES, never to everything the data holds. Head Office
 * is 90% of weekly value, carries no target, and is not tracked — including it would put an
 * ungradeable giant at the top of every value ranking and drag every achievement denominator
 * sideways. That is a golden rule, not a preference.
 */
export type SpotlightFilters = {
  /** Line codes: `cns`, `pedia`, `anti_infective`. */
  lines?: string[];
  /** Operational region codes: `GZ`, `CA`, `D1`… */
  regions?: string[];
  /** Canonical area codes: `GZ5`, `D14`… */
  areas?: string[];
  /** Named people, by HR id. Mixed case in the database — always compared case-insensitively. */
  hrIds?: string[];
  /** Named seats, when the owner picks a specific chair rather than a person. */
  seatIds?: string[];
  /**
   * Drop subjects whose seat has no occupant.
   *
   * WHY IT EXISTS. 43 of 111 rep seats are empty and they still sell, so a vacant territory can
   * out-achieve real people — Port Said and Domiat took 8th place on the first top-ten sheet that
   * was ever exported, at 130.7%, with nobody to congratulate. On a RECOGNITION sheet that is a
   * slot taken from a person; on a performance read it is real money that must not disappear.
   *
   * Both are legitimate, so this is a switch rather than a rule, and it DEFAULTS TO FALSE here —
   * a filter's absence must mean "no restriction", never a silent exclusion of real sales. The UI
   * ships with it ticked, because a sheet with somebody's name on it is the common case.
   */
  excludeVacant?: boolean;
};

export type SpotlightSelection = {
  window: SpotlightWindow;
  subject: SpotlightSubjectKind;
  filters: SpotlightFilters;
  rankBy: SpotlightRankBy;
  direction: SpotlightRankDirection;
  /** How many make the sheet. `null` means every subject that survives the filters. */
  limit: number | null;
  layout: SpotlightLayout;
  /**
   * Whether the sheet prints money. Absent means shown. `false` is the sheet that ranks by achievement
   * and prints no EGP figure at all, sales or target, because a target printed beside a percentage
   * gives the sales away (owner, 2026-11-04).
   */
  showValue?: boolean;
  /** Overrides the generated headline when set and non-empty. */
  headline?: string | null;
  /** Overrides the generated sub-line when set and non-empty. */
  subheadline?: string | null;
};

/** One subject's numbers over the whole window. */
export type SpotlightRow = {
  /** Stable identity for the subject — a seat id, an area code, a region key, or a line code. */
  key: string;
  /** What to print as the subject's name. Never empty; a vacant seat prints its territory. */
  title: string;
  /** Arabic name where the subject is a person and one is on file. */
  titleAr: string | null;
  /** "National Sales Manager", "District Manager", "Medical Representative", or the territory kind. */
  roleLabel: string;
  /** Human territory, e.g. "Giza" or "Helwan-Maadi". Never a bare code. */
  territory: string;
  /** Human line name, e.g. "CNS". Null when the subject spans lines. */
  lineName: string | null;
  hrId: string | null;
  isVacant: boolean;

  /** Every pound delivered in the window, targeted month or not. */
  actualValue: number;
  /**
   * The achievement's own NUMERATOR — pounds delivered in the months this subject was targeted in.
   *
   * 🔴 `actualValue / targetValue` IS NOT THE ACHIEVEMENT whenever the window holds a month that
   * carried sales and no target: the denominator drops that month and the numerator must drop it
   * too, or the percentage is measuring one set of months against another. Equal to `actualValue`
   * exactly when every active month was targeted, which is the ordinary case.
   *
   * It exists because a sheet that prints a figure beside a target invites the reader to divide the
   * pair, and the pair has to come out at the percentage printed above it.
   */
  gradedValue: number;
  /** Sum of targets over the months this subject was targeted in. Null when never targeted. */
  targetValue: number | null;
  /**
   * Percent, or null when the subject carries no target in the window at all.
   *
   * NEVER an average of monthly percentages — a percentage cannot be averaged across different
   * denominators. Computed once, from the sums.
   */
  achievement: number | null;
  /** Actual minus target. Null when there is no target to be over or under. */
  varianceValue: number | null;
  /**
   * WHICH months in the window carried a target for this subject, ascending — the months the
   * achievement is actually measured over.
   *
   * The hero sheet names these, never the window's own months. Naming the window would print "of
   * the monthly targets for June · July · August 2026" on a subject targeted only in July: three
   * months claimed, one of them measured, and a target asserted for two months where none was set.
   */
  targetedPeriods: PeriodKey[];
  /** How many months carried a target. Always `targetedPeriods.length`. */
  targetedMonths: number;
  /** Months in the window that carried any sales for this subject. */
  activeMonths: number;
};

export type SpotlightResult = {
  selection: SpotlightSelection;
  /** The months the window resolved to, ascending. */
  periods: PeriodKey[];
  /** "August 2026", "Q3 2026", "Semester 2 2026" — never "H2 2026" (owner, 2026-09-23). */
  windowLabel: string;
  headline: string;
  subheadline: string;
  /** The ranked shortlist, already cut to `limit`. */
  rows: SpotlightRow[];
  /** Every subject that survived the filters, before the cut — the denominator for "top 10 of N". */
  totalSubjects: number;
  /** Totals across the SHORTLIST, recomputed from sums rather than added percentages. */
  shortlistActualValue: number;
  shortlistTargetValue: number | null;
  shortlistAchievement: number | null;
  /** Subjects dropped from an achievement ranking because they carry no target at all. */
  untargetedSubjects: number;
  generatedAtCairo: string;
};
