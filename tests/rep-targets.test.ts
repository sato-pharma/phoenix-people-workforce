import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { AchievementRow } from "../src/lib/sales/monthly-targets.ts";
import {
  buildRepTargets,
  daysLeftInMonth,
  pickRepTargetsPeriod,
  repMonthStatus,
  repTargetsMonths,
  repTargetsProducts,
  repTargetsWindow,
  type RepTargetsNames,
} from "../src/lib/sales/rep-targets.ts";
import { shiftPeriod, totalRows } from "../src/lib/sales/vs-target.ts";

// ─────────────────────────────────────────────────────────────────────────────
// A Medical Rep's own Targets tab (owner, 2026-09-16).
//
// What these pin, in the order a regression would hurt:
//
//   1. The rep's numbers are the rep's Sales vs Target numbers. Achievement and the "No target"
//      figure come out of `totalRows` on the same rows, so the two screens cannot disagree.
//   2. Sales are shown only for a PUBLISHED month, and an unpublished month says null — never 0.
//      A zero would tell a rep they sold nothing in a month nobody has closed.
//   3. Units are added only inside ONE product. No month or page total carries units at all.
//   4. A forward month is offered only when a target is already loaded for it.
//   5. The loader is bounded to the rep's own HR id and to nothing wider (a source pin — it needs a
//      database to run, so its guard is asserted on the text).
// ─────────────────────────────────────────────────────────────────────────────

const CURRENT = "2026-09";
const TODAY = 16;

const PRODUCT_NAMES: Record<string, string> = { P1: "Alpha 10 ml ampoules", P2: "Beta 30 tablets", P3: "Gamma 20 sachets" };
const AREA_NAMES: Record<string, string> = { AB1: "Alexandria 1", CA2: "Nasr City" };
const LINE_NAMES: Record<string, string> = { cns: "CNS", pedia: "Pedia" };

const names: RepTargetsNames = {
  productName: (code) => PRODUCT_NAMES[code] ?? "Unnamed product",
  areaName: (_line, code) => AREA_NAMES[code] ?? "Unnamed area",
  lineName: (code) => LINE_NAMES[code] ?? "Unnamed line",
};

function row(overrides: Partial<AchievementRow>): AchievementRow {
  return {
    period: "2026-08",
    lineCode: "cns",
    regionCode: "R1",
    areaCode: "AB1",
    areaState: null,
    isOther: false,
    repSeatId: null,
    repHrId: "1001",
    dmSeatId: null,
    dmHrId: "1002",
    productCode: "P1",
    actualUnits: 0,
    actualValue: 0,
    targetUnits: null,
    targetValue: null,
    achievementValue: null,
    achievementUnits: null,
    hasTarget: false,
    hasActual: false,
    ...overrides,
  };
}

const targeted = (overrides: Partial<AchievementRow>) => row({ hasTarget: true, ...overrides });

// August: published. P1 is held in TWO areas (its units may be added — same product); P2 beats its
// target; P3 sold with no target at all.
const august = [
  targeted({ areaCode: "AB1", productCode: "P1", targetUnits: 100, targetValue: 10000, actualUnits: 90, actualValue: 9000, hasActual: true }),
  targeted({ areaCode: "CA2", productCode: "P1", targetUnits: 50.4, targetValue: 5040, actualUnits: 60, actualValue: 6000, hasActual: true }),
  targeted({ areaCode: "AB1", productCode: "P2", targetUnits: 20, targetValue: 4000, actualUnits: 25, actualValue: 5000, hasActual: true }),
  row({ areaCode: "AB1", productCode: "P3", actualUnits: 7, actualValue: 700, hasActual: true }),
];
// September: the current month. Sales rows exist, but the closing is not published.
const september = [
  targeted({ period: "2026-09", productCode: "P1", targetUnits: 110, targetValue: 11000, actualUnits: 30, actualValue: 3000, hasActual: true }),
  row({ period: "2026-09", productCode: "P3", actualUnits: 10, actualValue: 1000, hasActual: true }),
];
// October carries a loaded target; November only an empty forward row.
const october = [targeted({ period: "2026-10", productCode: "P1", targetUnits: 120, targetValue: 12000 })];
const november = [row({ period: "2026-11", productCode: "P2" })];

