import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import JSZip from "jszip";

import {
  ConsolidatedClosingSelectionError,
  canExportConsolidatedClosing,
  consolidateEngineFill,
  consolidatedFilePeriod,
  consolidatedSpanLabel,
  describeConsolidatedMonths,
  relabelConsolidatedWorkbook,
  resolveConsolidatedPeriods,
} from "../src/lib/sales/closing-consolidated.ts";
import { closingFileName } from "../src/lib/sales/closing-export-filename.ts";
import { foldStoreSplitByArea } from "../src/lib/sales/closing-store-split-months.ts";
import { summariseStoreSplitByArea, type StoreSplitRow } from "../src/lib/sales/store-sales-city-split.ts";

/**
 * 🔒 THE CONSOLIDATED CLOSING — several months of one line added together, in the closing's own
 * workbook and in the premium one. Owner, 2026-09-14: Super Admin and the CEO only; the whole
 * workbook, summed; any month on screen; and the store split worked out PER MONTH, then added.
 */

// An El Qema warehouse sale in Qalubeya, as tests/qema-warehouse-split.test.ts sets one up.
const QEMA_SALE: StoreSplitRow = {
  areaCode: "D11",
  clientCode: "QM-9001",
  clientName: "مخزن القليوبية للأدوية",
  distributorCode: "QM",
  includedInClosing: true,
  isDirect: false,
  officialLine: "Pedia",
  productCode: "LA001",
  qty: 150,
  salesValue: 40_500,
};

