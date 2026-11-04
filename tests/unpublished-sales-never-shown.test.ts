import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";
import { rollupAchievementByLine, type AchievementRow } from "../src/lib/sales/monthly-targets.ts";
import { isRowPublished, splitPeriodAtPublication, withholdUnpublishedSales } from "../src/lib/sales/vs-target.ts";
import { buildChannelSplit, publishedChannelCells, type ChannelSplitCell } from "../src/lib/sales/vs-target-page.ts";

/**
 * Owner, 2026-11-04: sales of an unpublished month never appear anywhere. Measured on production that
 * morning, with October and November unpublished: the managers' Targets page printed October's raw
 * sales (3,475,272.12 EGP across the three lines), and it opened by default on November's single
 * direct order at 98.1%.
 *
 * Every sales function in the database answers whether or not the month is published, so each screen
 * has to gate itself. The pure gates are driven with data; the routes and the page need a live
 * database, so those are pinned by reading the source with its comments removed.
 */

const SALE = 3_475_272.12;
const SALE_UNITS = 4_321;

function row(over: Partial<AchievementRow>): AchievementRow {
  return {
    period: "2026-10",
    lineCode: "cns",
    regionCode: "D1",
    areaCode: "CA1",
    areaState: "occupied",
    isOther: false,
    repSeatId: null,
    repHrId: null,
    dmSeatId: null,
    dmHrId: null,
    productCode: "P1",
    actualUnits: SALE_UNITS,
    actualValue: SALE,
    targetUnits: 5_000,
    targetValue: 12_500_000,
    achievementValue: SALE / 12_500_000,
    achievementUnits: SALE_UNITS / 5_000,
    hasTarget: true,
    hasActual: true,
    ...over,
  };
}

