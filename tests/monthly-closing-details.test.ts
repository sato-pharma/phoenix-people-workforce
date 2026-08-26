import assert from "node:assert/strict";

import { countsInClosingHeadline } from "../src/lib/sales/closing-headline.ts";

import ExcelJS from "exceljs";

import {
  applyDetailFilters,
  applyDetailScope,
  buildFilterOptions,
  summarize,
  type ClosingDetailRow,
  type ClosingDetailsResult,
} from "../src/lib/sales/monthly-closing-details.ts";
import { buildClosingDetailsWorkbook, buildMonthlyClosingWorkbook } from "../src/lib/sales/monthly-closing-export.ts";
import type { MonthlyClosingMatrix } from "../src/lib/sales/monthly-distributor-import.ts";
import type { MonthlyClosingComparison } from "../src/lib/sales/monthly-closing-comparison.ts";

// Monthly Closing "Details" — the audit layer under the Closing Matrix.
//
// The three things that must never regress:
//   1. scope is a security boundary (confidential products, region, product allowlist);
//   2. `includedInClosing` matches what phx_monthly_closing_matrix actually counts, so the
//      Data/Total sheets reconcile to the published headline;
//   3. the exported workbook really carries visible Data + Total sheets and keeps the
//      pre-aggregated sheet hidden under its new "Calc" name.

function row(overrides: Partial<ClosingDetailRow> = {}): ClosingDetailRow {
  const qty = overrides.qty ?? 10;
  const discount = overrides.discount ?? 0;
  const factoryPrice = overrides.factoryPrice ?? 100;
  const effectiveUnits = qty * (1 - discount);
  // The sheet area TRACKS whatever areaCode override the caller passed, unless the caller ALSO
  // overrides sheetAreaCode explicitly — that is how a test deliberately models a re-booked row
  // (fact area != brick-resolved area) rather than an ordinary one. Without this, a caller that
  // sets only `areaCode: "AR02"` to mean "this row is in a different area" got a row that looked
  // re-booked by accident (sheetAreaCode stuck at the "AR01" default), which is exactly what
  // closingAreaOf now reads first — see closing-row-area.ts.
  const sheetAreaCode = overrides.sheetAreaCode ?? overrides.areaCode ?? "AR01";
  const base: ClosingDetailRow = {
    id: 1,
    rowNumber: 1,
    distributorCode: "POS",
    invoicePeriod: "2026-06",
    invoiceDate: "2026-06-15",
    officialLine: "Pedia",
    sheetAreaCode,
    sheetAreaName: "Qena",
    sheetRegionCode: "UE",
    sheetRegionName: "Upper Egypt",
    blockCode: "BL01",
    brickId: "BR01",
    brickName: "Qena Centre",
    areaCode: "AR01",
    areaName: "Qena",
    regionCode: "UE",
    regionName: "Upper Egypt",
    areaMismatch: false,
    brickUnmapped: false,
    clientCode: "C1",
    clientName: "Pharmacy One",
    clientAddress: "Somewhere",
    productCode: "LA001",
    productName: "Lacto Advanced 1",
    family: "Lacto",
    factoryPrice,
    qty,
    bonusQty: 0,
    discount,
    effectiveUnits,
    salesValue: effectiveUnits * factoryPrice,
    sheetValue: effectiveUnits * factoryPrice,
    isDirect: false,
    isConfidential: false,
    missingClientCode: false,
    validationState: "valid",
    includedInClosing: true,
    exclusions: [],
    ...overrides,
  };
  // Keep the derived fields honest when a caller overrides only the inputs.
  const exclusions: ClosingDetailRow["exclusions"] = [];
  if (base.isDirect) exclusions.push("direct");
  if (base.isConfidential) exclusions.push("confidential");
  return {
    ...base,
    effectiveUnits: base.qty * (1 - base.discount),
    salesValue: base.qty * (1 - base.discount) * base.factoryPrice,
    missingClientCode: !base.clientCode,
    exclusions: overrides.exclusions ?? exclusions,
    includedInClosing: overrides.includedInClosing ?? exclusions.length === 0,
  };
}

