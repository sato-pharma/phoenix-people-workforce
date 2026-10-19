import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import {
  canAssignDirectOrderSalesMonth,
  canRecordDirectOrderCollection,
  deriveDirectOrderSalesMonthChange,
  DIRECT_ORDER_FINANCE_HR_ID,
} from "../src/lib/direct-orders/finance-authority.ts";
import { resolveCorrectionExtraLines } from "../src/lib/direct-orders/correction-lines.ts";
import { buildDirectOrderNeedsAction } from "../src/lib/direct-orders/needs-action.ts";
import { resolveDirectOrderWorkspaceTab } from "../src/lib/direct-orders/workspace-data.ts";
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
  const needsActionCode = stripComments(
    readFileSync(new URL("../src/lib/direct-orders/needs-action.ts", import.meta.url), "utf8"),
  );
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

  // And the money must go through the one shared resolver, not a second copy of the rules.
  //
  // The name changed on 2026-08-12 when a request became a basket: both callers now reach
  // resolveDirectOrderPricing through resolveDirectOrderBasket, which prices every line and applies
  // the same-family rule. The property this pins is unchanged — a correction is valued by the same
  // code a fresh submission is — and direct-orders-approval-flow.test.ts additionally asserts that
  // the pricing helper has exactly one call site, so no third path can price independently.
  assert.ok(
    revise.includes("resolveDirectOrderBasket"),
    "a correction must be repriced through the SAME resolver submitDirectOrder uses",
  );
  assert.ok(
    serviceSource.includes("async function resolveDirectOrderPricing"),
    "the shared pricing helper must exist",
  );

  // ── Finding 1, the UI half: a working service with no interface is the same defect ──
  const detailSource = readFileSync(
    new URL("../src/components/approvals-hub/direct-order-request-detail.tsx", import.meta.url),
    "utf8",
  );
  assert.ok(
    detailSource.includes("DirectOrderCorrectResubmit"),
    "the order detail must offer Correct & Resubmit — Needs Action already promises 'Fix and resubmit'",
  );
  assert.ok(
    detailSource.includes("canCorrectAndResubmit ?"),
    "the panel must be gated on the server-computed ownership+status flag, never rendered unconditionally",
  );

  const panelSource = readFileSync(
    new URL("../src/components/direct-orders/direct-order-correct-resubmit.tsx", import.meta.url),
    "utf8",
  );
  assert.ok(
    panelSource.includes("returnComment") && panelSource.includes("blockquote"),
    "the approver's reason must be shown prominently — it is the instruction the requester is acting on",
  );
  // Pre-filled, not re-entered: every editable field seeds from the order's current value.
  for (const seed of [
    "useState(String(qty))",
    'useState<"bonus" | "discount">(dealType)',
    "useState(String(bonus ?? 0))",
    'useState(collectionDate ?? "")',
  ]) {
    assert.ok(panelSource.includes(seed), `the correction form must pre-fill from the existing order (${seed})`);
  }
  assert.ok(
    !panelSource.includes("productName={") && panelSource.includes("raise a new order"),
    "the panel must not offer to edit the product/pharmacy, and must say why in words",
  );
  // Entered values survive a server refusal — retyping a correction is the frustration being fixed.
  assert.ok(
    panelSource.includes("// The entered values are kept on failure"),
    "a failed resubmit must keep what the requester typed",
  );

  // The server flag must mirror reviseDirectOrder's guard, or the button appears for someone the
  // server will refuse.
  assert.ok(
    serviceSource.includes("canCorrectAndResubmit:") && serviceSource.includes('request.status === "returned" &&'),
    "canCorrectAndResubmit must require returned status",
  );
  // The return reason is read from the EVENTS table — the decision RPC never stores it on the step.
  assert.ok(
    serviceSource.includes('.eq("event_type", "return")'),
    "the return comment must come from direct_order_events; the approval step never carries it",
  );

  // ── A returned BASKET is corrected whole (code review, 19 Oct 2026) ─────────
  // The form sent line one alone, the route forwarded no lines, and the service rebuilt the order as
  // [line 1, ...(input.items ?? [])]: the returned 86,625 EGP Lacto Advanced 1 + 2 order would have
  // gone back to its approver at 49,500 with Lacto Advanced 2 deleted and no trace of it.
  const storedLa2 = {
    productCode: "LA2",
    productName: "Lacto Advanced 2",
    qty: 150,
    dealType: "bonus" as const,
    bonus: 15,
    discountPct: null,
  };
  assert.deepEqual(
    resolveCorrectionExtraLines({ headProductCode: "LA1", storedExtras: [storedLa2], sent: undefined }),
    { ok: true, items: [{ productCode: "LA2", qty: 150, dealType: "bonus", bonus: 15, discountPct: null }] },
    "A CORRECTION THAT SENDS NO LINES DROPPED THE BASKET'S SECOND LINE. Absent must keep every stored line as it is.",
  );
  assert.deepEqual(
    resolveCorrectionExtraLines({
      headProductCode: "LA1",
      storedExtras: [storedLa2],
      sent: [{ productCode: "LA2", qty: 120, dealType: "discount", bonus: 0, discountPct: 10 }],
    }),
    { ok: true, items: [{ productCode: "LA2", qty: 120, dealType: "discount", bonus: 0, discountPct: 10 }] },
    "a corrected second line carries its own new quantity and deal",
  );
  const leftOut = resolveCorrectionExtraLines({ headProductCode: "LA1", storedExtras: [storedLa2], sent: [] });
  assert.equal(leftOut.ok, false, "a correction that leaves a stored product out is refused, never a silent delete");
  assert.match(leftOut.ok ? "" : leftOut.message, /^Lacto Advanced 2 is missing from this correction/);
  const added = resolveCorrectionExtraLines({
    headProductCode: "LA1",
    storedExtras: [storedLa2],
    sent: [
      { productCode: "LA2", qty: 150 },
      { productCode: "OTHER", qty: 10 },
    ],
  });
  assert.match(added.ok ? "" : added.message, /cannot add a product/, "a correction never adds a product");
  for (const sent of [
    [{ productCode: "LA1", qty: 5 }, { productCode: "LA2", qty: 150 }],
    [{ productCode: "LA2", qty: 150 }, { productCode: "LA2", qty: 10 }],
  ]) {
    const repeated = resolveCorrectionExtraLines({ headProductCode: "LA1", storedExtras: [storedLa2], sent });
    assert.match(repeated.ok ? "" : repeated.message, /appears twice/, "each product is corrected once");
  }
  assert.deepEqual(
    resolveCorrectionExtraLines({ headProductCode: "LA1", storedExtras: [], sent: [] }),
    { ok: true, items: [] },
    "a single-product order sends an empty list and keeps its one line",
  );

  // The wiring: the service reads the stored lines and feeds them through the rule, the route never
  // turns an absent list into an empty one, the form sends every line, and the order passes them in.
  const reviseCode = stripComments(revise);
  assert.ok(
    reviseCode.includes("loadDirectOrderItems(before.id)") && reviseCode.includes("resolveCorrectionExtraLines("),
    "reviseDirectOrder must read the stored lines and keep them through resolveCorrectionExtraLines",
  );
  assert.ok(
    reviseCode.includes("...extraLines.items") && !reviseCode.includes("...(input.items ?? [])"),
    "THE BASKET IS REBUILT FROM THE CALLER'S LIST AGAIN — an absent list drops every line after the first",
  );
  const reviseRouteCode = stripComments(
    readFileSync(new URL("../app/api/direct-orders/[id]/revise/route.ts", import.meta.url), "utf8"),
  );
  assert.ok(
    reviseRouteCode.includes("Array.isArray(body.items)") && !reviseRouteCode.includes("body.items ?? []"),
    "the revise route must forward the lines it was sent and leave an absent list absent",
  );
  assert.ok(
    stripComments(panelSource).includes("items: nextExtras.map("),
    "the correction form must send every line after the first",
  );
  assert.ok(
    stripComments(detailSource).includes("extraLines={detail.items.slice(1)"),
    "the order must hand the correction form its lines after the first",
  );

  // ── Phase 3: the workspace loads only what the open view can show ─────────
  const workspaceDataSource = readFileSync(
    new URL("../src/lib/direct-orders/workspace-data.ts", import.meta.url),
    "utf8",
  );

  // STRENGTHENED 2026-08-12. This used to assert that the full report was GATED on the view
  // (`needsFullReport ? getDirectOrderReport(access) : …`) and that Overview and Needs Action stayed
  // on the gate list, because their counters and Finance queue were derived from those rows and
  // dropping them would have silently under-reported.
  //
  // Both counts now come from their own cheap reads — countDirectOrderWorkspaceTotals and
  // listDirectOrderAwaitingFinanceMonth — and the Orders list from listDirectOrderOperationalPage.
  // The last holder of the report was the `allOrders` fallback, alive only while tab switching was
  // client-side; once a tab became a navigation it was unreachable. So the correct assertion is no
  // longer "gated" but ABSENT, which is strictly stronger: a gate can be widened by accident, and a
  // call that does not exist cannot be.
  const workspaceDataCode = stripComments(workspaceDataSource);
  assert.ok(
    !workspaceDataCode.includes("getDirectOrderReport("),
    "THE FULL-TABLE READ IS BACK IN THE WORKSPACE LOADER. Every view now has a read sized to what " +
      "it shows; getDirectOrderReport belongs to the report PAGE, which wants everything in order " +
      "to export it. Reintroducing it here puts the whole Direct Orders population back on the " +
      "module's most-opened screen.",
  );
  assert.ok(
    !workspaceDataCode.includes("VIEWS_NEEDING_FULL_REPORT"),
    "the gate list should be gone with the read it gated — a list of views needing a report nothing " +
      "fetches is a rule with no subject",
  );
  // The cheap reads that replaced it must actually be the ones in use.
  for (const replacement of [
    "countDirectOrderWorkspaceTotals",
    "listDirectOrderAwaitingFinanceMonth",
    "listDirectOrderOperationalPage",
  ]) {
    assert.ok(
      workspaceDataCode.includes(replacement),
      `${replacement} must still back its view — removing the report only helps if these remain`,
    );
  }

  // The per-view checks that used to live here — "orders", "pharmacy-control" and "controls" must
  // not appear on the gate list — are subsumed by the assertion above. A call that does not exist
  // cannot be triggered by ANY view, so enumerating the views that must not trigger it would now be
  // restating the same fact once per view.

  // Both shells must actually PASS the view, or the gate above can never fire.
  for (const page of [
    "../app/(admin)/admin/direct-orders/page.tsx",
    "../app/employee-portals/direct-orders/page.tsx",
  ]) {
    const pageSource = readFileSync(new URL(page, import.meta.url), "utf8");
    assert.ok(
      pageSource.includes("view: requestedTab"),
      `${page} must pass the resolved view to the loader`,
    );
    assert.ok(
      pageSource.includes("resolveDirectOrderWorkspaceTab(view)"),
      `${page} must resolve legacy ?view= aliases so old bookmarks do not fall back to Overview`,
    );
  }

  // The legacy aliases themselves — these URLs are in bookmarks, the sidebar history and
  // next.config.ts's retired-route redirects.
  for (const [legacy, target] of [
    ["my-orders", "orders"],
    ["all-orders", "orders"],
    ["customers", "pharmacy-control"],
    ["admin-tools", "pharmacy-control"],
  ]) {
    assert.equal(
      resolveDirectOrderWorkspaceTab(legacy),
      target,
      `the retired ?view=${legacy} link must land on ${target}, not silently on Overview`,
    );
  }
  assert.equal(resolveDirectOrderWorkspaceTab("orders"), "orders", "current names still resolve");
  assert.equal(resolveDirectOrderWorkspaceTab(""), "overview", "an absent view is Overview");
  assert.equal(resolveDirectOrderWorkspaceTab("nonsense"), "overview", "an unknown view falls back safely");

  console.log(
    "  direct-orders second-review fixes: findings 1 (service + UI), 2, 5, 6 + view-aware loading covered",
  );
}
