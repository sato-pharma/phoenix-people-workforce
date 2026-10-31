// Recruitment / ATS — the order a human should meet the pool in.
//
// The pool itself lists newest-first and must keep doing so: 152 rows arrived in the last seven
// days, and a CV that landed an hour ago must not be buried under one from March. That rule is
// about the TABLE, which is a record of what came in.
//
// Screening is a different job. Measured on production 2026-08-24, of the 382 undecided real CVs
// only about 53 are field-force shaped at all — 25 medical reps, 18 district managers, 10 area or
// regional. 137 are in unrelated fields entirely: accountants, teachers, mechanical procurement.
// Meeting those in arrival order means wading through seven strangers to reach one candidate, four
// hundred times over, which is the measured reason screening this pool costs an evening.
//
// So the QUEUE is ordered by who is worth meeting first, while the table it was built from is left
// exactly as it was. Nothing is hidden and nothing is auto-rejected — every candidate is still in
// the queue and still gets a human decision. Only the order changes.

import type { CandidateRating } from "@/lib/recruitment/candidate-rating";
import { type CandidateRegionCode } from "@/lib/recruitment/candidate-region";
import { type CandidateRoleFamily } from "@/lib/recruitment/candidate-role-family";
import { isNotACv } from "@/lib/recruitment/not-a-cv";

/**
 * The four groups, best first.
 *
 * `unknown` sits ABOVE `unrelated` deliberately, and it is the band worth explaining. A candidate
 * whose family could not be worked out is not a weak candidate — it is a candidate the ROW cannot
 * speak for, so only a human reading the CV can settle it. Burying those behind 137 accountants
 * would mean the one group that genuinely needs a person is the group nobody ever reaches.
 *
 * `sales` sits between the pharma bands and `unknown`, and it exists because neither neighbour
 * could hold it honestly. `pharma_adjacent` would claim these people are in pharma, which nothing
 * on their CV says; `unrelated` would file a Sales Representative beside an accountant, when
 * selling IS the job Phoenix is hiring for and only the industry differs. Its own band lets the
 * screener see that distinction instead of being told a wrong sentence about it.
 *
 * `no_cv` is last, and is the band that is NOT about the candidate at all. The extractor already
 * read that file and answered "this is not a CV" — a photographed certificate, a diploma, an
 * experience letter. That is a settled fact, so those rows do not belong in `unknown`, which
 * means "only a person can judge this". Measured on production 2026-08-25, 27 of the 67 sitting
 * in `unknown` were in exactly that state: a quarter of the band promoted for needing a human
 * needed no human at all, and each one cost a full open-read-and-decide before the screener
 * could see there was nothing to read.
 */
export const screeningBands = ["field_force", "pharma_adjacent", "sales", "unknown", "unrelated", "no_cv"] as const;

export type ScreeningBand = (typeof screeningBands)[number];

export const screeningBandLabels: Record<ScreeningBand, string> = {
  field_force: "Field force",
  pharma_adjacent: "Pharma, other roles",
  sales: "Sales, other industries",
  unknown: "Needs a read",
  unrelated: "Other fields",
  no_cv: "No CV to read",
};

/** One line each, shown to the screener so the order is never a mystery. */
export const screeningBandDescriptions: Record<ScreeningBand, string> = {
  field_force:
    "Medical reps, district managers, area and regional managers, national sales managers — the jobs Phoenix hires into the field.",
  pharma_adjacent: "Pharmacists and product managers — pharma people, but not a field-force job.",
  sales: "Sales and business development, with nothing on the CV saying pharma. The job is the same shape; the industry is not.",
  unknown: "No job title could be read off the CV, so only a person can judge these.",
  unrelated: "Their title says a different industry — HR, finance, engineering and so on.",
  no_cv: "The file they sent is a certificate or a letter, not a CV. There is nothing here to read.",
};

