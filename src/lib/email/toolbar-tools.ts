/**
 * The email editor's toolbox, described once.
 *
 * Owner request 2026-09-12: "ADD A TOOLBOX EXACTLY LIKE THE ONE IN THE EMAIL COMPOSER TO FEEL
 * LIKE USING GMAIL OR OUTLOOK AND TRAIN THE AI TOOL ON IT IN WHICH IT UNDERSTANDS WHAT I WANT
 * AND CAN USE EVERY TOOL."
 *
 * The toolbar buttons live in `src/components/admin/email-body-editor.tsx`, in the browser. The
 * rewrite model lives on the server and has no toolbar to press — the only way it can "use a
 * tool" is to emit the markup that tool produces. This file is that translation, and it is what
 * stops the two halves drifting apart: `tests/sato-email-toolbox.test.ts` reads the editor's own
 * source, extracts every control it renders, and fails if one of them is missing here. Add a
 * button to the toolbar and the test tells you to teach the AI about it.
 *
 * `markup` is not a suggestion. It is what `sanitizeEmailTemplateHtml` in
 * `src/lib/email/email-safety.ts` actually keeps — a declaration outside that allowlist is
 * dropped in silence, so a tool taught with the wrong markup would look to the sender like the
 * model ignoring him. `survivesAs` pins that: the test sanitizes every `markup` and asserts the
 * result still contains it.
 */

export type EmailToolbarTool = {
  /**
   * How a sender asks for this in his own words, typed into the composer's nudge box. These are
   * the phrases the model is told to recognise, so they are deliberately plain.
   */
  asks: readonly string[];
  /** The toolbar control's own label — exactly as its title/aria-label reads on screen. */
  label: string;
  /**
   * The markup the model must emit to press this button, or `null` for a control that produces
   * no markup of its own (undo, redo, clearing formatting, the hidden action button). A `null`
   * tool is still listed so the coverage test can see it was considered, not forgotten.
   */
  markup: string | null;
  /** Why this tool exists or when not to reach for it. Passed to the model with the tool. */
  note?: string;
  /**
   * A substring that must still be present after `markup` goes through the email sanitizer.
   * Usually the tag or the style declaration itself; for a heading it is what the sanitizer
   * rewrites the tag INTO, which is the whole reason this field is not inferred.
   */
  survivesAs?: string;
};

