/**
 * THE SHAPE OF SATO'S OWN HR PAPERS — the ones that are neither the contract, nor a government
 * form, nor one of the instruments that already has a module of its own.
 *
 * Six of them arrived together on 2026-09-05 with the instruction to put them into the house
 * identity and set them up in the system: the confidentiality undertaking, the appointment-documents
 * receipt and its exit counterpart, the two absence warnings, and the service-file social-status
 * sheet. They share one shape because they share one page: a letterhead, a company recital, an
 * identity grid, a body, and signatures. What differs between them is which of those parts is
 * filled in — a letter has paragraphs and no clauses, a checklist has a table and almost no prose.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY NOT `RenewalTemplate`. It is close, and it was tempting. The renewal pair are ARCHIVED legal
 * instruments — a signed annex has to reprint as the document that was signed, which is why every
 * version stays in `renewal-text.ts` forever and why its shape carries a `variant` discriminator and
 * a version id. These six are working papers of different KINDS, not versions of one instrument, and
 * two of them need a table shape the renewal pair has no use for. Bolting a checklist onto the
 * renewal shape would put a column that can never appear on an annex into the type that describes
 * annexes.
 *
 * WHAT IS SHARED IS THE LOOK, and that lives in `HOUSE_DOCUMENT_CSS` below: the contract's own
 * `document` layout, which the renewal papers already match. `render-contract.ts` keeps its private
 * copy on purpose and must not be pointed at this one — an archived contract version has to render
 * byte-identically forever, and sharing a stylesheet with papers that are still being designed is
 * exactly how that guarantee is lost. Two copies, one of them frozen, is the correct number.
 */

/** Which kind of page a paper is, which decides what the renderer draws. */
export type HrPaperKind =
  /** A signed undertaking: recital, identity grid, numbered or flowing body, both parties sign. */
  | "undertaking"
  /** A checklist the desk completes with the employee present. */
  | "checklist"
  /** A letter from the company to one employee. */
  | "letter"
  /**
   * A statement of fact the company issues ABOUT an employee, to be read by somebody else.
   *
   * NOT a `letter`, and the distinction earns its keep twice. `renderHrPaperHtml` resolves an
   * archived version only within the same kind, so folding a certificate in with the two absence
   * notices would put it in a pool with papers that END somebody's service. And the print banner
   * keyed on `letter` warns about blank absence dates, which is true of both notices and nonsense
   * on a certificate — a warning that does not apply is one a reader learns to skip.
   *
   * It is also the one kind nobody signs back: it is addressed to a future employer, an embassy or
   * a bank, so it carries the company's signature and stamp alone.
   */
  | "certificate"
  /**
   * The Arabic counterpart of `salary-letter-en.ts` — the letter a bank or an embassy reads, stating
   * the BASE salary and nothing else, as the English one does since 2026-10-28.
   *
   * NOT a `certificate`: `renderHrPaperHtml`'s banner for that kind warns about the certificate's own
   * "no salary, no reason for leaving" omissions, which would be actively wrong printed above a
   * document whose entire purpose is stating a salary. It also keeps this paper's archived versions
   * in a pool of its own rather than the certificate's.
   */
  | "salaryLetter"
  /** A data sheet for the service file: labelled grids and a repeating table. */
  | "dataSheet";

/**
 * Every token these papers can carry.
 *
 * One union across all of them, as the contract and the renewal papers each have — so one value bag
 * fills whichever paper is printing, and a paper referencing a token that is not here fails its test
 * rather than printing the literal `{{SOMETHING}}` onto a signature page.
 */
