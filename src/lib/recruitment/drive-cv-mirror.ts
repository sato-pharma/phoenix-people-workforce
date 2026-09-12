// Recruitment / ATS — mirroring each CV into the owner's Google Drive, filed by region and area.
//
// WHAT THIS IS AND IS NOT. Supabase Storage stays the app's backend and the source of truth; every
// CV the app serves still comes from there, through the permission-gated download route. Drive is a
// second copy the OWNER browses — his own cabinet, on his phone, in folders that match the shelves
// in the recruitment module. So every failure in this file is swallowed and recorded, never thrown:
// a Drive outage must not fail an intake that has already captured the CV, which is the only part of
// this flow that actually matters.
//
// THE SEQUENCE THIS IS BUILT AROUND. The applicant sends the CV first and answers the questions
// seconds-to-minutes later, on their own time or never. So:
//
//   1. On intake, the CV is mirrored immediately into `<Channel>/Did not answer` — or straight into
//      `Red flags` when it is an auto-forward, a duplicate copy, not a CV, or of unknown source.
//   2. When the classification conversation completes, the same file is MOVED into
//      `<Channel>/<Position>/<Region>/<Area>`, from the applicant's own answers.
//   3. A CV whose sender never answers stays visible in `Did not answer` rather than being guessed
//      into a folder from its contents. The rule itself lives in `drive-cabinet-folders.ts`.
//
// Measured on production 2026-09-03: 510 WhatsApp candidates, 207 of whom finished the conversation
// and 98 of whom named both a region and an area. A design that waited for answers before filing
// would have put roughly three in five CVs nowhere at all.

import { logError, logWarning } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { candidateFolderLabel, cleanFolderKey, isCandidateFolderKind } from "@/lib/recruitment/candidate-folder";
import {
  suggestFolderFromDeclaredAnswers,
  type CandidateFolderSuggestion,
} from "@/lib/recruitment/candidate-folder-suggestion";
import { inferCandidatePlacement } from "@/lib/recruitment/candidate-folder-inference";
import { copyLabelsFor, shouldMirrorCopy, withCopyLabel } from "@/lib/recruitment/cv-duplicate-copies";
import {
  CABINET_ROOT_NAME,
  cabinetImportSendersFromEnv,
  cabinetPathFor,
  earliestIntakeEvent,
  latestCvVerdict,
  type CabinetIntakeEvent,
} from "@/lib/recruitment/drive-cabinet-folders";
import {
  driveFileNameFor,
  driveFolderPathFor,
  driveInferredFolderPath,
  UNCLASSIFIED_FOLDER_NAME,
  type AreaRegionMap,
} from "@/lib/recruitment/drive-cv-folders";
import { isDriveConfigured } from "@/lib/recruitment/drive-storage";
import { moveDriveFile, uploadCvToDrivePath } from "@/lib/recruitment/drive-tree";
import { supabaseFileStorage } from "@/lib/recruitment/supabase-storage";

/**
 * What `drive_mirror_error` holds when a CV was binned in Drive by a person.
 *
 * Exported because it is a STATE, not a failure, and anything reporting on the mirror has to be able
 * to tell the two apart. `scripts/backfill-cvs-to-drive.mjs --verify` counted it under "last attempt
 * errored — run with --retry", which invites re-uploading a CV somebody deleted on purpose; a reader
 * following that advice would undo the deletion and it would look like tidying up.
 *
 * It is a named constant rather than the same sentence written twice, for the reason the backfill
 * script's own folder rule was deleted on 2026-09-08: a second copy cannot be kept in step, it can
 * only be found later — and here the copy would be a string match, which fails silently the first
 * time somebody rewords the message.
 */
export const REMOVED_FROM_DRIVE_BY_HAND = "Removed from Drive by hand — left alone, not re-filed.";

/** How long the area→region grouping is held before being re-read. Areas change a few times a year. */
const AREA_MAP_TTL_MS = 30 * 60_000;

let areaMapCache: { at: number; map: AreaRegionMap } | null = null;

