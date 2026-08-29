// Recruitment / ATS — the four facts a screener reads before deciding anything, and how sure we are
// of each.
//
// The pool has 426 people in it and the row that lists them answered almost none of the questions
// screening is made of. Measured against production 2026-08-24, what a reader could see was: the
// name, an email and a phone, one guessed role, a status that says "New" on 406 of the 426 rows, a
// timestamp, and the channel it arrived on. Not the job they hold, not where they live, not how
// long they have worked, not who they work for. So every single CV had to be opened to learn
// anything, which is exactly the "I would rather use WhatsApp" the owner reported.
//
// The facts were not missing. They were read off the CV and then declined at the write gate:
//
//   | fact                    | on the candidate row | read off the CV but NOT written |
//   | ----------------------- | -------------------- | ------------------------------- |
//   | total years' experience |                  120 |                             117 |
//   | current employer        |                  148 |                              73 |
//   | current job title       |                  177 |                              44 |
//   | worked as a medical rep |                  360 |                              14 |
//   | governorate             |                  267 |                               2 |
//
// **Every one of those 250 declined values carries `confidence: "low"`** — checked, not assumed;
// the split is 100/0. So `selectAutoApplyFields` is not broken and this module does not try to
// route around it: a hedged value must never be written into a column that the rest of the system
// reads as fact, and rule 13 of the extraction prompt tells the model exactly that ("a low is
// treated downstream as though you had not answered").
//
// What was missing was the middle tier. A fact here could be CONFIRMED or it could not exist, and
// nothing in between — so a number the AI worked out of someone's work history and honestly hedged
// was paid for, stored, and then shown to nobody, forever. This module adds that tier, and only
// that: `confirmed` says which side of the line a value came from, every screen that shows an
// unconfirmed one marks it, and nothing here writes anything anywhere.
//
// The pattern is not new — "Applying for" has drawn a stated role in black and a derived one in
// italic grey since 2026-08-21. This extends the same, already-understood convention to the other
// four facts rather than inventing a second vocabulary for the same idea.

import {
  candidateRegionCodes,
  candidateRegionForGovernorate,
  candidateRegionLabels,
  type CandidateRegionCode,
} from "@/lib/recruitment/candidate-region";
import { candidateRoleFamilyOrNull, type CandidateRoleFamily } from "@/lib/recruitment/candidate-role-family";
import { cleanEmployerName } from "@/lib/recruitment/employer-name";

/**
 * One screening fact, plus whether it is safe to read as settled.
 *
 * `confirmed: true` means it came off the candidate's own column — typed by a person, or applied by
 * intake because the CV reader was confident. `confirmed: false` means it is the CV reader's hedged
 * answer, shown because a hedged answer beats a blank cell but never presented as settled.
 */
export type ScreeningFact<T> = { confirmed: boolean; value: T };

/**
 * The CV reader's LOW-confidence answers for one candidate — the values `selectAutoApplyFields`
 * correctly refused to write. All optional: a candidate with no CV read, or whose reader was
 * confident about everything, simply has none.
 */
export type CandidateUnconfirmedCvFacts = {
  currentEmployer?: string | null;
  currentJobTitle?: string | null;
  governorate?: string | null;
  hasMedicalRepExperience?: boolean | null;
  yearsExperience?: number | null;
};

/** Just enough of a candidate to read the facts off. Structural, so `types.ts` need not import this. */
export type ScreeningFactsCandidateRow = {
  currentEmployer?: string | null;
  currentJobTitle?: string | null;
  cvUnconfirmed?: CandidateUnconfirmedCvFacts | null;
  governorate?: string | null;
  hasMedicalRepExperience?: boolean | null;
  /** The area the applicant tapped or typed on WhatsApp. There is no other source for this. */
  preferredAreaName?: string | null;
  /** The region code the applicant TAPPED — one of `candidateRegionCodes`, or nothing. */
  preferredRegionCode?: string | null;
  /** What they TYPED when their region was not on the list. A place name, not a region label. */
  preferredRegionName?: string | null;
  yearsExperience?: number | null;
};

export type CandidateScreeningFacts = {
  /**
   * The area the applicant asked to work in, in their own words.
   *
   * There is no second source for this and no way to derive it: a CV states where somebody LIVES,
   * never which of the company's areas they want. So this is present only for an applicant who
   * answered the WhatsApp questions, and absent for everyone else — which is a true statement
   * about what we know, not a gap to fill with a guess.
   */
  area: ScreeningFact<string> | null;
  employer: ScreeningFact<string> | null;
  governorate: ScreeningFact<string> | null;
  /** Worked as a medical rep. `false` is an answer, not an absence — see the boolean note below. */
  pharmaRep: ScreeningFact<boolean> | null;
  /**
   * The company region to file this candidate under, by the company's own map — never geography's.
   *
   * `declared` is the difference between "they told us" and "we worked it out from the address on
   * their CV". Both are shown the same way, because both are the best answer available, but the
   * tooltip has to be able to say which — a screener who cannot tell an applicant's own choice
   * from an inference has no way to know which one is safe to act on.
   *
   * `code` is null for a region somebody TYPED that maps to nothing we recognise. The label still
   * shows their words; the code stays null so the Region filter files them under Unknown rather
   * than quietly dropping them into whichever region sorts first.
   */
  region: ScreeningFact<{ code: string | null; declared: boolean; label: string }> | null;
  roleTitle: ScreeningFact<string> | null;
  years: ScreeningFact<number> | null;
};

