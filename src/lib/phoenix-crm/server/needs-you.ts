/**
 * Phoenix CRM — the module's answer to the central Needs You board's one question: what is waiting on
 * THIS viewer here, and what is worth his knowing (`src/lib/needs-you`).
 *
 * Until 2026-10-03 the board had sixteen sources and none of them was Phoenix CRM, so a district
 * manager's or the SFE Manager's Phoenix CRM decisions were visible ONLY inside the module — and the
 * one of them whose delay costs a rep his figures is the off-plan visit, which counts in nothing until
 * it is decided (the visit-type rule).
 *
 * ## It reads the module's own rules, never its own queries
 *
 * The two decision counts come from `server/decision-queues.ts`, which is also what the module page's
 * own "waiting for you" badge reads — ONE producer, two readers, so the board and the module can never
 * disagree about whose turn it is. Who may read at all is `readsTeamReports` (server/access.ts), and
 * the awaiting-validation figure is `loadReadiness`, the Team tab's own progress read.
 *
 * ## Three things a reader will want to change, and must not
 *
 * 🔴 **The two decision counts are in the module's OWN world, test included.** The Super Admin's
 * entries are test entries (owner, 2026-09-16), so `phoenixCrmDecisionSeats` puts his counts in the
 * test world — and this source carries them as they are, saying so in the row's note. Narrowing them
 * to real entries here would make the board read 0 while the module's own badge read 3, which is
 * exactly the under-report `needs-you/types.ts` is built to make impossible. Over-reporting is allowed
 * there and deliberately untested; a row that never appeared costs a deploy.
 *
 * 🔴 **The awaiting-validation figure is ALWAYS REAL, and that is not an inconsistency.**
 * `phoenix_crm_seat_readiness` has no test twin — it takes no `is_test` and counts the carried-over
 * list itself — so there is no test number to report. The Team tab shows it as null in test mode
 * because that tab is a test-world VIEW; this board is not one.
 *
 * 🔴 **A MEDICAL REP IS `not-applicable`, NOT A ZERO, AND NEVER A ROW.** `readsTeamReports` is
 * deliberately false for him (Golden rule #1: anything that compares him with other people stays off
 * his screens), and his own list progress is not something a central board reports about him. A rep
 * holds a territory in scope, so a gate on "has any scope" would have handed him a readiness figure
 * about his own list on a board built for the people above him.
 */

import { readsTeamReports, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import {
  countPhoenixCrmListRequestsWaitingForYou,
  countPhoenixCrmOffPlanVisitsWaitingForYou,
  phoenixCrmDecisionSeats,
} from "@/lib/phoenix-crm/server/decision-queues";
import { loadReadiness } from "@/lib/phoenix-crm/server/list";

export type PhoenixCrmDecisionCounts = {
  /** List requests — a grade, a drop, an add, a bring-back — at a step this viewer takes. */
  listRequests: number;
  /** Off-plan visits at a step this viewer takes. */
  offPlanVisits: number;
  /**
   * Customers carried over from iReports360 and still waiting to be validated, across the territories
   * this viewer reads. REAL entries, always (see the header). It is a count of work still to do on the
   * lists and never a score: a district manager may validate one beside his rep (owner, 2026-10-02),
   * and nothing in it is blocked on a decision of his.
   */
  awaitingValidation: number;
  /** How many territories that figure covers, so the sentence can say so. */
  territories: number;
  /** True when the two decision counts are TEST entries — the Super Admin, or a test account. */
  isTest: boolean;
};

/**
 * Whether Phoenix CRM has decisions to report to this viewer at all: a district manager, the SFE
 * Manager, a national or regional manager, the CEO or the Super Admin — never a medical rep.
 *
 * It is `readsTeamReports` and NOT a predicate of its own, because it is the same question that one
 * already answers: does this viewer read Phoenix CRM ABOUT A TEAM rather than about himself.
 */
export function phoenixCrmReadsDecisions(viewer: PhoenixCrmViewer): boolean {
  return readsTeamReports(viewer);
}

/**
 * The three counts, in one wave. It THROWS on any failed read rather than reporting a zero — the
 * board turns a rejection into its amber "could not be read" row, and a zero it cannot prove is the
 * one shape that board must never have.
 */
export async function loadPhoenixCrmDecisionCounts(viewer: PhoenixCrmViewer): Promise<PhoenixCrmDecisionCounts> {
  const seats = phoenixCrmDecisionSeats(viewer);
  const seatIds = viewer.scopeTerritories.map((seat) => seat.seatId);

  const [listRequests, offPlanVisits, readiness] = await Promise.all([
    countPhoenixCrmListRequestsWaitingForYou(seats),
    countPhoenixCrmOffPlanVisitsWaitingForYou(seats),
    // `loadReadiness` answers for EVERY seat asked about or throws — a territory the database did not
    // answer for is never read as ready, or as anything else. That is precisely the contract this
    // board needs, so it is called bare and its rejection travels.
    seatIds.length === 0 ? Promise.resolve(null) : loadReadiness(seatIds),
  ]);

  let awaitingValidation = 0;
  if (readiness) for (const seat of readiness.values()) awaitingValidation += seat.open;

  return { listRequests, offPlanVisits, awaitingValidation, territories: seatIds.length, isTest: seats.isTest };
}
