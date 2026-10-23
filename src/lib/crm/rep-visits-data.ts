// ─────────────────────────────────────────────────────────────────────────────
// The reads behind one rep's visit drill-down. Rules live in crm/rep-visits.ts,
// which is pure; this file only fetches rows and hands them over.
//
// Reads go through crm/reads.ts — the CRM mirror's single-source door, enforced by
// the "crm single-source door" test — so this cannot silently disagree with the
// board that links to it.
// ─────────────────────────────────────────────────────────────────────────────

import type { CallRateHolidays } from "@/lib/crm/call-rate";
import { buildKnownContactIndex, type KnownContactIndex } from "@/lib/crm/campaign-contact-match";
import { assistCampaignFragments } from "@/lib/crm/campaign-note-assist-model";
import { PHOENIX_VISIT_DETAIL_COLUMNS, type PhoenixDetailViewer } from "@/lib/crm/phoenix-visit-detail";
import { collapseDuplicateVisitSubmissions, queryCheckins, queryVisits } from "@/lib/crm/reads";
import {
  buildRepVisits,
  collectCampaignFragments,
  type CrmRegionTerritoryIndex,
  type RepVisitRow,
  type RepVisitsSummary,
  type VisitForRepDrilldown,
} from "@/lib/crm/rep-visits";
import { CRM_CUSTOMER_BRICK_RESOLUTIONS_TABLE, CRM_REGION_BRICK_RESOLUTIONS_TABLE } from "@/lib/crm/tables";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// Everything crm/rep-visits.ts reads, plus the two columns the duplicate collapse fingerprints on.
const VISIT_COLUMNS = [
  "agent_crm_id",
  "agent_hr_id",
  "agent_name",
  "ampm",
  "comment",
  "contact_crm_id",
  "contact_name",
  "crm_contact_grade",
  "crm_region_id",
  "crm_region_name",
  "crm_save_date",
  "crm_visit_id",
  "customer_name",
  "double_crm_id",
  "double_hr_id",
  "double_name",
  // The chain visit's SECOND manager. The door has returned the row since #5477; naming him here is
  // what stops one of the two people a chain visit carried going unnamed on the screen.
  "double2_hr_id",
  "double2_name",
  // A Phoenix CRM row's customer, validated or not yet — the rate's `not-validated` (crm/call-rate.ts).
  "phoenix_customer_validated",
  "speciality",
  "visit_date",
  "visit_type",
  "visit_type_description",
]
  .join(",")
  // THE PHOENIX FIELD SET, always selected and shown only to the tier the reader's role earns. It is
  // selected unconditionally on purpose: a select is a string, so a list that varied by role would
  // read `undefined` and print a blank the moment a tier was added — indistinguishable from a visit
  // that recorded nothing. The shaping is `phoenix-visit-detail.ts`'s job, not the query's.
  .concat(`,${PHOENIX_VISIT_DETAIL_COLUMNS.replaceAll(" ", "")}`);

const CHECKIN_COLUMNS = "agent_crm_id,agent_hr_id,contact_crm_id,check_date";

type CheckinRow = {
  agent_crm_id: number | null;
  agent_hr_id: string | null;
  contact_crm_id: number | null;
  check_date: string | null;
};

/**
 * crm_region_id -> the Phoenix brick/area/region it resolves to.
 *
 * DISPLAY OVERLAY, NEVER LOAD-BEARING. Degrades to an empty map on any error, exactly as the CRM
 * master tab's own copy of this read does: a mapping table that cannot be read must leave the visits
 * showing "not mapped yet", which is true, rather than take the page down.
 *
 * Measured against production 2026-08-28: `ireports360_crm_region_brick_resolutions` held 0 rows
 * against 239 distinct CRM regions in the August window, so this returned empty and every visit
 * rendered unmapped. Filling it is an admin action, not a deploy: the Region Mapping sheet
 * (Admin -> CRM -> Region Mapping) downloads a brick-dropdown workbook and re-imports it, and this
 * index then fills on its own.
 *
 * IT HAS SINCE BEEN FILLED, PARTLY — re-measured 2026-09-03 the table holds 105 rows, every one
 * carrying a brick, covering 100 of the 261 distinct regions on contacts (38%) and 105 of the 307
 * on visits. So the 2026-08-28 line is history, not current state: both outcomes are live now, and
 * a reader must not assume this returns empty.
 */
