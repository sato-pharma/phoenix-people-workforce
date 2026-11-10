import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";
import { createPlaceCheckReread, PLACE_CHECK_REREAD_QUIET_MS } from "../src/components/phoenix-crm/place-check-reread.ts";

import {
  adviceOnSubject,
  buildDeckSlides,
  DECK_TABS,
  deckAdviceRank,
  deckAdviceRanker,
  deckSlideAdvice,
  deckArrowStep,
  deckSeatItem,
  deckSlideKey,
  deckSourcesOf,
  deckStartOfBoardView,
  deckTabNeedsCases,
  parseDeckTab,
  placeAwaitsNewPhoto,
  placeIsUnreadable,
  reviewIsUnreadable,
  slideIsSettled,
  summarizeDeckOutcomes,
  venueIsUnreadable,
  venueLiveItems,
  type DeckSources,
  type PlaceReviewDeckInput,
} from "../src/lib/place-review-deck/slides.ts";
import { standingOfPlaceInUse } from "../src/lib/phoenix-crm/place-check-scorecard.ts";
import { parsePlaceNoteAdvice, placeNoteAdviceLabel } from "../src/lib/phoenix-crm/place-note-rules.ts";
import type { VenueGroup } from "../src/lib/phoenix-crm/shared-place-groups.ts";
import type { PlaceNoteIndex, ValidatedPlaceRow, ValidationReviewRow } from "../src/lib/phoenix-crm/view-types.ts";

/**
 * Place checks — the one-by-one review (owner, 2026-10-18: "I want to have the picture in a very wide
 * space in the screen and a column on the right having all the data I need … validate from this screen
 * or reject or approve. Then press next … like sliding instead of opening").
 *
 * What is pinned, and why each half matters:
 *   1. what each tab holds, the Places / Polyclinics / Both switch, and "All" with every slide once;
 *   2. when a slide may slide on by itself — a polyclinic only once its building AND every waiting
 *      customer are answered;
 *   3. the arrows never move while he types, holds a modifier or has the zoom open, and no key decides;
 *   4. the review is not a second decision path: every decision control reports through
 *      `usePlaceCheckDone`, and nothing the review adds posts anything;
 *   5. it is the Super Admin's alone, and none of it reaches a district manager's portal bundle;
 *   6. the dialog is a real dialog, the house rules hold on every new file, and the cases route reads
 *      the board's own loader.
 */

const ROOT = new URL("../", import.meta.url);

function read(path: string): string {
  return readFileSync(new URL(path, ROOT), "utf8");
}

const NEW_FILES = [
  "src/components/place-review-deck/review-deck.tsx",
  "src/components/place-review-deck/review-deck-button.tsx",
  "src/components/place-review-deck/place-checks-with-deck.tsx",
  "src/components/place-review-deck/deck-parts.tsx",
  "src/components/place-review-deck/deck-cases.ts",
  "src/components/crm-integrity/integrity-review-slide.tsx",
  "src/components/phoenix-crm/place-check-done.tsx",
] as const;

