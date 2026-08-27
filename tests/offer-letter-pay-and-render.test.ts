import { strict as assert } from "node:assert";

import {
  OFFER_SEED_JOB_TITLES,
  defaultOfferBlocks,
} from "../src/lib/offers/default-template.ts";
import { OFFER_BASIC_SHARE, deriveOfferPay, formatOfferAmount } from "../src/lib/offers/pay.ts";
import {
  buildOfferTokens,
  fillOfferTokens,
  renderOfferBlock,
  renderOfferDocument,
} from "../src/lib/offers/render.ts";
import { renderOfferEmail } from "../src/lib/offers/render-email.ts";
import type { OfferFields } from "../src/lib/offers/types.ts";

/**
 * The job-offer letter — its compensation formula and its renderer.
 *
 * An offer is a document somebody signs and is then paid against. Three things here can be wrong
 * in ways nobody notices until a real person is underpaid, so all three are pinned:
 *
 *   1. THE FORMULA. One typed number (the total monthly package) produces five figures and four
 *      annual columns. It was reverse-engineered from three signed offers, so those three are the
 *      fixtures: if the arithmetic ever drifts, these fail with the real names attached.
 *
 *   2. THE RE-SUM IDENTITY. basic + transport + cost of living must equal the total EXACTLY, at
 *      every input, or the table on the letter contradicts its own headline. Taking transport as
 *      the remainder rather than a second rounding is what guarantees it — so the property is
 *      asserted across a sweep, not just on the three fixtures.
 *
 *   3. THE HEADLINE MATCHING THE TABLE. The hero figure and the total row are rendered from the
 *      same derived tokens as the body rows. A template that let those diverge would print an
 *      offer whose big blue number disagrees with the sum beneath it.
 */

const SAMAA: OfferFields = {
  candidateEmail: "samaa@example.com",
  candidateName: "SAMAA SHALABY",
  contractTerm: "One year, renewable",
  costOfLiving: 3500,
  dateOfIssue: "26-Aug-26",
  reference: "SP-HR-DSM-2026-019",
  reportsTo: "National Sales Manager",
  salutationName: "Dr SAMAA SHALABY",
  startDate: "1 September 2026",
  territory: "Delta (3)",
  title: "District Sales Manager",
  totalMonthly: 30000,
  validUntil: "1 September 2026",
};

