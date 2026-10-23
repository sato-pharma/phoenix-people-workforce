import sanitizeHtml from "sanitize-html";

import { systemDeployment, systemLegalEntity } from "@/config/system-settings";
import { sanitizeEmailTemplateHtml } from "@/lib/email/email-safety";
import { HOUSE_COLORS } from "@/lib/hiring-pack/house-identity";
import { satoLogoUrl } from "@/lib/offers/brand";

/**
 * The Sato Pharma email: the house identity (SATO-DIS-2026-01) as an email body, never the Phoenix
 * shell. Owner 2026-09-11: "use the Sato identity, not the Phoenix".
 *
 * Nested tables, inline styles and px units, because Outlook lays mail out with Word and ignores
 * flex and grid. The mark is the ON-LIGHT png by absolute URL: the stock file sets SATO in white,
 * and Gmail and Outlook both drop `data:` images.
 *
 * The ink rule and the square-edge rule reach the sender's own body too: background fills are
 * stripped from it, so a highlight colour picked in the editor cannot put a filled area in the mail.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * 🔴 THE LETTER IS A FRAMED DOCUMENT, AND THE FRAME IS THE POINT. Owner 2026-09-12, choosing this
 * shape from four: "b but premium polish zebra tabled". The cuts before it set the letterhead loose
 * on the client's own white page, where an announcement reads as a message somebody typed. A
 * hairline frame closes the document, so what arrives is a notice the company issued.
 *
 * `houseLetterhead()` lays a paper out mark → brand rule → title → hairline → body, and the inside of
 * this frame repeats that sequence exactly rather than inventing an email look beside it. It cannot
 * CALL that function: the paper emits classes against `HOUSE_IDENTITY_CSS`, and a `<style>` sheet is
 * the one thing email clients most reliably throw away. So the structure is shared and the delivery
 * is not — every rule here is inline, on the element it styles.
 *
 * THE BAND IS AN IMAGE HERE, AND IT HAS TO BE. The house ornament is a `data:` SVG tiled as a CSS
 * background, and email throws away both halves of that — `data:` images, and `background-image` in
 * Word-rendered Outlook. `scripts/build-house-band-asset.ts` draws the same curve from the same
 * constants into `public/brand/sato-house-band.png`, which is served over https like the mark.
 *
 * 🔴 AND NOTHING STRUCTURAL HANGS ON IT, because Outlook blocks images until the reader asks for
 * them. The band sits flush inside the top edge as ornament; the letterhead's actual rule is the 2px
 * blue line under the masthead, which is ink. A reader with images off loses the ornament and still
 * has the document.
 *
 * 🔴 THE ZEBRA IS THE ONE FILL, AND IT IS STAMPED ROW BY ROW. `AGENTS.md` §4 allows exactly one
 * filled element in the house format — Brand Blue at 6% on alternating data rows. The paper gets it
 * from `tr:nth-child(even)`; Word-rendered Outlook does not implement `:nth-child` at all, and there
 * is no stylesheet to put it in, so `styleSenderTables()` walks the sender's own table and writes the
 * tint onto each even row's cells. That is also why the sender's fills are stripped first: the only
 * coloured ground that can reach the mail is the house one.
 * ───────────────────────────────────────────────────────────────────────────────────────────── */

const MAX_WIDTH = 640;
const LOGO_WIDTH = 124;
const COMPANY_NAME = systemLegalEntity.legalNameEn;
const COMPANY_NAME_AR = systemLegalEntity.legalNameAr;

/** The house standard every company document wears. `AGENTS.md` §4, THE DOCUMENT IDENTITY. */
const DOCUMENT_STANDARD = "SATO-DIS-2026-01 v1.0";

/** The kicker above the title. What this channel is: one notice, issued to a company list. */
const DOCUMENT_KICKER = "Company announcement";

/** The line under the colophon on a company announcement. A one-to-one notice supplies its own. */
const DEFAULT_FOOTNOTE = "This message was sent to a company distribution list. Recipients cannot see each other's addresses.";

/**
 * Aptos first, because it is the house face and ships with Microsoft 365 — which is what the office
 * reads mail on. Everything after it is a stack that exists on a phone, since a mail client that
 * cannot find the first name silently substitutes rather than asking.
 */
const FONT_STACK = "Aptos,'Segoe UI',Arial,Helvetica,sans-serif";
const MONO_STACK = "Consolas,'Courier New',monospace";

/** The house ornament, drawn by `scripts/build-house-band-asset.ts`. */
const BAND_PUBLIC_PATH = "/brand/sato-house-band.png";

