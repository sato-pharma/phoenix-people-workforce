// Pharmacy Master / Distributor Matching — read-only server data layer (Phase 1).
//
// SELECT-only: reads marketing_pharmacies + marketing_pharmacy_distributor_codes +
// marketing_distributors and hands the rows to the pure classifier in
// pharmacy-matching.ts. No insert/update/delete/upsert anywhere in this file, no new
// tables, no migration. Access is gated to Super Admin + CEO (assertPharmacyMasterAccess).

import type { AccessContext } from "@/lib/auth/permissions";
import {
  assertPharmacyMasterAccess,
  findPharmacyMatchCandidates,
  type PharmacyMatchCandidateGroup,
  type PharmacyMatchMember,
} from "@/lib/pharmacy-master/pharmacy-matching";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type PharmacyRow = {
  id: string;
  pharmacy_code: string;
  display_name: string;
  extracted_area_name: string | null;
  region_name: string | null;
  extracted_governorate_name: string | null;
  captured_address: string | null;
  captured_latitude: number | null;
  captured_longitude: number | null;
};

type LinkRow = {
  pharmacy_id: string;
  distributor_id: number;
  distributor_pharmacy_code: string;
};

type DistributorRow = {
  id: number;
  distributor_code: string;
  display_name: string;
};

export type PharmacyMasterCandidatesResult = {
  candidates: PharmacyMatchCandidateGroup[];
  distributors: Array<{ id: number; code: string; name: string }>;
  totalPharmacies: number;
  totalLinked: number;
  generatedAtIso: string;
};

/**
 * Every ACTIVE pharmacy ↔ distributor-code link, joined into the flat member shape the pure
 * classifier compares. Today this is a strict 1:1 (each pharmacy has exactly one active
 * distributor link) but the query makes no such assumption — a pharmacy with N links
 * contributes N members, so if the data ever grows multi-distributor per pharmacy this
 * continues to work unmodified.
 */
export async function getPharmacyMasterCandidates(access: AccessContext): Promise<PharmacyMasterCandidatesResult> {
  assertPharmacyMasterAccess(access);
  const supabase = getSupabaseAdmin();

  const [pharmaciesResult, linksResult, distributorsResult] = await Promise.all([
    supabase
      .from("marketing_pharmacies")
      .select("id, pharmacy_code, display_name, extracted_area_name, region_name, extracted_governorate_name, captured_address, captured_latitude, captured_longitude")
      .eq("active", true),
    supabase
      .from("marketing_pharmacy_distributor_codes")
      .select("pharmacy_id, distributor_id, distributor_pharmacy_code")
      .eq("active", true),
    supabase.from("marketing_distributors").select("id, distributor_code, display_name"),
  ]);
  if (pharmaciesResult.error) throw pharmaciesResult.error;
  if (linksResult.error) throw linksResult.error;
  if (distributorsResult.error) throw distributorsResult.error;

  const pharmacies = (pharmaciesResult.data ?? []) as PharmacyRow[];
  const links = (linksResult.data ?? []) as LinkRow[];
  const distributors = (distributorsResult.data ?? []) as DistributorRow[];

  const pharmacyById = new Map(pharmacies.map((row) => [row.id, row]));
  const distributorById = new Map(distributors.map((row) => [row.id, row]));

  const members: PharmacyMatchMember[] = [];
  for (const link of links) {
    const pharmacy = pharmacyById.get(link.pharmacy_id);
    const distributor = distributorById.get(link.distributor_id);
    if (!pharmacy || !distributor) continue; // orphaned link (soft-deleted parent) — skip, never guess
    members.push({
      address: pharmacy.captured_address,
      areaName: pharmacy.extracted_area_name,
      distributorCode: distributor.distributor_code,
      distributorId: distributor.id,
      distributorName: distributor.display_name,
      distributorPharmacyCode: link.distributor_pharmacy_code,
      governorateName: pharmacy.extracted_governorate_name,
      latitude: pharmacy.captured_latitude,
      longitude: pharmacy.captured_longitude,
      pharmacyCode: pharmacy.pharmacy_code,
      pharmacyId: pharmacy.id,
      displayName: pharmacy.display_name,
      regionName: pharmacy.region_name,
    });
  }

  return {
    candidates: findPharmacyMatchCandidates(members),
    distributors: distributors
      .map((row) => ({ code: row.distributor_code, id: row.id, name: row.display_name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    totalLinked: members.length,
    totalPharmacies: pharmacies.length,
    generatedAtIso: new Date().toISOString(),
  };
}
