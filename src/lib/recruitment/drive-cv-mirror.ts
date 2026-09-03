// Recruitment / ATS — mirroring each CV into the owner's Google Drive, filed by region and area.
//
// WHAT THIS IS AND IS NOT. Supabase Storage stays the app's backend and the source of truth; every
// CV the app serves still comes from there, through the permission-gated download route. Drive is a
// second copy the OWNER browses — his own cabinet, on his phone, in folders that match the shelves
// in the recruitment module. So every failure in this file is swallowed and recorded, never thrown:
// a Drive outage must not fail an intake that has already captured the CV, which is the only part of
// this flow that actually matters.
//
// THE SEQUENCE THIS IS BUILT AROUND. The applicant sends the CV first and answers the three
// questions seconds-to-minutes later, on their own time or never. So:
//
//   1. On intake, the CV is mirrored immediately into "Not yet classified".
//   2. When the classification conversation completes, the same file is MOVED into its real folder.
//   3. A CV whose sender never answers stays visible in the holding folder rather than nowhere.
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
  preferred_area_name: string | null;
  preferred_region_code: string | null;
  preferences_declared_at: string | null;
  folder_kind: string | null;
  folder_key: string | null;
  governorate: string | null;
  address: string | null;
  preferred_region_code: string | null;
  sent_for_region: string | null;
};

const CANDIDATE_FIELDS =
  "id, full_name, phone, whatsapp, status, applied_for_job_title, preferred_area_name, preferred_region_code, preferences_declared_at, folder_kind, folder_key, governorate, address, sent_for_region";

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
      : suggestFolderFromDeclaredAnswers({
          appliedForJobTitle: row.applied_for_job_title,
          folder: null,
          preferencesDeclaredAt: row.preferences_declared_at,
          preferredAreaName: row.preferred_area_name,
          preferredRegionCode: row.preferred_region_code,
          status: row.status ?? "",
        }).suggestion;

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

export type MirrorOutcome = "uploaded" | "moved" | "unchanged" | "skipped" | "failed";

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

    const areaRegions = await loadAreaRegionMap();
    const { fileName, path } = placementFor(candidateRow as MirrorCandidateRow, areaRegions, row.mime_type);
    const pathKey = path.join("/");

    // Already mirrored: this is a MOVE, and only when the folder actually changed. The common case
    // by far is "unchanged" — the retry sweep re-reads rows it has already handled.
    if (row.drive_mirror_file_id) {
      if (row.drive_mirror_path === pathKey) return "unchanged";
      const moved = await moveDriveFile({
        driveFileId: row.drive_mirror_file_id,
        newName: fileName,
        path,
      });
      if (!moved) {
        // The owner deleted or moved it himself. Clear our record so the next sweep re-uploads it
        // rather than repeatedly patching a file that is not there.
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
