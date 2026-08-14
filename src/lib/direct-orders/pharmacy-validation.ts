import type { AccessContext } from "@/lib/auth/permissions";
import { assertPermission } from "@/lib/auth/permissions";
import { forbiddenError, notFoundError, validationError } from "@/lib/http/api-errors";
import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { acknowledgeDirectOrderPharmacy } from "@/lib/direct-orders/service";
import {
  checkDirectOrderStorefrontEvidence,
  type DirectOrderEvidenceCheck,
} from "@/lib/direct-orders/evidence-check";
import { assertDirectOrderWorkflowTransition } from "@/lib/direct-orders/workflow";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// ─────────────────────────────────────────────────────────────────────────────
// Pharmacy Validation (spec A2 — docs/specs/direct-orders-v2.md).
//
// The door for a pharmacy the distributor sheets do not know. A rep with a held order submits
// EVIDENCE — a live storefront photo carrying its own GPS stamp, plus the details and the reason
// it is not in the master database — and a Super Admin decides one of three outcomes:
//
//   match    → it existed all along under a different spelling; the order rewires to the real
//              customer code and nothing new is created. THE OUTCOME WE EXPECT MOST.
//   approve  → genuinely new; it gets an official code but enters PROVISIONAL, on probation.
//   reject   → the order stays held.
//
// Deliberately mirrors marketing Customer Validation, which staff already use weekly.
// ─────────────────────────────────────────────────────────────────────────────

/** Same idiom as service.ts: one place turns a message into the module's 400. */
function badRequest(message: string): never {
  throw validationError(message);
}

export const DIRECT_ORDER_EVIDENCE_BUCKET = "direct-order-evidence";

/** Same cap as the marketing/outstation live captures (quality-0.86 canvas JPEG). */
const MAX_EVIDENCE_BYTES = 2 * 1024 * 1024;
/** One review sitting, not a shareable link. */
const EVIDENCE_SIGNED_URL_TTL_SECONDS = 60 * 60;

/**
 * How far the pin may sit from the nearest brick centroid of the requester's area before it is
 * worth the admin's attention.
 *
 * This is a FLAG, never an automatic rejection, and the reason is data quality: brick centroids
 * are geocoded guesses (949 of 1,142 resolved), so a hard radius gate would reject real
 * pharmacies whose brick was geocoded loosely — producing exactly the "the new system blocked
 * everything" complaint the whole design exists to avoid. The admin sees the distance and the pin
 * and decides. The evidence is still doing its work: a rep who is nowhere near the claimed
 * territory now has to explain a number, on the record.
 */
const AREA_PROXIMITY_FLAG_KM = 25;

export type DirectOrderValidationStatus = "pending" | "approved_new" | "matched_existing" | "rejected";

export type DirectOrderValidationRow = {
  id: string;
  pharmacyId: string;
  pharmacyName: string;
  phoenixPharmacyCode: string;
  requestId: string | null;
  requestedByHrId: string;
  requestedByName: string;
  requestedAt: string;
  claimedPharmacyName: string;
  claimedAddress: string | null;
  claimedDoctorName: string | null;
  claimedReason: string | null;
  capturedLatitude: number | null;
  capturedLongitude: number | null;
  capturedAccuracyMeters: number | null;
  capturedAt: string | null;
  requesterAreaCode: string | null;
  gpsInsideRequesterArea: boolean | null;
  /** Distance to the nearest brick centroid of the requester's area, when both are known. */
  areaDistanceKm: number | null;
  status: DirectOrderValidationStatus;
  decidedByHrId: string | null;
  decidedAt: string | null;
  decisionNotes: string | null;
  /** Short-lived signed URL for the evidence photo; null when there is no photo on file. */
  photoUrl: string | null;
  /**
   * What the storefront photo was read to say (spec E2).
   *
   * NULL means NO ANSWER — not yet read, or it could not be read — and the desk must render it as
   * such. It is advisory only: nothing in the decide path consults it, and a test asserts that.
   */
  evidenceCheck: DirectOrderEvidenceCheck | null;
};

/**
 * Who may work the validation desk. Exported so a caller can ASK before calling
 * `listDirectOrderPharmacyValidations`, which throws.
 *
 * The Needs Action inbox has to know whether to count pending validations for this
 * viewer, and the only alternatives were re-writing this condition at the call site
 * (a second copy of a visibility rule — the exact mechanism behind audit F5) or
 * calling the throwing function and swallowing the 403, which would hide a real
 * permission error as an empty queue.
 */
