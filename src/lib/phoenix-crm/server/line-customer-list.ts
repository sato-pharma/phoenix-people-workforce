/**
 * Phoenix CRM — a whole line's customer list as one .xlsx, grouped by region and then by rep
 * (owner's ask, 2026-11-18: "export xlsx sheet for the full line, example Pedia line, customer list
 * grouped per rep per region").
 *
 * 🔴 THE SAME TWO READERS AS THE LIST TEMPLATE BESIDE IT — the SFE Manager and the Super Admin, through
 * the integrity board's own predicate `canReadIntegrityBoard` plus `canApprove`, imported rather than a
 * second role list. The workbook names every customer of a line with the grades set for them, which is
 * the same sight the per-territory template already gives these two, and no one else's.
 *
 * 🔴 EACH TERRITORY IS READ THROUGH `loadTerritoryCustomers`, THE ONE TERRITORY READ — never a second
 * query on `phoenix_crm_customers`. It already drops the campaign-visit holders and keeps the list
 * proper (`onListOnly`: validated, or waiting to be validated), so this export can never count a
 * customer the rep's own List does not show. A line is ~40 seats, read six at a time.
 *
 * 🔴 A VACANT SEAT IS EXPORTED TOO, as "Seat vacant": a seat's carried-over list belongs to the seat,
 * not to the person, and leaving it out would make the line's total read short.
 */

import { validationError, forbiddenError } from "@/lib/http/api-errors";
import { mapWithConcurrency } from "@/lib/reconciliation/concurrency";
import { TERRITORY_TIER, territoryName, type OrgSeat } from "@/lib/phoenix-crm/scope";
import { territoryForView, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { canReadIntegrityBoard } from "@/lib/phoenix-crm/server/integrity-board";
import { loadTerritoryCustomers, mapTimings } from "@/lib/phoenix-crm/server/list";
import { buildLineCustomerListWorkbook, type LineListCustomer, type LineListTerritory } from "@/lib/phoenix-crm/server/line-customer-list-workbook";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { customerKindText } from "@/lib/phoenix-crm/speciality-list";
import { weekTimingsText } from "@/lib/phoenix-crm/timings";

type Row = Record<string, unknown>;

const SEATS_AT_ONCE = 6;

export type LineCustomerListLine = { lineCode: string; lineName: string; territories: number; regions: number };

function assertLineExporter(viewer: PhoenixCrmViewer): void {
  if (!canReadIntegrityBoard(viewer)) {
    throw forbiddenError("A line's customer list is the SFE Manager's and the Super Admin's.");
  }
  if (!viewer.canApprove) throw forbiddenError("Your role cannot export a line's customer list.");
}

/** The rep territories of the viewer's scope on one line — the per-line "Others" bucket holds no reps. */
function lineSeats(viewer: PhoenixCrmViewer, lineCode: string): OrgSeat[] {
  return viewer.scopeTerritories.filter(
    (seat) => seat.lineCode === lineCode && seat.tier === TERRITORY_TIER && !seat.isOtherPseudoDm,
  );
}

/** The lines this viewer may export, each with how many territories and regions it holds. */
export function lineCustomerListLines(viewer: PhoenixCrmViewer): LineCustomerListLine[] {
  assertLineExporter(viewer);
  const byLine = new Map<string, { lineName: string; seats: number; regions: Set<string> }>();
  for (const seat of viewer.scopeTerritories) {
    if (!seat.lineCode || seat.tier !== TERRITORY_TIER || seat.isOtherPseudoDm) continue;
    const entry = byLine.get(seat.lineCode) ?? { lineName: seat.lineName ?? seat.lineCode, regions: new Set<string>(), seats: 0 };
    entry.seats += 1;
    entry.regions.add(seat.regionName ?? "");
    byLine.set(seat.lineCode, entry);
  }
  return [...byLine.entries()]
    .map(([lineCode, entry]) => ({ lineCode, lineName: entry.lineName, regions: entry.regions.size, territories: entry.seats }))
    .sort((left, right) => left.lineName.localeCompare(right.lineName));
}

function standing(status: unknown): string {
  return status === "active" ? "On the list" : "Waiting to be validated";
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** The .xlsx for one line, and the facts the route audits. */
export async function buildLineCustomerList(
  viewer: PhoenixCrmViewer,
  lineCode: unknown,
): Promise<{ buffer: Buffer; fileName: string; lineName: string; territories: number; customers: number }> {
  assertLineExporter(viewer);
  const code = typeof lineCode === "string" ? lineCode.trim() : "";
  if (!code) throw validationError("Choose a line to export.");
  const seats = lineSeats(viewer, code);
  if (seats.length === 0) throw validationError("That line has no territory in your scope.");

  const managerOf = (seat: OrgSeat): OrgSeat | null => (seat.parentSeatId ? viewer.org.seats.get(seat.parentSeatId) ?? null : null);
  const [names, lists] = await Promise.all([
    loadPeopleNames([viewer.hrId, ...seats.map((seat) => seat.occupantHrId), ...seats.map((seat) => managerOf(seat)?.occupantHrId ?? null)]),
    mapWithConcurrency(seats, SEATS_AT_ONCE, async (seat) => {
      const { isTest } = territoryForView(viewer, seat.seatId, false);
      return loadTerritoryCustomers(seat.seatId, isTest, { onListOnly: true });
    }),
  ]);

  const territories: LineListTerritory[] = seats.map((seat, index) => {
    const { customers, placesByCustomer } = lists[index];
    const manager = managerOf(seat);
    return {
      areaName: seat.areaName,
      customers: customers.map((row: Row): LineListCustomer => {
        // Confirmed hours win over the draft, exactly as the list template prints them.
        const confirmed = (placesByCustomer.get(String(row.id)) ?? []).flatMap((place) => place.timings);
        const hours = confirmed.length > 0 ? confirmed : mapTimings(row.intake_timings);
        return {
          daysAndHours: hours.length > 0 ? weekTimingsText(hours, false) : null,
          grade: text(row.grade),
          listType: String(row.list_type ?? ""),
          name: String(row.name ?? ""),
          phone: text(row.phone),
          potential: text(row.potential_grade),
          primaryPharmacy: text(row.primary_pharmacy_name),
          speciality: customerKindText(text(row.customer_type), text(row.speciality)),
          status: standing(row.status),
        };
      }),
      districtManagerName: manager?.occupantHrId ? nameOf(names, manager.occupantHrId) : null,
      regionName: seat.regionName,
      repName: seat.occupantHrId ? nameOf(names, seat.occupantHrId) : null,
      seatId: seat.seatId,
      territoryName: territoryName(seat),
    };
  });

  const lineName = seats[0].lineName ?? code;
  const buffer = await buildLineCustomerListWorkbook({
    generatedAtIso: new Date().toISOString(),
    lineName,
    preparedFor: nameOf(names, viewer.hrId),
    territories,
  });
  const day = new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Cairo" });
  const slug = lineName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "line";
  return {
    buffer,
    customers: territories.reduce((sum, territory) => sum + territory.customers.length, 0),
    fileName: `phoenix-crm-${slug}-line-customer-list-${day}.xlsx`,
    lineName,
    territories: territories.length,
  };
}
