// Master Map — the Supabase reads.
//
// Kept apart from tree.ts so the whole shape of the sheet stays testable without a database.
//
// The customer crosswalk is ~52,600 rows and PostgREST hard-caps a response at 1,000, so it is
// paged by KEYSET on the bigint id rather than by .range(). Offset paging re-scans everything it
// has already skipped, which on this table is the difference between one pass and fifty-three
// increasingly expensive ones — the same lesson the Master Workbook export already learned.

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { ORGANOGRAM_ROW_CAP } from "@/lib/sales/master-map/organogram-limits";
import { currentCairoDateOnlyIso } from "@/lib/i18n/format";
import { lineName } from "@/lib/sales/monthly-targets";
import type { MasterMapCustomerInput } from "@/lib/sales/master-map/customer-merge";
import type {
  AreaInput,
  AreaManagerInput,
  BrickInput,
  OrganogramAreaInput,
  RegionInput,
} from "@/lib/sales/master-map/tree";
import { prettyDistributorName } from "@/lib/sales/master-map/tree";

const PAGE_SIZE = 1000;

export type MasterMapSource = {
  areaManagers: AreaManagerInput[];
  areas: AreaInput[];
  bricks: BrickInput[];
  customers: MasterMapCustomerInput[];
  /** distributor code -> human-readable name, for the Code column. */
  distributorNames: Map<string, string>;
  organogramAreas: OrganogramAreaInput[];
};

async function loadAllCustomers(): Promise<MasterMapCustomerInput[]> {
  const supabase = getSupabaseAdmin();
  const customers: MasterMapCustomerInput[] = [];
  let afterId = 0;

  for (;;) {
    const { data, error } = await supabase
      .from("source_of_sales_customer_map")
      .select("id,distributor_code,customer_code,customer_name,address,brick_id,source")
      .eq("active", true)
      .gt("id", afterId)
      .order("id", { ascending: true })
      .limit(PAGE_SIZE);
    if (error) throw error;

    const rows = data ?? [];
    if (rows.length === 0) break;

    for (const row of rows) {
      customers.push({
        address: (row.address as string | null) ?? "",
        brickId: String(row.brick_id ?? ""),
        customerCode: String(row.customer_code ?? ""),
        customerName: (row.customer_name as string | null) ?? "",
        distributorCode: String(row.distributor_code ?? ""),
        source: (row.source as string | null) ?? "",
      });
    }

    afterId = Number(rows[rows.length - 1].id);
    if (rows.length < PAGE_SIZE) break;
  }

  return customers;
}

/** A pseudo-DM seat is a real seat carrying real sales, so it is answered, not left blank. */
const PSEUDO_DM_MANAGER = "Sales only, no manager";

/** A real district that currently has nobody in it. Six of them today, all Anti Infective. */
const VACANT_MANAGER = "Vacant";

type Organogram = { areaManagers: AreaManagerInput[]; organogramAreas: OrganogramAreaInput[] };

const EMPTY_ORGANOGRAM: Organogram = { areaManagers: [], organogramAreas: [] };

/**
 * The last reading that actually worked, held for the life of the process.
 *
 * FAILING SOFT TO EMPTY WAS WORSE THAN FAILING. An empty organogram is not a neutral result — it
 * repaints every manager cell in the workbook to "Not in the organogram" and empties the Upper
 * Egypt 1 and Upper Egypt 2 tabs, and it does that quietly, so one timed-out read publishes a
 * sheet that reads as "the org chart is broken" rather than as "Phoenix could not reach it just
 * now". Holding the last good answer means a blip changes nothing at all: same names, same tabs,
 * same content hash, no repaint. Only a process that has NEVER read it successfully falls back to
 * empty, and that case is logged on every attempt.
 */
let lastGoodOrganogram: Organogram | null = null;

/** Never silently. A degraded workbook that nobody was told about is the failure mode here. */
function reportOrganogramFailure(cause: unknown): Organogram {
  if (lastGoodOrganogram) {
    console.warn(
      "[master map] the organogram came back unusable; holding the last good district managers so the sheet is not repainted with blanks",
      cause,
    );
    return lastGoodOrganogram;
  }
  console.warn(
    "[master map] the organogram came back unusable and nothing good is cached; every area will report its managers as unknown and Upper Egypt 1/2 will render empty",
    cause,
  );
  return EMPTY_ORGANOGRAM;
}