/** The body of one top-level function, up to the next top-level declaration. */
function functionBody(source: string, name: string): string {
  const start = source.search(new RegExp(`\\n(?:export )?function ${name}\\(`));
  assert.ok(start >= 0, `function ${name} must still exist — this check has lost its anchor`);
  const rest = source.slice(start + 1);
  const end = rest.slice(1).search(/\n(?:export )?(?:async )?(?:function|const|type|export \{)/);
  return end < 0 ? rest : rest.slice(0, end + 1);
}

function sources(): DeckSources {
  return {
    waitingReviews: ["r1", "r2"],
    waitingVenues: ["v-held"],
    unreadableReviews: ["r-blur"],
    unreadablePlaces: ["p-blur"],
    unreadableVenues: ["v-blur"],
    unconfirmedPlaces: ["p1"],
    unconfirmedVenues: ["v-held", "v-active"],
    newPhotoPlaces: ["p-retake"],
    historyReviews: ["r3"],
    historyVenues: ["v-retired"],
    cases: [
      { id: "c1", polyclinic: false },
      { id: "c2", polyclinic: true },
    ],
  };
}

function venue(status: "active" | "held" | "retired", customers: Array<{ key: string; state: string }>): Pick<VenueGroup, "venue" | "customers"> {
  return {
    venue: { sharedPlaceId: "v1", status } as unknown as VenueGroup["venue"],
    customers: customers as unknown as VenueGroup["customers"],
  };
}

export function runPlaceReviewDeckTests(): void {
  // ── 1 · What each tab holds ────────────────────────────────────────────────────────────────────
  const keys = (tab: Parameters<typeof buildDeckSlides>[0], kind: Parameters<typeof buildDeckSlides>[1] = "both", from = sources()) =>
    buildDeckSlides(tab, kind, from).map((slide) => slide.key);

  assert.deepEqual(DECK_TABS, ["waiting", "unreadable", "unconfirmed", "newPhoto", "integrity", "history", "all"], "the tabs, in the order the work is done");
  assert.deepEqual(keys("newPhoto"), ["place:p-retake"], "New photo asked is the places waiting on their rep's new photo");
  assert.deepEqual(keys("waiting"), ["review:r1", "review:r2", "venue:v-held"], "Waiting is the held places, then the buildings that need a decision");
  assert.deepEqual(keys("unreadable"), ["review:r-blur", "place:p-blur", "venue:v-blur"], "Not readable is the held places, then the places in use, then the buildings");
  assert.deepEqual(keys("unconfirmed"), ["place:p1", "venue:v-held", "venue:v-active"], "Not confirmed is the places in use, then the buildings");
  assert.deepEqual(keys("history"), ["review:r3", "venue:v-retired"], "History is the decided places, then the rejected buildings");
  assert.deepEqual(keys("integrity"), ["case:c1", "case:c2"], "Integrity cases is the open cases, in the board's order");
  assert.deepEqual(
    keys("all"),
    ["review:r1", "review:r2", "venue:v-held", "review:r-blur", "place:p-blur", "venue:v-blur", "place:p1", "venue:v-active", "place:p-retake", "case:c1", "case:c2", "review:r3", "venue:v-retired"],
    "All walks every tab in order and keeps each slide ONCE — the held building is in Waiting and among the buildings in use",
  );
  assert.equal(new Set(keys("all")).size, keys("all").length, "All holds no slide twice");

  // Not readable (owner, 2026-10-19: "in the review one by one put the unreadable in a separate tab").
  {
    const blurredSign = { verdict: "unjudged", reason: "unreadable", signText: null, problem: "blurred" };
    const review = (reviewId: string, extra: Record<string, unknown>) =>
      ({ reviewId, photoKind: "signboard", reason: "no_confident_listing", evidence: { checkReason: null, heldBecause: null, problem: null, signboard: null }, ...extra }) as unknown as ValidationReviewRow;
    const place = (placeId: string, signboard: unknown, extra: Record<string, unknown> = {}) =>
      ({ placeId, reviewed: false, photoKind: "signboard", signboard, schedule: null, ...extra }) as unknown as ValidatedPlaceRow;
    const group = (id: string, signboard: unknown, customers: Array<{ state: string; timetable: unknown }>) =>
      ({ venue: { sharedPlaceId: id, status: "active", signboard }, customers, total: customers.length }) as unknown as VenueGroup;

    const reviews = [
      review("r-clear", {}),
      review("r-sign", { evidence: { checkReason: null, heldBecause: null, problem: null, signboard: blurredSign } }),
      review("r-sign-named", { reason: "sign_other_name", evidence: { checkReason: null, heldBecause: null, problem: null, signboard: blurredSign } }),
      review("r-timetable", { photoKind: "schedule", reason: null, evidence: { checkReason: null, heldBecause: "timetable_unreadable", problem: null, signboard: null } }),
      review("r-not-a-timetable", { photoKind: "schedule", reason: null, evidence: { checkReason: "unreadable", heldBecause: null, problem: "not_a_timetable", signboard: null } }),
    ];
    const places = [
      place("p-clear", { verdict: "match", reason: null, signText: "x" }),
      place("p-sign", blurredSign),
      place("p-legible", { verdict: "unjudged", reason: "unreadable", signText: null, problem: "none" }),
      place("p-approved", blurredSign, { reviewed: true }),
      place("p-retake", { ...blurredSign, reason: "unreadable_final", retake: true }),
    ];
    const unreadableTimetable = { verdict: "unjudged", scheduleText: null, hoursRead: null, reason: "unreadable" };
    const venues = {
      clear: group("v-clear", { verdict: "match", reason: null, signText: "x", note: null }, [{ state: "in_use", timetable: { verdict: "match" } }]),
      sign: group("v-sign", { verdict: "unjudged", reason: "unreadable_final", signText: null, note: null }, []),
      seat: group("v-seat", null, [{ state: "waiting", timetable: unreadableTimetable }]),
      past: group("v-past", null, [{ state: "rejected", timetable: unreadableTimetable }]),
    };
    const input = {
      boardView: "needs",
      noteIndex: {},
      waiting: { reviews, venues: [venues.seat, venues.clear] },
      unconfirmed: { places, venues: [venues.clear, venues.sign, venues.past] },
      history: { reviews: [], venues: [] },
      lookup: { reviews, places, venues: Object.values(venues) },
    } as unknown as PlaceReviewDeckInput;
    const split = deckSourcesOf(input, []);
    assert.deepEqual(split.unreadableReviews, ["r-sign", "r-timetable"], "a held place whose sign or timetable could not be read is Not readable");
    assert.deepEqual(split.waitingReviews, ["r-clear", "r-sign-named", "r-not-a-timetable"], "and is MOVED out of Waiting — a sign naming somebody else, or a photo that is no timetable, stays");
    assert.deepEqual(split.unreadablePlaces, ["p-sign"], "a place in use is Not readable exactly when the scorecard counts it so");
    assert.deepEqual(split.unconfirmedPlaces, ["p-clear", "p-legible", "p-approved"], "and is MOVED out of Not confirmed — a legible sign, or one he approved, stays");
    assert.deepEqual(split.newPhotoPlaces, ["p-retake"], "a place whose rep was asked for a new photo leaves Not readable for New photo asked (owner, 2026-10-19: only what needs you)");
    assert.equal(placeAwaitsNewPhoto(places[4]), true);
    assert.deepEqual(split.unreadableVenues, ["v-seat", "v-sign"], "a polyclinic whose sign, or a waiting customer's timetable, could not be read is Not readable");
    assert.deepEqual([split.waitingVenues, split.unconfirmedVenues], [["v-clear"], ["v-clear", "v-past"]], "and leaves both tabs; a rejected customer's unread timetable is past the reading");
    const all = buildDeckSlides("all", "both", split).map((slide) => slide.key);
    assert.equal(new Set(all).size, all.length, "with Not readable in it, All still holds each slide once");
    assert.equal(all.length, reviews.length + places.length + 4, "and loses none: every held place, place in use and building is in All");
    for (const row of places) {
      assert.equal(placeIsUnreadable(row), standingOfPlaceInUse(row as Parameters<typeof standingOfPlaceInUse>[0]) === "notReadable", `the tab and the scorecard agree on ${row.placeId}`);
    }
    assert.equal(reviewIsUnreadable(reviews[1]), true);
    assert.equal(venueIsUnreadable(venues.past), false);
  }

  // The switch (owner, 2026-10-18: "view polyclinics only, or places only, or both").
  assert.deepEqual(keys("waiting", "places"), ["review:r1", "review:r2"], "Places keeps the places alone");
  assert.deepEqual(keys("waiting", "polyclinics"), ["venue:v-held"], "Polyclinics keeps the buildings alone");
  assert.deepEqual(keys("integrity", "polyclinics"), ["case:c2"], "a case filed on a polyclinic counts as a polyclinic");
  assert.deepEqual(keys("integrity", "places"), ["case:c1"], "and every other case as a place");
  assert.equal(keys("all", "places").length + keys("all", "polyclinics").length, keys("all", "both").length, "Places and Polyclinics together are Both, nothing lost and nothing twice");

  // The cases are read only when a tab needs them; before that the tab holds none of them.
  assert.deepEqual(keys("integrity", "both", { ...sources(), cases: null }), [], "no cases until they have been read");
  assert.equal(deckTabNeedsCases("integrity"), true);
  assert.equal(deckTabNeedsCases("all"), true, "All waits for the cases rather than shifting every History slide when they arrive");
  assert.equal(deckTabNeedsCases("waiting"), false, "the place tabs never pay for a read of the cases");

  // Where it opens.
  assert.equal(parseDeckTab("integrity"), "integrity", "?review=integrity is the Location integrity page's link");
  assert.equal(parseDeckTab("approve"), null, "anything else opens nothing");
  assert.equal(parseDeckTab(null), null);
  assert.deepEqual(deckStartOfBoardView("needs"), { tab: "waiting", kind: "both" }, "from Needs you, the waiting ones");
  assert.deepEqual(deckStartOfBoardView("unconfirmed"), { tab: "unconfirmed", kind: "places" }, "from Not confirmed, the single places in use");
  assert.deepEqual(deckStartOfBoardView("polyclinics"), { tab: "all", kind: "polyclinics" }, "from the polyclinic tab, every building");
  assert.deepEqual(deckStartOfBoardView("history"), { tab: "history", kind: "both" });
  assert.deepEqual(deckStartOfBoardView("samePlace"), { tab: "waiting", kind: "both" }, "the comparison tab has no photo of its own to review, so the review opens on Waiting");

  // ── 2 · When a slide slides on by itself ─────────────────────────────────────────────────────────
  assert.equal(slideIsSettled({ live: ["review:r1"], decided: [] }), false, "nothing decided here — it never moves on by itself");
  assert.equal(slideIsSettled({ live: [], decided: [] }), false, "a slide answered elsewhere does not slide past him unasked");
  assert.equal(slideIsSettled({ live: ["review:r1"], decided: ["review:r1"] }), true, "the one thing on it decided — on to the next");
  assert.equal(slideIsSettled({ live: [], decided: ["place:p1"] }), true, "a refused place has left the list and is answered");

  const held = venue("held", [
    { key: "a", state: "waiting" },
    { key: "b", state: "waiting" },
    { key: "c", state: "in_use" },
  ]);
  const live = venueLiveItems(held);
  assert.deepEqual(live, [deckSlideKey("venue", "v1"), deckSeatItem("a"), deckSeatItem("b")], "a held building waits on itself and on every customer the system is still checking");
  assert.equal(slideIsSettled({ live, decided: [deckSlideKey("venue", "v1")] }), false, "the building approved with two customers still waiting stays put");
  assert.equal(slideIsSettled({ live, decided: [deckSlideKey("venue", "v1"), deckSeatItem("a")] }), false, "and with one still waiting");
  assert.equal(slideIsSettled({ live, decided: [deckSlideKey("venue", "v1"), deckSeatItem("a"), deckSeatItem("b")] }), true, "only once every waiting customer is answered");
  assert.ok(!live.includes(deckSeatItem("c")), "a customer already in use is his to reject or not — nothing waits on him");
  assert.deepEqual(
    venueLiveItems(venue("retired", [{ key: "a", state: "waiting" }])),
    [deckSeatItem("a")],
    "a rejected building is not itself waiting; a customer still being checked in it is",
  );

  // ── 3 · The arrows, and no key that decides ─────────────────────────────────────────────────────
  const arrow = (key: string, overrides: Partial<Parameters<typeof deckArrowStep>[0]> = {}) =>
    deckArrowStep({ key, typing: false, modifier: false, otherDialogOpen: false, ...overrides });
  assert.equal(arrow("ArrowRight"), 1);
  assert.equal(arrow("ArrowLeft"), -1);
  assert.equal(arrow("ArrowRight", { typing: true }), 0, "never while he types a note — the arrows move the caret there");
  assert.equal(arrow("ArrowRight", { modifier: true }), 0, "never with a modifier held");
  assert.equal(arrow("ArrowRight", { otherDialogOpen: true }), 0, "never while the zoomed photo is open over the review");
  for (const key of ["Enter", " ", "a", "r", "Delete"]) assert.equal(arrow(key), 0, `${JSON.stringify(key)} does nothing: these are live places`);

  assert.deepEqual(
    summarizeDeckOutcomes(["Approved", "Rejected", "Approved"]),
    [
      { outcome: "Approved", count: 2 },
      { outcome: "Rejected", count: 1 },
    ],
    "the panel that closes a tab counts what was decided, most first",
  );

  // ── 4 · One decision path: the board's own controls, reporting through one hook ─────────────────
  const CONTROLS: ReadonlyArray<[string, ReadonlyArray<string>]> = [
    ["src/components/phoenix-crm/validation-review-queue.tsx", ["Decision", "RejectAfterApproval"]],
    // The take-back of a rejection is one control since 2026-11-10, drawn by the queue and a seated customer alike.
    ["src/components/phoenix-crm/place-check-restore.tsx", ["RestoreAfterRejection"]],
    ["src/components/phoenix-crm/validated-place-list.tsx", ["Approve", "Refuse"]],
    ["src/components/phoenix-crm/shared-place-list.tsx", ["Decision", "RestoreVenue"]],
    ["src/components/phoenix-crm/shared-place-customers.tsx", ["RejectNotOnTimetable", "WaitingDecision"]],
    ["src/components/crm-integrity/integrity-settle.tsx", ["IntegritySettleControl"]],
  ];
  for (const [path, names] of CONTROLS) {
    const code = stripComments(read(path));
    for (const name of names) {
      const body = functionBody(code, name);
      assert.match(body, /const done = usePlaceCheckDone\(\);/, `${path} ${name} must report a saved decision through usePlaceCheckDone, or the review never slides on`);
      // A literal or a choice between literals: `done(decision === "approve" ? "approved" : "rejected")`.
      assert.match(body, /done\([^;\n]*"[a-z]+"[^;\n]*\);/, `${path} ${name} must say what it decided`);
      assert.doesNotMatch(body, /router\.refresh\(\)/, `${path} ${name} refreshes through the hook, never beside it`);
    }
  }
  for (const [path, name] of [
    ["src/components/phoenix-crm/validation-review-queue.tsx", "Restore"],
    ["src/components/phoenix-crm/shared-place-customers.tsx", "RestoreSeated"],
  ] as const) {
    assert.match(functionBody(stripComments(read(path)), name), /<RestoreAfterRejection/, `${path} ${name} draws the one take-back control, which reports through usePlaceCheckDone`);
  }
  {
    const hook = stripComments(read("src/components/phoenix-crm/place-check-done.tsx"));
    assert.match(functionBody(hook, "usePlaceCheckDone"), /scope\?\.done\(scope\.item, outcome\);\s*placeCheckReread\.ask\(\(\) => router\.refresh\(\)\);/, "outside the review the hook still re-reads the page, through the one shared wait");
    assert.doesNotMatch(functionBody(hook, "usePlaceCheckDone"), /^\s*router\.refresh\(\);/m, "never a re-read of its own beside it");
  }

  // ── 4a · One re-read for a run of decisions (2026-11-01, "fix the portal home slow opens"): each one
  // rebuilt the module's heaviest page, and every read in the company slowed while the builds overlapped ──
  {
    // A clock the test turns by hand.
    let now = 0;
    const timers = new Map<number, { at: number; run: () => void }>();
    let nextHandle = 0;
    const clock = {
      clear: (handle: number) => void timers.delete(handle),
      set: (run: () => void, ms: number) => {
        nextHandle += 1;
        timers.set(nextHandle, { at: now + ms, run });
        return nextHandle;
      },
    };
    const advanceTo = (time: number) => {
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= time).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = due[1].at;
        timers.delete(due[0]);
        due[1].run();
      }
      now = time;
    };

    // The fourteen approvals of 10:45 to 10:50 Cairo on Sunday 1 Nov 2026, in seconds, as production logged them.
    const pressed = [7, 19, 46, 58, 63, 74, 88, 106, 133, 145, 180, 195, 248, 273];
    let reads = 0;
    const reread = createPlaceCheckReread<number>(clock);
    for (const second of pressed) {
      advanceTo(second * 1000);
      reread.ask(() => {
        reads += 1;
      });
    }
    assert.equal(reads, 2, "only the two pauses over the quiet time read the page while he works");
    advanceTo(273_000 + PLACE_CHECK_REREAD_QUIET_MS);
    assert.equal(reads, 3, "and the last decision is always read, once the quiet time has passed: three builds for fourteen decisions, not fourteen");
    advanceTo(600_000);
    assert.equal(reads, 3, "and nothing more arrives afterwards");

    reread.ask(() => {
      reads += 1;
    });
    reread.flush();
    assert.equal(reads, 4, "leaving the one-by-one review reads at once");
    advanceTo(1_200_000);
    assert.equal(reads, 4, "and the wait it replaced never fires as well");
    reread.flush();
    assert.equal(reads, 4, "with nothing waiting, leaving the review reads nothing");

    const button = stripComments(read("src/components/place-review-deck/review-deck-button.tsx"));
    assert.match(functionBody(button, "PlaceReviewDeckButton"), /placeCheckReread\.flush\(\);/, "the review's close hands the board its fresh rows");
  }

  // ── 4b · A saved decision releases its button at once (owner, 2026-10-24: "when i press approve its
  // staled do approving and grey out to forever") — never "Approving…" until the page's re-read lands ──
  {
    const hook = stripComments(read("src/components/phoenix-crm/place-check-done.tsx"));
    assert.match(functionBody(hook, "usePlaceCheckDone"), /return outcome;/, "the hook hands the outcome back, so a control can mark it saved");
    const savedHook = functionBody(hook, "useSavedOutcome");
    assert.match(savedHook, /JSON\.stringify\(subject\)/, "the saved outcome is tied to the row as it was when the button was pressed");
    assert.match(savedHook, /mark\.snapshot === snapshot/, "a re-read that changes the row hands it back to the server's own view, undo included");
    // 4c · Stale rows (owner, 2026-11-08: "places checks is stale … many error"). The saved mark was
    // component state, so a list that remounted forgot it and the decided row stood with live buttons
    // until the re-read — the next press answered "This place was already decided".
    assert.match(savedHook, /SAVED_MARKS\.get\(snapshot\)/, "the saved mark is read from the tab's store, so a remounted list still knows the row was decided");
    assert.doesNotMatch(savedHook, /useState<\{ outcome/, "never component state again: a tab change or a filter would forget it");
    assert.match(hook, /^const SAVED_MARKS = new Map</m, "the store lives at module level, outside every control");
    const already = functionBody(hook, "isAlreadyDecided");
    assert.match(already, /ALREADY_DECIDED_CODES\.has\(code\)/, "an already-decided refusal is read by its code, never its words");
    for (const code of ["phoenix_crm_review_decided", "phoenix_crm_full_name_not_held"]) {
      assert.ok(hook.includes(`"${code}"`), `${code} — the two refusals the SFE Manager met on 8 Nov — settle the row`);
    }
  }
  for (const [path, names] of CONTROLS) {
    if (path.includes("crm-integrity/")) continue; // useCrmAction answers its own refusals
    const code = stripComments(read(path));
    for (const name of names) {
      assert.match(
        functionBody(code, name),
        /if \(isAlreadyDecided\(error\)\) \{\s*markSaved\(done\("already"\)\);\s*setSaving\((?:false|null)\);\s*return;/,
        `${path} ${name}: a row decided already draws "Already decided", never a red error`,
      );
    }
  }
  {
    // The doctors' full names on the same page decided like no other control there.
    const names = stripComments(read("src/components/phoenix-crm/full-name-checks.tsx"));
    const body = functionBody(names, "FullNameDecision");
    assert.match(body, /const \{ saved, markSaved \} = useSavedOutcome\(row\);/, "a decided name draws its outcome at once");
    assert.match(body, /if \(saved\) return <PlaceCheckSaved outcome=\{saved\} \/>;/, "and no button to press twice");
    assert.match(body, /placeCheckReread\.ask\(\(\) => router\.refresh\(\)\)/, "one re-read for a run of decisions, never a whole-page rebuild per press");
    assert.doesNotMatch(names.replace(/placeCheckReread\.ask\(\(\) => router\.refresh\(\)\)/g, ""), /router\.refresh\(\)/, "no bare refresh anywhere in the file");
    assert.match(body, /if \(isAlreadyDecided\(error\)\) \{/, "an already-decided name settles the row");
    assert.doesNotMatch(names, /payload\.error/, "the refusal's sentence is shown, never its raw code");
    // And the page's comments and evidence start with the three lists that name the subjects.
    const page = stripComments(read("app/(admin)/admin/field-crm/validation-reviews/page.tsx"));
    assert.match(page, /subjectReads\.then\(\(\[reviewRows, validatedRows, sharedRows\]\) =>/, "the notes and evidence never wait for the reopened customers or the held names");
  }
  for (const [path, names] of CONTROLS) {
    if (path.includes("crm-integrity/")) continue; // useCrmAction already releases its own busy state
    const code = stripComments(read(path));
    for (const name of names) {
      const body = functionBody(code, name);
      assert.match(body, /const \{ saved, markSaved \} = useSavedOutcome\((?:row|customer)\);/, `${path} ${name} must hold its saved outcome against its own row`);
      const calls = body.match(/\bdone\(/g) ?? [];
      const wrapped = body.match(/markSaved\(done\(/g) ?? [];
      assert.ok(calls.length > 0 && wrapped.length === calls.length, `${path} ${name}: every saved decision is marked saved the moment the server says yes (${wrapped.length} of ${calls.length})`);
      assert.match(body, /markSaved\(done\([^;]*\)\);\s*setSaving\((?:false|null)\);/, `${path} ${name} lets go of its busy state on success, not only on failure`);
      const savedAt = body.search(/if \(saved\) return <PlaceCheckSaved outcome=\{saved\} \/>;/);
      assert.ok(savedAt >= 0, `${path} ${name} draws the saved outcome instead of its buttons once the decision is saved`);
      const firstButton = body.search(/<CrmButton/);
      assert.ok(firstButton < 0 || savedAt < firstButton, `${path} ${name} checks the saved outcome before any button can be drawn`);
    }
  }
  for (const path of NEW_FILES) {
    const code = stripComments(read(path));
    if (path.endsWith("deck-cases.ts")) {
      assert.doesNotMatch(code, /crmPost|method:\s*"(?:POST|PATCH|DELETE)"/, `${path} only reads`);
      continue;
    }
    assert.doesNotMatch(code, /crmPost|crmPatch|fetch\(|method:\s*"/, `${path} must post nothing of its own — every decision is a control the board already had`);
  }
  {
    const deck = stripComments(read("src/components/place-review-deck/review-deck.tsx"));
    assert.match(deck, /<PlaceCheckDoneProvider item=\{current\.key\} key=\{current\.key\} onDone=\{record\}>/, "every control on the slide reports to the review");
    assert.match(deck, /<PlaceCheckDoneItem item=\{deckSlideKey\("venue", venue\.sharedPlaceId\)\}>/, "a polyclinic's building is answered on its own");
    assert.match(deck, /<PlaceCheckDoneItem item=\{deckSeatItem\(customer\.key\)\}>/, "and each customer seated in it on his own");
    assert.match(deck, /const step = deckArrowStep\(/, "the keys go through the one rule pinned above");
    assert.match(deck, /lastDecision\.slideKey !== current\.key \|\| !settled/, "it slides on only after a decision on THIS slide, never on one he came Back to");
  }

  // ── 5 · The Super Admin's alone, and in none of the portal's bundles ────────────────────────────
  {
    const board = stripComments(read("src/components/phoenix-crm/validation-reviews-board.tsx"));
    assert.match(board, /const withDeck = !team && reviewDeck !== undefined;/, "a district manager's board is never handed the review");
    const imports = board.match(/import[^;]*from "@\/(?:lib|components)\/place-review-deck\/[^"]+";/g) ?? [];
    assert.ok(imports.length > 0, "the board names the review's input type");
    for (const line of imports) assert.match(line, /^import type /, `the board imports types only from the review: ${line}`);
    const page = stripComments(read("app/(admin)/admin/field-crm/validation-reviews/page.tsx"));
    assert.match(page, /<PlaceChecksWithDeck/, "the Super Admin's page is the one that hands the review in");
    assert.match(page, /canDecideValidationReviews\(viewer\)\) redirect\("\/admin"\)/, "and that page is his alone");
    const wrapper = stripComments(read("src/components/place-review-deck/place-checks-with-deck.tsx"));
    assert.match(wrapper, /mode="company"/, "the wrapper draws the company board only");
    const integrity = stripComments(read("app/(admin)/admin/phoenix-crm/integrity/page.tsx"));
    assert.match(integrity, /canSettle && board\.cases\.length > 0 \?/, "the link from Location integrity is behind the Super Admin's own flag — the SFE Manager would be turned away");
    assert.match(integrity, /href="\/admin\/field-crm\/validation-reviews\?review=integrity"/);
  }

  // ── 6 · A real dialog, the house rules, and the cases read through the board ─────────────────────
  {
    const deck = stripComments(read("src/components/place-review-deck/review-deck.tsx"));
    assert.match(deck, /useDialogA11y<HTMLDivElement>\(\{ open: hydrated, onClose: close \}\)/, "focus held inside, the page behind locked, Escape closes");
    assert.match(deck, /aria-modal="true"/);
    assert.match(deck, /role="dialog"/);
    assert.match(deck, /createPortal\(/, "over the page, not inside its layout");
    assert.match(deck, /if \(!hydrated\) return null;/, "and only after hydration, as the zoomed photo does");
    assert.match(deck, /if \(otherDialogOpen\(\)\) return;/, "Escape closes the zoomed photo first, never the review under it");
    assert.match(deck, /motion-safe:animate-in/, "the slide moves only when the device allows motion");
    assert.doesNotMatch(deck, /(?<!motion-safe:)animate-in/, "every transition is behind motion-safe");
    assert.match(deck, /const \[frozen\] = useState\(\(\) => input\);/, "the tabs are taken when the review opens, so '12 of 87' never shifts under his finger");
    // Closing the zoomed photo hands focus back to the review: the lightbox is taken off the page rather
    // than turned off, so the return has to run when the dialog's open period ENDS, unmount included.
    // Before 2026-10-19 focus fell to the page body and the next Tab left the review.
    const a11y = stripComments(read("src/components/ui/use-dialog-a11y.ts"));
    assert.match(
      a11y,
      /return \(\) => \{[^}]*?const target = returnFocusRef\.current;\s*returnFocusRef\.current = null;\s*if \(target instanceof HTMLElement && target\.isConnected\) target\.focus\(\);\s*\};\s*\}, \[open\]\);/,
      "focus goes back to where it was when a dialog closes, whether it is turned off or taken off the page",
    );
    // On a phone only Back / Next is pinned; pinned, a held place's decision covered 426 of the 603 px
    // under the photo and pushed Back / Next off the screen (measured 2026-10-19, 375 x 812).
    assert.match(deck, /aria-label="Move between photos"\s+className="sticky bottom-0 /, "Back / Next is what a phone keeps pinned");
    assert.match(
      deck,
      /\{view\.footer \? \(\s*<div className="(?![^"]*\bsticky\b)[^"]*">\s*<div className=\{cn\("(?![^"]*\bsticky\b)[^"]*"[^>]*>\{view\.footer\}/,
      "the decision follows the facts on a phone, never inside a pinned box",
    );
    // A polyclinic's two photos sit side by side on every screen: stacked on a phone, each upright photo
    // had about 104 x 139 px of a 375 x 812 screen (measured 2026-10-19; he chose side by side).
    const parts = stripComments(read("src/components/place-review-deck/deck-parts.tsx"));
    const split = /export function DeckSplitStage[\s\S]*?className="([^"]*)"/.exec(parts)?.[1] ?? "";
    assert.match(split, /(?:^| )grid-cols-2(?= |$)/, "a polyclinic's two photos sit side by side on a phone too");
    assert.doesNotMatch(split, /grid-rows-2/, "a polyclinic's two photos are never stacked");
    assert.match(parts, /absolute left-3 top-3 z-10 max-w-\[calc\(100%-5\.5rem\)\]/, "the photo's label stops short of the turn arrows in a half-width cell");
  }
  for (const path of NEW_FILES) {
    const code = stripComments(read(path));
    const classes = (code.match(/className=(?:"[^"]*"|\{[^}]*\})/g) ?? []).join(" ") + " " + (code.match(/cn\([^)]*\)/g) ?? []).join(" ");
    assert.doesNotMatch(classes, /\brounded-(?!none\b)[a-z0-9]+/, `${path}: square corners only`);
    assert.doesNotMatch(code, /\b(?:truncate|line-clamp-\d|text-ellipsis)\b/, `${path}: no ellipsis — wrap instead`);
    assert.doesNotMatch(code, /overflow-x-|overflow-auto\b|overflow-scroll\b/, `${path}: never a sideways scroll`);
    assert.doesNotMatch(code, /…/, `${path}: no ellipsis character`);
    const words = [...(code.match(/(["'`])(?:\\.|(?!\1)[\s\S])*\1/g) ?? []), ...[...code.matchAll(/>([^<>{}]+)</g)].map((match) => match[1] ?? "")];
    for (const text of words) {
      assert.doesNotMatch(text, /\b(?:doctors?|accounts?)\b/i, `${path} says ${text.trim().slice(0, 60)} — the field CRM says customer`);
    }
  }
  {
    const route = stripComments(read("app/api/admin/phoenix-crm/integrity/cases/route.ts"));
    assert.match(route, /export async function GET\(/, "the cases route reads");
    assert.doesNotMatch(route, /export async function (?:POST|PATCH|PUT|DELETE)\(/, "and only reads — settling is the settle route's");
    assert.match(route, /await assertPermission\(access, "phoenix_crm", "read"\);/, "the permission is asserted on the server");
    assert.match(route, /const board = await loadIntegrityBoard\(viewer\);/, "through the board's own loader, so every narrowing the board applies applies here");
    assert.doesNotMatch(route, /\.from\(/, "and never the table itself");
    assert.match(route, /canSettle: canSettleIntegrityCases\(viewer\)/, "the review never offers a button the settle route would refuse");
    const cases = stripComments(read("src/components/place-review-deck/deck-cases.ts"));
    assert.match(cases, /first: current\.first \?\? board\.cases/, "the tab keeps the cases as first read, so a settled case keeps its slide");
  }

  // ── 7 · The by-eye advice: a tag by the buttons, and the "approve" ones first ────────────────────
  // Owner, 2026-10-19: "Show my advice by the buttons" — each slide's tag beside Approve and Reject, and
  // the approvals first in every tab, so he can go through them fast. It decides nothing.
  {
    assert.equal(parsePlaceNoteAdvice("approve"), "approve");
    assert.equal(parsePlaceNoteAdvice("new_photo"), "new_photo");
    assert.equal(parsePlaceNoteAdvice("validate"), null, "a manager's recommendation word is not an advice");
    assert.equal(parsePlaceNoteAdvice(null), null);
    assert.equal(placeNoteAdviceLabel("new_photo"), "Ask for a new photo");

    const note = (advice: string | null, writtenAtText: string) => ({ advice, authorLabel: "x", body: "By eye: x", noteId: writtenAtText, repVisible: false, source: "system_admin", writtenAtText });
    const noteIndex = {
      integrity: {},
      recommendations: {},
      notes: {
        "place:p-approve": [note(null, "newest, no advice"), note("approve", "older")],
        "place:p-reject": [note("reject", "only")],
        "place:p-call": [note("your_call", "only")],
        "place:seat-photo": [note("new_photo", "only")],
        "place:seat-approve": [note("approve", "only")],
      },
    } as unknown as PlaceNoteIndex;
    assert.equal(adviceOnSubject(noteIndex, "place", "p-approve"), "approve", "the newest note that carries an advice speaks, past a newer one without");
    assert.equal(adviceOnSubject(noteIndex, "place", "p-none"), null);
    assert.equal(adviceOnSubject(noteIndex, "place", null), null, "a customer with no place has no advice");

    const lookup = {
      reviews: [{ reviewId: "r-held", placeId: "p-reject" }],
      places: [],
      venues: [{ venue: { sharedPlaceId: "v-mixed" }, customers: [{ placeId: "seat-photo" }, { placeId: null }, { placeId: "seat-approve" }] }],
    } as unknown as PlaceReviewDeckInput["lookup"];
    const advice = (key: string, kind: "review" | "place" | "venue" | "case") => deckSlideAdvice({ key, kind, polyclinic: kind === "venue" }, { lookup, noteIndex });
    assert.equal(advice("review:r-held", "review"), "reject", "a held place's slide carries its place's advice, found through the review row");
    assert.equal(advice("place:p-call", "place"), "your_call");
    assert.equal(advice("venue:v-mixed", "venue"), "approve", "a polyclinic sorts by the best advice among its building and its seated customers");
    assert.equal(advice("case:c1", "case"), null, "an integrity case has no by-eye advice");
    assert.deepEqual(
      ["approve", "your_call", "new_photo", "reject", null].map((one) => deckAdviceRank(one as Parameters<typeof deckAdviceRank>[0])),
      [0, 1, 2, 3, 4],
      "approve, your call, new photo, reject, then no advice",
    );

    const from: DeckSources = {
      ...sources(),
      waitingReviews: ["r-none", "r-held"],
      waitingVenues: ["v-mixed"],
      unconfirmedPlaces: ["p-none", "p-reject", "p-approve", "p-call"],
      unconfirmedVenues: [],
    };
    const rank = deckAdviceRanker({ lookup, noteIndex });
    const ranked = (tab: Parameters<typeof buildDeckSlides>[0]) => buildDeckSlides(tab, "both", from, rank).map((slide) => slide.key);
    assert.deepEqual(ranked("unconfirmed"), ["place:p-approve", "place:p-call", "place:p-reject", "place:p-none"], "every tab puts the by-eye approvals first, then your call, new photo, reject, then the rest");
    assert.deepEqual(ranked("waiting"), ["venue:v-mixed", "review:r-held", "review:r-none"], "a building with an approved customer comes up with the approvals");
    assert.deepEqual(ranked("integrity"), ["case:c1", "case:c2"], "slides of equal rank keep the board's own order");
    const all = ranked("all");
    assert.ok(all.indexOf("review:r-none") < all.indexOf("place:p-approve"), "All ranks inside each of its tabs, never across them — the work still runs tab by tab");
    assert.deepEqual(buildDeckSlides("unconfirmed", "both", from).map((slide) => slide.key), ["place:p-none", "place:p-reject", "place:p-approve", "place:p-call"], "with no rank the order is the board's");

    const loader = stripComments(read("src/lib/phoenix-crm/server/place-notes.ts"));
    assert.match(loader, /const noteColumns = "[^"]*\badvice\b[^"]*";/, "the board's note read brings the advice");
    assert.match(loader, /advice: source === "system_admin" \? parsePlaceNoteAdvice\(row\.advice\) : null,/, "only a System Administrator's note carries an advice");
    const repRead = loader.slice(loader.indexOf("export async function loadRepVisiblePlaceNotes("));
    assert.ok(repRead.length > 0 && loader.includes("export async function loadRepVisiblePlaceNotes("), "the rep's own read must still exist — this check has lost its anchor");
    assert.doesNotMatch(repRead.slice(0, repRead.indexOf("\nexport ", 1)), /advice/, "the rep's own read never names it");

    const deck = stripComments(read("src/components/place-review-deck/review-deck.tsx"));
    assert.match(deck, /const rankSlide = useMemo\(\(\) => deckAdviceRanker\(frozen\), \[frozen\]\);/, "the order is taken from the notes as the review opened, so a slide never jumps under his finger");
    assert.match(deck, /buildDeckSlides\(tab, kind, sources, rankSlide\)/, "the slides he moves through are the ranked ones");
    assert.match(
      functionBody(deck, "reviewSlide"),
      /<AdviceTag advice=\{adviceOnSubject\(noteIndex, "place", row\.placeId\)\} \/>\s*<ReviewDecision /,
      "a held place's tag sits right above its Approve and Reject",
    );
    assert.match(
      functionBody(deck, "placeSlide"),
      /<AdviceTag advice=\{adviceOnSubject\(noteIndex, "place", row\.placeId\)\} \/>\s*<PlaceInUseApprove /,
      "a place in use's tag sits right above its Approve and Refuse",
    );
    const venueBody = functionBody(deck, "venueSlide");
    assert.match(venueBody, /<AdviceTag advice=\{adviceOnSubject\(noteIndex, "shared_place", venue\.sharedPlaceId\)\} \/>\s*<PlaceCheckDoneItem item=\{deckSlideKey\("venue"/, "the building's tag sits above the building's decision");
    assert.match(venueBody, /<AdviceTag advice=\{adviceOnSubject\(noteIndex, "place", customer\.placeId\)\} \/>\s*<SeatedLastColumn /, "and each seated customer's above his own");

    const migration = read("supabase/migrations/20261019150453_phoenix_crm_place_note_advice.sql");
    assert.match(migration, /advice is null\s+or \(author_source = 'system_admin' and advice in \('approve', 'your_call', 'new_photo', 'reject'\)\)/, "the database allows an advice on a System Administrator's note only, from the four words");
  }
}
