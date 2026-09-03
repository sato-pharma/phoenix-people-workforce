/**
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE NATIONALITY THE PAPERS PRINT
 *
 * The owner set this default on 2026-09-03, after the readiness board measured what was actually
 * standing between 108 employees and a printable contract: nationality was blank on 107 of them,
 * and not because 107 things had gone wrong. Only 5 people in the company had a hiring profile row
 * at all, and exactly one of those had a nationality on it. It was one default nobody had set, not
 * a hundred data-entry tasks.
 *
 * A DEFAULT, NEVER A WRITE. Nothing is stored against anybody: `resolveNationality` answers at the
 * moment a paper is drawn, so a recorded value always wins and no employee record is given a fact
 * about them that a person did not enter. `profilePayload` in `paper-fields.ts` deliberately keeps
 * the raw value for the same reason — the save path must not turn a default into stored data the
 * next time HR touches an unrelated field.
 *
 * WHY IT IS SAFE, AND WHERE IT IS NOT. Recruitment is Egyptian nationals only, so مصري is right for
 * essentially everybody who reaches an employee record. But it is not a certainty:
 * `recruitment/nationality.ts` exists precisely because the candidate pool has held Pakistani,
 * Sudanese and Syrian applicants, and a contract is an instrument somebody signs. So the default is
 * reported as DERIVED on the readiness board rather than applied silently, and the gap it used to
 * raise is kept as a non-blocking advisory — HR is still told the value was never recorded, they
 * are simply no longer stopped from printing because of it.
 *
 * ARABIC INFLECTS IT FOR GENDER, and the first cut of this module did not. مصري is masculine;
 * مصرية is the same nationality for a woman. The masculine form was therefore going onto the
 * contract and the Form 1 of every woman in the company — 41 of the 94 employees with a readable
 * national ID. The owner asked for it to be derived from the ID (2026-09-03); measuring first
 * showed `employees.gender` is the better primary source, so it leads and the ID backs it up.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */

import { derivedSexFromNationalId, type EgyptianSex } from "@/lib/hiring-pack/national-id";

/**
 * مصري — the owner's answer, 2026-09-03. Arabic, because it is printed on Arabic papers.
 *
 * ALSO THE FALLBACK when sex is unknown, which is why it is the unsuffixed name. Not a claim that
 * masculine is the neutral form — Arabic has no neutral form here — just the one the owner named.
 */
export const DEFAULT_NATIONALITY_AR = "مصري";

/** مصرية — the same nationality for a woman. Arabic inflects it; English does not. */
export const DEFAULT_NATIONALITY_AR_FEMALE = "مصرية";

/**
 * The spellings `employees.gender` is written in.
 *
 * Production holds exactly `male` and `female` (lowercased on write by `employee-directory.ts`,
 * measured across all 106 active employees who carry one). The Arabic and single-letter forms are
 * defensive — an import or a hand edit is the likely source of anything else, and an unrecognised
 * value must fall through to the ID rather than being read as a third sex.
 */
const FEMALE_SPELLINGS = new Set(["female", "f", "أنثى", "انثى"]);
const MALE_SPELLINGS = new Set(["male", "m", "ذكر"]);

/**
 * Which of the two Arabic forms this person's papers need.
 *
 * ORDER MATTERS, AND IT IS THE HOUSE RULE: a value a person entered beats a value a machine read.
 * `employees.gender` is the wider source anyway — 106 of 125 active employees carry one against 94
 * with a readable national ID — and where both exist they agreed in 93 of 93, so the ID is a
 * backstop rather than a second opinion to reconcile.
 *
 * Null means neither source answered. That is 18 people on production, every one of whom has no
 * national ID at all and is therefore already blocked from printing any paper — so the masculine
 * fallback below is currently unreachable, and exists for correctness rather than for use.
 */
export function resolveSexForPapers(sources: {
  gender?: string | null;
  nationalId?: string | null;
}): EgyptianSex | null {
  const stated = String(sources.gender ?? "").trim().toLowerCase();
  if (FEMALE_SPELLINGS.has(stated)) return "female";
  if (MALE_SPELLINGS.has(stated)) return "male";
  return derivedSexFromNationalId(sources.nationalId);
}

/**
 * The nationality to print, and whether it came from the record or from the default.
 *
 * A blank-but-present value ("", "   ") counts as unrecorded: a spreadsheet import leaves those
 * behind constantly and a form printing a space where a nationality belongs is the same defect as
 * one printing nothing.
 *
 * A RECORDED nationality is printed exactly as recorded and is never re-gendered. If somebody typed
 * مصري for a woman that is a typo to fix in the record, not something to correct at print time —
 * the same reason `national-id.ts` reports a birth-date conflict instead of resolving it.
 */
export function resolveNationality(
  recorded: string | null | undefined,
  sexSources: { gender?: string | null; nationalId?: string | null } = {},
): {
  readonly value: string;
  readonly defaulted: boolean;
} {
  const stated = String(recorded ?? "").trim();
  if (stated) return { value: stated, defaulted: false };

  const sex = resolveSexForPapers(sexSources);
  return {
    value: sex === "female" ? DEFAULT_NATIONALITY_AR_FEMALE : DEFAULT_NATIONALITY_AR,
    defaulted: true,
  };
}
