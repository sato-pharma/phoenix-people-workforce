import type { AccessContext } from "@/lib/auth/permissions";
import { assertPermission } from "@/lib/auth/permissions";
import { forbiddenError, notFoundError, validationError } from "@/lib/http/api-errors";
import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { acknowledgeDirectOrderPharmacy } from "@/lib/direct-orders/service";
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
};

function assertValidationDeskAccess(access: AccessContext): void {
  if (!(access.scope === "system" || access.role === "Super Admin")) {
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

  const { bytes } = parseDirectOrderEvidencePhotoDataUrl(input.photoDataUrl);

  const supabase = getSupabaseAdmin();
  const { data: pharmacy } = await supabase
    .from("direct_order_pharmacies")
    .select("id, area_code, verification_status")
    .eq("id", pharmacyId)
    .maybeSingle();
  if (!pharmacy) notFoundError("Pharmacy not found.");

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
    const pharmacy = pharmacyById.get(String(row.pharmacy_id));
    const hr = String(row.requested_by_hr_id ?? "");
    out.push({
      id: String(row.id),
      pharmacyId: String(row.pharmacy_id),
      pharmacyName: pharmacy?.pharmacy_name ?? "(pharmacy missing)",
      phoenixPharmacyCode: pharmacy?.phoenix_pharmacy_code ?? "—",
      requestId: row.request_id ? String(row.request_id) : null,
      requestedByHrId: hr,
      requestedByName: nameByHr.get(hr.toUpperCase()) ?? hr,
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
    });
  }
  return out;
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
  if (!row) notFoundError("Validation not found.");
  if (String((row as { status?: string }).status ?? "") !== "pending") {
    badRequest("This validation has already been decided.");
  }
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
