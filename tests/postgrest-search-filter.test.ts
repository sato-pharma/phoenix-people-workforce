import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { ilikeAnyFilter, quotePostgrestValue } from "../src/lib/supabase/search-filter.ts";

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
export function runPostgrestSearchFilterTests() {
  // --- structural characters survive, quoted, instead of being stripped -------------------------
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

  // --- the two characters that DO need escaping ------------------------------------------------
  assert.equal(quotePostgrestValue('a"b'), '"a\\"b"', 'a double quote is backslash-escaped');
  assert.equal(quotePostgrestValue("a\\b"), '"a\\\\b"', "a backslash is doubled");
  // Order matters: backslash first, then quote. Escaping in the other order would re-escape the
  // backslash just inserted and produce `"a\\"b"`, which closes the value one character early.
  assert.equal(quotePostgrestValue('a\\"b'), '"a\\\\\\"b"', "backslash-then-quote escapes to 3 + 1");

  // --- wildcards ------------------------------------------------------------------------------
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

  // --- empty / degenerate input ----------------------------------------------------------------
  // Callers guard on the empty string because `.or("")` is an HTTP 400.
  assert.equal(ilikeAnyFilter(["a"], "   "), "");
  assert.equal(ilikeAnyFilter([], "cairo"), "");
  assert.equal(ilikeAnyFilter(["a"], ""), "");

  // --- the anti-pattern must not regenerate ----------------------------------------------------
  // Fixing seven call sites does not stop an eighth being written next week, and neither lint nor
  // typecheck can see this defect. Sweep tracked source for a search term interpolated straight
  // into an ilike pattern. `git ls-files` rather than a directory walk: this checkout carries ~1.9M
  // gitignored path entries (AGENTS.md §5).
  const listed = execFileSync("git", ["ls-files", "-z", "src", "app"], { maxBuffer: 64 * 1024 * 1024 })
    .toString("utf8")
    .split("\u0000")
    .filter((f) => /\.(ts|tsx)$/.test(f));
  assert.ok(listed.length > 500, `expected a large source list, got ${listed.length} — the sweep is not running`);

  const offenders: string[] = [];
  const raw = /ilike\.%\$\{/;
  for (const file of listed) {
    let text: string;
    try {
      // readFileSync, NOT `git show :path` — that returns an empty string under MSYS on this
      // checkout (AGENTS.md 2.1), which would make every sweep pass by reading nothing.
      text = readFileSync(file, "utf8");
    } catch {
      continue; // in the index, absent from the working tree — not this test's business
    }
    text.split("\n").forEach((line, i) => {
      if (raw.test(line)) offenders.push(`${file}:${i + 1}`);
    });
  }
  assert.deepEqual(
    offenders,
    [],
    `a search term is interpolated raw into an ilike pattern — use ilikeAnyFilter():\n  ${offenders.join("\n  ")}`,
  );
}