/** The paper's table grid, from `render-hr-paper.ts` — lighter than `hair`, so the zebra reads. */
const TABLE_GRID = "#CFDCE7";

/**
 * Outlook's own gutter on every table, and its refusal to honour `line-height` without being told.
 * Both belong on the elements themselves rather than in the stylesheet, which Outlook discards.
 */
const MSO_TABLE_RESET = "mso-table-lspace:0pt;mso-table-rspace:0pt";
const MSO_EXACT_LEADING = "mso-line-height-rule:exactly";

/**
 * MICRO — the house's label voice, lifted from the journey paper, where EVERY label in the document
 * is one uppercase tracked line and nothing else. Owner 2026-09-12, sending that paper as the
 * reference for this template. It is a SYSTEM, not a size: the kicker, the reference, the section
 * heads and the provenance labels are all the same line at different weights of emphasis, which is
 * what makes a page of unrelated blocks read as one document.
 *
 * `text-transform` is the one declaration here Word's engine may ignore. Nothing hangs on it — a
 * label that fails to uppercase still arrives tracked, bold and small, which is the shape.
 */
const MICRO =
  "font-size:10px;line-height:15px;letter-spacing:1.6px;text-transform:uppercase;font-weight:bold";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Every way a sender can put a coloured ground into the mail, removed before the house puts its own
 * one in. The `background` shorthand is here as well as `background-color`: an editor that writes the
 * shorthand would otherwise smuggle a fill past a rule written only against the longhand.
 */
