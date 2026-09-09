// Recruitment / ATS — where a CV goes in the CABINET, the owner's second Google Drive tree.
//
// WHY A SECOND TREE EXISTS AT ALL. The first one (`drive-cv-folders.ts`, root "Phoenix CVs") files
// by CONFIDENCE first: a confirmed answer goes on the "Medical Representative" shelf, an inferred
// one on "From the CV (not confirmed)", and the two never mix. That is honest and it is unusable at
// this size — the owner, 2026-09-07: "currently I am lost. Many CVs, many the same folder, many
// copies, and the CVs I can't reach everything."
//
// The reason is structural rather than cosmetic. A region exists in as many places as there are
// shelves, so "Cairo" is three different folders and none of them is all the Cairo CVs. Measured
// the same day: `From the CV (not confirmed)/Cairo` alone held 297 files for 192 people.
//
// WHAT HE ASKED FOR, IN HIS WORDS: "the region have one folder. The area have one folder. The
// position have one folder." Asked which way to nest them, he chose POSITION first. So:
//
//     <Position> / <Region> / <Area>
//
// and every level is optional from the bottom up — a candidate whose area nobody knows stops at the
// region, and one who named neither stops at the position. Three levels, never four.
//
// NO GOVERNORATE RUNG. The first tree groups "Qena 1" and "Qena 2" under a "Qena" parent. That rung
// is deliberately absent here: he asked for one folder per area, and the preview he chose showed
// `Delta (1)/Gharbia 1 (Tanta)` with nothing between. A governorate typed by hand still resolves to
// the parent NAME and becomes an area folder in its own right, so nothing is lost — "Qena" simply
// sits beside "Qena 1" and "Qena 2" rather than above them.
//
// THE OLD TREE IS FROZEN, NOT MIGRATED. Owner: "don't fix. Create a new folder and reroute."
// `Phoenix CVs` keeps every file it has and is never written to again. This module never resolves a
// path inside it and has no opinion about it.
//
// PURE — no database, no network, no React. The area→region grouping is handed in as a map, exactly
// as in `drive-cv-folders.ts`, so the whole tree is unit-testable without either.

import {
  candidateFolderKindLabels,
  candidateFolderLabel,
  cleanFolderKey,
  isCandidateFolderKind,
} from "@/lib/recruitment/candidate-folder";
import { canAutoFileBackground } from "@/lib/recruitment/candidate-background";
import { inferCandidatePlacement } from "@/lib/recruitment/candidate-folder-inference";
import { candidateRoleFamilyLabels, candidateRoleFamilyOrNull } from "@/lib/recruitment/candidate-role-family";
import {
  governorateFolderFromTypedArea,
  readsAsAJobTitle,
  regionFolderForArea,
  regionFolderFromTypedArea,
  sanitizeDriveSegment,
  type AreaRegionMap,
} from "@/lib/recruitment/drive-cv-folders";

/**
 * The cabinet's root folder name.
 *
 * Deliberately NOT "Phoenix CVs". The old tree keeps that name and keeps its files; a session that
 * confuses the two would write into a cabinet the owner asked to be left alone.
 */
export const CABINET_ROOT_NAME = "Phoenix CV Cabinet";

/** Level one when the record names no job title at all. 449 of 875 candidates on 2026-09-07. */
export const POSITION_NOT_STATED = "Position not stated";

/** Level two when nothing on the record — stated, typed or inferred — names a place. */
export const REGION_NOT_STATED = "Region not stated";

/** Level two for a candidate living outside Egypt; the country then becomes the AREA folder. */
export const OUTSIDE_EGYPT_REGION = "Outside Egypt";

/** Everything this module needs about a candidate. Matches the mirror's own row shape exactly. */
export type CabinetCandidateRow = {
  applied_for_job_title: string | null;
  address: string | null;
  current_job_title: string | null;
  declared_background: string | null;
  faculty: string | null;
  folder_key: string | null;
  folder_kind: string | null;
  governorate: string | null;
  preferred_area_name: string | null;
  preferred_region_code: string | null;
  sent_for_job_title: string | null;
  sent_for_region: string | null;
};

/**
 * The "other" family's folder, named for the shelf the app already calls it rather than the bare
 * "Other" the family table uses. A top-level folder called "Other" beside ten real job titles reads
 * as a mistake; "Other positions" reads as a decision.
 */
const OTHER_POSITIONS_FOLDER = candidateFolderKindLabels.other;

