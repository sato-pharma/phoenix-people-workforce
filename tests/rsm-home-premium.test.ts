import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  INCENTIVE_NOT_CONFIRMED_NOTE,
  OWN_EXCUSE_HREF,
  OWN_VACATION_HREF,
  REGION_FIGURES_UNAVAILABLE,
  achievementBand,
  achievementOf,
  compactEgp,
  districtsNeedingAttention,
  incentiveGap,
  monthLabel,
  ownRequestsHref,
  ownRequestsLabel,
  pendingItems,
  rankingBoardEmptyText,
  salesPacing,
  wholePercent,
} from "../src/lib/employee-portal/rsm-home-summary.ts";

// The Regional Sales Manager's home, premium pass (owner, 9 Nov 2026). Account: docs/rsm-home.md.
// Every figure below is worked by hand in the comment beside it.

const RM = "src/components/employee-portal/dashboards/rm-command-center.tsx";
const COMMAND = "src/components/employee-portal/portal-command-center.tsx";
const MM = "src/components/employee-portal/dashboards/mm-intel-sections.tsx";
const CRM = "src/components/employee-portal/dashboards/crm-first-visit-board.tsx";
const TREND = "src/lib/sales/monthly-closing-portal.ts";
const LIB = "src/lib/employee-portal/rsm-home-summary.ts";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\{\/\*[\s\S]*?\*\/\}/g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** The source of one top-level function, up to the next top-level declaration. */
function body(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `could not find ${signature} — has it been renamed? Re-point this test.`);
  const rest = source.slice(start + signature.length);
  const next = rest.search(/\n(export )?(async )?(function|const|type) /);
  return signature + (next >= 0 ? rest.slice(0, next) : rest);
}

function percents() {
  // Never rounded UP across a line.
  assert.equal(wholePercent(89.6), 89, "89.6% reads 89%, never 90% beside a gap to 90%");
  assert.equal(wholePercent(99.7), 99, "99.7% is not 100%");
  assert.equal(wholePercent(100), 100);
  assert.equal(wholePercent(0.29 * 100), 29, "28.999… from floating point still reads 29");
  assert.equal(wholePercent(-5), 0);
  assert.equal(wholePercent(null), 0);
  assert.equal(wholePercent(Number.NaN), 0);
  // 450 of 500 is exactly 90; 449.9 of 500 is 89.98.
  assert.equal(achievementOf(450, 500), 90);
  assert.equal(achievementOf(449.9, 500), 89);
  assert.equal(achievementOf(100, 0), null, "no target, no achievement — never 0%");
  assert.equal(achievementOf(100, null), null);
  assert.equal(achievementBand(100), "met");
  assert.equal(achievementBand(90), "near");
  assert.equal(achievementBand(89), "behind");
  assert.equal(achievementBand(69), "far");
}

function money() {
  assert.equal(compactEgp(1_234_567), "1.23 M EGP");
  assert.equal(compactEgp(1_000_000), "1 M EGP");
  assert.equal(compactEgp(412_500), "412.5 K EGP");
  assert.equal(compactEgp(520_000), "520 K EGP");
  assert.equal(compactEgp(950), "950 EGP");
  assert.equal(monthLabel("2026-09"), "Sep 2026");
  assert.equal(monthLabel("2026-13"), "2026-13", "a malformed month is shown as it came, never guessed");
  assert.equal(monthLabel("bad"), "bad");
}

function regionGap() {
  // 90% of 500,000 is 450,000: exactly there is cleared.
  assert.deepEqual(incentiveGap(450_000, 500_000), { state: "cleared", sub: "90% incentive line cleared" });
  // 90% of 520,000 is 468,000; 468,000 − 412,500 = 55,500.
  assert.deepEqual(incentiveGap(412_500, 520_000), { state: "short", gap: 55_500, sub: "sales still needed to reach 90%" });
  assert.deepEqual(incentiveGap(100, 0), { state: "no-target", sub: "no region target loaded" });
  assert.ok(/not yet confirmed by HR/.test(INCENTIVE_NOT_CONFIRMED_NOTE));
  assert.ok(!/synced|\d/.test(REGION_FIGURES_UNAVAILABLE), "the unavailable state names no sync and quotes no figure");
}

