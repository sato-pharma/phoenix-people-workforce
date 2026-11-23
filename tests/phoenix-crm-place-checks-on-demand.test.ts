import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  decidedSentWithPage,
  decisionFiguresSince,
  isReal,
  mergeDecided,
  PLACE_CHECKS_EVERYTHING_ROUTE,
  placeCheckOptions,
  placeCheckScorecardOf,
  placeChecksSummary,
  seatedPlacesInUse,
  withoutDecisionNotesThatAreComments,
} from "../src/lib/phoenix-crm/place-checks-on-demand.ts";
import {
  keepPlaceChecksForTheClick,
  PLACE_CHECKS_HANDOFF_MS,
  placeChecksHandoffKey,
  takePlaceChecksForTheClick,
} from "../src/lib/phoenix-crm/server/place-checks-handoff.ts";
import { withoutSeated } from "../src/lib/phoenix-crm/shared-place-groups.ts";
import { EMPTY_VALIDATION_REVIEW_FILTERS } from "../src/lib/phoenix-crm/validation-review-filters.ts";
import type { PlaceNoteIndex, ReopenedCustomerRow, SharedPlaceBoardRow, ValidatedPlaceRow, ValidationReviewRow } from "../src/lib/phoenix-crm/view-types.ts";
import { stripComments } from "./support/comment-strip.ts";
import { placeCheckBoardSource } from "./support/place-check-board-source.ts";

/**
 * Phoenix CRM — Place checks opens on what Needs you draws, and the rest waits for the click (owner,
 * 2026-11-14, "Load lists on demand").
 *
 * The page sent 12.5 MB on every open — 5,807 places in use (7.4 MB) and every decision ever made
 * (3.4 MB) — and building it froze the whole server: the 11 Nov 2026 stall alert (1.08 s, 11:34:44 Cairo)
 * ended as one 12.4 MB open of this page finished. It now sends 4.1 MB, and React's serializer went from
 * 211–330 ms to 60–103 ms on the same rows.
 *
 * What would break silently:
 * - the page handing the board every place in use again — nothing looks wrong, the freeze just comes back;
 * - the opening figures counted from the few places the page now sends, so the scorecard and the Not
 *   confirmed count quietly shrink to the seated customers;
 * - "Decided by" listing only the last 14 days' deciders;
 * - the older decisions merged back in another order, or twice after a re-read;
 * - a tab drawing part of a list while the rest is still on its way;
 * - the click's route answering anybody but the deciders;
 * - the review opening on the seated few instead of every place;
 * - (23 Nov 2026) the single clinics' decisions sent with the page again — 609 of the 991 decisions of the
 *   last 14 days that day, drawn only by History and "Approved by the system";
 * - the two decided tabs showing the few seated decisions as their count before the click, or a different
 *   number after it;
 * - (23 Nov 2026, "Fix what is under 9.5") "Rejected, last 14 days" counting every rejection that can still
 *   be taken back — it read 733 when 570 had been rejected in those 14 days — or the two decision cards
 *   counted from the few decisions the page now reads.
 */

const ROOT = new URL("../", import.meta.url);

function read(path: string): string {
  return stripComments(readFileSync(new URL(path, ROOT), "utf8").replace(/\r\n/g, "\n"));
}

const filterable = (repName: string) => ({
  repName,
  line: "CNS",
  region: "Cairo",
  listType: "AM",
  customerName: `Dr ${repName}`,
  territory: "T1",
  speciality: null,
  placeLabel: null,
  address: null,
  brickName: null,
  areaName: "Nasr City",
});

function review(id: string, createdAt: string, fields: Partial<ValidationReviewRow> = {}): ValidationReviewRow {
  return {
    ...filterable("Rep Waiting"),
    reviewId: id,
    placeId: `place-${id}`,
    sharedPlaceId: null,
    createdAt,
    status: "approved",
    recent: true,
    isTest: false,
    decidedByName: "Omar Gawish",
    decisionNote: null,
    photoKind: "signboard",
    ...fields,
  } as unknown as ValidationReviewRow;
}

