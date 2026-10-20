import assert from "node:assert/strict";

import { renderWebsiteApplyConfirmationEmail } from "../src/lib/recruitment/inbound/website-apply-confirmation-email.ts";

/**
 * The PURE render of the careers-site confirmation letter. It must be the SATO house template
 * (SATO-DIS-2026-01) and NOT the Phoenix shell — the owner's explicit requirement — must greet the
 * applicant by first name, name the role they applied for, and escape anything they typed.
 */
export function runWebsiteApplyConfirmationEmailTests() {
  const { subject, html, text } = renderWebsiteApplyConfirmationEmail({
    fullName: "Mariam Adel Hassan",
    roleTitle: "Talent Acquisition Specialist",
  });

  // The subject names the role and reads as a confirmation.
  assert.equal(subject, "We've received your application — Talent Acquisition Specialist");
  assert.match(html, /Talent Acquisition Specialist/);
  assert.match(text, /Talent Acquisition Specialist/);

  // Greeted "Dr" and the FIRST name only, never the whole string (owner, 2026-10-20: every
  // candidate is greeted with Dr — candidateGreetingName).
  assert.match(html, /Dear Dr Mariam,/);
  assert.doesNotMatch(html, /Dear Mariam Adel Hassan/);

  // SATO identity, not the Phoenix shell: the readable letter carries the SATO house-template
  // reference (SATO-DIS-2026-01) and the Sato letterhead, and the visible text never says "Phoenix".
  // (The blanket html must NOT be scanned for /Phoenix/: the brand images are hosted on the
  // phoenix-hr.satopharma.com subdomain — infrastructure, not anything a recipient reads.)
  assert.match(html, /Sato Pharma/);
  assert.match(html, /SATO-DIS-2026-01/);
  assert.doesNotMatch(text, /Phoenix/i);
  // Signed with the DEPARTMENT only. The letterhead and the provenance stamp already carry "Sato
  // Pharma", so the sign-off must NOT repeat the company name (the duplicate the owner flagged) and
  // must not say Talent Acquisition. The sign-off line is exactly "Regards, / Human Resources".
  assert.match(text, /Regards,\s*\n\s*Human Resources\b/);
  assert.doesNotMatch(text, /Regards,\s*\n\s*Sato Pharma/);
  assert.doesNotMatch(text, /Regards,\s*\n\s*Talent Acquisition/);

  // The house template's own chrome is present (renderSatoEmail wraps the body): it is a full HTML doc.
  assert.match(html, /<html/i);
  assert.match(html, /Application received/); // the kicker

  // Applicant-supplied text is HTML-escaped — a name with markup cannot inject into the letter.
  const injected = renderWebsiteApplyConfirmationEmail({
    fullName: "<script>alert(1)</script> Ali",
    roleTitle: "Talent Acquisition Specialist",
  });
  assert.doesNotMatch(injected.html, /<script>alert\(1\)<\/script>/);
  assert.match(injected.html, /&lt;script&gt;/);
}
