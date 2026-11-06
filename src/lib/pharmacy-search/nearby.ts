/**
 * "What else is around this pharmacy" — the doctors and hospitals half of the profile.
 *
 * Two things about this data are worth knowing before reading the code, because both shaped it:
 *
 * 1. **There is no doctor→brick map.** Both CRM brick-resolution tables are effectively empty
 *    (1 row across 14,452 contacts, checked 2026-08-21), so "doctors in this brick" cannot be
 *    answered. What CAN be answered is "doctors whose rep checked in near here" — 105,413
 *    check-ins carry GPS across 15,125 distinct contacts. Proximity, not territory.
 *
 * 2. **Check-ins are a partial feed.** Reps who never check in are invisible here. An empty
 *    result means "no check-ins nearby", NEVER "no doctors nearby", and the UI must say so.
 *
 * Both CRM reads go through `src/lib/crm/reads.ts` — the single door every consumer of the
 * iReports360 mirror uses, so the CRM module stays the only code that touches the feed.
 */

import { classifyCrmContactSpeciality, isHospitalSpeciality } from "@/lib/crm/contact-taxonomy";
import { queryCheckins, queryVisits } from "@/lib/crm/reads";
import type { SourceMaskViewer } from "@/lib/sales/closing-source-mask";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin, toQueryError } from "@/lib/supabase/server";

import { boundingBox, haversineKm, isUsablePoint, roundKm, type Point } from "./geo";
import { visibleDistributorRows } from "./source-visibility";
import type { NearbyDoctor, NearbyHospital } from "./types";

export const DEFAULT_RADIUS_KM = 2;
/** Doctors returned per lookup. Beyond this the list stops being readable. */
const MAX_DOCTORS = 25;
/** Hospitals returned per lookup. There are rarely many, and a long list is not the point. */
const MAX_HOSPITALS = 12;
/**
 * Contacts classified before the split. Higher than either cap on purpose: taking the nearest 25
 * and THEN splitting would let a cluster of hospitals crowd every doctor out of the answer, or the
 * reverse. Classify a wider ring, then fill each list from it.
 */
const MAX_CONTACTS_CLASSIFIED = 80;
/** Check-in rows pulled inside the box before aggregation. A 2 km box in Cairo stays well under. */
const CHECKIN_SCAN_LIMIT = 4000;

const HOSPITAL_PATTERNS = ["مستشف", "hospital", "معهد", "مبره", "مبرة"];

function looksLikeHospital(name: string | null | undefined): boolean {
  if (!name) return false;
  const lowered = name.toLowerCase();
  return HOSPITAL_PATTERNS.some((pattern) => lowered.includes(pattern));
}

type ContactKind = "doctor" | "hospital" | "other";

/**
 * What is this contact — a doctor, a hospital, or neither?
 *
 * The CRM's `speciality` field is not only specialities: `src/lib/crm/contact-taxonomy.ts` is the
 * module that established that and holds the owner's rule for it ("all specialities SP, pharmacy
 * and hospitals contract and insurance HCP", 2026-08-08). It is the authority here and this
 * function only composes it — the six hospital values are a strict subset of its own HCP list, so
 * the two cannot drift apart.
 *
 * Why it matters for this page: 19.7% of the 14,451 CRM contacts are HCP, not doctors (measured
 * 2026-08-21). Before the split, "مستشفي المطريه التعليمي" was returned as a DOCTOR 0.49 km away,
 * while the hospitals section could only offer coordinate-less brick matches — 1,026 hospital
 * contacts carry GPS check-ins against 285 hospital rows in the customer map, only 38 geocoded.
 *
 * `unclassified` — a blank speciality, or a value the vendor invented since the taxonomy was
 * written — stays in the DOCTORS list, which is what Doctor Coverage already does with it ("an
 * unknown speciality is still scored — dropping it would move the number silently"). It is only
 * 19 of 14,451 contacts, and each one still shows its raw speciality, so nothing is being passed
 * off as something it is not.
 */