function inUse(placeId: string, repName: string, fields: Partial<ValidatedPlaceRow> = {}): ValidatedPlaceRow {
  return {
    ...filterable(repName),
    placeId,
    sharedPlaceId: null,
    isTest: false,
    reviewed: false,
    photoKind: "signboard",
    signboard: { verdict: "match", reason: null, signText: "Dr" },
    schedule: null,
    validatedAt: "2026-11-01T10:00:00.000Z",
    decidedByName: "The system",
    ...fields,
  } as unknown as ValidatedPlaceRow;
}

const venue = { sharedPlaceId: "venue-1", isTest: false, repName: "Rep Building", line: "CNS", region: "Cairo", areaName: "Nasr City", decidedByName: null, status: "active" } as unknown as SharedPlaceBoardRow;
const testVenue = { ...venue, sharedPlaceId: "venue-test", isTest: true } as unknown as SharedPlaceBoardRow;
const reopened = [{ ...filterable("Rep Sent Back"), customerId: "c-9", isTest: false, refusedByName: "Omar Gawish", reopenedAt: "2026-11-02T10:00:00.000Z", sharedPlaceId: null }] as unknown as ReopenedCustomerRow[];

// Every place in use the page reads: a clinic the sign confirms, a clinic whose sign names somebody else
// (nobody looked — Not confirmed), a customer seated in a building, a customer of a test building, and a test entry.
const validated = [
  inUse("p-confirmed", "Rep Clinic"),
  inUse("p-other-name", "Rep Clinic Only", { signboard: { verdict: "other_name", reason: null, signText: "Somebody" } } as Partial<ValidatedPlaceRow>),
  inUse("p-seated", "Rep Building", { sharedPlaceId: "venue-1", photoKind: "schedule", schedule: { verdict: "match", scheduleText: null, hoursRead: null } } as Partial<ValidatedPlaceRow>),
  inUse("p-test-building", "Rep Building", { sharedPlaceId: "venue-test" }),
  inUse("p-test", "Rep Test", { isTest: true }),
];
const pending = [review("r-wait", "2026-11-13T09:00:00.000Z", { status: "pending", decidedByName: null } as Partial<ValidationReviewRow>)];
const decided = [
  review("r-new", "2026-11-12T09:00:00.000Z"),
  review("r-old", "2026-09-01T09:00:00.000Z", { recent: false, decidedByName: "Khaled Bedair" }),
];

function checkTheOpeningFigures() {
  const summary = placeChecksSummary({ team: false, pending, decided, validated, reopened, sharedPlaces: [venue, testVenue] });
  const real = <Row extends { isTest: boolean }>(set: Row[]) => set.filter((row) => !row.isTest);

  // The server counts exactly what the board counts with no filter, from EVERY row it read.
  assert.deepEqual(
    summary.scorecard,
    placeCheckScorecardOf({ pending: real(pending), validated: real(validated), reopened: real(reopened) }, EMPTY_VALIDATION_REVIEW_FILTERS, null),
    "the scorecard is the board's own count, filters empty",
  );
  assert.equal(summary.scorecard.total.places, 5, "every real place: the waiting one, two clinics, the seated customer and the test building's customer");
  assert.equal(summary.unconfirmed, 1, "Not confirmed counts the single clinic whose sign names somebody else — never the seated customer");
  assert.deepEqual(
    summary.options,
    placeCheckOptions({
      team: false,
      pending: real(pending),
      decided: real(decided).filter((row) => row.recent),
      everyDecided: real(decided),
      validated: real(validated),
      reopened: real(reopened),
      sharedPlaces: [venue],
    }),
    "the filter lists are the board's own",
  );
  assert.ok(summary.options.reps.includes("Rep Clinic Only"), "🔴 a rep whose only place is a clinic in use is still in the Rep box — the summary reads every place, not what the page sends");
  assert.ok(summary.options.deciders.includes("Khaled Bedair"), "🔴 Decided by lists everybody who ever decided, not the last 14 days");
  assert.ok(!summary.options.reps.includes("Rep Test"), "a test entry is in no list");
  assert.deepEqual(placeChecksSummary({ team: true, pending, decided, validated, reopened, sharedPlaces: [venue] }).options.deciders, [], "a manager's board names no decider");

  // What the page sends: the places seated in a building on the board, and nothing else.
  const seated = seatedPlacesInUse(validated, [venue, testVenue]);
  assert.deepEqual(
    seated.map((row) => row.placeId),
    ["p-seated", "p-test-building"],
    "a building's card shows everybody in it, so its customers come with the page",
  );
  // 🔴 Counting from what the page sends would be wrong — which is why the server counts before it trims.
  const fromTheFew = placeChecksSummary({ team: false, pending, decided, validated: seated, reopened, sharedPlaces: [venue, testVenue] });
  assert.notEqual(fromTheFew.unconfirmed, summary.unconfirmed, "the few the page sends cannot give the Not confirmed count");
  assert.notEqual(fromTheFew.scorecard.total.places, summary.scorecard.total.places, "nor the scorecard");
}

