import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Premium offer email — source-level guards. The .tsx renderers are stubbed under the test
 * harness (JSX can't be type-stripped), so — like the other email governance tests — this
 * asserts on the real source files. The rendered output itself is verified via browser E2E.
 *
 * Guarantees: (1) NO salary in the email body (salary lives on the secure page + the attached
 * PDF only); (2) a premium zebra-striped details table; (3) offers send via the fixed premium
 * renderer with attachments + the HR reply-to.
 */
export function runOfferEmailPremiumTests() {
  const offerLetterSrc = readFileSync("src/emails/offer-letter.tsx", "utf8");
  const layoutSrc = readFileSync("src/emails/phoenix-email-layout.tsx", "utf8");
  const offerEmailSrc = readFileSync("src/lib/offers/email.ts", "utf8");

  // 1) No salary rows in the offer email's details table.
  assert.doesNotMatch(offerLetterSrc, /"Base Salary"/, "offer email must not show Base Salary");
  assert.doesNotMatch(offerLetterSrc, /"Basic Salary"/, "offer email must not show Basic Salary");
  assert.doesNotMatch(offerLetterSrc, /"Net Salary"/, "offer email must not show Net Salary");

  // 2) Premium zebra-striped details table lives in the shared layout.
  assert.match(layoutSrc, /renderPhoenixMetadataTable/, "layout must render the details table");
  assert.match(layoutSrc, /phoenix-metadata-row-alt/, "details table must be zebra-striped (alternating rows)");

  // 3) Offers use the fixed premium renderer (sendPhoenixEmail) with attachments + HR reply-to,
  //    NOT the editable DB template engine.
  assert.match(offerEmailSrc, /sendPhoenixEmail\(/, "offers must send via sendPhoenixEmail directly");
  assert.match(offerEmailSrc, /renderOfferLetterEmailHtml/, "offers must use the fixed premium renderer");
  assert.match(offerEmailSrc, /attachments:\s*input\.attachments/, "offer send must pass attachments through");
  assert.match(offerEmailSrc, /hr@satopharma\.com/, "offer reply-to must default to the HR inbox");
  assert.doesNotMatch(offerEmailSrc, /sendTemplatedEmail/, "offers must no longer use the templated-email path");
}
