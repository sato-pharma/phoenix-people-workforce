/**
 * The offer letter's PROSE, converted between what a person edits and what is stored.
 *
 * ── Why this exists ──
 * Every word of the letter was already editable — but the paragraphs were editable only as raw
 * HTML in a textarea. To change one word of the greeting somebody had to find it inside
 * `<p class='lead'>Dear <strong>{{salutationName}}</strong>,</p>`, past the entities and the tags,
 * and a single mistyped bracket silently broke the letter for whoever it was next sent to. The
 * owner's ask — "any single letter I want to be able to edit in it" — is not satisfied by a box
 * that requires you to know HTML first.
 *
 * So the designer now edits prose on a canvas that looks like the letter, and this module is the
 * boundary that makes that safe: chips in, tokens out; toolbar markup in, a known-good tag set out.
 *
 * ── Why regex and not the DOM ──
 * Deliberately pure string work, no `DOMParser`, for two reasons. It runs identically on the server
 * and in a unit test, which is what lets `tests/offer-rich-text.test.ts` pin the round trip; and the
 * markup it has to understand is not arbitrary web HTML — it is what THIS editor's own toolbar
 * produces, because the canvas forces every paste through plain text. Wild markup never arrives.
 *
 * ── The one rule ──
 * Stored prose may only use tags that BOTH renderers can draw. `render.ts` emits the HTML
 * unchanged into a print stylesheet, and `render-email.ts` re-emits it through `safeRichText` into
 * Outlook-safe markup. A tag only one of them handles is a silent divergence between the PDF a
 * candidate signs and the email they read it in, which is precisely the class of defect nobody
 * notices until a candidate asks about it. The two lists below and `safeRichText` are one decision,
 * and `tests/offer-rich-text.test.ts` asserts they agree.
 */

/** Block-level tags allowed in stored prose. */
export const OFFER_PROSE_BLOCK_TAGS: readonly string[] = ["p", "ul", "ol", "li"];

/** Inline tags allowed in stored prose. */
export const OFFER_PROSE_INLINE_TAGS: readonly string[] = ["strong", "em", "u", "a", "br", "span"];

const ALLOWED_TAGS: ReadonlySet<string> = new Set([...OFFER_PROSE_BLOCK_TAGS, ...OFFER_PROSE_INLINE_TAGS]);

/** Void tags never carry a closing partner, so they must not be re-emitted with one. */
const VOID_TAGS: ReadonlySet<string> = new Set(["br"]);

/**
 * Tags the browser emits for a toolbar command, mapped to the one this module stores.
 *
 * `execCommand` is inconsistent across engines and versions — the same Bold button yields `<b>` in
 * one and `<strong>` in another. Normalising here means the stored letter reads the same whoever
 * typed it, and means a template diff shows a real edit rather than a change of browser.
 */
const TAG_ALIASES: Record<string, string> = {
  b: "strong",
  div: "p",
  i: "em",
  strike: "s",
  // `s` and `s`-like emphasis are not in the allow-list; they fall through to being unwrapped,
  // which keeps the words and drops the styling rather than losing the sentence.
};

const TOKEN_PATTERN = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/** The class the chip carries. Also the hook the canvas stylesheet paints it with. */
export const OFFER_TOKEN_CHIP_CLASS = "phx-offer-token";

export function escapeOfferHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * One `{{token}}`, drawn as the non-editable chip the canvas shows in its place.
 *
 * `contenteditable="false"` is what makes it behave like a single character: the caret steps over
 * it and Backspace removes the whole placeholder. Without it somebody deletes the closing brace of
 * `{{salutationName}}`, the letter prints `{{salutationName}` verbatim to a candidate, and nothing
 * on the way out flags it — `fillOfferTokens` leaves an unrecognised token standing on purpose.
 */
export function offerTokenChipHtml(token: string, label: string): string {
  const safeToken = token.replace(/[^a-zA-Z0-9_]/g, "");
  return (
    `<span class="${OFFER_TOKEN_CHIP_CLASS}" contenteditable="false" data-token="${safeToken}"` +
    ` title="Filled in from the offer when the letter is sent">${escapeOfferHtml(label)}</span>`
  );
}