function matrixStub(salesValue: number, salesUnits: number): MonthlyClosingMatrix {
  const cell = {
    achievement: null,
    salesUnits,
    salesValue,
    targetUnits: null,
    targetValue: null,
  };
  return {
    availableLines: ["Pedia"],
    availablePeriods: ["2026-06"],
    columns: [{ family: "Lacto", productCode: "LA001", productName: "Lacto Advanced 1" }],
    grandTotal: { cells: [cell], kind: "grandTotal", rowTotal: cell },
    line: "Pedia",
    period: "2026-06",
    regions: [
      {
        areas: [
          {
            areaCode: "AR01",
            areaName: "Qena",
            cells: [cell],
            kind: "area",
            regionCode: "UE",
            regionName: "Upper Egypt",
            rowTotal: cell,
          },
        ],
        regionCode: "UE",
        regionName: "Upper Egypt",
        subtotal: {
          cells: [cell],
          kind: "regionSubtotal",
          regionCode: "UE",
          regionName: "Upper Egypt",
          rowTotal: cell,
        },
      },
    ],
  };
}

function comparisonStub(): MonthlyClosingComparison {
  return {
    line: "Pedia",
    period: "2026-06",
    distributors: [{ code: "POS", name: "POS" }],
    byDistributor: [],
    productByDistributor: [],
    regionByDistributor: [],
    areaByDistributor: [],
    rankings: { products: [], areas: [], regions: [], bricks: [] },
    whiteSpace: {
      zeroSalesAreas: [],
      zeroSalesBricks: [],
      singleDistributorAreas: [],
      productGaps: [],
    },
    avgPrice: [],
    pareto: { customers: { share: 0, rows: [] } },
    insights: [],
    national: { units: 0, value: 0, productCount: 0, areaCount: 0, customerCount: 0 },
    totalAreas: 1,
    totalBricks: 1,
    data: {
      distProduct: [],
      customers: [],
      bricks: [],
      productByDist: [],
      areaByDist: [],
      masterAreas: [],
      masterBricks: [],
    },
  } as unknown as MonthlyClosingComparison;
}

function detailsStub(rows: ClosingDetailRow[]): ClosingDetailsResult {
  return {
    line: "Pedia",
    period: "2026-06",
    availableLines: ["Pedia"],
    availablePeriods: ["2026-06"],
    rows,
    filteredRowCount: rows.length,
    page: 1,
    pageSize: rows.length || 1,
    options: buildFilterOptions(rows),
    totals: summarize(rows, () => true),
    reconciliation: {
      closingHeadline: summarize(rows, countsInClosingHeadline),
      includedInClosing: summarize(rows, (r) => r.includedInClosing),
      excludedDirect: summarize(rows, (r) => r.isDirect),
      missingClientCode: summarize(rows, (r) => r.missingClientCode),
      excludedConfidential: summarize(rows, (r) => r.isConfidential),
      unmappedBricks: summarize(rows, (r) => r.brickUnmapped),
      areaMismatches: summarize(rows, (r) => r.areaMismatch),
    },
    confidentialIncluded: false,
    canRevealConfidential: false,
    outOfScope: false,
  };
}

