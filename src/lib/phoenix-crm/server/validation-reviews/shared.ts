/**
 * Place checks — the helpers every read and write here shares: the row reader, the short-name gate, the windows and the decider's name.
 * Moved out of `validation-reviews.ts` unchanged on 23 Nov 2026, so no file of Place checks is over 400
 * lines; that file re-exports everything here that it exported, so import from it.
 */

import { validationError } from "@/lib/http/api-errors";
import { distanceMeters, type GeoPoint } from "@/lib/phoenix-crm/geo";
import type { GoogleListing } from "@/lib/phoenix-crm/google-place-rules";
import { isUuid } from "@/lib/phoenix-crm/plan-rules";
import { numberOrNull, selectByIds, throwIfError } from "@/lib/phoenix-crm/server/db";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { APPROVAL_NEEDS_FULL_NAME, approvalNeedsFullName, VALIDATION_FULL_NAME_CODE } from "@/lib/phoenix-crm/pm-name-rules";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import type { ValidationReviewReading } from "@/lib/phoenix-crm/server/validation-reviews/types";

export type Row = Record<string, unknown>;

/** Where the Super Admin decides them (the SFE Manager reads the page and recommends). */
export const VALIDATION_REVIEWS_PATH = "/admin/field-crm/validation-reviews";

/** How long a decided review stays on the page beside the waiting ones. */
export const DECIDED_SHOWN_DAYS = 14;

/**
 * How long a REJECTED review stays, which is longer — because it still carries an action.
 *
 * 🔴 THE 14-DAY WINDOW WAS ABOUT TO TAKE THE UNDO WITH IT. `Approve it after all` lives on the
 * rejected row, so a rejection that scrolls off the page cannot be taken back by anybody: measured
 * 2026-10-15, all 49 of production's rejected reviews were inside 14 days, and the oldest (5 October)
 * would have lost its undo on the 19th — silently, with nothing going red. 90 days covers "I rejected
 * that last month by mistake"; a rejection whose place is no longer retired has nothing left to undo
 * and falls back under the ordinary window.
 */
export const REJECTED_SHOWN_DAYS = 90;

export function text(value: unknown): string | null {
  const cleaned = typeof value === "string" ? value.trim() : "";
  return cleaned ? cleaned : null;
}

/**
 * 🔴 A CLINIC CUSTOMER WITH ONLY ONE OR TWO NAMES IS NEVER APPROVED — HE IS SENT BACK FOR ALL THREE
 * (owner, 2026-11-07: "Don't accept from the beginning the two names"; for the validations already
 * waiting, "Send them back to the rep"). Approving him would validate a name every visit save then
 * refuses, so every approve path the SFE Manager shares asks this first: a held review and a place the
 * system never questioned. A rejection taken back does NOT — that is the Super Admin's alone and he is
 * never blocked (owner, 2026-11-10); he approves as it stands or corrects the name (`restoreValidation`). The screens disable Approve on the same rule (`approvalNeedsFullName`); this
 * is the boundary. Nothing is refused in the data — the rejection, with `short_name`, is the decider's press.
 */
export async function refuseApprovalOfShortName(customerId: unknown): Promise<void> {
  if (!isUuid(customerId)) return;
  const { data, error } = await getSupabaseAdmin()
    .from("phoenix_crm_customers")
    .select("name, list_type")
    .eq("id", String(customerId).toLowerCase())
    .maybeSingle();
  throwIfError(error);
  const customer = data as Row | null;
  if (customer && approvalNeedsFullName({ listType: customer.list_type, customerName: customer.name })) {
    throw validationError(APPROVAL_NEEDS_FULL_NAME, VALIDATION_FULL_NAME_CODE);
  }
}

/** The customer a review is about, for the gate above. */
export async function reviewCustomerId(reviewId: string): Promise<string | null> {
  const { data, error } = await getSupabaseAdmin().from("phoenix_crm_validation_reviews").select("customer_id").eq("id", reviewId).maybeSingle();
  throwIfError(error);
  return text((data as Row | null)?.customer_id);
}

/**
 * Whether the system's own approval of this held review must wait for the three names.
 *
 * Phoenix CRM validation audit, 14 Nov 2026: the system approves a held signboard through the same
 * function the two deciders' button runs, but it called it directly, so the one approve path that asked
 * nothing about a short name was the system's. It asks the SAME gate now, and reads its refusal as an
 * answer: true means "leave this one waiting", where the deciders' Approve is disabled and the rejection
 * with `short_name` sends it back to the rep. Any other failure travels to the caller.
 */
export async function heldReviewNeedsFullName(reviewId: string): Promise<boolean> {
  try {
    await refuseApprovalOfShortName(await reviewCustomerId(reviewId));
    return false;
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === VALIDATION_FULL_NAME_CODE) return true;
    throw error;
  }
}