function districts() {
  const rows = [
    // 412,500 / 520,000 = 79.3% → 79; gap 468,000 − 412,500 = 55,500.
    { hrId: "B-154", name: "Nermeen Salah", achievementPercent: 79.33, totalSales: 412_500, totalTarget: 520_000 },
    // 448,000 / 500,000 = 89.6% → 89 (the old board printed 90%); gap 450,000 − 448,000 = 2,000.
    { hrId: "PD-0012", name: "Mohamed Eleiwa", achievementPercent: 89.6, totalSales: 448_000, totalTarget: 500_000 },
    // 120% — cleared, not listed.
    { hrId: "PD-0028", name: "Sahar El Gallad", achievementPercent: 120, totalSales: 600_000, totalTarget: 500_000 },
    // 100,000 / 400,000 = 25%; gap 360,000 − 100,000 = 260,000.
    { hrId: "PD-0040", name: "Hossam Adel", achievementPercent: 25, totalSales: 100_000, totalTarget: 400_000 },
    // No target: unmeasurable, never behind.
    { hrId: "PD-0041", name: "Amr Fathy", achievementPercent: 0, totalSales: 90_000, totalTarget: 0 },
    // Exactly 90%: cleared.
    { hrId: "PD-0042", name: "Rana Mostafa", achievementPercent: 90, totalSales: 450_000, totalTarget: 500_000 },
  ];
  const attention = districtsNeedingAttention(rows, "Sep 2026");
  assert.equal(attention.state, "list");
  if (attention.state !== "list") return;
  assert.deepEqual(
    attention.behind.map((row) => [row.name, row.percent, row.band, row.salesText, row.gapText]),
    [
      ["Hossam Adel", 25, "far", "100 K EGP of 400 K EGP", "260 K EGP to 90%"],
      ["Nermeen Salah", 79, "behind", "412.5 K EGP of 520 K EGP", "55.5 K EGP to 90%"],
      ["Mohamed Eleiwa", 89, "behind", "448 K EGP of 500 K EGP", "2 K EGP to 90%"],
    ],
    "worst first; 89.6% reads 89, an exact 90% is cleared, a district with no target is not behind",
  );
  assert.equal(
    attention.unmeasuredText,
    "1 district has no target loaded for Sep 2026, so its achievement cannot be measured: Amr Fathy.",
  );
  const two = districtsNeedingAttention(
    [rows[4], { ...rows[4], hrId: "PD-0043", name: "Yara Nabil" }],
    "Sep 2026",
  );
  assert.equal(two.state === "list" && two.unmeasuredText, "2 districts have no target loaded for Sep 2026, so their achievement cannot be measured: Amr Fathy, Yara Nabil.");
  assert.deepEqual(districtsNeedingAttention(rows, null), { state: "hidden" }, "nothing is listed while no closing is published");
  assert.deepEqual(districtsNeedingAttention(rows, "  "), { state: "hidden" });
  assert.deepEqual(districtsNeedingAttention([], "Sep 2026"), { state: "hidden" });
  assert.deepEqual(districtsNeedingAttention([rows[2], rows[5]], "Sep 2026"), {
    state: "all-clear",
    text: "Every district in your region is at or above 90%.",
  });
  assert.equal(rankingBoardEmptyText("Sep 2026"), "Nobody on this board has a row in the Sep 2026 closing.");
  assert.equal(rankingBoardEmptyText(null), "No Monthly Closing is published for this board yet.");
}