export function canDecideDirectOrderPharmacyValidations(access: AccessContext): boolean {
  return access.scope === "system" || access.role === "Super Admin";
}

function assertValidationDeskAccess(access: AccessContext): void {
  if (!canDecideDirectOrderPharmacyValidations(access)) {
    throw forbiddenError("Forbidden: only a System Admin can decide pharmacy validations.");
  }
}

/** Great-circle distance in km. Plain haversine — no dependency for one formula. */
function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * JPEG-only, live-capture-only — the same rule as marketing and outstation evidence.
 *
 * A photo chosen from the gallery arrives as another MIME type and fails here, because the entire
 * claim this evidence makes is "taken at this place, at this time". Accepting a gallery upload
 * would reduce the evidence to a picture of a pharmacy, which proves nothing about who stood where.
 */
export function parseDirectOrderEvidencePhotoDataUrl(dataUrl: string): { bytes: Buffer } {
  const match = /^data:(image\/jpeg);base64,([a-zA-Z0-9+/=]+)$/i.exec(String(dataUrl ?? "").trim());
  if (!match) badRequest("The storefront photo must be a live capture taken inside the app.");
  const bytes = Buffer.from(match![2], "base64");
  if (bytes.length === 0) badRequest("The storefront photo is empty. Take it again.");
  if (bytes.length > MAX_EVIDENCE_BYTES) badRequest("The storefront photo is too large. Take it again.");
  return { bytes };
}

/**
 * Resolve how far the capture sits from the requester's own area, using the brick centroids that
 * area's customers map to. Returns null when either side is unknown — an unknown distance must
 * read as unknown on the desk, never as "inside".
 */
async function resolveAreaProximity(input: {
  areaCode: string | null;
  latitude: number | null;
  longitude: number | null;
}): Promise<{ distanceKm: number | null; inside: boolean | null }> {
  if (!input.areaCode || input.latitude == null || input.longitude == null) {
    return { distanceKm: null, inside: null };
  }
  const supabase = getSupabaseAdmin();
  const { data: bricks } = await supabase
    .from("source_of_sales_customer_map")
    .select("brick_id")
    .eq("active", true)
    .eq("area_code", input.areaCode)
    .not("brick_id", "is", null)
    .limit(500);
  const brickIds = Array.from(
    new Set(((bricks ?? []) as Array<{ brick_id: string | null }>).map((r) => r.brick_id).filter(Boolean) as string[]),
  );
  if (brickIds.length === 0) return { distanceKm: null, inside: null };

  const { data: centroids } = await supabase
    .from("geo_locations")
    .select("source_key, latitude, longitude")
    .eq("source_type", "brick_centroid")
    .eq("geocode_status", "success")
    .in("source_key", brickIds.slice(0, 200));
  const points = ((centroids ?? []) as Array<{ latitude: number | null; longitude: number | null }>)
    .filter((r) => r.latitude != null && r.longitude != null)
    .map((r) => ({ lat: Number(r.latitude), lon: Number(r.longitude) }));
  if (points.length === 0) return { distanceKm: null, inside: null };

  const here = { lat: Number(input.latitude), lon: Number(input.longitude) };
  const nearest = points.reduce((min, p) => Math.min(min, haversineKm(here, p)), Number.POSITIVE_INFINITY);
  const distanceKm = Math.round(nearest * 10) / 10;
  return { distanceKm, inside: distanceKm <= AREA_PROXIMITY_FLAG_KM };
}

/**
 * A rep submits validation evidence for the pharmacy behind their held order (spec A2).
 *
 * The order stays HELD throughout — submitting evidence is a request, not a release. Only the
 * Super Admin's decision moves anything.
 */
