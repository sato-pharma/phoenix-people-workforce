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
 * 1. THE CONTACT LIST, NOT VISITS. Rows come from Phoenix's own list — the open periods of
 *    `crm_contact_assignments`, what a rep was GIVEN — via `contact-lists.ts`, found by the rep's HR
 *    id so a rep hired without a CRM account still has one. Every other CRM board in Phoenix is built from visit or
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

import { getOrLoadShared } from "@/lib/cache/shared-read";
import { getAgentContactList, getRepContactList, type DoctorListRow } from "@/lib/crm/contact-lists";
import {
  loadTradeCounterparties,
  matchContactTrade,
  type ContactTrade,
} from "@/lib/crm/contact-trade";
import {
  clusterRows,
  findNeighbours,
  findSharedCustomers,
  nameKey,
  phoneKey,
  scoreLocationConfidence,
  type CheckinPoint,
  type LocationConfidence,
  type NearbyContact,
  type RosterEntry,
  type SharedWith,
} from "@/lib/crm/location-confidence";
import { buildPhoenixInsights, type PhoenixInsight } from "@/lib/crm/phoenix-insights";
import { IREPORTS360_VISIT_SOURCE } from "@/lib/crm/phoenix-team-starts";
import { repDoctorListRepKey } from "@/lib/crm/rep-doctor-lists";
import type { RepsListActivity } from "@/lib/crm/reps-list-activity";
import { isMissingCrmRpcError } from "@/lib/crm/reads";
import { isCrmSchemaMissingError } from "@/lib/crm/schema";
import { CRM_CONTACT_ROSTER } from "@/lib/crm/shared-windows";
import { loadValidatedPlacePoints, type ValidatedPlacePoint } from "@/lib/crm/validated-place-points";
import {
  CRM_CHECKINS_UNIFIED_VIEW,
  CRM_CONTACT_ASSIGNMENTS_TABLE,
  CRM_CONTACT_MASTER_TABLE,
  CRM_CUSTOMER_BRICK_RESOLUTIONS_TABLE,
  CRM_REGION_BRICK_RESOLUTIONS_TABLE,
} from "@/lib/crm/tables";
import { mapWithConcurrency } from "@/lib/reconciliation/concurrency";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * PostgREST silently returns ZERO rows for an `.in()` carrying several hundred ids — no error, which
 * reads exactly like "this rep has no mapped contacts". The largest single list measured is 197
 * contacts, so this cap is never cosmetic. See the repo's PostgREST notes.
 */
const IN_CHUNK = 50;

/** PostgREST caps a page at 1000 rows. Both resolution tables are read whole, so both are paged. */
const PAGE_SIZE = 1000;

/**
 * Chunks read at once. Each chunk is its own round trip, and one rep's list is two to six of them, so
 * reading them one after another made the board as slow as all of them added up (2026-10-01, "slow
 * to transfer between page and page"). Four at a time answers a whole list in one or two trips.
 */
const CHUNK_CONCURRENCY = 4;

/**
 * `ids` cut into `.in()`-sized chunks, in order. Every chunked read below folds its answers IN THIS
 * ORDER once they are all in, so it returns exactly what its old one-chunk-at-a-time loop returned —
 * the same rows, the same first-seen pin, the same first error — however the reads interleave.
 */
function inChunks<T>(ids: readonly T[]): T[][] {
  return Array.from({ length: Math.ceil(ids.length / IN_CHUNK) }, (_unused, index) => ids.slice(index * IN_CHUNK, (index + 1) * IN_CHUNK));
}

/** One brick heading on the board, with the rows — contacts AND pharmacies — that sit under it. */
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
  rows: RepsListContact[];
  /**
   * What the group heading says. A real brick's own name when mapped (these are Arabic locality
   * names in production — بشتيل, الكيت كات); otherwise the CRM region name, which the caller marks
   * as unmapped rather than dressing up as a brick.
   */
  heading: string;
  /** False when this group is a CRM region with no brick mapping behind it. */
  mapped: boolean;
};

/**
 * Where a rep actually STOOD the last time they checked in on this contact.
 *
 * This is the address the board shows. It is an OBSERVATION, not a record: `ireports360_checkins`
 * carries the rep's own GPS fix and the address it resolves to, so it says where the doctor is
 * TODAY, while the contact's `address` field says where the CRM was told they were, whenever that
 * was last edited. The two disagree often enough that showing only the second is how a rep ends up
 * at a clinic that has moved.
 *
 * THE BOARD ONCE SHOWED BOTH, LABELLED "Current" AND "Old". The owner removed the old one on
 * 2026-09-01 — "remove the old, doesn't make any relevance" — so a row now carries ONE address.
 * The CRM's own is still read, but only as the fallback for a contact nobody has checked in on;
 * it is never shown beside an observed one.
 *
 * Coverage measured on production 2026-09-01: 7,933 of 9,518 contacts (83.3%) have at least one
 * check-in, and every one of those carries BOTH coordinates and an address — so this is a real
 * column, not a mostly-empty one. Of the remaining 1,585, some 1,468 have a CRM address and 117
 * have no address anywhere, which is the only case that renders as an absence.
 */
