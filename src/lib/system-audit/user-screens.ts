import {
  USER_ERROR_SCREENS_BUCKET,
  USER_ERROR_SCREENS_RETENTION_DAYS,
  USER_ERROR_SCREENS_TABLE,
} from "@/lib/error-monitor/screen-intake";
import { isUuid } from "@/lib/http/uuid";
import type { ScreenKind } from "@/lib/error-monitor/screen-capture-rules";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * The error screenshots, as the System Audit reads them — the row drawer's pictures, the Super
 * Admin's image route, and the nightly 90-day retention.
 *
 * Service-role reads of a service-role-only table and a private bucket, so every caller is behind
 * assertSystemAdministratorWorkspaceAccess (the drawer and the image route) or inside the
 * CRON_SECRET-checked nightly sweep. A failed read THROWS; nothing here turns a failure into "no
 * pictures".
 */

type Client = ReturnType<typeof getSupabaseAdmin>;

function client(override?: Client): Client {
  return override ?? getSupabaseAdmin({ requestTimeoutMs: 15_000 });
}

function failure(what: string, error: { message?: string; code?: string } | null): Error {
  const code = error?.code ? ` (${error.code})` : "";
  return new Error(`System audit screenshot ${what} failed${code}: ${error?.message ?? "unknown error"}`);
}

export type UserScreenSummary = {
  id: string;
  capturedAt: string;
  kind: ScreenKind;
  httpStatus: number | null;
  width: number | null;
  height: number | null;
};

/** The screens named by `ids` that still exist (a pruned one is simply absent), oldest first. */
export async function loadUserScreenSummaries(ids: readonly string[], override?: Client): Promise<UserScreenSummary[]> {
  const wanted = Array.from(new Set(ids.filter((id) => isUuid(id)))).slice(0, 50);
  if (wanted.length === 0) return [];
  const { data, error } = await client(override)
    .from(USER_ERROR_SCREENS_TABLE)
    .select("id, created_at, kind, http_status, width, height")
    .in("id", wanted)
    .order("created_at", { ascending: true });
  if (error) throw failure("read", error);
  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    capturedAt: String(row.created_at),
    kind: row.kind as ScreenKind,
    httpStatus: typeof row.http_status === "number" ? row.http_status : null,
    width: typeof row.width === "number" ? row.width : null,
    height: typeof row.height === "number" ? row.height : null,
  }));
}

/** Whose screen a picture is, for the audit row its viewing writes (screenshot-views.ts). */
export type UserScreenTaken = {
  hrId: string | null;
  loginId: string | null;
  kind: string | null;
  pagePath: string | null;
  capturedAt: string | null;
  isTest: boolean;
};

/** One picture's bytes and whose screen it was, or null when no screen has that id (or its file is gone). */
export async function loadUserScreenImage(
  id: string,
  override?: Client,
): Promise<{ contentType: string; bytes: ArrayBuffer; taken: UserScreenTaken } | null> {
  if (!isUuid(id)) return null;
  const supabase = client(override);
  const { data, error } = await supabase
    .from(USER_ERROR_SCREENS_TABLE)
    .select("storage_path, hr_id, login_id, kind, page_path, created_at, is_test")
    .eq("id", id)
    .maybeSingle();
  if (error) throw failure("read", error);
  const row = (data ?? null) as Record<string, unknown> | null;
  const path = typeof row?.storage_path === "string" ? row.storage_path : null;
  if (!row || !path) return null;
  const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
  const taken: UserScreenTaken = {
    hrId: text(row.hr_id),
    loginId: text(row.login_id),
    kind: text(row.kind),
    pagePath: text(row.page_path),
    capturedAt: text(row.created_at),
    isTest: row.is_test === true,
  };
  const { data: file, error: downloadError } = await supabase.storage.from(USER_ERROR_SCREENS_BUCKET).download(path);
  if (downloadError) {
    // A file the bucket no longer holds is "not found", never a server failure.
    if (/not.?found|404/i.test(downloadError.message ?? "")) return null;
    throw failure("download", { message: downloadError.message });
  }
  if (!file) return null;
  return {
    contentType: file.type || (path.endsWith(".webp") ? "image/webp" : "image/jpeg"),
    bytes: await file.arrayBuffer(),
    taken,
  };
}

