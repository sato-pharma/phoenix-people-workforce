import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  MEDICAL_REP_OTHER_MAX_FILES,
  isMedicalRepExpenseKind,
  medicalRepOtherFileProblem,
  validateMedicalRepOtherExpenseInput,
  type MedicalRepSimpleExpenseAttachment,
} from "../src/lib/outstation/medical-rep-expenses.ts";
import { judgeClaim, type ClaimCheckFacts } from "../src/lib/outstation/approvals/checks.ts";

/**
 * A MEDICAL REP CAN FILE AN "OTHER" EXPENSE — AN INVOICE HE PAID — BESIDE HIS TRAVELING ONE
 * (owner, 2026-11-23: "make it possible to choose either traveling as it is now or other … if other
 * no destination will be chosen, only a field for a comment, and it is required, and date, and
 * upload PDF or image is required, and make this option to pass by approval or rejection from the
 * system administrator").
 *
 * Pins: the four required parts and the file rule (one answer for the form and the server); the
 * save as `expense_type = 'other'`, `submitted`, with no destination and nothing approved; the
 * route's `kind` switch; and Expense Approvals never filing such a claim as Ready, so a Super Admin
 * always decides it.
 */

const TODAY = "2026-11-23";
const pdf: MedicalRepSimpleExpenseAttachment = {
  bytes: Buffer.from("%PDF-1.4"),
  contentType: "application/pdf",
  fileName: "invoice.pdf",
  size: 8,
};
const photo: MedicalRepSimpleExpenseAttachment = {
  bytes: Buffer.from("jpeg"),
  contentType: "image/jpeg",
  fileName: "receipt.jpg",
  size: 4,
};
const base = { amount: 350, attachments: [pdf], expenseDate: "2026-11-20", notes: "  Printing for the clinic day  " };

function functionBody(source: string, declaration: string): string {
  const start = source.indexOf(declaration);
  assert.ok(start >= 0, `${declaration} exists`);
  const next = source.indexOf("\nexport ", start + declaration.length);
  return source.slice(start, next < 0 ? undefined : next);
}

function validatorRules() {
  const normalized = validateMedicalRepOtherExpenseInput(base, TODAY);
  assert.equal(normalized.amount, 350);
  assert.equal(normalized.expenseDate, "2026-11-20T00:00:00.000Z", "the day is stored as the traveling form stores its dates");
  assert.equal(normalized.notes, "Printing for the clinic day");
  assert.equal(validateMedicalRepOtherExpenseInput({ ...base, attachments: [photo] }, TODAY).attachments.length, 1, "a photo alone is enough");
  assert.equal(validateMedicalRepOtherExpenseInput({ ...base, expenseDate: TODAY }, TODAY).expenseDate, "2026-11-23T00:00:00.000Z", "today is allowed");
  assert.equal(validateMedicalRepOtherExpenseInput({ ...base, amount: 12.345 }, TODAY).amount, 12.35);

  // Every refusal says "required", "invalid" or "must be", which the route answers as a 400.
  assert.throws(() => validateMedicalRepOtherExpenseInput({ ...base, expenseDate: "" }, TODAY), /date is required/i);
  assert.throws(() => validateMedicalRepOtherExpenseInput({ ...base, expenseDate: "20-11-2026" }, TODAY), /date is invalid/i);
  assert.throws(() => validateMedicalRepOtherExpenseInput({ ...base, expenseDate: "2026-11-24" }, TODAY), /date must be today or earlier/i, "a cost is already paid");
  assert.throws(() => validateMedicalRepOtherExpenseInput({ ...base, amount: 0 }, TODAY), /invoice amount is required/i);
  assert.throws(() => validateMedicalRepOtherExpenseInput({ ...base, amount: -5 }, TODAY), /amount is required/i);
  assert.throws(() => validateMedicalRepOtherExpenseInput({ ...base, amount: Number.NaN }, TODAY), /amount is required/i);
  assert.throws(() => validateMedicalRepOtherExpenseInput({ ...base, notes: "   " }, TODAY), /comment is required/i, "the comment is required");
  assert.throws(() => validateMedicalRepOtherExpenseInput({ ...base, attachments: [] }, TODAY), /invoice or receipt is required/i, "the file is required");
  assert.throws(
    () => validateMedicalRepOtherExpenseInput({ ...base, attachments: undefined as unknown as MedicalRepSimpleExpenseAttachment[] }, TODAY),
    /invoice or receipt is required/i,
    "a client that posts no file is refused, never waved through",
  );
  assert.throws(
    () => validateMedicalRepOtherExpenseInput({ ...base, attachments: [{ ...pdf, contentType: "text/plain", fileName: "a.txt" }] }, TODAY),
    /must be a pdf or a photo/i,
  );
  assert.throws(
    () => validateMedicalRepOtherExpenseInput({ ...base, attachments: Array(MEDICAL_REP_OTHER_MAX_FILES + 1).fill(pdf) }, TODAY),
    /files must be 3 or fewer/i,
  );
  assert.equal(
    medicalRepOtherFileProblem([{ contentType: "application/pdf", size: 5 * 1024 * 1024 }, { contentType: "application/pdf", size: 5 * 1024 * 1024 }]),
    "The files must be 9 MB or less together — remove one, or attach a smaller PDF.",
    "the whole form travels as one body through the proxy's 10 MB",
  );
  assert.equal(medicalRepOtherFileProblem([{ contentType: "image/png", size: 10 }, { contentType: "application/pdf", size: 10 }]), null);

  assert.equal(isMedicalRepExpenseKind("other"), true);
  assert.equal(isMedicalRepExpenseKind("traveling"), true);
  assert.equal(isMedicalRepExpenseKind("meeting"), false, "the rep's form offers two kinds only");
}

