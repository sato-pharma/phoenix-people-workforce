// Recruitment / ATS — the folder a candidate's OWN answers put them in.
//
// The owner asked for this on 2026-08-30: *"candidates who applied via WhatsApp ... they were asked
// about the region and job title and area. So now we are confident hundred percent which folder
// those candidates should go to. Let's start with those."*
//
// He is right about the kind of certainty, and this module exists to hold the line on WHERE that
// certainty comes from. Measured against production the same morning:
//
//   257 candidates arrived from WhatsApp.
//   `applied_for_job_title` is filled on  82  of all candidates.
//     …of those,  64  were written by the CV EXTRACTOR reading the CV or the covering message.
//     …only      18  were written because the applicant TAPPED a menu row.
//
// So the column that looks like the answer is, three times in four, a machine's guess. Those guesses
// include a one-word Arabic job title and several area-bearing sentences lifted off a CV, which are
// descriptions of a career rather than a stated intent. Filing on that column would put 64 people
// into folders on the strength of an extraction, and a CV filed into the wrong area folder is a CV
// nobody opens again.
//
// THE ONE MARKER THIS MODULE TRUSTS is `preferencesDeclaredAt`, set by `writeClassification` in
// whatsapp-classify-session.ts at the moment a conversation completes. It is the only field in the
// record that means *the applicant said this*, rather than *something inferred this*. Everything
// below is gated on it, and that gate is the whole point of the file.
//
// PURE — no database, no React. Same rule as candidate-folder.ts, and for the same reason: a
// recruitment domain module that imports the database drags the service-role client into the
// browser bundle.

import {
  candidateFolderLabel,
  candidateFolderRefusal,
  cleanFolderKey,
  isFiledCandidate,
  type CandidateFolderKind,
} from "@/lib/recruitment/candidate-folder";
import {
  candidateRegionCodes,
  candidateRegionLabels,
  type CandidateRegionCode,
} from "@/lib/recruitment/candidate-region";
import { egyptRegionFromFreeText } from "@/lib/recruitment/candidate-region-freetext";
import { isUnreviewedCandidateStatus, normalizeCandidateStatus } from "@/lib/recruitment/candidate-status";
import { resolveBackgroundStanding } from "@/lib/recruitment/background-review";
import { screeningBandForFamily } from "@/lib/recruitment/screening-order";
import {
  candidateRoleFamily,
  candidateRoleFamilyLabels,
  type CandidateRoleFamily,
} from "@/lib/recruitment/candidate-role-family";
import type { Candidate } from "@/lib/recruitment/types";

/** Everything this module reads off a candidate — structural, so a test fixture need not be whole. */
export type DeclaringCandidate = Pick<
  Candidate,
  | "appliedForJobTitle"
  | "folder"
  | "preferencesDeclaredAt"
  | "preferredAreaName"
  | "preferredRegionCode"
  | "preferredRegionName"
  | "status"
>;

/** Where this candidate's own answers say they belong. */
export type CandidateFolderSuggestion = {
  kind: CandidateFolderKind;
  /** The value that would be stored — an area name, a region code, or a job title. */
  key: string;
  /** The same folder as a person reads it. */
  label: string;
};

/**
 * The answer for one candidate: a folder, or the sentence saying why there isn't one.
 *
 * A refusal carries words rather than a boolean for the same reason `candidateFolderRefusal` does —
 * the screen, the API's 400 and this module then say one thing instead of three that drift apart.
 */
export type CandidateFolderSuggestionResult =
  | { suggestion: CandidateFolderSuggestion; refusal: null }
  | { suggestion: null; refusal: string };

/**
 * The role family behind a declared job title.
 *
 * A tapped answer is stored as the family's own LABEL ("Medical Representative"), so an exact label
 * match is an exact answer and is tried first. Only a typed "Other" answer falls through to
 * `candidateRoleFamily`, which is a rule over free text and is allowed to be wrong in the way any
 * inference is — the difference matters, and mixing the two is how a tapped answer would inherit an
 * inference's error rate.
 */
