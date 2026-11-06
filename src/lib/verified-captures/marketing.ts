import type { AccessContext } from "@/lib/auth/permissions";
import { assessCaptureTrust } from "@/lib/evidence/capture-trust";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { loadMarketingEvidencePhotosByEntityIds } from "@/lib/marketing-requests/evidence-photo-storage";

import { assertVerifiedCapturesAccess } from "./access";
import { loadMarketingDistributorCodes } from "./distributor-codes";
import { employeeName, employeeTitle, loadEmployeeRecords } from "./employee-lookup";
import { buildCaptureLocation } from "./location";
import type { VerifiedMarketingCaptureRow, VerifiedMarketingCapturePharmacy } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// The Marketing tab of the Verified Captures gallery.
//
// "Verified" here is decided the same way PR #4336 decides it for the Validated tab: from the LIVE
// evidence, never the stored `validation_status` stamp (owner, 2026-09-24). A marketing customer is
// verified when his own capture is `complete` — a GPS fix plus a timestamped live photo that reached
// the bucket — AND every pharmacy actively linked to him is `complete` too, with at least one such
// pharmacy. That is exactly `customerIsEvidenceValidated`; this loader is its list form, resolving
// the photos, the location and the people so the gallery can render without a second call per row.
//
// Company-wide on purpose, gated to Super Admin at the top — the same posture as the Validated
// Customer register, and the reason the gate is the app's narrowest (see access.ts).
// ─────────────────────────────────────────────────────────────────────────────

const COMPLETE = "complete";

type CustomerRow = {
  id: string;
  customer_code: string | null;
  display_name: string | null;
  evidence_status: string | null;
  owner_hr_id: string | null;
  manager_hr_id: string | null;
  area_id: number | null;
  line_id: number | null;
  region_name: string | null;
  extracted_governorate_name: string | null;
  captured_latitude: number | string | null;
  captured_longitude: number | string | null;
  captured_address: string | null;
  captured_at: string | null;
};

type PharmacyRow = {
  id: string;
  display_name: string | null;
  evidence_status: string | null;
  captured_latitude: number | string | null;
  captured_longitude: number | string | null;
  captured_address: string | null;
  /** When the PIN was taken. Needed to date the shutter gap on a shop, as on its customer. */
  captured_at: string | null;
  extracted_area_name: string | null;
  extracted_governorate_name: string | null;
};

type LinkRow = { customer_id: string; pharmacy_id: string; active: boolean | null };

