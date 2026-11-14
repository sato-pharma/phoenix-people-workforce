import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
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
import { EMPTY_VALIDATION_REVIEW_FILTERS } from "../src/lib/phoenix-crm/validation-review-filters.ts";
import type { PlaceNoteIndex, ReopenedCustomerRow, SharedPlaceBoardRow, ValidatedPlaceRow, ValidationReviewRow } from "../src/lib/phoenix-crm/view-types.ts";
import { stripComments } from "./support/comment-strip.ts";

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
 * - the review opening on the seated few instead of every place.
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

function checkTheWiring() {
  const page = read("app/(admin)/admin/field-crm/validation-reviews/page.tsx");
  assert.match(page, /placeChecksSummary\(\{ team: false, pending: waiting, decided, validated, reopened, sharedPlaces \}\)/, "🔴 the figures are counted from every row the page read");
  for (const prop of ["validated={seatedInUse}", "decided={recentDecided}", "onDemand={onDemand}"]) {
    assert.ok(page.includes(prop), `the page hands the board ${prop}`);
  }
  assert.ok(!page.includes("validated={validated}"), "🔴 the page never hands the board every place in use again (7.4 MB, the freeze)");
  assert.ok(!page.includes("decided={decided}"), "🔴 nor every decision ever made");
  assert.match(page, /const recentDecided = decided\.filter\(\(row\) => row\.recent\);/, "the decisions it sends are the board's default window");

  const route = read("app/api/phoenix-crm/validation-reviews/everything/route.ts");
  assert.equal(PLACE_CHECKS_EVERYTHING_ROUTE, "/api/phoenix-crm/validation-reviews/everything", "the board asks the route that exists");
  const handler = route.slice(route.indexOf("export async function GET("));
  const gate = handler.indexOf('assertPermission(access, "phoenix_crm", "approve")');
  const decider = handler.indexOf("if (!canDecideValidationReviews(viewer)) throw forbiddenError(");
  const firstRow = handler.indexOf("takePlaceChecksForTheClick(placeChecksHandoffKey(viewer)) ?? (await readEverything(viewer))");
  assert.ok(gate > 0 && decider > gate && firstRow > decider, "🔴 the route asks `approve`, then the decider, before a row is taken or read — the page's own two gates");
  assert.match(
    page,
    /keepPlaceChecksForTheClick\(placeChecksHandoffKey\(viewer\), \{ validated, olderDecided: reviews\.rows\.filter\(\(row\) => !row\.recent\) \}\)/,
    "the page leaves what it read for the click, under the same person's key",
  );
  assert.match(route, /olderDecided: reviews\.rows\.filter\(\(row\) => !row\.recent\)/, "it answers only the decisions the page did not send");
  assert.match(route, /NextResponse\.json\(\{ everything, success: true \}\)/, "under the key the board reads");

  const board = read("src/components/phoenix-crm/validation-reviews-board.tsx");
  assert.ok(
    board.includes('useCrmGet<PlaceChecksEverything>(onDemand && wanted ? PLACE_CHECKS_EVERYTHING_ROUTE : null, "everything")'),
    "🔴 the board reads by the key the route answers under, and only once it is wanted",
  );
  assert.match(board, /if \(onDemand && !wanted && \(view === "unconfirmed" \|\| filtering \|\| deckAsked\)\) setWanted\(true\);/, "Not confirmed, any filter or the review asks for the rest");
  assert.match(board, /if \(wanted\) reloadEverything\(\);/, "a re-read of the page reads the rest again");
  assert.match(board, /complete \? placeCheckScorecardOf\(/, "🔴 the board counts the scorecard only once it holds every row");
  assert.match(board, /const reading = !complete && \(filtering \|\| view === "unconfirmed"\);/, "it knows when a tab would draw part of a list");
  for (const view of ["needs", "unconfirmed", "polyclinics", "history"]) {
    assert.ok(board.includes(`{!reading && view === "${view}" ? (`), `🔴 the ${view} tab is never drawn from part of its rows`);
  }
  assert.ok(board.includes("<ReadingEverything error={everythingRead.error} onRetry={reloadEverything} />"), "it says what it is reading, and offers Try again when the read fails");

  const button = read("src/components/place-review-deck/review-deck-button.tsx");
  assert.ok(button.includes("{start && ready ? <PlaceReviewDeck"), "🔴 the review opens only on every row");
  assert.match(button, /if \(start && !ready\) want\(\);/, "and asks for them when it is to open, `?review=` included");

  const portal = read("app/employee-portals/place-checks/page.tsx");
  assert.ok(!portal.includes("onDemand"), "a district manager's board is still handed its whole team, as before");
}

function checkTheHandoff() {
  const omar = placeChecksHandoffKey({ hrId: "B-10", role: "Super Admin", isTestPersona: false } as never);
  const sfe = placeChecksHandoffKey({ hrId: "SFE-1", role: "SFE Manager", isTestPersona: false } as never);
  const rows = (tag: string) => ({ validated: [inUse(tag, "Rep")], olderDecided: [] });
  const t0 = 1_000_000;

  keepPlaceChecksForTheClick(omar, rows("first"), t0);
  keepPlaceChecksForTheClick(omar, rows("second"), t0 + 10);
  assert.equal(takePlaceChecksForTheClick(sfe, t0 + 20), null, "🔴 one person never takes another's rows");
  assert.equal(takePlaceChecksForTheClick(omar, t0 + 20)?.validated[0].placeId, "second", "the click takes the newest read of the page");
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

export async function runPhoenixCrmPlaceChecksOnDemandTests() {
  checkTheOpeningFigures();
  checkTheHandoff();
  checkTheMergedDecisions();
  checkTheWiring();
}
