// Recruitment / Medical Rep hiring — who manages the area HR confirmed, on the line HR confirmed.
//
// The owner, 7 Nov 2026: when HR meets the candidate and chooses the line and the area, "the manager
// of this area must receive" the news — in-app, Telegram, email and a banner on his portal home. His
// answers: the area's DSM on that line, or the line's NSM where the area has no real DSM; and only
// when HR PASSES the candidate.
//
// THE ORGANOGRAM ANSWERS, the same one the sales master map reads (src/lib/sales/master-map/load.ts):
//   area name (the bot's own, as HR chose it) → area code (`au_v_canonical_areas`, through the
//   workspace places) → that line's district seat (`au_v_line_area_map`, today's row) → its
//   occupant (`au_v_org_tree_sales`).
// An area of the "Others" bucket (`is_other_pseudo_dm`) or a vacant seat has no real DSM, so the
// notice climbs the seat's parents to the line's NSM. A handover seat has two occupants; both are told.
//
// SERVER ONLY for the reads; `pickMrAreaManagers` is pure and tested.

import { hrIdForStorage } from "@/lib/hr-id";
import { currentCairoDateOnlyIso } from "@/lib/i18n/format";
import { recruitmentDb } from "@/lib/recruitment/db";
import { loadWorkspacePlaces } from "@/lib/recruitment/workspace/places";
import type { MrLine } from "@/lib/recruitment/mr-hiring/vocabulary";

export type MrOrgSeat = {
  seatId: string;
  parentSeatId: string | null;
  tier: string;
  occupantHrIds: string[];
  pseudo: boolean;
};

export type MrAreaManagers = { seat: "dsm" | "nsm"; hrIds: string[] };

/** How far up the seat tree the search for the NSM goes — DM → RSM → NSM is the deepest line. */
const MAX_CLIMB = 6;

/**
 * The people to tell for one district seat: its own occupants when it is a real DSM's seat, else the
 * occupants of the nearest NSM seat above it. Null when neither has anybody. PURE.
 */
export function pickMrAreaManagers(districtSeatId: string, seats: ReadonlyMap<string, MrOrgSeat>): MrAreaManagers | null {
  const district = seats.get(districtSeatId);
  if (!district) return null;
  if (!district.pseudo && district.occupantHrIds.length > 0) return { hrIds: district.occupantHrIds, seat: "dsm" };
  let parentId = district.parentSeatId;
  for (let hop = 0; hop < MAX_CLIMB && parentId; hop += 1) {
    const parent = seats.get(parentId);
    if (!parent) return null;
    if (parent.tier.toUpperCase() === "NSM") return parent.occupantHrIds.length > 0 ? { hrIds: parent.occupantHrIds, seat: "nsm" } : null;
    parentId = parent.parentSeatId;
  }
  return null;
}

function foldName(name: string): string {
  return name.replace(/\s+/g, " ").trim().toLowerCase();
}

/** The area code of an area HR confirmed, by the bot's own name. */
async function areaCodeFor(areaName: string): Promise<string | null> {
  const wanted = foldName(areaName);
  if (!wanted) return null;
  const places = await loadWorkspacePlaces("medical_rep");
  for (const region of places.regions) {
    for (const area of region.areas) if (foldName(area.name) === wanted) return area.code;
  }
  return null;
}

/** Today's district seat of one area on one line. */
async function districtSeatFor(areaCode: string, line: MrLine): Promise<string | null> {
  const today = currentCairoDateOnlyIso();
  const { data, error } = await recruitmentDb()
    .from("au_v_line_area_map")
    .select("dm_seat_id,effective_from,effective_to")
    .eq("area_code", areaCode)
    .eq("line_code", line)
    .limit(20);
  if (error) throw new Error(error.message);
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    const from = String(row.effective_from ?? "");
    const to = String(row.effective_to ?? "");
    if (from && from > today) continue;
    if (to && to < today) continue;
    const seatId = String(row.dm_seat_id ?? "").trim();
    if (seatId) return seatId;
  }
  return null;
}

/** The seats named, one row per occupant folded into one seat each. */
async function loadSeats(seatIds: string[], into: Map<string, MrOrgSeat>): Promise<void> {
  const wanted = seatIds.filter((id) => id && !into.has(id));
  if (wanted.length === 0) return;
  const { data, error } = await recruitmentDb()
    .from("au_v_org_tree_sales")
    .select("seat_id,parent_seat_id,seat_tier,occupant_hr_id,is_other_pseudo_dm,is_vacant")
    .in("seat_id", wanted)
    .limit(200);
  if (error) throw new Error(error.message);
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    const seatId = String(row.seat_id ?? "").trim();
    if (!seatId) continue;
    const seat = into.get(seatId) ?? {
      occupantHrIds: [],
      parentSeatId: String(row.parent_seat_id ?? "").trim() || null,
      pseudo: row.is_other_pseudo_dm === true,
      seatId,
      tier: String(row.seat_tier ?? "").trim(),
    };
    const occupant = hrIdForStorage(String(row.occupant_hr_id ?? ""));
    if (occupant && row.is_vacant !== true && !seat.occupantHrIds.includes(occupant)) seat.occupantHrIds.push(occupant);
    into.set(seatId, seat);
  }
}

/** Who manages this area on this line today — the DSM, or the line's NSM where there is no real DSM. */
export async function resolveMrAreaManagers(areaName: string, line: MrLine): Promise<MrAreaManagers | null> {
  const areaCode = await areaCodeFor(areaName);
  if (!areaCode) return null;
  const districtSeatId = await districtSeatFor(areaCode, line);
  if (!districtSeatId) return null;
  const seats = new Map<string, MrOrgSeat>();
  await loadSeats([districtSeatId], seats);
  // With no real DSM, climb to the NSM — one read per level, and only as far as the answer needs.
  let current = seats.get(districtSeatId);
  if (current && (current.pseudo || current.occupantHrIds.length === 0)) {
    for (let hop = 0; hop < MAX_CLIMB && current?.parentSeatId; hop += 1) {
      const parentId: string = current.parentSeatId;
      await loadSeats([parentId], seats);
      current = seats.get(parentId);
      if (!current || current.tier.toUpperCase() === "NSM") break;
    }
  }
  return pickMrAreaManagers(districtSeatId, seats);
}