function stripFills(html: string): string {
  return html
    .replace(/\sbgcolor\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/background-color\s*:\s*[^;"']*;?/gi, "")
    .replace(/background\s*:\s*[^;"']*;?/gi, "");
}

/**
 * A `style=""` left behind by `stripFills` is not cosmetic: it is an attribute, so the block styling
 * below reads the element as already styled and leaves it alone. Removing the empty one is what lets
 * a paragraph the sender highlighted still get the house spacing.
 */
function dropEmptyStyles(html: string): string {
  return html.replace(/\sstyle\s*=\s*(""|'')/gi, "");
}

/** Direction per block, so an Arabic line and an English line each read the right way. */
function directionPerBlock(html: string): string {
  return html.replace(/<(p|li|td|th|blockquote)((?:\s[^>]*)?)>/gi, (match, tag: string, attributes: string) =>
    /\sdir\s*=/i.test(attributes) ? match : `<${tag} dir="auto"${attributes}>`,
  );
}

/**
 * House spacing on the sender's own blocks.
 *
 * 🔴 OUTLOOK IS WHY THIS IS INLINE AND NOT A STYLESHEET. Word's engine gives `<p>` a 1em margin and
 * `<ul>` an indent of its own choosing, so the same email reads with one rhythm in Gmail and another
 * on the desks of the people most of this mail is addressed to. An element the sender already styled
 * is left exactly as they left it — this fills a gap, it does not overrule anybody.
 */
function applyBlockStyle(html: string, tags: readonly string[], css: string): string {
  const pattern = new RegExp(`<(${tags.join("|")})((?:\\s[^>]*)?)>`, "gi");
  return html.replace(pattern, (match, tag: string, attributes: string) =>
    /\sstyle\s*=/i.test(attributes) ? match : `<${tag}${attributes} style="${css}">`,
  );
}

/**
 * THE MARKER IS THE TICK, AND ONLY THE MARKER. The paper opens every milestone row with a short blue
 * tick and sets the words beside it in body ink — so the list of items reads as a marked schedule
 * without a single extra line of furniture.
 *
 * A bullet takes its colour from the item's own colour, with no way to address it separately in
 * email (`::marker` needs a stylesheet, and Word's engine has never implemented it). So the ITEM is
 * set in the brand blue, which paints the marker, and the item's own text is wrapped back to body
 * ink. That is the whole trick.
 *
 * 🔴 IT IS A SCANNER, NOT A REGEX, BECAUSE LISTS NEST. A non-greedy `<li>…</li>` match closes on the
 * FIRST `</li>` it meets, which for an item holding a sub-list is the sub-item's — wrapping half a
 * branch and leaving a stray tag behind. The depth counter is what makes a nested list survive.
 */
function inkListText(html: string): string {
  const open = `<span style="color:${HOUSE_COLORS.body}">`;
  let depth = 0;
  return html.replace(/<(\/?)li((?:\s[^>]*)?)>/gi, (_match, closing: string, attributes: string) => {
    if (closing === "/") {
      if (depth === 0) return "</li>";
      depth -= 1;
      return "</span></li>";
    }
    depth += 1;
    return `<li${attributes}>${open}`;
  });
}

function styleSenderBlocks(html: string): string {
  let out = applyBlockStyle(html, ["p"], "margin:0 0 16px 0");
  out = applyBlockStyle(out, ["ul", "ol"], "margin:0 0 18px 0;padding:0 0 0 20px");
  // 🔴 NO RULE UNDER A LIST ITEM. Owner 2026-09-12: "i am not happy with the list rules". A rule
  // under an item does not read as the paper's milestone row — the paper rules the FULL column and
  // the list is indented past the marker, so the rule lands under the text and reads as an
  // underline. What carries over from that row is the coloured tick, not the line.
  out = applyBlockStyle(out, ["li"], `margin:0 0 9px 0;padding:0;color:${HOUSE_COLORS.blue}`);
  out = inkListText(out);
  // THE CALLOUT, from the paper's opening band: hairlines above and below, a thick edge in the
  // brand's lightest stroke on the left, and the text on white. The tinted box every other mail
  // system reaches for is exactly the filled area THE INK RULE forbids.
  out = applyBlockStyle(
    out,
    ["blockquote"],
    `margin:0 0 18px 0;padding:13px 0 13px 16px;border-left:3px solid ${HOUSE_COLORS.light};` +
      `border-top:1px solid ${TABLE_GRID};border-bottom:1px solid ${TABLE_GRID};` +
      `color:${HOUSE_COLORS.body}`,
  );
  return out;
}

/**
 * THE SECTION DEVICE, the paper's strongest one: a rule across the column, and the heading set
 * UNDER it as one uppercase tracked line. The paper never sets a heading as large text — it sets it
 * as a label attached to a rule, which is why seven pages of different content read as one document.
 *
 * 🔴 IT MATCHES THE SANITIZER'S OUTPUT, NOT `<h2>`. `sanitizeEmailTemplateHtml` runs first and email
 * clients treat headings unevenly, so it rewrites every `<h1>`–`<h6>` into a `<p>` carrying
 * `font-size:NNpx;font-weight:bold` at the FRONT of the style attribute. That signature is the only
 * trace a heading leaves, so it is what this reads — h1, h2 and h3 (20/18/16px) only, because
 * h4–h6's sizes collide with a paragraph the sender merely emboldened.
 *
 * It runs LAST, after `styleSenderTables`, so the table scanner never sees the presentation table
 * this emits and stamp the sender's cell rules onto it.
 */
const SECTION_RANKS: Record<string, { label: number; leading: number; rule: number; space: number }> = {
  "16": { label: 11, leading: 16, rule: 1, space: 22 },
  "18": { label: 12, leading: 17, rule: 2, space: 26 },
  "20": { label: 13, leading: 18, rule: 2, space: 30 },
};

function sectionHeadings(html: string): string {
  return html.replace(
    /<p([^>]*?)\sstyle="font-size:(20|18|16)px;font-weight:bold([^"]*)"([^>]*)>([\s\S]*?)<\/p>/gi,
    (match, _before: string, size: string, _rest: string, _after: string, inner: string) => {
      const rank = SECTION_RANKS[size];
      if (!rank) return match;
      return (
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ' +
        `style="width:100%;border-collapse:collapse;${MSO_TABLE_RESET}">` +
        // Air above the rule. It cannot be padding on the rule's own cell: a border draws at the
        // OUTER edge of the padding box, so padding there moves the label and leaves the rule put.
        `<tr><td style="padding:${rank.space}px 0 0 0;font-size:0;line-height:0">&nbsp;</td></tr>` +
        `<tr><td style="border-top:${rank.rule}px solid ${HOUSE_COLORS.deep};font-size:0;line-height:0">&nbsp;</td></tr>` +
        `<tr><td dir="auto" style="padding:9px 0 15px 0;${MICRO};font-size:${rank.label}px;` +
        `line-height:${rank.leading}px;${MSO_EXACT_LEADING};color:${HOUSE_COLORS.deep}">${inner}</td></tr>` +
        "</table>"
      );
    },
  );
}

const TABLE_STYLE =
  `width:100%;border-collapse:collapse;${MSO_TABLE_RESET};margin:0 0 18px 0;` +
  `font-size:15px;line-height:22px;${MSO_EXACT_LEADING}`;
const CELL_BASE = `padding:8px 11px;border:1px solid ${TABLE_GRID};vertical-align:top`;
const HEAD_CELL =
  `${CELL_BASE};border-bottom:2px solid ${HOUSE_COLORS.blue};color:${HOUSE_COLORS.deep};` +
  "font-weight:bold;text-align:left";
const BODY_CELL = `${CELL_BASE};color:${HOUSE_COLORS.body}`;

/**
 * The house look on a table the sender built in the composer, stamped element by element.
 *
 * 🔴 THE ROW COUNTER IS THE WHOLE REASON THIS IS A SCANNER AND NOT A REGEX. The zebra is positional —
 * every second row that carries data — and the two mechanisms that express that cheaply are both
 * unavailable here: `:nth-child` needs a stylesheet email clients discard, and Word's engine would
 * ignore it even if one survived. So the rows are counted here and the tint is written onto the cells.
 *
 * A `<th>` is never striped and never counted: a header is not data, and a table whose head shares
 * the body's rhythm loses the thing a head is for. Cells the sender styled themselves keep their own
 * rules — the house declarations are written FIRST, so anything they set wins on the same property.
 */
function styleSenderTables(html: string): string {
  const frames: { rowIndex: number; rowHasData: boolean }[] = [];

  /**
   * 🔴 THE HOUSE OWNS THE GRID AND THE PADDING; THE SENDER OWNS THE INK.
   *
   * The house CSS is written FIRST and the sender's own style after it, so the ink he chose from
   * the toolbar — colour, weight, alignment — wins. (A fill never reaches here at all: the INK
   * RULE strips every one of those upstream, and the zebra below is the only ground in the
   * format.) That order is right for ink and wrong for the rule around a cell.
   * The composer stamps a border and a padding on every cell it draws — it has to, because the
   * Phoenix template manager shares that editor and nothing restamps ITS mail — and the assistant
   * copies the same markup out of the toolbox. Until 2026-09-23 that was `1px solid #cbd5e1`, and
   * being written last it quietly beat the house grid; being a SHORTHAND it also wiped the 2px blue
   * head rule underneath. Measured on a draft built from the incentive policy: every cell came out
   * slate and the head row lost its rule. Both stamps now carry the house values, so this filter
   * has nothing to correct on a fresh draft — it is what keeps an older body, or a table pasted in
   * from somewhere else, from overriding the format on its way out.
   *
   * Nothing in the toolbar sets a border or a padding, so dropping them here loses no choice
   * anybody made. Everything else the sender wrote survives, and still wins.
   */
  const houseOwned = /^(border|padding)(-[a-z-]+)?$/i;
  const senderOwn = (style: string): string =>
    style
      .split(";")
      .filter((declaration) => {
        const property = declaration.split(":")[0]?.trim() ?? "";
        return property !== "" && !houseOwned.test(property);
      })
      .join(";");

  /**
   * One declaration per property, the LAST one kept — which is the one a client honours anyway.
   *
   * This runs so the pass is IDEMPOTENT. A body that has already been through it carries the house
   * declarations itself, so the next pass writes them a second time: `color:#1A1A1A;color:#1A1A1A`.
   * Nothing renders differently, and it would have gone unnoticed for ever — except that an email
   * this composer produced is now uploaded straight back into it (the verbatim route), and without
   * this the markup grows by about 1.8 KB every time he does that, compounding on each round trip.
   *
   * Only identical property NAMES are collapsed, so a shorthand and a longhand — `border` and
   * `border-bottom` — both survive, in their own order.
   */
  const collapse = (style: string): string => {
    const declarations = style.split(";").map((declaration) => declaration.trim()).filter(Boolean);
    const property = (declaration: string) => (declaration.split(":")[0] ?? "").trim().toLowerCase();
    // The LAST value, in the FIRST position. The last value is the one a client honours; the first
    // position is the house's own order, so a body that goes round the loop a second time comes
    // back byte for byte rather than merely looking the same.
    const winner = new Map<string, string>();
    for (const declaration of declarations) winner.set(property(declaration), declaration);
    const written = new Set<string>();
    return declarations
      .map((declaration) => {
        const name = property(declaration);
        if (written.has(name)) return "";
        written.add(name);
        return winner.get(name) ?? declaration;
      })
      .filter(Boolean)
      .join(";");
  };

  const merge = (attributes: string, css: string): string => {
    const existing = /\sstyle\s*=\s*"([^"]*)"/i.exec(attributes);
    if (!existing) return `${attributes} style="${css}"`;
    const kept = senderOwn(existing[1]);
    return attributes.replace(existing[0], ` style="${collapse(kept ? `${css};${kept}` : css)}"`);
  };

  // The one hook the responsive sheet needs. A phone gives a four-column table about 340px, and at
  // the desk padding every cell wraps its own contents — so the cells are tagged here and the media
  // query tightens them. THE FITS-THE-SCREEN RULE: the answer is never a sideways scroll.
  const tagCell = (attributes: string): string => {
    // This tag never collects the class twice on a second pass, unlike the styles above: the
    // sanitizer drops `class` from every cell before this runs, so what arrives here is always
    // bare. The branch below is for a cell that was never sanitised — a caller's own markup.
    const existing = /\sclass\s*=\s*"([^"]*)"/i.exec(attributes);
    if (!existing) return `${attributes} class="sato-cell"`;
    return attributes.replace(existing[0], ` class="sato-cell ${existing[1]}"`);
  };

  return html.replace(
    /<(\/?)(table|tr|th|td)((?:\s[^>]*)?)>/gi,
    (match, closing: string, rawTag: string, attributes: string) => {
      const tag = rawTag.toLowerCase();
      const isClosing = closing === "/";

      if (tag === "table") {
        if (isClosing) {
          frames.pop();
          return match;
        }
        frames.push({ rowHasData: false, rowIndex: 0 });
        return `<table${merge(attributes, TABLE_STYLE)}>`;
      }

      const frame = frames[frames.length - 1];
      if (!frame) return match;

      if (tag === "tr") {
        if (isClosing) {
          if (frame.rowHasData) frame.rowIndex += 1;
          frame.rowHasData = false;
        }
        return match;
      }

      if (isClosing) return match;
      if (tag === "th") return `<th${tagCell(merge(attributes, HEAD_CELL))}>`;

      // The first `<td>` of a row is what makes it a data row, so the stripe is decided here rather
      // than at `<tr>`, where a header row and a data row are still indistinguishable.
      const zebra = frame.rowIndex % 2 === 1;
      frame.rowHasData = true;
      return `<td${tagCell(merge(attributes, zebra ? `${BODY_CELL};background:${HOUSE_COLORS.tint}` : BODY_CELL))}>`;
    },
  );
}