const allRows = [...august, ...september, ...october, ...november];
const published = new Set(["cns|2026-08"]);

function build(requestedPeriod: string | null, rows: AchievementRow[] = allRows, keys: ReadonlySet<string> = published) {
  return buildRepTargets({ rows, publishedKeys: keys, current: CURRENT, today: TODAY, requestedPeriod, names });
}

export function runRepTargetsTests() {
  // ── HEADLINE: an unpublished month shows NO sales — null, never 0 ─────────────
  const septemberView = build(null);
  assert.equal(septemberView.period, "2026-09", "the tab opens on the current month when a target is loaded for it");
  assert.equal(septemberView.status, "in_progress");
  assert.equal(
    septemberView.totals.actualValue,
    null,
    "September's closing is not published: its sales must be null. EGP 4,000 of raw September rows exist, and " +
      "printing them — or a 0 — against the target is exactly what the publication gate forbids.",
  );
  assert.equal(septemberView.totals.achievementValue, null);
  assert.equal(septemberView.totals.productsAtTarget, null);
  assert.equal(septemberView.totals.noTargetSalesValue, 0);
  for (const product of septemberView.products) {
    assert.equal(product.actualValue, null, `${product.productName} must not carry unpublished sales`);
    assert.equal(product.actualUnits, null);
    assert.equal(product.achievementValue, null);
    assert.equal(product.gapValue, null);
  }
  assert.deepEqual(
    septemberView.products.map((product) => product.productName),
    ["Alpha 10 ml ampoules"],
    "an untargeted product must not be listed in an unpublished month — its presence would announce unpublished sales",
  );
  assert.equal(septemberView.daysLeft, 15, "16 September: fifteen days left, today included");

  // ── Parity with Sales vs Target: the same function on the same rows ──────────
  const augustView = build("2026-08");
  const augustTotals = totalRows(august);
  assert.equal(augustView.status, "published");
  assert.equal(augustView.totals.achievementValue, augustTotals.achievementValue, "achievement must be totalRows' own figure");
  assert.equal(augustView.totals.actualValue, augustTotals.actualValue);
  assert.equal(augustView.totals.targetValue, 19040);
  assert.equal(augustView.totals.gapValue, 20700 - 19040);
  assert.equal(
    augustView.totals.noTargetSalesValue,
    augustTotals.uncoveredActualValue,
    "the 'no target' figure must be the one Sales vs Target prints, so the two screens quote the same pounds",
  );
  assert.equal(augustView.totals.noTargetSalesValue, 700);
  assert.equal(augustView.totals.targetedProducts, 2);
  assert.equal(augustView.totals.productsAtTarget, 1, "only Beta reached 100%");
  assert.equal(augustView.daysLeft, null, "days left belongs to the in-progress month only");

  // ── Units: added inside one product, never across products ───────────────────
  const [alpha, beta, gamma] = augustView.products;
  assert.equal(alpha?.productName, "Alpha 10 ml ampoules", "largest target first");
  assert.equal(alpha?.targetUnits, 150.4, "the same product in two areas adds its units");
  assert.equal(alpha?.actualUnits, 150);
  assert.equal(alpha?.targetValue, 15040);
  assert.ok(Math.abs((alpha?.gapUnits ?? 0) - -0.4) < 1e-9);
  assert.equal(alpha?.gapValue, -40);
  assert.equal(alpha?.achievementValue, totalRows(august.slice(0, 2)).achievementValue);
  assert.equal(beta?.productName, "Beta 30 tablets");
  assert.equal(beta?.achievementValue, 1.25);
  assert.equal(gamma?.productName, "Gamma 20 sachets", "a published untargeted product that sold is listed last");
  assert.equal(gamma?.hasTarget, false);
  assert.equal(gamma?.achievementValue, null, "an untargeted product is not graded on its own");
  assert.equal(gamma?.targetShare, null);
  for (const key of [...Object.keys(augustView.totals), ...Object.keys(augustView.months[0] ?? {})]) {
    assert.ok(
      !/units/i.test(key),
      `"${key}" is a units figure on a total that spans products. Units of different products are never added — ` +
        "above one product the only honest total is value.",
    );
  }

  // ── Months offered ───────────────────────────────────────────────────────────
  const months = repTargetsMonths(allRows, published, CURRENT);
  assert.deepEqual(
    months.map((month) => [month.period, month.status]),
    [
      ["2026-08", "published"],
      ["2026-09", "in_progress"],
      ["2026-10", "upcoming"],
    ],
    "November carries no target yet — targets arrive a quarter at a time, so it is simply not offered",
  );
  assert.equal(months[0]?.actualValue, 20700);
  assert.equal(months[1]?.actualValue, null, "an unpublished month in the strip is null too, never 0");
  assert.equal(months[2]?.targetValue, 12000);
  assert.deepEqual(
    repTargetsMonths([], new Set(), CURRENT).map((month) => month.period),
    [CURRENT],
    "the current month is always offered, even with nothing in it",
  );

  // ── Month status ─────────────────────────────────────────────────────────────
  assert.equal(repMonthStatus("2026-08", new Set(["cns"]), published, CURRENT), "published");
  assert.equal(repMonthStatus("2026-07", new Set(["cns"]), published, CURRENT), "awaiting_closing");
  assert.equal(
    repMonthStatus("2026-08", new Set(["cns", "pedia"]), published, CURRENT),
    "awaiting_closing",
    "every line the rep holds that month must be published — never half a month's sales against a whole month's target",
  );
  assert.equal(repMonthStatus(CURRENT, new Set(["cns"]), new Set([`cns|${CURRENT}`]), CURRENT), "published");
  assert.equal(repMonthStatus(CURRENT, new Set(["cns"]), published, CURRENT), "in_progress");
  assert.equal(repMonthStatus("2026-10", new Set(["cns"]), published, CURRENT), "upcoming");

  // ── Landing month ────────────────────────────────────────────────────────────
  assert.equal(pickRepTargetsPeriod(months, CURRENT, "2026-10"), "2026-10", "a requested month that is offered wins");
  assert.equal(pickRepTargetsPeriod(months, CURRENT, "2026-11"), CURRENT, "a requested month that is not offered is ignored");
  assert.equal(pickRepTargetsPeriod(months, CURRENT, "not-a-month"), CURRENT);
  const noCurrentTarget = repTargetsMonths([...august, september[1]!], published, CURRENT);
  assert.equal(
    pickRepTargetsPeriod(noCurrentTarget, CURRENT, null),
    "2026-08",
    "without a current target the tab opens on the newest month that had one",
  );
  assert.equal(pickRepTargetsPeriod(repTargetsMonths([], new Set(), CURRENT), CURRENT, null), CURRENT);
  assert.equal(build("2026-11").period, CURRENT);

  // ── Forward month ────────────────────────────────────────────────────────────
  const octoberView = build("2026-10");
  assert.equal(octoberView.status, "upcoming");
  assert.equal(octoberView.totals.targetValue, 12000);
  assert.equal(octoberView.products[0]?.targetUnits, 120);
  assert.equal(octoberView.daysLeft, null);

  // ── Names, never codes ───────────────────────────────────────────────────────
  assert.deepEqual(augustView.lineNames, ["CNS"]);
  assert.deepEqual(augustView.areaNames, ["Alexandria 1", "Nasr City"]);
  const bareCurrent = build(CURRENT, august);
  assert.deepEqual(
    bareCurrent.areaNames,
    ["Alexandria 1", "Nasr City"],
    "a month with no rows of its own still names the rep's areas from their newest month",
  );
  for (const view of [augustView, septemberView, octoberView]) {
    for (const product of view.products) {
      assert.doesNotMatch(product.productName, /^P\d$/, "a product code must never reach the screen");
    }
  }

  // ── Nothing attributed ───────────────────────────────────────────────────────
  const empty = build(null, [], new Set());
  assert.equal(empty.isEmptyScope, true);
  assert.equal(empty.period, CURRENT);
  assert.deepEqual(empty.products, []);
  assert.equal(empty.totals.targetValue, 0);
  assert.equal(empty.totals.actualValue, null);

  // ── Pure helpers ─────────────────────────────────────────────────────────────
  assert.deepEqual(repTargetsWindow("2026-09"), { from: "2026-07", to: "2026-12" }, "never before the July 2026 floor");
  assert.deepEqual(repTargetsWindow("2028-05"), { from: "2027-06", to: "2028-08" }, "a trailing year, not the floor");
  for (const current of ["2026-07", "2026-09", "2027-06", "2028-05", "2031-12"]) {
    const { from, to } = repTargetsWindow(current);
    let span = 1;
    for (let cursor = from; cursor < to; cursor = shiftPeriod(cursor, 1)!) span += 1;
    assert.ok(
      span <= 24,
      `${current}: a ${span}-month window passes the range loader's 24-month cap, which would silently cut off ` +
        "the current month and everything after it",
    );
    assert.ok(from <= current && current <= to, `${current} must sit inside its own window`);
  }
  assert.equal(daysLeftInMonth("2026-09", 16), 15);
  assert.equal(daysLeftInMonth("2026-09", 30), 1, "the last day still has one day left — today");
  assert.equal(daysLeftInMonth("2026-02", 1), 28);
  assert.equal(daysLeftInMonth("2028-02", 1), 29, "leap year");

  // Products with neither a target nor sales are dropped even when published.
  assert.deepEqual(repTargetsProducts([row({ productCode: "P2" })], true, names.productName), []);

  // ── The loader: SELF only, merged before bounded ─────────────────────────────
  const source = readFileSync("src/lib/sales/rep-targets.ts", "utf8");
  assert.match(
    source,
    /if \(bound\.kind !== "self"\) return empty\(\);/,
    "the rep loader must refuse every bound but SELF. A line or area bound here would show one rep other reps' numbers.",
  );
  assert.match(
    source,
    /filterRowsForBound\(applyAchievementAreaMerges\(rangeRows\), bound\)/,
    "rows must be merged BEFORE they are bounded, exactly as Sales vs Target does",
  );
  // The header comment names the manager bound to explain why it is NOT used, so pin the code: no
  // import from its module and no call to either function.
  assert.doesNotMatch(
    source,
    /from "@\/lib\/sales\/portal-targets"/,
    "rep-targets.ts must not import the manager bound: it resolves a Medical Rep to their whole line",
  );
  for (const banned of ["resolvePortalTargetsBound(", "filterAchievementForScope("]) {
    assert.ok(!source.includes(banned), `rep-targets.ts must not call ${banned}) — it hands a rep every rep on their line`);
  }
  assert.doesNotMatch(
    source,
    /loadPublishedPeriodKeys\([^)]*\)\s*\.catch/,
    "a failed publication read must throw, never become an empty set that marks a published month unpublished",
  );

  // ── The header fits a 1024px laptop ──────────────────────────────────────────
  // A 1024px screen leaves the portal page 621px beside the sidebar. With the ring AND the "At
  // target" aside beside the headline there, the headline column measured 100px and its title and
  // stats spilled out of it, so the rep header keeps both below the headline until xl.
  const view = readFileSync("src/components/sales/rep-targets-view.tsx", "utf8");
  assert.match(
    view,
    /<CommandBand\b(?:(?!\/>)[\s\S])*\bbesideFrom="xl"/,
    "the rep header must keep its ring and aside below the headline until xl — beside it at 1024px they squeeze the headline to 100px",
  );
  const visuals = readFileSync("src/components/sales/target-visuals.tsx", "utf8");
  assert.match(
    visuals,
    /besideFrom === "xl"\s*\?\s*"xl:flex-row xl:items-center xl:justify-between"/,
    'CommandBand must move the ring beside the headline only from xl when a page passes besideFrom="xl"',
  );
}
