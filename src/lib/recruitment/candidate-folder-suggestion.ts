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
  normalizedAreaMatchKey,
  resolveCanonicalMedicalRepArea,
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
  namesAnOccupation,
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
  | { suggestion: null; refusal: string; cause?: UnplacedCause; typed?: string };

/**
 * WHY somebody who answered still has no folder, as a value a screen can group on.
 *
 * The refusal SENTENCE says it to one person; this says it to forty, so the Folders tab can put the
 * thirty who typed an unlisted area under one instruction instead of repeating that instruction on
 * thirty rows. Optional on the result because only the refusals a recruiter can act on carry it —
 * the guard clauses ("Already filed.", "Candidate not found.") never reach a screen.
 */
export type UnplacedCause =
  | "degree"
  | "area_not_listed"
  | "no_area"
  | "region"
  | "job_title"
  | "no_role"
  | "other";

/**
 * A declared job title, read: which family it names, and whether the applicant TAPPED it or typed it.
 *
 * `tapped` is not decoration. It is the difference between an answer the applicant chose off a menu
 * and a sentence they wrote, and the "other" shelf below is keyed on that text VERBATIM — so it is
 * the one fact that says whether the folder name came from this system's own vocabulary or from a
 * WhatsApp message.
 */
type DeclaredRole = { family: CandidateRoleFamily; tapped: boolean };

/**
 * The role family behind a declared job title.
 *
 * A tapped answer is stored as the family's own LABEL ("Medical Representative"), so an exact label
 * match is an exact answer and is tried first. Only a typed "Other" answer falls through to
 * `candidateRoleFamily`, which is a rule over free text and is allowed to be wrong in the way any
 * inference is — the difference matters, and mixing the two is how a tapped answer would inherit an
 * inference's error rate.
 */
function readDeclaredRole(title: string | null | undefined): DeclaredRole | null {
  const cleaned = cleanFolderKey(title);
  if (!cleaned) return null;
  const tapped = (Object.keys(candidateRoleFamilyLabels) as CandidateRoleFamily[]).find(
    (family) => candidateRoleFamilyLabels[family].toLowerCase() === cleaned.toLowerCase(),
  );
  if (tapped) return { family: tapped, tapped: true };
  return { family: candidateRoleFamily(cleaned), tapped: false };
}