export type HrPaperToken =
  // The occasion
  | "ISSUE_DATE"
  | "ISSUE_DAY_NAME"
  // The company — the contract's own recital facts, so no two papers describe it differently
  | "COMPANY_NAME"
  | "COMPANY_LEGAL_FORM"
  | "COMPANY_HEAD_OFFICE_FULL"
  | "COMPANY_CITY"
  | "COMMERCIAL_REGISTER"
  | "COMMERCIAL_REGISTER_OFFICE"
  | "UNIFIED_REGISTER"
  | "TAX_CARD"
  | "COMPANY_INSURANCE_NUMBER"
  | "COMPANY_INSURANCE_OFFICE"
  | "CONTRACT_SIGNATORY"
  | "CONTRACT_SIGNATORY_TITLE"
  // The person
  | "EMPLOYEE_NAME"
  | "HR_ID"
  | "NATIONAL_ID"
  | "INSURANCE_NUMBER"
  | "JOB_TITLE"
  | "DEPARTMENT"
  | "ADDRESS"
  | "PHONE"
  | "EMAIL"
  | "NATIONALITY"
  | "RELIGION"
  | "GENDER"
  | "BIRTH_DATE"
  | "BIRTH_PLACE"
  | "MILITARY_STATUS"
  | "MARITAL_STATUS"
  | "QUALIFICATION"
  // The engagement
  | "HIRE_DATE"
  | "CONTRACT_DATE"
  | "LAST_WORKING_DATE"
  // The period of service, as a certificate states it
  //
  // THREE TOKENS RATHER THAN ONE SENTENCE, because a certificate says the same thing two ways
  // depending on whether the person has left, and a paper that gets that wrong asserts somebody
  // resigned who is at his desk. `SERVICE_END` closes the period — a date for a leaver, «تاريخه»
  // for somebody still serving; `SERVICE_STATUS` states which of the two in words, so the reading
  // never rests on one word; `SERVICE_DURATION` is the span, counted inclusive of the last day.
  | "SERVICE_END"
  | "SERVICE_STATUS"
  | "SERVICE_DURATION"
  // The BASE salary, on the Arabic HR letter — the figure on the employee's record, stated as it is.
  //
  // (It stated the BASIC salary until 2026-09-20, when the owner said to "put the base": the basic is
  // still what the English letter states.) Three tokens for the same reason SERVICE_END/STATUS/
  // DURATION are three: `BASE_SALARY_LEAD` is the sentence's own verb, present tense for somebody
  // still on the payroll and past tense for a leaver, chosen once per render alongside
  // `SERVICE_STATUS`; `BASE_SALARY` and `BASE_SALARY_WORDS` are the figure and its تفقيط, each
  // independently blankable when there is no salary to state.
  | "BASE_SALARY_LEAD"
  | "BASE_SALARY"
  | "BASE_SALARY_WORDS"
  // How the paper was drawn up — «من نسختين، نسخة تُسلَّم …». Worked out from the number of copies
  // the desk chose at print time (`copies-clause.ts`), never stored: it is not a fact about the
  // employee, it is a fact about this print run.
  | "COPIES_CLAUSE"
  // The absence being warned about
  | "ABSENCE_FROM"
  | "ABSENCE_TO"
  | "FIRST_WARNING_FROM"
  | "FIRST_WARNING_TO"
  // A deadline the desk sets
  | "COMPLETION_DEADLINE";

/** One labelled box in an identity or data grid. */
export type HrPaperField = {
  labelAr: string;
  /**
   * The English label, on a paper the owner supplied in both languages (the exit interview). Printed
   * on its own line pinned left-to-right — a bilingual label on ONE line turns wholly one way and
   * renders the other half backwards.
   */
  labelEn?: string;
  /** The token whose value fills it. Null prints a ruled blank for a pen. */
  token: HrPaperToken | null;
  /** Latin digits — a national ID, an employee code, a date. Pinned left-to-right. */
  ltr?: boolean;
  /** Takes the whole row instead of sharing it. */
  wide?: boolean;
};

/** A grid of labelled boxes under its own heading. */
export type HrPaperSection = {
  headingAr: string | null;
  fields: readonly HrPaperField[];
};

/** One row of a checklist — a document the desk ticks off. */
export type HrPaperChecklistRow = {
  /** Printed as the serial. Kept as a string so the paper decides its own numbering. */
  number: string;
  labelAr: string;
  /** The English line under it, on a bilingual paper. See `HrPaperField.labelEn`. */
  labelEn?: string;
};