function checkTheMergedDecisions() {
  // The read's own order: newest first, then the id, newest first.
  const a = review("a", "2026-11-10T00:00:00.000Z");
  const b = review("b", "2026-11-10T00:00:00.000Z");
  const c = review("c", "2026-10-01T00:00:00.000Z", { recent: false });
  const d = review("d", "2026-11-11T00:00:00.000Z", { recent: false });
  assert.deepEqual(
    mergeDecided([a, b], [c, d]).map((row) => row.reviewId),
    ["d", "b", "a", "c"],
    "the older decisions fall into the read's own order, not after the recent ones",
  );
  const restated = review("c", "2026-10-01T00:00:00.000Z", { recent: true, status: "rejected" });
  const merged = mergeDecided([restated], [c]);
  assert.equal(merged.length, 1, "🔴 a row in both reads is drawn once");
  assert.equal(merged[0].status, "rejected", "and it is the page's copy, the newer read");

  // A comment written with the decision is drawn once, under the comments — on the older rows too.
  const notes = { "place:place-n": [{ body: "The sign is hidden." }] } as unknown as PlaceNoteIndex["notes"];
  const noted = withoutDecisionNotesThatAreComments([review("n", "2026-09-01T00:00:00.000Z", { decisionNote: " The sign is hidden. " })], notes);
  assert.equal(noted[0].decisionNote, null, "the decision note that is also a comment is not drawn twice");
}

/**
 * 🔴 THE DECISIONS OF SINGLE CLINICS WAIT FOR THE CLICK (owner, 23 Nov 2026: "Fix them"). The page sends the
 * recent decisions seated in a building on the board, the two decided tabs are counted on the server, and
 * the rows come with the click.
 */
function checkTheDecisionsThatWait() {
  const waiting = review("d-wait", "2026-11-13T09:00:00.000Z", { status: "pending", decidedByName: null } as Partial<ValidationReviewRow>);
  const clinic = review("d-clinic", "2026-11-12T09:00:00.000Z");
  const system = review("d-system", "2026-11-12T08:00:00.000Z", { approvedByRule: "sign_wins" } as unknown as Partial<ValidationReviewRow>);
  const seated = review("d-seated", "2026-11-11T09:00:00.000Z", { sharedPlaceId: "venue-1" });
  // Seated in a building that is not on the board: it stays among the clinics, where it can still be found.
  const elsewhere = review("d-elsewhere", "2026-11-10T09:00:00.000Z", { sharedPlaceId: "venue-gone" });
  const old = review("d-old", "2026-09-01T09:00:00.000Z", { recent: false });
  const test = review("d-test", "2026-11-12T07:00:00.000Z", { isTest: true });
  const everyRow = [waiting, clinic, system, seated, elsewhere, old, test];
  const everyDecision = everyRow.filter((row) => row.status !== "pending");

  const sent = decidedSentWithPage(everyDecision.filter((row) => row.recent), [venue]);
  assert.deepEqual(sent.map((row) => row.reviewId), ["d-seated"], "🔴 the page sends only the recent decisions seated in a building on the board");
  // The click answers EVERY decision since 23 Nov 2026 (the wide read does not know what the page chose to
  // send), and the board keeps the page's copy of a row in both: no decision is lost and none is drawn twice.
  assert.match(
    read("src/lib/phoenix-crm/server/place-checks-wide-read.ts"),
    /olderDecided: reviews\.rows\.filter\(\(row\) => row\.status !== "pending"\),/,
    "🔴 the click answers every decision, and a waiting place is never one of them",
  );
  const left = everyRow.filter((row) => row.status !== "pending");
  const pageCopy = { ...seated, decisionNote: "the page's copy" };
  const merged = mergeDecided([pageCopy], left);
  assert.deepEqual(
    merged.map((row) => row.reviewId).sort(),
    ["d-clinic", "d-elsewhere", "d-old", "d-seated", "d-system", "d-test"],
    "🔴 every decision is on the board once after the click: none lost, none twice",
  );
  assert.equal(merged.find((row) => row.reviewId === "d-seated")?.decisionNote, "the page's copy", "🔴 a row in both is the page's, the newer read");

  const summary = placeChecksSummary({ team: false, lanes: true, pending: [waiting], decided: everyDecision, validated, reopened, sharedPlaces: [venue, testVenue] });
  assert.equal(summary.bySystem, 1, "🔴 the server counts what the system approved, a tab whose rows the page no longer sends");
  assert.equal(summary.history, 3, "🔴 and History: two single clinics' recent decisions by a person, and one customer sent back");
  const whole = placeChecksSummary({ team: false, pending: [waiting], decided: everyDecision, validated, reopened, sharedPlaces: [venue, testVenue] });
  assert.deepEqual([whole.history, whole.bySystem], [4, 0], "a board with no lanes is not told which approvals were the system's: its History is whole");

  // The board after the click, by the board's own steps (use-board-rows.ts): the same two numbers.
  const afterTheClick = withoutSeated(mergeDecided(sent, left).filter(isReal).filter((row) => row.recent), new Set(["venue-1"]));
  const bySystemAfter = afterTheClick.filter((row) => Boolean(row.approvedByRule)).length;
  assert.equal(bySystemAfter, summary.bySystem, "🔴 the tab shows the same count before the click and after it");
  assert.equal(afterTheClick.length - bySystemAfter + withoutSeated(reopened, new Set(["venue-1"])).length, summary.history, "and so does History");
}

