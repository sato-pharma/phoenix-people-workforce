import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  resolveTargetCustomerLink,
  targetCustomerLinkSentence,
} from "@/lib/marketing-requests/target-customer-link";
import { stripComments } from "./support/comment-strip.ts";

/**
 * "Validated with <customer>" under every target pharmacy on the approval screens (owner,
 * 2026-10-31: "when the request go to the approval windows must obvious clear show that those ph are
 * validated with the customer").
 *
 * The venue stamp ("Validated") is about the pharmacy row; this line is about the customer↔pharmacy
 * LINK the request rests on. Pinned: the resolver's verdicts (a desk link is validated but says it is
 * a desk entry; a pending link and a missing link are never green), and that the summary and both
 * approval screens carry the server-resolved sentence.
 */
export function runMarketingTargetCustomerLinkTests() {
  const desk = "Validated at the desk by A on behalf of B. Pharmacy linked by code 1 — no field GPS or live photo of the pharmacy yet.";

  // Matched on the request's distributor code first.
  const byCode = resolveTargetCustomerLink(
    [
      { distributor_code_id: "code-a", pharmacy_id: "ph-1", validation_status: "pending" },
      { distributor_code_id: "code-b", pharmacy_id: "ph-1", validation_status: "system_validated" },
    ],
    { distributorCodeId: "code-b", pharmacyId: "ph-1" },
  );
  assert.deepEqual(byCode, { deskEntry: false, state: "validated" });
  assert.equal(targetCustomerLinkSentence(byCode, "احمد ياسين"), "Validated with احمد ياسين");

  // A desk link is validated, and says the pharmacy has no field photo.
  const deskLink = resolveTargetCustomerLink(
    [{ distributor_code_id: "code-a", pharmacy_id: "ph-1", validation_notes: desk, validation_status: "sfe_validated" }],
    { distributorCodeId: "code-a", pharmacyId: "ph-1" },
  );
  assert.deepEqual(deskLink, { deskEntry: true, state: "validated" });
  assert.match(targetCustomerLinkSentence(deskLink, "Dr X"), /^Validated with Dr X · desk entry, the pharmacy has no field photo$/);

  // A person's approval on the mapping screen counts as validated.
  assert.equal(
    resolveTargetCustomerLink(
      [{ distributor_code_id: null, pharmacy_id: "ph-1", validation_status: "admin_approved" }],
      { distributorCodeId: null, pharmacyId: "ph-1" },
    ).state,
    "validated",
  );

  // A code with no link falls back to the pharmacy; a pending link is never green.
  const pending = resolveTargetCustomerLink(
    [{ distributor_code_id: "code-z", pharmacy_id: "ph-1", validation_status: "pending" }],
    { distributorCodeId: "code-unread", pharmacyId: "ph-1" },
  );
  assert.equal(pending.state, "not_validated");
  assert.equal(targetCustomerLinkSentence(pending, null), "Not validated with this customer yet");

  // No link at all.
  const none = resolveTargetCustomerLink([], { distributorCodeId: "code-a", pharmacyId: "ph-9" });
  assert.equal(none.state, "no_link");
  assert.equal(targetCustomerLinkSentence(none, "Dr X"), "No link to Dr X on file");

  // The summary reads the request customer's own links and resolves the sentence on the server.
  const service = stripComments(readFileSync("src/lib/marketing-requests/service.ts", "utf8"));
  assert.match(
    service,
    /\.from\("marketing_customer_pharmacies"\)\s*\.select\("pharmacy_id, distributor_code_id, validation_status, validation_notes"\)\s*\.eq\("customer_id", request\.customerId\)/,
    "the decision summary must read the request customer's links to its target pharmacies",
  );
  assert.match(
    service,
    /customerLink: \(\(\) => \{[\s\S]*?resolveTargetCustomerLink\(customerLinkRows,[\s\S]*?sentence: targetCustomerLinkSentence\(link, linkCustomerName\)/,
    "each target pharmacy carries the resolved link and its sentence",
  );

  // Both approval screens print it.
  for (const file of [
    "src/components/marketing-requests/marketing-request-approver-detail.tsx",
    "src/components/employee-portal/marketing-request-decision-confirmation.tsx",
  ]) {
    const code = stripComments(readFileSync(file, "utf8"));
    assert.match(code, /\{pharmacy\.customerLink\.sentence\}/, `${file} must print the "Validated with <customer>" line`);
    assert.match(
      code,
      /pharmacy\.customerLink\.state === "validated" \? "text-emerald-800" : "text-amber-800"/,
      `${file} must colour anything short of a validated link amber`,
    );
  }
}
