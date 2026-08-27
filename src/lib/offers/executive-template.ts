import type { OfferBlock, OfferTheme } from "@/lib/offers/types";

/**
 * Built-in template TWO — the "Ultra Premium" executive letter the owner uploaded on 2026-08-27
 * (`Sato_Pharma_Employment_Offer_Ultra_Premium.pdf`), transcribed block for block.
 *
 * ── What is different from built-in one, and what is not ──
 * The WORDING is the same letter: same reference, same paragraphs, same four clauses, same three
 * onboarding steps, same confidentiality footer. Comparing the two PDFs line by line, not one
 * sentence of the legal text moved. What changed is the DESIGN — navy bands instead of hairlines,
 * a tinted zebra salary table, numeral tiles down the left of the clauses, an initials disc beside
 * the salutation, a dark appointment badge, and a closing "Welcome aboard" band.
 *
 * That is exactly why this is a second template rather than a second renderer: the block
 * vocabulary is identical, so `variant: "executive"` swaps the skin and everything the designer
 * can do to built-in one it can do to this one. Both are editable, both are restorable, and either
 * can be the design a new offer opens on.
 *
 * ── The colours are MEASURED, not matched by eye ──
 * Every value below was read out of the uploaded PDF's own content stream — the fill colours off
 * its painted rectangles and the text colours in force at each glyph run. `tint-line` is the one
 * token the source does not use (its hero panel is borderless); it is set to the measured hairline
 * rather than to something invented.
 */

export const OFFER_EXECUTIVE_THEME: OfferTheme = {
  body: "#172330",
  brand: "#0b86be",
  chip: "#f5f8fa",
  faint: "#667482",
  frame: "#d7e1e7",
  hair: "#eef3f6",
  ink: "#0b1724",
  line: "#d7e1e7",
  muted: "#172330",
  soft: "#667482",
  tint: "#eaf6fb",
  "tint-line": "#d7e1e7",
};

export const OFFER_EXECUTIVE_FONT = "'Segoe UI',Arial,Helvetica,sans-serif";
export const OFFER_EXECUTIVE_FONT_SIZE_PT = 9.4;
export const OFFER_EXECUTIVE_TEMPLATE_NAME = "SATO Executive Offer";

let seq = 0;
/** Stable, readable ids — regenerated identically on every install, like built-in one. */
function id(type: string): string {
  seq += 1;
  return `${type}-x${seq}`;
}