const bandByFamily: Record<CandidateRoleFamily, ScreeningBand> = {
  area_regional_manager: "field_force",
  district_manager: "field_force",
  finance: "unrelated",
  // HR Section Head (added 2026-10-06): `unrelated` beside human_resources — an HR leader's CV speaks
  // to no field-force or pharma read, and a title WAS read, so it is not `unknown`.
  hr_section_head: "unrelated",
  human_resources: "unrelated",
  medical_rep: "field_force",
  // Field force, not `sales`: an NSM runs the field organisation. Before this family existed all 7
  // of them fell through to the `sales` catch-all and sorted BELOW every medical rep.
  national_sales_manager: "field_force",
  // The office/admin seat at head office (added 2026-09-02 with the Sheraton Office Coordinator
  // opening). `unrelated` sits beside human_resources and finance for the same reason: it is a real
  // Phoenix job, but nothing on that CV speaks to a field-force or pharma read, so a screener gets
  // through the reps first. It is NOT `unknown` — a title WAS read, and knowing it is an office job
  // is itself the useful fact.
  office_coordinator: "unrelated",
  other: "unrelated",
  // Personnel Specialist (added 2026-10-31): `unrelated` beside human_resources for the same reason —
  // a personnel CV speaks to no field-force or pharma read. A title WAS read, so it is not `unknown`.
  personnel: "unrelated",
  pharmacist: "pharma_adjacent",
  product_manager: "pharma_adjacent",
  sales: "sales",
  // Talent Acquisition (added 2026-09-22). `unrelated` beside human_resources for the same reason:
  // a recruiter's CV speaks to no field-force or pharma read, so a screener gets through the reps
  // first. A title WAS read, so it is not `unknown`.
  talent_acquisition: "unrelated",
};

/**
 * Which band a resolved family belongs to. `null` — nobody could work out a family — is `unknown`,
 * which is NOT the same as the `other` family: `other` means a title was read and it was something
 * else, and that is a fact worth acting on.
 */
export function screeningBandForFamily(family: CandidateRoleFamily | null): ScreeningBand {
  return family === null ? "unknown" : bandByFamily[family];
}

const bandRank: Record<ScreeningBand, number> = {
  field_force: 0,
  pharma_adjacent: 1,
  sales: 2,
  unknown: 3,
  unrelated: 4,
  no_cv: 5,
};

export type ScreeningOrderInput = {
  /** ISO timestamp. Ties inside a band are broken newest-first, the same rule the table uses. */
  createdAt: string;
  /**
   * The star somebody put on this CV, 1 to 3, or null for the overwhelming majority nobody has.
   *
   * THE TOP KEY OF THE WHOLE ORDER — above the band, above pharma experience, above everything
   * this module works out for itself. That is the point of it, and it is a deliberate inversion:
   * every other rank here is DERIVED, and a star is a person saying "this one". A human who has
   * read the document outranks a rule that has read the columns, and the owner asked for stars
   * precisely so the ones he likes rise to the top rather than sitting wherever the band put them.
   *
   * It only ever moves CVs somebody actually starred. Unrated sorts exactly where it always did,
   * which is most of the pile.
   */
  rating?: CandidateRating | null;
  family: CandidateRoleFamily | null;
  /**
   * Whether this person has worked as a medical rep. `null` means nobody has answered, which must
   * NOT be scored as "no" — 66 production rows are in that state and folding them into the bottom
   * of their band would punish a candidate for a gap in our own data.
   */
  hasPharmaExperience: boolean | null;
  /**
   * True only when a read is on record and it said the file is not a CV. Absent or false means
   * nobody has judged it, which is a different claim — see `isNotACv`.
   */
  notACv?: boolean;
  /**
   * Where this person is, for the region filter. `null` means no region could be worked out — 73 of
   * the 534 undecided rows measured 2026-09-04 — and those are shown under their own chip rather
   * than being quietly dropped from every region a screener might pick.
   *
   * Resolved by the CALLER, deliberately. The pure `candidateRegionForGovernorate` reaches 453 of
   * 534; the free-text address reader adds 8 more and would pull the whole Egypt place vocabulary
   * into the client bundle for them. Eight rows in an honest "no region" bucket is the better deal.
   */
  region?: CandidateRegionCode | null;
  /**
   * Groups CVs that are probably the same person — the phone number, in practice.
   *
   * Same key does NOT assert same person, and nothing here merges anything. Measured on production
   * 2026-09-04, 28 undecided rows share a phone with another row, and 9 of those carry a DIFFERENT
   * name: a mother and daughter, two colleagues, one handset. Collapsing on the number alone would
   * silently discard three real applicants. So the key only makes those rows land NEXT TO each
   * other, where a screener can see both names at once and decide — which is the part that was
   * actually costing time, since the two copies used to sit hundreds of rows apart.
   */
  duplicateKey?: string | null;
  /**
   * Years of experience, or `null` when nobody has read one off the CV — 296 of 534 undecided rows.
   * Bucketed, never used as a raw number: see `experienceRank`.
   */
  yearsExperience?: number | null;
};

