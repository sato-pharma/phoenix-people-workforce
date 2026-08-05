import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DIRECT_ORDER_REPORT_COLUMNS,
  HELD_ORDER_LIFETIME_DAYS,
  directOrderReportColumnIndex,
  directOrderShareFileUrl,
  heldClockCells,
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

  // The owner's rule is "do not minus even one field". The count is that promise, pinned — it went
  // 39 -> 43 (held clock) -> 44 (evidence link) on 2026-08-05. Adding is fine and expected; this assertion
  // exists to make a REMOVAL impossible to do quietly, so update it deliberately or not at all.
  assert.equal(DIRECT_ORDER_REPORT_COLUMNS.length, 44, "the Direct Orders report is a 44-column report");
  for (const promised of ["Status", "Sales value (EGP)", "Pharmacy name", "Held at", "Days to expiry"]) {
    assert.ok(
      directOrderReportColumnIndex(promised) >= 0,
      `"${promised}" must still be a column — the count alone would let a swap slip through`,
    );
  }

  // ── The held fuse is duplicated on purpose; it must not drift ────────────────────────────
  // report-columns.ts cannot import from service.ts (no Supabase in the feed's hot path), and
  // moving the constant the other way would mean editing the expiry sweep's own default — a line
  // spec B6 pins. So there are two 14s, and this is what stops them diverging: change one and the
  // report starts promising an expiry date the sweep does not honour.
  {
    const serviceSource = readFileSync(new URL("../src/lib/direct-orders/service.ts", import.meta.url), "utf8");
    const declared = /const HELD_ORDER_LIFETIME_DAYS = (\d+);/.exec(serviceSource);
    assert.ok(declared, "service.ts must still declare HELD_ORDER_LIFETIME_DAYS");
    assert.equal(
      Number(declared[1]),
      HELD_ORDER_LIFETIME_DAYS,
      `service.ts holds a held order for ${declared[1]} days but the report computes its expiry from ${HELD_ORDER_LIFETIME_DAYS} — the sheet would show a deadline that is not the real one`,
    );
  }

  // The clock is blank for anything not held. A countdown on an approved order reads as a deadline
  // that does not exist, which is worse than no column at all.
  assert.deepEqual(heldClockCells(null), ["", null, "", null]);
  {
    const now = new Date("2026-08-10T00:00:00Z");
    const [heldAt, daysHeld, expires, daysLeft] = heldClockCells("2026-08-04T00:00:00Z", now);
    assert.equal(heldAt, "2026-08-04T00:00:00Z");
    assert.equal(daysHeld, 6, "held on the 4th, read on the 10th, is 6 days");
    assert.equal(String(expires).slice(0, 10), "2026-08-18", "14 days from the 4th is the 18th");
    assert.equal(daysLeft, 8, "and 8 of those days are left");
  }

  // ── Clickable evidence ───────────────────────────────────────────────────────────────────
  // The link column is LAST, and it is the same column in the .xlsx and the live sheet — only the
  // URL base differs. Omitting the argument (the plain download) must blank it rather than throw
  // or write "undefined" into a cell the owner reads.
  assert.equal(DIRECT_ORDER_REPORT_COLUMNS[DIRECT_ORDER_REPORT_COLUMNS.length - 1].label, "Evidence photo link");
  assert.equal(directOrderReportRowCells(row()).at(-1), null, "no links argument means a blank cell");
  assert.equal(
    directOrderReportRowCells(row(), { evidence: "https://x/e" }).at(-1),
    "https://x/e",
  );

  // The file URL is addressed by REQUEST ID, never by storage path: a path parameter would turn the
  // route into a read primitive over a private bucket holding employee photos and leave attachments.
  const fileUrl = directOrderShareFileUrl("https://phoenix-hr.satopharma.com/", "tok en", "req/1");
  assert.equal(
    fileUrl,
    "https://phoenix-hr.satopharma.com/api/share/direct-orders/tok%20en/file?kind=evidence&request=req%2F1",
    "both the token and the request id must be URL-encoded, and the trailing slash collapsed",
  );
  assert.ok(!/storage|path=/.test(fileUrl), "the URL must never carry a storage path");

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
