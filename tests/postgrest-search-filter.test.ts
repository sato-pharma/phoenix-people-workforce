import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { ilikeAnyFilter, ilikeContainsValue, quotePostgrestValue } from "../src/lib/supabase/search-filter.ts";
import { stripComments } from "./support/comment-strip.ts";

// Regression guard for PostgREST `or(...)` filter injection via a free-text search box.
//
// WHAT HAPPENED. Seven call sites spliced a user-supplied search term straight into a PostgREST
// filter expression — `or("customer_name.ilike.%" + term + "%")`. In that grammar `,` separates
// conditions and `()` groups them, so a term containing either terminates the value early and every
// condition after it is discarded. The request still returns HTTP 200; it just answers a filter
// nobody wrote. Five of the seven sites applied no sanitization at all.
//
// WHY THE OBVIOUS FIX IS WRONG. Stripping `(`, `)` and `,` makes the query safe and simultaneously
// unable to find the rows it exists to find. Measured against production on 2026-08-31, searching
// the customer map for the pharmacy `ابن القيم(حسام حسن)`: the raw term returned 0 rows, the
// paren-stripped term returned 0 rows, and only the double-quoted form returned the row
// (customer_code 22199106). 787 customer names contain a parenthesis. A previous session hit the
// same wall from the other side and left a comment in `crm/master.ts` about "Campaign
// (Prospection)" matching 0 of ~29k rows after stripping.
//
// So both failure modes are silent and they pull in opposite directions, which is why the fix is a
// shared helper that quotes rather than strips — and why this test pins the generated string.
//
// WHAT THE 2026-10-23 SWEEP FOUND, AND WHY THIS FILE GREW. Two constructions in Direct Orders
// survived the August fix untouched, and the sweep at the bottom of this file matched NEITHER:
//
//   B04-01  `const like = \`%${term.replace(/[%_]/g, (m) => \`\\${m}\`)}%\`` then
//           `.or(\`pharmacy_name.ilike.${like},phoenix_pharmacy_code.ilike.${like}\`)`
//           The `%` is inside the VARIABLE, so the sweep's `ilike.%${` never appeared in the
//           source. A term holding a comma turned the two conditions asked for into four
//           fragments, two carrying no operator at all → HTTP 400, search box dead.
//
//   B04-02  `\`"${String(value).replace(/"/g, '""')}"\`` for `in.()` members. SQL doubles a quote
//           to escape it; PostgREST uses a BACKSLASH, and a backslash went through unescaped.
//           Latent only because every member is a uuid or an HR-id key.
//
// So the sweep is not merely widened here — a regex over `ilike.` cannot separate a user-supplied
// term from a server-derived identifier, and measurement says so: a repo-wide ban on interpolating
// any value after `ilike.` matches 23 sites across 5,607 tracked source files, nearly all of them
// correct (an HR-id key, a canonical line name, a column the caller chose). A rule with 20 false
// positives gets an allowlist, and an allowlist that large is where the next real defect hides.
//
// What is pinned instead, and exactly how far each part reaches:
//
//   * BEHAVIOUR — the generated filter is parsed the way PostgREST parses it and the condition
//     count is asserted. That is the property the defect broke, and it is checked for the fixed
//     helper AND for the two original constructions, which are embedded below as literals so this
//     test demonstrably fails against the implementation it replaced.
//   * ONE FILE, EXACTLY — `src/lib/direct-orders/service.ts` must keep routing its `ilike` values
//     and its `in.()` members through the shared helper. No allowlist, no false positives, and it
//     is the file both defects lived in.
//   * REPO-WIDE, ONE SHAPE — SQL-style quote doubling inside a file that also builds a PostgREST
//     filter. Measured 2026-10-23: the bare regex matches 10 files, all of them correct CSV/XLSX
//     escaping where `""` IS the grammar (RFC 4180); scoped to PostgREST files it matched exactly
//     the one defect and now matches nothing.
//
// This does NOT prove the whole class is covered. The 20 other sites that build a LIKE pattern by
// hand are unproven by anything here; whether each one's input can carry a comma is a question
// about data provenance that no regex answers. B04-03, B04-04 and B04-C3 remain open by name.
export function runPostgrestSearchFilterTests() {
  // ── Point 1 · structural characters survive, quoted, instead of being stripped ───────────────
  // The headline assertion. If ilikeAnyFilter ever goes back to stripping or to raw interpolation,
  // this is the line that fires.
  assert.equal(
    ilikeAnyFilter(["customer_name"], "ابن القيم(حسام حسن)"),
    'customer_name.ilike."%ابن القيم(حسام حسن)%"',
    "a parenthesised name must stay intact inside a quoted value — stripping it matched 0 real rows",
  );

  // A comma inside the value must not read as a condition separator. Two columns, one comma: the
  // only comma outside the quotes is the one this helper put there.
  const withComma = ilikeAnyFilter(["a", "b"], "Cairo, Egypt");
  assert.equal(withComma, 'a.ilike."%Cairo, Egypt%",b.ilike."%Cairo, Egypt%"');
  assert.equal(withComma.split('"').length - 1, 4, "exactly two quoted values, so exactly four quotes");

  // ── the two characters that DO need escaping ─────────────────────────────────────────────────
  assert.equal(quotePostgrestValue('a"b'), '"a\\"b"', "a double quote is backslash-escaped");
  assert.equal(quotePostgrestValue("a\\b"), '"a\\\\b"', "a backslash is doubled");
  // Order matters: backslash first, then quote. Escaping in the other order would re-escape the
  // backslash just inserted and produce `"a\\"b"`, which closes the value one character early.
  assert.equal(quotePostgrestValue('a\\"b'), '"a\\\\\\"b"', "backslash-then-quote escapes to 3 + 1");

  // ── Point 3 · wildcards ─────────────────────────────────────────────────────────────────────
  // `%` and `*` are neutralised: PostgREST exposes no ESCAPE clause for ilike, so a literal `%`
  // cannot be matched, and left alone a lone `%` matched all 66,109 active customer rows.
  // "50%" -> the % is blanked and trimmed away, leaving the term "50". The two % in the expected
  // string are the helper's OWN contains-wildcards, not the user's.
  assert.equal(ilikeAnyFilter(["a"], "50%"), 'a.ilike."%50%"');
  assert.equal(ilikeAnyFilter(["a"], "%"), "", "a term that is nothing but a wildcard filters nothing");
  assert.equal(ilikeAnyFilter(["a"], "*"), "", "`*` is translated to `%` by PostgREST, so it goes too");
  assert.equal(ilikeAnyFilter(["a"], "B*12"), 'a.ilike."%B 12%"', "an interior wildcard becomes a space");

  // `_` is deliberately kept: it matches any single character, so the result is a superset that
  // still contains the literal row. Blanking it would break identifiers containing underscores.
  assert.equal(ilikeAnyFilter(["a"], "AB_12"), 'a.ilike."%AB_12%"', "underscore is preserved on purpose");

  // Direct Orders used to escape `%` and `_` with a backslash instead of blanking them, which is a
  // narrower pattern than the helper's. The direction of that change is the thing to pin: for
  // every term, the helper's pattern matches a SUPERSET of what the old one matched, so no row
  // that was findable before became unfindable. `%50\%%` matches names containing a literal "50%";
  // `%50%` matches those and more.
  const oldDirectOrdersPattern = (term: string) => `%${term.replace(/[%_]/g, (m) => `\\${m}`)}%`;
  for (const term of ["50%", "AB_12", "El Salam"]) {
    const widened = ilikeContainsValue(term);
    assert.ok(widened, `the helper must still produce a pattern for ${JSON.stringify(term)}`);
    const oldLiteral = oldDirectOrdersPattern(term).replace(/\\([%_])/g, "$1");
    const newLiteral = widened.slice(1, -1).replace(/^%|%$/g, "");
    assert.ok(
      oldLiteral.replace(/^%|%$/g, "").includes(newLiteral) || newLiteral.length <= oldLiteral.length,
      `the new pattern for ${JSON.stringify(term)} must not be narrower than the old one`,
    );
  }

  // ── empty / degenerate input ────────────────────────────────────────────────────────────────
  // Callers guard on the empty string because `.or("")` is an HTTP 400.
  assert.equal(ilikeAnyFilter(["a"], "   "), "");
  assert.equal(ilikeAnyFilter([], "cairo"), "");
  assert.equal(ilikeAnyFilter(["a"], ""), "");
  assert.equal(ilikeContainsValue("*"), null, "a wildcard-only term has nothing searchable left");

  // ── Points 1 + 5 · parse the filter the way PostgREST does ──────────────────────────────────
  // The defect is not a spelling, it is a COUNT: the expression asked for two conditions and
  // PostgREST saw four. So the assertion counts them, with the same rule PostgREST uses — a comma
  // separates conditions only OUTSIDE a double-quoted value, and inside one a backslash escapes
  // the next character.
  const conditionsOf = (filter: string): string[] => {
    const parts: string[] = [];
    let current = "";
    let inQuotes = false;
    let escaped = false;
    for (const ch of filter) {
      if (escaped) {
        current += ch;
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        current += ch;
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inQuotes = !inQuotes;
        current += ch;
        continue;
      }
      if (ch === "," && !inQuotes) {
        parts.push(current);
        current = "";
        continue;
      }
      current += ch;
    }
    parts.push(current);
    return parts;
  };
  // A condition PostgREST can act on names a column and an operator. A fragment with neither is
  // the signature of a value that escaped its own condition.
  const wellFormed = (condition: string) => /^[a-z_][a-z0-9_]*\.(i?like|eq|in)\./i.test(condition);

  const HOSTILE = [
    ["a comma — the shape that broke the pharmacy search", "El Salam, Nasr City"],
    ["a parenthesised name — 787 customers have one", "ابن القيم(حسام حسن)"],
    ["a double quote", 'El "Salam" Pharmacy'],
    ["a backslash", "El\\Salam"],
    ["every structural character at once", 'a,b(c)d"e\\f'],
  ] as const;

  for (const [label, term] of HOSTILE) {
    const fixed = conditionsOf(ilikeAnyFilter(["pharmacy_name", "phoenix_pharmacy_code"], term));
    assert.equal(fixed.length, 2, `${label}: the helper must still produce exactly 2 conditions`);
    fixed.forEach((condition) =>
      assert.ok(wellFormed(condition), `${label}: every condition must stay well formed — got ${condition}`),
    );
  }

  // Point 5 — the ORIGINAL implementations, as literals, so this test is demonstrably sensitive to
  // the defect it exists to catch. These two functions are copies of what shipped; if the
  // assertions below ever stop failing for them, the parser above has gone blind and every
  // assertion in this block is worthless.
  const originalPharmacyFilter = (term: string) => {
    const like = `%${term.replace(/[%_]/g, (m) => `\\${m}`)}%`;
    return `pharmacy_name.ilike.${like},phoenix_pharmacy_code.ilike.${like}`;
  };
  const originalQuoteInList = (values: readonly string[]) =>
    values.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(",");

  const brokenByComma = conditionsOf(originalPharmacyFilter("El Salam, Nasr City"));
  assert.equal(
    brokenByComma.length,
    4,
    "the original construction must be seen to produce 4 conditions from a 2-condition expression",
  );
  assert.ok(
    brokenByComma.some((condition) => !wellFormed(condition)),
    "and at least one of those fragments must carry no operator at all — that is the HTTP 400",
  );
  assert.equal(
    conditionsOf(ilikeAnyFilter(["pharmacy_name", "phoenix_pharmacy_code"], "El Salam, Nasr City")).length,
    2,
    "while the corrected construction holds at 2 for the same term",
  );

  // ── Point 2 · `in.()` members ───────────────────────────────────────────────────────────────
  // An `in.(…)` list is comma separated, so a member that can hold a comma must be quoted, and the
  // quoting must be PostgREST's. One member in, one member out.
  const members = (list: string) => conditionsOf(list);
  assert.equal(members(quotePostgrestValue("El Salam, Nasr City")).length, 1, "a comma must stay inside the member");
  assert.equal(
    [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ]
      .map(quotePostgrestValue)
      .join(",")
      .split('"').length - 1,
    4,
    "two members, two quoted values, four quotes",
  );
  // The divergence B04-02 was: SQL doubles the quote, PostgREST backslashes it, and a backslash
  // member was not escaped at all. Both forms are asserted so the difference cannot be read as
  // cosmetic.
  assert.equal(quotePostgrestValue('od"d'), '"od\\"d"', "PostgREST escape");
  assert.equal(originalQuoteInList(['od"d']), '"od""d"', "SQL escape — what shipped");
  assert.notEqual(
    originalQuoteInList(['od"d']),
    quotePostgrestValue('od"d'),
    "the two grammars must be seen to disagree on a quote",
  );
  assert.notEqual(
    originalQuoteInList(["a\\b"]),
    quotePostgrestValue("a\\b"),
    "and on a backslash, which the shipped form left unescaped",
  );

  // ── the source assertions ───────────────────────────────────────────────────────────────────
  // `git ls-files` rather than a directory walk: this checkout carries ~1.9M gitignored path
  // entries (AGENTS.md §5).
  const listed = execFileSync("git", ["ls-files", "-z", "src", "app"], { maxBuffer: 64 * 1024 * 1024 })
    .toString("utf8")
    .split("\u0000")
    .filter((f) => /\.(ts|tsx)$/.test(f));
  assert.ok(listed.length > 500, `expected a large source list, got ${listed.length} — the sweep is not running`);

  const readTracked = (file: string): string | null => {
    try {
      // readFileSync, NOT `git show :path` — that returns an empty string under MSYS on this
      // checkout (AGENTS.md 2.1), which would make every sweep pass by reading nothing.
      return readFileSync(file, "utf8");
    } catch {
      return null; // in the index, absent from the working tree — not this test's business
    }
  };

  const DIRECT_ORDERS = "src/lib/direct-orders/service.ts";
  const directOrdersRaw = readTracked(DIRECT_ORDERS);
  assert.ok(directOrdersRaw, `${DIRECT_ORDERS} must be readable — both defects lived there`);
  // Comments quote the defect they describe, including the file's own account of it above the
  // fixed functions. A source assertion that reads comments is satisfied by the explanation and
  // blind to the code.
  const directOrders = stripComments(directOrdersRaw);

  // Point 6 · reintroduction, in the one file where the measurement supports a hard rule.
  const reintroduced: string[] = [];
  directOrders.split("\n").forEach((line, i) => {
    // An `ilike` value built inline from a `%`-wrapped template — B04-01's exact shape — or the
    // operator followed by a template literal rather than a helper-derived value.
    if (/i?like\.(%\$\{|`)/.test(line)) reintroduced.push(`${DIRECT_ORDERS}:${i + 1} ilike pattern built inline`);
    if (/replace\(\s*\/"\/g\s*,\s*['"]""['"]\s*\)/.test(line)) {
      reintroduced.push(`${DIRECT_ORDERS}:${i + 1} SQL-style quote doubling in a PostgREST filter`);
    }
  });
  assert.deepEqual(
    reintroduced,
    [],
    `Direct Orders must build its PostgREST filter values with the shared helper:\n  ${reintroduced.join("\n  ")}`,
  );
  // The positive half: the helpers are actually imported and used. The negative rule above passes
  // trivially on a file that stopped filtering at all.
  assert.match(
    directOrders,
    /ilikeAnyFilter\(\["pharmacy_name", "phoenix_pharmacy_code"\], term\)/,
    "the pharmacy search must resolve its filter through ilikeAnyFilter",
  );
  assert.match(
    directOrders,
    /ilikeContainsValue\(q\)/,
    "the operational page's free-text search must resolve its pattern through ilikeContainsValue",
  );
  assert.match(
    directOrders,
    /function quoteInList\([\s\S]{0,200}?quotePostgrestValue\(String\(value\)\)/,
    "quoteInList must delegate to quotePostgrestValue, not re-implement the escape",
  );

  // Point 4 · the authorization boundary is independent of the search clause. The search was
  // rewritten; the permission check, the scope predicate and the overflow refusal must all still
  // be there, and the scope predicate must still be applied with a column method rather than
  // folded into the `or(...)` expression the search builds.
  const pageStart = directOrders.indexOf("export async function listDirectOrderOperationalPage");
  assert.ok(pageStart > 0, "listDirectOrderOperationalPage must still exist");
  const afterPage = directOrders.indexOf("\nasync function decorateDirectOrderPage", pageStart);
  const pageBody = directOrders.slice(pageStart, afterPage > 0 ? afterPage : undefined);
  assert.match(
    pageBody,
    /assertPermission\(access, "direct_orders", "read"\)/,
    "the operational page must still assert the read permission before it queries",
  );
  assert.match(
    pageBody,
    /query\.in\("requester_hr_id", predicate\.hrIdCandidates\)/,
    "the scope predicate must stay a column filter, ANDed — never a term inside the search or(...)",
  );
  assert.ok(
    pageBody.indexOf("assertPermission") < pageBody.indexOf("filters.q"),
    "and it must be asserted before the search term is read, not after",
  );
  assert.match(
    pageBody,
    /pharmacies\.overflowed \|\| requesters\.overflowed/,
    "the match-limit refusal must survive: a silently capped list reads as the order not existing",
  );
  assert.match(
    pageBody,
    /if \(clauses\.length\) query = query\.or\(clauses\.join\(","\)\)/,
    "`.or(\"\")` is an HTTP 400, so an empty clause list must not reach it",
  );

  // Point 6 · reintroduction, repo-wide, for the one shape the measurement supports.
  //
  // SQL-style quote doubling is correct in a CSV or XLSX cell (RFC 4180) and wrong in a PostgREST
  // filter. Measured across 5,607 tracked source files on 2026-10-23: the bare regex matches 10
  // files, every one of them spreadsheet or CSV escaping — `export/csv-cell.ts`,
  // `export/spreadsheet-safe.ts`, four sales workbook builders, `sales/weekly/export-kit.ts`,
  // `sales/monthly-closing-export.ts` and three report components. Scoping the rule to files that
  // ALSO construct a PostgREST filter leaves those ten alone and matched exactly one file: the one
  // this test now guards. That is why the scope is the fix, not the regex.
  const SQL_DOUBLING = /replace\(\s*\/"\/g\s*,\s*['"]""['"]\s*\)/;
  const BUILDS_POSTGREST_FILTER = /i?like\.|\.in\.\(|\.or\(/;
  const offenders: string[] = [];
  for (const file of listed) {
    const raw = readTracked(file);
    if (!raw) continue;
    const text = stripComments(raw);
    if (!SQL_DOUBLING.test(text) || !BUILDS_POSTGREST_FILTER.test(text)) continue;
    text.split("\n").forEach((line, i) => {
      if (SQL_DOUBLING.test(line)) offenders.push(`${file}:${i + 1}`);
    });
  }
  assert.deepEqual(
    offenders,
    [],
    "SQL-style `\"\"` doubling in a file that builds PostgREST filters — PostgREST escapes with a " +
      `backslash; use quotePostgrestValue():\n  ${offenders.join("\n  ")}`,
  );

  // The August sweep, kept. It matches nothing today and is cheap; it is the one shape that is
  // unambiguously wrong wherever it appears, because the `%` makes the intent a LIKE pattern and
  // the `${` makes the value unquoted.
  const rawInterpolation: string[] = [];
  for (const file of listed) {
    const raw = readTracked(file);
    if (!raw) continue;
    stripComments(raw)
      .split("\n")
      .forEach((line, i) => {
        if (/i?like\.%\$\{/.test(line)) rawInterpolation.push(`${file}:${i + 1}`);
      });
  }
  assert.deepEqual(
    rawInterpolation,
    [],
    `a search term is interpolated raw into an ilike pattern — use ilikeAnyFilter():\n  ${rawInterpolation.join("\n  ")}`,
  );
}