export function executiveOfferBlocks(): OfferBlock[] {
  seq = 0;
  return [
    {
      id: id("letterhead"),
      props: {
        // No `logo` key at all, deliberately. That is what lets the renderer supply the Sato mark
        // itself — a data URI in the PDF, the public URL in email. An empty string here would read
        // as "the designer cleared this field on purpose" and would suppress the mark entirely.
        name: "SATO PHARMACEUTICALS",
        // The uploaded design carries a second line under the unit, in brand blue.
        tagline: "Executive Employment Offer",
        unit: "Human Resources",
      },
      type: "letterhead",
    },
    // In this design the rule sits UNDER the letterhead rather than above it, and prints as a short
    // brand segment against a long hairline. Same block, different skin, different position.
    { id: id("rail"), props: {}, type: "rail" },
    {
      id: id("control"),
      props: {
        items: [
          { brand: false, k: "Reference", v: "{{reference}}" },
          { brand: false, k: "Date of Issue", v: "{{dateOfIssue}}" },
          { brand: true, k: "Offer Valid Until", v: "{{validUntil}}" },
          { brand: false, k: "Status", v: "Private &amp; Confidential" },
        ],
      },
      type: "control",
    },
    {
      id: id("title"),
      props: {
        badge: "Leadership Appointment",
        h1: "Offer of Employment",
        sub: "{{title}} &middot; {{territory}}",
      },
      type: "title",
    },
    {
      id: id("text"),
      props: {
        // `{{initials}}` is derived from the candidate's name — the disc in the uploaded letter
        // reads "SS" for Samaa Shalaby. Clear this field and the disc disappears.
        avatar: "{{initials}}",
        html:
          "<p class='lead'>Dear <strong>{{salutationName}}</strong>,</p>" +
          "<p>On behalf of Sato Pharmaceuticals, it is our pleasure to offer you the position of " +
          "<strong>{{title}}</strong>, reporting to the {{reportsTo}}.</p>" +
          "<p>Throughout our selection process you demonstrated the commercial judgement and the people " +
          "leadership this district needs, and we would like you to bring both to {{territory}}. In this role " +
          "you will be fully accountable for the territory&rsquo;s sales performance &mdash; translating " +
          "commercial strategy into an executable district plan, leading and developing your field team, and " +
          "driving sustainable growth and market expansion.</p>",
      },
      type: "text",
    },
    {
      id: id("scope"),
      props: {
        items: [
          { k: "Reports To", v: "{{reportsTo}}" },
          { k: "Territory", v: "{{territory}}" },
          { k: "Start Date", v: "{{startDate}}" },
          { k: "Contract", v: "{{contractTerm}}" },
        ],
      },
      type: "scope",
    },
    { id: id("heading"), props: { sub: "/ Net Package", text: "Compensation" }, type: "heading" },
    {
      id: id("compensation"),
      props: {
        asideK: "Annual, Guaranteed",
        currency: "EGP",
        heroK: "Total Monthly Package",
        heroNote: "before performance incentive",
        note:
          "Figures are net and not subject to statutory deductions. The performance incentive described " +
          "below is additional to the package above and is not included in these totals.",
        rows: [
          { a: "{{basicAnnual}}", l: "Basic Salary", m: "{{basicMonthly}}" },
          { a: "{{transportAnnual}}", l: "Internal Transportation Allowance", m: "{{transportMonthly}}" },
          { a: "{{costOfLivingAnnual}}", l: "Cost of Living Allowance", m: "{{costOfLivingMonthly}}" },
        ],
        totalLabel: "Total Package",
      },
      type: "compensation",
    },
    {
      id: id("heading"),
      props: { sub: "/ Executive Support", text: "Incentive &amp; Benefits" },
      type: "heading",
    },
    {
      id: id("benefits"),
      props: {
        items: [
          {
            k: "Performance Incentive",
            t: "Eligibility for a performance-based incentive in accordance with company policy, additional to your monthly package.",
          },
          { k: "Medical Insurance", t: "Private medical cover under the company executive medical scheme." },
          { k: "Social Insurance", t: "Social insurance coverage in compliance with local regulations." },
          { k: "Business Travel", t: "Business travel and related expenses covered as per company policy." },
        ],
      },
      type: "benefits",
    },
    { id: id("pagebreak"), props: {}, type: "pagebreak" },
    // Page two opens on the same rule page one does, under the repeated masthead. It is a second
    // rail block rather than page furniture so that it stays visible and editable in the designer.
    { id: id("rail"), props: {}, type: "rail" },
    {
      id: id("heading"),
      props: { sub: "/ Core Conditions", text: "Terms of Engagement" },
      type: "heading",
    },
    {
      id: id("clauses"),
      props: {
        items: [
          {
            h: "Probation Period",
            t: "Your first three months from the start date are a mutual probation period. A formal performance review will be conducted at its conclusion to confirm your appointment and agree your development priorities. During this period, the company reserves the right to terminate the contract without liability.",
          },
          {
            h: "Outstation Expenses",
            t: "You will be eligible for outstation expenses in accordance with company policy for business travel exceeding 60 km within your assigned territory, excluding Sharkia Governorate.",
          },
          {
            h: "Contract Duration &amp; Notice",
            t: "This contract is valid for one year and is renewable based on mutual agreement. Either party may terminate the contract with one month&rsquo;s prior written notice.",
          },
          {
            h: "Confidentiality",
            t: "Upon termination or expiration of this agreement, you agree to maintain full confidentiality of all company information, including trade secrets, trademarks and proprietary data.",
          },
        ],
      },
      type: "clauses",
    },
    {
      id: id("heading"),
      props: { sub: "/ 3-Step Onboarding", text: "What Happens Next" },
      type: "heading",
    },
    {
      id: id("steps"),
      props: {
        items: [
          {
            h: "Sign &amp; return",
            n: "Step 01",
            t: "Sign the acceptance below and return a scanned copy to your HR contact before the validity date shown on page 1.",
          },
          {
            h: "Joining documents",
            n: "Step 02",
            t: "Submit your national ID, graduation certificate, experience letters and military status where applicable.",
          },
          {
            h: "Induction",
            n: "Step 03",
            t: "HR will confirm your reporting location and first-week induction schedule ahead of your start date.",
          },
        ],
      },
      type: "steps",
    },
    {
      id: id("text"),
      props: {
        html:
          "<p style='margin-top:12px'>Please confirm your acceptance of this offer by signing below and " +
          "returning a copy of this letter. We believe your leadership will be a strong addition to our " +
          "organisation, and we look forward to welcoming you onboard.</p>",
      },
      type: "text",
    },
    {
      id: id("signature"),
      props: {
        leftK: "For Sato Pharmaceuticals",
        // Named rather than "Authorised signatory", because the letter now goes out pre-signed and
        // a signature over an anonymous role reads as unattributable. No `leftSignature` key at
        // all, deliberately — same rule as the letterhead logo above: an absent prop lets the
        // renderer supply the signature on file, where an empty string would mean "cleared".
        leftName: "Omar Anwar Gawish",
        leftSub: "Human Resources",
        rightK: "Accepted By",
        rightName: "{{candidateName}}",
        rightSub: "{{title}} &middot; {{territory}}",
        title: "Accepted &amp; Signed",
      },
      type: "signature",
    },
    {
      id: id("footer"),
      props: {
        // The running mark along the foot of every printed page in the uploaded design.
        pageMark: "Private &amp; Confidential &bull; Sato Pharma",
        right: "Employment Offer",
        text: "This offer is issued to the named recipient and is private and confidential. It supersedes any prior verbal or written discussion regarding this position, and becomes binding on both parties upon signature by an authorised representative of Sato Pharmaceuticals.",
      },
      type: "footer",
    },
    {
      id: id("welcome"),
      props: { k: "Welcome Aboard", text: "We look forward to welcoming you onboard." },
      type: "welcome",
    },
  ];
}