/**
 * area_name -> its SALES region code, from `au_v_canonical_areas`.
 *
 * READ THE PUBLIC VIEW, NEVER `.schema("au")`. PostgREST exposes only public, graphql_public and
 * analytics, so `.schema("au").from("canonical_areas")` answers PGRST106 "Invalid schema: au" — and
 * because every caller here is best-effort, that error is SWALLOWED: no crash, no log a person
 * reads, just every CV filed under "Not yet classified" for ever. `listCandidateFolderAreaOptions`
 * reads this same view, and `tests/drive-cv-folders.test.ts` pins the choice.
 *
 * The recruitment override (Delta (3)) is applied later, inside `driveFolderPathFor`, deliberately:
 * this function's job is to report what the database says, and the override's job is to be the one
 * place recruitment disagrees with it. Merging them here would hide the disagreement.
 */
export async function loadAreaRegionMap(): Promise<AreaRegionMap> {
  const now = Date.now();
  if (areaMapCache && now - areaMapCache.at < AREA_MAP_TTL_MS) return areaMapCache.map;

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("au_v_canonical_areas")
    .select("area_name, code_region_code")
    .eq("is_active", true);
  if (error) throw error;

  const map: Record<string, string> = {};
  for (const row of (data ?? []) as Array<{ area_name?: string | null; code_region_code?: string | null }>) {
    const area = String(row.area_name ?? "").trim();
    const region = String(row.code_region_code ?? "").trim();
    if (area && region) map[area] = region;
  }
  areaMapCache = { at: now, map };
  return map;
}

/** Test seam — and the way to pick up an area rename without waiting out the TTL. */
export function resetAreaRegionCache(): void {
  areaMapCache = null;
}

/** Everything the mirror needs about a candidate, read in one query. */
type MirrorCandidateRow = {
  id: string;
  full_name: string | null;
  phone: string | null;
  whatsapp: string | null;
  status: string | null;
  applied_for_job_title: string | null;
  current_job_title: string | null;
  declared_background: string | null;
  faculty: string | null;
  sent_for_job_title: string | null;
  preferred_area_name: string | null;
  preferred_region_code: string | null;
  preferred_region_name: string | null;
  preferences_declared_at: string | null;
  folder_kind: string | null;
  folder_key: string | null;
  governorate: string | null;
  address: string | null;
  sent_for_region: string | null;
};

const CANDIDATE_FIELDS =
  "id, full_name, phone, whatsapp, status, applied_for_job_title, current_job_title, declared_background, faculty, sent_for_job_title, preferred_area_name, preferred_region_code, preferred_region_name, preferences_declared_at, folder_kind, folder_key, governorate, address, sent_for_region";

/**
 * The folder path for one candidate, and the name their file should carry.
 *
 * The suggestion is asked for on the RAW record rather than on a mapped `Candidate`, so this can run
 * from the intake worker and from a standalone backfill script without either having to build the
 * whole candidate object. `folder` is passed through because `suggestFolderFromDeclaredAnswers`
 * refuses an already-filed candidate — and an already-filed one has a folder we should honour, so it
 * is read directly in that case rather than re-derived.
 */
export function placementFor(
  row: MirrorCandidateRow,
  areaRegions: AreaRegionMap,
  mimeType: string | null,
): { fileName: string; path: string[] } {
  // A candidate a recruiter has ALREADY filed by hand outranks anything derived. That decision is
  // the whole point of the shelf, and re-deriving it would quietly move a CV a human deliberately
  // placed — `suggestFolderFromDeclaredAnswers` refuses a filed candidate for exactly this reason,
  // so the stored folder is read directly instead.
  const filedKind = isCandidateFolderKind(row.folder_kind) ? row.folder_kind : null;
  const filedKey = cleanFolderKey(row.folder_key);
  const suggestion: CandidateFolderSuggestion | null =
    filedKind && filedKey
      ? { key: filedKey, kind: filedKind, label: candidateFolderLabel(filedKind, filedKey) }
      : suggestFolderFromDeclaredAnswers(
          {
            appliedForJobTitle: row.applied_for_job_title,
            folder: null,
            preferencesDeclaredAt: row.preferences_declared_at,
            preferredAreaName: row.preferred_area_name,
            preferredRegionCode: row.preferred_region_code,
            preferredRegionName: row.preferred_region_name,
            status: row.status ?? "",
          },
          // areaRegions is already keyed by every live area name — the same list
          // listCanonicalMedicalRepAreaNames would return, with no second read.
          Object.keys(areaRegions),
        ).suggestion;

  const fileName = driveFileNameFor({
    candidateName: row.full_name,
    mimeType,
    phone: row.whatsapp || row.phone,
  });

  // A STATED answer always wins, and reaches the confirmed tree.
  if (suggestion) return { fileName, path: driveFolderPathFor(suggestion, areaRegions) };

  // Otherwise fall to inference, which files under its own caveated shelf and never mixes with the
  // above. `driveInferredFolderPath` answers a real folder even for a null placement, so there is
  // no third branch and no CV without a folder.
  return {
    fileName,
    path: driveInferredFolderPath(
      inferCandidatePlacement({
        address: row.address,
        governorate: row.governorate,
        preferredRegionCode: row.preferred_region_code,
        sentForRegion: row.sent_for_region,
      }),
    ),
  };
}