/**
 * Which of these places are still in use.
 *
 * Phoenix CRM validation audit, 14 Nov 2026: a rejected building, and a place retired from the list,
 * both retire the place and leave a pending review of it pending. Every reader that asked "is a review
 * waiting?" then answered yes for a place nobody can decide any more, so the customer read "checking"
 * for ever and his requests were held on Place checks. A pending review counts only while its place is
 * active; this is the one read that says which are. Two plain reads, never an embedded join.
 */
export async function activePlaceIds(placeIds: ReadonlyArray<string | null | undefined>): Promise<Set<string>> {
  const rows = await selectByIds<Row>("phoenix_crm_places", "id", "id", placeIds, (query) => query.eq("status", "active"));
  return new Set(rows.map((row) => String(row.id)));
}

/** Whether one decision was made after another. An instant that cannot be read is never the later one. */
export function decidedLater(left: unknown, right: unknown): boolean {
  const leftAt = Date.parse(String(left ?? ""));
  const rightAt = Date.parse(String(right ?? ""));
  if (Number.isNaN(leftAt)) return false;
  return Number.isNaN(rightAt) || leftAt > rightAt;
}

/**
 * Whether a review row is still somebody's to decide, for the page and for the count that must equal it.
 * A DECIDED row always is shown (its history and its undo are its own). A WAITING row is, unless its
 * place was read and is no longer in use. 🔴 A place that could not be read hides nothing: the row stays,
 * because a waiting review that disappears is the one failure this queue must never have.
 */
export function reviewStillToDecide(review: Row, placeById: ReadonlyMap<string, Row>): boolean {
  if (review.status !== "pending") return true;
  const place = placeById.get(String(review.place_id));
  return !place || place.status === "active";
}

// ── Telling the Super Admin ─────────────────────────────────────────────────────────────────────

export function reviewNoticeKey(reviewId: string): string {
  return `phoenix_crm:validation_review:${reviewId}`;
}

/**
 * The decider the system writes when it approves a held signboard (`SIGNBOARD_SYSTEM_ACTOR` in
 * server/signboard-holds.ts, which imports this file — so the word is restated here rather than
 * imported back, and `tests/phoenix-crm-held-signboard.test.ts` holds the two equal).
 */
const SYSTEM_DECIDER = "SYSTEM";

/** Who decided a review, as a word the screen can print: the system's own word, a person's name, or nothing. */
export function deciderLabel(names: Awaited<ReturnType<typeof loadPeopleNames>>, hrId: string | null): string | null {
  if (!hrId) return null;
  return hrId === SYSTEM_DECIDER ? "The system" : nameOf(names, hrId, "") || null;
}

export function reading(lat: unknown, lon: unknown, accuracy: unknown): ValidationReviewReading | null {
  const latitude = numberOrNull(lat);
  const longitude = numberOrNull(lon);
  return latitude === null || longitude === null ? null : { lat: latitude, lon: longitude, accuracyMeters: numberOrNull(accuracy) };
}

export function listingsOf(google: Row, point: GeoPoint): Array<GoogleListing & { distanceMeters: number }> {
  const raw = Array.isArray(google.listings) ? (google.listings as Row[]) : [];
  const listings: Array<GoogleListing & { distanceMeters: number }> = [];
  for (const listing of raw) {
    const lat = numberOrNull(listing.lat);
    const lon = numberOrNull(listing.lon);
    if (lat === null || lon === null) continue;
    listings.push({
      placeId: String(listing.placeId ?? ""),
      name: String(listing.name ?? ""),
      lat,
      lon,
      mapsUri: text(listing.mapsUri),
      distanceMeters: distanceMeters(point, { lat, lon }),
    });
  }
  return listings.sort((left, right) => left.distanceMeters - right.distanceMeters);
}

/**
 * `created_at desc, id desc` — the order `loadValidatedPlaces` used to ask the database for. Time is
 * compared as an instant first (an offset in the text cannot reorder it); two stamps in the same
 * millisecond fall back to the text, which carries the microseconds; then the id, compared as plain
 * text because a lowercase uuid string sorts exactly as Postgres sorts the uuid.
 */
export function newestValidatedFirst(left: Row, right: Row): number {
  const leftAt = String(left.created_at ?? "");
  const rightAt = String(right.created_at ?? "");
  const byInstant = Date.parse(rightAt) - Date.parse(leftAt);
  if (Number.isFinite(byInstant) && byInstant !== 0) return byInstant;
  if (leftAt !== rightAt) return leftAt < rightAt ? 1 : -1;
  const leftId = String(left.id);
  const rightId = String(right.id);
  return leftId === rightId ? 0 : leftId < rightId ? 1 : -1;
}

export function isRecord(value: unknown): value is Row {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
