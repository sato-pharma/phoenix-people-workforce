import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripSqlComments } from "./support/comment-strip.ts";
import { lastDefinerPath, lastDefinerSql } from "./support/sql-definer.ts";

// ─────────────────────────────────────────────────────────────────────────────
// The Direct Orders customer search answers a ONE- or TWO-character probe from an index
// (2026-10-16).
//
// `phx_search_direct_order_customers` matches the customer code (contains) or the Arabic-normalized
// name (contains). Both are trigram-indexed, and a trigram index cannot narrow anything for fewer
// than three characters, so a two-character probe re-checked all 81,016 active rows: '10' took
// 1,959 ms on production, the function's worst call 5,316 ms. A GIN index of every 1- and
// 2-character piece of each customer's lower-cased code and normalized name now answers those probes
// directly, 1.3–1.9 s down to 3–50 ms on staging, with the same rows in the same order.
//
// What keeps the answer IDENTICAL is a set of agreements between three pieces of SQL that no
// database is present to check here:
//   * the probe test (`{1,2}`) and the key function's piece length (1 and 2) must be the same number —
//     a three-character probe looked up in two-character pieces silently finds NOTHING;
//   * the probe alphabet must exclude `% _ \` and everything whose lower() is not character by
//     character — inside one, ILIKE means something other than "contains";
//   * the keys the search looks up ('c:' + lower(code), 'n:' + lower(normalized name)) must be the
//     keys the function writes, and both sides must lower-case.
// And one more that costs the most when it breaks: `phx_normalize_arabic` is IMMUTABLE and backs three
// indexes, so its cheaper body must keep the same output — the fold pairs and the removal class are
// pinned here, and the letters 0621..063F / 0641..064A must never enter the removal class.
// ─────────────────────────────────────────────────────────────────────────────

