// Recruitment / ATS — where a CV lands in Google Drive.
//
// WHY THIS EXISTS. The owner asked for the CV shelf to exist as real folders in his own Drive, so
// he can open a region on his phone and read the CVs waiting in it:
//
//   "we will make a folder in Google Drive ... the WhatsApp will do the same in the Google Drive.
//    We will make a folder called, for example, region Alex. In this region, we have Alex Center."
//
// NESTED, WHERE THE APP IS FLAT. `candidate-folder.ts` keeps two SEPARATE shelves — fifty area
// folders under Medical Representative, eight region folders under District Manager — because a
// screen has limited room and a recruiter filters rather than walks. A filing cabinet is the other
// shape: you open Alex-BHR and find Alex Center inside it. Nesting costs nothing in Drive, and it is
// what he described, so the area shelf is grouped by region HERE and only here. The app's own shelf
// is untouched.
//
// ONE BRAIN, NOT TWO. Which shelf a candidate belongs on is NOT decided here — it is
// `suggestFolderFromDeclaredAnswers`, which is gated on `preferencesDeclaredAt` and therefore only
// ever files on what the applicant TAPPED, never on what the CV extractor guessed. Duplicating that
// judgement would be the drift this module exists to avoid: this file only turns a decision already
// made into a path.
//
// PURE — no database, no network, no React. The area→region grouping is handed in as a map rather
// than read from `au.canonical_areas`, so the whole tree is unit-testable without either.

import type { InferredPlacement } from "@/lib/recruitment/candidate-folder-inference";
import {
  candidateFolderKindLabels,
  candidateFolderLabel,
  cleanFolderKey,
  type CandidateFolderKind,
} from "@/lib/recruitment/candidate-folder";
import type { CandidateFolderSuggestion } from "@/lib/recruitment/candidate-folder-suggestion";
import { recruitmentRegionForArea } from "@/lib/recruitment/candidate-region";
import { egyptRegionFromFreeText } from "@/lib/recruitment/candidate-region-freetext";

/**
 * Where a CV goes when nobody yet knows where it belongs.
 *
 * This is the common case at the moment a CV arrives, and that is the whole reason the folder is
 * named rather than the upload deferred. The applicant sends the file FIRST and answers the three
 * questions seconds-to-minutes later; the worker that stores the CV runs before any of that. So the
 * file is written here immediately and MOVED once the answers land (`driveFolderPathFor` is asked
 * again at that point). A CV whose sender never finishes the conversation stays here, visible, which
 * is the honest outcome — 303 of the 510 WhatsApp candidates measured on 2026-09-03 are in exactly
 * that state, and a design that waited for answers would have filed none of them anywhere.
 */
export const UNCLASSIFIED_FOLDER_NAME = "Not yet classified";

/**
 * The shelf for CVs placed by INFERENCE rather than by the applicant's own answers.
 *
 * Deliberately a sibling of the four real shelves and never nested inside one. The name has to do
 * the work of a caveat, because a folder is read on a phone with no tooltip and no legend: anyone
 * opening it must understand at a glance that nobody confirmed this. It stops at region for the
 * reasons `candidate-folder-inference.ts` sets out, so nothing inside it is ever two levels deep
 * except the one country case below.
 */
export const INFERRED_FOLDER_NAME = "From the CV (not confirmed)";

/**
 * Inferred, and the CV names nowhere at all. Still a folder rather than the flat holding pile — the
 * owner's instruction on 2026-09-04 was that no CV sits without one, and "the CV does not say" is a
 * genuine, checkable fact about the record rather than a bucket for leftovers.
 */
export const NO_LOCATION_FOLDER_NAME = "Location not on the CV";

/**
 * The "other" shelf, when what the applicant typed as their job title is not one.
 *
 * Measured on production 2026-09-04: of the seven distinct job titles on that shelf, six are real
 * free-typed roles — "Office Coordinator" (17 CVs), "Technical Support and infrastructure Engineer",
 * "National Sales Manager" — and exactly ONE is a WhatsApp message that landed in the title box:
 * "بخصوص الإعلان دا", which is "regarding this advertisement". It became a Drive folder with that
 * name.
 *
 * So the guard is deliberately narrow. A sentence-detector tuned on one row would eventually eat
 * "Technical Support and infrastructure Engineer", and a wrong folder is worse than a shallow one —
 * this module's standing rule. See `readsAsAJobTitle` for the exact, measured test.
 */
export const UNREADABLE_TITLE_FOLDER_NAME = "Job title not clear";

/** Inferred and outside Egypt — the country sits under this so the region list stays Egyptian. */
export const OUTSIDE_EGYPT_FOLDER_NAME = "Outside Egypt";

