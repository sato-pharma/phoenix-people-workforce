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
 * ## Four things a reader will want to change, and must not
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
 *
 * 🔴 **THE HELD-PLACE COUNT IS THE DECIDERS' ALONE, AND IT LINKS OFF THE TEAM TAB.** Added
 * 2026-10-05, after the owner put that queue on email, in-app and Telegram by name — the board is the
 * fourth way the same hold reaches him, and the only one that still shows it tomorrow if he reads a
 * notice and does nothing. `countValidationReviewsWaiting` is asked only when
 * `canDecideValidationReviews` is true (the Super Admin, and the SFE Manager since 2026-10-19, who
 * decides the same queue), so every other viewer gets a true zero with no query; and its row carries
 * its OWN href to `/admin/field-crm/validation-reviews`, because the Team tab cannot decide one. Both
 * halves look like tidying and are not: narrowing the href to the source's default would send him to a
 * screen with no decision on it, and widening the gate would put the queue on the screens of people who
 * cannot act on it. The email, in-app and Telegram notice of a new hold is still the Super Admin's
 * alone (`notifyValidationReviewWaiting`) — the SFE Manager is not sent a message he was not given.
 *
 * 🔴 **THE RECORDED-VISIT COUNT IS THE ADMINISTRATOR'S ALONE, AND LINKS TO THE VISIT RECORDING PAGE.**
 * Added 2026-10-16, the day the owner ruled that a recorded visit of any type waits for his approval
 * first. It counts in nothing until he decides, so a rep's figures wait on him by name. Asked only when
 * `canAdminister` is true — a true zero with no query for everyone else.
 */

import type { AccessContext } from "@/lib/auth/permissions";
import {
  canAdminister,
  canEnterMissedRecords,
  readsTeamReports,
  resolvePhoenixCrmViewer,
  type PhoenixCrmViewer,
} from "@/lib/phoenix-crm/server/access";
import { countCameraItemsWaiting } from "@/lib/phoenix-crm/server/camera-items";
import { countLateVisitsWaiting } from "@/lib/phoenix-crm/server/late-visits";
import {
  countPhoenixCrmListRequestsWaitingForYou,
  countPhoenixCrmOffPlanVisitsWaitingForYou,
  countPhoenixCrmWeeklyPlansWaitingForYou,
  phoenixCrmDecisionSeats,
} from "@/lib/phoenix-crm/server/decision-queues";
import { loadReadinessShared } from "@/lib/phoenix-crm/server/list";
import {
  canDecideValidationReviews,
  countReopenedCustomersWaiting,
  countValidationReviewsWaiting,
} from "@/lib/phoenix-crm/server/validation-reviews";
import { countRecordedVisitsWaiting } from "@/lib/phoenix-crm/server/visit-recordings";

