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

  // ── The managers' rows (owner, 2026-10-19: "yes, all manager levels") ──────────────────────────
  //
  // 🔴 A MANAGER'S ROW IS HIS DAYS, AND IT NEVER REACHES THE MONTH'S THREE FIGURES. The visits he rode
  //    with a rep are already on that rep's row, so adding his row would count one visit twice.
  {
    const withManager = buildTeamCalendar(
      "2026-02",
      [{ kind: "manager", manager: null, person: "Mina Farouk", seatId: "M1", territory: "District Sales Manager · Anti Infective" }, ...people],
      {
        visits: [
          // His own single visits and a ride with the rep — the SAME visit appears on S1's row below.
          { counts: { am: 1, pharmacies: 0, pm: 0 }, day: "2026-02-03", seatId: "M1" },
          { counts: { am: 1, pharmacies: 2, pm: 6 }, day: "2026-02-03", seatId: "S1" },
        ],
      },
    );
    assert.equal(withManager[0]?.kind, "manager", "the manager keeps his kind on the row the screen draws");
    assert.equal(withManager[0]?.days[2]?.shape, "am", "and his own worked half colours his day like anybody's");
    assert.deepEqual(teamCalendarTotals(withManager), { am: 1, pharmacies: 2, pm: 6 }, "but only the reps' rows are summed");
    assert.deepEqual(withManager[1]?.totals, { am: 1, pharmacies: 2, pm: 6 }, "a rep's row is exactly what it was");
  }

  {
    const service = stripComments(readFileSync("src/lib/phoenix-crm/server/team-calendar.ts", "utf8"));
    // Never upward, and the SAME reach the Managers report uses — not a second definition of "his managers".
    assert.match(service, /managersInScope\(viewer\.org, viewer\.hrId, viewer\.basis\)/, "the managers drawn are the ones this viewer reads, never above him");
    assert.match(service, /const managers = isTest \? \[\] : managersOnGrid\(viewer, seats\)/, "the test world draws none");
    // His own single visits come through the ONE door out of that table; this file never names it.
    assert.match(service, /loadManagerOwnVisitDays\(\{ end: bounds\.to, isTest, managerHrIds: hrIds, start: bounds\.from \}\)/, "his own visits come through the adapter");
    assert.doesNotMatch(service, /phoenix_crm_manager_visits/, "and this file never names the table that adapter guards");
    // A ride-along is the rule the manager's plan report judges by, read from the countable view.
    assert.match(service, /countsAsManagersDoubleVisit\(visit, hrId\)/, "a ride-along is a double or chain visit naming him");
    assert.equal((service.match(/foldVisitRow\(fold, /g) ?? []).length, 2, "and it folds through the one function a rep's visit folds through");
    // A manager's row never opens a rep's day page — that page is a territory's. Since 2026-10-20 it opens ITS OWN
    // page, `/manager-day/<seat>/<day>`, which lists his visits card by card.
    const tab = stripComments(readFileSync("src/components/phoenix-crm/calendar-tab.tsx", "utf8"));
    assert.match(tab, /const page = row\.kind === "manager" \? "manager-day" : "day";/, "a manager's cell links to the manager's own day page, never to a territory page");
    assert.equal((tab.match(/href=\{dayHref\(row, day\.day, test\)\}/g) ?? []).length, 2, "neither the desktop row nor the phone card builds the link any other way");
  }

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
    const scored = { countsInKpi: true, customerValidated: true };
    const day = dayDetailCounts([
      { ...scored, capturedAt: "2026-09-30T07:10:00.000Z", customerId: "1", customerName: "أحمد الهضيمي", listType: "AM", pharmacyName: "صيدلية النور" },
      { ...scored, capturedAt: "2026-09-30T10:20:00.000Z", customerId: "2", customerName: "Mona Adel", listType: "PM", pharmacyName: "صيدلية النور " },
      { ...scored, capturedAt: "2026-09-30T12:00:00.000Z", customerId: "3", customerName: "Sara Nabil", listType: "PM", pharmacyName: null },
      { ...scored, capturedAt: "2026-09-30T13:00:00.000Z", customerId: "4", customerName: "Hany Samir", listType: "pm", pharmacyName: "El Ezaby" },
    ]);
    assert.deepEqual(day.counts, { am: 1, pharmacies: 2, pm: 3 }, "three figures apart, and the two spellings are one pharmacy");
    assert.equal(day.pharmacies.length, 2);
    assert.equal(day.awaitingValidation, 0);
    assert.equal(day.awaitingApproval, 0);

    // 🔴 THE HEADLINE IS THE CALENDAR CELL'S OWN BASIS — only the visits that COUNT. It used to
    //    count every row it was handed, while `server/team-calendar.ts` counts the rows
    //    `phoenix_crm_countable_visits` and `customer_validated` agree on: one rep's Tuesday read 3
    //    on the grid and 5 on the page the grid links to, with nothing to say which was right. On a
    //    team that has just started the gap is EVERY visit — measured 2026-10-02, 0 of Delta (1)'s
    //    1,551 carried-over customers were validated the day before it began.
    const held = dayDetailCounts([
      { ...scored, capturedAt: "2026-09-30T07:10:00.000Z", customerId: "1", customerName: "Scored", listType: "AM", pharmacyName: "El Ezaby" },
      // Saved, real, and in no figure: nobody has validated this customer yet.
      { capturedAt: "2026-09-30T08:00:00.000Z", countsInKpi: false, customerValidated: false, customerId: "2", customerName: "Waiting", listType: "PM", pharmacyName: "Seif" },
      // Validated, but off the plan and still with the approvers — the other half of the question.
      { capturedAt: "2026-09-30T09:00:00.000Z", countsInKpi: false, customerValidated: true, customerId: "3", customerName: "Off plan", listType: "PM", pharmacyName: null },
    ]);
    assert.deepEqual(held.counts, { am: 1, pharmacies: 1, pm: 0 }, "only the scored visit reaches a figure, pharmacies included");
    assert.equal(held.awaitingValidation, 1, "and what is held back is REPORTED, never dropped — a 0 with no reason is the defect");
    assert.equal(held.awaitingApproval, 1, "the two reasons stay apart: one is the list, the other is an approval");
    assert.equal(held.pharmacies.length, 2, "every pharmacy is still LISTED — the feedback was really taken");
    assert.deepEqual(
      held.pharmacies.map((entry) => entry.counted),
      [true, false],
      "and each one says whether it is inside the figure above it",
    );
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

    // 🔴 AND IT COUNTS FROM THE ROW'S OWN ANSWER, NEVER BY COUNTING ROWS. `countsInKpi` is
    //    `visitCountsInKpi`, the TypeScript twin of the countable view plus `customer_validated`.
    assert.match(service, /countsInKpi: visit\.countsInKpi/, "the service hands the row's own answer to the counter");
    assert.match(service, /customerValidated: visit\.customerValidated/, "and the reason it is held back, so the page can say so");
    const visits = stripComments(readFileSync("src/lib/phoenix-crm/server/visits.ts", "utf8"));
    assert.match(visits, /visitCountsInKpi\(\{/, "the row answers it once, through the one predicate");
    assert.match(visits, /validated_at/, "which means the read has to ask for validated_at by name — a view would have answered it");

    // Leave is HR's table, and a Phoenix CRM service may not read it (tests/phoenix-crm-boundary).
    assert.match(service, /loadApprovedLeaveDays/, "leave comes through the vacation module");
    assert.doesNotMatch(service, /v2_vacation_requests/, "and never by naming HR's table here");
    // 🔴 AND A FAILED LEAVE READ IS SAID, NEVER SWALLOWED. Caught and discarded, a day of approved
    //    leave reads exactly like a day the rep worked and logged nothing.
    assert.match(service, /leaveUnread = true/, "the day page reports a leave read it could not make");
    assert.match(screen, /view\.leaveUnread/, "and the screen prints the sentence");
    const calendarService = stripComments(readFileSync("src/lib/phoenix-crm/server/team-calendar.ts", "utf8"));
    assert.match(calendarService, /unread: true/, "the team calendar reports it too");
    assert.match(calendarService, /leaveUnread: leave\.unread/, "and carries it onto the view");
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
    //    would move the denominator under a manager while he reads the page. A week returned for ONE
    //    day still counts on its other days (owner, 2026-10-02, "Still planned"), so the plans that can
    //    hold a sent day are read and each planning is kept only on a day it was sent.
    assert.match(
      service,
      /from\("phoenix_crm_plans"\)[\s\S]{0,200}?\.in\("status", \[\.\.\.PLAN_STATUSES_WITH_SENT_DAYS\]\)/,
      "planned counts read plans that were actually sent",
    );
    assert.match(service, /isPlanDaySent\(\{ \.\.\.plan, date: day \}\)/, "on the days they were sent — never a draft day, never a returned one");
    assert.match(service, /from\("phoenix_crm_countable_visits"\)/, "and visits come from the countable view, never the raw table");

    const tab = stripComments(readFileSync("src/components/phoenix-crm/reports-tab.tsx", "utf8"));
    // 🔴 `SECTION_TITLES` moved to `src/lib/phoenix-crm/report-guide.ts` on 2026-10-03 (domain-first),
    // so the NAME lives in the guide and the tab only offers the section. Both halves are asserted —
    // the name alone would pass with nothing offering it, and vice versa.
    assert.match(tab, /offer\("frequency"\)/, "the section is offered");
    assert.match(
      stripComments(readFileSync("src/lib/phoenix-crm/report-guide.ts", "utf8")),
      // A NAME, never THAT name: the subject here is that the name lives in the guide and not in the
      // tab, and a rename of a report is ONE edit, in the guide (tests/phoenix-crm-reports-export.test.ts
      // section 9). Pinning the wording here would make it two.
      /frequency: "[^"]+"/,
      "and it is named there, not in the tab",
    );
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
    const mapKeys = activeMap.split(",").map((key) => key.trim());
    for (const key of ["frequency", "tracking"]) {
      assert.ok(mapKeys.includes(key), `the ${key} resource is in the map Refresh reads`);
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

  // 🔴 `through` IS WHERE THE MONTH HAS GOT TO, NOT WHERE IT ENDS — and the service passed the
  //    month's END for a RUNNING month, so on the 3rd every customer read a 28-day silence and the
  //    note fired on all of them: "then not again" about a customer the rep had seen yesterday.
  assert.equal(
    spacingNote(["2026-03-01", "2026-03-02"], "2026-03-31"),
    "Seen on the 1st and the 2nd, then not again.",
    "a FINISHED month measures the tail to its own end",
  );
  assert.equal(
    spacingNote(["2026-03-01", "2026-03-02"], "2026-03-03"),
    null,
    "the same two days on the 3rd of a RUNNING month say nothing — there is no silence to report yet",
  );

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

    // 🔴 WHO GETS THE NOTE IS DECIDED BY THE SERVER, FROM THE ONE PREDICATE THAT MEANS "a manager
    //    reading a seat that is not his own". It was `readsTeamReports(viewer)` until the audit of
    //    2026-10-02 found the acting District Manager who still holds a rep seat: a manager by that
    //    predicate, he read the note on his OWN sheet. `readsTeamReportsOn` is `readsTeamReports`
    //    less every seat the viewer is blind on (tests/phoenix-crm-blind-payloads.test.ts).
    assert.match(service, /const managerView = readsTeamReportsOn\(viewer, seat\);/, "the note is a manager's, decided per seat");
    assert.match(service, /buildTrackingSheet\(/, "and the helper gates it a second time, inside");
    assert.match(service, /\{ managerView \}/, "the decision is passed down, never re-made");

    // 🔴 AND THE SPACING WINDOW STOPS AT TODAY ON A RUNNING MONTH. `month.monthEnd` judged days
    //    nobody had lived yet; the end of the window is the EARLIER of the month's end and today.
    assert.match(
      service,
      /const spacingThrough = month\.monthEnd > viewer\.cairoToday \? viewer\.cairoToday : month\.monthEnd;/,
      "min(month end, today) — never the month's end on a running month",
    );
    assert.match(service, /^\s*spacingThrough,$/m, "and that window — not the month's end — is what reaches the helper");

    // 🔴 THE DROP DATE IS THE CAIRO ONE. `status_changed_at` is a timestamptz, so `slice(0, 10)` is
    //    the UTC day — and Cairo is UTC+2/+3, so every drop in the first two or three hours of a
    //    month read as the month before and took that customer out of the month he was worked in.
    assert.match(service, /cairoDayOfInstant\(changed\)/, "the Cairo day of the change, never a slice of the instant");
    assert.doesNotMatch(service, /changed\.slice\(0, 10\)/, "the UTC slice is gone");

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

    // 🔴 IT OPENS ON THE LAST MONTH WITH WORK IN IT (owner, 2026-10-01). Opening on the CURRENT
    //    month means opening on an empty grid every 1st of the month, and he had to press
    //    Previous month every single time to see anything at all.
    assert.match(service, /const asked = .*raw\.month.*\? String\(raw\.month\) : null/, "an explicit month is read first");
    assert.match(service, /const month = asked \?\?/, "and it always wins — this decides the FIRST load only, never a month somebody chose");
    assert.match(service, /latestWorkedMonth\(seatIds, isTest, thisMonth\)/, "otherwise the server finds the last worked month");
    assert.match(service, /\?\? thisMonth\)/, "and a scope that has never worked falls back to the current month");

    // What counts as work is what COLOURS a cell — a visit or a day activity, never leave and
    // never a Friday. Opening on a grid of F and dashes would answer the letter and not the point.
    assert.match(service, /newestOf\(\s*"phoenix_crm_countable_visits"/, "visits count as work");
    assert.match(service, /newestOf\(\s*"phoenix_crm_day_activities"/, "and so does a recorded day activity");
    assert.doesNotMatch(service, /newestOf\(\s*"[^"]*leave/i, "leave is not work");
    // 🔴 EACH SELECT LIST IS A LITERAL. PostgREST's types parse it at COMPILE time, so a template
    //    literal built from a column name resolves to a ParserError and not a row shape — the
    //    typecheck caught exactly that on the first cut of this function.
    assert.match(service, /\.select\("seat_id, visit_date"\)/, "the visit read names its columns literally");
    assert.match(service, /\.select\("seat_id, activity_date"\)/, "and so does the activity read");
    assert.doesNotMatch(service, /\.select\(`/, "no select list is ever built from a variable");
    // Capped, so an activity recorded ahead of time cannot open a manager on a month that has not
    // happened; and a BROKEN read throws rather than reading as "this scope has never worked",
    // which would quietly restore the old behaviour for ever.
    assert.match(service, /\.lte\("visit_date", lastDayOfCap\)/, "the search is capped at the current month");
    assert.match(service, /if \(error\) throw new Error/, "a failed read is an error, never an empty answer");

    // The client's half: it asks for NO month on the first load, which is what lets the server
    // choose, and its arrows step from the month ON SCREEN rather than from its own null.
    const screenSource = stripComments(readFileSync("src/components/phoenix-crm/calendar-tab.tsx", "utf8"));
    assert.match(screenSource, /useState<string \| null>\(null\)/, "no month is picked until he picks one");
    assert.match(screenSource, /month: picked/, "so the first request names none and the server answers with the month");
    assert.match(screenSource, /const month = picked \?\? view\.data\?\.month \?\?/, "the heading follows the server until he chooses");
    assert.match(screenSource, /setPicked\(shiftMonth\(month, step\.by\)\)/, "and an arrow steps from what is on screen, not from this month");

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

    // A manager can narrow the month to one rep (owner, 2026-10-17): the picker is the module's own
    // combo box, never offered to a rep reading only himself, and the month's three figures follow
    // whoever is drawn rather than keeping the whole team's.
    assert.match(screen, /const canChooseRep = !own && allRows\.length > 1;/, "a rep, or a team of one, is never offered a picker");
    assert.match(screen, /<CrmSelect\s+id="calendar-rep"/, "the rep picker is the module's CrmSelect, so an admin gets the combo box");
    assert.match(screen, /allRows\.filter\(\(row\) => row\.seatId === repSeat\)/, "choosing a rep draws only his row");
    assert.match(screen, /<CrmStat label="AM" value=\{totals\.am\} \/>/, "the AM figure follows the rep drawn");
    assert.doesNotMatch(screen, /view\.data\.totals\.(?:am|pm|pharmacies)/, "no figure reads the whole team's total behind the picker's back");

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

  // ── 🔴 PLACE AGAINST ACTUAL PAGES, AND BEFORE 2026-10-02 IT STOPPED DEAD AT 1,000 ─────────────
  //
  // PostgREST caps every response at `db-max-rows` (supabase/config.toml: 1000) and says NOTHING
  // when it does. `loadVisitLocationReport` read each seat batch with one unpaged `await query`, and
  // every figure on the report is computed over those rows — `total`, the far / weak-GPS / no-place
  // counts, `measured`, and `farthestMeters`. So each one was a figure over a truncated set wearing
  // the shape of a complete one, and the row a manager most needs (the farthest) is exactly what a
  // cut-off drops. It is silent by construction: 1,000 is a plausible number.
  {
    const service = stripComments(readFileSync("src/lib/phoenix-crm/server/reports.ts", "utf8"));
    const start = service.indexOf("export async function loadVisitLocationReport(");
    assert.notEqual(start, -1, "the place-vs-actual service is still there");
    // 🔴 THE END ANCHOR IS CODE, NEVER A COMMENT. `stripComments` blanks comments in place, so
    //    `indexOf("// ── Frequency")` finds nothing, returns -1, and `slice(start, -1)` hands back
    //    the whole rest of the file — every assertion below then reads the other services.
    const end = service.indexOf("export type CustomerFrequencyReportView", start);
    assert.ok(end > start, "and the next declaration bounds it");
    const body = service.slice(start, end);
    assert.match(body, /fetchAllRowsKeyset<Row>\(/, "the visits are read with a keyset walk");
    assert.match(body, /cursorColumn: "id"/, "on the primary key, like every other paged read in the module");
    assert.doesNotMatch(body, /const \{ data, error \} = await query/, "the single unpaged read is gone");

    // The config's cap is the reason, and it is a real number rather than a story.
    const config = readFileSync("supabase/config.toml", "utf8");
    assert.match(config, /max_rows\s*=\s*1000/, "the cap this guards against is the configured one");
  }

  console.log("phoenix-crm wave 2 reports: OK");
}
