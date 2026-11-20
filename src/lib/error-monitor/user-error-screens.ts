import crypto from "node:crypto";

import type { AccessContext } from "@/lib/auth/permissions";
import { describeThrown } from "@/lib/error-monitor/describe-thrown";
import {
  USER_ERROR_SCREENS_BUCKET,
  USER_ERROR_SCREENS_TABLE,
  screenStoragePath,
  type ScreenReport,
} from "@/lib/error-monitor/screen-intake";
import {
  ERROR_SCREENSHOT_BUCKET,
  errorScreenshotObjectPath,
  type ErrorScreenshotContentType,
} from "@/lib/error-monitor/screenshot-intake";
import { cairoDateTimeSortable } from "@/lib/format/cairo-datetime";
import { hrIdForStorage } from "@/lib/hr-id";
import { logError, logWarning } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { isTestAccountRow } from "@/lib/system-audit/noise";

/**
 * Storing one error screenshot — the server half behind /api/errors/screen (the block screenshot)
 * and, since 17 Nov 2026, behind /api/errors/client/screenshot (the crash picture,
 * `attachErrorScreenshot`).
 *
 * The file goes into the private bucket first, then its row; a row that cannot be written takes its
 * file back out, and a clean-up that fails is logged (`removeUnreferencedScreenshot`), so a picture
 * nothing points at is never kept in silence. Service-role only (the tables and the buckets are
 * locked to it), so this runs only inside the routes, after the caller is resolved.
 *
 * THE OWNER OF A PICTURE. A real employee's picture is filed under their HR id. A TEST account's
 * session carries the MIRRORED employee's HR id (src/lib/auth/test-persona.ts), so its picture is
 * filed under its own login with `hr_id` empty and `is_test` set — exactly how the System Audit files
 * a test account's errors (noise.ts `isTestAccountRow`, app-error-fold.ts) — and never lands on that
 * employee's line.
 */

type Client = ReturnType<typeof getSupabaseAdmin>;

export type ScreenOwner = { hrId: string | null; loginId: string | null; role: string | null; isTest: boolean };

/** Pure: who a capture is filed under. */
export function screenOwnerFor(access: Pick<AccessContext, "hrId" | "loginId" | "role" | "testPersona">): ScreenOwner {
  // The session holds the lowercase comparison key; the row stores the HR id's stored spelling.
  const hrId = hrIdForStorage(access.hrId?.trim() || null);
  const loginId = access.loginId?.trim() || null;
  const isTest = Boolean(access.testPersona) || isTestAccountRow({ hr_id: hrId, login_id: loginId });
  return {
    hrId: isTest ? null : hrId,
    loginId,
    role: access.role ?? null,
    isTest,
  };
}

function failure(what: string, error: { message?: string; code?: string } | null): Error {
  const code = error?.code ? ` (${error.code})` : "";
  return new Error(`Error screenshot ${what} failed${code}: ${error?.message ?? "unknown error"}`);
}

/** Pictures this owner stored since `sinceIso`. A failed read THROWS — the route refuses rather than guess. */
export async function countRecentUserErrorScreens(owner: ScreenOwner, sinceIso: string, override?: Client): Promise<number> {
  const supabase = override ?? getSupabaseAdmin({ requestTimeoutMs: 8_000 });
  let query = supabase.from(USER_ERROR_SCREENS_TABLE).select("id", { count: "exact", head: true }).gte("created_at", sinceIso);
  if (owner.hrId) query = query.eq("hr_id", owner.hrId);
  else if (owner.loginId) query = query.eq("login_id", owner.loginId);
  else return 0;
  const { count, error } = await query;
  if (error) throw failure("rate-limit read", error);
  return count ?? 0;
}

/**
 * What a clean-up needs of a Storage bucket: supabase-js's own `remove`, which ANSWERS a failure in
 * `{ error }` rather than rejecting.
 */
type RemovableBucket = { remove(paths: string[]): Promise<{ error: unknown }> };

/** Why a picture was left with nothing pointing at it. */
type UnreferencedScreenshotReason = "upload_failed" | "insert_failed" | "row_write_failed" | "row_missing";

/**
 * Take back out a picture nothing points at — and SAY so when it will not go.
 *
 * Both buckets are private and their pictures unmasked, and both 90-day removals work from the ROWS
 * (`pruneUserErrorScreens`, `pruneOldAppErrorEvents`): a file with no row is reached by neither and is
 * kept for ever. Until 17 Nov 2026 the clean-up here was `bucket.remove([...]).catch(() => undefined)`,
 * which could never see a failure — supabase-js `remove()` does not reject, it answers `{ error }` —
 * and the crash route did no clean-up at all. Now the answer is read, a throw is caught too, and a
 * clean-up that fails is logged through the structured logger with the bucket, the reason and the
 * path in its labels, so a person can remove that one file.
 *
 * A failed clean-up after a failed upload is a WARNING: the file may never have landed. After a stored
 * upload whose row could not be written it is an ERROR — the file certainly exists and nothing points
 * at it — which also files it in `app_error_events`, where the System Audit board reads it.
 *
 * Never throws. Returns whether the file is known to be gone.
 */
async function removeUnreferencedScreenshot(
  bucket: RemovableBucket,
  input: { bucket: string; path: string; reason: UnreferencedScreenshotReason },
): Promise<boolean> {
  let cause: unknown = null;
  try {
    const { error } = await bucket.remove([input.path]);
    cause = error ?? null;
  } catch (error) {
    cause = error ?? new Error("Storage remove threw");
  }
  if (cause === null) return true;
  const log = input.reason === "upload_failed" ? logWarning : logError;
  log("An error screenshot with no row pointing at it could not be removed", {
    labels: { event: "error_screenshot_orphan_cleanup_failed", bucket: input.bucket, reason: input.reason, path: input.path },
    error: cause,
  });
  return false;
}