/**
 * The organogram's line × area map, as of today: which district owns each area, and who runs it.
 *
 * "As of today" on purpose, matching the owner's standing rule that Source of Sales attributes to
 * TODAY's structure and never as-was: a reorganisation re-cuts the whole sheet rather than leaving
 * an old shape behind. Same view the Monthly Closing reads, so the sheet and the closing can never
 * disagree about which district an area belongs to, or about who manages it.
 *
 * TODAY IS CAIRO'S TODAY, not the server's. This was `new Date().toISOString()`, which is UTC, and
 * Cairo runs two to three hours ahead of it — so between midnight and about 03:00 Cairo the sheet
 * was still applying yesterday's structure, and a reorganisation taking effect today would not
 * show until mid-morning. (The Monthly Closing had the same UTC window and no longer does — but it
 * does not resolve at "today" at all any more: `loadLineOperationalRegions` now takes the month
 * being closed, because a closing computes a specific month's money and this sheet shows now.)
 *
 * THREE READS, NOT ONE, BECAUSE THE NAME IS THREE HOPS AWAY: the map holds a seat id, the org tree
 * says who occupies that seat, and only `employees` knows the person's name. All three are tiny
 * (147 map rows, 133 seats, 22 distinct managers today), so they cost three round trips and nothing
 * else — no paging, unlike the 52,000-row customer crosswalk above.
 *
 * EVERY AREA GETS AN ANSWER. A seat with nobody in it says "Vacant" and an Others bucket says
 * "Sales only, no manager"; neither is left blank, because a blank cell in a sheet reads as "this
 * was not loaded" rather than "there is genuinely no manager here" — the same reason the owner's
 * rule says to flag a row rather than drop it.
 *
 * FAILS SOFT, BUT NEVER SILENTLY. A master of 50,000 pharmacies must not stop refreshing because
 * the org chart is briefly unreadable — but it must not quietly blank every manager either. See
 * lastGoodOrganogram above: the previous good answer is held, and the failure is logged.
 */
