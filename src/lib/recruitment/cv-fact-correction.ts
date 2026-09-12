// Recruitment / ATS — proposing a CORRECTION to a candidate fact that is already stored.
//
// WHY THIS EXISTS, AND WHY IT IS NOT selectAutoApplyFields.
//
// cv-auto-apply.ts fills gaps and never overwrites (its gate 4). That is the right rule for every
// inbound CV, and it must stay. But it means a fact the extractor got WRONG is permanent: the
// column is populated, so every later re-read declines to touch it. On 2026-09-11 the owner found
// four such classes while screening vacant-area CVs — a graduation year taken from the START of an
// ongoing degree, experience inflated by internships, the CV headline stored as the current job,
// and a governorate contradicting the address. #3729 fixed the extractor. It could not fix the
// rows already written, because nothing in the system is allowed to overwrite them.
//
// This module is that missing half, deliberately kept narrow. It PROPOSES; it writes nothing. The
// job that consumes it is dry-run by default and the owner approves the diff.
//
// THE GATES, and the measured reason for each. A blanket "new value wins" was tried against
// production on 2026-09-12 and rejected: re-deriving current_job_title from stored work history
// returned 120 open candidates, and the replacements included "Marketing Manager" -> "best",
// "Chemist" -> "Chemist." and a district manager demoted to his own oldest job. Every gate below
// exists to refuse one of those.
//
//  1. CORRECTABLE_KEYS only — the four fact classes, never identity. full_name, email, phone and
//     national_id are excluded permanently: they decide dedupe, and the _norm indexes behind them
//     are app-maintained (AGENTS.md). A correction job must not be able to repoint one person's
//     record at another.
//  2. High confidence only. The extractor's own hedge is respected, exactly as auto-apply does.
//  3. A DECLARED answer always wins. Where the applicant answered on WhatsApp, that is the owner's
//     source of truth — the CV guess never overwrites it, whatever the confidence.
//  4. Cosmetic differences are NOT corrections. Trailing punctuation, case and collapsed whitespace
//     are normalised away before comparing. This is the gate that removed most of the 120.
//  5. A populated column is never blanked, with ONE opt-in exception: graduationYear, where null is
//     the correct answer for a degree still in progress. It is the whole point of pattern 1, so it
//     is allowed — but only when explicitly enabled, never as a side effect.
//
// GATES 6-8 were added on 2026-09-12 after the first free preview over production. Gates 1-5 let
// 182 proposals through, and a triage of that sheet found most of them were not corrections at all:
//
//  6. Experience drift is not a correction. 40 of the 82 yearsExperience proposals moved the number
//     by LESS THAN A YEAR — 7.7 -> 7.8, 18 -> 18.1, 23 -> 23.2. That is the calendar, not a repair:
//     experience accrues between one reading and the next, so a re-read of an unchanged CV always
//     disagrees slightly with what was stored. Below a year the two are indistinguishable.
//  7. A governorate spelled differently is the same governorate. 16 of the 22 governorate proposals
//     were transliteration — "Sharqia" -> "Sharkia", "Dakahlia" -> "Ad Daqahliyah", "Menoufia" ->
//     "Menofia", "Beheira" -> "Elbehaira". Applying those would have replaced the app's canonical
//     spelling with a variant: worse than doing nothing. resolveGovernorate is the one place that
//     vocabulary lives (a fourth copy is forbidden), so both sides are resolved through it.
//  8. An employer is not a job title. Six currentJobTitle proposals offered an organisation where a
//     role belongs — "Community Pharmacist" -> "Dr. Tarek ElTohamy Pharmacy", "Senior Accountant"
//     -> "Madawa Pharmaceutical Company". That is the owner's original defect 3 (the CV headline
//     stored as the job) reappearing inside the PROPOSAL, so the correction path must refuse it.

import { resolveGovernorate } from "@/lib/geo/egypt-locations";
import { getCvPositionSchema } from "@/lib/recruitment/cv-field-schemas";
import { cvFieldColumn } from "@/lib/recruitment/cv-field-storage";
import type { ExtractedCandidateFields, ExtractedCvValue } from "@/lib/recruitment/cv-extraction-fields";

/**
 * The only four fields this job may correct. Adding a key here is a deliberate decision about a
 * fact class whose stored value has been proven wrong at scale — not a convenience.
 */