export async function storeUserErrorScreen(
  input: { owner: ScreenOwner; report: ScreenReport; release: string | null; nowMs?: number },
  override?: Client,
): Promise<{ id: string; storagePath: string }> {
  const supabase = override ?? getSupabaseAdmin({ requestTimeoutMs: 15_000 });
  const id = crypto.randomUUID();
  const nowIso = new Date(input.nowMs ?? Date.now()).toISOString();
  const storagePath = screenStoragePath({
    cairoDate: cairoDateTimeSortable(nowIso).slice(0, 10),
    owner: input.owner.hrId ?? input.owner.loginId,
    id,
    contentType: input.report.image.contentType,
  });

  const bucket = supabase.storage.from(USER_ERROR_SCREENS_BUCKET);
  let uploadError: { message?: string } | null = null;
  try {
    const { error } = await bucket.upload(storagePath, input.report.image.bytes, {
      cacheControl: "private, max-age=0",
      contentType: input.report.image.contentType,
      upsert: false,
    });
    uploadError = error;
  } catch (error) {
    uploadError = { message: describeThrown(error) };
  }
  if (uploadError) {
    // A failed upload is not proof that nothing was kept: the 15-second timeout above can fire after
    // Storage stored the bytes. Removing a file that is not there succeeds, so the clean-up always runs.
    await removeUnreferencedScreenshot(bucket, { bucket: USER_ERROR_SCREENS_BUCKET, path: storagePath, reason: "upload_failed" });
    throw failure("upload", { message: uploadError.message });
  }

  let insertError: { message?: string; code?: string } | null = null;
  try {
    const { error } = await supabase.from(USER_ERROR_SCREENS_TABLE).insert({
      id,
      hr_id: input.owner.hrId,
      login_id: input.owner.loginId,
      role: input.owner.role,
      kind: input.report.kind,
      http_status: input.report.httpStatus,
      method: input.report.method,
      api_path: input.report.apiPath,
      page_path: input.report.pagePath,
      message: input.report.message,
      storage_path: storagePath,
      width: input.report.width,
      height: input.report.height,
      bytes: input.report.image.bytes.length,
      release: input.release,
      is_test: input.owner.isTest,
    });
    insertError = error;
  } catch (error) {
    insertError = { message: describeThrown(error) };
  }
  if (insertError) {
    // No row, so no picture: take the file back out, and say so if it will not go.
    await removeUnreferencedScreenshot(bucket, { bucket: USER_ERROR_SCREENS_BUCKET, path: storagePath, reason: "insert_failed" });
    throw failure("insert", insertError);
  }
  return { id, storagePath };
}

export type AttachErrorScreenshotResult =
  | { ok: true; path: string }
  | { ok: false; stage: "upload" | "row"; cause: unknown };

/**
 * The CRASH picture — the server half behind /api/errors/client/screenshot, run after the route has
 * checked the ticket, the size, the rate and the format.
 *
 * The bytes go to the private `error-screenshots` bucket at the error row's own path (`.webp` or
 * `.jpg`, stored under the type its magic bytes proved), then that path onto the row — so a path on a
 * row always resolves. A row that cannot be written, whether the update errors or matches no row,
 * takes the file back out: until 17 Nov 2026 the route answered 500 and left the unmasked picture in
 * the bucket with nothing pointing at it, where no removal would ever reach it. Never throws.
 */
export async function attachErrorScreenshot(
  input: { eventId: string; bytes: Uint8Array; contentType: ErrorScreenshotContentType; now?: Date },
  override?: Client,
): Promise<AttachErrorScreenshotResult> {
  const supabase = override ?? getSupabaseAdmin();
  const path = errorScreenshotObjectPath(input.eventId, input.contentType, input.now);
  const bucket = supabase.storage.from(ERROR_SCREENSHOT_BUCKET);

  let uploadError: unknown = null;
  try {
    // `upsert` so a retry against the same error row replaces its picture rather than orphaning one —
    // the path is keyed by that row's id, so there is only ever one per error.
    const { error } = await bucket.upload(path, input.bytes, { contentType: input.contentType, upsert: true });
    uploadError = error ?? null;
  } catch (error) {
    uploadError = error ?? new Error("Storage upload threw");
  }
  if (uploadError) {
    // As above: the default 15-second timeout can fire after Storage kept the bytes.
    await removeUnreferencedScreenshot(bucket, { bucket: ERROR_SCREENSHOT_BUCKET, path, reason: "upload_failed" });
    return { ok: false, stage: "upload", cause: uploadError };
  }

  let rowError: unknown = null;
  let matched = 0;
  try {
    // `.select("id")` so a write that matched NO row is seen: it answers no error, only an empty list.
    const { data, error } = await supabase
      .from("app_error_events")
      .update({ screenshot_path: path })
      .eq("id", input.eventId)
      .select("id");
    rowError = error ?? null;
    matched = Array.isArray(data) ? data.length : 0;
  } catch (error) {
    rowError = error ?? new Error("The app_error_events update threw");
  }
  if (rowError || matched === 0) {
    await removeUnreferencedScreenshot(bucket, {
      bucket: ERROR_SCREENSHOT_BUCKET,
      path,
      reason: rowError ? "row_write_failed" : "row_missing",
    });
    return { ok: false, stage: "row", cause: rowError ?? new Error("No app_error_events row matched the ticket's id.") };
  }
  return { ok: true, path };
}