/**
 * Split HTML into alternating text and tag pieces.
 *
 * Even indices are text, odd indices are tags. Everything below walks this rather than the raw
 * string, so a `{{token}}` sitting inside an attribute — `href="{{ctaUrl}}"` — is never mistaken
 * for one in the prose and turned into a chip that would break the attribute.
 */
function splitTags(html: string): string[] {
  return html.split(/(<[^>]*>)/);
}

/** Stored prose → canvas HTML: every `{{token}}` in the TEXT becomes a chip. */
export function offerStoredToEditorHtml(html: string, labels: ReadonlyMap<string, string>): string {
  return splitTags(html)
    .map((piece, index) => {
      if (index % 2 === 1) return piece;
      return piece.replace(TOKEN_PATTERN, (_match, token: string) =>
        offerTokenChipHtml(token, labels.get(token) ?? token),
      );
    })
    .join("");
}

/** Read one attribute off a raw tag string, either quote style. */
function attributeOf(tag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(tag);
  if (!match) return null;
  return match[2] ?? match[3] ?? "";
}

/**
 * A `style` attribute, kept as written minus anything that could break out of it.
 *
 * Deliberately NOT a list of approved properties. An allow-list drops whatever it has not heard of,
 * and dropping is the failure mode this whole module exists to prevent: the shipped classic letter
 * spaces one paragraph with `style="margin-top:12px"`, so a property allow-list that had not
 * thought of `margin-top` would have silently reflowed that letter the first time somebody opened
 * the block and clicked away. Templates already in the field can hold anything, and none of it is
 * dangerous — this is HR-authored content rendered into a PDF, not user input rendered into a page.
 *
 * What IS refused is the small set that stops a declaration being a declaration: quotes and angle
 * brackets, which would close the attribute, and `url(` / `expression(`, which fetch or execute.
 * Refusing a declaration is safer than refusing the whole attribute, because losing one property is
 * a visible nudge in the layout and losing all of them is the silent rewrite again.
 */
