import type { AccessContext } from "@/lib/auth/permissions";
import { assertPermission } from "@/lib/auth/permissions";
import { forbiddenError, notFoundError, validationError } from "@/lib/http/api-errors";
import { writeRequiredAuditLog } from "@/lib/admin/audit";
import {
  acknowledgeDirectOrderPharmacy,
  confirmDirectOrderPharmacyFromInvoiceValidation,
} from "@/lib/direct-orders/service";
import {
  DIRECT_ORDER_INVOICE_BUCKET,
  DIRECT_ORDER_INVOICE_SLOT_LIMIT,
  directOrderInvoiceSlotsFullMessage,
  normalizeDirectOrderValidationRoute,
  parseDirectOrderInvoiceDataUrl,
  type DirectOrderInvoiceContentType,
  type DirectOrderInvoiceSlotCount,
  type DirectOrderValidationRoute,
  type ParsedDirectOrderInvoiceFile,
} from "@/lib/direct-orders/invoice-evidence";
import {
  checkDirectOrderStorefrontEvidence,
  type DirectOrderEvidenceCheck,
} from "@/lib/direct-orders/evidence-check";
import { bumpCustomer360Cache } from "@/lib/cache/namespaces";
import { assertDirectOrderWorkflowTransition } from "@/lib/direct-orders/workflow";
import {
  directOrderFieldEvidenceGap,
  directOrderRejectionWasOnlyRedundant,
  type DirectOrderFieldEvidenceGap,
} from "@/lib/direct-orders/field-evidence-gap";
import { readAccuracyInput, readCoordinateInput } from "@/lib/geo/coordinate-input";
import { canonicalHrIdKey, hrIdForStorage, hrIdLookupKeys } from "@/lib/hr-id";
import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import {
  parsePharmacyLicenseDataUrl,
  PHARMACY_LICENSE_BUCKET,
  type PharmacyLicenseContentType,
} from "@/lib/venues/pharmacy-license";
import { normalizeVenueType, venueRequiresDistributorCode, venueTypeLabel, type VenueType } from "@/lib/venues/venue-type";
import {
  VENUE_LOCATION_REQUIRED_MESSAGE,
  venueAdminRouteEvidenceGapMessage,
  venueIdentityGapMessage,
} from "@/lib/venues/venue-validation-rule";
import {
  WHOLESALER_VENUE_REFUSED_MESSAGE,
  isCertainWholesalerVenue,
  suspectedWholesalerFlag,
  suspectedWholesalerNote,
} from "@/lib/venues/wholesaler-venue-guard";

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
  /**
   * `pharmacy` or `nursery` — what the desk is actually deciding about.
   *
   * Everything on this screen was worded for a pharmacy: it offers a match against the distributor
   * master database, it names the pharmacy licence, and it explains an absent licence in terms of
   * distributor codes. None of that is true of a nursery, and until 2026-08-29 the desk had no way
   * to know it was looking at one — so an admin was shown three pharmacy sentences and one button
   * that would refuse him.
   */
  venueType: VenueType;
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
   * The pharmacy trade licence (رخصة الصيدلية), when one was attached — see
   * `src/lib/venues/pharmacy-license.ts` for why a codeless venue needs one.
   *
   * Signed on the same TTL as the storefront photo. `licenseContentType` travels with it because
   * the desk has to know whether to render an image or offer a PDF to open; guessing from the URL
   * is not possible once it is signed.
   */
  licenseUrl: string | null;
  licenseContentType: PharmacyLicenseContentType | null;
  licenseUploadedAt: string | null;
  /**
   * The approver's verdict that the licence trade name matches the shop sign.
   *
   * NULL means NOBODY WAS ASKED — no licence on file, or a claim decided before this existed — and
   * the desk must render it as such. Same rule as `evidenceCheck`: silence here would read as
   * "checked and fine", which is the one thing it must never mean.
   */
  licenseNameMatchesSign: boolean | null;
  /** Does this pharmacy have a distributor code in any distributor? Drives the licence prompt. */
  hasDistributorCode: boolean;
  /**
   * What the storefront photo was read to say (spec E2).
   *
   * NULL means NO ANSWER — not yet read, or it could not be read — and the desk must render it as
   * such. It is advisory only: nothing in the decide path consults it, and a test asserts that.
   */
  evidenceCheck: DirectOrderEvidenceCheck | null;
  /**
   * Name-based wholesaler suspicion (owner rule, 2026-09-22). A certain wholesaler never reaches the
   * desk at all (the pickers drop it and the write paths refuse it); this is the AMBIGUOUS tier — a
   * bare «X فارما»-style name that MIGHT be a warehouse. It is advisory only, exactly like
   * `evidenceCheck`: the desk shows a warning, the human decides, nothing in the decide path reads it.
   */
  suspectedWholesaler: boolean;
  suspectedWholesalerNote: string | null;
  /**
   * Why this VENUE holds no live photo and no GPS fix, or null when one exists (owner, 2026-09-29:
   * "put the not-field-validated line on the validation desk too").
   *
   * About the venue, never about the claim in front of the decider — a claim carrying a photo and a
   * pin is itself a standing capture and silences this, `pending` included. Optional, because only
   * the desk's list loader fills it; the per-request loader leaves it undefined.
   */
  fieldEvidenceGap?: DirectOrderFieldEvidenceGap | null;
  /**
   * `field` = a live photo and a pin; `invoice` = a distributor invoice alone (owner, 2026-09-14).
   * Every row filed before the invoice route existed is `field`.
   */
  validationRoute: DirectOrderValidationRoute;
  /** Short-lived signed URL for the distributor invoice; only on an invoice claim. */
  invoiceUrl: string | null;
  invoiceContentType: DirectOrderInvoiceContentType | null;
  invoiceUploadedAt: string | null;
  /**
   * How many of the requester's invoice slots are in use right now, for an invoice claim — the
   * "2 of 5 pharmacies validated by invoice" the rep sees, shown to the reviewer as well. Null on a
   * field claim.
   */
  requesterInvoiceSlots: DirectOrderInvoiceSlotCount | null;
  /**
   * A field claim on a pharmacy that was already confirmed by invoice: the rep went back with a
   * live photo and location. Approving it frees one of their invoice slots.
   */
  upgradesInvoiceValidation: boolean;
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

/**
 * Who may open the desk at all: everyone above, plus the SFE Manager — who sees and decides INVOICE
 * claims only (owner, 2026-09-14: the reviewer of an invoice validation is "both"). A live-photo
 * claim is still decided by a System Admin alone; `decideDirectOrderPharmacyValidation` enforces
 * that per row and `listDirectOrderPharmacyValidations` filters the SFE Manager's queue to match.
 */
export function canDecideDirectOrderInvoiceValidations(access: AccessContext): boolean {
  return canDecideDirectOrderPharmacyValidations(access) || access.role === "SFE Manager";
}