/**
 * Characters Drive tolerates but a human browsing folders does not, plus the separator this module
 * uses to express a path. Drive itself permits "/" inside a name, which is precisely the problem: a
 * job title like "Sales / Marketing Coordinator" typed on the "other" shelf would render as two
 * folders in any path-shaped reading of the tree and as one confusing name in Drive.
 */
export function sanitizeDriveSegment(name: string): string {
  const cleaned = String(name ?? "")
    // eslint-disable-next-line no-control-regex -- control characters are exactly what is stripped
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[\\/]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  // Drive rejects neither a leading dot nor a trailing one, but both read as a hidden or truncated
  // folder to a person. Stripped rather than rejected: a name is never worth failing a CV over.
  return cleaned.replace(/^\.+/, "").replace(/\.+$/, "").trim();
}

/** The area→region grouping this module needs, keyed by the EXACT `au.canonical_areas.area_name`. */
export type AreaRegionMap = Readonly<Record<string, string>>;

/**
 * The region folder an AREA sits inside, as a label.
 *
 * Routed through `recruitmentRegionForArea` rather than the raw `code_region_code`, and that is
 * load-bearing: the Delta (3) move deliberately left the SALES geography alone (owner, Option A), so
 * `au.canonical_areas` still files Sharkia 1, Sharkia 2, Qalubeya, Suez and Ismailia under their old
 * regions. Reading that column directly would put a Delta (3) applicant's CV in the Delta (2) folder
 * — the exact mis-file the recruitment override was written to prevent.
 *
 * An area the map does not know returns null, and the caller then files region-less rather than
 * guessing. A wrong region folder is worse than a shallow one: nobody opens Delta (2) looking for a
 * CV that is in it by mistake.
 */
export function regionFolderForArea(areaName: string, areaRegions: AreaRegionMap): string | null {
  const area = cleanFolderKey(areaName);
  if (!area) return null;
  const salesRegion = areaRegions[area] ?? null;
  if (!salesRegion) return null;
  const code = recruitmentRegionForArea(area, salesRegion);
  // The label, not the code: this is a folder a person reads. `candidateFolderLabel` already falls
  // back to the code verbatim for anything unlisted, which is the owner's standing rule — never show
  // an invented value, and never show "Unknown".
  return candidateFolderLabel("district_manager", code) || null;
}

/**
 * The region folder a FREE-TYPED area name points at, when the canonical map has never heard of it.
 *
 * An applicant types their area by hand, and when they type a GOVERNORATE rather than one of the
 * company's areas — "Qena", "Minia Government", "kafrelsheikh" — `regionFolderForArea` returns null
 * and the CV used to land directly under the shelf with no region above it: findable only by
 * scrolling every medical-rep CV in the company. Six were in that state on 2026-09-04.
 *
 * A governorate still names a REGION unambiguously, and `egyptRegionFromFreeText` reads exactly
 * that. So one level of precision is lost and none of the filing is.
 */
export function regionFolderFromTypedArea(areaName: string): string | null {
  const region = egyptRegionFromFreeText(areaName);
  if (!region) return null;
  return candidateFolderLabel("district_manager", region) || null;
}

/**
 * Whether a typed job title can be used as a folder name at all.
 *
 * The one measured failure is an Arabic SENTENCE sent as a title. Every real title on that shelf in
 * production is written in Latin script, so requiring one Latin letter separates the seven cases
 * cleanly and cannot touch a legitimate English title however unusual its wording. It is a narrow
 * test on purpose: if Arabic job titles ever become normal here, this is the line to revisit, and a
 * misfile lands in a named folder rather than being lost.
 */
export function readsAsAJobTitle(label: string): boolean {
  return /[A-Za-z]/.test(String(label ?? ""));
}

/**
 * The Drive path for one CV, as folder segments under the configured root.
 *
 * `null` for the suggestion means "not filed" — no answers yet, already filed, rejected, or any of
 * the refusals `suggestFolderFromDeclaredAnswers` names — and every one of those lands in the same
 * unclassified folder. That is deliberate: the refusal SENTENCE belongs on the candidate record and
 * on the recruiter's screen, not encoded as a folder nobody asked for. A tree with a folder per
 * reason is a tree nobody browses.
 */
