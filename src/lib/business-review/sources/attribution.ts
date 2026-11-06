// Business Review — where a person stood, in the month the thing happened.
//
// THE DECISION THIS FILE ENCODES. Marketing spend, outstation claims and CRM visits all name a
// PERSON. To show them beside sales they must be placed on an area, a district and a line. The
// obvious way is to join to the live seat tree (`au_v_org_tree`) — and it is wrong, measurably:
// joining January's visits to today's tree loses 1,791 rows on top of the 2,509 that carry no
// hr_id at all, because the reps who made them have since left and hold no current seat. Roughly
// 47% of that month vanishes, silently, into "no area".
//
// So placement comes from the achievement rows the sales half already loaded. Those are resolved
// month by month inside the RPC via au.f_seat_occupant_asof, which means they carry occupancy AS
// IT WAS in that month, and they cost nothing extra — the range call has already been made. Two
// things follow, both of them the point:
//
//   1. A visit, an expense and a sale made by the same rep in the same month land on the same
//      area, the same district and the same line. The two halves of the review are structurally
//      incapable of disagreeing about who owns what.
//   2. A rep who left in March still places correctly for January and February.
//
// The live tree is kept only as a SECOND pass, for people who carry no sales rows at all —
// Product Managers, Training Managers, NSMs, anyone whose footprint is riding along rather than
// selling. That fallback is today's answer applied to a historical month, so it is flagged
// (`placedFromLiveTree`) and the coverage tab says so rather than pretending otherwise.

import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { isRegionalManagerHeldDistrict } from "@/lib/org/sales-only-seats";
import type { AchievementRow } from "@/lib/sales/monthly-targets";

/** HR ids arrive in mixed case from three different systems. Every map in this module is keyed
 *  through here — a bare `.toLowerCase()` comparison against the mirror once read 3% of a table. */
export function hrKey(hrId: string | null | undefined): string {
  return String(hrId ?? "").trim().toUpperCase();
}

export type Placement = {
  areaCode: string | null;
  dmSeatId: string | null;
  dmHrId: string | null;
  lineCode: string | null;
  regionCode: string | null;
  /** True when this came from today's seat tree rather than the month's own attribution. */
  placedFromLiveTree: boolean;
};

export type AttributionMap = {
  /** The month's own placement for a person, falling back to their nearest month in the window,
   *  then to the live tree. Null only when the person is unknown to both. */
  place: (hrId: string | null | undefined, period: string) => Placement | null;
  /** People who could only be placed from today's tree — reported, never hidden. */
  liveTreeOnlyHrIds: Set<string>;
  /** People no source could place at all. */
  unplaceableHrIds: Set<string>;
};

type LiveSeatRow = {
  occupant_hr_id: string | null;
  area_code: string | null;
  line_code: string | null;
  region_code: string | null;
  seat_id: string | null;
  seat_tier: string | null;
  parent_seat_id: string | null;
};

/**
 * Today's seat tree, used only for people the sales rows never mention.
 *
 * A manager's own seat is not a DM seat, so their district is resolved by walking up to the
 * nearest DM ancestor; an NSM or a Product Manager has none, and correctly gets a null district
 * rather than being forced onto an arbitrary one.
 */
async function loadLiveTree(): Promise<Map<string, Placement>> {
  const supabase = getSupabaseAdmin();
  // Paged, every seat: the parent walk below needs the whole tree, and a cut tree misplaces people.
  // As before, an unreadable tree answers an empty map rather than failing the pack.
  let rows: LiveSeatRow[];
  try {
    rows = await fetchAllRows<LiveSeatRow>(
      () =>
        supabase
          .from("au_v_org_tree")
          .select("occupant_hr_id, area_code, line_code, region_code, seat_id, seat_tier, parent_seat_id")
          .order("seat_id", { ascending: true }),
      "occupant_hr_id",
    );
  } catch {
    return new Map();
  }
  const bySeat = new Map(rows.filter((r) => r.seat_id).map((r) => [r.seat_id as string, r]));

  const dmSeatOf = (row: LiveSeatRow): { seatId: string | null; hrId: string | null } => {
    let cursor: LiveSeatRow | undefined = row;
    for (let hop = 0; cursor && hop < 12; hop += 1) {
      if (cursor.seat_tier === "DM" || cursor.seat_tier === "ACTING_DM") {
        return { seatId: cursor.seat_id, hrId: cursor.occupant_hr_id };
      }
      cursor = cursor.parent_seat_id ? bySeat.get(cursor.parent_seat_id) : undefined;
    }
    return { seatId: null, hrId: null };
  };

  const out = new Map<string, Placement>();
  for (const row of rows) {
    const key = hrKey(row.occupant_hr_id);
    if (!key || out.has(key)) continue;
    const dm = dmSeatOf(row);
    out.set(key, {
      areaCode: row.area_code,
      dmSeatId: dm.seatId,
      dmHrId: dm.hrId,
      lineCode: row.line_code,
      regionCode: row.region_code,
      placedFromLiveTree: true,
    });
  }
  return out;
}

