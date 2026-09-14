import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  canAttachDirectOrderInvoice,
  describeDirectOrderInvoiceClaimPlan,
  directOrderRequestInvoicePath,
  planDirectOrderInvoiceClaim,
  shouldRecordInvoiceValidationAtSfeRung,
} from "@/lib/direct-orders/order-invoice-rules";

// ─────────────────────────────────────────────────────────────────────────────
// The invoice a rep used, kept with the order (owner, 2026-09-14).
//
// His words: "When the pharmacies validate by invoices goes to SFE to validate it must clearly show
// the invoice pic used." His answers, each pinned below:
//   1. The invoice read on the order form is saved WITH the order, and the SFE Manager sees it, full
//      width, first on the order.
//   2. For a NEW pharmacy, the SFE Manager's approval counts as its invoice validation — 1 of the rep's
//      5 slots. Over the limit the approval stands and is flagged, never blocked.
//   3. Orders already sent with no invoice: the rep attaches it again, on the order, while it is held
//      or still waiting for the SFE Manager.
// ─────────────────────────────────────────────────────────────────────────────

function read(rel: string) {
  return readFileSync(new URL(rel, import.meta.url), "utf8");
}

/** The body of one function, bounded at the next top-level declaration so assertions cannot leak. */
function functionBlock(source: string, name: string) {
  const start = source.search(new RegExp(`(?:export )?async function ${name}\\(`));
  assert.ok(start >= 0, `${name} must exist`);
  const rest = source.slice(start + 1);
  const next = rest.search(/^(?:export )?(?:async )?function |^(?:export )?(?:const|type) |^\/\/ ── /m);
  return source.slice(start, next >= 0 ? start + 1 + next : undefined);
}

const SERVICE = "../src/lib/direct-orders/service.ts";
const ORDER_INVOICE = "../src/lib/direct-orders/order-invoice.ts";
const MIGRATION = "../supabase/migrations/20260914200000_direct_order_request_invoice.sql";
const DETAIL = "../src/components/approvals-hub/direct-order-request-detail.tsx";
const ATTACH = "../src/components/direct-orders/attach-direct-order-invoice.tsx";
const SUBMIT_FORM = "../src/components/direct-orders/direct-order-submit-form.tsx";
const CAPTURE = "../src/components/direct-orders/invoice-capture.tsx";
const EVIDENCE = "../src/components/direct-orders/direct-order-invoice-evidence.tsx";
const DESK = "../src/components/direct-orders/validation-desk.tsx";
const ATTACH_ROUTE = "../app/api/direct-orders/[id]/invoice/route.ts";
const SUBMIT_ROUTE = "../app/api/direct-orders/submit/route.ts";
const REGISTRY = "../src/lib/security/access-registry.ts";

const FREE = { used: 2, limit: 5 };
const FULL = { used: 5, limit: 5 };

function planRules() {
  const base = {
    requestStatus: "held",
    pharmacyVerificationStatus: "pending_review",
    venueRequiresDistributorCode: true,
    openClaimOnPharmacy: false,
    slots: FREE,
  };
  // A held order's invoice is filed as the pharmacy's validation — that is what revives the order.
  assert.equal(planDirectOrderInvoiceClaim(base), "file_claim");
  // With the approvers, the SFE rung confirms the pharmacy: no second review of the same thing.
  assert.equal(planDirectOrderInvoiceClaim({ ...base, requestStatus: "pending_approval" }), "sfe_confirms_on_order");
  // No sixth.
  assert.equal(planDirectOrderInvoiceClaim({ ...base, slots: FULL }), "slots_full");
  assert.equal(planDirectOrderInvoiceClaim({ ...base, openClaimOnPharmacy: true }), "claim_already_open");
  assert.equal(planDirectOrderInvoiceClaim({ ...base, venueRequiresDistributorCode: false }), "no_distributor_account");
  assert.equal(planDirectOrderInvoiceClaim({ ...base, pharmacyVerificationStatus: "verified" }), "not_needed");
  assert.equal(planDirectOrderInvoiceClaim({ ...base, pharmacyVerificationStatus: "rejected" }), "not_needed");
}

function sfeRungRules() {
  const base = {
    pharmacyWasPendingReview: true,
    orderHasInvoice: true,
    venueRequiresDistributorCode: true,
    requesterAlreadyHoldsInvoiceClaim: false,
    slots: FREE,
  };
  assert.equal(shouldRecordInvoiceValidationAtSfeRung(base), true, "the SFE approval of a new pharmacy on an invoice counts as 1 of 5");
  assert.equal(shouldRecordInvoiceValidationAtSfeRung({ ...base, slots: { used: 4, limit: 5 } }), true, "the fifth still counts");
  assert.equal(shouldRecordInvoiceValidationAtSfeRung({ ...base, slots: FULL }), false, "a sixth is never counted");
  assert.equal(shouldRecordInvoiceValidationAtSfeRung({ ...base, pharmacyWasPendingReview: false }), false);
  assert.equal(shouldRecordInvoiceValidationAtSfeRung({ ...base, orderHasInvoice: false }), false);
  assert.equal(shouldRecordInvoiceValidationAtSfeRung({ ...base, venueRequiresDistributorCode: false }), false);
  assert.equal(
    shouldRecordInvoiceValidationAtSfeRung({ ...base, requesterAlreadyHoldsInvoiceClaim: true }),
    false,
    "a pharmacy already holding one of the rep's slots never takes a second",
  );
}

