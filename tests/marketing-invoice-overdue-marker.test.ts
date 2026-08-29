import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { currentCairoDateOnlyIso } from "../src/lib/i18n/format.ts";
import {
  effectiveMarketingInvoiceStatus,
  marketingInvoiceDueLabel,
  resolveMarketingInvoiceObligation,
} from "../src/lib/marketing-requests/invoice-obligation.ts";

// Approving a marketing request records an invoice deadline, and until now nothing read it back.
// `invoice_status` was only ever written 'pending' at approval or 'submitted' when the file
// arrived, so a request eighteen days late read as calmly "Pending" everywhere it appeared.
//
// The marker is DERIVED rather than flipped by a nightly job — a stored flag can only be wrong
// here (it dies silently, and it goes stale the moment a deadline is corrected forward). That
// choice puts the whole invariant in one module, which is what this pins: the boundary at the
// deadline day, which statuses may go overdue at all, Cairo rather than UTC, and — the part that
// actually rots — that BOTH readers go through the module instead of reading the column raw.

const SRC = join(process.cwd(), "src");

/** Every value the table's CHECK constraint allows. An effective status may never leave this set. */
const ALLOWED_DB_STATUSES = new Set(["not_required", "pending", "submitted", "cleared", "overdue", "hold"]);

export function runMarketingInvoiceOverdueMarkerTests() {
  // ── The real production row this was built for ──────────────────────────────
  // MKT-REQ-20260802-DCF31EC4: approved 2026-08-04, deadline 2026-08-11, still no invoice.
  const real = resolveMarketingInvoiceObligation(
    { invoiceDeadlineDate: "2026-08-11", invoiceStatus: "pending" },
    "2026-08-29",
  );
  assert.equal(real.isOverdue, true, "an invoice 18 days past its deadline is overdue");
  assert.equal(real.daysOverdue, 18, "the count is whole days past the deadline, not since approval");
  assert.equal(real.effectiveStatus, "overdue", "the surface must say overdue where the column says pending");

  // ── The boundary: the deadline day itself is NOT late ───────────────────────
  // A deadline of the 2nd means "by the end of the 2nd". Telling somebody they are late on the day
  // they are still on time is the fastest way for a marker to stop being believed.
  const onTheDay = resolveMarketingInvoiceObligation(
    { invoiceDeadlineDate: "2026-09-02", invoiceStatus: "pending" },
    "2026-09-02",
  );
  assert.equal(onTheDay.isOverdue, false, "the deadline day itself is due, not overdue");
  assert.equal(onTheDay.daysUntilDue, 0, "on the deadline day there are zero days left, not one");

  const dayAfter = resolveMarketingInvoiceObligation(
    { invoiceDeadlineDate: "2026-09-02", invoiceStatus: "pending" },
    "2026-09-03",
  );
  assert.equal(dayAfter.daysOverdue, 1, "the marker appears the day AFTER the deadline, counting one day");

  const dayBefore = resolveMarketingInvoiceObligation(
    { invoiceDeadlineDate: "2026-09-02", invoiceStatus: "pending" },
    "2026-09-01",
  );
  assert.equal(dayBefore.isOverdue, false, "a deadline still ahead is not overdue");
  assert.equal(dayBefore.daysUntilDue, 1, "one day remains");

  // ── Only a pending obligation can go overdue ────────────────────────────────
  for (const status of ["submitted", "cleared"]) {
    const arrived = resolveMarketingInvoiceObligation(
      { invoiceDeadlineDate: "2026-01-01", invoiceStatus: status },
      "2026-08-29",
    );
    assert.equal(arrived.isOverdue, false, `${status}: the invoice arrived — nothing is owed, however late it was`);
    assert.equal(arrived.effectiveStatus, status, `${status} must survive untouched`);
  }

  const notRequired = resolveMarketingInvoiceObligation(
    { invoiceDeadlineDate: "2026-01-01", invoiceStatus: "not_required" },
    "2026-08-29",
  );
  assert.equal(notRequired.isOverdue, false, "nothing was ever owed on a not_required obligation");

  // `hold` is a human deliberately pausing this one. Nagging about a pause somebody chose is how a
  // marker earns itself ignored, so a hold is left exactly as it is.
  const held = resolveMarketingInvoiceObligation(
    { invoiceDeadlineDate: "2026-01-01", invoiceStatus: "hold" },
    "2026-08-29",
  );
  assert.equal(held.isOverdue, false, "a deliberately held obligation is never marked overdue");
  assert.equal(held.effectiveStatus, "hold", "a hold keeps its own status");

  // ── An undated obligation can never be late ─────────────────────────────────
  // The one production row in this state predates approval-time deadlines and already carries its
  // invoice. Inventing a deadline for it would manufacture a debt nobody agreed to.
  const undated = resolveMarketingInvoiceObligation(
    { invoiceDeadlineDate: null, invoiceStatus: "pending" },
    "2026-08-29",
  );
  assert.equal(undated.isOverdue, false, "no deadline means nothing to be late against");
  assert.equal(undated.daysUntilDue, null, "an undated obligation has no countdown");

  // Junk must fail closed to "not overdue" rather than throw on a page render.
  const junk = resolveMarketingInvoiceObligation(
    { invoiceDeadlineDate: "not-a-date", invoiceStatus: "pending" },
    "2026-08-29",
  );
  assert.equal(junk.isOverdue, false, "an unparseable deadline must not manufacture an overdue badge");

  // Nothing derived may leave the set the database CHECK constraint allows.
  for (const status of ["pending", "submitted", "cleared", "hold", "not_required", "overdue"]) {
    const derived = effectiveMarketingInvoiceStatus(
      { invoiceDeadlineDate: "2026-01-01", invoiceStatus: status },
      "2026-08-29",
    );
    assert.ok(
      ALLOWED_DB_STATUSES.has(derived),
      `derived status "${derived}" must be one the invoice_status CHECK constraint allows`,
    );
  }

  // ── Cairo, not UTC ──────────────────────────────────────────────────────────
  // 22:30 UTC is already 01:30 the NEXT day in Cairo. A deadline of the 29th is therefore still
  // open at 20:30 UTC (23:30 Cairo, same day) and late at 22:30 UTC.
  assert.equal(
    currentCairoDateOnlyIso(new Date("2026-08-29T20:30:00Z")),
    "2026-08-29",
    "23:30 Cairo is still the 29th",
  );
  assert.equal(
    currentCairoDateOnlyIso(new Date("2026-08-29T22:30:00Z")),
    "2026-08-30",
    "01:30 Cairo is already the 30th — this is the hour a UTC clock gets wrong",
  );
  assert.equal(
    resolveMarketingInvoiceObligation(
      { invoiceDeadlineDate: "2026-08-29", invoiceStatus: "pending" },
      currentCairoDateOnlyIso(new Date("2026-08-29T20:30:00Z")),
    ).isOverdue,
    false,
    "at 23:30 Cairo on the deadline day the invoice is not yet late",
  );
  assert.equal(
    resolveMarketingInvoiceObligation(
      { invoiceDeadlineDate: "2026-08-29", invoiceStatus: "pending" },
      currentCairoDateOnlyIso(new Date("2026-08-29T22:30:00Z")),
    ).isOverdue,
    true,
    "half an hour later, in Cairo, it is",
  );

  // Every entry point must DEFAULT to Cairo's date, not the runtime clock's. The assertions above
  // inject `today`, so they would still pass if the default were `new Date().toISOString()` — and
  // the server runs in UTC, which is the environment that gets it wrong.
  const module_ = readFileSync(join(SRC, "lib/marketing-requests/invoice-obligation.ts"), "utf8");
  assert.equal(
    (module_.match(/today: string = currentCairoDateOnlyIso\(\)/g) ?? []).length,
    3,
    "all three entry points must default `today` to currentCairoDateOnlyIso — a UTC server is a day ahead after 22:00",
  );
  assert.ok(
    !/new Date\(\)\.toISOString\(\)/.test(module_),
    "no entry point may fall back to a raw UTC ISO date",
  );

  // ── The cell label: short, and it never wraps or ellipsises (owner rule) ────
  assert.equal(
    marketingInvoiceDueLabel({ invoiceDeadlineDate: "2026-08-11", invoiceStatus: "pending" }, "2026-08-29"),
    "18d late",
  );
  assert.equal(
    marketingInvoiceDueLabel({ invoiceDeadlineDate: "2026-09-02", invoiceStatus: "pending" }, "2026-09-02"),
    "Due today",
  );
  assert.equal(
    marketingInvoiceDueLabel({ invoiceDeadlineDate: "2026-09-02", invoiceStatus: "pending" }, "2026-08-29"),
    "2 Sep",
  );
  assert.equal(
    marketingInvoiceDueLabel({ invoiceDeadlineDate: null, invoiceStatus: "pending" }, "2026-08-29"),
    "-",
    "an undated obligation shows a dash, never an empty cell",
  );
  for (const today of ["2026-08-29", "2026-09-02", "2026-09-30"]) {
    const label = marketingInvoiceDueLabel({ invoiceDeadlineDate: "2026-09-02", invoiceStatus: "pending" }, today);
    assert.ok(label.length <= 9, `"${label}" must stay short enough for a narrow cell — no wrapping, no ellipsis`);
    assert.ok(!label.includes("…"), "the owner rule forbids an ellipsis anywhere in the UI");
  }

  // ── BOTH readers must go through this module ───────────────────────────────
  // This is the assertion that actually protects the invariant over time. The screen and the export
  // are built by two different files, and an export that disagrees with the screen breaks an owner
  // rule. Reading the raw column in either place silently reintroduces "Pending" on a late invoice.
  const reportService = readFileSync(join(SRC, "lib/marketing-requests/request-report-service.ts"), "utf8");
  assert.ok(
    reportService.includes("effectiveMarketingInvoiceStatus"),
    "the report export must resolve the effective status, not read invoice_status raw",
  );
  assert.ok(
    !/financeInvoiceStatus:\s*text\(financeRow,\s*"invoice_status"\)/.test(reportService),
    "the export must not go back to reading the stored column — that is exactly the bug this closes",
  );

  const service = readFileSync(join(SRC, "lib/marketing-requests/service.ts"), "utf8");
  const builderStart = service.indexOf("export function buildMarketingApprovedRequestRows");
  assert.ok(builderStart > 0, "the approved-request row builder must still exist");
  const builderEnd = service.indexOf("\nfunction buildRoiWindowLabel", builderStart);
  assert.ok(builderEnd > builderStart, "the builder must still be followed by buildRoiWindowLabel");
  const builder = service.slice(builderStart, builderEnd);
  assert.ok(
    builder.includes("resolveMarketingInvoiceObligation"),
    "the Approved Requests table must resolve the obligation rather than pass the stored status through",
  );
  assert.ok(
    builder.includes("invoiceDueLabel"),
    "the row must carry the short due label the table cell renders",
  );

  // The table cell and the mobile card must both key off the resolved count, not re-derive it.
  const table = readFileSync(join(SRC, "components/employee-portal/marketing-request-drafts.tsx"), "utf8");
  assert.ok(table.includes("Invoice due"), "the Approved Requests table must carry an Invoice due column");
  assert.ok(
    (table.match(/row\.invoiceDaysOverdue > 0/g) ?? []).length >= 2,
    "desktop table AND mobile card must both show the overdue state — mobile never gets a table here",
  );
  assert.ok(
    table.includes("whitespace-nowrap"),
    "the due cell must be pinned nowrap — the owner rule forbids wrapped text in the UI",
  );
}
