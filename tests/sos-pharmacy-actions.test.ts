import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildPharmacyActions,
  classifyRowKind,
  findSharedCustomerKeys,
  type PeriodRows,
  type PharmacyActionRow,
} from "../src/lib/sales/sos-pharmacy-actions.ts";
import { buildMonthPace } from "../src/lib/sales/sos-month-pace.ts";

// The portal Source of Sales pharmacy action lists. Every rule here is the owner's own pick
// (2026-09-14): STOPPED = bought in any of the 3 closings before the latest and nothing in the
// latest; DROPPING = latest 30%+ below the 3-closing average; NEW = latest only. Main Stores,
// El Qema, wholesaler city-split shares and code-less rows are never a pharmacy to chase.

function row(overrides: Partial<PharmacyActionRow> & { clientCode: string; salesValue: number }): PharmacyActionRow {
  return {
    distributorCode: "IBN",
    clientName: `Pharmacy ${overrides.clientCode}`,
    clientAddress: "",
    areaCode: "CA1",
    sheetAreaCode: "CA1",
    areaName: "Cairo 1",
    sheetAreaName: "Cairo 1",
    brickId: "B1",
    brickName: "Brick One",
    productCode: "P1",
    productName: "Product One",
    effectiveUnits: 10,
    isDirect: false,
    evenSplitApplied: false,
    ...overrides,
  };
}

const LATEST = "2026-08";
const P1 = "2026-07";
const P2 = "2026-06";
const P3 = "2026-05";

function periods(byPeriod: Record<string, PharmacyActionRow[]>): PeriodRows[] {
  return Object.entries(byPeriod).map(([period, rows]) => ({ period, rows }));
}

