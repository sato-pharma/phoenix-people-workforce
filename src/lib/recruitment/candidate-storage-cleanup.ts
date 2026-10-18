// Recruitment / ATS — taking a deleted candidate's file BYTES out of storage.
//
// WHY THIS EXISTS. `ats_files` rows cascade away with their candidate, but each row only POINTS at
// an object in the private `recruitment-files` bucket (the column is named `drive_file_id` and holds
// the Supabase Storage path — see 20260903213000_cv_google_drive_mirror.sql). Nothing removed the
// object, so a deleted candidate's CV or job offer stayed in the bucket with no row left that could
// ever name it. Measured on production 2026-10-18: 89 objects had no `ats_files` row, among them job
// offers and the CVs of people whose records had been deleted.
//
// TWO HALVES, because the cascade destroys the only record of where the bytes are:
//   readCandidateStoragePaths       BEFORE the delete, while the rows still exist
//   removeCandidateStorageObjects   AFTER the record delete has succeeded
//
// NEITHER HALF EVER THROWS. A storage problem is logged, never raised: it must not roll back or block
// the record delete (owner brief, 2026-10-18). A failure here leaves bytes in the bucket — the state
// before this module existed — and says so in the log; it never leaves a half-deleted candidate.
//
// ONLY A DELETED CANDIDATE'S OWN PATHS ARE EVER REMOVED. Never sweep "objects with no `ats_files` row":
// on 2026-10-18 the three that remained were interview-calendar CVs that an `ats_interview_bookings` or
// `ats_interview_request_items` row still points at through `external_cv_file_id`, which are real and
// in use. The Storage API is the only door — `delete from storage.objects` is refused by
// `storage.protect_delete()` (42501) and would take its whole transaction with it.

import type { SupabaseClient } from "@supabase/supabase-js";

import { logError } from "@/lib/observability/log";
import { recruitmentDb } from "@/lib/recruitment/db";
import { RECRUITMENT_FILES_BUCKET } from "@/lib/recruitment/supabase-storage";

/** PostgREST answers an over-long `.in()` with ZERO rows and no error, so filters are chunked. */
const CHUNK_SIZE = 50;

export type StorageCleanupLabels = Record<string, string | number>;

export type StorageCleanupDeps = {
  /** The service-role client. Tests hand in a plain-object fake; production leaves it unset. */
  client?: SupabaseClient;
  /** Where a swallowed failure is written. Never receives a storage path, which names a person. */
  logFailure?: (message: string, details: { error: unknown; labels: StorageCleanupLabels }) => void;
};

export type StorageCleanupOutcome = {
  /** Paths left in the bucket because a failure stopped their removal. */
  failed: number;
  /** Paths left in the bucket on purpose: a surviving `ats_files` row still points at them. */
  keptReferenced: number;
  /** Objects the Storage API reported as removed. */
  removed: number;
};

function defaultLogFailure(message: string, details: { error: unknown; labels: StorageCleanupLabels }): void {
  logError(message, { error: details.error, labels: details.labels });
}

function chunk<T>(items: readonly T[], size = CHUNK_SIZE): T[][] {
  const out: T[][] = [];
  for (let at = 0; at < items.length; at += size) out.push(items.slice(at, at + size));
  return out;
}

/** The distinct, non-blank storage paths in a list of raw column values, in first-seen order. */
export function distinctStoragePaths(values: readonly unknown[]): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") continue;
    const path = value.trim();
    if (path) seen.add(path);
  }
  return [...seen];
}

function pathsOf(rows: readonly unknown[] | null | undefined): string[] {
  return distinctStoragePaths((rows ?? []).map((row) => (row as { drive_file_id?: unknown } | null)?.drive_file_id));
}

/**
 * The storage paths of every file the candidate holds, read BEFORE the record is deleted.
 *
 * Reads by `candidate_id`, which covers a file attached to one of the candidate's applications too:
 * `uploadCandidateFile` always requires the candidate (production 2026-10-18: 214 files, none with a
 * null `candidate_id`). Returns an empty list — and logs — if the read fails, so a cleanup problem can
 * never be the reason a record survives its delete.
 */
export async function readCandidateStoragePaths(
  candidateId: string,
  deps: StorageCleanupDeps = {},
): Promise<string[]> {
  const logFailure = deps.logFailure ?? defaultLogFailure;
  try {
    const client = deps.client ?? recruitmentDb();
    const { data, error } = await client.from("ats_files").select("drive_file_id").eq("candidate_id", candidateId);
    if (error) throw error;
    return pathsOf(data);
  } catch (error) {
    logFailure("Could not list a candidate's stored files before deleting the record; their bytes will stay in storage", {
      error,
      labels: { candidate_id: candidateId, event: "candidate_delete_storage_list_failed" },
    });
    return [];
  }
}

/**
 * Removes the given objects from the recruitment bucket, AFTER the candidate row is gone.
 *
 * A path that a SURVIVING `ats_files` row still names is kept, not removed. Nothing writes two rows
 * onto one path today (every upload mints a fresh `cv/<uuid>/…`), but bytes cannot be taken back and
 * two ordinary events could make the list wrong: a merge that re-points a file to its survivor
 * between the read and the delete, and any future copy-by-reference. If that check cannot be
 * completed, NOTHING is removed — a leaked object is recoverable, a deleted one is not.
 *
 * Removal goes in batches, and one batch failing leaves the others to run.
 */
export async function removeCandidateStorageObjects(
  candidateId: string,
  paths: readonly string[],
  deps: StorageCleanupDeps = {},
): Promise<StorageCleanupOutcome> {
  const outcome: StorageCleanupOutcome = { failed: 0, keptReferenced: 0, removed: 0 };
  const wanted = distinctStoragePaths(paths);
  if (wanted.length === 0) return outcome;

  const logFailure = deps.logFailure ?? defaultLogFailure;

  let client: SupabaseClient;
  const stillReferenced = new Set<string>();
  try {
    client = deps.client ?? recruitmentDb();
    for (const batch of chunk(wanted)) {
      const { data, error } = await client.from("ats_files").select("drive_file_id").in("drive_file_id", batch);
      if (error) throw error;
      for (const path of pathsOf(data)) stillReferenced.add(path);
    }
  } catch (error) {
    outcome.failed = wanted.length;
    logFailure("Could not confirm a deleted candidate's files are unreferenced; nothing was removed from storage", {
      error,
      labels: {
        candidate_id: candidateId,
        event: "candidate_delete_storage_check_failed",
        file_count: wanted.length,
      },
    });
    return outcome;
  }

  const removable = wanted.filter((path) => !stillReferenced.has(path));
  outcome.keptReferenced = wanted.length - removable.length;

  for (const batch of chunk(removable)) {
    try {
      const { data, error } = await client.storage.from(RECRUITMENT_FILES_BUCKET).remove(batch);
      if (error) throw error;
      outcome.removed += Array.isArray(data) ? data.length : 0;
    } catch (error) {
      outcome.failed += batch.length;
      logFailure("Could not remove a deleted candidate's files from storage; the bytes are still in the bucket", {
        error,
        labels: {
          candidate_id: candidateId,
          event: "candidate_delete_storage_remove_failed",
          file_count: batch.length,
        },
      });
    }
  }

  return outcome;
}