export async function loadCrmRegionTerritoryIndex(): Promise<CrmRegionTerritoryIndex> {
  const supabase = getSupabaseAdmin();
  const index = new Map<
    number,
    {
      brickId: string;
      brickName: string | null;
      areaCode: string | null;
      areaName: string | null;
      regionCode: string | null;
      regionName: string | null;
    }
  >();
  try {
    const { data: resolutions, error } = await supabase
      .from(CRM_REGION_BRICK_RESOLUTIONS_TABLE)
      .select("crm_region_id, brick_id")
      .eq("status", "mapped")
      .not("brick_id", "is", null);
    if (error) return index;
    const rows = (resolutions ?? []) as Array<{ brick_id: string | null; crm_region_id: number }>;
    if (rows.length === 0) return index;

    const brickIds = Array.from(new Set(rows.map((row) => row.brick_id).filter((id): id is string => Boolean(id))));
    // Chunked at 50: a PostgREST `.in()` carrying several hundred ids goes in the URL and past some
    // length returns `{ data: [], error: null }` — an empty set indistinguishable from a true answer
    // (AGENTS.md §2.1). 239 regions is already past where that has bitten in this repo.
    const brickById = new Map<string, { area_code: string | null; brick_name: string | null; region_code: string | null }>();
    for (let start = 0; start < brickIds.length; start += 50) {
      const { data: bricks, error: bricksError } = await supabase
        .from("source_of_sales_bricks")
        .select("brick_id, brick_name, area_code, region_code")
        .in("brick_id", brickIds.slice(start, start + 50));
      if (bricksError) return index;
      for (const brick of (bricks ?? []) as Array<{
        area_code: string | null;
        brick_id: string;
        brick_name: string | null;
        region_code: string | null;
      }>) {
        brickById.set(brick.brick_id, brick);
      }
    }

    const areaCodes = Array.from(
      new Set(Array.from(brickById.values()).map((b) => b.area_code).filter((c): c is string => Boolean(c))),
    );
    const regionCodes = Array.from(
      new Set(Array.from(brickById.values()).map((b) => b.region_code).filter((c): c is string => Boolean(c))),
    );
    const [areasRes, regionsRes] = await Promise.all([
      supabase.from("source_of_sales_areas").select("area_code, area_name").in("area_code", areaCodes),
      supabase.from("source_of_sales_regions").select("region_code, region_name").in("region_code", regionCodes),
    ]);
    const areaName = new Map(
      ((areasRes.data ?? []) as Array<{ area_code: string; area_name: string | null }>).map((a) => [a.area_code, a.area_name]),
    );
    const regionName = new Map(
      ((regionsRes.data ?? []) as Array<{ region_code: string; region_name: string | null }>).map((r) => [
        r.region_code,
        r.region_name,
      ]),
    );

    for (const row of rows) {
      if (!row.brick_id) continue;
      const brick = brickById.get(row.brick_id);
      index.set(row.crm_region_id, {
        brickId: row.brick_id,
        brickName: brick?.brick_name ?? null,
        areaCode: brick?.area_code ?? null,
        areaName: brick?.area_code ? (areaName.get(brick.area_code) ?? null) : null,
        regionCode: brick?.region_code ?? null,
        regionName: brick?.region_code ? (regionName.get(brick.region_code) ?? null) : null,
      });
    }
  } catch {
    return index;
  }
  return index;
}

/**
 * How many CRM regions have been tied to a brick, and how many are still waiting.
 *
 * The drill-down states this on the page rather than leaving the reader to infer it from a column of
 * "not mapped yet" markers. `CRM_CUSTOMER_BRICK_RESOLUTIONS_TABLE` is counted too because a
 * per-customer resolution is strictly more precise than a region-level one, so a reader deciding
 * whether the mapping is worth filling should see both numbers.
 */
export async function loadCrmMappingCoverage(): Promise<{ mappedRegions: number; mappedCustomers: number }> {
  const supabase = getSupabaseAdmin();
  try {
    const [regions, customers] = await Promise.all([
      supabase
        .from(CRM_REGION_BRICK_RESOLUTIONS_TABLE)
        .select("crm_region_id", { count: "exact", head: true })
        .eq("status", "mapped"),
      supabase
        .from(CRM_CUSTOMER_BRICK_RESOLUTIONS_TABLE)
        .select("crm_contact_id", { count: "exact", head: true })
        .eq("status", "mapped"),
    ]);
    return { mappedRegions: regions.count ?? 0, mappedCustomers: customers.count ?? 0 };
  } catch {
    return { mappedRegions: 0, mappedCustomers: 0 };
  }
}

