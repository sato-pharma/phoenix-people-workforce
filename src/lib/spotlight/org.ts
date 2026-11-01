// Spotlight — the org read.
//
// Kept apart from rank.ts for the reason `org-placement-data.ts` is kept apart from
// `org-placement.ts`: the ranking stays pure and testable without a database, and it stops being
// pure the moment a Supabase import lands in it.
//
// ONE READ, of the whole tree. `au_v_org_tree` carries every tier with its occupant, line, region
// and area, so the seat index, the climb to a district or a national seat, and the human names for
// every code all come out of the same 133 rows. Reading a rep-only slice is the mistake this file
// exists to avoid repeating.

import { isRegionalManagerHeldDistrict } from "@/lib/org/sales-only-seats";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { hrKey, type OrgPerson, type OrgSeat, type SpotlightOrg } from "./rank";

const text = (value: unknown): string | null => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : null;
};

export type SpotlightOrgIndex = SpotlightOrg & {
  lineNames: Map<string, string>;
  regionNames: Map<string, string>;
  areaNames: Map<string, string>;
};

/**
 * 🔴 THE 1000-ROW CAP IS ASSERTED, NEVER TRUSTED. An unbounded PostgREST select stops at exactly
 * 1,000 rows with no error and no marker — the array simply ends. On a truncated org read the
 * symptom would be a spotlight that silently omits whole districts, which looks like a filter
 * working rather than a read failing.
 */
async function selectAll(table: string, columns: string): Promise<Record<string, unknown>[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from(table).select(columns);
  if (error) throw new Error(`${table}: ${error.message}`);
  const rows = (data ?? []) as unknown as Record<string, unknown>[];
  if (rows.length >= 1000) {
    throw new Error(
      `${table} returned ${rows.length} rows — at or past PostgREST's unbounded cap, so the read may be`
      + " truncated. Paginate it before a spotlight is built on it.",
    );
  }
  return rows;
}

/**
 * The seat tree, the people in it, and the human name for every code the sheet might print.
 *
 * Deliberately NOT cached. A spotlight is exported a handful of times a month by two people, and a
 * stale seat here would put a leaver's name on a printed award — the one error on this page that
 * cannot be taken back once it is in a group chat. Two reads of ~130 and ~250 rows is not a cost
 * worth trading that for.
 */
export async function loadSpotlightOrg(): Promise<SpotlightOrgIndex> {
  const [seatRows, peopleRows] = await Promise.all([
    selectAll(
      "au_v_org_tree_sales",
      "seat_id, parent_seat_id, seat_tier, line_code, line_name, region_code, region_name, area_code, area_name, occupant_hr_id, is_vacant, seat_display_label",
    ),
    selectAll("employees", "hr_id, full_name, name_ar, job_title"),
  ]);

  const seats = new Map<string, OrgSeat>();
  const lineNames = new Map<string, string>();
  const regionNames = new Map<string, string>();
  const areaNames = new Map<string, string>();

  for (const row of seatRows) {
    const seatId = text(row.seat_id);
    const tier = text(row.seat_tier);
    if (!seatId || !tier) continue;

    const lineCode = text(row.line_code);
    const regionCode = text(row.region_code);
    const areaCode = text(row.area_code);
    const lineName = text(row.line_name);
    const regionName = text(row.region_name);
    const areaName = text(row.area_name);

    // Human names, never raw codes, is an owner rule for every surface. The tree already knows
    // them, so the sheet never has to print "GZ5" or "anti_infective" at a reader.
    if (lineCode && lineName) lineNames.set(lineCode, lineName);
    if (regionCode && regionName) regionNames.set(regionCode, regionName);
    if (areaCode && areaName) areaNames.set(areaCode, areaName);

    seats.set(seatId, {
      seatId,
      parentSeatId: text(row.parent_seat_id),
      tier,
      lineCode,
      lineName,
      regionCode,
      regionName,
      areaCode,
      areaName,
      occupantHrId: text(row.occupant_hr_id),
      isVacant: row.is_vacant === true,
      displayLabel: text(row.seat_display_label) ?? seatId,
    });
  }

  const people = new Map<string, OrgPerson>();
  for (const row of peopleRows) {
    const hrId = text(row.hr_id);
    const fullName = text(row.full_name);
    if (!hrId || !fullName) continue;
    // Keyed lower-case. HR ids are mixed case in this database and a case-sensitive lookup here
    // would print a vacant seat for a seated person.
    people.set(hrKey(hrId), {
      hrId,
      fullName,
      nameAr: text(row.name_ar),
      jobTitle: text(row.job_title),
    });
  }

  return { seats, people, lineNames, regionNames, areaNames };
}

