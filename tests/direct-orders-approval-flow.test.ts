import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  computeDirectOrderSalesValue,
  computeDiscountSalesValue,
  directOrderExpectedRoleChain,
  directOrderExpectedStepCount,
  directOrderManagementLadder,
  evaluateStepAction,
  maxBonusUnits,
  resolveActionAvailability,
  resolveActiveStep,
  validateBonus,
  validateDiscount,
} from "../src/lib/direct-orders/approval-flow.ts";
import type { DirectOrderStepState } from "../src/lib/direct-orders/types.ts";

function steps(...defs: Array<Partial<DirectOrderStepState> & { order: number; status: DirectOrderStepState["status"] }>): DirectOrderStepState[] {
  return defs.map((d) => ({
    order: d.order,
    kind: d.kind ?? "person",
    role: d.role ?? null,
    approverHrId: d.approverHrId ?? `MGR-${d.order}`,
    label: d.label ?? `Level ${d.order}`,
    status: d.status,
  }));
}

export function runDirectOrdersApprovalFlowTests() {
  // ── Single-request READ is scope-gated, not permission-gated ────────────────
  // `direct_orders:read` is held by every requester role (District / Regional / Product Manager …),
  // so asserting the permission alone let any of them fetch ANY order company-wide by id — requester,
  // pharmacy, doctor, quantities, factory/public price, bonus/discount and sales value. The guard must
  // live inside getDirectOrderRequest (the single read choke point) and run BEFORE the value is
  // returned, so every present and future caller inherits it.
  {
    const serviceSource = readFileSync(new URL("../src/lib/direct-orders/service.ts", import.meta.url), "utf8");
    assert.match(serviceSource, /async function canViewDirectOrderRequest\(/, "a per-request scope guard must exist");

    const readerIdx = serviceSource.indexOf("export async function getDirectOrderRequest(");
    assert.ok(readerIdx > -1, "getDirectOrderRequest must still be the single read entrypoint");
    const readerBody = serviceSource.slice(readerIdx, readerIdx + 1600);
    assert.match(
      readerBody,
      /if \(!\(await canViewDirectOrderRequest\(access, request, steps\)\)\) return null;/,
      "getDirectOrderRequest must consult the scope guard and return null (not throw) for an out-of-scope id, so ids cannot be probed",
    );

    // The guard must admit an assigned approver: someone who has to DECIDE a request must be able to
    // open it even when the requester sits outside their own reporting subtree.
    const guardIdx = serviceSource.indexOf("async function canViewDirectOrderRequest(");
    const guardBody = serviceSource.slice(guardIdx, serviceSource.indexOf("export async function getDirectOrderRequest(", guardIdx));
    assert.match(guardBody, /resolveDirectOrderReportScope\(access\) === "all"/, "company-tier roles keep full read");
    assert.match(guardBody, /step\.approverHrId/, "an assigned approver must always be able to open the request");
    assert.match(guardBody, /resolveVisibleRequesterHrIds\(access\)/, "subtree tier must reuse the report's visible-requester set");
  }

  // The report's subtree walk must be seat-continuity aware, or a district's orders vanish while its
  // DSM seat is being replaced (the resignation trigger reassigns reports UPWARD and stamps
  // pending_manager_replacement_for_hr_id).
  {
    const serviceSource = readFileSync(new URL("../src/lib/direct-orders/service.ts", import.meta.url), "utf8");
    const walkIdx = serviceSource.indexOf("async function resolveVisibleRequesterHrIds(");
    const walkBody = serviceSource.slice(walkIdx, walkIdx + 1600);
    assert.match(walkBody, /pendingManagerReplacementForHrId/, "the walk must follow the vacant-seat continuity edge too");
    assert.match(walkBody, /resolveEmployeeIdentityId\(access\)/, "the viewer must be resolved by employee identity, not the raw session hrId");
  }

  // ── Ladder per requester role (owner-locked) ────────────────────────────────
  assert.deepEqual(directOrderManagementLadder("District Manager"), ["Regional Manager", "National Sales Manager"]);
  assert.deepEqual(directOrderManagementLadder("Regional Manager"), ["National Sales Manager"]);
  assert.deepEqual(directOrderManagementLadder("National Sales Manager"), []);
  assert.deepEqual(directOrderManagementLadder("Product Manager"), []);
  assert.deepEqual(directOrderManagementLadder("Group Product Manager"), []);

  // Every chain ends at the CEO.
  assert.deepEqual(directOrderExpectedRoleChain("District Manager"), ["Regional Manager", "National Sales Manager", "CEO"]);
  assert.deepEqual(directOrderExpectedRoleChain("Product Manager"), ["CEO"]);
  assert.equal(directOrderExpectedStepCount("District Manager"), 3);
  assert.equal(directOrderExpectedStepCount("Regional Manager"), 2);
  assert.equal(directOrderExpectedStepCount("National Sales Manager"), 1);
  assert.equal(directOrderExpectedStepCount("Group Product Manager"), 1);

  // ── Bonus cap: config-driven percentage (25% default, 30% for an Ivyronc override) ──
  assert.equal(maxBonusUnits({ qty: 100, capPct: 25 }), 25);
  assert.equal(maxBonusUnits({ qty: 200, capPct: 25 }), 50);
  assert.equal(maxBonusUnits({ qty: 100, capPct: 30 }), 30);
  assert.equal(maxBonusUnits({ qty: 200, capPct: 30 }), 60);
  assert.equal(maxBonusUnits({ qty: 90, capPct: 25 }), 22); // floor(22.5)

  assert.equal(validateBonus({ qty: 100, bonus: 25, capPct: 25 }).withinCap, true);
  assert.equal(validateBonus({ qty: 100, bonus: 26, capPct: 25 }).withinCap, false);
  assert.equal(validateBonus({ qty: 100, bonus: 30, capPct: 30 }).withinCap, true);
  assert.equal(validateBonus({ qty: 100, bonus: 31, capPct: 30 }).withinCap, false);

  // ── Discount cap + value ────────────────────────────────────────────────────
  assert.equal(validateDiscount({ discountPct: 25, capPct: 25 }).withinCap, true);
  assert.equal(validateDiscount({ discountPct: 26, capPct: 25 }).withinCap, false);
  // owner example: 100 Roya × public 92 = 9200 gross → 25% off → 6900
  assert.equal(computeDiscountSalesValue({ qty: 100, publicPrice: 92, discountPct: 25 }), 6900);
  assert.equal(computeDiscountSalesValue({ qty: 100, publicPrice: 92, discountPct: 0 }), 9200);

  // ── Bonus-mode value = qty × PHARMACY price, bonus NEVER counted ────────────
  // Owner change 2026-08-03: bonus deals moved off the factory price onto a per-product
  // "pharmacy price". Discount deals (asserted just above) are deliberately UNCHANGED.
  assert.equal(computeDirectOrderSalesValue({ qty: 100, pharmacyPrice: 111.15 }), 11115);
  assert.equal(computeDirectOrderSalesValue({ qty: 0, pharmacyPrice: 50 }), 0);
  assert.equal(computeDirectOrderSalesValue({ qty: 200, pharmacyPrice: 30.375 }), 6075);
  // The parameter is pharmacyPrice, not factoryPrice. `pnpm typecheck` is the real guard
  // against a stale caller; this pins the RUNTIME consequence — 0, i.e. visibly wrong rather
  // than plausibly wrong, so a missed call site can never quietly bill the old basis.
  assert.equal(
    computeDirectOrderSalesValue({ qty: 100, factoryPrice: 90 } as unknown as { qty: number; pharmacyPrice: number }),
    0,
  );
  // The two modes must not share a price source.
  assert.notEqual(
    computeDiscountSalesValue({ qty: 100, publicPrice: 92, discountPct: 0 }),
    computeDirectOrderSalesValue({ qty: 100, pharmacyPrice: 80 }),
  );

  // ── Over cap FLAGS, it never blocks (owner rule, 2026-08-03) ────────────────
  {
    const serviceSource = readFileSync(new URL("../src/lib/direct-orders/service.ts", import.meta.url), "utf8");
    assert.doesNotMatch(
      serviceSource,
      /only the CEO can approve it/,
      "the CEO-only finalization gate must be gone — an over-cap order is flagged, never rejected",
    );
    assert.doesNotMatch(serviceSource, /exceeds the cap; only/, "no cap-based badRequest may remain");
    // …but removing the BLOCK must not remove the FLAG or its accountability trail.
    assert.match(serviceSource, /function isRequestOverCap\(/, "the over-cap flag itself must survive");
    assert.match(
      serviceSource,
      /over_cap_finalized/,
      "finalizing an over-cap order must still be recorded as an event — the audit replaced the gate",
    );
  }

  // ── A missing pharmacy price falls back and flags; it never blocks ──────────
  {
    const serviceSource = readFileSync(new URL("../src/lib/direct-orders/service.ts", import.meta.url), "utf8");
    const submitIdx = serviceSource.indexOf("export async function submitDirectOrder(");
    assert.ok(submitIdx > -1, "submitDirectOrder must still exist");
    const submitBody = serviceSource.slice(submitIdx, serviceSource.indexOf("// ── Decide", submitIdx));

    assert.match(
      submitBody,
      /select\("public_price, pharmacy_price"\)/,
      "both money inputs must be read FRESH from the table — listSourceOfSalesProducts is unstable_cache'd for 600s and no price setter busts it",
    );
    assert.match(submitBody, /pharmacy_price_snapshot/, "the pricing basis must be snapshotted onto the request");

    // The bonus branch must contain NO badRequest at all. Checked on the branch body rather than
    // by pattern-matching a message, because a block can be written either side of the value line
    // and either order would read as "no pharmacy price … badRequest".
    const bonusBranch = submitBody.slice(
      submitBody.indexOf("// Bonus: value = qty × PHARMACY price"),
      submitBody.indexOf("// Load the pharmacy in full"),
    );
    assert.ok(bonusBranch.length > 0, "the bonus pricing branch must still be identifiable");
    assert.doesNotMatch(
      bonusBranch,
      /badRequest/,
      "a missing pharmacy price must fall back and flag, never block — the bonus branch may not refuse anything",
    );
    assert.match(bonusBranch, /pharmacyPrice \?\? product\.factoryPrice/, "the fallback basis is the factory price");
    assert.match(
      serviceSource,
      /function isFallbackPricedRequest\(/,
      "the missing-price flag must be derived from the SNAPSHOT, so it keeps telling the truth after the product master changes",
    );
  }

  // ── The xlsx column list and the row builder are positional twins ───────────
  // They have no compile-time link: adding to one and not the other silently shifts every
  // later column in the owner's export, so the header would sit above the wrong data.
  {
    const workbookSource = readFileSync(new URL("../src/lib/direct-orders/report-workbook.ts", import.meta.url), "utf8");
    const columnsBlock = workbookSource.slice(
      workbookSource.indexOf("export const DIRECT_ORDER_REPORT_COLUMNS"),
      workbookSource.indexOf("export function directOrderReportRowCells"),
    );
    const rowsBlock = workbookSource.slice(
      workbookSource.indexOf("export function directOrderReportRowCells"),
      workbookSource.indexOf("export async function buildDirectOrdersReportWorkbook"),
    );
    const columnCount = (columnsBlock.match(/\{ label: "/g) ?? []).length;
    const cellCount = (rowsBlock.match(/^\s{4}row\./gm) ?? []).length;
    assert.equal(
      columnCount,
      cellCount,
      `the xlsx column list (${columnCount}) and the row builder (${cellCount}) must stay the same length`,
    );
    assert.match(columnsBlock, /\{ label: "Pharmacy price"/, "the report must expose the pharmacy price");
    assert.match(rowsBlock, /row\.pharmacyPriceSnapshot/, "the row builder must emit the pharmacy price");
  }

  // ── resolveActiveStep ───────────────────────────────────────────────────────
  const chain = steps(
    { order: 1, status: "approved" },
    { order: 2, status: "pending" },
    { order: 3, status: "pending", kind: "role", role: "CEO", approverHrId: null, label: "CEO" },
  );
  assert.equal(resolveActiveStep(chain)?.order, 2);
  assert.equal(resolveActiveStep(steps({ order: 1, status: "approved" }, { order: 2, status: "approved" })), null);

  // ── Sequential gating ───────────────────────────────────────────────────────
  // Order-2 cannot act while order-1 is still pending.
  const fresh = steps(
    { order: 1, status: "pending" },
    { order: 2, status: "pending" },
    { order: 3, status: "pending", kind: "role", role: "CEO" },
  );
  assert.equal(evaluateStepAction({ steps: fresh, actorOrder: 2, decision: "approve" }).allowed, false);
  const l1 = evaluateStepAction({ steps: fresh, actorOrder: 1, decision: "approve" });
  assert.equal(l1.allowed, true);
  assert.equal(l1.nextStatus, "pending_approval");
  assert.equal(l1.isFinal, false);

  // After 1 & 2 approved, CEO approve finalizes.
  const atCeo = steps(
    { order: 1, status: "approved" },
    { order: 2, status: "approved" },
    { order: 3, status: "pending", kind: "role", role: "CEO" },
  );
  const ceo = evaluateStepAction({ steps: atCeo, actorOrder: 3, decision: "approve" });
  assert.equal(ceo.allowed, true);
  assert.equal(ceo.nextStatus, "approved");
  assert.equal(ceo.isFinal, true);

  // Reject is terminal; return sends back.
  assert.equal(evaluateStepAction({ steps: fresh, actorOrder: 1, decision: "reject" }).nextStatus, "rejected");
  assert.equal(evaluateStepAction({ steps: fresh, actorOrder: 1, decision: "reject" }).isFinal, true);
  assert.equal(evaluateStepAction({ steps: fresh, actorOrder: 1, decision: "return" }).nextStatus, "returned");
  assert.equal(evaluateStepAction({ steps: fresh, actorOrder: 1, decision: "return" }).isFinal, false);

  // Single-rung (PM/GPM/NSM → CEO): approving the only rung finalizes.
  const single = steps({ order: 1, status: "pending", kind: "role", role: "CEO", approverHrId: null });
  const only = evaluateStepAction({ steps: single, actorOrder: 1, decision: "approve" });
  assert.equal(only.nextStatus, "approved");
  assert.equal(only.isFinal, true);

  // Already-decided step cannot act again.
  assert.equal(evaluateStepAction({ steps: atCeo, actorOrder: 1, decision: "approve" }).allowed, false);

  // ── Button availability ─────────────────────────────────────────────────────
  const availActive = resolveActionAvailability({ status: "pending_approval", steps: fresh, actorOrder: 1 });
  assert.equal(availActive.approve.enabled, true);
  const availBlocked = resolveActionAvailability({ status: "pending_approval", steps: fresh, actorOrder: 2 });
  assert.equal(availBlocked.approve.enabled, false);
  const availClosed = resolveActionAvailability({ status: "approved", steps: atCeo, actorOrder: 3 });
  assert.equal(availClosed.approve.enabled, false);
  const availReturned = resolveActionAvailability({ status: "returned", steps: fresh, actorOrder: 1 });
  assert.equal(availReturned.approve.enabled, false);
}
