import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildCustomerFrequencyReport,
  customerFrequencyTotals,
  frequencyGradeTarget,
} from "../src/lib/phoenix-crm/customer-frequency.ts";
import { dayDetailCounts } from "../src/lib/phoenix-crm/day-detail.ts";
import { buildTeamCalendar, dayShape, monthDays, teamCalendarTotals } from "../src/lib/phoenix-crm/team-calendar.ts";
import { buildTrackingSheet, spacingNote } from "../src/lib/phoenix-crm/tracking-sheet.ts";
import { readsCalendar, readsTeamReports, type PhoenixCrmViewer } from "../src/lib/phoenix-crm/server/access.ts";
import type { OrgSeat } from "../src/lib/phoenix-crm/scope.ts";
import { stripComments } from "./support/comment-strip.ts";

/** One territory seat, enough for the access predicates — they read the list's LENGTH, not a seat. */
const SEAT = { seatId: "seat-1" } as unknown as OrgSeat;

/**
 * The six fields `readsCalendar` and `readsTeamReports` actually read. A partial cast is honest
 * here precisely because that is the whole contract: both are pure functions over these, and
 * building a real viewer would need an organogram, a config and a live access context to test a
 * boolean.
 */
function viewerWith(patch: Partial<PhoenixCrmViewer>): PhoenixCrmViewer {
  return {
    isSuperAdmin: false,
    isSfeManager: false,
    basis: "tree",
    managerSeats: [],
    ownTerritories: [],
    scopeTerritories: [],
    ...patch,
  } as unknown as PhoenixCrmViewer;
}

/**
 * Phoenix CRM Wave 2 — the three reports, and the rulings the owner gave on them.
 *
 *   4. Team calendar — pharmacies are shown in the day's detail but NOT counted in the small
 *      coloured day cell; the cell reflects AM and PM only (2026-09-30).
 *   5. Frequency per customer — two columns apart: visits against his A/B/C grade norm, and
 *      visits against how often he was planned (2026-09-30).
 *   6. (the tracking sheet's own rule, from the plan) — the spacing note is for MANAGERS only.
 *
 * Each of those is a way the report could look tidier and be wrong: one blended figure, one
 * averaged frequency, one helpful note that puts a judgement on a rep's own phone.
 *
 * The calendar's block also pins what its SCREEN may not do, because the grid it rebuilds is a
 * screen he recorded rather than a spec he wrote: `AgentsCalendar.aspx`, 7:40 of his second video
 * of 2026-09-29.
 */