function checkTheWiring() {
  const page = read("app/(admin)/admin/field-crm/validation-reviews/page.tsx");
  // Since 23 Nov 2026 the figures are counted by the read behind the page (`place-checks-wide-read.ts`),
  // from every row THAT read made; `tests/phoenix-crm-place-checks-first-read.test.ts` pins the rest of it.
  const wide = read("src/lib/phoenix-crm/server/place-checks-wide-read.ts");
  assert.match(
    wide,
    /const summary = placeChecksSummary\(\{ team: false, lanes: decides, pending: sets\.waiting, decided: sets\.decided, validated, reopened: reopenedRead\.rows, sharedPlaces: sets\.sharedPlaces, capped, decidedSince \}\);/,
    "🔴 the figures are counted from every row the wide read made",
  );
  assert.match(wide, /const decidedSince = Date\.now\(\) - DECIDED_SHOWN_DAYS \* 86_400_000;/, "the two decision cards' 14 days are the board's own 14 days");
  assert.match(
    wide,
    /decisionFigures: summary\.decisionFigures,\s*\},\s*summary,\s*\};/,
    "🔴 the click's rows carry the same two figures the summary answers: the cards do not move when the rows arrive",
  );
  for (const prop of ["validated={seatedInUse}", "decided={sentDecided}", "onDemand={onDemand}"]) {
    assert.ok(page.includes(prop), `the page hands the board ${prop}`);
  }
  assert.ok(!page.includes("validated={validated}"), "🔴 the page never hands the board every place in use again (7.4 MB, the freeze)");
  assert.ok(!page.includes("decided={decided}"), "🔴 nor every decision ever made");
  assert.ok(!page.includes("decided={recentDecided}"), "🔴 nor the whole 14-day window: 609 of its 991 rows were single clinics' (23 Nov 2026)");
  assert.match(page, /const sentDecided = decidedSentWithPage\(decided\.filter\(\(row\) => row\.recent\), sharedPlaces\);/, "the decisions it sends are the recent ones seated in a building on the board");

  const route = read("app/api/phoenix-crm/validation-reviews/everything/route.ts");
  assert.equal(PLACE_CHECKS_EVERYTHING_ROUTE, "/api/phoenix-crm/validation-reviews/everything", "the board asks the route that exists");
  const handler = route.slice(route.indexOf("export async function GET("));
  const gate = handler.indexOf('assertPermission(access, "phoenix_crm", "approve")');
  const decider = handler.indexOf("if (!readsCompanyPlaceChecks(viewer)) throw forbiddenError(");
  const firstRow = handler.indexOf("takePlaceChecksForTheClick(placeChecksHandoffKey(viewer)) ?? (await readEverything(viewer))");
  assert.ok(gate > 0 && decider > gate && firstRow > decider, "🔴 the route asks `approve`, then the board's reader, before a row is taken or read — the page's own two gates");
  assert.match(
    read("app/api/phoenix-crm/validation-reviews/summary/route.ts"),
    /keepPlaceChecksForTheClick\(placeChecksHandoffKey\(viewer\), wide\.everything, startedAt\)/,
    "the figures' read leaves what it read for the click, under the same person's key",
  );
  assert.match(route, /return \(await readPlaceChecksWide\(viewer\)\)\.everything;/, "reading for itself, the click's route makes the same wide read");
  assert.match(wide, /olderDecided: reviews\.rows\.filter\(\(row\) => row\.status !== "pending"\)/, "which answers every decision; the board keeps the page's copy of one it already holds");
  assert.match(route, /NextResponse\.json\(\{ everything, success: true \}\)/, "under the key the board reads");

  const board = placeCheckBoardSource(read);
  assert.ok(
    board.includes('useCrmGet<PlaceChecksEverything>(onDemand && wanted && summarySettled ? PLACE_CHECKS_EVERYTHING_ROUTE : null, "everything")'),
    "🔴 the board reads by the key the route answers under, only once it is wanted, and only once the figures' read has ended",
  );
  assert.match(board, /if \(onDemand && !wanted && \(viewNeedsEverything\(view\) \|\| filtering \|\| deckAsked\)\) setWanted\(true\);/, "a tab whose rows wait, any filter or the review asks for the rest");
  assert.match(
    board,
    /export function viewNeedsEverything\(view: PlaceCheckView\): boolean \{\s*return view === "unconfirmed" \|\| view === "history" \|\| view === "bySystem";\s*\}/,
    "🔴 Not confirmed, History and Approved by the system are the tabs whose rows the page does not send",
  );
  assert.match(board, /if \(wanted\) reloadEverything\(\);/, "a re-read of the page reads the rest again");
  assert.match(board, /complete \? placeCheckScorecardOf\(/, "🔴 the board counts the scorecard only once it holds every row");
  assert.match(board, /const reading = !complete && \(filtering \|\| viewNeedsEverything\(view\)\);/, "it knows when a tab would draw part of a list");
  assert.match(board, /const counted = !complete && !filtering \? summary : null;/, "until the rows are in, the two decided tabs show the server's count");
  assert.ok(
    board.includes("count: decidedCount(historyCount, (figures) => figures.history) }") && board.includes("count: decidedCount(bySystemRows.length, (figures) => figures.bySystem) }"),
    "🔴 never the count of the few seated decisions the board holds before the click",
  );
  for (const view of ["needs", "unconfirmed", "polyclinics", "history", "bySystem"]) {
    assert.ok(board.includes(`{!reading && view === "${view}" ? (`), `🔴 the ${view} tab is never drawn from part of its rows`);
  }
  assert.ok(board.includes("<ReadingEverything error={everythingRead.error} onRetry={reloadEverything} />"), "it says what it is reading, and offers Try again when the read fails");

  const button = read("src/components/place-review-deck/review-deck-button.tsx");
  // Since 23 Nov 2026 the review opens on the press, on what waits; the tabs built from every place in use
  // are listed once the rest is in (`deckTabNeedsEveryPlace`, pinned in tests/place-review-deck.test.ts).
  assert.ok(
    button.includes("{start ? <PlaceReviewDeck input={input} onClose={close} rest={{ ready, error: rows.error, retry: rows.retry }} start={start} /> : null}"),
    "🔴 the review opens at once, and is told whether the board holds every row yet",
  );
  assert.match(button, /if \(start && !ready\) want\(\);/, "and asks for the rest when it is to open, `?review=` included");

  const portal = read("app/employee-portals/place-checks/page.tsx");
  assert.ok(!portal.includes("onDemand"), "a district manager's board is still handed its whole team, as before");
}

