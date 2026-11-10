/**
 * Phoenix CRM — the Super Admin validates a customer on a TRUSTED POINT (owner, 2026-11-10).
 *
 * His words: "what administrator validates will be validated as follow: we will search all locations for
 * this customer in phx crm, then we will compare with the locations of checkins of this customer from the
 * old crm until we find a trusted point or trusted average location... based on this location we will
 * extract the brick, area and all what we need." He chose: build it as HIS validation, and the customer's
 * visits are measured from that point. The rule itself is pure: `findTrustedPoint`
 * (src/lib/phoenix-crm/trusted-point-rules.ts). Account: docs/phoenix-crm-trusted-point.md.
 *
 * The readings, gathered here and nowhere else:
 *   - every Phoenix visit of the customer with a location (archived ones left out);
 *   - every place ever captured for him, RETIRED ones included (a rejected validation retires the place,
 *     and its readings are still real GPS fixes taken at his door): the photo's own reading and the
 *     Capture-location pin, each one reading, a pin identical to the photo reading counted once;
 *   - every old-CRM (iReports360) check-in of his reference contact or his own Phoenix contact id
 *     (src/lib/crm/trusted-point-checkins.ts — iReports360 rows only, never the view's Phoenix mirror).
 *   🔴 A visit COPIED from iReports360 (`imported_from_ireports360_at`) is the same check-in again at the
 *   same coordinates: it is skipped when its check-in is among the old-CRM rows read, and counted as an
 *   old-CRM reading otherwise — never twice.
 *
 * The brick, area and region are resolved by `resolvePlaceLocation`, the one resolver a captured, moved or
 * seated place uses, with the seat's own territory breaking a tie — never a second lookup rule. The apply
 * re-runs the whole preview on the server; a point from a browser is never trusted.
 *
 * 🔴 THE SUPER ADMIN'S ALONE (`canDecideSharedPlaces`: Super Admin, update, never a test account), checked
 * before anything is read. Admin-side only — golden rule #1: the rep's app never shows any of it.
 */

import { loadOldCrmCheckinsForContacts } from "@/lib/crm/trusted-point-checkins";
import { conflictError, forbiddenError, notFoundError, validationError } from "@/lib/http/api-errors";
import { isUuid } from "@/lib/phoenix-crm/plan-rules";
import { territoryForRead, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { callPhoenixCrm, numberOrNull, throwIfError } from "@/lib/phoenix-crm/server/db";
import { resolvePlaceLocation } from "@/lib/phoenix-crm/server/place-location";
import { loadPhoenixCrmConfig } from "@/lib/phoenix-crm/server/settings";
import { canDecideSharedPlaces } from "@/lib/phoenix-crm/server/shared-places";
import { restampVisitLocationsQuietly } from "@/lib/phoenix-crm/server/visit-locations";
import {
  findTrustedPoint,
  mergeTrustedPointReadings,
  TRUSTED_CORE_METERS,
  TRUSTED_MIN_DAYS,
  TRUSTED_MIN_READINGS,
  type TrustedPointGathered,
  type TrustedPointResult,
} from "@/lib/phoenix-crm/trusted-point-rules";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

/** Ceiling on one customer's Phoenix visits read — a doctor seen twice a week for years stays far under it. */
const VISITS_MAX = 3000;

/** Who may validate on a trusted point: the Super Admin, exactly as he decides shared places. */
export function canPlaceOnTrustedPoint(viewer: PhoenixCrmViewer): boolean {
  return canDecideSharedPlaces(viewer);
}

export function assertTrustedPointDecider(viewer: PhoenixCrmViewer): void {
  if (!canPlaceOnTrustedPoint(viewer)) {
    throw forbiddenError("Only the Super Admin validates a customer on a trusted point.");
  }
}

export type { TrustedPointGathered };

export type TrustedPointLocation = {
  address: string | null;
  brickName: string | null;
  brickDistanceKm: number | null;
  brickLookup: string | null;
  areaName: string | null;
  regionName: string | null;
};

export type TrustedPointPreview = {
  customerId: string;
  customerName: string;
  seatId: string;
  isTest: boolean;
  status: string;
  result: TrustedPointResult;
  counts: TrustedPointGathered["counts"];
  /** The geography of the point, resolved as a captured place's is; null when the point is not trusted. */
  location: TrustedPointLocation | null;
  /** Why it cannot be applied even when trusted (an active place, a pending check, the Archive); null when it can. */
  blockedReason: string | null;
  canApply: boolean;
  /** The rule's thresholds, so the screen states them rather than repeating numbers. */
  rule: { coreMeters: number; minReadings: number; minDays: number };
};

type CustomerRow = {
  id: string;
  name: string;
  seatId: string;
  isTest: boolean;
  status: string;
  listType: string;
  contactIds: number[];
};

async function loadCustomer(customerId: string): Promise<CustomerRow> {
  const { data, error } = await getSupabaseAdmin()
    .from("phoenix_crm_customers")
    .select("id, name, seat_id, is_test, status, list_type, reference_contact_crm_id, own_contact_crm_id")
    .eq("id", customerId)
    .maybeSingle();
  throwIfError(error);
  const row = data as Row | null;
  if (!row) throw notFoundError("This customer is not on any list. Reload the page.");
  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    seatId: String(row.seat_id),
    isTest: row.is_test === true,
    status: String(row.status ?? ""),
    listType: String(row.list_type ?? ""),
    contactIds: [numberOrNull(row.reference_contact_crm_id), numberOrNull(row.own_contact_crm_id)].filter((id): id is number => id !== null),
  };
}