function declaredRoleFamily(title: string | null | undefined): CandidateRoleFamily | null {
  return readDeclaredRole(title)?.family ?? null;
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
 * they named a region, just not by tapping a row. This is that answer read properly, in two shapes:
 *
 *   RESOLVED        exactly one region, confidently — the same governorate reader other callers use
 *                    elsewhere (`egyptRegionFromFreeText`), so this file stays the one place that
 *                    owns "what governorate is this"; a region CODE or LABEL typed verbatim ("UE",
 *                    "Delta (1)"); or a NUMBERED half of Upper Egypt ("Upper Egypt 1", "UE ( 1 )",
 *                    "UE1 or UE2") — the owner's decision on 2026-09-11, asked directly: file a typed
 *                    numbered mention into the one Upper Egypt folder this apply flow offers, same as
 *                    a plain "Upper Egypt". Pedia's Upper Egypt split into UE-1/UE-2 on 2026-09-01
 *                    (see the regionMenu() comment in whatsapp-classify-menus.ts) and AGENTS.md's
 *                    golden rule is that the split membership DIFFERS by product line, which this
 *                    apply flow has no way to know — so which HALF they meant is not recovered here,
 *                    only that they meant Upper Egypt. `preferred_region_name` still holds their exact
 *                    words, so nothing is lost for whoever later needs to tell UE-1 from UE-2.
 *   SPANS REGIONS   the text names MORE than one — "Behira, Alex, Kafr El-Sheikh" is Alex-BHR AND
 *                    Delta (1), and there is no single folder for that. Comma-split so each place is
 *                    read on its own rather than the first WORD in the whole string winning, which is
 *                    what `candidateRegionForGovernorate` alone would do. UNRECOGNIZED — the text
 *                    names no region this app knows at all — falls out of the same path with zero
 *                    matches rather than one.
 */
export type DeclaredRegionFreeTextReading =
  | { kind: "resolved"; code: CandidateRegionCode }
  | { kind: "spans_regions"; codes: readonly CandidateRegionCode[] }
  | { kind: "unrecognized" };

// "Upper Egypt 1", "UE ( 1 )", "Upper (1)", "Upper Egypt (1)", "UE1 or UE2" — every variant production
// actually holds — all reduce, once punctuation is flattened to spaces, to "ue"/"upper" immediately
// followed (a bare space or nothing at all) by a "1" or "2".
const UPPER_EGYPT_NUMBERED_PATTERN = /\b(?:ue|upper)\s*(?:egypt)?\s*([12])\b/;

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
  // A numbered mention of Upper Egypt names the REGION, by the owner's decision — see the doc comment
  // above. Checked before the label match below so this never falls through to "unrecognized".
  if (UPPER_EGYPT_NUMBERED_PATTERN.test(normalizeForRegionScan(typed))) return { code: "UE", kind: "resolved" };

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
 *
 * `canonicalMedicalRepAreas` is the live `au.canonical_areas` list (via
 * `listCanonicalMedicalRepAreaNames`), required rather than defaulted so a caller cannot forget it
 * and silently let a free-typed area back in — see `resolveCanonicalMedicalRepArea` for why a
 * candidate's own typed area must match one of these exactly or be refused. It has no bearing on
 * the district-manager or "other" shelves, which are unaffected.
 */
export function suggestFolderFromDeclaredAnswers(
  candidate: DeclaringCandidate | null | undefined,
  canonicalMedicalRepAreas: readonly string[],
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

  const declaredRole = readDeclaredRole(candidate.appliedForJobTitle);
  if (!declaredRole) {
    return { refusal: "Answered the questions but named no role.", suggestion: null, cause: "no_role" };
  }
  const family = declaredRole.family;

  if (family === "medical_rep") {
    // The medical-rep shelf is keyed on the AREA, so a rep who never reached the area question has
    // no folder — and must not be quietly parked on the "other" shelf under their job title, which
    // would file a medical rep away from every other medical rep.
    const area = cleanFolderKey(candidate.preferredAreaName);
    if (!area) {
      return {
        refusal: "Applied as a medical rep but named no area, so there is no area folder to file into.",
        suggestion: null,
        cause: "no_area",
      };
    }
    // The area is FREE TEXT — the applicant either tapped a live area or typed one because theirs
    // was "not listed". A typed answer must match one of the current areas exactly (case and
    // whitespace aside) or it is refused rather than opening a stray folder. See
    // resolveCanonicalMedicalRepArea for why this never guesses between two real areas.
    const resolved = resolveCanonicalMedicalRepArea(area, canonicalMedicalRepAreas);
    if (resolved.area === null) {
      return {
        refusal: `Applied as a medical rep, but ${resolved.refusal}`,
        suggestion: null,
        cause: "area_not_listed",
        typed: area,
      };
    }
    return { refusal: null, suggestion: buildSuggestion("medical_rep", resolved.area) };
  }

  if (family === "district_manager") {
    // The region shelf is keyed on a CODE, and only a real one. An applicant who chose "Other" and
    // typed their region left words, not a code; storing words in this shelf is the exact shape that
    // produced undefined label lookups in production on 2026-08-24.
    const code = cleanFolderKey(candidate.preferredRegionCode)?.toUpperCase() ?? null;
    if (code) {
      if (!isKnownRegionCode(code)) {
        return {
          refusal: `Named a region this system no longer lists (${code}).`,
          suggestion: null,
          cause: "region",
        };
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
        cause: "region",
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
        cause: "region",
      };
    }
    return {
      refusal: `Typed "${typedRegion}" as their region, but it names no region this app recognises.`,
      suggestion: null,
      cause: "region",
    };
  }

  // Every other role goes on the "other" shelf under the job title itself — the owner's own split:
  // *"8 regions, and split other positions by job title"*.
  //
  // THE TITLE MUST NAME A JOB, AND ONLY THIS SHELF HAS TO ASK. The other three shelves are keyed on
  // a vocabulary — a canonical area, a region code, one fixed folder — so a value that is not in it
  // is refused by the list itself. This one is keyed on FREE TEXT by the owner's own design, which
  // is right for a recruiter naming a shelf and wrong for an automated action reading whatever the
  // applicant last typed: `applied_for_job_title` is filled by the WhatsApp flow, and a reply that
  // is not an answer to the job question lands in it unchanged.
  //
  // Measured against production 2026-09-11: a candidate whose title read "بخصوص الإعلان دا"
  // ("regarding this ad") had a folder of that name opened for her by the bulk "file the declared
  // CVs" action, one shelf away from the Medical Representative folder she belonged on. Nothing was
  // wrong with the filing code — the text simply was not a job, and no gate asked.
  //
  // So the gate is: a TAPPED answer is this system's own label and always files; a TYPED one files
  // only when it NAMES A JOB — `namesAnOccupation`, which is a much lower bar than being placed in
  // a family and deliberately so. "Regulatory Affairs Specialist" belongs to no family here and is
  // exactly the kind of position the owner's split is FOR, so the question this shelf asks is not
  // *which role is this* but *is this a role at all*. A typed answer that names no seat is refused,
  // as an unrecognised area is, and stays in the pool with the reason on screen.
  //
  // THE REFUSAL IS NOT A DEAD END — the picker's "Job title" box is free text and still takes any
  // title a recruiter types, so the owner's split survives whole. What it no longer does is let an
  // unread sentence name a folder with nobody looking.
  const title = cleanFolderKey(candidate.appliedForJobTitle);
  if (!title) return { refusal: "Answered the questions but named no role.", suggestion: null, cause: "no_role" };
  if (!declaredRole.tapped && !namesAnOccupation(title)) {
    return {
      refusal: `Typed "${title}" as their job title, which names no job — a folder cannot be opened from it. File this CV by hand under the title it should have.`,
      suggestion: null,
      cause: "job_title",
    };
  }
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
  /** Which instruction on the Folders tab this row sits under — see `groupUnplacedFilings`. */
  cause: UnplacedCause;
  /** The area they TYPED, verbatim, when the cause is `area_not_listed`; null otherwise. */
  typed: string | null;
  /**
   * Live areas that share a place-name word with what they typed — a hint for the person choosing,
   * NEVER a filing. "Minia" names two areas and does not say which, and the module's rule
   * (resolveCanonicalMedicalRepArea) is that territory is not inferred from free text; this only
   * shows the recruiter which real areas the typed word could mean so they need not go and look.
   */
  couldBe: string[];
};

// Words that name a DIRECTION or a kind of place rather than the place itself. "Qena north" must hint
// the two Qena areas, not also North Sinai; "Cairo East" must not hint every "East".
const AREA_HINT_STOP_WORDS = new Set([
  "north", "south", "east", "west", "center", "centers", "centre", "upper", "lower",
  "government", "governorate", "city", "town", "district", "and",
]);

/** Latin place-name words of at least four letters, "y" read as "i" so Minya and Minia meet. */
function areaHintWords(value: string): string[] {
  return normalizedAreaMatchKey(value)
    .replace(/[^a-z]+/g, " ")
    .replace(/y/g, "i")
    .split(" ")
    .filter((word) => word.length >= 4 && !AREA_HINT_STOP_WORDS.has(word));
}

/**
 * The live areas a typed answer could mean, at most four. Empty when it shares no place-name word
 * with any area — an Arabic answer, or a town that is not the name of an area. Pure hinting: the
 * caller shows these and files nothing.
 */
export function areasThatCouldBeMeant(typed: string, canonicalAreas: readonly string[]): string[] {
  const typedWords = new Set(areaHintWords(typed));
  if (typedWords.size === 0) return [];
  return canonicalAreas
    .filter((area) => areaHintWords(area).some((word) => typedWords.has(word)))
    .slice(0, 4);
}

/**
 * Every candidate whose own answers name a folder, grouped for a screen.
 *
 * Returns the refusals too, and on purpose. The danger this whole feature carries is that filing is
 * a quiet way to lose a good CV, so a screen that shows only the confident half invites the owner to
 * believe the rest were handled. `skipped` is what stops that.
 *
 * `canonicalMedicalRepAreas` is threaded straight through to `suggestFolderFromDeclaredAnswers` —
 * see there for why a medical rep's typed area is refused rather than guessed when it does not
 * exactly match a live area.
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
export function collectSuggestedFilings(
  candidates: readonly Candidate[],
  canonicalMedicalRepAreas: readonly string[],
): {
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
        cause: "degree",
        typed: null,
        couldBe: [],
      });
      continue;
    }

    const result = suggestFolderFromDeclaredAnswers(candidate, canonicalMedicalRepAreas);
    if (result.suggestion) {
      filings.push({
        candidateId: candidate.id,
        fullName: candidate.fullName,
        status: candidate.status ?? null,
        suggestion: result.suggestion,
        untouched: isUnreviewedCandidateStatus(candidate.status),
      });
    } else {
      const typed = result.typed ?? null;
      skipped.push({
        candidateId: candidate.id,
        fullName: candidate.fullName,
        reason: result.refusal,
        cause: result.cause ?? "other",
        typed,
        couldBe: typed ? areasThatCouldBeMeant(typed, canonicalMedicalRepAreas) : [],
      });
    }
  }

  return { filings, skipped, rejectedCount };
}

/** One instruction on the Folders tab, with every person it applies to under it. */
export type UnplacedGroup = {
  cause: UnplacedCause;
  /** What is wrong, in a few words a recruiter reads at a glance. */
  heading: string;
  /** What to do about it, once for the whole group — the sentence that used to repeat on every row. */
  instruction: string;
  rows: SkippedFiling[];
};

// In the order a recruiter works them: the ones with a single clear next click first, the ones that
// need a question put to the applicant last. The copy lives here rather than in the component so a
// test can pin it — a group with no instruction is the dead end this whole grouping exists to end.
const UNPLACED_GROUPS: ReadonlyArray<Pick<UnplacedGroup, "cause" | "heading" | "instruction">> = [
  {
    cause: "degree",
    heading: "Their degree has to be checked by a person first",
    instruction:
      "Answer each one in “Degrees waiting for you to check”, on this same tab just below. Once the degree is confirmed they can be filed.",
  },
  {
    cause: "area_not_listed",
    heading: "The area they typed is not one of our areas",
    instruction:
      "Open the CV, choose their real area and press File to folder. The system does not guess: some places, like Minia, hold more than one of our areas and they did not say which.",
  },
  {
    cause: "no_area",
    heading: "They never named an area",
    instruction:
      "Open the CV. If it says where they live or work, file it by hand under that area; if it does not, ask them.",
  },
  {
    cause: "region",
    heading: "Their region does not match one region folder",
    instruction: "Open the CV, choose the region folder that fits and press File to folder.",
  },
  {
    cause: "job_title",
    heading: "The job title they typed names no job",
    instruction: "Open the CV and file it by hand under the title it should have.",
  },
  {
    cause: "no_role",
    heading: "They named no role",
    instruction: "Open the CV and file it by hand under the role it is for.",
  },
  {
    cause: "other",
    heading: "Could not be placed",
    instruction: "The reason is beside each name.",
  },
];

/**
 * The skipped rows, gathered under the one instruction each needs — the screen used to print 48
 * near-identical sentences, and a list that long reads as noise rather than as a to-do.
 *
 * Empty groups are dropped; a group keeps the input order of its rows.
 */
export function groupUnplacedFilings(skipped: readonly SkippedFiling[]): UnplacedGroup[] {
  return UNPLACED_GROUPS.map((group) => ({
    ...group,
    rows: skipped.filter((row) => row.cause === group.cause),
  })).filter((group) => group.rows.length > 0);
}
