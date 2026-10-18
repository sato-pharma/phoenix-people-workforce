/**
 * The pharmacies reps NAME on their visits to a customer — read for Customer 360.
 *
 * A rep standing in a doctor's clinic types the pharmacy he took feedback from into the visit's
 * pharmacy box (rule 3c in `pharmacy-call-rules.ts`). The owner's ruling (2026-10-18): a pharmacy
 * named this way on a VALIDATED doctor's visit is that doctor's pharmacy — tied automatically when the
 * same name stands once in the brick the doctor is validated in, put to him on Customer 360's
 * "Pharmacy matches" tab when it does not.
 *
 * This file only READS what the rep wrote and where he stood; the matching is
 * `src/lib/customer-360/pharmacy-matcher.ts`. It sits here because Phoenix CRM's own tables are read
 * inside Phoenix CRM's module.
 *
 * 🔴 REAL VISITS ONLY (`is_test` false) and a doctor's or account's visit only: a Pharmacy-list visit
 * is the shop's own call, not a shop named on a doctor's visit.
 *
 * 🔴 THE BRICK IS THE VISIT'S PLACE BRICK — the clinic he was standing in, which is where the doctor
 * is validated. Never the shop's (nothing measured where the shop is).
 */

import { pharmacyNameKey, splitNamedPharmacies, isPharmacyListType } from "@/lib/phoenix-crm/pharmacy-call-rules";
import { chunk, IN_ID_CHUNK } from "@/lib/phoenix-crm/server/db";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/** One pharmacy name on one visit. A visit naming two shops is two of these. */
export type NamedPharmacyOnVisit = {
  visitId: string;
  customerId: string;
  visitDate: string;
  repHrId: string | null;
  lineCode: string | null;
  /** As the rep typed it — shown, never compared. */
  typed: string;
  /** `pharmacyNameKey(typed)` — compared, never shown. */
  nameKey: string;
  placeId: string | null;
  brickId: string | null;
  brickName: string | null;
  areaCode: string | null;
  areaName: string | null;
  regionName: string | null;
  address: string | null;
  lat: number | null;
  lon: number | null;
};

type VisitRow = {
  id: string;
  customer_id: string | null;
  visit_date: string | null;
  rep_hr_id: string | null;
  line_code: string | null;
  list_type: string | null;
  pharmacy_name: string | null;
  place_id: string | null;
};

type PlaceRow = {
  id: string;
  brick_id: string | null;
  brick_name: string | null;
  area_code: string | null;
  area_name: string | null;
  region_name: string | null;
  address: string | null;
  lat: number | null;
  lon: number | null;
  pin_lat: number | null;
  pin_lon: number | null;
};

const text = (value: unknown): string | null => {
  const out = typeof value === "string" ? value.trim() : "";
  return out.length > 0 ? out : null;
};

const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/**
 * Every pharmacy named on a real visit to one of `customerIds` (Phoenix CRM customer ids), with the
 * geography of the place the visit was made at. Paged on `id` — the 1,000-row cap returns no error.
 */
export async function readNamedPharmaciesOnVisits(customerIds: ReadonlySet<string>): Promise<NamedPharmacyOnVisit[]> {
  if (customerIds.size === 0) return [];
  const visits = await fetchAllRowsKeyset<VisitRow>(
    () =>
      getSupabaseAdmin()
        .from("phoenix_crm_visits")
        .select("id, customer_id, visit_date, rep_hr_id, line_code, list_type, pharmacy_name, place_id")
        .eq("is_test", false)
        .not("pharmacy_name", "is", null),
    { cursorColumn: "id", cursorOf: (row) => row.id },
  );
  const wanted = visits.filter(
    (row) => row.customer_id && customerIds.has(row.customer_id) && !isPharmacyListType(row.list_type) && text(row.pharmacy_name),
  );
  if (wanted.length === 0) return [];

  const placeIds = [...new Set(wanted.map((row) => row.place_id).filter((id): id is string => Boolean(id)))];
  const places = new Map<string, PlaceRow>();
  for (const part of chunk(placeIds, IN_ID_CHUNK)) {
    const { data, error } = await getSupabaseAdmin()
      .from("phoenix_crm_places")
      .select("id, brick_id, brick_name, area_code, area_name, region_name, address, lat, lon, pin_lat, pin_lon")
      .in("id", part);
    if (error) throw new Error(`customer-360: reading phoenix_crm_places failed — ${error.message}`);
    for (const row of (data ?? []) as PlaceRow[]) places.set(row.id, row);
  }

  const out: NamedPharmacyOnVisit[] = [];
  for (const visit of wanted) {
    const place = visit.place_id ? places.get(visit.place_id) ?? null : null;
    for (const typed of splitNamedPharmacies(visit.pharmacy_name)) {
      const nameKey = pharmacyNameKey(typed);
      if (!nameKey) continue;
      out.push({
        address: text(place?.address),
        areaCode: text(place?.area_code),
        areaName: text(place?.area_name),
        brickId: text(place?.brick_id),
        brickName: text(place?.brick_name),
        customerId: String(visit.customer_id),
        lat: num(place?.pin_lat) ?? num(place?.lat),
        lineCode: text(visit.line_code),
        lon: num(place?.pin_lon) ?? num(place?.lon),
        nameKey,
        placeId: visit.place_id,
        regionName: text(place?.region_name),
        repHrId: text(visit.rep_hr_id),
        typed,
        visitDate: String(visit.visit_date ?? ""),
        visitId: visit.id,
      });
    }
  }
  return out;
}