export function safeOfferStyle(style: string): string | null {
  const kept = style
    .split(";")
    .map((declaration) => declaration.trim())
    .filter((declaration) => {
      if (declaration === "" || !declaration.includes(":")) return false;
      if (/["'<>]/.test(declaration)) return false;
      if (/\b(url|expression|image-set)\s*\(/i.test(declaration)) return false;
      return /^[a-zA-Z-]+\s*:/.test(declaration);
    });

  return kept.length > 0 ? kept.join(";") : null;
}

/** A link target the letter may carry. Anything else loses the link and keeps the words. */
function safeHref(href: string): string | null {
  const trimmed = href.trim();
  if (/^(https?:\/\/|mailto:)/i.test(trimmed)) return trimmed.replace(/"/g, "&quot;");
  return null;
}

/**
 * Rebuild one opening tag with only the attributes the letter is allowed to store.
 *
 * Returns null when the tag itself is not allowed, which the caller reads as "unwrap" — drop the
 * tag and keep the words inside it. Losing a style is recoverable; losing a sentence out of a job
 * offer is not.
 */
function rebuildOpenTag(name: string, raw: string): string | null {
  if (!ALLOWED_TAGS.has(name)) return null;

  // `class` is load-bearing: the greeting is `<p class="lead">`, and both stylesheets size it from
  // that class. Stripping it the way a generic sanitiser would silently reflows the letter.
  const className = (attributeOf(raw, "class") ?? "").trim().replace(/[^A-Za-z0-9_ -]/g, "");
  const style = safeOfferStyle(attributeOf(raw, "style") ?? "");
  const attributes =
    (className ? ` class="${className}"` : "") + (style ? ` style="${style}"` : "");

  if (name === "p" || name === "li" || name === "ul" || name === "ol") {
    return `<${name}${attributes}>`;
  }

  if (name === "a") {
    const href = safeHref(attributeOf(raw, "href") ?? "");
    return href ? `<a href="${href}"${attributes}>` : null;
  }

  if (name === "span") {
    // A span carrying nothing at all is not worth storing — unwrap it, so the Source view stays
    // something a person can still read rather than a thicket of empty tags left by the browser.
    return attributes ? `<span${attributes}>` : null;
  }

  return `<${name}${attributes}>`;
}

/**
 * Canvas HTML → stored prose.
 *
 * Chips collapse back to `{{tokens}}`, browser-specific markup is normalised, and every tag the
 * two renderers cannot both draw is unwrapped rather than deleted.
 */
export function offerEditorToStoredHtml(html: string): string {
  // Chips first, and as whole elements — after this there are no `data-token` spans left, so the
  // span handling below never has to tell a placeholder from a colour.
  const withTokens = html
    .replace(
      /<span\b[^>]*\bdata-token\s*=\s*["']([a-zA-Z0-9_]+)["'][^>]*>[\s\S]*?<\/span>/gi,
      (_match, token: string) => `{{${token}}}`,
    )
    // `<font>` is what a browser emits for a colour when `styleWithCSS` could not be switched on.
    // It is not in the allow-list, so without this the colour somebody picked would be dropped
    // along with the tag — and dropping is the one outcome this module exists to prevent.
    .replace(/<font\b([^>]*)>/gi, (_match, attributes: string) => {
      const colour = /\scolor\s*=\s*("([^"]*)"|'([^']*)')/i.exec(attributes);
      const value = (colour?.[2] ?? colour?.[3] ?? "").trim();
      return value && !/["'<>;]/.test(value) ? `<span style="color:${value}">` : "<span>";
    })
    .replace(/<\/font>/gi, "</span>");

  const pieces = splitTags(withTokens).map((piece, index) => {
    if (index % 2 === 0) return piece;

    const tag = piece;
    const closing = /^<\s*\//.test(tag);
    const nameMatch = /^<\s*\/?\s*([a-zA-Z0-9]+)/.exec(tag);
    if (!nameMatch) return "";

    const raw = nameMatch[1].toLowerCase();
    const name = TAG_ALIASES[raw] ?? raw;

    if (closing) return ALLOWED_TAGS.has(name) && !VOID_TAGS.has(name) ? `</${name}>` : "";
    if (VOID_TAGS.has(name)) return ALLOWED_TAGS.has(name) ? `<${name}>` : "";

    const rebuilt = rebuildOpenTag(name, tag);
    if (rebuilt === null) return "";
    // A self-closed non-void tag from the browser would leave an orphan `</p>` if re-emitted as an
    // opener, so it is dropped whole — the words are in the text pieces either side regardless.
    return /\/\s*>$/.test(tag) ? "" : rebuilt;
  });

  return tidyProse(pieces.join(""));
}

/**
 * An unwrapped tag can leave its closing partner behind, so the pass above is followed by one that
 * discards orphans. Done as a stack rather than another regex because `</span>` after an unwrapped
 * `<span>` and `</span>` after a kept one are the same six characters.
 */
function tidyProse(html: string): string {
  const open: string[] = [];
  const out: string[] = [];

  for (const [index, piece] of splitTags(html).entries()) {
    if (index % 2 === 0) {
      out.push(piece);
      continue;
    }
    const nameMatch = /^<\s*(\/?)\s*([a-zA-Z0-9]+)/.exec(piece);
    if (!nameMatch) continue;
    const [, slash, name] = nameMatch;

    if (slash) {
      const at = open.lastIndexOf(name);
      if (at === -1) continue;
      open.splice(at, 1);
      out.push(piece);
      continue;
    }
    if (!VOID_TAGS.has(name)) open.push(name);
    out.push(piece);
  }

  // Anything still open closes at the end, innermost first, so the stored string is well formed
  // even if the canvas handed over something that was not.
  for (const name of [...open].reverse()) out.push(`</${name}>`);

  return (
    out
      .join("")
      // Chrome turns a paragraph into a list by putting the list INSIDE the paragraph —
      // `<p><ul><li>…</li></ul></p>`, which is not valid HTML and which every renderer then
      // repairs its own way. Unwrapping it here means the stored letter is the same document
      // wherever it is drawn, rather than one that depends on whose parser is reading it.
      .replace(/<p\b[^>]*>\s*(<(?:ul|ol)\b[\s\S]*?<\/(?:ul|ol)>)\s*<\/p>/gi, "$1")
      .replace(/<p>\s*<\/p>/gi, "")
      .trim()
  );
}

/**
 * Is there any actual writing here?
 *
 * Used to tell an empty canvas from one holding `<p><br></p>`, which is what a browser leaves
 * behind when somebody selects everything and deletes it.
 */
export function offerProseIsEmpty(html: string): boolean {
  return (
    html
      .replace(/<[^>]*>/g, "")
      .replace(/&nbsp;/g, " ")
      .trim() === ""
  );
}
