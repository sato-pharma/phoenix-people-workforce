import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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
// These pins hold the rebuilt shape: the trip's length is ONE helper read everywhere, the row and the
// panel both name it, each trip day is one folding row whose map is drawn only when opened, and the
// decision is the panel's pinned last part.

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
  const workspace = stripComments(readFileSync("src/components/outstation/expense-approvals-workspace.tsx", "utf8"));
  const workload = stripComments(readFileSync("src/components/outstation/trip-workload-evidence.tsx", "utf8"));

  assert.match(
    workspace,
    /const span = tripSpan\(record\.date, record\.toDate\);[\s\S]*?span\.multiDay \? \(\s*<span[^>]*>\s*\{formatNumberValue\(span\.days\)\} days/,
    "HEADLINE: a queue row names a multi-day trip's length beside its dates",
  );
  assert.match(
    workspace,
    /\{tripSpanLabel\(span\)\}/,
    "HEADLINE: the decision panel states the trip's length in words",
  );
  assert.doesNotMatch(workspace, /\btruncate\b/, "nothing on the approvals screen is cut off with an ellipsis (AGENTS.md §4)");
  assert.doesNotMatch(workspace, /bg-gradient-to-/, "the panel header is flat, never a gradient");
  assert.match(
    workspace,
    /<RouteFact from=\{record\.from\} to=\{record\.location \|\| record\.to\} \/>/,
    "the route wraps (RouteFact), never scrolls sideways inside its own box",
  );

  // The decision is the panel's LAST part, after the evidence — and the evidence is the part that
  // scrolls on a desktop, so the decision stays in reach.
  const panel = workspace.slice(workspace.indexOf("function ExpenseDecisionPanel("));
  const evidenceAt = panel.indexOf("lg:overflow-y-auto");
  const decideAt = panel.indexOf("onClick={onApprove}");
  assert.ok(evidenceAt > 0 && decideAt > evidenceAt, "HEADLINE: Approve sits below the scrolling evidence, pinned last");
  assert.match(
    workspace,
    /lg:sticky lg:top-4 lg:flex lg:max-h-\[calc\(100dvh-7rem\)\] lg:flex-col/,
    "the panel is window-high on a desktop, so its decision bar never leaves the screen",
  );
  assert.match(workspace, /<ExpenseClaimValidationPanel collapsible requestId=/, "the claim checks fold, verdict in the header");

  // The premium pass (owner, 2026-11-06: "do a heavy big premium polish").
  assert.doesNotMatch(
    workspace,
    /overflow-x-auto|\bw-max\b/,
    "HEADLINE: nothing on the approvals screen scrolls sideways — the By employee trips were a w-max strip in an overflow-x-auto box",
  );
  assert.match(
    workspace,
    /<table className="hidden w-full table-fixed border border-slate-200 bg-white text-xs md:table">\s*<colgroup>/,
    "a person's trips are a fitted table on a desktop (AGENTS.md §4), with cards on a phone",
  );
  assert.match(
    workspace,
    /Trip \{formatNumberValue\(position\.index\)\} of \{formatNumberValue\(position\.total\)\}/,
    "the panel says where the trip sits in the list and walks it with Previous / Next",
  );
  assert.match(
    workspace,
    /window\.matchMedia\("\(max-width: 1023px\)"\)\.matches[\s\S]{0,200}panelRef\.current\?\.scrollIntoView/,
    "HEADLINE: on a phone, opening a trip brings its panel into view instead of leaving it under the list",
  );

  // Each trip day is ONE row, and a day's map is drawn only once that day is opened.
  assert.match(workload, /<TripDayRow\b/, "HEADLINE: the days render as one row each");
  assert.match(
    workload,
    /\{opened && checkins\.length > 0 \? \(/,
    "HEADLINE: a day's route map mounts only when that day is opened",
  );
  assert.equal(
    (workload.match(/<TripDayRouteMap\b/g) ?? []).length,
    1,
    "there is one place a map is drawn — the opened day — not a second always-open list",
  );
  assert.doesNotMatch(workload, /PortalDesktopTable/, "the old seven-column table is gone");
  assert.match(workload, /days with no field activity/, "a long trip says how many of its days had no field work");

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