async function recordMirror(
  fileId: string,
  patch: { drive_mirror_file_id?: string; drive_mirror_path?: string; drive_mirror_error?: string | null },
): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("ats_files")
    .update({ ...patch, drive_mirror_at: new Date().toISOString() })
    .eq("id", fileId);
  if (error) {
    logWarning("Drive mirror bookkeeping failed", {
      error,
      labels: { event: "drive_mirror_record_failed", fileId },
    });
  }
}

/**
 * What one mirror pass did. `removed` is NOT a failure — it records that the owner binned the file
 * in Drive and the mirror deliberately left it alone, which is a different fact from every other
 * member here and the only one that means "working as intended, and doing nothing".
 */
export type MirrorOutcome = "uploaded" | "moved" | "unchanged" | "skipped" | "removed" | "failed";

/**
 * Mirror ONE stored CV into Drive, or move it if it is already there and its folder has changed.
 *
 * Never throws. Returns what happened so the backfill can count outcomes and the worker can log one
 * line. A failure is written to `drive_mirror_error` so it is visible without reading logs, and
 * cleared on the next success.
 */
export async function mirrorCvToDrive(fileId: string): Promise<MirrorOutcome> {
  if (!isDriveConfigured()) return "skipped";

  try {
    const supabase = getSupabaseAdmin();
    const { data: fileRow, error: fileError } = await supabase
      .from("ats_files")
      .select("id, candidate_id, file_name, mime_type, drive_file_id, drive_mirror_file_id, drive_mirror_path")
      .eq("id", fileId)
      .maybeSingle();
    if (fileError) throw fileError;
    if (!fileRow) return "skipped";

    const row = fileRow as {
      candidate_id: string | null;
      drive_file_id: string | null;
      drive_mirror_file_id: string | null;
      drive_mirror_path: string | null;
      file_name: string | null;
      mime_type: string | null;
    };
    // A row with no storage key has no bytes to copy — a CV-as-link candidate, or a record whose
    // upload failed. Nothing to mirror, and not a failure.
    if (!row.drive_file_id || !row.candidate_id) return "skipped";

    const { data: candidateRow, error: candidateError } = await supabase
      .from("ats_candidates")
      .select(CANDIDATE_FIELDS)
      .eq("id", row.candidate_id)
      .maybeSingle();
    if (candidateError) throw candidateError;
    if (!candidateRow) return "skipped";

    // ONE COPY PER DISTINCT FILE. An applicant who sends the same CV again gets a new `ats_files`
    // row — correctly, it is a real event — and until now that row was mirrored as a second copy in
    // the owner's cabinet. Measured 2026-09-07: 264 of 1,156 mirrored files were byte-identical
    // re-sends, one candidate having THIRTEEN copies of one file in one folder. The row stays; the
    // COPY is suppressed. `content_md5` has existed since 2026-09-05 but nothing read it for this,
    // so the pile was still growing — 15 groups gained a copy after that column shipped.
    const { data: siblingRows, error: siblingError } = await supabase
      .from("ats_files")
      .select("id, content_md5, created_at")
      .eq("candidate_id", row.candidate_id)
      .eq("kind", "cv");
    if (siblingError) throw siblingError;
    const siblings = (siblingRows ?? []) as Array<{ content_md5: string | null; created_at: string | null; id: string }>;

    // THE STORED PATH IS ROOTED, AND THAT PREFIX IS THE WHOLE CUTOVER SAFETY PROPERTY.
    //
    // Every row written before 2026-09-07 records a path in the OLD tree — "From the CV (not
    // confirmed)/Cairo", "Medical Representative/Cairo". Two of those shapes ("Medical
    // Representative/<Region>", "District Manager/<Region>") are indistinguishable from a legitimate
    // CABINET path, so there is no way to tell the trees apart from an unrooted path alone. Without
    // this prefix the mirror would read a legacy row, see a folder mismatch, and MOVE the file —
    // emptying the frozen tree one candidate at a time, silently, with no error anywhere.
    //
    // Prefixed, a legacy row is unmistakable and is treated as "not mirrored HERE": a fresh copy is
    // made in the cabinet and the file in the old tree is never touched.
    const recordedInCabinet = String(row.drive_mirror_path ?? "").startsWith(`${CABINET_ROOT_NAME}/`);

    // A NEW re-send never reaches Drive. A copy that is ALREADY in the cabinet is not deleted and not
    // skipped either: the path rule below sends it to `Red flags/Duplicate copies`, so the original is
    // the only copy left in the channel folders. Measured 2026-09-12: 265 such copies in the cabinet.
    const duplicate = !shouldMirrorCopy(fileId, siblings);
    if (duplicate && !(row.drive_mirror_file_id && recordedInCabinet)) return "skipped";

    // WHERE THE CV ARRIVED, AND WHETHER IT IS A CV AT ALL. The owner's rule files by channel and by
    // the applicant's own answers — never by what the CV says — and parks anything that would mislead
    // a recruiter under `Red flags`. Both facts belong to THIS file, not to the candidate: one person
    // can write to the chatbot line and email careers@, and each CV goes where it actually arrived.
    const { data: intakeRows, error: intakeError } = await supabase
      .from("ats_cv_intake_events")
      .select("channel, mailbox_label, sender_identifier, raw_metadata, created_at")
      .eq("file_id", fileId)
      .order("created_at", { ascending: true })
      .limit(1);
    if (intakeError) throw intakeError;
    const { data: verdictRows, error: verdictError } = await supabase
      .from("ats_candidate_cv_extractions")
      .select("is_cv, created_at")
      .eq("file_id", fileId)
      .order("created_at", { ascending: false })
      .limit(1);
    if (verdictError) throw verdictError;

    const areaRegions = await loadAreaRegionMap();
    const { fileName: baseFileName } = placementFor(candidateRow as MirrorCandidateRow, areaRegions, row.mime_type);
    // A candidate who sent TWO DIFFERENT CVs gets both, and until now both wore the same name in the
    // same folder. The label separates them; a candidate with one CV gets an empty label and the
    // plain name. Owner's request, 2026-09-07: "add the date to the duplicate names".
    const fileName = withCopyLabel(baseFileName, copyLabelsFor(siblings).get(fileId) ?? "");
    // THE CABINET, NOT THE OLD TREE. `Phoenix CVs` is frozen at the owner's instruction ("don't fix.
    // Create a new folder and reroute"), and `ensureRootFolder` resolves the cabinet, so this path
    // is created beneath it. `placementFor` is still the source of the FILE NAME, which the two
    // trees share — only the folders differ.
    const path = cabinetPathFor(
      {
        candidate: candidateRow as MirrorCandidateRow,
        fileId,
        importSenders: cabinetImportSendersFromEnv(process.env),
        intake: earliestIntakeEvent((intakeRows ?? []) as CabinetIntakeEvent[]),
        isCv: latestCvVerdict((verdictRows ?? []) as Array<{ created_at: string | null; is_cv: boolean | null }>),
        siblings,
      },
      areaRegions,
    );
    const pathKey = [CABINET_ROOT_NAME, ...path].join("/");

    // Already in the cabinet: reconcile it. The folder may have changed, and so may the NAME.
    //
    // THE NAME IS WHY THIS NO LONGER SHORT-CIRCUITS ON A MATCHING PATH. A candidate's first CV is
    // named plainly; the moment a SECOND, different CV arrives, both need an arrival-date label to
    // tell them apart (`copyLabelsFor`). `mirrorCandidateCvsToDrive` re-walks every one of that
    // candidate's rows, so the first file IS revisited — but returning early on an unchanged folder
    // meant it kept its plain name while its sibling got a dated one. One dated and one not is worse
    // than neither, because it reads as though the undated file is the only real one.
    //
    // `moveDriveFile` already reads the file's current parents and name in one request and patches
    // only what actually differs, so letting it run costs one GET on an otherwise unchanged row and
    // nothing else. That is a handful of requests per intake, against a name that is wrong until
    // something else happens to move the file.
    if (row.drive_mirror_file_id && recordedInCabinet) {
      const folderUnchanged = row.drive_mirror_path === pathKey;
      const moved = await moveDriveFile({
        driveFileId: row.drive_mirror_file_id,
        newName: fileName,
        path,
      });
      if (moved === "trashed") {
        // THE OWNER BINNED IT, AND THAT IS AN INSTRUCTION, NOT A FAULT.
        //
        // Handled apart from "missing" because the two want opposite responses, and the difference
        // is the whole point of asking Drive for `trashed`. A file that has vanished should be
        // re-filed; a file somebody deliberately deleted must never be — putting it back would
        // overrule the owner with a cron job, and he would have to delete it again after every
        // classification event, with no way to make it stop.
        //
        // So the id is KEPT rather than cleared. Clearing it is what routes a row to the upload
        // branch below, which is exactly the resurrection this avoids; keeping it means every later
        // pass lands here again, reads `trashed`, and does nothing. Idempotent by construction.
        //
        // Real case, 2026-09-07: `MRs JO.pdf` — a job posting that arrived by email and was treated
        // as a CV — binned from the cabinet on its first night. The database went on reporting it
        // filed under Medical Representative / Cairo, because a trashed file answers 200.
        await recordMirror(fileId, {
          drive_mirror_error: REMOVED_FROM_DRIVE_BY_HAND,
        });
        return "removed";
      }
      if (moved === "ok" && folderUnchanged) return "unchanged";
      if (moved === "missing") {
        // Gone rather than binned — moved out from under us, or deleted permanently. Clear our
        // record so the next sweep re-uploads it rather than repeatedly patching a file that is
        // not there.
        await recordMirror(fileId, { drive_mirror_error: "The mirrored file is no longer in Drive." });
        await supabase.from("ats_files").update({ drive_mirror_file_id: null }).eq("id", fileId);
        return "failed";
      }
      await recordMirror(fileId, { drive_mirror_error: null, drive_mirror_path: pathKey });
      return "moved";
    }

    const downloaded = await supabaseFileStorage.downloadFile(row.drive_file_id);
    const driveFileId = await uploadCvToDrivePath({
      bytes: downloaded.bytes,
      fileName,
      mimeType: row.mime_type || downloaded.mimeType,
      path,
    });
    await recordMirror(fileId, {
      drive_mirror_error: null,
      drive_mirror_file_id: driveFileId,
      drive_mirror_path: pathKey,
    });
    return "uploaded";
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Drive mirror failed.";
    logError("Drive CV mirror failed", { error, labels: { event: "drive_cv_mirror_failed", fileId } });
    await recordMirror(fileId, { drive_mirror_error: detail }).catch(() => {});
    return "failed";
  }
}

/**
 * Mirror every stored CV belonging to one candidate.
 *
 * Called from two places: the intake worker, the moment a CV is captured, and the classification
 * session, the moment the applicant's answers land. Both are best-effort and neither awaits it into
 * anything that matters.
 */
export async function mirrorCandidateCvsToDrive(candidateId: string | null | undefined): Promise<void> {
  if (!candidateId || !isDriveConfigured()) return;
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("ats_files")
      .select("id")
      .eq("candidate_id", candidateId)
      .eq("kind", "cv");
    if (error) throw error;
    for (const row of (data ?? []) as Array<{ id: string }>) {
      await mirrorCvToDrive(row.id);
    }
  } catch (error) {
    logError("Drive mirror for candidate failed", {
      error,
      labels: { candidateId, event: "drive_candidate_mirror_failed" },
    });
  }
}

/** Exported for the tests and the backfill's summary line. */
export const DRIVE_HOLDING_FOLDER = UNCLASSIFIED_FOLDER_NAME;