/**
 * Pictures removed per night, at most — 10 storage calls of 100, and exactly the 1,000 rows one PostgREST
 * read returns (a larger limit would be cut to 1,000 without a word). At 500 a
 * day of more than 500 new pictures would outlive the owner’s 90 days with no alarm (risk review,
 * 23 Oct 2026); a run that hits this cap shows `candidates` equal to it in the run report.
 */
export const SCREEN_PRUNE_BATCH = 1_000;
const STORAGE_REMOVE_CHUNK = 100;

export type ScreenPruneResult = {
  cutoff: string;
  candidates: number;
  deletedRows: number;
  deletedFiles: number;
  /** Rows kept because their file could not be removed — tried again next night. */
  keptForRetry: number;
  error: string | null;
};

/**
 * The 90-day retention (owner, 23 Oct 2026), run inside the nightly sweep. Removes at most 500
 * pictures older than 90 days — and never one the detector has not folded yet (`notAfter`, its
 * watermark), so a picture is always in the ledger before it goes. Each file goes through the
 * Storage API first (a delete on storage.objects is refused by storage.protect_delete), and a row is
 * deleted only once its file is gone; a file that will not go keeps its row for the next night.
 */
export async function pruneUserErrorScreens(
  input: { nowMs: number; notAfter: string | null; limit?: number },
  override?: Client,
): Promise<ScreenPruneResult> {
  const supabase = client(override);
  const cutoffMs = input.nowMs - USER_ERROR_SCREENS_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const notAfterMs = input.notAfter ? Date.parse(input.notAfter) : Number.NaN;
  const cutoff = new Date(Number.isFinite(notAfterMs) ? Math.min(cutoffMs, notAfterMs) : cutoffMs).toISOString();
  const result: ScreenPruneResult = { cutoff, candidates: 0, deletedRows: 0, deletedFiles: 0, keptForRetry: 0, error: null };
  // Never folded at all: nothing is old enough to be safe to remove.
  if (!input.notAfter) return result;

  const { data, error } = await supabase
    .from(USER_ERROR_SCREENS_TABLE)
    .select("id, storage_path")
    .lt("created_at", cutoff)
    .order("created_at", { ascending: true })
    .limit(Math.min(input.limit ?? SCREEN_PRUNE_BATCH, SCREEN_PRUNE_BATCH));
  if (error) throw failure("retention read", error);
  const rows = (data ?? []) as Array<{ id: string; storage_path: string }>;
  result.candidates = rows.length;
  if (rows.length === 0) return result;

  // A hundred at a time: the ids travel in the request URL, and five hundred of them would not fit.
  for (let index = 0; index < rows.length; index += STORAGE_REMOVE_CHUNK) {
    const chunk = rows.slice(index, index + STORAGE_REMOVE_CHUNK);
    const { data: removed, error: removeError } = await supabase.storage
      .from(USER_ERROR_SCREENS_BUCKET)
      .remove(chunk.map((row) => row.storage_path));
    if (removeError) {
      result.error = `Storage refused a removal: ${removeError.message}`;
      result.keptForRetry += chunk.length;
      continue;
    }
    // A file already missing is not listed as removed, and its row is just as safe to delete.
    result.deletedFiles += (removed ?? []).length;
    const ids = chunk.map((row) => row.id);
    const { error: deleteError, count } = await supabase.from(USER_ERROR_SCREENS_TABLE).delete({ count: "exact" }).in("id", ids);
    if (deleteError) throw failure("retention delete", deleteError);
    result.deletedRows += count ?? ids.length;
  }
  return result;
}
