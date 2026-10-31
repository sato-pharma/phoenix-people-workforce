// THE TEAM COACHING SKILLS SURVEY'S ARITHMETIC — the formulas of "Team Skills Survey 2026 (1).xlsx",
// one for one (owner, 2026-10-31: "the results are automated"). Pure and client-safe: the screens,
// the API and the tests all call these, so a figure on the page is the figure the workbook would
// have shown for the same ratings.
//
//   Survey!P   Average (0-5)       = AVERAGE of the rated skills; an empty skill is left out, 0 counts
//   Calc!D     Experience score    = MIN(5, years / full-experience years x 5)
//   Calc!E     Overall score       = weight x capability average + (1 - weight) x experience score,
//                                    or the capability average alone when the years are empty
//   Ranking!J  Performance level   = >= target "At or above target"; >= target - 1 "Developing";
//                                    otherwise "Priority for coaching"
//   Analysis   per skill           = AVERAGE, COUNT, share <= 2, share >= 4, MAX(0, target - avg),
//                                    High when the gap >= 1, Medium when > 0, else On target;
//                                    RANK ascending (lowest average = 1, ties share a rank)
//   Analysis!B5 Overall average    = AVERAGE over every single rating (not the row averages)
//   by district / by band          = AVERAGEIF over the row averages; bands are [from, to)
//
// One deliberate difference: the workbook breaks a tie in the ranking by row order. A web page has no
// row order, so a tie goes to the higher capability average, then the name.
// Pinned by tests/coaching-skills-survey-calculations.test.ts.

import {
  skillsSurveyDefaultExperienceBands,
  skillsSurveyPerformanceLevels,
  skillsSurveyTrainingPriorities,
  type SkillsSurveyPerformanceLevel,
  type SkillsSurveyTrainingPriority,
} from "@/lib/coaching/skills-survey/vocabulary";

export const skillsSurveyMinScore = 0;
export const skillsSurveyMaxScore = 5;

export type SkillsSurveySkill = {
  key: string;
  name: string;
  goodLooksLike: string;
  displayOrder: number;
  isActive: boolean;
};

export type SkillsSurveyExperienceBand = {
  label: string;
  from: number;
  to: number;
};

export type SkillsSurveySettings = {
  targetScore: number;
  capabilityWeight: number;
  fullExperienceYears: number;
  experienceBands: SkillsSurveyExperienceBand[];
};

export const skillsSurveyDefaultSettings: SkillsSurveySettings = {
  capabilityWeight: 0.8,
  experienceBands: skillsSurveyDefaultExperienceBands.map((band) => ({ ...band })),
  fullExperienceYears: 5,
  targetScore: 4,
};

/** skill key -> 0..5. A skill that is not in the object was not observed. */
export type SkillsSurveyScores = Record<string, number>;

/** One saved survey, as every calculation below reads it. */
export type SkillsSurveyEntry = {
  id: string;
  memberHrId: string;
  memberName: string;
  districtName: string | null;
  raterHrId: string;
  raterName: string;
  yearsInRole: number | null;
  scores: SkillsSurveyScores;
  developmentPriorities: string | null;
  surveyDate: string;
  surveyYear: number;
  surveyQuarter: number;
  updatedAt: string | null;
};

function isScore(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= skillsSurveyMinScore && value <= skillsSurveyMaxScore;
}

/**
 * The scores a client sent, made safe to store: only known skills, only whole numbers 0 to 5. An
 * empty value (null, undefined, "") is "not observed" and is dropped; anything else is refused, so a
 * bad rating can never be saved as a silent zero.
 */
export function normalizeSkillsSurveyScores(input: unknown, allowedKeys: ReadonlySet<string>): SkillsSurveyScores {
  if (input === null || input === undefined) return {};
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Ratings must be sent as one score per skill.");
  }
  const scores: SkillsSurveyScores = {};
  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    if (!allowedKeys.has(key)) throw new Error(`Unknown skill: ${key}.`);
    if (raw === null || raw === undefined || raw === "") continue;
    const value = typeof raw === "string" ? Number(raw) : raw;
    if (!isScore(value)) throw new Error("Enter a whole number from 0 to 5, or leave the skill as Not observed.");
    scores[key] = value;
  }
  return scores;
}

/** A stored `scores` object read back defensively — anything that is not a 0..5 whole number is ignored. */
export function readSkillsSurveyScores(value: unknown): SkillsSurveyScores {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const scores: SkillsSurveyScores = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const numeric = typeof raw === "string" ? Number(raw) : raw;
    if (isScore(numeric)) scores[key] = numeric;
  }
  return scores;
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Survey!P — Average (0-5). */
export function capabilityAverage(scores: SkillsSurveyScores): number | null {
  return mean(Object.values(scores).filter(isScore));
}

