import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DIRECT_ORDER_INVOICE_BUCKET,
  DIRECT_ORDER_INVOICE_MAX_BYTES,
  DIRECT_ORDER_INVOICE_SLOT_LIMIT,
  directOrderInvoiceSlotLabel,
  directOrderInvoiceSlotsFullMessage,
  normalizeDirectOrderValidationRoute,
  parseDirectOrderInvoiceDataUrl,
} from "@/lib/direct-orders/invoice-evidence";

// ─────────────────────────────────────────────────────────────────────────────
// A distributor invoice validates a direct-order pharmacy on its own (owner, 2026-09-14).
//
// His rules, each pinned below:
//   1. The invoice is stored as validation evidence, and the reviewer SEES it.
//   2. The reviewer is the SFE Manager as well as the Super Admin — the SFE Manager for invoice
//      claims only.
//   3. At most FIVE pharmacies per rep stand on an invoice at once; a sixth is REFUSED.
//   4. "1 of 5 pharmacies validated by invoice" is shown to the rep and to the reviewer.
//   5. A rejected invoice claim gives its slot back; confirming the pharmacy later with a live photo
//      and location frees the slot too.
// ─────────────────────────────────────────────────────────────────────────────

function read(rel: string) {
  return readFileSync(new URL(rel, import.meta.url), "utf8");
}

/** The body of one function, bounded at the next top-level declaration so assertions cannot leak. */
function functionBlock(source: string, name: string) {
  const start = source.search(new RegExp(`(?:export )?async function ${name}\\(`));
  assert.ok(start >= 0, `${name} must exist`);
  const rest = source.slice(start + 1);
  const next = rest.search(/^(?:export )?(?:async )?function |^(?:export )?(?:const|type) /m);
  return source.slice(start, next >= 0 ? start + 1 + next : undefined);
}

const VALIDATION = "../src/lib/direct-orders/pharmacy-validation.ts";
const SERVICE = "../src/lib/direct-orders/service.ts";
const MIGRATION = "../supabase/migrations/20260914180000_direct_order_invoice_validation.sql";
const CAPTURE = "../src/components/direct-orders/pharmacy-validation-capture.tsx";
const INVOICE_CAPTURE = "../src/components/direct-orders/pharmacy-invoice-validation-capture.tsx";
const INVOICE_LIST = "../src/components/direct-orders/invoice-validated-pharmacies.tsx";
const INVOICE_EVIDENCE = "../src/components/direct-orders/direct-order-invoice-evidence.tsx";
const DESK = "../src/components/direct-orders/validation-desk.tsx";
const APPROVAL_DETAIL = "../src/components/approvals-hub/direct-order-request-detail.tsx";
const VALIDATIONS_PAGE = "../app/(admin)/admin/direct-orders/(desks)/validations/page.tsx";
const NAVIGATION = "../src/config/system-navigation.ts";