/** Every filter value the picker can offer, derived from the same tree the ranking uses. */
export type SpotlightFacets = {
  lines: { code: string; name: string }[];
  regions: { code: string; name: string; lineCodes: string[] }[];
  areas: { code: string; name: string; regionCode: string | null; lineCodes: string[] }[];
  people: { hrId: string; name: string; roleLabel: string; territory: string; lineName: string | null }[];
};

const TIER_LABEL: Record<string, string> = {
  NSM: "National Sales Manager",
  RSM: "Regional Sales Manager",
  DM: "District Sales Manager",
  ACTING_DM: "Acting District Manager",
  REP: "Medical Representative",
  CEO: "Chief Executive Officer",
};

/**
 * Build the picker's options from the tree.
 *
 * A region is listed ONCE with the lines it appears on, rather than once per line. That is the
 * shape the owner's own example needs — "the Giza district managers for the three lines" is one
 * region and three lines, not three regions.
 */
export function facetsFrom(index: SpotlightOrgIndex): SpotlightFacets {
  const regions = new Map<string, { code: string; name: string; lineCodes: Set<string> }>();
  const areas = new Map<string, { code: string; name: string; regionCode: string | null; lineCodes: Set<string> }>();
  const people: SpotlightFacets["people"] = [];

  for (const seat of index.seats.values()) {
    if (seat.regionCode) {
      const entry = regions.get(seat.regionCode)
        ?? { code: seat.regionCode, name: seat.regionName ?? seat.regionCode, lineCodes: new Set<string>() };
      if (seat.lineCode) entry.lineCodes.add(seat.lineCode);
      regions.set(seat.regionCode, entry);
    }
    if (seat.areaCode) {
      const entry = areas.get(seat.areaCode)
        ?? { code: seat.areaCode, name: seat.areaName ?? seat.areaCode, regionCode: seat.regionCode, lineCodes: new Set<string>() };
      if (seat.lineCode) entry.lineCodes.add(seat.lineCode);
      areas.set(seat.areaCode, entry);
    }

    const person = seat.occupantHrId ? index.people.get(hrKey(seat.occupantHrId)) : null;
    // A district a Regional Manager holds himself is still a region to filter by, but he is already
    // listed from his regional seat, and rank.ts answers nothing for him as a district manager.
    if (person && seat.tier !== "CEO" && !isRegionalManagerHeldDistrict(seat.seatId)) {
      people.push({
        hrId: person.hrId,
        name: person.fullName,
        roleLabel: TIER_LABEL[seat.tier] ?? seat.tier,
        territory: seat.areaName ?? seat.regionName ?? "Egypt",
        lineName: seat.lineName,
      });
    }
  }

  const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name);

  return {
    lines: [...index.lineNames].map(([code, name]) => ({ code, name })).sort(byName),
    regions: [...regions.values()].map((r) => ({ ...r, lineCodes: [...r.lineCodes].sort() })).sort(byName),
    areas: [...areas.values()].map((a) => ({ ...a, lineCodes: [...a.lineCodes].sort() })).sort(byName),
    people: people.sort((a, b) => a.name.localeCompare(b.name)),
  };
}
