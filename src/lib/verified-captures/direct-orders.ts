import type { AccessContext } from "@/lib/auth/permissions";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import {
  listDirectOrderPharmacyValidations,
  type DirectOrderValidationStatus,
} from "@/lib/direct-orders/pharmacy-validation";

import { assertVerifiedCapturesAccess } from "./access";
import { loadDirectOrderDistributorCodes } from "./distributor-codes";
import { employeeName, employeeTitle, loadEmployeesWithManagers, resolveManager } from "./employee-lookup";
import { buildCaptureLocation } from "./location";
import type { VerifiedDirectOrderCaptureRow } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// The Direct Orders tab of the Verified Captures gallery.
//
// A direct-order pharmacy is verified when the desk decided it real — `approved_new` (genuinely new,
// given a code) or `matched_existing` (it existed under another spelling). SCOPE, owner's choice
// 2026-09-24: the FIELD lane (live photo + GPS) and the INVOICE lane (a distributor invoice, no
// photo/GPS), but NOT catalogue-directory pharmacies — those were never captured in the field, carry
// no photo and no location, and so have nothing to show on a captures gallery. Catalogue pharmacies
// have no validation row at all, so filtering to the two decided lanes excludes them for free.
//
// Reuses `listDirectOrderPharmacyValidations`, which already signs the photo, invoice and licence
// URLs and resolves the requester's name and the pin. All this loader adds is the district manager
// (the requester's manager) and the row shape the gallery renders.
// ─────────────────────────────────────────────────────────────────────────────

const VERIFIED_STATUSES: DirectOrderValidationStatus[] = ["approved_new", "matched_existing"];

export async function listVerifiedDirectOrderCaptures(
  access: AccessContext,
): Promise<VerifiedDirectOrderCaptureRow[]> {
  assertVerifiedCapturesAccess(access);

  // Super Admin (this page's only viewer) sees every lane. Ask with no status filter and keep the
  // two decided-real statuses ourselves, so a future third status cannot silently slip onto the tab.
  const validations = await listDirectOrderPharmacyValidations(access);
  const verified = validations.filter((row) => VERIFIED_STATUSES.includes(row.status));
  if (verified.length === 0) return [];

  const supabase = getSupabaseAdmin();
  const requesterHrIds = verified.map((row) => row.requestedByHrId);
  const decidedByHrIds = verified.map((row) => row.decidedByHrId);
  const validationIds = [...new Set(verified.map((row) => row.id).filter(Boolean))];
  const pharmacyIds = [...new Set(verified.map((row) => row.pharmacyId).filter(Boolean))];
  const [directory, distributorCodes, capturedByValidation, geographyByPharmacy] = await Promise.all([
    loadEmployeesWithManagers([...requesterHrIds, ...decidedByHrIds], supabase),
    loadDirectOrderDistributorCodes(
      verified.map((row) => row.pharmacyId),
      supabase,
    ),
    // The rich captured-address blob ("… Egypt · Brick X · Area Y · Region Z") is not on the shared
    // validation row, so read it here keyed by validation id.
    loadCapturedAddresses(validationIds, supabase),
    // The pharmacy's own free-text address and its resolved brick/area, for the fallback when a
    // capture carried no reverse-geocoded blob.
    loadPharmacyGeography(pharmacyIds, supabase),
  ]);

  return verified.map((row) => {
    const manager = resolveManager(directory, row.requestedByHrId);
    const geography = geographyByPharmacy.get(row.pharmacyId);
    return {
      id: row.id,
      pharmacyId: row.pharmacyId,
      pharmacyName: row.pharmacyName,
      pharmacyCode: row.phoenixPharmacyCode && row.phoenixPharmacyCode !== "—" ? row.phoenixPharmacyCode : null,
      route: row.validationRoute,
      repHrId: row.requestedByHrId || null,
      repName: row.requestedByName || null,
      repTitle: employeeTitle(directory, row.requestedByHrId),
      managerHrId: manager.hrId,
      managerName: manager.name,
      managerTitle: manager.title,
      verifiedAt: row.decidedAt,
      verifiedByName: employeeName(directory, row.decidedByHrId),
      verifiedByTitle: employeeTitle(directory, row.decidedByHrId),
      photoUrl: row.photoUrl,
      invoiceUrl: row.invoiceUrl,
      invoiceIsPdf: row.invoiceContentType === "application/pdf",
      licenseUrl: row.licenseUrl,
      location: buildCaptureLocation({
        latitude: row.capturedLatitude,
        longitude: row.capturedLongitude,
        capturedAddress: capturedByValidation.get(row.id) ?? null,
        rawFallback: geography?.pharmacyAddress ?? row.claimedAddress ?? null,
        brick: geography?.brick ?? null,
        area: geography?.area ?? null,
      }),
      distributorCodes: distributorCodes.get(row.pharmacyId) ?? [],
    } satisfies VerifiedDirectOrderCaptureRow;
  });
}

