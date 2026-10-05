/**
 * Phoenix CRM — places the Google Maps check could not confirm, and the Super Admin's decision on each.
 *
 * Owner, 2026-10-03: an account Google has no listing for is "held for review and only system admin can
 * approve or reject … but do not show the rep that a person is accepting or rejecting — show him that
 * it's automated from system". So:
 *   · ONE decider: the Super Admin (`canDecideValidationReviews`), never a test account — not the SFE,
 *     not a district manager. The page lives under /admin, a tree a rep cannot open.
 *   · The rep reads only `locationCheck` on his own list ("checking" / "not_confirmed"), worded as the
 *     system's (google-place-rules.ts). Nothing he receives names who decided, or that anybody did.
 *
 * The writes are `phoenix_crm_validate_customer` / `phoenix_crm_add_place` (the hold) and
 * `phoenix_crm_decide_validation_review` (the decision) — migration 20261003130536.
 */

import { forbiddenError, notFoundError, validationError } from "@/lib/http/api-errors";
import { formatPhoenixDateTime } from "@/lib/i18n/format";
import { withdrawInAppNotificationsByEventKeyPrefix } from "@/lib/notifications/in-app";
import { phoenixCrmChannels } from "@/lib/notifications/phoenix-crm-channel-guard";
import { resolveHrIdsForRole } from "@/lib/notifications/role-recipients";
import { createSystemNotificationForRecipients } from "@/lib/notifications/system";
import { logError } from "@/lib/observability/log";
import { cleanText } from "@/lib/phoenix-crm/entry-rules";
import { distanceMeters, type GeoPoint } from "@/lib/phoenix-crm/geo";
import type { GoogleListing, LocationCheckState } from "@/lib/phoenix-crm/google-place-rules";
import { isUuid } from "@/lib/phoenix-crm/plan-rules";
import { territoryName, type OrgSeat } from "@/lib/phoenix-crm/scope";
import type { PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { callPhoenixCrm, numberOrNull, throwIfError } from "@/lib/phoenix-crm/server/db";
import { PHOENIX_CRM_NOTIFICATION_CATEGORY, PHOENIX_CRM_NOTIFICATION_MODULE } from "@/lib/phoenix-crm/server/notifications";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { restampVisitLocationsQuietly } from "@/lib/phoenix-crm/server/visit-locations";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

/** Where the Super Admin decides them. */
export const VALIDATION_REVIEWS_PATH = "/admin/field-crm/validation-reviews";

/** How long a decided review stays on the page beside the waiting ones. */
const DECIDED_SHOWN_DAYS = 14;

/** The Super Admin, and nobody else (owner, 2026-10-03: "only system admin can approve or reject"). */
export function canDecideValidationReviews(viewer: PhoenixCrmViewer): boolean {
  return viewer.isSuperAdmin && viewer.canUpdate && !viewer.isTestPersona;
}

function text(value: unknown): string | null {
  const cleaned = typeof value === "string" ? value.trim() : "";
  return cleaned ? cleaned : null;
}

// ── What the rep's own list reads ───────────────────────────────────────────────────────────────

/**
 * Each customer's check, as his list shows it: `checking` while one waits, `not_confirmed` when the
 * latest one was turned down. A customer never held is simply absent.
 */
export async function loadLocationChecks(seatId: string, isTest: boolean): Promise<Map<string, LocationCheckState>> {
  const { data, error } = await getSupabaseAdmin()
    .from("phoenix_crm_validation_reviews")
    .select("customer_id, status, created_at")
    .eq("seat_id", seatId)
    .eq("is_test", isTest)
    .order("created_at", { ascending: false })
    .limit(1000);
  throwIfError(error);
  const checks = new Map<string, LocationCheckState>();
  for (const row of (data ?? []) as Row[]) {
    const customerId = String(row.customer_id);
    if (row.status === "pending") {
      checks.set(customerId, "checking");
      continue;
    }
    // Newest first: the first decided row is his latest answer, unless a waiting one already spoke.
    if (!checks.has(customerId)) checks.set(customerId, row.status === "rejected" ? "not_confirmed" : null);
  }
  return checks;
}

/** Whether a customer's place is with the Super Admin right now. */
export async function pendingLocationReview(customerId: string): Promise<boolean> {
  const { count, error } = await getSupabaseAdmin()
    .from("phoenix_crm_validation_reviews")
    .select("id", { count: "exact", head: true })
    .eq("customer_id", customerId)
    .eq("status", "pending");
  throwIfError(error);
  return (count ?? 0) > 0;
}

// ── Telling the Super Admin ─────────────────────────────────────────────────────────────────────

function reviewNoticeKey(reviewId: string): string {
  return `phoenix_crm:validation_review:${reviewId}`;
}

/**
 * A held place is waiting, to every Super Admin — which in practice is the owner alone.
 *
 * 🔴 EMAIL, IN-APP AND TELEGRAM (and the phone), BY HIS OWN ORDER (owner, 2026-10-05, naming the page:
 * "when an update here /admin/field-crm/validation-reviews I must be notified by email, in app and
 * telegram"). This is the module's one email that goes nowhere but to him, so the volume argument that
 * keeps the rest of Phoenix CRM email-free does not apply. The channels are NOT written out here: they
 * come from `phoenixCrmChannels`, whose allowlist is the single place the module's email exception is
 * declared and the only place the guard will honour — naming them here would be a second truth that
 * the guard silently overrules.
 *
 * Never throws: the place is already saved, and a notice that cannot be sent must not turn the rep's
 * save into an error.
 */
export async function notifyValidationReviewWaiting(input: { customerName: string; seat: OrgSeat; repHrId: string; reviewId: string | null }): Promise<void> {
  if (!input.reviewId) return;
  try {
    const [{ hrIds }, names] = await Promise.all([resolveHrIdsForRole("Super Admin", "Phoenix CRM — validation reviews"), loadPeopleNames([input.repHrId])]);
    const recipients = hrIds.filter((hrId) => !hrId.startsWith("TEST-"));
    if (recipients.length === 0) return;
    const rep = nameOf(names, input.repHrId, "A rep");
    await createSystemNotificationForRecipients(
      {
        actionUrl: VALIDATION_REVIEWS_PATH,
        category: PHOENIX_CRM_NOTIFICATION_CATEGORY,
        channels: phoenixCrmChannels("validation_review_waiting"),
        eventType: "validation_review_waiting",
        message: `${rep} validated ${input.customerName} (${territoryName(input.seat)}), and the system could not confirm it against Google Maps. It waits for your decision.`,
        metadata: { idempotencyKey: reviewNoticeKey(input.reviewId), seatId: input.seat.seatId },
        module: PHOENIX_CRM_NOTIFICATION_MODULE,
        priority: "normal",
        recordId: input.reviewId,
        subjectHrId: input.repHrId,
        telegram: { ctaLabel: "Open the reviews", ctaUrl: VALIDATION_REVIEWS_PATH },
        title: `Place to check: ${input.customerName}`,
      },
      recipients,
    );
  } catch (error) {
    logError("Phoenix CRM validation review notice failed", { error, labels: { event: "phoenix_crm_validation_review_notify_failed" } });
  }
}

// ── The Super Admin's page ──────────────────────────────────────────────────────────────────────

export type ValidationReviewReading = { lat: number; lon: number; accuracyMeters: number | null };

export type ValidationReviewRow = {
  reviewId: string;
  status: "pending" | "approved" | "rejected";
  kind: "validation" | "added_place";
  isTest: boolean;
  createdAt: string;
  createdAtText: string;
  repName: string;
  territory: string;
  customerName: string;
  listType: string;
  speciality: string | null;
  placeLabel: string | null;
  address: string | null;
  brickName: string | null;
  areaName: string | null;
  point: { lat: number; lon: number };
  mapsLink: string;
  pin: ValidationReviewReading | null;
  photo: ValidationReviewReading | null;
  /** The signboard photo, signed on the page by the CRM's own photo link (the Super Admin reads all). */
  photoPath: string | null;
  /** Why the system held it, and every listing Google returned for the name. */
  reason: "no_confident_listing" | "lookup_failed" | "listing_far" | "refused_by_admin" | null;
  query: string | null;
  listings: Array<GoogleListing & { distanceMeters: number }>;
  decidedByName: string | null;
  decidedAtText: string | null;
  decisionNote: string | null;
  /**
   * Whether this rejection can still be taken back (owner, 2026-10-03: "add the option to approve
   * after reject"): the place is still retired, and nothing newer has been said about it.
   */
  restorable: boolean;
};

function reading(lat: unknown, lon: unknown, accuracy: unknown): ValidationReviewReading | null {
  const latitude = numberOrNull(lat);
  const longitude = numberOrNull(lon);
  return latitude === null || longitude === null ? null : { lat: latitude, lon: longitude, accuracyMeters: numberOrNull(accuracy) };
}

function listingsOf(google: Row, point: GeoPoint): Array<GoogleListing & { distanceMeters: number }> {
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

/** Every waiting review, and the ones decided in the last two weeks — newest first. */
export async function loadValidationReviews(viewer: PhoenixCrmViewer): Promise<ValidationReviewRow[]> {
  if (!canDecideValidationReviews(viewer)) throw forbiddenError("Only the Super Admin decides these.");
  const since = new Date(Date.now() - DECIDED_SHOWN_DAYS * 86_400_000).toISOString();
  const { data, error } = await getSupabaseAdmin()
    .from("phoenix_crm_validation_reviews")
    .select("id, seat_id, customer_id, place_id, is_test, kind, status, google, created_by_hr_id, created_at, decided_by_hr_id, decided_at, decision_note")
    .or(`status.eq.pending,decided_at.gte.${since}`)
    .order("created_at", { ascending: false })
    .limit(500);
  throwIfError(error);
  const reviews = (data ?? []) as Row[];
  if (reviews.length === 0) return [];

  const customerIds = [...new Set(reviews.map((row) => String(row.customer_id)))];
  const placeIds = [...new Set(reviews.map((row) => String(row.place_id)))];
  const [customers, places] = await Promise.all([
    getSupabaseAdmin().from("phoenix_crm_customers").select("id, name, list_type, speciality").in("id", customerIds),
    getSupabaseAdmin()
      .from("phoenix_crm_places")
      .select("id, label, address, brick_name, area_name, lat, lon, pin_lat, pin_lon, pin_accuracy_meters, photo_lat, photo_lon, photo_accuracy_meters, photo_path, status")
      .in("id", placeIds),
  ]);
  throwIfError(customers.error);
  throwIfError(places.error);
  const customerById = new Map(((customers.data ?? []) as Row[]).map((row) => [String(row.id), row]));
  const placeById = new Map(((places.data ?? []) as Row[]).map((row) => [String(row.id), row]));
  const names = await loadPeopleNames(reviews.flatMap((row) => [text(row.created_by_hr_id), text(row.decided_by_hr_id)]));

  return reviews.map((row) => {
    const customer = customerById.get(String(row.customer_id)) ?? {};
    const place = placeById.get(String(row.place_id)) ?? {};
    const google = (row.google && typeof row.google === "object" ? row.google : {}) as Row;
    const point = { lat: numberOrNull(place.lat) ?? 0, lon: numberOrNull(place.lon) ?? 0 };
    const seat = viewer.org.seats.get(String(row.seat_id));
    const photoPath = text(place.photo_path);
    const status = row.status === "approved" || row.status === "rejected" ? row.status : "pending";
    const reason =
      google.reason === "no_confident_listing" || google.reason === "lookup_failed" || google.reason === "listing_far" || google.reason === "refused_by_admin"
        ? google.reason
        : null;
    return {
      reviewId: String(row.id),
      status,
      kind: row.kind === "added_place" ? "added_place" : "validation",
      isTest: row.is_test === true,
      createdAt: String(row.created_at),
      createdAtText: formatPhoenixDateTime(String(row.created_at)),
      repName: nameOf(names, text(row.created_by_hr_id), "A rep"),
      territory: seat ? territoryName(seat) : "Territory no longer in the organogram",
      customerName: String(customer.name ?? "Unknown customer"),
      listType: String(customer.list_type ?? ""),
      speciality: text(customer.speciality),
      placeLabel: text(place.label),
      address: text(place.address),
      brickName: text(place.brick_name),
      areaName: text(place.area_name),
      point,
      mapsLink: `https://www.google.com/maps/search/?api=1&query=${point.lat},${point.lon}`,
      pin: reading(place.pin_lat, place.pin_lon, place.pin_accuracy_meters),
      photo: reading(place.photo_lat, place.photo_lon, place.photo_accuracy_meters),
      photoPath,
      reason,
      query: text(google.query),
      listings: listingsOf(google, point),
      decidedByName: text(row.decided_by_hr_id) ? nameOf(names, text(row.decided_by_hr_id), "") || null : null,
      decidedAtText: text(row.decided_at) ? formatPhoenixDateTime(String(row.decided_at)) : null,
      decisionNote: text(row.decision_note),
      // One review row per place (the UNIQUE index), so this row IS the place's whole story: a
      // rejection can be taken back while the place it retired is still retired.
      restorable: status === "rejected" && place.status === "retired",
    };
  });
}

// ── The decision ────────────────────────────────────────────────────────────────────────────────

/**
 * Approve or reject one held place. Approve validates a held customer in the rep's own name; reject
 * retires the place and, when it was his only one, sends him back to To validate. The rep is not
 * notified by a person: his list simply moves on, in the system's words.
 */
export async function decideValidationReview(viewer: PhoenixCrmViewer, raw: unknown): Promise<{ reviewId: string; status: "approved" | "rejected" }> {
  if (!canDecideValidationReviews(viewer)) throw forbiddenError("Only the Super Admin decides these.");
  const body = (raw && typeof raw === "object" ? raw : {}) as Row;
  if (!isUuid(body.reviewId)) throw validationError("Choose the place to decide.");
  const decision = body.decision === "approve" ? "approve" : body.decision === "reject" ? "reject" : null;
  if (!decision) throw validationError("Choose approve or reject.");
  const reviewId = String(body.reviewId).toLowerCase();
  // `review_not_found` and `review_decided` come back worded by the module's refusal table (db.ts).
  const result = await callPhoenixCrm<Row>("phoenix_crm_decide_validation_review", {
    p: { review_id: reviewId, actor_hr_id: viewer.hrId, decision, note: cleanText(body.note, 500) },
  });
  // A retired place changes what every visit to the customer is measured against.
  if (decision === "reject") {
    await restampVisitLocationsQuietly({
      seatId: String(result.seat_id),
      isTest: result.is_test === true,
      customerId: String(result.customer_id),
      actorHrId: viewer.hrId,
      settings: viewer.config.settings,
      scope: "all",
    });
  }
  // The "waiting for you" notice is answered.
  await withdrawInAppNotificationsByEventKeyPrefix(reviewNoticeKey(reviewId)).catch(() => undefined);
  return { reviewId, status: decision === "approve" ? "approved" : "rejected" };
}

/**
 * Take a rejection back (owner, 2026-10-03: "add the option to approve after reject"). The place comes
 * back, and the customer is validated again in the REP's own name where the rejection had sent him to
 * To validate — he did validate it, and a reversal does not take that away from him.
 *
 * The place's one review row turns from `rejected` to `approved` (it is UNIQUE per place), carrying who
 * rejected it and why in its `google` payload, beside the four events the list keeps. The rep's list
 * simply stops saying "Validate again", with no word about a person (golden rule #1).
 *
 * A reason is required, exactly as the refusal it undoes: a decision reversed in silence is the one a
 * reader cannot understand months later.
 */
export async function restoreValidation(viewer: PhoenixCrmViewer, raw: unknown): Promise<{ reviewId: string; validated: boolean }> {
  if (!canDecideValidationReviews(viewer)) throw forbiddenError("Only the Super Admin decides these.");
  const body = (raw && typeof raw === "object" ? raw : {}) as Row;
  if (!isUuid(body.reviewId)) throw validationError("Choose the rejection to take back.");
  const note = cleanText(body.note, 500);
  if (!note) throw validationError("Write why this place is accepted after all — it stays on the record.");

  // `review_not_found`, `review_not_rejected` and `place_not_retired` come back worded by the
  // module's refusal table (db.ts).
  const result = await callPhoenixCrm<Row>("phoenix_crm_restore_validation", {
    p: { review_id: String(body.reviewId).toLowerCase(), actor_hr_id: viewer.hrId, note },
  });
  // The place is measurable again, so every visit to the customer gets its distance back.
  await restampVisitLocationsQuietly({
    seatId: String(result.seat_id),
    isTest: result.is_test === true,
    customerId: String(result.customer_id),
    actorHrId: viewer.hrId,
    settings: viewer.config.settings,
    scope: "all",
  });
  return { reviewId: String(result.review_id), validated: result.validated === true };
}

// ── Refusing a validation the system never held ─────────────────────────────────────────────────

/**
 * Only AM customers are checked against Google (`googleCheckApplies`), so a DOCTOR's validation — and
 * any AM one that matched its listing — is never held and never reaches the queue above. There was no
 * way to undo one: on 2026-10-03 a rep's validation had to be refused by hand in SQL.
 *
 * This is that, as a button. It writes the SAME review row the automatic check would have written —
 * `refused_by_admin`, in the rep's name, decided by the Super Admin — and then runs the SAME
 * `phoenix_crm_decide_validation_review` reject. So there is one reject path, one audit shape, and the
 * rep's own list reads `not_confirmed` in the system's automated wording either way (golden rule #1:
 * "do not show the rep that a person is accepting or rejecting").
 */

/** How far back the page offers validations to refuse. */
const VALIDATED_SHOWN_DAYS = 30;

export type ValidatedPlaceRow = {
  placeId: string;
  customerId: string;
  customerName: string;
  listType: string;
  speciality: string | null;
  isTest: boolean;
  repName: string;
  territory: string;
  validatedAt: string;
  validatedAtText: string;
  placeLabel: string | null;
  address: string | null;
  brickName: string | null;
  areaName: string | null;
  point: { lat: number; lon: number };
  mapsLink: string;
  pin: ValidationReviewReading | null;
  photo: ValidationReviewReading | null;
  photoPath: string | null;
  /** Visits already measured against this place — refusing it un-places every one of them. */
  visits: number;
  /** Other active places this customer has: when there are none, refusing sends him back to To validate. */
  otherPlaces: number;
};

/**
 * Every place validated in the last VALIDATED_SHOWN_DAYS that is still active and is not already
 * waiting in the queue above — newest first, so "he just validated this, take it back" is the top row.
 */
export async function loadValidatedPlaces(viewer: PhoenixCrmViewer): Promise<ValidatedPlaceRow[]> {
  if (!canDecideValidationReviews(viewer)) throw forbiddenError("Only the Super Admin decides these.");
  const since = new Date(Date.now() - VALIDATED_SHOWN_DAYS * 86_400_000).toISOString();
  const { data, error } = await getSupabaseAdmin()
    .from("phoenix_crm_places")
    .select(
      "id, seat_id, customer_id, is_test, label, address, brick_name, area_name, lat, lon, pin_lat, pin_lon, pin_accuracy_meters, photo_lat, photo_lon, photo_accuracy_meters, photo_path, created_by_hr_id, created_at",
    )
    .eq("status", "active")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(400);
  throwIfError(error);
  const places = (data ?? []) as Row[];
  if (places.length === 0) return [];

  const customerIds = [...new Set(places.map((row) => String(row.customer_id)))];
  const [customers, pending, visits, activePlaces] = await Promise.all([
    getSupabaseAdmin().from("phoenix_crm_customers").select("id, name, list_type, speciality").in("id", customerIds),
    getSupabaseAdmin().from("phoenix_crm_validation_reviews").select("place_id").eq("status", "pending").in("customer_id", customerIds),
    getSupabaseAdmin().from("phoenix_crm_visits").select("place_id").in("place_id", places.map((row) => String(row.id))),
    getSupabaseAdmin().from("phoenix_crm_places").select("id, customer_id").eq("status", "active").in("customer_id", customerIds),
  ]);
  throwIfError(customers.error);
  throwIfError(pending.error);
  throwIfError(visits.error);
  throwIfError(activePlaces.error);
  const customerById = new Map(((customers.data ?? []) as Row[]).map((row) => [String(row.id), row]));
  const held = new Set(((pending.data ?? []) as Row[]).map((row) => String(row.place_id)));
  const visitsByPlace = new Map<string, number>();
  for (const row of (visits.data ?? []) as Row[]) {
    const placeId = String(row.place_id ?? "");
    if (placeId) visitsByPlace.set(placeId, (visitsByPlace.get(placeId) ?? 0) + 1);
  }
  const placesByCustomer = new Map<string, number>();
  for (const row of (activePlaces.data ?? []) as Row[]) {
    const customerId = String(row.customer_id);
    placesByCustomer.set(customerId, (placesByCustomer.get(customerId) ?? 0) + 1);
  }
  const names = await loadPeopleNames(places.map((row) => text(row.created_by_hr_id)));

  return places
    .filter((row) => !held.has(String(row.id)))
    .map((row) => {
      const customer = customerById.get(String(row.customer_id)) ?? {};
      const point = { lat: numberOrNull(row.lat) ?? 0, lon: numberOrNull(row.lon) ?? 0 };
      const seat = viewer.org.seats.get(String(row.seat_id));
      return {
        placeId: String(row.id),
        customerId: String(row.customer_id),
        customerName: String(customer.name ?? "Unknown customer"),
        listType: String(customer.list_type ?? ""),
        speciality: text(customer.speciality),
        isTest: row.is_test === true,
        repName: nameOf(names, text(row.created_by_hr_id), "A rep"),
        territory: seat ? territoryName(seat) : "Territory no longer in the organogram",
        validatedAt: String(row.created_at),
        validatedAtText: formatPhoenixDateTime(String(row.created_at)),
        placeLabel: text(row.label),
        address: text(row.address),
        brickName: text(row.brick_name),
        areaName: text(row.area_name),
        point,
        mapsLink: `https://www.google.com/maps/search/?api=1&query=${point.lat},${point.lon}`,
        pin: reading(row.pin_lat, row.pin_lon, row.pin_accuracy_meters),
        photo: reading(row.photo_lat, row.photo_lon, row.photo_accuracy_meters),
        photoPath: text(row.photo_path),
        visits: visitsByPlace.get(String(row.id)) ?? 0,
        otherPlaces: Math.max((placesByCustomer.get(String(row.customer_id)) ?? 1) - 1, 0),
      };
    });
}

/**
 * Refuse one validation the system never questioned. A note is REQUIRED — the automatic holds carry
 * Google's own evidence, and a hand refusal carries nothing unless the person who pressed it says why,
 * which is what the record is read back for months later.
 */
export async function refuseValidatedPlace(viewer: PhoenixCrmViewer, raw: unknown): Promise<{ placeId: string; reopened: boolean }> {
  if (!canDecideValidationReviews(viewer)) throw forbiddenError("Only the Super Admin decides these.");
  const body = (raw && typeof raw === "object" ? raw : {}) as Row;
  if (!isUuid(body.placeId)) throw validationError("Choose the place to refuse.");
  const note = cleanText(body.note, 500);
  if (!note) throw validationError("Write why this validation is refused — it stays on the record.");
  const placeId = String(body.placeId).toLowerCase();

  const { data, error } = await getSupabaseAdmin()
    .from("phoenix_crm_places")
    .select("id, seat_id, customer_id, is_test, status, created_by_hr_id")
    .eq("id", placeId)
    .maybeSingle();
  throwIfError(error);
  const place = data as Row | null;
  if (!place) throw notFoundError("This place is no longer there. Reload the page.");
  if (place.status !== "active") throw validationError("This place is already retired. Reload the page.");

  // The review the automatic check would have written, had this customer been in its scope.
  //
  // 🔴 An UPSERT on place_id, never a plain insert: `phoenix_crm_validation_reviews_place_idx` is
  // UNIQUE on place_id, so a place that was already held once — an AM one the check held and then
  // approved — has a row, and inserting a second died on 23505. It is put back to `pending` (and
  // `decided_at` cleared with it, or the table's own CHECK refuses the row) so the shared reject
  // below is what decides it, exactly as it decides an automatic hold.
  const upserted = await getSupabaseAdmin()
    .from("phoenix_crm_validation_reviews")
    .upsert(
      {
        seat_id: String(place.seat_id),
        customer_id: String(place.customer_id),
        place_id: placeId,
        is_test: place.is_test === true,
        kind: "validation",
        status: "pending",
        google: { reason: "refused_by_admin", refused_by_hr_id: viewer.hrId },
        created_by_hr_id: String(place.created_by_hr_id),
        decided_by_hr_id: null,
        decided_at: null,
        decision_note: null,
      },
      { onConflict: "place_id" },
    )
    .select("id")
    .single();
  throwIfError(upserted.error);
  const reviewId = String((upserted.data as Row).id);

  const result = await callPhoenixCrm<Row>("phoenix_crm_decide_validation_review", {
    p: { review_id: reviewId, actor_hr_id: viewer.hrId, decision: "reject", note },
  });
  // A retired place changes what every visit to the customer is measured against.
  await restampVisitLocationsQuietly({
    seatId: String(result.seat_id),
    isTest: result.is_test === true,
    customerId: String(result.customer_id),
    actorHrId: viewer.hrId,
    settings: viewer.config.settings,
    scope: "all",
  });
  return { placeId, reopened: result.reopened === true };
}
