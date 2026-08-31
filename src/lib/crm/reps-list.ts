/**
 * Reps List — a rep's whole CRM contact list, grouped by the brick each contact sits in.
 *
 * The owner's specification, 2026-08-31: filter Line -> Region -> Area, pick a medical rep, and see
 * "all his customers, his contact list, grouped by bricks" — his example being ten doctors under
 * one brick. This module is the domain service behind both entry points (the admin board and the
 * portal's team-scoped copy); neither page re-implements any of it.
 *
 * ## Three things this file is deliberately built around
 *
 * 1. THE CONTACT LIST, NOT VISITS. Rows come from `ireports360_contacts` — the list the CRM says a
 *    rep was GIVEN — via `contact-lists.ts`. Every other CRM board in Phoenix is built from visit or
 *    plan history and is therefore blind to a doctor who was assigned and never touched. That was
 *    the owner's own wording when he specified the board this one replaces ("Not visits."), and it
 *    is why the retired Doctor List existed at all.
 *
 * 2. THE BRICK IS RESOLVED IN TWO STEPS, PRECISE FIRST. A contact's own mapping
 *    (`ireports360_crm_customer_brick_resolutions`, keyed on the iReports360 contactID) always wins;
 *    only when there is none does the contact's CRM REGION supply one
 *    (`ireports360_crm_region_brick_resolutions`). That is the same precedence
 *    `src/lib/crm/customer-brick.ts` describes — a customer is the finest thing Phoenix can resolve,
 *    a region is a rough locality grouping many of them.
 *
 * 3. AN UNMAPPED CONTACT IS SHOWN, NAMED BY ITS CRM REGION — NEVER DROPPED, NEVER POOLED.
 *    Measured against production 2026-08-31: only 5,608 of 9,518 contacts (58.9%) resolve to a brick
 *    at all. The other 3,910 are NOT missing data — exactly ONE of them lacks a CRM region; the
 *    remaining 3,909 carry a perfectly good region name that has simply never been mapped to a
 *    brick, across 152 distinct region names (Qena 179 contacts, Mahalla 176, Ma-adi 173, Malawi
 *    170, Assiut 151, El Menia 149, Fayoum 140 — the top 20 are 53% of the whole gap).
 *
 *    So hiding them would shorten every rep's list by roughly 40% with nothing on screen saying why,
 *    and pooling them into one "Unmapped" bucket would throw away the region name that is the only
 *    thing an admin needs in order to FIX the mapping. Instead each unmapped contact groups under
 *    its own CRM region, flagged `mapped: false`, so the board reads as a punch-list of exactly
 *    which localities still need a brick. `countUnmappedRegions` is what the page states out loud.
 *
 * The grouping core is pure and fixture-testable; everything touching Supabase sits below it.
 */

import { getAgentContactList, type DoctorListRow } from "@/lib/crm/contact-lists";
import { isCrmSchemaMissingError } from "@/lib/crm/schema";
import {
  CRM_CUSTOMER_BRICK_RESOLUTIONS_TABLE,
  CRM_REGION_BRICK_RESOLUTIONS_TABLE,
} from "@/lib/crm/tables";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * PostgREST silently returns ZERO rows for an `.in()` carrying several hundred ids — no error, which
 * reads exactly like "this rep has no mapped contacts". The largest single list measured is 197
 * contacts, so this cap is never cosmetic. See the repo's PostgREST notes.
 */
const IN_CHUNK = 50;

/** PostgREST caps a page at 1000 rows. Both resolution tables are read whole, so both are paged. */
const PAGE_SIZE = 1000;

/** One brick heading on the board, with the contacts that sit under it. */
export type RepsListGroup = {
  /** Sales area code the brick belongs to (e.g. `GZ3`). Null for an unmapped group. */
  areaCode: string | null;
  /**
   * The area's own name, which is what the page shows. The code is carried only so a group can be
   * matched back to the cascade; the owner's standing rule is that a screen never displays a raw
   * code, so a brick whose area has no name row falls back to showing no area at all rather than
   * printing `GZ3` at the reader.
   */
  areaName: string | null;
  /** Brick id (e.g. `B198-5`). Null for an unmapped group. Never rendered — the name is. */
  brickId: string | null;
  contacts: DoctorListRow[];
  /**
   * What the group heading says. A real brick's own name when mapped (these are Arabic locality
   * names in production — بشتيل, الكيت كات); otherwise the CRM region name, which the caller marks
   * as unmapped rather than dressing up as a brick.
   */
  heading: string;
  /** False when this group is a CRM region with no brick mapping behind it. */
  mapped: boolean;
};

export type RepsListCounts = {
  am: number;
  pharmacy: number;
  pm: number;
  total: number;
};

