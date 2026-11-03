/**
 * Phoenix CRM — the Polyclinic Caps page of the Super Admin and the SFE Manager, server side: every exception, the
 * reps, one rep's polyclinics, and the one write. The rule, his words and what stays untouched are in `../venue-cap-rules.ts`.
 *
 * 🔴 EVERY ANSWER COMES FROM THE DATABASE'S OWN MATCH. `phoenix_crm_venue_cap_board` says whether a venue is
 * lifted with the very test the door's trigger runs, so an old name key row and a row from this page read the
 * same, and `phoenix_crm_venue_cap_set` does a switch in one transaction under the venue's lock.
 *
 * The seats sent to the write are the rep's seats read here, never the page's word, so a venue on a seat the
 * rep has left is refused rather than written.
 */

import { forbiddenError, validationError } from "@/lib/http/api-errors";
import { isUuid } from "@/lib/phoenix-crm/plan-rules";
import { canUseSfeFieldControls, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { callPhoenixCrm, numberOrNull, textOrNull } from "@/lib/phoenix-crm/server/db";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { personKey, seatOccupants, type OrgSeat } from "@/lib/phoenix-crm/scope";
import {
  parseVenueCapAction,
  venueCapNumberProblem,
  venueExceptionSetter,
  venueHasException,
  type VenueCapAction,
  type VenueCapRepRow,
  type VenueCapRow,
  type VenueCapsAdminView,
  type VenueExceptionRow,
} from "@/lib/phoenix-crm/venue-cap-rules";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

/** The Super Admin and the SFE Manager (owner, 2026-11-03), and never a test account. */
export function canManageVenueCaps(viewer: PhoenixCrmViewer): boolean {
  return canUseSfeFieldControls(viewer);
}

function assertManager(viewer: PhoenixCrmViewer): void {
  if (!canManageVenueCaps(viewer)) throw forbiddenError("Only the Super Admin and the SFE Manager manage polyclinic caps.");
}

/** Every occupied rep seat, one entry per PERSON: a person on two territories is one row on the page. */
function seatsByPerson(viewer: PhoenixCrmViewer): Map<string, OrgSeat[]> {
  const people = new Map<string, OrgSeat[]>();
  for (const seat of viewer.org.territoryHolders) {
    if (!seat.occupantHrId) continue;
    const held = people.get(seat.occupantHrId) ?? [];
    held.push(seat);
    people.set(seat.occupantHrId, held);
  }
  return people;
}

type UnplannedRow = {
  id: string;
  seat_id: string;
  shared_place_id: string | null;
  venue_name_key: string | null;
  granted_by_hr_id: string | null;
  created_at: string | null;
};

/**
 * Who set a row that frees unplanned visits only, which the board says of a venue without saying who. The board's own
 * test has already matched the venue, so this needs only the row: the one naming the venue, otherwise the seat's
 * newest name key row. A seat holding two such keys is not told apart here; none does today.
 */
async function loadUnplannedSetters(): Promise<UnplannedRow[]> {
  return fetchAllRowsKeyset<UnplannedRow>(
    () =>
      getSupabaseAdmin()
        .from("phoenix_crm_offplan_exemptions")
        .select("id, seat_id, shared_place_id, venue_name_key, granted_by_hr_id, created_at")
        .is("ended_at", null)
        .is("rep_hr_id", null)
        .eq("lifts_venue_cap", false),
    { cursorColumn: "id", cursorOf: (row) => String(row.id) },
  );
}

function unplannedSetterOf(rows: ReadonlyArray<UnplannedRow>, seatId: string, sharedPlaceId: string): UnplannedRow | null {
  const onSeat = rows.filter((row) => row.seat_id === seatId);
  return (
    onSeat.find((row) => row.shared_place_id === sharedPlaceId) ??
    onSeat
      .filter((row) => row.venue_name_key)
      .sort((left, right) => String(right.created_at ?? "").localeCompare(String(left.created_at ?? "")))[0] ??
    null
  );
}

export async function loadVenueCapsAdmin(viewer: PhoenixCrmViewer, rawRep: unknown): Promise<VenueCapsAdminView> {
  assertManager(viewer);
  const people = seatsByPerson(viewer);
  const selectedHrId = personKey(textOrNull(rawRep));
  const selectedSeats = new Set((selectedHrId ? (people.get(selectedHrId) ?? []) : []).map((seat) => seat.seatId));

  // 🔴 EVERY TERRITORY, A VACANT ONE INCLUDED: an exception belongs to the territory, so it stands while nobody holds it,
  // and the page opens on all of them (owner, 2026-11-03). The same one read answers the chosen rep's list below.
  const companyBoard = await callPhoenixCrm<Row[]>("phoenix_crm_venue_cap_board", { p_seats: viewer.org.territories.map((seat) => seat.seatId) });
  const board = companyBoard.filter((row) => selectedSeats.has(String(row.seat_id)));
  const { sharedPlaceDailyCap, offPlanDailyCap, offPlanWeeklyCap } = viewer.config.settings;
  const standing = companyBoard.filter((row) =>
    venueHasException({ lifted: row.lifted === true, dailyCap: numberOrNull(row.daily_cap), unplannedFree: row.unplanned_free === true }, sharedPlaceDailyCap),
  );
  const unplannedSetters = standing.some((row) => row.unplanned_free === true) ? await loadUnplannedSetters() : [];
  const unplannedOf = (row: Row) => (row.unplanned_free === true ? unplannedSetterOf(unplannedSetters, String(row.seat_id), String(row.shared_place_id)) : null);
  const seatOf = (row: Row) => viewer.org.seats.get(String(row.seat_id));

  const names = await loadPeopleNames([
    ...people.keys(),
    ...standing.flatMap((row) => {
      const seat = seatOf(row);
      return seat ? seatOccupants(seat) : [];
    }),
    ...[...standing, ...board].map((row) => textOrNull(row.daily_cap_set_by_hr_id)),
    ...[...standing, ...board].map((row) => textOrNull(row.lifted_by_hr_id)),
    ...standing.map((row) => unplannedOf(row)?.granted_by_hr_id ?? null),
  ]);

  const joinDistinct = (values: Array<string | null | undefined>) => [...new Set(values.filter((value): value is string => Boolean(value)))].join(" · ");
  const reps: VenueCapRepRow[] = [...people.entries()]
    .map(([hrId, held]) => ({
      hrId,
      name: nameOf(names, hrId),
      lineName: joinDistinct(held.map((seat) => seat.lineName)) || "No line",
      areaName: joinDistinct(held.map((seat) => seat.areaName)) || "No area",
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  const venues: VenueCapRow[] = board.map((row) => {
    const setBy = textOrNull(row.daily_cap_set_by_hr_id);
    const liftedBy = textOrNull(row.lifted_by_hr_id);
    return {
      sharedPlaceId: String(row.shared_place_id),
      seatId: String(row.seat_id),
      name: String(row.name),
      kind: String(row.kind),
      held: row.status === "held",
      seated: Number(row.seated ?? 0),
      dailyCap: numberOrNull(row.daily_cap),
      dailyCapSetByName: setBy ? nameOf(names, setBy) : null,
      dailyCapSetAt: textOrNull(row.daily_cap_set_at),
      lifted: row.lifted === true,
      liftedByName: liftedBy ? nameOf(names, liftedBy) : null,
      liftedAt: textOrNull(row.lifted_at),
      unplannedFree: row.unplanned_free === true,
    };
  });

  const exceptions: VenueExceptionRow[] = standing
    .map((row) => {
      const seat = seatOf(row);
      const unplanned = unplannedOf(row);
      const setter = venueExceptionSetter(
        {
          lifted: row.lifted === true,
          liftedBy: textOrNull(row.lifted_by_hr_id),
          liftedAt: textOrNull(row.lifted_at),
          dailyCap: numberOrNull(row.daily_cap),
          dailyCapSetBy: textOrNull(row.daily_cap_set_by_hr_id),
          dailyCapSetAt: textOrNull(row.daily_cap_set_at),
          unplannedBy: textOrNull(unplanned?.granted_by_hr_id),
          unplannedAt: textOrNull(unplanned?.created_at),
        },
        sharedPlaceDailyCap,
      );
      return {
        sharedPlaceId: String(row.shared_place_id),
        name: String(row.name),
        kind: String(row.kind),
        held: row.status === "held",
        reps: (seat ? seatOccupants(seat) : []).map((hrId) => ({ hrId, name: nameOf(names, hrId) })),
        lineName: seat?.lineName || "No line",
        areaName: seat?.areaName || "No area",
        lifted: row.lifted === true,
        dailyCap: numberOrNull(row.daily_cap),
        unplannedFree: row.unplanned_free === true,
        setByName: setter.by ? nameOf(names, setter.by) : null,
        setAt: setter.at,
      };
    })
    .sort((left, right) => (left.reps[0]?.name ?? "").localeCompare(right.reps[0]?.name ?? "") || left.name.localeCompare(right.name));

  return {
    companyCap: sharedPlaceDailyCap,
    offPlanDailyCap,
    offPlanWeeklyCap,
    exceptions,
    reps,
    selected: reps.find((rep) => rep.hrId === selectedHrId) ?? null,
    venues,
  };
}

/** One switch or one number, on one venue of one rep. No message and no email goes to anybody. */
export async function setVenueCap(
  viewer: PhoenixCrmViewer,
  raw: unknown,
): Promise<{ sharedPlaceId: string; action: VenueCapAction }> {
  assertManager(viewer);
  const body = (raw && typeof raw === "object" ? raw : {}) as Row;
  const hrId = personKey(textOrNull(body.hrId));
  if (!hrId) throw validationError("Choose a rep from the list.");
  const sharedPlaceId = String(body.sharedPlaceId ?? "").trim();
  if (!isUuid(sharedPlaceId)) throw validationError("Choose a polyclinic from the list.");
  const action = parseVenueCapAction(body.action);
  if (!action) throw validationError("Reload the page and try again.");

  const seats = seatsByPerson(viewer).get(hrId) ?? [];
  if (seats.length === 0) throw validationError("This person holds no rep territory now. Reload the page.");

  let cap: number | null = null;
  if (action === "raise") {
    const problem = venueCapNumberProblem(body.cap, viewer.config.settings.sharedPlaceDailyCap);
    if (problem) throw validationError(problem);
    cap = Number(String(body.cap).trim());
  }

  await callPhoenixCrm("phoenix_crm_venue_cap_set", {
    p_seats: seats.map((seat) => seat.seatId),
    p_shared_place: sharedPlaceId,
    p_action: action,
    p_cap: cap,
    p_actor: viewer.hrId,
  });
  return { sharedPlaceId, action };
}
