/**
 * One pharmacy, written two ways.
 *
 * WHAT WENT WRONG. A rep registers a marketing customer against the distributor's pharmacy code as
 * they read it off the invoice — `1548234`. Source of Sales stores that same pharmacy zero-padded
 * to ten digits — `0001548234`. The sales-evidence panel matched the two as exact text, found
 * nothing, and then told the approver, in red, that the absence was MEANINGFUL: "No sales have ever
 * been recorded against this customer's pharmacy code. This is an unproven customer, not missing
 * data." The customer had in fact bought EGP 8,981 across 29 invoices, including the very product
 * the request was promoting. Measured on production 2026-08-19: 8 of 304 registered codes, hiding
 * EGP 208,247.89 of real trade, every one of them reading as a hard zero.
 *
 * WHY LEADING ZEROS ARE SAFE TO IGNORE. Source of Sales itself stores both forms. Every code whose
 * digits collide once the leading zeros come off resolves to the SAME pharmacy written twice
 * (`0001503390` | `1503390`, and ~hundreds more) — there is no pair where the padding distinguishes
 * two different customers. So the zeros are formatting, not identity, and folding them together
 * cannot credit one pharmacy's sales to another. That was checked against the live table before
 * this file existed; do not relax it to a numeric cast, which would also fold `1234` into `01234`
 * for a non-numeric scheme if one is ever introduced.
 *
 * WHY FORMS AND NOT NORMALIZATION. The obvious fix is to strip zeros on both sides and compare, but
 * the sales side is matched with a PostgREST `.in("client_code", …)` against a stored column — there
 * is no place to put an expression. So the lookup expands to every spelling the same pharmacy could
 * carry, and the query stays a plain indexed IN.
 *
 * Non-numeric codes pass through untouched: two of the registered codes are not digits at all, and
 * padding those would invent a code nobody holds.
 */

/** The width Source of Sales pads numeric pharmacy codes to. */
const PADDED_WIDTH = 10;

/** Trim and upper-case, the way every caller stored it. */
export function normalizePharmacyCode(value: string | null | undefined): string {
  return String(value ?? "").trim().toUpperCase();
}

/**
 * Every spelling of one pharmacy code that could appear in a sales row.
 *
 * Returns the code as entered, its bare form with leading zeros removed, and that bare form padded
 * back to ten digits — deduplicated and sorted so the query is stable. A non-numeric or empty code
 * returns just itself, so nothing is invented.
 */
export function pharmacyCodeLookupForms(value: string | null | undefined): string[] {
  const code = normalizePharmacyCode(value);
  if (!code) return [];
  if (!/^\d+$/.test(code)) return [code];

  const bare = code.replace(/^0+/, "");
  // An all-zero code strips to nothing. Keep the original rather than emitting an empty lookup that
  // would match every row with a blank client_code.
  if (!bare) return [code];

  const forms = new Set<string>([code, bare]);
  if (bare.length < PADDED_WIDTH) forms.add(bare.padStart(PADDED_WIDTH, "0"));
  return [...forms].sort();
}

/** The lookup forms for a whole set of registered codes, deduplicated across them. */
export function pharmacyCodeLookupSet(values: Iterable<string | null | undefined>): string[] {
  const forms = new Set<string>();
  for (const value of values) {
    for (const form of pharmacyCodeLookupForms(value)) forms.add(form);
  }
  return [...forms].sort();
}