function toNumber(value: number | string | null): number | null {
  if (value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function listVerifiedMarketingCaptures(
  access: AccessContext,
): Promise<VerifiedMarketingCaptureRow[]> {
  assertVerifiedCapturesAccess(access);
  const supabase = getSupabaseAdmin();

  // Only customers whose OWN capture is complete can be verified — the customer half of the rule —
  // so filter here and let the pharmacy check below finish it. Company-wide, newest first.
  // Paged to the end: a fixed ceiling here would drop the oldest verified customers from the gallery
  // with no sign that the list was cut. `id` ends the order so the pages cannot overlap.
  const customers = await fetchAllRows<CustomerRow>(
    () =>
      supabase
        .from("marketing_customers")
        .select(
          "id, customer_code, display_name, evidence_status, owner_hr_id, manager_hr_id, area_id, line_id, region_name, extracted_governorate_name, captured_latitude, captured_longitude, captured_address, captured_at",
        )
        .eq("evidence_status", COMPLETE)
        .neq("active", false)
        .order("captured_at", { ascending: false }),
    "id",
  );
  if (customers.length === 0) return [];

  const customerIds = customers.map((row) => row.id);

  // The active links, so a customer is judged on the pharmacies he is actually tied to right now.
  const { data: linkData, error: linkError } = await supabase
    .from("marketing_customer_pharmacies")
    .select("customer_id, pharmacy_id, active")
    .in("customer_id", customerIds)
    .neq("active", false);
  if (linkError) throw linkError;

  const links = (linkData ?? []) as LinkRow[];
  const pharmacyIdsByCustomer = new Map<string, string[]>();
  for (const link of links) {
    const list = pharmacyIdsByCustomer.get(link.customer_id) ?? [];
    if (!list.includes(link.pharmacy_id)) list.push(link.pharmacy_id);
    pharmacyIdsByCustomer.set(link.customer_id, list);
  }

  const allPharmacyIds = [...new Set(links.map((link) => link.pharmacy_id))];
  const pharmacyById = new Map<string, PharmacyRow>();
  for (let index = 0; index < allPharmacyIds.length; index += 200) {
    const { data, error } = await supabase
      .from("marketing_pharmacies")
      .select(
        "id, display_name, evidence_status, captured_latitude, captured_longitude, captured_address, captured_at, extracted_area_name, extracted_governorate_name",
      )
      .in("id", allPharmacyIds.slice(index, index + 200));
    if (error) throw error;
    for (const row of (data ?? []) as PharmacyRow[]) pharmacyById.set(row.id, row);
  }

  // Keep only the customers that pass the WHOLE rule: at least one linked pharmacy, and every one of
  // them complete. `every` on an empty list is true, so the length guard is what enforces "captured
  // at least one venue" — matching `customerIsEvidenceValidated`, which returns false for zero links.
  const verified = customers.filter((customer) => {
    const pharmacyIds = pharmacyIdsByCustomer.get(customer.id) ?? [];
    if (pharmacyIds.length === 0) return false;
    return pharmacyIds.every((id) => pharmacyById.get(id)?.evidence_status === COMPLETE);
  });
  if (verified.length === 0) return [];

  // Resolve people, geography and photos for the verified set only.
  const hrIds = [
    ...new Set(
      verified.flatMap((row) => [row.owner_hr_id, row.manager_hr_id]).filter((v): v is string => Boolean(v)),
    ),
  ];
  const areaIds = [...new Set(verified.map((row) => row.area_id).filter((v): v is number => v !== null))];
  const lineIds = [...new Set(verified.map((row) => row.line_id).filter((v): v is number => v !== null))];
  const verifiedPharmacyIds = [
    ...new Set(verified.flatMap((row) => pharmacyIdsByCustomer.get(row.id) ?? [])),
  ];

  const [directory, areasResult, linesResult, customerPhotos, pharmacyPhotos, distributorCodes] =
    await Promise.all([
      loadEmployeeRecords(hrIds, supabase),
      areaIds.length
        ? supabase.from("areas").select("id, code, name").in("id", areaIds)
        : Promise.resolve({ data: [] as unknown[] }),
      lineIds.length
        ? supabase.from("lines").select("id, name").in("id", lineIds)
        : Promise.resolve({ data: [] as unknown[] }),
      loadMarketingEvidencePhotosByEntityIds({
        entityIds: verified.map((row) => row.id),
        entityType: "customer",
        supabase,
      }),
      loadMarketingEvidencePhotosByEntityIds({
        entityIds: verifiedPharmacyIds,
        entityType: "pharmacy",
        supabase,
      }),
      loadMarketingDistributorCodes(verifiedPharmacyIds, supabase),
    ]);

  const areaName = new Map(
    ((areasResult.data ?? []) as Array<{ id: number; code: string | null; name: string | null }>).map((row) => [
      Number(row.id),
      row.name ?? row.code ?? null,
    ]),
  );
  const lineName = new Map(
    ((linesResult.data ?? []) as Array<{ id: number; name: string | null }>).map((row) => [
      Number(row.id),
      row.name ?? null,
    ]),
  );

  return verified.map((customer) => {
    const pharmacyIds = pharmacyIdsByCustomer.get(customer.id) ?? [];
    const pharmacies: VerifiedMarketingCapturePharmacy[] = pharmacyIds
      .map((id) => pharmacyById.get(id))
      .filter((row): row is PharmacyRow => Boolean(row))
      .map((row) => ({
        id: row.id,
        displayName: row.display_name ?? "(pharmacy)",
        photoUrl: pharmacyPhotos.get(row.id)?.signedUrl ?? null,
        photoTrust: assessCaptureTrust({
          locationFix: {
            capturedAt: row.captured_at,
            latitude: toNumber(row.captured_latitude),
            longitude: toNumber(row.captured_longitude),
          },
          photoFix: pharmacyPhotos.get(row.id) ?? null,
        }),
        location: buildCaptureLocation({
          latitude: toNumber(row.captured_latitude),
          longitude: toNumber(row.captured_longitude),
          capturedAddress: row.captured_address,
          area: row.extracted_area_name,
          governorate: row.extracted_governorate_name,
        }),
        distributorCodes: distributorCodes.get(row.id) ?? [],
      }));

    return {
      id: customer.id,
      customerCode: customer.customer_code,
      displayName: customer.display_name ?? "(customer)",
      repHrId: customer.owner_hr_id,
      repName: employeeName(directory, customer.owner_hr_id),
      repTitle: employeeTitle(directory, customer.owner_hr_id),
      managerHrId: customer.manager_hr_id,
      managerName: employeeName(directory, customer.manager_hr_id),
      managerTitle: employeeTitle(directory, customer.manager_hr_id),
      areaName: customer.area_id !== null ? areaName.get(customer.area_id) ?? null : null,
      lineName: customer.line_id !== null ? lineName.get(customer.line_id) ?? null : null,
      governorate: customer.extracted_governorate_name ?? customer.region_name ?? null,
      capturedAt: customer.captured_at,
      photoUrl: customerPhotos.get(customer.id)?.signedUrl ?? null,
      // The photo against its own venue fix. `unmeasured` is the common answer and the honest one:
      // every capture taken before 2026-09-29 has no photo coordinates at all, and so does any
      // capture whose shutter could not read a position. It must never be rendered as agreement.
      photoTrust: assessCaptureTrust({
        locationFix: {
          capturedAt: customer.captured_at,
          latitude: toNumber(customer.captured_latitude),
          longitude: toNumber(customer.captured_longitude),
        },
        photoFix: customerPhotos.get(customer.id) ?? null,
      }),
      location: buildCaptureLocation({
        latitude: toNumber(customer.captured_latitude),
        longitude: toNumber(customer.captured_longitude),
        capturedAddress: customer.captured_address,
        // The customer's own SALES area is the most meaningful "area" for him; the governorate is
        // already clean on the row.
        area: customer.area_id !== null ? areaName.get(customer.area_id) ?? null : null,
        governorate: customer.extracted_governorate_name ?? customer.region_name ?? null,
      }),
      pharmacyCount: pharmacies.length,
      pharmacies,
    } satisfies VerifiedMarketingCaptureRow;
  });
}
