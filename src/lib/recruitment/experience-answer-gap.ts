// Does the experience band an applicant chose on WhatsApp disagree with the years their CV counts?
//
// Owner, 2026-10-19 ("Flag CV vs WhatsApp gaps"): the pool shows both side by side — the band they
// tapped ("3 - 5 years") over the CV reader's count ("~12 yrs") — and a screener reading forty rows
// does not do that arithmetic for every one. Hossam Abdelrouf Abdelfattah answered "3 - 5 years"
// with a CV that counts about twelve: either the CV reader miscounted or the answer undersells him,
// and both are worth a phone call before he is sent anywhere.
//
// Pure, so the table cell, the phone card and the tests read one rule. It never says WHICH side is
// right — the CV count is hedged far more often than not — only that the two cannot both be.
//
// Experience only, on purpose. The other pairs answer different questions: the region they asked
// to WORK in against the address they LIVE at, and the discipline they named against the faculty
// on their degree. A difference there is normal, not a contradiction.

/** A band in years. `max` null means open-ended ("More than 5 years"). */
export type ExperienceBand = { max: number | null; min: number };

/**
 * A year either side of the band before it counts as a disagreement. The CV figure is the reader's
 * arithmetic over work-history dates, so "1 - 3 years" against 3.5 is rounding, not a contradiction.
 */
export const EXPERIENCE_GAP_TOLERANCE_YEARS = 1;

const NUMBER = String.raw`(\d+(?:\.\d+)?)`;

/**
 * The band an answer names, or null when it names none we can read. The bot's own five labels always
 * parse; an answer typed in by hand parses when it has the same shape, and anything else stays null
 * — an answer we cannot read is never flagged.
 */
export function experienceBandYears(answer: string | null | undefined): ExperienceBand | null {
  const text = String(answer ?? "").trim().toLowerCase();
  if (!text) return null;
  if (/fresh|no experience|^none$|^0$/.test(text)) return { max: 0, min: 0 };
  const less = text.match(new RegExp(String.raw`(?:less than|under|below|<)\s*${NUMBER}`));
  if (less) return { max: Number(less[1]), min: 0 };
  const more = text.match(new RegExp(String.raw`(?:more than|over|above|greater than|>)\s*${NUMBER}`));
  if (more) return { max: null, min: Number(more[1]) };
  const plus = text.match(new RegExp(String.raw`^${NUMBER}\s*\+`));
  if (plus) return { max: null, min: Number(plus[1]) };
  const range = text.match(new RegExp(String.raw`${NUMBER}\s*(?:-|–|—|to)\s*${NUMBER}`));
  if (range) {
    const [low, high] = [Number(range[1]), Number(range[2])].sort((a, b) => a - b);
    return { max: high, min: low };
  }
  const single = text.match(new RegExp(String.raw`^${NUMBER}\s*(?:years?|yrs?|y)?$`));
  if (single) return { max: Number(single[1]), min: Number(single[1]) };
  return null;
}

export type ExperienceAnswerGap = {
  band: ExperienceBand;
  /** "WhatsApp says "3 - 5 years"; the CV counts about 12 years." — the tooltip and the phone line. */
  explanation: string;
};

/** The short label on the flag itself. */
export const EXPERIENCE_GAP_LABEL = "CV differs";

function years(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return `${rounded} ${rounded === 1 ? "year" : "years"}`;
}

/**
 * The disagreement, or null when the two agree, either side is missing, or the answer names no band.
 * `cvYears` is the pool's years fact — the CV reader's count, or the recorded figure where one exists.
 */
export function experienceAnswerGap(
  declared: string | null | undefined,
  cvYears: number | null | undefined,
): ExperienceAnswerGap | null {
  if (typeof cvYears !== "number" || !Number.isFinite(cvYears) || cvYears < 0) return null;
  const band = experienceBandYears(declared);
  if (!band) return null;
  const tooFew = cvYears < band.min - EXPERIENCE_GAP_TOLERANCE_YEARS;
  const tooMany = band.max !== null && cvYears > band.max + EXPERIENCE_GAP_TOLERANCE_YEARS;
  if (!tooFew && !tooMany) return null;
  return {
    band,
    explanation: `WhatsApp says "${String(declared).trim()}"; the CV counts about ${years(cvYears)}. Check which is right before sending them on.`,
  };
}

/**
 * The same question asked of the pool's resolved facts — what the "CV differs" filter keeps. It takes
 * the facts rather than the candidate so this module stays free of the pool's types, and the filter
 * reads exactly the pair the row's flag reads.
 */
export function factsHaveExperienceGap(facts: {
  declaredExperience?: { value?: string | null } | null;
  years?: { value?: number | null } | null;
}): boolean {
  return experienceAnswerGap(facts.declaredExperience?.value, facts.years?.value) !== null;
}
