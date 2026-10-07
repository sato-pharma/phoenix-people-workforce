import { strict as assert } from "node:assert";

import { OFFER_BLOCK_DEFS } from "../src/lib/offers/block-schema.ts";
import {
  OFFER_BUILTIN_TEMPLATES,
  isOfferBuiltinKey,
  isOfferTemplateVariant,
  offerBuiltinTemplate,
} from "../src/lib/offers/builtin-templates.ts";
import { buildOfferTokens, offerPageFooterHtml, renderOfferDocument } from "../src/lib/offers/render.ts";
import { renderOfferEmail } from "../src/lib/offers/render-email.ts";
import type { OfferBlockType, OfferFields } from "../src/lib/offers/types.ts";

/**
 * The designs that ship with the job-offer module.
 *
 * The owner uploaded two letters and asked for both, both editable, and switching between them, then
 * asked for a third in Sato's own corporate identity and a fourth in the HR-forms house identity,
 * each added beside the last. All four are implemented as ONE block list plus a skin — so the
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
    4,
    "four designs ship: the classic letter, the executive one, the Sato corporate one, and the HR-forms house one — each added beside the last, none changed",
  );

  const keys = OFFER_BUILTIN_TEMPLATES.map((entry) => entry.key);
  assert.equal(new Set(keys).size, keys.length, "built-in keys must be unique — they are how Restore finds a row");

  const variants = OFFER_BUILTIN_TEMPLATES.map((entry) => entry.variant);
  assert.equal(new Set(variants).size, variants.length, "two built-ins that share a skin would look identical");
  assert.equal(new Set(variants).size, 4, "each shipped design carries its own skin — classic, executive, sato, house");

  assert.equal(
    OFFER_BUILTIN_TEMPLATES.filter((entry) => entry.seedAsDefault).length,
    1,
    "exactly one design may seed as the default — the partial unique index makes two a conflict",
  );

  assert.equal(offerBuiltinTemplate("executive")?.key, "executive", "a built-in is found by key");
  assert.equal(offerBuiltinTemplate("nope"), null, "an unknown key must not resolve to a design");
  assert.ok(
    isOfferBuiltinKey("classic") && isOfferBuiltinKey("executive") && isOfferBuiltinKey("sato") && isOfferBuiltinKey("house"),
    "all four keys are recognised",
  );
  assert.equal(offerBuiltinTemplate("sato")?.key, "sato", "the Sato corporate design is found by key");
  assert.equal(offerBuiltinTemplate("house")?.key, "house", "the HR-forms house design is found by key");
  assert.ok(!isOfferBuiltinKey("default"), "a plausible-looking key that does not exist must be rejected");
  assert.ok(isOfferTemplateVariant("executive"), "the executive skin is a known variant");
  assert.ok(isOfferTemplateVariant("sato"), "the Sato corporate skin is a known variant");
  assert.ok(isOfferTemplateVariant("house"), "the HR-forms house skin is a known variant");
  assert.ok(!isOfferTemplateVariant("premium"), "an unknown skin must be rejected, not passed through");

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

  // ----------------------------------------------------------------- the four skins --
  const classic = OFFER_BUILTIN_TEMPLATES.find((entry) => entry.key === "classic");
  const executive = OFFER_BUILTIN_TEMPLATES.find((entry) => entry.key === "executive");
  const sato = OFFER_BUILTIN_TEMPLATES.find((entry) => entry.key === "sato");
  const house = OFFER_BUILTIN_TEMPLATES.find((entry) => entry.key === "house");
  assert.ok(classic && executive && sato && house, "all four designs must be in the registry");

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

  for (const [name, doc] of [["classic", classicDoc], ["executive", executiveDoc], ["sato", satoDoc], ["house", houseDoc]] as const) {
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
