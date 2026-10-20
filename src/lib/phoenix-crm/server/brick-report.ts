/**
 * Phoenix CRM — the brick coverage report's two halves, composed (C2).
 *
 * The CRM half is `phoenix_crm_report_brick_coverage`, which computes coverage NATIVELY from
 * `phoenix_crm_places` — the brick, area and region were resolved server-side at capture and frozen
 * there (owner, 2026-09-23), so the module already owns the fact and never asks iReports360 for it.
 *
 * The sales half is the monthly closing's own brick grain, through the SHARED loader in
 * `@/lib/sales/closing-brick-sales` — the same two reads Employee 360's brick panel makes, lifted out
 * verbatim rather than written a second time.
 *
 * ## 🔴 The El Qema mask is mandatory, and it is this file's job
 *
 * `phx_closing_brick` returns El Qema's rows like any other distributor's. A warehouse brick carrying
 * its stock would announce a source that leaves no trace in a closing detail for anyone but the Super
 * Admin, so `withoutMaskedSourceRows` runs over the raw rows BEFORE anything is summed. It cannot live
 * in SQL: the mask takes a viewer's role. It cannot live in the pure module either: that one is
 * bundled for the phone. So it lives here, once, on the way in.
 *
 * ## 🔴 Same gate as the other manager sections
 *
 * `readsTeamReports` — the Super Admin, the SFE Manager, a company basis, or a manager seat. A medical
 * rep is deliberately out (owner, 2026-09-26): a board comparing bricks across a team is the manager's.
 *
 * ## Which months the sales half covers
 *
 * Only months whose distributor files have LANDED, inside the chosen period. Files arrive across the
 * first two weeks, so early in a month none has landed — and painting every brick as "no sales" then
 * would be a lie about the reps. When the period holds no landed month the sales half is simply empty
 * and `salesMonths` says so, which the screen prints rather than implying zero.
 */