export async function requestDirectOrderPharmacyValidation(
  access: AccessContext,
  input: {
    pharmacyId: string;
    requestId?: string | null;
    claimedPharmacyName: string;
    claimedAddress?: string | null;
    claimedDoctorName?: string | null;
    claimedReason: string;
    photoDataUrl: string;
    capturedLatitude?: number | null;
    capturedLongitude?: number | null;
    capturedAccuracyMeters?: number | null;
    capturedAt?: string | null;
    capturedAddress?: string | null;
  },
): Promise<{ validationId: string }> {
  await assertPermission(access, "direct_orders", "create");

  const pharmacyId = String(input.pharmacyId ?? "").trim();
  const claimedName = String(input.claimedPharmacyName ?? "").trim();
  const reason = String(input.claimedReason ?? "").trim();
  if (!pharmacyId) badRequest("Pharmacy is required.");
  if (!claimedName) badRequest("Pharmacy name is required.");
  // The reason is mandatory on purpose: "why is this not in the master database" is the question
  // the admin has to answer, and making the rep answer it first is most of the review.
  if (!reason) badRequest("Say why this pharmacy is not in the master database.");

  // The evidence must come from the person whose order is stuck. `direct_orders:create` alone is
  // not enough: it admits every rep in the company, so without this any of them could file a
  // storefront photo for a pharmacy in someone else's territory. The UI only offers the capture to
  // the requester (canCaptureDirectOrderValidation), but a hidden button is UX, not access control
  // — the check has to exist on this side of the wire too.
  const linkedRequestId = input.requestId ? String(input.requestId).trim() : "";
  let linkedRequestStatus: string | null = null;
  if (linkedRequestId) {
    const supabaseForOwnership = getSupabaseAdmin();
    const { data: linked } = await supabaseForOwnership
      .from("direct_order_requests")
      // `status` rides along on the query that was already being made. Every round trip here
      // is a cross-region hop (Railway `europe-west4` -> Supabase `eu-central-1`), so the registry
      // gate below costs nothing rather than doubling the latency of filing evidence.
      .select("id, requester_hr_id, status")
      .eq("id", linkedRequestId)
      .maybeSingle();
    if (!linked) throw notFoundError("That direct order was not found.");
    const owner = canonicalHrIdKey(String((linked as { requester_hr_id?: string }).requester_hr_id ?? ""));
    if (!owner || owner !== canonicalHrIdKey(access.hrId ?? "")) {
      throw forbiddenError("You can only submit evidence for your own direct order.");
    }
    linkedRequestStatus = String((linked as { status?: string }).status ?? "") || null;

    // Said in words BEFORE the registry gate below, which would otherwise refuse this with the
    // registry's own generic sentence — the same kind of text that reached a user this morning as
    // "module is missing or inactive" and told them nothing they could act on.
    //
    // The client already hides the capture unless the order is held (canCaptureDirectOrderValidation),
    // but a hidden button is UX, not access control: until now the SERVER accepted evidence against
    // an order that had already been revived or had expired while the rep stood at the pharmacy.
    if (linkedRequestStatus !== "held") {
      badRequest(
        `This order is no longer waiting on a pharmacy — it is ${linkedRequestStatus ?? "in an unknown state"}. ` +
          "Reload it to see where it stands; evidence is only needed while an order is held.",
      );
    }
  }

  // The registry gate (audit F2). Until now this action was DECLARED in the registry and invoked by
  // nothing: the entire door out of the held lane sat outside the module's governance layer, which
  // therefore claimed a coverage it did not have.
  //
  // It refuses no one who could legitimately be here. `direct_orders:create` above admits Medical
  // Rep and Financial Advisor; the registry lists only the five requester roles plus Super Admin —
  // and since DIRECT_ORDER_REQUESTER_ROLES is exactly those five, and only the REQUESTER may
  // capture evidence, neither of those two can ever be the person filing. The coarse permission was
  // simply wider than the truth.
  //
  // The row's REAL status, never a literal (audit F6): a held order that was revived or expired
  // while the rep stood in front of the pharmacy must be refused here, not accepted against a
  // constant that says "held" because the code assumed so.
  await assertDirectOrderWorkflowTransition({
    access,
    actionKey: "request_pharmacy_validation",
    expectedNextStatus: "held",
    // No linked order means there is no status to read. The registry's `from: [held]` describes an
    // order, so this branch can only be checked on role — which is the half F2 was actually about.
    status: linkedRequestStatus ?? "held",
  });

  const { bytes } = parseDirectOrderEvidencePhotoDataUrl(input.photoDataUrl);

  const supabase = getSupabaseAdmin();
  const { data: pharmacy } = await supabase
    .from("direct_order_pharmacies")
    .select("id, area_code, verification_status")
    .eq("id", pharmacyId)
    .maybeSingle();
  if (!pharmacy) throw notFoundError("Pharmacy not found.");

  const areaCode = (pharmacy as { area_code?: string | null }).area_code ?? null;
  // Resolved SERVER-SIDE from the stored geography — never taken from the browser, which is the
  // one place a rep could otherwise assert their own compliance.
  const proximity = await resolveAreaProximity({
    areaCode,
    latitude: input.capturedLatitude ?? null,
    longitude: input.capturedLongitude ?? null,
  });

  // What Phoenix offered before this claim was accepted (spec B4). Resolved server-side at
  // submission rather than trusted from the browser: the record has to say what the system WOULD
  // have shown, not what a client claims it showed. `suggestions_refused` is therefore simply
  // "candidates existed and the rep submitted anyway" — the honest reading of the act.
  const suggestions = await suggestDirectOrderPharmacies(access, { name: claimedName, limit: 5 }).catch(() => []);

  const { data: inserted, error } = await supabase
    .from("direct_order_pharmacy_validations")
    .insert({
      pharmacy_id: pharmacyId,
      request_id: input.requestId ?? null,
      requested_by_hr_id: access.hrId,
      suggestions_shown: suggestions.length > 0 ? suggestions : null,
      suggestions_refused: suggestions.length > 0,
      claimed_pharmacy_name: claimedName,
      claimed_address: input.claimedAddress?.trim() || null,
      claimed_doctor_name: input.claimedDoctorName?.trim() || null,
      claimed_reason: reason,
      captured_latitude: input.capturedLatitude ?? null,
      captured_longitude: input.capturedLongitude ?? null,
      captured_accuracy_meters: input.capturedAccuracyMeters ?? null,
      captured_at: input.capturedAt ?? null,
      captured_address: input.capturedAddress?.trim() || null,
      requester_area_code: areaCode,
      gps_inside_requester_area: proximity.inside,
      storage_bucket: DIRECT_ORDER_EVIDENCE_BUCKET,
      status: "pending",
    })
    .select("id")
    .single();
  if (error) {
    // The partial unique index refuses a second OPEN validation for one pharmacy.
    if (String((error as { code?: string }).code ?? "") === "23505") {
      badRequest("This pharmacy already has a validation waiting for a decision.");
    }
    throw error;
  }
  const validationId = String((inserted as { id: string }).id);

  // Upload AFTER the row exists, so the path is keyed on an id that is already durable — the same
  // ordering marketing uses, and the reason its evidence rows can never point at a missing object.
  const path = `${pharmacyId}/${validationId}.jpg`;
  const { error: uploadError } = await supabase.storage
    .from(DIRECT_ORDER_EVIDENCE_BUCKET)
    .upload(path, bytes, { contentType: "image/jpeg", upsert: true });
  if (uploadError) {
    // Never leave a validation claiming evidence it does not have.
    await supabase.from("direct_order_pharmacy_validations").delete().eq("id", validationId);
    throw uploadError;
  }
  await supabase.from("direct_order_pharmacy_validations").update({ storage_path: path }).eq("id", validationId);

  // Read the storefront evidence once, here, so the answer is already on the Super Admin's desk
  // when they open it (spec E2). The bytes are already in hand from the parse above, so nothing is
  // re-downloaded.
  //
  // WRAPPED SO IT CANNOT FAIL THE FILING. The rep is standing in front of the pharmacy; a model
  // being busy, rate-limited, or returning nonsense must leave their evidence filed and this column
  // null. Same reasoning as pingDirectOrderSheet being void-and-unawaitable, and
  // extractCvFieldsFromBytes' is_cv gate failing open: an assist that can block the thing it
  // assists is not an assist.
  //
  // A null column means "no answer", never "passed" — the desk renders it as such.
  try {
    const evidenceCheck = await checkDirectOrderStorefrontEvidence({ bytes, claimedPharmacyName: claimedName });
    if (evidenceCheck) {
      await supabase
        .from("direct_order_pharmacy_validations")
        .update({ evidence_check: evidenceCheck })
        .eq("id", validationId);
    }
  } catch (error) {
    logError("Storefront evidence check failed; the validation was filed without it", {
      labels: { event: "direct_order_evidence_check_failed", validationId },
      error: error instanceof Error ? error : new Error(String(error)),
    });
  }

  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? access.hrId,
    entityType: "direct_order_request",
    entityId: `validation:${validationId}`,
    newValues: { pharmacyId, status: "pending", areaCode, distanceKm: proximity.distanceKm },
    summary: `Pharmacy validation requested by ${access.hrId ?? "unknown"} for ${claimedName}.`,
  });

  return { validationId };
}

