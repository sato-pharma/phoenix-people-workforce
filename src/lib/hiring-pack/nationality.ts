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
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */

/** مصري — the owner's answer, 2026-09-03. Arabic, because it is printed on Arabic papers. */
export const DEFAULT_NATIONALITY_AR = "مصري";

/**
 * The nationality to print, and whether it came from the record or from the default.
 *
 * A blank-but-present value ("", "   ") counts as unrecorded: a spreadsheet import leaves those
 * behind constantly and a form printing a space where a nationality belongs is the same defect as
 * one printing nothing.
 */
export function resolveNationality(recorded: string | null | undefined): {
  readonly value: string;
  readonly defaulted: boolean;
} {
  const stated = String(recorded ?? "").trim();
  if (stated) return { value: stated, defaulted: false };
  return { value: DEFAULT_NATIONALITY_AR, defaulted: true };
}
