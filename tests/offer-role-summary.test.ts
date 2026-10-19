import { strict as assert } from "node:assert";

import { OFFER_BUILTIN_TEMPLATES } from "../src/lib/offers/builtin-templates.ts";
import { OFFER_SEED_JOB_TITLES, defaultOfferBlocks } from "../src/lib/offers/default-template.ts";
import { executiveOfferBlocks } from "../src/lib/offers/executive-template.ts";
import { houseOfferBlocks } from "../src/lib/offers/house-template.ts";
import { premiumOfferBlocks } from "../src/lib/offers/premium-template.ts";
import { satoOfferBlocks } from "../src/lib/offers/sato-template.ts";
import {
  OFFER_FIELD_FORCE_ROLE_SUMMARY,
  OFFER_ROLE_SUMMARY_FALLBACK,
  OFFER_TALENT_ACQUISITION_ROLE_SUMMARY,
  OFFER_TRAINING_MANAGER_ROLE_SUMMARY,
  offerRoleSummary,
} from "../src/lib/offers/role-summary.ts";
import { OFFER_PLACEHOLDER_KEYS } from "../src/lib/offers/placeholders.ts";
import { buildOfferTokens, renderOfferBlock, renderOfferDocument } from "../src/lib/offers/render.ts";
import type { OfferBlock, OfferFields } from "../src/lib/offers/types.ts";

/**
 * The offer letter's role paragraph belongs to the JOB TITLE, never to the design.
 *
 * ── WHAT THIS EXISTS TO STOP COMING BACK ──
 * Three of the first four shipped designs — including the HR-forms letter production sends by default —
 * had this sentence typed into the design itself and therefore printed it for EVERY position in the
 * company: "…the people leadership this district needs … fully accountable for the territory's
 * sales performance … leading and developing your field team". It was transcribed from one signed
 * DSM letter and became the words a Talent Acquisition Specialist read on the page they were asked
 * to sign, with nowhere to change it that did not also reword every medical representative's offer.
 *
 * So the regression this guards is a sentence about sales, districts, territories or field teams
 * creeping back into any design's blocks. The check is on the BLOCKS, which is where the defect
 * lived, and it covers every design rather than the three that had it — now five, the premium one
 * included: the newest design is how the next design ships with the bug.
 *
 * ── AND THE FOUR PROPERTIES THE MECHANISM NEEDS ──
 * That one design can serve every position only if: a worded position prints ITS OWN words; an
 * unworded one prints a role-neutral sentence rather than a gap; `{{territory}}` inside a stored
 * paragraph resolves to this candidate's own area; and the paragraph is escaped exactly once, so a
 * territory with an ampersand in it does not print `&amp;` on a legal document.
 */

const FIELDS: OfferFields = {
  candidateEmail: "candidate@example.com",
  candidateName: "SAMAA SHALABY",
  contractTerm: "One year, renewable",
  costOfLiving: 3500,
  dateOfIssue: "26 August 2026",
  reference: "SP-HR-DSM-2026-019",
  reportsTo: "National Sales Manager",
  roleSummary: "",
  salutationName: "Dr SAMAA SHALABY",
  startDate: "1 September 2026",
  territory: "Delta 3",
  title: "District Sales Manager",
  totalMonthly: 30000,
  validUntil: "2 September 2026",
};

/** Every string written anywhere in a design's blocks, however deeply nested. */
function blockText(blocks: OfferBlock[]): string {
  const found: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === "string") found.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value as Record<string, unknown>).forEach(walk);
  };
  walk(blocks);
  return found.join("\n");
}

/** The rendered text block of a design, with one offer's values in it. */
function renderedBody(blocks: OfferBlock[], fields: OfferFields): string {
  const tokens = buildOfferTokens(fields);
  return blocks
    .filter((block) => block.type === "text")
    .map((block) => renderOfferBlock(block, tokens))
    .join("\n");
}

