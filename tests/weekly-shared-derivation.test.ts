import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { narrowStockRowsToGovernorate, resolveBranchGovernorates } from "../src/lib/sales/weekly/branch-governorate-scope.ts";
import { shareDerivedWeeklyRows, weeklyPriceFingerprint } from "../src/lib/sales/weekly/derived-rows.ts";
import { _resetWeeklyRowCache, bumpWeeklyRowsGeneration, getOrLoadWeeklyRows } from "../src/lib/sales/weekly/row-cache.ts";
import { yieldToEventLoop } from "../src/lib/platform/yield-to-event-loop.ts";

/**
 * Nine reps opening Weekly Stock together cannot freeze the server.
 *
 * 🔴 THE INCIDENT (12 Nov 2026, 14:33 Cairo, read from production's logs on 14 Nov): nine Medical Reps
 * opened Weekly Stock within six seconds. The weekly rows were already cached, so each rep's build
 * re-priced, de-cumulated and gap-checked the same 66,526 rows with no real wait in between, and the
 * nine ran end to end: the server froze for 3.1 s and every page in flight finished in the same
 * millisecond, after 3 to 10.6 s. Measured on the laptop with nine real reps: the longest freeze went
 * from 1,479 ms to 204–327 ms, and all 24 Weekly Stock and Weekly Sales results compared byte for byte.
 *
 * Pinned here: the viewer-independent work runs ONCE per cached load and price list (derived-rows.ts),
 * every caller still gets its own copies, a price edit or a new load re-derives, the governorate
 * narrowing reads each depot once with the same answer, and the loader is wired through all of it.
 */

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

type Row = { id: number; salesValue: number };

