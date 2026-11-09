/**
 * Phoenix CRM — the adoption report's four reads (F3).
 *
 * Which territories have opened the module at all, how long they have had it, and which have had it
 * for weeks and never touched it. Every other board measures work being done; this one measures
 * whether it has begun.
 *
 * ## 🔴 Same gate as the other manager sections
 *
 * `readsTeamReports` — the Super Admin, the SFE Manager, a company basis, or a manager seat. A board
 * naming who has never opened the module must not reach the field: a rep seeing his own name on it
 * is being told the system is watching him begin (Golden Rule #1's blind half), and a rep seeing a
 * colleague's name on it is worse.
 *
 * ## Three reads for the whole company, whatever the scope
 *
 * The same shape as the exceptions board: readiness in one call (which also carries the date each
 * list was stamped ready), and the other two facts chunked over the seat ids rather than asked per
 * seat. ~140 territories must not be ~420 queries.
 *
 * 🔴 **The first visit and the visit count come from `phoenix_crm_countable_visits`**, the module's
 * one predicate for whether a visit counts — an off-plan visit still waiting for its two approvals
 * has not adopted anything yet. Since 2026-10-16 the view is counted in the database
 * (`phoenix_crm_seat_visit_firsts`) rather than read here row by row.
 */

import { forbiddenError } from "@/lib/http/api-errors";
import {
  ADOPTION_GRACE_DAYS,
  buildAdoptionReport,
  type AdoptionFacts,
  type AdoptionReport,
} from "@/lib/phoenix-crm/adoption-rules";
import { territoryName, type OrgSeat } from "@/lib/phoenix-crm/scope";
import { readsTeamReports, readWorldFor, testReadSeats, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { callPhoenixCrm, chunk } from "@/lib/phoenix-crm/server/db";
import { sharedReadiness } from "@/lib/phoenix-crm/server/exceptions";
import type { SeatReadiness } from "@/lib/phoenix-crm/server/list";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { openLineCodes } from "@/lib/phoenix-crm/server/settings";
import { mapWithConcurrency } from "@/lib/reconciliation/concurrency";

type Row = Record<string, unknown>;

export type AdoptionView = AdoptionReport & {
  isTest: boolean;
  cairoToday: string;
  /** The grace a line gets before an untouched territory counts as overdue, so the screen can say it. */
  graceDays: number;
};

type VisitFirsts = { firstVisitOn: string | null; visitsEver: number };

/**
 * The first countable visit ever on each seat, and how many there have been.
 *
 * No date floor: "ever" is the question, and a territory that worked in the first week of the
 * rollout and stopped is exactly the row a floor would hide.
 *
 * 🔴 AND NO `customer_validated` FILTER, DELIBERATELY — THE ONE BOARD IN THE MODULE THAT COUNTS A
 * VISIT TO A CUSTOMER NOBODY HAS VALIDATED YET. The owner's rule of 2026-10-01 is that such a visit
 * is counted in no KPI until the customer is on the list, and every tally and rate here obeys it
 * (team-calendar.ts, exceptions.ts, reports.ts, and every phoenix_crm_report_* function). This board
 * is not a KPI: it asks whether a territory has STARTED, and a rep standing at a clinic logging a
 * visit to a carried-over doctor he has not validated yet has plainly started. Filtering would put
 * him on the "never touched it" list for doing the work — and would read as truest at the moment it
 * is most wrong, in the first weeks, when almost nobody is validated yet.
 */
//
// 🔴 COUNTED IN THE DATABASE SINCE 2026-10-16 (`phoenix_crm_seat_visit_firsts`), over the same view,
// with the same two filters (the seat, the world) and nothing else. "Ever" is every visit the company
// has made: it was read here row by row — the whole history, in pages of 1,000, one after another —
// to produce two numbers per territory, and it grew by some six hundred rows a working day. The
// function answers one row per territory that has any visit: the earliest `visit_date` (MIN skips a
// missing date, as the old loop did) and how many rows there are (count(*), dated or not, as before).
// 150 territories a call keeps the answer far under PostgREST's 1,000-row cap; four calls at a time.
async function loadVisitFirsts(seatIds: string[], isTest: boolean): Promise<Map<string, VisitFirsts>> {
  const out = new Map<string, VisitFirsts>();
  if (seatIds.length === 0) return out;

  const answers = await mapWithConcurrency(chunk(seatIds, 150), 4, (part) =>
    callPhoenixCrm<unknown>("phoenix_crm_seat_visit_firsts", { p_seat_ids: part, p_is_test: isTest }),
  );
  for (const answer of answers) {
    for (const row of (Array.isArray(answer) ? answer : []) as Row[]) {
      const seatId = String(row.seat_id ?? "");
      if (!seatId) continue;
      // Folded in as the old loop folded rows, so a territory asked about in two batches adds up the same.
      const date = typeof row.first_visit_on === "string" ? row.first_visit_on : null;
      const current = out.get(seatId) ?? { firstVisitOn: null, visitsEver: 0 };
      out.set(seatId, {
        firstVisitOn: date === null ? current.firstVisitOn : current.firstVisitOn === null || date < current.firstVisitOn ? date : current.firstVisitOn,
        visitsEver: current.visitsEver + Number(row.visits_ever ?? 0),
      });
    }
  }
  return out;
}

export async function gatherAdoption(input: {
  seats: ReadonlyArray<OrgSeat>;
  isTest: boolean;
  cairoToday: string;
  config: PhoenixCrmViewer["config"];
}): Promise<AdoptionView> {
  const { config, isTest, seats } = input;
  const seatIds = seats.map((seat) => seat.seatId);

  const [readiness, firsts, names] = await Promise.all([
    // Readiness is measured on real entries; in test mode nothing is claimed about a list. It also
    // carries the date each list was stamped finished: `phoenix_crm_seat_readiness` answers it
    // straight from `phoenix_crm_territory_readiness` when it is not asked to stamp, so the second
    // read of that table this board used to make is gone and the date is the same one.
    isTest || seatIds.length === 0 ? Promise.resolve(new Map<string, SeatReadiness>()) : sharedReadiness(seatIds),
    loadVisitFirsts(seatIds, isTest),
    loadPeopleNames(seats.map((seat) => seat.occupantHrId)),
  ]);

  const openedOn = new Map(config.lineRollout.map((line) => [line.lineCode, line.opensOn]));
  const openLines = openLineCodes(config.lineRollout, input.cairoToday);

  const facts: AdoptionFacts[] = seats.map((seat) => {
    const list = readiness.get(seat.seatId) ?? null;
    const visits = firsts.get(seat.seatId) ?? { firstVisitOn: null, visitsEver: 0 };
    return {
      seatId: seat.seatId,
      territoryName: territoryName(seat),
      lineName: seat.lineName,
      repName: seat.occupantHrId ? nameOf(names, seat.occupantHrId) : null,
      hasRep: Boolean(seat.occupantHrId),
      lineOpenedOn: (seat.lineCode ? openedOn.get(seat.lineCode) : null) ?? null,
      lineIsOpen: Boolean(seat.lineCode && openLines.has(seat.lineCode)),
      readiness: list
        ? { total: list.total, validated: list.validated, dropped: list.dropped, dropPending: list.dropPending, ready: list.ready }
        : null,
      readyAt: list?.readyAt ?? null,
      firstVisitOn: visits.firstVisitOn,
      visitsEver: visits.visitsEver,
    };
  });

  const report = buildAdoptionReport(facts, { cairoToday: input.cairoToday });
  return { ...report, isTest, cairoToday: input.cairoToday, graceDays: ADOPTION_GRACE_DAYS };
}

/**
 * The report for one viewer.
 *
 * 🔴 **The seats are the viewer's whole reach, INCLUDING the territories whose line has not opened.**
 * `scopeTerritories` is already filtered to open lines, so using it alone would silently drop every
 * territory still waiting — and "which of my territories has the module reached" is precisely what
 * this board is for. `waitingScopeTerritories` is the other half, and dropping it would make a
 * rollout look complete the moment the open half adopted.
 */
export async function loadAdoptionReport(viewer: PhoenixCrmViewer, raw: { test: unknown }): Promise<AdoptionView> {
  if (!readsTeamReports(viewer)) throw forbiddenError("The adoption report is for managers.");
  const isTest = readWorldFor(viewer, raw.test);

  const seen = new Set<string>();
  const seats = testReadSeats(viewer, isTest, [...viewer.scopeTerritories, ...viewer.waitingScopeTerritories]).filter((seat) => {
    if (seen.has(seat.seatId)) return false;
    seen.add(seat.seatId);
    return true;
  });

  return gatherAdoption({ seats, isTest, cairoToday: viewer.cairoToday, config: viewer.config });
}