/** Read every reading of where a rep stood with this customer; `mergeTrustedPointReadings` merges and de-duplicates them. */
export async function gatherTrustedPointReadings(customer: Pick<CustomerRow, "id" | "isTest" | "contactIds">): Promise<TrustedPointGathered> {
  const supabase = getSupabaseAdmin();
  const [visitsResult, placesResult, oldCheckins] = await Promise.all([
    supabase
      .from("phoenix_crm_visits")
      .select("id, lat, lon, accuracy_meters, visit_date, rep_hr_id, manager_hr_id, entered_by_hr_id, imported_from_ireports360_at, ireports360_checkin_id")
      .eq("customer_id", customer.id)
      .eq("is_test", customer.isTest)
      .is("archived_at", null)
      .not("lat", "is", null)
      .not("lon", "is", null)
      .order("visit_date", { ascending: true })
      .limit(VISITS_MAX),
    // Retired places included on purpose: a rejected capture is still a real reading at the door.
    supabase
      .from("phoenix_crm_places")
      .select("id, created_by_hr_id, captured_at, photo_lat, photo_lon, photo_accuracy_meters, photo_captured_at, pin_lat, pin_lon, pin_accuracy_meters")
      .eq("customer_id", customer.id)
      .eq("is_test", customer.isTest),
    loadOldCrmCheckinsForContacts(customer.contactIds),
  ]);
  throwIfError(visitsResult.error);
  throwIfError(placesResult.error);
  return mergeTrustedPointReadings({
    visits: (visitsResult.data ?? []) as Row[],
    places: (placesResult.data ?? []) as Row[],
    oldCheckins,
  });
}

/** The seat's own area code, from the organogram — the territory a captured place is filed in. */
async function seatAreaCodes(seatId: string): Promise<string[]> {
  const { data, error } = await getSupabaseAdmin().from("au_v_org_tree").select("seat_id, area_code").eq("seat_id", seatId).limit(1);
  throwIfError(error);
  const area = ((data ?? []) as Row[])[0]?.area_code;
  return typeof area === "string" && area.trim() ? [area.trim()] : [];
}

async function blockedReasonFor(customer: CustomerRow): Promise<string | null> {
  if (customer.status === "dropped") return "This customer is in the Archive.";
  if (customer.status !== "pending" && customer.status !== "active") return "This customer is not on the rep's list.";
  if (customer.listType !== "AM" && customer.listType !== "PM") return "A pharmacy is never validated.";
  const supabase = getSupabaseAdmin();
  const [places, reviews] = await Promise.all([
    supabase.from("phoenix_crm_places").select("id").eq("customer_id", customer.id).eq("status", "active").limit(1),
    supabase.from("phoenix_crm_validation_reviews").select("id").eq("customer_id", customer.id).eq("status", "pending").limit(1),
  ]);
  throwIfError(places.error);
  throwIfError(reviews.error);
  if ((places.data ?? []).length > 0) return "This customer already has a validated place. Move that place instead.";
  if ((reviews.data ?? []).length > 0) return "This customer's place is waiting on Place checks. Decide it there first.";
  return null;
}

type PreviewInternals = { preview: TrustedPointPreview; locationColumns: Record<string, unknown> | null };