const NORMALIZE_DEFINER = /create or replace function public\.phx_normalize_arabic\(/;
const KEYS_DEFINER = /create or replace function public\.phx_direct_order_search_keys\(/;
const SEARCH_DEFINER = /create (?:or replace )?function public\.phx_search_direct_order_customers\(/;
const ORIGINAL_SEARCH = "supabase/migrations/20260804183000_direct_order_customer_directory_search.sql";

/** The text of one function between its dollar-quote tags, comment-stripped input. */
function bodyOf(sql: string, signature: string): string {
  const start = sql.lastIndexOf(signature);
  assert.ok(start >= 0, `the migration must define ${signature}`);
  const open = /as\s+(\$function\$|\$\$)/.exec(sql.slice(start));
  assert.ok(open, `${signature} must be written as a dollar-quoted body`);
  const bodyStart = start + open.index + open[0].length;
  const end = sql.indexOf(open[1], bodyStart);
  assert.ok(end > bodyStart, `${signature} body must be closed`);
  return sql.slice(bodyStart, end).replace(/\r\n/g, "\n");
}

const squash = (text: string): string => text.replace(/\s+/g, " ").trim();

/** `\0627` style tokens and `\064B-\0652` ranges inside a codepoint-escaped class. */
function escapeTokens(cls: string): string[] {
  return [...cls.matchAll(/\\([0-9A-Fa-f]{4})(?:-\\([0-9A-Fa-f]{4}))?/g)].map((m) => (m[2] ? `${m[1]}-${m[2]}` : m[1]).toUpperCase());
}

/** Every way the normalizer's body can change what it returns. Empty means it is the pinned shape. */
export function normalizerViolations(body: string): string[] {
  const out: string[] = [];
  const text = squash(body);

  const cls = /regexp_replace\(\s*lower\(coalesce\(p_text, ''\)\),\s*U&'\[([^\]]*)\]\+', '', 'g'\s*\)/.exec(text);
  if (!cls) {
    out.push("the removal must be ONE regexp_replace over lower(coalesce(p_text, '')) with a codepoint-escaped class");
  } else {
    const tokens = escapeTokens(cls[1]);
    if (!cls[1].startsWith("\\\\s")) out.push("the removal class must keep the original \\s (written \\\\s inside U&'...')");
    if (tokens.join(",") !== "064B-0652,0670,0640") {
      out.push(`the removal class must hold exactly harakat 064B-0652, superscript alef 0670 and tatweel 0640, found ${tokens.join(",")} — a range that reaches the letters 0621..063F or 0641..064A empties the probe and the search matches every row`);
    }
  }

  const fold = /translate\(.*?U&'((?:\\[0-9A-Fa-f]{4}){7})',\s*U&'((?:\\[0-9A-Fa-f]{4}){7})'\s*\)/.exec(text);
  if (!fold) {
    out.push("the three letter folds must be ONE translate() of seven letters onto seven targets, each side written as codepoint escapes");
  } else {
    const from = escapeTokens(fold[1]);
    const to = escapeTokens(fold[2]);
    const expected: Array<[string, string]> = [
      ["0623", "0627"], ["0625", "0627"], ["0622", "0627"], ["0671", "0627"], // alef family -> alef
      ["0629", "0647"], // ta-marbuta -> ha
      ["0649", "064A"], ["0626", "064A"], // alef-maqsura, ya-hamza -> ya
    ];
    expected.forEach(([a, b], i) => {
      if (from[i] !== a || to[i] !== b) out.push(`fold position ${i + 1} must map ${a} to ${b}, found ${from[i]} to ${to[i]}`);
    });
  }

  if (/\blower\(coalesce\(p_text, ''\)\)/.test(text) === false) out.push("the input must still be lower-cased and NULL-safe before anything else");
  if (!/nullif\(\s*translate\(/.test(text) || !/,\s*''\s*\)\s*;\s*end/.test(text)) out.push("an empty result must still become NULL (nullif(..., ''))");
  return out;
}

/** Every way the search and its key function can disagree. Empty means the fast path is exact. */
export function searchViolations(searchBody: string, keysBody: string): string[] {
  const out: string[] = [];
  const search = squash(searchBody);
  const keys = squash(keysBody);

  // ── the probe test ─────────────────────────────────────────────────────────
  const probe = /\(p0\.raw ~ U&'\^\[([^\]]*)\]\{1,(\d+)\}\$'\) as short_probe/.exec(search);
  if (!probe) {
    out.push("probe_kind must flag a short probe as p0.raw ~ U&'^[alphabet]{1,N}$'");
  } else {
    const alphabet = probe[1];
    if (/[%_\\]/.test(alphabet.replace(/\\[0-9A-Fa-f]{4}/g, ""))) {
      out.push("the short-probe alphabet must not contain % _ or a backslash: inside one, ILIKE means something other than 'contains'");
    }
    if (alphabet !== "0-9A-Za-z\\0621-\\064A") {
      out.push(`the short-probe alphabet must be digits, ASCII letters and the Arabic letters U+0621..U+064A, found [${alphabet}] — lower() must be character by character for every member`);
    }
    const probeMax = Number(probe[2]);
    const pieceLengths = [...keys.matchAll(/substr\(s, i, (\d+)\)/g)].map((m) => Number(m[1]));
    const pieceMax = Math.max(0, ...pieceLengths);
    if (probeMax !== pieceMax) {
      out.push(`the probe is allowed ${probeMax} characters but the key function writes pieces of at most ${pieceMax} — a longer probe finds nothing in shorter pieces and the search returns an empty list that looks like "no such customer"`);
    }
    if (pieceMax !== 2) out.push(`the key function must write 1- and 2-character pieces, found a longest piece of ${pieceMax}`);
  }

  // ── the keys, both ways round ──────────────────────────────────────────────
  const probeKeys = /array\['(c:)' \|\| lower\(p0\.raw\)\] \|\| case when p0\.norm is not null then array\['(n:)' \|\| lower\(p0\.norm\)\] else array\[\]::text\[\] end as keys/.exec(search);
  if (!probeKeys) {
    out.push("the lookup keys must be 'c:' || lower(raw), plus 'n:' || lower(norm) only when norm is not null");
  }
  const written = [...keys.matchAll(/keys := keys \|\| \('([a-z]:)' \|\| substr\(s, i, (\d)\)\)/g)].map((m) => `${m[1]}${m[2]}`).sort();
  if (written.join(",") !== "c:1,c:2,n:1,n:2") {
    out.push(`the key function must append c: and n: pieces of length 1 and 2, found ${written.join(",") || "none"}`);
  }
  if (!/s := lower\(p_code\);/.test(keys)) out.push("the code pieces must come from lower(p_code) — ILIKE lower-cases the text before it looks inside it");
  if (!/s := lower\(public\.phx_normalize_arabic\(p_name\)\);/.test(keys)) {
    out.push("the name pieces must come from lower(public.phx_normalize_arabic(p_name)) — the search ILIKEs the normalized name");
  }

  // ── the two directory arms ─────────────────────────────────────────────────
  if (!/from public\.source_of_sales_customer_map m, probe_kind p where m\.active and p\.raw <> '' and not p\.short_probe and \(p_distributor_code is null or m\.distributor_code = p_distributor_code\) and \( m\.customer_code ilike p\.raw \|\| '%' or m\.customer_code ilike '%' \|\| p\.raw \|\| '%' or \(p\.norm is not null and public\.phx_normalize_arabic\(m\.customer_name\) ilike '%' \|\| p\.norm \|\| '%'\) \)/.test(search)) {
    out.push("the existing trigram arm must stay, unchanged, behind `not p.short_probe`");
  }
  if (!/from public\.source_of_sales_customer_map m, probe_kind p where m\.active and p\.raw <> '' and p\.short_probe and \(p_distributor_code is null or m\.distributor_code = p_distributor_code\) and public\.phx_direct_order_search_keys\(m\.customer_code, m\.customer_name\) && p\.keys/.test(search)) {
    out.push("the short arm must look the keys up with `phx_direct_order_search_keys(code, name) && p.keys` behind `p.short_probe`");
  }
  return out;
}

export function runDirectOrderSearchShortProbeFastPathTests() {
  const normalizeBody = bodyOf(lastDefinerSql(NORMALIZE_DEFINER, "phx_normalize_arabic"), "create or replace function public.phx_normalize_arabic(");
  const keysSql = lastDefinerSql(KEYS_DEFINER, "phx_direct_order_search_keys");
  const keysBody = bodyOf(keysSql, "create or replace function public.phx_direct_order_search_keys(");
  const searchSql = lastDefinerSql(SEARCH_DEFINER, "phx_search_direct_order_customers");
  const searchBody = bodyOf(searchSql, "create or replace function public.phx_search_direct_order_customers(");
  const where = lastDefinerPath(SEARCH_DEFINER, "phx_search_direct_order_customers");

  // ── the normalizer: cheaper body, same output ──────────────────────────────
  assert.deepEqual(
    normalizerViolations(normalizeBody),
    [],
    `RED ${where}: phx_normalize_arabic backs the name_trgm and norm_name indexes and the short-key index, so any change to what it returns silently desynchronises them`,
  );
  const normalizeHeader = squash(normalizeSignature(lastDefinerSql(NORMALIZE_DEFINER, "phx_normalize_arabic")));
  assert.match(normalizeHeader, /\bimmutable\b/, "the normalizer must stay IMMUTABLE or it cannot back an index");
  assert.match(normalizeHeader, /parallel safe/, "the normalizer must stay PARALLEL SAFE");
  assert.match(normalizeHeader, /set search_path = ''/, "the normalizer must pin search_path");

  // ── the keys and the search agree ──────────────────────────────────────────
  assert.deepEqual(
    searchViolations(searchBody, keysBody),
    [],
    `RED ${where}: the short-probe path must stay exact — probe length, alphabet and keys have to agree with the key function`,
  );
  const keysHeader = squash(headerOf(keysSql, "create or replace function public.phx_direct_order_search_keys("));
  assert.match(keysHeader, /\bimmutable\b/, "the key function must be IMMUTABLE — it backs an index");
  assert.match(keysHeader, /set search_path = ''/, "the key function must pin search_path");
  assert.match(
    keysSql,
    /revoke all on function public\.phx_direct_order_search_keys\(text, text\) from public, anon, authenticated;/,
    "this project's default ACL hands a new function to anon and authenticated: they must be revoked by name, not just PUBLIC",
  );
  assert.match(keysSql, /grant execute on function public\.phx_direct_order_search_keys\(text, text\) to service_role;/, "the writers' role needs EXECUTE to maintain the index");
  assert.match(
    keysSql,
    /create index if not exists source_of_sales_customer_map_search_keys_idx\s+on public\.source_of_sales_customer_map\s+using gin \(public\.phx_direct_order_search_keys\(customer_code, customer_name\)\)\s+where active;/,
    "the short-key index must be a GIN over the key function, partial on active like its trigram siblings, or the planner will not use it for this search",
  );

  // ── everything the change promised NOT to touch ────────────────────────────
  const search = squash(searchBody);
  assert.match(search, /^with probe as \( select btrim\(coalesce\(p_query, ''\)\) as raw, public\.phx_normalize_arabic\(p_query\) as norm \),/, "the probe CTE must be unchanged");
  assert.match(searchSql, /language sql\s+stable\s+security invoker\s+set search_path = ''/, "the search must stay SECURITY INVOKER, STABLE, with search_path pinned — DEFINER would hand the whole catalogue to anyone who can reach it");
  assert.doesNotMatch(searchSql, /security definer/, "the search must never become SECURITY DEFINER");

  const original = squash(stripSqlComments(readFileSync(ORIGINAL_SEARCH, "utf8")));
  const rank = (text: string) => /select h\.source, h\.distributor_code[\s\S]*?limit least\(greatest\(coalesce\(p_limit, 30\), 1\), 100\);/.exec(text)?.[0] ?? "";
  assert.ok(rank(original).length > 100, "fixture precondition: the original ranking and limit are found");
  assert.equal(rank(search), rank(original), "the ranking and the limit must be byte-for-byte the original — the fast path may change HOW rows are found, never their order");

  const phoenixArm = (text: string) => /select 'phoenix'::text as source[\s\S]*?\) \) select h\.source/.exec(text)?.[0].replace(/probe_kind p/g, "probe p").replace(/ \) \) select h\.source$/, "") ?? "";
  assert.ok(phoenixArm(original).length > 100, "fixture precondition: the original Phoenix arm is found");
  assert.equal(phoenixArm(search), phoenixArm(original), "the Phoenix-pharmacies arm must be the original, untouched");

  const slowArm = (text: string) => /select 'directory'::text as source[\s\S]*?\) \) union all/.exec(text)?.[0].replace(/ and not p\.short_probe/g, "").replace(/probe_kind p/g, "probe p") ?? "";
  assert.ok(slowArm(original).length > 100, "fixture precondition: the original directory arm is found");
  assert.equal(slowArm(search), slowArm(original), "the existing directory arm must be the original, plus only `not p.short_probe`");

  // ── negative controls: the checks must be able to fail ─────────────────────
  // A function replacement: in a replacement STRING, `$'` means "the rest of the input after the match".
  const widened = searchBody.replace("{1,2}$'", () => "{1,3}$'");
  assert.notEqual(widened, searchBody, "fixture precondition: the probe bound is where the mutation lands");
  assert.ok(
    searchViolations(widened, keysBody).some((v) => v.includes("allowed 3 characters but the key function writes pieces of at most 2")),
    "a probe bound longer than the key pieces must be refused",
  );
  const withWildcard = searchBody.replace("[0-9A-Za-z\\0621-\\064A]", "[0-9A-Za-z%\\0621-\\064A]");
  assert.notEqual(withWildcard, searchBody, "fixture precondition: the alphabet is where the mutation lands");
  assert.ok(searchViolations(withWildcard, keysBody).some((v) => v.includes("% _ or a backslash")), "a wildcard in the short-probe alphabet must be refused");
  const noLower = searchBody.replace("'c:' || lower(p0.raw)", "'c:' || p0.raw");
  assert.notEqual(noLower, searchBody, "fixture precondition: the probe key is where the mutation lands");
  assert.ok(searchViolations(noLower, keysBody).some((v) => v.startsWith("the lookup keys must be")), "a probe key that is not lower-cased must be refused — an uppercase probe would find nothing");
  const threeCharKeys = keysBody.replace("substr(s, i, 2)", "substr(s, i, 3)");
  assert.notEqual(threeCharKeys, keysBody, "fixture precondition: the piece length is where the mutation lands");
  assert.ok(searchViolations(searchBody, threeCharKeys).length > 0, "a key function that changes its piece length without the probe bound must be refused");
  const slowGone = searchBody.replace(" and not p.short_probe", "");
  assert.notEqual(slowGone, searchBody, "fixture precondition: the trigram arm's gate is where the mutation lands");
  assert.ok(searchViolations(slowGone, keysBody).some((v) => v.includes("behind `not p.short_probe`")), "a trigram arm that also runs for a short probe would return its rows twice");
  const widerClass = normalizeBody.replace("\\0670\\0640", "\\0670\\0640\\0627");
  assert.notEqual(widerClass, normalizeBody, "fixture precondition: the removal class is where the mutation lands");
  assert.ok(normalizerViolations(widerClass).some((v) => v.includes("must hold exactly harakat")), "a letter in the removal class must be refused");
  const wrongPair = normalizeBody.replace("\\0629\\0649", "\\0649\\0629");
  assert.notEqual(wrongPair, normalizeBody, "fixture precondition: the fold list is where the mutation lands");
  assert.ok(normalizerViolations(wrongPair).some((v) => v.startsWith("fold position")), "a swapped fold pair must be refused");
  const previousNormalizer = bodyOf(
    stripSqlComments(readFileSync("supabase/migrations/20260807120000_direct_order_search_arabic_space_fold.sql", "utf8")),
    "create or replace function public.phx_normalize_arabic(",
  );
  assert.ok(normalizerViolations(previousNormalizer).length > 0, "the five-regex body is not the pinned shape; if it passes, this check proves nothing");
  const previousSearch = bodyOf(stripSqlComments(readFileSync(ORIGINAL_SEARCH, "utf8")), "create function public.phx_search_direct_order_customers(");
  assert.ok(searchViolations(previousSearch, keysBody).length > 0, "the original search has no short-probe path; if it passes, this check proves nothing");
}

/** Everything from the function's name to its dollar-quote, for the volatility words. */
function headerOf(sql: string, signature: string): string {
  const start = sql.lastIndexOf(signature);
  assert.ok(start >= 0, `the migration must define ${signature}`);
  const open = /as\s+(\$function\$|\$\$)/.exec(sql.slice(start));
  assert.ok(open, `${signature} must be a dollar-quoted body`);
  return sql.slice(start, start + open.index);
}

function normalizeSignature(sql: string): string {
  return headerOf(sql, "create or replace function public.phx_normalize_arabic(");
}
