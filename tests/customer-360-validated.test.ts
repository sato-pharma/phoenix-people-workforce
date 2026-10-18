import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import {
  isCountedDirectOrder,
  isCountedMarketingLinkStatus,
  isDroppedPhoenixRow,
  isTrustedDirectOrderVenue,
  isValidatedMarketingCustomer,
  isValidatedPhoenixHubRow,
  marketingCustomerHubKind,
  phoenixContactId,
  phoenixHubKind,
  PLACEHOLDER_CONTACT_CRM_ID,
  type MarketingCustomerRow,
  type PhoenixCustomerRow,
} from "../src/lib/customer-360/validated.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Customer 360 counts VALIDATED customers only (owner, 2026-10-18: "you will work only on validated
 * customers … because of the correct data"). Every status word lives in `validated.ts`; this suite
 * pins the rule and refuses a second definition of "validated" anywhere else in the module.
 */

function phoenixRow(overrides: Partial<PhoenixCustomerRow> = {}): PhoenixCustomerRow {
  return {
    id: "pc-1",
    is_test: false,
    list_type: "PM",
    own_contact_crm_id: null,
    reference_contact_crm_id: 555,
    speciality: "Pediatrics",
    status: "active",
    validated_at: "2026-10-10T08:00:00Z",
    ...overrides,
  };
}

function marketingCustomer(overrides: Partial<MarketingCustomerRow> = {}): MarketingCustomerRow {
  return { active: true, customer_type: "clinic", id: "mc-1", merged_into_customer_id: null, validation_status: "system_validated", ...overrides };
}

const MODULE_FOLDERS = [
  "src/lib/customer-360",
  "src/components/customer-360",
  "app/(admin)/customer-360",
  "app/api/customer-360",
];

/** The two files allowed to spell a status word: the rule itself, and the label map that renders it. */
const MAY_SPELL_A_STATUS = new Set(["src/lib/customer-360/validated.ts", "src/lib/customer-360/labels.ts"]);

