import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  cycleGroupIsCumulative,
  decumulateRows,
  depotWeekGapKey,
  depotWeekGapKeys,
  depotWeekGaps,
  directGroupLooksCumulative,
  moneySpansDepotGap,
  suppressGapSpannedValue,
  weekHasDecumulationGap,
  type DecumulableRow,
} from "../src/lib/sales/weekly/decumulate.ts";
import { weeklyDistributorIsCumulative } from "../src/lib/sales/weekly/distributors.ts";

// Build a cumulative row with sensible defaults.
function row(p: Partial<DecumulableRow> & { weekStart: string; weekNumber: number | null }): DecumulableRow {
  return {
    cycleMonth: "2026-05-01",
    distributorCode: "IS-S",
    productCode: "LA001",
    branchCode: "CAIRO",
    branchName: "Cairo",
    salesValue: 0,
    salesQty: 0,
    netQty: 0,
    stockQty: 0,
    ...p,
  };
}

const sumBy = (rows: DecumulableRow[], pick: (r: DecumulableRow) => number) =>
  Number(rows.reduce((a, r) => a + pick(r), 0).toFixed(2));

export function runWeeklyDecumulationTests() {
  // 1) Single cell across 4 cumulative weeks → real per-week diffs; first week = itself.
  {
    const cumulative = [
      row({ weekStart: "2026-05-02", weekNumber: 1, salesValue: 100, netQty: 10, stockQty: 50 }),
      row({ weekStart: "2026-05-09", weekNumber: 2, salesValue: 250, netQty: 26, stockQty: 40 }),
      row({ weekStart: "2026-05-16", weekNumber: 3, salesValue: 400, netQty: 41, stockQty: 55 }),
      row({ weekStart: "2026-05-23", weekNumber: 4, salesValue: 450, netQty: 45, stockQty: 30 }),
    ];
    const real = decumulateRows(cumulative);
    const byWeek = new Map(real.map((r) => [r.weekNumber, r]));
    assert.equal(byWeek.get(1)!.salesValue, 100, "W1 = itself");
    assert.equal(byWeek.get(2)!.salesValue, 150, "W2 = 250-100");
    assert.equal(byWeek.get(3)!.salesValue, 150, "W3 = 400-250");
    assert.equal(byWeek.get(4)!.salesValue, 50, "W4 = 450-400");
    assert.equal(byWeek.get(2)!.netQty, 16, "W2 net = 26-10");
    // Stock is a snapshot — NEVER subtracted.
    assert.equal(byWeek.get(2)!.stockQty, 40, "W2 stock = snapshot 40");
    assert.equal(byWeek.get(4)!.stockQty, 30, "W4 stock = snapshot 30");
    // Telescoping: sum of real weeks == last cumulative sheet.
    assert.equal(sumBy(real, (r) => r.salesValue), 450, "month total == last cumulative");
  }

  // 2) Two product×branch cells de-cumulate independently.
  {
    const cumulative = [
      row({ weekStart: "2026-05-02", weekNumber: 1, productCode: "A", branchCode: "X", salesValue: 100 }),
      row({ weekStart: "2026-05-02", weekNumber: 1, productCode: "B", branchCode: "Y", salesValue: 200 }),
      row({ weekStart: "2026-05-09", weekNumber: 2, productCode: "A", branchCode: "X", salesValue: 130 }),
      row({ weekStart: "2026-05-09", weekNumber: 2, productCode: "B", branchCode: "Y", salesValue: 260 }),
    ];
    const real = decumulateRows(cumulative);
    const find = (wk: number, prod: string) => real.find((r) => r.weekNumber === wk && r.productCode === prod)!;
    assert.equal(find(2, "A").salesValue, 30, "A W2 = 130-100");
    assert.equal(find(2, "B").salesValue, 60, "B W2 = 260-200");
  }

  // 3) A cell that first appears mid-cycle = full value (no prior to subtract).
  {
    const cumulative = [
      row({ weekStart: "2026-05-02", weekNumber: 1, productCode: "A", salesValue: 100 }),
      row({ weekStart: "2026-05-09", weekNumber: 2, productCode: "A", salesValue: 120 }),
      row({ weekStart: "2026-05-09", weekNumber: 2, productCode: "NEW", salesValue: 40 }),
    ];
    const real = decumulateRows(cumulative);
    assert.equal(real.find((r) => r.productCode === "NEW")!.salesValue, 40, "new mid-cycle cell = full");
  }

  // 4) Separate cycles (different months / distributors) never cross-subtract.
  {
    const cumulative = [
      row({ cycleMonth: "2026-05-01", weekStart: "2026-05-30", weekNumber: 4, salesValue: 500 }),
      row({ cycleMonth: "2026-06-01", weekStart: "2026-06-06", weekNumber: 1, salesValue: 80 }),
    ];
    const real = decumulateRows(cumulative);
    const june = real.find((r) => r.cycleMonth === "2026-06-01")!;
    assert.equal(june.salesValue, 80, "June W1 is itself, not 80-500");
  }

  // 5) Untagged rows (no cycle/week) pass through unchanged.
  {
    const untagged = [row({ weekStart: "2026-05-02", cycleMonth: "", weekNumber: null, salesValue: 999, stockQty: 7 })];
    const real = decumulateRows(untagged);
    assert.equal(real.length, 1);
    assert.equal(real[0].salesValue, 999, "untagged passes through");
  }

  // 6) Boundary mis-tag surfaces as a NEGATIVE week (not silently hidden).
  {
    const cumulative = [
      row({ weekStart: "2026-05-01", weekNumber: 1, salesValue: 500 }), // really prior-month close
      row({ weekStart: "2026-05-08", weekNumber: 2, salesValue: 100 }), // new cycle, lower → negative diff
    ];
    const real = decumulateRows(cumulative);
    const w2 = real.find((r) => r.weekNumber === 2)!;
    assert.ok(w2.salesValue < 0, "boundary mis-tag yields a visible negative week");
  }

  // 7) A NON-cumulative distributor (Direct) is never subtracted — its sheet already holds only that
  //    week's own orders. These are the real 2026-05 prod figures: under the old blanket de-cumulation
  //    W3 came out at 592,161.50 - 657,360.00 = -65,198.50, a negative week that cannot exist.
  {
    const direct = [
      row({ distributorCode: "Direct", weekStart: "2026-05-09", weekNumber: 2, salesValue: 657360, netQty: 700, stockQty: 0 }),
      row({ distributorCode: "Direct", weekStart: "2026-05-16", weekNumber: 3, salesValue: 592161.5, netQty: 640, stockQty: 0 }),
    ];
    const real = decumulateRows(direct);
    const byWeek = new Map(real.map((r) => [r.weekNumber, r]));
    assert.equal(real.length, 2, "Direct rows all survive");
    assert.equal(byWeek.get(2)!.salesValue, 657360, "Direct W2 passes through untouched");
    assert.equal(byWeek.get(3)!.salesValue, 592161.5, "Direct W3 is its own week, NOT 592161.5-657360");
    assert.ok(byWeek.get(3)!.salesValue > 0, "a non-cumulative week can never go negative by subtraction");
    assert.equal(byWeek.get(3)!.netQty, 640, "Direct units are not subtracted either");
    // The month is the SUM of Direct's weeks, not its last sheet (the opposite of a cumulative feed).
    assert.equal(sumBy(real, (r) => r.salesValue), 1249521.5, "Direct month = sum of its weeks");
  }

  // 8) The exemption is per-distributor, not a global switch: identical numbers under a cumulative
  //    code still subtract. Guards against "fixing" Direct by disabling de-cumulation for everyone.
  {
    const cumulative = [
      row({ distributorCode: "IS", weekStart: "2026-05-09", weekNumber: 2, salesValue: 657360 }),
      row({ distributorCode: "IS", weekStart: "2026-05-16", weekNumber: 3, salesValue: 592161.5 }),
    ];
    const real = decumulateRows(cumulative);
    const w3 = real.find((r) => r.weekNumber === 3)!;
    assert.equal(w3.salesValue, -65198.5, "a cumulative distributor still subtracts (and still shows the negative)");
  }

  // 8b) A Direct cycle uploaded CUMULATIVELY (June 2026 on prod) is detected and de-cumulated, even
  //     though the registry flags Direct non-cumulative. Under the old fixed flag its four sheets were
  //     summed, counting the month ~2.2x; now the month telescopes to the last sheet. The detector reads
  //     the two signatures of a running total — cells never vanish and values never fall.
  {
    const cumulativeDirect = [
      row({ distributorCode: "Direct", weekStart: "2026-06-06", weekNumber: 1, productCode: "LA001", branchCode: "X", salesValue: 100, netQty: 10 }),
      row({ distributorCode: "Direct", weekStart: "2026-06-13", weekNumber: 2, productCode: "LA001", branchCode: "X", salesValue: 250, netQty: 26 }),
      row({ distributorCode: "Direct", weekStart: "2026-06-20", weekNumber: 3, productCode: "LA001", branchCode: "X", salesValue: 400, netQty: 41 }),
      row({ distributorCode: "Direct", weekStart: "2026-06-27", weekNumber: 4, productCode: "LA001", branchCode: "X", salesValue: 450, netQty: 45 }),
    ];
    assert.equal(directGroupLooksCumulative(cumulativeDirect), true, "monotonic Direct sheets are detected cumulative");
    const real = decumulateRows(cumulativeDirect);
    assert.equal(sumBy(real, (r) => r.salesValue), 450, "cumulative Direct month = last sheet, NOT the ~2.2x sum of all four");
    const byWeek = new Map(real.map((r) => [r.weekNumber, r]));
    assert.equal(byWeek.get(2)!.salesValue, 150, "W2 = 250-100 once detected cumulative");
    assert.equal(byWeek.get(4)!.netQty, 4, "units de-cumulate too: W4 = 45-41");
  }

  // 8c) A genuinely per-week Direct cycle (cells vanish / values fall / a returns-only negative week —
  //     May & July 2026 on prod) is NOT detected cumulative, so it still passes straight through summed.
  {
    const perWeekDirect = [
      row({ distributorCode: "Direct", weekStart: "2026-05-09", weekNumber: 2, productCode: "LA001", branchCode: "AB", salesValue: 128700, netQty: 200 }),
      row({ distributorCode: "Direct", weekStart: "2026-05-16", weekNumber: 3, productCode: "LA001", branchCode: "AB", salesValue: 45045, netQty: 70 }),
      row({ distributorCode: "Direct", weekStart: "2026-05-16", weekNumber: 3, productCode: "SS001", branchCode: "OT", salesValue: -28462, netQty: -30 }),
    ];
    assert.equal(directGroupLooksCumulative(perWeekDirect), false, "vanishing cells and a falling value read as per-week");
    const real = decumulateRows(perWeekDirect);
    assert.equal(sumBy(real, (r) => r.salesValue), 128700 + 45045 - 28462, "per-week Direct month = sum of its own weeks, untouched");
  }

  // 8d) Detection can only ADD de-cumulation to a non-cumulative-flagged distributor — it never turns it
  //     OFF for a cumulative one. Even per-week-shaped numbers under IS still de-cumulate (guards #8).
  {
    // Net falls week to week (700 → 640) — the detector keys on netQty, so this reads as per-week.
    const isPerWeekShaped = [
      row({ distributorCode: "IS", weekStart: "2026-05-09", weekNumber: 2, salesValue: 657360, netQty: 700 }),
      row({ distributorCode: "IS", weekStart: "2026-05-16", weekNumber: 3, salesValue: 592161.5, netQty: 640 }),
    ];
    assert.equal(cycleGroupIsCumulative("IS", isPerWeekShaped), true, "a cumulative-flagged distributor is always de-cumulated");
    assert.equal(cycleGroupIsCumulative("Direct", isPerWeekShaped), false, "the same shape under Direct is detected per-week");
    // Fewer than two weeks carries no evidence — the registry flag decides.
    assert.equal(directGroupLooksCumulative([isPerWeekShaped[0]]), false, "a single week is never called cumulative on its own");
  }

  // 9) The registry flag itself: default true, explicit opt-out for Direct only, code-case agnostic,
  //    and an UNKNOWN code must default to cumulative (the pre-existing behaviour).
  assert.equal(weeklyDistributorIsCumulative("Direct"), false, "Direct is non-cumulative");
  assert.equal(weeklyDistributorIsCumulative("direct"), false, "the flag is case-insensitive");
  assert.equal(weeklyDistributorIsCumulative("IS"), true, "Ibn Sina is cumulative");
  assert.equal(weeklyDistributorIsCumulative("PS"), true, "Overseas is cumulative");
  assert.equal(weeklyDistributorIsCumulative("NOPE"), true, "an unknown code defaults to cumulative");
  assert.equal(weeklyDistributorIsCumulative(null), true, "a null code defaults to cumulative");

  // ── M6: decumulation-gap detection ──
  // The first present week of a cycle never spans a gap (nothing before it).
  assert.equal(weekHasDecumulationGap(null, 1), false, "first present week is not a gap");
  // Adjacent weeks (W2 after W1) are contiguous — no gap.
  assert.equal(weekHasDecumulationGap(1, 2), false, "W2 immediately after W1 is contiguous");
  assert.equal(weekHasDecumulationGap(3, 4), false, "W4 immediately after W3 is contiguous");
  // The core case: weeks [1, 3, 4] uploaded (W2 missing). W3's previous PRESENT week is W1, so W3's
  // de-cumulated figure spans the missing W2 — flag it.
  assert.equal(weekHasDecumulationGap(1, 3), true, "W3 after a missing W2 spans the gap");
  // A two-week gap (only W1 then W4) also flags.
  assert.equal(weekHasDecumulationGap(1, 4), true, "W4 after missing W2+W3 spans the gap");

  // ── M6 per depot: a week spans a gap when THAT depot sent no sheet for the week before ──
  // The flag above is pooled: it asks whether ANY depot uploaded the week before. On a region's Field
  // Force tab that hid a real gap. In August 2026 Ibn Sina-Sato and Overseas sent no week 2 while POS sent
  // one, so every week looked uploaded, and week 3, which held two weeks of those two depots' sales,
  // carried no warning.
  {
    const sheet = (distributorCode: string, weekNumber: number, extra: Partial<DecumulableRow> = {}) =>
      row({ cycleMonth: "2026-08-01", distributorCode, weekNumber, weekStart: `2026-08-0${weekNumber}`, ...extra });
    const rows = [
      // Ibn Sina-Sato and Overseas skipped week 2; POS sent it.
      sheet("IS-S", 1), sheet("IS-S", 3), sheet("IS-S", 4),
      sheet("PS", 1), sheet("PS", 3), sheet("PS", 3, { productCode: "LA002" }),
      sheet("POS", 1), sheet("POS", 2), sheet("POS", 3),
      // A code in another casing is the same depot, as decumulateRows groups it: POS then skipped week 4.
      sheet(" pos ", 5),
      // EGD's first sheet of the month is week 3. A month-to-date sheet then holds weeks 1 to 3.
      sheet("EG", 3), sheet("EG", 4),
      // Direct is invoice-keyed and never de-cumulated, so a missing Direct week is only a missing week.
      sheet("Direct", 1), sheet("Direct", 3),
      // Untagged rows and a row with no week date are never de-cumulated as weeks.
      row({ cycleMonth: "", weekNumber: 3, weekStart: "2026-08-03", distributorCode: "RM" }),
      row({ cycleMonth: "2026-08-01", weekNumber: null, weekStart: "2026-08-03", distributorCode: "RM" }),
      row({ cycleMonth: "2026-08-01", weekNumber: 4, weekStart: "", distributorCode: "RM" }),
      // Another month is its own calendar, whatever order the rows arrive in.
      row({ cycleMonth: "2026-07-01", weekNumber: 2, weekStart: "2026-07-08", distributorCode: "IS-S" }),
      row({ cycleMonth: "2026-07-01", weekNumber: 1, weekStart: "2026-07-01", distributorCode: "IS-S" }),
    ];
    const august = [1, 2, 3, 4, 5];
    assert.deepEqual(
      august.filter((week, i) => weekHasDecumulationGap(i > 0 ? august[i - 1] : null, week)),
      [],
      "fixture: pooled over every depot, no August week follows a missing one",
    );
    assert.deepEqual(
      depotWeekGaps(rows),
      [
        { distributorCode: "EG", cycleMonth: "2026-08-01", weekNumber: 3 },
        { distributorCode: "IS-S", cycleMonth: "2026-08-01", weekNumber: 3 },
        { distributorCode: "POS", cycleMonth: "2026-08-01", weekNumber: 5 },
        { distributorCode: "PS", cycleMonth: "2026-08-01", weekNumber: 3 },
      ],
      "each depot is judged on its own calendar: a skipped week flags that depot's next sheet, and so does a first sheet after week 1; Direct, untagged rows and undated rows never flag",
    );

    // The flag names exactly the figure de-cumulation could not isolate.
    const real = decumulateRows([
      sheet("IS-S", 1, { salesValue: 100 }),
      sheet("IS-S", 3, { salesValue: 300 }),
      sheet("POS", 1, { salesValue: 10 }),
      sheet("POS", 2, { salesValue: 20 }),
      sheet("POS", 3, { salesValue: 30 }),
    ]);
    const week3 = (code: string) => real.find((r) => r.distributorCode === code && r.weekNumber === 3)?.salesValue;
    assert.equal(week3("IS-S"), 200, "Ibn Sina-Sato's week 3 is its week-3 sheet minus its week-1 sheet: weeks 2 and 3 together");
    assert.equal(week3("POS"), 10, "POS's week 3 is one week, whatever Ibn Sina-Sato skipped");

    assert.equal(
      depotWeekGapKey(" is-s ", "2026-08-01", 3),
      depotWeekGapKey("IS-S", "2026-08-01", 3),
      "a depot's week is looked up case-blind and space-blind",
    );
    assert.notEqual(depotWeekGapKey("IS-S", "2026-08-01", 3), depotWeekGapKey("IS-S", "2026-09-01", 3), "another month is another key");
    assert.notEqual(depotWeekGapKey("IS-S", "2026-08-01", 3), depotWeekGapKey("PS", "2026-08-01", 3), "another depot is another key");

    // The one rule every screen marks a week by: money from a depot week that spans a gap.
    const keys = depotWeekGapKeys(depotWeekGaps(rows));
    const august3 = (distributorCode: string) => ({ distributorCode, cycleMonth: "2026-08-01", weekNumber: 3 });
    assert.equal(moneySpansDepotGap(august3("is-s"), { value: 500, units: 5 }, keys), true, "Ibn Sina-Sato's week-3 sales read high");
    assert.equal(moneySpansDepotGap(august3("IS-S"), { value: -40, units: 0 }, keys), true, "and so does a return: it is money");
    assert.equal(moneySpansDepotGap(august3("IS-S"), { value: 0, units: 3 }, keys), true, "and units sold at no recorded value");
    assert.equal(moneySpansDepotGap(august3("IS-S"), { value: 0, units: 0 }, keys), false, "a stock-only row moves no money, so it never marks its week");
    assert.equal(moneySpansDepotGap(august3("POS"), { value: 500, units: 5 }, keys), false, "POS sent week 2, so its week 3 is one week");
    assert.equal(
      moneySpansDepotGap({ ...august3("IS-S"), weekNumber: null }, { value: 500, units: 5 }, keys),
      false,
      "an untagged row is no week at all",
    );
  }

  // ── M6 remediation: suppress the inflated single-week figure for a gap-spanning week ──
  // Non-gap weeks keep their real value; gap weeks are nulled (suppressed), never shown as a true
  // single-week number. Works for any value type, including an already-null delta.
  assert.equal(suppressGapSpannedValue(false, 150), 150, "non-gap week keeps its value");
  assert.equal(suppressGapSpannedValue(false, 0), 0, "a real zero is kept (not confused with suppression)");
  assert.equal(suppressGapSpannedValue(true, 150), null, "gap week value is suppressed to null");
  assert.equal(suppressGapSpannedValue(true, -25), null, "gap week negative value is also suppressed");
  assert.equal(suppressGapSpannedValue(true, null), null, "already-null delta stays null under suppression");
  assert.equal(suppressGapSpannedValue(false, null), null, "a null delta on a non-gap week passes through unchanged");

  // The dashboard computes spansGap via the shared helper, then suppresses value/units/WoW at the
  // source so no downstream consumer (table, cross-month chart, exports) can render the inflated
  // number as a true single-week value.
  const serviceSource = readFileSync("src/lib/sales/weekly/service.ts", "utf8");

  // The upload preview de-cumulates on a SECOND path (computeThisWeekOnly subtracts the prior batch's
  // stored header), so the non-cumulative exemption has to be honoured there too — otherwise Direct's
  // "this week only" stays negative on the validation screen even though the dashboard is correct.
  assert.match(serviceSource, /if \(!weeklyDistributorIsCumulative\(distributorCode\)\) \{/, "computeThisWeekOnly exempts non-cumulative distributors");
  assert.match(serviceSource, /const spansGap = weekHasDecumulationGap\(prev\?\.weekNumber \?\? null, w\.weekNumber\)/, "weekComparison computes spansGap via the shared helper");
  assert.match(serviceSource, /salesValue: suppressGapSpannedValue\(spansGap, /, "weekComparison suppresses salesValue on a gap week");
  assert.match(serviceSource, /salesUnits: suppressGapSpannedValue\(spansGap, /, "weekComparison suppresses salesUnits on a gap week");
  assert.match(serviceSource, /deltaValuePct: suppressGapSpannedValue\(spansGap, /, "weekComparison suppresses the WoW delta on a gap week");

  // The Overview marks a week one depot skipped the week before, and keeps its figure (owner, 2026-09-17).
  assert.match(
    serviceSource,
    /const realRows = decumulateRows\(allRows\);\s*(?:\/\/[^\n]*\n\s*)*const depotGaps = depotWeekGaps\(allRows\);/,
    "depot calendars are read over the rows de-cumulation subtracted from, before any scope or filter",
  );
  assert.match(
    serviceSource,
    /for \(const row of scopedRows\) \{[\s\S]{0,900}if \(moneySpansDepotGap\(row, \{ value: row\.salesValue, units: row\.netQty \}, depotGapKeys\)\) cur\.depotSpansGap = true;/,
    "a week is marked where the viewer's own week-comparison money came from a depot week that spans a gap",
  );
  assert.match(serviceSource, /\n\s*depotSpansGap: w\.depotSpansGap,\n/, "and the mark is returned, with no suppression of its own");
  assert.doesNotMatch(serviceSource, /suppressGapSpannedValue\([^)]*depotSpansGap/, "a depot mark never blanks a figure");

  const adminOverview = readFileSync("src/components/sales/weekly/weekly-dashboard-view-impl.tsx", "utf8");
  assert.match(adminOverview, /\{row\.depotSpansGap && !row\.spansGap \? \(/, "the admin week table marks a depot gap beside a real figure");
  const portalOverview = readFileSync("src/components/sales/weekly/portal-weekly-dashboard-impl.tsx", "utf8");
  assert.match(
    portalOverview,
    /<WeekCrossMonthChart weekComparison=\{data\.weekComparison\} \/>\s*<\/div>\s*<WeekGapNote weekComparison=\{data\.weekComparison\} \/>/,
    "the portal week chart is followed by the note naming the weeks that read high or are left at zero",
  );
  assert.match(portalOverview, /const high = shown\.filter\(\(r\) => r\.depotSpansGap && !r\.spansGap\)/, "the note reads the depot mark");

  // ── M7: logical-week (cycle_month + week_number + template) duplicate guard ──
  // persistWeeklyUpload adds a second SELECT pre-check on the logical week slot and maps the unique
  // index's 23505 to a friendly 409 (the week_start-only guard missed a re-upload of the same cycle
  // week carrying a different week_start).
  assert.match(serviceSource, /\.eq\("cycle_month", result\.cycleMonth\)\s*\.eq\("week_number", result\.weekNumber\)\s*\.eq\("template_key", result\.templateKey\)/, "persist pre-checks the logical-week slot");
  assert.match(serviceSource, /if \(isPostgresUniqueViolation\(batchInsert\.error\)\) \{[\s\S]*?"duplicate_week"/, "batch-insert unique violation maps to a duplicate_week 409");
  const m7Migration = readFileSync("supabase/migrations/20260712020000_weekly_sales_batches_cycle_week_unique.sql", "utf8");
  assert.match(m7Migration, /create unique index if not exists weekly_sales_batches_validated_cycle_week_tmpl_uidx/, "the logical-week unique index migration exists");
  assert.match(m7Migration, /\(distributor_code, cycle_month, week_number, template_key\)/, "the index keys on the full logical-week slot including template_key");
}