export function runOfferRoleSummaryTests(): void {
  const designs: [string, OfferBlock[]][] = [
    ["classic", defaultOfferBlocks()],
    ["executive", executiveOfferBlocks()],
    ["sato", satoOfferBlocks()],
    ["house", houseOfferBlocks()],
    ["premium", premiumOfferBlocks()],
  ];

  // ───────────────────────────────────── no design hard-codes what a job IS ──
  // The words, not a flag: a design that re-typed the sales paragraph would pass any check on the
  // token's presence while printing the old defect. Each phrase below is one the sentence actually
  // used, so a near-miss rewrite is caught too.
  const banned = [
    "this district needs",
    "sales performance",
    "district plan",
    "field team",
    "market expansion",
    // Added 15 Oct 2026. The 2026-10-07 sweep above moved the SALES paragraph out of the designs and
    // missed this, because it is not in that paragraph: the closing sentence of four designs read
    // "We believe your leadership will be a strong addition to our organisation", and the executive
    // design wore a "Leadership Appointment" badge in its title block. Both printed on every letter,
    // so an Office Coordinator offer was congratulated on leadership nobody had offered them. One
    // word catches both, and it catches a badge as well as a paragraph.
    "leadership",
  ];
  for (const [name, blocks] of designs) {
    const text = blockText(blocks);
    assert.ok(
      text.includes("{{roleSummary}}"),
      `the ${name} design must take what the job IS from the job title, as {{roleSummary}}`,
    );
    for (const phrase of banned) {
      assert.ok(
        !text.toLowerCase().includes(phrase),
        `the ${name} design must not describe a sales job — "${phrase}" is in its blocks, and every `
          + "position in the company would read it. Write it on the job title instead.",
      );
    }
  }

  // The token is discoverable, or nobody can use it: the designer's picker is generated from the
  // catalogue, and a token missing from it is a feature that exists and cannot be found.
  assert.ok(
    OFFER_PLACEHOLDER_KEYS.has("roleSummary"),
    "{{roleSummary}} must be in the placeholder catalogue, or the designer cannot offer it",
  );

  // ──────────────────────────────────────────── a worded position prints ITS words ──
  const worded = renderedBody(designs[0]![1], {
    ...FIELDS,
    roleSummary: OFFER_TALENT_ACQUISITION_ROLE_SUMMARY,
    territory: "Head Office",
    title: "Talent Acquisition",
  });
  assert.ok(worded.includes("own hiring end to end"), "a worded position must print its own paragraph");
  assert.ok(
    !worded.toLowerCase().includes("field team"),
    "a talent-acquisition letter must not mention a field team — this is the whole defect",
  );
  // A stored paragraph belongs to the POSITION while the territory belongs to the LETTER, so a
  // position's own sentence has to be able to name this candidate's area. That is what lets one row
  // against District Sales Manager say Delta 3 for one offer and Alex East for the next.
  const withTerritory = renderedBody(designs[0]![1], {
    ...FIELDS,
    roleSummary: "You will lead the team across {{territory}}.",
    territory: "Alex East",
  });
  assert.ok(
    withTerritory.includes("across Alex East"),
    "{{territory}} inside a stored paragraph must resolve to this candidate's own area",
  );

  // ──────────────────────────────── an unworded position prints a sentence, not a gap ──
  const unworded = renderedBody(designs[0]![1], { ...FIELDS, roleSummary: "" });
  assert.ok(
    unworded.includes("the judgement and the commitment this role calls for"),
    "a position with no wording must fall back to the role-neutral sentence",
  );
  assert.ok(
    !unworded.includes("<p></p>") && !unworded.includes("{{roleSummary}}"),
    "an unworded position must leave neither an empty paragraph nor a visible token in the letter",
  );
  assert.ok(
    unworded.includes("Delta 3"),
    "the standard sentence names the candidate's own territory too",
  );

  // Null, undefined and whitespace all mean the same thing, because they arrive from three
  // different places: a column older than the migration, a cleared textarea, and an API caller.
  for (const blank of [null, undefined, "", "   ", "\n\t "]) {
    assert.equal(
      offerRoleSummary(blank),
      OFFER_ROLE_SUMMARY_FALLBACK,
      `a blank role summary (${JSON.stringify(blank)}) must resolve to the standard sentence`,
    );
  }
  assert.equal(
    offerRoleSummary("  Written by hand.  "),
    "Written by hand.",
    "a stored paragraph is trimmed, never otherwise rewritten",
  );

  // ───────────────────────────────────────────────── escaped exactly once ──
  // The paragraph's own tokens are substituted RAW and the whole thing is then escaped by the outer
  // pass. Substituting them escaped would escape twice and print `Alex &amp; Delta` on a letter.
  const ampersand = buildOfferTokens({
    ...FIELDS,
    roleSummary: "You will cover {{territory}}.",
    territory: "Alex & Delta",
  });
  assert.equal(
    ampersand.roleSummary,
    "You will cover Alex & Delta.",
    "a token inside the paragraph must be substituted raw — the letter's own pass does the escaping",
  );
  const rendered = renderedBody(designs[0]![1], {
    ...FIELDS,
    roleSummary: "You will cover {{territory}}.",
    territory: "Alex & Delta",
  });
  assert.ok(
    rendered.includes("Alex &amp; Delta") && !rendered.includes("&amp;amp;"),
    "the paragraph must reach the letter escaped exactly once",
  );

  // An unknown token inside a stored paragraph stays visible, for the same reason it does in a
  // template: a typo somebody can see beats a silent hole in a document being signed.
  const typo = buildOfferTokens({ ...FIELDS, roleSummary: "Reporting to {{reprotsTo}}." });
  assert.equal(
    typo.roleSummary,
    "Reporting to {{reprotsTo}}.",
    "a misspelt token inside the paragraph must stay visible, never blank",
  );

  // ─────────────────────────── the field force keeps the letter it already gets ──
  // All 36 offers on production were sent on the classic or HR-forms design, and both printed the
  // field-force paragraph. Seeding it onto the three sales titles is what makes this change invisible
  // to them — a seed that lost it would quietly reword the next medical representative's offer.
  const seeded = new Map(OFFER_SEED_JOB_TITLES.map((seed) => [seed.title, seed.roleSummary ?? null]));
  for (const title of ["National Sales Manager", "District Sales Manager", "Medical Representative"]) {
    assert.equal(
      seeded.get(title),
      OFFER_FIELD_FORCE_ROLE_SUMMARY,
      `${title} must keep the paragraph its letters print today`,
    );
  }

  // The stored wording is plain text, escaped on its way into the letter — so an HTML entity typed
  // into it prints as those literal characters on a signed document.
  for (const [name, text] of [
    ["the field-force paragraph", OFFER_FIELD_FORCE_ROLE_SUMMARY],
    ["the standard sentence", OFFER_ROLE_SUMMARY_FALLBACK],
    ["the talent-acquisition paragraph", OFFER_TALENT_ACQUISITION_ROLE_SUMMARY],
    ["the training-manager paragraph", OFFER_TRAINING_MANAGER_ROLE_SUMMARY],
  ] as const) {
    assert.ok(
      !/&[a-zA-Z]+;|&#\d+;/.test(text),
      `${name} must use real characters, never HTML entities — it is escaped into the letter`,
    );
    assert.ok(!/<[a-zA-Z/]/.test(text), `${name} must carry no HTML tags`);
  }

  // ─────────────────────────────────────── a Training Manager's letter is about learning ──
  // The title is seeded with its own words, and those words promise no territory number, field team
  // or district plan — the same defect the talent-acquisition paragraph exists to avoid.
  assert.equal(
    seeded.get("Training Manager"),
    OFFER_TRAINING_MANAGER_ROLE_SUMMARY,
    "the Training Manager title is seeded with its own paragraph",
  );
  for (const forbidden of ["sales performance", "district plan", "field team", "market expansion"]) {
    assert.ok(
      !OFFER_TRAINING_MANAGER_ROLE_SUMMARY.toLowerCase().includes(forbidden),
      `the training-manager paragraph must not say "${forbidden}"`,
    );
  }
  const trainingLetter = renderedBody(designs[0]![1], {
    ...FIELDS,
    roleSummary: OFFER_TRAINING_MANAGER_ROLE_SUMMARY,
    territory: "Head Office",
    title: "Training Manager",
  });
  assert.ok(
    trainingLetter.includes("own the learning of our teams") && trainingLetter.includes("bring both to Head Office"),
    "a Training Manager letter prints its own paragraph, naming the territory it was given",
  );

  // ───────────────────────────── the premium letter takes the job title's words too ──
  // The premium design re-dresses the same blocks, so the paragraph must reach it through the whole
  // document — masthead rebuilt, blocks drawn by the premium body builder — exactly as it reaches the
  // others, escaped once, and must never be a sentence the design itself carries.
  const premiumDesign = OFFER_BUILTIN_TEMPLATES.find((entry) => entry.key === "premium");
  assert.ok(premiumDesign, "the premium design is in the registry");
  const premiumLetter = (fields: OfferFields) =>
    renderOfferDocument(
      {
        blocks: premiumDesign.blocks(),
        fontFamily: premiumDesign.fontFamily,
        fontSizePt: premiumDesign.fontSizePt,
        theme: premiumDesign.theme,
        variant: premiumDesign.variant,
      },
      fields,
    ).body;
  const premiumWorded = premiumLetter({
    ...FIELDS,
    roleSummary: OFFER_TALENT_ACQUISITION_ROLE_SUMMARY,
    territory: "Head Office",
    title: "Talent Acquisition",
  });
  assert.ok(premiumWorded.includes("own hiring end to end"), "a worded position prints its own paragraph on the premium letter");
  assert.ok(!premiumWorded.toLowerCase().includes("field team"), "a talent-acquisition premium letter must not mention a field team");
  const premiumUnworded = premiumLetter({ ...FIELDS, roleSummary: "" });
  assert.ok(
    premiumUnworded.includes("the judgement and the commitment this role calls for") && premiumUnworded.includes("Delta 3"),
    "an unworded position prints the role-neutral sentence, naming the candidate's own territory, on the premium letter",
  );
  assert.ok(!premiumUnworded.includes("{{roleSummary}}"), "no visible token on the premium letter");
  const premiumAmpersand = premiumLetter({ ...FIELDS, roleSummary: "You will cover {{territory}}.", territory: "Alex & Delta" });
  assert.ok(
    premiumAmpersand.includes("You will cover Alex &amp; Delta.") && !premiumAmpersand.includes("&amp;amp;"),
    "the paragraph reaches the premium letter escaped exactly once",
  );
}