function text(raw: string | null | undefined): string | null {
  const value = String(raw ?? "").trim();
  return value.length > 0 ? value : null;
}

/**
 * The column first, the hedged CV read second, nothing invented.
 *
 * Order is the whole point and it never varies: a confirmed value always wins, so a later CV read
 * can never contradict what a person typed or what intake already accepted. The fallback only ever
 * fills a hole.
 */
function pick<T>(confirmed: T | null | undefined, unconfirmed: T | null | undefined): ScreeningFact<T> | null {
  if (confirmed !== null && confirmed !== undefined) return { confirmed: true, value: confirmed };
  if (unconfirmed !== null && unconfirmed !== undefined) return { confirmed: false, value: unconfirmed };
  return null;
}

/**
 * A number that can honestly be printed as years of experience.
 *
 * Rejects NaN and negatives, and caps at 60: the CV reader derives this by counting work-history
 * dates, and a mis-parsed year ("2001" read as a duration) is the failure mode that produces a
 * "2001 yrs" cell. Nobody in this pool has worked for more than six decades.
 */
const LONGEST_PLAUSIBLE_CAREER_YEARS = 60;

function years(raw: number | null | undefined): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  if (raw < 0 || raw > LONGEST_PLAUSIBLE_CAREER_YEARS) return null;
  return raw;
}

/**
 * The region the applicant asked for in their own words, or null when they never answered.
 *
 * THIS OUTRANKS EVERYTHING ELSE, and the reason is worth stating plainly: every other source for
 * a candidate's region answers a different question. A CV's governorate says where somebody LIVES;
 * this says where they want to WORK, which is the question a screener is actually asking. A person
 * living in Cairo who asked for Alex-BHR is an Alex-BHR candidate, and inferring Cairo from their
 * address would contradict the only party who knows.
 *
 * Two shapes arrive, because the menu has an escape. A TAPPED region is a code straight off
 * `candidateRegionCodes` and needs no interpretation. A TYPED one is free text from "My region is
 * not listed", and in production it is a PLACE — "Minya", "Minia Government ( Minia North )" — not
 * a region label, so it goes through the same governorate map the CV path uses, which resolves both
 * of those to Upper Egypt. Where that map has no answer the code stays null and their words are
 * shown verbatim: the Region filter then files them under Unknown, which is true, instead of
 * guessing a region for somebody who told us theirs was not on our list.
 *
 * The stored code is validated rather than trusted. It is a plain text column, so a value that is
 * not a live region code would otherwise index `candidateRegionLabels` to undefined and render an
 * empty cell that looks exactly like "no answer".
 */
function declaredRegion(
  candidate: ScreeningFactsCandidateRow,
): { code: string | null; declared: boolean; label: string } | null {
  const tapped = text(candidate.preferredRegionCode);
  if (tapped && (candidateRegionCodes as readonly string[]).includes(tapped)) {
    const code = tapped as CandidateRegionCode;
    return { code, declared: true, label: candidateRegionLabels[code] };
  }
  const typed = text(candidate.preferredRegionName);
  if (!typed) return null;
  const recovered = candidateRegionForGovernorate(typed);
  return recovered
    ? { code: recovered, declared: true, label: candidateRegionLabels[recovered] }
    : { code: null, declared: true, label: typed };
}

/**
 * Everything the screening row and the profile header show, resolved once.
 *
 * Booleans get their own branch because `false` is a real answer here — "has not worked as a medical
 * rep" is a finding, not a blank — so the usual falsy check would throw it away and show the
 * candidate as unanswered. That is the same trap the pool's experience FILTER already documents.
 */
