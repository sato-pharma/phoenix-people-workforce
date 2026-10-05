// Phoenix Ranks — the military rank ladder and the stars. PURE.
//
// Owner, 2026-10-05: "like the ranks in the army … his rank, and everyone sees he has two or three
// stars". He chose the Egyptian army ladder, in Arabic.
//
// THE RANK IS EARNED, NOT DRAWN: it reads the rep's ROLLING score — the mean of the last three
// months' totals — so one bad day never demotes anyone and one good day never promotes anyone. The
// thresholds are absolute, not a quota, so every rep can read exactly how far promotion is.
//
// THE STARS are titles: each time a rep finishes #1 of the company or #1 of the line in a CLOSED
// month, quarter or semester. Day and week wins are medals on the profile, counted apart.

export type RankInsignia =
  | { kind: "none" }
  | { kind: "chevrons"; count: number }
  | { kind: "stars"; count: number }
  | { kind: "eagle"; stars: number }
  | { kind: "eagle-swords" };

export type MilitaryRank = {
  /** 0 = the lowest. */
  level: number;
  arabic: string;
  english: string;
  /** The rolling score at which this rank begins. */
  minScore: number;
  insignia: RankInsignia;
};

export const RANK_LADDER: readonly MilitaryRank[] = [
  { level: 0, arabic: "جندي", english: "Private", minScore: 0, insignia: { kind: "none" } },
  { level: 1, arabic: "عريف", english: "Corporal", minScore: 40, insignia: { kind: "chevrons", count: 1 } },
  { level: 2, arabic: "رقيب", english: "Sergeant", minScore: 50, insignia: { kind: "chevrons", count: 2 } },
  { level: 3, arabic: "رقيب أول", english: "Staff Sergeant", minScore: 58, insignia: { kind: "chevrons", count: 3 } },
  { level: 4, arabic: "ملازم", english: "Second Lieutenant", minScore: 64, insignia: { kind: "stars", count: 1 } },
  { level: 5, arabic: "ملازم أول", english: "First Lieutenant", minScore: 70, insignia: { kind: "stars", count: 2 } },
  { level: 6, arabic: "نقيب", english: "Captain", minScore: 76, insignia: { kind: "stars", count: 3 } },
  { level: 7, arabic: "رائد", english: "Major", minScore: 82, insignia: { kind: "eagle", stars: 0 } },
  { level: 8, arabic: "مقدم", english: "Lieutenant Colonel", minScore: 87, insignia: { kind: "eagle", stars: 1 } },
  { level: 9, arabic: "عقيد", english: "Colonel", minScore: 91, insignia: { kind: "eagle", stars: 2 } },
  { level: 10, arabic: "عميد", english: "Brigadier", minScore: 95, insignia: { kind: "eagle", stars: 3 } },
  { level: 11, arabic: "لواء", english: "Major General", minScore: 98, insignia: { kind: "eagle-swords" } },
];

/** Months that make up the rolling score. */
export const RANK_ROLLING_MONTHS = 3;

export function rankForScore(score: number | null): MilitaryRank {
  if (score === null || !Number.isFinite(score)) return RANK_LADDER[0];
  let rank = RANK_LADDER[0];
  for (const candidate of RANK_LADDER) if (score >= candidate.minScore) rank = candidate;
  return rank;
}

export function nextRank(rank: MilitaryRank): MilitaryRank | null {
  return RANK_LADDER[rank.level + 1] ?? null;
}

/**
 * The rolling score: the mean of the most recent ranked month totals, newest first, at most three.
 * A running month counts — it is the freshest evidence — so a rep reads the effect of this month at
 * once. Null when no month has ranked the rep yet.
 */
export function rollingScore(monthTotalsNewestFirst: readonly (number | null)[]): number | null {
  const ranked = monthTotalsNewestFirst.filter((value): value is number => value !== null).slice(0, RANK_ROLLING_MONTHS);
  if (ranked.length === 0) return null;
  return Math.round((ranked.reduce((sum, value) => sum + value, 0) / ranked.length) * 100) / 100;
}

/** "Captain begins at 76 · Major at 82 — 3.6 points to promotion." */
export function promotionSentence(score: number | null): string {
  if (score === null) return "A rank is earned after the first ranked month.";
  const rank = rankForScore(score);
  const next = nextRank(rank);
  if (!next) return `${rank.english} is the highest rank. Every point above ${rank.minScore} keeps it.`;
  const gap = Math.max(0, Math.round((next.minScore - score) * 10) / 10);
  return `${next.english} (${next.arabic}) begins at ${next.minScore}: ${gap} ${gap === 1 ? "point" : "points"} to promotion.`;
}

export type RankTitle = {
  windowKind: "day" | "week" | "month" | "quarter" | "semester";
  windowKey: string;
  windowLabel: string;
  scope: "company" | "line";
};

/** Stars = month, quarter and semester titles (company or line #1) in CLOSED windows. */
export function starCount(titles: readonly RankTitle[]): number {
  return titles.filter((title) => title.windowKind === "month" || title.windowKind === "quarter" || title.windowKind === "semester").length;
}
