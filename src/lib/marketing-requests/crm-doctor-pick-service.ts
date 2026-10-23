/**
 * The server half of Customer Validation's area → doctor pick (`crm-doctor-pick.ts` holds the rules).
 *
 * Reach is the organogram's, read exactly as Phoenix CRM reads it (`territoriesInScope`): a rep's own
 * territories; a District, Regional or National Manager's territories below his seats; the company
 * roles every territory. The doctors are the AM and PM lists of the chosen area's territories inside
 * that reach — active or not validated yet, never a pharmacy, never a dropped or outside customer.
 * A vacant territory still offers its list: a list belongs to the seat, not the person.
 *
 * 🔴 Nothing here writes to Phoenix CRM. The pick only READS a rep's list.
 */

import type { AccessContext } from "@/lib/auth/permissions";
import { forbiddenError, notFoundError, validationError } from "@/lib/http/api-errors";
import {
  crmDoctorAreaChoices,
  crmDoctorAreaIsFixed,
  crmSeatsOfArea,
  readsEveryCrmDoctorArea,
  type CrmDoctorAreaChoice,
  type CrmDoctorAreasPayload,
  type CrmDoctorListPayload,
  type CrmDoctorOption,
  type ResolvedCrmDoctorPick,
  UNPICKED_CRM_DOCTOR,
} from "@/lib/marketing-requests/crm-doctor-pick";
import { personKey, territoriesInScope, type OrgSeat } from "@/lib/phoenix-crm/scope";
import { chunk, dedupeIds, textOrNull } from "@/lib/phoenix-crm/server/db";
import { loadPhoenixCrmOrg } from "@/lib/phoenix-crm/server/org";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

/** The territories this viewer chooses an area from. */
export async function crmDoctorReach(access: Pick<AccessContext, "hrId" | "role" | "scope">): Promise<OrgSeat[]> {
  const org = await loadPhoenixCrmOrg();
  const basis = readsEveryCrmDoctorArea(access.role, access.scope) ? "all" : "tree";
  return territoriesInScope(org, personKey(access.hrId), basis).filter((seat) => !seat.isOtherPseudoDm);
}

/** GET: the areas he may choose — a rep's own, fixed. */
export async function loadCrmDoctorAreas(access: AccessContext): Promise<CrmDoctorAreasPayload> {
  const reach = await crmDoctorReach(access);
  return { areas: crmDoctorAreaChoices(reach), areaFixed: crmDoctorAreaIsFixed(access.role) };
}

async function loadListRows(seatIds: ReadonlyArray<string>, extra?: { ids: ReadonlyArray<string> }): Promise<Row[]> {
  const rows: Row[] = [];
  for (const part of chunk(dedupeIds(seatIds), 50)) {
    rows.push(
      ...(await fetchAllRowsKeyset<Row>(
        () => {
          let query = getSupabaseAdmin()
            .from("phoenix_crm_customers")
            .select("id, seat_id, name, speciality, list_type, status")
            .in("seat_id", part)
            .eq("is_test", false)
            .in("status", ["active", "pending"])
            .in("list_type", ["AM", "PM"]);
          if (extra) query = query.in("id", [...extra.ids]);
          return query;
        },
        { cursorColumn: "id", cursorOf: (row) => String(row.id) },
      )),
    );
  }
  return rows;
}

function areaOf(seats: ReadonlyArray<OrgSeat>): CrmDoctorAreaChoice {
  const first = seats[0];
  return { seatId: first.seatId, areaName: first.areaName ?? first.seatLabel ?? first.seatId };
}

/** GET: the doctors of one area he may choose — every rep list of that area inside his reach, by name. */
export async function loadCrmDoctorsForArea(access: AccessContext, areaSeatId: unknown): Promise<CrmDoctorListPayload> {
  const reach = await crmDoctorReach(access);
  const seats = crmSeatsOfArea(reach, typeof areaSeatId === "string" ? areaSeatId : null);
  if (!seats || seats.length === 0) throw forbiddenError("Choose one of your own areas.");
  const [rows, names] = await Promise.all([
    loadListRows(seats.map((seat) => seat.seatId)),
    loadPeopleNames(seats.map((seat) => seat.occupantHrId)),
  ]);
  const seatById = new Map(seats.map((seat) => [seat.seatId, seat]));
  const doctors = rows
    .flatMap((row): CrmDoctorOption[] => {
      const crmCustomerId = textOrNull(row.id);
      const seat = seatById.get(textOrNull(row.seat_id) ?? "");
      const listType = row.list_type === "AM" || row.list_type === "PM" ? row.list_type : null;
      const name = textOrNull(row.name);
      if (!crmCustomerId || !seat || !listType || !name) return [];
      return [
        {
          crmCustomerId,
          name,
          speciality: textOrNull(row.speciality),
          listType,
          repName: seat.occupantHrId ? nameOf(names, seat.occupantHrId) : null,
          lineName: seat.lineName,
        },
      ];
    })
    .sort((left, right) => left.name.localeCompare(right.name) || (left.repName ?? "").localeCompare(right.repName ?? ""));
  return { area: areaOf(seats), doctors };
}

/**
 * Re-checks a submitted pick on the server — the drop-list is a convenience, the reach is the boundary.
 * A picked doctor must be on a list of the chosen area inside the viewer's reach; his stored name wins.
 * No pick at all (an offline capture queued before 2026-10-23, or "Not on the list") saves as typed and
 * is flagged `not_on_list`, never refused — refusing would lose a capture made in the field.
 */
export async function resolveCrmDoctorPick(
  access: Pick<AccessContext, "hrId" | "role" | "scope">,
  input: { areaSeatId: string | null; crmCustomerId: string | null },
  reachCache?: { reach?: OrgSeat[] },
): Promise<ResolvedCrmDoctorPick> {
  if (!input.areaSeatId && !input.crmCustomerId) return UNPICKED_CRM_DOCTOR;
  const reach = reachCache?.reach ?? (await crmDoctorReach(access));
  if (reachCache) reachCache.reach = reach;
  const seats = crmSeatsOfArea(reach, input.areaSeatId);
  if (!seats || seats.length === 0) throw forbiddenError("Forbidden: that area is not one you can choose.");
  const area = areaOf(seats);
  if (!input.crmCustomerId) {
    return { chosenAreaName: area.areaName, chosenAreaSeatId: area.seatId, crmListStatus: "not_on_list", displayName: null, phoenixCrmCustomerId: null };
  }
  const rows = await loadListRows(seats.map((seat) => seat.seatId), { ids: [input.crmCustomerId] });
  const name = textOrNull(rows[0]?.name);
  if (!name) {
    throw notFoundError("That doctor is no longer on a rep's list in this area. Choose the doctor again.", "crm_doctor_not_in_area");
  }
  if (name.length > 300) throw validationError("That doctor's name could not be read.");
  return {
    chosenAreaName: area.areaName,
    chosenAreaSeatId: area.seatId,
    crmListStatus: "on_list",
    displayName: name,
    phoenixCrmCustomerId: textOrNull(rows[0]?.id),
  };
}