function attachRules() {
  const base = { viewerHrKey: "d-104", requesterHrKey: "d-104", status: "pending_approval", activeStepConfirmsPharmacy: true };
  assert.equal(canAttachDirectOrderInvoice(base), true, "the requester attaches while the SFE Manager has not decided");
  assert.equal(canAttachDirectOrderInvoice({ ...base, status: "held", activeStepConfirmsPharmacy: false }), true);
  assert.equal(
    canAttachDirectOrderInvoice({ ...base, activeStepConfirmsPharmacy: false }),
    false,
    "once the SFE Manager has approved, the file a decision was made on can no longer change",
  );
  assert.equal(canAttachDirectOrderInvoice({ ...base, viewerHrKey: "d-200" }), false, "only the requester");
  assert.equal(canAttachDirectOrderInvoice({ ...base, viewerHrKey: "" , requesterHrKey: "" }), false, "no identity is nobody");
  for (const status of ["approved", "rejected", "returned", "cancelled"]) {
    assert.equal(canAttachDirectOrderInvoice({ ...base, status }), false, `not on a ${status} order`);
  }

  const first = directOrderRequestInvoicePath("req-1", "jpg", new Date("2026-09-14T10:00:00Z"));
  const second = directOrderRequestInvoicePath("req-1", "jpg", new Date("2026-09-14T10:05:00Z"));
  assert.notEqual(first, second, "a replaced invoice never overwrites the file an earlier decision used");
  assert.ok(first.startsWith("orders/req-1/"));
}

function sentences() {
  for (const plan of ["file_claim", "sfe_confirms_on_order", "slots_full", "claim_already_open", "no_distributor_account", "not_needed"] as const) {
    const text = describeDirectOrderInvoiceClaimPlan(plan, plan === "slots_full" ? FULL : FREE);
    assert.ok(text.length > 20, `${plan} says a sentence`);
    assert.doesNotMatch(text, /_/, `${plan} never shows a plan code`);
  }
  assert.match(describeDirectOrderInvoiceClaimPlan("file_claim", FREE), /3 of 5/, "the claim just filed is counted in the label");
}