const CHUNK = 200;

/** captured_address per validation id — the rich reverse-geocoded blob the field app stored. */
async function loadCapturedAddresses(
  validationIds: readonly string[],
  supabase: ReturnType<typeof getSupabaseAdmin>,
): Promise<Map<string, string>> {
  const byId = new Map<string, string>();
  for (let index = 0; index < validationIds.length; index += CHUNK) {
    const { data, error } = await supabase
      .from("direct_order_pharmacy_validations")
      .select("id, captured_address")
      .in("id", validationIds.slice(index, index + CHUNK));
    if (error) throw error;
    for (const row of (data ?? []) as Array<{ id: string; captured_address: string | null }>) {
      if (row.captured_address) byId.set(String(row.id), row.captured_address);
    }
  }
  return byId;
}

type PharmacyGeography = { pharmacyAddress: string | null; brick: string | null; area: string | null };

/**
 * A direct-order pharmacy's own address and its resolved brick/area NAMES, for the fallback when a
 * capture carried no reverse-geocoded blob to parse. Names never codes: `brick_id` resolves through
 * `source_of_sales_bricks` and `area_code` through `areas`.
 */
async function loadPharmacyGeography(
  pharmacyIds: readonly string[],
  supabase: ReturnType<typeof getSupabaseAdmin>,
): Promise<Map<string, PharmacyGeography>> {
  const byPharmacy = new Map<string, PharmacyGeography>();
  if (pharmacyIds.length === 0) return byPharmacy;

  type PharmacyRow = {
    id: string;
    pharmacy_address: string | null;
    brick_id: string | null;
    area_code: string | null;
  };
  const rows: PharmacyRow[] = [];
  for (let index = 0; index < pharmacyIds.length; index += CHUNK) {
    const { data, error } = await supabase
      .from("direct_order_pharmacies")
      .select("id, pharmacy_address, brick_id, area_code")
      .in("id", pharmacyIds.slice(index, index + CHUNK));
    if (error) throw error;
    rows.push(...((data ?? []) as PharmacyRow[]));
  }

  const brickIds = [...new Set(rows.map((row) => row.brick_id).filter((v): v is string => Boolean(v)))];
  const areaCodes = [...new Set(rows.map((row) => row.area_code).filter((v): v is string => Boolean(v)))];

  const [brickNames, areaNames] = await Promise.all([
    loadBrickNames(brickIds, supabase),
    loadAreaNames(areaCodes, supabase),
  ]);

  for (const row of rows) {
    byPharmacy.set(row.id, {
      pharmacyAddress: row.pharmacy_address,
      brick: row.brick_id ? brickNames.get(row.brick_id) ?? null : null,
      area: row.area_code ? areaNames.get(row.area_code) ?? null : null,
    });
  }
  return byPharmacy;
}

async function loadBrickNames(
  brickIds: readonly string[],
  supabase: ReturnType<typeof getSupabaseAdmin>,
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (let index = 0; index < brickIds.length; index += CHUNK) {
    const { data, error } = await supabase
      .from("source_of_sales_bricks")
      .select("brick_id, brick_name")
      .in("brick_id", brickIds.slice(index, index + CHUNK));
    if (error) throw error;
    for (const row of (data ?? []) as Array<{ brick_id: string | null; brick_name: string | null }>) {
      if (row.brick_id && row.brick_name && !names.has(row.brick_id)) names.set(row.brick_id, row.brick_name);
    }
  }
  return names;
}

async function loadAreaNames(
  areaCodes: readonly string[],
  supabase: ReturnType<typeof getSupabaseAdmin>,
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (let index = 0; index < areaCodes.length; index += CHUNK) {
    const { data, error } = await supabase
      .from("areas")
      .select("code, name")
      .in("code", areaCodes.slice(index, index + CHUNK));
    if (error) throw error;
    for (const row of (data ?? []) as Array<{ code: string | null; name: string | null }>) {
      if (row.code && row.name) names.set(row.code, row.name);
    }
  }
  return names;
}