export type PharmacySuggestion = {
  distributorCode: string;
  customerCode: string;
  customerName: string;
  address: string | null;
  areaCode: string | null;
  score: number;
};

/**
 * "Did you mean…" for a claimed pharmacy name (spec B4).
 *
 * Arabic-normalized trigram similarity, not a model — see the migration for why. Used in two
 * places, deliberately the same call: shown to the REP before they may claim a pharmacy is new,
 * and shown to the SUPER ADMIN on the validation desk. Both people are answering the same
 * question, so they should be looking at the same candidates.
 */
export async function suggestDirectOrderPharmacies(
  access: AccessContext,
  input: { name: string; limit?: number },
): Promise<PharmacySuggestion[]> {
  await assertPermission(access, "direct_orders", "read");
  const name = String(input.name ?? "").trim();
  if (name.length < 2) return [];
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("phx_suggest_direct_order_pharmacies", {
    p_name: name,
    p_min_score: 0.35,
    p_limit: Math.min(Math.max(input.limit ?? 5, 1), 20),
  });
  if (error) throw error;
  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    distributorCode: String(row.distributor_code ?? ""),
    customerCode: String(row.customer_code ?? ""),
    customerName: String(row.customer_name ?? ""),
    address: row.address ? String(row.address) : null,
    areaCode: row.area_code ? String(row.area_code) : null,
    score: Number(row.score ?? 0),
  }));
}

