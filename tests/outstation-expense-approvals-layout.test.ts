import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { displayPlace } from "../src/lib/outstation/place-label.ts";
import { tripSpan, tripSpanLabel } from "../src/lib/outstation/trip-span.ts";
import { stripComments } from "./support/comment-strip.ts";

// Expense Approvals, rebuilt (owner, 2026-11-06: "so untidy so confusing for me and specially when the
// trip is more than 1 day … the page needs a heavy big work").
//
// What was wrong: a three-day trip showed exactly like a same-day one (a Start and an End date four
// cells apart, nothing saying "three days"); the queue row cut names and places off with an ellipsis;
// the evidence was one long column — the workload table, then every day again with its visits and a
// Google map EACH, then the checks, then the photos — and only then the amount and the Approve button.
//
// These pins hold the shape rebuilt from scratch on 2026-11-07: the trip's length is ONE helper read
// everywhere; one stat line; the list is a narrow rail; the chosen trip fills the page — verdict
// tiles, every day open with every visit and check-in time and ITS OWN MAP (one map per day), the
// claim checks, the photos with their capture time and GPS; and ONE sticky decision bar.

export function runOutstationExpenseApprovalsLayoutTests() {
  // ── 1. The trip's length ────────────────────────────────────────────────────────────────────
  const same = tripSpan("2026-10-12", "2026-10-12");
  assert.equal(same.days, 1);
  assert.equal(same.multiDay, false);
  assert.equal(tripSpanLabel(same), "Same-day trip");

  const three = tripSpan("2026-10-12", "2026-10-14");
  assert.equal(three.days, 3, "start and end both count: 12, 13 and 14 October");
  assert.equal(three.nights, 2);
  assert.deepEqual(three.dayKeys, ["2026-10-12", "2026-10-13", "2026-10-14"]);
  assert.equal(tripSpanLabel(three), "3 days · 2 nights");
  assert.equal(tripSpanLabel(tripSpan("2026-10-12", "2026-10-13")), "2 days · 1 night");

  // A month end and a year end are calendar days, never clock arithmetic.
  assert.equal(tripSpan("2026-10-31", "2026-11-02").days, 3);
  assert.equal(tripSpan("2026-12-31T22:00:00.000Z", "2027-01-01").days, 2, "only the date part is read");

  // A missing, unreadable or backwards end date is a same-day trip — never an invented span.
  assert.equal(tripSpan("2026-10-12", "").days, 1);
  assert.equal(tripSpan("2026-10-12", null).days, 1);
  assert.equal(tripSpan("2026-10-14", "2026-10-12").days, 1);
  assert.deepEqual(tripSpan("", "2026-10-12").dayKeys, []);

  // ── 2. The screen ───────────────────────────────────────────────────────────────────────────
  // Rebuilt from scratch on 2026-11-07 (owner: "fully from scratch rebuild the expense approvals,
  // more premium, polished, more obvious, clear, more easy for design and human review"; his two
  // decisions: ONE TRIP FILLS THE SCREEN, and ONE COMPACT STAT LINE; then "make sure I see a map
  // and the visits on map, visit type, time saved and check-in and photo captured time at arrival
  // and departure — any information or data you have for the trip must be shown"; and ~01:00 on the
  // first cut's one trip-wide map: "in a multiple day trip separate each day from the other; if 3
  // days then I should have 3 maps").
  const workspace = stripComments(readFileSync("src/components/outstation/expense-approvals-workspace.tsx", "utf8"));
  const workload = stripComments(readFileSync("src/components/outstation/trip-workload-evidence.tsx", "utf8"));
  const rail = stripComments(readFileSync("src/components/outstation/expense-approvals/trip-list.tsx", "utf8"));
  const review = stripComments(readFileSync("src/components/outstation/expense-approvals/trip-review.tsx", "utf8"));
  const bar = stripComments(readFileSync("src/components/outstation/expense-approvals/decision-bar.tsx", "utf8"));
  const statLine = stripComments(readFileSync("src/components/outstation/expense-approvals/stat-line.tsx", "utf8"));
  const employees = stripComments(readFileSync("src/components/outstation/expense-approvals/employee-summary.tsx", "utf8"));
  const photos = stripComments(readFileSync("src/components/outstation/trip-evidence-photos.tsx", "utf8"));
  const screen = [workspace, rail, review, bar, statLine, employees, workload, photos].join("\n");

  // The workspace is the money container and composes the parts; the old in-file panel is gone.
  assert.doesNotMatch(workspace, /<ExpenseDecisionPanel\b|function ExpenseDecisionPanel\(/, "HEADLINE: the old decision panel is gone from the workspace");
  assert.doesNotMatch(workspace, /lg:overflow-y-auto|matchMedia|scrollIntoView\(\{ behavior/, "HEADLINE: no scroll box, no phone scroll-into-view hack");
  assert.match(
    workspace,
    /<TripList\b[\s\S]*?footer=\{<DecisionBar placement="rail" \{\.\.\.decisionBarProps\} \/>\}[\s\S]*?<TripReview\b[\s\S]*?<DecisionBar placement="bar" \{\.\.\.decisionBarProps\} \/>/,
    "HEADLINE: the decision sits in the left column under the list; the right side is the trip alone; a phone gets the slim row",
  );
  assert.match(rail, /\{footer \? <div className="phx-expense-rail-footer hidden shrink-0 lg:block">\{footer\}<\/div> : null\}/, "the rail's decision block is desktop-only — the phone sheet never carries it");
  assert.match(workspace, /valuesOnly=\{isImportedHistoryTrip\(selected\.date\)\}/, "imported history is still values only where TripReview is mounted");

  // One stat line, the ONLY place the four figures render.
  assert.match(workspace, /<StatLine\b/, "HEADLINE: one compact stat line at the top");
  assert.match(statLine, /data-stat-line/, "the stat line is one strip");
  assert.doesNotMatch(workspace, /awaiting decision|at stake|cleared to pay/, "no chips and no stat cards repeating the stat line");

  // ONE compact header (owner, 2026-11-07: "about half of the screen is wasted in the irrelevant
  // place … make smart screen that helps me and shows me the real data easily"). The hero, the
  // stat strip, the restored-drafts banner and the toolbar were four stacked blocks over the trips.
  assert.doesNotMatch(workspace, /<AdminPageHero\b/, "HEADLINE: no page hero over the trips");
  assert.match(
    workspace,
    /data-approvals-header>[\s\S]*?<h1\b[\s\S]*?<StatLine\b[\s\S]*?Export XLSX[\s\S]*?role="tablist"[\s\S]*?Filter by trip month[\s\S]*?Filter by employee[\s\S]*?Clear all/,
    "HEADLINE: one panel — title, figures and Export on one line; views, search and filters on the next",
  );
  assert.match(workspace, /title=\{`Brought back /, "restored, unsaved decisions are a small chip carrying the full sentence");
  assert.doesNotMatch(workspace, /<AdminCallout tone="warning">\s*<AlertTriangle[^>]*\/>\s*<span>\s*Brought back/, "never the full-width restored-drafts banner");
  assert.doesNotMatch(statLine, /PANEL_CLASS|grid-cols-4/, "the stat line sits inline in the header, never a panel of its own");

  // The rail: narrow, sticky and window-high on a desktop; a fixed sheet on a phone, no portal.
  assert.match(rail, /lg:w-\[19rem\]/, "the list is the rail");
  // Owner's review, 2026-11-07 (scored 2 of 10): the decision panel scrolled away with the page. The
  // sticky sat on the box INSIDE the aside, and the aside was exactly that box's height, so it had
  // nowhere to travel. The sticky is on the aside itself, under the frozen top bar, whose height
  // the app shell publishes (chrome-height-probe.tsx) — divided by the zoom <main> wears.
  assert.match(rail, /<aside className="phx-expense-rail /, "HEADLINE: the WHOLE aside is the sticky rail");
  assert.doesNotMatch(rail, /lg:sticky/, "never the box inside it again");
  const css = readFileSync("app/globals.css", "utf8");
  const railRule = css.match(/\.phx-expense-rail \{[^}]*\}/)?.[0] ?? "";
  assert.match(railRule, /position: sticky/, "HEADLINE: the rail is sticky on a desktop");
  assert.match(railRule, /top: calc\(var\(--phx-chrome-h, 104px\) \/ var\(--phx-scale-applied, 1\) \+ 1rem\)/, "HEADLINE: pinned UNDER the top bar, corrected for the zoom");
  assert.match(railRule, /align-self: flex-start/, "and as tall as its content, so it can travel the row");
  assert.match(css, /\.phx-expense-rail-footer \{[^}]*overflow-y: auto/, "an open Adjust panel scrolls inside the rail, never pushing Approve off screen");
  const shell = stripComments(readFileSync("src/components/layout/app-shell.tsx", "utf8"));
  assert.match(shell, /<div className="sticky top-0 z-30">[\s{}]*<ChromeHeightProbe \/>/, "the shell measures its frozen chrome");
  const probe = readFileSync("src/components/layout/chrome-height-probe.tsx", "utf8");
  assert.match(probe, /new ResizeObserver\(publish\)/, "and keeps the height current as the chrome changes");
  assert.match(probe, /setProperty\("--phx-chrome-h"/, "publishing it as --phx-chrome-h");
  assert.match(rail, /fixed inset-0 z-40/, "HEADLINE: on a phone the list is a full-height sheet");
  assert.doesNotMatch(rail, /scrollIntoView\(|createPortal/, "the sheet needs no scrolling and no portal");
  assert.match(
    rail,
    /const span = tripSpan\(record\.date, record\.toDate\);[\s\S]*?span\.multiDay \? \([\s\S]*?\{formatNumberValue\(span\.days\)\} days/,
    "a queue row names a multi-day trip's length beside its dates",
  );
  assert.match(rail, /\{displayPlace\(place\)\}/, "a row prints the place in words, never the plus-code prefix");

  // The trip as a page: nothing folded, nothing in a scroll box, one map drawn for EVERY day.
  assert.match(review, /\{tripSpanLabel\(span\)\}/, "the trip page states the trip's length in words");
  assert.match(review, /Trip \{formatNumberValue\(position\.index\)\} of \{formatNumberValue\(position\.total\)\}/, "the page says where the trip sits and walks the list with Previous / Next");
  assert.match(
    review,
    /<RouteFact from=\{displayPlace\(record\.from\)\} to=\{displayPlace\(destination\)\} toTitle=\{destination\} \/>/,
    "the route wraps (RouteFact), never scrolls sideways, and reads the place in words at both ends — the stored address is the tooltip",
  );
  assert.doesNotMatch(review, /Stored address/, "HEADLINE: no second 'Stored address · 6W33+64C…' line under the route (owner's review, 2026-11-07)");
  const primitives = readFileSync("src/components/outstation/approval-detail-primitives.tsx", "utf8");
  assert.equal(
    (primitives.match(/className="m-0 min-w-0 break-words text-left" dir="auto"/g) ?? []).length,
    2,
    "HEADLINE: From and To start at the same edge — an Arabic From still reads right to left inside it",
  );
  assert.doesNotMatch(review, /overflow-y-auto|CollapsibleSection|<details/, "HEADLINE: nothing on the trip page is folded or boxed into its own scroll");
  const verdictAt = review.indexOf("data-verdict-strip");
  const daysAt = review.indexOf('id="trip-field-work"');
  assert.ok(verdictAt > 0 && daysAt > verdictAt, "HEADLINE: the three verdict tiles come before the days and their maps");
  assert.doesNotMatch(review, /id="trip-map"|The trip on one map/, "HEADLINE: there is no trip-wide map any more — each day draws its own");
  // ONE MAP PER DAY: the page hands every day block its own map, and the block draws it.
  assert.match(review, /<TripWorkloadEvidencePanel\b[^>]*\balwaysOpen\b/, "HEADLINE: every trip day is open, no folding");
  assert.match(review, /renderDayMap=\{\(day, firstCheckinNumber\) => \(\s*<DayMap\b/, "HEADLINE: every day block gets its own map (if 3 days then 3 maps)");
  assert.match(workload, /map=\{renderDayMap\?\.\(day, firstCheckinNumber\)\}/, "and the always-open day block draws the map it is handed");
  assert.match(
    workload,
    /\{map\}\s*\{visits\.length > 0 \|\| checkins\.length > 0 \? \(\s*<div[^>]*>\s*<DayDetail\b/,
    "HEADLINE: the map comes first and the day's visits and check-ins are listed UNDER it, inside the day's own box",
  );
  const dayMapAt = review.indexOf("function DayMap(");
  const mapTag = review.indexOf("<FieldWorkforceRouteMap", dayMapAt);
  assert.ok(dayMapAt > 0 && mapTag > dayMapAt, "HEADLINE: the day map is drawn by DayMap");
  // The one condition in front of a day's map is "has it scrolled into view" — a latch set once by
  // an IntersectionObserver and never cleared — so a six-day trip costs one Google map load at a
  // time, and nothing is ever behind a click.
  const beforeMap = review.slice(dayMapAt, mapTag);
  assert.deepEqual(beforeMap.match(/\? \(|&& \(/g), ["? (", "? ("], "two conditions stand before the day map: scrolled into view, and has it anything to draw");
  assert.match(beforeMap, /\{seen \? \(\s*empty \? \(\s*<DayMapEmpty \/>\s*\) : \($/m, "the latch, then the empty-day line — never an open/closed state");
  // A day with nothing of its own to pin and no route on it is ONE line (owner's review, 2026-11-07).
  assert.match(review, /const empty = !loading && pinned === 0 && !tripRoute;/, "HEADLINE: an empty day is known before any map is drawn");
  assert.match(review, /\) : empty \? \(\s*<DayMapEmpty \/>/, "and never even gets the map-sized placeholder");
  assert.match(review, /empty: "No GPS points this day"/, "HEADLINE: it says so in five words");
  // The legend: the " · " sits OUTSIDE the place's own direction, so coordinates never run into an
  // Arabic name and no "·" is left dangling at the wrong end.
  assert.doesNotMatch(review, /<span dir="auto"> · /, "HEADLINE: no separator inside a dir=auto span");
  assert.equal((review.match(/\{" · "\}\s*<bdi dir="auto">/g) ?? []).length, 4, "the four legend places each sit in a <bdi> after the separator");
  assert.match(review, /submittedLabel=\{submittedLabel\}/, "the submitted-from place is passed as words, never cut out of the pin's title");
  // The rep's words only; the system's allowance sentences on a line of their own.
  assert.match(review, /data-allowance-notices/, "HEADLINE: the allowance notices have their own line");
  const latchAt = review.indexOf("function useSeenOnce");
  const latch = review.slice(latchAt, dayMapAt);
  assert.ok(latchAt > 0 && /new IntersectionObserver\(/.test(latch) && /setSeen\(true\)/.test(latch), "the latch is set by an IntersectionObserver");
  assert.doesNotMatch(latch, /setSeen\(false\)/, "and never cleared — a drawn map stays drawn");
  assert.match(review, /className="h-\[360px\] border border-slate-200 bg-slate-50 sm:h-\[420px\]"/, "the box before the map is the map's own size, so the page never jumps");
  // The point the request was submitted from is a hollow pin on EVERY day's map.
  assert.match(review, /typeof record\.capturedLatitude === "number" && typeof record\.capturedLongitude === "number"/, "the submission point is read from the record");
  assert.match(review, /destination=\{submittedAt\}/, "HEADLINE: and drawn as the hollow pin on each day's map");
  assert.equal((review.match(/submittedAt=\{submittedAt\}/g) ?? []).length, 2, "both the CRM day blocks and the no-CRM fallback days get it");
  assert.match(review, /frame="bare"/, "the map on the trip page is the bare square, the card frame stays for the compliance page");
  assert.match(review, /photo\.kind === "arrival" \? firstDay : lastDay/, "the arrival photo is pinned on the first day's map, the departure photo on the last");
  assert.match(review, /add\(cairoDayKey\(stop\.capturedAt\)/, "a journey stop is pinned on the day it was captured, read in Cairo");
  assert.match(review, /<ExpenseClaimValidationPanel bare /, "the claim checks are listed open");
  assert.match(review, /data-map-legend/, "a legend names every pin on each day's map");

  // Everything the trip has is printed: visit times, check-in times, photo capture time and GPS.
  assert.match(workload, /\{formatClock\(visit\.submittedAt\)\}/, "HEADLINE: the time each visit was saved is printed");
  assert.match(workload, /\{formatClock\(checkin\.at\)\}/, "HEADLINE: the time of each check-in is printed");
  assert.match(workload, /function TripDayOpen\(/, "the always-open day block exists beside the folded one the request centre keeps");
  assert.match(workload, /days with no field activity/, "a long trip says how many of its days had no field work");
  assert.match(photos, /\{photo\.latitude\.toFixed\(5\)\}, \{photo\.longitude\.toFixed\(5\)\}/, "HEADLINE: a photo card prints its captured GPS");
  assert.match(photos, /href=\{`https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=\$\{photo\.latitude\.toFixed\(6\)\},\$\{photo\.longitude\.toFixed\(6\)\}`\}/, "HEADLINE: and the GPS opens that point in Google Maps");
  assert.match(photos, /\{displayPlace\(photo\.locationLabel\)\}/, "the photo's place reads in words");
  assert.match(photos, /Captured with the live camera\./, "and whether it was a live capture");

  // The decision bar: the page's ONE sticky footer, holding Approve, Reject and Save.
  assert.match(bar, /"sticky bottom-0 z-20 border-t-2 border-slate-900 bg-white lg:hidden"/, "HEADLINE: the sticky row exists for a phone only — nothing is fixed over the trip on a desktop");
  assert.match(bar, /Adjust · reason/, "the row is slim: the deduction and the reason fold out on request");
  assert.match(bar, /onClick=\{approve\}/, "Approve lives in the bar (it applies a pre-cut first)");
  assert.match(bar, /Save \{formatNumberValue\(dirtyCount\)\}/, "and so does Save");
  assert.doesNotMatch(workspace, /sticky bottom-4/, "the old floating Save bar is gone — never two bottom bars");
  // The Adjust panel (owner's review, 2026-11-07, 5 of 10): Approved dropped to a line of its own,
  // the reason box held one line of a long sentence, and the folded system text read as his own.
  assert.match(bar, /<div className="grid grid-cols-3 items-end gap-x-2 gap-y-2" data-amount-equation>/, "HEADLINE: Claimed − Deduction = Approved is one three-column row");
  assert.equal((bar.match(/"mt-1 block w-full min-w-0 text-right font-mono/g) ?? []).length, 2, "both inputs fill their column");
  assert.match(bar, /box\.style\.height = "auto";[\s\S]*?box\.scrollHeight/, "HEADLINE: the reason box grows with its wrapped text");
  assert.match(bar, /Math\.max\(wanted, line \* 3 \+ chrome\), ceiling/, "from three rows to ten");
  assert.match(bar, /Why it is held ·/, "HEADLINE: the folded system sentence is labelled as the system's");
  // The stat line says what a filtered count is out of.
  assert.match(statLine, /of \{formatNumberValue\(cell\.of\)\}/, "HEADLINE: narrowed, a count reads '109 of 163'");
  assert.match(statLine, /data-stat-filtered/, "and the line is tagged Filtered");
  assert.match(workspace, /narrowed=\{narrowed\}\s*overall=\{overallCounts\}/, "fed the whole-queue counts");
  assert.match(rail, /data-rail-count>[\s\S]*?\{formatNumberValue\(pendingCount\)\} awaiting[\s\S]*?\{formatNumberValue\(activeList\.length\)\} of \{formatNumberValue\(totalCount\)\} trips/, "the rail header: awaiting, then shown of total");
  // The rail's order is remembered per reviewer, never shared across people on one PC.
  assert.match(workspace, /ownerScopedStorageKey\(EXPENSE_APPROVAL_VIEW_KEY_BASE, viewerHrId\)/, "HEADLINE: Biggest / Oldest first is remembered per reviewer");
  assert.match(workspace, /onSort=\{chooseSort\}/, "and written when he picks it");
  // By employee and the claim checks.
  assert.equal((employees.match(/\{displayPlace\(row\.destination\) \|\| "—"\}/g) ?? []).length, 2, "HEADLINE: By employee reads the place in words on desktop and phone");
  assert.equal((employees.match(/title=\{row\.destination \|\| undefined\}/g) ?? []).length, 2, "the stored address is the tooltip");
  const checks = stripComments(readFileSync("src/components/outstation/expense-claim-validation-panel.tsx", "utf8"));
  assert.match(checks, /\{orderClaimChecks\(state\.data\.checks\)\.map\(/, "HEADLINE: problems first");
  assert.match(checks, /\{bare \? null : \(/, "on the trip page the headline sentence is never said twice");
  assert.match(checks, /bare && check\.verdict === "clean" \? \(/, "a passed check is one line on the trip page");

  // By employee is still a fitted table with cards on a phone.
  assert.match(
    employees,
    /<table className="hidden w-full table-fixed border border-slate-200 bg-white text-xs md:table">\s*<colgroup>/,
    "a person's trips are a fitted table on a desktop (AGENTS.md §4), with cards on a phone",
  );

  // The premium rules, over the whole screen.
  assert.doesNotMatch(screen, /\btruncate\b/, "nothing on the approvals screen is cut off with an ellipsis (AGENTS.md §4)");
  assert.doesNotMatch(screen, /bg-gradient-to-/, "flat, never a gradient");
  assert.doesNotMatch(screen, /overflow-x-auto|\bw-max\b/, "HEADLINE: nothing on the approvals screen scrolls sideways");

  // A place in words: the plus code goes, the postal code and the country go, Arabic is untouched.
  assert.equal(displayPlace("3CGJ+3G, Nasr City, Cairo Governorate 4450113, Egypt"), "Nasr City, Cairo Governorate");
  assert.equal(displayPlace("6W25+MQF Mahatet El Raml, Alexandria, Egypt"), "Mahatet El Raml, Alexandria");
  assert.equal(displayPlace("شارع الهرم، الجيزة، مصر"), "شارع الهرم، الجيزة");
  assert.equal(displayPlace("Sohag"), "Sohag");
  assert.equal(displayPlace("3CGJ+3G"), "3CGJ+3G", "a place that is only a plus code keeps its text rather than vanishing");
  assert.equal(displayPlace(""), "—");
  assert.equal(displayPlace(null), "—");

  // ── 3. Save sends only what he changed (owner, 2026-11-06: "the Save button very long to save") ──
  // The outstation workflow reads every app-submitted claim it is sent from the database twice, one
  // after another, before it can skip an unchanged one — so posting the whole queue made one Approve
  // wait on hundreds of round trips. An app claim goes only when its decision changed; an imported
  // sheet row still travels with its whole report, whose totals are recomputed from that set.
  const posted = workspace.match(/const isPostedOnSave = \(record: LoadedRecord\) => \{[\s\S]*?\n {6}\};/)?.[0];
  assert.ok(posted, "HEADLINE: save() decides row by row what it posts");
  assert.match(posted, /outstationRequestIdFromTripId\(record\.tripId\) === null\) return true;/, "an imported row keeps its whole report");
  assert.match(posted, /expenseDecisionChanged\(local, savedDecision\(record\)\)/, "an app claim goes only when its decision changed");
  assert.match(workspace, /records: reportRecords\.filter\(isPostedOnSave\)\.map\(/, "HEADLINE: the body carries only those rows");
}
