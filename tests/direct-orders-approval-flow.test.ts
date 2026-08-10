import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  computeDirectOrderSalesValue,
  computeDiscountSalesValue,
  directOrderExpectedRoleChain,
  directOrderExpectedStepCount,
  directOrderManagementLadder,
  evaluateStepAction,
  isLegacySystemAdminAckStep,
  isPharmacyConfirmingStep,
  maxBonusUnits,
  resolveActionAvailability,
  resolveActiveStep,
  validateBonus,
  validateDiscount,
} from "../src/lib/direct-orders/approval-flow.ts";
import { directOrderReportRowCells } from "../src/lib/direct-orders/report-columns.ts";
import type { DirectOrderReportRow, DirectOrderStepState } from "../src/lib/direct-orders/types.ts";

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

  // The MANAGEMENT ladder above is the sales line only — it deliberately excludes both the
  // opening SFE rung and the closing CEO rung. The full chain (SFE + line + CEO) is asserted
  // in its own block further down.

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

  // ── SFE Manager validates FIRST, on every chain (owner rule, 2026-08-03) ───
  {
    for (const role of [
      "District Manager",
      "Regional Manager",
      "National Sales Manager",
      "Product Manager",
      "Group Product Manager",
    ] as const) {
      const chain = directOrderExpectedRoleChain(role);
      assert.equal(chain[0], "SFE Manager", `${role}'s chain must OPEN with SFE validation`);
      assert.equal(chain[chain.length - 1], "CEO", `${role}'s chain must still END at the CEO`);
      // Checked HERE, before the deep-equals below, so that re-adding the rung fails on this
      // named assertion rather than on a positional diff that says nothing about why it matters
      // (owner rule, 2026-08-04: "remove the super admin from the approval workflow").
      assert.ok(
        !chain.includes("Super Admin"),
        `${role}: Super Admin must never appear in a direct-order approval chain`,
      );
    }
    // The sales line still sits between SFE and the CEO, in order.
    assert.deepEqual(directOrderExpectedRoleChain("District Manager"), [
      "SFE Manager",
      "Regional Manager",
      "National Sales Manager",
      "CEO",
    ]);
    assert.deepEqual(directOrderExpectedRoleChain("Product Manager"), ["SFE Manager", "CEO"]);
    // Every chain grew by exactly one rung.
    assert.equal(directOrderExpectedStepCount("District Manager"), 4);
    assert.equal(directOrderExpectedStepCount("Regional Manager"), 3);
    assert.equal(directOrderExpectedStepCount("National Sales Manager"), 2);
    assert.equal(directOrderExpectedStepCount("Product Manager"), 2);
    assert.equal(directOrderExpectedStepCount("Group Product Manager"), 2);

    // ── Super Admin is NOT in the approval chain, ever ───────────────────────
    // (owner rule, 2026-08-04: "remove the super admin from the approval workflow of the direct
    // orders", superseding the System Admin ack rung added earlier the same day.)
    //
    // The pharmacy no longer changes the SHAPE of the chain at all — an unrecognised pharmacy
    // gets the identical rungs, because confirming it rides on the mandatory SFE rung instead of
    // a rung of its own. This is the assertion that fails if anyone re-inserts the rung.
    for (const role of [
      "District Manager",
      "Regional Manager",
      "National Sales Manager",
      "Product Manager",
      "Group Product Manager",
    ] as const) {
      assert.ok(
        !directOrderExpectedRoleChain(role).includes("Super Admin"),
        `${role}: Super Admin must never appear in a direct-order approval chain`,
      );
    }
    assert.deepEqual(
      directOrderExpectedRoleChain("District Manager"),
      ["SFE Manager", "Regional Manager", "National Sales Manager", "CEO"],
      "the chain is SFE → sales line → CEO, with no acknowledgment rung wedged into it",
    );

    // The LEGACY rung is still RECOGNISED — in-flight requests chained before the rule change
    // still carry one, and approving it must still confirm the pharmacy rather than strand it.
    // Identified by KIND as well as role: a person rung whose occupant happens to be a Super
    // Admin is an ordinary manager and must not silently verify the pharmacy.
    assert.ok(isLegacySystemAdminAckStep({ kind: "role", role: "Super Admin" }));
    assert.ok(
      !isLegacySystemAdminAckStep({ kind: "person", role: "Super Admin" }),
      "a person rung is not the ack rung",
    );
    assert.ok(!isLegacySystemAdminAckStep({ kind: "role", role: "CEO" }));

    // Both the current confirming rung (SFE) and the legacy one confirm the pharmacy.
    assert.ok(isPharmacyConfirmingStep({ kind: "role", role: "SFE Manager" }), "SFE confirms today");
    assert.ok(isPharmacyConfirmingStep({ kind: "role", role: "Super Admin" }), "legacy rung still confirms");
    assert.ok(
      !isPharmacyConfirmingStep({ kind: "role", role: "CEO" }),
      "the CEO rung must not be the thing that confirms a pharmacy — that was the failure mode",
    );
    assert.ok(
      !isPharmacyConfirmingStep({ kind: "person", role: null }),
      "an ordinary manager rung must never confirm a pharmacy",
    );

    // A role rung must be actionable BY ROLE. The service used to special-case the CEO only,
    // which would have left the new SFE rung actionable by nobody at all.
    const serviceSource = readFileSync(new URL("../src/lib/direct-orders/service.ts", import.meta.url), "utf8");
    assert.doesNotMatch(
      serviceSource,
      /isCeoStep\(activeStep\)\s*\n?\s*\?\s*access\.role === "CEO"/,
      "authorization must match on the rung's KIND, not on the CEO specifically",
    );
    assert.match(
      serviceSource,
      /activeStep\.kind === "role"/,
      "the decide path must resolve any role rung, not just the CEO's",
    );
  }

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
    // SUPERSEDED RULE (owner ruling, 2026-08-04). This block previously asserted the opposite —
    // "a missing pharmacy price must fall back and flag, never block". The owner has since ruled
    // that a direct order is priced on the pharmacy price or the public price and NEVER on the
    // factory price, so there is no basis left to fall back to: a missing pharmacy price is now
    // refused, exactly as the discount branch refuses a missing public price. The old fallback
    // also produced genuinely valueless orders — Tigogrow (TG001) and Osteosat (OS001) carry
    // neither price, so a bonus order on either submitted at 0 EGP and reached the CEO.
    // Bound to the CONDITION, not merely to the presence of the word `badRequest`: an earlier
    // version of this assertion matched /badRequest/ alone and still passed when the guard was
    // neutered to `if (false)`, which is precisely the failure a regression test exists to catch.
    assert.match(
      bonusBranch,
      /if \(pharmacyPrice == null\) \{[\s\S]{0,240}badRequest\(/,
      "a bonus deal with no pharmacy price must be REFUSED — there is no factory-price fallback any more",
    );
    assert.doesNotMatch(
      bonusBranch,
      /factoryPrice/,
      "the factory price must never be a pricing basis for a direct order (owner ruling, 2026-08-04)",
    );
    assert.match(
      bonusBranch,
      /computeDirectOrderSalesValue\(\{ qty, pharmacyPrice \}\)/,
      "a bonus deal must be valued on the pharmacy price alone",
    );
    // The old `isFallbackPricedRequest` flag is GONE, and its absence is asserted rather than
    // left to rot: it existed only to say "this bonus order was valued at the factory price",
    // a state that can no longer occur now that such a submission is refused outright.
    assert.doesNotMatch(
      serviceSource,
      /isFallbackPricedRequest/,
      "the factory-price fallback flag must not come back — a bonus order without a pharmacy price is refused, never re-priced",
    );
  }

  // ── The xlsx column list and the row builder are positional twins ───────────
  // They have no compile-time link: adding to one and not the other silently shifts every
  // later column in the owner's export, so the header would sit above the wrong data.
  {
    // The pair lives in report-columns.ts, which carries no ExcelJS import, so the live Google
    // Sheet feed renders the identical columns without loading a spreadsheet engine on every poll.
    const workbookSource = readFileSync(new URL("../src/lib/direct-orders/report-columns.ts", import.meta.url), "utf8");
    const columnsBlock = workbookSource.slice(
      workbookSource.indexOf("export const DIRECT_ORDER_REPORT_COLUMNS"),
      workbookSource.indexOf("export function directOrderReportRowCells"),
    );
    const rowsBlock = workbookSource.slice(
      workbookSource.indexOf("export function directOrderReportRowCells"),
      workbookSource.indexOf("export function directOrderReportColumnIndex"),
    );
    // Counted by EXECUTING the pair, not by matching `row.` lines in the source.
    //
    // The old heuristic counted one source line per cell, which silently under-counted the moment a
    // builder emitted several cells from one line — `...heldClockCells(row.heldAt)` returns four.
    // It then reported a mismatch that did not exist, which is the worst kind of guard: it fails on
    // correct code and teaches whoever hits it to edit the test until it goes quiet.
    const columnCount = (columnsBlock.match(/\{ label: "/g) ?? []).length;
    // An empty row is enough: this asserts the LENGTH of the emitted array, which does not
    // depend on any field's value. Building a full 43-field fixture here would duplicate the
    // one in direct-orders-report-columns.test.ts and rot the moment a field is renamed.
    const cellCount = directOrderReportRowCells({} as DirectOrderReportRow).length;
    assert.equal(
      columnCount,
      cellCount,
      `the xlsx column list (${columnCount}) and the row builder (${cellCount}) must stay the same length`,
    );
    assert.match(columnsBlock, /\{ label: "Pharmacy price"/, "the report must expose the pharmacy price");
    assert.match(rowsBlock, /row\.pharmacyPriceSnapshot/, "the row builder must emit the pharmacy price");
  }

  // ── The live Sheet feed and the .xlsx are ONE report ─────────────────────────
  // The CSV feed originally carried its own hand-written 25-column subset, so the owner's live
  // Google Sheet and his downloaded workbook were already different reports on the day they
  // shipped — same title, same link, quietly different columns. The fix was to delete the second
  // list, not to keep the two in step by hand.
  {
    const shareSource = readFileSync(new URL("../src/lib/direct-orders/report-share-links.ts", import.meta.url), "utf8");
    assert.match(
      shareSource,
      /import \{\s*DIRECT_ORDER_REPORT_COLUMNS,\s*directOrderReportRowCells,/,
      "the CSV feed must build its columns from the shared report-columns definition, never its own list",
    );
    const csvBlock = shareSource.slice(
      shareSource.indexOf("export function buildDirectOrderReportCsv"),
      shareSource.indexOf("export function buildDirectOrderReportBundleCsv"),
    );
    assert.doesNotMatch(
      csvBlock,
      /const headers = \[/,
      "SECOND COLUMN LIST IS BACK: the CSV feed must not hand-roll its own headers — that is how the Sheet and the .xlsx drifted apart",
    );
    assert.match(
      csvBlock,
      /DIRECT_ORDER_REPORT_COLUMNS\.map/,
      "the CSV header row must be derived from the shared column list",
    );
    // report-columns.ts exists precisely so this hot path never loads ExcelJS. If someone points
    // the feed back at report-workbook.ts, every 60-second poll pays for a spreadsheet engine.
    assert.doesNotMatch(
      shareSource,
      /from "@\/lib\/direct-orders\/report-workbook"/,
      "the share feed must not import report-workbook — that pulls ExcelJS into a route polled every minute",
    );
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

  // ── THE LOCKED PRICING RULE (owner, 2026-08-04, stated four times) ──────────
  //   Discount → qty × PUBLIC price × (1 − discount%)
  //   Bonus    → qty × PHARMACY price
  //   The factory price is never used for anything in this module.
  //
  // Pinned with the owner's OWN worked example so the rule is checkable against the sentence he
  // wrote, not against a paraphrase: Nermeen Salah, Lacto Advanced 1, 240 units, 25% discount,
  // public price 330 → 59,400 EGP. That order had been recorded as a BONUS deal with 25 bonus
  // units and valued at 240 × 281.688 = 67,605.12 — the bonus/discount conflation captured the
  // wrong deal type, not merely the wrong label.
  assert.equal(computeDiscountSalesValue({ qty: 240, publicPrice: 330, discountPct: 25 }), 59400);
  // And the same 240 units as a BONUS deal price on the pharmacy price, never the public one.
  assert.equal(computeDirectOrderSalesValue({ qty: 240, pharmacyPrice: 281.688 }), 67605.12);
  assert.notEqual(
    computeDiscountSalesValue({ qty: 240, publicPrice: 330, discountPct: 25 }),
    computeDirectOrderSalesValue({ qty: 240, pharmacyPrice: 281.688 }),
  );

  // ── The factory price must not appear ANYWHERE in Direct Orders ─────────────
  // Owner instruction, 2026-08-04, stated twice: a direct order is priced on the pharmacy price
  // (bonus) or the public price (discount) and the factory price is not used for anything —
  // not as a fallback basis, not as a report column, not in the export, the approval window or
  // the approved-order email. It kept creeping back as a "harmless" reference column, which is
  // how a number nobody should act on ends up on the screen where money is approved.
  //
  // `direct_order_requests.factory_price_snapshot` is NOT NULL with no default, so the insert
  // still writes a literal 0 until a migration drops the column; that write is the ONLY place
  // the name may legitimately appear in service.ts.
  {
    const files = [
      ["../src/lib/direct-orders/report-workbook.ts", "the XLSX export"],
      ["../src/lib/direct-orders/approved-email.ts", "the approved-order email"],
      ["../src/components/direct-orders/direct-order-report-workspace.tsx", "the admin report"],
      ["../src/components/direct-orders/direct-order-caps-manager.tsx", "the caps screen"],
      ["../src/components/approvals-hub/direct-order-request-detail.tsx", "the approval window"],
    ] as const;
    for (const [rel, what] of files) {
      const source = readFileSync(new URL(rel, import.meta.url), "utf8");
      const code = source
        .split(/\r?\n/)
        .filter((line) => {
          const t = line.trim();
          return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*") && !t.startsWith("{/*");
        })
        .join("\n");
      assert.doesNotMatch(
        code,
        /factoryPrice|factory_price|Factory price/i,
        `${what} must not reference the factory price — a direct order never uses it`,
      );
    }
  }

  // ── Whoever owns the sales month must be able to SEE a direct order ─────────
  // Finance owns the sales month (canSetDirectOrderSalesMonth admits exactly one HR_ID, B-185),
  // but Finance is never a requester and never an approver. Without a company-wide report tier the
  // scope resolved to "own", every list came back empty and canViewDirectOrderRequest refused every
  // id — so the only person permitted to book an order into a month could not open one, and
  // 177,124.80 EGP of approved orders sat in no month, no rep and no report. The two rules are a
  // pair: dropping the role from the tier re-stranded the money silently, with nothing failing.
  {
    const serviceSource = readFileSync(new URL("../src/lib/direct-orders/service.ts", import.meta.url), "utf8");
    const tierIdx = serviceSource.indexOf("const DIRECT_ORDER_REPORT_SEE_ALL_ROLES");
    assert.ok(tierIdx > -1, "the report tier list must still exist");
    const tierBlock = serviceSource.slice(tierIdx, serviceSource.indexOf("];", tierIdx));
    assert.match(
      tierBlock,
      /"Finance Manager"/,
      "Finance Manager must keep company-wide direct-order scope, or the sales-month owner cannot reach a single order to book",
    );
    // And the setter itself must still be the thing that gates the write.
    assert.match(
      serviceSource,
      /export function canSetDirectOrderSalesMonth\(/,
      "the sales-month permission gate must still exist",
    );
  }

  // ── A reversal must mirror its original's PRICING BASIS ─────────────────────
  // `deal_type` is NOT NULL DEFAULT 'bonus' in the column definition, so omitting it from the
  // reversal insert does not fail — it silently writes 'bonus'. Reversing a DISCOUNT order then
  // produced a row labelled "Bonus" whose sales_value had been computed from the public price;
  // and because the copied pharmacy_price_snapshot is null on a discount deal, that row also
  // satisfied isFallbackPricedRequest (bonus + no pharmacy price) and got badged "no pharmacy
  // price" for a product that has one. Two of production's five approved orders are discount
  // deals, so this was reachable. Asserted against source because the insert is DB-bound.
  {
    const serviceSource = readFileSync(new URL("../src/lib/direct-orders/service.ts", import.meta.url), "utf8");
    const reverseIdx = serviceSource.indexOf("export async function reverseDirectOrder(");
    assert.ok(reverseIdx > -1, "reverseDirectOrder must still exist");
    const insertIdx = serviceSource.indexOf(".insert({", reverseIdx);
    assert.ok(insertIdx > -1, "reverseDirectOrder must still insert the reversal row");
    const reversalInsert = serviceSource.slice(insertIdx, serviceSource.indexOf("})", insertIdx));

    assert.match(
      reversalInsert,
      /deal_type: original\.dealType/,
      "a reversal must copy deal_type from its original, or the column default silently makes every reversal a 'bonus' row",
    );
    assert.match(
      reversalInsert,
      /discount_pct: original\.discountPct/,
      "a reversal of a discount order must carry the discount percentage that produced its sales_value",
    );
    assert.match(
      reversalInsert,
      /public_price_snapshot: original\.publicPriceSnapshot/,
      "a reversal of a discount order must carry the public price its sales_value was computed from",
    );
  }

  // ── A reversal's first approver must be addressed as PEOPLE, not one joined string ──
  // `hrIdsForRole(...).join(",")` collapsed every holder of the opening rung's role into a single
  // recipient string, and canonicalHrIdKey returns "hr-001,hr-002" as a truthy key — so the
  // notification was addressed to somebody who does not exist. It stayed invisible only because
  // the opening rung is SFE Manager, who is separately in the CC set.
  {
    const serviceSource = readFileSync(new URL("../src/lib/direct-orders/service.ts", import.meta.url), "utf8");
    const reverseIdx = serviceSource.indexOf("export async function reverseDirectOrder(");
    const reverseBody = serviceSource.slice(reverseIdx, serviceSource.indexOf("\n}", reverseIdx));
    // Comment lines are stripped before the negative assertion: the fix's own explanatory comment
    // quotes the bad `.join(",")` call, and a raw source match cannot tell prose from code.
    const reverseCode = reverseBody
      .split("\n")
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
      .join("\n");
    assert.ok(
      !/\.join\(","\)/.test(reverseCode),
      "reverseDirectOrder must not join role holders into one comma-separated pseudo recipient",
    );
    assert.match(
      reverseBody,
      /recipients: \[\.\.\.reversalFirstApprovers,/,
      "reverseDirectOrder must spread the first rung's approvers into the recipient list, as submit does",
    );
  }
}
