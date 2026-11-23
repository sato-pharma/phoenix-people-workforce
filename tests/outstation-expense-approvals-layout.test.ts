import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";

import { EMPTY_PRESS_QUEUE, addPress, pressBody } from "../src/lib/outstation/approvals/press-queue.ts";
import type { DeskClaim, DeskDecisionRequest } from "../src/lib/outstation/approvals/types.ts";
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
// Three rebuilds since. 7 Nov ~00:30: a page per trip beside a narrow rail (Approve still under the
// fold). 7 Nov ~03:20: a Place checks list page and a full-screen "Review one by one" reviewer. 23 Nov:
// the decision desk (approvals-desk/), after his audit scored the page 4.8 out of 10 — "REBUILD FROM
// SCRATCH". These pins hold what every one of them was for: the trip's length is ONE helper read
// everywhere; the waiting list is on the first screen; tiles that each count one thing; ONE MAP PER
// DAY; and the decision in reach wherever he has scrolled to.

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
  // REBUILT FROM SCRATCH, 2026-11-23 (approvals-desk/; owner: "REBUILD FROM SCRATCH LESS THAN 9.5/10
  // PER ITEM IS NOT ACCPETED"). The audit of the 7 Nov screen found the first waiting trip under a
  // page of tiles, tabs and filters, nine tabs, a Save button, and a reviewer that was a second way
  // to decide. The desk is: one line that says what waits, six true tiles, three lanes, the list —
  // and one trip opened the same way from anywhere, on one scroll, its decision pinned at the foot.
  // Every day still draws ITS OWN MAP ("if 3 days then I should have 3 maps").
  const dir = "src/components/outstation/approvals-desk";
  const read = (file: string) => stripComments(readFileSync(`${dir}/${file}`, "utf8"));
  const workspace = read("desk-workspace.tsx");
  const tiles = read("desk-tiles.tsx");
  const list = read("desk-row.tsx");
  const parts = read("desk-parts.tsx");
  const history = read("desk-history.tsx");
  const reviewer = read("desk-reviewer.tsx");
  const tripFile = read("desk-trip-file.tsx");
  const days = read("desk-days.tsx");
  const dayMap = read("desk-day-map.tsx");
  const decision = read("desk-decision.tsx");
  const undoBar = read("desk-undo-bar.tsx");
  const workload = stripComments(readFileSync("src/components/outstation/trip-workload-evidence.tsx", "utf8"));
  const photos = stripComments(readFileSync("src/components/outstation/trip-evidence-photos.tsx", "utf8"));
  const screen = readdirSync(dir)
    .filter((file) => /\.tsx?$/.test(file))
    .map(read)
    .join("\n");

  // The screens before it are gone, file and all — and so is everything that existed only for them.
  for (const retired of [
    "src/components/outstation/expense-approvals-workspace.tsx",
    "src/components/outstation/expense-approvals",
    "src/components/outstation/expense-review",
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
    /<CrmSurfaceProvider surface="admin">\s*<DeskWorkspace initialSearch=\{searchText\(await searchParams\)\} \/>/,
    "HEADLINE: the route mounts the desk inside the Phoenix CRM admin surface, with the address's own view",
  );

  // Top to bottom: hero, the one line, the tiles, the lanes, the list. The reviewer mounts last.
  const order = ["<AdminPageHero", "<DeskTopLine", "<DeskTiles", "<DeskTabs", "<DeskList", "<DeskUndoBar", "<DeskReviewer"];
  const at = order.map((tag) => workspace.indexOf(tag));
  assert.ok(at.every((index, i) => index > 0 && (i === 0 || index > at[i - 1])), `HEADLINE: the page reads top to bottom ${order.join(" → ")}`);
  // 🔴 On a phone the first claim began 904 px down, under the tiles (measured at 375, 23 Nov 2026).
  // The tiles are drawn twice: above the lanes from a tablet up, after the list on a phone.
  assert.equal((workspace.match(/<DeskTiles /g) ?? []).length, 2, "the tiles are drawn in two places, one per width");
  assert.ok(
    workspace.indexOf('<DeskTiles className="hidden md:block"') > workspace.indexOf("<DeskTopLine") &&
      workspace.indexOf('<DeskTiles className="hidden md:block"') < workspace.indexOf("<DeskTabs"),
    "HEADLINE: the tiles above the lanes are hidden on a phone",
  );
  assert.ok(
    workspace.indexOf('<DeskTiles className="md:hidden"') > workspace.indexOf("<DeskList") &&
      workspace.indexOf('<DeskTiles className="md:hidden"') < workspace.indexOf("<DeskUndoBar"),
    "HEADLINE: on a phone the tiles come after the list, so the first claim is on the first screen",
  );
  assert.ok(tiles.includes('<div className={cn("min-w-0", className)} data-desk-tiles>'), "and the tiles wear the width rule they are given");
  assert.match(workspace, /\bcompact\n\s*description=\{/, "HEADLINE: the hero is compact — one sentence, never a band of its own");
  assert.match(workspace, /Export XLSX/);
  assert.match(workspace, /className="min-w-0 space-y-3" data-expense-desk/, "and the parts sit close");
  assert.doesNotMatch(workspace, /<AdminTableShell\b|<AdminStatCard\b/, "no three-row section header and no tall stat cards over the list");
  // Owner, 2026-11-07, circling everything above the first trip: "the screen is consumed in
  // irrelevant place". Nothing between the tiles and the list but the lanes and the search box.
  const between = workspace.slice(workspace.indexOf("<DeskTabs"), workspace.indexOf("<DeskList"));
  assert.doesNotMatch(between, /<h2|<CrmNote|<select/, "HEADLINE: no heading row, banner or filter band between the lanes and the list");
  assert.equal((between.match(/<input/g) ?? []).length, 1, "one search box, on the lanes' own line");

  // The one line: what waits, in one unit, with what is over a week.
  assert.match(tiles, /data-desk-top-line>\s*<span data-desk-waiting=\{top\.count\}>/, "HEADLINE: the page opens on one line that says how many decisions wait");
  assert.ok(tiles.includes("const top = deskTopLine(queue);"), "read from the one function every waiting figure comes from");
  assert.ok(tiles.includes("{formatNumberValue(top.overSevenDays)} over 7 days"), "HEADLINE: and how many have waited more than a week");
  assert.ok(tiles.includes("aria-pressed={overOnly}"), "which is a press that shows only those");

  // Six tiles, one per place a trip can stand — never a count that includes another tile's trips.
  assert.ok(tiles.includes("{TRIP_STANDINGS.map((standing) => {"), "HEADLINE: one tile per standing, from the one list of standings");
  assert.ok(tiles.includes("const tile = queue.tiles[standing];"), "each reading the server's own count");
  assert.ok(tiles.includes("onClick={() => onOpen(standing)}"), "and a tile opens its trips");
  assert.match(tiles, /grid min-w-0 grid-cols-2 border border-slate-200 bg-white sm:grid-cols-3 xl:grid-cols-6/, "one slim strip: two across on a phone, six on a desktop");
  assert.ok(tiles.includes("data-desk-agreement"), "under them, how often the system's lane matched his answer");

  // The lanes: a tablist, keyboard included.
  assert.match(workspace, /<div aria-label="Expense approvals" className="flex min-w-0 flex-wrap" role="tablist">/, "HEADLINE: the three lanes are a tablist that wraps, never a scroller");
  assert.match(workspace, /event\.key === "Home" \? 0/, "Home and End move between the lanes");
  assert.ok(workspace.includes("{DESK_LANES.map((key, index) => ("), "the lanes are the domain's own three");
  assert.ok(list.includes('role="tabpanel"') && list.includes("aria-labelledby={`desk-tab-${lane}`}"), "and the list is the lane's panel");

  // The list: cards on a phone (drawn first), a fixed table on a desktop, twenty at a time.
  const cardsAt = list.indexOf('<div className="divide-y divide-slate-100 md:hidden">');
  assert.ok(cardsAt > 0 && cardsAt < list.indexOf("<CrmTable"), "HEADLINE: phone cards, then the fixed desktop table");
  assert.ok(list.includes('<CrmTable columns={["26%", null, "8%", "14%", "25%"]}>'), "HEADLINE: five named columns that fit the panel");
  assert.ok(list.includes("const PAGE_ROWS = 20;") && list.includes("<CrmShowMore "), "and twenty rows at a time");
  assert.ok(list.includes("<TripLine claim={claim} />"), "a desktop row prints the trip's dates and route");
  assert.equal((parts.match(/\{displayPlace\(claim\.(?:from|to)\)\}/g) ?? []).length, 2, "HEADLINE: From and To in words, never the plus-code prefix");
  assert.ok(list.includes('<bdi dir="auto">{displayPlace(claim.to)}</bdi>'), "HEADLINE: the phone card prints the place in words too");
  assert.ok(history.includes('<bdi dir="auto">{displayPlace(claim.to)}</bdi>'), "and so does History's");
  assert.match(history, /md:hidden[\s\S]*?<CrmTable /, "History is a fitted table with cards on a phone");
  assert.ok(parts.includes("${formatNumberValue(days)} days`"), "HEADLINE: a trip over more than one day says how many days, beside its dates");
  // The heading of the list is one line: the lane, its count, its meaning, the ticks and the lane's press.
  assert.match(
    list,
    /<h2 className="min-w-0 break-words text-sm font-black text-slate-950">[\s\S]*?\{DESK_LANE_LABEL\[lane\]\} \(\{formatNumberValue\(claims\.length\)\}\)[\s\S]*?<\/h2>\s*\{claims\.length > 0 \? \(\s*<div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">\s*\{canDecide \? <TickAll [\s\S]*?\{action\}/,
    "HEADLINE: the lane's title, the tick-all and the lane's one-press action share ONE heading line",
  );

  // The reviewer: the whole screen, one scroll, the decision pinned under it.
  assert.match(reviewer, /return createPortal\(/, "HEADLINE: an open trip is the whole screen");
  assert.ok(reviewer.includes('className="fixed inset-0 z-[200] flex min-w-0 flex-col bg-slate-100 text-slate-900 outline-none"'), "over everything, as one column");
  assert.match(reviewer, /text-orange-400">Expense approvals<\/p>/, "the orange kicker");
  assert.ok(reviewer.includes("`Claim ${formatNumberValue(index + 1)} of ${formatNumberValue(walk.length)} in this lane`"), "HEADLINE: it says which claim of the lane this is");
  assert.ok(reviewer.includes('aria-label="Previous claim"') && reviewer.includes('aria-label="Next claim"') && reviewer.includes('aria-label="Close the claim"'), "Previous, Next and Close are labelled buttons");
  assert.doesNotMatch(reviewer, /event\.key === "Enter"|key === "a"|key === "r"/, "HEADLINE: no key decides anything");
  assert.match(reviewer, /useDialogA11y</, "Esc closes, focus is trapped, the page behind it does not scroll");

  // 🔴 APPROVE IS ON SCREEN AT THE TOP OF A TRIP: the facts scroll in their own box and the decision
  // is a footer under that box, so it is in reach wherever he has scrolled to.
  const scrollAt = tripFile.indexOf('<div className="min-h-0 min-w-0 flex-1 overflow-y-auto" data-trip-file={claim.requestId}>');
  const footerAt = tripFile.indexOf('<footer className="min-w-0 border-t border-slate-300 bg-white" data-reviewer-decision>');
  assert.ok(scrollAt > 0 && footerAt > scrollAt, "HEADLINE: the trip scrolls in its own box and the decision sits under it, not inside it");
  const footer = tripFile.slice(footerAt);
  assert.ok(footer.includes("<DecisionButtons canDecide={canDecide} claim={claim} everyAction "), "HEADLINE: the pinned footer carries the row's own buttons — one way to decide");
  assert.ok(footer.includes('<div className="mb-2 max-h-[50vh] min-w-0 overflow-y-auto">'), "HEADLINE: an open reason box is capped at half the screen, so it never pushes the buttons off it");
  for (const state of ["pressed", "locked", "read-only"]) {
    assert.ok(footer.includes(`data-decision-state="${state}"`), `a claim that cannot be decided says why (${state}) in place of the buttons`);
  }
  assert.doesNotMatch(tripFile.slice(scrollAt, footerAt), /<DecisionButtons|<DecisionPanel/, "and nothing in the scrolling part decides");

  // The one scroll: who and what, what the system found, the trip day by day, photos and tickets.
  const column = ["data-trip-summary", 'name="found"', 'name="days"', 'name="attachments"'].map((tag) => tripFile.indexOf(tag));
  assert.ok(column.every((index, i) => index > 0 && (i === 0 || index > column[i - 1])), "HEADLINE: the trip → what the system found → day by day → photos and tickets");
  assert.ok(tripFile.includes('<Sheet name="found" title="What the system found">'), "HEADLINE: what the system found has its own section");
  assert.ok(tripFile.includes("data-check={check.key} data-check-answer={check.answer}"), "every check is listed with its answer, in one sentence");
  assert.ok(tripFile.includes('<span className="sr-only"> — {look.word}</span>'), "and the answer is in words too, not only a colour");
  assert.ok(tripFile.includes("<TripAttachments data={file.attachments} onChanged={readAgain} tripId={claim.tripId} />"), "the photos, stops and tickets panel the Held requests screen uses");
  assert.equal((tripFile.match(/<bdi dir="auto">/g) ?? []).length, 3, "HEADLINE: the name, the employee's note and the decision's reason each start at their own edge, Arabic too");

  // ONE MAP PER DAY: the domain hands back one map per trip day and each day block draws its own.
  assert.ok(days.includes("const span = tripSpan(tripStart, tripEnd);"), "HEADLINE: the trip's days come from the one trip-length helper");
  assert.match(days, /\{maps\.map\(\(map, index\) => \(\s*<DayBlock /, "HEADLINE: every trip day is a block, open, no folding");
  assert.equal((days.match(/<DeskDayMapBox map=\{map\} routeLine=\{routeLine\} \/>/g) ?? []).length, 1, "HEADLINE: and every day block draws its own map (if 3 days then 3 maps)");
  assert.doesNotMatch(days, /<details|aria-expanded/, "nothing in a day is behind a click");
  assert.ok(dayMap.includes("if (!map.hasPoints && map.legend.length === 0 && map.unplaced === 0) return null;"), "HEADLINE: a day with nothing to draw draws nothing — never a map-sized box");
  assert.match(dayMap, /\{map\.hasPoints \? \(\s*<div className="min-w-0">\s*\{seen \? \(\s*<FieldWorkforceRouteMap /, "HEADLINE: a day's map is created only once it comes into view");
  const latchAt = dayMap.indexOf("function useSeenOnce");
  const latch = dayMap.slice(latchAt, dayMap.indexOf("export function DeskDayMapBox("));
  assert.ok(latchAt > 0 && /new IntersectionObserver\(/.test(latch) && /setSeen\(true\)/.test(latch), "the latch is set by an IntersectionObserver");
  assert.doesNotMatch(latch, /setSeen\(false\)/, "and never cleared — a drawn map stays drawn");
  assert.match(latch, /addEventListener\("scroll", check, \{ capture: true, passive: true \}\)/, "HEADLINE: inside the reviewer the trip scrolls in its own box, so the fallback listens in the capture phase");
  assert.match(latch, /if \(box\.width === 0 && box\.height === 0\) return;/, "HEADLINE: a hidden map is never created early — a zero-sized box is not on screen");
  assert.ok(dayMap.includes('<div aria-hidden className="h-64 w-full border border-slate-200 bg-slate-50" />'), "the box before the map holds the map's place, so the page never jumps");
  assert.ok(dayMap.includes('frame="bare"'), "the bare square map");
  assert.ok(dayMap.includes("data-day-map-legend"), "a legend names every pin on each day's map");
  assert.ok(dayMap.includes("{line.point.lat.toFixed(5)}, {line.point.lon.toFixed(5)}") && dayMap.includes("href={mapsHref(line.point.lat, line.point.lon)}"), "HEADLINE: every pin's position opens that point in Google Maps");
  assert.equal((days.match(/<bdi dir="auto">/g) ?? []).length, 2, "a visit's customer and place each sit in their own <bdi>");

  // The old system's record (a trip from before the team moved to Phoenix CRM) is the shared
  // verified-workload block, so it is held to the same rules.
  assert.match(tripFile, /<TripWorkloadEvidencePanel\s+alwaysOpen\s+dayOrder="data-first"/, "the old system's record is drawn open, data first");
  assert.ok(
    tripFile.includes("const oldRecord = claim.declaredWorkload && (daysBeforePhoenix > 0 || (file.crm !== null && !file.crm.reading)) ? claim.declaredWorkload : null;"),
    "HEADLINE: the old system's record is drawn only for a trip Phoenix CRM cannot speak for — days before the team moved, or no reading at all",
  );
  assert.match(tripFile, /\{oldRecord \? \(\s*<Sheet name="old-record" title="Before Phoenix CRM: the old system's record">/, "and it has its own titled section, after the day-by-day read");
  assert.doesNotMatch(workload, /font-mono/, "HEADLINE: the verified-workload counts are tabular-nums, never monospace");
  assert.match(workload, /<Badge className="rounded-none" variant=\{tone\}>/, "HEADLINE: the workload verdict is square, not the shared round pill");
  assert.match(workload, /\{formatClock\(visit\.submittedAt\)\}/, "HEADLINE: the time each visit was saved is printed");
  assert.match(workload, /\{formatClock\(checkin\.at\)\}/, "HEADLINE: the time of each check-in is printed");
  assert.match(photos, /href=\{`https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=\$\{photo\.latitude\.toFixed\(6\)\},\$\{photo\.longitude\.toFixed\(6\)\}`\}/, "HEADLINE: a photo's GPS opens that point in Google Maps");

  // The decision: the reasons the system found are one-press chips; a rejection needs a reason.
  assert.ok(decision.includes("data-reason-chip={chip.key}"), "HEADLINE: the reasons the system found are one-press chips");
  assert.ok(decision.includes('onClick={() => (mode === "reject" ? send(chip.text) : setReason(chip.text))}'), "HEADLINE: a rejection is sent by the chip itself — the second press");
  assert.ok(decision.includes('disabled={!text || (mode === "reduce" && (figure === null || tooHigh))}'), "HEADLINE: no rejection and no reduced amount goes without a reason");
  assert.ok(decision.includes('hint={mode === "reject" ? "The employee is told this reason." : "Kept on the claim. The employee is not told about a reduced amount."}'), "and the box says who will read it");
  assert.doesNotMatch(screen, /Sparkles/, "nothing designed looks machine-made — the rewrite carries a pen");

  // Undo stays in reach while the list scrolls.
  assert.match(undoBar, /className=\{cn\("sticky bottom-0 z-30 /, "HEADLINE: Undo stays in reach while the list scrolls");

  // RETIRED with the rebuild, on his 23 Nov choices: the per-reviewer "Biggest / Oldest first"
  // memory (the order is oldest first, always) and every draft kept in the browser.
  assert.doesNotMatch(screen, /ownerScopedStorageKey|localStorage|sessionStorage/, "HEADLINE: the desk keeps nothing in the browser — the view is in the address");
  assert.doesNotMatch(screen, /onSort|chooseSort|Biggest first/, "and offers no second order");

  // The premium rules, over the whole screen.
  assert.doesNotMatch(screen, /font-mono/, "HEADLINE: no monospace anywhere on the screen — figures are tabular-nums");
  assert.doesNotMatch(screen, /\btruncate\b|line-clamp/, "nothing on the approvals screen is cut off with an ellipsis (AGENTS.md §4)");
  assert.doesNotMatch(screen, /bg-gradient-to-|\bshadow-(?!none)/, "flat: never a gradient, never a drop shadow");
  assert.doesNotMatch(screen, /\brounded-(?!none)/, "square corners only");
  assert.doesNotMatch(screen, /overflow-x-auto|overflow-x-scroll|\bw-max\b/, "HEADLINE: nothing on the approvals screen scrolls sideways");

  // A place in words: the plus code goes, the postal code and the country go, Arabic is untouched.
  assert.equal(displayPlace("3CGJ+3G, Nasr City, Cairo Governorate 4450113, Egypt"), "Nasr City, Cairo Governorate");
  assert.equal(displayPlace("6W25+MQF Mahatet El Raml, Alexandria, Egypt"), "Mahatet El Raml, Alexandria");
  assert.equal(displayPlace("شارع الهرم، الجيزة، مصر"), "شارع الهرم، الجيزة");
  assert.equal(displayPlace("Sohag"), "Sohag");
  assert.equal(displayPlace("3CGJ+3G"), "3CGJ+3G", "a place that is only a plus code keeps its text rather than vanishing");
  assert.equal(displayPlace(""), "—");
  assert.equal(displayPlace(null), "—");

  // ── 3. A press sends only its own claims (owner, 2026-11-06: "the Save button very long to save") ──
  // The 6 Nov fix stopped Save posting the whole queue. Since 23 Nov there is no Save: a press is
  // sent by itself, and its body is the claims of that press and nothing else — one for a row, the
  // lane's batch for "Approve all".
  const claim = (requestId: number) => ({ requestId, revision: `rev-${requestId}`, standing: "waiting", total: 500 }) as unknown as DeskClaim;
  const approve = (requestId: number): DeskDecisionRequest => ({ action: "approve", requestId, revision: `rev-${requestId}` });
  const onePress = addPress(EMPTY_PRESS_QUEUE, { claims: [claim(1), claim(2), claim(3)], decisions: [approve(2)], now: 1_000 });
  assert.deepEqual(
    pressBody(onePress.waiting[0]),
    { decisions: [{ action: "approve", requestId: 2, revision: "rev-2" }] },
    "HEADLINE: one Approve posts that one claim, with the version he saw — never the queue",
  );
  const hook = read("use-desk.ts");
  assert.ok(hook.includes("body: JSON.stringify(pressBody(press)),"), "HEADLINE: and that body is exactly what the page sends");
  assert.equal((hook.match(/method: "POST"/g) ?? []).length, 1, "the desk has one write, the press");

  // ── 4. What the look-over of 23 Nov found, before the desk was ever merged ──────────────────
  const select = read("desk-select.tsx");
  // History's Open button was clipped between 768 and 1250 px: its column was 9% of the table.
  assert.ok(history.includes('columns={["25%", "16%", null, "13%", "13%"]}'), "History's last column is wide enough for the Open button on a tablet");

  // On a phone every press target is 44px. A dense button gets it under md only.
  assert.ok(parts.includes('export const PHONE_TARGET = "max-md:min-h-11";'), "the one phone-target class");
  assert.ok(history.includes('approvalActionClassName("neutral", "dense", PHONE_TARGET)} data-open-trip'), "History's Open on a phone card is 44px tall");
  assert.equal((read("desk-rewrite.tsx").match(/"neutral", "dense", PHONE_TARGET\)/g) ?? []).length, 2, "Rewrite formally and its Undo are 44px tall on a phone");
  assert.ok(select.includes("inline-flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center md:w-9"), "the tick is 44px wide on a phone");
  assert.ok(tiles.includes("inline-flex min-h-11 items-center border px-2 py-0.5 text-xs font-black transition md:min-h-8"), "the over-7-days switch is 44px tall on a phone");
  assert.ok(history.includes("inline-flex min-h-11 items-center border px-3 py-1 text-xs font-black transition md:min-h-9"), "History's choices are 44px tall on a phone");
  assert.ok(read("desk-undo-bar.tsx").includes("inline-flex h-11 w-11 shrink-0 items-center justify-center hover:bg-black/5 md:h-8 md:w-8"), "a notice's close is 44px on a phone");

  // A stored code is never printed: a name, never a trip id; words, never a flag with its underscores swapped.
  for (const name of readdirSync(dir).filter((entry) => entry.endsWith(".tsx"))) {
    assert.doesNotMatch(read(name), /\.replace\(\/_\/g/, name + " prints a stored code with its underscores swapped for spaces");
  }
  assert.doesNotMatch(select, /employeeName \|\| claim\.tripId/, "a claim with no name reads Unassigned, never its trip id");
  assert.ok(select.includes('leftOut.map((claim) => claim.employeeName || "Unassigned")'), "the trips a batch leaves out are named the way every row names them");
  assert.match(parts, /if \(key === "far"\) return "Far from the saved place";\s*if \(key === "weak_gps"\) return "Weak GPS reading";\s*return null;/, 'a visit\'s position note is words; "ok" and "no_place" draw no pill');
  assert.ok(read("desk-days.tsx").includes("{visitLocationNote(visit.locationFlag) ? <CrmPill"), "the opened trip draws that note, and nothing when there is none");
  assert.match(parts, /if \(key === "other"\) return "Other transport";\s*return "";/, "a transport value the desk does not know draws nothing");

  // The confirm pair inside a table row is the dense, flat size; a phone card and the opened trip keep the 44px one.
  assert.match(list, /<TableRowDetail colSpan=\{5\} id=\{panelId\}>\s*<DecisionPanel [^\n]*size="dense" \/>/, "Reduce and Reject confirm flat inside the table");
  assert.equal((list.match(/<DecisionPanel [^\n]*size="dense"/g) ?? []).length, 1, "only the table row's panel is dense");
  assert.ok(decision.includes('approvalActionClassName(mode === "reject" ? "reject" : "confirm", size)'), "the confirm button takes the panel's size");
  assert.match(decision, /onPress,\s*size = "regular",\s*\}: \{\s*claim: DeskClaim;\s*mode: Exclude<DecisionMode, "idle">;/, "and a panel is regular unless the table says otherwise");
}
