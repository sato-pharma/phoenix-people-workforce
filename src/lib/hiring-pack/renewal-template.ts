/**
 * The SHAPE of the two renewal papers, shared by every version of them.
 *
 * Written 2026-09-05 to the same pattern as `contract-template.ts` and `custody-template.ts`: a
 * shape here, the legal Arabic in `renewal-text.ts`, one renderer over both. The reason is the one
 * the contract archive already learned — these are papers people SIGN, so a superseded version has
 * to stay printable as the document that was actually signed, and a renderer per version rots
 * quietly until the day somebody reprints one.
 *
 * TWO DOCUMENTS, ONE SHAPE, AND THEY ARE ALTERNATIVES. `renewal` is the annex that extends a
 * fixed-term contract for a further term; `nonRenewal` is the notice that says the company will not
 * extend it. Exactly one of them is issued per expiring contract — the same relationship the
 * resignation and the mutual-termination agreement have, and for the same reason: a file holding
 * both signed contradicts itself.
 *
 * WHY THEY ARE NOT ONE MORE CONTRACT VERSION. An annex is not a contract; it is an instrument that
 * cannot be read alone (its own opening line says so — «ولا يُقرأ ولا يُفسَّر إلا معه»). Filing it as
 * `contract-v5` would make it the paper a new hire signs, which is exactly wrong, and would archive
 * the contract that is still current.
 */

/**
 * Which of the two papers a version is.
 *
 * A DISCRIMINATOR RATHER THAN TWO SHAPES, because the two share their whole apparatus — the same
 * letterhead, the same company recital, the same party identification, the same signature block —
 * and differ only in what sits between: numbered articles on the annex, a letter's paragraphs on
 * the notice. Two shapes would duplicate the apparatus and let the two drift apart, which on paper
 * means the annex and the notice naming the same company two different ways.
 */
export type RenewalVariant = "renewal" | "nonRenewal";

/**
 * Every token either paper can carry.
 *
 * The union is the SUPERSET across both documents and every version of them, exactly as
 * `ContractToken` is: one value bag fills whichever paper is printing, and a version referencing a
 * token that is not here fails its test rather than printing the literal `{{SOMETHING}}` onto a
 * signature page.
 */
export type RenewalToken =
  // The occasion — when this instrument itself is drawn up
  | "ANNEX_NUMBER"
  | "ANNEX_DAY_NAME"
  | "ANNEX_DATE"
  // The company. The same facts the contract's own recital states, in the same order, so the two
  // papers in one file cannot describe the company two different ways.
  | "COMPANY_NAME"
  | "COMPANY_LEGAL_FORM"
  | "COMPANY_HEAD_OFFICE_FULL"
  | "COMPANY_CITY"
  | "COMMERCIAL_REGISTER"
  | "COMMERCIAL_REGISTER_OFFICE"
  | "UNIFIED_REGISTER"
  | "TAX_CARD"
  | "CONTRACT_SIGNATORY"
  | "CONTRACT_SIGNATORY_TITLE"
  // The person
  | "EMPLOYEE_NAME"
  | "HR_ID"
  | "NATIONAL_ID"
  | "JOB_TITLE"
  | "DEPARTMENT"
  | "TERRITORY"
  // The contract being renewed, or not renewed
  | "CONTRACT_DATE"
  | "CONTRACT_START_DATE"
  | "CONTRACT_END_DATE"
  | "ORIGINAL_HIRE_DATE"
  // The new term
  | "RENEWAL_DURATION"
  | "RENEWAL_START_DATE"
  | "RENEWAL_END_DATE"
  | "OBJECTIVE_REASON"
  // Pay during the new term
  | "SALARY_FIGURES"
  | "SALARY_WORDS"
  | "INSURANCE_WAGE"
  // The notice's own dates
  | "NOTICE_DATE"
  | "LAST_WORKING_DATE";

/** One labelled box in the identity grid at the head of either paper. */
export type RenewalField = {
  labelAr: string;
  /** The token whose value fills it. Null prints a ruled blank — a box a pen completes. */
  token: RenewalToken | null;
  /** Latin digits: a national ID, an employee code, a date. See `fieldValue` in the renderer. */
  ltr?: boolean;
  /** Takes the whole row instead of sharing it. */
  wide?: boolean;
};

/** One numbered article of the annex. */
export type RenewalArticle = {
  /** The article label exactly as printed — "مادة (1)". */
  number: string;
  /** The article's own heading. Null on an untitled article. */
  titleAr: string | null;
  /** The clause. Carries `{{TOKEN}}` markers only where the paper leaves a blank. */
  body: string;
};

/** One column of the signature block. */
export type RenewalSignatureColumn = {
  headingAr: string;
  fieldsAr: readonly string[];
};