/**
 * 🔴 THE LAST PASS IS A SANITIZER, BECAUSE THE REWRITES ABOVE ARE REGEXES OVER A STRING.
 *
 * `sanitizeEmailTemplateHtml` runs first, and everything after it edits its SERIALISED output with
 * regular expressions that cannot tell an attribute value from text. That let a body restore an
 * event handler: `stripFills` removes ` bgcolor='…'` wherever it appears — including from the middle
 * of a `title` attribute up to a quote in the following text — so the text after it became live
 * attributes again (`<span title="q" onmouseover="…">`). Technical audit 23 Oct 2026, P7-02. The
 * same string is the composer's preview (`dangerouslySetInnerHTML`) and the email that is sent.
 *
 * So the finished body is parsed once more and re-serialised against an allow-list. This pass only
 * REMOVES: the tags are the first pass's tags, the attributes are the first pass's plus the three the
 * house stamps itself (`class` for the phone sheet, `role` and the table spacing attributes), and
 * the styles are kept VERBATIM (`parseStyleAttributes: false`) — they were filtered by the first pass
 * or written by this file, and re-parsing them would reformat the house CSS. Entities are left as
 * they are (`decodeEntities: false`), so the house `&nbsp;` spacer cells survive byte for byte; every
 * entity in the sender's part was already decoded and re-escaped by the first pass.
 */