export const CORRECTABLE_KEYS: readonly string[] = [
  "graduationYear",
  "yearsExperience",
  "currentJobTitle",
  "governorate",
];

/**
 * Keys whose stored value came from the applicant's own WhatsApp answer when
 * `preferences_declared_at` is set. A CV reading never overwrites one of these.
 *
 * governorate is here because the declared region/area is what the folder and region filter run
 * on; currentJobTitle because `applied_for_job_title` is written from the applicant's own answer
 * and the two are read side by side when screening.
 */
const DECLARED_BACKED_KEYS: ReadonlySet<string> = new Set(["governorate", "currentJobTitle"]);

export type FactCorrection = {
  readonly key: string;
  readonly column: string;
  readonly from: ExtractedCvValue;
  readonly to: ExtractedCvValue;
  /** Why this one is being proposed — carried into the owner's review sheet verbatim. */
  readonly reason: string;
};

/**
 * Cosmetic normalisation for the "is this really a different answer?" test.
 *
 * Lower-cases, collapses runs of whitespace, and strips trailing punctuation. "Chemist" and
 * "Chemist." collapse to one string, so the pair is not proposed as a correction. Deliberately
 * does NOT strip internal punctuation: "Chemist / Medical Representative" is a genuinely different
 * answer from "Chemist" and must stay visible.
 */
export function normalizeFactForComparison(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return String(value);
  if (typeof value !== "string") return null;
  const collapsed = value.trim().replace(/\s+/g, " ").replace(/[.,;:،؛]+$/u, "").trim();
  return collapsed.length === 0 ? null : collapsed.toLowerCase();
}

/**
 * Whether two values say the same thing once cosmetics are removed.
 *
 * Numbers compare numerically so that 3 and 3.0 are one answer — years_experience is `numeric`,
 * and a string/number mismatch across the jsonb boundary is otherwise read as a change.
 */
export function saysTheSameThing(a: unknown, b: unknown): boolean {
  const numericA = typeof a === "number" ? a : typeof a === "string" && a.trim() !== "" ? Number(a) : NaN;
  const numericB = typeof b === "number" ? b : typeof b === "string" && b.trim() !== "" ? Number(b) : NaN;
  if (Number.isFinite(numericA) && Number.isFinite(numericB)) return numericA === numericB;
  return normalizeFactForComparison(a) === normalizeFactForComparison(b);
}

/**
 * The smallest change in years of experience that can be a CORRECTION rather than the calendar.
 *
 * A CV read in March and re-read in September yields a larger number for the same work history,
 * because the most recent job is still running. Anything under a year is that drift. The defect
 * this job exists for — a fresh graduate credited with years of experience — is never this small.
 */
export const MIN_EXPERIENCE_YEARS_CHANGE = 1;

/** Gate 6 — a sub-year move in years of experience is the clock, not a repair. */
export function isExperienceDrift(current: unknown, proposed: unknown): boolean {
  const from = toFiniteNumber(current);
  const to = toFiniteNumber(proposed);
  if (from === null || to === null) return false;
  return Math.abs(to - from) < MIN_EXPERIENCE_YEARS_CHANGE;
}

/**
 * Gate 7 — whether two spellings name the same Egyptian governorate.
 *
 * Both sides go through `resolveGovernorate`, the single vocabulary for Egyptian place names
 * (AGENTS.md forbids a second copy). When either side resolves to nothing the answer is false, so
 * an unrecognisable value never silently suppresses a real disagreement.
 */
export function namesTheSameGovernorate(a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = resolveGovernorate(a);
  const right = resolveGovernorate(b);
  if (left === null || right === null) return false;
  return left === right;
}

/**
 * Words that mark a string as the name of an ORGANISATION rather than a role. Kept deliberately
 * short and unambiguous: every one of these names a place of work, never a job.
 */
const EMPLOYER_MARKERS =
  /\b(pharmacy|pharmacies|hospital|clinic|company|co\.|corp|corporation|ltd|llc|inc|group|center|centre|factory|laboratories|labs|institute|university|college|school)\b|صيدلي(?:ة|ه)|مستشفى|شرك(?:ة|ه)|معمل|مصنع|جامع(?:ة|ه)|مركز|عياد(?:ة|ه)/iu;

