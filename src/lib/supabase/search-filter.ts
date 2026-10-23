/** Free-text search filters for PostgREST `or(...)` expressions.
 *
 * `or("col.ilike.%TERM%")` splices TERM straight into PostgREST's filter grammar, where `,` and
 * `()` are structural. A term containing either one terminates the value early and every condition
 * after it is silently discarded — the request still returns HTTP 200, just against a filter nobody
 * wrote. The historic workaround was to strip those characters, which makes the query safe and
 * simultaneously unable to find the rows it exists to find.
 *
 * Measured against production PostgREST on 2026-08-31, searching the customer map for the pharmacy
 * `ابن القيم(حسام حسن)`:
 *
 * | term spliced in raw (what shipped)     | 0 rows — the `)` truncated the filter |
 * | parentheses stripped (the obvious fix) | 0 rows — the pattern no longer matches the name |
 * | double-quoted, as below                | 1 row — customer_code 22199106 |
 *
 * 787 customer names contain a parenthesis, so stripping is not a cosmetic loss.
 *
 * PostgREST accepts a DOUBLE-QUOTED filter value. Inside the quotes `,` `(` `)` lose all structural
 * meaning and only `"` and `\` need escaping — with a backslash, not by SQL-style doubling. Every
 * hostile input probed against production (`)`, `()`, `,`, `"`, `\`, and combinations) returned
 * HTTP 200/206 and matched literally, with no parse error on any of them.
 */

/** `%` and `*` are wildcards, not searchable text, and PostgREST exposes no `ESCAPE` clause for
 * `ilike` — so a literal `%` cannot be matched and is replaced with a space rather than passed
 * through. Left alone it is actively harmful: a lone `%` matched all 66,109 active customer rows,
 * the exact opposite of narrowing. `*` gets the same treatment because PostgREST translates it to
 * `%` inside an `ilike` pattern, so a product code like `B*12` silently became a wildcard.
 *
 * `_` is deliberately NOT neutralised. It matches any single character, so a term containing one
 * yields a superset that still includes the literal row — a search for `AB_12` finds `AB_12`.
 * Blanking it would break every identifier that legitimately contains an underscore. */
const WILDCARD_CHARS = /[%*]/g;

/** Escape a value for use inside a double-quoted PostgREST filter, and wrap it in those quotes.
 * Backslash first, then the quote — reversing the order would re-escape the backslashes just added. */
export function quotePostgrestValue(value: string): string {
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/** Build the argument for `.or(...)`: `term` matched case-insensitively against every column.
 *
 * Returns an empty string when the term has no searchable content left, which callers must treat as
 * "apply no filter" — passing `""` to `.or()` is a 400. */
export function ilikeAnyFilter(columns: readonly string[], term: string): string {
  const cleaned = String(term ?? "").replace(WILDCARD_CHARS, " ").trim();
  if (!cleaned || columns.length === 0) return "";
  const value = quotePostgrestValue(`%${cleaned}%`);
  return columns.map((column) => `${column}.ilike.${value}`).join(",");
}

/** A quoted `ilike` value that matches `term` as typed (wildcards neutralised as above), for an
 * identifier column — an HR id, a login id, an email. Null when nothing searchable is left, which
 * callers treat as "no match", never as "no filter". */
export function ilikeExactValue(term: string): string | null {
  const cleaned = String(term ?? "").replace(WILDCARD_CHARS, " ").trim();
  return cleaned ? quotePostgrestValue(cleaned) : null;
}

/** A quoted `ilike` value that matches rows CONTAINING `term`. Null when nothing searchable is left. */
export function ilikeContainsValue(term: string): string | null {
  const cleaned = String(term ?? "").replace(WILDCARD_CHARS, " ").trim();
  return cleaned ? quotePostgrestValue(`%${cleaned}%`) : null;
}