export type RepsListForRep = {
  counts: RepsListCounts;
  groups: RepsListGroup[];
  /** Distinct CRM regions on this rep's list that have no brick mapping. Stated on screen. */
  unmappedRegionCount: number;
  /** Contacts on this rep's list sitting in an unmapped region. Stated on screen. */
  unmappedContactCount: number;
};

/** contactCrmId -> brickId, and brickId -> its display metadata. */
export type BrickIndex = {
  brickByContactId: Map<number, string>;
  brickByRegionName: Map<string, string>;
  metaByBrickId: Map<string, { areaCode: string | null; areaName: string | null; name: string }>;
};

const normalizeRegionKey = (value: string | null | undefined): string => (value ?? "").trim().toLowerCase();

/**
 * PURE CORE — group one rep's contacts by brick. No IO, so the fixtures in the test file are the
 * whole contract.
 *
 * Ordering is by size descending then heading, so the brick a rep actually works sits at the top;
 * every unmapped group is pushed BELOW every mapped one regardless of size, because a heading that
 * is really a "still needs mapping" note must never outrank a real brick on the page.
 */
export function groupContactsByBrick(rows: readonly DoctorListRow[], index: BrickIndex): RepsListForRep {
  const groups = new Map<string, RepsListGroup>();
  const counts: RepsListCounts = { am: 0, pharmacy: 0, pm: 0, total: 0 };

  for (const row of rows) {
    counts.total += 1;
    if (row.listType === "PM") counts.pm += 1;
    else if (row.listType === "AM") counts.am += 1;
    else counts.pharmacy += 1;

    // Precise first: the contact's own mapping, then its region's. See the header.
    const brickId =
      index.brickByContactId.get(row.contactCrmId) ??
      index.brickByRegionName.get(normalizeRegionKey(row.region)) ??
      null;
    const meta = brickId ? index.metaByBrickId.get(brickId) : undefined;

    // A brick id with no row in `source_of_sales_bricks` is a stale mapping, not a brick. It is
    // treated as unmapped rather than rendered as a bare code, which the owner's naming rule forbids.
    const isMapped = Boolean(brickId && meta);
    const key = isMapped ? `brick:${brickId}` : `region:${normalizeRegionKey(row.region) || "(none)"}`;

    let group = groups.get(key);
    if (!group) {
      group = {
        areaCode: isMapped ? (meta?.areaCode ?? null) : null,
        areaName: isMapped ? (meta?.areaName ?? null) : null,
        brickId: isMapped ? brickId : null,
        contacts: [],
        heading: isMapped
          ? (meta?.name ?? "").trim() || "Unnamed brick"
          : (row.region ?? "").trim() || "No CRM region recorded",
        mapped: isMapped,
      };
      groups.set(key, group);
    }
    group.contacts.push(row);
  }

  const ordered = [...groups.values()].sort((left, right) => {
    if (left.mapped !== right.mapped) return left.mapped ? -1 : 1;
    if (left.contacts.length !== right.contacts.length) return right.contacts.length - left.contacts.length;
    return left.heading.localeCompare(right.heading);
  });

  for (const group of ordered) {
    group.contacts.sort((left, right) => left.name.localeCompare(right.name));
  }

  const unmapped = ordered.filter((group) => !group.mapped);
  return {
    counts,
    groups: ordered,
    unmappedContactCount: unmapped.reduce((total, group) => total + group.contacts.length, 0),
    unmappedRegionCount: unmapped.length,
  };
}

/** Every mapped CRM region -> brick. Small (105 mapped rows in production) but paged anyway. */
async function loadRegionBrickMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const supabase = getSupabaseAdmin();
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from(CRM_REGION_BRICK_RESOLUTIONS_TABLE)
      .select("crm_region_name, brick_id, status")
      .eq("status", "mapped")
      .not("brick_id", "is", null)
      .order("crm_region_name", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) {
      // Before the mapping migration ships this table is absent; an empty map is the correct answer
      // and every contact then groups under its CRM region, which is a readable board.
      if (isCrmSchemaMissingError(error)) return map;
      throw new Error(`Could not read region brick mappings: ${error.message}`);
    }
    const rows = (data ?? []) as Array<{ brick_id: string | null; crm_region_name: string | null }>;
    for (const row of rows) {
      const key = normalizeRegionKey(row.crm_region_name);
      if (key && row.brick_id && !map.has(key)) map.set(key, row.brick_id);
    }
    if (rows.length < PAGE_SIZE) return map;
  }
}