/**
 * Build the placement map for a window.
 *
 * `interestedHrIds` is every person the non-sales sources mention. Only those are looked up in
 * the live tree, so the fallback stays a named, countable set rather than a silent widening.
 */
export async function buildAttributionMap(
  rows: readonly AchievementRow[],
  interestedHrIds: Iterable<string>,
): Promise<AttributionMap> {
  // Exact (person, month) placement, from the month's own attribution.
  const exact = new Map<string, Placement>();
  // Every month a person appears in, so a gap month can borrow the nearest one they do hold.
  const monthsByPerson = new Map<string, string[]>();

  const remember = (hrId: string | null, period: string, placement: Placement) => {
    const key = hrKey(hrId);
    if (!key) return;
    const composite = `${key}|${period}`;
    if (!exact.has(composite)) exact.set(composite, placement);
    const months = monthsByPerson.get(key);
    if (months) {
      if (!months.includes(period)) months.push(period);
    } else monthsByPerson.set(key, [period]);
  };

  for (const row of rows) {
    const placement: Placement = {
      areaCode: row.areaCode,
      dmSeatId: row.dmSeatId,
      dmHrId: row.dmHrId,
      lineCode: row.lineCode,
      regionCode: row.regionCode,
      placedFromLiveTree: false,
    };
    remember(row.repHrId, row.period, placement);
    // A district manager places on their own district, never on one of its areas — attaching a
    // DM's own expense to whichever area happened to sort first would invent a territory cost.
    // A district a Regional Manager holds himself is not where his expense lands: it would put all of
    // it on two vacant areas, so he keeps the placement his regional seat gives him.
    if (!isRegionalManagerHeldDistrict(row.dmSeatId)) remember(row.dmHrId, row.period, { ...placement, areaCode: null });
  }
  for (const months of monthsByPerson.values()) months.sort();

  const wanted = new Set<string>();
  for (const hrId of interestedHrIds) {
    const key = hrKey(hrId);
    if (key && !monthsByPerson.has(key)) wanted.add(key);
  }

  const liveTree = wanted.size > 0 ? await loadLiveTree() : new Map<string, Placement>();
  const liveTreeOnlyHrIds = new Set<string>();
  const unplaceableHrIds = new Set<string>();
  for (const key of wanted) {
    if (liveTree.has(key)) liveTreeOnlyHrIds.add(key);
    else unplaceableHrIds.add(key);
  }

  /** The month this person holds that sits nearest the one asked for. Prefers the most recent
   *  earlier month — a rep's January territory describes January better than their June one. */
  const nearestMonth = (months: readonly string[], period: string): string | null => {
    let earlier: string | null = null;
    let later: string | null = null;
    for (const month of months) {
      if (month <= period) earlier = month;
      else if (later == null) later = month;
    }
    return earlier ?? later;
  };

  return {
    place(hrId, period) {
      const key = hrKey(hrId);
      if (!key) return null;
      const direct = exact.get(`${key}|${period}`);
      if (direct) return direct;
      const months = monthsByPerson.get(key);
      if (months) {
        const nearest = nearestMonth(months, period);
        if (nearest) return exact.get(`${key}|${nearest}`) ?? null;
      }
      return liveTree.get(key) ?? null;
    },
    liveTreeOnlyHrIds,
    unplaceableHrIds,
  };
}
