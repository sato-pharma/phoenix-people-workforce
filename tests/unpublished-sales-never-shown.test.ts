import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";
import { rollupAchievementByLine, type AchievementRow } from "../src/lib/sales/monthly-targets.ts";
import { isRowPublished, splitPeriodAtPublication, withholdUnpublishedSales } from "../src/lib/sales/vs-target.ts";
import { buildChannelSplit, publishedChannelCells, type ChannelSplitCell } from "../src/lib/sales/vs-target-page.ts";
import {
  isSalesPeriodReleased,
  isSalesPeriodReleasedCompanyWide,
  isSalesPeriodReleasedForLines,
  newestCompanyPublishedPeriod,
  newestPeriodPublishedForLines,
  readsLiveBusinessReview,
  readsUnpublishedSalesTools,
  releasedPeriodsUpToFirstHole,
  salesScopeLineCodes,
} from "../src/lib/sales/unpublished-sales-access.ts";
import { gateWindow, selectableWindows } from "../src/lib/spotlight/period.ts";

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

  // ── Who reads an unpublished month: his two rulings of that morning ─────────
  const viewer = (role: string, scope = "self") => ({ role, scope }) as Parameters<typeof readsUnpublishedSalesTools>[0];
  assert.equal(readsUnpublishedSalesTools(viewer("Super Admin", "all")), true);
  assert.equal(readsUnpublishedSalesTools(viewer("SFE Manager", "all")), true);
  assert.equal(readsUnpublishedSalesTools(viewer("Medical Rep", "system")), true, "the system's own runs are not a viewer");
  assert.equal(readsUnpublishedSalesTools(viewer("CEO", "all")), false, "'Super Admin and SFE only': the CEO is refused the tools");
  assert.equal(readsUnpublishedSalesTools(viewer("Finance Manager", "all")), false);
  assert.equal(readsUnpublishedSalesTools(viewer("Marketing Manager", "all")), false);
  assert.equal(readsUnpublishedSalesTools(viewer("Medical Rep")), false);
  assert.equal(readsUnpublishedSalesTools(null), false, "no viewer reads nothing");

  assert.equal(readsLiveBusinessReview(viewer("CEO", "all")), true, "'Admins keep the live view': the CEO keeps this one");
  assert.equal(readsLiveBusinessReview(viewer("SFE Manager", "all")), true);
  assert.equal(readsLiveBusinessReview(viewer("Super Admin", "all")), true);
  assert.equal(readsLiveBusinessReview(viewer("Marketing Manager", "all")), false);
  assert.equal(readsLiveBusinessReview(viewer("Regional Manager", "region")), false);
  assert.equal(readsLiveBusinessReview(null), false);

  // ── What counts as released ─────────────────────────────────────────────────
  const threeMonths = new Set(
    ["2026-07", "2026-08", "2026-09"].flatMap((period) => ["cns", "pedia", "anti_infective"].map((code) => `${code}|${period}`)),
  );
  assert.equal(isSalesPeriodReleased("2026-06", null, new Set()), true, "January to June are history with no publication row");
  assert.equal(isSalesPeriodReleased("2026-09", "cns", threeMonths), true);
  assert.equal(isSalesPeriodReleased("2026-10", "cns", threeMonths), false, "October holds sales and no publication");
  assert.equal(isSalesPeriodReleased("2026-09", null, threeMonths), false, "a row on no line is never released");

  const octoberOnCns = new Set([...threeMonths, "cns|2026-10"]);
  assert.equal(isSalesPeriodReleasedForLines("2026-10", ["cns"], octoberOnCns), true, "a viewer on the published line sees it");
  assert.equal(isSalesPeriodReleasedForLines("2026-10", ["cns", "pedia"], octoberOnCns), false, "a viewer across two lines waits for both");
  assert.equal(isSalesPeriodReleasedForLines("2026-09", [], threeMonths), false, "no lines at all opens nothing");
  assert.equal(isSalesPeriodReleasedForLines("2026-09", ["cns", null], threeMonths), false, "a scope line that resolves to nothing fails closed");
  assert.equal(isSalesPeriodReleasedForLines("2026-03", [], new Set()), true, "and history stays history");
  assert.equal(isSalesPeriodReleasedCompanyWide("2026-10", octoberOnCns), false, "a company figure waits for every line");
  assert.equal(isSalesPeriodReleasedCompanyWide("2026-09", octoberOnCns), true);

  assert.deepEqual(salesScopeLineCodes({ canViewAllSales: true, allowedLineNames: null }), ["cns", "pedia", "anti_infective"]);
  assert.deepEqual(salesScopeLineCodes({ canViewAllSales: false, allowedLineNames: new Set(["Anti Infective"]) }), ["anti_infective"]);
  assert.deepEqual(salesScopeLineCodes({ canViewAllSales: false, allowedLineNames: new Set(["Head Office"]) }), [null], "kept as null, so it fails closed");
  assert.deepEqual(salesScopeLineCodes({ canViewAllSales: false, allowedLineNames: new Set() }), []);

  assert.deepEqual(
    releasedPeriodsUpToFirstHole(["2026-10", "2026-09", "2026-07", "2026-06", "2026-11", "2026-08"], threeMonths),
    ["2026-06", "2026-07", "2026-08", "2026-09"],
    "the Business Review's window stops at the last published month",
  );
  const augustWithdrawn = new Set([...threeMonths].filter((key) => !key.endsWith("|2026-08")));
  assert.deepEqual(
    releasedPeriodsUpToFirstHole(["2026-07", "2026-08", "2026-09"], augustWithdrawn),
    ["2026-07"],
    "a range read cannot step over a withdrawn month, so nothing after the hole is offered",
  );

  assert.equal(newestCompanyPublishedPeriod(octoberOnCns), "2026-09", "the CEO's card adds the lines, so one line's October does not move it");
  assert.equal(newestCompanyPublishedPeriod(new Set(["cns|2026-07"])), null, "nothing fully published is null, not the newest month loaded");
  assert.equal(newestPeriodPublishedForLines(["cns"], octoberOnCns), "2026-10");

  // ── The Spotlight gate: a finished month is not yet a published one ─────────
  const firstOfNovember = { year: 2026, month: 11 };
  const isPublished = (period: string) => isSalesPeriodReleasedCompanyWide(period, threeMonths);
  assert.equal(gateWindow({ kind: "month", key: "2026-10" }, firstOfNovember).allowed, true, "October has finished");
  assert.equal(gateWindow({ kind: "month", key: "2026-10" }, firstOfNovember, isPublished).allowed, false, "and is not published");
  assert.equal(gateWindow({ kind: "month", key: "2026-09" }, firstOfNovember, isPublished).allowed, true);
  assert.equal(gateWindow({ kind: "quarter", key: "2026-Q3" }, firstOfNovember, isPublished).allowed, true);
  assert.equal(
    gateWindow({ kind: "quarter", key: "2026-Q4" }, { year: 2027, month: 1 }, isPublished).allowed,
    false,
    "one unpublished month closes the whole window",
  );
  assert.equal(
    selectableWindows("month", firstOfNovember, 3, isPublished)[0]!.key,
    "2026-09",
    "the picker follows the same gate, so it never offers what the export refuses",
  );

  // ── Each surface is wired to the gate. These need a live database, so read with comments removed ──
  const pin = (path: string, needle: string, why: string) => assert.ok(source(path).includes(needle), `${path}: ${why}`);
  // The refusal must come before the read it protects, or the data has been loaded for nothing and a
  // later edit can return it.
  const before = (path: string, gate: string, read: string, why: string) => {
    const body = source(path);
    const gateAt = body.indexOf(gate);
    const readAt = body.indexOf(read);
    assert.ok(gateAt !== -1 && readAt !== -1 && gateAt < readAt, `${path}: ${why}`);
  };

  pin("src/lib/sales/sos-dashboard.ts", "isSalesPeriodReleasedForLines(period, salesScopeLineCodes(salesScope), publishedKeys)", "the month list behind the picker, the trend and the comparisons must be gated");
  pin("src/lib/sales/sos-dashboard.ts", "const [loadedPeriods, references,", "the raw list must not keep the name the rest of the function reads");
  pin("src/lib/employee-portal/portal-sales-canonical.ts", "applyAchievementAreaMerges(released)", "the rep's Incentive tab and the portal payload are built from these rows");
  pin("src/lib/employee-360/brick-coverage.ts", "isSalesPeriodReleased(period, territory.lineCode, publishedKeys)", "the rep's bricks, and the fallback to the latest month, read this list");
  pin("src/lib/phoenix-crm/server/brick-report.ts", ".filter((month) => isSalesPeriodReleased(month, code, publishedKeys))", "the CRM brick report must gate each line's own months");
  pin("src/lib/direct-orders/rep-area-view-service.ts", "isSalesPeriodReleased(request.sales_month, repLineCode, publishedKeys)", "Direct Orders in My Area is a sales figure");
  pin("src/lib/sales/sos-month-pace-loader.ts", "directReleased\n      ? rpcAll<ClosingDirectRow>", "the pace strip's booked orders wait for the closing; the weekly half is his carve-out");
  pin("src/lib/market-awareness/tracking.ts", "isSalesPeriodReleased(row.period, line.lineCode, publishedKeys)", "the tracking function answers for any month that holds data");
  assert.ok(
    !source("src/lib/market-awareness/tracking.ts").includes("phx_market_awareness_last_closed_period"),
    "the last closed month must come from the publication keys, per this activity's lines",
  );
  pin("src/lib/sales/service.ts", "isSalesPeriodReleased(record.period, resolveTargetLineCode(record.line), publishedKeys)", "the monthly dashboard, the overview and the platform tile share this read");
  pin("src/lib/crm/brick-coverage.ts", "isSalesPeriodReleased(month, resolveTargetLineCode(row.official_line), publishedKeys)", "the board opens on the running month and takes any month in its URL");
  pin("app/(admin)/admin/brick-coverage/page.tsx", "includeUnpublishedSales: readsUnpublishedSalesTools(access)", "only the tools' readers may ask for them");
  pin("src/lib/pharmacy-search/profile.ts", "isSalesPeriodReleasedCompanyWide(period, publishedKeys)", "a pharmacy's monthly history reads the raw roll-up");
  pin("src/lib/direct-orders/service.ts", "if (!visibility.allowsRetailMonth(month)) continue;", "the retail feed beside an order is raw sales; the order itself is a work record");

  // Business Review: live for his three, published for everyone else, through both portal doors.
  pin("src/lib/business-review/service.ts", "releasedPeriodsUpToFirstHole(reviewPeriods, publishedKeys)", "the window must be capped, because the bundle is built from the window");
  pin("app/employee-portals/business-review/page.tsx", "publishedOnly: !readsLiveBusinessReview(access)", "the portal page must stop managers at the last published month");
  pin("app/api/business-review/pack/route.ts", "publishedOnly: !readsLiveBusinessReview(access)", "and so must the pack they download");

  // Refused outright, including by typed URL.
  before("app/api/sales/monthly-import/batches/route.ts", "readsUnpublishedSalesTools(access)", "listSourceOfSalesUploadBatches()", "the upload list prints totals, and sales:read reaches every role");
  before("app/api/sales/truth-check/route.ts", "readsUnpublishedSalesTools(access)", "loadSalesTruthReport(", "the truth check reads any month, and sales:read reaches every role");
  before("app/api/sales/monthly-closing/premium-export/route.ts", "isSalesPeriodReleased(", "fillClosingEngine(", "a workbook must be refused before it is filled");
  before("app/api/sales/monthly-closing/consolidated-export/route.ts", "isSalesPeriodReleased(", "buildConsolidatedClosingWorkbook({", "every month in the consolidated workbook must be published");
  before("app/api/sales/monthly-closing/consolidated-premium-export/route.ts", "isSalesPeriodReleased(", "buildConsolidatedPremiumClosing({", "and in its premium twin");
  before("app/api/sales/sos-dashboard/email-report/route.ts", "isSalesPeriodReleasedCompanyWide(", "buildAndEmailSosBiReport({ period })", "the by-hand send reads as the system, so nothing further down asks");

  // Spotlight: the gate and the picker must read the same keys.
  pin("src/lib/spotlight/service.ts", "isSalesPeriodReleasedCompanyWide(period, publishedKeys)", "the sheet is company-wide");
  pin("app/api/spotlight/options/route.ts", 'selectableWindows("month", undefined, 18, isPublished)', "the picker must follow the gate");
  pin("app/(admin)/spotlight/page.tsx", 'selectableWindows("month", undefined, 18, isPublished)', "on first paint too");

  // The CEO's card.
  const ceo = source("src/lib/ceo/command-center.ts");
  assert.ok(ceo.includes("loadSalesReleaseKeys()\n    .then(newestCompanyPublishedPeriod)"), "the card adds the lines, so its month must be published on all of them");
  assert.ok(ceo.includes("closingPeriod ? loadSourceOfSalesDashboard(closingPeriod,"), "no fully published month must read as unavailable, not as the newest month loaded");
  assert.ok(ceo.includes("sosR.value?.period === closingPeriod"), "the loader answers its newest month when asked for one with no batch");
  assert.ok(!ceo.includes("latestPublishedClosingPeriod("), "one line publishing must not move the card");
}
