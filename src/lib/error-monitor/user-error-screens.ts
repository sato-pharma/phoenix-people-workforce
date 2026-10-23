import crypto from "node:crypto";

import type { AccessContext } from "@/lib/auth/permissions";
import {
  USER_ERROR_SCREENS_BUCKET,
  USER_ERROR_SCREENS_TABLE,
  screenStoragePath,
  type ScreenReport,
} from "@/lib/error-monitor/screen-intake";
import { cairoDateTimeSortable } from "@/lib/format/cairo-datetime";
import { hrIdForStorage } from "@/lib/hr-id";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { isTestAccountRow } from "@/lib/system-audit/noise";

/**
 * Storing one error screenshot — the server half behind /api/errors/screen.
 *
 * The file goes into the private bucket first, then its row; a row that cannot be written takes its
 * file back out, so the bucket never holds a picture nothing points at. Service-role only (the table
 * and the bucket are locked to it), so this runs only inside the route, after the caller is resolved.
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
  const { error: uploadError } = await bucket.upload(storagePath, input.report.image.bytes, {
    cacheControl: "private, max-age=0",
    contentType: input.report.image.contentType,
    upsert: false,
  });
  if (uploadError) throw failure("upload", { message: uploadError.message });

  const { error: insertError } = await supabase.from(USER_ERROR_SCREENS_TABLE).insert({
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
  if (insertError) {
    // No row, so no picture: take the file back out (best effort — it is unreachable either way).
    await bucket.remove([storagePath]).catch(() => undefined);
    throw failure("insert", insertError);
  }
  return { id, storagePath };
}