async function buildPreview(customerId: string): Promise<PreviewInternals> {
  if (!isUuid(customerId)) throw validationError("Choose the customer.");
  const customer = await loadCustomer(customerId.toLowerCase());
  const [gathered, blockedReason] = await Promise.all([gatherTrustedPointReadings(customer), blockedReasonFor(customer)]);
  const result = findTrustedPoint(gathered.readings);
  let location: TrustedPointLocation | null = null;
  let locationColumns: Record<string, unknown> | null = null;
  if (result.trusted) {
    locationColumns = await resolvePlaceLocation(
      { lat: result.lat, lon: result.lon, accuracyMeters: result.maxSpreadMeters },
      { areaCodes: await seatAreaCodes(customer.seatId) },
    );
    location = {
      address: (locationColumns.address as string | null) ?? null,
      brickName: (locationColumns.brick_name as string | null) ?? null,
      brickDistanceKm: numberOrNull(locationColumns.brick_distance_km),
      brickLookup: (locationColumns.brick_lookup as string | null) ?? null,
      areaName: (locationColumns.area_name as string | null) ?? null,
      regionName: (locationColumns.region_name as string | null) ?? null,
    };
  }
  return {
    preview: {
      customerId: customer.id,
      customerName: customer.name,
      seatId: customer.seatId,
      isTest: customer.isTest,
      status: customer.status,
      result,
      counts: gathered.counts,
      location,
      blockedReason,
      canApply: result.trusted && blockedReason === null,
      rule: { coreMeters: TRUSTED_CORE_METERS, minReadings: TRUSTED_MIN_READINGS, minDays: TRUSTED_MIN_DAYS },
    },
    locationColumns,
  };
}

/** The preview without a viewer — the ops script's door, which runs as the system. */
export async function previewTrustedPointFor(customerId: string): Promise<TrustedPointPreview> {
  return (await buildPreview(customerId)).preview;
}

export type TrustedPointApplied = { placeId: string; customerId: string; event: string; preview: TrustedPointPreview };

/**
 * Write the trusted place. The preview is computed again HERE, so the point written is the server's own,
 * then the customer's earlier visits are measured against it (the validation's own restamp scope).
 */
export async function applyTrustedPointFor(customerId: string, actorHrId: string): Promise<TrustedPointApplied> {
  const actor = actorHrId.trim();
  if (!actor) throw validationError("Name who validates the customer.");
  const { preview, locationColumns } = await buildPreview(customerId);
  if (!preview.result.trusted || !locationColumns) throw validationError(preview.result.trusted ? "The point could not be read." : preview.result.reason);
  if (preview.blockedReason) throw conflictError(preview.blockedReason, "phoenix_crm_trusted_point_blocked");
  const found = preview.result;
  const basis = {
    readings: found.readings,
    of: found.of,
    days: found.days,
    reps: found.reps,
    sources: found.sources,
    median_spread_meters: found.medianSpreadMeters,
    max_spread_meters: found.maxSpreadMeters,
    first_day: found.firstDay,
    last_day: found.lastDay,
    rule: { core_meters: TRUSTED_CORE_METERS, min_readings: TRUSTED_MIN_READINGS, min_days: TRUSTED_MIN_DAYS },
    gathered: preview.counts,
  };
  const result = await callPhoenixCrm<Row>("phoenix_crm_place_on_trusted_point", {
    p: {
      seat_id: preview.seatId,
      actor_hr_id: actor,
      is_test: preview.isTest,
      customer_id: preview.customerId,
      location: { lat: found.lat, lon: found.lon, accuracy_meters: found.maxSpreadMeters, ...locationColumns },
      basis,
    },
  });
  const config = await loadPhoenixCrmConfig();
  await restampVisitLocationsQuietly({
    seatId: preview.seatId,
    isTest: preview.isTest,
    customerId: preview.customerId,
    actorHrId: actor,
    settings: config.settings,
    scope: "unplaced",
  });
  return { placeId: String(result.place_id), customerId: String(result.customer_id), event: String(result.event ?? ""), preview };
}

/** The Super Admin's preview: gated before anything is read, then the customer's seat must be in his reach. */
export async function previewTrustedPoint(viewer: PhoenixCrmViewer, customerId: unknown): Promise<TrustedPointPreview> {
  assertTrustedPointDecider(viewer);
  const preview = await previewTrustedPointFor(String(customerId ?? ""));
  territoryForRead(viewer, preview.seatId, preview.isTest);
  return preview;
}

/** The Super Admin's apply: gated before anything is read or written. */
export async function placeOnTrustedPoint(viewer: PhoenixCrmViewer, customerId: unknown): Promise<TrustedPointApplied> {
  assertTrustedPointDecider(viewer);
  const id = String(customerId ?? "");
  if (!isUuid(id)) throw validationError("Choose the customer.");
  const customer = await loadCustomer(id.toLowerCase());
  territoryForRead(viewer, customer.seatId, customer.isTest);
  return applyTrustedPointFor(id, viewer.hrId);
}