export function candidateScreeningFacts(candidate: ScreeningFactsCandidateRow): CandidateScreeningFacts {
  const cv = candidate.cvUnconfirmed ?? {};

  const governorate = pick(text(candidate.governorate), text(cv.governorate));
  const derivedRegionCode = governorate ? candidateRegionForGovernorate(governorate.value) : null;
  const asked = declaredRegion(candidate);
  const areaName = text(candidate.preferredAreaName);

  const confirmedPharma = typeof candidate.hasMedicalRepExperience === "boolean" ? candidate.hasMedicalRepExperience : null;
  const unconfirmedPharma = typeof cv.hasMedicalRepExperience === "boolean" ? cv.hasMedicalRepExperience : null;

  return {
    // Always settled when present: a person tapped or typed it, and there is nothing to hedge
    // against because no other source offers an area at all.
    area: areaName ? { confirmed: true, value: areaName } : null,
    // Both sides go through the same guard. A junk value typed into the column is still junk on
    // the card: the confirmed/hedged split says how SURE we are of a fact, not whether it is one.
    employer: pick(cleanEmployerName(candidate.currentEmployer), cleanEmployerName(cv.currentEmployer)),
    governorate,
    pharmaRep: pick<boolean>(confirmedPharma, unconfirmedPharma),
    // The applicant's own answer, then the CV. Note the asymmetry in `confirmed`: a declared
    // region is always settled, because a person tapped it, whereas a derived one inherits the
    // governorate's confidence and stays hedged when the CV reader was hedging.
    region: asked
      ? { confirmed: true, value: asked }
      : derivedRegionCode
        ? {
            confirmed: governorate!.confirmed,
            value: { code: derivedRegionCode, declared: false, label: candidateRegionLabels[derivedRegionCode] },
          }
        : null,
    roleTitle: pick(text(candidate.currentJobTitle), text(cv.currentJobTitle)),
    years: pick(years(candidate.yearsExperience), years(cv.yearsExperience)),
  };
}

/**
 * The role family to file a candidate under, and it must be the SAME answer the row displays.
 *
 * This exists because the two disagreed, and the disagreement was invisible. The Role filter read
 * `currentJobTitle` alone while the row's "Applying for" cell read a six-rung evidence ladder, so a
 * candidate could sit on screen reading "District Sales Manager, Alexandria" and still be missing
 * from the District Manager filter — which is precisely what happened to Mahmoud Refaat Selim in
 * production on 2026-08-24: title on the row NULL, the cell showing the role off his email subject,
 * and the one filter built to find him blind to him.
 *
 * `currentJobTitle` alone classified 177 of 426. Adding the CV reader's hedged title takes it to
 * 221, and falling through to the resolved "Applying for" text — the thing already on screen —
 * takes it to what the reader can actually see. Anything that names no known family lands in
 * "Other" rather than null, which is honest: we DO have a string for that person, it just is not a
 * job we recruit for. Null stays reserved for "nobody ever told us", which is a different claim and
 * the reason `candidateRoleFamilyOrNull` exists at all.
 */
export function candidateScreeningRoleFamily(
  facts: CandidateScreeningFacts,
  appliedForText: string | null | undefined,
): CandidateRoleFamily | null {
  return candidateRoleFamilyOrNull(facts.roleTitle?.value ?? text(appliedForText));
}

/** "12 yrs", "6.9 yrs", "8 mo" — a decimal year under 1 reads as nonsense in years. */
export function formatYearsOfExperience(value: number): string {
  if (value < 1) {
    const months = Math.round(value * 12);
    return months <= 0 ? "<1 mo" : `${months} mo`;
  }
  // One decimal only when there is one, so a whole number never reads "8.0 yrs".
  const rounded = Math.round(value * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)} yrs`;
}

/** The hover text that says, in words, why a value is in grey rather than black. */
export const UNCONFIRMED_FACT_TITLE =
  "Read off the CV, but the reader was not confident — check it against the CV before relying on it.";

/**
 * The same five hedged answers, read out of a CV extraction the caller already has in hand.
 *
 * The pool gets them from `listCandidates`, which fetches five jsonb paths for the whole page. The
 * profile panel is the other way round: it is already holding the WHOLE extraction it just loaded,
 * so paying for a second read there would be absurd. Both end at this one shape, and both agree on
 * what "hedged" means, because that decision lives here rather than in each caller.
 *
 * `confidence: "low"` only — a "high" value is already on the column, and reading it here would
 * print the same fact twice, once as settled and once as a guess.
 */
export function unconfirmedCvFactsFromExtraction(
  fields: Record<string, { confidence?: unknown; value?: unknown }> | null | undefined,
): CandidateUnconfirmedCvFacts {
  const low = (key: string): unknown => {
    const field = fields?.[key];
    return field && field.confidence === "low" ? (field.value ?? null) : null;
  };
  const pharma = low("hasMedicalRepExperience");
  const experience = low("yearsExperience");
  return {
    currentEmployer: text(low("currentEmployer") as string | null),
    currentJobTitle: text(low("currentJobTitle") as string | null),
    governorate: text(low("governorate") as string | null),
    hasMedicalRepExperience: typeof pharma === "boolean" ? pharma : null,
    yearsExperience: typeof experience === "number" ? experience : null,
  };
}