export function runSosPharmacyActionsTests() {
  // ── PER AREA: every tile's count and money come from one area-scoped set ─────
  // A rep with two areas picked one and saw that area's COUNTS beside every area's EGP, and a
  // "Buying pharmacies" figure that never narrowed (2026-09-25). byArea is computed from the
  // uncapped lists, so its counts, its money and its top list agree, and the areas sum to the whole.
  {
    const cairo2 = { areaCode: "CA2", sheetAreaCode: "CA2", areaName: "Cairo 2", sheetAreaName: "Cairo 2", brickId: "B2" };
    const result = buildPharmacyActions({
      periods: periods({
        [LATEST]: [
          row({ clientCode: "A1", salesValue: 100 }),
          row({ clientCode: "A2", salesValue: 40 }),
          row({ clientCode: "B1", salesValue: 700, ...cairo2 }),
          row({ clientCode: "BNEW", salesValue: 60, ...cairo2 }),
          row({ clientCode: "", salesValue: 30, ...cairo2 }),
        ],
        [P1]: [
          row({ clientCode: "A1", salesValue: 100 }),
          row({ clientCode: "A2", salesValue: 100 }),
          row({ clientCode: "AGONE", salesValue: 90 }),
          row({ clientCode: "B1", salesValue: 700, ...cairo2 }),
          row({ clientCode: "BGONE", salesValue: 300, ...cairo2 }),
        ],
      }),
    });
    const ca1 = result.byArea.CA1;
    const ca2 = result.byArea.CA2;
    assert.ok(ca1 && ca2, "each area with sales gets a summary");

    const inAreaOf = (code: string) => <T extends { areaCode: string }>(list: T[]) => list.filter((item) => item.areaCode === code);
    for (const [code, summary] of Object.entries(result.byArea)) {
      const inArea = inAreaOf(code);
      assert.equal(summary.counts.stopped, inArea(result.stopped).length, `${code}: stopped count = its list`);
      assert.equal(summary.counts.dropping, inArea(result.dropping).length, `${code}: dropping count = its list`);
      assert.equal(summary.counts.newPharmacies, inArea(result.newPharmacies).length, `${code}: new count = its list`);
      assert.equal(summary.valueAtStake.stopped, inArea(result.stopped).reduce((t, i) => t + i.priorAverage, 0), `${code}: stopped EGP = its own pharmacies`);
      assert.equal(summary.valueAtStake.newPharmacies, inArea(result.newPharmacies).reduce((t, i) => t + i.latestValue, 0), `${code}: new EGP = its own pharmacies`);
      assert.equal(summary.counts.activePharmacies, summary.top.length, `${code}: buying count = its top list (under the cap)`);
      assert.equal(summary.latestTotals.pharmacies, summary.top.reduce((t, i) => t + i.latestValue, 0), `${code}: buying EGP = its buying pharmacies`);
      assert.ok(summary.top.every((item) => item.areaCode === code), `${code}: top list holds only its own pharmacies`);
      assert.deepEqual(summary.stopped.map((item) => item.key), inArea(result.stopped).map((item) => item.key), `${code}: stopped LIST is its own area's rows, not the count alone`);
      assert.deepEqual(summary.dropping.map((item) => item.key), inArea(result.dropping).map((item) => item.key), `${code}: dropping LIST is its own area's rows`);
      assert.deepEqual(summary.newPharmacies.map((item) => item.key), inArea(result.newPharmacies).map((item) => item.key), `${code}: new LIST is its own area's rows`);
      assert.deepEqual(summary.crossSell.map((item) => item.key), inArea(result.crossSell).map((item) => item.key), `${code}: cross-sell LIST is its own area's rows`);
      assert.deepEqual(summary.untappedBricks.map((b) => b.brickId), inArea(result.untappedBricks).map((b) => b.brickId), `${code}: untapped-bricks LIST is its own area's rows`);
    }

    assert.equal(ca1.counts.activePharmacies, 2, "Cairo 1 has two buying pharmacies, not the four across both areas");
    assert.equal(ca1.latestTotals.pharmacies, 140, "Cairo 1's buying EGP is its own 140, not 900");
    assert.equal(ca1.valueAtStake.stopped, 90, "Cairo 1's stopped EGP is AGONE only");
    assert.equal(ca1.valueAtStake.dropping, 60, "Cairo 1's dropping EGP is A2 only (100 before, 40 latest)");
    assert.equal(ca2.valueAtStake.stopped, 300, "Cairo 2's stopped EGP is BGONE only");
    assert.equal(ca2.latestTotals.noCustomerCode, 30, "a code-less row lands in its own area's tie-back");
    assert.equal(ca2.latestTotals.total, 790);
    assert.equal(ca1.top[0].share, 100 / 140, "an area's top share is of that area's pharmacy value");

    const sumOf = (pick: (summary: (typeof result.byArea)[string]) => number) =>
      Object.values(result.byArea).reduce((total, summary) => total + pick(summary), 0);
    assert.equal(sumOf((a) => a.latestTotals.total), result.latestTotals.total, "the areas add back to the whole closing");
    assert.equal(sumOf((a) => a.latestTotals.pharmacies), result.latestTotals.pharmacies);
    assert.equal(sumOf((a) => a.counts.activePharmacies), result.counts.activePharmacies);
    assert.equal(sumOf((a) => a.valueAtStake.stopped), result.valueAtStake.stopped);

    // The screen reads byArea for every figure AND every list, never the whole result's globally
    // capped list filtered to an area — that undercounts once a line passes ACTION_LIST_LIMIT
    // (caught in review on this PR: only "top" read the per-area list at first).
    const screen = readFileSync(new URL("../src/components/sales/portal/portal-sos-pharmacy-actions.tsx", import.meta.url), "utf8");
    assert.ok(screen.includes("actions.byArea?.[area]"), "the screen scopes its figures through byArea");
    for (const whole of ["actions.valueAtStake", "actions.counts", "actions.latestTotals"]) {
      assert.ok(!screen.includes(whole), `the screen never renders ${whole} directly — it would stay all-areas when an area is picked`);
    }
    for (const capped of ["inArea(actions.crossSell)", "inArea(actions.untappedBricks)", "inArea(actions[tab])"]) {
      assert.ok(!screen.includes(capped), `the screen never filters ${capped} to an area — that list is already globally capped`);
    }
    for (const scoped of ["scope?.crossSell", "scope?.untappedBricks", "scope?.["]) {
      assert.ok(screen.includes(scoped), `the screen reads ${scoped} for its list, not the capped whole-result array`);
    }
  }

  // ── The global cap can hide an area's own rows behind bigger rows from OTHER areas: byArea's
  // lists must be capped PER AREA, not filtered out of the whole result's already-capped list ──
  {
    const big = { areaCode: "CA9", sheetAreaCode: "CA9", areaName: "Cairo 9", sheetAreaName: "Cairo 9", brickId: "B9" };
    const latestRows = [row({ clientCode: "SMALL", salesValue: 0 })];
    const priorRows = [row({ clientCode: "SMALL", salesValue: 10 })];
    for (let i = 0; i < 204; i += 1) {
      latestRows.push(row({ clientCode: `BIG${i}`, salesValue: 0, ...big }));
      priorRows.push(row({ clientCode: `BIG${i}`, salesValue: 1000, ...big }));
    }
    const result = buildPharmacyActions({ periods: periods({ [LATEST]: latestRows, [P1]: priorRows }) });
    assert.equal(result.stopped.length, 200, "the whole-result list is capped at ACTION_LIST_LIMIT");
    assert.ok(!result.stopped.some((item) => item.name === "Pharmacy SMALL"), "SMALL's tiny average sorts past the global cap, out of the whole list");
    assert.equal(result.byArea.CA1.counts.stopped, 1, "CA1's tile count still finds SMALL");
    assert.deepEqual(result.byArea.CA1.stopped.map((item) => item.name), ["Pharmacy SMALL"], "CA1's own LIST still shows SMALL — capped per area, not filtered out of the global 200");
  }

  // ── STOPPED ────────────────────────────────────────────────────────────────
  {
    const result = buildPharmacyActions({
      periods: periods({
        [LATEST]: [row({ clientCode: "ACTIVE", salesValue: 500 })],
        [P1]: [row({ clientCode: "ACTIVE", salesValue: 500 })],
        [P2]: [row({ clientCode: "GONE", salesValue: 900 }), row({ clientCode: "ACTIVE", salesValue: 500 })],
        [P3]: [row({ clientCode: "ACTIVE", salesValue: 500 })],
      }),
    });
    assert.deepEqual(result.stopped.map((item) => item.name), ["Pharmacy GONE"], "bought in one of the 3 prior closings, nothing in the latest = stopped");
    assert.equal(result.stopped[0].priorAverage, 300, "the average counts the months it did not buy as zeros");
    assert.equal(result.stopped[0].lastBoughtPeriod, P2);
    assert.equal(result.valueAtStake.stopped, 300);
    assert.equal(result.latestPeriod, LATEST);
    assert.deepEqual(result.priorPeriods, [P1, P2, P3]);
    assert.equal(result.historyComplete, true);
  }

  // A closing older than the look-back is outside the rule: bought 4 closings ago only is not "stopped".
  {
    const result = buildPharmacyActions({
      periods: periods({
        [LATEST]: [row({ clientCode: "A", salesValue: 1 })],
        [P1]: [row({ clientCode: "A", salesValue: 1 })],
        [P2]: [row({ clientCode: "A", salesValue: 1 })],
        [P3]: [row({ clientCode: "A", salesValue: 1 })],
        "2026-04": [row({ clientCode: "OLD", salesValue: 5000 })],
      }),
    });
    assert.equal(result.stopped.length, 0, "only the 3 closings before the latest are looked back over");
  }

  // ── DROPPING: at or beyond 30% below the 3-closing average ─────────────────
  {
    const history = (code: string) => [P1, P2, P3].map((period) => [period, row({ clientCode: code, salesValue: 1000 })] as const);
    const byPeriod: Record<string, PharmacyActionRow[]> = { [LATEST]: [], [P1]: [], [P2]: [], [P3]: [] };
    for (const code of ["AT70", "AT71", "HALF"]) for (const [period, entry] of history(code)) byPeriod[period].push(entry);
    byPeriod[LATEST].push(row({ clientCode: "AT70", salesValue: 700 }));
    byPeriod[LATEST].push(row({ clientCode: "AT71", salesValue: 701 }));
    byPeriod[LATEST].push(row({ clientCode: "HALF", salesValue: 500 }));
    const result = buildPharmacyActions({ periods: periods(byPeriod) });
    assert.deepEqual(
      result.dropping.map((item) => item.name),
      ["Pharmacy HALF", "Pharmacy AT70"],
      "exactly 30% below is dropping, 29.9% is not; the biggest money gap is listed first",
    );
    assert.equal(Math.round((result.dropping[0].change ?? 0) * 100), -50);
    assert.equal(result.valueAtStake.dropping, 800);
  }

  // ── NEW ────────────────────────────────────────────────────────────────────
  {
    const result = buildPharmacyActions({
      periods: periods({
        [LATEST]: [row({ clientCode: "FRESH", salesValue: 250 }), row({ clientCode: "BACK", salesValue: 100 })],
        [P1]: [],
        [P2]: [],
        [P3]: [row({ clientCode: "BACK", salesValue: 100 })],
      }),
    });
    assert.deepEqual(result.newPharmacies.map((item) => item.name), ["Pharmacy FRESH"], "bought in the latest and none of the 3 before = new");
  }

  // With no earlier closing published, nothing can be stopped, dropping or new.
  {
    const result = buildPharmacyActions({ periods: periods({ [LATEST]: [row({ clientCode: "A", salesValue: 10 })] }) });
    assert.equal(result.newPharmacies.length, 0);
    assert.equal(result.historyComplete, false);
    assert.equal(result.top.length, 1, "the top list still works on a single closing");
  }

  // ── What is NOT a pharmacy ─────────────────────────────────────────────────
  {
    const mainStores = row({ clientCode: "", clientName: "Main Stores", distributorCode: "", salesValue: 400 });
    const qema = row({ clientCode: "W1", distributorCode: "QM", salesValue: 900 });
    const noCode = row({ clientCode: "", clientName: "Walk-in", salesValue: 30 });
    const shareA = row({ clientCode: "STORE", distributorCode: "UPA", salesValue: 200, areaCode: "CA1", sheetAreaCode: "CA1" });
    const shareB = row({ clientCode: "STORE", distributorCode: "UPA", salesValue: 200, areaCode: "CA2", sheetAreaCode: "CA2" });
    const fractional = row({ clientCode: "SOLO", distributorCode: "UPA", salesValue: 55, effectiveUnits: 3.25 });
    const registry = row({ clientCode: "EZ", distributorCode: "EZ", salesValue: 70, evenSplitApplied: true });
    const real = row({ clientCode: "REAL", salesValue: 1000 });
    const latest = [mainStores, qema, noCode, shareA, shareB, fractional, registry, real];
    const shared = findSharedCustomerKeys([{ period: LATEST, rows: latest }]);

    assert.equal(classifyRowKind(mainStores, shared), "mainStores");
    assert.equal(classifyRowKind(qema, shared), "mainStores", "El Qema's real rows (Super Admin) are the same warehouse money as Main Stores");
    assert.equal(classifyRowKind(noCode, shared), "noCode");
    assert.equal(classifyRowKind(shareA, shared), "wholesalerShare", "one customer in two closing areas in one month is a city-split share");
    assert.equal(classifyRowKind(fractional, shared), "wholesalerShare", "fractional units are what a split share looks like from one area");
    assert.equal(classifyRowKind(registry, shared), "wholesalerShare", "the even-split registry's customers are shared by the database");
    assert.equal(classifyRowKind(real, shared), "pharmacy");

    const result = buildPharmacyActions({ periods: periods({ [LATEST]: latest }) });
    assert.deepEqual(result.top.map((item) => item.name), ["Pharmacy REAL"], "only a real pharmacy reaches a list");
    assert.equal(result.latestTotals.total, 2855, "every row still counts toward the latest total");
    assert.equal(result.latestTotals.pharmacies, 1000);
    assert.equal(result.latestTotals.mainStores, 1300);
    assert.equal(result.latestTotals.wholesalerShares, 525);
    assert.equal(result.latestTotals.noCustomerCode, 30);
    assert.equal(
      result.latestTotals.pharmacies + result.latestTotals.mainStores + result.latestTotals.wholesalerShares + result.latestTotals.noCustomerCode,
      result.latestTotals.total,
      "the split ties back to the whole closing",
    );
    assert.equal(result.top[0].share, 1);
  }

  // A wholesaler shared in an EARLIER month is a wholesaler in every month, so its absence from the
  // latest is not a "stopped pharmacy".
  {
    const result = buildPharmacyActions({
      periods: periods({
        [LATEST]: [row({ clientCode: "KEEP", salesValue: 10 })],
        [P1]: [
          row({ clientCode: "STORE", distributorCode: "UPA", salesValue: 300, areaCode: "CA1", sheetAreaCode: "CA1" }),
          row({ clientCode: "STORE", distributorCode: "UPA", salesValue: 300, areaCode: "CA2", sheetAreaCode: "CA2" }),
          row({ clientCode: "KEEP", salesValue: 10 }),
        ],
      }),
    });
    assert.equal(result.stopped.length, 0, "a city-split wholesaler never lands on the stopped list");
  }

  // The same code at two distributors is two pharmacies.
  {
    const result = buildPharmacyActions({
      periods: periods({
        [LATEST]: [row({ clientCode: "100", distributorCode: "IBN", salesValue: 5 })],
        [P1]: [row({ clientCode: "100", distributorCode: "SOF", salesValue: 5 }), row({ clientCode: "100", distributorCode: "IBN", salesValue: 5 })],
      }),
    });
    assert.equal(result.stopped.length, 1, "a pharmacy is keyed by distributor AND customer code");
  }

  // ── Cross-sell gaps ────────────────────────────────────────────────────────
  {
    const latest: PharmacyActionRow[] = [];
    // Five pharmacies buy P1; four also buy P2 → both are core (≥40%). P3 has one buyer → not core.
    for (const code of ["A", "B", "C", "D", "E"]) latest.push(row({ clientCode: code, salesValue: 100, productCode: "P1", productName: "Alpha" }));
    for (const code of ["A", "B", "C", "D"]) latest.push(row({ clientCode: code, salesValue: 100, productCode: "P2", productName: "Beta" }));
    latest.push(row({ clientCode: "A", salesValue: 100, productCode: "P3", productName: "Gamma" }));
    const result = buildPharmacyActions({ periods: periods({ [LATEST]: latest }) });
    assert.deepEqual(result.coreProducts.map((product) => product.name), ["Alpha", "Beta"]);
    assert.deepEqual(result.crossSell.map((item) => item.name), ["Pharmacy E"], "E buys Alpha but never Beta");
    assert.deepEqual(result.crossSell[0].missingProducts.map((product) => product.name), ["Beta"]);
  }

  // A product bought earlier in the window is not a gap.
  {
    const latest: PharmacyActionRow[] = [];
    for (const code of ["A", "B", "C", "D", "E"]) {
      latest.push(row({ clientCode: code, salesValue: 100, productCode: "P1", productName: "Alpha" }));
      if (code !== "E") latest.push(row({ clientCode: code, salesValue: 100, productCode: "P2", productName: "Beta" }));
    }
    const result = buildPharmacyActions({
      periods: periods({ [LATEST]: latest, [P1]: [row({ clientCode: "E", salesValue: 50, productCode: "P2", productName: "Beta" })] }),
    });
    assert.equal(result.crossSell.length, 0, "E bought Beta last month, so it is not a gap");
  }

  // ── Untapped bricks ────────────────────────────────────────────────────────
  {
    const result = buildPharmacyActions({
      periods: periods({
        [LATEST]: [row({ clientCode: "A", salesValue: 100, brickId: "B1" })],
        [P2]: [row({ clientCode: "B", salesValue: 100, brickId: "B2" })],
        // A Main Stores share on brick B3 is not a pharmacy buying there.
        [P1]: [row({ clientCode: "", clientName: "Main Stores", distributorCode: "", salesValue: 100, brickId: "B3" })],
      }),
      brickUniverse: [
        { brickId: "B1", brickName: "One", areaCode: "CA1", areaName: "Cairo 1" },
        { brickId: "B2", brickName: "Two", areaCode: "CA1", areaName: "Cairo 1" },
        { brickId: "B3", brickName: "Three", areaCode: "CA1", areaName: "Cairo 1" },
        { brickId: "B4", brickName: "Four", areaCode: "CA1", areaName: "Cairo 1" },
      ],
    });
    assert.deepEqual(result.untappedBricks.map((brick) => brick.brickName), ["Four", "Three"], "no pharmacy bought in the brick across the whole window");
    assert.deepEqual(result.areas, [{ code: "CA1", name: "Cairo 1" }]);
  }

  // ── Value only: no unit total is ever produced ─────────────────────────────
  {
    const result = buildPharmacyActions({ periods: periods({ [LATEST]: [row({ clientCode: "A", salesValue: 100 })] }) });
    const serialized = JSON.stringify(result);
    assert.ok(!/units/i.test(serialized), "the action lists carry EGP only — units of different products are never added");
  }

  // ── Direct orders are pharmacies to chase, like any distributor customer ───
  {
    const direct = (overrides: Partial<PharmacyActionRow> & { clientCode: string; salesValue: number }) =>
      row({ distributorCode: "DirectReq", isDirect: true, ...overrides });
    const result = buildPharmacyActions({
      periods: periods({
        [LATEST]: [direct({ clientCode: "DOP-000053", salesValue: 3450, effectiveUnits: 2.5 }), direct({ clientCode: "DOP-000054", salesValue: 100 })],
        [P1]: [direct({ clientCode: "DOP-000077", salesValue: 800 }), direct({ clientCode: "DOP-000054", salesValue: 500 })],
      }),
    });
    assert.deepEqual(result.newPharmacies.map((item) => item.key), ["DIRECTREQ|DOP-000053"], "a direct-order pharmacy counts as new");
    assert.equal(result.newPharmacies[0].isDirect, true, "the item says it is a direct order");
    assert.deepEqual(result.stopped.map((item) => item.key), ["DIRECTREQ|DOP-000077"], "a direct-order pharmacy counts as stopped");
    assert.deepEqual(result.dropping.map((item) => item.key), ["DIRECTREQ|DOP-000054"], "a direct-order pharmacy counts as dropping");
    assert.equal(result.latestTotals.pharmacies, 3550, "a direct order is never mistaken for a wholesaler's split share");
    assert.equal(result.latestTotals.wholesalerShares, 0);
    assert.equal(buildPharmacyActions({ periods: periods({ [LATEST]: [row({ clientCode: "A", salesValue: 100 })] }) }).top[0].isDirect, false);
  }

  // ── Month pace (weekly, approximate — never an official number) ────────────
  {
    const pace = buildMonthPace({
      period: "2026-09",
      dayOfMonth: 15,
      daysInMonth: 30,
      targets: [
        { areaCode: "CA1", targetValue: 1000 },
        { areaCode: "ca2", targetValue: 600 },
        { areaCode: "CA2", targetValue: 400 },
      ],
      weekly: [
        { areaCode: "CA1", areaName: "Cairo 1", value: 600, allocatedValue: 300 },
        { areaCode: "CA2", areaName: "Cairo 2", value: 200, allocatedValue: 0 },
        { areaCode: "CA3", areaName: "Cairo 3", value: 50, allocatedValue: 0 },
      ],
    });
    assert.deepEqual(pace.rows.map((entry) => entry.areaName), ["Cairo 2", "Cairo 1", "Cairo 3"], "furthest behind first; no-target areas last");
    const cairo2 = pace.rows[0];
    assert.equal(cairo2.targetValue, 1000, "one area's product targets add up by VALUE");
    assert.equal(cairo2.expectedByToday, 500, "halfway through the month, half the target is expected");
    assert.equal(cairo2.onPace, false);
    assert.equal(pace.rows[1].onPace, true);
    assert.equal(pace.rows[2].targetValue, null, "weekly sales with no target are shown, never measured");
    assert.equal(pace.rows[2].progress, null);
    assert.equal(pace.totals.targetValue, 2000);
    assert.equal(pace.totals.weeklyValue, 850);
    assert.equal(pace.totals.expectedByToday, 1000);
    assert.equal(Math.round((pace.allocatedShare ?? 0) * 1000), 353, "the branch-name allocated part is reported");
    assert.ok(!/units/i.test(JSON.stringify(pace)), "the pace strip is value only");

    // DIRECT ORDERS (owner 2026-09-14: "make the directreq also counts in it"). Booked orders count in
    // progress beside the weekly value; an area selling only through direct orders is not "behind".
    const withDirect = buildMonthPace({
      period: "2026-09",
      dayOfMonth: 15,
      daysInMonth: 30,
      targets: [
        { areaCode: "CA1", targetValue: 1000 },
        { areaCode: "CA4", targetValue: 1000 },
      ],
      weekly: [{ areaCode: "CA1", areaName: "Cairo 1", value: 300, allocatedValue: 0 }],
      direct: [
        { areaCode: "CA1", value: 250 },
        { areaCode: "ca4", value: 400 },
        { areaCode: "CA4", value: 200 },
        { areaCode: "", value: 999 },
      ],
    });
    const ca1 = withDirect.rows.find((entry) => entry.areaCode === "CA1");
    const ca4 = withDirect.rows.find((entry) => entry.areaCode === "CA4");
    assert.equal(ca1?.directValue, 250);
    assert.equal(ca1?.soFarValue, 550, "weekly and direct orders add up by VALUE");
    assert.equal(ca1?.onPace, true, "direct orders lift an area over the expected-by-today line");
    assert.equal(ca4?.weeklyValue, 0);
    assert.equal(ca4?.soFarValue, 600, "an area with direct orders only is still measured");
    assert.equal(ca4?.progress, 0.6);
    assert.equal(withDirect.totals.directValue, 850, "a direct row with no area is never placed");
    assert.equal(withDirect.totals.soFarValue, 1150);
    assert.equal(withDirect.totals.progress, 0.575);
    assert.equal(withDirect.hasDirectOrders, true);

    const weeklyHoldsDirect = buildMonthPace({
      period: "2026-07",
      dayOfMonth: 15,
      daysInMonth: 31,
      targets: [{ areaCode: "CA1", targetValue: 1000 }],
      weekly: [{ areaCode: "CA1", value: 300, allocatedValue: 0 }],
      direct: [{ areaCode: "CA1", value: 250 }],
      directInWeekly: true,
    });
    assert.equal(weeklyHoldsDirect.totals.soFarValue, 300, "a weekly upload that already carries Direct never counts it twice");
    assert.equal(weeklyHoldsDirect.hasDirectOrders, false);

    const empty = buildMonthPace({ period: "2026-09", dayOfMonth: 2, daysInMonth: 30, targets: [], weekly: [] });
    assert.equal(empty.hasTargets, false);
    assert.equal(empty.hasWeeklyData, false);
    assert.equal(empty.totals.progress, null);
  }
}