export async function runMonthlyClosingDetailsTests() {
  // ── Exclusion semantics mirror phx_monthly_closing_matrix ──────────────────
  //
  // Verified against production 2026-06: with EXACTLY these two exclusions the detail rows
  // reproduce the RPC to the cent on all three lines. Adding a third ("no client code") — which
  // the fact-rollup's customer-grain path does filter on — understated CNS by 11,205 units, so
  // a missing client code must stay a data-quality flag and never an exclusion.
  {
    const rows = [
      row({ id: 1 }),
      row({ id: 2, isDirect: true }),
      row({ id: 3, clientCode: "" }),
      row({ id: 4, isConfidential: true, productCode: "LA003" }),
    ];
    assert.equal(rows[0].includedInClosing, true, "a plain coded row feeds the closing");
    assert.equal(rows[1].includedInClosing, false, "Direct rows are excluded (not f.is_direct)");
    assert.equal(
      rows[2].includedInClosing,
      true,
      "a missing client code does NOT remove the row from the closing",
    );
    assert.equal(rows[2].missingClientCode, true, "…but it is flagged for data quality");
    assert.equal(rows[3].includedInClosing, false, "confidential products are excluded");
    assert.deepEqual(rows[2].exclusions, [], "no client code is not an exclusion reason");
  }

  // ── The data-quality bucket counts every no-code row, Direct or not ────────
  {
    const rows = [
      row({ id: 1 }),
      row({ id: 2, isDirect: true, clientCode: "" }),
      row({ id: 3, clientCode: "" }),
    ];
    assert.deepEqual(rows[1].exclusions, ["direct"]);
    const noCode = summarize(rows, (r) => r.missingClientCode);
    assert.equal(noCode.rows, 2, "both no-code rows are surfaced, regardless of Direct");
  }

  // ── Scope is a security boundary ───────────────────────────────────────────
  {
    const rows = [
      row({ id: 1, productCode: "LA001" }),
      row({ id: 2, productCode: "LA003", isConfidential: true }),
    ];
    const dropped = applyDetailScope(rows, {
      allowedRegionCodes: null,
      allowedProductCodes: null,
      dropConfidential: true,
    });
    assert.equal(dropped.length, 1, "confidential rows are removed when not revealed");
    assert.equal(dropped[0].productCode, "LA001");

    const kept = applyDetailScope(rows, {
      allowedRegionCodes: null,
      allowedProductCodes: null,
      dropConfidential: false,
    });
    assert.equal(kept.length, 2, "an allowed viewer who opted in keeps them");
  }

  {
    const rows = [
      row({ id: 1, regionCode: "UE" }),
      row({ id: 2, regionCode: "CA" }),
    ];
    const scoped = applyDetailScope(rows, {
      allowedRegionCodes: new Set(["UE"]),
      allowedProductCodes: null,
      dropConfidential: true,
    });
    assert.deepEqual(scoped.map((r) => r.id), [1], "region scope keeps only the viewer's region");

    // An empty region set means the viewer's region resolved to nothing — fail CLOSED.
    const failClosed = applyDetailScope(rows, {
      allowedRegionCodes: new Set(),
      allowedProductCodes: null,
      dropConfidential: true,
    });
    assert.equal(failClosed.length, 0, "an unresolved region shows nothing, not everything");
  }

  {
    const rows = [row({ id: 1, productCode: "LA001" }), row({ id: 2, productCode: "GU001" })];
    const scoped = applyDetailScope(rows, {
      allowedRegionCodes: null,
      allowedProductCodes: new Set(["LA001"]),
      dropConfidential: true,
    });
    assert.deepEqual(scoped.map((r) => r.id), [1], "per-user product allowlist is enforced");
  }

  // ── Filters are a convenience, never a boundary ────────────────────────────
  {
    const rows = [
      row({ id: 1, areaCode: "AR01", productCode: "LA001", clientName: "Alpha" }),
      row({ id: 2, areaCode: "AR02", productCode: "GU001", clientName: "Beta" }),
      row({ id: 3, areaCode: "AR01", productCode: "GU001", isDirect: true, clientName: "Gamma" }),
    ];
    assert.deepEqual(
      applyDetailFilters(rows, { areaCodes: ["AR01"] }).map((r) => r.id),
      [1, 3],
    );
    assert.deepEqual(
      applyDetailFilters(rows, { inclusion: "excluded" }).map((r) => r.id),
      [3],
    );
    assert.deepEqual(
      applyDetailFilters(rows, { search: "beta" }).map((r) => r.id),
      [2],
      "search is case-insensitive across customer / brick / product",
    );
    assert.equal(applyDetailFilters(rows, undefined).length, 3, "no filter keeps everything");
  }

  // ── Totals ─────────────────────────────────────────────────────────────────
  {
    const rows = [
      row({ id: 1, qty: 10, factoryPrice: 100 }),
      row({ id: 2, qty: 5, discount: 0.5, factoryPrice: 100 }),
      row({ id: 3, qty: 20, isDirect: true, factoryPrice: 100 }),
    ];
    const included = summarize(rows, (r) => r.includedInClosing);
    assert.equal(included.rows, 2, "only the Direct row is dropped");
    assert.equal(included.units, 15, "units are raw qty (matches sum(total_qty))");
    assert.equal(
      included.effectiveUnits,
      12.5,
      "effective units apply the discount (matches fact_rollup.effective_units)",
    );
    assert.equal(included.salesValue, 1250, "value = effective units x factory price");
  }

  // ── Filter options come from the scoped set ────────────────────────────────
  {
    const options = buildFilterOptions([
      row({ id: 1, areaCode: "AR02", areaName: "Beta", productCode: "GU001", productName: "Guamusin" }),
      row({ id: 2, areaCode: "AR01", areaName: "Alpha", productCode: "LA001", productName: "Lacto Advanced 1" }),
    ]);
    assert.deepEqual(options.areas.map((a) => a.name), ["Alpha", "Beta"], "areas sort by name");
    assert.equal(options.products.length, 2);
    assert.deepEqual(options.distributors, ["POS"]);
  }

  // ── The exported workbook carries the audit sheets ─────────────────────────
  {
    const rows = [
      row({ id: 1, qty: 10, factoryPrice: 100 }),
      row({ id: 2, qty: 4, isDirect: true, factoryPrice: 100 }),
      row({ id: 3, qty: 7, isConfidential: true, productCode: "LA003", factoryPrice: 100 }),
    ];
    const details = detailsStub(rows);
    const buffer = await buildMonthlyClosingWorkbook(
      matrixStub(1000, 10),
      comparisonStub(),
      details,
    );

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    const names = workbook.worksheets.map((sheet) => sheet.name);

    assert.ok(names.includes("Data"), "a visible Data sheet is present");
    assert.ok(names.includes("Total"), "a visible Total sheet is present");
    assert.ok(names.includes("Calc"), "the pre-aggregated sheet was renamed to Calc");
    assert.equal(
      workbook.getWorksheet("Calc")?.state,
      "hidden",
      "Calc stays hidden — it is machinery, not a report",
    );
    assert.equal(
      workbook.getWorksheet("Data")?.state ?? "visible",
      "visible",
      "Data must be visible or it cannot be audited",
    );
    assert.ok(
      names.includes("Confidential"),
      "confidential rows get their own sheet rather than polluting Data",
    );

    // Confidential rows must NOT be on the Data sheet — that is what keeps Total tying out.
    const dataSheet = workbook.getWorksheet("Data");
    assert.ok(dataSheet, "Data sheet resolves");
    let sawConfidential = false;
    dataSheet!.eachRow((sheetRow) => {
      sheetRow.eachCell((cell) => {
        if (String(cell.value ?? "") === "LA003") sawConfidential = true;
      });
    });
    assert.equal(sawConfidential, false, "LA003 never appears on the Data sheet");

    // The Total sheet's numbers must be live formulas, not pasted values.
    const totalSheet = workbook.getWorksheet("Total");
    assert.ok(totalSheet, "Total sheet resolves");
    let formulaCells = 0;
    totalSheet!.eachRow((sheetRow) => {
      sheetRow.eachCell((cell) => {
        const value = cell.value as { formula?: string } | null;
        if (value && typeof value === "object" && typeof value.formula === "string") {
          formulaCells += 1;
          if (value.formula.includes("SUMIFS")) {
            assert.ok(
              value.formula.includes("'Data'!"),
              "Total's SUMIFS point at the visible Data sheet",
            );
          }
        }
      });
    });
    assert.ok(formulaCells > 0, "Total is formula-driven, not a pasted snapshot");
  }

  // ── A workbook built without details still works (back-compat) ─────────────
  {
    const buffer = await buildMonthlyClosingWorkbook(matrixStub(0, 0), comparisonStub());
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    const names = workbook.worksheets.map((sheet) => sheet.name);
    assert.ok(names.includes("Calc"), "Calc is still written when there are no details");
    assert.ok(!names.includes("Data"), "no raw Data sheet without details");
  }

  // ── "Tgt % of Line" — each row's target share of the line's total target ───
  // Two areas with targets 500 and 1,500: shares must be 25% and 75%, the region and grand rows
  // 100%, every cell a live formula dividing by the ABSOLUTE grand-total target cell.
  {
    const cellWith = (salesValue: number, targetValue: number | null) => ({
      achievement: targetValue ? salesValue / targetValue : null,
      salesUnits: salesValue / 10,
      salesValue,
      targetUnits: targetValue === null ? null : targetValue / 10,
      targetValue,
    });
    const areaWith = (areaCode: string, areaName: string, salesValue: number, targetValue: number | null) => ({
      areaCode, areaName, cells: [cellWith(salesValue, targetValue)], kind: "area" as const,
      regionCode: "CA", regionName: "Cairo", rowTotal: cellWith(salesValue, targetValue),
    });
    const targeted: MonthlyClosingMatrix = {
      availableLines: ["Pedia"],
      availablePeriods: ["2026-06"],
      columns: [{ family: "Lacto", productCode: "LA001", productName: "Lacto Advanced 1" }],
      grandTotal: { cells: [cellWith(1600, 2000)], kind: "grandTotal", rowTotal: cellWith(1600, 2000) },
      line: "Pedia",
      period: "2026-06",
      regions: [{
        areas: [areaWith("CA1", "Heliopolis", 400, 500), areaWith("CA2", "Nasr City", 1200, 1500)],
        regionCode: "CA", regionName: "Cairo",
        subtotal: { cells: [cellWith(1600, 2000)], kind: "regionSubtotal", regionCode: "CA", regionName: "Cairo", rowTotal: cellWith(1600, 2000) },
      }],
    };
    const buffer = await buildMonthlyClosingWorkbook(targeted, comparisonStub());
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    const shares: number[] = [];
    workbook.getWorksheet("Target vs Achievement")!.eachRow((sheetRow) => {
      sheetRow.eachCell((cell) => {
        const value = cell.value as { formula?: string; result?: unknown } | null;
        if (value && typeof value === "object" && typeof value.formula === "string"
          && value.formula.includes("/$F$")) {
          shares.push(Number(value.result ?? Number.NaN));
        }
      });
    });
    assert.deepEqual(
      shares,
      [0.25, 0.75, 1, 1],
      "area shares 25%/75%, region total 100%, grand total 100% — all against the absolute grand target",
    );
  }

  // ── Filtered workbooks say so on the file itself, and stay honest about targets ───
  // A row-level filtered export rebuilds every sheet from the same rows, so the tie to the
  // matrix HOLDS — but the file must (a) name its own filter on the Closing Matrix sheet, (b)
  // label the headline as the filtered total, and (c) omit Target vs Achievement, because a
  // company-set target cannot be sliced by distributor/inclusion/search.
  {
    const workbookOf = async (options?: { filterNote?: string; includeTargetSheet?: boolean }) => {
      const buffer = await buildMonthlyClosingWorkbook(
        matrixStub(1000, 10),
        comparisonStub(),
        detailsStub([row({ id: 1, qty: 10, factoryPrice: 100 })]),
        options,
      );
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
      const textsOf = (sheetName: string) => {
        const texts: string[] = [];
        workbook.getWorksheet(sheetName)?.eachRow((sheetRow) => {
          sheetRow.eachCell((cell) => {
            if (typeof cell.value === "string") texts.push(cell.value);
          });
        });
        return texts;
      };
      return { names: workbook.worksheets.map((sheet) => sheet.name), textsOf };
    };

    const unfiltered = await workbookOf();
    assert.ok(unfiltered.names.includes("Target vs Achievement"), "an unfiltered export keeps the target sheet");
    assert.ok(
      unfiltered.textsOf("Target vs Achievement").includes("Tgt % of Line"),
      "each targeted row carries its share of the whole line's target",
    );
    assert.ok(
      unfiltered.textsOf("Total").some((text) => text.includes("Closing Matrix grand total")
        && !text.includes("(filtered)")),
      "…and its headline is the published month",
    );

    const NOTE = "Filtered export — this workbook covers only: Distributor: Ibn Sina.";
    const filtered = await workbookOf({ filterNote: NOTE, includeTargetSheet: false });
    assert.ok(
      !filtered.names.includes("Target vs Achievement"),
      "a row-level filtered export omits Target vs Achievement instead of faking an achievement %",
    );
    assert.ok(
      filtered.textsOf("Closing Matrix").some((text) => text === NOTE),
      "the Closing Matrix sheet carries the filter stamp verbatim",
    );
    assert.ok(
      filtered.textsOf("Total").some((text) => text.includes("Closing Matrix grand total (filtered)")),
      "the Total sheet still ties — to the filtered matrix, and says so",
    );
  }

  // ── The scoped (Details-only) export never leaks the Matrix/Comparison sheets ──
  // This is what a non-admin, scope-limited viewer (DM/RM/NSM/PM/GPM) downloads: the exact
  // rows their Details tab already shows them, with no company-wide sheet alongside it.
  {
    const rows = [
      row({ id: 1, qty: 10, factoryPrice: 100 }),
      row({ id: 2, qty: 4, isDirect: true, factoryPrice: 100 }),
      row({ id: 3, qty: 7, isConfidential: true, productCode: "LA003", factoryPrice: 100 }),
    ];
    const details = detailsStub(rows);
    const buffer = await buildClosingDetailsWorkbook(details);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    const names = workbook.worksheets.map((sheet) => sheet.name);

    assert.deepEqual(
      names.sort(),
      ["Confidential", "Data", "Total"],
      "a scoped export carries ONLY Data/Total(/Confidential) — never Matrix, Comparison, " +
        "Rankings, Gaps, Summary, or the hidden Calc sheet, which are all unscoped company-wide reads",
    );

    let sawConfidential = false;
    workbook.getWorksheet("Data")!.eachRow((sheetRow) => {
      sheetRow.eachCell((cell) => {
        if (String(cell.value ?? "") === "LA003") sawConfidential = true;
      });
    });
    assert.equal(sawConfidential, false, "LA003 never appears on the Data sheet here either");

    // With no company-wide headline to compare against, Total's reconciliation must show its
    // own totals only — never a fabricated "Closing Matrix grand total" row.
    let sawMatrixLabel = false;
    workbook.getWorksheet("Total")!.eachRow((sheetRow) => {
      sheetRow.eachCell((cell) => {
        if (String(cell.value ?? "").includes("Closing Matrix grand total")) sawMatrixLabel = true;
      });
    });
    assert.equal(
      sawMatrixLabel,
      false,
      "a scoped export has no company-wide grand total to reconcile against",
    );
  }

  // ── A scoped export with nothing confidential skips that sheet entirely ────
  {
    const details = detailsStub([row({ id: 1, qty: 5, factoryPrice: 50 })]);
    const buffer = await buildClosingDetailsWorkbook(details);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    assert.deepEqual(workbook.worksheets.map((s) => s.name).sort(), ["Data", "Total"]);
  }

  console.log("monthly-closing-details: ok");
}