export function runPhoenixCrmWave2ReportTests(): void {
  // ── The team calendar ────────────────────────────────────────────────────────────────────────
  //
  // 🔴 THE CELL'S COLOUR IS THE DAY'S SHAPE, NOT HOW BUSY IT WAS. Read off his own recording: AM
  //    only cyan, PM only orange, AM + PM green, Annual Vacation blue, Campaign pink, Friday black.
  //    The first cut of this module coloured by a density band off AM + PM together — that was mine
  //    and not his, and it cannot show the one pattern the grid exists for: a rep who only ever
  //    works mornings reads as an ordinary quiet rep under a band, and jumps off the page under this.
  //
  // 🔴 AND PHARMACIES ARE NEVER IN IT (his answer, 2026-09-30). Twenty pharmacy visits and no
  //    customer is a BLANK day: a pharmacy is not a contact, and letting it colour the cell makes a
  //    day on customers and a day on shops read alike at the glance a calendar is for.
  const friday = "2026-03-06";
  const blank = { am: 0, pharmacies: 0, pm: 0 };
  assert.equal(dayShape({ activity: null, counts: { am: 0, pharmacies: 20, pm: 0 }, day: "2026-03-05", onLeave: false }), "none");
  assert.equal(dayShape({ activity: null, counts: { am: 3, pharmacies: 9, pm: 0 }, day: "2026-03-05", onLeave: false }), "am");
  assert.equal(dayShape({ activity: null, counts: { am: 0, pharmacies: 9, pm: 7 }, day: "2026-03-05", onLeave: false }), "pm");
  assert.equal(dayShape({ activity: null, counts: { am: 1, pharmacies: 0, pm: 7 }, day: "2026-03-05", onLeave: false }), "both");

  // 🔴 WORK COMES FIRST, ALWAYS. A visit logged on a Friday, or on a day HR has him on leave, is
  //    work — hiding it behind the black F or the blue would be the grid disagreeing with his own
  //    visit rows, which is how a manager learns to stop trusting it.
  assert.equal(dayShape({ activity: null, counts: { am: 2, pharmacies: 0, pm: 0 }, day: friday, onLeave: true }), "am");
  assert.equal(dayShape({ activity: "training", counts: { am: 0, pharmacies: 0, pm: 4 }, day: friday, onLeave: false }), "pm");
  // And when nothing was logged: Friday, then leave, then the day activity. Each is a REASON the day
  // is blank, which is the whole point of telling them apart from a plain missed day.
  assert.equal(dayShape({ activity: "meeting", counts: blank, day: friday, onLeave: true }), "rest");
  assert.equal(dayShape({ activity: "meeting", counts: blank, day: "2026-03-05", onLeave: true }), "leave");
  assert.equal(dayShape({ activity: "meeting", counts: blank, day: "2026-03-05", onLeave: false }), "activity");
  assert.equal(dayShape({ activity: null, counts: blank, day: "2026-03-05", onLeave: false }), "none");

  // Every day of the month is present, including the empty ones — a grid that skips the 12th makes a
  // quiet week look busy — and so is every person, including one with nothing at all: HIS row is the
  // finding, and a grid that drops him hides a territory nobody is working.
  const people = [
    { manager: "Nosiba Salah", person: "Aisha Ehab", seatId: "S1", territory: "Minia 2 · Anti Infective" },
    { manager: "Nosiba Salah", person: "Seat is vacant", seatId: "S2", territory: "Minia 1 · Anti Infective" },
  ];
  const grid = buildTeamCalendar("2026-02", people, {
    activities: [{ activity: "conference", day: "2026-02-11", seatId: "S1" }],
    leave: [{ day: "2026-02-12", seatId: "S1" }],
    visits: [
      { counts: { am: 1, pharmacies: 2, pm: 6 }, day: "2026-02-03", seatId: "S1" },
      { counts: { am: 1, pharmacies: 0, pm: 4 }, day: "2026-02-03", seatId: "S1" },
      { counts: { am: 0, pharmacies: 1, pm: 9 }, day: "2026-02-10", seatId: "S1" },
      // Outside the month, and for a seat nobody on the grid holds: both are dropped rather than
      // silently widening the month or minting a row the viewer was never allowed to see.
      { counts: { am: 5, pharmacies: 0, pm: 5 }, day: "2026-03-01", seatId: "S1" },
      { counts: { am: 5, pharmacies: 0, pm: 5 }, day: "2026-02-04", seatId: "SOMEONE-ELSE" },
    ],
  });
  assert.equal(grid.length, 2, "a person with nothing keeps his row");
  assert.equal(monthDays("2026-02").length, 28, "February 2026 has 28 days");
  assert.equal(grid[0]?.days.length, 28, "and the grid holds all of them, on every row");
  assert.deepEqual(grid[0]?.days[2]?.counts, { am: 2, pharmacies: 2, pm: 10 }, "two rows on one day merge, each bucket apart");
  assert.equal(grid[0]?.days[2]?.shape, "both");
  assert.equal(grid[0]?.days[10]?.shape, "activity", "a conference is a working day that was not a call");
  assert.equal(grid[0]?.days[11]?.shape, "leave", "leave comes from HR's loader, never from a gap in the visits");
  assert.equal(grid[0]?.days[1]?.shape, "none", "an empty day is a real day");
  assert.equal(
    grid[1]?.days.every((day) => day.counts.am === 0 && day.counts.pm === 0),
    true,
    "and a row is never fed another seat's work",
  );
  assert.deepEqual(grid[0]?.totals, { am: 2, pharmacies: 3, pm: 19 }, "a person's total keeps the three apart");
  assert.deepEqual(teamCalendarTotals(grid), { am: 2, pharmacies: 3, pm: 19 }, "and so does the month's");
  assert.deepEqual(
    [grid[0]?.amOnlyDays, grid[0]?.pmOnlyDays, grid[0]?.bothDays],
    [0, 1, 1],
    "the shape tallies are counted, not left to the eye",
  );
  assert.equal(buildTeamCalendar("nonsense", people).length, 0);

  // ── The calendar's screen ────────────────────────────────────────────────────────────────────
  {
    // COMMENTS STRIPPED, and that is not tidiness: this file's own header explains which classes
    // are banned, so a raw sweep matches the explanation and reports the rule as broken by the
    // sentence that states it (the trap `exceptions.ts` hit first).
    const tab = stripComments(readFileSync("src/components/phoenix-crm/calendar-tab.tsx", "utf8"));

    // 🔴 NO COMBINED FIGURE ANYWHERE. His own grid prints ONE number per cell, which on a
    //    both-halves day is AM + PM added — and the AM · PM · Pharmacies golden rule reports every
    //    count apart. The cell carries the one figure its colour names, or the two stacked. This is
    //    the assertion that stops the tidier-looking single number coming back.
    assert.doesNotMatch(tab, /\.(?:am|pm)\s*\+\s*[A-Za-z0-9_.]*\.(?:am|pm)\b/, "a cell must never print AM + PM as one number");
    // Lower case deliberately, and no `i` flag: the LEGEND says "AM + PM", which is his own wording
    // for a shape and not a sum. What is banned is the two halves being ADDED, in either order.
    assert.doesNotMatch(tab, /\b(?:am|pm)\s*\+\s*(?:am|pm)\b/, "and nothing on the screen may add the two halves at all");

    // 🔴 HIS PALETTE, NOT PHOENIX'S ORANGE. A design he hands over is final: a manager who knows the
    //    old grid must not have to relearn what a colour means.
    for (const [shape, hue] of [
      ["am", "sky"],
      ["pm", "orange"],
      ["both", "emerald"],
      ["leave", "blue"],
      ["activity", "pink"],
      ["rest", "slate-900"],
    ]) {
      assert.match(tab, new RegExp(`\\b${shape}:\\s*"[^"]*${hue}`), `the ${shape} cell keeps his ${hue} ink`);
    }

    // 🔴 AND IT FITS THE SCREEN. His grid scrolls sideways across 31 day columns; Phoenix bans that,
    //    and `overflow-x-auto` over a `min-width` IS the bug the rule names. The 31 columns live in
    //    a table-fixed percentage colgroup, and below `lg` the identity columns MERGE into a card.
    assert.doesNotMatch(tab, /overflow-x-auto|min-w-\[/, "no sideways scroll and no minimum width on the grid");
    // Through the module's own primitive, which is where `table-fixed` and the colgroup live —
    // `tests/phoenix-crm-fits-the-screen` refuses a raw <table> anywhere in Phoenix CRM.
    assert.match(tab, /<CrmTable columns=\{\["22%"/, "the day columns go through CrmTable");
    assert.doesNotMatch(tab, /<table\b/, "and never a hand-rolled table");
    assert.match(tab, /max-lg:hidden/, "the full grid is the desktop's");
    assert.match(tab, /\blg:hidden/, "and a card per person is the phone's");

    // 🔴 A DAY WITH WORK ON IT OPENS IN A NEW TAB (owner, 2026-09-30: "when I press on any day that
    //    have activity, I am redirected to a new tab with the full detail of this day"). Both the
    //    desktop grid and the phone card, or the phone quietly loses the feature.
    assert.equal(
      (tab.match(/target="_blank"/g) ?? []).length,
      2,
      "the grid and the card both open the day in a new tab — one without the other is a phone that cannot follow him",
    );
    assert.equal(
      (tab.match(/rel="noopener noreferrer"/g) ?? []).length,
      2,
      "and both carry the rel pair, so the opened page cannot reach back into the calendar",
    );
    // 🔴 DECIDED BY THE SHAPE, NEVER BY ARITHMETIC ON THE COUNTS. `counts.am + counts.pm > 0` is the
    //    obvious-looking test and it is the banned sum in disguise — the assertion above would catch
    //    it, and this one says why the shape list is the right test in the first place.
    assert.match(
      tab,
      /function opensTheDay\(day: TeamCalendarDay\): boolean \{\s*return day\.shape === "am" \|\| day\.shape === "pm" \|\| day\.shape === "both" \|\| day\.shape === "activity";/,
      "a Friday, a leave day and an empty day open nothing — there is no day to show, and the panel already says why",
    );
  }

  // ── The day the calendar opens ───────────────────────────────────────────────────────────────
  {
    // 🔴 AM AND PM FROM THE LIST TYPE; A PHARMACY IS A DISTINCT NAME AND NOT A ROW. Two visits that
    //    named the same pharmacy are ONE pharmacy, however it was spelled — the grouping is
    //    `todayPharmacies`, reused rather than rewritten, because a second copy of it will drift.
    const day = dayDetailCounts([
      { capturedAt: "2026-09-30T07:10:00.000Z", customerId: "1", customerName: "أحمد الهضيمي", listType: "AM", pharmacyName: "صيدلية النور" },
      { capturedAt: "2026-09-30T10:20:00.000Z", customerId: "2", customerName: "Mona Adel", listType: "PM", pharmacyName: "صيدلية النور " },
      { capturedAt: "2026-09-30T12:00:00.000Z", customerId: "3", customerName: "Sara Nabil", listType: "PM", pharmacyName: null },
      { capturedAt: "2026-09-30T13:00:00.000Z", customerId: "4", customerName: "Hany Samir", listType: "pm", pharmacyName: "El Ezaby" },
    ]);
    assert.deepEqual(day.counts, { am: 1, pharmacies: 2, pm: 3 }, "three figures apart, and the two spellings are one pharmacy");
    assert.equal(day.pharmacies.length, 2);
    assert.deepEqual(
      day.pharmacies[0]?.fromCustomers,
      ["أحمد الهضيمي", "Mona Adel"],
      "a pharmacy names every customer whose visit mentioned it",
    );
    // 🔴 THE INSTANT IS NOT A CLOCK, AND THE FIELD SAYS SO. `todayPharmacies` copies what it is
    //    given into a field it documents as a formatted Cairo clock, because Today formats first.
    //    This page has raw instants, so the name changes at this boundary — passing an instant as
    //    `firstAt` would render a UTC timestamp on a screen whose every other time is Cairo.
    assert.equal(day.pharmacies[0]?.firstCapturedAt, "2026-09-30T07:10:00.000Z");
    assert.equal("firstAt" in (day.pharmacies[0] ?? {}), false, "the misleading name does not survive the boundary");

    // 🔴 THE PAGE DOES NOT DECIDE WHO SEES A DISTANCE — THE SERVER DID. `loadVisitDay` already
    //    resolves the territory through the viewer's scope and already applies `isLocationBlind`,
    //    so a REP opening his own day reads "Visit saved" and nothing else (Golden rule #1). A
    //    screen that re-decided it would be one edit from showing him a distance.
    const service = stripComments(readFileSync("src/lib/phoenix-crm/server/day-detail.ts", "utf8"));
    assert.match(service, /loadVisitDay\(viewer, raw\)/, "the day is read through the one gated loader, never a second query");
    const screen = stripComments(readFileSync("src/components/phoenix-crm/day-detail-view.tsx", "utf8"));
    assert.doesNotMatch(screen, /isLocationBlind|distanceMeters|accuracyMeters/, "the screen never re-decides what a reader may measure");
    assert.match(screen, /visit\.locationLabel/, "it prints the sentence the server chose for this reader");

    // Leave is HR's table, and a Phoenix CRM service may not read it (tests/phoenix-crm-boundary).
    assert.match(service, /loadApprovedLeaveDays/, "leave comes through the vacation module");
    assert.doesNotMatch(service, /v2_vacation_requests/, "and never by naming HR's table here");
  }

  // ── Frequency per customer ─────────────────────────────────────────────────────
  //
  // 🔴 THE TARGET IS PHOENIX CRM'S OWN `grade_targets`, KEYED BY LIST TYPE THEN GRADE — and the
  //    first cut of this module got it wrong in a way no browser would have shown. It scored
  //    against `DoctorCoverageNorms` from `src/lib/crm/doctor-coverage-config`, the iReports360
  //    side, keyed by the customer's SPECIALITY. Production reads PM A 3 · B 2 · C 1 and AM A 1
  //    today, where that other table says A 2 — so coverage and frequency would have printed
  //    different denominators for the same customer on the same screen.
  const settings = { gradeTargets: { AM: { A: 1, B: null, C: null }, PM: { A: 3, B: 2, C: 1 } } } as const;
  assert.equal(frequencyGradeTarget(settings, "PM", "A"), 3);
  assert.equal(frequencyGradeTarget(settings, "PM", "C"), 1);
  assert.equal(frequencyGradeTarget(settings, "AM", "A"), 1, "AM and PM carry different numbers — that is the whole point of the key");
  // 🔴 NO GRADE IS null, NEVER ZERO, and so is a grade the company set NO number for. AM B and AM C
  //    are unset on production right now: writing 0 would report every one of those customers as
  //    permanently over-visited and put a red number against work nobody asked for.
  assert.equal(frequencyGradeTarget(settings, "PM", null), null);
  assert.equal(frequencyGradeTarget(settings, "AM", "B"), null, "an unset target is no expectation, not an expectation of none");

  const frequency = buildCustomerFrequencyReport(
    [
      { customerId: "1", grade: "A", listType: "PM", name: "Seen once, needed three", planned: 1, visits: 1 },
      { customerId: "2", grade: "B", listType: "PM", name: "Kept every plan, still over", planned: 4, visits: 4 },
      { customerId: "3", grade: null, listType: "PM", name: "Nobody graded him", planned: 0, visits: 3 },
      { customerId: "4", grade: "C", listType: "PM", name: "Exactly right", planned: 1, visits: 1 },
      { customerId: "5", grade: "B", listType: "AM", name: "No number was ever set", planned: 2, visits: 0 },
    ],
    settings,
  );
  // 🔴 THE TWO COLUMNS ARE KEPT WHOLE AND SEPARATE. The second customer is +2 on the grade and 0
  //    against his plan — the two disagree, and that disagreement IS the finding. Blending them,
  //    or showing whichever looks worse, hides it.
  const kept = frequency.find((row) => row.customerId === "2");
  assert.equal(kept?.againstGrade, 2, "four visits against a target of two");
  assert.equal(kept?.againstPlan, 0, "and he kept every plan he made");
  assert.equal(kept?.gradeVerdict, "Over by 2");
  const missed = frequency.find((row) => row.customerId === "1");
  assert.equal(missed?.againstGrade, -2, "one visit against a target of three");
  assert.equal(missed?.gradeTarget, 3);
  assert.equal(missed?.gradeVerdict, "Under by 2");
  assert.equal(frequency.find((row) => row.customerId === "4")?.gradeVerdict, "On the grade");
  assert.equal(frequency.find((row) => row.customerId === "5")?.gradeVerdict, "No target set");

  // 🔴 OVER IS A DEVIATION TOO, NEVER A BONUS (owner, 2026-08-21, reaffirmed 2026-09-04). The list
  //    is ordered by the SIZE of the gap, so the customer seen twice too often sits at the top
  //    beside the one seen twice too seldom. The first cut sorted by `visits - target` ascending,
  //    which put every over-visited customer at the BOTTOM looking like the healthiest row.
  assert.deepEqual(
    frequency.map((row) => row.customerId),
    ["1", "2", "4", "3", "5"],
    "biggest gap first, under before over at the same size, and no-target rows last",
  );
  assert.equal(frequency[frequency.length - 1]?.againstGrade, null);

  const totals = customerFrequencyTotals(frequency);
  assert.deepEqual(totals, { customers: 5, noTarget: 2, onTarget: 1, over: 1, under: 1 }, "under, on and over stay apart");
  // Nothing anywhere produces one blended frequency figure.
  assert.equal(
    Object.keys(frequency[0] ?? {}).some((key) => /combined|blend|average|overall/i.test(key)),
    false,
    "there is no single combined frequency field to render by accident",
  );

  // The SCREEN and the SERVICE, on the two things that could quietly go wrong.
  {
    const service = stripComments(readFileSync("src/lib/phoenix-crm/server/reports.ts", "utf8"));
    // The targets come off the viewer's own resolved config — never a second read that could
    // disagree with the rest of his session.
    assert.match(service, /const settings = viewer\.config\.settings;/, "the frequency report scores against the viewer's own settings");
    // 🔴 A DRAFT IS NOT A PLAN. The rep owns his draft until he sends it, so counting draft rows
    //    would move the denominator under a manager while he reads the page.
    assert.match(
      service,
      /from\("phoenix_crm_plans"\)[\s\S]{0,200}?\.in\("status", \["submitted", "approved"\]\)/,
      "planned counts read plans that were actually sent",
    );
    assert.match(service, /from\("phoenix_crm_countable_visits"\)/, "and visits come from the countable view, never the raw table");

    const tab = stripComments(readFileSync("src/components/phoenix-crm/reports-tab.tsx", "utf8"));
    assert.match(tab, /frequency: "Frequency per customer"/, "the section is offered by name");
    // Membership, not the exact list: the point is that this section asks for a MONTH like
    // coverage does, and a later month-shaped report joining the constant is not a regression.
    const monthly = /MONTHLY_SECTIONS: ReadonlyArray<ReportSection> = \[([^\]]+)\]/.exec(tab)?.[1] ?? "";
    assert.match(monthly, /"coverage"/);
    assert.match(monthly, /"frequency"/, "it asks for a month, like coverage");
    // And the Month picker is offered for every one of them — the filters branched on
    // `coverage` alone at first, so the month could never be changed from this screen.
    assert.match(tab, /\) : MONTHLY_SECTIONS\.includes\(activeSection\) \? \(/, "the Month select follows the same list");
    // Every section has a key in the resource map, or Refresh throws the moment it is open.
    const activeMap = /const active = \{([^}]+)\}\[activeSection\]/.exec(tab)?.[1] ?? "";
    for (const key of ["frequency", "tracking"]) {
    const mapKeys = activeMap.split(",").map((key) => key.trim());
    for (const key of ["frequency", "tracking"]) {
      assert.ok(mapKeys.includes(key), `the ${key} resource is in the map Refresh reads`);
    }
    }
    assert.doesNotMatch(tab, /againstGrade\s*\+\s*[A-Za-z.]*againstPlan/, "the two comparisons are never added into one score");
  }

  // ── The tracking sheet ───────────────────────────────────────────────────────────────────────
  // The note only speaks when the rep actually STOPPED — a bunched start then silence, which is
  // the shape he described. An even cadence says nothing, because a note on every row is unread.
  assert.equal(spacingNote(["2026-03-05", "2026-03-09"], "2026-03-31"), "Seen on the 5th and the 9th, then not again.");
  assert.equal(spacingNote(["2026-03-05", "2026-03-12", "2026-03-19", "2026-03-26"], "2026-03-31"), null, "an even cadence to the end says nothing");
  assert.equal(spacingNote(["2026-03-20"], "2026-03-31"), null, "one visit is not a pattern");
  assert.equal(spacingNote(["2026-03-05", "2026-03-09"], "2026-03-12"), null, "and nothing is said while the month still has room");

  // 🔴 THE NOTE IS MANAGERS ONLY, GATED IN THE HELPER AS WELL AS THE SCREEN (Golden rule #1: the
  //    rep's app is blind, and anything that judges how he worked is never his). A helper that
  //    returns the note and trusts the screen to hide it is one render from a rep's phone.
  const input = [{ customerId: "1", days: ["2026-03-09", "2026-03-05", "2026-03-05"], name: "أحمد الهضيمي" }];
  const forManager = buildTrackingSheet(input, "2026-03-31", { managerView: true });
  const forRep = buildTrackingSheet(input, "2026-03-31", { managerView: false });
  assert.equal(forManager[0]?.spacing, "Seen on the 5th and the 9th, then not again.");
  assert.equal(forRep[0]?.spacing, null, "the rep's own sheet carries the marks and not one word of judgement");
  assert.deepEqual(forRep[0]?.days, ["2026-03-05", "2026-03-09"], "two visits in one day mark that day once, and the days sort");
  assert.deepEqual(forManager[0]?.gaps, [4], "the gap is in whole days");

  // ── The tracking sheet's service and screen ────────────────────────────────────────
  {
    const service = stripComments(readFileSync("src/lib/phoenix-crm/server/reports.ts", "utf8"));

    // 🔴 WHO GETS THE NOTE IS DECIDED BY THE SERVER, FROM THE ONE PREDICATE THAT ALREADY MEANS
    //    "is a manager". A second rule here would be a second answer to a settled question, and
    //    the answer it could get wrong puts a judgement on a rep's own phone (Golden rule #1).
    assert.match(service, /const managerView = readsTeamReports\(viewer\);/, "the note is a manager's, by the module's own predicate");
    assert.match(service, /buildTrackingSheet\(/, "and the helper gates it a second time, inside");
    assert.match(service, /\{ managerView \}/, "the decision is passed down, never re-made");

    // 🔴 THE TWO PER-CUSTOMER REPORTS READ THE SAME LIST AND THE SAME VISITS. Coverage's own SQL
    //    resolves "validated, active or retired during the month"; a second resolution here would
    //    put a different denominator beside coverage on the same screen.
    assert.equal(
      (service.match(/from\("phoenix_crm_customers"\)/g) ?? []).length,
      1,
      "one resolver for the month's list, shared — never one per report",
    );
    assert.match(service, /async function listedCustomers\(/);
    assert.match(service, /async function visitDaysByCustomer\(/, "and one reader for the visits, returning DAYS");
    // Repeats matter to one report and not the other, which is why it returns days rather than a
    // count: two visits on one day are two VISITS and one MARK.
    assert.match(service, /visits: \(daysByCustomer\.get\(String\(row\.id\)\) \?\? \[\]\)\.length/, "frequency counts visits, repeats and all");

    const tab = stripComments(readFileSync("src/components/phoenix-crm/reports-tab.tsx", "utf8"));
    const start = tab.indexOf("function TrackingSection(");
    assert.notEqual(start, -1, "the tracking sheet has its own section component");
    const body = tab.slice(start, tab.indexOf("\nfunction ", start + 10));

    // The screen renders what it was given and never re-decides the audience.
    assert.match(body, /row\.spacing/, "it prints the note the server chose to compute");
    assert.doesNotMatch(body, /readsTeamReports|isRep\b|isSuperAdmin/, "and never works out for itself who may read it");

    // 🔴 THIRTY-ONE DAY COLUMNS CANNOT SCROLL SIDEWAYS. A fixed percentage colgroup from `lg`, and
    //    below that the columns MERGE into the row's own sentence — never `overflow-x-auto` over a
    //    minimum width, which is the bug the fits-the-screen rule names.
    assert.match(body, /<CrmTable columns=\{\["26%"/, "the day columns go through CrmTable");
    assert.doesNotMatch(body, /<table\b/, "and never a hand-rolled table");
    assert.doesNotMatch(body, /overflow-x-auto|min-w-\[/, "no sideways scroll and no minimum width");
    assert.match(body, /hidden min-w-0 lg:block/, "the full month is the desktop's");
    assert.match(body, /\blg:hidden/, "and the phone reads the days as words");
  }

  // ── Who opens the calendar, and what the rep is NOT given with it ───────────────────────────
  {
    // Owner, 2026-10-01: "I WANT THE MEDICAL REP TO HAVE ALSO HIS TEAM CALENDER SEEING ONLY
    // HISELF". The calendar therefore leaves `readsTeamReports` and gets a predicate of its own.
    const rep = viewerWith({ ownTerritories: [SEAT], scopeTerritories: [SEAT] });
    const manager = viewerWith({ managerSeats: [SEAT], scopeTerritories: [SEAT] });

    assert.equal(readsCalendar(rep), true, "a rep holding a territory opens the calendar");
    assert.equal(readsCalendar(manager), true, "and so does his manager");
    assert.equal(readsCalendar(viewerWith({ isSuperAdmin: true })), true, "and the Super Admin, seat or no seat");

    // 🔴 THE WHOLE POINT OF A SEPARATE PREDICATE. Widening `readsTeamReports` would have been one
    //    character, and would have handed the rep the place-vs-actual report, the exceptions
    //    board, the brick report, the adoption board and the daily digest's recipient test — every
    //    one a comparison ACROSS people, which is what Golden rule #1 keeps off his screens.
    assert.equal(readsTeamReports(rep), false, "the rep is still refused every report ABOUT a team");
    assert.equal(readsTeamReports(manager), true, "while his manager keeps them");

    // An empty grid is indistinguishable from a month with no work in it, so nobody is shown one.
    assert.equal(readsCalendar(viewerWith({})), false, "a viewer with no territory in scope is refused, not shown an empty month");
    assert.equal(readsCalendar(viewerWith({ basis: "all" })), false, "including a company-basis viewer who reaches no territory");

    const service = stripComments(readFileSync("src/lib/phoenix-crm/server/team-calendar.ts", "utf8"));
    assert.match(service, /if \(!readsCalendar\(viewer\)\) throw forbiddenError/, "the service gates on the calendar's own predicate");
    assert.doesNotMatch(service, /if \(!readsTeamReports\(viewer\)\)/, "and no longer on the manager-only one");
    // 🔴 WHOSE MONTH IT IS COMES FROM THE PREDICATE, NEVER FROM THE ROW COUNT. A district manager
    //    down to one rep still reads a team, and a count would rename his screen as people join
    //    and leave.
    assert.match(service, /readsTeamReports\(viewer\) \? "team" : "own"/, "whose month it is, decided by who is reading");
    // What keeps a rep's view his own is the SCOPE, not a branch: `scopeTerritories` holds his own
    // seat and nobody else's, so there is no path by which he is handed a colleague.
    assert.match(service, /testReadSeats\(viewer, isTest, viewer\.scopeTerritories\)/, "the rows are built from the viewer's own scope");

    const overview = stripComments(readFileSync("src/lib/phoenix-crm/server/overview.ts", "utf8"));
    assert.match(overview, /calendar: readsCalendar\(viewer\)/, "the tab reads the service's predicate rather than restating it");

    const exportRoute = stripComments(readFileSync("app/api/phoenix-crm/reports/export/route.ts", "utf8"));
    assert.match(exportRoute, /readsCalendar\(viewer\) \? loadTeamCalendar\(/, "the workbook follows the screen, so a rep's own month is in his download");
    assert.doesNotMatch(exportRoute, /managerSections \? loadTeamCalendar\(/, "the calendar is not a manager section any more");

    // The screen says whose month it is from that same flag, and never from the row count.
    const screen = stripComments(readFileSync("src/components/phoenix-crm/calendar-tab.tsx", "utf8"));
    assert.match(screen, /view\.data\?\.scope === "own"/, "the heading follows the server's answer");
    assert.match(screen, /Your month/, "a rep reads Your month");
    assert.match(screen, /The team's month/, "and a manager still reads The team's month");
    assert.doesNotMatch(screen, /rows\.length === 1/, "the title is never decided by counting people");

    // The module chooser's blurb is ONE static line shown to both readers, so it may not promise
    // a rep other people's work.
    const modules = stripComments(readFileSync("src/lib/phoenix-crm/modules.ts", "utf8"));
    const calendarEntry = /\{ key: "calendar",[^\n]*\}/.exec(modules)?.[0] ?? "";
    assert.ok(calendarEntry.length > 0, "the calendar module entry is findable");
    assert.doesNotMatch(calendarEntry, /team/i, "its blurb never promises a team to the one reader who only sees himself");

    // 🔴 AND THE GRID STILL JUDGES NOTHING. Giving a rep a month of his own work is only safe
    //    while that month carries no verdict on him — no distance, no flag, no accuracy, no
    //    integrity signal at all (Golden rule #1; `isLocationBlind` covers the day a cell opens).
    for (const banned of [/\bmocked\b/, /\baccuracy\b/, /locationFlag/, /integrity/i, /\bmetres\b/, /\bdistance\b/i]) {
      assert.doesNotMatch(screen, banned, `the calendar screen carries no ${String(banned)} — nothing on it judges the person`);
    }
  }

  console.log("phoenix-crm wave 2 reports: OK");
}
