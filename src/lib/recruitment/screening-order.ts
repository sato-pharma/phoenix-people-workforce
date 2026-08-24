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
  field_force: "Medical reps, district managers, area and regional managers — the jobs Phoenix hires into the field.",
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
  human_resources: "unrelated",
  medical_rep: "field_force",
  other: "unrelated",
  pharmacist: "pharma_adjacent",
  product_manager: "pharma_adjacent",
  sales: "sales",
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
};

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
export function screeningSortKey(input: ScreeningOrderInput): [number, number, number] {
  const band = screeningBand(input);
  // Confirmed pharma experience lifts a candidate within their band; an unanswered one sits in the
  // middle rather than at the bottom, so a data gap never costs somebody their place.
  const pharma = input.hasPharmaExperience === true ? 0 : input.hasPharmaExperience === null ? 1 : 2;
  const created = new Date(input.createdAt).getTime();
  return [bandRank[band], pharma, Number.isNaN(created) ? 0 : -created];
}

/**
 * Reorders a screening queue: best band first, pharma experience first inside it, newest first
 * inside that.
 *
 * Returns a NEW array. The caller's list is the visible table's own order and reordering it in
 * place would silently rearrange the page behind the reader.
 */
export function orderForScreening<T>(items: readonly T[], describe: (item: T) => ScreeningOrderInput): T[] {
  return [...items]
    .map((item, index) => ({ index, item, key: screeningSortKey(describe(item)) }))
    .sort((left, right) => {
      for (let i = 0; i < left.key.length; i += 1) {
        if (left.key[i] !== right.key[i]) return left.key[i] - right.key[i];
      }
      // Stable: equal keys keep the order the caller handed them in.
      return left.index - right.index;
    })
    .map((entry) => entry.item);
}

/** How many are in each band, for the one line that tells the screener what they are about to meet. */
export function countByBand<T>(items: readonly T[], describe: (item: T) => ScreeningOrderInput): Record<ScreeningBand, number> {
  const counts: Record<ScreeningBand, number> = { field_force: 0, pharma_adjacent: 0, sales: 0, unknown: 0, unrelated: 0, no_cv: 0 };
  for (const item of items) counts[screeningBand(describe(item))] += 1;
  return counts;
}
