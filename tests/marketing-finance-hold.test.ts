import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  canPlaceMarketingRequestOnFinanceHold,
  canReleaseMarketingRequestFromFinanceHold,
  classifyMarketingInvoiceOverdue,
  MARKETING_FINANCE_HOLD_STATUS,
} from "@/lib/marketing-requests/finance-hold";

// `finance_hold` was a status the lifecycle could DESCRIBE and never ENTER.
//
// The database constraint permitted it, five screens carried a label for it, and
// `approvedMarketingRequestStatuses` counted it as approved — but no code anywhere wrote it.
// Measured in production 2026-08-29: zero rows had ever held it, and only four of the eleven
// declared statuses had ever occurred at all.
//
// #2680 made it decidable by creating the first invoice obligations that had ever existed (4, one
// already 18 days late). The owner's rule for acting on them, given the same day, is the rule
// expenses run under: the system FLAGS, a human decides.
//
// These pin the two things that make that rule true rather than merely intended — the flag never
// fires on an invoice that was actually delivered, and the reason is durable before the hold is.

const MODULE_PATH = join(process.cwd(), "src/lib/marketing-requests/finance-hold.ts");

export function runMarketingFinanceHoldTests() {
  // ── The flag: late means late, and delivered never does ────────────────────────

  assert.deepEqual(
    classifyMarketingInvoiceOverdue({
      invoiceDeadlineDate: "2026-08-11",
      invoiceRequired: true,
      invoiceStatus: "pending",
      today: "2026-08-29",
    }),
    { daysOverdue: 18 },
    "an invoice still owed past its deadline is overdue by whole days",
  );

  assert.equal(
    classifyMarketingInvoiceOverdue({
      invoiceDeadlineDate: "2026-09-02",
      invoiceRequired: true,
      invoiceStatus: "pending",
      today: "2026-08-29",
    }),
    null,
    "an invoice owed but not yet due is not overdue",
  );

  assert.equal(
    classifyMarketingInvoiceOverdue({
      invoiceDeadlineDate: "2026-08-29",
      invoiceRequired: true,
      invoiceStatus: "pending",
      today: "2026-08-29",
    }),
    null,
    "the deadline DAY is not yet late — a hold on the due date would be a day early",
  );

  // The dangerous direction. A request whose invoice has already been delivered must never be
  // flagged: holding it would freeze a request that owes nothing, and the admin acting on the queue
  // has no way to see that the flag was wrong.
  for (const settled of ["submitted", "cleared", "not_required"]) {
    assert.equal(
      classifyMarketingInvoiceOverdue({
        invoiceDeadlineDate: "2026-08-01",
        invoiceRequired: true,
        invoiceStatus: settled,
        today: "2026-08-29",
      }),
      null,
      `an invoice in "${settled}" has been dealt with and must never be flagged as overdue`,
    );
  }

  assert.equal(
    classifyMarketingInvoiceOverdue({
      invoiceDeadlineDate: "2026-08-01",
      invoiceRequired: false,
      invoiceStatus: "pending",
      today: "2026-08-29",
    }),
    null,
    "a request that owes no invoice cannot be overdue on one",
  );

  assert.equal(
    classifyMarketingInvoiceOverdue({
      invoiceDeadlineDate: null,
      invoiceRequired: true,
      invoiceStatus: "pending",
      today: "2026-08-29",
    }),
    null,
    "an obligation with no deadline has nothing to be late against",
  );

  // ── Which requests may be held, and which released ─────────────────────────────

  for (const holdable of ["approved", "active"]) {
    assert.ok(
      canPlaceMarketingRequestOnFinanceHold(holdable),
      `"${holdable}" means the money is committed, so it can be held`,
    );
  }

  for (const notHoldable of ["draft", "pending_approval", "rejected", "returned", "closed", "archived"]) {
    assert.ok(
      !canPlaceMarketingRequestOnFinanceHold(notHoldable),
      `"${notHoldable}" carries no live obligation and must not be holdable`,
    );
  }

  assert.ok(
    canReleaseMarketingRequestFromFinanceHold(MARKETING_FINANCE_HOLD_STATUS),
    "a held request can be released",
  );
  assert.ok(
    !canReleaseMarketingRequestFromFinanceHold("approved"),
    "releasing a request that was never held would silently rewrite its status",
  );

  // ── The reason is durable BEFORE the hold is ───────────────────────────────────
  //
  // A Supabase client request that times out at 15s still COMMITS, so a two-write mutation can
  // half-apply with no error at all. Ordered reason-then-status, the only reachable half-state is a
  // recorded reason on a request that was never held: inert and visible. Reversed, it is a request
  // frozen on a live money module with nobody able to say why — and nothing would report it.
  //
  // Matched on call ORDER rather than a byte window, so reformatting the file cannot false-fail it.
  const source = readFileSync(MODULE_PATH, "utf8");
  for (const action of ["placeMarketingRequestOnFinanceHold", "releaseMarketingRequestFromFinanceHold"]) {
    const start = source.indexOf(`export async function ${action}`);
    assert.ok(start >= 0, `${action} must exist`);
    const body = source.slice(start);
    const reasonAt = body.indexOf("recordHoldReason(");
    const statusAt = body.indexOf("applyHoldStatus(");
    assert.ok(reasonAt >= 0, `${action} must record the reason`);
    assert.ok(statusAt >= 0, `${action} must apply the status`);
    assert.ok(
      reasonAt < statusAt,
      `${action} must write the reason BEFORE the status — reversed, a timeout leaves a request `
      + "held with no recorded reason",
    );
  }

  // ── Nothing here moves a request on its own ────────────────────────────────────
  //
  // The owner rejected auto-holding explicitly: the system flags, a human decides. The status is
  // written in exactly two places, both reached only from a hand action behind a Super Admin gate.
  const statusWrites = source.split("applyHoldStatus({").length - 1;
  assert.equal(
    statusWrites,
    2,
    "the status may be written only by the two hand actions — a third caller is an auto-transition, "
    + "which is the shape the owner rejected",
  );
}
