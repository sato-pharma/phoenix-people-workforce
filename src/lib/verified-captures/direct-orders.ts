import type { AccessContext } from "@/lib/auth/permissions";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import {
  listDirectOrderPharmacyValidations,
  type DirectOrderValidationStatus,
} from "@/lib/direct-orders/pharmacy-validation";

import { assertVerifiedCapturesAccess } from "./access";
import { loadDirectOrderDistributorCodes } from "./distributor-codes";
import { employeeName, employeeTitle, loadEmployeesWithManagers, resolveManager } from "./employee-lookup";
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
  const [directory, distributorCodes] = await Promise.all([
    loadEmployeesWithManagers([...requesterHrIds, ...decidedByHrIds], supabase),
    loadDirectOrderDistributorCodes(
      verified.map((row) => row.pharmacyId),
      supabase,
    ),
  ]);

  return verified.map((row) => {
    const manager = resolveManager(directory, row.requestedByHrId);
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
      location: {
        latitude: row.capturedLatitude,
        longitude: row.capturedLongitude,
        address: row.claimedAddress,
      },
      distributorCodes: distributorCodes.get(row.pharmacyId) ?? [],
    } satisfies VerifiedDirectOrderCaptureRow;
  });
}
