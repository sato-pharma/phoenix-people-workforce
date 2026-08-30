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
import { candidateRegionCodes, type CandidateRegionCode } from "@/lib/recruitment/candidate-region";
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

function isKnownRegionCode(code: string): code is CandidateRegionCode {
  return (candidateRegionCodes as readonly string[]).includes(code);
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
    if (!code) {
      return {
        refusal:
          "Applied as a district manager but named no region from the list, so there is no region folder to file into.",
        suggestion: null,
      };
    }
    if (!isKnownRegionCode(code)) {
      return { refusal: `Named a region this system no longer lists (${code}).`, suggestion: null };
    }
    return { refusal: null, suggestion: buildSuggestion("district_manager", code) };
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
 */
export function collectSuggestedFilings(candidates: readonly Candidate[]): {
  filings: SuggestedFiling[];
  skipped: SkippedFiling[];
} {
  const filings: SuggestedFiling[] = [];
  const skipped: SkippedFiling[] = [];

  for (const candidate of candidates) {
    // A candidate who never answered is not "skipped" in any sense worth showing — that is most of
    // the pool, and listing it would bury the handful that genuinely could not be placed.
    if (!cleanFolderKey(candidate.preferencesDeclaredAt)) continue;
    if (isFiledCandidate(candidate)) continue;

    const result = suggestFolderFromDeclaredAnswers(candidate);
    if (result.suggestion) {
      filings.push({
        candidateId: candidate.id,
        fullName: candidate.fullName,
        suggestion: result.suggestion,
      });
    } else {
      skipped.push({ candidateId: candidate.id, fullName: candidate.fullName, reason: result.refusal });
    }
  }

  return { filings, skipped };
}