/**
 * Numbered questions answered in writing — a question, then ruled lines for the pen.
 *
 * Not a grid: a question is a sentence, and a sentence squeezed into a label column wraps into a
 * tower of three-word lines beside an empty box.
 */
export type HrPaperOpenQuestions = {
  headingAr: string;
  rows: readonly HrPaperChecklistRow[];
  /** How many ruled lines under each question. */
  lines: number;
};

/**
 * A checklist: rows down the side, verdict columns across the top.
 *
 * The columns are the paper's own — «متوفر / غير متوفر / لا ينطبق» — and they print as empty boxes,
 * never as anything Phoenix filled. There is no register of which certificates a person handed over,
 * and inventing one on a form somebody signs would assert that a document was seen when it was not.
 */
export type HrPaperChecklist = {
  headingAr: string;
  /** The first column's header — what the rows are. */
  itemHeadingAr: string;
  /** The verdict columns, printed as empty boxes. */
  columnsAr: readonly string[];
  rows: readonly HrPaperChecklistRow[];
  /** The line under the table, e.g. the deadline for anything missing. */
  footNoteAr: string | null;
};

/** A table the employee fills in by hand — the dependants block on the service-file sheet. */
export type HrPaperOpenTable = {
  headingAr: string;
  columnsAr: readonly string[];
  /** How many blank rows to draw. Enough to be useful, few enough to fit the page. */
  rows: number;
  /**
   * The person the paper is printed for, as the table's first row — one token per column after the
   * serial, null for a cell left to the pen. The salary memo lists several people; the one whose pack
   * is open is the first of them, and the rest are written in.
   */
  firstRowTokens?: readonly (HrPaperToken | null)[];
};

/** One column of the signature block. */
export type HrPaperSignatureColumn = {
  headingAr: string;
  fieldsAr: readonly string[];
};

/** One complete, printable paper. */
export type HrPaperTemplate = {
  /**
   * Stable identity, unique across every document this system prints.
   *
   * NEVER RENAME OR REUSE ONE — a reprint resolves the version through it, so an id that changes
   * meaning reprints somebody's signed paper as a document they never saw.
   */
  id: string;
  kind: HrPaperKind;
  version: number;
  titleAr: string;
  subtitleAr: string;
  /** Who keeps this copy, printed in the letterhead's own band. */
  purposeAr: string;
  /** The line binding this paper to the contract, on the papers that supplement one. */
  bindingLineAr: string | null;
  /** The company recital. Empty on a paper that names the company in its own prose instead. */
  firstPartyHeadingAr: string | null;
  firstPartyLinesAr: readonly string[];
  /** Who the paper is about, as a labelled grid. */
  secondPartyHeadingAr: string | null;
  secondPartyFields: readonly HrPaperField[];
  /** Further grids, on the data sheet. */
  sections: readonly HrPaperSection[];
  /** The body, as paragraphs. */
  bodyParagraphsAr: readonly string[];
  /** The operative line a warning builds to — set apart from the paragraphs around it. */
  operativeHeadingAr: string | null;
  operativeParagraphsAr: readonly string[];
  checklist: HrPaperChecklist | null;
  /** Written answers, after the checklist. */
  openQuestions?: HrPaperOpenQuestions | null;
  openTable: HrPaperOpenTable | null;
  /** Paragraphs that follow the table they refer to — the handover record's closing recitals. */
  closingParagraphsAr?: readonly string[];
  /** A closing declaration the signer is agreeing to. */
  declarationAr: string | null;
  signaturesHeadingAr: string | null;
  signatureColumns: readonly HrPaperSignatureColumn[];
  signatoryNoteLinesAr: readonly string[];
  /** The employee's separate line acknowledging he was handed a copy. */
  receiptAcknowledgmentAr: string | null;
  /** The refusal-to-sign protocol, on a paper that is SERVED rather than agreed. */
  serviceNoteAr: string | null;
  serviceFields: readonly HrPaperField[];
  footerAr: string;
  /*
   * THERE IS NO `unsealed` FLAG ANY MORE, and that is the point: NO hiring paper carries a printed
   * company seal (owner, 2026-09-29 — "remove the sato pharma stamp/seal from all hiring documents,
   * leave it only in job offers"). It existed from 2026-09-20 for the one paper he exempted then,
   * the Arabic salary letter; the exemption is now the rule, so a per-template switch would only
   * invite one back. The job offer's seal lives in `src/lib/offers/` and is untouched.
   */
};