function pacing() {
  const ready = salesPacing([
    { period: "2026-09", salesValue: 5_200_000, targetValue: 6_000_000 },
    { period: "2026-07", salesValue: 4_000_000, targetValue: 5_000_000 },
    { period: "2026-08", salesValue: 4_650_000, targetValue: null },
    { period: "junk", salesValue: 9_999_999, targetValue: 1 },
  ]);
  assert.equal(ready.state, "ready");
  if (ready.state !== "ready") return;
  assert.deepEqual(
    ready.months.map((m) => [m.label, m.shortLabel, m.salesText, m.achievementText, m.band, m.barHeight, m.latest]),
    [
      // 4.0 / 5.0 = 80%; bar 4.0 / 5.2 = 76.9 → 77.
      ["Jul 2026", "Jul", "4 M EGP", "80% of target", "behind", 77, false],
      // No target loaded; bar 4.65 / 5.2 = 89.4 → 89.
      ["Aug 2026", "Aug", "4.65 M EGP", "No target loaded", null, 89, false],
      // 5.2 / 6.0 = 86.7% → 86; the highest month is the full bar.
      ["Sep 2026", "Sep", "5.2 M EGP", "86% of target", "behind", 100, true],
    ],
    "oldest first, a malformed month dropped, every month named with its sales and achievement",
  );
  assert.equal(ready.headline, "Sep 2026 sales", "the latest month is named, never 'Latest month'");
  assert.equal(ready.targetText, "of 6 M EGP target · 86%");
  // (5.2 − 4.65) / 4.65 = 11.8% → 12, a percent of the month before — never "pts".
  assert.deepEqual(ready.change, { direction: "up", percent: 12, text: "Up 12% on Aug 2026" });
  assert.equal(ready.changeNote, null);

  const down = salesPacing([
    { period: "2026-08", salesValue: 100, targetValue: null },
    { period: "2026-09", salesValue: 95, targetValue: null },
  ]);
  assert.equal(down.state === "ready" && down.change?.text, "Down 5% on Aug 2026");
  assert.equal(down.state === "ready" && down.targetText, "No target loaded for Sep 2026");
  // (1,004 − 1,000) / 1,000 = 0.4% → 0.
  const level = salesPacing([
    { period: "2026-08", salesValue: 1_000, targetValue: null },
    { period: "2026-09", salesValue: 1_004, targetValue: null },
  ]);
  assert.equal(level.state === "ready" && level.change?.text, "Level with Aug 2026");
  const afterNothing = salesPacing([
    { period: "2026-08", salesValue: 0, targetValue: null },
    { period: "2026-09", salesValue: 50, targetValue: null },
  ]);
  assert.equal(afterNothing.state === "ready" && afterNothing.change, null, "no percent of a zero month");
  assert.equal(afterNothing.state === "ready" && afterNothing.changeNote, "No sales in Aug 2026 to compare against.");
  const single = salesPacing([{ period: "2026-09", salesValue: 0, targetValue: null }]);
  assert.equal(single.state === "ready" && single.changeNote, "The first published month, so there is nothing before it to compare.");
  assert.equal(single.state === "ready" && single.months[0].barHeight, 6, "a zero month still draws its floor");
  assert.deepEqual(salesPacing([]), { state: "empty" });
}

function pending() {
  assert.deepEqual(pendingItems({ plansAwaitingApproval: 3, ownVacationRequests: 1, ownExcuseRequests: 2 }), {
    decisions: [{ key: "plans", text: "3 plans are awaiting your approval", href: "/employee-portals/approvals-hub?module=weekly_plan" }],
    own: [
      { key: "vacation", text: "Your vacation request is awaiting approval", href: OWN_VACATION_HREF },
      { key: "excuse", text: "2 of your excuse requests are awaiting approval", href: OWN_EXCUSE_HREF },
    ],
  });
  assert.deepEqual(pendingItems({ plansAwaitingApproval: 0, ownVacationRequests: 2, ownExcuseRequests: 0 }).decisions, [], "the viewer's own requests are never the viewer's decision");
  assert.equal(pendingItems({ plansAwaitingApproval: 1, ownVacationRequests: 0, ownExcuseRequests: 0 }).decisions[0].text, "1 plan is awaiting your approval");
  assert.deepEqual(pendingItems({ plansAwaitingApproval: 0, ownVacationRequests: 0, ownExcuseRequests: 0 }), { decisions: [], own: [] });
  assert.equal(OWN_VACATION_HREF, "/employee-portals/vacation-request");
  assert.equal(OWN_EXCUSE_HREF, "/employee-portals/excuses");
  assert.equal(ownRequestsHref(0, 2), OWN_EXCUSE_HREF);
  assert.equal(ownRequestsHref(1, 2), OWN_VACATION_HREF);
  assert.equal(ownRequestsHref(0, 0), OWN_VACATION_HREF);
  assert.equal(ownRequestsLabel(1), "my request awaiting approval");
  assert.equal(ownRequestsLabel(2), "my requests awaiting approval");
  assert.equal(ownRequestsLabel(null), "my requests awaiting approval");
}

