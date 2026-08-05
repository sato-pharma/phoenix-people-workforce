import assert from "node:assert/strict";

import {
  DIRECT_ORDER_REPORT_COLUMNS,
  directOrderReportColumnIndex,
  directOrderReportRowCells,
  summariseDirectOrderReport,
} from "../src/lib/direct-orders/report-columns.ts";
import type { DirectOrderReportRow } from "../src/lib/direct-orders/types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// report-columns.ts is the single definition of "what a Direct Orders row is". Three surfaces read
// it: the downloadable .xlsx, the live Google Sheet's CSV feed, and the by-status breakdown they
// both show. It is deliberately free of Supabase and ExcelJS imports, so unlike most of this
// module it can be EXECUTED in a test rather than only inspected as text.
//
// Which is the point: this file guards arithmetic the owner reads as money. A silent change to the
// totals here would show up as a wrong number on a report he makes decisions from.
// ─────────────────────────────────────────────────────────────────────────────

function row(overrides: Partial<DirectOrderReportRow> = {}): DirectOrderReportRow {
  return {
    id: "req-1",
    requesterHrId: "HR1",
    requesterName: "Dina Hamdy",
    requesterRole: "District Manager",
    status: "approved",
    line: "Anti Infective",
    productCode: "RO001",
    productName: "Royafloxacin",
    pharmacyPriceSnapshot: 66.93,
    qty: 50,
    bonus: 7,
    bonusOverrideReason: null,
    dealType: "bonus",
    discountPct: null,
    publicPriceSnapshot: 92,
    salesValue: 3346.5,
    collectionDate: null,
    salesMonth: null,
    marketingRequestId: null,
    paymentDate: null,
    paidAmount: null,
    remainingAmount: null,
    reversalOfRequestId: null,
    reversedByRequestId: null,
    sosBatchId: null,
    createdAt: "2026-08-04T10:00:00.000Z",
    decidedAt: null,
    activeStepLabel: "Completed",
    activeStepOrder: null,
    pharmacyCode: "DOP-000010",
    pharmacyName: "ريهام",
    pharmacyAddress: "Cairo",
    brickId: "BR1",
    brickName: "Brick One",
    areaCode: "A1",
    areaName: "Area One",
    regionCode: "R1",
    regionName: "Region One",
    doctorName: "Dr Reham",
    distributorCodesText: "Ibn Sina: 123",
    ...overrides,
  } as DirectOrderReportRow;
}

export function runDirectOrderReportColumnsTests() {
  // ── THE HEADLINE: one row produces exactly one cell per column ──────────────────────────
  // If these two ever diverge, every column after the insertion point sits under the wrong
  // header — the export silently reports region data beneath "Area".
  const cells = directOrderReportRowCells(row());
  assert.equal(
    cells.length,
    DIRECT_ORDER_REPORT_COLUMNS.length,
    `the row builder emitted ${cells.length} cells for ${DIRECT_ORDER_REPORT_COLUMNS.length} columns — the two are positional twins and must match`,
  );

  // The owner's rule is "do not minus even one field". 39 is that promise, pinned.
  assert.equal(DIRECT_ORDER_REPORT_COLUMNS.length, 39, "the Direct Orders report is a 39-column report");

  // Values must land under their own header, not merely be present somewhere.
  const at = (label: string) => cells[directOrderReportColumnIndex(label)];
  assert.equal(at("Status"), "approved");
  assert.equal(at("Sales value (EGP)"), 3346.5);
  assert.equal(at("Pharmacy price"), 66.93);
  assert.equal(at("Pharmacy name"), "ريهام", "Arabic pharmacy names must survive unmangled");
  assert.equal(at("Qty (units)"), 50);
  assert.equal(at("Bonus (units)"), 7);
  assert.equal(at("Request ID"), "req-1");

  // Nulls must render as empty, never as the string "null" in the owner's spreadsheet.
  assert.equal(at("Sales month"), "", "a null sales month must be blank, not the text 'null'");
  assert.equal(at("Decided at"), "");
  assert.equal(at("Discount %"), "");

  // ── The aggregates the cover sheet and the totals row both quote ────────────────────────
  const summary = summariseDirectOrderReport([
    row({ id: "a", status: "approved", salesValue: 100, qty: 10 }),
    row({ id: "b", status: "held", salesValue: 250.5, qty: 5 }),
    row({ id: "c", status: "held", salesValue: 49.5, qty: 1 }),
  ]);
  assert.equal(summary.totalValue, 400, "total value must be the sum of every row");
  assert.equal(summary.approvedValue, 100, "approved value must count ONLY approved rows");
  assert.equal(summary.totalUnits, 16);

  // By-status must be sorted and complete — it drives a whole sheet.
  assert.deepEqual(
    summary.byStatus,
    [
      { status: "approved", count: 1, value: 100 },
      { status: "held", count: 2, value: 300 },
    ],
    "the by-status breakdown must group, sum and sort by status",
  );

  // A non-finite salesValue must contribute zero rather than poison the total with NaN. This is
  // the failure that turns a whole money column into #VALUE! in the owner's sheet.
  const poisoned = summariseDirectOrderReport([
    row({ id: "x", salesValue: Number.NaN, qty: Number.NaN }),
    row({ id: "y", salesValue: 10, qty: 2 }),
  ]);
  assert.equal(poisoned.totalValue, 10, "a NaN sales value must count as zero, never propagate");
  assert.equal(poisoned.totalUnits, 2, "a NaN qty must count as zero, never propagate");

  // An empty report must summarise to zeroes, not throw or return NaN.
  const empty = summariseDirectOrderReport([]);
  assert.equal(empty.totalValue, 0);
  assert.equal(empty.approvedValue, 0);
  assert.equal(empty.totalUnits, 0);
  assert.deepEqual(empty.byStatus, []);

  // Lookup must fail loudly rather than silently returning column 0 and mislabelling data.
  assert.equal(directOrderReportColumnIndex("No Such Column"), -1);
}
