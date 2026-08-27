import type { OfferBlockType } from "@/lib/offers/types";

/**
 * What each block type lets you edit.
 *
 * The editor is GENERIC — it renders inputs from this table rather than carrying a hand-written
 * form per block type. That is what makes "add, drop, delete, edit, everything" true in practice:
 * a new block type needs one entry here and the whole editor understands it, instead of a new
 * component that somebody forgets to write and that silently makes half a block uneditable.
 *
 * `list` fields are repeatable rows (compensation lines, benefits, clauses, steps) — each with its
 * own add / delete / reorder, because the owner's real templates differ mostly in how many rows
 * each section has.
 */

export type OfferFieldKind = "color" | "html" | "text" | "textarea" | "toggle";

export type OfferFieldDef = {
  hint?: string;
  key: string;
  kind: OfferFieldKind;
  label: string;
};

export type OfferListDef = {
  /** A blank row, used by the list's own Add button. */
  blank: Record<string, string | boolean>;
  fields: OfferFieldDef[];
  itemLabel: string;
  key: string;
  label: string;
};

export type OfferBlockDef = {
  description: string;
  fields: OfferFieldDef[];
  label: string;
  lists: OfferListDef[];
  type: OfferBlockType;
};

const t = (key: string, label: string, hint?: string): OfferFieldDef => ({ hint, key, kind: "text", label });
const area = (key: string, label: string, hint?: string): OfferFieldDef => ({ hint, key, kind: "textarea", label });

export const OFFER_BLOCK_DEFS: OfferBlockDef[] = [
  {
    description: "The thin coloured band down the left edge of page one.",
    fields: [],
    label: "Accent rail",
    lists: [],
    type: "rail",
  },
  {
    description: "Company name, unit and optional logo across the top.",
    fields: [
      t("name", "Company name"),
      t("unit", "Department line"),
      t("tagline", "Second line", "Prints under the department, in the brand colour. Leave blank to omit."),
      t("logo", "Logo image URL", "Leave blank to print the company name as a wordmark."),
    ],
    label: "Letterhead",
    lists: [],
    type: "letterhead",
  },
  {
    description: "The reference / date / validity strip. Mark one item to highlight it.",
    fields: [],
    label: "Control strip",
    lists: [
      {
        blank: { brand: false, k: "Label", v: "Value" },
        fields: [t("k", "Label"), t("v", "Value"), { key: "brand", kind: "toggle", label: "Highlight" }],
        itemLabel: "Item",
        key: "items",
        label: "Strip items",
      },
    ],
    type: "control",
  },
  {
    description: "The document's main heading, its subtitle, and the badge beside them.",
    fields: [
      t("h1", "Heading"),
      t("sub", "Subtitle"),
      t("badgeK", "Badge line 1", "The small tinted line. Leave both badge lines blank to omit the badge."),
      t("badge", "Badge line 2", "The larger line under it."),
    ],
    label: "Document title",
    lists: [],
    type: "title",
  },
  {
    description: "A section heading — the small capitalised rule above a block.",
    fields: [t("text", "Heading text"), t("sub", "Trailing note", "Prints after the heading, lighter — e.g. “/ Net Package”.")],
    label: "Section heading",
    lists: [],
    type: "heading",
  },
  {
    description: "Free paragraphs. Simple HTML is allowed; {{tokens}} are filled per offer.",
    fields: [
      { key: "html", kind: "html", label: "Body" },
      t("avatar", "Initials disc", "Usually {{initials}}. Leave blank for plain paragraphs."),
    ],
    label: "Paragraphs",
    lists: [],
    type: "text",
  },
  {
    description: "The four-up facts panel — reports to, territory, start date, contract.",
    fields: [],
    label: "Role facts",
    lists: [
      {
        blank: { k: "Label", v: "Value" },
        fields: [t("k", "Label"), t("v", "Value")],
        itemLabel: "Fact",
        key: "items",
        label: "Facts",
      },
    ],
  type: "scope",
  },
  {
    description:
      "The salary table. The monthly and annual columns are filled from the offer's own figures — type the total package once and the rest is derived.",
    fields: [
      t("heroK", "Headline label"),
      t("heroNote", "Headline note"),
      t("asideK", "Annual column label"),
      t("currency", "Currency"),
      t("totalLabel", "Total row label"),
      area("note", "Footnote"),
    ],
    label: "Compensation table",
    lists: [
      {
        blank: { a: "", l: "New line", m: "" },
        fields: [
          t("l", "Line"),
          t("m", "Monthly", "Usually a {{token}} such as {{basicMonthly}}."),
          t("a", "Annual", "Usually a {{token}} such as {{basicAnnual}}."),
        ],
        itemLabel: "Line",
        key: "rows",
        label: "Salary lines",
      },
    ],
    type: "compensation",
  },
  {
    description: "Benefits, each a short label and one sentence.",
    fields: [],
    label: "Benefits",
    lists: [
      {
        blank: { k: "Benefit", t: "Description" },
        fields: [t("k", "Benefit"), area("t", "Description")],
        itemLabel: "Benefit",
        key: "items",
        label: "Benefits",
      },
    ],
    type: "benefits",
  },
  {
    description: "Numbered terms of engagement.",
    fields: [],
    label: "Clauses",
    lists: [
      {
        blank: { h: "Clause", t: "Text" },
        fields: [t("h", "Clause"), area("t", "Text")],
        itemLabel: "Clause",
        key: "items",
        label: "Clauses",
      },
    ],
    type: "clauses",
  },
  {
    description: "The what-happens-next steps.",
    fields: [],
    label: "Next steps",
    lists: [
      {
        blank: { h: "Step", n: "Step 00", t: "What to do" },
        fields: [t("n", "Number"), t("h", "Step"), area("t", "Detail")],
        itemLabel: "Step",
        key: "items",
        label: "Steps",
      },
    ],
    type: "steps",
  },
  {
    description: "The two signature panels.",
    fields: [
      t("title", "Panel title"),
      t("leftK", "Left label"),
      t("leftName", "Left name"),
      t("leftSub", "Left subtitle"),
      t(
        "leftSignature",
        "Signature image",
        "Drawn on the left-hand rule, over the signatory's name. Untouched, this uses the signature " +
          "held on file. Type an image URL to override it, or type in this box and empty it again " +
          "to print an unsigned letter for signing by hand.",
      ),
      t("rightK", "Right label"),
      t("rightName", "Right name"),
      t("rightSub", "Right subtitle"),
    ],
    label: "Signatures",
    lists: [],
    type: "signature",
  },
  {
    description: "The confidentiality footer, and the mark repeated along the foot of every page.",
    fields: [
      area("text", "Footer text"),
      t("right", "Right-hand mark"),
      t(
        "pageMark",
        "Running page foot",
        "Printed at the bottom of EVERY page of the PDF, with a live page number. Blank means no running foot.",
      ),
    ],
    label: "Footer",
    lists: [],
    type: "footer",
  },
  {
    description: "The closing band — a short label over one line, with a coloured end cap.",
    fields: [t("k", "Label"), t("text", "Line")],
    label: "Closing band",
    lists: [],
    type: "welcome",
  },
  {
    description: "Forces the next block onto a new printed page. Ignored in the email body.",
    fields: [],
    label: "Page break",
    lists: [],
    type: "pagebreak",
  },
  {
    description:
      "Raw HTML, printed exactly as typed. Included in the PDF only — it is dropped from the email body, where an unpredictable tag would break the layout in Outlook.",
    fields: [{ key: "html", kind: "html", label: "HTML" }],
    label: "Raw HTML",
    lists: [],
    type: "html",
  },
];