type ValidationPharmacyRow = { pharmacy_name: string; phoenix_pharmacy_code: string };

/**
 * One validation row, fully resolved (signed photo URL, area proximity, requester name).
 *
 * Shared by the Validation Desk (`listDirectOrderPharmacyValidations`, every pending claim) and
 * `getDirectOrderPharmacyValidationForRequest` (one request's own evidence, for the approval-detail
 * screen) — extracted so the two call sites can never drift the way two independent copies of the
 * same eleven-field mapping always eventually do.
 */
async function mapValidationRow(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  row: Record<string, unknown>,
  pharmacy: ValidationPharmacyRow | undefined,
  requesterName: string,
): Promise<DirectOrderValidationRow> {
  const storagePath = row.storage_path ? String(row.storage_path) : null;
  let photoUrl: string | null = null;
  if (storagePath) {
    const { data: signed } = await supabase.storage
      .from(String(row.storage_bucket ?? DIRECT_ORDER_EVIDENCE_BUCKET))
      .createSignedUrl(storagePath, EVIDENCE_SIGNED_URL_TTL_SECONDS);
    photoUrl = signed?.signedUrl ?? null;
  }
  const proximity = await resolveAreaProximity({
    areaCode: row.requester_area_code ? String(row.requester_area_code) : null,
    latitude: row.captured_latitude == null ? null : Number(row.captured_latitude),
    longitude: row.captured_longitude == null ? null : Number(row.captured_longitude),
  });
  const hr = String(row.requested_by_hr_id ?? "");
  return {
    id: String(row.id),
    pharmacyId: String(row.pharmacy_id),
    pharmacyName: pharmacy?.pharmacy_name ?? "(pharmacy missing)",
    phoenixPharmacyCode: pharmacy?.phoenix_pharmacy_code ?? "—",
    requestId: row.request_id ? String(row.request_id) : null,
    requestedByHrId: hr,
    requestedByName: requesterName || hr,
    requestedAt: String(row.requested_at),
    claimedPharmacyName: String(row.claimed_pharmacy_name ?? ""),
    claimedAddress: row.claimed_address ? String(row.claimed_address) : null,
    claimedDoctorName: row.claimed_doctor_name ? String(row.claimed_doctor_name) : null,
    claimedReason: row.claimed_reason ? String(row.claimed_reason) : null,
    capturedLatitude: row.captured_latitude == null ? null : Number(row.captured_latitude),
    capturedLongitude: row.captured_longitude == null ? null : Number(row.captured_longitude),
    capturedAccuracyMeters: row.captured_accuracy_meters == null ? null : Number(row.captured_accuracy_meters),
    capturedAt: row.captured_at ? String(row.captured_at) : null,
    requesterAreaCode: row.requester_area_code ? String(row.requester_area_code) : null,
    gpsInsideRequesterArea: row.gps_inside_requester_area == null ? null : Boolean(row.gps_inside_requester_area),
    areaDistanceKm: proximity.distanceKm,
    status: String(row.status ?? "pending") as DirectOrderValidationStatus,
    decidedByHrId: row.decided_by_hr_id ? String(row.decided_by_hr_id) : null,
    decidedAt: row.decided_at ? String(row.decided_at) : null,
    decisionNotes: row.decision_notes ? String(row.decision_notes) : null,
    photoUrl,
    // Read straight through: the column is null whenever there is no answer, and null must stay
    // null all the way to the screen rather than becoming a default that reads like a pass.
    evidenceCheck: (row.evidence_check as DirectOrderEvidenceCheck | null) ?? null,
  };
}

