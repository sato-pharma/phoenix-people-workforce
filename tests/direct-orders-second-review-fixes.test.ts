import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  canAssignDirectOrderSalesMonth,
  canRecordDirectOrderCollection,
  deriveDirectOrderSalesMonthChange,
  DIRECT_ORDER_FINANCE_HR_ID,
} from "../src/lib/direct-orders/finance-authority.ts";
import { buildDirectOrderNeedsAction } from "../src/lib/direct-orders/needs-action.ts";
import type { AccessContext } from "../src/lib/auth/permissions.ts";

/**
 * Regression cover for the three functional defects the independent second review found
 * (2026-08-11), plus the architectural isolation that came with them.
 *
 *   Finding 1 — a RETURNED order could not be corrected and resubmitted as the same request.
 *   Finding 2 — Needs Action offered "Finish Draft" for a state nothing can create.
 *   Finding 5 — the sales month could be written onto an order nobody had approved.
 *   Finding 6 — Finance's authority was reachable from several call sites by HR_ID literal.
 *
 * Each block below fails loudly if the corresponding fix is reverted.
 */

function ctx(overrides: Partial<AccessContext>): AccessContext {
  return {
    hrId: DIRECT_ORDER_FINANCE_HR_ID,
    role: "Finance Manager",
    scope: "company",
    source: "session",
    ...overrides,
  };
}