export async function runClosingConsolidatedExportTests() {
  // ── 🔴 SPLIT EACH MONTH, THEN ADD ─────────────────────────────────────────────────────────────
  //
  // The assertion that pays for the whole fold. 150 packs in August and 150 in September are each
  // at or under El Qema's 200-pack band, so each month's closing kept its sale inside the
  // governorate. Pooling the two months would read 300, cross the band and spread half over the
  // rest of the country — moving money that neither month's closing moved.
  const august = [{ ...QEMA_SALE }];
  const september = [{ ...QEMA_SALE, clientCode: "QM-9001" }];
  const folded = foldStoreSplitByArea([
    { period: "2026-08", rows: august },
    { period: "2026-09", rows: september },
  ]);
  const pooled = summariseStoreSplitByArea([...august, ...september], "2026-09");
  const perMonth = [
    ...summariseStoreSplitByArea(august, "2026-08"),
    ...summariseStoreSplitByArea(september, "2026-09"),
  ];

  assert.ok(folded.length > 0, "the Qalubeya sale was split in each month, so the sheet has rows");
  assert.equal(
    folded.some((entry) => entry.areaCode === "AB1"),
    false,
    "Alexandria received nothing in either month, so the consolidated sheet must not credit it",
  );
  assert.ok(
    pooled.some((entry) => entry.areaCode === "AB1"),
    "the pooled 300 packs WOULD have reached Alexandria — which is exactly the error the fold avoids",
  );
  for (const entry of folded) {
    const months = perMonth.filter((month) => month.areaCode === entry.areaCode && month.line === entry.line);
    const sum = (field: "movedOutValue" | "receivedValue" | "netValue") =>
      Number(months.reduce((total, month) => total + month[field], 0).toFixed(2));
    assert.equal(entry.receivedValue, sum("receivedValue"), `${entry.areaCode} receives the two months' shares added`);
    assert.equal(entry.movedOutValue, sum("movedOutValue"), `${entry.areaCode} sends out the two months added`);
    assert.equal(entry.netValue, sum("netValue"), `${entry.areaCode}'s net is the two months' nets added`);
  }
  const qalubeya = folded.find((entry) => entry.areaCode === "D11");
  assert.ok(qalubeya, "Qalubeya appears");
  assert.equal(qalubeya.movedOutValue, 81_000, "both months of Qalubeya's own warehouse sale went out to its block");
  assert.equal(
    Number((qalubeya.beforeValue + qalubeya.netValue).toFixed(2)),
    qalubeya.afterValue,
    "before + net = after still holds across the span",
  );

  // A month the split was not applied to is left out once any month was split: its movement is
  // hypothetical and the Closing Matrix beside the sheet does not carry it. JUNE, not July — the
  // gate moved to 2026-07 on the owner's "FIX JULY" ruling (2026-10-02), so July is an APPLIED
  // month now and June is the newest unapplied one. The invariant is unchanged; only the month that
  // demonstrates it.
  const withJune = foldStoreSplitByArea([
    { period: "2026-06", rows: [{ ...QEMA_SALE, qty: 900, salesValue: 243_000 }] },
    { period: "2026-08", rows: august },
  ]);
  assert.equal(
    withJune.find((entry) => entry.areaCode === "D11")?.movedOutValue,
    40_500,
    "June's unapplied split does not ride into a span that includes August",
  );
  // And the other side of the ruling: July DOES ride in now, because it is an applied month.
  const withJuly = foldStoreSplitByArea([
    { period: "2026-07", rows: [{ ...QEMA_SALE, qty: 900, salesValue: 243_000 }] },
    { period: "2026-08", rows: august },
  ]);
  assert.equal(
    withJuly.find((entry) => entry.areaCode === "D11")?.movedOutValue,
    283_500,
    "July's split is applied since 'FIX JULY', so its 243,000 is added to August's 40,500",
  );

  // ── Who, and how many months ─────────────────────────────────────────────────────────────────
  assert.equal(canExportConsolidatedClosing("Super Admin"), true);
  assert.equal(canExportConsolidatedClosing("CEO"), true);
  for (const role of ["SFE Manager", "National Sales Manager", "Medical Rep", "Employee", "", null, undefined]) {
    assert.equal(canExportConsolidatedClosing(role), false, `${String(role)} is not offered a consolidated closing`);
  }
  assert.deepEqual(resolveConsolidatedPeriods(["2026-09", "2026-07", "2026-08", "2026-08"]), ["2026-07", "2026-08", "2026-09"]);
  assert.throws(() => resolveConsolidatedPeriods(["2026-08"]), ConsolidatedClosingSelectionError, "one month is the ordinary closing");
  assert.throws(() => resolveConsolidatedPeriods([]), ConsolidatedClosingSelectionError);
  assert.throws(() => resolveConsolidatedPeriods("nonsense"), ConsolidatedClosingSelectionError);

  // ── The span, named — never the latest month standing for all of them ────────────────────────
  assert.equal(consolidatedSpanLabel(["2026-07", "2026-08", "2026-09"]), "Jul–Sep 2026");
  assert.equal(consolidatedSpanLabel(["2025-11", "2025-12", "2026-01", "2026-02"]), "Nov 2025–Feb 2026");
  assert.equal(consolidatedSpanLabel(["2026-07", "2026-09"]), "Jul, Sep 2026", "a gap is listed, never drawn as a range over August");
  for (const label of [consolidatedSpanLabel(["2026-07", "2026-09"]), consolidatedSpanLabel(["2026-07", "2026-08"])]) {
    assert.equal(label.includes("·"), false, "the premium Contents sheet splits A1 on its last dot");
  }
  assert.equal(describeConsolidatedMonths(["2026-07", "2026-08", "2026-09"]), "July 2026 to September 2026 (3 months)");
  assert.equal(describeConsolidatedMonths(["2026-07", "2026-09"]), "July 2026, September 2026 (2 months)");
  assert.equal(
    closingFileName({ kind: "consolidated", line: "Pedia", period: consolidatedFilePeriod(["2026-07", "2026-08", "2026-09"]), region: "all regions" }),
    "phoenix-monthly-closing-consolidated-jul-2026-to-sep-2026-pedia-all-regions.xlsx",
  );
  assert.equal(
    closingFileName({ extension: "xlsm", kind: "premium-consolidated", line: "CNS", period: consolidatedFilePeriod(["2026-08", "2026-09"]), region: "Cairo" }),
    "phoenix-monthly-closing-premium-consolidated-aug-2026-to-sep-2026-cns-cairo.xlsm",
  );

  // ── The premium fill, relabelled for the span ────────────────────────────────────────────────
  const fill = consolidateEngineFill(
    {
      sheets: {
        "Family by Month": { cells: { A1: "Family by Month · September 2026" }, notes: ["Series from April 2026 to September 2026"] },
        Overview: { cells: { A1: "Pedia · September 2026", H8: "August value", I5: 0.12 }, notes: ["September 2026 closing"] },
        "Rep Card": { cells: { N4: "August 2026" } },
      },
    } as unknown as Parameters<typeof consolidateEngineFill>[0],
    { latestPeriod: "2026-09", periods: ["2026-07", "2026-08", "2026-09"] },
  );
  const overview = fill.sheets.Overview;
  assert.equal(overview.cells?.A1, "Pedia · Jul–Sep 2026", "the title names the span");
  assert.equal(overview.cells?.I5, null, "no growth figure against a month the span was never compared with");
  assert.equal(overview.cells?.H8, "Prior value");
  assert.equal(overview.cells?.I6, "not compared: 3 months added together");
  assert.deepEqual(overview.notes, ["Jul–Sep 2026 closing"]);
  assert.equal(fill.sheets["Rep Card"].cells?.N4, "The prior month");
  assert.deepEqual(
    fill.sheets["Family by Month"].notes,
    ["Series from April 2026 to September 2026"],
    "Family by Month's notes name where its month-by-month series runs, so they stay",
  );

  // ── The normal workbook, relabelled inside its XML ───────────────────────────────────────────
  const zip = new JSZip();
  zip.file("xl/sharedStrings.xml", "<sst><si><t>Month: 2026-09</t></si><si><t>Total 2026-09</t></si></sst>");
  zip.file("xl/worksheets/sheet1.xml", "<worksheet><c t=\"inlineStr\"><is><t>Month: 2026-09</t></is></c></worksheet>");
  zip.file("xl/styles.xml", "<styleSheet>Month: 2026-09</styleSheet>");
  const relabelled = await JSZip.loadAsync(
    await relabelConsolidatedWorkbook(Buffer.from(await zip.generateAsync({ type: "nodebuffer" })), {
      latestPeriod: "2026-09",
      periods: ["2026-07", "2026-08", "2026-09"],
    }),
  );
  const shared = await relabelled.file("xl/sharedStrings.xml")!.async("string");
  assert.ok(shared.includes("Months: July 2026 to September 2026 (3 months)"), "the band header names the span");
  assert.ok(shared.includes("Total 2026-09"), "only the band header's exact text changes");
  assert.ok(
    (await relabelled.file("xl/worksheets/sheet1.xml")!.async("string")).includes("Months: July 2026 to September 2026"),
    "inline strings in the sheets are relabelled too",
  );
  assert.equal(
    await relabelled.file("xl/styles.xml")!.async("string"),
    "<styleSheet>Month: 2026-09</styleSheet>",
    "no part but the strings and the sheets is touched",
  );

  // ── Where the gates and the switches sit ─────────────────────────────────────────────────────
  const ROOT = resolve(import.meta.dirname, "..");
  const read = (file: string) => readFileSync(join(ROOT, file), "utf8");

  for (const route of [
    "app/api/sales/monthly-closing/consolidated-export/route.ts",
    "app/api/sales/monthly-closing/consolidated-premium-export/route.ts",
  ]) {
    const body = read(route);
    const permission = body.indexOf('assertPermission(access, "sales", "export")');
    const role = body.indexOf("canExportConsolidatedClosing(access.role)");
    const build = body.search(/buildConsolidated(ClosingWorkbook|PremiumClosing)\(/);
    assert.ok(permission > 0 && role > permission, `${route} checks the export permission, then the role`);
    assert.ok(build > role, `${route} refuses anyone but Super Admin and the CEO before it builds anything`);
  }

  const registry = read("src/lib/security/access-registry.ts");
  for (const path of ["/api/sales/monthly-closing/consolidated-export", "/api/sales/monthly-closing/consolidated-premium-export"]) {
    assert.ok(registry.includes(path), `${path} is declared in the access registry`);
  }

  const page = read("app/(admin)/sales/monthly-closing/page.tsx");
  assert.ok(
    page.includes("canExportConsolidated={canExportConsolidatedClosing(access.role)}"),
    "the screen offers the consolidated buttons by the same role question the routes ask",
  );
  const workspace = read("src/components/sales/monthly-closing-workspace.tsx");
  assert.ok(workspace.includes("canExportConsolidated = false"), "no consolidated button unless the page says so");
  assert.ok(
    workspace.includes("const showConsolidatedExports = isMultiPeriod && canExportConsolidated;"),
    "the consolidated buttons appear only with several months on screen, and only for the two roles",
  );
  for (const handler of ["handleConsolidatedExport", "handleConsolidatedPremiumExport", "handleConsolidatedPremiumXlsxExport"]) {
    assert.match(
      workspace,
      new RegExp(`async function ${handler}\\(\\) \\{\\s*await runExport\\(\\{\\s*body: \\{[^}]*periods: selectedPeriods`),
      `${handler} goes through runExport and sends the months on screen`,
    );
  }

  // 🔒 The frozen builder: the consolidated path is a switch that is OFF unless a caller passes it.
  const builder = read("src/lib/sales/monthly-closing-export.ts");
  assert.ok(builder.includes("consolidatedMonths?:"), "the switch is optional");
  assert.ok(
    builder.includes("matrix.period === JULY_2026_DIRECT_PERIOD && !options?.consolidatedMonths"),
    "the single-month July file keeps its Direct Orders sheet",
  );
  const consolidatedModule = read("src/lib/sales/monthly-closing-consolidated-export.ts");
  assert.ok(
    consolidatedModule.includes("mapWithConcurrency(requested, MONTH_CONCURRENCY"),
    "the months are loaded one by one, each with its own split — never pooled into one read",
  );
  assert.ok(
    consolidatedModule.indexOf("withoutMaskedSourceRows(") < consolidatedModule.indexOf("buildMonthlyClosingWorkbook("),
    "El Qema is masked before the consolidated workbook is written",
  );
}