/**
 * How many pharmacy claims are waiting on this viewer — a COUNT, not the claims.
 *
 * WHY THIS EXISTS. The consolidated workspace's Needs Action inbox counts three queues:
 * approvals, the Finance sales-month queue, and pending pharmacy validations. The sidebar badge
 * counted only the first two, so a System Admin saw a badge reading 9 and opened a screen reading
 * 12. Measured live on 2026-08-11 — the badge was not wrong about approvals, it was silent about a
 * whole queue, which is worse: the three pharmacies nobody had confirmed were the items with no
 * other chaser at all.
 *
 * A count, never `listDirectOrderPharmacyValidations().length` — that loads every claim plus its
 * pharmacies, its requesters and its evidence rows, and this runs on a 30-second poll. `head: true`
 * sends no rows at all.
 *
 * Returns 0 for anyone who cannot work the desk, matching the rule the other two halves already
 * follow: a badge you cannot clear is how people learn to ignore badges.
 */
export async function countDirectOrderPendingValidations(access: AccessContext): Promise<number> {
  if (!canDecideDirectOrderPharmacyValidations(access)) return 0;
  const supabase = getSupabaseAdmin();
  const { count, error } = await supabase
    .from("direct_order_pharmacy_validations")
    .select("id", { count: "exact", head: true })
    .eq("status", "pending");
  if (error) throw error;
  return count ?? 0;
}

/** The Super Admin's validation desk: every pending claim, with its evidence. */
export async function listDirectOrderPharmacyValidations(
  access: AccessContext,
  options?: { status?: DirectOrderValidationStatus },
): Promise<DirectOrderValidationRow[]> {
  assertValidationDeskAccess(access);
  const supabase = getSupabaseAdmin();
  let query = supabase
    .from("direct_order_pharmacy_validations")
    .select("*")
    .order("requested_at", { ascending: true });
  if (options?.status) query = query.eq("status", options.status);
  const { data, error } = await query;
  if (error) throw error;

  const rows = (data ?? []) as Array<Record<string, unknown>>;
  if (rows.length === 0) return [];

  const pharmacyIds = Array.from(new Set(rows.map((r) => String(r.pharmacy_id))));
  const { data: pharmacies } = await supabase
    .from("direct_order_pharmacies")
    .select("id, pharmacy_name, phoenix_pharmacy_code")
    .in("id", pharmacyIds);
  const pharmacyById = new Map(
    ((pharmacies ?? []) as Array<{ id: string; pharmacy_name: string; phoenix_pharmacy_code: string }>).map((p) => [p.id, p]),
  );

  const hrIds = Array.from(new Set(rows.map((r) => String(r.requested_by_hr_id ?? "")).filter(Boolean)));
  const { data: employees } = await supabase.from("employees").select("hr_id, full_name").in("hr_id", hrIds);
  const nameByHr = new Map(
    ((employees ?? []) as Array<{ hr_id: string; full_name: string | null }>).map((e) => [
      e.hr_id.toUpperCase(),
      e.full_name ?? e.hr_id,
    ]),
  );

  const out: DirectOrderValidationRow[] = [];
  for (const row of rows) {
    const pharmacy = pharmacyById.get(String(row.pharmacy_id));
    const hr = String(row.requested_by_hr_id ?? "");
    out.push(await mapValidationRow(supabase, row, pharmacy, nameByHr.get(hr.toUpperCase()) ?? hr));
  }
  return out;
}

/**
 * One request's own pharmacy-evidence row, for the approval-detail screen (admin + portal) rather
 * than the Validation Desk. Owner rule, 2026-08-08: evidence becomes visible to everyone who can
 * already open the order (`canViewDirectOrderRequest`), not just Super Admin — so this is
 * deliberately UNGATED, unlike `listDirectOrderPharmacyValidations`. The caller has already proven
 * the viewer may see this specific request; that check is strictly narrower than the desk's "every
 * pending claim company-wide", so reusing `assertValidationDeskAccess` here would wrongly refuse a
 * viewer this function exists to serve.
 *
 * Returns null for the common case: most orders never touch the held/validation lane at all.
 */