export function offerBlockDef(type: OfferBlockType): OfferBlockDef {
  return (
    OFFER_BLOCK_DEFS.find((def) => def.type === type) ?? {
      description: "",
      fields: [],
      label: type,
      lists: [],
      type,
    }
  );
}

/** The theme tokens, in the order they are shown as colour swatches. */
export const OFFER_THEME_FIELDS: { key: string; label: string }[] = [
  { key: "brand", label: "Brand" },
  { key: "ink", label: "Headings" },
  { key: "body", label: "Body text" },
  { key: "muted", label: "Muted text" },
  { key: "soft", label: "Soft text" },
  { key: "faint", label: "Faint text" },
  { key: "tint", label: "Panel fill" },
  { key: "tint-line", label: "Panel border" },
  { key: "chip", label: "Chip fill" },
  { key: "line", label: "Rules" },
  { key: "hair", label: "Hairlines" },
  { key: "frame", label: "Frames" },
];

/** Fonts offered in the designer. All are safe on Chromium and in email clients. */
export const OFFER_FONT_CHOICES: { label: string; value: string }[] = [
  { label: "Open Sans", value: "'Open Sans',Arial,Helvetica,sans-serif" },
  { label: "Segoe UI", value: "'Segoe UI',Arial,Helvetica,sans-serif" },
  { label: "Arial", value: "Arial,Helvetica,sans-serif" },
  { label: "Helvetica", value: "Helvetica,Arial,sans-serif" },
  { label: "Georgia", value: "Georgia,'Times New Roman',serif" },
  { label: "Times New Roman", value: "'Times New Roman',Times,serif" },
  { label: "Tahoma", value: "Tahoma,Verdana,Arial,sans-serif" },
  { label: "Verdana", value: "Verdana,Geneva,Arial,sans-serif" },
];