export type ContactSeenAt = {
  address: string | null;
  /** ISO timestamp of that check-in, so the page can say how fresh the observation is. */
  at: string | null;
  lat: number;
  lon: number;
};

/**
 * A contact row, the location a rep last observed for it, and the three judgements the board makes
 * about that location. All three are optional: they are annotations on a contact, and a list that
 * could not read check-ins is still a correct contact list.
 */
export type RepsListContact = DoctorListRow & {
  /**
   * What happened to this contact in the month the board is scoring — visited, behind plan, never
   * touched. ATTACHED BY THE BOARD, not by this module: the contact list is the CRM's own and knows
   * nothing about plans or visits, and that separation is what lets a complete list still render on
   * a day the plan mirror cannot be read.
   *
   * `undefined` means nobody asked for it. `null` means it was asked for and could not be
   * established — which is NOT "nothing happened". See `activityForContact`.
   */
  activity?: RepsListActivity | null;
  /** Which neighbourhood in its group this contact stands in, numbered from 0. Null when it stands alone. */
  cluster?: number | null;
  /** How well every check-in on this contact agrees with the pin being shown. Null when none exist. */
  confidence?: LocationConfidence | null;
  /** Anything odd about this record, one sentence each. Null or empty when there is nothing to say. */
  insights?: PhoenixInsight[] | null;
  /** Other contacts in the SAME group standing at effectively the same address. */
  nearby?: NearbyContact[] | null;
  /**
   * Where the doctor's VALIDATED live photo stands (owner, 2026-10-31: "use the validation pin"). It
   * outranks `seenAt` for where the row is — the pin its address opens and the neighbours it is
   * painted with — because a validation is a deliberate capture at the door and a check-in is wherever
   * the rep's phone was. Null when the doctor is not validated yet; the row then falls back to `seenAt`.
   */
  place?: ValidatedPlacePoint | null;
  seenAt?: ContactSeenAt | null;
  /** Other reps carrying what the evidence says is this same customer. */
  sharedWith?: SharedWith[] | null;
  /**
   * Business Phoenix has actually done with this row — direct orders for a pharmacy, marketing
   * requests for a doctor. Null on the overwhelming majority of rows, which is the honest answer:
   * see `contact-trade.ts` for why a name alone can never establish this and what the area adds.
   */
  trade?: ContactTrade | null;
};

/**
 * A PHARMACY IS NOT A CONTACT. Owner's rule, 2026-09-01, in his own words: "you will not count the
 * pharmacies as contacts. Everyone should have contacts and pharmacies. The contacts is divided
 * into AM and PM, and the pharmacies are separate."
 *
 * So `contacts` is AM + PM and nothing else, and it is the only figure a screen may ever label
 * "contacts". `total` stays because the list still has a row count and the board needs one for
 * "N of M shown" — but it is deliberately NOT named `contacts`, and printing it under that word is
 * the exact mistake this comment exists to stop.
 */
export type RepsListCounts = {
  am: number;
  /** AM + PM. The owner's definition of a contact — pharmacies are never in here. */
  contacts: number;
  pharmacy: number;
  pm: number;
  /** Every row on the list, contacts PLUS pharmacies. Never shown under the word "contacts". */
  total: number;
};

