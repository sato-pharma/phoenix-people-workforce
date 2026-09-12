import assert from "node:assert/strict";

import { validateManualEmailRecipientPolicy } from "../src/lib/email/email-safety.ts";
import { HOUSE_COLORS } from "../src/lib/hiring-pack/house-identity.ts";
import {
  SATO_EMAIL_MAX_PER_EMAIL,
  buildSatoEmailIdempotencyKey,
  buildSatoEmailSendPlan,
  findUnfilledPlaceholders,
} from "../src/lib/sato-email/plan.ts";
import { renderSatoEmail } from "../src/lib/sato-email/render.ts";

/**
 * THE SATO EMAIL WEARS THE HOUSE IDENTITY, NOT PHOENIX. Owner 2026-09-11: "use the Sato identity,
 * not the Phoenix." The ink rule and the square-edge rule reach the sender's own body too.
 */
export function runSatoEmailRenderTests() {
  const { html, text } = renderSatoEmail({
    bodyHtml:
      '<p style="background-color:#ffff00">مرحبا بكم</p><p>Hello team</p>' +
      '<table><tr><td bgcolor="#eeeeee">cell</td></tr></table><script>alert(1)</script>',
    signOff: "Human Resources",
    subject: "Public holiday: <Eid>",
  });

  assert.match(
    html,
    /<img src="https:\/\/[^"]+\/brand\/sato-pharma-logo-on-light\.png"/,
    "the mark must be the ON-LIGHT png by absolute https URL — email clients drop data: images",
  );
  assert.ok(!/sato-pharma-logo\.png/.test(html), "never the stock mark, which sets SATO in white and vanishes on white");

  const visible = html.replace(/<[^>]+>/g, " ");
  assert.ok(!/phoenix/i.test(visible), "nothing a reader sees may say Phoenix");
  assert.ok(!/phoenix/i.test(text), "nor the plain-text part");

  assert.ok(!/border-radius/i.test(html), "square edges — no radius anywhere");
  assert.ok(!/box-shadow/i.test(html), "no depth effects");

  assert.ok(!/bgcolor/i.test(html), "a fill the sender added to a table cell must be stripped — the ink rule");
  assert.ok(!/background-color/i.test(html), "a highlight the sender picked must be stripped — the ink rule");
  const grounds = [...html.matchAll(/background\s*:\s*([^;"]+)/gi)].map((match) => match[1].trim().toLowerCase());
  assert.ok(grounds.length > 0 && grounds.every((value) => value === "#ffffff"), "the only ground is plain white paper");

  assert.ok(html.includes(HOUSE_COLORS.deep), "the heading is in the logo's deep blue");
  assert.ok(html.includes(HOUSE_COLORS.blue), "the brand rule is in the PHARMA blue");

  assert.ok(html.includes("Public holiday: &lt;Eid&gt;"), "the subject is escaped");
  assert.ok(!/<script/i.test(html), "the body is sanitised");

  assert.match(html, /<p dir="auto"[^>]*>مرحبا بكم<\/p>/, "each line carries its own direction, so Arabic and English both read right");

  assert.match(text, /Hello team/, "the plain-text part carries the body");
  assert.match(text, /Regards,\nHuman Resources/, "and the sign-off");

  const unsigned = renderSatoEmail({ bodyHtml: "<p>Body</p>", signOff: "  ", subject: "Subject" });
  assert.ok(!unsigned.html.includes("Regards,"), "an empty sign-off leaves no dangling 'Regards,'");
}

export function runSatoEmailPlanTests() {
  const people = Array.from({ length: 95 }, (_, index) => ({
    email: `Person${index}@SatoPharma.com`,
    hrId: `B-${index}`,
    name: `Person ${index}`,
  }));
  const plan = buildSatoEmailSendPlan([...people, { email: " person3@satopharma.com ", hrId: "B-3", name: "Duplicate" }]);

  assert.equal(plan.recipients.length, 95, "the same address in a different case is the same person, counted once");
  assert.deepEqual(plan.batches.map((batch) => batch.length), [25, 25, 25, 20], "a big list is cut into emails of at most 25");
  assert.equal(new Set(plan.batches.flat()).size, 95, "nobody lands in two emails");
  assert.ok(
    SATO_EMAIL_MAX_PER_EMAIL + 2 <= 50,
    "each email must stay under Resend's 50-recipient limit after the standing admin Bcc and the neutral To are added",
  );

  // 🔴 THE REASON THE BATCH IS 25 AND NOT 40. Every email this composer sends is a MANUAL email, so
  // it must pass the cap the system already applies to one — rather than that cap being widened for
  // this screen, which would widen it for the older HR reply composer too. Asserted against the
  // policy's OWN answer, so an operator raising PHOENIX_HR_EMAIL_MAX_RECIPIENTS cannot silently
  // leave the batch size above it.
  const fullBatch = Array.from({ length: SATO_EMAIL_MAX_PER_EMAIL }, (_, index) => `person${index}@satopharma.com`);
  const policy = validateManualEmailRecipientPolicy({ to: fullBatch });
  assert.ok(
    SATO_EMAIL_MAX_PER_EMAIL <= policy.maxRecipients,
    `a full email of ${SATO_EMAIL_MAX_PER_EMAIL} must fit the manual-email cap of ${policy.maxRecipients}`,
  );
  assert.deepEqual(
    policy.issues.map((issue) => issue.code),
    [],
    "a full batch of employee addresses raises no manual-email policy issue",
  );

  assert.deepEqual(
    findUnfilledPlaceholders("Public holiday: [Holiday name]", "<p>Back on [Day and date], see array[1].</p>"),
    ["[Holiday name]", "[Day and date]"],
    "unfilled template gaps are found, a one-character bracket is not",
  );
  assert.deepEqual(findUnfilledPlaceholders("Nothing left to fill"), []);

  const base = { batch: ["a@satopharma.com", "b@satopharma.com"], batchIndex: 0, clientRequestId: "req-1", html: "<p>x</p>", senderId: "B-10", subject: "S" };
  assert.equal(buildSatoEmailIdempotencyKey(base), buildSatoEmailIdempotencyKey({ ...base, batch: ["b@satopharma.com", "a@satopharma.com"] }), "a double-click re-sends nothing");
  assert.notEqual(buildSatoEmailIdempotencyKey(base), buildSatoEmailIdempotencyKey({ ...base, batchIndex: 1 }), "each email in a send has its own key");
  assert.notEqual(buildSatoEmailIdempotencyKey(base), buildSatoEmailIdempotencyKey({ ...base, clientRequestId: "req-2" }), "a deliberate second send still goes");
}