function source(path: string): string {
  return stripComments(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
}

export function runUnpublishedSalesNeverShownTests() {
  const septemberOnly = new Set(["cns|2026-09"]);

  // ── The Targets page gate: the target stays, the sale is gone ──────────────
  const [withheld] = withholdUnpublishedSales([row({})], septemberOnly);
  assert.equal(withheld.targetValue, 12_500_000, "an unpublished month still shows its target");
  assert.equal(withheld.actualValue, 0, "and carries no sale");
  assert.equal(withheld.actualUnits, 0, "no units either: units are a sale too");
  assert.equal(withheld.achievementValue, null, "no percentage: 27.8% of a target is the sale in another form");
  assert.equal(withheld.achievementUnits, null);
  assert.equal(withheld.hasActual, false, "and it no longer claims to have sold");
  assert.ok(
    !JSON.stringify(withheld).includes(String(SALE)),
    "the sale is absent from the row itself, because the row is what the page payload is made of",
  );

  const [totalled] = rollupAchievementByLine(withholdUnpublishedSales([row({}), row({ productCode: "P2" })], septemberOnly));
  assert.equal(totalled.actualValue, 0, "a roll-up of withheld rows cannot add the sale back");
  assert.equal(totalled.targetValue, 25_000_000, "and it still adds the targets");

  assert.deepEqual(
    withholdUnpublishedSales([row({ hasTarget: false, targetValue: null, targetUnits: null })], septemberOnly),
    [],
    "a row with no target holds nothing but a sale: its presence alone says this area and product sold",
  );
  assert.deepEqual(
    withholdUnpublishedSales([row({ lineCode: null })], new Set(["cns|2026-10"])).map((entry) => entry.actualValue),
    [0],
    "a row on no line is never published, whatever else is",
  );

  const published = row({ period: "2026-09" });
  assert.deepEqual(
    withholdUnpublishedSales([published], septemberOnly),
    [published],
    "a published month keeps every figure: the gate must not blank the months that are real",
  );

  // Per line, not per month. An area code repeats across lines and each line publishes on its own day.
  const partlyPublished = withholdUnpublishedSales(
    [row({ lineCode: "cns" }), row({ lineCode: "pedia" })],
    new Set(["cns|2026-10"]),
  );
  assert.deepEqual(
    partlyPublished.map((entry) => [entry.lineCode, entry.actualValue]),
    [["cns", SALE], ["pedia", 0]],
    "in a month one line has published, the other line's sale stays withheld",
  );

  // ── Sales vs Target's panel quotes the target and no sale, under any name ──
  const split = splitPeriodAtPublication([row({})], septemberOnly);
  assert.equal(split.salesLoaded, false);
  assert.equal(split.pendingTargetValue, 12_500_000, "the panel's target sentence keeps its figure");
  assert.ok(
    !JSON.stringify(split).includes(String(SALE)),
    "nothing the split hands the page holds the sale: it used to arrive as pendingDirectValue",
  );
  assert.ok(
    !source("src/components/sales/vs-target/vs-target-dashboard.tsx").includes("pendingDirectValue"),
    "the not-published panel must not print a sales figure",
  );

  // ── The Direct/Indirect panel ──────────────────────────────────────────────
  const cell = (lineCode: string | null, channel: "direct" | "indirect", salesValue: number): ChannelSplitCell => ({
    lineCode,
    areaCode: "CA1",
    repHrId: null,
    channel,
    salesValue,
  });
  const cells = [cell("cns", "direct", 100), cell("cns", "indirect", 200), cell("pedia", "indirect", 9_000), cell(null, "direct", 5)];
  const kept = publishedChannelCells(cells, "2026-10", new Set(["cns|2026-10"]));
  assert.deepEqual(
    kept.map((entry) => entry.salesValue),
    [100, 200],
    "only the published line's cells survive, in a month another line has not published",
  );
  assert.deepEqual(
    buildChannelSplit(kept, { kind: "company" }),
    { direct: 100, indirect: 200 },
    "so the panel's totals carry none of the unpublished line's 9,000",
  );
  assert.deepEqual(
    publishedChannelCells(cells, "2026-11", new Set(["cns|2026-10"])),
    [],
    "the month is part of the key: October's publication does not open November",
  );
  assert.ok(
    source("src/lib/sales/vs-target-page.ts").includes("buildChannelSplit(publishedChannelCells(channelCells, period, publishedKeys), bound)"),
    "the dashboard must build the panel from the gated cells",
  );

  // ── The Targets page ───────────────────────────────────────────────────────
  const page = source("app/employee-portals/targets/page.tsx");
  assert.ok(
    page.includes("applyAchievementAreaMerges(withholdUnpublishedSales(achievement, publishedKeys))"),
    "the portal Targets page must gate the achievement rows before anything is built from them",
  );
  assert.equal(
    page.split("applyAchievementAreaMerges(").length - 1,
    1,
    "and that gated read must be the only one, or a second path carries the raw rows",
  );
  assert.ok(page.includes("salesPublished={salesPublished}"), "the page must tell the workspace the month is unpublished");
  assert.ok(page.includes("let salesPublished = false;"), "and a failed publication read must leave it closed");

  const workspace = source("src/components/sales/targets-workspace.tsx");
  assert.ok(
    workspace.includes("canDrill: salesPublished &&"),
    "an unpublished month must offer no expander into its source rows",
  );
  assert.ok(
    workspace.includes("liveAch: salesPublished &&"),
    "an unpublished month must print no percentage: 0 / target reads as 0.0%, a claim nobody made",
  );
  assert.equal(
    workspace.split("salesPublished ? formatEgp(row.actualValue)").length - 1
      + workspace.split("salesPublished ? formatEgpFull(row.actualValue)").length - 1,
    2,
    "the desktop cell and the phone card must both print 'Not published', never a formatted zero",
  );

  // ── The Targets drill-down: `period` is in the query string ────────────────
  const breakdown = source("app/api/sales/targets/breakdown/route.ts");
  const gateAt = breakdown.indexOf("if (!isRowPublished({ lineCode: line, period }, publishedKeys))");
  const firstReadAt = breakdown.indexOf("loadSourceBreakdownDetail(period");
  assert.ok(gateAt !== -1, "the drill-down must refuse an unpublished period");
  assert.ok(firstReadAt !== -1 && gateAt < firstReadAt, "and refuse it before a source row is read");
  assert.ok(
    breakdown.includes("trend: trend.filter((point) => isRowPublished({ lineCode: line, period: point.period }, publishedKeys))"),
    "the trend returns every loaded month, so asking for a published one must not draw the unpublished one beside it",
  );

  // ── The brick drill-down ───────────────────────────────────────────────────
  assert.ok(
    source("app/api/sales/vs-target/bricks/route.ts").includes(
      "filterBricksForBound(brickRows, bound).filter((row) => isRowPublished(row, publishedKeys))",
    ),
    "the brick panel must gate per row: an area code repeats across lines, so a period-wide check leaks a line",
  );
  assert.equal(
    isRowPublished({ lineCode: "pedia", period: "2026-10" }, new Set(["cns|2026-10"])),
    false,
    "the same area code on the line that has not published stays closed",
  );
}