/**
 * The position folder for one candidate — level one of the cabinet.
 *
 * THE TITLE IS CLASSIFIED, NEVER USED VERBATIM, and that is the whole difference between this tree
 * and the one it replaces. Filing on the typed string is what produced the old tree's long tail:
 * measured 2026-09-07, filing 58 distinct typed titles verbatim gives 40 top-level folders of which
 * 26 hold exactly ONE CV — "Office Coordinator (Sheraton, Cairo)" sitting beside "Office
 * Coordinator", "Upper Egypt District Sales Manager" beside "District Manager", seven separate HR
 * spellings, four separate accountant spellings. That is the owner's own complaint, "many the same
 * folder", reproduced in a new tree.
 *
 * So the position is resolved through `candidateRoleFamily`, the repository's existing job-title
 * classifier. It is not a new judgement invented here: it is rule-based rather than substring-based,
 * repairs the "manger" misspelling three candidates actually have, handles compound titles that name
 * two jobs at once, and its area/district boundary is the OWNER'S OWN correction from 2026-08-28.
 * Eleven families, each already carrying the company's own label. Reusing it means a candidate
 * cannot be a District Manager to the pool filter and something else in the cabinet.
 *
 * A folder a RECRUITER filed by hand still outranks the title — that decision is the point of the
 * shelf, and re-deriving it would quietly move a CV a human placed.
 *
 * WHY A GUESSED TITLE IS ALLOWED HERE AT ALL. `suggestFolderFromDeclaredAnswers` refuses to file on
 * `applied_for_job_title` unless the applicant actually answered, because three times in four the
 * value is the CV extractor's guess. The cabinet deliberately takes the guess: it is a browsing aid
 * over a frozen second copy, never the record of a decision, and a guessed folder that is wrong
 * costs a recruiter one wrong click while no folder at all costs him the CV. The owner chose this
 * layout knowing 449 candidates would land under `Position not stated`.
 */
export function cabinetPositionFolder(row: CabinetCandidateRow): string {
  const filedKind = isCandidateFolderKind(row.folder_kind) ? row.folder_kind : null;
  const filedKey = cleanFolderKey(row.folder_key);
  if (filedKind && filedKind !== "other") return candidateFolderKindLabels[filedKind];

  // A hand-filed "other" carries a typed key, so it goes through the same classifier as a typed
  // title — otherwise the one shelf a human chose is the one that fragments.
  //
  // THE LADDER, STRONGEST FIRST, AND IT ONLY EVER FILLS A GAP. `sent_for_job_title` is written when
  // a recruiter actually puts someone forward, so it is an action rather than an extraction — the
  // same reason `candidate-folder-inference.ts` calls `sent_for_region` "the strongest signal in
  // this file". `applied_for_job_title` is what they said they want. `current_job_title` is what
  // their CV says they do now, which is a DIFFERENT claim and therefore last.
  //
  // Reaching for the current title is safe precisely because it is last: a candidate who named a
  // job they applied for never consults it, so this can never move anyone AWAY from the folder
  // their own answer earned. It only fills in for someone who would otherwise be in
  // `Position not stated`, and "the CV says medical rep" is a better answer than "we have no idea".
  // Measured 2026-09-07: of 449 candidates with no applied-for title, 15 have a recruiter's
  // `sent_for_job_title` and 338 a `current_job_title`, taking the unknown branch from 462 CVs —
  // over half the cabinet — down to 109.
  const title =
    cleanFolderKey(filedKind === "other" ? filedKey : null) ??
    cleanFolderKey(row.sent_for_job_title) ??
    cleanFolderKey(row.applied_for_job_title) ??
    cleanFolderKey(row.current_job_title);

  // Blank is NOT "other": "we do not know this person's job" is a different claim from "their job is
  // none of these", and only the second deserves a folder full of unrelated roles.
  const family = candidateRoleFamilyOrNull(title);

  // ── THE LAST RUNG: THE DEGREE, WHEN NO TITLE SURVIVED ──────────────────────────────────────────
  //
  // A pharmacy, science, veterinary or dentistry graduate with no job title anywhere is the medical
  // rep pool. Measured 2026-09-08: 118 CVs sat in `Position not stated`, and 32 of them had exactly
  // that — a recognised, eligible degree and nothing else. Filing them under the shrug meant the one
  // group Phoenix hires most of was the hardest group to find.
  //
  // OWNER'S CHOICE, ASKED AND ANSWERED. This asserts a position nobody stated, and the alternative
  // offered was a truthful `Graduate — Pharmacy` shelf that claims only what is known. He chose this
  // one: the cabinet is where a recruiter LOOKS, and a science graduate with no title is looked for
  // beside the reps. Recorded because the objection is real and a later reader will raise it again.
  //
  // LAST, so it can only ever fill a gap. Any title that resolves to a family — including `other` —
  // is reached first, so this can never move somebody away from a folder their own words earned.
  //
  // THE GATE IS THE APP'S OWN. `canAutoFileBackground` already decides which degrees may be acted on
  // unattended, and it refuses paramedical and unrecognised ones. Of the 118, it cleared 32 and
  // declined 86 — 25 paramedical, 61 unreadable. Re-deriving that judgement here would be a second
  // copy of a rule that has already been argued out once.
  if (!family && canAutoFileBackground({ declaredBackground: row.declared_background, faculty: row.faculty })) {
    return candidateRoleFamilyLabels.medical_rep;
  }

  if (!family) return POSITION_NOT_STATED;

  // A job title that is really a WhatsApp message never becomes a folder name — the measured case is
  // "بخصوص الإعلان دا" ("regarding this advertisement"), typed into the title box and already a
  // folder in the old tree. The classifier cannot catch it because it is a valid-looking string that
  // matches no family, so the readability test still guards the one place it could surface.
  if (family === "other") {
    return title && readsAsAJobTitle(title) ? OTHER_POSITIONS_FOLDER : POSITION_NOT_STATED;
  }
  return candidateRoleFamilyLabels[family];
}

