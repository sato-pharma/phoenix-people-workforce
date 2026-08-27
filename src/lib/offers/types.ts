/**
 * Types for the job-offer module.
 *
 * This module is deliberately INDEPENDENT of recruitment. An offer here is not tied to a
 * candidate row, an application, or a hiring pipeline stage — the owner asked for a separate
 * module so an offer can be issued to anybody, including somebody who never entered the ATS.
 * `src/lib/recruitment/offers.ts` is a different thing (the recruitment pipeline's own offer
 * stage) and the two must not be merged.
 */

/**
 * A template is an ordered list of blocks. Blocks — rather than one contenteditable blob of
 * HTML — are what make a template both editable by a non-engineer and safely re-renderable into
 * two very different targets: a print-quality PDF (grid, flex, pt units) and an email body
 * (tables only, because Outlook ignores grid and flex entirely).
 */
export type OfferBlockType =
  | "benefits"
  | "clauses"
  | "compensation"
  | "control"
  | "footer"
  | "heading"
  | "html"
  | "letterhead"
  | "pagebreak"
  | "rail"
  | "scope"
  | "signature"
  | "steps"
  | "text"
  | "title"
  | "welcome";

/**
 * The SKIN a template is drawn in. Both variants render the SAME blocks — this chooses the visual
 * identity, not the content, which is why either built-in design can be edited into anything and
 * still look like itself.
 *
 * `classic`   — the signed Dr Samaa letter: white sheet, blue rail, hairline rules.
 * `executive` — the Ultra Premium letter: navy bands, tinted zebra table, numeral tiles.
 */
export type OfferTemplateVariant = "classic" | "executive";

/**
 * Which shipped design a row IS a copy of, or null for one somebody built themselves.
 *
 * This is what makes "restore" survive renaming: the built-ins are regenerated from code, and the
 * row is found by this key rather than by a name the owner is free to change.
 */
export type OfferBuiltinKey = "classic" | "executive";

export type OfferBlock = {
  id: string;
  /** Free-form per-type payload. Validated on save by `sanitizeTemplateBlocks`. */
  props: Record<string, unknown>;
  type: OfferBlockType;
};

/**
 * The design tokens a template may override. These are the same CSS custom properties the
 * owner's own editable HTML used, so a template designed in the standalone builder imports
 * unchanged.
 */
export type OfferTheme = Partial<
  Record<
    | "body"
    | "brand"
    | "chip"
    | "faint"
    | "frame"
    | "hair"
    | "ink"
    | "line"
    | "muted"
    | "soft"
    | "tint"
    | "tint-line",
    string
  >
>;

export type OfferTemplate = {
  blocks: OfferBlock[];
  /**
   * Set on the two shipped designs, null on anything built in the UI. A built-in can be edited
   * freely and always restored, because the original lives in code rather than in this row.
   */
  builtinKey: OfferBuiltinKey | null;
  createdAt: string | null;
  createdBy: string | null;
  fontFamily: string;
  fontSizePt: number;
  id: string;
  /**
   * The template a NEW offer opens on. Exactly one row carries it — a database fact, not a
   * convention — and which one is the owner's choice, moved with "Use for new offers".
   */
  isDefault: boolean;
  name: string;
  theme: OfferTheme;
  updatedAt: string | null;
  variant: OfferTemplateVariant;
};

export type OfferTemplateInput = {
  blocks: OfferBlock[];
  fontFamily?: string;
  fontSizePt?: number;
  name: string;
  theme?: OfferTheme;
  variant?: OfferTemplateVariant;
};

/**
 * A job title and the flat cost-of-living allowance that goes with it.
 *
 * Cost of living is per TITLE, never per person — that is the rule the three signed offers
 * establish, and it is why one typed number can produce the whole compensation table.
 */
export type OfferJobTitle = {
  active: boolean;
  contractTerm: string | null;
  costOfLiving: number;
  id: string;
  reportsTo: string | null;
  /**
   * The letter design new offers for this title open on.
   *
   * Null means "no preference — use whichever template holds `isDefault`", which is a real answer
   * rather than a missing one: it keeps following the default if the default later moves, where
   * storing the default's own id would freeze a decision nobody made.
   */
  templateId: string | null;
  title: string;
};

export type OfferJobTitleInput = {
  active?: boolean;
  contractTerm?: string | null;
  costOfLiving: number;
  reportsTo?: string | null;
  templateId?: string | null;
  title: string;
};

export type OfferStatus = "accepted" | "declined" | "draft" | "sent" | "withdrawn";

/** Everything that varies between one offer and the next. Feeds the template's `{{tokens}}`. */
export type OfferFields = {
  candidateEmail: string;
  candidateName: string;
  contractTerm: string;
  costOfLiving: number;
  dateOfIssue: string;
  reference: string;
  reportsTo: string;
  /** How the letter addresses them — "Dr SAMAA SHALABY", not necessarily the legal name. */
  salutationName: string;
  startDate: string;
  territory: string;
  title: string;
  totalMonthly: number;
  validUntil: string;
};

export type OfferRecord = OfferFields & {
  createdAt: string | null;
  createdBy: string | null;
  id: string;
  sentAt: string | null;
  sentBy: string | null;
  status: OfferStatus;
  templateId: string | null;
  /**
   * Snapshot of the template as rendered at send time — an offer must never re-render later.
   *
   * `variant` is OPTIONAL because snapshots taken before a second design existed do not carry one,
   * and those offers were all classic. Absent therefore means classic, which is the truth for them
   * rather than a fallback.
   */
  templateSnapshot: {
    blocks: OfferBlock[];
    fontFamily: string;
    fontSizePt: number;
    theme: OfferTheme;
    variant?: OfferTemplateVariant;
  } | null;
};