function classifyContact(speciality: string | null): ContactKind {
  if (isHospitalSpeciality(speciality)) return "hospital";
  // Everything else the taxonomy calls HCP is a pharmacy, a contract or an insurer. Dropped rather
  // than relabelled: this section answers "which doctors and hospitals", not "which accounts".
  if (classifyCrmContactSpeciality(speciality) === "hcp") return "other";
  return "doctor";
}

type CheckinRow = {
  address: string | null;
  contact_crm_id: number | null;
  contact_name: string | null;
  lat: number | null;
  lon: number | null;
};

/**
 * Everyone the CRM has been checked into within `radiusKm` of a point, split by what they are.
 *
 * One scan answers both halves of the owner's question ("doctors near it with their speciality,
 * and hospitals") because both come from the same 105k GPS check-ins — the split is by
 * `speciality`, not by a second query.
 *
 * The bounding box is the whole reason this is affordable: filtering 105k rows down to a few
 * dozen in Postgres, then doing exact distance in Node. Without PostGIS there is no index-backed
 * radius query available.
 */
export async function findNearbyContacts(
  centre: Point,
  radiusKm: number = DEFAULT_RADIUS_KM,
): Promise<{ doctors: NearbyDoctor[]; hospitals: NearbyHospital[] }> {
  const rows = await queryCheckins<CheckinRow>({
    // Newest first, so that if a dense box ever exceeds the scan limit what survives is current
    // practice rather than the oldest history the mirror happens to hold.
    ascending: false,
    bounds: boundingBox(centre, radiusKm),
    columns: "contact_crm_id, contact_name, lat, lon, address",
    // The DOCTOR is the subject of this read; the rep who recorded the point is never shown and
    // never scored. Leaving the resigned-agent exclusion on would take 1,100 of 15,125 contacts to
    // zero (measured on production 2026-08-21) purely because the rep who logged them has since
    // left — a doctor who no longer has a rep is exactly the doctor worth surfacing here.
    includeResignedAgents: true,
    limit: CHECKIN_SCAN_LIMIT,
    requireContactCrmId: true,
  });

  // Keep the NEAREST check-in per contact: a doctor visited at both a clinic and a hospital has
  // two points, and the closer one is the one that answers "is this doctor near the pharmacy".
  const nearest = new Map<number, { address: string | null; distanceKm: number; name: string }>();
  for (const row of rows) {
    if (!isUsablePoint(row.lat, row.lon)) continue;
    const contactId = row.contact_crm_id;
    const name = row.contact_name?.replace(/\s+/g, " ").trim();
    if (contactId == null || !name) continue;

    const distanceKm = haversineKm(centre, { latitude: row.lat as number, longitude: row.lon as number });
    if (distanceKm > radiusKm) continue;

    const existing = nearest.get(contactId);
    if (!existing || distanceKm < existing.distanceKm) {
      nearest.set(contactId, { address: row.address?.trim() || null, distanceKm, name });
    }
  }

  if (nearest.size === 0) return { doctors: [], hospitals: [] };

  const contactIds = [...nearest.entries()]
    .sort((a, b) => a[1].distanceKm - b[1].distanceKm)
    .slice(0, MAX_CONTACTS_CLASSIFIED)
    .map(([contactId]) => contactId);

  const visitRows = await queryVisits<{ contact_crm_id: number | null; speciality: string | null }>({
    columns: "contact_crm_id, speciality",
    contactCrmIds: contactIds,
    // Same reasoning as the check-in read above — a doctor's speciality does not stop being true
    // because the rep who recorded it has left.
    includeResignedAgents: true,
  });

  // A contact can carry more than one speciality string across visits; the most frequent one is
  // the honest summary, and the visit count doubles as a "how well do we know them" signal.
  const specialityTally = new Map<number, Map<string, number>>();
  const visitTally = new Map<number, number>();
  for (const row of visitRows) {
    const contactId = row.contact_crm_id;
    const speciality = String(row.speciality ?? "").trim();
    if (contactId == null || !speciality) continue;
    visitTally.set(contactId, (visitTally.get(contactId) ?? 0) + 1);
    const tally = specialityTally.get(contactId) ?? new Map<string, number>();
    tally.set(speciality, (tally.get(speciality) ?? 0) + 1);
    specialityTally.set(contactId, tally);
  }

  const doctors: NearbyDoctor[] = [];
  const hospitals: NearbyHospital[] = [];

  for (const contactId of contactIds) {
    const entry = nearest.get(contactId)!;
    const tally = specialityTally.get(contactId);
    const speciality = tally
      ? [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
      : null;

    const kind = classifyContact(speciality);
    if (kind === "other") continue;

    if (kind === "hospital") {
      hospitals.push({
        address: entry.address,
        distanceKm: roundKm(entry.distanceKm),
        name: entry.name,
        origin: "database",
        proximity: "checkin",
        speciality,
      });
      continue;
    }

    doctors.push({
      distanceKm: roundKm(entry.distanceKm),
      lastSeenAddress: entry.address,
      name: entry.name,
      speciality,
      visits: visitTally.get(contactId) ?? 0,
    });
  }

  // Two crm ids can carry the same person's name; showing them twice reads as two doctors.
  const byName = new Map<string, NearbyDoctor>();
  for (const doctor of doctors) {
    const key = `${doctor.name}|${doctor.speciality ?? ""}`;
    const existing = byName.get(key);
    if (!existing || doctor.distanceKm < existing.distanceKm) {
      byName.set(key, existing ? { ...doctor, visits: doctor.visits + existing.visits } : doctor);
    } else {
      byName.set(key, { ...existing, visits: existing.visits + doctor.visits });
    }
  }

  const byHospitalName = new Map<string, NearbyHospital>();
  for (const hospital of hospitals) {
    const existing = byHospitalName.get(hospital.name);
    if (!existing || (hospital.distanceKm ?? Infinity) < (existing.distanceKm ?? Infinity)) {
      byHospitalName.set(hospital.name, hospital);
    }
  }

  return {
    doctors: [...byName.values()].sort((a, b) => a.distanceKm - b.distanceKm).slice(0, MAX_DOCTORS),
    hospitals: [...byHospitalName.values()]
      .sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity))
      .slice(0, MAX_HOSPITALS),
  };
}