export type PhoenixCrmDecisionCounts = {
  /** List requests — a grade, a drop, an add, a bring-back — at a step this viewer takes. */
  listRequests: number;
  /** Off-plan visits at a step this viewer takes. */
  offPlanVisits: number;
  /**
   * Weekly plans SENT and waiting for this viewer's own approval, in the weeks the Team tab lists.
   * There is no SFE step on a plan — the SFE Manager returns one and approves none — so this is the
   * reviewer's count alone, and it is the SAME function the module's own badge reads.
   */
  weeklyPlans: number;
  /**
   * Customers carried over from iReports360 and still waiting to be validated, across the territories
   * this viewer reads. REAL entries, always (see the header). It is a count of work still to do on the
   * lists and never a score: a district manager may validate one beside his rep (owner, 2026-10-02),
   * and nothing in it is blocked on a decision of his.
   */
  awaitingValidation: number;
  /** How many territories that figure covers, so the sentence can say so. */
  territories: number;
  /**
   * Places the Google Maps check could not settle, waiting on the decider's own page — and 0, with no
   * query at all, for every other viewer, because only the Super Admin decides one since 19 Nov 2026
   * (`canDecideValidationReviews`; the SFE Manager recommends). It is the one count here that is BLOCKED
   * on a decision nobody else can take, which is why it reaches the decider's own lane rather than the
   * worth-knowing band.
   */
  placeChecks: number;
  /** When the oldest of those was held, so the row can state its age. */
  oldestPlaceCheckAt: string | null;
  /**
   * The place checks the SFE Manager has recommended on (22 Nov 2026), which leave Place checks for the SFE
   * recommendations page and wait on the Super Admin there — counted apart, so `placeChecks` is exactly
   * what Place checks draws and this exactly what that page draws. 0 with no query for everyone else.
   */
  sfeRecommendedChecks: number;
  /** When the oldest of those was raised, so the row can state its age. */
  oldestSfeRecommendedAt: string | null;
  /**
   * Customers whose place the Super Admin refused, back under To validate and not captured again yet
   * (added 2026-10-08: measured that day, 0 of 22 had been, the oldest 76.7 hours later). His alone,
   * like `placeChecks` — 0 with no query for everyone else. NOT a decision of his: the rep redoes the
   * photo, so the row is worth knowing and never his own lane.
   */
  reopenedWaiting: number;
  /** When the oldest of those was refused, so the row can state how long it has waited. */
  oldestReopenedAt: string | null;
  /**
   * Recorded visits waiting on the Administrator (owner, 2026-10-16) — any type, planned included. Each
   * counts in nothing until he decides. His alone (`canAdminister`): 0 with no query for everyone else.
   */
  recordedVisits: number;
  /** When the oldest of those was recorded, so the row can state its age. */
  oldestRecordedVisitAt: string | null;
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
 * The counts, in one wave. It THROWS on any failed read rather than reporting a zero — the
 * board turns a rejection into its amber "could not be read" row, and a zero it cannot prove is the
 * one shape that board must never have.
 */
export async function loadPhoenixCrmDecisionCounts(viewer: PhoenixCrmViewer): Promise<PhoenixCrmDecisionCounts> {
  const seats = phoenixCrmDecisionSeats(viewer);
  const seatIds = viewer.scopeTerritories.map((seat) => seat.seatId);

  const decidesPlaces = canDecideValidationReviews(viewer);
  const [listRequests, offPlanVisits, weeklyPlans, readiness, placeCheck, reopened, recorded] = await Promise.all([
    countPhoenixCrmListRequestsWaitingForYou(seats),
    countPhoenixCrmOffPlanVisitsWaitingForYou(seats),
    // The weekly plans waiting on him. It was missing here until 2026-10-08 while the module's own
    // badge counted it, so the board read 0 for a manager with weeks sitting on his desk.
    countPhoenixCrmWeeklyPlansWaitingForYou(seats, viewer.cairoToday),
    // `loadReadiness` answers for EVERY seat asked about or throws — a territory the database did not
    // answer for is never read as ready, or as anything else. That is precisely the contract this
    // board needs, so it is called bare and its rejection travels. A count on a board, so it reads the
    // minute-old copy (loadReadinessShared), which keeps that contract and never keeps a failure.
    seatIds.length === 0 ? Promise.resolve(null) : loadReadinessShared(seatIds),
    // The held-place queue is the Super Admin's alone, so for everybody else it is a TRUE zero and no
    // query is made at all — the gate is the module's own (`canDecideValidationReviews`), never a
    // role test spelled out again here.
    decidesPlaces ? countValidationReviewsWaiting() : Promise.resolve({ count: 0, oldestAt: null, sfeRecommended: { count: 0, oldestAt: null } }),
    // The same gate for the same reason: only he refuses a place, so only he is told it is not redone.
    decidesPlaces ? countReopenedCustomersWaiting() : Promise.resolve({ count: 0, oldestAt: null }),
    // A recorded visit waits on the Administrator alone, so for everybody else this is a true zero.
    canAdminister(viewer) ? countRecordedVisitsWaiting() : Promise.resolve({ count: 0, oldestAt: null }),
  ]);

  let awaitingValidation = 0;
  if (readiness) for (const seat of readiness.values()) awaitingValidation += seat.open;

  return {
    listRequests,
    offPlanVisits,
    weeklyPlans,
    awaitingValidation,
    territories: seatIds.length,
    placeChecks: placeCheck.count,
    oldestPlaceCheckAt: placeCheck.oldestAt,
    sfeRecommendedChecks: placeCheck.sfeRecommended.count,
    oldestSfeRecommendedAt: placeCheck.sfeRecommended.oldestAt,
    reopenedWaiting: reopened.count,
    oldestReopenedAt: reopened.oldestAt,
    recordedVisits: recorded.count,
    oldestRecordedVisitAt: recorded.oldestAt,
    isTest: seats.isTest,
  };
}

/** The five Phoenix CRM queues that wait on the Super Admin alone, as sidebar badge slots. */
export type SuperAdminCrmQueueBadges = {
  placeChecks: { count: number };
  sfeRecommendedChecks: { count: number };
  cameraReviews: { count: number };
  lateVisits: { count: number };
  recordedVisits: { count: number };
};

const NO_CRM_QUEUE_BADGES: SuperAdminCrmQueueBadges = {
  placeChecks: { count: 0 },
  sfeRecommendedChecks: { count: 0 },
  cameraReviews: { count: 0 },
  lateVisits: { count: 0 },
  recordedVisits: { count: 0 },
};

/**
 * The numbers on the Super Admin's own Phoenix CRM rows — Place Checks, SFE Recommendations, Camera Reviews,
 * Late Visits and Visit Recording (owner, 27 Nov 2026: "are there things that are mine that are not showing?").
 * Each of those queues is decided by him alone, and until this none of the five rows carried a number, so a
 * held place or a late visit waited with nothing on the rail to say so.
 *
 * Every count is asked under the SAME gate as the page that decides it (`canDecideValidationReviews`,
 * `canEnterMissedRecords`, `canAdminister`), so the number is only ever drawn for the person who can clear it
 * — the SFE Manager, who reads Place Checks and only recommends, gets 0. Anyone who is not a Super Admin
 * returns zeros before the Phoenix CRM viewer is even built. The counts are the ones Needs You already uses,
 * so the badge and that board cannot disagree. It throws on a failed read; the batched loader turns a throw
 * into zero slots for the badge alone.
 */
export async function loadSuperAdminCrmQueueBadges(access: AccessContext): Promise<SuperAdminCrmQueueBadges> {
  if (access.role !== "Super Admin") return NO_CRM_QUEUE_BADGES;
  const viewer = await resolvePhoenixCrmViewer(access);
  const decidesPlaces = canDecideValidationReviews(viewer);
  const decidesLateAndCamera = canEnterMissedRecords(viewer);
  const [places, camera, late, recorded] = await Promise.all([
    decidesPlaces ? countValidationReviewsWaiting() : Promise.resolve({ count: 0, oldestAt: null, sfeRecommended: { count: 0, oldestAt: null } }),
    decidesLateAndCamera ? countCameraItemsWaiting() : Promise.resolve({ count: 0, oldestAt: null }),
    decidesLateAndCamera ? countLateVisitsWaiting() : Promise.resolve(0),
    canAdminister(viewer) ? countRecordedVisitsWaiting() : Promise.resolve({ count: 0, oldestAt: null }),
  ]);
  return {
    placeChecks: { count: places.count },
    sfeRecommendedChecks: { count: places.sfeRecommended.count },
    cameraReviews: { count: camera.count },
    lateVisits: { count: late },
    recordedVisits: { count: recorded.count },
  };
}