async function loadOrganogram(): Promise<Organogram> {
  const today = currentCairoDateOnlyIso();
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("au_v_line_area_map")
      .select("area_code,line_code,operational_region_code,dm_seat_id,effective_from,effective_to")
      .limit(ORGANOGRAM_ROW_CAP);
    if (error || !data) return reportOrganogramFailure(error);
    // A full page means PostgREST truncated at its ceiling and said nothing. Half an org chart is
    // worse than none: the areas that fell off the end would render "Not in the organogram", which
    // reads as a mapping the owner has to go and fix rather than as a read that came back short.
    if (data.length >= ORGANOGRAM_ROW_CAP) {
      return reportOrganogramFailure(
        new Error(`the area map came back at the ${ORGANOGRAM_ROW_CAP}-row ceiling, so it is truncated`),
      );
    }

    const current: Array<{ areaCode: string; line: string; regionCode: string; seatId: string }> = [];
    for (const row of data as Array<Record<string, unknown>>) {
      const areaCode = String(row.area_code ?? "").trim();
      if (!areaCode) continue;

      const from = String(row.effective_from ?? "");
      const to = String(row.effective_to ?? "");
      if (from && from > today) continue;
      if (to && to < today) continue;

      current.push({
        areaCode,
        line: String(row.line_code ?? "").trim(),
        regionCode: String(row.operational_region_code ?? "").trim(),
        seatId: String(row.dm_seat_id ?? "").trim(),
      });
    }

    const seatIds = [...new Set(current.map((row) => row.seatId).filter(Boolean))];
    const seats = new Map<string, { hrId: string; pseudo: boolean }>();
    if (seatIds.length > 0) {
      const { data: seatRows, error: seatError } = await supabase
        .from("au_v_org_tree_sales")
        .select("seat_id,occupant_hr_id,is_other_pseudo_dm")
        .in("seat_id", seatIds)
        .limit(ORGANOGRAM_ROW_CAP);
      // Checked, because losing THIS read is the worst of the three: with no seats every district
      // resolves to "Vacant", and the sheet would report fifty job openings that do not exist.
      if (seatError) return reportOrganogramFailure(seatError);
      for (const row of (seatRows ?? []) as Array<Record<string, unknown>>) {
        seats.set(String(row.seat_id ?? ""), {
          hrId: String(row.occupant_hr_id ?? "").trim(),
          // Checked BEFORE vacancy: an Others bucket is flagged vacant too, and reporting it as a
          // vacant district would invent a job opening that does not exist.
          pseudo: row.is_other_pseudo_dm === true,
        });
      }
    }

    const hrIds = [...new Set([...seats.values()].map((seat) => seat.hrId).filter(Boolean))];
    const names = new Map<string, string>();
    if (hrIds.length > 0) {
      const { data: people, error: peopleError } = await supabase
        .from("employees")
        .select("hr_id,full_name")
        .in("hr_id", hrIds)
        .limit(ORGANOGRAM_ROW_CAP);
      // Same reasoning: an occupied seat whose name did not load also reads as "Vacant".
      if (peopleError) return reportOrganogramFailure(peopleError);
      for (const row of (people ?? []) as Array<Record<string, unknown>>) {
        const name = String(row.full_name ?? "").trim();
        if (name) names.set(String(row.hr_id ?? ""), name);
      }
    }

    const seenArea = new Set<string>();
    const seenManager = new Set<string>();
    const organogramAreas: OrganogramAreaInput[] = [];
    const areaManagers: AreaManagerInput[] = [];

    for (const row of current) {
      const line = lineName(row.line);

      // The map is one row per line, so the same area appears under a district once per line.
      if (row.regionCode) {
        const key = `${row.regionCode}|${row.areaCode}|${row.line}`;
        if (!seenArea.has(key)) {
          seenArea.add(key);
          organogramAreas.push({ areaCode: row.areaCode, lineName: line, regionCode: row.regionCode });
        }
      }

      const managerKey = `${row.areaCode}|${row.line}`;
      if (seenManager.has(managerKey)) continue;
      seenManager.add(managerKey);

      const seat = seats.get(row.seatId);
      const manager = seat?.pseudo
        ? PSEUDO_DM_MANAGER
        : (names.get(seat?.hrId ?? "") ?? VACANT_MANAGER);
      areaManagers.push({ areaCode: row.areaCode, lineName: line, manager });
    }

    // A successful read that came back EMPTY is treated exactly like a failed one. That is the
    // shape a broken view returns, the organogram is never legitimately empty, and publishing it
    // would blank every manager cell in the workbook — the very thing this path exists to prevent.
    if (areaManagers.length === 0) {
      return reportOrganogramFailure(new Error("the organogram returned no area rows"));
    }

    const organogram: Organogram = { areaManagers, organogramAreas };
    lastGoodOrganogram = organogram;
    return organogram;
  } catch (cause) {
    return reportOrganogramFailure(cause); // see "FAILS SOFT, BUT NEVER SILENTLY" above
  }
}

export async function loadMasterMapSource(): Promise<MasterMapSource & { regions: RegionInput[] }> {
  const supabase = getSupabaseAdmin();

  const [regionsResult, areasResult, bricksResult, distributorsResult, customers, organogram] =
    await Promise.all([
      supabase.from("source_of_sales_regions").select("region_code,region_name").eq("active", true),
      supabase
        .from("source_of_sales_areas")
        .select("area_code,area_name,region_code")
        .eq("active", true),
      supabase
        .from("source_of_sales_bricks")
        .select("brick_id,brick_name,area_code")
        .eq("active", true),
      supabase.from("source_of_sales_distributors").select("distributor_code,distributor_name"),
      loadAllCustomers(),
      loadOrganogram(),
    ]);

  for (const result of [regionsResult, areasResult, bricksResult, distributorsResult]) {
    if (result.error) throw result.error;
  }

  const distributorNames = new Map<string, string>();
  for (const row of distributorsResult.data ?? []) {
    const code = String(row.distributor_code ?? "");
    if (code) distributorNames.set(code, prettyDistributorName(String(row.distributor_name ?? "")) || code);
  }

  return {
    areaManagers: organogram.areaManagers,
    areas: (areasResult.data ?? []).map((row) => ({
      areaCode: String(row.area_code ?? ""),
      areaName: String(row.area_name ?? ""),
      regionCode: String(row.region_code ?? ""),
    })),
    bricks: (bricksResult.data ?? []).map((row) => ({
      areaCode: String(row.area_code ?? ""),
      brickId: String(row.brick_id ?? ""),
      brickName: String(row.brick_name ?? ""),
    })),
    customers,
    distributorNames,
    organogramAreas: organogram.organogramAreas,
    regions: (regionsResult.data ?? []).map((row) => ({
      regionCode: String(row.region_code ?? ""),
      regionName: String(row.region_name ?? ""),
    })),
  };
}