const millisecondsPerDay = 86_400_000;
const daysPerYear = 365.25;

function dayNumber(isoDate: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate);
  if (!match) return null;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / millisecondsPerDay;
}

/**
 * Years in Role on a given day: HR's total years plus the time since HR typed them, to one
 * decimal. Empty when HR has not filled the field.
 */
export function yearsInRoleOn(
  totalExperienceYears: number | null | undefined,
  totalExperienceAsOf: string | null | undefined,
  onDate: string,
): number | null {
  if (totalExperienceYears === null || totalExperienceYears === undefined || !Number.isFinite(totalExperienceYears)) {
    return null;
  }
  const from = totalExperienceAsOf ? dayNumber(totalExperienceAsOf) : null;
  const to = dayNumber(onDate);
  const elapsedYears = from !== null && to !== null && to > from ? (to - from) / daysPerYear : 0;
  return Math.round((totalExperienceYears + elapsedYears) * 10) / 10;
}

/** Calc!D — Experience score. */
export function experienceScore(yearsInRole: number | null, settings: SkillsSurveySettings): number | null {
  if (yearsInRole === null || !Number.isFinite(yearsInRole) || settings.fullExperienceYears <= 0) return null;
  return Math.min(skillsSurveyMaxScore, (yearsInRole / settings.fullExperienceYears) * skillsSurveyMaxScore);
}

/** Calc!E — Overall score (0-5). */
export function overallScore(
  capability: number | null,
  experience: number | null,
  settings: SkillsSurveySettings,
): number | null {
  if (capability === null) return null;
  if (experience === null) return capability;
  return settings.capabilityWeight * capability + (1 - settings.capabilityWeight) * experience;
}

/** Ranking!J — Performance level. */
export function performanceLevel(score: number | null, targetScore: number): SkillsSurveyPerformanceLevel | null {
  if (score === null) return null;
  if (score >= targetScore) return skillsSurveyPerformanceLevels.atOrAboveTarget;
  if (score >= targetScore - 1) return skillsSurveyPerformanceLevels.developing;
  return skillsSurveyPerformanceLevels.priorityForCoaching;
}

export type SkillsSurveyScoreCard = {
  capabilityAverage: number | null;
  experienceScore: number | null;
  overallScore: number | null;
  performanceLevel: SkillsSurveyPerformanceLevel | null;
};

export function scoreSkillsSurveyEntry(
  entry: Pick<SkillsSurveyEntry, "scores" | "yearsInRole">,
  settings: SkillsSurveySettings,
): SkillsSurveyScoreCard {
  const capability = capabilityAverage(entry.scores);
  const experience = experienceScore(entry.yearsInRole, settings);
  const overall = overallScore(capability, experience, settings);
  return {
    capabilityAverage: capability,
    experienceScore: experience,
    overallScore: overall,
    performanceLevel: performanceLevel(overall, settings.targetScore),
  };
}

export type SkillsSurveyRankingRow = SkillsSurveyScoreCard & {
  entry: SkillsSurveyEntry;
  overallRank: number;
  capabilityRank: number;
};

function byName(left: SkillsSurveyEntry, right: SkillsSurveyEntry) {
  return left.memberName.localeCompare(right.memberName);
}

/**
 * The Ranking sheet. Only a survey with at least one rating is ranked (the sheet's Calc!G is blank
 * for a row with no average). Highest overall score first.
 */
export function buildSkillsSurveyRanking(
  entries: readonly SkillsSurveyEntry[],
  settings: SkillsSurveySettings,
): SkillsSurveyRankingRow[] {
  const scored = entries
    .map((entry) => ({ entry, ...scoreSkillsSurveyEntry(entry, settings) }))
    .filter((row): row is typeof row & { capabilityAverage: number; overallScore: number } =>
      row.capabilityAverage !== null && row.overallScore !== null,
    );

  const capabilityOrder = [...scored].sort(
    (left, right) => right.capabilityAverage - left.capabilityAverage || byName(left.entry, right.entry),
  );
  const capabilityRankById = new Map(capabilityOrder.map((row, index) => [row.entry.id, index + 1]));

  return [...scored]
    .sort(
      (left, right) =>
        right.overallScore - left.overallScore ||
        right.capabilityAverage - left.capabilityAverage ||
        byName(left.entry, right.entry),
    )
    .map((row, index) => ({
      ...row,
      capabilityRank: capabilityRankById.get(row.entry.id) ?? index + 1,
      overallRank: index + 1,
    }));
}

