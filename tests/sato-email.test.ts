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
  assert.ok(grounds.length > 0, "the mail lays its own white ground rather than inheriting the client's");
  // 🔴 THIS BODY'S TABLE IS ONE ROW, AND A SINGLE ROW IS NEVER STRIPED — so white really is the only
  // ground here, and this assertion says nothing at all about the zebra. It read as the ink rule's
  // guard for a while and was blind to the one fill the house format allows. The zebra is pinned
  // properly in `runSatoEmailHouseTemplateTests`, against a table with enough rows to stripe.
  assert.ok(grounds.every((value) => value === "#ffffff"), "a one-row table adds no ground of its own");

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

/**
 * THE TEMPLATE WEARS THE JOURNEY PAPER'S DEVICES. Owner 2026-09-12, sending that paper as the
 * reference for this email and settling the one detail he sent back: "keep the blue marker".
 *
 * Each assertion below pins a DECISION, not a measurement — the shape of a heading, what carries a
 * list item, where the company is named. A number inside one (a padding, a size) is incidental; the
 * relationship it expresses is the thing. Break one and the message tells you which decision moved.
 */
export function runSatoEmailHouseTemplateTests() {
  const { html } = renderSatoEmail({
    bodyHtml:
      "<h2>What is closing</h2>" +
      "<blockquote>The offices close on Thursday and reopen on Monday.</blockquote>" +
      "<ul><li>Hand any pending claim to your manager.</li></ul>" +
      "<table><thead><tr><th>Day</th><th>Offices</th></tr></thead><tbody>" +
      "<tr><td>Thursday</td><td>Closed</td></tr>" +
      "<tr><td>Friday</td><td>Closed</td></tr>" +
      "<tr><td>Saturday</td><td>Closed</td></tr>" +
      "<tr><td>Sunday</td><td>Open</td></tr>" +
      "</tbody></table>",
    signOff: "Human Resources",
    subject: "Eid al-Adha holiday",
  });

  // 🔴 THE ZEBRA, MEASURED ON A TABLE BIG ENOUGH TO HAVE ONE. Four data rows, so the second and the
  // fourth carry the tint and the head carries nothing: a `<th>` is not data, and a head sharing the
  // body's rhythm loses the thing a head is for.
  const rows = html.split(/<tr[^>]*>/i).slice(1);
  const striped = rows.filter((row) => row.includes(`background:${HOUSE_COLORS.tint}`));
  assert.equal(striped.length, 2, "of four data rows, exactly two are striped");
  assert.ok(
    striped.every((row) => /Friday|Sunday/.test(row)),
    "the SECOND and FOURTH data rows are the striped ones — the count starts after the head, not at it",
  );
  assert.ok(!/<th[^>]*background/i.test(html), "a header row is never striped");

  const grounds = [...html.matchAll(/background\s*:\s*([^;"]+)/gi)].map((match) => match[1].trim().toUpperCase());
  assert.deepEqual(
    [...new Set(grounds)].sort(),
    ["#F2F6FA", "#FFFFFF"],
    "THE INK RULE: white paper and the 6% zebra row are the only two grounds in the whole mail",
  );

  // THE SECTION DEVICE: a heading is a rule with an uppercase label under it. The paper never sets a
  // heading as large text, which is what makes pages of unrelated content read as one document.
  assert.ok(
    !/font-size:18px;font-weight:bold/.test(html),
    "a heading never survives as the sanitizer's bold paragraph — it becomes the section device",
  );
  const section = new RegExp(
    `border-top:\\d+px solid ${HOUSE_COLORS.deep};[^"]*">&nbsp;</td></tr><tr><td[^>]*text-transform:uppercase[^>]*>([^<]+)</td>`,
    "i",
  ).exec(html);
  assert.ok(section, "a heading emits a deep rule with a tracked uppercase label under it");
  assert.equal(section?.[1], "What is closing", "and the label is the heading the sender typed");

  // 🔴 NO RULE UNDER A LIST ITEM, AND THE MARKER KEEPS THE BRAND BLUE. Owner 2026-09-12: "i am not
  // happy with the list rules", then "keep the blue marker". The item is set in blue so the bullet
  // takes it, and the item's own words are wrapped back to body ink.
  assert.ok(!/<li[^>]*border-bottom/i.test(html), "a list item carries no rule");
  assert.match(
    html,
    new RegExp(`<li[^>]*color:${HOUSE_COLORS.blue}"><span style="color:${HOUSE_COLORS.body}">`),
    "the marker takes the PHARMA blue and the words stay in body ink",
  );

  // THE CALLOUT: a light edge and hairlines on white, never the tinted box — that is a filled area.
  assert.match(
    html,
    new RegExp(`<blockquote[^>]*border-left:3px solid ${HOUSE_COLORS.light}`),
    "a quote is the paper's callout — a thick light edge on white",
  );

  // THE PROVENANCE FOOT, and the masthead that no longer duplicates it. The mark says the company;
  // the head carries the reference instead, and the legal person is stated ONCE, where an issuer
  // belongs. So "Sato Pharma" appears exactly twice: the mark's alt text, and the foot.
  assert.ok(html.includes(">Issued by</div>"), "the foot names the issuer under a micro label");
  assert.ok(html.includes(">Reference</div>"), "and the standard under its own");
  assert.equal(
    (html.match(/Sato Pharma/g) || []).length,
    2,
    "the mark's alt text and the provenance foot — the masthead does not typeset the name a second time",
  );
  assert.equal(
    (html.match(/SATO-DIS-2026-01 v1\.0/g) || []).length,
    2,
    "THE DOCUMENT IDENTITY is stamped twice: the masthead reference and the provenance foot",
  );

  // THE COLOPHON: a SHORT centred rule closes the document. Full width would open a section.
  assert.match(html, /<table[^>]*width="180"/, "the colophon rule is a third of the column, not the whole of it");
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