/** One complete, printable version of one of the two renewal papers. */
export type RenewalTemplate = {
  /**
   * Stable identity, unique across every document this system prints.
   *
   * NEVER RENAME OR REUSE ONE. A reprint resolves the version through it, so an id that changes
   * meaning reprints somebody's annex as a document they never saw, with no error anywhere.
   */
  id: string;
  variant: RenewalVariant;
  version: number;
  titleAr: string;
  subtitleAr: string;
  /** Who keeps this copy, printed in the letterhead's own band. */
  purposeAr: string;
  /** The line that binds the annex to its contract — «ولا يُقرأ ولا يُفسَّر إلا معه». */
  bindingLineAr: string | null;
  /** The company recital, stated in this paper's own words. */
  firstPartyHeadingAr: string;
  firstPartyLinesAr: readonly string[];
  /** The employee, as a labelled grid rather than prose — this is a form, not a contract. */
  secondPartyHeadingAr: string;
  secondPartyFields: readonly RenewalField[];
  preambleHeadingAr: string | null;
  preambleAr: string | null;
  /** The numbered articles. Empty on the notice, which is a letter and has none. */
  articles: readonly RenewalArticle[];
  /** The letter's paragraphs. Empty on the annex, whose body is its articles. */
  bodyParagraphsAr: readonly string[];
  /** The pay-and-posting grid, on the annex. Empty on the notice, which changes neither. */
  termsHeadingAr: string | null;
  termsFields: readonly RenewalField[];
  signaturesHeadingAr: string;
  signatureColumns: readonly RenewalSignatureColumn[];
  /**
   * Lines naming who signs for the company, printed under its column.
   *
   * The same apparatus the contract grew in version 4: the signatory is not a constant, because a
   * delegate sometimes signs, and an instrument naming one person in its recital and another over
   * the signature line is defective.
   */
  signatoryNoteLinesAr: readonly string[];
  /** The employee's separate line acknowledging he was handed a copy. */
  receiptAcknowledgmentAr: string;
  /** The refusal-to-sign protocol, on the notice. Empty on the annex, which is signed by agreement. */
  witnessNoteAr: string | null;
  witnessFields: readonly RenewalField[];
  /** The running footer. */
  footerAr: string;
};

/** The dotted rule an absent value prints as. Matches the contract's, so the two papers agree. */
export const RENEWAL_BLANK_RULE = "……………………";

/** A wider rule, for a box that takes a sentence rather than a value. */
export const RENEWAL_BLANK_RULE_WIDE = "………………………………………………………………";

/**
 * Substitute the blanks.
 *
 * An absent value becomes a dotted rule, NOT an empty string — the same rule the contract follows
 * and for the same reason: an instrument that silently closes up around a missing date reads as
 * complete, and a reader has no way to see that something was dropped. A visible run of dots is
 * what the paper form gives, and it survives photocopying.
 */
export function fillRenewalTokens(
  template: string,
  values: Partial<Record<RenewalToken, string | null | undefined>>,
): string {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (whole, token: string) => {
    const value = values[token as RenewalToken];
    const text = typeof value === "string" ? value.trim() : "";
    return text.length > 0 ? text : RENEWAL_BLANK_RULE;
  });
}

/** Every string in a version that can carry a token, so a caller can sweep the whole document. */
export function renewalTemplateStrings(template: RenewalTemplate): string[] {
  return [
    template.titleAr,
    template.subtitleAr,
    template.purposeAr,
    template.bindingLineAr,
    template.firstPartyHeadingAr,
    ...template.firstPartyLinesAr,
    template.secondPartyHeadingAr,
    ...template.secondPartyFields.map((field) => field.labelAr),
    template.preambleHeadingAr,
    template.preambleAr,
    ...template.articles.flatMap((article) => [article.number, article.titleAr, article.body]),
    ...template.bodyParagraphsAr,
    template.termsHeadingAr,
    ...template.termsFields.map((field) => field.labelAr),
    template.signaturesHeadingAr,
    ...template.signatureColumns.flatMap((column) => [column.headingAr, ...column.fieldsAr]),
    ...template.signatoryNoteLinesAr,
    template.receiptAcknowledgmentAr,
    template.witnessNoteAr,
    ...template.witnessFields.map((field) => field.labelAr),
    template.footerAr,
  ].filter((value): value is string => typeof value === "string");
}

/**
 * Every distinct token a version actually uses — in its prose AND in its field grids.
 *
 * Returned as raw strings rather than `RenewalToken[]` on purpose: the point of calling this is to
 * find a token that is NOT in the union, and typing the return as the union would assert away the
 * very thing being checked.
 */
export function renewalTemplateTokens(template: RenewalTemplate): string[] {
  const found = new Set<string>();
  for (const text of renewalTemplateStrings(template)) {
    for (const match of text.matchAll(/\{\{([A-Z_]+)\}\}/g)) found.add(match[1]);
  }
  // A grid field carries its token in a field rather than in `{{...}}`, so a sweep of the prose
  // alone would report a document using half the tokens it actually prints.
  for (const field of [
    ...template.secondPartyFields,
    ...template.termsFields,
    ...template.witnessFields,
  ]) {
    if (field.token) found.add(field.token);
  }
  return [...found].sort();
}