/** Who a Reps List is for. `hrId` finds the list; `agentCrmId` is null for a rep with no CRM account. */
export type RepsListAgent = {
  agentCrmId: number | null;
  hrId: string | null;
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
export function groupContactsByBrick(rows: readonly RepsListContact[], index: BrickIndex): RepsListForRep {
  const groups = new Map<string, RepsListGroup>();
  const counts: RepsListCounts = { am: 0, contacts: 0, pharmacy: 0, pm: 0, total: 0 };

  for (const row of rows) {
    counts.total += 1;
    if (row.listType === "PM") counts.pm += 1;
    else if (row.listType === "AM") counts.am += 1;
    else counts.pharmacy += 1;
    // See RepsListCounts: contacts are AM + PM. A pharmacy row increments `total` and nothing else.
    if (row.listType !== "Pharmacy") counts.contacts += 1;

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
        rows: [],
        heading: isMapped
          ? (meta?.name ?? "").trim() || "Unnamed brick"
          : (row.region ?? "").trim() || "No CRM region recorded",
        mapped: isMapped,
      };
      groups.set(key, group);
    }
    group.rows.push(row);
  }

  const ordered = [...groups.values()].sort((left, right) => {
    if (left.mapped !== right.mapped) return left.mapped ? -1 : 1;
    if (left.rows.length !== right.rows.length) return right.rows.length - left.rows.length;
    return left.heading.localeCompare(right.heading);
  });

  for (const group of ordered) {
    group.rows.sort((left, right) => left.name.localeCompare(right.name));
    // NEIGHBOURS ARE FOUND PER GROUP, WHICH IS WHAT MAKES "in the same brick" STRUCTURAL. The owner
    // asked to highlight doctors in one brick who are very near each other; a group already IS one
    // brick (or one unmapped region), so the comparison can never reach across a heading and claim
    // two people are together when the page has just told the reader they are in different places.
    //
    // A row stands where its validated photo was taken, else where it was last checked in — the one
    // precedence its address and pin follow too (`rowPoint` in Phoenix CRM's own List), so the colour a
    // doctor is painted and the map his address opens can never disagree about where he is.
    const found = findNeighbours(
      group.rows.map((row) => {
        const point = row.place ?? row.seenAt ?? null;
        return { contactCrmId: row.contactCrmId, lat: point?.lat ?? null, lon: point?.lon ?? null, name: row.name };
      }),
    );
    for (const row of group.rows) row.nearby = found.get(row.contactCrmId) ?? null;
    // Then gather each cluster onto consecutive rows — the owner's follow-up the same day: "make
    // them under each other". The alphabetical sort above is the input, and `clusterRows` keeps
    // as much of it as gathering allows, so this is a reorder rather than a different sort.
    //
    // The same pass NUMBERS the neighbourhoods, because his next instruction was that each one
    // carries its own colour rather than all of them sharing a single tint. The number is computed
    // here, beside the clustering that defines it, and not in the browser: a colour chosen from
    // "does this row have neighbours" cannot tell one block from the next, which is precisely the
    // distinction he asked to see. Scoped to the group, so numbering restarts in every brick.
    const clustered = clusterRows(group.rows, found);
    group.rows = clustered.rows;
    for (const row of group.rows) row.cluster = clustered.clusterOf.get(row.contactCrmId) ?? null;
  }

  const unmapped = ordered.filter((group) => !group.mapped);
  return {
    counts,
    groups: ordered,
    unmappedContactCount: unmapped.reduce((total, group) => total + group.rows.length, 0),
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
  const answers = await mapWithConcurrency(inChunks(contactIds), CHUNK_CONCURRENCY, async (chunk) =>
    supabase
      .from(CRM_CUSTOMER_BRICK_RESOLUTIONS_TABLE)
      .select("crm_contact_id, brick_id, status")
      .in("crm_contact_id", chunk)
      .eq("status", "mapped")
      .not("brick_id", "is", null),
  );
  for (const { data, error } of answers) {
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
  // A few chunks at once, folded in chunk order (2026-10-16 performance audit): the same names, and the
  // same first failure, as the one-chunk-at-a-time loop gave.
  const answers = await mapWithConcurrency(inChunks(areaCodes), CHUNK_CONCURRENCY, async (chunk) =>
    supabase.from("source_of_sales_areas").select("area_code, area_name").in("area_code", chunk),
  );
  for (const { data, error } of answers) {
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
  // A few chunks at once, folded in chunk order (2026-10-16 performance audit) — see `loadAreaNames`.
  const answers = await mapWithConcurrency(inChunks(brickIds), CHUNK_CONCURRENCY, async (chunk) =>
    supabase.from("source_of_sales_bricks").select("brick_id, brick_name, area_code, active").in("brick_id", chunk),
  );
  for (const { data, error } of answers) {
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
 * The most recent check-in per contact — the "current address", as observed rather than recorded.
 *
 * Ordered newest-first and kept on FIRST SIGHT of each contact, so what lands is the latest fix.
 * Chunked at `IN_CHUNK` for the same reason every other `.in()` here is: PostgREST returns zero
 * rows and no error for a long list, which reads exactly like "nobody has ever visited these".
 *
 * A check-in with no coordinates is skipped outright. The whole point of this column is that the
 * address is CLICKABLE to a real pin, and an address with no pin behind it promises a map it
 * cannot open — the CRM address is already on the row for the text-only case.
 */
export type ContactCheckins = { points: CheckinPoint[]; seenAt: ContactSeenAt };

type CheckinRow = {
  address: string | null;
  agent_crm_id: number | null;
  agent_hr_id: string | null;
  check_date: string | null;
  contact_crm_id: number;
  /** The page cursor's tiebreak only — never carried onto a point. */
  crm_checkin_id: number;
  lat: number;
  lon: number;
};

export async function loadCheckins(contactIds: readonly number[]): Promise<Map<number, ContactCheckins>> {
  const byContact = new Map<number, ContactCheckins>();
  const supabase = getSupabaseAdmin();
  const ids = [...new Set(contactIds)];
  // One chunk's pages, in order. A failed page hands back the pages before it WITH its error rather
  // than throwing, so the fold below meets the error exactly where the old serial loop did.
  //
  // 🔴 KEYSET PAGES, NOT OFFSET (2026-10-16 Phoenix CRM performance audit). An OFFSET page over a union
  // view makes the database build and throw away every row before it, so a contact with years of
  // check-ins cost more with every page. Each page now starts strictly after the last row of the one
  // before, on the SAME order — newest first, the check-in id breaking a tie — which is a total order
  // (crm_checkin_id is unique and check_date is never empty on an iReports360 check-in), so the pages
  // hold exactly the rows, in exactly the order, the OFFSET walk did.
  const readChunk = async (chunk: number[]): Promise<{ error: { message: string } | null; rows: CheckinRow[] }> => {
    const rows: CheckinRow[] = [];
    let after: { at: string; id: number } | null = null;
    for (;;) {
      let query = supabase
        .from(CRM_CHECKINS_UNIFIED_VIEW)
        .select("contact_crm_id, agent_crm_id, agent_hr_id, lat, lon, address, check_date, crm_checkin_id")
        // iReports360 check-ins only: these pins reach the rep's own Phoenix CRM List (shared-customers.ts),
        // and a Phoenix visit's position is never shown on a rep's screen (golden rule #1). A validated
        // place's point may be (validated-place-points.ts) — it is where the customer is, not a visit.
        .eq("source", IREPORTS360_VISIT_SOURCE)
        .in("contact_crm_id", chunk)
        .not("lat", "is", null)
        .not("lon", "is", null);
      if (after) {
        query = query.or(`check_date.lt."${after.at}",and(check_date.eq."${after.at}",crm_checkin_id.lt.${after.id})`);
      }
      const { data, error } = await query
        .order("check_date", { ascending: false })
        // A stable tiebreak, or two rows sharing a timestamp could straddle a page — which would both
        // duplicate one check-in and drop another, quietly changing the score.
        .order("crm_checkin_id", { ascending: false })
        .limit(PAGE_SIZE);
      if (error) return { error, rows };
      const pageRows = (data ?? []) as CheckinRow[];
      rows.push(...pageRows);
      if (pageRows.length < PAGE_SIZE) return { error: null, rows };
      const last = pageRows[pageRows.length - 1];
      after = { at: String(last.check_date), id: Number(last.crm_checkin_id) };
    }
  };
  const answers = await mapWithConcurrency(inChunks(ids), CHUNK_CONCURRENCY, readChunk);
  for (const { error, rows } of answers) {
    for (const row of rows) {
      // Keyed like the roster, so a rep with no CRM account counts as an observer and a partner.
      const point: CheckinPoint = {
        at: row.check_date,
        lat: row.lat,
        lon: row.lon,
        repKey: repDoctorListRepKey(row.agent_crm_id, row.agent_hr_id),
      };
      const existing = byContact.get(row.contact_crm_id);
      if (existing) {
        existing.points.push(point);
        continue;
      }
      // Newest first, so the FIRST row seen for a contact is the pin the board shows.
      byContact.set(row.contact_crm_id, {
        points: [point],
        seenAt: { address: row.address?.trim() || null, at: row.check_date, lat: row.lat, lon: row.lon },
      });
    }
    if (error) {
      // The board is about the contact list; a missing or unreadable check-in table costs the
      // observed address and nothing else, so it degrades to the CRM address rather than 500ing.
      if (isCrmSchemaMissingError(error)) return byContact;
      throw new Error(`Could not read contact check-ins: ${error.message}`);
    }
  }
  return byContact;
}

/** One open assignment with the contact fields identity matching needs, embedded from the master. */
export type RosterAssignmentRecord = {
  agent_crm_id: number | null;
  agent_hr_id: string | null;
  contact: {
    crm_region_name: string | null;
    name: string | null;
    phone: string | null;
    speciality: string | null;
  } | null;
  contact_crm_id: number;
};

/**
 * An open assignment as a roster entry, or null when it cannot be one. Pure; exported for its test.
 *
 * Keyed on the rep key — the CRM id, or `hr:<id>` for a rep with no CRM account — so a rep hired
 * without an account is a partner the sharing and insight matchers can name. Only a row naming
 * nobody at all is left out: it could never be named, and a shared null key would make every such
 * row "the same rep" as every other.
 */
export function toRosterEntry(record: RosterAssignmentRecord): RosterEntry | null {
  const repKey = repDoctorListRepKey(record.agent_crm_id, record.agent_hr_id);
  if (!repKey) return null;
  // Flattened first, so every field below reads one plain row. Speciality and CRM region are what
  // corroborate a name match: drop either and every distant twin falls silent.
  const row = {
    contact_name: record.contact?.name ?? null,
    crm_region_name: record.contact?.crm_region_name ?? null,
    phone: record.contact?.phone ?? null,
    speciality: record.contact?.speciality ?? null,
  };
  return {
    contactCrmId: record.contact_crm_id,
    name: row.contact_name?.trim() || "",
    nameKey: nameKey(row.contact_name),
    phoneKey: phoneKey(row.phone),
    regionKey: row.crm_region_name?.trim().toLowerCase() || null,
    repKey,
    speciality: row.speciality?.trim() || null,
  };
}

/** One copy, with room to grow well past today's 13,095 rows; a load over the budget is served, not kept. */
const CONTACT_ROSTER_LIMITS = { maxEntries: 1, maxRowsTotal: 60_000 };

/**
 * Every contact on every rep's list today, reduced to the fields identity matching needs.
 *
 * READ FROM PHOENIX'S OWN LIST — the open periods of `crm_contact_assignments`, with the contact's
 * name, phone, speciality and region from `crm_contacts` — never from the vendor scrape, which stops
 * moving the day the sweep is switched off.
 *
 * A COMPANY-WIDE READ IS THE POINT, and it is safe here because nothing from it reaches the screen
 * except a rep's NAME on a row the viewer can already see. Sharing cannot be detected from one rep's
 * own list by construction: the other half of the pair is, by definition, on somebody else's.
 *
 * 🔴 ONE STATEMENT, AND A MINUTE-OLD COPY (2026-10-25 production load audit). This read was 28% of all
 * database time: every Reps List rep page ran it, as fourteen parallel OFFSET pages with the contact
 * EMBEDDED — and an embed is a lateral join run for every row the OFFSET throws away, so the whole read
 * cost ~3.1 s of database time (222 ms a page, 2,357 pages in seven hours). `phx_crm_contact_roster`
 * returns the same rows from one hash join (~180 ms), and the in-process shared copy
 * (`getOrLoadShared`, 60 s, the freshness the owner chose for display reads on 2026-10-16) means a
 * manager stepping from rep to rep pays it once a minute, not once a page; an applied list change
 * drops it at once (`refreshSharedContactRoster`). It is a DISPLAY read — the
 * "also on X's list" line — and nothing that decides money, an approval or a notification reads it.
 * The copy is in memory, never `unstable_cache`: at ~13,000 rows it is over the 2 MB data-cache entry
 * limit that throws in dev. The page walk stays only as the fallback for a database without the
 * function (PGRST202).
 */
export async function loadContactRoster(): Promise<RosterEntry[]> {
  const { rows } = await getOrLoadShared(CRM_CONTACT_ROSTER, "open", readContactRoster, CONTACT_ROSTER_LIMITS);
  return rows ?? [];
}

const CONTACT_ROSTER_RPC = "phx_crm_contact_roster";

/** One roster row as the function returns it: [id, contact_crm_id, agent_crm_id, agent_hr_id, name, phone, speciality, crm_region_name]. */
export type RosterTuple = [number, number, number | null, string | null, string | null, string | null, string | null, string | null];

/** The function's tuple as the record the page walk's embed returned. Pure; exported for its test. */
export function rosterRecordFromTuple(tuple: RosterTuple): RosterAssignmentRecord {
  const [, contactCrmId, agentCrmId, agentHrId, name, phone, speciality, crmRegionName] = tuple;
  return {
    agent_crm_id: agentCrmId == null ? null : Number(agentCrmId),
    agent_hr_id: agentHrId,
    contact: { crm_region_name: crmRegionName, name, phone, speciality },
    contact_crm_id: Number(contactCrmId),
  };
}

/** null = the CRM schema is missing here (never stored); otherwise every roster entry. */
async function readContactRoster(): Promise<RosterEntry[] | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc(CONTACT_ROSTER_RPC);
  if (error) {
    if (isMissingCrmRpcError(error)) return readContactRosterByPages();
    if (isCrmSchemaMissingError(error)) return null;
    throw new Error(`Could not read the contact roster: ${error.message}`);
  }
  const roster: RosterEntry[] = [];
  for (const tuple of (Array.isArray(data) ? data : []) as RosterTuple[]) {
    const entry = toRosterEntry(rosterRecordFromTuple(tuple));
    if (entry) roster.push(entry);
  }
  return roster;
}

/** The pre-function read, kept only for a database that has not got `phx_crm_contact_roster` yet. */
async function readContactRosterByPages(): Promise<RosterEntry[] | null> {
  const supabase = getSupabaseAdmin();
  const { count, error: countError } = await supabase
    .from(CRM_CONTACT_ASSIGNMENTS_TABLE)
    .select("id", { count: "exact", head: true })
    .is("effective_to", null);
  if (countError) {
    if (isCrmSchemaMissingError(countError)) return null;
    throw new Error(`Could not size the contact roster: ${countError.message}`);
  }

  // Ordered by the assignment `id` — unique, so no page repeats or skips a row.
  const pages = Math.max(1, Math.ceil((count ?? 0) / PAGE_SIZE));
  const results = await Promise.all(
    Array.from({ length: pages }, (_unused, page) =>
      supabase
        .from(CRM_CONTACT_ASSIGNMENTS_TABLE)
        .select(`id, contact_crm_id, agent_crm_id, agent_hr_id, contact:${CRM_CONTACT_MASTER_TABLE}(name, phone, speciality, crm_region_name)`)
        .is("effective_to", null)
        .order("id", { ascending: true })
        .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1),
    ),
  );

  const roster: RosterEntry[] = [];
  for (const { data, error } of results) {
    if (error) {
      if (isCrmSchemaMissingError(error)) return null;
      throw new Error(`Could not read the contact roster: ${error.message}`);
    }
    for (const row of (data ?? []) as unknown as RosterAssignmentRecord[]) {
      const entry = toRosterEntry(row);
      if (entry) roster.push(entry);
    }
  }
  return roster;
}

/**
 * The pin for a set of contacts OUTSIDE the rep being viewed — the other half of a candidate match.
 *
 * Only ever asked for the handful of contacts that already matched on name or phone, so this stays
 * a single small request rather than a second pass over all 111,914 check-ins.
 */
export async function loadPinsFor(contactIds: readonly number[]): Promise<Map<number, { lat: number; lon: number }>> {
  const pins = new Map<number, { lat: number; lon: number }>();
  const ids = [...new Set(contactIds)];
  if (ids.length === 0) return pins;
  const supabase = getSupabaseAdmin();
  const answers = await mapWithConcurrency(inChunks(ids), CHUNK_CONCURRENCY, async (chunk) =>
    supabase
      .from(CRM_CHECKINS_UNIFIED_VIEW)
      .select("contact_crm_id, lat, lon, check_date")
      // iReports360 check-ins only, as loadCheckins above: never a Phoenix visit's position.
      .eq("source", IREPORTS360_VISIT_SOURCE)
      .in("contact_crm_id", chunk)
      .not("lat", "is", null)
      .not("lon", "is", null)
      .order("check_date", { ascending: false })
      .limit(PAGE_SIZE),
  );
  for (const { data, error } of answers) {
    if (error) {
      if (isCrmSchemaMissingError(error)) return pins;
      throw new Error(`Could not read check-ins for the shared-customer check: ${error.message}`);
    }
    for (const row of (data ?? []) as Array<{ contact_crm_id: number; lat: number; lon: number }>) {
      if (!pins.has(row.contact_crm_id)) pins.set(row.contact_crm_id, { lat: row.lat, lon: row.lon });
    }
  }
  return pins;
}

/**
 * One rep's contact list, grouped by brick.
 *
 * The reads are staged rather than one flat parallel batch because each stage narrows the next:
 * the contacts decide which contact-mappings and check-ins to ask for, and both mapping sources
 * together decide which brick names are worth fetching. On the largest measured list (197
 * contacts) that is four round trips.
 */
export async function getRepsListForAgent(
  /**
   * The rep. A bare number is a CRM account (Plan Verification's callers hold only that); the object
   * form carries the HR id, which is what finds the list of a rep hired without a CRM account.
   */
  agent: number | RepsListAgent,
  /**
   * Rep key -> the rep's readable name, for the "also on X's list" line. The key is the CRM id as a
   * string, or `hr:<id>` for a rep with no CRM account. REQUIRED rather than optional on purpose:
   * with an empty map the sharing check silently finds nothing, which looks exactly like a company
   * with no shared customers instead of like a caller that forgot.
   */
  repNames: ReadonlyMap<string, string>,
): Promise<RepsListForRep> {
  const { agentCrmId: ownCrmId, hrId } = typeof agent === "number" ? { agentCrmId: agent, hrId: null } : agent;
  // STARTED WITH THE LIST, NOT AFTER IT (2026-10-01, "slow to transfer between page and page"). The
  // region brick map, the company-wide roster and the trade counterparties take nothing from the
  // rep's rows, so they ride beside the list read instead of queueing behind it. Each is still
  // awaited exactly where it was, so its answer and its error arrive where they always did; each is
  // also handled the moment it starts, so a failure while the list is loading is never UNHANDLED.
  const regionBrickMapRead = loadRegionBrickMap();
  const rosterRead = loadContactRoster();
  const counterpartiesRead = loadTradeCounterparties();
  for (const read of [regionBrickMapRead, rosterRead, counterpartiesRead]) read.catch(() => undefined);
  // The HR id wins whenever it is known: it is who the rep IS, and it also finds his rows written by
  // a Phoenix list change, which carry no CRM account.
  const rows = hrId ? await getRepContactList(hrId) : ownCrmId != null ? await getAgentContactList(ownCrmId) : [];
  // "Someone else" to the sharing and insight matchers is a different rep KEY — the same key the
  // roster and the check-ins carry — so a rep with no CRM account is himself, not a stranger.
  const repKey = repDoctorListRepKey(ownCrmId, hrId);
  if (rows.length === 0 || !repKey) {
    return {
      counts: { am: 0, contacts: 0, pharmacy: 0, pm: 0, total: 0 },
      groups: [],
      unmappedContactCount: 0,
      unmappedRegionCount: 0,
    };
  }

  const contactIds = rows.map((row) => row.contactCrmId);
  // 🔴 EACH READ STARTS THE MOMENT WHAT IT NEEDS IS IN (2026-10-16 Phoenix CRM performance audit). The
  // brick names need only the two brick mappings, and the other reps' pins need only the company-wide
  // roster — neither ever needed this rep's check-ins, which are the slowest read here. They used to
  // wait for all four of the second stage; now each chains on its own inputs, and every answer is the
  // one the staged reads gave. Each is handled the moment it starts and awaited where it was used.
  const contactBrickMapRead = loadContactBrickMap(contactIds);
  const checkinsRead = loadCheckins(contactIds);
  // Never throws: a failed read answers an empty map and every row falls back to its check-ins.
  const placesRead = loadValidatedPlacePoints(contactIds);
  const metaRead = Promise.all([contactBrickMapRead, regionBrickMapRead]).then(([byContactId, byRegionName]) => {
    const needed = new Set<string>();
    for (const row of rows) {
      const brickId = byContactId.get(row.contactCrmId) ?? byRegionName.get(normalizeRegionKey(row.region));
      if (brickId) needed.add(brickId);
    }
    return loadBrickMeta([...needed]);
  });
  const otherPinsRead = rosterRead.then((rosterRows) => {
    // Narrow the roster to the contacts that could possibly be the same customer BEFORE asking for any
    // more check-ins. Matching keys come from the roster on both sides so the two halves of a pair are
    // normalized identically — reading one side off the display row instead would compare a real name
    // against the `Contact 12345` placeholder a nameless row falls back to.
    const rosterById = new Map(rosterRows.map((entry) => [entry.contactCrmId, entry]));
    const mineNameKeys = new Set<string>();
    const minePhoneKeys = new Set<string>();
    for (const id of contactIds) {
      const entry = rosterById.get(id);
      if (!entry) continue;
      if (entry.nameKey) mineNameKeys.add(entry.nameKey);
      if (entry.phoneKey) minePhoneKeys.add(entry.phoneKey);
    }
    const mineIds = new Set(contactIds);
    const candidateIds = rosterRows
      .filter(
        (entry) =>
          entry.repKey !== repKey &&
          !mineIds.has(entry.contactCrmId) &&
          ((entry.nameKey !== "" && mineNameKeys.has(entry.nameKey)) ||
            (entry.phoneKey != null && minePhoneKeys.has(entry.phoneKey))),
      )
      .map((entry) => entry.contactCrmId);
    return loadPinsFor(candidateIds);
  });
  for (const read of [contactBrickMapRead, checkinsRead, metaRead, otherPinsRead]) read.catch(() => undefined);

  const [brickByContactId, brickByRegionName, checkins, roster, otherPins, placeByContact] = await Promise.all([
    contactBrickMapRead,
    regionBrickMapRead,
    checkinsRead,
    rosterRead,
    otherPinsRead,
    placesRead,
  ]);

  const pins = new Map(otherPins);
  for (const [contactCrmId, found] of checkins) pins.set(contactCrmId, { lat: found.seenAt.lat, lon: found.seenAt.lon });
  const sharedByContact = findSharedCustomers(
    rows.map((row) => ({ contactCrmId: row.contactCrmId, repKey })),
    roster,
    pins,
    repNames,
  );

  // A SHARED CUSTOMER'S VISITS ARE SPLIT ACROSS TWO CONTACT ROWS, AND THE SCORE HAS TO SEE BOTH.
  //
  // The CRM files every visit against the contact row of the rep who made it, and gives each rep
  // their own row for the same doctor. So scoring this row alone counts only OUR rep's visits, and
  // the "confirmed by more than one rep" term can never fire on precisely the contacts where a
  // second observer actually exists — the shared ones. The board then said both things at once: a
  // violet row naming the other rep, and a popup underneath it reading "only one rep has ever
  // checked in here". Measured 2026-09-01: doctor حمادة الشهالي is rows 95283 (14 visits) and 100196
  // (12 visits) under two different reps, and 374 shared contacts are in that shape.
  //
  // Fetched only for the rows that actually MATCHED, not for every identity candidate — that is a
  // far smaller set than `candidateIds` and keeps this to one extra round trip.
  const partnerIds = new Set<number>();
  for (const list of sharedByContact.values()) {
    for (const entry of list) for (const id of entry.contactCrmIds) partnerIds.add(id);
  }
  // Read beside the brick names and the trade counterparties, which were already on their way.
  const [partnerCheckins, metaByBrickId, counterparties] = await Promise.all([
    partnerIds.size > 0 ? loadCheckins([...partnerIds]) : Promise.resolve(new Map<number, ContactCheckins>()),
    metaRead,
    counterpartiesRead,
  ]);

  // HAS PHOENIX ACTUALLY TRADED WITH THIS ROW? Matched here rather than inside `contact-trade.ts`
  // because the area a contact sits in is the SAME two-step brick resolution the grouping below
  // uses, and resolving it twice is how the badge and the group heading come to disagree about
  // where a doctor is. See that file's header for why the area — not the name — is what makes a
  // match trustworthy.
  const tradeByContact = matchContactTrade(
    rows.map((row) => {
      const brickId =
        brickByContactId.get(row.contactCrmId) ?? brickByRegionName.get(normalizeRegionKey(row.region)) ?? null;
      return {
        areaCode: brickId ? (metaByBrickId.get(brickId)?.areaCode ?? null) : null,
        contactCrmId: row.contactCrmId,
        name: row.name,
      };
    }),
    counterparties,
  );

  // WHAT LOOKS WRONG ABOUT EACH ROW. Computed from the roster, the pins and the check-ins that are
  // already loaded above, so it costs no extra round trip. Deliberately built AFTER the sharing
  // pass and never inside it: the two answer opposite questions about the same pair of records —
  // sharing asks who else has this customer, insights ask why two records that look like the same
  // customer are 40 km apart — and folding them together would make the highlight fire on rows the
  // owner does not want highlighted.
  const insightsByContact = buildPhoenixInsights(
    rows.map((row) => ({
      contactCrmId: row.contactCrmId,
      points: checkins.get(row.contactCrmId)?.points ?? [],
      repKey,
    })),
    roster,
    pins,
    repNames,
  );

  // Every annotation rides ON the row rather than in a lookup beside it: this object crosses the
  // server-to-client boundary, where a Map would arrive as `{}` — the same serialization trap that
  // has bitten `unstable_cache` here before.
  const annotated: RepsListContact[] = rows.map((row) => {
    const found = checkins.get(row.contactCrmId) ?? null;
    const sharedWith = sharedByContact.get(row.contactCrmId) ?? null;

    // Only reps who contributed at least one real visit are named in the popup's explanation. A rep
    // who shares the customer but has never checked in changes nothing about the score, and naming
    // them as evidence would overstate what was actually counted.
    const sharedPoints: CheckinPoint[] = [];
    const sharedRepNames: string[] = [];
    const distant: { metres: number | null; repName: string }[] = [];
    for (const entry of sharedWith ?? []) {
      // An empty id list is the proximity gate having refused this partner — the two records match
      // on a phone but stand somewhere else. That is worth SAYING rather than leaving the reader to
      // wonder why a row naming two reps scores as though it had one.
      if (entry.contactCrmIds.length === 0) {
        distant.push({ metres: entry.metres, repName: entry.repName });
        continue;
      }
      const before = sharedPoints.length;
      for (const id of entry.contactCrmIds) {
        const partner = partnerCheckins.get(id);
        if (partner) sharedPoints.push(...partner.points);
      }
      if (sharedPoints.length > before) sharedRepNames.push(entry.repName);
    }

    return {
      ...row,
      confidence: scoreLocationConfidence(
        found ? { lat: found.seenAt.lat, lon: found.seenAt.lon } : null,
        found ? [...found.points, ...sharedPoints] : [],
        Date.now(),
        sharedPoints.length > 0 || distant.length > 0
          ? { count: sharedPoints.length, distant, repNames: sharedRepNames }
          : undefined,
      ),
      insights: insightsByContact.get(row.contactCrmId) ?? null,
      nearby: null,
      place: placeByContact.get(row.contactCrmId) ?? null,
      seenAt: found?.seenAt ?? null,
      sharedWith,
      trade: tradeByContact.get(row.contactCrmId) ?? null,
    };
  });

  return groupContactsByBrick(annotated, { brickByContactId, brickByRegionName, metaByBrickId });
}

/**
 * WHERE EACH CONTACT ON ONE REP'S LIST SITS — the grouping alone, without the check-ins, sharing,
 * insight and trade annotations `getRepsListForAgent` adds for its own board.
 *
 * For a caller that needs only brick placement: Employee 360 compares the bricks of a rep's current
 * list with the bricks of his area. It resolves the brick with the SAME two steps and the SAME
 * loaders as the board above, so the two screens can never place one doctor in two bricks. Skipping
 * the annotations also skips the company-wide roster read, which this caller has no use for.
 */
export async function getRepsListBrickPlacement(hrId: string): Promise<RepsListForRep> {
  const rows = await getRepContactList(hrId);
  if (rows.length === 0) {
    return {
      counts: { am: 0, contacts: 0, pharmacy: 0, pm: 0, total: 0 },
      groups: [],
      unmappedContactCount: 0,
      unmappedRegionCount: 0,
    };
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