const FINAL_PASS_ATTRIBUTES = ["style", "dir", "class"];

function sanitizeFinishedBody(html: string): string {
  return sanitizeHtml(html, {
    allowedAttributes: {
      "*": FINAL_PASS_ATTRIBUTES,
      a: ["href", "rel", "target", "title", ...FINAL_PASS_ATTRIBUTES],
      img: ["src", "alt", "width", "height", ...FINAL_PASS_ATTRIBUTES],
      span: ["title", ...FINAL_PASS_ATTRIBUTES],
      table: ["role", "width", "cellpadding", "cellspacing", "border", ...FINAL_PASS_ATTRIBUTES],
      td: ["colspan", "rowspan", "bgcolor", ...FINAL_PASS_ATTRIBUTES],
      th: ["colspan", "rowspan", "bgcolor", ...FINAL_PASS_ATTRIBUTES],
      tr: ["bgcolor", ...FINAL_PASS_ATTRIBUTES],
    },
    allowedSchemes: ["http", "https", "mailto", "tel"],
    allowedSchemesByTag: { img: ["https"] },
    allowProtocolRelative: false,
    allowedTags: [
      "a", "b", "blockquote", "br", "em", "hr", "i", "img", "li", "ol", "p", "s", "span",
      "strong", "table", "tbody", "td", "th", "thead", "tr", "u", "ul",
    ],
    disallowedTagsMode: "discard",
    enforceHtmlBoundary: true,
    parseStyleAttributes: false,
    parser: { decodeEntities: false },
  });
}

