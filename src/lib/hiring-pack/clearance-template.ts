/**
 * The shape of the two clearance papers — إخلاء طرف.
 *
 * THEY RUN IN OPPOSITE DIRECTIONS, and that is the whole reason there are two of them. It is easy
 * to read the pair as one document printed twice; it is not.
 *
 *   • إخلاء طرف موظف — the COMPANY certifies the EMPLOYEE is clear. Seven departments sign it, HR
 *     signs it, the company stamps it, and the employee walks out with it. It is his proof that
 *     nothing is outstanding against him.
 *   • إخلاء طرف شركة — the EMPLOYEE certifies the COMPANY is clear. He acknowledges receiving his
 *     final settlement and his original papers, and releases the company from further claim. It
 *     stays in his personnel file.
 *
 * So each one protects the party who does NOT keep it, and mixing them up hands each side the
 * wrong protection. The keeper is printed on the paper itself, in a strip under the masthead, for
 * exactly that reason.
 *
 * WHY A BLOCK LIST RATHER THAN A FIXED SET OF SECTIONS. The two forms share a masthead, a company
 * recital, an employee-details block and a signature row, and then diverge completely: one carries
 * a six-row departmental sign-off table, the other an amount-received block and four numbered
 * undertakings. Modelling the middle as an ordered list of typed blocks lets both be described
 * without either carrying empty fields belonging to the other — and lets a third clearance form,
 * if one ever arrives, be added as data rather than as a branch in the renderer.
 */

/** Which of the pair this is, and therefore who keeps it. */
export type ClearanceVariant = "employeeKeeps" | "companyKeeps";

/**
 * The values Phoenix fills in.
 *
 * Note what is ABSENT: the settlement amount. See `ClearanceField.token` below — that omission is
 * the most important decision in this file.
 */
export type ClearanceToken =
  | "COMPANY_NAME"
  | "COMPANY_LEGAL_FORM"
  | "COMMERCIAL_REGISTER"
  | "COMMERCIAL_REGISTER_OFFICE"
  | "UNIFIED_REGISTER"
  | "TAX_CARD"
  | "COMPANY_HEAD_OFFICE_FULL"
  | "EMPLOYEE_NAME"
  | "NATIONAL_ID"
  | "JOB_TITLE"
  | "DEPARTMENT"
  | "HIRE_DATE"
  | "LAST_WORKING_DATE"
  | "ADDRESS";

/**
 * One labelled box.
 *
 * `token` null prints a rule for the pen, and every null here is a decision rather than a gap:
 *
 *   • THE SETTLEMENT AMOUNT IS NEVER AUTO-FILLED, on either form, in figures or in words. The
 *     company's copy is a release of claims — the employee signs that the figure printed on it
 *     settles everything owed to him — so a wrong number there is not a typo, it is a signed
 *     waiver of money he is still owed. Phoenix does not compute a final settlement (the clearance
 *     module says so in its own words: it "may not approve final settlement"), and printing a
 *     figure from anywhere else would lend it an authority it does not have.
 *   • THE REASON-FOR-LEAVING BOXES are left for the pen because the paper's four options
 *     (استقالة / انتهاء مدة العقد / إنهاء من الشركة / أخرى) are a different vocabulary from the two
 *     routes Phoenix records. A mutual termination is none of the four, so ticking one from the
 *     other model would assert a legal basis nobody chose.
 *   • THE DEPARTMENTAL SIGN-OFFS need a wet signature per desk whatever the app knows.
 *
 * `fixedAr` is standing text printed in place of a rule — the tick-box menus.
 *
 * `ltr` pins a Latin/digit run left-to-right inside the right-to-left line. The Word original does
 * the same with U+202A/U+202C embedding controls, visible in its own markup around every number.
 * Without it the bidirectional algorithm reorders the digit groups: this company's own tax card
 * `477-108-318` has already printed as `318-108-477` once.
 */
export type ClearanceField = {
  labelAr: string;
  token: ClearanceToken | null;
  fixedAr: string | null;
  /** Spans the full width instead of sharing a row — an address, or a menu of tick-boxes. */
  wide: boolean;
  ltr: boolean;
};

/** One department on the sign-off table, and what it is signing for. */
export type ClearanceStationRow = {
  number: string;
  departmentAr: string;
  scopeAr: string;
};

/** One numbered undertaking on the company's copy. */
export type ClearanceClause = {
  number: string;
  body: string;
};

/** A signature column, and the line saying what that signature means. */
export type ClearanceSignatureColumn = {
  headingAr: string;
};

export type ClearanceBlock =
  | { kind: "fields"; headingAr: string; fields: readonly ClearanceField[] }
  | {
      kind: "stations";
      headingAr: string;
      columnsAr: readonly string[];
      rows: readonly ClearanceStationRow[];
    }
  | { kind: "clauses"; headingAr: string; clauses: readonly ClearanceClause[] }
  | { kind: "prose"; headingAr: string | null; paragraphs: readonly string[] };

export type ClearanceTemplate = {
  /** Registry id — `clearance-employee-v1`, `clearance-company-v1`. */
  id: string;
  version: number;
  variant: ClearanceVariant;

  titleAr: string;
  subtitleAr: string;
  /** The strip under the masthead naming who keeps this copy. The point of the whole pair. */
  keeperAr: string;

  blocks: readonly ClearanceBlock[];
  closingAr: string | null;
  signatureColumns: readonly ClearanceSignatureColumn[];
};

/** What a box prints when nobody has supplied its value. Matches the Word original's two widths. */
export const CLEARANCE_BLANK_RULE = "................................";
export const CLEARANCE_BLANK_RULE_WIDE = "...............................................................";

/**
 * Every string a template prints, flattened in printed order.
 *
 * Walks the STRUCTURE rather than reading the file, so reformatting, a comment edit or a TypeScript
 * rename all leave the fingerprint alone and only a change to the printed Arabic moves it — which
 * is the thing worth pinning, because these are papers somebody signs. Byte-window pinning of a
 * source file has false-failed in this repo before, the moment anything above the window moved.
 */
export function clearanceTemplateStrings(template: ClearanceTemplate): string[] {
  const out: string[] = [template.titleAr, template.subtitleAr, template.keeperAr];
  for (const block of template.blocks) {
    if (block.headingAr) out.push(block.headingAr);
    if (block.kind === "fields") {
      // A label and its standing text are pushed SEPARATELY, never joined. They are printed in two
      // different elements, so a joined string is a string that appears nowhere on the page — and a
      // test asserting each entry reaches paper would then be asserting something that can only be
      // satisfied by accident.
      for (const field of block.fields) {
        out.push(field.labelAr);
        if (field.fixedAr) out.push(field.fixedAr);
      }
    } else if (block.kind === "stations") {
      out.push(...block.columnsAr);
      for (const row of block.rows) {
        out.push(row.departmentAr);
        out.push(row.scopeAr);
      }
    } else if (block.kind === "clauses") {
      for (const clause of block.clauses) {
        out.push(clause.number);
        out.push(clause.body);
      }
    } else {
      out.push(...block.paragraphs);
    }
  }
  if (template.closingAr) out.push(template.closingAr);
  out.push(...template.signatureColumns.map((column) => column.headingAr));
  return out;
}

/** Every token a template actually uses, sorted — pinned per form by the tests. */
export function clearanceTemplateTokens(template: ClearanceTemplate): ClearanceToken[] {
  const used = new Set<ClearanceToken>();
  for (const block of template.blocks) {
    if (block.kind !== "fields") continue;
    for (const field of block.fields) if (field.token) used.add(field.token);
  }
  return [...used].sort();
}