export type SkillsSurveySkillAnalysisRow = {
  skill: SkillsSurveySkill;
  rank: number | null;
  averageScore: number | null;
  ratingsCount: number;
  shareRatedLow: number | null;
  shareRatedHigh: number | null;
  gapToTarget: number | null;
  trainingPriority: SkillsSurveyTrainingPriority;
};

export type SkillsSurveyAnalysis = {
  targetScore: number;
  teamMembersRated: number;
  overallAverage: number | null;
  skills: SkillsSurveySkillAnalysisRow[];
};

function trainingPriority(gap: number | null): SkillsSurveyTrainingPriority {
  if (gap === null) return skillsSurveyTrainingPriorities.noData;
  if (gap >= 1) return skillsSurveyTrainingPriorities.high;
  if (gap > 0) return skillsSurveyTrainingPriorities.medium;
  return skillsSurveyTrainingPriorities.onTarget;
}

function ratingsFor(entries: readonly SkillsSurveyEntry[], skillKey: string): number[] {
  const ratings: number[] = [];
  for (const entry of entries) {
    const value = entry.scores[skillKey];
    if (isScore(value)) ratings.push(value);
  }
  return ratings;
}

/**
 * The skills an analysis shows: every active skill in the Training Manager's order, plus any
 * turned-off skill that still carries ratings in these surveys, so an old rating is never hidden.
 */
export function skillsForAnalysis(
  skills: readonly SkillsSurveySkill[],
  entries: readonly SkillsSurveyEntry[],
): SkillsSurveySkill[] {
  const rated = new Set(entries.flatMap((entry) => Object.keys(entry.scores)));
  return [...skills]
    .filter((skill) => skill.isActive || rated.has(skill.key))
    .sort((left, right) => left.displayOrder - right.displayOrder);
}

/** Excel's RANK(value, range, 1): ascending, ties share the lower rank. */
function ascendingRank(value: number, values: readonly number[]): number {
  return values.filter((other) => other < value).length + 1;
}

/** The Analysis sheet's TNA summary. */
export function buildSkillsSurveyAnalysis(
  entries: readonly SkillsSurveyEntry[],
  skills: readonly SkillsSurveySkill[],
  settings: SkillsSurveySettings,
): SkillsSurveyAnalysis {
  const shown = skillsForAnalysis(skills, entries);
  const rows = shown.map((skill) => {
    const ratings = ratingsFor(entries, skill.key);
    const average = mean(ratings);
    const count = ratings.length;
    const gap = average === null ? null : Math.max(0, settings.targetScore - average);
    return {
      averageScore: average,
      gapToTarget: gap,
      rank: null as number | null,
      ratingsCount: count,
      shareRatedHigh: count === 0 ? null : ratings.filter((value) => value >= 4).length / count,
      shareRatedLow: count === 0 ? null : ratings.filter((value) => value <= 2).length / count,
      skill,
      trainingPriority: trainingPriority(gap),
    };
  });

  const averages = rows.flatMap((row) => (row.averageScore === null ? [] : [row.averageScore]));
  for (const row of rows) {
    row.rank = row.averageScore === null ? null : ascendingRank(row.averageScore, averages);
  }

  const everyRating = entries.flatMap((entry) => Object.values(entry.scores).filter(isScore));
  return {
    overallAverage: mean(everyRating),
    skills: rows,
    targetScore: settings.targetScore,
    teamMembersRated: entries.length,
  };
}

export type SkillsSurveyGroupAverageRow = {
  label: string;
  teamMembers: number;
  overallAverage: number | null;
  skillAverages: Record<string, number | null>;
};

function groupAverages(
  label: string,
  entries: readonly SkillsSurveyEntry[],
  skills: readonly SkillsSurveySkill[],
): SkillsSurveyGroupAverageRow {
  const rowAverages = entries.flatMap((entry) => {
    const average = capabilityAverage(entry.scores);
    return average === null ? [] : [average];
  });
  return {
    label,
    overallAverage: mean(rowAverages),
    skillAverages: Object.fromEntries(skills.map((skill) => [skill.key, mean(ratingsFor(entries, skill.key))])),
    teamMembers: entries.length,
  };
}

/** "Average score by district" — the districts come from the surveys, never typed in. */
export function buildSkillsSurveyDistrictAverages(
  entries: readonly SkillsSurveyEntry[],
  skills: readonly SkillsSurveySkill[],
): SkillsSurveyGroupAverageRow[] {
  const shown = skillsForAnalysis(skills, entries);
  const byDistrict = new Map<string, SkillsSurveyEntry[]>();
  for (const entry of entries) {
    const district = entry.districtName?.trim() || "No district";
    byDistrict.set(district, [...(byDistrict.get(district) ?? []), entry]);
  }
  return [...byDistrict.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([district, group]) => groupAverages(district, group, shown));
}