/** The contact-level mappings for exactly these contacts, chunked so PostgREST cannot silently zero. */
async function loadContactBrickMap(contactIds: readonly number[]): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  if (contactIds.length === 0) return map;
  const supabase = getSupabaseAdmin();
  for (let from = 0; from < contactIds.length; from += IN_CHUNK) {
    const chunk = contactIds.slice(from, from + IN_CHUNK);
    const { data, error } = await supabase
      .from(CRM_CUSTOMER_BRICK_RESOLUTIONS_TABLE)
      .select("crm_contact_id, brick_id, status")
      .in("crm_contact_id", chunk)
      .eq("status", "mapped")
      .not("brick_id", "is", null);
    if (error) {
      if (isCrmSchemaMissingError(error)) return map;
      throw new Error(`Could not read customer brick mappings: ${error.message}`);
    }
    for (const row of (data ?? []) as Array<{ brick_id: string | null; crm_contact_id: number }>) {
      if (row.brick_id) map.set(row.crm_contact_id, row.brick_id);
    }
  }
  return map;
}

/** Area code -> area name, for exactly the areas the bricks in play sit in. */
async function loadAreaNames(areaCodes: readonly string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (areaCodes.length === 0) return names;
  const supabase = getSupabaseAdmin();
  for (let from = 0; from < areaCodes.length; from += IN_CHUNK) {
    const chunk = areaCodes.slice(from, from + IN_CHUNK);
    const { data, error } = await supabase
      .from("source_of_sales_areas")
      .select("area_code, area_name")
      .in("area_code", chunk);
    if (error) throw new Error(`Could not read area names: ${error.message}`);
    for (const row of (data ?? []) as Array<{ area_code: string | null; area_name: string | null }>) {
      const name = (row.area_name ?? "").trim();
      if (row.area_code && name && !names.has(row.area_code)) names.set(row.area_code, name);
    }
  }
  return names;
}

/** Brick display metadata for the ids actually in play. Names are what the page renders. */
async function loadBrickMeta(
  brickIds: readonly string[],
): Promise<Map<string, { areaCode: string | null; areaName: string | null; name: string }>> {
  const meta = new Map<string, { areaCode: string | null; areaName: string | null; name: string }>();
  if (brickIds.length === 0) return meta;
  const supabase = getSupabaseAdmin();
  for (let from = 0; from < brickIds.length; from += IN_CHUNK) {
    const chunk = brickIds.slice(from, from + IN_CHUNK);
    const { data, error } = await supabase
      .from("source_of_sales_bricks")
      .select("brick_id, brick_name, area_code, active")
      .in("brick_id", chunk);
    if (error) throw new Error(`Could not read brick names: ${error.message}`);
    for (const row of (data ?? []) as Array<{
      active: boolean | null;
      area_code: string | null;
      brick_id: string | null;
      brick_name: string | null;
    }>) {
      // A retired brick still names itself; dropping it here would turn a historically-correct
      // mapping into an "unmapped" group and hide the fact that the brick simply moved.
      if (!row.brick_id || meta.has(row.brick_id)) continue;
      if (row.active === false) continue;
      meta.set(row.brick_id, { areaCode: row.area_code, areaName: null, name: (row.brick_name ?? "").trim() });
    }
  }

  const areaNames = await loadAreaNames([
    ...new Set([...meta.values()].map((entry) => entry.areaCode).filter((code): code is string => Boolean(code))),
  ]);
  for (const entry of meta.values()) {
    entry.areaName = entry.areaCode ? (areaNames.get(entry.areaCode) ?? null) : null;
  }
  return meta;
}

/**
 * One rep's contact list, grouped by brick.
 *
 * The three reads are sequenced rather than parallel because each narrows the next: the contacts
 * decide which contact-mappings to ask for, and both mapping sources together decide which brick
 * names are worth fetching. On the largest measured list (197 contacts) that is four round trips.
 */
export async function getRepsListForAgent(agentCrmId: number): Promise<RepsListForRep> {
  const rows = await getAgentContactList(agentCrmId);
  if (rows.length === 0) {
    return { counts: { am: 0, pharmacy: 0, pm: 0, total: 0 }, groups: [], unmappedContactCount: 0, unmappedRegionCount: 0 };
  }

  const [brickByContactId, brickByRegionName] = await Promise.all([
    loadContactBrickMap(rows.map((row) => row.contactCrmId)),
    loadRegionBrickMap(),
  ]);

  const needed = new Set<string>();
  for (const row of rows) {
    const brickId = brickByContactId.get(row.contactCrmId) ?? brickByRegionName.get(normalizeRegionKey(row.region));
    if (brickId) needed.add(brickId);
  }
  const metaByBrickId = await loadBrickMeta([...needed]);

  return groupContactsByBrick(rows, { brickByContactId, brickByRegionName, metaByBrickId });
}
