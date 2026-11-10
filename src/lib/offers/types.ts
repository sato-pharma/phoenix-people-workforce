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
 * `sato`      — the Sato corporate-identity letter: navy masthead band closed by a 3px brand
 *               seam, the reverse Sato mark, micro labels and the SHARP square-edge look. It is a
 *               THIRD skin added beside the two frozen designs, not a change to either of them.
 * `house`     — the HR-forms house identity (SATO-DIS-2026-01): the on-light mark over the
 *               engine-turned band, the three logo blues, and the INK RULE — no filled areas, the
 *               identity carried by lines and type, one 6% zebra on the salary table. A FOURTH
 *               skin the owner asked for on 2026-09-22 to match the hiring-pack forms, added
 *               beside the three others and changing none of them.
 * `premium`   — the HR premium identity (SATO-DIS-2026-01 raised to premium): the centred masthead
 *               over the engine-turned band, a double-keyline frame with security microtext, the
 *               Arabic watermark, a Sato-only running foot and the ink rule. A FIFTH skin the owner
 *               asked for on 2026-10-13 — "for job offers create new template with the new identity"
 *               — added beside the four others and changing none of them.
 */
export type OfferTemplateVariant = "classic" | "executive" | "sato" | "house" | "premium";

/**
 * Which shipped design a row IS a copy of, or null for one somebody built themselves.
 *
 * This is what makes "restore" survive renaming: the built-ins are regenerated from code, and the
 * row is found by this key rather than by a name the owner is free to change.
 */
export type OfferBuiltinKey = "classic" | "executive" | "sato" | "house" | "premium";

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
   * What the letter says this job IS — the paragraph after the salutation, in this position's own
   * words, reaching the letter as `{{roleSummary}}`.
   *
   * Null means "nobody has worded this position yet" and prints the role-neutral standard sentence
   * rather than a gap (`src/lib/offers/role-summary.ts`). It lives here, beside the figures, because
   * it is the same kind of fact as the cost of living: true of the POSITION, never of the design the
   * letter happens to wear. Before it existed, three of the four designs told every candidate in the
   * company that they would be leading a district's field team.
   */
  roleSummary: string | null;
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
  roleSummary?: string | null;
  templateId?: string | null;
  title: string;
};

/**
 * `pending_approval` (owner, 2026-11-10): Talent Acquisition pressed Send and the offer is waiting for
 * the HR Manager. Nothing has reached the candidate; only his Approve and send does
 * (`src/lib/offers/approval.ts`).
 */
export type OfferStatus = "accepted" | "declined" | "draft" | "pending_approval" | "sent" | "withdrawn";

/** Who asked for an offer's approval, who decided, and what he said when he sent it back. */
export type OfferApproval = {
  approvedAt: string | null;
  approvedBy: string | null;
  requestedAt: string | null;
  requestedBy: string | null;
  returnedAt: string | null;
  returnedBy: string | null;
  returnReason: string | null;
};

/** Everything that varies between one offer and the next. Feeds the template's `{{tokens}}`. */
export type OfferFields = {
  candidateEmail: string;
  candidateName: string;
  contractTerm: string;
  costOfLiving: number;
  dateOfIssue: string;
  reference: string;
  reportsTo: string;
  /**
   * The paragraph describing the job, prefilled from the job title and overridable for this one
   * letter — the same shape as `reportsTo` and `contractTerm` above.
   *
   * It is COPIED onto the offer when the title is chosen, not looked up again when the letter is
   * drawn, and that direction is the whole safety of it: a sent offer must say tomorrow what the
   * candidate signed today, and resolving a live title would let rewording a position silently
   * restate a letter already in somebody's inbox. Empty prints the role-neutral standard sentence,
   * which is what every offer written before this field existed carries.
   */
  roleSummary: string;
  /** How the letter addresses them — "Dr SAMAA SHALABY", not necessarily the legal name. */
  salutationName: string;
  startDate: string;
  territory: string;
  title: string;
  totalMonthly: number;
  validUntil: string;
};

