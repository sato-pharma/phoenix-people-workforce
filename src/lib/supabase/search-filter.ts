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

/** What is left of a typed term once the wildcards are neutralised — null when nothing is.
 *
 * THE ONE PLACE THAT RULE IS APPLIED. Every builder below goes through it, so a call site cannot
 * acquire its own private idea of what a searchable term is; a caller that needs a minimum length
 * measures the value this returns rather than re-implementing the cleaning to measure it. */
export function searchableTerm(term: string | null | undefined): string | null {
  const cleaned = String(term ?? "").replace(WILDCARD_CHARS, " ").trim();
  return cleaned || null;
}

/** Build the argument for `.or(...)`: `term` matched case-insensitively against every column.
 *
 * Returns an empty string when the term has no searchable content left, which callers must treat as
 * "apply no filter" — passing `""` to `.or()` is a 400. */
export function ilikeAnyFilter(columns: readonly string[], term: string): string {
  const cleaned = searchableTerm(term);
  if (!cleaned || columns.length === 0) return "";
  const value = quotePostgrestValue(`%${cleaned}%`);
  return columns.map((column) => `${column}.ilike.${value}`).join(",");
}

/** A quoted `ilike` value that matches `term` as typed (wildcards neutralised as above), for an
 * identifier column — an HR id, a login id, an email. Null when nothing searchable is left, which
 * callers treat as "no match", never as "no filter". */
export function ilikeExactValue(term: string): string | null {
  const cleaned = searchableTerm(term);
  return cleaned ? quotePostgrestValue(cleaned) : null;
}

/** A quoted `ilike` value that matches rows CONTAINING `term`. Null when nothing searchable is left. */
export function ilikeContainsValue(term: string): string | null {
  const cleaned = searchableTerm(term);
  return cleaned ? quotePostgrestValue(`%${cleaned}%`) : null;
}

/** One arm of an `.or(...)` expression — `column.operator."value"` — with the value quoted.
 *
 * For a value that is NOT free text: an HR id, a login id, a uuid, a national id, a mobile number.
 * Those reach the filter already normalised, so they need no wildcard rule — but normalising is not
 * validating. `canonicalHrIdKey` in `src/lib/hr-id.ts`, which every HR id passes through, trims,
 * lower-cases and maps aliases; it guarantees NO character set, so a comma or a parenthesis stored
 * in or typed into one of these columns would otherwise end the clause early and silently hand
 * PostgREST a filter nobody wrote. Quoting is the whole fix, and it is the same quoting as above.
 *
 * `%` is left intact deliberately: the caller supplies it (see the `contains` identity filters in
 * payroll), and these filters only ever NARROW a set the viewer may already see. */
export function quotedOrClause(column: string, operator: "eq" | "ilike", value: string): string {
  return `${column}.${operator}.${quotePostgrestValue(value)}`;
}

/** The body of a PostgREST `in.(…)` list of TEXT values, each one quoted.
 *
 * Numbers must NOT come through here — a quoted numeric is still matched, but three copies of this
 * list builder existed before this helper (CRM reads, Direct Orders, the hiring-manager notify) and
 * a fourth was hand-rolled inline with no escaping at all. One copy, one rule. */
export function quotedInList(values: readonly string[]): string {
  return values.map((value) => quotePostgrestValue(String(value))).join(",");
}

/** The same CONTAINS pattern for supabase-js's own `.ilike(column, pattern)` method, which is NOT
 * the same transport and so must NOT be quoted.
 *
 * `.or("col.ilike.VALUE")` hands PostgREST one expression to parse, where `,` and `()` are
 * structural and double quotes are the escape hatch. `.ilike(col, pattern)` sends the pattern as
 * its own URL-encoded query parameter — nothing in it is structural, and the double quotes
 * `quotePostgrestValue` adds would be matched as two literal characters of the pharmacy's name,
 * finding nothing. The two functions therefore differ ONLY in the quoting their transport demands,
 * and sharing one wildcard rule between them is the whole point of this module: three call sites
 * STRIPPED `,` and `()` from a client-method pattern, where they were never dangerous, and so
 * could not find the 787 customers whose name holds a parenthesis (audit finding B04-C3).
 *
 * Null when nothing searchable is left, which callers treat as "no match", never as "no filter". */
export function ilikeContainsPattern(term: string): string | null {
  const cleaned = searchableTerm(term);
  return cleaned ? `%${cleaned}%` : null;
}