export async function getDirectOrderPharmacyValidationForRequest(
  requestId: string,
  pharmacyId: string,
): Promise<DirectOrderValidationRow | null> {
  const supabase = getSupabaseAdmin();
  let row: Record<string, unknown> | null = null;
  if (requestId) {
    const { data } = await supabase
      .from("direct_order_pharmacy_validations")
      .select("*")
      .eq("request_id", requestId)
      .order("requested_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    row = (data as Record<string, unknown> | null) ?? null;
  }
  // Fallback for rows filed before request linkage existed: the most recent claim on this pharmacy.
  if (!row && pharmacyId) {
    const { data } = await supabase
      .from("direct_order_pharmacy_validations")
      .select("*")
      .eq("pharmacy_id", pharmacyId)
      .order("requested_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    row = (data as Record<string, unknown> | null) ?? null;
  }
  if (!row) return null;

  const { data: pharmacyRow } = await supabase
    .from("direct_order_pharmacies")
    .select("pharmacy_name, phoenix_pharmacy_code")
    .eq("id", pharmacyId)
    .maybeSingle();

  const hr = String(row.requested_by_hr_id ?? "");
  let requesterName = hr;
  if (hr) {
    // Case-insensitive on purpose: requester_hr_id has shipped lower-cased on other direct-order
    // tables before, and an exact-cased join against employees.hr_id silently returns nothing.
    const { data: employeeRow } = await supabase
      .from("employees")
      .select("full_name")
      .ilike("hr_id", hr)
      .maybeSingle();
    requesterName = (employeeRow as { full_name?: string | null } | null)?.full_name ?? hr;
  }

  return mapValidationRow(supabase, row, (pharmacyRow as ValidationPharmacyRow | null) ?? undefined, requesterName);
}

/**
 * The Super Admin decides (spec A2).
 *
 * `match` is the outcome to reach for: the pharmacy existed all along under another spelling, so
 * the claim resolves to a real distributor customer and nothing new is minted. `approve` admits a
 * genuinely new identity but only as PROVISIONAL — probation (spec A3) is what turns an admin's
 * judgement into something the data has to confirm, so a wrong approval self-corrects.
 */
export async function decideDirectOrderPharmacyValidation(
  access: AccessContext,
  input: {
    validationId: string;
    decision: "approve" | "match" | "reject";
    notes?: string | null;
    /** Required for `match`: the real directory customer this pharmacy actually is. */
    matchDistributorCode?: string | null;
    matchCustomerCode?: string | null;
  },
): Promise<void> {
  assertValidationDeskAccess(access);
  const supabase = getSupabaseAdmin();

  const { data: row } = await supabase
    .from("direct_order_pharmacy_validations")
    .select("*")
    .eq("id", input.validationId)
    .maybeSingle();
  if (!row) throw notFoundError("Validation not found.");
  if (String((row as { status?: string }).status ?? "") !== "pending") {
    badRequest("This validation has already been decided.");
  }

  // The registry gate (audit F2). `assertValidationDeskAccess` above already restricts this to a
  // System Admin and the registry lists exactly "Super Admin", so this adds no new refusal today.
  // It is here because the registry is the module's declared governance layer, and a door out of
  // the held lane that no registry action guards is coverage the registry claims but cannot honour.
  // If the desk rule is ever loosened, this stops the two drifting apart silently.
  //
  // Deliberately gated on ROLE and not on the linked order's status, unlike the request side.
  // Passing the order's real status here was written first and then removed, because it introduces
  // a bug: approving one validation revives every held order of that pharmacy, so a SECOND pending
  // validation for the same pharmacy would find its linked order already `pending_approval` and be
  // refused — blocking a decision the admin still legitimately has to make (if only to reject it).
  //
  // The real precondition for deciding is the VALIDATION being `pending`, which is checked above.
  // The registry's `from: [held]` describes where the orders sit in the normal case, not a
  // condition this action may enforce. Said plainly rather than dressed up as an F6-style check.
  await assertDirectOrderWorkflowTransition({
    access,
    actionKey: "decide_pharmacy_validation",
    expectedNextStatus: "held",
    status: "held",
  });

  const pharmacyId = String((row as { pharmacy_id: string }).pharmacy_id);
  const notes = input.notes?.trim() || null;
  const now = new Date().toISOString();

  if (input.decision === "reject") {
    // The order stays held. Rejecting is not a dead end for the rep — they can still resubmit
    // the order against a pharmacy that has a real code, which is the outcome we want.
    await supabase
      .from("direct_order_pharmacy_validations")
      .update({ status: "rejected", decided_by_hr_id: access.hrId, decided_at: now, decision_notes: notes, updated_at: now })
      .eq("id", input.validationId);
    await writeRequiredAuditLog({
      actorLoginId: access.loginId ?? access.hrId,
      entityType: "direct_order_request",
      entityId: `validation:${input.validationId}`,
      oldValues: { status: "pending" },
      newValues: { status: "rejected" },
      summary: `Pharmacy validation rejected by ${access.hrId ?? "unknown"}${notes ? `: ${notes}` : "."}`,
    });
    return;
  }

  if (input.decision === "match") {
    const distributorCode = String(input.matchDistributorCode ?? "").trim();
    const customerCode = String(input.matchCustomerCode ?? "").trim();
    if (!distributorCode || !customerCode) badRequest("Pick the real customer this pharmacy matches.");

    // The pair must exist in the master database — matching to something that is not there would
    // simply relocate the phantom.
    const { data: mapRow } = await supabase
      .from("source_of_sales_customer_map")
      .select("brick_id, area_code, region_code")
      .eq("active", true)
      .eq("distributor_code", distributorCode)
      .eq("customer_code", customerCode)
      .maybeSingle();
    if (!mapRow) badRequest("That customer is not in the master database.");

    const geo = mapRow as Record<string, unknown>;
    const { error: linkError } = await supabase.from("direct_order_pharmacy_distributor_codes").insert({
      pharmacy_id: pharmacyId,
      distributor_code: distributorCode,
      customer_code: customerCode,
      mapped_brick_id: geo.brick_id ? String(geo.brick_id) : null,
      mapped_area_code: geo.area_code ? String(geo.area_code) : null,
      mapped_region_code: geo.region_code ? String(geo.region_code) : null,
    });
    // 23505 = that code already belongs to a pharmacy (the Stage 1 uniqueness guard). Say so
    // plainly rather than surfacing a constraint name.
    if (linkError && String((linkError as { code?: string }).code ?? "") === "23505") {
      badRequest("That customer code is already linked to another pharmacy in Phoenix.");
    }
    if (linkError) throw linkError;

    // Matched to a real distributor customer, so the pharmacy is TRUSTED outright — the master
    // database vouches for it. No probation: there is nothing left to prove.
    await supabase
      .from("direct_order_pharmacies")
      .update({
        brick_id: geo.brick_id ? String(geo.brick_id) : null,
        area_code: geo.area_code ? String(geo.area_code) : null,
        region_code: geo.region_code ? String(geo.region_code) : null,
        trust_state: "trusted",
        trusted_at: now,
        trusted_reason: `Matched to ${distributorCode}/${customerCode} during validation`,
      })
      .eq("id", pharmacyId);

    await supabase
      .from("direct_order_pharmacy_validations")
      .update({
        status: "matched_existing",
        decided_by_hr_id: access.hrId,
        decided_at: now,
        decision_notes: notes,
        matched_distributor_code: distributorCode,
        matched_customer_code: customerCode,
        updated_at: now,
      })
      .eq("id", input.validationId);
  } else {
    // approve → genuinely new, admitted on PROBATION.
    await supabase
      .from("direct_order_pharmacies")
      .update({ trust_state: "provisional", probation_started_at: now })
      .eq("id", pharmacyId);
    await supabase
      .from("direct_order_pharmacy_validations")
      .update({ status: "approved_new", decided_by_hr_id: access.hrId, decided_at: now, decision_notes: notes, updated_at: now })
      .eq("id", input.validationId);
  }

  // Both approve and match confirm the identity, which is what releases the held orders. Reusing
  // acknowledgeDirectOrderPharmacy keeps ONE code path for "the pharmacy is confirmed": it marks
  // it verified, audits it, and revives every order parked on it.
  await acknowledgeDirectOrderPharmacy(access, { pharmacyId });

  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? access.hrId,
    entityType: "direct_order_request",
    entityId: `validation:${input.validationId}`,
    oldValues: { status: "pending" },
    newValues: { status: input.decision === "match" ? "matched_existing" : "approved_new", pharmacyId },
    summary: `Pharmacy validation ${input.decision === "match" ? "matched to an existing customer" : "approved as new (provisional)"} by ${access.hrId ?? "unknown"}.`,
  });
}