/** "Average score by experience band" — From (included) up to To (not included). */
export function buildSkillsSurveyExperienceBandAverages(
  entries: readonly SkillsSurveyEntry[],
  skills: readonly SkillsSurveySkill[],
  settings: SkillsSurveySettings,
): Array<SkillsSurveyGroupAverageRow & { from: number; to: number }> {
  const shown = skillsForAnalysis(skills, entries);
  return settings.experienceBands.map((band) => {
    const group = entries.filter(
      (entry) => entry.yearsInRole !== null && entry.yearsInRole >= band.from && entry.yearsInRole < band.to,
    );
    return { ...groupAverages(band.label, group, shown), from: band.from, to: band.to };
  });
}

/** A Cairo calendar date's quarter. */
export function skillsSurveyQuarterOf(isoDate: string): { year: number; quarter: number } {
  const match = /^(\d{4})-(\d{2})/.exec(isoDate);
  if (!match) throw new Error("A valid date is required.");
  return { quarter: Math.floor((Number(match[2]) - 1) / 3) + 1, year: Number(match[1]) };
}

export function skillsSurveyQuarterLabel(year: number, quarter: number): string {
  return `Q${quarter} ${year}`;
}

export function skillsSurveyQuarterKey(year: number, quarter: number): string {
  return `${year}-Q${quarter}`;
}

export function parseSkillsSurveyQuarterKey(value: string | null | undefined): { year: number; quarter: number } | null {
  const match = /^(\d{4})-Q([1-4])$/.exec(String(value ?? "").trim());
  return match ? { quarter: Number(match[2]), year: Number(match[1]) } : null;
}

/** A survey can be saved only inside the quarter it belongs to. */
export function isSkillsSurveyQuarterOpen(year: number, quarter: number, todayIso: string): boolean {
  const today = skillsSurveyQuarterOf(todayIso);
  return today.year === year && today.quarter === quarter;
}

/** The Training Manager's settings, checked before they are stored. */
export function normalizeSkillsSurveySettings(input: Partial<SkillsSurveySettings>, current: SkillsSurveySettings): SkillsSurveySettings {
  const targetScore = input.targetScore ?? current.targetScore;
  const capabilityWeight = input.capabilityWeight ?? current.capabilityWeight;
  const fullExperienceYears = input.fullExperienceYears ?? current.fullExperienceYears;
  if (!Number.isFinite(targetScore) || targetScore < 0 || targetScore > 5) {
    throw new Error("The target score must be a number from 0 to 5.");
  }
  if (!Number.isFinite(capabilityWeight) || capabilityWeight < 0 || capabilityWeight > 1) {
    throw new Error("The capability weight must be from 0% to 100%.");
  }
  if (!Number.isFinite(fullExperienceYears) || fullExperienceYears <= 0 || fullExperienceYears > 60) {
    throw new Error("The years for full experience score must be more than 0 and at most 60.");
  }
  const bands = (input.experienceBands ?? current.experienceBands).map((band) => ({
    from: Number(band.from),
    label: String(band.label ?? "").trim(),
    to: Number(band.to),
  }));
  if (bands.length === 0) throw new Error("Keep at least one experience band.");
  for (const band of bands) {
    if (!band.label) throw new Error("Every experience band needs a name.");
    if (!Number.isFinite(band.from) || !Number.isFinite(band.to) || band.from < 0 || band.to <= band.from) {
      throw new Error(`The band "${band.label}" must run from a lower number of years to a higher one.`);
    }
  }
  return {
    capabilityWeight: Math.round(capabilityWeight * 1000) / 1000,
    experienceBands: bands,
    fullExperienceYears: Math.round(fullExperienceYears * 10) / 10,
    targetScore: Math.round(targetScore * 10) / 10,
  };
}

/** A skill key made from a new skill's name: lower case, underscores, never colliding with one in use. */
export function skillsSurveySkillKeyFor(name: string, existingKeys: ReadonlySet<string>): string {
  const base =
    name
      .toLowerCase()
      .replace(/&/g, " ")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 50) || "skill";
  let key = base;
  let suffix = 2;
  while (existingKeys.has(key)) {
    key = `${base}_${suffix}`;
    suffix += 1;
  }
  return key;
}

export function formatSkillsSurveyScore(value: number | null | undefined, digits = 2): string {
  return value === null || value === undefined || !Number.isFinite(value) ? "" : value.toFixed(digits);
}

export function formatSkillsSurveyShare(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value) ? "" : `${Math.round(value * 100)}%`;
}
