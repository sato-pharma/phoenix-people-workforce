/**
 * Phoenix CRM — the Super Admin's Polyclinic Caps page, server side: the reps, one rep's polyclinics, and the
 * one write. The rule, his words and what stays untouched are in `../venue-cap-rules.ts`.
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
import type { PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { callPhoenixCrm, numberOrNull, textOrNull } from "@/lib/phoenix-crm/server/db";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { personKey, type OrgSeat } from "@/lib/phoenix-crm/scope";
import {
  parseVenueCapAction,
  venueCapNumberProblem,
  type VenueCapAction,
  type VenueCapRepRow,
  type VenueCapRow,
  type VenueCapsAdminView,
} from "@/lib/phoenix-crm/venue-cap-rules";

type Row = Record<string, unknown>;

/** The Super Admin, and never a test account. */
export function canManageVenueCaps(viewer: PhoenixCrmViewer): boolean {
  return viewer.isSuperAdmin && viewer.canUpdate && !viewer.isTestPersona;
}

function assertManager(viewer: PhoenixCrmViewer): void {
  if (!canManageVenueCaps(viewer)) throw forbiddenError("Only the Super Admin manages polyclinic caps.");
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

export async function loadVenueCapsAdmin(viewer: PhoenixCrmViewer, rawRep: unknown): Promise<VenueCapsAdminView> {
  assertManager(viewer);
  const people = seatsByPerson(viewer);
  const selectedHrId = personKey(textOrNull(rawRep));
  const seats = selectedHrId ? (people.get(selectedHrId) ?? []) : [];

  const board =
    seats.length > 0
      ? await callPhoenixCrm<Row[]>("phoenix_crm_venue_cap_board", { p_seats: seats.map((seat) => seat.seatId) })
      : [];

  const names = await loadPeopleNames([
    ...people.keys(),
    ...board.map((row) => textOrNull(row.daily_cap_set_by_hr_id)),
    ...board.map((row) => textOrNull(row.lifted_by_hr_id)),
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

  const { sharedPlaceDailyCap, offPlanDailyCap, offPlanWeeklyCap } = viewer.config.settings;
  return {
    companyCap: sharedPlaceDailyCap,
    offPlanDailyCap,
    offPlanWeeklyCap,
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