export function runDirectOrderInvoiceValidationTests() {
  // ── The limit and the words ───────────────────────────────────────────────────────────────
  assert.equal(DIRECT_ORDER_INVOICE_SLOT_LIMIT, 5, "THE OWNER'S LIMIT IS FIVE pharmacies per rep on an invoice alone");
  assert.equal(DIRECT_ORDER_INVOICE_BUCKET, "direct-order-invoices");
  assert.equal(directOrderInvoiceSlotLabel({ used: 1, limit: 5 }), "1 of 5 pharmacies validated by invoice");
  assert.match(
    directOrderInvoiceSlotsFullMessage({ used: 5, limit: 5 }),
    /5 of 5[\s\S]*live photo and location/,
    "the refusal must say how to free a slot, not just that the rep is out of them",
  );

  // Every row written before the column existed is a field claim; only an exact `invoice` is not.
  assert.equal(normalizeDirectOrderValidationRoute("invoice"), "invoice");
  assert.equal(normalizeDirectOrderValidationRoute(null), "field");
  assert.equal(normalizeDirectOrderValidationRoute("Invoice"), "field");
  assert.equal(normalizeDirectOrderValidationRoute("field"), "field");

  // ── The parser ────────────────────────────────────────────────────────────────────────────
  const png = parseDirectOrderInvoiceDataUrl(`data:image/png;base64,${Buffer.from("png-bytes").toString("base64")}`);
  assert.equal(png.contentType, "image/png");
  assert.equal(png.extension, "png");
  const pdf = parseDirectOrderInvoiceDataUrl(`data:application/pdf;base64,${Buffer.from("%PDF-1.4").toString("base64")}`);
  assert.equal(pdf.extension, "pdf");
  assert.throws(() => parseDirectOrderInvoiceDataUrl(""), /Attach the distributor invoice/);
  assert.throws(
    () => parseDirectOrderInvoiceDataUrl(`data:text/plain;base64,${Buffer.from("x").toString("base64")}`),
    /JPEG, a PNG, or a PDF/,
  );
  // Real bytes with junk mixed in: Node's decoder silently skips the junk, so only the re-encode
  // comparison catches it. (Junk alone decodes to nothing and is refused as empty instead.)
  assert.throws(() => parseDirectOrderInvoiceDataUrl("data:image/png;base64,QUJD@@REVG"), /inside the app/);
  const oversize = "A".repeat(Math.ceil(((DIRECT_ORDER_INVOICE_MAX_BYTES + 16) * 4) / 3));
  assert.throws(() => parseDirectOrderInvoiceDataUrl(`data:image/jpeg;base64,${oversize}`), /under 5 MB/);

  // ── Filing a claim ────────────────────────────────────────────────────────────────────────
  const validation = read(VALIDATION);
  const requestBlock = functionBlock(validation, "requestDirectOrderPharmacyValidation");

  assert.match(
    requestBlock,
    /if \(!isInvoiceRoute && \(capturedLatitude === null \|\| capturedLongitude === null\)\) \{\s*badRequest\(VENUE_LOCATION_REQUIRED_MESSAGE\)/,
    "the pin is waived for the INVOICE route only — every other claim still needs a location",
  );
  assert.match(
    requestBlock,
    /const bytes = isInvoiceRoute \? null : parseDirectOrderEvidencePhotoDataUrl\(input\.photoDataUrl\)\.bytes/,
    "the live photo is waived for the invoice route only",
  );
  assert.match(
    requestBlock,
    /if \(slots\.used >= slots\.limit\) badRequest\(directOrderInvoiceSlotsFullMessage\(slots\)\)/,
    "A SIXTH INVOICE PHARMACY MUST BE REFUSED until a slot opens (owner, 2026-09-14)",
  );
  assert.match(
    requestBlock,
    /if \(isInvoiceRoute && !linkedRequestId\) \{\s*badRequest\(/,
    "an invoice must belong to a held order — with no order there is nothing for the decision to move",
  );
  assert.match(
    requestBlock,
    /pharmacyHasConfirmedInvoiceValidation\(supabase, pharmacyId, access\.hrId \?\? ""\)[\s\S]{0,120}if \(!ownInvoiceClaim\) \{\s*throw forbiddenError\(/,
    "a live photo with no order behind it is ONLY for a pharmacy the rep validated by invoice themselves — otherwise any rep could file evidence against any pharmacy",
  );
  assert.match(
    requestBlock,
    /if \(isInvoiceRoute \|\| !linkedRequestId\) \{[\s\S]{0,700}\.eq\("status", "pending"\)[\s\S]{0,400}badRequest\(/,
    "a double tap must not file the same invoice (or the same field check) twice",
  );
  assert.match(requestBlock, /validation_route: validationRoute/, "the route must be stored on the row");
  assert.match(
    requestBlock,
    /\.from\(DIRECT_ORDER_INVOICE_BUCKET\)[\s\S]{0,200}\.upload\(/,
    "THE INVOICE MUST BE STORED as evidence, in its own private bucket",
  );

  // ── What holds a slot, and what frees it ──────────────────────────────────────────────────
  const slotStatuses = /const INVOICE_SLOT_STATUSES[^=]*=\s*\[([^\]]*)\]/.exec(validation);
  assert.ok(slotStatuses, "INVOICE_SLOT_STATUSES must exist");
  assert.doesNotMatch(slotStatuses![1], /rejected/, "A REJECTED INVOICE CLAIM MUST GIVE ITS SLOT BACK (owner's answer)");
  assert.match(slotStatuses![1], /"pending"/, "a pending invoice claim holds its slot, or a rep could file ten before anyone decides");
  const slotsBlock = functionBlock(validation, "loadOpenInvoiceSlots");
  assert.match(
    slotsBlock,
    /if \(confirmedInField\.has\(pharmacyId\)\) continue;/,
    "confirming the pharmacy with a live photo and location must free its slot",
  );
  assert.match(slotsBlock, /verification_status === "rejected"\) continue;/, "a pharmacy ruled false holds no slot");
  assert.match(slotsBlock, /i \+= 50/, "the lookups must be chunked — a long .in() comes back empty and would read as zero slots used");

  // ── Who decides ───────────────────────────────────────────────────────────────────────────
  assert.match(
    validation,
    /export function canDecideDirectOrderInvoiceValidations\(access: AccessContext\): boolean \{\s*return canDecideDirectOrderPharmacyValidations\(access\) \|\| access\.role === "SFE Manager";/,
    "THE SFE MANAGER MUST BE ABLE TO DECIDE invoice claims (owner: both reviewers)",
  );
  const decideBlock = functionBlock(validation, "decideDirectOrderPharmacyValidation");
  assert.match(
    decideBlock,
    /if \(!isInvoiceRoute && !decidesEveryClaim\) \{\s*throw forbiddenError\(/,
    "THE SFE MANAGER DECIDES INVOICE CLAIMS ONLY — a live-photo claim stays with a System Admin",
  );
  assert.match(
    decideBlock,
    /if \(decidesEveryClaim\) \{\s*await acknowledgeDirectOrderPharmacy\(access, \{ pharmacyId \}\);\s*\} else \{\s*await confirmDirectOrderPharmacyFromInvoiceValidation\(access, \{ pharmacyId, validationId: input\.validationId \}\);/,
    "an SFE Manager's approval must confirm the pharmacy through the invoice-only door, or their decision would leave the order held",
  );
  assert.match(
    decideBlock,
    /const gap = isInvoiceRoute \|\| invoiceIdentityOnFile \? null : venueIdentityGapMessage\(/,
    "the invoice answers who the pharmacy is, so the code-or-licence leg is not asked of it",
  );
  assert.match(
    functionBlock(validation, "countDirectOrderPendingValidations"),
    /if \(!decidesEveryClaim\) query = query\.eq\("validation_route", "invoice"\)/,
    "the SFE Manager's badge counts only what they can clear",
  );
  assert.match(
    functionBlock(validation, "listDirectOrderPharmacyValidations"),
    /if \(!canDecideDirectOrderPharmacyValidations\(access\)\) query = query\.eq\("validation_route", "invoice"\)/,
    "the SFE Manager's desk must hold invoice claims only",
  );

  const service = read(SERVICE);
  const confirmBlock = functionBlock(service, "confirmDirectOrderPharmacyFromInvoiceValidation");
  assert.match(confirmBlock, /claim\.validation_route !== "invoice"/, "the SFE confirm door must open for an invoice claim only");
  assert.match(confirmBlock, /\["approved_new", "matched_existing"\]\.includes/, "and only once that claim is decided");
  assert.doesNotMatch(
    service,
    /export async function markDirectOrderPharmacyVerified/,
    "the confirming write must stay private — exported, it confirms any pharmacy for anyone",
  );
  assert.match(
    functionBlock(service, "acknowledgeDirectOrderPharmacy"),
    /Forbidden: only a System Admin can acknowledge a venue\./,
    "the standalone acknowledge stays a System Admin's action",
  );

  // ── The migration ─────────────────────────────────────────────────────────────────────────
  const migration = read(MIGRATION);
  assert.equal(
    (migration.match(/update public\.workflow_registry_modules/g) ?? []).length,
    1,
    "exactly ONE registry update per migration — one version bump",
  );
  assert.doesNotMatch(migration, /version\s*=/, "`version` is trigger-owned and must never be set by hand");
  assert.match(migration, /'decide_pharmacy_validation'[\s\S]{0,200}'\["SFE Manager"\]'::jsonb/, "the registry must admit the SFE Manager to decide");
  assert.match(migration, /'direct-order-invoices',\s*'direct-order-invoices',\s*false/, "the invoice bucket must be PRIVATE");

  // ── The screens ───────────────────────────────────────────────────────────────────────────
  const capture = read(CAPTURE);
  assert.doesNotMatch(
    capture,
    /DIRECT_ORDER_INVOICE_ACCEPT_ATTRIBUTE/,
    "the live-capture screen keeps no upload input but the licence's — the invoice picker lives in its own component",
  );
  assert.match(capture, /<PharmacyInvoiceValidationCapture/, "the held-order capture must offer the invoice route");

  const invoiceCapture = read(INVOICE_CAPTURE);
  assert.match(invoiceCapture, /validationRoute: "invoice"/);
  assert.match(invoiceCapture, /directOrderInvoiceSlotLabel\(slots\)/, "THE REP MUST SEE '1 of 5 pharmacies validated by invoice' before sending");
  assert.doesNotMatch(invoiceCapture, /geolocation|photoDataUrl/, "the invoice route asks for no location and no storefront photo");

  assert.match(read(INVOICE_LIST), /mode="upgrade"/, "the rep's invoice pharmacies must offer the live-photo confirmation that frees a slot");
  assert.match(read(INVOICE_LIST), /directOrderInvoiceSlotLabel\(slots\)/);

  const desk = read(DESK);
  assert.match(desk, /<DirectOrderInvoiceEvidence[\s\S]{0,200}url=\{row\.invoiceUrl\}/, "THE REVIEWER MUST SEE THE UPLOADED INVOICE on the desk");
  assert.match(desk, /directOrderInvoiceSlotLabel\(row\.requesterInvoiceSlots\)/, "and how many invoice slots the rep is using");
  assert.match(
    read(APPROVAL_DETAIL),
    /<DirectOrderInvoiceEvidence[\s\S]{0,200}url=\{pharmacyEvidence\.invoiceUrl\}/,
    "the order's approvers must see the invoice too",
  );

  const page = read(VALIDATIONS_PAGE);
  assert.match(page, /if \(!canDecideDirectOrderInvoiceValidations\(access\)\) redirect\(/, "the desk page must open for the SFE Manager");
  const navigation = read(NAVIGATION);
  const navItem = /href: "\/admin\/direct-orders\/validations",[\s\S]*?roles: \[([^\]]*)\]/.exec(navigation);
  assert.ok(navItem, "the Pharmacy Validation nav item must exist");
  assert.match(navItem![1], /"SFE Manager"/, "the SFE Manager must be able to reach the desk");

  // Invisible AI (owner rule D4): none of the new screens names a mechanism.
  for (const rel of [INVOICE_CAPTURE, INVOICE_LIST, INVOICE_EVIDENCE]) {
    assert.doesNotMatch(read(rel), /\bAI\b|GPT|model suggests|artificial intelligence/i, `${rel} must not mention AI`);
  }
}
