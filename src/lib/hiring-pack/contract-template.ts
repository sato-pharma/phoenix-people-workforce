/**
 * The SHAPE of an employment contract, shared by every version of it.
 *
 * Split out of `contract-text.ts` on 2026-08-30, when the owner replaced the contract with a
 * redrafted one and asked that the old text be archived rather than deleted: "make the other
 * contract go to archived instead of removing it from system … and any paper I replace, it goes to
 * the archive."
 *
 * So there is no longer "the contract text" — there are contract VERSIONS, one of them current and
 * the rest archived, and this file describes what any of them looks like. The legal Arabic lives in
 * `contract-text-v1.ts` and `contract-text-v2.ts`; `contract-text.ts` is the registry over them.
 *
 * WHY A SHAPE RATHER THAN TWO RENDERERS. The two versions are laid out differently — v1 is prose
 * with a run-in opening line, v2 is a banded table with a title panel, party bands and a two-column
 * signature block — and the tempting shortcut is a renderer per version. That ends with the archived
 * version's renderer rotting quietly until the day somebody reprints a contract signed in 2025 and
 * gets a broken page. One shape, one renderer, a `layout` discriminator: both versions stay alive
 * because both are exercised by the same code.
 */

/**
 * How a version is laid out on the page.
 *
 * `prose` — v1: a run-in opening sentence, the parties as numbered paragraphs, articles as a
 * continuous flow. `banded` — v2: a navy title panel, the parties in a bordered table under blue
 * heading bands, and the articles in a two-column grid with the article number and title in the
 * narrow column. Both are A4 and both are right-to-left; the difference is furniture, not language.
 */
export type ContractLayout = "prose" | "banded";

/**
 * Every token any version of the contract can carry.
 *
 * The union is the SUPERSET across versions, not the intersection: v1 opens with a day name that v2
 * has no line for, and v2's recital states four company registration facts that v1 never mentioned.
 * Keeping one union means `fillContractTokens` takes one value bag whichever version is printing,
 * and a version referencing a token that is not here fails its test rather than printing the literal
 * `{{SOMETHING}}` onto a signature page.
 */
export type ContractToken =
  // The occasion
  | "DAY_NAME"
  | "CONTRACT_DATE"
  // The company
  //
  // FOUR OF THESE COME IN PAIRS, AND THE PAIRS ARE NOT REDUNDANT. The head office and the person who
  // signs are each stated differently by different versions of the contract — v1 gives the address
  // in the short form and names the signatory by his social-insurance designation ("المدير
  // المسئول"), v2 gives the full unit-and-building address and names him by his company office
  // ("المدير العام والممثل القانوني للشركة"). Feeding one value into both would be the obvious
  // simplification and it is the one thing the archive exists to prevent: it would reprint a
  // contract signed against v1 with wording that was not on the page anybody signed.
  | "COMPANY_NAME"
  | "COMPANY_LEGAL_FORM"
  | "COMPANY_HEAD_OFFICE"
  | "COMPANY_HEAD_OFFICE_FULL"
  | "COMPANY_CITY"
  | "COMPANY_BRANCH_REGISTRY"
  | "COMMERCIAL_REGISTER"
  | "COMMERCIAL_REGISTER_OFFICE"
  | "UNIFIED_REGISTER"
  | "TAX_CARD"
  | "RESPONSIBLE_MANAGER"
  | "RESPONSIBLE_MANAGER_TITLE"
  | "CONTRACT_SIGNATORY"
  | "CONTRACT_SIGNATORY_TITLE"
  // The person
  | "EMPLOYEE_NAME"
  | "NATIONALITY"
  | "QUALIFICATION"
  | "BIRTH_DATE"
  | "BIRTH_PLACE"
  | "NATIONAL_ID"
  | "INSURANCE_NUMBER"
  | "ADDRESS"
  | "PHONE"
  | "EMAIL"
  // The engagement
  | "JOB_TITLE"
  | "DEPARTMENT"
  | "SALARY_FIGURES"
  | "SALARY_WORDS"
  | "INSURANCE_WAGE"
  | "DURATION"
  | "START_DATE"
  | "UNDERPERFORMANCE_PCT"
  | "UNDERPERFORMANCE_MONTHS"
  | "TRAINING_BOND";