export async function runWeeklySharedDerivationTests() {
  // ---- 1. the rows cache names its load: one source per cache entry, a new one after a write ----
  {
    _resetWeeklyRowCache();
    const load = async () => ({ rows: [{ id: 1, salesValue: 10 }], pages: 1 });
    const miss = await getOrLoadWeeklyRows<Row>("k", load);
    const hit = await getOrLoadWeeklyRows<Row>("k", load);
    assert.equal(miss.cache, "miss");
    assert.equal(hit.cache, "hit");
    assert.equal(miss.source, hit.source, "the read that stored the entry and a later hit share one source");
    assert.notEqual(hit.rows, hit.source, "the source is never the copy a caller gets");
    bumpWeeklyRowsGeneration("test");
    const afterWrite = await getOrLoadWeeklyRows<Row>("k", load);
    assert.notEqual(afterWrite.source, hit.source, "a weekly write gives the rows a new source, so nothing derived before it is reused");
    _resetWeeklyRowCache();
  }

  // ---- 2. nine callers on one load and one price list → ONE derivation, nine separate copies ----
  {
    const source = {};
    let derivations = 0;
    const gate = deferred<void>();
    const derive = async () => {
      derivations += 1;
      await gate.promise;
      return { realRows: [{ id: 1, salesValue: 10 }], depotGaps: [{ distributorCode: "EGD", cycleMonth: "2026-10", weekNumber: 2 }] };
    };
    const callers = Array.from({ length: 9 }, () => shareDerivedWeeklyRows<Row>(source, "prices-a", derive));
    gate.resolve();
    const results = await Promise.all(callers);
    assert.equal(derivations, 1, "the rows were re-priced and de-cumulated once, not nine times — the 12 Nov freeze");
    results[0].realRows[0].salesValue = 999;
    results[0].depotGaps[0].weekNumber = 99;
    assert.equal(results[1].realRows[0].salesValue, 10, "one caller writing to its row never reaches another's");
    assert.equal(results[1].depotGaps[0].weekNumber, 2, "nor to its gaps");
    assert.equal(results.filter((result) => result.shared).length, 8, "eight waited for the first one's work");

    const later = await shareDerivedWeeklyRows<Row>(source, "prices-a", derive);
    assert.equal(derivations, 1, "a later viewer of the same load and prices reuses it");
    assert.equal(later.realRows[0].salesValue, 10, "and reads the derived value, untouched by the caller that wrote to its copy");

    await shareDerivedWeeklyRows<Row>(source, "prices-b", derive);
    assert.equal(derivations, 2, "a price edit re-derives at once");
    await shareDerivedWeeklyRows<Row>({}, "prices-b", derive);
    assert.equal(derivations, 3, "a new load re-derives");
  }

  // ---- 3. a failed derivation fails its callers and is tried again by the next one ----
  {
    const source = {};
    await assert.rejects(shareDerivedWeeklyRows<Row>(source, "p", async () => { throw new Error("boom"); }), /boom/);
    const retried = await shareDerivedWeeklyRows<Row>(source, "p", async () => ({ realRows: [{ id: 2, salesValue: 5 }], depotGaps: [] }));
    assert.equal(retried.realRows[0].id, 2, "a failure is never served to the next viewer");
  }

  // ---- 4. the price fingerprint: exactly what re-pricing reads ----
  {
    const products = [{ productCode: "SAG", factoryPrice: 111.15 }, { productCode: "ROY", factoryPrice: 50 }];
    const overrides = [{ productCode: "SAG", effectivePeriod: "2026-10", factoryPrice: 170.52 }];
    const base = weeklyPriceFingerprint(products, overrides);
    assert.equal(weeklyPriceFingerprint([...products].reverse(), overrides), base, "the order the master is read in does not matter");
    assert.notEqual(weeklyPriceFingerprint([{ ...products[0], factoryPrice: 112 }, products[1]], overrides), base, "a factory price edit changes it");
    assert.notEqual(weeklyPriceFingerprint(products, [{ ...overrides[0], factoryPrice: 171 }]), base, "a dated price edit changes it");
    assert.notEqual(weeklyPriceFingerprint(products, []), base, "a removed dated price changes it");
    assert.equal(weeklyPriceFingerprint(null, null), "no-master", "an unreadable master is its own price list");
  }

  // ---- 5. the governorate narrowing reads each depot once, with the same answer as reading every row ----
  {
    const depots = [
      { branchName: "الدقهلية2 ودمياط", areaCode: null },
      { branchName: "كبار عملاء القاهرة", areaCode: null },
      { branchName: "Alex Main", areaCode: null },
      { branchName: "اسيوط", areaCode: null },
      { branchName: "منطقة القناة_ك", areaCode: null },
      { branchName: "Same Name", areaCode: "D15" },
      { branchName: "Same Name", areaCode: "UE3" },
      { branchName: null, areaCode: null },
    ];
    const rows = Array.from({ length: 400 }, (_, i) => ({ ...depots[i % depots.length], i }));
    const first = resolveBranchGovernorates(depots[0]);
    const govs: string[] = first instanceof Set ? [...first] : [];
    assert.ok(govs.length > 0, "the first depot names a governorate, so the first viewer is a real one");
    const viewers: Set<string>[] = [new Set(govs), new Set(["giza"]), new Set(["alexandria"])];
    for (const viewer of viewers) {
      const expected = rows.filter((row) => {
        const scope = resolveBranchGovernorates(row);
        if (scope === "ALL" || scope === "FLOOR") return true;
        for (const gov of scope) if (viewer.has(gov)) return true;
        return false;
      });
      assert.deepEqual(narrowStockRowsToGovernorate(rows, viewer), expected, "the same depots, in the same order, as one read per row");
    }
  }

  // ---- 6. the pause really lets queued work run first ----
  {
    let ran = false;
    setImmediate(() => {
      ran = true;
    });
    await yieldToEventLoop();
    assert.equal(ran, true, "work queued before the pause runs during it");
  }

  // ---- 7. the wiring: the loader derives through the shared work and builds the trend in one pass ----
  {
    const service = readFileSync(path.join(process.cwd(), "src/lib/sales/weekly/service.ts"), "utf8");
    assert.match(service, /const derived = await shareDerivedWeeklyRows<FactRow>\(rawRows\.source, priceFingerprint,/, "re-pricing and de-cumulation run through the shared derivation");
    assert.equal((service.match(/decumulateRows\(allRows\)/g) ?? []).length, 1, "de-cumulation happens in exactly one place");
    assert.doesNotMatch(service, /scopedRows\.filter\(\(row\) => row\.weekStart === week\)/, "the trend never re-filters every row once per week");
    const stock = readFileSync(path.join(process.cwd(), "src/lib/sales/weekly/stock-dashboard-service.ts"), "utf8");
    assert.ok((stock.match(/await yieldToEventLoop\(\);/g) ?? []).length >= 3, "the Weekly Stock build pauses between its row passes");
  }
}