function serviceWiring() {
  const service = read(SERVICE);
  const submit = functionBlock(service, "submitDirectOrder");
  const parseAt = submit.indexOf("parseDirectOrderRequestInvoice(");
  const insertAt = submit.indexOf('.from("direct_order_requests")');
  assert.ok(parseAt > 0 && insertAt > 0 && parseAt < insertAt, "a bad invoice is refused before the order is written");
  const saveAt = submit.indexOf("saveSubmittedDirectOrderInvoice(");
  assert.ok(saveAt > submit.indexOf('eventType: "submitted"'), "the invoice is saved after the order exists");
  assert.equal((submit.match(/return \{ \.\.\.request, invoiceNote \}/g) ?? []).length, 2, "both submit exits tell the rep what became of the invoice");

  const decide = functionBlock(service, "decideDirectOrder");
  const loadAt = decide.indexOf("const pharmacyBeforeApproval =");
  const markAt = decide.indexOf("markDirectOrderPharmacyVerified(");
  const recordAt = decide.indexOf("recordDirectOrderInvoiceValidationAtSfeRung(");
  assert.ok(loadAt > 0 && markAt > 0, "both the pre-approval read and the confirmation exist");
  assert.ok(loadAt < markAt, "the pharmacy is read as the SFE Manager found it, before confirming it");
  assert.ok(recordAt > markAt, "the slot is recorded only once the pharmacy is confirmed");
  assert.ok(recordAt < decide.indexOf("catch (confirmError)"), "a failed confirmation records no slot");

  const detail = functionBlock(service, "getDirectOrderApprovalDetail");
  assert.match(detail, /loadDirectOrderRequestInvoice\(request/);
  assert.match(detail, /canAttachDirectOrderInvoice\(\{/);
  assert.match(detail, /orderInvoice,\s*invoiceExpected,\s*canAttachInvoice,/);
  assert.match(service, /invoiceStoragePath: row\.invoice_storage_path/);
}

function orderInvoiceModule() {
  const source = read(ORDER_INVOICE);
  const attach = functionBlock(source, "attachDirectOrderInvoice");
  assert.match(attach, /assertPermission\(access, "direct_orders", "create"\)/);
  assert.match(attach, /forbiddenError\(/, "only the order's own requester");
  assert.match(attach, /canAttachDirectOrderInvoice\(/);
  assert.match(attach, /\.eq\("status", "pending"\)/, "the active rung is read live, not trusted from the screen");

  const saveOnSubmit = functionBlock(source, "saveSubmittedDirectOrderInvoice");
  assert.match(saveOnSubmit, /catch \(error\)/);
  assert.doesNotMatch(saveOnSubmit, /\bthrow\b/, "a submitted order is never reported as failed because of its invoice");
  assert.match(saveOnSubmit, /invoice_attach_failed/);

  const store = functionBlock(source, "storeOrderInvoice");
  assert.match(store, /upsert: false/, "never overwrite an invoice object");
  assert.match(store, /\.remove\(\[path\]\)/, "a failed row update leaves no orphan file");

  const rung = functionBlock(source, "recordDirectOrderInvoiceValidationAtSfeRung");
  assert.match(rung, /status: "approved_new"/);
  assert.match(rung, /validation_route: "invoice"/);
  assert.match(rung, /decided_by_hr_id: hrIdForStorage\(access\.hrId\)/, "decided by the SFE Manager who approved, never the system");
  assert.match(rung, /invoice_storage_path: request\.invoiceStoragePath/, "the slot points at the invoice the SFE Manager saw");
  assert.match(rung, /invoice_slot_not_counted/, "over the limit the order says so instead of silently counting nothing");
  const rungCatch = rung.slice(rung.lastIndexOf("} catch (error) {"));
  assert.ok(rungCatch.includes("logError("), "post-commit: a failure is logged");
  assert.doesNotMatch(rungCatch, /\bthrow\b/, "post-commit: a failure never fails the approval");

  const apply = functionBlock(source, "applyOrderInvoice");
  assert.match(apply, /requestDirectOrderPharmacyValidation\(access/, "a held order's claim goes through the one door every claim uses");
  assert.match(apply, /validationRoute: "invoice"/);
}

function migration() {
  const sql = read(MIGRATION);
  assert.match(sql, /add column if not exists invoice_storage_path text/i);
  assert.match(sql, /direct_order_requests_invoice_pair_check/);
  assert.match(sql, /notify pgrst, 'reload schema'/);
}

function screens() {
  const detail = read(DETAIL);
  const panelAt = detail.indexOf('title="Invoice used for this order"');
  assert.ok(panelAt > 0 && panelAt < detail.indexOf('title="Order details"'), "the invoice is the first panel on the order");
  assert.match(detail, /<DirectOrderInvoiceEvidence[\s\S]{0,200}prominent[\s\S]{0,60}url=\{shownInvoice\.url\}/, "shown large, not as a thumbnail");
  assert.match(detail, /pharmacyEvidence\?\.validationRoute === "invoice"/, "an older order falls back to its claim's invoice");
  assert.match(detail, /<AttachDirectOrderInvoice hasInvoice=/);
  assert.match(detail, /No invoice is attached to this order yet/, "a missing invoice is said out loud");

  const evidence = read(EVIDENCE);
  assert.match(evidence, /max-h-\[75vh\] w-full/);
  assert.match(evidence, /<ZoomHint/);
  assert.match(read(DESK), /md:grid-cols-\[minmax\(0,1fr\)_minmax\(0,1fr\)\]/, "the desk gives an invoice half the card");

  const form = read(SUBMIT_FORM);
  assert.match(form, /onInvoicePhoto=\{\(file\) => \{/);
  assert.match(form, /invoiceDataUrl: invoicePhoto\?\.dataUrl \?\? null/);
  assert.match(form, /Don&apos;t attach it/, "the rep can drop the invoice");
  assert.match(read(CAPTURE), /onInvoicePhoto\?\.\(file\);/);

  const attach = read(ATTACH);
  assert.match(attach, /capture="environment"/);
  assert.match(attach, /\/api\/direct-orders\/\$\{encodeURIComponent\(requestId\)\}\/invoice/);

  // D4: never mention how the invoice is read.
  for (const [name, text] of [["detail", detail], ["attach", attach], ["form", form], ["evidence", evidence]] as const) {
    assert.doesNotMatch(text.replace(/\/\/.*$|\{\/\*[\s\S]*?\*\/\}|\/\*[\s\S]*?\*\//gm, ""), />[^<]*\b(AI|artificial intelligence|model|GPT|Claude)\b[^<]*</, `${name} shows no AI wording`);
  }
}

function routes() {
  const route = read(ATTACH_ROUTE);
  assert.match(route, /assertSameOriginMutation\(request\)/);
  assert.match(route, /attachDirectOrderInvoice\(access, \{ requestId: id/);
  assert.match(read(SUBMIT_ROUTE), /invoiceDataUrl: typeof body\.invoiceDataUrl === "string"/);
  assert.match(
    read(REGISTRY),
    /pattern: "\/api\/direct-orders\/:id\/invoice", permission: \{ resource: "direct_orders", action: "create" \}, guard: "domain-helper", csrfRequired: true/,
  );
}

export async function runDirectOrderOrderInvoiceTests() {
  planRules();
  sfeRungRules();
  attachRules();
  sentences();
  serviceWiring();
  orderInvoiceModule();
  migration();
  screens();
  routes();
}
