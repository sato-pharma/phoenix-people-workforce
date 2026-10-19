import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";
import { inlineLocalAssets } from "../src/lib/hiring-pack/paper-artwork.ts";
import { OFFER_BLOCK_DEFS } from "../src/lib/offers/block-schema.ts";
import {
  OFFER_BUILTIN_TEMPLATES,
  isOfferBuiltinKey,
  isOfferTemplateVariant,
  offerBuiltinTemplate,
} from "../src/lib/offers/builtin-templates.ts";
import { PREMIUM_OFFER_SKIN } from "../src/lib/offers/premium-skin.ts";
import { buildOfferTokens, offerPageFooterHtml, renderOfferDocument } from "../src/lib/offers/render.ts";
import { renderOfferEmail } from "../src/lib/offers/render-email.ts";
import type { OfferBlockType, OfferFields } from "../src/lib/offers/types.ts";

/**
 * The designs that ship with the job-offer module.
 *
 * The owner uploaded two letters and asked for both, both editable, and switching between them, then
 * asked for a third in Sato's own corporate identity, a fourth in the HR-forms house identity and
 * (13 Oct 2026) a fifth in the HR premium identity, each added beside the last. All five are
 * implemented as ONE block list plus a skin — so the
 * failures worth pinning are the ones that would let a design ship looking right and behave wrongly:
 *
 *   1. A BLOCK TYPE THE SANITIZER DOES NOT KNOW. `sanitizeTemplateBlocks` drops unknown types, so a
 *      design using one seeds fine, renders fine, previews fine — and loses that block the first
 *      time anybody presses Save. The list is now derived from `OFFER_BLOCK_DEFS`; this asserts the
 *      derivation actually covers every type both designs use, and that the union has no member
 *      without an editor entry.
 *
 *   2. A SKIN THAT DOES NOT APPLY, OR APPLIES TO BOTH. The variant is the only thing separating the
 *      two designs. If the override sheet were appended unconditionally, editing one would change
 *      the other; if it were never appended, the second design would silently be the first.
 *
 *   3. A RUNNING PAGE FOOT THAT PRINTS BLANK. Chromium renders `footerTemplate` in a SEPARATE
 *      document that inherits none of the page's CSS custom properties. A `var(--ink)` in there
 *      resolves to nothing and the foot comes out empty — on every page of a legal document, and
 *      only in the real PDF, never in the on-screen preview.
 */

const SAMPLE: OfferFields = {
  candidateEmail: "samaa@example.com",
  candidateName: "SAMAA SHALABY",
  contractTerm: "One year, renewable",
  costOfLiving: 3500,
  dateOfIssue: "27-Aug-26",
  reference: "SP-HR-DSM-2026-019",
  reportsTo: "National Sales Manager",
  roleSummary: "",
  salutationName: "Dr SAMAA SHALABY",
  startDate: "1 September 2026",
  territory: "Delta (3)",
  title: "District Sales Manager",
  totalMonthly: 30000,
  validUntil: "1 September 2026",
};

/**
 * Every member of `OfferBlockType`, written out.
 *
 * A union cannot be iterated at runtime, and `next.config` sets `ignoreBuildErrors`, so a type
 * added to the union without an entry in `OFFER_BLOCK_DEFS` compiles, builds and deploys. The
 * `satisfies` makes a missing name a type error and the loop below makes a missing DEF a test
 * failure — the two together are what an exhaustive list actually needs here.
 */
const ALL_BLOCK_TYPES = [
  "benefits",
  "clauses",
  "compensation",
  "control",
  "footer",
  "heading",
  "html",
  "letterhead",
  "pagebreak",
  "rail",
  "scope",
  "signature",
  "steps",
  "text",
  "title",
  "welcome",
] as const satisfies readonly OfferBlockType[];