function checkTheHandoff() {
  const omar = placeChecksHandoffKey({ hrId: "B-10", role: "Super Admin", isTestPersona: false } as never);
  const sfe = placeChecksHandoffKey({ hrId: "SFE-1", role: "SFE Manager", isTestPersona: false } as never);
  const rows = (tag: string) => ({
    validated: [inUse(tag, "Rep")],
    olderDecided: [],
    decisionFigures: { approved: 0, rejected: 0 },
    noteIndex: { notes: {}, recommendations: {}, integrity: {} } as unknown as PlaceNoteIndex,
    capped: { reviews: false, validated: false },
  });
  const t0 = 1_000_000;

  keepPlaceChecksForTheClick(omar, rows("first"), t0);
  keepPlaceChecksForTheClick(omar, rows("second"), t0 + 10);
  assert.equal(takePlaceChecksForTheClick(sfe, t0 + 20), null, "🔴 one person never takes another's rows");
  assert.equal(takePlaceChecksForTheClick(omar, t0 + 20)?.validated[0].placeId, "second", "the click takes the newest read");
  assert.equal(takePlaceChecksForTheClick(omar, t0 + 30), null, "🔴 taken once: a second click reads for itself");

  keepPlaceChecksForTheClick(omar, rows("late"), t0);
  assert.equal(takePlaceChecksForTheClick(omar, t0 + PLACE_CHECKS_HANDOFF_MS + 1), null, "🔴 never older than two minutes");
  assert.equal(takePlaceChecksForTheClick(omar, t0 + 1), null, "and an expired entry is gone, not kept for later");
  assert.notEqual(
    placeChecksHandoffKey({ hrId: "B-10", role: "Super Admin", isTestPersona: true } as never),
    omar,
    "a test account's rows are never the real account's",
  );
}