export function prepareSatoEmailBody(bodyHtml: string): string {
  const safe = dropEmptyStyles(stripFills(sanitizeEmailTemplateHtml(bodyHtml)));
  return sanitizeFinishedBody(sectionHeadings(styleSenderTables(styleSenderBlocks(directionPerBlock(safe)))));
}

export function satoEmailHtmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/(p|li|tr|blockquote|ul|ol)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The line the inbox shows beside the subject.
 *
 * Left empty, a client fills it with whatever markup it reaches first — which here is the alt text
 * of the mark, so every announcement in the list previewed as "Sato Pharma". This puts the opening
 * words of the actual message there instead. Hidden in the body itself by the usual four-property
 * combination; the trailing spacer stops a client padding it with the text that follows.
 */
function preheader(bodyText: string): string {
  const opening = bodyText.replace(/\s+/g, " ").trim().slice(0, 140);
  if (!opening) return "";
  return (
    '<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#ffffff">' +
    `${escapeHtml(opening)}${"&#847;&zwnj;&nbsp;".repeat(24)}</div>`
  );
}

function logoBaseUrl(): string {
  const configured = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || systemDeployment.productionUrl;
  return /^https?:\/\//i.test(configured) ? configured : `https://${configured}`;
}

export type SatoEmailContent = {
  subject: string;
  bodyHtml: string;
  signOff: string;
  /**
   * What this notice is, in the masthead's label line. Defaults to "Company announcement" — the
   * composer's own. A one-to-one notice (an interview invitation) names itself instead.
   */
  kicker?: string;
  /** The line under the colophon. Defaults to the distribution-list note, which is wrong for a one-to-one mail. */
  footnote?: string;
};