function declaredRoleFamily(title: string | null | undefined): CandidateRoleFamily | null {
  const cleaned = cleanFolderKey(title);
  if (!cleaned) return null;
  const tapped = (Object.keys(candidateRoleFamilyLabels) as CandidateRoleFamily[]).find(
    (family) => candidateRoleFamilyLabels[family].toLowerCase() === cleaned.toLowerCase(),
  );
  if (tapped) return tapped;
  return candidateRoleFamily(cleaned);
}

/**
 * Does the degree-eligibility verdict have any bearing on the job this person actually asked for?
 *
 * The paramedical shelf answers ONE question — *eligible for the FIELD FORCE?* — and the owner drew
 * its edge explicitly on 2026-09-02: *"para medical is not accepted in medical rep or district
 * manager but normally accepted in office coordinator."* So a degree outside the five disciplines is
 * a reason to hold a rep or a district manager, and no reason whatsoever to hold an office
 * coordinator. Before this, the gate below read the verdict alone and held everybody — which put a
 * legitimate office hire on the one shelf the folder module calls *"the only shelf nobody is hired
 * out of"*.
 *
 * The line is drawn with `screeningBandForFamily` rather than a second list of role names, so the
 * two cannot drift apart: everything that module already calls `unrelated` — office coordinator, HR,
 * finance, and the `other` catch-all — is a head-office seat where a pharma or science degree is not
 * part of the job. Field force, pharma-adjacent and sales keep the hold exactly as it was, so
 * NOTHING changes for the two roles the owner named.
 *
 * A role nobody could read stays HELD, and deliberately: `screeningBandForFamily(null)` is
 * `unknown`, which is not `unrelated`. Releasing that case would turn "we cannot tell what they
 * applied for" into "file them anywhere", the exact widening this function exists to prevent.
 *
 * Do NOT answer this question by adding para-medical to the eligible disciplines in
 * candidate-background.ts. That list is the FIELD-FORCE rule, and widening it would open the medical
 * rep and district manager shelves to the very people the owner just excluded from them.
 */
export function degreeEligibilityAppliesToDeclaredRole(title: string | null | undefined): boolean {
  return screeningBandForFamily(declaredRoleFamily(title)) !== "unrelated";
}

function isKnownRegionCode(code: string): code is CandidateRegionCode {
  return (candidateRegionCodes as readonly string[]).includes(code);
}

/**
 * Reading a TYPED region answer — an applicant who chose "My region is not listed" and then typed
 * words into `preferred_region_name`, which is free text and answers for none of the eight regions
 * by construction.
 *
 * Measured against production 2026-09-11: 11 district manager applicants sat unplaceable this way,
 * and every one of them HAD typed a real answer — "Minya", "Behira, Alex, Kafr El-Sheikh", "UE ( 1 )".
 * The old refusal read "named no region from the list" for all of them, which is false for every one:
 * they named a region, just not by tapping a row. This is that answer read properly, in three shapes:
 *
 *   RESOLVED           exactly one region, confidently — the same governorate reader `Others named
 *                       for a governorate` uses elsewhere (`egyptRegionFromFreeText`), so this file
 *                       stays the one place that owns "what governorate is this".
 *   SPANS REGIONS       the text names MORE than one — "Behira, Alex, Kafr El-Sheikh" is Alex-BHR
 *                       AND Delta (1), and there is no single folder for that. Comma-split so each
 *                       place is read on its own rather than the first WORD in the whole string
 *                       winning, which is what `candidateRegionForGovernorate` alone would do.
 *   UPPER EGYPT SPLIT   names a NUMBERED half of Upper Egypt ("Upper Egypt 1", "UE ( 1 )", "UE1 or
 *                       UE2") rather than the region itself. `candidateRegionCodes` carries ONE Upper
 *                       Egypt folder, but Pedia's Upper Egypt split into UE-1/UE-2 on 2026-09-01 (see
 *                       the regionMenu() comment in whatsapp-classify-menus.ts) and AGENTS.md's golden
 *                       rule is that the split membership DIFFERS by product line — which this apply
 *                       flow has no way to know. So this is deliberately NOT resolved to "UE": doing
 *                       that would be this module deciding a question only the owner can answer.
 *
 * A short region CODE or the company's own region LABEL, typed verbatim ("UE", "Delta (1)"), resolves
 * directly and is checked before either of the ambiguous shapes above — a plain "Upper Egypt" with no
 * trailing number is not the split case and should still open its one real folder.
 */