/**
 * Hospitals from the two NON-CRM sources — the ones a check-in cannot reach.
 *
 * Neither is complete on its own: hospital CUSTOMERS sitting in the same brick (285 across the
 * customer map, no coordinates at all), and hospital addresses already geocoded into
 * `geo_locations` (38, with coordinates). The CRM contribution is much larger and comes from
 * {@link findNearbyContacts}; {@link mergeHospitals} joins them. Google fills the remainder in
 * `external.ts`, and only when the reader asks for it.
 */
export async function findKnownHospitals(
  options: { brickId: string | null; centre: Point | null; radiusKm?: number; viewer: SourceMaskViewer },
): Promise<NearbyHospital[]> {
  const supabase = getSupabaseAdmin();
  const radiusKm = options.radiusKm ?? DEFAULT_RADIUS_KM;
  const found = new Map<string, NearbyHospital>();

  if (options.centre) {
    const box = boundingBox(options.centre, radiusKm);
    // Every geocoded address in the box, paged: the box holds every pharmacy in it, not only the
    // hospitals, so in dense Cairo a fixed `.limit(500)` cut the list BEFORE the hospital filter ran.
    let data: Array<Record<string, unknown>>;
    try {
      data = await fetchAllRows<Record<string, unknown>>(
        () =>
          supabase
            .from("geo_locations")
            .select("label, address_text, latitude, longitude")
            .eq("source_type", "pharmacy_address")
            .gte("latitude", box.minLatitude)
            .lte("latitude", box.maxLatitude)
            .gte("longitude", box.minLongitude)
            .lte("longitude", box.maxLongitude),
        "id",
      );
    } catch (error) {
      throw new Error(`Nearby hospital lookup failed: ${toQueryError(error).message}`);
    }

    for (const row of data) {
      const label = String(row.label ?? "").trim();
      if (!looksLikeHospital(label)) continue;
      if (!isUsablePoint(row.latitude as number, row.longitude as number)) continue;
      const distanceKm = haversineKm(options.centre, {
        latitude: row.latitude as number,
        longitude: row.longitude as number,
      });
      if (distanceKm > radiusKm) continue;
      found.set(label, {
        address: (row.address_text as string | null)?.trim() || null,
        distanceKm: roundKm(distanceKm),
        name: label,
        origin: "database",
        proximity: "geocoded",
        speciality: null,
      });
    }
  }

  const brickId = options.brickId;
  if (brickId) {
    // The whole brick, paged: a busy brick holds 2,006 customers on production, and a fixed
    // 1,000-row limit cut the list before the hospital filter ran, so hospitals past the cut vanished.
    let data: Array<Record<string, unknown>>;
    try {
      data = await fetchAllRows<Record<string, unknown>>(
        () =>
          visibleDistributorRows(
            supabase.from("source_of_sales_customer_map").select("customer_name, address, brick_id").eq("brick_id", brickId),
            options.viewer,
          ),
        "id",
      );
    } catch (error) {
      throw new Error(`Brick hospital lookup failed: ${toQueryError(error).message}`);
    }

    for (const row of data) {
      const name = String(row.customer_name ?? "").trim();
      if (!looksLikeHospital(name) || found.has(name)) continue;
      // No coordinates on the customer map — same brick is the only proximity claim we can make,
      // so distanceKm stays null rather than being invented.
      found.set(name, {
        address: String(row.address ?? "").trim() || null,
        distanceKm: null,
        name,
        origin: "database",
        proximity: "same_brick",
        speciality: null,
      });
    }
  }

  return [...found.values()].sort((a, b) => {
    if (a.distanceKm == null && b.distanceKm == null) return a.name.localeCompare(b.name, "ar");
    if (a.distanceKm == null) return 1;
    if (b.distanceKm == null) return -1;
    return a.distanceKm - b.distanceKm;
  });
}