/**
 * Three buckets, not a number line.
 *
 * The figure is extracted from a CV, so ordering on the exact value would imply a precision the
 * data has not got — "7.4 years" beating "7.1 years" is noise, not seniority. Three buckets is what
 * an extracted number can honestly support.
 *
 * UNKNOWN SHARES THE MIDDLE BUCKET, and that is the whole point. 296 of 534 undecided rows have no
 * figure at all; ranking them below everyone with a number would demote more than half the pool for
 * a gap in OUR data, and ranking them above would invent seniority nobody claimed. The middle is
 * the only honest place, and it is the same rule `hasPharmaExperience` already follows.
 */
export function experienceRank(years: number | null | undefined): number {
  if (years === null || years === undefined || !Number.isFinite(years)) return 1;
  if (years >= 5) return 0;
  if (years >= 2) return 1;
  return 2;
}

/**
 * The band a candidate actually lands in.
 *
 * Checked BEFORE the family, because "there is no CV here" outranks anything a title might have
 * said: a certificate that happens to carry the words "Medical Representative" is still not a CV,
 * and putting it at the front of the queue would be the worst possible use of the ordering.
 */
export function screeningBand(input: ScreeningOrderInput): ScreeningBand {
  if (isNotACv({ notACv: input.notACv })) return "no_cv";
  return screeningBandForFamily(input.family);
}

/**
 * Sort key, lowest first. Exported for the test, and because a caller that wants to show WHY a
 * candidate is where they are needs the same numbers the sort used.
 */
export function screeningSortKey(
  input: ScreeningOrderInput,
): [number, number, number, number, number] {
  const band = screeningBand(input);
  // Confirmed pharma experience lifts a candidate within their band; an unanswered one sits in the
  // middle rather than at the bottom, so a data gap never costs somebody their place.
  const pharma = input.hasPharmaExperience === true ? 0 : input.hasPharmaExperience === null ? 1 : 2;
  const created = new Date(input.createdAt).getTime();
  // Experience sits BELOW pharma and ABOVE recency, and the order of those three is the argument.
  // Pharma experience is the thing Phoenix is actually hiring for, so it stays first. Recency drops
  // to last because within one band, meeting the 12-year rep before the 1-year rep is worth more
  // than meeting the one who applied on Tuesday before the one who applied on Monday.
  // NEGATED, because this key sorts lowest-first: three stars is -3 and leads, unrated is 0 and
  // keeps the place the rest of the key gives it. Never a positive number, so an unstarred CV is
  // never pushed BELOW where it would have been without the feature.
  // Written as a branch rather than `-(input.rating ?? 0)`, which produces NEGATIVE ZERO for an
  // unrated CV. It sorts identically — but `Object.is(-0, 0)` is false, so a strict assertion that
  // an unstarred CV scores exactly 0 would fail against a key that is behaving perfectly. A number
  // nobody can compare by equality is a trap left for the next person, not a clever saving.
  const star = input.rating ? -input.rating : 0;
  return [
    star,
    bandRank[band],
    pharma,
    experienceRank(input.yearsExperience),
    Number.isNaN(created) ? 0 : -created,
  ];
}

/**
 * Reorders a screening queue: best band first, pharma experience first inside it, then the more
 * experienced, then newest — and finally any near-duplicate pulled up beside its best-ranked twin.
 *
 * Returns a NEW array. The caller's list is the visible table's own order and reordering it in
 * place would silently rearrange the page behind the reader.
 */