export type DeclaredRegionFreeTextReading =
  | { kind: "resolved"; code: CandidateRegionCode }
  | { kind: "spans_regions"; codes: readonly CandidateRegionCode[] }
  | { kind: "upper_egypt_split" }
  | { kind: "unrecognized" };

// "Upper Egypt 1", "UE ( 1 )", "Upper (1)", "Upper Egypt (1)", "UE1 or UE2" — every variant production
// actually holds — all reduce, once punctuation is flattened to spaces, to "ue"/"upper" immediately
// followed (a bare space or nothing at all) by a "1" or "2". Plain "upper egypt" carries no digit and
// never matches, which is the whole point: the split is what is undecided, not the region itself.
const UPPER_EGYPT_SPLIT_PATTERN = /\b(?:ue|upper)\s*(?:egypt)?\s*([12])\b/;

function normalizeForRegionScan(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** A region label or code, reduced the same way on both sides so "Delta 1" typed plainly still
 *  matches the stored "Delta (1)". */
function regionLabelKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function regionNamedDirectly(typed: string): CandidateRegionCode | null {
  const upper = typed.toUpperCase();
  if (isKnownRegionCode(upper)) return upper;
  const key = regionLabelKey(typed);
  return candidateRegionCodes.find((code) => regionLabelKey(candidateRegionLabels[code]) === key) ?? null;
}

export function readDeclaredRegionFreeText(typed: string): DeclaredRegionFreeTextReading {
  if (UPPER_EGYPT_SPLIT_PATTERN.test(normalizeForRegionScan(typed))) return { kind: "upper_egypt_split" };

  const direct = regionNamedDirectly(typed);
  if (direct) return { kind: "resolved", code: direct };

  // Comma-split so "Behira, Alex, Kafr El-Sheikh" is read as three PLACES, not one long string whose
  // first matching word wins — `candidateRegionForGovernorate`'s own fallback would otherwise return
  // "Alex-BHR" alone and silently drop that the third place is Delta (1).
  const segments = typed
    .split(/[,،]/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  const distinct: CandidateRegionCode[] = [];
  for (const segment of segments.length > 0 ? segments : [typed]) {
    const code = egyptRegionFromFreeText(segment);
    if (code && !distinct.includes(code)) distinct.push(code);
  }
  if (distinct.length === 1) return { kind: "resolved", code: distinct[0] };
  if (distinct.length > 1) return { kind: "spans_regions", codes: distinct };
  return { kind: "unrecognized" };
}

/**
 * The folder this candidate's own answers put them in, or why there is none.
 *
 * The order of the gates is deliberate: already-filed, then never-answered, then rejected, then the
 * per-shelf requirements. Each returns the most specific true sentence available, because a screen
 * listing "12 cannot be filed" with no reasons is a screen that gets ignored.
 */
export function suggestFolderFromDeclaredAnswers(
  candidate: DeclaringCandidate | null | undefined,
): CandidateFolderSuggestionResult {
  if (!candidate) return { refusal: "Candidate not found.", suggestion: null };

  if (isFiledCandidate(candidate)) {
    return { refusal: "Already filed.", suggestion: null };
  }

  if (!cleanFolderKey(candidate.preferencesDeclaredAt)) {
    return {
      refusal:
        "Never answered the WhatsApp questions. Any job title on this record was read off the CV by the extractor, not stated by the applicant.",
      suggestion: null,
    };
  }

  const blocked = candidateFolderRefusal(candidate);
  if (blocked) return { refusal: blocked, suggestion: null };

  const family = declaredRoleFamily(candidate.appliedForJobTitle);
  if (!family) {
    return { refusal: "Answered the questions but named no role.", suggestion: null };
  }

  if (family === "medical_rep") {
    // The medical-rep shelf is keyed on the AREA, so a rep who never reached the area question has
    // no folder — and must not be quietly parked on the "other" shelf under their job title, which
    // would file a medical rep away from every other medical rep.
    const area = cleanFolderKey(candidate.preferredAreaName);
    if (!area) {
      return {
        refusal: "Applied as a medical rep but named no area, so there is no area folder to file into.",
        suggestion: null,
      };
    }
    return { refusal: null, suggestion: buildSuggestion("medical_rep", area) };
  }

  if (family === "district_manager") {
    // The region shelf is keyed on a CODE, and only a real one. An applicant who chose "Other" and
    // typed their region left words, not a code; storing words in this shelf is the exact shape that
    // produced undefined label lookups in production on 2026-08-24.
    const code = cleanFolderKey(candidate.preferredRegionCode)?.toUpperCase() ?? null;
    if (code) {
      if (!isKnownRegionCode(code)) {
        return { refusal: `Named a region this system no longer lists (${code}).`, suggestion: null };
      }
      return { refusal: null, suggestion: buildSuggestion("district_manager", code) };
    }

    // No tapped code — but they may still have TYPED one after choosing "My region is not listed",
    // which lands in preferredRegionName rather than the code column. Read it properly instead of
    // reporting "named no region" for somebody who plainly named one. See readDeclaredRegionFreeText.
    const typedRegion = cleanFolderKey(candidate.preferredRegionName);
    if (!typedRegion) {
      return {
        refusal:
          "Applied as a district manager but named no region from the list, so there is no region folder to file into.",
        suggestion: null,
      };
    }

    const reading = readDeclaredRegionFreeText(typedRegion);
    if (reading.kind === "resolved") {
      return { refusal: null, suggestion: buildSuggestion("district_manager", reading.code) };
    }
    if (reading.kind === "spans_regions") {
      const names = reading.codes.map((regionCode) => candidateRegionLabels[regionCode]).join(" and ");
      return {
        refusal: `Typed "${typedRegion}" as their region, which spans ${names} — there is no single region folder for that.`,
        suggestion: null,
      };
    }
    if (reading.kind === "upper_egypt_split") {
      return {
        refusal: `Typed "${typedRegion}" as their region. Upper Egypt has split into UE-1/UE-2 by product line since 2026-09-01 and this system offers only one Upper Egypt folder — ask the owner whether this should file there before filing it.`,
        suggestion: null,
      };
    }
    return {
      refusal: `Typed "${typedRegion}" as their region, but it names no region this app recognises.`,
      suggestion: null,
    };
  }

  // Every other role goes on the "other" shelf under the job title itself — the owner's own split:
  // *"8 regions, and split other positions by job title"*.
  const title = cleanFolderKey(candidate.appliedForJobTitle);
  if (!title) return { refusal: "Answered the questions but named no role.", suggestion: null };
  return { refusal: null, suggestion: buildSuggestion("other", title) };
}

function buildSuggestion(kind: CandidateFolderKind, key: string): CandidateFolderSuggestion {
  return { key, kind, label: candidateFolderLabel(kind, key) };
}

/** One candidate paired with the folder their answers name. */
export type SuggestedFiling = {
  candidateId: string;
  fullName: string | null;
  suggestion: CandidateFolderSuggestion;
  /**
   * Nobody has acted on this person yet — `isUnreviewedCandidateStatus`, the SAME question the
   * recruitment landing screen counts, deliberately not a second copy of it.
   *
   * It carries the owner's split, made on 2026-08-30 after reading the first fifteen: nine had
   * arrived that morning and five were already shortlisted. His own words for what a folder is —
   * *"if this CV is good, but I'm not needing it now"* — do not describe somebody a recruiter
   * shortlisted four hours ago, so a single button filing the whole set would take live prospects
   * off the screen the recruiters work from.
   */
  untouched: boolean;
  /** As stored, so a screen naming who it would leave behind can say WHY without a second lookup. */
  status: string | null;
};

/** One candidate who answered, but whose answers do not reach a folder. */
export type SkippedFiling = {
  candidateId: string;
  fullName: string | null;
  reason: string;
};

/**
 * Every candidate whose own answers name a folder, grouped for a screen.
 *
 * Returns the refusals too, and on purpose. The danger this whole feature carries is that filing is
 * a quiet way to lose a good CV, so a screen that shows only the confident half invites the owner to
 * believe the rest were handled. `skipped` is what stops that.
 *
 * REJECTION IS COUNTED, NOT NARRATED. Measured against production 2026-09-11: 40 of the 60 rows this
 * screen called "answered but cannot be placed" were REJECTED — a settled decision, not an open one —
 * and burying 25 genuinely actionable rows under them is worse than the silence `skipped` exists to
 * prevent. So a rejection is pulled out before any per-shelf reason runs (which also fixes a second
 * fault: the degree gate below used to run FIRST, so a rejected candidate who also read as paramedical
 * showed the degree sentence instead of the rejection — two wordings for the same settled decision).
 * `rejectedCount` keeps the transparency this module insists on everywhere else: the number is still
 * on screen, it is just not 40 rows of the same unchangeable sentence.
 */
export function collectSuggestedFilings(candidates: readonly Candidate[]): {
  filings: SuggestedFiling[];
  skipped: SkippedFiling[];
  rejectedCount: number;
} {
  const filings: SuggestedFiling[] = [];
  const skipped: SkippedFiling[] = [];
  let rejectedCount = 0;

  for (const candidate of candidates) {
    // A candidate who never answered is not "skipped" in any sense worth showing — that is most of
    // the pool, and listing it would bury the handful that genuinely could not be placed.
    if (!cleanFolderKey(candidate.preferencesDeclaredAt)) continue;
    if (isFiledCandidate(candidate)) continue;

    if (normalizeCandidateStatus(candidate.status) === "rejected") {
      rejectedCount += 1;
      continue;
    }

    // THE DEGREE COMES FIRST — for the jobs the degree is about.
    //
    // The owner, 2026-08-31: "anyone non eligible, you will make the admin be able to check first
    // their CV and confirm." Answering the WhatsApp questions is not that check. Without this gate
    // the bulk "file the ones nobody has opened" action put a Commerce graduate who asked to be a
    // medical rep straight onto the Medical Rep shelf — and filing him did not merely mis-shelve
    // him, it REMOVED him from the review queue, which refuses anybody already on a shelf. The
    // human check the owner asked for would then never happen, and nothing on any screen would say
    // so.
    //
    // PARAMEDICAL ONLY, and the narrowness is the point. "Their degree could not be read" is not a
    // reason to withhold anything: 159 of the 604 CVs in production name no faculty at all, so
    // gating on "eligible" would empty this action for most of the pool and quietly break a feature
    // that works. This module already holds the same rule for the same reason — "treating a parsing
    // failure as grounds for exclusion is how unreadable strings become quiet removals". An unknown
    // degree files onto its declared role shelf, where a recruiter sees it, exactly as before.
    //
    // The STANDING, not the parser's verdict: an admin who has already answered outranks it in both
    // directions, so a graduate an admin confirmed eligible files here even if the parser dislikes
    // the faculty string, and one an admin confirmed paramedical is held even if it likes it.
    // SCOPED TO THE ROLE since 2026-09-02 — see degreeEligibilityAppliesToDeclaredRole. The verdict
    // is about the field force, so it holds a rep and a district manager and lets an office
    // coordinator through. Both halves are load-bearing: drop the first and a Commerce graduate
    // reaches the Medical Rep shelf, drop the second and a legitimate office hire is parked on a
    // shelf nobody is hired out of.
    const standing = resolveBackgroundStanding(candidate);
    if (
      standing.outcome === "paramedical" &&
      degreeEligibilityAppliesToDeclaredRole(candidate.appliedForJobTitle)
    ) {
      skipped.push({
        candidateId: candidate.id,
        fullName: candidate.fullName,
        reason: "Their degree reads as something outside the five disciplines — answer it in Degrees waiting for you to check.",
      });
      continue;
    }

    const result = suggestFolderFromDeclaredAnswers(candidate);
    if (result.suggestion) {
      filings.push({
        candidateId: candidate.id,
        fullName: candidate.fullName,
        status: candidate.status ?? null,
        suggestion: result.suggestion,
        untouched: isUnreviewedCandidateStatus(candidate.status),
      });
    } else {
      skipped.push({ candidateId: candidate.id, fullName: candidate.fullName, reason: result.refusal });
    }
  }

  return { filings, skipped, rejectedCount };
}