const STATUS_LITERAL = /["'](?:system_validated|sfe_validated|admin_approved|trusted|provisional)["']/;
const STATUS_FILTER = /\.(?:eq|neq|in|not|is|filter)\(\s*["'](?:validated_at|trust_state|validation_status)["']/;

function sourceFiles(directory: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full.replace(/\\/g, "/"));
  }
  return out;
}

export function runCustomer360ValidatedTests() {
  // ── Phoenix CRM: a validated PM or AM customer is a hub ───────────────────────────────────────
  assert.equal(isValidatedPhoenixHubRow(phoenixRow()), true, "a validated, active PM doctor is a hub");
  assert.equal(isValidatedPhoenixHubRow(phoenixRow({ validated_at: null })), false, "a customer still pending validation is out");
  assert.equal(isValidatedPhoenixHubRow(phoenixRow({ is_test: true })), false, "a test row is never a customer");
  assert.equal(isValidatedPhoenixHubRow(phoenixRow({ list_type: "Pharmacy" })), false, "a pharmacy on the list is a shop, never a hub");
  assert.equal(isValidatedPhoenixHubRow(phoenixRow({ status: "pending" })), false, "only active or dropped rows count");
  assert.equal(isValidatedPhoenixHubRow(phoenixRow({ status: "dropped" })), true, "a dropped customer keeps his history in the report");
  assert.equal(isDroppedPhoenixRow(phoenixRow({ status: " Dropped " })), true, "dropped is read case- and space-blind");
  assert.equal(
    isValidatedPhoenixHubRow(phoenixRow({ reference_contact_crm_id: PLACEHOLDER_CONTACT_CRM_ID })),
    false,
    "the iReports360 placeholder contact is never a person",
  );
  assert.equal(
    isValidatedPhoenixHubRow(phoenixRow({ own_contact_crm_id: null, reference_contact_crm_id: null })),
    false,
    "a row with no contact id cannot be joined to anything",
  );
  assert.equal(isValidatedPhoenixHubRow(phoenixRow({ speciality: "Pharmacy" })), false, "a pharmacy filed on a doctor's list is not a doctor");
  assert.equal(
    phoenixContactId({ own_contact_crm_id: 777, reference_contact_crm_id: null }),
    777,
    "a customer a rep added himself is known by the contact Phoenix minted for him",
  );
  assert.equal(phoenixContactId({ own_contact_crm_id: 777, reference_contact_crm_id: 555 }), 555, "the carried-over contact wins");
  assert.equal(phoenixHubKind("PM"), "doctor");
  assert.equal(phoenixHubKind(" am "), "account", "AM is an account, read case- and space-blind");
  assert.equal(phoenixHubKind("Pharmacy"), null, "a pharmacy list is no hub kind");

  // ── Marketing customers ───────────────────────────────────────────────────────────────────────
  assert.equal(isValidatedMarketingCustomer(marketingCustomer()), true, "system validated counts");
  assert.equal(isValidatedMarketingCustomer(marketingCustomer({ validation_status: "sfe_validated" })), true, "SFE validated counts");
  assert.equal(isValidatedMarketingCustomer(marketingCustomer({ validation_status: "pending" })), false, "pending is out");
  assert.equal(isValidatedMarketingCustomer(marketingCustomer({ active: false })), false, "an inactive customer is out");
  assert.equal(isValidatedMarketingCustomer(marketingCustomer({ merged_into_customer_id: "mc-2" })), false, "a merged-away row is out");
  assert.equal(marketingCustomerHubKind("clinic"), "doctor", "a clinic is the doctor's own place");
  assert.equal(marketingCustomerHubKind("Doctor"), "doctor");
  for (const type of ["hospital", "account", "other", null]) {
    assert.equal(marketingCustomerHubKind(type), "account", `a marketing customer of type ${String(type)} is an account`);
  }

  // ── The ties: link status, venue trust, counted orders ────────────────────────────────────────
  for (const status of ["admin_approved", "sfe_validated", "system_validated"]) {
    assert.equal(isCountedMarketingLinkStatus(status), true, `a link at ${status} ties the pharmacy`);
  }
  for (const status of ["pending", "rejected", null]) {
    assert.equal(isCountedMarketingLinkStatus(status), false, `a link at ${String(status)} ties nothing`);
  }
  const venue = { active: true, merged_into_pharmacy_id: null, trust_state: "trusted" };
  assert.equal(isTrustedDirectOrderVenue(venue), true, "a trusted direct-order venue ties to its doctor");
  assert.equal(isTrustedDirectOrderVenue({ ...venue, trust_state: "provisional" }), false, "a venue on probation does not");
  assert.equal(isTrustedDirectOrderVenue({ ...venue, active: false }), false, "an inactive venue does not");
  assert.equal(isTrustedDirectOrderVenue({ ...venue, merged_into_pharmacy_id: "v-2" }), false, "a merged-away venue does not");
  const order = { reversal_of_request_id: null, reversed_by_request_id: null, status: "approved" };
  assert.equal(isCountedDirectOrder(order), true, "an approved order counts");
  assert.equal(isCountedDirectOrder({ ...order, status: "pending_sfe" }), false, "an order not yet approved does not");
  assert.equal(isCountedDirectOrder({ ...order, reversal_of_request_id: "r-1" }), false, "a reversal is not a sale");
  assert.equal(isCountedDirectOrder({ ...order, reversed_by_request_id: "r-2" }), false, "a reversed order is not a sale");

  // ── One definition of "validated" ─────────────────────────────────────────────────────────────
  // The guard must be able to see a status word at all, or every clean result below is vacuous.
  const rule = stripComments(readFileSync("src/lib/customer-360/validated.ts", "utf8"));
  assert.match(rule, STATUS_LITERAL, "the guard's pattern catches the status words the rule file spells");

  const files = MODULE_FOLDERS.flatMap((folder) => sourceFiles(folder));
  assert.ok(files.length >= 25, `the module scan found only ${files.length} files — it has stopped seeing the module`);
  for (const file of files) {
    if (MAY_SPELL_A_STATUS.has(file)) continue;
    const code = stripComments(readFileSync(file, "utf8"));
    assert.doesNotMatch(code, STATUS_LITERAL, `${file} spells a validation status — "validated" is decided in validated.ts only`);
    assert.doesNotMatch(code, STATUS_FILTER, `${file} filters on a validation column — use validated.ts's rule`);
  }
}