function sources() {
  const rm = stripComments(read(RM));
  assert.ok(!rm.includes("Incentives shown below"), "the floating incentive banner above boards with no incentive is gone");
  assert.ok(rm.includes("{INCENTIVE_NOT_CONFIRMED_NOTE}"), "the caveat sits under the Gap to 90% tile");
  assert.ok(rm.includes("incentiveGap(sales, target)"), "the Gap to 90% tile is measured on the money");
  assert.ok(rm.includes("districtsNeedingAttention(rmRegional.dsms, rmRegional.windowLabel)"), "the districts list comes from the summary");
  assert.ok(rm.includes("wholePercent(rmRegional.achievementPercent)"), "the achievement tile never rounds up");
  assert.ok(!/Math\.round\(/.test(rm), "no percentage on the page is rounded up by hand");
  assert.ok(rm.includes('<LineSalesPacingSection access={access} title="Region Sales Pacing" />'), "the region's trend is never called the line's");
  assert.ok(rm.includes("href: ownRequestsHref(pendingVacationCount, pendingExcuseCount)"), "the viewer's own requests open the viewer's own pages");
  assert.ok(rm.includes("{REGION_FIGURES_UNAVAILABLE}") && !/synced/i.test(rm), "no 'synced' on the page");

  const command = stripComments(read(COMMAND));
  const pendingBody = body(command, "export function PendingActions(");
  assert.ok(pendingBody.includes("pendingItems("), "Needs Your Decision is split by pendingItems");
  assert.ok(pendingBody.includes('title="Your Requests in Progress"'));
  assert.ok(!/vacation request\{/.test(pendingBody), "no own vacation request is listed as a decision");
  const ranking = body(command, "export function RankingPanel(");
  assert.ok(ranking.includes("wholePercent(row.achievementPercent)") && !ranking.includes("Math.round("), "the boards never round up across a line");
  assert.ok(ranking.includes("rankingBoardEmptyText(windowLabel)"), "an empty board names its closing, never a sync");
  const context = body(command, "export function PortalContextBar(");
  assert.ok(!context.includes("whitespace-nowrap"), "a territory naming every region wraps on a phone");
  assert.ok(body(command, "export function egpCompact(").includes("compactEgp(value)"), "one money spelling");
  for (const part of ["export function SectionShell(", "export function PortalContextBar(", "export function SectionHead(", "export function SectionMeta(", "export function KeycardGrid(", "export function RankingPanel(", "export function PendingActions("]) {
    assert.ok(!/text-phx-(2xs|3xs)|text-\[(9|10)px\]/.test(body(command, part)), `${part} draws nothing below 11px`);
  }

  const mm = stripComments(read(MM));
  const pacingBody = body(mm, "export async function LineSalesPacingSection(");
  assert.ok(pacingBody.includes("salesPacing(trend)"), "the panel's words come from salesPacing");
  assert.ok(!/pts|DeltaPts|Published months|Latest month/.test(pacingBody), "a percent change is never 'pts', and the month is named");
  assert.ok(pacingBody.includes("{month.label}") && pacingBody.includes("{month.achievementText}"), "each bar carries its month and achievement");
  assert.ok(!/text-phx-(2xs|3xs)/.test(mm), "nothing below 11px in the intel sections");
  assert.ok(read(TREND).includes("targetValue: matrix.grandTotal.rowTotal.targetValue ?? null"), "the target is the published closing's own");

  const crm = stripComments(read(CRM));
  assert.ok(!/\brounded\b/.test(crm), "the source badge has square corners");
  assert.ok(!/text-phx-(2xs|3xs)/.test(crm), "nothing below 11px on the CRM First Visit board");
  assert.ok(!/whitespace-nowrap border/.test(crm), "name and early-bird chips wrap inside a phone's width");

  for (const path of [RM, MM, CRM]) {
    assert.ok(!/\brounded(-|\b)/.test(stripComments(read(path))), `${path}: square corners`);
  }
  const strings = [...read(LIB).matchAll(/"([^"\n]*)"|`([^`\n]*)`/g)].map((match) => match[1] ?? match[2]).join("\n");
  assert.ok(!/\b(he|his|him|she|her)\b/i.test(strings), "no gendered word in the page's words");
}

export function runRsmHomePremiumTests() {
  percents();
  money();
  regionGap();
  districts();
  pacing();
  pending();
  sources();
}