export type OfferRecord = OfferFields & {
  /**
   * HR's own words for the candidate, printed at the top of the offer EMAIL body and never on the PDF
   * (owner, 2026-11-10). Empty for no message. Optional, like every column added after the module
   * shipped: a database without migration 20261110195450 has no such column.
   */
  emailMessage?: string;
  /** 0 as first issued; 1, 2, … once HR issues an updated offer (owner, 2026-11-10). */
  revision?: number;
  /** Every earlier version that went out, newest last. Empty for an offer never updated. */
  revisionHistory?: OfferRevision[];
  /** When the current update was started, and who started it. Null for an offer never updated. */
  revisedAt?: string | null;
  revisedBy?: string | null;
  /**
   * The HR Manager's approval (owner, 2026-11-10). Optional, like every column added after the module
   * shipped: an offer written before it, or read from a database without migration 20261110190002,
   * simply has none of them.
   */
  approval?: OfferApproval;
  /** When the candidate submitted the joining form (his acceptance). Null otherwise. */
  acceptedAt?: string | null;
  /** "candidate_form" — he pressed Submit on the joining form; "hr" — HR recorded his reply by hand. */
  acceptedVia?: "candidate_form" | "hr" | null;
  /** The employee record the joining form created. Null until he submits, and for a hand-recorded acceptance. */
  employeeHrId?: string | null;
  /** Who was secretly copied (BCC) when it was sent. Empty for a draft, and for an offer sent to the candidate alone. */
  bccRecipients: string[];
  /** Who was openly copied (CC) when it was sent. Empty for a draft, and for an offer sent to the candidate alone. */
  ccRecipients: string[];
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
  /**
   * The open seat in `position_vacancies` this offer was written against, or null.
   *
   * DELIBERATELY NOT in `OfferFields`. Those fields feed the letter's `{{tokens}}`, and a seat id
   * prints nowhere — what the letter says about the job is `territory` and `reportsTo`, which the
   * seat FILLS IN when one is chosen and which stay editable afterwards. Keeping it out of the
   * fields is also what stops it reaching the template snapshot frozen at send time.
   *
   * This is the ONE pointer the offers module carries outward, and the direction is the reason: a
   * vacancy is an org seat, shared HR data that `src/lib/employees/vacancy-closer.ts` has always
   * owned without touching recruitment or offers. A CANDIDATE pointer is still forbidden here —
   * the offers module stays independent of the ATS because an offer may go to somebody who never
   * entered it, and `tests/candidate-offer-pointer.test.ts` pins that.
   *
   * Null is the answer for every offer written before 2026-09-29, and stays a valid answer
   * afterwards: a letter may be issued before anybody has settled which seat it fills.
   */
  vacancyId: number | null;
};

/**
 * One earlier version of an offer that went out, frozen when HR started an update (owner, 2026-11-10:
 * "i may need to update a job offer"). Kept on the row in `revision_history`, newest last, so the
 * letter a candidate once held is never lost when its terms change.
 */
export type OfferRevision = {
  approvedAt: string | null;
  approvedBy: string | null;
  bcc: string[];
  cc: string[];
  emailMessage: string | null;
  fields: OfferFields;
  requestedBy: string | null;
  /** 0 for the offer as first issued, 1 for the first update, and so on. */
  revision: number;
  sentAt: string | null;
  sentBy: string | null;
  /**
   * The answer it carried when the update started — sent, accepted, declined or withdrawn — and, for an
   * acceptance, when and how. Cancel update puts them back. Absent on an entry frozen before answered
   * offers could be updated (2026-11-10), which was always a sent one.
   */
  status?: OfferStatus;
  acceptedAt?: string | null;
  acceptedVia?: OfferRecord["acceptedVia"];
  /** When the update that replaced it was started, and who started it. */
  supersededAt: string;
  supersededBy: string | null;
  templateId: string | null;
  templateSnapshot: OfferRecord["templateSnapshot"];
  vacancyId: number | null;
};

/**
 * One open seat, as the offers screen and the hire bridge need it.
 *
 * A narrowed copy of what `src/lib/employees/vacancy-closer.ts` reads rather than an import of its
 * row type, so the offers module's shape does not move when that module's query does.
 */
export type OfferVacancyOption = {
  areaId: number | null;
  areaName: string | null;
  departmentId: number | null;
  jobTitle: string | null;
  lineId: number | null;
  lineName: string | null;
  managerHrId: string | null;
  managerName: string | null;
  positionId: number | null;
  positionTitle: string | null;
  regionName: string | null;
  vacancyCode: string;
  vacancyId: number;
};