export function driveFolderPathFor(
  suggestion: CandidateFolderSuggestion | null | undefined,
  areaRegions: AreaRegionMap,
): string[] {
  if (!suggestion) return [UNCLASSIFIED_FOLDER_NAME];

  const shelf = candidateFolderKindLabels[suggestion.kind];
  const label = suggestion.label || candidateFolderLabel(suggestion.kind, suggestion.key);

  if (suggestion.kind === "medical_rep") {
    // Region first, then area — "Medical Representative / Alex-BHR / Alex Center".
    const region = regionFolderForArea(suggestion.key, areaRegions);
    if (region) return [shelf, region, label].map(sanitizeDriveSegment).filter(Boolean);

    // The area is not one of ours — almost always a governorate typed by hand. File under the
    // region it names, and deliberately WITHOUT an area folder: inventing "Qena north" beside the
    // real "Qena 1" and "Qena 2" would put a name that looks official on a folder nobody owns, and
    // a wrong folder is worse than a shallow one. Their exact words stay on the candidate record.
    const typedRegion = regionFolderFromTypedArea(suggestion.key);
    if (typedRegion) return [shelf, typedRegion].map(sanitizeDriveSegment).filter(Boolean);

    // Nothing readable at all. Their own words are still better than the top of the shelf.
    return [shelf, label].map(sanitizeDriveSegment).filter(Boolean);
  }

  // A job title that is really a message never becomes a folder name.
  if (suggestion.kind === "other" && !readsAsAJobTitle(label)) {
    return [shelf, UNREADABLE_TITLE_FOLDER_NAME].map(sanitizeDriveSegment).filter(Boolean);
  }

  // The paramedical shelf holds exactly one folder, so the shelf IS the folder — nesting a
  // "Paramedical / Paramedical" would be noise. Every other shelf keeps its one level.
  const segments: string[] = suggestion.kind === "paramedical" ? [shelf] : [shelf, label];
  return segments.map(sanitizeDriveSegment).filter(Boolean);
}

/**
 * The path for a candidate placed by INFERENCE, under its own clearly-caveated shelf.
 *
 * `null` for the placement is not a failure — it means the record names nowhere, which is a fact
 * worth a folder of its own rather than a reason to fall back to the flat pile. Everything here is
 * one level under the shelf except a foreign country, which keeps the Egyptian region list clean by
 * sitting under "Outside Egypt".
 */
export function driveInferredFolderPath(placement: InferredPlacement | null | undefined): string[] {
  if (!placement) {
    return [INFERRED_FOLDER_NAME, NO_LOCATION_FOLDER_NAME].map(sanitizeDriveSegment);
  }
  const segments =
    placement.basis === "outside-egypt"
      ? [INFERRED_FOLDER_NAME, OUTSIDE_EGYPT_FOLDER_NAME, placement.label]
      : [INFERRED_FOLDER_NAME, placement.label];
  return segments.map(sanitizeDriveSegment).filter(Boolean);
}

/** True when a path sits on the inferred shelf — used to tell a guess from a stated answer. */
export function isInferredPath(path: readonly string[]): boolean {
  return path[0] === INFERRED_FOLDER_NAME;
}

/** True when this path is the holding folder rather than a real filing decision. */
export function isUnclassifiedPath(path: readonly string[]): boolean {
  return path.length === 1 && path[0] === UNCLASSIFIED_FOLDER_NAME;
}

/** Two paths compared for identity — used to decide whether a stored CV actually needs moving. */
export function samePath(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((segment, index) => segment === right[index]);
}

const EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
  "application/msword": ".doc",
  "application/pdf": ".pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

/**
 * The file's name in Drive: the person, then the number that disambiguates them.
 *
 * The original filename is deliberately NOT kept. Measured on production 2026-09-03, what applicants
 * actually send is "CV.pdf", "cv (1).pdf", "WhatsApp Image ….jpg" — names that are identical across
 * dozens of people and useless in a folder listing, which is the one place this name is read. The
 * phone number is appended because two applicants genuinely do share a name, and it is the value the
 * owner would ring anyway.
 *
 * A candidate with no name read yet is NOT skipped and NOT invented: the file is named for the
 * number alone, so it is still findable and still gets renamed the day extraction succeeds.
 */
export function driveFileNameFor(input: {
  candidateName: string | null | undefined;
  phone: string | null | undefined;
  mimeType: string | null | undefined;
  originalFileName?: string | null;
}): string {
  const name = sanitizeDriveSegment(input.candidateName ?? "");
  const digits = String(input.phone ?? "").replace(/\D/g, "");
  const extension =
    EXTENSION_BY_MIME[String(input.mimeType ?? "").toLowerCase().split(";")[0]?.trim() ?? ""] ??
    // Fall back to the original file's own extension before giving up — a mime type we do not list
    // is not a reason to write a file nobody's phone will open.
    (String(input.originalFileName ?? "").match(/\.[A-Za-z0-9]{1,5}$/)?.[0] ?? "");

  const stem = [name || null, digits || null].filter(Boolean).join(" - ") || "Unnamed CV";
  return `${stem}${extension}`;
}

/** The shelf labels this module can produce, so a test can assert the tree's top level exactly. */
export function driveShelfLabels(): string[] {
  return (Object.keys(candidateFolderKindLabels) as CandidateFolderKind[])
    .map((kind) => candidateFolderKindLabels[kind])
    .concat(UNCLASSIFIED_FOLDER_NAME);
}
