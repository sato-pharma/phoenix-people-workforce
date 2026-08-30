/**
 * The shape of a custody receipt (إقرار استلام عهدة) — the paper an employee signs for a company
 * device.
 *
 * WHY THIS IS ITS OWN SHAPE AND NOT A CONTRACT VERSION. The contract is one instrument with a
 * version history: v2 replaced v1 and only one of them is current. A custody receipt is one
 * instrument with two FORMS, both current at the same time — the document itself numbers them
 * (`نموذج رقم 1` for a laptop, `نموذج رقم 2` for a phone or tablet), and which one you print
 * depends on what is in your hand, not on what year it is. They are registered as two documents
 * with one current version each, rather than as two versions of one document, because the archive's
 * central rule is that exactly one version of a document is current and everything else is
 * superseded. Filing these as versions would either make that rule false or declare the tablet form
 * "archived", which would tell HR it had been withdrawn.
 *
 * WHAT DIFFERS BETWEEN THE TWO FORMS is small and entirely contained here: the form number, the
 * heading over the item table, the item rows themselves, and the technical block — Windows "About"
 * fields for a laptop, IMEI and SIM details for a phone. Every clause, both signature blocks and
 * the whole return protocol are identical, and are held once in the shared text rather than
 * duplicated per form, so a wording change cannot land on one form and miss the other.
 */

/** Which of the two numbered forms this is. */
export type CustodyVariant = "laptop" | "mobileTablet";

/**
 * The values Phoenix fills in. Everything else on the page is standing text or a blank for the pen.
 *
 * Deliberately small. A custody receipt is mostly about a DEVICE, and Phoenix holds no asset
 * register — so the device half of the page prints as ruled blanks, exactly as the owner's own
 * blank templates do, and only the half that is about the PERSON is filled. That is the half worth
 * filling: it is copied from an ID card by hand today, which is where the transcription errors are.
 */
export type CustodyToken =
  | "COMPANY_NAME"
  | "COMPANY_LEGAL_FORM"
  | "COMMERCIAL_REGISTER"
  | "COMMERCIAL_REGISTER_OFFICE"
  | "UNIFIED_REGISTER"
  | "TAX_CARD"
  | "COMPANY_HEAD_OFFICE_FULL"
  | "ISSUE_DATE"
  | "EMPLOYEE_NAME"
  | "NATIONAL_ID"
  | "JOB_TITLE"
  | "DEPARTMENT"
  | "HR_ID"
  | "PHONE"
  | "ADDRESS";

/**
 * One labelled box on the form.
 *
 * `token` null means the box prints ruled and empty — a handover date, a declaration number, the
 * place of handover. Those are written at the desk with the device present, and a printed guess
 * would be worse than a rule: this is a signed acknowledgement of what was physically handed over.
 *
 * `ltr` marks a value that must be laid out left-to-right inside an otherwise right-to-left line.
 * It is not cosmetic. A national ID, a phone number, a serial number or an IMEI is a run of Latin
 * digits in an Arabic paragraph, and the bidirectional algorithm will reorder the groups around it
 * — the same defect that once printed the company's tax card number `477-108-318` reversed as
 * `318-108-477`. The Word original defends against this with U+202A/U+202C embedding controls
 * around every such run; this is the same defence, expressed the way HTML expresses it.
 */
export type CustodyField = {
  labelAr: string;
  token: CustodyToken | null;
  /** Spans the full width instead of sharing a row — an address needs the room. */
  wide: boolean;
  ltr: boolean;
};

/** A row of the "بيان العهدة المسلَّمة" table: a numbered item, and blanks for what it is. */
export type CustodyItemRow = {
  number: string;
  itemAr: string;
};

/** One numbered undertaking, e.g. "(7) ألتزم برد العهدة …". */
export type CustodyClause = {
  number: string;
  body: string;
};

/** A titled group of undertakings, e.g. "ثالثًا — رد العهدة والمسؤولية المالية". */
export type CustodyClauseGroup = {
  headingAr: string;
  clauses: readonly CustodyClause[];
};

/** One of the three signature columns, and the line attesting what that signature means. */
export type CustodySignatureColumn = {
  headingAr: string;
  attestationAr: string;
};