/**
 * 🔴 THE TWO DECISION CARDS COUNT THE LAST 14 DAYS BY THE DAY OF THE DECISION (owner, 23 Nov 2026: "Fix what
 * is under 9.5"). A rejection that can still be taken back stays on the board for 90 days and is `recent`
 * all that time, so the card that counted `recent` rows read 733 under "Rejected, last 14 days" when 570
 * had been rejected in those 14 days (production, 23 Nov 2026).
 */
function checkTheDecisionCards() {
  const now = Date.parse("2026-11-23T12:00:00.000Z");
  const since = now - 14 * 86_400_000;
  const day = (daysAgo: number) => new Date(now - daysAgo * 86_400_000).toISOString();
  const decided = [
    review("a-today", day(40), { status: "approved", decidedAt: day(0) }),
    review("a-edge", day(40), { status: "approved", decidedAt: new Date(since).toISOString() }),
    review("r-week", day(40), { status: "rejected", decidedAt: day(7) }),
    // Rejected 30 days ago and still restorable: on the board, `recent`, and not a rejection of these 14 days.
    review("r-restorable", day(40), { status: "rejected", decidedAt: day(30), recent: true }),
    review("a-old", day(90), { status: "approved", decidedAt: day(60), recent: false }),
    review("a-test", day(3), { status: "approved", decidedAt: day(1), isTest: true }),
    review("r-undated", day(3), { status: "rejected", decidedAt: null }),
  ];
  assert.deepEqual(decisionFiguresSince(decided, since), { approved: 2, rejected: 1 }, "🔴 HEADLINE: a decision counts by the day it was made; a rejection that is only still restorable does not, nor a test entry, nor a row with no decision time");
  assert.deepEqual(decisionFiguresSince(decided, Number.NEGATIVE_INFINITY), { approved: 3, rejected: 2 }, "with no start, every real dated decision counts");
  assert.deepEqual(decisionFiguresSince([], since), { approved: 0, rejected: 0 }, "no decisions is a true zero");

  const input = { team: false, lanes: true, pending: [], decided, validated: [], reopened: [], sharedPlaces: [] };
  assert.deepEqual(placeChecksSummary({ ...input, decidedSince: since }).decisionFigures, { approved: 2, rejected: 1 }, "🔴 the figures' read answers the same two numbers, from the start it is handed");
  assert.deepEqual(placeChecksSummary(input).decisionFigures, { approved: 3, rejected: 2 }, "handed no start, it counts every decision it was given");
}

export async function runPhoenixCrmPlaceChecksOnDemandTests() {
  checkTheDecisionCards();
  checkTheOpeningFigures();
  checkTheHandoff();
  checkTheMergedDecisions();
  checkTheDecisionsThatWait();
  checkTheWiring();
}