/**
 * Join hospital lists from every source into one, nearest first.
 *
 * The same hospital reaches us more than once — as a CRM contact with a measured check-in
 * distance, as a customer row in the brick with no coordinates, and sometimes from Google. The
 * entry that survives is the one with a REAL distance, because "0.49 km away" and "somewhere in
 * this brick" are not the same answer and the better one must not lose to arrival order.
 */
export function mergeHospitals(...lists: NearbyHospital[][]): NearbyHospital[] {
  const byName = new Map<string, NearbyHospital>();
  for (const hospital of lists.flat()) {
    const key = hospital.name.replace(/\s+/g, " ").trim();
    if (!key) continue;
    const existing = byName.get(key);
    if (!existing) {
      byName.set(key, hospital);
      continue;
    }
    const incomingRank = existing.distanceKm == null && hospital.distanceKm != null;
    const closer =
      existing.distanceKm != null && hospital.distanceKm != null && hospital.distanceKm < existing.distanceKm;
    if (incomingRank || closer) byName.set(key, hospital);
  }

  return [...byName.values()].sort((a, b) => {
    if (a.distanceKm == null && b.distanceKm == null) return a.name.localeCompare(b.name, "ar");
    if (a.distanceKm == null) return 1;
    if (b.distanceKm == null) return -1;
    return a.distanceKm - b.distanceKm;
  });
}

export const __testables = { classifyContact, looksLikeHospital };