/** A box on the return protocol. `fixedAr` is standing text rather than a blank — the ✓/✗ line. */
export type CustodyReturnField = {
  labelAr: string;
  fixedAr: string | null;
  wide: boolean;
};

export type CustodyTemplate = {
  /** Registry id — `custody-laptop-v1`, `custody-mobile-v1`. */
  id: string;
  version: number;
  variant: CustodyVariant;

  /** `نموذج رقم` — 1 for the laptop form, 2 for the phone/tablet form. */
  formNumberAr: string;
  titleAr: string;
  subtitleAr: string;
  /** Labels on the header strip, in printed order: form no., declaration no., issue date, dept. */
  headerLabelsAr: readonly string[];
  departmentAr: string;

  holderHeadingAr: string;
  holderFields: readonly CustodyField[];

  itemsHeadingAr: string;
  itemColumnsAr: readonly string[];
  itemRows: readonly CustodyItemRow[];
  itemTotalLabelAr: string;
  itemNoteAr: string;

  technicalHeadingAr: string;
  technicalFields: readonly CustodyField[];

  clausesHeadingAr: string;
  clauseGroups: readonly CustodyClauseGroup[];
  closingAr: string;

  signaturesHeadingAr: string;
  signatureColumns: readonly CustodySignatureColumn[];

  returnHeadingAr: string;
  returnIntroAr: string;
  returnFields: readonly CustodyReturnField[];
  returnSignatureColumns: readonly CustodySignatureColumn[];
};

/**
 * What a box prints when nobody has supplied its value.
 *
 * A ruled line, not an empty cell. The same reasoning as the contract's blank rule: an empty box on
 * a signed instrument reads as "this does not apply", while a rule reads as "somebody still has to
 * write here" — and this document is signed by three people, so the difference decides whether a
 * missing value gets caught at the desk or after the fact.
 */
export const CUSTODY_BLANK_RULE = "..................................";

/** The wider rule, for a full-width box. Matches the Word original's own two widths. */
export const CUSTODY_BLANK_RULE_WIDE = "...............................................................";

/**
 * Every string a template carries, flattened in printed order.
 *
 * Used by the archive tests to fingerprint the wording. It walks the STRUCTURE rather than reading
 * the file, so the fingerprint survives reformatting, a comment edit or a field being renamed in
 * TypeScript, and changes only when the printed Arabic actually changes — which is the thing worth
 * pinning. Byte-window pinning of a source file has false-failed in this repo before.
 */
export function custodyTemplateStrings(template: CustodyTemplate): string[] {
  return [
    template.formNumberAr,
    template.titleAr,
    template.subtitleAr,
    ...template.headerLabelsAr,
    template.departmentAr,
    template.holderHeadingAr,
    ...template.holderFields.map((field) => field.labelAr),
    template.itemsHeadingAr,
    ...template.itemColumnsAr,
    ...template.itemRows.map((row) => `${row.number} ${row.itemAr}`),
    template.itemTotalLabelAr,
    template.itemNoteAr,
    template.technicalHeadingAr,
    ...template.technicalFields.map((field) => field.labelAr),
    template.clausesHeadingAr,
    ...template.clauseGroups.flatMap((group) => [
      group.headingAr,
      ...group.clauses.map((clause) => `${clause.number} ${clause.body}`),
    ]),
    template.closingAr,
    template.signaturesHeadingAr,
    ...template.signatureColumns.flatMap((column) => [column.headingAr, column.attestationAr]),
    template.returnHeadingAr,
    template.returnIntroAr,
    ...template.returnFields.map((field) => `${field.labelAr} ${field.fixedAr ?? ""}`.trim()),
    ...template.returnSignatureColumns.flatMap((column) => [
      column.headingAr,
      column.attestationAr,
    ]),
  ];
}

/** Every token a template actually uses, sorted — the archive tests pin this per form. */
export function custodyTemplateTokens(template: CustodyTemplate): CustodyToken[] {
  const used = new Set<CustodyToken>();
  for (const field of [...template.holderFields, ...template.technicalFields]) {
    if (field.token) used.add(field.token);
  }
  return [...used].sort();
}