export async function runDirectOrderSecondReviewFixTests() {
  // ── Finding 5: the sales month is approved-only, SERVER-SIDE ───────────────
  //
  // The injection RPC already filters `status = 'approved'`, so none of this could inject money
  // incorrectly. What it could do is leave a request row asserting a Finance decision no approval
  // chain ever authorised. UI hiding is not a guard; this is.
  for (const status of ["draft", "pending_approval", "returned", "held", "rejected", "expired", "cancelled"]) {
    const outcome = deriveDirectOrderSalesMonthChange({
      status,
      currentMonth: null,
      requestedMonth: "2026-07",
    });
    assert.equal(
      outcome.ok,
      false,
      `a sales month must be refused on a ${status} order — only an approved order can be booked`,
    );
  }

  const approvedAssign = deriveDirectOrderSalesMonthChange({
    status: "approved",
    currentMonth: null,
    requestedMonth: "2026-07",
  });
  assert.equal(approvedAssign.ok, true, "an approved order accepts a sales month");
  assert.equal(approvedAssign.ok && approvedAssign.nextMonth, "2026-07");

  // Format is still validated, and still before the status rule can be mistaken for a format rule.
  assert.equal(
    deriveDirectOrderSalesMonthChange({ status: "approved", currentMonth: null, requestedMonth: "July 2026" }).ok,
    false,
    "a malformed month is refused even on an approved order",
  );

  // Clearing stays possible wherever a month is actually stored, or a month stamped before this
  // guard existed — or left behind on a reversed order — would be unfixable through the product.
  assert.equal(
    deriveDirectOrderSalesMonthChange({ status: "reversed", currentMonth: "2026-07", requestedMonth: null }).ok,
    true,
    "a stored month can always be cleared, whatever the order's status",
  );
  assert.equal(
    deriveDirectOrderSalesMonthChange({ status: "pending_approval", currentMonth: null, requestedMonth: null }).ok,
    false,
    "clearing a month that was never set is refused rather than silently succeeding",
  );

  // ── Finding 6: Finance authority is an IDENTITY gate, isolated in one module ──
  assert.equal(canAssignDirectOrderSalesMonth(ctx({})), true, "Ahmed (B-185) may book a sales month");
  assert.equal(
    canAssignDirectOrderSalesMonth(ctx({ hrId: "b-185" })),
    true,
    "HR_ID matching is case-insensitive — a lower-cased session must not lose the duty",
  );
  assert.equal(
    canAssignDirectOrderSalesMonth(ctx({ hrId: "S-1", role: "Super Admin", scope: "system" })),
    true,
    "Super Admin may book a sales month",
  );
  // The sharpest guard here: the duty follows the PERSON, not the job title.
  assert.equal(
    canAssignDirectOrderSalesMonth(ctx({ hrId: "F-999", role: "Finance Manager" })),
    false,
    "a DIFFERENT Finance Manager must NOT inherit the sales-month duty — it is bound to an HR_ID",
  );
  assert.equal(
    canAssignDirectOrderSalesMonth(ctx({ hrId: "C-1", role: "CEO", scope: "company" })),
    false,
    "the CEO approves orders but never books the month",
  );
  assert.equal(
    canAssignDirectOrderSalesMonth(ctx({ hrId: "S-9", role: "SFE Manager", scope: "company" })),
    false,
    "SFE Manager can see the month but never set it",
  );

  // The literal must exist in exactly ONE place, or reassigning the duty means hunting for copies.
  const financeAuthoritySource = readFileSync(
    new URL("../src/lib/direct-orders/finance-authority.ts", import.meta.url),
    "utf8",
  );
  assert.ok(
    financeAuthoritySource.includes('DIRECT_ORDER_FINANCE_HR_ID = "B-185"'),
    "finance-authority.ts owns the HR_ID literal",
  );
  for (const file of ["collection-rules.ts", "service.ts"]) {
    const source = readFileSync(new URL(`../src/lib/direct-orders/${file}`, import.meta.url), "utf8");
    assert.ok(
      !source.includes('"B-185"'),
      `${file} must not re-declare the Finance HR_ID — it imports it from finance-authority.ts`,
    );
  }

  // Both duties remain SEPARATE predicates even though they resolve to the same person today.
  assert.equal(
    canRecordDirectOrderCollection(ctx({ hrId: "F-999", role: "Finance Manager" })),
    false,
    "recording a collection is bound to the same person, by the same rule",
  );

  // ── Finding 2: no phantom "Finish Draft" queue ─────────────────────────────
  const draftRow = {
    id: "00000000-0000-0000-0000-000000000001",
    requesterHrId: "B-1",
    requesterName: "A Requester",
    productName: "Tigogrow",
    pharmacyName: "Test Pharmacy",
    pharmacyCode: "DOP-000001",
    areaName: "Area 1",
    regionName: "Region 1",
    coveringRepName: null,
    qty: 10,
    salesValue: 100,
    submittedAt: "2026-08-01T00:00:00.000Z",
    createdAt: "2026-08-01T00:00:00.000Z",
    status: "draft",
    salesMonth: null,
    bonusOverCap: false,
  };
  const needsActionGroups = buildDirectOrderNeedsAction({
    myOrders: [draftRow],
    awaitingMyApproval: [],
    awaitingFinanceMonth: [],
    pendingCustomerValidations: 0,
    basePath: "/admin/direct-orders",
  });
  assert.ok(
    !needsActionGroups.some((g) => String(g.kind) === "finish_draft"),
    "a draft row must NOT produce a Needs Action group — nothing in the product can create or finish one",
  );
  assert.equal(
    needsActionGroups.length,
    0,
    "an inbox holding only a draft has nothing actionable in it at all",
  );

  // Checked against CODE, not prose: the comment explaining why the group is gone necessarily
  // names it, and an assertion that cannot tell a comment from a call site is one that will be
  // "fixed" by deleting the explanation.
  const needsActionCode = readFileSync(
    new URL("../src/lib/direct-orders/needs-action.ts", import.meta.url),
    "utf8",
  )
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  assert.ok(
    !needsActionCode.includes("finish_draft"),
    "the finish_draft kind must stay removed until real draft create/edit/submit paths exist",
  );

  // ── Finding 1: returned orders are corrected as the SAME request ───────────
  const serviceSource = readFileSync(new URL("../src/lib/direct-orders/service.ts", import.meta.url), "utf8");

  assert.ok(
    serviceSource.includes("export async function reviseDirectOrder"),
    "reviseDirectOrder must exist — a returned order needs a way back into its own chain",
  );

  const revise = serviceSource.slice(
    serviceSource.indexOf("export async function reviseDirectOrder"),
    serviceSource.indexOf("// ── Decide (approve / reject / return)"),
  );

  // It must UPDATE the existing row, never INSERT a replacement. This is the whole defect.
  assert.ok(
    revise.includes('.update({') && revise.includes('.eq("id", before.id)'),
    "reviseDirectOrder must UPDATE the same request row",
  );
  assert.ok(
    !revise.includes('.from("direct_order_requests")\n    .insert('),
    "reviseDirectOrder must never insert a second order as the correction mechanism",
  );

  // It must not touch the approval ledger — history and the resumed rung both depend on that.
  assert.ok(
    !revise.includes('from("direct_order_approval_steps")'),
    "reviseDirectOrder must not rebuild or modify the approval chain — the returned rung is still pending",
  );

  // Compare-and-swap on `returned`, so two tabs cannot both resubmit.
  assert.ok(
    revise.includes('.eq("status", "returned")'),
    "the update must be conditional on the row still being returned",
  );

  // The registry check must pass the row's REAL status, which is what finally exercises the
  // `from: ["draft","returned"]` the registry has declared since the foundation migration.
  assert.ok(
    revise.includes("status: before.status"),
    "the workflow-registry check must use the row's real status, not a hard-coded literal",
  );
  assert.ok(
    revise.includes('actionKey: "submit"') && revise.includes('expectedNextStatus: "pending_approval"'),
    "correcting a returned order is the registry's `submit` action returning it to pending_approval",
  );

  // Ownership, status precondition and an explanation to the approver are all required.
  assert.ok(
    revise.includes('before.status !== "returned"'),
    "only a returned order can be corrected",
  );
  assert.ok(
    revise.includes("canonicalHrIdKey(before.requesterHrId)"),
    "only the person who raised the order may answer the return",
  );
  assert.ok(
    revise.includes("correctionNote"),
    "a correction must say what changed, mirroring the approver's required return reason",
  );

  // Product and pharmacy are identity, not detail — a correction must not silently move either.
  assert.ok(
    revise.includes("before.productCode"),
    "the product is re-resolved from the stored code, never taken from the caller",
  );

  // And the money must go through the one shared pricing helper, not a second copy of the rules.
  assert.ok(
    revise.includes("resolveDirectOrderPricing"),
    "a correction must be repriced through the SAME helper submitDirectOrder uses",
  );
  assert.ok(
    serviceSource.includes("async function resolveDirectOrderPricing"),
    "the shared pricing helper must exist",
  );

  console.log("  direct-orders second-review fixes: findings 1, 2, 5, 6 all covered");
}