function assertValidationDeskAccess(access: AccessContext): void {
  if (!canDecideDirectOrderInvoiceValidations(access)) {
    throw forbiddenError("Forbidden: only a System Admin or an SFE Manager can decide pharmacy validations.");
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
    /**
     * The pharmacy trade licence, optional always. Unlike `photoDataUrl` this may be a PDF and may
     * come from a file picker — it is a document, not a claim about a place. See
     * `src/lib/venues/pharmacy-license.ts` for the full reasoning.
     */
    licenseDataUrl?: string | null;
    /**
     * `invoice` files the claim on a distributor invoice ALONE — no pin and no storefront photo —
     * limited to {@link DIRECT_ORDER_INVOICE_SLOT_LIMIT} open pharmacies per rep. Anything else is the
     * field route, which is what every caller sent before this existed.
     */
    validationRoute?: DirectOrderValidationRoute | null;
    /** The distributor invoice as a data URL (JPEG, PNG or PDF). Required on the invoice route. */
    invoiceDataUrl?: string | null;
    /**
     * The storefront pin exactly as the client posted it. Read below with `readCoordinateInput`,
     * never pre-parsed by the caller: `Number("")` and `Number(" ")` are 0, so a route that coerced
     * a blank pin handed this function a finite 0 and the claim was filed at 0°N 0°E.
     */
    capturedLatitude?: unknown;
    capturedLongitude?: unknown;
    /** The fix's accuracy exactly as posted, read below with `readAccuracyInput` for the same reason. */
    capturedAccuracyMeters?: unknown;
    capturedAt?: string | null;
    capturedAddress?: string | null;
    /**
     * The live photo’s OWN fix, read at the shutter — NOT a copy of the `captured*` pin above.
     * Unparsed for the same reason as the pin. All four may be absent: the shutter never blocks
     * on a second reading, and absent means NOT MEASURED, never “same place as the pin”.
     */
    photoLatitude?: unknown;
    photoLongitude?: unknown;
    photoAccuracyMeters?: unknown;
    photoCapturedAt?: string | null;
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

  const validationRoute = normalizeDirectOrderValidationRoute(input.validationRoute);
  const isInvoiceRoute = validationRoute === "invoice";

  // LEG 1 OF THE VENUE RULE — a location is a must (owner, 2026-08-26). See
  // `src/lib/venues/venue-validation-rule.ts` for all three legs.
  //
  // Until now these two arrived `?? null` and a claim with no pin was filed exactly like one that
  // had it. The pin is not decoration: it is the only input that ties the storefront photo to a
  // PLACE, it is what `resolveAreaProximity` scores below, and `gps_inside_requester_area` reads
  // `false` for a missing pin and for a pin 400km away alike — so a submission with none arrives on
  // the desk looking like a submission that failed the proximity check.
  //
  // Safe to make a refusal: all 6 production validations carry coordinates, so this refuses nothing
  // anyone has ever legitimately sent. Each coordinate is read on its own by the shared reader, so
  // null, a missing key, NaN, "" and whitespace are all no coordinate, where `Number(...)` made the
  // blank ones a finite 0 that passed this check.
  const capturedLatitude = readCoordinateInput(input.capturedLatitude);
  const capturedLongitude = readCoordinateInput(input.capturedLongitude);
  //
  // THE INVOICE ROUTE IS THE ONE EXCEPTION (owner, 2026-09-14): a distributor invoice validates a
  // pharmacy on its own, and the price is the five-pharmacy limit enforced below — not a pin.
  if (!isInvoiceRoute && (capturedLatitude === null || capturedLongitude === null)) {
    badRequest(VENUE_LOCATION_REQUIRED_MESSAGE);
  }
  // The fix's accuracy decides nothing and refuses nothing; it is only stored. A blank one is null,
  // where the route's `Number(...)` stored it as 0 m, a perfect fix the device never reported.
  const capturedAccuracyMeters = readAccuracyInput(input.capturedAccuracyMeters);
  // The photo’s own reading, through the same readers and stored beside the pin rather than over
  // it. Deliberately NOT defaulted to the pin when absent: that substitution is the defect this
  // replaces, and downstream it would be indistinguishable from a real second measurement. It
  // refuses nothing either — a photo is never rejected for having no fix of its own.
  const photoLatitude = readCoordinateInput(input.photoLatitude);
  const photoLongitude = readCoordinateInput(input.photoLongitude);
  const photoAccuracyMeters = readAccuracyInput(input.photoAccuracyMeters);

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

    // 🔴 THE ORDER'S STATUS NO LONGER REFUSES A FIELD CAPTURE (owner, 2026-09-29: "let the rep
    // capture a venue whenever it is still pending_review"). It used to demand `held` here as well
    // as on the screen, and that made a System Admin's hold release a permanent, silent lock on the
    // venue's only capture door — see `canCaptureDirectOrderValidation` for the case that found it.
    //
    // THE INVOICE ROUTE KEEPS THE OLD RULE. His ruling is about the rep standing in front of a
    // venue; the invoice lane is a different bargain — five pharmacies per rep, filed against the
    // held order the decision revives — and widening that was not asked for. Kept narrow on purpose.
    if (isInvoiceRoute && linkedRequestStatus !== "held") {
      badRequest(
        `This order is no longer waiting on a pharmacy — it is ${linkedRequestStatus ?? "in an unknown state"}. ` +
          "An invoice validation belongs to a held order; to validate this venue now, capture it with a live photo and location.",
      );
    }
  }

  // An invoice validates the pharmacy behind a HELD order — that is where the rep meets the problem,
  // and it is the order the decision revives. With no order there is nothing for the invoice to move.
  if (isInvoiceRoute && !linkedRequestId) {
    badRequest("Attach the invoice from the held order it belongs to — open that order and validate its pharmacy there.");
  }

  // THE GATE THAT REPLACES IT, and the one his ruling names: does this venue still need somebody to
  // stand in front of it? A venue already `verified` needs no further evidence, and a `rejected` one
  // was examined and found not to be real — re-filing against either is not a capture worth taking.
  //
  // Read on THIS side of the wire, not inferred from the screen: `canCaptureDirectOrderValidation`
  // hides the button on the same condition, and a hidden button is UX, never access control.
  const { data: venueRow } = await getSupabaseAdmin()
    .from("direct_order_pharmacies")
    .select("verification_status")
    .eq("id", pharmacyId)
    .maybeSingle();
  if (!venueRow) throw notFoundError("That venue was not found.");
  const venueStatus = String((venueRow as { verification_status?: string | null }).verification_status ?? "");
  if (venueStatus !== "pending_review") {
    badRequest(
      venueStatus === "verified"
        ? "This venue is already validated — no further evidence is needed for it."
        : `This venue is ${venueStatus || "in an unknown state"}, so it is not waiting for evidence.`,
    );
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
  //
  // 🔴 ASSERTED ONLY WHEN THE ORDER IS ACTUALLY HELD, since 2026-09-29. The registry models ORDER
  // transitions — every one of its sixteen actions is `from: [statuses] -> to: one status` — and
  // this action is declared `held -> held`, meaning "the order stays held while evidence is
  // gathered". After the owner's ruling a capture can also happen while the order is `returned` or
  // `pending_approval`, and it changes the order's status in NEITHER case.
  //
  // So there is no honest way to keep asserting it there. Widening `from` while leaving `to: held`
  // would make the registry claim a returned order becomes held, which it does not — a fabricated
  // transition is worse than an absent one, because the audit surface would then be lying rather
  // than silent. Asserting it only where it is true keeps the F2 coverage exactly where the registry
  // still describes reality.
  //
  // WHAT THAT GIVES UP, AND WHY IT IS NOTHING: the registry's other half is its `allowedRoles` — the
  // five requester roles plus Super Admin. It can never refuse anyone the checks above admit,
  // because only the order's OWN REQUESTER reaches this line (the ownership check), and the
  // requester of a direct order is by definition one of those roles. That is the same reasoning the
  // comment above already makes about `direct_orders:create` being wider than the truth.
  if (linkedRequestStatus === "held") {
    await assertDirectOrderWorkflowTransition({
      access,
      actionKey: "request_pharmacy_validation",
      expectedNextStatus: "held",
      status: linkedRequestStatus,
    });
  }

  // The invoice route carries no storefront photo, so there is nothing to parse; every other claim
  // still must be a live JPEG.
  const bytes = isInvoiceRoute ? null : parseDirectOrderEvidencePhotoDataUrl(input.photoDataUrl).bytes;

  // Parsed before the row exists, for the same reason as the photo and the licence below.
  let invoice: ParsedDirectOrderInvoiceFile | null = null;
  if (isInvoiceRoute) {
    try {
      invoice = parseDirectOrderInvoiceDataUrl(input.invoiceDataUrl);
    } catch (invoiceError) {
      badRequest(invoiceError instanceof Error ? invoiceError.message : "The distributor invoice file is not valid.");
    }
  }

  // Parsed BEFORE the row is inserted, on the same reasoning as the storefront photo: a licence
  // that is too large or is a file type nobody can open must fail while the rep is still looking
  // at the form, not after a validation row exists claiming a document it never received.
  // `parsePharmacyLicenseDataUrl` throws a plain Error; this module reports its refusals as 400s.
  let license: { bytes: Buffer; contentType: PharmacyLicenseContentType; extension: string } | null = null;
  if (String(input.licenseDataUrl ?? "").trim()) {
    try {
      license = parsePharmacyLicenseDataUrl(input.licenseDataUrl);
    } catch (licenseError) {
      badRequest(licenseError instanceof Error ? licenseError.message : "The pharmacy licence file is not valid.");
    }
  }

  const supabase = getSupabaseAdmin();
  const { data: pharmacy } = await supabase
    .from("direct_order_pharmacies")
    .select("id, area_code, verification_status, venue_type")
    .eq("id", pharmacyId)
    .maybeSingle();
  if (!pharmacy) throw notFoundError("Venue not found.");

  if (isInvoiceRoute) {
    const invoiceVenueType = normalizeVenueType((pharmacy as { venue_type?: string | null }).venue_type);
    // A distributor invoice is a distributor vouching for its customer. A venue with no distributor
    // account has no such invoice to produce, so the route is not open to it.
    if (!venueRequiresDistributorCode(invoiceVenueType)) {
      badRequest(
        `A ${venueTypeLabel(invoiceVenueType).toLowerCase()} has no distributor account, so it cannot be validated by a distributor invoice. Validate it with a live photo and location.`,
      );
    }
    if (String((pharmacy as { verification_status?: string | null }).verification_status ?? "") === "verified") {
      badRequest("This pharmacy is already confirmed — it needs no invoice.");
    }
    // THE LIMIT (owner, 2026-09-14): no sixth pharmacy on an invoice alone until a slot opens.
    const slots = await getDirectOrderInvoiceValidationSlots(access);
    if (slots.used >= slots.limit) badRequest(directOrderInvoiceSlotsFullMessage(slots));
  } else if (!linkedRequestId) {
    // A live photo with no order behind it exists for ONE purpose: validating in the field a pharmacy
    // the rep already confirmed by invoice, which frees that slot. It must be THEIR invoice claim —
    // otherwise any rep could file evidence against any pharmacy, which is what the ownership check
    // on the linked order stops everywhere else.
    const ownInvoiceClaim = await pharmacyHasConfirmedInvoiceValidation(supabase, pharmacyId, access.hrId ?? "");
    if (!ownInvoiceClaim) {
      throw forbiddenError(
        "Forbidden: a live photo without an order is only for a pharmacy you validated by invoice. Open your held order to validate this pharmacy.",
      );
    }
  }

  // ONE OPEN CLAIM PER PHARMACY on the two new paths. The UI hides the button while one is pending,
  // but a double tap or a second tab would otherwise file the same invoice — or the same field check —
  // twice, and the reviewer would decide the same thing twice.
  if (isInvoiceRoute || !linkedRequestId) {
    const ownKeys = hrIdLookupKeys(access.hrId ?? "").filter(Boolean);
    const { count: openClaims, error: openClaimsError } = await supabase
      .from("direct_order_pharmacy_validations")
      .select("id", { count: "exact", head: true })
      .eq("pharmacy_id", pharmacyId)
      .eq("validation_route", validationRoute)
      .eq("status", "pending")
      .in("requested_by_hr_id", ownKeys.length > 0 ? ownKeys : [""]);
    if (openClaimsError) throw openClaimsError;
    if ((openClaims ?? 0) > 0) {
      badRequest(
        isInvoiceRoute
          ? "You already sent an invoice for this pharmacy. It is waiting for review."
          : "You already sent a live photo of this pharmacy. It is waiting for review.",
      );
    }
  }

  const areaCode = (pharmacy as { area_code?: string | null }).area_code ?? null;
  // Resolved SERVER-SIDE from the stored geography — never taken from the browser, which is the
  // one place a rep could otherwise assert their own compliance.
  const proximity = await resolveAreaProximity({
    areaCode,
    latitude: capturedLatitude,
    longitude: capturedLongitude,
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
      requested_by_hr_id: hrIdForStorage(access.hrId),
      suggestions_shown: suggestions.length > 0 ? suggestions : null,
      suggestions_refused: suggestions.length > 0,
      claimed_pharmacy_name: claimedName,
      claimed_address: input.claimedAddress?.trim() || null,
      claimed_doctor_name: input.claimedDoctorName?.trim() || null,
      claimed_reason: reason,
      captured_latitude: capturedLatitude,
      captured_longitude: capturedLongitude,
      captured_accuracy_meters: capturedAccuracyMeters,
      captured_at: input.capturedAt ?? null,
      captured_address: input.capturedAddress?.trim() || null,
      photo_latitude: photoLatitude,
      photo_longitude: photoLongitude,
      photo_accuracy_meters: photoAccuracyMeters,
      photo_captured_at: input.photoCapturedAt ?? null,
      requester_area_code: areaCode,
      gps_inside_requester_area: proximity.inside,
      storage_bucket: DIRECT_ORDER_EVIDENCE_BUCKET,
      validation_route: validationRoute,
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
  let path: string | null = null;
  if (bytes) {
    path = `${pharmacyId}/${validationId}.jpg`;
    const { error: uploadError } = await supabase.storage
      .from(DIRECT_ORDER_EVIDENCE_BUCKET)
      .upload(path, bytes, { contentType: "image/jpeg", upsert: true });
    if (uploadError) {
      // Never leave a validation claiming evidence it does not have.
      await supabase.from("direct_order_pharmacy_validations").delete().eq("id", validationId);
      throw uploadError;
    }
    await supabase.from("direct_order_pharmacy_validations").update({ storage_path: path }).eq("id", validationId);
  }

  // The distributor invoice, on the invoice route. Its own bucket, and a failed upload unwinds the
  // filing for the same reason the storefront photo does: an invoice claim with no invoice on file
  // would reach the reviewer as a claim resting on nothing.
  if (invoice) {
    const invoicePath = `${pharmacyId}/${validationId}-invoice.${invoice.extension}`;
    const { error: invoiceUploadError } = await supabase.storage
      .from(DIRECT_ORDER_INVOICE_BUCKET)
      .upload(invoicePath, invoice.bytes, { contentType: invoice.contentType, upsert: true });
    if (invoiceUploadError) {
      await supabase.from("direct_order_pharmacy_validations").delete().eq("id", validationId);
      throw invoiceUploadError;
    }
    await supabase
      .from("direct_order_pharmacy_validations")
      .update({
        invoice_content_type: invoice.contentType,
        invoice_storage_path: invoicePath,
        invoice_uploaded_at: new Date().toISOString(),
      })
      .eq("id", validationId);
  }

  // The licence, when one was attached. Same id-keyed path shape, `-license` suffixed so the two
  // objects for one claim can never collide — but a DIFFERENT bucket. `direct-order-evidence` is
  // provisioned JPEG-only with a 2MB ceiling, which is a second wall behind the live-capture parser
  // and must stay that way; the licence goes to `pharmacy-licenses`, which admits a PNG or a PDF.
  //
  // A FAILURE HERE UNWINDS THE WHOLE FILING, exactly as the storefront upload does. That looks
  // harsh for an optional document, and it is the right call: the alternative is a validation row
  // whose `license_storage_path` is null while the rep watched a licence upload and believed it was
  // sent. A rep who is told "it did not send, try again" loses a minute; an approver who decides a
  // codeless pharmacy believing no licence exists loses the only identity check there was.
  if (license) {
    const licensePath = `${pharmacyId}/${validationId}-license.${license.extension}`;
    const { error: licenseUploadError } = await supabase.storage
      .from(PHARMACY_LICENSE_BUCKET)
      .upload(licensePath, license.bytes, { contentType: license.contentType, upsert: true });
    if (licenseUploadError) {
      if (path) await supabase.storage.from(DIRECT_ORDER_EVIDENCE_BUCKET).remove([path]).catch(() => undefined);
      await supabase.from("direct_order_pharmacy_validations").delete().eq("id", validationId);
      throw licenseUploadError;
    }
    await supabase
      .from("direct_order_pharmacy_validations")
      .update({
        license_content_type: license.contentType,
        license_storage_path: licensePath,
        license_uploaded_at: new Date().toISOString(),
      })
      .eq("id", validationId);
  }

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
  // The venue type decides WHICH question the photo is read against. Without it every photo was
  // judged "is this a pharmacy", so a clinic filed (correctly) as a nursery came back a red
  // "does not look like a pharmacy" on evidence that was never wrong.
  // No storefront photo on the invoice route, so nothing to read.
  if (bytes) {
    try {
      const evidenceCheck = await checkDirectOrderStorefrontEvidence({
        bytes,
        claimedPharmacyName: claimedName,
        venueType: normalizeVenueType((pharmacy as { venue_type?: string | null }).venue_type),
      });
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
  }

  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? access.hrId,
    entityType: "direct_order_request",
    entityId: `validation:${validationId}`,
    newValues: {
      pharmacyId,
      status: "pending",
      areaCode,
      distanceKm: proximity.distanceKm,
      licenseAttached: Boolean(license),
      validationRoute,
      invoiceAttached: Boolean(invoice),
    },
    summary: `Pharmacy validation requested by ${access.hrId ?? "unknown"} for ${claimedName}${isInvoiceRoute ? " on a distributor invoice" : ""}${license ? ", with a pharmacy licence attached" : ""}.`,
  });

  return { validationId };
}

// ─────────────────────────────────────────────────────────────────────────────
// Invoice slots (owner, 2026-09-14).
//
// A rep may hold at most DIRECT_ORDER_INVOICE_SLOT_LIMIT pharmacies on an invoice alone. A slot is
// IN USE while the invoice claim is pending or was approved/matched, and it FREES when:
//   - the claim is rejected (the slot comes back — owner's answer), or
//   - the pharmacy is later confirmed by a live-photo validation (the rep went back in the field), or
//   - the pharmacy itself was ruled false.
// None of that is a shape a CHECK constraint can hold, so it is computed here, in one place, and
// used by the refusal, the rep's counter and the reviewer's counter alike.
// ─────────────────────────────────────────────────────────────────────────────

const INVOICE_SLOT_STATUSES: DirectOrderValidationStatus[] = ["pending", "approved_new", "matched_existing"];
const CONFIRMED_VALIDATION_STATUSES: DirectOrderValidationStatus[] = ["approved_new", "matched_existing"];

export type DirectOrderInvoiceSlotPharmacy = {
  validationId: string;
  pharmacyId: string;
  pharmacyName: string;
  phoenixPharmacyCode: string;
  venueType: VenueType;
  /** `pending` = the invoice is still with the reviewer; approved/matched = confirmed on it. */
  status: DirectOrderValidationStatus;
  requestedAt: string;
  /** A live-photo validation of this pharmacy is waiting for a decision; approving it frees the slot. */
  fieldValidationPending: boolean;
};

export type DirectOrderInvoiceSlots = DirectOrderInvoiceSlotCount & {
  pharmacies: DirectOrderInvoiceSlotPharmacy[];
};

/**
 * Every open invoice slot of the given requesters, keyed by canonical HR id.
 *
 * Both spellings of each HR id are looked up, because `requested_by_hr_id` holds canonical ids from
 * 2026-09-05 and the lower-cased comparison key before that. Chunked at 50 because a long PostgREST
 * `.in()` comes back empty with no error — which here would read as "no slots used" and let a rep
 * past the limit.
 */
async function loadOpenInvoiceSlots(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  requesterHrIds: string[],
): Promise<Map<string, DirectOrderInvoiceSlotPharmacy[]>> {
  const slotsByRequester = new Map<string, DirectOrderInvoiceSlotPharmacy[]>();
  const lookupKeys = Array.from(new Set(requesterHrIds.flatMap((hr) => hrIdLookupKeys(hr)).filter(Boolean)));
  if (lookupKeys.length === 0) return slotsByRequester;

  const invoiceRows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < lookupKeys.length; i += 50) {
    const { data, error } = await supabase
      .from("direct_order_pharmacy_validations")
      .select("id, pharmacy_id, requested_by_hr_id, status, requested_at")
      .eq("validation_route", "invoice")
      .in("status", INVOICE_SLOT_STATUSES)
      .in("requested_by_hr_id", lookupKeys.slice(i, i + 50))
      .order("requested_at", { ascending: false });
    if (error) throw error;
    invoiceRows.push(...((data ?? []) as Array<Record<string, unknown>>));
  }
  if (invoiceRows.length === 0) return slotsByRequester;

  const pharmacyIds = Array.from(new Set(invoiceRows.map((r) => String(r.pharmacy_id))));
  const confirmedInField = new Set<string>();
  const pendingInField = new Set<string>();
  const pharmacyById = new Map<
    string,
    { pharmacy_name: string | null; phoenix_pharmacy_code: string | null; venue_type: string | null; verification_status: string | null }
  >();
  for (let i = 0; i < pharmacyIds.length; i += 50) {
    const chunk = pharmacyIds.slice(i, i + 50);
    const [fieldResult, pharmacyResult] = await Promise.all([
      supabase
        .from("direct_order_pharmacy_validations")
        .select("pharmacy_id, status")
        .eq("validation_route", "field")
        .in("status", ["pending", ...CONFIRMED_VALIDATION_STATUSES])
        .in("pharmacy_id", chunk),
      supabase
        .from("direct_order_pharmacies")
        .select("id, pharmacy_name, phoenix_pharmacy_code, venue_type, verification_status")
        .in("id", chunk),
    ]);
    if (fieldResult.error) throw fieldResult.error;
    if (pharmacyResult.error) throw pharmacyResult.error;
    for (const field of (fieldResult.data ?? []) as Array<{ pharmacy_id: string; status: string }>) {
      if (field.status === "pending") pendingInField.add(String(field.pharmacy_id));
      else confirmedInField.add(String(field.pharmacy_id));
    }
    for (const pharmacy of (pharmacyResult.data ?? []) as Array<{
      id: string;
      pharmacy_name: string | null;
      phoenix_pharmacy_code: string | null;
      venue_type: string | null;
      verification_status: string | null;
    }>) {
      pharmacyById.set(String(pharmacy.id), pharmacy);
    }
  }

  const seen = new Set<string>();
  for (const row of invoiceRows) {
    const pharmacyId = String(row.pharmacy_id);
    const requester = canonicalHrIdKey(String(row.requested_by_hr_id ?? ""));
    if (!requester) continue;
    // Validated in the field since: the slot is free.
    if (confirmedInField.has(pharmacyId)) continue;
    const pharmacy = pharmacyById.get(pharmacyId);
    // Ruled false, or gone: nothing left standing on this invoice.
    if (!pharmacy || pharmacy.verification_status === "rejected") continue;
    const key = `${requester}:${pharmacyId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const list = slotsByRequester.get(requester) ?? [];
    list.push({
      validationId: String(row.id),
      pharmacyId,
      pharmacyName: pharmacy.pharmacy_name ?? "(pharmacy missing)",
      phoenixPharmacyCode: pharmacy.phoenix_pharmacy_code ?? "—",
      venueType: normalizeVenueType(pharmacy.venue_type),
      status: String(row.status ?? "pending") as DirectOrderValidationStatus,
      requestedAt: String(row.requested_at ?? ""),
      fieldValidationPending: pendingInField.has(pharmacyId),
    });
    slotsByRequester.set(requester, list);
  }
  return slotsByRequester;
}

/**
 * The viewer's OWN invoice slots — "2 of 5 pharmacies validated by invoice" and which pharmacies
 * they are. Reads only the caller's own claims, so it needs no desk gate.
 */
export async function getDirectOrderInvoiceValidationSlots(access: AccessContext): Promise<DirectOrderInvoiceSlots> {
  const hrId = access.hrId ?? "";
  const key = canonicalHrIdKey(hrId);
  if (!key) return { used: 0, limit: DIRECT_ORDER_INVOICE_SLOT_LIMIT, pharmacies: [] };
  const slots = await loadOpenInvoiceSlots(getSupabaseAdmin(), [hrId]);
  const pharmacies = slots.get(key) ?? [];
  return { used: pharmacies.length, limit: DIRECT_ORDER_INVOICE_SLOT_LIMIT, pharmacies };
}

/**
 * Someone ELSE's slot count — the requester's, read while an approver looks at their order or while
 * the SFE Manager's approval decides whether it counts as one. The same computation as the rep's own
 * counter, so the approver and the rep can never read two different numbers.
 */
export async function getDirectOrderInvoiceSlotCountForRequester(requesterHrId: string): Promise<DirectOrderInvoiceSlotCount> {
  const key = canonicalHrIdKey(requesterHrId);
  if (!key) return { used: 0, limit: DIRECT_ORDER_INVOICE_SLOT_LIMIT };
  const slots = await loadOpenInvoiceSlots(getSupabaseAdmin(), [requesterHrId]);
  return { used: (slots.get(key) ?? []).length, limit: DIRECT_ORDER_INVOICE_SLOT_LIMIT };
}

/**
 * Was this pharmacy confirmed by an invoice claim — optionally, one filed by this requester?
 * `head: true`: the question is whether one exists, never the rows.
 */
async function pharmacyHasConfirmedInvoiceValidation(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  pharmacyId: string,
  requesterHrId?: string,
): Promise<boolean> {
  let query = supabase
    .from("direct_order_pharmacy_validations")
    .select("id", { count: "exact", head: true })
    .eq("pharmacy_id", pharmacyId)
    .eq("validation_route", "invoice")
    .in("status", CONFIRMED_VALIDATION_STATUSES);
  if (requesterHrId !== undefined) {
    const keys = hrIdLookupKeys(requesterHrId).filter(Boolean);
    // No HR id is nobody's claim — never an unfiltered "anyone's".
    if (keys.length === 0) return false;
    query = query.in("requested_by_hr_id", keys);
  }
  const { count, error } = await query;
  if (error) throw error;
  return (count ?? 0) > 0;
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
  return ((data ?? []) as Array<Record<string, unknown>>)
    .map((row) => ({
      distributorCode: String(row.distributor_code ?? ""),
      customerCode: String(row.customer_code ?? ""),
      customerName: String(row.customer_name ?? ""),
      address: row.address ? String(row.address) : null,
      areaCode: row.area_code ? String(row.area_code) : null,
      score: Number(row.score ?? 0),
    }))
    // Owner rule 2026-09-22 ("never never never"): a wholesaler / makhzan is never offered as a
    // "did you mean" candidate — not to the rep before they claim a new pharmacy, nor to the Super
    // Admin on the validation desk (both read this same call).
    .filter((hit) => !isCertainWholesalerVenue(hit.customerName, hit.customerCode, hit.distributorCode));
}

type ValidationPharmacyRow = {
  pharmacy_name: string;
  phoenix_pharmacy_code: string;
  /** Nullable because every row written before the column existed reads back NULL — see `normalizeVenueType`. */
  venue_type?: string | null;
};

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
  /**
   * Whether this pharmacy holds a distributor code, when the caller already knows. The desk reads
   * it for every row in ONE query rather than one per claim; the single-row caller passes nothing
   * and this resolves it itself.
   */
  hasDistributorCode?: boolean,
  /**
   * The desk resolves both of these for every row in a few queries; the single-row caller passes
   * nothing and they are resolved here.
   */
  context?: { invoiceSlotsUsed?: number; upgradesInvoiceValidation?: boolean },
): Promise<DirectOrderValidationRow> {
  const bucket = String(row.storage_bucket ?? DIRECT_ORDER_EVIDENCE_BUCKET);
  const storagePath = row.storage_path ? String(row.storage_path) : null;
  let photoUrl: string | null = null;
  if (storagePath) {
    const { data: signed } = await supabase.storage
      .from(bucket)
      .createSignedUrl(storagePath, EVIDENCE_SIGNED_URL_TTL_SECONDS);
    photoUrl = signed?.signedUrl ?? null;
  }
  // Read from the licence bucket, NOT from `bucket` above. `storage_bucket` on this row describes
  // the storefront photo and only that; the licence has always lived in `pharmacy-licenses`, which
  // is one fixed name rather than a per-row value, so there is nothing on the row to consult.
  const licensePath = row.license_storage_path ? String(row.license_storage_path) : null;
  let licenseUrl: string | null = null;
  if (licensePath) {
    const { data: signedLicense } = await supabase.storage
      .from(PHARMACY_LICENSE_BUCKET)
      .createSignedUrl(licensePath, EVIDENCE_SIGNED_URL_TTL_SECONDS);
    licenseUrl = signedLicense?.signedUrl ?? null;
  }
  // The distributor invoice lives in its own bucket, one fixed name — same reasoning as the licence.
  const validationRoute = normalizeDirectOrderValidationRoute(row.validation_route);
  const invoicePath = row.invoice_storage_path ? String(row.invoice_storage_path) : null;
  let invoiceUrl: string | null = null;
  if (invoicePath) {
    const { data: signedInvoice } = await supabase.storage
      .from(DIRECT_ORDER_INVOICE_BUCKET)
      .createSignedUrl(invoicePath, EVIDENCE_SIGNED_URL_TTL_SECONDS);
    invoiceUrl = signedInvoice?.signedUrl ?? null;
  }
  let invoiceSlotsUsed = context?.invoiceSlotsUsed;
  if (validationRoute === "invoice" && invoiceSlotsUsed === undefined) {
    const requester = String(row.requested_by_hr_id ?? "");
    const slots = await loadOpenInvoiceSlots(supabase, [requester]);
    invoiceSlotsUsed = (slots.get(canonicalHrIdKey(requester) ?? "") ?? []).length;
  }
  let upgradesInvoiceValidation = context?.upgradesInvoiceValidation;
  if (validationRoute === "field" && upgradesInvoiceValidation === undefined) {
    upgradesInvoiceValidation = await pharmacyHasConfirmedInvoiceValidation(supabase, String(row.pharmacy_id));
  }

  // Resolved here only for the single-row caller. `head: true` sends no rows — this asks whether
  // ANY code exists, and the answer is a boolean either way.
  let codeKnown = hasDistributorCode;
  if (codeKnown === undefined) {
    const { count } = await supabase
      .from("direct_order_pharmacy_distributor_codes")
      .select("pharmacy_id", { count: "exact", head: true })
      .eq("pharmacy_id", String(row.pharmacy_id));
    codeKnown = (count ?? 0) > 0;
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
    // `normalizeVenueType`, not `parseVenueTypeChoice`: this reads a STORED column, and a row
    // written before it existed is a pharmacy, which is what it was.
    venueType: normalizeVenueType(pharmacy?.venue_type),
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
    licenseUrl,
    licenseContentType: row.license_content_type
      ? (String(row.license_content_type) as PharmacyLicenseContentType)
      : null,
    licenseUploadedAt: row.license_uploaded_at ? String(row.license_uploaded_at) : null,
    // Same rule as `evidenceCheck` below — null is "nobody was asked", never "checked and fine".
    licenseNameMatchesSign:
      row.license_name_matches_sign == null ? null : Boolean(row.license_name_matches_sign),
    hasDistributorCode: codeKnown,
    validationRoute,
    invoiceUrl,
    invoiceContentType: row.invoice_content_type
      ? (String(row.invoice_content_type) as DirectOrderInvoiceContentType)
      : null,
    invoiceUploadedAt: row.invoice_uploaded_at ? String(row.invoice_uploaded_at) : null,
    requesterInvoiceSlots:
      validationRoute === "invoice"
        ? { used: invoiceSlotsUsed ?? 0, limit: DIRECT_ORDER_INVOICE_SLOT_LIMIT }
        : null,
    upgradesInvoiceValidation: validationRoute === "field" && Boolean(upgradesInvoiceValidation),
    // Read straight through: the column is null whenever there is no answer, and null must stay
    // null all the way to the screen rather than becoming a default that reads like a pass.
    evidenceCheck: (row.evidence_check as DirectOrderEvidenceCheck | null) ?? null,
    // Name-based wholesaler suspicion (owner rule, 2026-09-22). Name-only: a certain wholesaler is
    // already blocked upstream, so what a claim can still carry here is the ambiguous فارما tier.
    suspectedWholesaler: suspectedWholesalerFlag(row.claimed_pharmacy_name as string | null),
    suspectedWholesalerNote: suspectedWholesalerNote(row.claimed_pharmacy_name as string | null),
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
  const decidesEveryClaim = canDecideDirectOrderPharmacyValidations(access);
  if (!decidesEveryClaim && !canDecideDirectOrderInvoiceValidations(access)) return 0;
  const supabase = getSupabaseAdmin();
  let query = supabase
    .from("direct_order_pharmacy_validations")
    .select("id", { count: "exact", head: true })
    .eq("status", "pending");
  // The SFE Manager's badge counts the claims they can clear: invoice claims only.
  if (!decidesEveryClaim) query = query.eq("validation_route", "invoice");
  const { count, error } = await query;
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
  // An SFE Manager's desk holds the claims they may decide — invoice claims — and nothing else.
  if (!canDecideDirectOrderPharmacyValidations(access)) query = query.eq("validation_route", "invoice");
  const { data, error } = await query;
  if (error) throw error;

  const rows = (data ?? []) as Array<Record<string, unknown>>;
  if (rows.length === 0) return [];

  const pharmacyIds = Array.from(new Set(rows.map((r) => String(r.pharmacy_id))));
  const { data: pharmacies } = await supabase
    .from("direct_order_pharmacies")
    .select("id, pharmacy_name, phoenix_pharmacy_code, venue_type")
    .in("id", pharmacyIds);
  const pharmacyById = new Map(
    ((pharmacies ?? []) as Array<{ id: string } & ValidationPharmacyRow>).map((p) => [p.id, p]),
  );

  // BOTH SPELLINGS, because this column holds both. requested_by_hr_id is written canonically from
  // 2026-09-05, and every row filed before that holds the lower-cased comparison key. employees.hr_id
  // is canonical, so a raw `.in()` on the column's own value matched only the newer half and the
  // older half came back nameless — rendered as "(unknown — a-12)" rather than as an error.
  const hrIds = Array.from(
    new Set(
      rows
        .flatMap((r) => hrIdLookupKeys(String(r.requested_by_hr_id ?? "")))
        .filter(Boolean),
    ),
  );
  const { data: employees } = await supabase.from("employees").select("hr_id, full_name").in("hr_id", hrIds);
  const nameByHr = new Map(
    ((employees ?? []) as Array<{ hr_id: string; full_name: string | null }>).map((e) => [
      e.hr_id.toUpperCase(),
      e.full_name ?? e.hr_id,
    ]),
  );

  // Which of these pharmacies hold a distributor code, in ONE query for the whole desk. A codeless
  // pharmacy is the case the licence exists for, and asking per row would be an N+1 on a screen
  // that already signs two storage URLs per claim.
  //
  // Chunked at 50: a PostgREST `.in()` puts every id in the URL, so past a few hundred it comes
  // back `{ data: [], error: null }` — an empty set indistinguishable from "none of them have a
  // code", which would silently prompt for a licence on every pharmacy in the company. This
  // function takes an optional status filter and with none it returns EVERY claim ever filed, so
  // the long list is reachable.
  const pharmaciesWithCode = new Set<string>();
  for (let i = 0; i < pharmacyIds.length; i += 50) {
    const { data: codeRows } = await supabase
      .from("direct_order_pharmacy_distributor_codes")
      .select("pharmacy_id")
      .in("pharmacy_id", pharmacyIds.slice(i, i + 50));
    for (const codeRow of (codeRows ?? []) as Array<{ pharmacy_id: string }>) {
      pharmaciesWithCode.add(String(codeRow.pharmacy_id));
    }
  }

  // Each invoice claim's requester counter, and which field claims revisit an invoice pharmacy — for
  // the whole desk in a handful of queries rather than per row.
  const invoiceRequesters = rows
    .filter((r) => normalizeDirectOrderValidationRoute(r.validation_route) === "invoice")
    .map((r) => String(r.requested_by_hr_id ?? ""));
  const slotsByRequester =
    invoiceRequesters.length > 0
      ? await loadOpenInvoiceSlots(supabase, invoiceRequesters)
      : new Map<string, DirectOrderInvoiceSlotPharmacy[]>();
  const fieldPharmacyIds = Array.from(
    new Set(
      rows
        .filter((r) => normalizeDirectOrderValidationRoute(r.validation_route) === "field")
        .map((r) => String(r.pharmacy_id)),
    ),
  );
  const confirmedByInvoice = new Set<string>();
  for (let i = 0; i < fieldPharmacyIds.length; i += 50) {
    const { data: invoiceClaims, error: invoiceClaimsError } = await supabase
      .from("direct_order_pharmacy_validations")
      .select("pharmacy_id")
      .eq("validation_route", "invoice")
      .in("status", CONFIRMED_VALIDATION_STATUSES)
      .in("pharmacy_id", fieldPharmacyIds.slice(i, i + 50));
    if (invoiceClaimsError) throw invoiceClaimsError;
    for (const claim of (invoiceClaims ?? []) as Array<{ pharmacy_id: string }>) {
      confirmedByInvoice.add(String(claim.pharmacy_id));
    }
  }

  // "Put the not-field-validated line on the validation desk too" (owner, 2026-09-29). One batch for
  // the whole desk, reading each venue's WHOLE evidence — a field claim in front of the decider does
  // NOT need the line, and a pending one already counts, so a row being decided on a live photo and
  // a pin silences it by itself.
  const venueEvidence = await loadDirectOrderVenueFieldEvidenceBatch(pharmacyIds);

  const out: DirectOrderValidationRow[] = [];
  for (const row of rows) {
    const pharmacy = pharmacyById.get(String(row.pharmacy_id));
    const hr = String(row.requested_by_hr_id ?? "");
    const mapped = await mapValidationRow(
      supabase,
      row,
      pharmacy,
      nameByHr.get(hr.toUpperCase()) ?? hr,
      pharmaciesWithCode.has(String(row.pharmacy_id)),
      {
        invoiceSlotsUsed: (slotsByRequester.get(canonicalHrIdKey(hr) ?? "") ?? []).length,
        upgradesInvoiceValidation: confirmedByInvoice.has(String(row.pharmacy_id)),
      },
    );
    const evidence = venueEvidence.get(String(row.pharmacy_id));
    out.push({
      ...mapped,
      fieldEvidenceGap: evidence ? directOrderFieldEvidenceGap(evidence) : null,
    });
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
    .select("pharmacy_name, phoenix_pharmacy_code, venue_type")
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
 * Has anyone ever stood in front of this venue with a phone — and if not, why not.
 *
 * Asked of the WHOLE venue, deliberately, not of the one row the approval screen already loads.
 * `getDirectOrderPharmacyValidationForRequest` returns the MOST RECENT claim, so a venue captured in
 * the field in July and re-filed on an invoice in September would come back as invoice-only, and the
 * screen would tell an approver nobody had captured a venue somebody had. A false "no field
 * evidence" is the one answer this line must never give.
 *
 * Small by construction — the busiest venue in production holds a handful of claims — and the
 * `.limit()` is the AGENTS.md rule that an unbounded PostgREST select stops at 1000 with no marker,
 * not a real expectation of reaching it.
 */
/** The columns both loaders read, and the only shape the two predicates below understand. */
const VENUE_EVIDENCE_COLUMNS =
  "pharmacy_id, validation_route, status, storage_path, captured_latitude, captured_longitude, decision_notes";

type VenueEvidenceRow = {
  pharmacy_id?: string | null;
  validation_route?: string | null;
  status?: string | null;
  storage_path?: string | null;
  captured_latitude?: number | null;
  captured_longitude?: number | null;
  decision_notes?: string | null;
};

export type DirectOrderVenueFieldEvidence = {
  hasFieldCapture: boolean;
  validatedByInvoice: boolean;
  entrySource: string | null;
};

const NO_VENUE_EVIDENCE: DirectOrderVenueFieldEvidence = {
  hasFieldCapture: false,
  validatedByInvoice: false,
  entrySource: null,
};

/**
 * Does this ONE claim carry a live photo and a GPS fix that still stands?
 *
 * The CAPTURE is the evidence, not the decision — a marketing transfer arrives with a PENDING field
 * row already holding the rep's photo and pin. A rejected one is the desk saying the capture did not
 * stand, so it proves nothing — EXCEPT when the desk's own note says the claim was redundant, which
 * refuses the claim and not the photograph (owner, 2026-09-29).
 *
 * The photo and the two coordinates are required either way: a note readmits a decision, it never
 * invents evidence that is not on the row.
 *
 * ONE function, called by the single-venue loader and the desk's batch loader alike. Two copies of
 * this predicate could disagree about whether the same venue was captured, on two screens that are
 * looking at the same claim.
 */
function claimIsAStandingFieldCapture(row: VenueEvidenceRow): boolean {
  return (
    normalizeDirectOrderValidationRoute(row.validation_route) === "field" &&
    (String(row.status ?? "") !== "rejected" || directOrderRejectionWasOnlyRedundant(row.decision_notes)) &&
    Boolean(String(row.storage_path ?? "").trim()) &&
    row.captured_latitude != null &&
    row.captured_longitude != null
  );
}

/** Did the desk decide an INVOICE claim on this venue real? */
function claimIsADecidedInvoiceValidation(row: VenueEvidenceRow): boolean {
  return (
    normalizeDirectOrderValidationRoute(row.validation_route) === "invoice" &&
    (String(row.status ?? "") === "approved_new" || String(row.status ?? "") === "matched_existing")
  );
}

function foldVenueEvidence(rows: VenueEvidenceRow[], entrySource: string | null): DirectOrderVenueFieldEvidence {
  return {
    entrySource,
    hasFieldCapture: rows.some(claimIsAStandingFieldCapture),
    validatedByInvoice: rows.some(claimIsADecidedInvoiceValidation),
  };
}

export async function loadDirectOrderVenueFieldEvidence(
  pharmacyId: string,
): Promise<DirectOrderVenueFieldEvidence> {
  if (!pharmacyId) return NO_VENUE_EVIDENCE;
  const supabase = getSupabaseAdmin();
  const [{ data, error }, { data: venueRow }] = await Promise.all([
    supabase
      .from("direct_order_pharmacy_validations")
      .select(VENUE_EVIDENCE_COLUMNS)
      .eq("pharmacy_id", pharmacyId)
      .limit(200),
    // The RAW entry source. `DirectOrderPharmacy.entrySource` cannot answer this: its mapper folds
    // `marketing_transfer` into `catalogue`, which would tell an approver a hand-captured transfer
    // came off a distributor list. Read here rather than widening that mapper's two-value type,
    // which several other screens already read.
    supabase.from("direct_order_pharmacies").select("entry_source").eq("id", pharmacyId).maybeSingle(),
  ]);
  const entrySource = (venueRow as { entry_source?: string | null } | null)?.entry_source ?? null;
  // Never throws: this decorates an approval screen, and an approver must not lose the whole order
  // because a decoration could not be read. Absent evidence is what the empty answer already says.
  if (error) return { ...NO_VENUE_EVIDENCE, entrySource };
  return foldVenueEvidence((data ?? []) as VenueEvidenceRow[], entrySource);
}

/**
 * The same answer for MANY venues at once — the validation desk's form of it (owner, 2026-09-29:
 * "put the not-field-validated line on the validation desk too").
 *
 * The desk lists every pending claim, so asking per row would be one round trip per claim; this is
 * two, whatever the desk holds. It reads each venue's WHOLE evidence, not the pending claims the
 * desk already has, for the same reason the single loader does: a venue captured in the field months
 * ago and re-filed on an invoice today would otherwise read as uncaptured.
 *
 * CHUNKED AT 50. A PostgREST `.in()` fails three ways — zero rows and no error, `22P02` on one null
 * id, and a silent failure once the header passes ~16KB — so the ids are filtered for nullish values
 * and sent in small batches rather than one long list.
 */
export async function loadDirectOrderVenueFieldEvidenceBatch(
  pharmacyIds: string[],
): Promise<Map<string, DirectOrderVenueFieldEvidence>> {
  const out = new Map<string, DirectOrderVenueFieldEvidence>();
  const ids = Array.from(new Set(pharmacyIds.map((id) => String(id ?? "").trim()).filter(Boolean)));
  if (ids.length === 0) return out;

  const supabase = getSupabaseAdmin();
  const claimsByVenue = new Map<string, VenueEvidenceRow[]>();
  const entrySourceByVenue = new Map<string, string | null>();
  let readFailed = false;

  for (let index = 0; index < ids.length; index += 50) {
    const slice = ids.slice(index, index + 50);
    const [{ data: claims, error }, { data: venues }] = await Promise.all([
      supabase.from("direct_order_pharmacy_validations").select(VENUE_EVIDENCE_COLUMNS).in("pharmacy_id", slice),
      supabase.from("direct_order_pharmacies").select("id, entry_source").in("id", slice),
    ]);
    // Same posture as the single loader: a decoration that cannot be read must never cost the desk
    // its rows. The venues in a failed slice simply answer "no evidence".
    if (error) readFailed = true;
    for (const row of ((claims ?? []) as VenueEvidenceRow[])) {
      const key = String(row.pharmacy_id ?? "");
      if (!key) continue;
      const list = claimsByVenue.get(key) ?? [];
      list.push(row);
      claimsByVenue.set(key, list);
    }
    for (const venue of ((venues ?? []) as Array<{ id?: string | null; entry_source?: string | null }>)) {
      const key = String(venue.id ?? "");
      if (key) entrySourceByVenue.set(key, venue.entry_source ?? null);
    }
  }

  for (const id of ids) {
    const entrySource = entrySourceByVenue.get(id) ?? null;
    out.set(
      id,
      readFailed && !claimsByVenue.has(id)
        ? { ...NO_VENUE_EVIDENCE, entrySource }
        : foldVenueEvidence(claimsByVenue.get(id) ?? [], entrySource),
    );
  }
  return out;
}

/**
 * How many of this venue's distributor codes the MASTER DATABASE actually agrees with.
 *
 * Deliberately not `count(*)` on the link table. A link row is something Phoenix wrote about itself;
 * it is not the distributor's book agreeing. Three invented codes reached production exactly that
 * way — `0000`, `0001000000`, `0001511111` — and two were later written into
 * `source_of_sales_customer_map`, where a fabricated code resolves forever and looks trustworthy to
 * every later reader. So each pair is re-checked against the map, which is the same lookup the
 * `match` decision below makes before it will accept one.
 *
 * PAIRWISE, one round trip each, rather than one `.in()` over all the codes. Two reasons and both
 * are real: an `.in()` on distributor codes crossed with an `.in()` on customer codes matches pairs
 * nobody submitted (distributor A's code against distributor B's customer), and a PostgREST `.in()`
 * carrying a long list silently returns zero rows with no error. A venue has at most a handful of
 * codes — the largest in production has one — and this runs once, when a human clicks a decision.
 */
async function countVenueCodesInMasterDatabase(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  pharmacyId: string,
): Promise<number> {
  const { data: links } = await supabase
    .from("direct_order_pharmacy_distributor_codes")
    .select("distributor_code, customer_code")
    .eq("pharmacy_id", pharmacyId);

  const pairs = (links ?? []) as Array<{ distributor_code?: string | null; customer_code?: string | null }>;
  let found = 0;
  for (const pair of pairs) {
    const distributorCode = String(pair.distributor_code ?? "").trim();
    const customerCode = String(pair.customer_code ?? "").trim();
    if (!distributorCode || !customerCode) continue;
    const { data: mapRow } = await supabase
      .from("source_of_sales_customer_map")
      .select("customer_code")
      .eq("active", true)
      .eq("distributor_code", distributorCode)
      .eq("customer_code", customerCode)
      .maybeSingle();
    if (mapRow) found += 1;
  }
  return found;
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
    /**
     * The approver's answer to the question the licence exists to ask: does the trade name printed
     * on it match the name on the shop sign?
     *
     * Optional and NON-BLOCKING. Leaving it unanswered records null — "nobody was asked" — rather
     * than refusing the decision. The system flags, it never rejects (owner's standing rule), and a
     * codeless pharmacy the admin is otherwise sure of must not be un-decidable for want of a
     * checkbox. It is written on every outcome including `reject`, because "I looked and the names
     * did not match" is the most valuable rejection reason this desk can record.
     */
    licenseNameMatchesSign?: boolean | null;
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

  // The SFE Manager decides INVOICE claims only (owner, 2026-09-14). A live-photo claim — including
  // one that revisits an invoice pharmacy — stays with a System Admin, as it always was.
  const validationRoute = normalizeDirectOrderValidationRoute((row as { validation_route?: string }).validation_route);
  const isInvoiceRoute = validationRoute === "invoice";
  const decidesEveryClaim = canDecideDirectOrderPharmacyValidations(access);
  if (!isInvoiceRoute && !decidesEveryClaim) {
    throw forbiddenError(
      "Forbidden: an SFE Manager decides invoice validations only. A validation with a live photo and location is decided by a System Admin.",
    );
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

  // A verdict about a licence that is not on file is not a verdict about anything — the DB refuses
  // that shape too (`…_license_verdict_check`), and dropping it here means an older client that
  // always sends the field cannot 500 on a claim with no licence.
  const licenseOnFile = Boolean((row as { license_storage_path?: string | null }).license_storage_path);
  const licenseVerdict =
    licenseOnFile && input.licenseNameMatchesSign != null ? Boolean(input.licenseNameMatchesSign) : null;
  const licenseColumns = licenseVerdict == null ? {} : { license_name_matches_sign: licenseVerdict };

  if (input.decision === "reject") {
    // The order stays held. Rejecting is not a dead end for the rep — they can still resubmit
    // the order against a pharmacy that has a real code, which is the outcome we want.
    await supabase
      .from("direct_order_pharmacy_validations")
      .update({
        status: "rejected",
        decided_by_hr_id: hrIdForStorage(access.hrId),
        decided_at: now,
        decision_notes: notes,
        updated_at: now,
        ...licenseColumns,
      })
      .eq("id", input.validationId);
    await writeRequiredAuditLog({
      actorLoginId: access.loginId ?? access.hrId,
      entityType: "direct_order_request",
      entityId: `validation:${input.validationId}`,
      oldValues: { status: "pending" },
      newValues: { status: "rejected", licenseNameMatchesSign: licenseVerdict },
      summary: `Pharmacy validation rejected by ${access.hrId ?? "unknown"}${notes ? `: ${notes}` : "."}`,
    });
    return;
  }

  // LEG 3 OF THE VENUE RULE — either the code, and it is in our database, or the licence (owner,
  // 2026-08-26). See `src/lib/venues/venue-validation-rule.ts`.
  //
  // ONLY ON `approve`, and the asymmetry is the whole design:
  //
  //   match   → the pair is verified against `source_of_sales_customer_map` a few lines below
  //             before it is accepted, so the code route is satisfied by the act of matching. This
  //             is the outcome we want most and nothing may make it harder.
  //   reject  → returned above, ungated. Refusing to let someone say no is how evidence stops
  //             being filed at all.
  //   approve → mints a brand-new identity for a venue the master database does not know. That is
  //             the one outcome where nothing outside the rep's own words says who this venue is,
  //             and it is the outcome the rule exists for.
  //
  // Measured before shipping: all three `approved_new` rows in production carry no licence and no
  // code the master database agrees with — including two nurseries, one of which was given an
  // invented code instead. The single validation waiting for a decision today HAS a licence, so
  // this blocks no live work.
  //
  // The existing codes are re-checked rather than assumed absent, because a pharmacy can already
  // carry a real code and still arrive here — approving it is then legitimate and must not be
  // refused for want of a document it does not need.
  // Read once, above the branches, because the venue type decides which decisions are even
  // MEANINGFUL here and not merely how one of them is judged.
  //
  // `normalizeVenueType`, not `parseVenueTypeChoice`: this reads a STORED column, and a row written
  // before the column existed is a pharmacy, which is what it was.
  const { data: venueRow } = await supabase
    .from("direct_order_pharmacies")
    .select("venue_type")
    .eq("id", pharmacyId)
    .maybeSingle();
  const venueType = normalizeVenueType((venueRow as { venue_type?: string | null } | null)?.venue_type);

  // Owner rule 2026-09-22 ("never never never"): a wholesaler / makhzan is never accepted as a
  // venue. On `approve` the only identity is the rep's claimed name — there is no code to check — so
  // a certain-wholesaler name is refused outright. (`match` is refused below on the master-database
  // customer name it would attach to.) The two-tier detector protects owner pharmacy-overrides, so a
  // real pharmacy named like a warehouse (مخزن الطرشوبى) is not caught here.
  const claimedVenueName = String((row as { claimed_pharmacy_name?: string | null }).claimed_pharmacy_name ?? "").trim();
  if (input.decision === "approve" && isCertainWholesalerVenue(claimedVenueName)) {
    badRequest(WHOLESALER_VENUE_REFUSED_MESSAGE);
  }

  // `match` IS THE FORGERY PATH FOR A VENUE WITH NO DISTRIBUTOR ACCOUNT, and it was the one door
  // left open. Matching inserts a real distributor/customer pair into
  // `direct_order_pharmacy_distributor_codes` for this venue — which is exactly the shape the whole
  // venue-type feature exists to prevent. Registration already refuses to write a code onto a
  // nursery (`src/lib/direct-orders/service.ts`), the master database already refuses to identify
  // one by a code it holds, and this desk was still able to attach one with a click.
  //
  // It is not a hypothetical: three invented nursery codes reached production before the venue type
  // existed and two were written into `source_of_sales_customer_map`, where a fabricated code
  // resolves `exact` forever. Matching would produce the same row from the other direction, and a
  // code arriving by this path would look MORE trustworthy than those did, because the pair really
  // does resolve — it just belongs to somebody else.
  if (input.decision === "match" && !venueRequiresDistributorCode(venueType)) {
    badRequest(
      `A ${venueTypeLabel(venueType).toLowerCase()} has no distributor account, so it cannot be matched to a distributor customer — ` +
        `the code would belong to a different business. Approve it on its location and photo, or reject it.`,
    );
  }

  // A field claim on a pharmacy already confirmed by invoice is the rep going back with a live photo.
  // The invoice already answered WHO the pharmacy is, so leg 3 is not asked again, and the approval
  // must not restart a probation clock (or demote a matched pharmacy) that the invoice decision set.
  const invoiceIdentityOnFile =
    !isInvoiceRoute && (await pharmacyHasConfirmedInvoiceValidation(supabase, pharmacyId));

  if (input.decision === "approve") {
    // THE INVOICE ROUTE: a distributor invoice validates the pharmacy on its own (owner, 2026-09-14),
    // so neither the code-or-licence leg nor the location-and-photo legs are asked of it.
    const gap = isInvoiceRoute || invoiceIdentityOnFile ? null : venueIdentityGapMessage({
      codesInOurDatabase: await countVenueCodesInMasterDatabase(supabase, pharmacyId),
      hasLicenseOnFile: licenseOnFile,
      venueType,
    });
    if (gap) badRequest(gap);

    // And the admin route's own gate — for a venue with no distributor account the location and the
    // live photo are the whole evidence base, so they have to actually be on the row. Both are
    // already refused at capture, so this fires on nothing a rep can send; it exists so the rule
    // cannot be satisfied by a claim that carries neither. See `venueAdminRouteEvidenceGapMessage`.
    const evidenceGap = venueAdminRouteEvidenceGapMessage({
      venueType,
      hasLocationOnFile:
        (row as { captured_latitude?: number | null }).captured_latitude != null &&
        (row as { captured_longitude?: number | null }).captured_longitude != null,
      hasLivePhotoOnFile: Boolean((row as { storage_path?: string | null }).storage_path),
    });
    if (evidenceGap) badRequest(evidenceGap);
  }

  if (input.decision === "match") {
    const distributorCode = String(input.matchDistributorCode ?? "").trim();
    const customerCode = String(input.matchCustomerCode ?? "").trim();
    if (!distributorCode || !customerCode) badRequest("Pick the real customer this pharmacy matches.");

    // The pair must exist in the master database — matching to something that is not there would
    // simply relocate the phantom.
    const { data: mapRow } = await supabase
      .from("source_of_sales_customer_map")
      .select("customer_name, brick_id, area_code, region_code")
      .eq("active", true)
      .eq("distributor_code", distributorCode)
      .eq("customer_code", customerCode)
      .maybeSingle();
    if (!mapRow) badRequest("That customer is not in the master database.");

    // Owner rule 2026-09-22 ("never never never"): matching would attach this venue to the master
    // customer, so a wholesaler / makhzan customer is refused — a warehouse's sales belong to the
    // distributor, not to a single venue. Checked with the code pair so a code-keyed owner ruling
    // (pharmacy-override or store-override) is honoured.
    const matchedCustomerName = String((mapRow as { customer_name?: string | null }).customer_name ?? "").trim();
    if (isCertainWholesalerVenue(matchedCustomerName, customerCode, distributorCode)) {
      badRequest(WHOLESALER_VENUE_REFUSED_MESSAGE);
    }

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
        decided_by_hr_id: hrIdForStorage(access.hrId),
        decided_at: now,
        decision_notes: notes,
        matched_distributor_code: distributorCode,
        matched_customer_code: customerCode,
        updated_at: now,
        ...licenseColumns,
      })
      .eq("id", input.validationId);
  } else {
    // approve → genuinely new, admitted on PROBATION. Not again for a field revisit of an invoice
    // pharmacy: its trust state was set when the invoice was decided.
    if (!invoiceIdentityOnFile) {
      await supabase
        .from("direct_order_pharmacies")
        .update({ trust_state: "provisional", probation_started_at: now })
        .eq("id", pharmacyId);
    }
    await supabase
      .from("direct_order_pharmacy_validations")
      .update({
        status: "approved_new",
        decided_by_hr_id: hrIdForStorage(access.hrId),
        decided_at: now,
        decision_notes: notes,
        updated_at: now,
        ...licenseColumns,
      })
      .eq("id", input.validationId);
  }

  // Both approve and match confirm the identity, which is what releases the held orders. Reusing
  // acknowledgeDirectOrderPharmacy keeps ONE code path for "the pharmacy is confirmed": it marks
  // it verified, audits it, and revives every order parked on it.
  //
  // An SFE Manager cannot use the standalone acknowledge action — it is a System Admin's registry
  // action — so their invoice decision confirms through a wrapper that only admits a pharmacy whose
  // INVOICE claim has just been decided. Same private write underneath, same revival of held orders.
  if (decidesEveryClaim) {
    await acknowledgeDirectOrderPharmacy(access, { pharmacyId });
  } else {
    await confirmDirectOrderPharmacyFromInvoiceValidation(access, { pharmacyId, validationId: input.validationId });
  }

  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? access.hrId,
    entityType: "direct_order_request",
    entityId: `validation:${input.validationId}`,
    oldValues: { status: "pending" },
    newValues: {
      status: input.decision === "match" ? "matched_existing" : "approved_new",
      pharmacyId,
      licenseNameMatchesSign: licenseVerdict,
      validationRoute,
    },
    summary: `Pharmacy validation${isInvoiceRoute ? " on a distributor invoice" : ""} ${input.decision === "match" ? "matched to an existing customer" : invoiceIdentityOnFile ? "approved with a live photo and location" : "approved as new (provisional)"} by ${access.hrId ?? "unknown"}${
      licenseVerdict === true
        ? ", licence name confirmed against the shop sign"
        : licenseVerdict === false
          ? ", licence name did NOT match the shop sign"
          : ""
    }.`,
  });
  bumpCustomer360Cache("direct-order pharmacy validation decided");
}
