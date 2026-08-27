import type { OfferBlock, OfferJobTitleInput, OfferTheme } from "@/lib/offers/types";

/**
 * The SATO offer as the owner designed it — the factory default, transcribed block for block
 * from the signed template (Dr Samaa Shalaby, DSM Delta 3, ref SP-HR-DSM-2026-019).
 *
 * This is DATA, not layout code, which is the whole point: the same structure is edited in the
 * admin UI, stored as JSON, and rendered by two different renderers. Nothing here is hard-coded
 * into a component, so a non-engineer can reorder, retitle, recolour or delete any of it without
 * a deploy — and can always restore this exact arrangement afterwards.
 *
 * The `{{token}}` placeholders are filled per offer by `renderOfferHtml`. An unknown token is
 * left visible rather than blanked, so a typo shows up as `{{reprotsTo}}` on the preview instead
 * of as a silent gap on a legal document.
 */

/** The palette from the signed PDF, sampled from its content stream. */
export const OFFER_DEFAULT_THEME: OfferTheme = {
  body: "#45515a",
  brand: "#0879b8",
  chip: "#f8fafb",
  faint: "#8a959d",
  frame: "#ccd6dd",
  hair: "#e1e7eb",
  ink: "#111820",
  line: "#dde4e8",
  muted: "#56626b",
  soft: "#69757e",
  tint: "#f3f9fc",
  "tint-line": "#b9d8e9",
};

export const OFFER_DEFAULT_FONT = "'Open Sans',Arial,Helvetica,sans-serif";
export const OFFER_DEFAULT_FONT_SIZE_PT = 9.9;
export const OFFER_DEFAULT_TEMPLATE_NAME = "SATO Offer of Employment";

/**
 * Seed job titles and their flat cost-of-living allowances.
 *
 * The three figures are the owner's own, given directly (2026-08-26). The two marked below are
 * additionally corroborated by signed offers. Titles are fully editable in the admin UI — this
 * list is only what a fresh install starts with.
 */
export const OFFER_SEED_JOB_TITLES: OfferJobTitleInput[] = [
  {
    contractTerm: "One year, renewable",
    costOfLiving: 5500,
    reportsTo: "Chief Executive Officer",
    title: "National Sales Manager",
  },
  {
    // Corroborated: Dr Samaa Shalaby, SP-HR-DSM-2026-019 (30,000 total → 18,550 / 7,950 / 3,500).
    contractTerm: "One year, renewable",
    costOfLiving: 3500,
    reportsTo: "National Sales Manager",
    title: "District Sales Manager",
  },
  {
    // Corroborated: Omar Tamer (17,000 → 10,150 / 4,350) and Adel Srour (19,000 → 11,550 / 4,950).
    contractTerm: "One year, renewable",
    costOfLiving: 2500,
    reportsTo: "District Sales Manager",
    title: "Medical Representative",
  },
];

let seq = 0;
/** Stable, readable ids — the default template is regenerated identically on every install. */
function id(type: string): string {
  seq += 1;
  return `${type}-${seq}`;
}

export function defaultOfferBlocks(): OfferBlock[] {
  seq = 0;
  return [
    { id: id("rail"), props: {}, type: "rail" },
    {
      id: id("letterhead"),
      props: { logo: "", name: "SATO PHARMACEUTICALS", unit: "Human Resources" },
      type: "letterhead",
    },
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
      props: { h1: "Offer of Employment", sub: "{{title}} &middot; {{territory}}" },
      type: "title",
    },
    {
      id: id("text"),
      props: {
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
    { id: id("heading"), props: { text: "Compensation" }, type: "heading" },
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
    { id: id("heading"), props: { text: "Incentive &amp; Benefits" }, type: "heading" },
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
    { id: id("heading"), props: { text: "Terms of Engagement" }, type: "heading" },
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
    { id: id("heading"), props: { text: "What Happens Next" }, type: "heading" },
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
        // Named, not "Authorised signatory" — the letter carries a real signature now, and a
        // signature over an anonymous role reads as unattributable. `leftSignature` is absent on
        // purpose so the renderer supplies the signature on file; see `signatureInk`.
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
        right: "SATO PHARMACEUTICALS",
        text: "This offer is issued to the named recipient and is private and confidential. It supersedes any prior verbal or written discussion regarding this position, and becomes binding on both parties upon signature by an authorised representative of Sato Pharmaceuticals.",
      },
      type: "footer",
    },
  ];
}