/** The dotted rule an absent value prints as. The same one every other house paper uses. */
export const HR_PAPER_BLANK_RULE = "……………………";

/** A wider rule, for a box that takes a sentence rather than a value. */
export const HR_PAPER_BLANK_RULE_WIDE = "………………………………………………………………";

/**
 * Substitute the blanks.
 *
 * An absent value becomes a dotted rule, never an empty string — the rule every paper in this module
 * follows, because a document that silently closes up around a missing value reads as complete and a
 * reader has no way to see that something was dropped.
 */
export function fillHrPaperTokens(
  template: string,
  values: Partial<Record<HrPaperToken, string | null | undefined>>,
): string {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (whole, token: string) => {
    const value = values[token as HrPaperToken];
    const text = typeof value === "string" ? value.trim() : "";
    return text.length > 0 ? text : HR_PAPER_BLANK_RULE;
  });
}

/** Every string in a paper that can carry a token, so a caller can sweep the whole document. */
export function hrPaperTemplateStrings(template: HrPaperTemplate): string[] {
  return [
    template.titleAr,
    template.subtitleAr,
    template.purposeAr,
    template.bindingLineAr,
    template.firstPartyHeadingAr,
    ...template.firstPartyLinesAr,
    template.secondPartyHeadingAr,
    ...template.secondPartyFields.map((field) => field.labelAr),
    ...template.sections.flatMap((section) => [
      section.headingAr,
      ...section.fields.map((field) => field.labelAr),
    ]),
    ...template.bodyParagraphsAr,
    template.operativeHeadingAr,
    ...template.operativeParagraphsAr,
    ...(template.checklist
      ? [
          template.checklist.headingAr,
          template.checklist.itemHeadingAr,
          template.checklist.footNoteAr,
          ...template.checklist.columnsAr,
          ...template.checklist.rows.map((row) => row.labelAr),
        ]
      : []),
    ...(template.openQuestions
      ? [
          template.openQuestions.headingAr,
          ...template.openQuestions.rows.flatMap((row) => [row.labelAr, row.labelEn]),
        ]
      : []),
    ...(template.openTable
      ? [template.openTable.headingAr, ...template.openTable.columnsAr]
      : []),
    ...(template.closingParagraphsAr ?? []),
    template.declarationAr,
    template.signaturesHeadingAr,
    ...template.signatureColumns.flatMap((column) => [column.headingAr, ...column.fieldsAr]),
    ...template.signatoryNoteLinesAr,
    template.receiptAcknowledgmentAr,
    template.serviceNoteAr,
    ...template.serviceFields.map((field) => field.labelAr),
    template.footerAr,
  ].filter((value): value is string => typeof value === "string");
}

/**
 * Every distinct token a paper actually uses — in its prose AND in its grids.
 *
 * Returned as raw strings rather than `HrPaperToken[]`: the point of calling this is to find a token
 * that is NOT in the union, and typing the return as the union would assert away the very thing
 * being checked.
 */
export function hrPaperTemplateTokens(template: HrPaperTemplate): string[] {
  const found = new Set<string>();
  for (const text of hrPaperTemplateStrings(template)) {
    for (const match of text.matchAll(/\{\{([A-Z_]+)\}\}/g)) found.add(match[1]);
  }
  const gridFields = [
    ...template.secondPartyFields,
    ...template.sections.flatMap((section) => section.fields),
    ...template.serviceFields,
  ];
  for (const field of gridFields) if (field.token) found.add(field.token);
  for (const token of template.openTable?.firstRowTokens ?? []) if (token) found.add(token);
  return [...found].sort();
}
