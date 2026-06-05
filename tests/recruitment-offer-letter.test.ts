import assert from "node:assert/strict";

import { renderOfferLetterHtml, type OfferLetterVersion } from "../src/lib/recruitment/offer-letters.ts";

export function runRecruitmentOfferLetterTests() {
  const version: OfferLetterVersion = {
    id: "v1",
    offerId: "o1",
    applicationId: "a1",
    version: 2,
    kind: "offer_letter",
    snapshot: {
      candidateName: "Ahmed <script>alert(1)</script>",
      jobTitle: "Medical Rep",
      offerCode: "OFF-2026-001",
      baseSalary: 10000,
      netSalary: 9000,
      grossSalary: 12000,
      fuelAllowance: 500,
      startDate: "2026-07-01",
    },
    generatedBy: "a16",
    generatedAt: "2026-06-05T00:00:00.000Z",
  };

  const html = renderOfferLetterHtml(version);
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /Version 2/);
  assert.match(html, /Medical Rep/);
  assert.match(html, /EGP 10,000/);
  assert.match(html, /Phoenix Workforce/); // brand from system-settings

  // Candidate name must be HTML-escaped (no raw script injection).
  assert.ok(!html.includes("<script>alert(1)"), "candidate name must be escaped");
  assert.match(html, /Ahmed &lt;script&gt;/);

  // Missing/zero figures render as a dash, not "EGP 0".
  const empty = renderOfferLetterHtml({ ...version, snapshot: { candidateName: "Sara", jobTitle: "Rep" } });
  assert.match(empty, /Sara/);
  assert.doesNotMatch(empty, /EGP 0\b/);
}
