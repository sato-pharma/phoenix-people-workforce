/**
 * Phoenix CRM — issuing and reading a server-minted time anchor (A1, phase 2).
 *
 * The rules are pure and live in `@/lib/phoenix-crm/offline-clock`; this file is their I/O, and it
 * has exactly one job worth stating: **the anchor's timestamp is the server's and only ever the
 * server's.** `issued_at` is defaulted by the database, no request body can reach it, and nothing
 * here reads a clock supplied by a phone.
 *
 * WHY (owner, 2026-09-27): "I want the Cairo time, but I don't want the time on the phone because
 * they may install an app that changes the time in the phone." So the phone is given a starting
 * point it cannot move, and later sends only how much monotonic time has elapsed since.
 *
 * WHY THE ANCHOR IS A ROW AND NOT A SIGNED TOKEN. A signature needs a secret, and a secret needs
 * creating, distributing to Railway and GitHub, and rotating — this repository has already lost a
 * day to a half-rotated one. A row needs none of that: the server looks it up and knows first-hand
 * whether it issued it, to whom, for which territory and when. The row is the evidence, readable
 * long afterwards by a human asking how a visit came to be dated as it was.
 *
 * NOTHING HERE IS SINGLE-USE, deliberately. One anchor dates every visit a rep captures during one
 * offline stretch. What bounds it is AGE, checked in the pure module at the moment of use.
 */

import { ApiError, validationError } from "@/lib/http/api-errors";
import { type TimeAnchorRecord } from "@/lib/phoenix-crm/offline-clock";
import { readTestFlag, territoryForVisit, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { throwIfError } from "@/lib/phoenix-crm/server/db";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

/**
 * How many anchors one person may take in an hour.
 *
 * The phone re-anchors opportunistically — on app open and after a successful request — so an honest
 * day asks for a handful. This is far above that and low enough that a loop cannot fill the table;
 * the same shape and the same reasoning as `SLOTS_PER_HOUR` on the photo slots.
 */
export const ANCHORS_PER_HOUR = 60;

/** The longest a boot identity may be. Android's is short; this is generous and bounded. */
const BOOT_ID_MAX = 120;

export type TimeAnchorView = {
  anchorId: string;
  /** The server's clock, ISO. The phone stores this beside its own monotonic reading. */
  issuedAt: string;
};

function bootIdOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > BOOT_ID_MAX) throw validationError("The phone reported an unusable restart id.");
  return trimmed;
}

/**
 * Mint an anchor for the person about to go offline.
 *
 * Gated with `territoryForVisit` rather than `territoryForRepWrite`: an anchor is used to date a
 * VISIT, and a visit may be entered by the territory's rep, by a manager of the territory, or by the
 * Super Admin in test mode. Using the narrower gate would leave a district manager unable to enter a
 * double visit in a dead spot.
 */
export async function issueTimeAnchor(viewer: PhoenixCrmViewer, raw: unknown): Promise<TimeAnchorView> {
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const test = readTestFlag(body.test);
  const { seat, isTest } = territoryForVisit(viewer, body.seatId, test);
  const bootId = bootIdOf(body.bootId);

  const supabase = getSupabaseAdmin();
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const recent = await supabase
    .from("phoenix_crm_time_anchors")
    .select("id", { count: "exact", head: true })
    .eq("hr_id", viewer.hrId)
    // Counted per world: a test account's anchors are filed under the rep it mirrors.
    .eq("is_test", isTest)
    .gte("issued_at", since);
  throwIfError(recent.error);
  if ((recent.count ?? 0) >= ANCHORS_PER_HOUR) {
    throw new ApiError(429, "rate_limited", "The app asked for too many time checks. Wait a few minutes and try again.");
  }

  // 🔴 `issued_at` is NOT written here. The column defaults to now() in the database, so the
  // server's clock is the only thing that can set it and no request body can reach it.
  const { data, error } = await supabase
    .from("phoenix_crm_time_anchors")
    .insert({ hr_id: viewer.hrId, seat_id: seat.seatId, boot_id: bootId, is_test: isTest })
    .select("id, issued_at")
    .single();
  throwIfError(error);
  const row = (data ?? {}) as Row;
  return { anchorId: String(row.id), issuedAt: String(row.issued_at) };
}

/**
 * The anchor as the server holds it, for the pure rules to judge a claim against.
 *
 * Returns null rather than throwing on a missing id: an unknown anchor is one of the refusals the
 * rules already name (`no_anchor`), and it must stay a silent verdict on the board rather than an
 * error on a rep's phone.
 */
export async function readTimeAnchor(anchorId: unknown): Promise<TimeAnchorRecord | null> {
  const id = typeof anchorId === "string" ? anchorId.trim() : "";
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;

  const { data, error } = await getSupabaseAdmin()
    .from("phoenix_crm_time_anchors")
    .select("id, hr_id, seat_id, boot_id, issued_at, is_test")
    .eq("id", id)
    .maybeSingle();
  throwIfError(error);
  if (!data) return null;
  const row = data as Row;
  const issuedAt = new Date(String(row.issued_at));
  if (Number.isNaN(issuedAt.getTime())) return null;
  return {
    anchorId: String(row.id),
    issuedAt,
    hrId: String(row.hr_id ?? ""),
    seatId: String(row.seat_id ?? ""),
    bootId: row.boot_id ? String(row.boot_id) : null,
    isTest: row.is_test === true,
  };
}
