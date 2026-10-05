// Phoenix Ranks — "why am I not number one, why am I number one". PURE.
//
// Owner, 2026-10-05: "everything is clear to the rep … why I am not number one, why I am number
// one, everything perfectly clear". So every sentence here is arithmetic the rep can check against
// the bars on the same page: each pillar is one Nth of the total (equal weights), so raising a
// pillar by P points raises the total by P / N, and the sentence says how many places that buys.
//
// Neutral wording throughout: the board speaks TO the rep ("you"), never about a "he".

import {
  RANK_PILLAR_LABELS,
  RANK_PILLARS,
  RANK_START_BONUS_MAX,
  scoredPillarCount,
  startBonusOf,
  startBonusPoints,
  type RankPillarKey,
  type RankStanding,
} from "@/lib/rep-ranks/scoring";

export type RankLever = {
  pillar: RankPillarKey;
  label: string;
  score: number;
  /** Points the TOTAL gains if this pillar reaches 100. */
  totalGain: number;
  /** The company position that gain alone would reach, or null when it changes nothing. */
  wouldReachPosition: number | null;
};

export type RankExplanation = {
  headline: string;
  lines: string[];
  levers: RankLever[];
  strengths: string[];
};

const round1 = (value: number): number => Math.round(value * 10) / 10;
const ORDINAL_SHARE: Record<number, string> = { 6: "sixth", 7: "seventh", 8: "eighth", 9: "ninth", 10: "tenth", 11: "eleventh", 12: "twelfth" };
/** "1 point", "9.3 points". */
const points = (value: number): string => (round1(value) === 1 ? "1 point" : `${round1(value)} points`);

function positionFor(total: number, others: readonly RankStanding[], self: RankStanding): number {
  let position = 1;
  for (const other of others) {
    if (other.hrIdKey === self.hrIdKey || !other.ranked || other.total === null) continue;
    if (other.total > total) position += 1;
  }
  return position;
}

/** The explanation one rep reads about one window. `standings` is the whole window, ranked. */
export function explainStanding(self: RankStanding, standings: readonly RankStanding[]): RankExplanation {
  if (!self.ranked || self.total === null || self.companyPosition === null) {
    return {
      headline: "Not ranked in this period",
      lines: ["A rep is ranked once the period holds enough days in the field to compare fairly."],
      levers: [],
      strengths: [],
    };
  }

  const scored = scoredPillarCount(self.pillars);
  const leader = standings.find((standing) => standing.ranked && standing.companyPosition === 1) ?? null;
  const above = standings.find((standing) => standing.ranked && standing.companyPosition === (self.companyPosition ?? 0) - 1) ?? null;

  const lines: string[] = [];
  const headline =
    self.companyPosition === 1
      ? `You are #1 of ${self.companyCount} in the company.`
      : `You are #${self.companyPosition} of ${self.companyCount} in the company.`;
  if (self.linePosition !== null) {
    lines.push(`#${self.linePosition} of ${self.lineCount} in ${self.lineName ?? "your line"}.`);
  }
  const bonus = startBonusOf(self.pillars);
  lines.push(
    `Your score is ${self.total.toFixed(1)}: the average of ${scored} measures, each worth the same (one ${ORDINAL_SHARE[scored] ?? `in ${scored}`} of the average)${
      bonus > 0 ? `, plus ${round1(bonus)} of the ${RANK_START_BONUS_MAX} AM start bonus points` : ""
    }.`,
  );

  if (self.companyPosition === 1) {
    const second = standings.find((standing) => standing.ranked && standing.companyPosition === 2) ?? null;
    if (second && second.total !== null) {
      lines.push(`You lead ${second.repName} by ${points(self.total - second.total)}.`);
    }
  } else {
    if (leader && leader.total !== null) {
      lines.push(`${leader.repName} leads with ${leader.total.toFixed(1)}, ${points(leader.total - self.total)} ahead of you.`);
    }
    if (above && above.total !== null && above !== leader) {
      lines.push(`${above.repName} is one place above you, ${points(above.total - self.total)} ahead.`);
    }
  }

  // Where the leader beats this rep, pillar by pillar — the honest answer to "why not number one".
  if (leader && leader.hrIdKey !== self.hrIdKey) {
    const behind = RANK_PILLARS.filter(({ key }) => {
      const mine = self.pillars[key];
      const theirs = leader.pillars[key];
      return mine !== null && theirs !== null && theirs > mine;
    }).map(({ key, bonus }) =>
      // The bonus is read in the points it adds, the way its bar prints it, never as a 0-100 score.
      bonus
        ? `${RANK_PILLAR_LABELS[key]} +${startBonusPoints(self.pillars[key]).toFixed(1)} against +${startBonusPoints(leader.pillars[key]).toFixed(1)} of ${RANK_START_BONUS_MAX}`
        : `${RANK_PILLAR_LABELS[key]} ${self.pillars[key]} against ${leader.pillars[key]}`,
    );
    if (behind.length > 0) lines.push(`Where #1 is ahead: ${behind.join(" · ")}.`);
  }

  const levers: RankLever[] = RANK_PILLARS.flatMap(({ key, bonus: isBonus }) => {
    const score = self.pillars[key];
    if (score === null || score >= 100) return [];
    // A measure is one Nth of the average; the AM start bonus adds its own share of 5 points.
    const gain = isBonus ? ((100 - score) / 100) * RANK_START_BONUS_MAX : (100 - score) / scored;
    const totalGain = round1(Math.min(gain, 100 - (self.total ?? 0)));
    if (totalGain <= 0) return [];
    const newTotal = Math.min(100, (self.total ?? 0) + gain);
    const reach = positionFor(newTotal, standings, self);
    return [
      {
        pillar: key,
        label: RANK_PILLAR_LABELS[key],
        score,
        totalGain,
        wouldReachPosition: reach < (self.companyPosition ?? reach) ? reach : null,
      },
    ];
  })
    .sort((a, b) => b.totalGain - a.totalGain)
    .slice(0, 3);

  const strengths = RANK_PILLARS.filter(({ key, bonus }) => !bonus && (self.pillars[key] ?? 0) >= 95).map(
    ({ key }) => `${RANK_PILLAR_LABELS[key]}: ${self.pillars[key]}`,
  );

  return { headline, lines, levers, strengths };
}

/** "Raising PM call rate from 64 to full marks adds 4.5 points — enough for #3." */
export function leverSentence(lever: RankLever): string {
  const reach = lever.wouldReachPosition ? ` That alone would put you at #${lever.wouldReachPosition}.` : "";
  if (RANK_PILLARS.some((pillar) => pillar.key === lever.pillar && pillar.bonus)) {
    return `Pressing I started working by 08:00 on every working day adds ${points(lever.totalGain)} to your score.${reach}`;
  }
  return `Raising ${lever.label} from ${lever.score} to 100 adds ${points(lever.totalGain)} to your score.${reach}`;
}