/** One numbered article. `titleAr` is null on versions whose articles are numbered but untitled. */
export type ContractArticle = {
  /** The article label exactly as printed — "مادة (1)". */
  number: string;
  /** The article's own heading, where the version has them. v1 has none; v2 titles all nineteen. */
  titleAr: string | null;
  /** The clause. Carries `{{TOKEN}}` markers only where the paper form leaves a blank. */
  body: string;
};

/**
 * One column of the signature block.
 *
 * `fieldsAr` is the list of labelled rules a pen fills — "الاسم /", "التوقيع /". It is empty on a
 * version whose signature block is just headings over open space, which is what v1's is. Empty is
 * therefore meaningful and not a gap: it says this version asks for a signature and nothing else.
 */
export type ContractSignatureColumn = {
  headingAr: string;
  fieldsAr: readonly string[];
};

/** One complete, printable version of the employment contract. */
export type ContractTemplate = {
  /**
   * Stable identity, written onto the employee row when a contract is signed.
   *
   * NEVER REUSE OR RENUMBER ONE. It is the only record of which text a person actually put their
   * name to, and a reprint resolves the version through it — so changing an id silently reprints
   * somebody's contract as a document they never saw.
   */
  id: string;
  version: number;
  layout: ContractLayout;
  titleAr: string;
  subtitleAr: string;
  /** A run-in opening sentence, on versions that have one. */
  openingAr: string | null;
  /** Band headings over each party's details, on versions that separate them that way. */
  firstPartyHeadingAr: string | null;
  firstPartyLinesAr: readonly string[];
  secondPartyHeadingAr: string | null;
  secondPartyLinesAr: readonly string[];
  preambleHeadingAr: string;
  preambleAr: string;
  articles: readonly ContractArticle[];
  /** The closing "تحريرًا في … بمدينة …" line, on versions that date the contract at the end. */
  closingAr: string | null;
  signatureColumns: readonly ContractSignatureColumn[];
  /** The running footer, on versions that carry one. */
  footerAr: string | null;
};

/** The dotted rule an absent value prints as. Long enough to be seen, short enough to sit in a line. */
export const CONTRACT_BLANK_RULE = "……………………";

/**
 * Substitute the blanks.
 *
 * An absent value becomes a dotted rule of the paper form's own length, NOT an empty string. That
 * is deliberate: a contract that silently closes up around a missing salary reads as complete, and
 * a reader has no way to see that something was dropped. A visible run of dots is the same signal
 * the paper version gives, and it survives photocopying.
 */
export function fillContractTokens(
  template: string,
  values: Partial<Record<ContractToken, string | null | undefined>>,
): string {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (whole, token: string) => {
    const value = values[token as ContractToken];
    const text = typeof value === "string" ? value.trim() : "";
    return text.length > 0 ? text : CONTRACT_BLANK_RULE;
  });
}

/** Every string in a version that can carry a token, so a caller can sweep the whole document. */
export function contractTemplateStrings(template: ContractTemplate): string[] {
  return [
    template.titleAr,
    template.subtitleAr,
    template.openingAr,
    template.firstPartyHeadingAr,
    ...template.firstPartyLinesAr,
    template.secondPartyHeadingAr,
    ...template.secondPartyLinesAr,
    template.preambleHeadingAr,
    template.preambleAr,
    ...template.articles.flatMap((article) => [article.number, article.titleAr, article.body]),
    template.closingAr,
    ...template.signatureColumns.flatMap((column) => [column.headingAr, ...column.fieldsAr]),
    template.footerAr,
  ].filter((value): value is string => typeof value === "string");
}

/**
 * Every distinct token a version actually uses.
 *
 * Returned as raw strings rather than `ContractToken[]` on purpose: the point of calling this is to
 * find a token that is NOT in the union, and typing the return as the union would assert away the
 * very thing being checked.
 */
export function contractTemplateTokens(template: ContractTemplate): string[] {
  const found = new Set<string>();
  for (const text of contractTemplateStrings(template)) {
    for (const match of text.matchAll(/\{\{([A-Z_]+)\}\}/g)) found.add(match[1]);
  }
  return [...found].sort();
}
