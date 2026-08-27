/**
 * Every `{{placeholder}}` a template may use.
 *
 * ── Why this file exists ──
 * The tokens were real long before this catalogue was: `buildOfferTokens` has always produced them
 * and `fillOfferTokens` has always substituted them. What did not exist was any way to FIND OUT
 * they existed. Somebody editing a letter in the designer had to already know that the monthly
 * basic is spelled `basicMonthly` and not `monthlyBasic`, `basic_monthly` or `basicSalary` — and
 * nothing on the screen told them. A feature nobody can discover is a feature nobody uses.
 *
 * ── Why a misspelling is worse here than in most places ──
 * `fillOfferTokens` deliberately leaves an unknown token STANDING rather than blanking it, so a
 * mistyped `{{reprotsTo}}` prints as those literal characters. That is the right call — a silent
 * hole in a legally binding document is far worse than a visible one — but it only helps if
 * somebody looks. This catalogue is what lets the designer flag the typo at editing time, before a
 * candidate is the one who spots it.
 *
 * ── The one rule ──
 * This list and `buildOfferTokens` must agree EXACTLY, in both directions.
 *   - A token the builder produces but this list omits is invisible: nobody can find it.
 *   - An entry here with no matching token prints literally, and the picker actively hands the
 *     designer a broken placeholder.
 * `tests/offer-placeholders.test.ts` compares the two sets and fails on either kind of drift, so
 * adding a token to the builder without describing it here cannot merge.
 */

export type OfferPlaceholderGroup = "Candidate" | "Company" | "Dates" | "Money" | "Role";

export type OfferPlaceholder = {
  group: OfferPlaceholderGroup;
  /** The token name WITHOUT braces — `basicMonthly`, not `{{basicMonthly}}`. */
  key: string;
  /** What it is, in the words HR would use. */
  label: string;
  /** Where the value comes from. Shown under the label so nobody has to guess. */
  note: string;
};

/** The order the designer lists them in — inputs first, derived money last. */
export const OFFER_PLACEHOLDER_GROUPS: OfferPlaceholderGroup[] = [
  "Candidate",
  "Role",
  "Dates",
  "Money",
  "Company",
];

export const OFFER_PLACEHOLDERS: OfferPlaceholder[] = [
  // ── Candidate ──────────────────────────────────────────────────────────────────────────────
  {
    group: "Candidate",
    key: "candidateName",
    label: "Full name",
    note: "As typed on the offer. Used where the letter needs the legal name.",
  },
  {
    group: "Candidate",
    key: "salutationName",
    label: "Name in the greeting",
    note: "How the letter addresses them — \"Dr Samaa Shalaby\". Not always the legal name.",
  },
  {
    group: "Candidate",
    key: "candidateEmail",
    label: "Email address",
    note: "Where the offer is sent. Rarely printed, but available.",
  },
  {
    group: "Candidate",
    key: "initials",
    label: "Initials",
    note: "Derived from the full name — first and last word only, so a three-part name still fits the disc.",
  },

  // ── Role ───────────────────────────────────────────────────────────────────────────────────
  { group: "Role", key: "title", label: "Job title", note: "The position being offered." },
  { group: "Role", key: "territory", label: "Territory", note: "The area or district the role covers." },
  { group: "Role", key: "reportsTo", label: "Reports to", note: "The manager's title, not their name." },
  {
    group: "Role",
    key: "contractTerm",
    label: "Contract term",
    note: "\"One year, renewable\" — free text, so it can say whatever the contract says.",
  },
  {
    group: "Role",
    key: "reference",
    label: "Offer reference",
    note: "The letter's own reference number.",
  },

  // ── Dates ──────────────────────────────────────────────────────────────────────────────────
  { group: "Dates", key: "dateOfIssue", label: "Date of issue", note: "The date printed on the letter." },
  {
    group: "Dates",
    key: "validUntil",
    label: "Offer valid until",
    note: "After this date the offer lapses. Printed in the control strip.",
  },
  { group: "Dates", key: "startDate", label: "Start date", note: "First day of employment." },

  // ── Money ──────────────────────────────────────────────────────────────────────────────────
  // Every one of these is DERIVED. Whoever writes the offer types the total package and the cost of
  // living; basic, transport and all six annual/monthly figures compute from those two. That is the
  // "smart fields" the owner asked for, and it is why no template should ever hard-code a number.
  {
    group: "Money",
    key: "totalMonthly",
    label: "Total package, monthly",
    note: "The one figure that is typed. Everything else below is calculated from it.",
  },
  { group: "Money", key: "totalAnnual", label: "Total package, annual", note: "Total monthly × 12." },
  {
    group: "Money",
    key: "basicMonthly",
    label: "Basic salary, monthly",
    note: "Derived from the total package. Never type this.",
  },
  { group: "Money", key: "basicAnnual", label: "Basic salary, annual", note: "Basic monthly × 12." },
  {
    group: "Money",
    key: "transportMonthly",
    label: "Transport allowance, monthly",
    note: "Derived from the total package. Never type this.",
  },
  {
    group: "Money",
    key: "transportAnnual",
    label: "Transport allowance, annual",
    note: "Transport monthly × 12.",
  },
  {
    group: "Money",
    key: "costOfLivingMonthly",
    label: "Cost of living, monthly",
    note: "Comes from the job title's own figure, and can be overridden per offer.",
  },
  {
    group: "Money",
    key: "costOfLivingAnnual",
    label: "Cost of living, annual",
    note: "Cost of living monthly × 12.",
  },

  // ── Company ────────────────────────────────────────────────────────────────────────────────
  // Read from the same `systemLegalEntity` the employment contract and Form 1 read, never retyped.
  // A candidate who receives an offer naming one entity and a contract naming another has a real
  // reason to ask what they are signing.
  {
    group: "Company",
    key: "companyName",
    label: "Company name",
    note: "The legal entity in English, shared with the contract and Form 1.",
  },
  {
    group: "Company",
    key: "companyNameAr",
    label: "Company name (Arabic)",
    note: "The legal entity as it appears on Arabic paperwork.",
  },
  {
    group: "Company",
    key: "companyAddress",
    label: "Head office address",
    note: "The registered head office, as printed on the contract.",
  },
];

/** Fast membership test for the designer's unknown-placeholder check. */
export const OFFER_PLACEHOLDER_KEYS: ReadonlySet<string> = new Set(
  OFFER_PLACEHOLDERS.map((placeholder) => placeholder.key),
);

/**
 * Every `{{token}}` written anywhere in a block's props, with no matching placeholder.
 *
 * Walks props recursively because the repeatable lists (clauses, benefits, steps, salary rows) hold
 * their text one level down — a check that only looked at top-level string props would miss the
 * body of every clause, which is most of the letter's words.
 */
export function unknownOfferPlaceholders(value: unknown, found: Set<string> = new Set()): string[] {
  if (typeof value === "string") {
    for (const match of value.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)) {
      const key = match[1];
      if (key && !OFFER_PLACEHOLDER_KEYS.has(key)) found.add(key);
    }
  } else if (Array.isArray(value)) {
    for (const entry of value) unknownOfferPlaceholders(entry, found);
  } else if (value && typeof value === "object") {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      unknownOfferPlaceholders(entry, found);
    }
  }
  return [...found].sort();
}