/**
 * Gate 8 — whether a proposed job title is really an employer.
 *
 * True only when the PROPOSAL carries an organisation marker and the stored value does not: that is
 * the direction that makes the record worse. A candidate whose stored title already names their
 * employer is left alone, because the proposal is then no worse than what is there.
 */
export function looksLikeAnEmployerNotARole(current: unknown, proposed: unknown): boolean {
  if (typeof proposed !== "string") return false;
  if (!EMPLOYER_MARKERS.test(proposed)) return false;
  if (typeof current === "string" && EMPLOYER_MARKERS.test(current)) return false;
  return true;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export type FactCorrectionInput = {
  readonly extractedFields: ExtractedCandidateFields | null | undefined;
  readonly positionKey: string;
  /** The candidate row, camelCase as the app carries it. */
  readonly candidate: Record<string, unknown>;
  /** True when `preferences_declared_at` is set — the applicant answered on WhatsApp. */
  readonly hasDeclaredPreferences: boolean;
  /**
   * Allow graduationYear to be cleared when the CV shows the degree is still in progress.
   * Off by default: blanking a populated column is the one destructive shape here, so it is
   * never a side effect of running the job.
   */
  readonly allowClearingGraduationYear?: boolean;
};

/**
 * The corrections a re-read proposes for one candidate. Returns [] when there is nothing to do,
 * which is the common case and lets the caller skip the row entirely.
 */
export function selectFactCorrections(input: FactCorrectionInput): FactCorrection[] {
  const schema = getCvPositionSchema(input.positionKey);
  if (!schema || !input.extractedFields) return [];

  const corrections: FactCorrection[] = [];

  for (const key of CORRECTABLE_KEYS) {
    const definition = schema.fields.find((field) => field.key === key);
    if (!definition || definition.storage !== "column") continue;

    const column = cvFieldColumn(key);
    if (!column) continue;

    const proposal = input.extractedFields[key];
    if (!proposal) continue;

    const current = input.candidate[camelCaseOf(column)] ?? input.candidate[key] ?? null;

    // Gate 3 — the applicant's own answer is the owner's source of truth.
    if (input.hasDeclaredPreferences && DECLARED_BACKED_KEYS.has(key)) continue;

    // Gate 5 — clearing a populated column. graduationYear is the single opt-in exception,
    // because "this degree is still in progress, so there is no graduation year" is precisely
    // the defect being repaired; every other key simply declines.
    if (proposal.value === null || proposal.value === undefined) {
      if (key !== "graduationYear") continue;
      if (input.allowClearingGraduationYear !== true) continue;
      if (current === null || current === undefined) continue;
      if (proposal.confidence !== "high") continue;
      corrections.push({
        key,
        column,
        from: current as ExtractedCvValue,
        to: null,
        reason: "the CV shows this degree is still in progress, so it has produced no graduation year",
      });
      continue;
    }

    // Gate 2 — the extractor's own hedge.
    if (proposal.confidence !== "high") continue;

    // A scalar column never takes an array; the correctable four are all scalars.
    if (Array.isArray(proposal.value)) continue;

    // Nothing stored yet is a GAP, not a correction — cv-auto-apply.ts owns that case, and
    // letting both write the same column would make provenance unreadable.
    if (current === null || current === undefined || (typeof current === "string" && current.trim() === "")) continue;

    // Gate 4 — cosmetic differences are not corrections.
    if (saysTheSameThing(current, proposal.value)) continue;

    // Gate 6 — a sub-year move in experience is the calendar, not a repair.
    if (key === "yearsExperience" && isExperienceDrift(current, proposal.value)) continue;

    // Gate 7 — the same governorate spelled another way is not a correction, and writing the
    // variant over the canonical spelling would be a regression.
    if (key === "governorate" && namesTheSameGovernorate(current, proposal.value)) continue;

    // Gate 8 — an employer name is never a job title.
    if (key === "currentJobTitle" && looksLikeAnEmployerNotARole(current, proposal.value)) continue;

    if (definition.type === "number" && typeof proposal.value !== "number") continue;
    if (definition.type === "string" && typeof proposal.value !== "string") continue;

    corrections.push({
      key,
      column,
      from: current as ExtractedCvValue,
      to: proposal.value,
      reason: `the CV reads "${String(proposal.value)}" where the record holds "${String(current)}"`,
    });
  }

  return corrections;
}

/** snake_case column -> the camelCase property the app carries it as. */
function camelCaseOf(column: string): string {
  return column.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}