/** Columns of a normal visit that describe WHO was seen. Nothing else is needed to build the list. */
const CONTACT_DIRECTORY_COLUMNS = "agent_hr_id,contact_crm_id,contact_name,speciality";

/**
 * How far back a normal visit still counts as "this doctor is on his list".
 *
 * A year, because the question is whether the rep has a working relationship with this doctor, and
 * a doctor seen once eighteen months ago is not one. It also keeps the read small: one rep's normal
 * visits over twelve months is on the order of a thousand rows, against 89,010 for the whole
 * company all-time — which is the read this window exists to avoid.
 */
const CONTACT_DIRECTORY_MONTHS = 12;

function directoryWindowStart(dateTo: string): string {
  const end = new Date(`${dateTo}T00:00:00Z`);
  if (Number.isNaN(end.getTime())) return dateTo;
  end.setUTCMonth(end.getUTCMonth() - CONTACT_DIRECTORY_MONTHS);
  return end.toISOString().slice(0, 10);
}

/**
 * The doctors this rep already visits normally, keyed by name.
 *
 * WHAT IT IS FOR. A campaign visit carries no contact record, so the screen calls it prospecting.
 * For 3,126 of production's campaign visits that is wrong — the rep visits that same doctor on his
 * normal rounds and simply coded this one call as a campaign. This index is what lets the screen
 * say so instead of asserting a prospect.
 *
 * SCOPED TO THIS REP, DELIBERATELY. A further 2,716 campaign visits name a doctor on a COLLEAGUE's
 * list, which is a territory question rather than a coding mistake and wants a different answer on
 * screen. Detecting those needs the company-wide directory — 14,717 contacts behind an 89,010-row
 * scan — which is a database object, not a page read. `buildKnownContactIndex` takes rows, so when
 * that object exists this function changes and nothing downstream does.
 *
 * DISPLAY OVERLAY, NEVER LOAD-BEARING. Returns an empty index on any failure, which makes every
 * campaign row read exactly as it does today. A directory that cannot be read must not take the
 * drill-down down with it, and must never make a visit look like something it is not.
 */
export async function loadRepContactDirectory(
  hrId: string | null,
  dateTo: string,
): Promise<KnownContactIndex> {
  if (!hrId) return new Map();
  try {
    const rows = await queryVisits<{
      agent_hr_id: string | null;
      contact_crm_id: number | null;
      contact_name: string | null;
      speciality: string | null;
    }>({
      agentHrIdILike: hrId,
      columns: CONTACT_DIRECTORY_COLUMNS,
      dateFrom: directoryWindowStart(dateTo),
      dateTo,
      visitTypes: [0],
    });
    return buildKnownContactIndex(
      rows.map((row) => ({
        agentHrId: row.agent_hr_id,
        contactCrmId: row.contact_crm_id == null ? null : String(row.contact_crm_id),
        contactName: row.contact_name,
        speciality: row.speciality,
      })),
    );
  } catch {
    return new Map();
  }
}

export type RepVisitsInput = {
  dateFrom: string;
  dateTo: string;
  /** The rep, by HR id. Matched case-insensitively by the door — do NOT pre-expand casings. */
  agentHrId?: string | null;
  /** The rep, by CRM agent id. Used when the person has no resolved HR id. */
  agentCrmId?: number | null;
  /** hr id (lower-cased) -> real name, for the double-visit partner column. */
  partnerNameByHrId?: ReadonlyMap<string, string>;
  /**
   * Who is reading, so each row's Phoenix half is shaped to his sight tier and blinded on his own row
   * (golden rule #1's three tiers, owner 2026-10-02). Omitted → no Phoenix half at all.
   */
  viewer?: PhoenixDetailViewer;
  /**
   * The national holidays of the window — the SAME set the rate above the list was divided by, so a
   * call on a holiday is marked "not scored" here exactly where the rate left it out. Omitted, no
   * day is treated as a holiday (the weekend and the catch-all contact are still marked).
   */
  holidays?: CallRateHolidays;
};