export function orderForScreening<T>(items: readonly T[], describe: (item: T) => ScreeningOrderInput): T[] {
  // `describe` is resolved ONCE per item and carried through both passes. It reads the candidate's
  // facts, and calling it inside the clustering scan instead would make this quadratic — 534 rows
  // is ~285,000 reads for a list that re-renders on every keystroke.
  const sorted = items
    .map((item, index) => ({ described: describe(item), index, item }))
    .map((entry) => ({ ...entry, key: screeningSortKey(entry.described) }))
    .sort((left, right) => {
      for (let i = 0; i < left.key.length; i += 1) {
        if (left.key[i] !== right.key[i]) return left.key[i] - right.key[i];
      }
      // Stable: equal keys keep the order the caller handed them in.
      return left.index - right.index;
    });

  // Then, and only then, make the duplicates adjacent.
  //
  // This runs AFTER the sort rather than inside it so a duplicate can never drag its twin up the
  // queue: the best-ranked member keeps exactly the place the ranking gave it, and the others are
  // lifted to sit behind it. Everybody else's relative order is untouched, which is why this is
  // safe to do to a list a person is reading.
  const followers = new Map<string, T[]>();
  for (const entry of sorted) {
    const key = duplicateKeyOf(entry.described);
    if (key === null) continue;
    const group = followers.get(key);
    if (group) group.push(entry.item);
    else followers.set(key, []); // the first one keeps its own place; only the rest follow it
  }

  const emitted = new Set<string>();
  const clustered: T[] = [];
  for (const entry of sorted) {
    const key = duplicateKeyOf(entry.described);
    if (key === null) {
      clustered.push(entry.item);
      continue;
    }
    if (emitted.has(key)) continue; // already emitted, next to its twin
    emitted.add(key);
    clustered.push(entry.item, ...(followers.get(key) ?? []));
  }
  return clustered;
}

/** The grouping key, or `null` when there is nothing to group on. Blank is not a key. */
function duplicateKeyOf(input: ScreeningOrderInput): string | null {
  const key = String(input.duplicateKey ?? "").trim();
  return key ? key : null;
}

/**
 * The near-duplicate sets, so the screen can say "2 CVs from this number" and show the other names.
 *
 * Only keys with more than one member come back. Showing the OTHER NAMES is not decoration: it is
 * the whole difference between "they uploaded twice" and "two people share a handset", and only a
 * person can tell those apart — which is why this reports and never merges.
 */
export function duplicateSets<T>(items: readonly T[], describe: (item: T) => ScreeningOrderInput): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = duplicateKeyOf(describe(item));
    if (key === null) continue;
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  for (const [key, group] of groups) if (group.length < 2) groups.delete(key);
  return groups;
}

/** The chip a candidate belongs under in the region filter. */
export const NO_REGION = "none" as const;

export type ScreeningRegionKey = CandidateRegionCode | typeof NO_REGION;

export function screeningRegionKey(input: ScreeningOrderInput): ScreeningRegionKey {
  return input.region ?? NO_REGION;
}

/**
 * How many candidates sit in each region, for the filter chips.
 *
 * Counted over the WHOLE queue rather than the filtered view, so the chips do not change under the
 * reader's hand as they narrow — a count that only tells you about what you can already see is not
 * a count anybody can act on.
 */
export function countByRegion<T>(
  items: readonly T[],
  describe: (item: T) => ScreeningOrderInput,
): Map<ScreeningRegionKey, number> {
  const counts = new Map<ScreeningRegionKey, number>();
  for (const item of items) {
    const key = screeningRegionKey(describe(item));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * Narrow a queue to one region. `null` means no filter and returns the list unchanged.
 *
 * A filter, never a sort. Ordering by region would fight the band order for control of the top of
 * the queue and leave a screener meeting a weak local candidate before a strong one an hour away;
 * picking a region is a decision the screener makes, not one the ranking should make for them.
 */
export function filterByRegion<T>(
  items: readonly T[],
  describe: (item: T) => ScreeningOrderInput,
  region: ScreeningRegionKey | null,
): readonly T[] {
  if (region === null) return items;
  return items.filter((item) => screeningRegionKey(describe(item)) === region);
}

/** How many are in each band, for the one line that tells the screener what they are about to meet. */
export function countByBand<T>(items: readonly T[], describe: (item: T) => ScreeningOrderInput): Record<ScreeningBand, number> {
  const counts: Record<ScreeningBand, number> = { field_force: 0, pharma_adjacent: 0, sales: 0, unknown: 0, unrelated: 0, no_cv: 0 };
  for (const item of items) counts[screeningBand(describe(item))] += 1;
  return counts;
}