/** Ordered as the toolbar reads, left to right, so the prompt and the screen tell one story. */
export const EMAIL_TOOLBAR_TOOLS: readonly EmailToolbarTool[] = [
  {
    asks: ["use Tahoma", "change the font", "a font that reads well in Arabic"],
    label: "Font",
    markup: `<span style="font-family: Tahoma">text</span>`,
    survivesAs: "font-family",
  },
  {
    asks: ["make it bigger", "make this line small", "huge text"],
    label: "Font size",
    markup: `<span style="font-size: large">text</span>`,
    note: "keywords only — small, medium, large, x-large, xx-large",
    survivesAs: "font-size",
  },
  {
    asks: ["make this a heading", "give it a section title"],
    label: "Heading",
    markup: `<h2>Section name</h2>`,
    note: "becomes the house section heading: a rule across the page with a small uppercase label",
    survivesAs: "font-size:18px",
  },
  {
    asks: ["a smaller heading", "a sub-heading"],
    label: "Sub-heading",
    markup: `<h3>Sub-section name</h3>`,
    survivesAs: "font-size:16px",
  },
  {
    asks: ["more space between the lines", "tighten it up"],
    label: "Line spacing",
    markup: `<p style="line-height: 1.75">text</p>`,
    survivesAs: "line-height",
  },
  {
    asks: ["space the letters out"],
    label: "Letter spacing",
    markup: `<p style="letter-spacing: 1px">text</p>`,
    survivesAs: "letter-spacing",
  },
  {
    asks: ["make it Arabic", "right to left", "this paragraph is Arabic"],
    label: "Right-to-left paragraph (Arabic)",
    markup: `<p dir="rtl">text</p>`,
    note: "set it on every Arabic paragraph, list and table, never once around the whole body",
    survivesAs: `dir="rtl"`,
  },
  {
    asks: ["back to English", "left to right"],
    label: "Left-to-right paragraph (English)",
    markup: `<p dir="ltr">text</p>`,
    survivesAs: `dir="ltr"`,
  },
  {
    asks: ["make it red", "colour the deadline"],
    label: "Text color",
    markup: `<span style="color: #B91C1C">text</span>`,
    survivesAs: "color",
  },
  {
    asks: ["highlight the date", "put a marker on it"],
    label: "Highlight color",
    markup: `<span style="background-color: #FDE68A">text</span>`,
    survivesAs: "background-color",
  },
  {
    asks: ["bold the deadline", "make the date stand out", "emphasise it"],
    label: "Bold",
    markup: `<strong>text</strong>`,
    survivesAs: "<strong>",
  },
  { asks: ["italics", "in italic"], label: "Italic", markup: `<em>text</em>`, survivesAs: "<em>" },
  { asks: ["underline it"], label: "Underline", markup: `<u>text</u>`, survivesAs: "<u>" },
  {
    asks: ["strike it through", "show it as cancelled"],
    label: "Strikethrough",
    markup: `<s>text</s>`,
    survivesAs: "<s>",
  },
  {
    asks: ["make it a list", "bullet points", "one per line"],
    label: "Bulleted list",
    markup: `<ul><li>item</li></ul>`,
    note: "one idea per item, no full stop at the end of an item",
    survivesAs: "<li>",
  },
  {
    asks: ["number the steps", "a numbered list"],
    label: "Numbered list",
    markup: `<ol><li>item</li></ol>`,
    survivesAs: "<ol>",
  },
  {
    asks: ["align it left"],
    label: "Align left",
    markup: `<p style="text-align: left">text</p>`,
    survivesAs: "text-align",
  },
  {
    asks: ["centre it", "center the heading"],
    label: "Align center",
    markup: `<p style="text-align: center">text</p>`,
    survivesAs: "text-align",
  },
  {
    asks: ["align it right", "right-align the Arabic"],
    label: "Align right",
    markup: `<p style="text-align: right">text</p>`,
    survivesAs: "text-align",
  },
  {
    asks: ["quote the policy", "set that apart"],
    label: "Quote",
    markup: `<blockquote>quoted text</blockquote>`,
    survivesAs: "<blockquote>",
  },
  {
    asks: ["link the portal", "make that a link"],
    label: "Link",
    markup: `<a href="https://phoenix-hr.satopharma.com/portal">text</a>`,
    note: "only an address the sender already wrote — a link you mint is refused",
    survivesAs: "href",
  },
  { asks: ["remove the link", "take the link off"], label: "Remove link", markup: null },
  {
    // Hidden in both composers today via hiddenActions, because {{ctaUrl}} has nothing to
    // resolve against there. Listed so the coverage test still sees it if it is ever shown.
    asks: ["insert the action button"],
    label: "Action button",
    markup: null,
  },
  {
    asks: ["put the dates in a table", "show it as a table", "a row per branch"],
    label: "Insert table",
    markup:
      `<table style="border-collapse: collapse; width: 100%"><tbody>` +
      `<tr><th style="border: 1px solid #cbd5e1; padding: 8px; text-align: left">Column</th></tr>` +
      `<tr><td style="border: 1px solid #cbd5e1; padding: 8px">Cell</td></tr></tbody></table>`,
    note: "only when the draft already has something with two dimensions; never an empty cell",
    survivesAs: "<td",
  },
  {
    asks: ["add the picture", "put the poster in"],
    label: "Insert image",
    markup: `<img src="https://phoenix-hr.satopharma.com/poster.png" alt="" style="max-width: 100%" />`,
    note: "only an image address the sender already wrote",
    survivesAs: "<img",
  },
  {
    asks: ["put a line between the sections", "separate them"],
    label: "Divider line",
    markup: `<hr />`,
    survivesAs: "<hr",
  },
  { asks: ["strip the formatting", "make it plain"], label: "Clear formatting", markup: null },
  { asks: ["undo that"], label: "Undo", markup: null },
  { asks: ["redo that"], label: "Redo", markup: null },
];

/**
 * The toolbox as the rewrite prompt states it. Only the tools that produce markup appear — the
 * model cannot press Undo, and listing it would invite it to narrate a click it never made.
 */
export function toolboxPromptLines(): string[] {
  return EMAIL_TOOLBAR_TOOLS.filter((tool) => tool.markup !== null).map(
    (tool) =>
      `- ${tool.label} — the sender says "${tool.asks[0]}" — you write ${tool.markup}` +
      (tool.note ? ` (${tool.note})` : ""),
  );
}