/**
 * The region and area folders for one candidate — levels two and three.
 *
 * Resolution runs strongest-signal-first and stops at the first answer, so a stated area is never
 * overridden by an inference drawn from the same record.
 *
 * `region` is always a string; `area` is null whenever nothing names one, and the caller then files
 * one level shallower rather than inventing a folder.
 */
export function cabinetPlaceFolders(
  row: CabinetCandidateRow,
  areaRegions: AreaRegionMap,
): { region: string; area: string | null } {
  const statedArea = cleanFolderKey(row.preferred_area_name);
  const statedRegion = cleanFolderKey(row.preferred_region_code);

  // 1. A stated AREA is the strongest thing here: it names both rungs at once.
  if (statedArea) {
    const region = regionFolderForArea(statedArea, areaRegions);
    // Routed through `regionFolderForArea`, which applies the recruitment Delta (3) override rather
    // than the raw sales `code_region_code`. Reading the column directly would file a Sharkia
    // applicant under Delta (2) — the exact mis-file that override exists to prevent.
    if (region) return { area: statedArea, region };

    // Not one of the company's areas — almost always a governorate typed by hand. Their words never
    // become a folder verbatim: "Qena north" would sit beside the real "Qena 1" and "Qena 2" wearing
    // an official-looking name for a territory nobody owns. Resolve to what the company does own.
    const typedRegion = regionFolderFromTypedArea(statedArea);
    if (typedRegion) return { area: governorateFolderFromTypedArea(statedArea), region: typedRegion };
  }

  // 2. A stated REGION with no readable area — the District Manager case, and every applicant who
  //    answered the region question and skipped the area one.
  if (statedRegion) {
    const label = candidateFolderLabel("district_manager", statedRegion);
    if (label) return { area: null, region: label };
  }

  // 3. Nothing stated. Fall to the same inference the mirror uses. It answers a real placement or
  //    null, and null genuinely means the record names nowhere — a fact, not a failure.
  const placement = inferCandidatePlacement({
    address: row.address,
    governorate: row.governorate,
    preferredRegionCode: row.preferred_region_code,
    sentForRegion: row.sent_for_region,
  });
  if (!placement) return { area: null, region: REGION_NOT_STATED };

  // A foreign country is not an Egyptian region, so it becomes the AREA under one shared region
  // folder. That keeps the region level a list of the company's own eight and nothing else.
  if (placement.basis === "outside-egypt") {
    return { area: placement.label || null, region: OUTSIDE_EGYPT_REGION };
  }
  return { area: null, region: placement.label || REGION_NOT_STATED };
}

/**
 * The full cabinet path for one CV: `[position, region]` or `[position, region, area]`.
 *
 * Sanitized here as well as at the Drive layer, deliberately — this is the last point at which a
 * segment is still a domain value rather than a folder name, and a typed job title carrying a "/"
 * ("HR Generalist / HR Operations / Personnel & Payroll" is live in production) would otherwise read
 * as three folders in any path-shaped view of the tree.
 */
export function cabinetPathFor(row: CabinetCandidateRow, areaRegions: AreaRegionMap): string[] {
  const { area, region } = cabinetPlaceFolders(row, areaRegions);
  const segments = area ? [cabinetPositionFolder(row), region, area] : [cabinetPositionFolder(row), region];
  return segments.map(sanitizeDriveSegment).filter(Boolean);
}