import { forbiddenError, validationError } from "@/lib/http/api-errors";
import { scopeForRole } from "@/lib/auth/permissions";
import {
  buildBrickCoverageReport,
  type BrickCoverageReport,
  type BrickCrmRow,
  type BrickName,
  type BrickSalesTotal,
  type BrickTerritory,
} from "@/lib/phoenix-crm/brick-report";
import { resolveReportPeriod, type ReportPeriod } from "@/lib/phoenix-crm/report-rules";
import { territoriesUnderManager, territoryName, type OrgSeat } from "@/lib/phoenix-crm/scope";
import { readsTeamReports, reportIncludesTest, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { callPhoenixCrm } from "@/lib/phoenix-crm/server/db";
import { loadAreaBrickMaster, loadClosingBrickSales, upperCode } from "@/lib/sales/closing-brick-sales";
import { withoutMaskedSourceRows } from "@/lib/sales/closing-source-mask";
import { lineName } from "@/lib/sales/monthly-targets";
import { SALES_HISTORY_FLOOR, loadUploadedPeriodsInRange } from "@/lib/sales/vs-target";

type Row = Record<string, unknown>;

export type BrickCoverageView = BrickCoverageReport & {
  period: ReportPeriod;
  includeTest: boolean;
};

function asRows(data: unknown): Row[] {
  return Array.isArray(data) ? (data as Row[]) : [];
}

function count(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function mapCrmRow(row: Row): BrickCrmRow {
  return {
    seatId: String(row.seat_id ?? ""),
    brickId: text(row.brick_id),
    brickName: text(row.brick_name),
    areaCode: text(row.area_code),
    areaName: text(row.area_name),
    customers: count(row.customers),
    am: count(row.am),
    pm: count(row.pm),
    visited: count(row.visited),
    amVisited: count(row.am_visited),
    pmVisited: count(row.pm_visited),
    visits: count(row.visits),
  };
}

/**
 * The months inside the period whose distributor files have landed.
 *
 * `Iterable`, not an array: `loadUploadedPeriodsInRange` answers with a Set, and a signature that
 * demanded an array would only push a spread to every call site.
 */
export function landedMonthsIn(period: ReportPeriod, uploaded: Iterable<string>): string[] {
  const from = period.from.slice(0, 7);
  const to = period.to.slice(0, 7);
  return [...new Set(uploaded)].filter((month) => month >= from && month <= to).sort();
}

/**
 * The report. Refuses with a plain 403 for a rep: unlike the location-integrity board this one keeps
 * no secret whose EXISTENCE has to be hidden — it is made of work not done, which a rep can see about
 * himself anywhere else in the module.
 */
export async function loadBrickCoverageReport(
  viewer: PhoenixCrmViewer,
  raw: { seatId?: unknown; lineCode?: unknown; managerHrId?: unknown; includeTest?: unknown; from?: unknown; to?: unknown },
): Promise<BrickCoverageView> {
  if (!readsTeamReports(viewer)) throw forbiddenError("Coverage against sales is for managers.");

  const periodResult = resolveReportPeriod({ from: raw.from, to: raw.to, cairoToday: viewer.cairoToday });
  if (!periodResult.ok) throw validationError(periodResult.error);
  const period = periodResult.value;

  let seats: OrgSeat[] = viewer.scopeTerritories;
  const wantedLine = text(raw.lineCode);
  if (wantedLine) {
    seats = seats.filter((seat) => seat.lineCode === wantedLine);
    if (seats.length === 0) throw forbiddenError("This line is outside your scope.");
  }
  // The manager filter (owner, 2026-10-20: "when filter by manager u find no manager") — the same narrowing as
  // `chooseTerritories`: the territories under the seats he holds, and refused when he is not one of the viewer's.
  const wantedManager = text(raw.managerHrId);
  if (wantedManager) {
    const under = territoriesUnderManager(viewer.org, viewer.hrId, viewer.basis, wantedManager);
    if (under) seats = seats.filter((seat) => under.has(seat.seatId));
    if (!under || seats.length === 0) throw forbiddenError("This manager is outside your scope.");
  }
  const wantedSeat = text(raw.seatId);
  if (wantedSeat) {
    seats = seats.filter((seat) => seat.seatId === wantedSeat);
    if (seats.length === 0) throw forbiddenError("This territory is outside your scope.");
  }
  const includeTest = reportIncludesTest(viewer, raw.includeTest);

  if (seats.length === 0) {
    return {
      ...buildBrickCoverageReport({ territories: [], crmRows: [], sales: [], brickNames: [], salesMonths: [] }),
      period,
      includeTest,
    };
  }

  const [crmData, uploaded] = await Promise.all([
    callPhoenixCrm<unknown>("phoenix_crm_report_brick_coverage", {
      p_seat_ids: seats.map((seat) => seat.seatId),
      p_from: period.from,
      p_to: period.to,
      p_include_test: includeTest,
    }),
    loadUploadedPeriodsInRange(SALES_HISTORY_FLOOR, period.to.slice(0, 7)),
  ]);

  const chosenIds = new Set(seats.map((seat) => seat.seatId));
  const crmRows = asRows(crmData)
    .filter((row) => chosenIds.has(String(row.seat_id)))
    .map(mapCrmRow);

  /**
   * 🔴 A territory's AREA CODES come from its own captured places, not from the seat model.
   *
   * `OrgSeat` carries `areaName` and no code, and the closing's brick rows are keyed by CODE — matching
   * the two by name would break on the first area whose closing spelling differs from the organogram's,
   * which is the class of bug that doubles a line. `phoenix_crm_places` froze the resolved `area_code`
   * at capture, so the CRM half already answers it exactly, per territory.
   *
   * The cost is honest and worth stating: a territory whose rep has captured NOTHING yet has no area
   * code here, so it gets no sales-only bricks. It shows as an empty territory rather than as one
   * whose bricks all read "sales, nobody on the list" — which would be an accusation built on a gap.
   */
  const areaCodesBySeat = new Map<string, Set<string>>();
  for (const row of crmRows) {
    const code = upperCode(row.areaCode);
    if (!code) continue;
    const set = areaCodesBySeat.get(row.seatId) ?? new Set<string>();
    set.add(code);
    areaCodesBySeat.set(row.seatId, set);
  }
  const territories: BrickTerritory[] = seats.map((seat) => ({
    seatId: seat.seatId,
    territoryName: territoryName(seat),
    lineCode: seat.lineCode ?? null,
    areaCodes: [...(areaCodesBySeat.get(seat.seatId) ?? [])],
  }));

  // One read per line per landed month. Lines, not seats: the closing's brick grain is per line, and
  // two territories of the same line would otherwise fetch the same rows twice.
  const lines = [...new Set(seats.map((seat) => seat.lineCode).filter((code): code is string => Boolean(code)))];
  const salesMonths = landedMonthsIn(period, uploaded);
  const masked = { role: viewer.role, scope: scopeForRole(viewer.role) };
  // 🔴 EACH BATCH CARRIES THE LINE IT WAS ASKED FOR. `loadClosingBrickSales` takes the line and its
  // rows do not name it, so flattening the results loses the one fact the join needs — and a board
  // keyed by brick alone then adds every line's money onto one brick (see `BrickSalesTotal`). The
  // reads are built as `{ lineCode, rows }` pairs rather than a flat array for exactly that reason.
  const rawSales = await Promise.all(
    lines.flatMap((code) =>
      salesMonths.map(async (month) => ({ lineCode: code, rows: await loadClosingBrickSales(lineName(code), month) })),
    ),
  );
  // 🔴 The mask, before anything is summed.
  const sales: BrickSalesTotal[] = rawSales.flatMap((batch) =>
    [...withoutMaskedSourceRows(batch.rows, masked)].map((row) => ({
      lineCode: batch.lineCode,
      brickId: row.brickId,
      areaCode: upperCode(row.areaCode),
      value: row.value,
    })),
  );

  // A brick the closing booked to one of these areas needs its NAME, or the board prints an id at a
  // manager. The CRM half already names the bricks it knows; this covers the sales-only ones.
  const areaCodes = [...new Set(territories.flatMap((territory) => territory.areaCodes.map(upperCode)).filter(Boolean))];
  const areaSet = new Set(areaCodes);
  const salesBrickIds = [...new Set(sales.filter((row) => areaSet.has(row.areaCode)).map((row) => row.brickId))];
  const brickNames: BrickName[] =
    areaCodes.length === 0 && salesBrickIds.length === 0
      ? []
      : (await loadAreaBrickMaster(areaCodes, salesBrickIds)).map((entry) => ({
          brickId: entry.brickId,
          brickName: entry.brickName,
          areaCode: entry.areaCode,
        }));

  return {
    ...buildBrickCoverageReport({ territories, crmRows, sales, brickNames, salesMonths }),
    period,
    includeTest,
  };
}