function savedAsAnOtherClaimThatWaits() {
  const service = readFileSync(new URL("../src/lib/outstation/service.ts", import.meta.url), "utf8");
  const body = functionBody(service, "export async function submitMedicalRepOtherExpenseRequest(");

  for (const [pattern, why] of [
    [/expense_type: "other"/, "stored as an Other expense"],
    [/^\s+status: "submitted",$/m, "it waits — nothing approves it at submit"],
    [/other_amount: normalized\.amount/, "the amount is the Other amount payroll already reads"],
    [/claimed_total_amount: normalized\.amount/, "the claim is the amount paid"],
    [/go_ticket_amount: 0/, "no ticket"],
    [/return_ticket_amount: 0/, "no ticket"],
    [/allowance_amount: 0/, "no allowance"],
    [/to_label: nonTravelDestinationLabel\("other"\)/, "no destination is chosen"],
    [/to_place_id: null/, "no destination is chosen"],
    [/captured_location_source: NON_TRAVEL_LOCATION_SOURCE/, "no position was taken"],
    [/captured_accuracy_meters: null,/, "no position, so no accuracy — 0 is the admin manual-entry marker the expense command reads"],
    [/evidence_gate_status: "grandfathered"/, "no photo step exists, so the gate must not hold an approved claim for ever"],
    [/validateMedicalRepOtherExpenseInput\(input, todayInCairo\(\)\)/, "the server judges with the form's own rule and Cairo's day"],
  ] as const) {
    assert.match(body, pattern, why);
  }
  for (const forbidden of ["approveOutstationRequestForPayroll", "releaseOutstationRequest", "writeClaimToPayrollInOneStep", "Residence location is not configured"]) {
    assert.ok(!body.includes(forbidden), `the Other submit must not contain ${forbidden}`);
  }
  const guard = body.indexOf("assertNoDuplicateTicket(");
  const upload = body.indexOf("uploadOutstationTicketAttachments(");
  assert.ok(guard > 0 && upload > guard, "the same-cost and same-receipt guard runs before any file is stored");
  assert.match(body, /otherAmount: normalized\.amount/, "the guard is asked about the Other amount");

  const route = readFileSync(new URL("../app/api/outstation/medical-rep-expenses/route.ts", import.meta.url), "utf8");
  assert.match(route, /kind: z\.enum\(\["traveling", "other"\]\)\.optional\(\)/);
  assert.match(route, /if \(fields\.kind === "other"\) \{[\s\S]*?submitMedicalRepOtherExpenseRequest\(access,/);
  assert.ok(
    route.indexOf('await assertPermission(access, "outstation", "create")') < route.indexOf("parseFormBody("),
    "the body is read only after the access check",
  );

  const form = readFileSync(new URL("../src/components/employee-portal/medical-rep-expenses.tsx", import.meta.url), "utf8");
  assert.ok(form.includes("medicalRepOtherFileProblem("), "the form judges the files with the server's own rule");
  assert.ok(form.includes("!invoiceProblem &&"), "Submit stays locked until the invoice is attached");
  assert.ok(form.includes('accept="image/*,application/pdf,.pdf"'), "a PDF or a photo can be picked");
  assert.ok(form.includes('formData.set("kind", "other")'));
  assert.ok(!form.includes("Traveling only"), "the form is no longer traveling only");
  // Owner, 2026-11-23: "make a field in the form to put the value of the invoice" — the field is named for the invoice.
  assert.ok(form.includes('<FormField label="Invoice amount (EGP)">'), "the value field is labelled as the invoice amount");
  assert.ok(!form.includes('label="Amount paid"'), "the old label is gone");

  const page = readFileSync(new URL("../app/employee-portals/expenses/page.tsx", import.meta.url), "utf8");
  assert.match(page, /canSubmitOther=\{canSubmitExpense\}/, "an invoice needs no home address on file");
}

function neverReadyOnTheDesk() {
  const facts = {
    attachments: 1,
    duplicateTickets: [],
    duplicateTrips: [],
    eligibilityReason: null,
    eligibilityStatus: "needs_review",
    evidenceGateStatus: "grandfathered",
    expenseType: "other",
    fieldWork: null,
    hasNoTicketFare: false,
    role: "Medical Rep",
    today: TODAY,
    transportation: "other",
    tripDates: ["2026-11-20"],
  } as unknown as ClaimCheckFacts;

  const withInvoice = judgeClaim(facts);
  assert.equal(withInvoice.lane, "your_call", "an Other claim is the Super Admin's call, never Ready");
  assert.deepEqual(withInvoice.checks.map((entry) => entry.key).sort(), ["amounts", "duplicate"], "no trip check applies to it");
  assert.match(withInvoice.reason ?? "", /read the invoice/i);

  const noInvoice = judgeClaim({ ...facts, attachments: 0 } as ClaimCheckFacts);
  assert.equal(noInvoice.lane, "your_call");
  assert.match(noInvoice.reason ?? "", /no invoice or picture attached/i);
}

export async function runMedicalRepOtherExpenseTests() {
  validatorRules();
  savedAsAnOtherClaimThatWaits();
  neverReadyOnTheDesk();
}
