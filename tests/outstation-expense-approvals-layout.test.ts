import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

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
// The first rebuild (2026-11-07 ~00:30) gave the trip a page of its own beside a narrow rail; the live
// tour of it (636f0fc) still found Approve under the fold. At ~03:20 the owner had it retired and
// rebuilt from scratch in the Phoenix CRM identity: a Place checks list page, and every trip decided in
// the full-screen "Review one by one" reviewer. These pins hold that shape: the trip's length is ONE
// helper read everywhere; six tiles that each say what a filtered count is out of; the reviewer's dark
// evidence stage with ONE MAP PER DAY; and the decision pinned at the foot of its column.

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
  // RETIRED AND REBUILT FROM SCRATCH IN THE PHOENIX CRM IDENTITY (owner, 2026-11-07 ~03:20: "retire
  // the current expense approval and rebuild from scratch, same Phoenix CRM identity"). The live tour
  // of the rail-and-page build (636f0fc) found Approve 57px under the fold at the top of a trip, an
  // Adjusted count with no "of N", and a stack of panels rather than one Phoenix screen.
  //
  // The list page is drawn as Place checks draws its own (hero, six tiles, tabs, filter bar, advice,
  // a fixed table with phone cards); every trip is decided in the full-screen "Review one by one"
  // reviewer — the dark evidence stage on the left, the white column on the right, the decision
  // pinned at its foot. Every day still draws ITS OWN MAP ("if 3 days then I should have 3 maps").
  const dir = "src/components/outstation/expense-review";
  const read = (file: string) => stripComments(readFileSync(`${dir}/${file}`, "utf8"));
  const workspace = read("expense-review-workspace.tsx");
  const header = read("review-header.tsx");
  const stats = read("review-stats.tsx");
  const tabs = read("review-tabs.tsx");
  const filters = read("review-filters.tsx");
  const table = read("review-queue-table.tsx");
  const employees = read("employee-roll-up.tsx");
  const deck = read("review-deck/deck.tsx");
  const stage = read("review-deck/deck-stage.tsx");
  const subject = read("review-deck/deck-subject.tsx");
  const found = read("review-deck/deck-found.tsx");
  const decision = read("review-deck/deck-decision.tsx");
  const review = read("review-deck/deck-days.tsx");
  const workload = stripComments(readFileSync("src/components/outstation/trip-workload-evidence.tsx", "utf8"));
  const photos = stripComments(readFileSync("src/components/outstation/trip-evidence-photos.tsx", "utf8"));
  const screen = [
    workspace,
    header,
    stats,
    tabs,
    filters,
    table,
    employees,
    deck,
    stage,
    subject,
    found,
    decision,
    review,
    read("review-parts.tsx"),
    read("review-banners.tsx"),
    read("review-bulk-bar.tsx"),
  ].join("\n");

  // The old screen is gone, file and all — and so is everything that existed only for it.
  for (const retired of [
    "src/components/outstation/expense-approvals-workspace.tsx",
    "src/components/outstation/expense-approvals",
    "src/components/layout/chrome-height-probe.tsx",
  ]) {
    assert.equal(existsSync(retired), false, `HEADLINE: ${retired} is retired`);
  }
  const css = readFileSync("app/globals.css", "utf8");
  assert.doesNotMatch(css, /phx-expense-rail/, "the rail's sticky rules went with the rail");
  assert.doesNotMatch(readFileSync("src/components/layout/app-shell.tsx", "utf8"), /ChromeHeightProbe/, "and the chrome probe that only the rail read");
  const page = stripComments(readFileSync("app/(admin)/admin/outstation/expense-approvals/page.tsx", "utf8"));
  assert.match(
    page,
    /<CrmSurfaceProvider surface="admin">\s*<ExpenseReviewWorkspace canDecide=\{canDecideOutstationExpenseApprovals\(access\)\} viewerHrId=\{access\.hrId\} \/>/,
    "HEADLINE: the route mounts the rebuilt screen inside the Phoenix CRM admin surface",
  );

  // The list page, in the Place checks order: hero (carrying the advice), the stat strip, tabs,
  // filters, save strip, list.
  const order = ["<ReviewHeader", "<ReviewStatTiles", "<ReviewTabs", "<ReviewFilters", "<ReviewSaveStrip", "<ReviewQueueTable", "<ExpenseReviewDeck"];
  const at = order.map((tag) => workspace.indexOf(tag));
  assert.ok(at.every((index, i) => index > 0 && (i === 0 || index > at[i - 1])), `HEADLINE: the list page reads top to bottom ${order.join(" → ")}`);
  assert.match(header, /<AdminPageHero\b/, "the page wears the admin hero, as Place checks does");
  assert.match(header, /Review one by one/, "HEADLINE: one orange button opens the reviewer");
  assert.match(header, /Export XLSX/);

  // Owner, 2026-11-07, circling everything above the first trip: "the screen is consumed in
  // irrelevant place". The band over the trips is compact, and nothing in it says a thing twice.
  assert.match(header, /\bcompact\n\s*description=\{advice\}/, "HEADLINE: the hero is compact and its one sentence is the live advice");
  assert.match(workspace, /reviewAdvice\(review\.stats, egp\)/, "built from the live figures, so it agrees with them");
  assert.doesNotMatch(workspace, /<ReviewAdvice\b/, "HEADLINE: no separate advice box under the hero");
  assert.doesNotMatch(stats, /AdminStatCard/, "HEADLINE: the six figures are one slim strip, never six tall cards");
  assert.match(stats, /data-stat-strip/, "one band, six cells");
  assert.doesNotMatch(filters, />Filters<\/h2>/, "HEADLINE: the filter bar has no heading row of its own");
  assert.match(filters, /data-save-strip[\s\S]*?<p className="min-w-0 flex-1 basis-72 /, "HEADLINE: N unsaved · Save N is one line, never a three-line banner");
  assert.match(workspace, /className="min-w-0 space-y-3" data-expense-review/, "and the parts sit close");
  // Owner, 2026-11-07: "fold the expense table heading into one line".
  const bulk = read("review-bulk-bar.tsx");
  assert.doesNotMatch(table, /<AdminTableShell\b/, "HEADLINE: the trips' table has no three-row section header");
  assert.match(
    table,
    /data-table-heading>\s*<h2 [^>]*title=\{REVIEW_TAB_DESCRIPTIONS\[tab\]\}>[\s\S]*?<\/h2>\s*\{!loading && !loadError && rows\.length > 0 \? bulkBar : null\}\s*<\/div>/,
    "HEADLINE: the tab's title and the tick-and-approve controls share ONE heading line; the tab's sentence is the title's hover",
  );
  assert.doesNotMatch(bulk, /border-b border-slate-200 bg-slate-50 px-4 py-3/, "HEADLINE: the bulk controls are never a band of their own");

  // Six tiles, and EVERY ONE says what a filtered count is out of — Adjusted included.
  for (const key of ["pending", "look", "clean", "approved", "adjusted", "rejected"]) {
    assert.match(stats, new RegExp(`key: "${key}",`), `the ${key} tile is there`);
  }
  assert.match(stats, /const outOf = \(key: keyof ReviewStats\) => countOutOf\(stats\[key\], narrowed \? overall\[key\] : null\);/, "HEADLINE: one rule gives every tile its 'of N'");
  assert.match(stats, /of \{formatNumberValue\(figure\.of\)\}/, "and it is printed on the tile");
  assert.match(workspace, /narrowed=\{review\.narrowed\}\s*onOpenTab=\{review\.chooseTab\}\s*overall=\{review\.overallStats\}/, "fed the whole-queue figures; a tile opens its tab");

  // The tabs: the Place checks tablist, keyboard included.
  assert.match(tabs, /role="tablist"/);
  assert.match(tabs, /event\.key === "Home" \? 0/, "Home and End move between the tabs");
  assert.match(filters, /className="sticky top-2 z-20 /, "HEADLINE: N unsaved · Save N stays in reach while the list scrolls");
  assert.match(filters, /restored · unsaved/, "restored drafts say so, small, on the save strip");

  // The list: a fixed table on a desktop, cards on a phone (drawn first), twenty at a time.
  assert.ok(table.indexOf("<CrmCardsOnPhone>") > 0 && table.indexOf("<CrmCardsOnPhone>") < table.indexOf("<CrmTable"), "HEADLINE: phone cards, then the fixed desktop table");
  assert.match(table, /<CrmTable columns=\{\["3rem", "30%", null, "15%", "19%"\]\}>/, "named columns that fit the panel");
  assert.match(table, /<CrmShowMore /, "and twenty rows at a time");
  assert.match(table, /\{displayPlace\(/, "a row prints the place in words, never the plus-code prefix");
  assert.match(employees, /<CrmCardsOnPhone>[\s\S]*?<CrmTable /, "By employee is a fitted table with cards on a phone");

  // The reviewer: the Place checks deck, for an expense claim.
  assert.match(deck, /createPortal\(/, "HEADLINE: the reviewer is the whole screen");
  assert.match(deck, /className="fixed inset-0 z-\[200\] flex flex-col bg-slate-950 text-white"/, "on black, over everything");
  assert.match(deck, /Expense approvals<\/p>[\s\S]{0,200}Review one by one/, "the orange kicker and the title");
  assert.match(deck, /role="tablist"/, "the tabs ride in its header, with their counts");
  assert.match(deck, /style=\{\{ width: `\$\{progress\}%` \}\}/, "and a progress line under them");
  assert.match(deck, /aria-label="Close the review"/);
  assert.match(deck, /deckArrowStep\(\{/, "HEADLINE: ← and → move between trips through the Place checks rule (never while typing)");
  assert.doesNotMatch(deck, /event\.key === "Enter"|key === "a"|key === "r"/, "HEADLINE: no key decides anything");
  assert.match(deck, /useDialogA11y</, "Esc closes, focus is trapped, the page behind it does not scroll");
  assert.match(deck, /<section aria-label="The evidence" className="relative h-\[55svh\] min-h-0 min-w-0 bg-slate-950 lg:h-auto lg:flex-1">/, "HEADLINE: the evidence fills the dark stage on the left");
  assert.match(deck, /lg:w-\[460px\] lg:flex-none xl:w-\[500px\]/, "and the white column holds the rest on the right");

  // 🔴 APPROVE IS ON SCREEN AT THE TOP OF A TRIP: the decision is pinned at the foot of the column, the
  // facts scroll above it, and the pinned band is capped so it never pushes Back / Next off screen.
  const pinned = deck.indexOf("<DeckDecisionBar");
  assert.ok(pinned > deck.indexOf("data-deck-column"), "HEADLINE: the decision bar sits under the scrolling column, not inside it");
  assert.match(deck, /<div className="min-w-0 px-5 py-3 lg:max-h-\[45vh\] lg:overflow-y-auto">\s*<DeckDecisionBar/, "HEADLINE: pinned and capped at 45% of the screen");
  assert.match(deck, /<div className="min-w-0 lg:min-h-0 lg:flex-1 lg:overflow-y-auto" data-deck-column>/, "the facts scroll on their own above it");
  assert.match(deck, /aria-label="Move between trips"/, "Back / Next under it");
  assert.match(decision, /data-deck-approve/, "Approve is the pinned bar's");
  assert.match(decision, /Save \{formatNumberValue\(dirtyCount\)\}/, "and so is Save");
  const bar = decision.slice(decision.indexOf("export function DeckDecisionBar("));
  assert.doesNotMatch(bar, /data-amount-equation|<textarea/, "HEADLINE: the pinned bar is one short band — the equation and the reason box live in the column above");

  // The column: who and what, what the system found, the decision.
  const column = ["<DeckSubject", "<DeckFound", "<DeckAdjust"].map((tag) => deck.indexOf(tag));
  assert.ok(column.every((index, i) => index > 0 && (i === 0 || index > column[i - 1])), "HEADLINE: subject → what the system found → your decision");
  assert.match(subject, /\{tripSpanLabel\(span\)\}/, "the trip's length in words");
  assert.match(subject, /title=\{destination \|\| undefined\}/, "the stored address is the To's tooltip, never a second line");
  assert.doesNotMatch(subject, /Stored address/);
  assert.equal(
    (subject.match(/className="min-w-0 break-words text-left" dir="auto"/g) ?? []).length,
    3,
    "HEADLINE: From, To and the submitted-from place all start at the left edge, Arabic too",
  );
  assert.match(subject, /className="m-0 min-w-0 break-words text-left text-sm font-semibold text-slate-900" dir="auto"/, "HEADLINE: brick, area and region values are left-aligned (live review: the brick right-aligned)");
  assert.doesNotMatch(screen, /font-mono/, "HEADLINE: no monospace anywhere on the screen — figures are tabular-nums");
  // The reviewer's field-work view is the shared verified-workload block, so it is held to the same
  // rules (live tour of d67cacc: "AM 0 · PM 0 · Pharmacies 0" in monospace, a round "No activity").
  assert.doesNotMatch(workload, /font-mono/, "HEADLINE: the verified-workload counts are tabular-nums, never monospace");
  assert.match(workload, /<Badge className="rounded-none" variant=\{tone\}>/, "HEADLINE: the workload verdict is square, not the shared round pill");
  assert.match(subject, /<p className="shrink-0 text-left" data-subject-claimed>/, "HEADLINE: \"Claimed\" starts where its amount starts, even wrapped under a long name");
  assert.match(found, /What the system found/, "HEADLINE: the Place checks reviewer's own section");
  assert.match(found, /data-found-signal=\{one\.key\}/, "each finding is a button");
  assert.match(found, /onClick=\{\(\) => onView\(one\.key\)\}/, "that puts its evidence on the stage");
  assert.match(found, /data-allowance-notices/, "the allowance notices have their own line");

  // The stage: three views, all mounted, one shown.
  for (const view of ["field", "photos", "checks"]) {
    assert.match(stage, new RegExp(`view === "${view}" \\? null : "hidden"`), `the ${view} view stays mounted while hidden`);
  }
  assert.match(stage, /<ExpenseClaimValidationPanel bare /, "the claim checks are listed open");
  assert.match(stage, /<TripAttachments onLoaded=\{onAttachments\} tripId=\{record\.tripId\} \/>/, "the photos, stops and tickets panel the Held requests screen uses");

  // ONE MAP PER DAY: the page hands every day block its own map, and the block draws it.
  assert.match(review, /<TripWorkloadEvidencePanel\b[^>]*\balwaysOpen\b/, "HEADLINE: every trip day is open, no folding");
  assert.match(review, /renderDayMap=\{\(day, firstCheckinNumber\) => \(\s*<DayMap\b/, "HEADLINE: every day block gets its own map (if 3 days then 3 maps)");
  assert.match(workload, /map=\{renderDayMap\?\.\(day, firstCheckinNumber\)\}/, "and the always-open day block draws the map it is handed");
  const dayMapAt = review.indexOf("function DayMap(");
  const mapTag = review.indexOf("<FieldWorkforceRouteMap", dayMapAt);
  assert.ok(dayMapAt > 0 && mapTag > dayMapAt, "HEADLINE: the day map is drawn by DayMap");
  assert.match(review, /const empty = !loading && pinned === 0 && !tripRoute;/, "HEADLINE: an empty day is known before any map is drawn");
  assert.match(review, /\{empty \? \(\s*<p [^>]*data-day-map-empty>/, "and is one line, never a map-sized box");
  assert.match(review, /empty: "No GPS points this day"/, "HEADLINE: it says so in five words");
  assert.match(review, /\) : seen \? \(\s*<FieldWorkforceRouteMap/, "HEADLINE: a day's map is created only once it comes into view");
  const latchAt = review.indexOf("function useSeenOnce");
  const latch = review.slice(latchAt, dayMapAt);
  assert.ok(latchAt > 0 && /new IntersectionObserver\(/.test(latch) && /setSeen\(true\)/.test(latch), "the latch is set by an IntersectionObserver");
  assert.doesNotMatch(latch, /setSeen\(false\)/, "and never cleared — a drawn map stays drawn");
  assert.match(latch, /addEventListener\("scroll", check, \{ capture: true, passive: true \}\)/, "HEADLINE: inside the reviewer the evidence scrolls in its own box, so the fallback listens in the capture phase");
  assert.match(latch, /if \(box\.width === 0 && box\.height === 0\) return;/, "HEADLINE: a hidden view's map is never created early — a zero-sized box is not on screen");
  assert.match(review, /className="h-\[360px\] border border-slate-200 bg-slate-50 sm:h-\[420px\]"/, "the box before the map is the map's own size, so the column never jumps");
  assert.doesNotMatch(review, /<span dir="auto"> · /, "HEADLINE: no separator inside a dir=auto span");
  assert.equal((review.match(/\{" · "\}\s*<bdi dir="auto">/g) ?? []).length, 4, "the four legend places each sit in a <bdi> after the separator");
  assert.match(review, /submittedLabel=\{submittedLabel\}/, "the submitted-from place is passed as words");
  assert.match(review, /typeof record\.capturedLatitude === "number" && typeof record\.capturedLongitude === "number"/, "the submission point is read from the record");
  assert.match(review, /destination=\{submittedAt\}/, "HEADLINE: and drawn as the hollow pin on each day's map");
  assert.equal((review.match(/submittedAt=\{submittedAt\}/g) ?? []).length, 2, "both the CRM day blocks and the no-CRM fallback days get it");
  assert.match(review, /frame="bare"/, "the bare square map");
  assert.match(review, /photo\.kind === "arrival" \? firstDay : lastDay/, "the arrival photo on the first day's map, the departure photo on the last");
  assert.match(review, /add\(cairoDayKey\(stop\.capturedAt\)/, "a journey stop on the day it was captured, read in Cairo");
  assert.match(review, /data-map-legend/, "a legend names every pin on each day's map");

  // Everything the trip has is printed: visit times, check-in times, photo capture time and GPS.
  assert.match(workload, /\{formatClock\(visit\.submittedAt\)\}/, "HEADLINE: the time each visit was saved is printed");
  assert.match(workload, /\{formatClock\(checkin\.at\)\}/, "HEADLINE: the time of each check-in is printed");
  assert.match(photos, /href=\{`https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=\$\{photo\.latitude\.toFixed\(6\)\},\$\{photo\.longitude\.toFixed\(6\)\}`\}/, "HEADLINE: a photo's GPS opens that point in Google Maps");

  // The decision: Claimed − Deduction = Approved in one row; the reason box grows with what is in it.
  assert.match(decision, /<div className="grid min-w-0 grid-cols-3 items-end gap-x-2 gap-y-2" data-amount-equation>/, "HEADLINE: Claimed − Deduction = Approved is one three-column row");
  assert.match(decision, /box\.style\.height = "auto";[\s\S]*?box\.scrollHeight/, "HEADLINE: the reason box grows with its wrapped text");
  assert.match(decision, /Math\.max\(wanted, line \* 3 \+ chrome\), ceiling/, "from three rows to ten");
  assert.match(decision, /Why it is held · /, "HEADLINE: the system's sentence is labelled as the system's");
  assert.match(decision, /data-reason-chip=\{chip\.key\}/, "HEADLINE: the reasons the system found are one-click chips");
  assert.match(decision, /reasonAfterChip\(\{ chips, current: decision\.hrComment, picked: chip, systemText \}\)/, "and a chip never writes over the reviewer's own words");
  assert.match(decision, /onClick=\{rejectReasonMissing \? askForReason : onReject\}/, "HEADLINE: Reject with no reason puts the cursor in the reason box instead of refusing");
  assert.doesNotMatch(decision, /Sparkles/, "nothing designed looks machine-made — the rewrite carries a pen");

  // The order is remembered per reviewer, never shared across people on one PC.
  const hook = stripComments(readFileSync(`${dir}/use-expense-review.ts`, "utf8"));
  assert.match(hook, /ownerScopedStorageKey\(EXPENSE_APPROVAL_VIEW_KEY_BASE, viewerHrId\)/, "HEADLINE: Biggest / Oldest first is remembered per reviewer");
  assert.match(workspace, /onSort=\{review\.chooseSort\}/, "and written when it is picked");

  // The premium rules, over the whole screen.
  assert.doesNotMatch(screen, /\btruncate\b/, "nothing on the approvals screen is cut off with an ellipsis (AGENTS.md §4)");
  assert.doesNotMatch(screen, /bg-gradient-to-/, "flat, never a gradient");
  assert.doesNotMatch(screen, /\brounded-(?!none)/, "square corners only");
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
  const posted = hook.match(/const isPostedOnSave = \(record: LoadedRecord\) => \{[\s\S]*?\n {6}\};/)?.[0];
  assert.ok(posted, "HEADLINE: save() decides row by row what it posts");
  assert.match(posted, /outstationRequestIdFromTripId\(record\.tripId\) === null\) return true;/, "an imported row keeps its whole report");
  assert.match(posted, /expenseDecisionChanged\(local, savedDecision\(record\)\)/, "an app claim goes only when its decision changed");
  assert.match(hook, /records: reportRecords\.filter\(isPostedOnSave\)\.map\(/, "HEADLINE: the body carries only those rows");
}