export function runOfferLetterPayAndRenderTests() {
  // ---------------------------------------------------------------- the formula --
  // The three signed offers this formula was decoded from. Basic and transport are what the
  // signed PDFs actually say — not what this code computes — so a drift shows up as a mismatch
  // against a real document rather than against another line of our own code.
  const signedOffers = [
    { basic: 18550, costOfLiving: 3500, name: "Dr Samaa Shalaby (DSM, Delta 3)", total: 30000, transport: 7950 },
    { basic: 10150, costOfLiving: 2500, name: "Omar Tamer (MR, Tanta)", total: 17000, transport: 4350 },
    { basic: 11550, costOfLiving: 2500, name: "Adel Srour (Senior MR, Downtown)", total: 19000, transport: 4950 },
  ];

  for (const offer of signedOffers) {
    const pay = deriveOfferPay({ costOfLiving: offer.costOfLiving, totalMonthly: offer.total });

    assert.equal(pay.basic.monthly, offer.basic, `${offer.name}: basic salary must match the signed offer`);
    assert.equal(
      pay.transport.monthly,
      offer.transport,
      `${offer.name}: transportation allowance must match the signed offer`,
    );
    assert.equal(pay.costOfLiving.monthly, offer.costOfLiving, `${offer.name}: cost of living is flat per title`);
    assert.equal(pay.total.monthly, offer.total, `${offer.name}: total must be what was typed`);

    // Every annual column is exactly twelve months of its own monthly figure.
    assert.equal(pay.basic.annual, offer.basic * 12, `${offer.name}: annual basic`);
    assert.equal(pay.transport.annual, offer.transport * 12, `${offer.name}: annual transport`);
    assert.equal(pay.costOfLiving.annual, offer.costOfLiving * 12, `${offer.name}: annual cost of living`);
    assert.equal(pay.total.annual, offer.total * 12, `${offer.name}: annual total`);
  }

  // ------------------------------------------------------- the re-sum identity --
  // A sweep, not three fixtures: two independent roundings would pass the three above and still
  // drift by a pound on some other package.
  //
  // The step is ONE POUND on purpose, and that detail is the whole test. Rounding basic and
  // transport separately drifts if and only if 0.7 x remainder lands exactly on .5 — which
  // happens exactly when the remainder ends in 5. A coarser sweep (this was written stepping by
  // 250) never produces such a remainder, so it passes against the broken formula and proves
  // nothing. Every pound from 5,000 to 25,000 covers the real offer range and every residue.
  let checked = 0;
  for (const seed of OFFER_SEED_JOB_TITLES) {
    for (let total = 5000; total <= 25000; total += 1) {
      const pay = deriveOfferPay({ costOfLiving: seed.costOfLiving, totalMonthly: total });
      assert.equal(
        pay.basic.monthly + pay.transport.monthly + pay.costOfLiving.monthly,
        pay.total.monthly,
        `components must re-sum exactly at total ${total} for ${seed.title}`,
      );
      assert.ok(pay.basic.monthly >= 0, `basic must never be negative (total ${total})`);
      assert.ok(pay.transport.monthly >= 0, `transport must never be negative (total ${total})`);
      assert.ok(
        Number.isInteger(pay.basic.monthly) && Number.isInteger(pay.transport.monthly),
        `figures must be whole pounds (total ${total})`,
      );
      checked += 1;
    }
  }
  assert.ok(checked > 50000, `the sweep must actually run at one-pound resolution (checked ${checked})`);

  // The named worked example of the drift, kept explicit so the reason survives a refactor.
  // 10,005 − 2,500 = 7,505. Seventy percent of that is 5,253.5 and thirty percent is 2,251.5:
  // rounding each independently rounds BOTH halves up and yields 7,506 — one pound more than the
  // package, printed on a document somebody signs. Taking transport as the remainder cannot.
  const drift = deriveOfferPay({ costOfLiving: 2500, totalMonthly: 10005 });
  assert.equal(drift.basic.monthly, 5254, "basic rounds up from 5,253.5");
  assert.equal(drift.transport.monthly, 2251, "transport absorbs the rounding as the remainder");
  assert.equal(
    drift.basic.monthly + drift.transport.monthly + drift.costOfLiving.monthly,
    10005,
    "the .5 case must re-sum exactly — this is the case a second rounding gets wrong",
  );

  // Nonsense input must not print a negative salary on a legal document.
  const overrun = deriveOfferPay({ costOfLiving: 9000, totalMonthly: 5000 });
  assert.equal(overrun.costOfLiving.monthly, 5000, "cost of living cannot exceed the package");
  assert.equal(overrun.basic.monthly, 0, "an over-run package yields no basic, never a negative one");
  assert.equal(overrun.transport.monthly, 0, "an over-run package yields no transport");

  const empty = deriveOfferPay({ costOfLiving: 0, totalMonthly: 0 });
  assert.equal(empty.total.monthly, 0, "an empty offer derives zeros, not NaN");
  assert.ok(Number.isFinite(empty.basic.annual), "an empty offer must not produce NaN annuals");

  // The share is a named constant, and the whole formula pivots on it.
  assert.equal(OFFER_BASIC_SHARE, 0.7, "the basic share is 70% of the post-cost-of-living remainder");

  // ------------------------------------------------------------ the seed titles --
  // The owner gave these three figures directly (2026-08-26). A silent edit changes real pay.
  const byTitle = new Map(OFFER_SEED_JOB_TITLES.map((t) => [t.title, t.costOfLiving]));
  assert.equal(byTitle.get("National Sales Manager"), 5500, "NSM cost of living");
  assert.equal(byTitle.get("District Sales Manager"), 3500, "DSM cost of living");
  assert.equal(byTitle.get("Medical Representative"), 2500, "Medical Rep cost of living");

  // ------------------------------------------------------------------- tokens --
  const tokens = buildOfferTokens(SAMAA);
  assert.equal(tokens.basicMonthly, "18,550", "the basic token is formatted with separators");
  assert.equal(tokens.basicAnnual, "222,600", "the annual basic token");
  assert.equal(tokens.transportMonthly, "7,950", "the transport token");
  assert.equal(tokens.totalAnnual, "360,000", "the annual total token");
  assert.equal(tokens.title, "District Sales Manager", "the job title token");

  // An unknown token stays visible. Blanking it would print a hole in a signed document.
  const filled = fillOfferTokens("{{salutationName}} / {{reprotsTo}}", tokens);
  assert.ok(filled.includes("Dr SAMAA SHALABY"), "a known token is substituted");
  assert.ok(filled.includes("{{reprotsTo}}"), "an unknown token must stay visible, not blank out");

  // A candidate's name is data, not markup — it must never reach the document as live HTML.
  const injected = buildOfferTokens({ ...SAMAA, candidateName: '<img src=x onerror="alert(1)">' });
  const injectedOut = fillOfferTokens("{{candidateName}}", injected);
  assert.ok(!injectedOut.includes("<img"), "a name containing markup must be escaped");
  assert.ok(injectedOut.includes("&lt;img"), "the escaped form is what reaches the page");

  // ---------------------------------------------------------------- the render --
  const blocks = defaultOfferBlocks();
  assert.ok(blocks.length >= 15, `the default template must carry the full design (${blocks.length} blocks)`);

  // Every block renders, and no block leaves an unresolved token behind.
  const rendered = blocks.map((block) => renderOfferBlock(block, tokens));
  for (const [index, html] of rendered.entries()) {
    const leftover = /\{\{\s*[a-zA-Z0-9_]+\s*\}\}/.exec(html);
    assert.equal(
      leftover,
      null,
      `block ${index} (${blocks[index].type}) left an unresolved token: ${leftover?.[0]}`,
    );
  }

  // The compensation block is the one that carries money. Every derived figure must appear.
  const compensation = blocks.find((b) => b.type === "compensation");
  assert.ok(compensation, "the default template must have a compensation block");
  const compHtml = renderOfferBlock(compensation, tokens);
  for (const figure of ["18,550", "222,600", "7,950", "95,400", "3,500", "42,000", "30,000", "360,000"]) {
    assert.ok(compHtml.includes(figure), `the compensation table must print ${figure}`);
  }

  // The headline and the total row are the SAME number. A template cannot make them disagree,
  // because both read the derived token rather than anything stored on the block.
  const heroMatch = /class="big tnum"><span class="cur">EGP<\/span>([\d,]+)</.exec(compHtml);
  assert.ok(heroMatch, "the hero figure must render");
  assert.equal(heroMatch[1], tokens.totalMonthly, "the hero figure must equal the derived total");
  const totalRow = /class="total"><td>[^<]*<\/td><td class="r tnum">([\d,]+)</.exec(compHtml);
  assert.ok(totalRow, "the total row must render");
  assert.equal(totalRow[1], tokens.totalMonthly, "the total row must equal the hero figure");

  // A block type nobody knows renders as nothing rather than throwing — a corrupt stored
  // template must degrade, not 500 the page that is about to send somebody a job offer.
  assert.equal(
    renderOfferBlock({ id: "x", props: {}, type: "not-a-real-block" as never }, tokens),
    "",
    "an unknown block type renders empty instead of throwing",
  );

  // ------------------------------------------------------------ whole document --
  const doc = renderOfferDocument(
    { blocks, fontFamily: "'Open Sans',Arial,sans-serif", fontSizePt: 9.9, theme: {} },
    SAMAA,
  );
  assert.ok(doc.html.startsWith("<!doctype html>"), "the document is standalone");
  assert.ok(doc.html.includes("SAMAA SHALABY"), "the candidate is named in the document");
  assert.ok(doc.html.includes("@page"), "the print page size must be declared");
  assert.ok(doc.css.includes("--brand:#0879b8"), "the SATO brand colour must reach the stylesheet");
  assert.equal(
    /\{\{\s*[a-zA-Z0-9_]+\s*\}\}/.exec(doc.body),
    null,
    "a finished document must carry no unresolved tokens",
  );

  // A theme override must actually repaint, or the colour picker in the UI is decorative.
  const themed = renderOfferDocument({ blocks, theme: { brand: "#c0392b" } }, SAMAA);
  assert.ok(themed.css.includes("--brand:#c0392b"), "a theme override must reach the stylesheet");
  assert.ok(!themed.css.includes("--brand:#0879b8"), "the overridden colour must not also survive");

  // Formatting is the same everywhere a figure is written.
  assert.equal(formatOfferAmount(1234567), "1,234,567", "amounts are thousands-separated");
  assert.equal(formatOfferAmount(Number.NaN), "0", "a non-finite amount prints as zero, never as NaN");

  // -------------------------------------------------------------- the email body --
  // The email is a SECOND renderer over the same blocks, and the reason is mechanical: Outlook
  // on Windows lays mail out with Word's engine, which implements neither grid nor flex. Every
  // assertion below is something that silently destroys the layout in a real client.
  const email = renderOfferEmail({ blocks, theme: {} }, SAMAA);

  assert.ok(!/display\s*:\s*grid/i.test(email.html), "grid does not exist in Outlook — it must not be emitted");
  assert.ok(!/display\s*:\s*flex/i.test(email.html), "flex does not exist in Outlook — it must not be emitted");
  assert.ok(!/@font-face/i.test(email.html), "Gmail strips @font-face; the body must not depend on one");
  assert.ok(!/data:image/i.test(email.html), "Gmail and Outlook strip data: image URIs");
  assert.ok(!/<link\b/i.test(email.html), "an external stylesheet never loads in a mail client");
  assert.ok(!/\d\s*pt\b/i.test(email.html), "pt units are unreliable in mail clients; px only");

  // Tables must declare themselves as layout, or a screen reader announces the whole letter as
  // a data table.
  const presentationTables = (email.html.match(/role="presentation"/g) ?? []).length;
  const totalTables = (email.html.match(/<table/g) ?? []).length;
  assert.equal(presentationTables, totalTables, `every layout table needs role="presentation" (${presentationTables}/${totalTables})`);

  // The money must survive into the email exactly as it appears on the letter.
  for (const figure of ["18,550", "222,600", "7,950", "3,500", "30,000", "360,000"]) {
    assert.ok(email.html.includes(figure), `the email must carry ${figure}`);
  }
  assert.equal(
    /\{\{\s*[a-zA-Z0-9_]+\s*\}\}/.exec(email.html),
    null,
    "the email must carry no unresolved tokens",
  );

  // A plain-text alternative is not decoration — a multipart email without one scores worse with
  // spam filters, and an offer in a junk folder was never made.
  assert.ok(email.text.length > 400, `the plain-text part must be real (${email.text.length} chars)`);
  assert.ok(email.text.includes("30,000"), "the plain-text part must carry the package");
  assert.ok(!/<[a-z]/i.test(email.text), "the plain-text part must contain no markup");
  assert.ok(email.text.includes("attached as a PDF"), "the text part must point at the attachment");

  // A raw-HTML block is the one escape hatch that could smuggle grid/flex past every guarantee
  // above, so the email renderer drops it. The print renderer still honours it.
  const withRaw = [...blocks, { id: "raw", props: { raw: '<div style="display:grid">X</div>' }, type: "html" as const }];
  const rawEmail = renderOfferEmail({ blocks: withRaw, theme: {} }, SAMAA);
  assert.ok(!/display\s*:\s*grid/i.test(rawEmail.html), "a raw-HTML block must not reach the email body");
  assert.ok(
    renderOfferDocument({ blocks: withRaw }, SAMAA).body.includes("display:grid"),
    "the print renderer must still honour a raw-HTML block",
  );

  // A theme override must repaint the email too, not just the PDF.
  const redEmail = renderOfferEmail({ blocks, theme: { brand: "#c0392b" } }, SAMAA);
  assert.ok(redEmail.html.includes("#c0392b"), "a theme override must reach the email body");
}