/**
 * Every visit one rep recorded in a period, resolved.
 *
 * Applies the SAME duplicate-submission collapse as `loadCallRateReport`, so the row count here
 * cannot exceed the call count on the board that linked to it — a rep re-saving the same contact-day
 * stop is one visit in both places.
 *
 * The agent filter is applied AFTER the collapse and on the same fields the rate keys on, rather
 * than being pushed into the query, so that a visit whose `agent_hr_id` resolved on one duplicate
 * row and not another is treated identically here and there.
 */
export async function loadRepVisits(
  input: RepVisitsInput,
): Promise<{ rows: RepVisitRow[]; summary: RepVisitsSummary }> {
  const hrId = input.agentHrId?.trim() || null;
  const [rawVisits, checkins, territoryIndex, contactDirectory] = await Promise.all([
    queryVisits<VisitForRepDrilldown & { double_crm_id: number | null }>({
      dateFrom: input.dateFrom,
      dateTo: input.dateTo,
      columns: VISIT_COLUMNS,
      // Push the rep down into the query when we have an hr id — the door sprays every casing
      // variant itself, which is the only safe way to match `agent_hr_id` in this mirror.
      ...(hrId ? { agentHrIdILike: hrId } : {}),
    }),
    // A rep with a CRM id is read by it here, the same narrowing the filter below applies, so the month
    // is one keyset scan of the rep's own check-ins instead of the whole company's read day by day (performance
    // phase 1, 2026-10-23). A rep without one is still read company-wide and narrowed by hr id below:
    // those rows can carry any casing or a legacy spelling, which only the canonical key below matches.
    queryCheckins<CheckinRow>({
      dateFrom: input.dateFrom,
      dateTo: input.dateTo,
      columns: CHECKIN_COLUMNS,
      ...(input.agentCrmId != null ? { agentCrmIds: [input.agentCrmId] } : {}),
    }),
    loadCrmRegionTerritoryIndex(),
    loadRepContactDirectory(hrId, input.dateTo),
  ]);

  const collapsed = collapseDuplicateVisitSubmissions(rawVisits);
  // With no hr id there is nothing to have filtered on above, so the crm id does it here.
  const visits =
    hrId != null
      ? collapsed
      : input.agentCrmId != null
        ? collapsed.filter((visit) => visit.agent_crm_id === input.agentCrmId)
        : collapsed;
  // By CRM id when the rep has one, exactly as before. A rep hired after the CRM cutover has none —
  // his check-ins carry a NULL `agent_crm_id` — so he is narrowed by hr id instead, rather than being
  // handed every check-in in the company.
  const hrKey = canonicalHrIdKey(hrId);
  const scopedCheckins =
    input.agentCrmId != null
      ? checkins.filter((checkin) => checkin.agent_crm_id === input.agentCrmId)
      : hrKey
        ? checkins.filter((checkin) => checkin.agent_crm_id == null && canonicalHrIdKey(checkin.agent_hr_id) === hrKey)
        : checkins;

  // THE CHEAP-MODEL ASSIST, ON THE RESIDUE ONLY.
  //
  // The owner, 2026-08-28: "you can use a cheap or free AI assist that already exists in our code
  // base to separate and analyse and extract the data." The rules in campaign-note.ts settle most
  // of the corpus for free — measured over all 17,474 distinct campaign notes on production they
  // name a person in 57.8% and a place in 24.3%, and recognise a further 12.8% as the rep's own
  // remark. This reads the 15.2% left over: an abbreviation a human resolves instantly and a rule
  // cannot, "م. طنطا العام" for Tanta General, "ص ثروت" for Tharwat Pharmacy.
  //
  // ONE call per drill-down, never per row, and only for fragments the rules already failed on —
  // that is what keeps it cheap. It cannot throw: a missing key, a timeout or a malformed answer
  // all return an empty map and the page renders the rules' reading exactly as it did before.
  //
  // This is the wire that was missing. Both halves shipped on 2026-08-28 and nothing ever called
  // them, so the residue stayed unread on the screen for five days while reading as a finished
  // feature — the module was tested, documented and reachable by no route at all.
  const assisted = await assistCampaignFragments(collectCampaignFragments(visits));

  return buildRepVisits(visits, scopedCheckins, {
    assisted,
    contactDirectory,
    holidays: input.holidays,
    partnerNameByHrId: input.partnerNameByHrId,
    territoryIndex,
    viewer: input.viewer,
  });
}
