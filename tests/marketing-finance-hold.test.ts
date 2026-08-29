import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  canPlaceMarketingRequestOnFinanceHold,
  canReleaseMarketingRequestFromFinanceHold,
  MARKETING_FINANCE_HOLD_STATUS,
  nextInvoiceStatusOnHold,
  nextInvoiceStatusOnRelease,
} from "@/lib/marketing-requests/finance-hold";

// `finance_hold` was a status the lifecycle could DESCRIBE and never ENTER.
//
// The database constraint permitted it, five screens carried a label for it, and
// `approvedMarketingRequestStatuses` counted it as approved — but no code anywhere wrote it.
// Measured in production 2026-08-29: zero rows had ever held it, and only four of the eleven
// declared statuses had ever occurred at all.
//
// #2680 made it decidable by creating the first invoice obligations that had ever existed (4, one
// already 18 days late); #2686 made lateness visible. The owner's rule for acting on it, given the
// same day, is the rule expenses run under: the system FLAGS, a human decides.
//
// These pin what makes that rule true rather than merely intended.

const MODULE_PATH = join(process.cwd(), "src/lib/marketing-requests/finance-hold.ts");

export function runMarketingFinanceHoldTests() {
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

  // ── The hold silences the overdue marker, and never resurrects a settled invoice ─
  //
  // A hold IS a deliberate pause, which is the one state invoice-obligation.ts excludes from going
  // overdue. Pausing the obligation is therefore what stops the tab and the export saying "18d
  // late" about a request whose lateness is the acknowledged reason it is frozen.

  assert.equal(nextInvoiceStatusOnHold("pending"), "hold", "holding pauses an invoice that is still owed");
  assert.equal(nextInvoiceStatusOnHold("overdue"), "hold", "a stored overdue still means owed, so it pauses too");
  assert.equal(nextInvoiceStatusOnRelease("hold"), "pending", "releasing lets the marker resume");

  // The dangerous direction, and not a hypothetical one: production carries an `active` request
  // whose invoice is already `submitted` (measured 2026-08-29). A hold placed on it for some other
  // reason must leave that alone — and the release must not then set it to `pending`, which would
  // manufacture a debt that had already been settled and put a paid request back on the queue.
  for (const settled of ["submitted", "cleared", "not_required"]) {
    assert.equal(
      nextInvoiceStatusOnHold(settled),
      null,
      `a "${settled}" invoice has been dealt with — holding the request must not mark it paused`,
    );
    assert.equal(
      nextInvoiceStatusOnRelease(settled),
      null,
      `releasing must not rewrite a "${settled}" invoice back to pending`,
    );
  }

  assert.equal(nextInvoiceStatusOnHold("hold"), null, "an already-paused invoice needs no second pause");
  assert.equal(nextInvoiceStatusOnRelease("pending"), null, "a live obligation is not something a release resumes");

  const source = readFileSync(MODULE_PATH, "utf8");

  // ── Lateness is defined in exactly ONE place ───────────────────────────────────
  //
  // This module had its own copy of the overdue rule before #2686 landed one. Two definitions on a
  // money module do not fail loudly: they agree until a boundary case, and then the queue an admin
  // acts on disagrees with the screen he read it on, with neither obviously wrong. The owner's rule
  // that an export must match the screen is the same rule one directory up.
  assert.ok(
    source.includes("resolveMarketingInvoiceObligation"),
    "the hold queue must derive lateness from the shared obligation module",
  );
  for (const localDateArithmetic of ["86_400_000", "Date.parse("]) {
    assert.ok(
      !source.includes(localDateArithmetic),
      `finance-hold.ts must not re-derive deadlines itself (found ${localDateArithmetic}) — `
      + "a second definition of overdue is what invoice-obligation.ts exists to prevent",
    );
  }

  // ── The reason is durable BEFORE the hold is ───────────────────────────────────
  //
  // A Supabase client request that times out at 15s still COMMITS, so a two-write mutation can
  // half-apply with no error at all. Ordered reason-then-status, the only reachable half-state is a
  // recorded reason on a request that was never held: inert and visible. Reversed, it is a request
  // frozen on a live money module with nobody able to say why — and nothing would report it.
  //
  // Matched on call ORDER rather than a byte window, so reformatting the file cannot false-fail it.
  for (const action of ["placeMarketingRequestOnFinanceHold", "releaseMarketingRequestFromFinanceHold"]) {
    const start = source.indexOf(`export async function ${action}`);
    assert.ok(start >= 0, `${action} must exist`);
    const body = source.slice(start);
    const reviewAt = body.indexOf("recordFinanceReview(");
    const statusAt = body.indexOf("applyHoldStatus(");
    assert.ok(reviewAt >= 0, `${action} must record the reason`);
    assert.ok(statusAt >= 0, `${action} must apply the status`);
    assert.ok(
      reviewAt < statusAt,
      `${action} must write the reason BEFORE the status — reversed, a timeout leaves a request `
      + "held with no recorded reason",
    );
  }

  // ── The actor is written in the casing the database stores ────────────
  //
  // Both writes land in columns with a foreign key to employees(hr_id), and that column is MIXED
  // CASE: 178 of 179 production rows carry an uppercase letter. resolveEmployeeIdentityId lowercases,
  // so its result matches essentially nobody and the database refuses the write.
  //
  // This is measured, not predicted. Running the real path against production on 2026-08-29 failed
  // with `23503 ... Key (finance_reviewer_hr_id)=(b-10) is not present in table "employees"` -- the
  // owner's own id, stored `B-10`. The feature shipped green, deployed cleanly, and could be used by
  // nobody; only exercising it end to end found that, which is why this assertion exists rather than
  // a comment saying to be careful.
  assert.ok(
    source.includes("resolveCanonicalActorHrId"),
    "the actor must be resolved to its STORED hr_id casing -- a normalized id fails the employees "
    + "foreign key for 178 of 179 people",
  );
  const actorFn = source.slice(source.indexOf("async function assertHoldActor"));
  assert.ok(
    actorFn.slice(0, actorFn.indexOf("\n}")).includes("resolveCanonicalActorHrId"),
    "assertHoldActor itself must return the canonical hr_id, not the normalized identity",
  );

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
