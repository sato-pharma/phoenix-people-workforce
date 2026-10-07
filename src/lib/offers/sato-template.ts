import type { OfferBlock, OfferTheme } from "@/lib/offers/types";
import {
  OFFER_OUTSTATION_CLAUSE_HEADING,
  OFFER_OUTSTATION_CLAUSE_TEXT,
} from "@/lib/offers/outstation-clause";

/**
 * Built-in template THREE — the SATO CORPORATE-IDENTITY letter, added on the owner's instruction
 * (2026-09-22, "make a new job offer template that takes Sato corporate identity and style").
 *
 * ── What this is, and what it is NOT ──
 * It is a THIRD skin sitting BESIDE the two frozen designs — the classic Dr Samaa letter and the
 * "Ultra Premium" executive one. Neither of those is touched: the freeze on `src/lib/offers/`
 * (AGENTS.md §4) protects them exactly as they are, and adding a design next to them is the
 * additive move the module was built for — one entry in `OFFER_BUILTIN_TEMPLATES` plus this file.
 *
 * The WORDING is the same binding offer letter as the other two — same reference, same paragraphs,
 * the same four clauses, the same three onboarding steps, the same confidentiality footer. Not one
 * sentence of the legal text is new here. What is new is the DESIGN: it wears Sato Pharma's own
 * "SHARP" corporate identity rather than either uploaded letter's look —
 *
 *   • a navy masthead band carrying the REVERSE Sato mark (white on navy), closed by a 3px
 *     brand-blue seam — the band-and-seam closure the identity uses everywhere;
 *   • the one Sato brand blue (#0879b8) as the single accent, over navy masses and hairline greys;
 *   • micro labels — uppercase, tracked — as the one voice of every eyebrow and index;
 *   • 90-degree corners throughout, no soft shadows, no gradient washes.
 *
 * Because the block vocabulary is identical to the other two designs, `variant: "sato"` swaps the
 * skin and everything the designer can do to them it can do to this one: it is editable, it is
 * restorable, and it can be the design a new offer opens on.
 *
 * ── The palette is the identity's, not matched by eye ──
 * The values below are the SHARP tokens from `skills/sato-pharma-identity`: brand `#0879b8`, the
 * navy `#17304d` for masses and bands, body `#45515a`, and the identity's hairline greys and
 * blue-tinted chips. `ink` is the navy on purpose — in this design every dark mass (the masthead,
 * the section ticks, the clause tiles, the acceptance header, the welcome band) is Sato navy.
 */

export const OFFER_SATO_THEME: OfferTheme = {
  body: "#45515a",
  brand: "#0879b8",
  chip: "#f2f5f7",
  faint: "#8a959d",
  frame: "#dde4e8",
  hair: "#e1e7eb",
  ink: "#17304d",
  line: "#dde4e8",
  muted: "#45515a",
  soft: "#69757e",
  tint: "#f3f9fc",
  "tint-line": "#b9d8e9",
};

// The identity's Latin family. No download: it is the "Helvetica Neue" stack the SHARP system
// specifies for UI and documents alike.
export const OFFER_SATO_FONT = "'Helvetica Neue',Helvetica,Arial,sans-serif";
export const OFFER_SATO_FONT_SIZE_PT = 9.6;
export const OFFER_SATO_TEMPLATE_NAME = "SATO Corporate Offer";

let seq = 0;
/** Stable, readable ids — regenerated identically on every install, like the other built-ins. */
function id(type: string): string {
  seq += 1;
  return `${type}-s${seq}`;
}

export function satoOfferBlocks(): OfferBlock[] {
  seq = 0;
  return [
    {
      id: id("letterhead"),
      props: {
        // No `logo` key at all, deliberately — the same rule as the other two designs: an absent
        // prop lets the renderer supply the Sato mark, where an empty string would read as "the
        // designer cleared this on purpose" and suppress it. In the Sato skin the mark drawn here
        // is the REVERSE one (white on navy), because this masthead is a navy band.
        name: "SATO PHARMACEUTICALS",
        tagline: "Corporate Employment Offer",
        unit: "Human Resources",
      },
      type: "letterhead",
    },
    // The 3px brand-blue seam that closes the navy masthead band above it — the band-and-seam
    // closure the identity uses everywhere. Same block, different skin: the base rail is a 6px
    // brand bar; the Sato skin trims it to a 3px seam.
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
        badge: "Private &amp; Confidential",
        h1: "Offer of Employment",
        sub: "{{title}} &middot; {{territory}}",
      },
      type: "title",
    },
    {
      id: id("text"),
      props: {
        // Derived from the candidate's name — the square tile beside the salutation reads "SS" for
        // Samaa Shalaby. Clear this field and the tile disappears.
        avatar: "{{initials}}",
        html:
          "<p class='lead'>Dear <strong>{{salutationName}}</strong>,</p>" +
          "<p>On behalf of Sato Pharmaceuticals, it is our pleasure to offer you the position of " +
          "<strong>{{title}}</strong>, reporting to the {{reportsTo}}.</p>" +
          // Per JOB TITLE, not per design. This design's own role-neutral sentence is what the module
          // now uses as the standard paragraph for a position nobody has worded yet, so a letter on
          // this design reads the same as before for any such title. `src/lib/offers/role-summary.ts`.
          "<p>{{roleSummary}}</p>",
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
      props: { sub: "/ What You Receive", text: "Incentive &amp; Benefits" },
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
          { k: "Medical Insurance", t: "Private medical cover under the company medical scheme." },
          { k: "Social Insurance", t: "Social insurance coverage in compliance with local regulations." },
          { k: "Business Travel", t: "Business travel and related expenses covered as per company policy." },
        ],
      },
      type: "benefits",
    },
    { id: id("pagebreak"), props: {}, type: "pagebreak" },
    // Page two opens on the same 3px seam page one does.
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
            h: OFFER_OUTSTATION_CLAUSE_HEADING,
            t: OFFER_OUTSTATION_CLAUSE_TEXT,
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
          "returning a copy of this letter. We look forward to welcoming you to Sato Pharma.</p>",
      },
      type: "text",
    },
    {
      id: id("signature"),
      props: {
        leftK: "For Sato Pharmaceuticals",
        // Named rather than "Authorised signatory": the letter goes out pre-signed and a signature
        // over an anonymous role is unattributable. No `leftSignature` key, deliberately — an
        // absent prop lets the renderer supply the signature on file, exactly as the two other
        // built-ins do.
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
        // The running mark along the foot of every printed page.
        pageMark: "Private &amp; Confidential &bull; Sato Pharma",
        right: "Employment Offer",
        text: "This offer is issued to the named recipient and is private and confidential. It supersedes any prior verbal or written discussion regarding this position, and becomes binding on both parties upon signature by an authorised representative of Sato Pharmaceuticals.",
      },
      type: "footer",
    },
    {
      id: id("welcome"),
      props: { k: "Welcome to Sato Pharma", text: "We look forward to welcoming you onboard." },
      type: "welcome",
    },
  ];
}