export function renderSatoEmail(content: SatoEmailContent): { html: string; text: string } {
  const subject = content.subject.trim();
  const signOff = content.signOff.trim();
  const kicker = content.kicker?.trim() || DOCUMENT_KICKER;
  const footnote = content.footnote?.trim() || DEFAULT_FOOTNOTE;
  const body = prepareSatoEmailBody(content.bodyHtml);
  const bodyText = satoEmailHtmlToText(body);
  const logo = satoLogoUrl(logoBaseUrl());
  const band = `${logoBaseUrl().replace(/\/+$/, "")}${BAND_PUBLIC_PATH}`;

  const hairline = (color: string, space: string) =>
    `<tr><td style="padding:${space};font-size:0;line-height:0">` +
    `<div style="border-top:1px solid ${color};font-size:0;line-height:0">&nbsp;</div></td></tr>`;

  // The masthead, in the paper's arrangement: the mark on one side, and on the other TWO
  // right-aligned micro lines — what this is, then the standard that issued it — with the brand rule
  // drawn under both. Owner 2026-09-12, sending the journey paper as the reference.
  //
  // 🔴 THE COMPANY NAME IS NOT REPEATED HERE. It used to sit beside the mark, typeset, saying what
  // the mark already says; the paper puts the reference there instead and states the legal person
  // ONCE, in the provenance foot, where a document names its issuer. That also retires the separate
  // reference row this head used to need — one relationship instead of two stacked ones.
  const masthead =
    '<tr><td style="padding:0 0 18px 0">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ' +
    `style="width:100%;border-collapse:collapse;${MSO_TABLE_RESET}">` +
    '<tr><td align="left" valign="bottom" style="padding:0">' +
    `<img src="${escapeHtml(logo)}" width="${LOGO_WIDTH}" alt="${escapeHtml(COMPANY_NAME)}" ` +
    `style="display:block;width:${LOGO_WIDTH}px;height:auto;border:0"></td>` +
    '<td align="right" valign="bottom" style="padding:0 0 2px 0">' +
    `<div dir="ltr" class="sato-kicker" style="${MICRO};letter-spacing:2.2px;` +
    `color:${HOUSE_COLORS.light}">${escapeHtml(kicker)}</div>` +
    // Set in the mono face, because a file reference is a number and reads as one: it is the only
    // line in the document that is not the house text face, and that is what marks it as a stamp.
    '<div dir="ltr" class="sato-std" style="padding-top:5px;' +
    `font-family:${MONO_STACK};font-size:10px;line-height:15px;letter-spacing:0.4px;` +
    `color:${HOUSE_COLORS.muted}">${DOCUMENT_STANDARD}</div>` +
    "</td></tr></table></td></tr>";

  // `lh__rule` — the brand rule the whole letterhead hangs from. It is INK, not the band image, so a
  // reader with images blocked still gets a letterhead rather than a masthead floating over text.
  const brandRule = `<tr><td style="border-top:2px solid ${HOUSE_COLORS.blue};font-size:0;line-height:0">&nbsp;</td></tr>`;

  // `lh__title` then `lh__hair`: the paper sets the title against the rule above and closes the
  // block with a hairline, so the body opens on its own rather than running straight out of the head.
  const titleBlock =
    `<tr><td dir="auto" class="sato-title" style="padding:24px 0 20px 0;font-family:${FONT_STACK};` +
    `font-size:25px;line-height:33px;letter-spacing:-0.3px;font-weight:bold;${MSO_EXACT_LEADING};` +
    `color:${HOUSE_COLORS.deep}">${escapeHtml(subject)}</td></tr>` +
    hairline(HOUSE_COLORS.hair, "0");

  const signOffRow = signOff
    ? `<tr><td dir="auto" style="padding:22px 0 0 0;font-size:16px;line-height:26px;color:${HOUSE_COLORS.body}">` +
      `Regards,<br><strong style="color:${HOUSE_COLORS.deep}">${escapeHtml(signOff)}</strong></td></tr>`
    : "";

  // THE PROVENANCE BLOCK, from the paper's last page: a micro label over the value it names, in
  // columns. It answers the two questions a company document has to answer about itself — who
  // issued it, and under what standard — and it answers them in the label voice the whole document
  // is set in, rather than as a paragraph of small print.
  const provenance = (label: string, value: string, align: "left" | "right") =>
    `<td align="${align}" valign="top" class="sato-prov" style="padding:0">` +
    `<div dir="ltr" style="${MICRO};font-size:9px;line-height:13px;letter-spacing:1.4px;` +
    `color:${HOUSE_COLORS.muted}">${escapeHtml(label)}</div>${value}</td>`;

  const footer =
    hairline(HOUSE_COLORS.hair, "34px 0 0 0") +
    '<tr><td style="padding:15px 0 0 0">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ' +
    `style="width:100%;border-collapse:collapse;${MSO_TABLE_RESET}"><tr>` +
    provenance(
      "Issued by",
      `<div dir="ltr" style="padding-top:6px;font-size:12px;line-height:18px;font-weight:bold;` +
        `color:${HOUSE_COLORS.deep}">${escapeHtml(COMPANY_NAME)}</div>` +
        // `dir` decides which way the RUN reads; alignment is a separate question and the block
        // answers it. Without the explicit `text-align`, the Arabic name is flung to the far edge
        // while the English name it belongs with stays at the margin, and the pair reads broken.
        '<div dir="rtl" lang="ar" style="text-align:left;font-size:12px;line-height:18px;' +
        `color:${HOUSE_COLORS.muted}">${escapeHtml(COMPANY_NAME_AR)}</div>`,
      "left",
    ) +
    provenance(
      "Reference",
      `<div dir="ltr" style="padding-top:6px;font-family:${MONO_STACK};font-size:12px;` +
        `line-height:18px;color:${HOUSE_COLORS.body}">${DOCUMENT_STANDARD}</div>`,
      "right",
    ) +
    "</tr></table></td></tr>" +
    // THE COLOPHON: a SHORT centred hairline — a third of the column, not the full width — and one
    // centred micro line under it. The paper closes on it, and the shortness is the whole device:
    // a full-width rule here would read as another section starting.
    '<tr><td align="center" style="padding:26px 0 0 0">' +
    '<table role="presentation" width="180" cellpadding="0" cellspacing="0" border="0" ' +
    `style="width:180px;border-collapse:collapse;${MSO_TABLE_RESET}">` +
    `<tr><td style="border-top:1px solid ${HOUSE_COLORS.hair};font-size:0;line-height:0">&nbsp;</td></tr>` +
    "</table></td></tr>" +
    '<tr><td align="center" style="padding:12px 0 0 0">' +
    `<div dir="ltr" style="font-size:10px;line-height:17px;letter-spacing:0.4px;color:${HOUSE_COLORS.muted}">` +
    `${escapeHtml(footnote)}</div></td></tr>`;

  // Everything inside the frame, in the paper's order.
  const documentBlock =
    '<tr><td class="sato-pad" style="padding:30px 34px 30px 34px">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ' +
    `style="width:100%;border-collapse:collapse;${MSO_TABLE_RESET}">` +
    masthead +
    brandRule +
    titleBlock +
    // `sato-message` marks the sender's own words inside the house frame. Nothing styles it — it is
    // a NAME, for the one job of finding this cell again: an email this composer produced is
    // routinely uploaded back into it, and the frame around it has to be taken off before the
    // renderer puts a fresh one on, or the reader gets two mastheads and two colophons nested one
    // inside the other. `unwrapSatoEmailFrame` looks for this class first (source-document.ts).
    `<tr><td class="sato-message" style="padding:22px 0 0 0;font-size:16px;line-height:27px;` +
    `${MSO_EXACT_LEADING};color:${HOUSE_COLORS.body}">${body}</td></tr>` +
    signOffRow +
    footer +
    "</table></td></tr>";

  // The only stylesheet in the message, and nothing depends on it: a client that discards it gets the
  // 640 px layout it would have got anyway. It exists so a phone gets the gutter back.
  const responsiveCss =
    "@media only screen and (max-width:620px){" +
    ".sato-shell{padding:20px 12px !important}" +
    ".sato-pad{padding:22px 18px !important}" +
    ".sato-title{font-size:21px !important;line-height:29px !important}" +
    ".sato-kicker{letter-spacing:1.4px !important}" +
    ".sato-std{letter-spacing:0 !important}" +
    // The provenance columns stack on a phone rather than squeezing. A `td` taken to `display:block`
    // is the one layout move mobile clients agree on, and the `!important` beats the `align`
    // attribute — a presentational hint, which loses to any author rule.
    ".sato-prov{display:block !important;width:100% !important;text-align:left !important;" +
    "padding:0 0 14px 0 !important}" +
    ".sato-cell{padding:6px 7px !important;font-size:14px !important;line-height:20px !important}}";

  const html =
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="color-scheme" content="light only">' +
    '<meta name="supported-color-schemes" content="light">' +
    `<title>${escapeHtml(subject)}</title>` +
    `<style>${responsiveCss}</style></head>` +
    '<body style="margin:0;padding:0;background:#ffffff;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%">' +
    preheader(bodyText) +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ' +
    `style="width:100%;border-collapse:collapse;${MSO_TABLE_RESET};background:#ffffff">` +
    '<tr><td align="center" class="sato-shell" style="padding:36px 24px">' +
    `<table role="presentation" width="${MAX_WIDTH}" cellpadding="0" cellspacing="0" border="0" ` +
    `style="width:100%;max-width:${MAX_WIDTH}px;border-collapse:collapse;${MSO_TABLE_RESET};` +
    `font-family:${FONT_STACK};color:${HOUSE_COLORS.body}">` +
    // The frame carries its border on the CELL rather than on the `<table>` element, because Word's
    // engine honours a cell border reliably and a table border only sometimes.
    `<tr><td style="padding:0;border:1px solid ${HOUSE_COLORS.hair}">` +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ' +
    `style="width:100%;border-collapse:collapse;${MSO_TABLE_RESET}">` +
    // The ornament, flush inside the top edge. Ornament only — see the header note.
    '<tr><td style="padding:0;font-size:0;line-height:0">' +
    `<img src="${escapeHtml(band)}" width="${MAX_WIDTH}" alt="" ` +
    `style="display:block;width:100%;max-width:${MAX_WIDTH}px;height:auto;border:0"></td></tr>` +
    documentBlock +
    // The foot rule, flush against the frame's own bottom edge: the double line engraved stationery
    // closes with, and the counterweight to the band at the head.
    `<tr><td style="border-top:2px solid ${HOUSE_COLORS.deep};font-size:0;line-height:0">&nbsp;</td></tr>` +
    "</table></td></tr></table></td></tr></table></body></html>";

  const textParts = [subject, bodyText];
  if (signOff) textParts.push(`Regards,\n${signOff}`);
  textParts.push(`--\n${COMPANY_NAME}\n${DOCUMENT_STANDARD}`);

  return { html, text: textParts.filter(Boolean).join("\n\n") };
}