export function runOfferBuiltinTemplateTests() {
  // ------------------------------------------------------------------ the registry --
  assert.equal(
    OFFER_BUILTIN_TEMPLATES.length,
    5,
    "five designs ship: the classic letter, the executive one, the Sato corporate one, the HR-forms house one and the HR premium one — each added beside the last, none changed",
  );

  const keys = OFFER_BUILTIN_TEMPLATES.map((entry) => entry.key);
  assert.equal(new Set(keys).size, keys.length, "built-in keys must be unique — they are how Restore finds a row");

  const variants = OFFER_BUILTIN_TEMPLATES.map((entry) => entry.variant);
  assert.equal(new Set(variants).size, variants.length, "two built-ins that share a skin would look identical");
  assert.equal(new Set(variants).size, 5, "each shipped design carries its own skin — classic, executive, sato, house, premium");

  assert.equal(
    OFFER_BUILTIN_TEMPLATES.filter((entry) => entry.seedAsDefault).length,
    1,
    "exactly one design may seed as the default — the partial unique index makes two a conflict",
  );

  assert.equal(offerBuiltinTemplate("executive")?.key, "executive", "a built-in is found by key");
  assert.equal(offerBuiltinTemplate("nope"), null, "an unknown key must not resolve to a design");
  assert.ok(
    isOfferBuiltinKey("classic")
      && isOfferBuiltinKey("executive")
      && isOfferBuiltinKey("sato")
      && isOfferBuiltinKey("house")
      && isOfferBuiltinKey("premium"),
    "all five keys are recognised",
  );
  assert.equal(offerBuiltinTemplate("sato")?.key, "sato", "the Sato corporate design is found by key");
  assert.equal(offerBuiltinTemplate("house")?.key, "house", "the HR-forms house design is found by key");
  assert.equal(offerBuiltinTemplate("premium")?.key, "premium", "the HR premium design is found by key");
  assert.ok(!isOfferBuiltinKey("default"), "a plausible-looking key that does not exist must be rejected");
  assert.ok(isOfferTemplateVariant("executive"), "the executive skin is a known variant");
  assert.ok(isOfferTemplateVariant("sato"), "the Sato corporate skin is a known variant");
  assert.ok(isOfferTemplateVariant("house"), "the HR-forms house skin is a known variant");
  assert.ok(isOfferTemplateVariant("premium"), "the HR premium skin is a known variant");
  assert.ok(!isOfferTemplateVariant("galaxy"), "an unknown skin must be rejected, not passed through");
  assert.ok(!isOfferBuiltinKey("galaxy"), "an unknown built-in key must be rejected, not passed through");

  // --------------------------------------------------- every block type is editable --
  const definedTypes = new Set(OFFER_BLOCK_DEFS.map((def) => def.type));
  for (const type of ALL_BLOCK_TYPES) {
    assert.ok(definedTypes.has(type), `block type "${type}" has no entry in OFFER_BLOCK_DEFS — it would be uneditable AND dropped on save`);
  }
  assert.equal(
    definedTypes.size,
    ALL_BLOCK_TYPES.length,
    `OFFER_BLOCK_DEFS holds ${definedTypes.size} types against ${ALL_BLOCK_TYPES.length} in the union`,
  );

  for (const builtin of OFFER_BUILTIN_TEMPLATES) {
    const blocks = builtin.blocks();
    assert.ok(blocks.length > 8, `${builtin.name}: a whole offer letter, not a stub (${blocks.length} blocks)`);

    // A block type the sanitizer does not know is silently discarded on save.
    for (const block of blocks) {
      assert.ok(
        definedTypes.has(block.type),
        `${builtin.name}: block "${block.id}" is a "${block.type}", which would be dropped the first time this design is saved`,
      );
    }

    // Ids address the click target and the edit target. A collision is renamed by the sanitizer,
    // which means the id you clicked is not the id you edited.
    const ids = blocks.map((block) => block.id);
    assert.equal(new Set(ids).size, ids.length, `${builtin.name}: block ids must be unique within a design`);
  }

  // ----------------------------------------------------------------- the five skins --
  const classic = OFFER_BUILTIN_TEMPLATES.find((entry) => entry.key === "classic");
  const executive = OFFER_BUILTIN_TEMPLATES.find((entry) => entry.key === "executive");
  const sato = OFFER_BUILTIN_TEMPLATES.find((entry) => entry.key === "sato");
  const house = OFFER_BUILTIN_TEMPLATES.find((entry) => entry.key === "house");
  const premium = OFFER_BUILTIN_TEMPLATES.find((entry) => entry.key === "premium");
  assert.ok(classic && executive && sato && house && premium, "all five designs must be in the registry");

  const classicDoc = renderOfferDocument(
    { blocks: classic.blocks(), fontFamily: classic.fontFamily, fontSizePt: classic.fontSizePt, theme: classic.theme, variant: classic.variant },
    SAMPLE,
  );
  const executiveDoc = renderOfferDocument(
    { blocks: executive.blocks(), fontFamily: executive.fontFamily, fontSizePt: executive.fontSizePt, theme: executive.theme, variant: executive.variant },
    SAMPLE,
  );
  const satoDoc = renderOfferDocument(
    { blocks: sato.blocks(), fontFamily: sato.fontFamily, fontSizePt: sato.fontSizePt, theme: sato.theme, variant: sato.variant },
    SAMPLE,
    { logoReverseUrl: "data:image/png;base64,CCCC" },
  );
  const houseDoc = renderOfferDocument(
    { blocks: house.blocks(), fontFamily: house.fontFamily, fontSizePt: house.fontSizePt, theme: house.theme, variant: house.variant },
    SAMPLE,
    { logoUrl: "data:image/png;base64,DDDD" },
  );
  const premiumDoc = renderOfferDocument(
    { blocks: premium.blocks(), fontFamily: premium.fontFamily, fontSizePt: premium.fontSizePt, theme: premium.theme, variant: premium.variant },
    SAMPLE,
    { logoUrl: "data:image/png;base64,DDDD" },
  );

  assert.ok(executiveDoc.css.length > classicDoc.css.length, "the executive skin is an override sheet appended to the base");
  // The page size is the cleanest discriminator: the base sheet is A4 and the uploaded executive
  // letter is US Letter, measured from the PDF itself.
  assert.ok(!classicDoc.css.includes("size:letter"), "the classic design must not carry the executive skin");
  assert.ok(executiveDoc.css.includes("size:letter"), "the executive skin must actually be appended");
  assert.equal(classicDoc.pageSize, "A4", "the classic letter prints A4");
  assert.equal(executiveDoc.pageSize, "Letter", "the executive letter prints US Letter, as uploaded");

  // The measured colours, straight out of the uploaded PDF's own content stream. If these drift the
  // letter still renders — in the wrong company's colours.
  assert.ok(executiveDoc.css.includes("--ink:#0b1724"), "the executive navy must reach the stylesheet");
  assert.ok(executiveDoc.css.includes("--brand:#0b86be"), "the executive blue must reach the stylesheet");
  assert.ok(classicDoc.css.includes("--brand:#0879b8"), "the classic design keeps the SATO brand blue");

  // ── The welcome band must not orphan onto a page of its own ────────────────────────────────
  // It is the LAST element of the executive letter, and the letter is US Letter rather than A4, so
  // it has less room than every other design. At the 16pt this skin shipped with, it did not fit
  // under the foot: EVERY executive offer printed a third page carrying the band and nothing else
  // (measured 15 Oct 2026 on the live template, for a blank role paragraph and for the longest one
  // in the catalogue alike). The threshold sits between 14pt and 16pt, so the margin is pinned at or
  // under 14pt rather than at one value — a smaller gap is a judgement, a bigger one is the defect.
  const welcomeMarginPt = Number(/\.welcome\{border:0;margin-top:(\d+(?:\.\d+)?)pt\}/.exec(executiveDoc.css)?.[1] ?? NaN);
  assert.ok(
    Number.isFinite(welcomeMarginPt),
    "the executive skin must still set its own top margin on the welcome band — the rule was renamed or lost",
  );
  assert.ok(
    welcomeMarginPt <= 14,
    `the executive welcome band's top margin is ${welcomeMarginPt}pt; over 14pt it does not fit under the foot `
      + "and every executive offer prints an empty third page holding only that band",
  );

  // ── The Sato corporate design ──────────────────────────────────────────────────────────────
  // A third skin appended to the base, added beside the two frozen letters and changing neither.
  assert.ok(satoDoc.css.length > classicDoc.css.length, "the Sato skin is an override sheet appended to the base");
  assert.equal(satoDoc.pageSize, "A4", "the Sato letter prints A4 — its masthead is in the flow, not repeated furniture");
  assert.ok(!satoDoc.css.includes("size:letter"), "the Sato design is A4 and must not carry the executive skin");
  assert.ok(satoDoc.css.includes("--brand:#0879b8"), "the Sato design uses the one Sato brand blue");
  assert.ok(satoDoc.css.includes("--ink:#17304d"), "the Sato navy must reach the stylesheet — it is every dark mass in the design");
  // The identity signatures: the navy masthead band, the 3px brand seam, and the reverse mark.
  assert.ok(/\.letterhead\{[^}]*background:var\(--ink\)/.test(satoDoc.css), "the Sato masthead is a navy band");
  assert.ok(/\.rail\{height:3px\}/.test(satoDoc.css), "the navy band is closed by a 3px brand seam");
  assert.ok(satoDoc.css.includes(".letterhead .lh-reverse{display:block"), "the Sato skin reveals the reverse mark");
  assert.ok(satoDoc.css.includes(".letterhead img{display:none}"), "the on-light ink mark is hidden on the navy band");
  assert.ok(
    /<img class="lh-reverse" src="data:image\/png;base64,CCCC"/.test(satoDoc.body),
    "the Sato masthead carries the reverse Sato mark the renderer was handed",
  );
  // The closing welcome band wears the SAME reverse mark on navy — no tinted tile — closed by its
  // own brand seam, mirroring the masthead. The ink mark and the tint cap are hidden on the Sato skin.
  assert.ok(
    /<img class="wc-reverse" src="data:image\/png;base64,CCCC"/.test(satoDoc.body),
    "the Sato welcome band carries the reverse Sato mark the renderer was handed",
  );
  assert.ok(satoDoc.css.includes(".welcome-cap .wc-reverse{display:block"), "the Sato skin reveals the reverse mark in the welcome band");
  assert.ok(/\.welcome\{border:0;border-top:3px solid var\(--brand\)\}/.test(satoDoc.css), "the Sato welcome band is closed by a 3px brand seam");
  assert.ok(/\.welcome-cap\{background:var\(--ink\)/.test(satoDoc.css), "the Sato welcome cap is navy, not a tinted tile");
  // The reverse mark is drawn ONLY when the renderer is given one — classic and executive never are.
  assert.ok(!classicDoc.body.includes("lh-reverse"), "the classic letterhead carries no reverse-mark element");
  assert.ok(!executiveDoc.body.includes("lh-reverse"), "the executive letterhead carries no reverse-mark element");
  assert.ok(!classicDoc.body.includes("wc-reverse"), "the classic welcome band carries no reverse-mark element");
  assert.ok(!executiveDoc.body.includes("wc-reverse"), "the executive welcome band carries no reverse-mark element");
  assert.ok(classicDoc.css.includes(".letterhead .lh-reverse{display:none}"), "the base hides the reverse mark by default");
  assert.ok(classicDoc.css.includes(".welcome-cap .wc-reverse{display:none}"), "the base hides the welcome reverse mark by default");

  // ── The HR-forms house design ──────────────────────────────────────────────────────────────
  // A FOURTH skin, the SATO-DIS-2026-01 house identity, added beside the three others and changing
  // none of them. It PAINTS NOTHING — its signature is the ink rule: lines and type in the three
  // logo blues, one 6% zebra, and the engine-turned band under the mark.
  assert.equal(houseDoc.pageSize, "A4", "the house letter prints A4");
  assert.ok(!houseDoc.css.includes("size:letter"), "the house design is A4 and must not carry the executive skin");
  // The variant reached the renderer and was not downgraded to classic: `.rail{display:none}` is a
  // house-only rule, so its presence proves the house branch of offerDocumentCss ran.
  assert.ok(houseDoc.css.includes(".rail{display:none}"), "the house skin drops the filled top brand bar");
  assert.ok(!classicDoc.css.includes(".rail{display:none}"), "the house skin must not reach the classic design");
  assert.ok(!satoDoc.css.includes(".rail{display:none}"), "the house skin must not reach the Sato design");
  // The three logo blues, sampled from the mark — the identity's colour.
  assert.ok(houseDoc.css.includes("--brand:#0A6BA6"), "Brand Blue (the one accent) must reach the stylesheet");
  assert.ok(houseDoc.css.includes("--tint:#F2F6FA"), "the 6% zebra tint must reach the stylesheet");
  assert.ok(houseDoc.css.includes("color:#0A527D"), "Brand Deep must ink the headings, table rules and clause numerals");
  // THE INK RULE. None of the filled masses the other three draw survive: no navy masthead band, no
  // tinted salary hero, no ink clause tile, no filled accept header.
  assert.ok(!/\.letterhead\{[^}]*background:var\(--ink\)/.test(houseDoc.css), "the house masthead is not a filled band");
  assert.ok(/\.comp-hero\{background:#fff/.test(houseDoc.css), "the salary hero is white, not a tinted panel");
  assert.ok(/\.clause \.no\{background:#fff/.test(houseDoc.css), "the clause numeral is type, not a filled ink tile");
  assert.ok(/\.accept-h\{background:#fff/.test(houseDoc.css), "the acceptance header is ruled, not a filled ink band");
  // The one deliberate fill — the 6% zebra on the salary table.
  assert.ok(
    houseDoc.css.includes(".comp tbody tr:not(.total):nth-child(odd) td{background:var(--tint)}"),
    "the salary table carries the one permitted fill — the 6% zebra",
  );
  // The engine-turned band under the mark, in Brand Deep, is the house letterhead's ornament.
  assert.ok(
    /\.letterhead\{padding:6px 0 3mm;background:url\(data:image\/svg\+xml/.test(houseDoc.css),
    "the house masthead carries the engine-turned band on its lower edge",
  );
  // The on-light mark the renderer was handed is placed in the letterhead (house draws on white, so
  // it needs no reverse mark and carries none).
  assert.ok(houseDoc.body.includes('src="data:image/png;base64,DDDD"'), "the house letterhead carries the on-light mark");
  assert.ok(!houseDoc.body.includes("lh-reverse"), "the house design draws on white and needs no reverse mark");
  assert.ok(!/class="welcome/.test(houseDoc.body), "the house letter ends on the signature, like the HR forms — no welcome band");

  premiumSkinTests({ classic, house, premium }, { classicDoc, houseDoc, premiumDoc });
  frozenDesignTests();

  for (const [name, doc] of [
    ["classic", classicDoc],
    ["executive", executiveDoc],
    ["sato", satoDoc],
    ["house", houseDoc],
    ["premium", premiumDoc],
  ] as const) {
    assert.ok(doc.html.startsWith("<!doctype html>"), `${name}: the document is standalone`);
    assert.ok(doc.html.includes("SAMAA SHALABY"), `${name}: the candidate is named`);
    assert.ok(doc.html.includes("@page"), `${name}: the print page size must be declared`);
    assert.equal(
      /\{\{\s*[a-zA-Z0-9_]+\s*\}\}/.exec(doc.body),
      null,
      `${name}: a finished document must carry no unresolved tokens`,
    );
    // One typed total, five derived figures — the same identity the classic letter is pinned on.
    for (const figure of ["18,550", "7,950", "3,500", "30,000"]) {
      assert.ok(doc.body.includes(figure), `${name}: the letter must carry ${figure}`);
    }
  }

  // The executive letter's own furniture, each a thing the design is recognisable by.
  assert.ok(executiveDoc.body.includes("SS"), "the initials disc must be filled from the candidate's name");
  assert.ok(/class="welcome/.test(executiveDoc.body), "the closing welcome band belongs to this design");

  // ------------------------------------------------------------- the running page foot --
  const tokens = buildOfferTokens(SAMPLE);
  const foot = offerPageFooterHtml(executive.blocks(), tokens, executive.theme);
  assert.ok(foot !== "", "the executive design declares a running foot");
  assert.ok(
    !foot.includes("var(--"),
    "Chromium renders footerTemplate in a separate document with no custom properties — a var() here prints nothing",
  );
  assert.ok(!/class="(?!pageNumber|totalPages)/.test(foot.replace(/class="(pageNumber|totalPages)"/g, "")),
    "the foot may only use the two classes Chromium substitutes; a stylesheet class would be unstyled");
  assert.ok(foot.includes("pageNumber"), "the running foot must carry a live page number");
  assert.equal(
    /\{\{\s*[a-zA-Z0-9_]+\s*\}\}/.exec(foot),
    null,
    "the running foot must carry no unresolved tokens",
  );

  // A design with no page mark must produce no foot at all. Chromium given an empty footerTemplate
  // falls back to its OWN default, which stamps the page title and today's date onto a legal letter.
  assert.equal(
    offerPageFooterHtml(classic.blocks(), tokens, classic.theme),
    "",
    "the classic design asks for no running foot, so none may be emitted",
  );

  // ------------------------------------------------------------------------ the email --
  // Both designs go out through the same table-based renderer, so both carry the same guarantees.
  for (const builtin of OFFER_BUILTIN_TEMPLATES) {
    const email = renderOfferEmail({ blocks: builtin.blocks(), theme: builtin.theme }, SAMPLE);

    assert.ok(!/display\s*:\s*grid/i.test(email.html), `${builtin.name}: grid does not exist in Outlook`);
    assert.ok(!/display\s*:\s*flex/i.test(email.html), `${builtin.name}: flex does not exist in Outlook`);
    assert.ok(!/\d\s*pt\b/i.test(email.html), `${builtin.name}: pt units are unreliable in mail clients`);
    assert.ok(!/color-mix\(/i.test(email.html), `${builtin.name}: color-mix() is unsupported in mail clients and renders as no colour at all`);

    const presentation = (email.html.match(/role="presentation"/g) ?? []).length;
    const tables = (email.html.match(/<table/g) ?? []).length;
    assert.equal(presentation, tables, `${builtin.name}: every layout table needs role="presentation" (${presentation}/${tables})`);

    assert.equal(
      /\{\{\s*[a-zA-Z0-9_]+\s*\}\}/.exec(email.html),
      null,
      `${builtin.name}: the email must carry no unresolved tokens`,
    );
    for (const figure of ["18,550", "7,950", "3,500", "30,000"]) {
      assert.ok(email.html.includes(figure), `${builtin.name}: the email must carry ${figure}`);
    }
    assert.ok(email.text.length > 400, `${builtin.name}: the plain-text part must be real (${email.text.length} chars)`);
    assert.ok(!/<[a-z]/i.test(email.text), `${builtin.name}: the plain-text part must contain no markup`);
  }

  // The executive design's dark bands are the thing a mail client is most likely to lose, because
  // they are background fills rather than text. They are inline styles for exactly that reason.
  const executiveEmail = renderOfferEmail({ blocks: executive.blocks(), theme: executive.theme }, SAMPLE);
  assert.ok(executiveEmail.html.includes("#0b1724"), "the executive navy must be inlined into the email, not left to a class");

  // ------------------------------------------- the executive letter's identity, page by page --
  // Everything below was measured off the uploaded "Ultra Premium" PDF. Each assertion is a detail
  // that was wrong once and was corrected against the source, so a failure here means the letter
  // has drifted from the document the owner supplied.
  const marked = renderOfferDocument(
    { blocks: executive.blocks(), fontFamily: executive.fontFamily, fontSizePt: executive.fontSizePt, theme: executive.theme, variant: executive.variant },
    SAMPLE,
    { logoUrl: "data:image/png;base64,AAAA" },
  );

  // The masthead repeats at the top of BOTH pages of the source. Flow content cannot do that, so it
  // is Chromium page furniture driven by the letterhead block — and that block is hidden in flow.
  assert.ok(marked.pageHeaderHtml !== "", "the executive letter repeats its masthead on every page");
  assert.ok(
    marked.pageHeaderHtml.includes("data:image/png;base64,AAAA"),
    "the repeated masthead must carry the Sato mark, not only type",
  );
  assert.ok(
    marked.pageHeaderHtml.includes("text-transform:uppercase"),
    "both masthead labels are set in capitals in the source",
  );
  assert.ok(
    !marked.pageHeaderHtml.includes("var(--"),
    "Chromium renders the header in a separate document that inherits no custom properties",
  );
  assert.ok(
    marked.css.includes(".letterhead{display:none}"),
    "the in-flow letterhead must be hidden, or the masthead prints twice on page one",
  );
  assert.equal(
    classicDoc.pageHeaderHtml,
    "",
    "the classic design asks for no repeated masthead, so none may be emitted",
  );
  assert.ok(
    !classicDoc.css.includes(".letterhead{display:none}"),
    "the classic letterhead stays in the flow where it has always been",
  );

  // Four typographic details, each measured off the source page.
  assert.ok(/h1\{[^}]*text-transform:uppercase/.test(marked.css), "the source sets the title in capitals");
  assert.ok(
    /\.section-h \.sub\{[^}]*color:var\(--brand\)/.test(marked.css),
    "'/ NET PACKAGE' and its siblings are brand blue in the source, not grey",
  );
  assert.ok(
    /\.steps \.h\{[^}]*text-transform:uppercase/.test(marked.css),
    "the onboarding step titles are set in capitals in the source",
  );
  assert.ok(
    /\.lede-body \.lead:first-child\{[^}]*font-weight:700/.test(marked.css),
    "the salutation is bold in full in the source, not only the name inside it",
  );

  // The mark appears twice: the repeated masthead, and the welcome band. The uploaded letter also
  // sets one beside the confidentiality note, but the owner had it removed on 2026-08-27 — stacked
  // two lines above the welcome band's mark it read as floating loose. Exactly ONE in the body.
  assert.equal(
    (marked.body.match(/class="mark"/g) ?? []).length,
    1,
    "the welcome band carries the only in-body mark; the one above it was removed by the owner",
  );
  assert.ok(
    !/<footer class="foot"[^]*?class="mark"[^]*?<\/footer>/.test(marked.body),
    "no mark may return beside the confidentiality note",
  );
  assert.ok(
    marked.css.includes(".welcome-cap .mark{display:block"),
    "the welcome band's mark must be revealed by the executive skin",
  );
  assert.ok(
    classicDoc.css.includes(".welcome-cap .mark{display:none}"),
    "the classic letter sets its identity in type and shows no mark",
  );

  // Page two of the source opens on the same rule page one does, under the repeated masthead.
  const railsAfterBreak = executive
    .blocks()
    .slice(executive.blocks().findIndex((block) => block.type === "pagebreak"))
    .filter((block) => block.type === "rail").length;
  assert.equal(railsAfterBreak, 1, "page two opens on a rail, as page one does");

  // An empty `logo` prop means the designer cleared the field on purpose and must NOT fall back to
  // the supplied mark. An ABSENT prop is what lets the renderer fill it in.
  assert.equal(
    Object.hasOwn(executive.blocks()[0]?.props ?? {}, "logo"),
    false,
    "the executive letterhead must leave `logo` absent so the renderer supplies the Sato mark",
  );

  // ── The authorised signatory's signature ───────────────────────────────────────────────────
  // Both letters go out pre-signed by a named person, so both must name him and neither may pin a
  // `leftSignature` — absent is what lets the renderer supply the signature on file, exactly as the
  // letterhead logo works above.
  for (const builtin of OFFER_BUILTIN_TEMPLATES) {
    const block = builtin.blocks().find((b) => b.type === "signature");
    assert.ok(block, `${builtin.key} must still carry a signature block`);
    assert.equal(
      block.props?.leftName,
      "Omar Anwar Gawish",
      `${builtin.key} signs in a real name — a signature over an anonymous role is unattributable`,
    );
    assert.equal(
      Object.hasOwn(block.props ?? {}, "leftSignature"),
      false,
      `${builtin.key} must leave leftSignature ABSENT so the renderer supplies the signature on file`,
    );
  }

  const signed = renderOfferDocument(
    { blocks: executive.blocks(), theme: executive.theme, variant: executive.variant },
    SAMPLE,
    { signatureUrl: "data:image/png;base64,BBBB" },
  );
  assert.equal(
    (signed.body.match(/class="sigink"/g) ?? []).length,
    1,
    "exactly ONE signature may be drawn — the company signs, the candidate signs by hand",
  );
  // The candidate's own panel must never be pre-signed. Split on the panel boundary and check the
  // ink landed in the first half, which is the company's.
  const [company, candidate] = signed.body.split('<div class="micro k">Accepted By</div>');
  assert.ok(company?.includes('class="sigink"'), "the signature belongs on the company's panel");
  assert.ok(
    candidate !== undefined && !candidate.includes('class="sigink"'),
    "the candidate's panel must NEVER carry a signature — that would be signing on their behalf",
  );

  // All four rules move together, or two of them sit visibly lower than the others.
  assert.equal(
    (signed.body.match(/class="sigrow signed"/g) ?? []).length,
    2,
    "both panels take the signed headroom, so all four rules stay level",
  );
  assert.ok(
    /\.sigrow\.signed \.sigline\{margin-top:-/.test(signed.css),
    "the rule must ride UP into the ink so the signature sits ON the line, not hovering above it",
  );

  // Clearing the field is a real editing choice and must survive: an empty string prints an
  // unsigned letter even when the renderer was handed a signature.
  const unsigned = renderOfferDocument(
    {
      blocks: executive.blocks().map((b) => (b.type === "signature" ? { ...b, props: { ...b.props, leftSignature: "" } } : b)),
      theme: executive.theme,
      variant: executive.variant,
    },
    SAMPLE,
    { signatureUrl: "data:image/png;base64,BBBB" },
  );
  assert.ok(
    !unsigned.body.includes('class="sigink"'),
    "an empty leftSignature is a deliberate clearing and must NOT fall back to the signature on file",
  );
}

// =====================================================================================================
// The fifth design — HR premium — and the lock on the four before it.
// =====================================================================================================

type BuiltinDesign = (typeof OFFER_BUILTIN_TEMPLATES)[number];
type OfferDocument = ReturnType<typeof renderOfferDocument>;
type RenderOptions = Parameters<typeof renderOfferDocument>[2];

function renderDesign(design: BuiltinDesign, fields: OfferFields, options: RenderOptions = {}): OfferDocument {
  return renderOfferDocument(
    { blocks: design.blocks(), fontFamily: design.fontFamily, fontSizePt: design.fontSizePt, theme: design.theme, variant: design.variant },
    fields,
    options,
  );
}

/** Every run of visible text in a document, entities decoded — the WORDS, whatever the markup around them. */
function textChunks(html: string): string[] {
  return html
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<svg[\s\S]*?<\/svg>/g, " ")
    .split(/<[^>]*>/)
    .map((chunk) =>
      chunk
        .replace(/&middot;/g, "·")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter((chunk) => chunk !== "");
}

/** A stylesheet as flat rules — selectors and declaration bodies, comments gone. */
function cssRules(css: string): { body: string; selectors: string[] }[] {
  return [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    body: match[2] ?? "",
    selectors: (match[1] ?? "").split(",").map((selector) => selector.trim()),
  }));
}

/** The last value a rule body gives a property — the one that wins inside that rule. */
function lastValue(body: string, property: "background" | "display"): string | null {
  const found = [...body.matchAll(new RegExp(`(?:^|;)\\s*${property}(?:-color)?\\s*:\\s*([^;]+)`, "g"))];
  const last = found[found.length - 1];
  return last ? (last[1] ?? "").trim() : null;
}

/** A background that paints an area: anything but nothing, transparent, or the page's own white. */
function paints(value: string | null): boolean {
  return value !== null && !/^(none|transparent|#fff|#ffffff|white)$/i.test(value);
}

const PREMIUM_ZEBRA = ".comp tbody tr:not(.total):nth-child(odd) td";

function premiumSkinTests(
  designs: { classic: BuiltinDesign; house: BuiltinDesign; premium: BuiltinDesign },
  docs: { classicDoc: OfferDocument; houseDoc: OfferDocument; premiumDoc: OfferDocument },
): void {
  const { classic, house, premium } = designs;
  const { classicDoc, houseDoc, premiumDoc } = docs;

  // ── It is a design of its own, on its own skin ───────────────────────────────────────────────────
  assert.equal(premium.variant, "premium", "the fifth design carries its own skin");
  assert.equal(premium.seedAsDefault, false, "a new offer still opens on the classic letter — premium is chosen, never seeded as the default");
  assert.equal(premium.name, "SATO Premium Offer", "the design is named for the company, never the app");
  assert.ok(!/phoenix/i.test(`${premium.name} ${premium.description}`), "nothing the designer lists for the design says Phoenix");
  assert.equal(premiumDoc.pageSize, "A4", "the premium letter prints A4, portrait");
  assert.ok(!premiumDoc.css.includes("size:letter"), "the premium design must not carry the executive skin");
  assert.ok(premiumDoc.css.includes(PREMIUM_OFFER_SKIN), "the premium skin is appended to the base sheet, whole");
  assert.ok(
    !classicDoc.css.includes(PREMIUM_OFFER_SKIN) && !houseDoc.css.includes(PREMIUM_OFFER_SKIN),
    "the premium skin must not reach the classic or house design",
  );
  // The premium sheet geometry: the page has no margin of its own, the sheet carries the padding, and
  // the frame and foot are fixed so they repeat on every printed page.
  const pageRules = [...premiumDoc.css.matchAll(/@page\s*\{[^}]*\}/g)].map((match) => match[0]);
  assert.match(
    pageRules[pageRules.length - 1] ?? "",
    /margin:\s*0\s*[;}]/,
    "premium prints edge to edge: the @page rule that wins has margin 0, and the sheet owns the padding",
  );
  assert.ok(/position:\s*fixed/.test(premiumDoc.css), "the frame and the foot are fixed, so they print on every page");
  assert.equal(premiumDoc.pageHeaderHtml, "", "premium draws its own chrome — no Chromium header");
  assert.equal(premiumDoc.pageFooterHtml, "", "premium draws its own foot — no Chromium footer to print the date and title over a letter");
  assert.ok(premiumDoc.css.includes(".rail{display:none}"), "the premium skin drops the filled top brand bar");

  // ── It says what the other designs say: the dress changes, never the words ───────────────────────
  const stripIds = (blocks: { id: string }[]) => JSON.stringify(blocks.map(({ id: _id, ...rest }) => rest));
  assert.equal(
    stripIds(premium.blocks()),
    stripIds(classic.blocks()),
    "the premium blocks are the classic blocks word for word — only the ids differ, so the two never collide in the designer",
  );
  assert.ok(premium.blocks().every((block) => block.id.endsWith("-p")), "premium block ids carry their own suffix");
  const wordedFields = { ...SAMPLE, roleSummary: "You will lead the people who sell across {{territory}}.", territory: "Alex East" };
  const premiumWorded = textChunks(renderDesign(premium, wordedFields).body).join(" ");
  assert.ok(
    premiumWorded.includes("You will lead the people who sell across Alex East."),
    "the premium letter prints the job title's own {{roleSummary}}, with {{territory}} resolved inside it",
  );
  assert.ok(!premiumWorded.includes("{{"), "no token reaches the premium letter unresolved");
  // Every run of words the classic and the house letters print is in the premium letter — the legal
  // wording included. The masthead joins the company name and unit onto one line and the title row
  // moves into it, so the check is on the words, not on where they stand.
  const premiumText = textChunks(premiumDoc.body).join(" ");
  for (const [name, doc] of [["classic", classicDoc], ["house", houseDoc]] as const) {
    const chunks = textChunks(doc.body);
    assert.ok(chunks.length > 60, `the ${name} letter's words were found (${chunks.length} runs) — a sweep that finds none proves nothing`);
    for (const chunk of chunks) {
      assert.ok(premiumText.includes(chunk), `the ${name} letter says "${chunk}" and the premium letter must say it too`);
    }
  }

  // ── The company seal and the two signature cells, exactly as the offer draws them today ──────────
  const signedOptions = {
    logoUrl: "data:image/png;base64,DDDD",
    sealUrl: "data:image/svg+xml;base64,SEAL",
    signatureUrl: "data:image/png;base64,BBBB",
  };
  const premiumSigned = renderDesign(premium, SAMPLE, signedOptions);
  assert.equal((premiumSigned.body.match(/class="offer-seal"/g) ?? []).length, 1, "the seal is drawn exactly once on the premium letter");
  const [companyCell, candidateCell] = premiumSigned.body.split('<div class="micro k">Accepted By</div>');
  assert.ok(
    companyCell !== undefined && /<div class="sigcell"><img class="offer-seal"[^>]*><div class="sigink-box">/.test(companyCell),
    "the seal sits in the company's signature cell and nowhere else — over its own rule",
  );
  assert.ok(candidateCell !== undefined && !candidateCell.includes("offer-seal"), "the candidate's cell is never stamped");
  assert.ok(candidateCell !== undefined && !candidateCell.includes('class="sigink"'), "the candidate's cell is never pre-signed");
  assert.equal(
    (candidateCell?.match(/<div class="sigink-box"><\/div>/g) ?? []).length,
    2,
    "the candidate's signature and date boxes are blank",
  );
  const acceptBlock = (doc: OfferDocument): string =>
    doc.body.slice(doc.body.indexOf('<div class="accept keep">'), doc.body.indexOf('<footer class="foot">'));
  const classicSigned = renderDesign(classic, SAMPLE, signedOptions);
  const houseSigned = renderDesign(house, SAMPLE, signedOptions);
  assert.ok(acceptBlock(premiumSigned).includes("offer-seal"), "the acceptance block was found, with the seal in it");
  assert.equal(acceptBlock(premiumSigned), acceptBlock(classicSigned), "premium's acceptance block is the classic letter's, byte for byte");
  assert.equal(acceptBlock(premiumSigned), acceptBlock(houseSigned), "premium's acceptance block is the house letter's, byte for byte");
  for (const selector of [/\.offer-seal\{[^}]*\}/, /\.sigcell\{[^}]*\}/]) {
    const base = selector.exec(classicDoc.css)?.[0];
    assert.ok(base, `the base sheet defines ${selector}`);
    assert.ok(premiumDoc.css.includes(base), `the premium letter keeps the base's own ${base.split("{")[0]} rule, untouched`);
  }
  // The skin moves the seal and nothing else about the signature cells. The base drew a 30mm seal
  // centred on the whole cell, which printed the word SIGNATURE under the ink (owner, 19 Oct 2026:
  // "fix sato premium offer template", then "Move the seal"). So the premium skin may place
  // `.offer-seal`, only inside `.accept`, only smaller, and only with its foot on the rule — and it
  // still never restyles the cell or the signature ink.
  const sealRule = /\.accept \.offer-seal\{([^}]*)\}/.exec(PREMIUM_OFFER_SKIN)?.[1];
  assert.ok(sealRule, "the premium skin places the seal through `.accept .offer-seal`");
  assert.ok(/bottom:[\d.]+mm/.test(sealRule) && /top:auto/.test(sealRule), "the seal's foot sits on the signatory's rule, never centred on the cell");
  const sealSide = Number(/width:([\d.]+)mm/.exec(sealRule)?.[1]);
  assert.ok(sealSide > 0 && sealSide < 30, `the premium seal is smaller than the base's 30mm (${sealSide}mm) so it clears the name above it`);
  assert.equal(
    PREMIUM_OFFER_SKIN.replace(/\.accept \.offer-seal\{[^}]*\}/, "").includes("offer-seal"),
    false,
    "the seal is placed in exactly one rule of the premium skin",
  );
  assert.ok(
    !PREMIUM_OFFER_SKIN.includes("sigcell") && !PREMIUM_OFFER_SKIN.includes("sigink"),
    "the premium skin never touches the signature cells or the signature ink",
  );

  // ── Nothing in the letter says Phoenix: it is a company paper, in Sato's name ────────────────────
  assert.ok(
    !/\bphoenix\b/i.test(premiumSigned.html),
    "no word of the premium letter — masthead, foot, watermark alt text, document title — says Phoenix",
  );
  assert.ok(premiumSigned.html.includes("SATO-DIS-2026-01"), "the premium foot carries the company document identity");
  assert.ok(premiumSigned.html.includes("Sato Pharma"), "the premium foot is Sato's own, Sato only");
  assert.ok(premiumSigned.body.includes("pm-mast"), "the premium masthead is drawn");
  assert.ok(
    !premiumSigned.body.includes('lang="ar"'),
    "the English offer prints no Arabic run — and so no empty one with a stray diamond before the names",
  );
  assert.ok(!premiumSigned.body.includes("pm-dia"), "no diamond leads the names line when there is no Arabic name before it");

  // ── Ink rule, square corners, no shadows ─────────────────────────────────────────────────────────
  for (const [place, text] of [["css", premiumSigned.css], ["document", premiumSigned.html]] as const) {
    for (const match of text.matchAll(/border-radius\s*:\s*([^;}"]+)/g)) {
      assert.match(match[1] ?? "", /^0(px)?$/, `premium ${place}: every corner is square (found border-radius: ${match[1]})`);
    }
    assert.ok(!/box-shadow|text-shadow|drop-shadow/.test(text), `premium ${place}: no shadows`);
    assert.ok(!/gradient\(/.test(text), `premium ${place}: no gradients`);
  }
  assert.ok(!/\brx=/.test(premiumSigned.html), "premium draws no rounded SVG shape");
  // Inside the skin, the only background that is not nothing is the 6% zebra on the salary table.
  const skinRules = cssRules(PREMIUM_OFFER_SKIN);
  const painted = skinRules.filter((rule) => paints(lastValue(rule.body, "background")));
  assert.deepEqual(
    painted.map((rule) => rule.selectors),
    [[PREMIUM_ZEBRA]],
    "the premium skin paints exactly one area — the salary table's zebra row",
  );
  assert.equal(lastValue(painted[0]?.body ?? "", "background"), "var(--tint)", "the zebra is the 6% tint");
  assert.ok(!/url\(/.test(PREMIUM_OFFER_SKIN), "the premium skin tiles no image — the band is a vector inside the masthead");
  // And every area the BASE sheet paints is either switched off or turned to nothing by the skin,
  // under the very same selector — so nothing the base fills survives into the premium letter.
  const skinFinal = new Map<string, { background: string | null; display: string | null }>();
  for (const rule of skinRules) {
    for (const selector of rule.selectors) {
      const earlier = skinFinal.get(selector);
      skinFinal.set(selector, {
        background: lastValue(rule.body, "background") ?? earlier?.background ?? null,
        display: lastValue(rule.body, "display") ?? earlier?.display ?? null,
      });
    }
  }
  let baseFills = 0;
  for (const rule of cssRules(classicDoc.css)) {
    if (!paints(lastValue(rule.body, "background"))) continue;
    for (const selector of rule.selectors) {
      baseFills += 1;
      const answer = skinFinal.get(selector);
      assert.ok(
        answer !== undefined && (answer.display === "none" || !paints(answer.background)),
        `the base sheet paints ${selector} and the premium skin must switch it off or clear it`,
      );
    }
  }
  assert.ok(baseFills >= 8, `the base sheet's painted selectors were found (${baseFills}) — a sweep that finds none proves nothing`);

  // ── Escaped once: a name with an ampersand in it prints one `&amp;`, never `&amp;amp;` ───────────
  const ampersand = renderDesign(premium, { ...SAMPLE, territory: "Alex & Delta" }, signedOptions);
  assert.ok(ampersand.body.includes("Alex &amp; Delta"), "the territory reaches the premium masthead escaped once");
  assert.ok(
    !ampersand.html.includes("&amp;amp;") && !ampersand.html.includes("&amp;middot;"),
    "the premium masthead must not escape its words a second time",
  );

  // ── The two images the chrome names by /brand/ path reach both the preview and the PDF ───────────
  assert.ok(/src="\/brand\//.test(premiumSigned.html), "the premium chrome names its mark and watermark by /brand/ path");
  const inlined = inlineLocalAssets(premiumSigned.html);
  assert.deepEqual(inlined.missing, [], "every /brand/ image the premium letter names exists on disk to be inlined");
  assert.ok(
    !/src="\/brand\//.test(inlined.html) && inlined.html.includes('src="data:image/'),
    "once inlined, no premium image is left for the page to resolve",
  );
  assert.ok(
    !/src="\/(brand|forms)\//.test(classicSigned.html) && !/src="\/(brand|forms)\//.test(houseSigned.html),
    "the older designs name no /brand/ image, so inlining them would change nothing",
  );
  const pdfSource = stripComments(readFileSync("src/lib/offers/pdf.ts", "utf8"));
  assert.ok(
    /premium\s*\?\s*inlineLocalAssets\(rendered\.html\)\.html\s*:\s*rendered\.html/.test(pdfSource),
    "the PDF path inlines the premium design's images and hands every other design's html over unchanged",
  );
  assert.ok(
    /premium\s*\?\s*await stampPremiumPageNumbers\(printed\)\s*:\s*printed/.test(pdfSource),
    "the premium PDF is numbered N / M after layout; every other design's bytes are returned as printed",
  );
  const previewSource = stripComments(readFileSync("app/api/offers/preview/route.ts", "utf8"));
  assert.ok(
    /premium\s*\?\s*inlineLocalAssets\(rendered\.html\)\.html\s*:\s*rendered\.html/.test(previewSource)
      && /premium\s*\?\s*inlineLocalAssets\(rendered\.body\)\.html\s*:\s*rendered\.body/.test(previewSource),
    "the designer's preview inlines the premium design's images, and returns every other design as it always has",
  );
}

/**
 * THE FOUR OLDER DESIGNS ARE FROZEN — owner rule, 2026-09-05. Their rendered letter is fingerprinted
 * against the bytes measured BEFORE the premium design was added: the whole document (html, body,
 * css, page size, running header and foot) for a fixed fixture with every image supplied.
 *
 * A red here means a change reached classic, executive, sato or house. If it was meant to, the owner
 * has to have said so, and the digest below is the thing to update with his word in the commit; if
 * it was not meant to, the change belongs behind `variant === "premium"` where it cannot reach them.
 *
 * Re-pinned once, on 15 Oct 2026, on his word: "fix the leadership wording and the executive
 * design's empty third page". Classic, executive and house moved because the closing sentence no
 * longer tells every candidate their LEADERSHIP is a strong addition (the executive title badge no
 * longer says "Leadership Appointment" either), and the executive letter's welcome band now fits
 * under the foot instead of orphaning onto a third page. SATO IS UNCHANGED, which is the proof the
 * edit reached the words it was aimed at and nothing else — its sentence never said leadership.
 *
 * Re-pinned again the same evening, on his word: "drop the welcome sentence from the Executive
 * closing paragraph". The executive letter said "we look forward to welcoming you onboard" twice —
 * once to close the body and again, word for word, in the welcome band under the signature and the
 * foot. The band keeps it; the paragraph now ends at "a strong addition to our organisation".
 * EXECUTIVE WAS THE ONLY DIGEST THAT MOVED on that edit — classic, sato and house were the proof it
 * reached the one letter he named.
 *
 * Re-pinned a third time minutes later, on his word: "drop the welcome sentence from the Corporate
 * closing paragraph too". Corporate welcomed three times over — "we look forward to welcoming you to
 * Sato Pharma" to close the body, then the band heading "Welcome to Sato Pharma" and its sentence.
 * The band keeps both; the paragraph now ends at "returning a copy of this letter", so it instructs
 * and the band welcomes. CLASSIC AND HOUSE ARE UNCHANGED THROUGH ALL THREE RE-PINS — they carry no
 * welcome band at all, which is why neither needed touching.
 */
function frozenDesignTests(): void {
  const fixture: OfferFields = {
    candidateEmail: "samaa@example.com",
    candidateName: "SAMAA SHALABY",
    contractTerm: "One year, renewable",
    costOfLiving: 3500,
    dateOfIssue: "27-Aug-26",
    reference: "SP-HR-DSM-2026-019",
    reportsTo: "National Sales Manager",
    roleSummary: "",
    salutationName: "Dr SAMAA SHALABY",
    startDate: "1 September 2026",
    territory: "Delta (3)",
    title: "District Sales Manager",
    totalMonthly: 30000,
    validUntil: "1 September 2026",
  };
  const everyImage = {
    logoReverseUrl: "data:image/png;base64,CCCC",
    logoUrl: "data:image/png;base64,AAAA",
    sealUrl: "data:image/svg+xml;base64,SEAL",
    signatureUrl: "data:image/png;base64,BBBB",
  };
  const frozen: Record<string, string> = {
    classic: "6904dc4bbad6bbf4cf50b67c044da4624bba253c8fe8804c2338fd426c78017c",
    executive: "400b377c88dd198c347f60e25152a638d588ac1578c80b7d78727f960c481c7c",
    house: "32a225cbdb295ebb1812115339215c230b35399417cfd56dabeab8a2a6243b29",
    sato: "0af8b78761f6a0c2dafc8b33481374b43716f91aad11a23f3cf3be0632fd7790",
  };
  for (const [key, digest] of Object.entries(frozen)) {
    const design = OFFER_BUILTIN_TEMPLATES.find((entry) => entry.key === key);
    assert.ok(design, `${key} is in the registry`);
    const actual = createHash("sha256").update(JSON.stringify(renderDesign(design, fixture, everyImage))).digest("hex");
    assert.equal(
      actual,
      digest,
      `the ${key} design is FROZEN by the owner (2026-09-05) and its rendered letter has changed — a premium change must stay behind variant === "premium"`,
    );
  }
}
