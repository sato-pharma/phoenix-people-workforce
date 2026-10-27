import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { isPayslipRowVisibleToAudience, payslipAudienceOrFilter } from "../src/lib/payroll/payslip-center.ts";
import {
  ilikeAnyFilter,
  ilikeContainsPattern,
  ilikeContainsValue,
  ilikeExactValue,
  quotePostgrestValue,
  quotedInList,
  quotedOrClause,
  searchableTerm,
} from "../src/lib/supabase/search-filter.ts";
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
// WHAT THE 2026-10-23 REMAINDER CLOSED (B04-03, B04-04, B04-C3), AND THE DISTINCTION IT TURNS ON.
// The three findings the sweep left open are fixed and pinned below. They are not all the same bug,
// and the reason matters more than the fix: PostgREST has TWO transports for an `ilike`, and the
// correct treatment is opposite in each.
//
//   `.or("col.ilike.VALUE")` — one expression PostgREST parses. `,` and `()` are structural, so the
//   value must be DOUBLE-QUOTED. Stripping them is the silent-no-rows failure measured above.
//     B04-04  src/lib/payroll/payslip-center.ts — the payslip AUDIENCE filter spliced job titles in
//             raw, on a comment asserting that no value holds a comma. The retired HR Business
//             Partner seat's titles did not; the promise was about data, not code.
//     B04-C3  src/lib/recruitment/candidates.ts — stripped `,()` from the pool search, so
//             `Ahmed Ali (Pharmacist)` and a phone typed `(010) 1234` were unfindable.
//
//   `.ilike(col, pattern)` — the client's own method. The pattern is one URL-encoded query
//   parameter; nothing in it is structural and quoting it would match two literal `"`. Only the
//   wildcards may be touched.
//     B04-C3  src/lib/crm/reads.ts and src/lib/direct-orders/service.ts — both stripped characters
//             that were never dangerous on this transport, losing the 787 parenthesised customer
//             names and rewriting `CNS_Cairo` to `CNSCairo`.
//
//   And one that is neither: `employees?col=ilike.VALUE` built by hand.
//     B04-03  src/lib/employees/employee-directory.ts — a plain `col=ilike.VALUE` query
//             parameter, where nothing is structural and double quotes are matched literally. So
//             the value is percent-encoded and NEVER quoted: quoting it (#6350) made both
//             uniqueness checks find no holder. Their wildcards are deliberately NOT blanked — see
//             the comment at each site: over-matching is corrected by the exact comparison that
//             follows, under-matching would admit the duplicate the function exists to refuse.
//
// This still does NOT prove the whole class is covered. The 20 other sites that build a LIKE
// pattern by hand are unproven by anything here; whether each one's input can carry a comma is a
// question about data provenance that no regex answers. Two are known and deliberately untouched:
// `src/lib/crm/master.ts` strips `,()` from the master search (the same unfindable-rows loss, on
// the or-transport) and `src/lib/whatsapp-inbox/store.ts` splices a raw `*term*` into an or-string.
// Neither was authorized in this change.
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
  // `\` is LIKE's escape character. A term ending in one used to leave the pattern ending in an
  // escape, which Postgres refuses outright ("LIKE pattern must not end with escape character") —
  // the WhatsApp inbox swallowed that error and its employee suggestions vanished (23 Oct 2026).
  assert.equal(ilikeExactValue("ahmed\\"), '"ahmed"', "a trailing backslash never reaches the pattern");
  assert.equal(ilikeContainsValue("El\\Salam"), '"%El Salam%"', "an interior backslash becomes a space");
  assert.equal(ilikeExactValue("\\"), null, "a term that is nothing but a backslash searches nothing");

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

  // ── MR-B04 · the three exports the identity sweep added ──────────────────────────────────────
  // `searchableTerm` is the ONE place the wildcard rule is applied, and it is exported so that a
  // caller needing a minimum length measures what it returns instead of re-implementing the
  // cleaning in order to measure it. Four call sites did exactly that before.
  assert.equal(searchableTerm("  Cairo, Egypt  "), "Cairo, Egypt", "whitespace trimmed, structure kept");
  assert.equal(searchableTerm("50%"), "50", "the wildcard is blanked, the text survives");
  assert.equal(searchableTerm("%"), null, "nothing searchable left");
  assert.equal(searchableTerm("  "), null);
  assert.equal(searchableTerm(null), null, "null and undefined are inputs here, not errors");
  assert.equal(searchableTerm(undefined), null);
  // Every builder in the module goes through it, so they cannot disagree about what a term is.
  assert.equal(ilikeContainsValue("%"), null);
  assert.equal(ilikeContainsPattern("%"), null);
  assert.equal(ilikeAnyFilter(["a"], "%"), "");

  // `quotedOrClause` is the arm builder for a value that is NOT free text — an HR id, a login id,
  // a uuid, a national id, a mobile number. Those reach a filter normalised, which is not the same
  // as validated: `canonicalHrIdKey` trims, case-folds and maps aliases and guarantees NO character
  // set. So the quoting is the whole fix, and the wildcard rule must NOT be applied — these filters
  // only ever narrow a set the viewer may already see, and blanking a `%` the caller put there
  // would change what payroll's contains mode asks for.
  assert.equal(quotedOrClause("hr_id", "eq", "B-10"), 'hr_id.eq."B-10"');
  assert.equal(quotedOrClause("hr_id", "ilike", "%b-10%"), 'hr_id.ilike."%b-10%"', "the caller's wildcard survives");
  assert.equal(
    quotedOrClause("national_id", "eq", "298,7(x)"),
    'national_id.eq."298,7(x)"',
    "a hostile identity value is quoted whole, never stripped and never left to end the arm",
  );
  assert.equal(quotedOrClause("hr_id", "eq", 'a"b\\c'), 'hr_id.eq."a\\"b\\\\c"', "and escaped the way PostgREST escapes");
  // THE PROPERTY, on the shape the defect turned on: two arms asked for, two arms seen, however
  // hostile the ids. This is the assertion that fires if a site goes back to splicing an id raw.
  const identityArms = [
    quotedOrClause("recipient_hr_id", "eq", "B-10,ADMIN-HR"),
    quotedOrClause("recipient_login_id", "eq", "omar(hr)"),
  ].join(",");
  assert.deepEqual(conditionsOf(identityArms), [
    'recipient_hr_id.eq."B-10,ADMIN-HR"',
    'recipient_login_id.eq."omar(hr)"',
  ]);
  conditionsOf(identityArms).forEach((condition) =>
    assert.ok(wellFormed(condition), `every identity arm must stay well formed — got ${condition}`),
  );
  // The original construction, embedded: the same two arms, spliced raw. Three conditions out of
  // two, and the third carries no operator — which is the HTTP 400, and the one before it is a
  // filter on a column nobody named.
  const originalIdentityArms = ["recipient_hr_id.eq.B-10,ADMIN-HR", "recipient_login_id.eq.omar(hr)"].join(",");
  assert.equal(
    conditionsOf(originalIdentityArms).length,
    3,
    "the shipped construction must be seen to turn 2 identity arms into 3 conditions",
  );
  assert.ok(
    conditionsOf(originalIdentityArms).some((condition) => !wellFormed(condition)),
    "and at least one of them must carry no operator at all",
  );

  // `quotedInList` is the `in.(…)` member list. FOUR implementations of this existed before the
  // sweep — CRM reads, Direct Orders, the hiring-manager notify (which wrapped each id in `"` and
  // escaped nothing inside it, then DROPPED every id that could carry one) and `cv-lookup`'s own
  // private clause builder. One copy, one rule.
  assert.equal(quotedInList(["B-10", "ADMIN-HR"]), '"B-10","ADMIN-HR"');
  assert.equal(quotedInList(['a"b', "c\\d"]), '"a\\"b","c\\\\d"', "backslash escaping, not SQL doubling");
  assert.equal(quotedInList([]), "", "an empty list must produce the empty string, for the caller to skip");
  assert.equal(
    quotedInList(["B-10"]),
    [quotePostgrestValue("B-10")].join(","),
    "it must be the shared value quoting, not a second implementation of it",
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

  // ── B04-C3 · the CLIENT-METHOD pattern, which must NOT be quoted ─────────────────────────────
  // The headline assertion for the two client-method sites: a parenthesised name survives WHOLE,
  // and it carries no quotes. Either half wrong is a defect — stripping loses the row, quoting
  // makes PostgREST look for a name that literally begins with a double quote.
  assert.equal(
    ilikeContainsPattern("ابن القيم(حسام حسن)"),
    "%ابن القيم(حسام حسن)%",
    "a client-method pattern keeps the parentheses and carries no quotes",
  );
  assert.equal(ilikeContainsPattern("El Salam, Nasr City"), "%El Salam, Nasr City%", "and the comma");
  assert.equal(ilikeContainsPattern("CNS_Cairo"), "%CNS_Cairo%", "and the underscore the old strip deleted");
  assert.ok(!ilikeContainsPattern("anything")?.includes('"'), "a quoted value would be matched literally");

  // The wildcard rule is the SAME rule — one implementation, two transports.
  assert.equal(ilikeContainsPattern("B*12"), "%B 12%", "`*` becomes a space, as PostgREST reads it as `%`");
  assert.equal(ilikeContainsPattern("50%"), "%50%", "the user's `%` is blanked; the two here are the helper's");
  assert.equal(ilikeContainsPattern("%"), null, "a wildcard-only term has nothing searchable left");
  assert.equal(ilikeContainsPattern("   "), null, "and an empty one applies no filter at all");
  // The two functions must differ in EXACTLY one way: the quoting their transport demands.
  const term = 'El Salam, Nasr City(2)"x"';
  assert.equal(
    ilikeContainsValue(term),
    quotePostgrestValue(ilikeContainsPattern(term) ?? ""),
    "the or-transport value is the client pattern, quoted — nothing else may differ between them",
  );
  // What the three sites did before: strip the structural characters out of a pattern where they
  // were never structural. Embedded so this test is demonstrably sensitive to the defect.
  const originalStrippedPattern = (value: string) => `%${value.replace(/[%_,()]/g, " ").trim()}%`;
  assert.notEqual(
    originalStrippedPattern("ابن القيم(حسام حسن)"),
    ilikeContainsPattern("ابن القيم(حسام حسن)"),
    "the shipped strip must be seen to produce a different pattern — it matched 0 of 787 such names",
  );

  // ── B04-04 · the payslip AUDIENCE filter — an access boundary, not a search box ───────────────
  // This filter decides what a restricted viewer FETCHES. A truncated or-string here does not read
  // as a missing row, it reads as the Payslips Center being broken (400) or as a filter nobody
  // wrote. Today's only audience is company-wide, so these assertions guard the shape for the next
  // narrower seat rather than a live leak.
  assert.equal(payslipAudienceOrFilter({ kind: "company" }), null, "company scope filters nothing");
  assert.equal(
    payslipAudienceOrFilter({ jobTitles: [], kind: "job-titles", selfHrId: null }),
    null,
    "an empty audience must return null, never the empty string — `.or(\"\")` is an HTTP 400",
  );
  assert.equal(
    payslipAudienceOrFilter({ jobTitles: ["Medical Representative"], kind: "job-titles", selfHrId: "B-10" }),
    'job_title.ilike."Medical Representative",hr_id.ilike."B-10"',
    "both halves of the audience, each value quoted",
  );

  // The property, on the shape that breaks it: a title holding a comma or parentheses. The count is
  // what the defect changed — three conditions asked for, four seen, one of them with no operator
  // in it at all.
  const hostileAudience = {
    jobTitles: ["Medical Rep, Pedia", "Supervisor (Delta)"],
    kind: "job-titles",
    selfHrId: "B-10",
  } as const;
  const audienceFilter = payslipAudienceOrFilter(hostileAudience);
  assert.ok(audienceFilter, "the audience must still produce a filter");
  const audienceConditions = conditionsOf(audienceFilter);
  assert.equal(audienceConditions.length, 3, "two titles plus the viewer's own row — exactly three conditions");
  audienceConditions.forEach((condition) =>
    assert.ok(wellFormed(condition), `every audience condition must stay well formed — got ${condition}`),
  );
  // And the audience must not have WIDENED while being quoted: the columns are exactly these two.
  assert.deepEqual(
    audienceConditions.map((condition) => condition.split(".")[0]),
    ["job_title", "job_title", "hr_id"],
    "no column may be added to the audience filter",
  );

  // The original implementation, embedded: raw splice, no quoting.
  const originalAudienceOrFilter = (titles: readonly string[], selfHrId: string | null) => {
    const terms = titles.map((title) => `job_title.ilike.${title}`);
    if (selfHrId) terms.push(`hr_id.ilike.${selfHrId}`);
    return terms.join(",");
  };
  const brokenAudience = conditionsOf(originalAudienceOrFilter(hostileAudience.jobTitles, hostileAudience.selfHrId));
  assert.equal(
    brokenAudience.length,
    4,
    "the shipped construction must be seen to turn 3 conditions into 4 for the same audience",
  );
  // The parenthesised title does NOT split — it survives as one fragment whose `(Delta)` PostgREST
  // reads as a nested logic group, which is the other half of the 400. Named so that a future
  // reader does not take the count alone as the whole defect.
  assert.ok(
    brokenAudience.includes("job_title.ilike.Supervisor (Delta)"),
    "and the parenthesised title must still be seen to reach PostgREST as an unbalanced group",
  );
  assert.ok(
    brokenAudience.some((condition) => !wellFormed(condition)),
    "and at least one fragment must carry no operator at all — that is the 400",
  );
  // The wildcard decision is deliberate and asserted, because the obvious "neutralise everything"
  // fix is the wrong one HERE: blanking a `%` narrows the SQL, and THE BOUNDARY in payslip-center
  // only ever filters further. A title that genuinely holds a `%` must still fetch its rows.
  assert.equal(
    payslipAudienceOrFilter({ jobTitles: ["Rep 50%"], kind: "job-titles", selfHrId: null }),
    'job_title.ilike."Rep 50%"',
    "a wildcard in a title is left alone: widening is caught by the JS boundary, narrowing is not",
  );
  // The boundary itself must still refuse the row the SQL widening could let through.
  assert.equal(
    isPayslipRowVisibleToAudience(hostileAudience, { hrId: "A-99", jobTitle: "Finance Manager" }),
    false,
    "the JavaScript boundary is what actually enforces the audience — it must still say no",
  );
  assert.equal(
    isPayslipRowVisibleToAudience(hostileAudience, { hrId: "A-99", jobTitle: "medical rep, pedia" }),
    true,
    "and yes, case-insensitively, to a title that is in it",
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
  // Direct Orders' own `quoteInList` was the FOURTH implementation of this list quoting. It was
  // correct, which is exactly why it is the one to delete: the sweep leaves one implementation, so
  // a future correction to the escaping reaches every caller. The local name survives as an alias
  // because ~20 call sites in this file read it.
  assert.match(
    directOrders,
    /const quoteInList = quotedInList;/,
    "quoteInList must be the shared quotedInList, not a fourth implementation of the escape",
  );
  assert.doesNotMatch(
    directOrders,
    /function quoteInList\(/,
    "and must not be a local function again",
  );

  // ── the remainder's five sites · each routed by the rule ITS transport demands ───────────────
  // Source assertions on purpose: two of the five sit in non-exported functions behind a Supabase
  // client, so the wiring is what is checkable here. The BEHAVIOUR of every helper they call is
  // pinned above, and stripComments means the explanation written at each site cannot satisfy the
  // check on the code's behalf.
  const requireSource = (file: string) => {
    const raw = readTracked(file);
    assert.ok(raw, `${file} must be readable`);
    return stripComments(raw as string);
  };

  // B04-C3 (a) · CRM unstamped accounts — client method, unquoted pattern, `_` preserved.
  const crmReads = requireSource("src/lib/crm/reads.ts");
  assert.match(
    crmReads,
    /ilikeContainsPattern\(options\.labelContains\)/,
    "getUnstampedAgentAccounts must build its pattern with ilikeContainsPattern",
  );
  assert.doesNotMatch(
    crmReads,
    /labelContains\.replace\(/,
    "and must not strip characters out of the label — that is what lost `CNS_Cairo`",
  );

  // B04-C3 (b) · the Direct Orders customer picker — same transport, same rule.
  assert.match(
    directOrders,
    /ilikeContainsPattern\(search\)/,
    "the customer picker must build its pattern with ilikeContainsPattern",
  );
  assert.doesNotMatch(
    directOrders,
    /replace\(\/\[%_,\(\)\]\/g/,
    "and must not strip `,()` from a client-method pattern, where they were never structural",
  );

  // B04-C3 (c) · the candidate pool — the OTHER transport, so the value is quoted, not stripped.
  const candidates = requireSource("src/lib/recruitment/candidates.ts");
  assert.match(
    candidates,
    /ilikeAnyFilter\(\["full_name", "email", "phone", "national_id"\], q\)/,
    "searchCandidates must build its or(...) through ilikeAnyFilter",
  );
  assert.match(
    candidates,
    /if \(filter\) query = query\.or\(filter\)/,
    "and must not hand `.or(\"\")` an empty filter — that is an HTTP 400",
  );

  // B04-04 · the payslip audience. The access boundary, so both halves are named explicitly.
  const payslipCenter = requireSource("src/lib/payroll/payslip-center.ts");
  assert.match(
    payslipCenter,
    /job_title\.ilike\.\$\{quotePostgrestValue\(title\)\}/,
    "every job title in the audience filter must be quoted",
  );
  assert.match(
    payslipCenter,
    /hr_id\.ilike\.\$\{quotePostgrestValue\(audience\.selfHrId\)\}/,
    "and so must the viewer's own HR id",
  );
  assert.match(
    payslipCenter,
    /terms\.length > 0 \? terms\.join\(","\) : null/,
    "an audience with nothing in it must return null rather than the empty string",
  );

  // B04-03 · a hand-built `col=ilike.VALUE` path is a PLAIN query parameter, and it must NOT be
  // quoted. PostgREST reads everything after `ilike.` as the pattern; double quotes are an escape
  // only inside `in.(…)` lists and `or`/`and` groups, so a quoted value is matched as two literal
  // `"` characters and finds nothing. #6350 quoted both employee-directory uniqueness checks on
  // 2026-10-23 and so disabled them — measured on production the same day, the CRM-username read
  // found 1 holder unquoted and 0 quoted, and a taken username reached the unique index as a raw
  // 23505. Same transport as supabase-js's `.ilike()`; see ilikeContainsPattern's note.
  const quotedIlikePath: string[] = [];
  let plainIlikePaths = 0;
  for (const file of listed) {
    const raw = readTracked(file);
    if (!raw) continue;
    stripComments(raw)
      .split("\n")
      .forEach((line, i) => {
        if (!/=ilike\.\$\{encodeURIComponent\(/.test(line)) return;
        if (/=ilike\.\$\{encodeURIComponent\((quotePostgrestValue|quotedOrClause|quotedInList)\(/.test(line)) {
          quotedIlikePath.push(`${file}:${i + 1}`);
          return;
        }
        plainIlikePaths += 1;
      });
  }
  assert.deepEqual(
    quotedIlikePath,
    [],
    `a plain \`col=ilike.VALUE\` query parameter was quoted — PostgREST then matches the quote ` +
      `marks literally and the read finds nothing; percent-encode the raw value:\n  ${quotedIlikePath.join("\n  ")}`,
  );
  assert.equal(plainIlikePaths, 2, "both employee-directory uniqueness checks must still make this read");

  // ── MR-B04 · the identity sites · one pin per site, naming the call that must be there ───────
  //
  // These are not search boxes. Each one splices an HR id, a login id, a user id, a national id or
  // a mobile number into an `or(...)` filter that IS the read's access boundary or its narrowing,
  // and the census (2026-10-23) read each value back to its producer: `canonicalHrIdKey`
  // (`@/lib/hr-id`) and `sharedIdentityKeys` trim, case-fold and map aliases — they guarantee NO
  // character set. So "an HR id never contains a comma" was a property of today's data, not of the
  // code, and the failure it would cause is silent: a filter that still returns HTTP 200 and
  // answers a question nobody asked. Every value is quoted now, through the one shared builder.
  //
  // Source pins on purpose: all but two of these sit in non-exported functions behind a Supabase
  // client, so the wiring is what is checkable here — the BEHAVIOUR of `quotedOrClause`,
  // `quotedInList`, `ilikeAnyFilter`, `ilikeContainsValue` and `searchableTerm` is pinned by the
  // unit assertions above, and `stripComments` means the explanation written at each site cannot
  // satisfy the check on the code's behalf.

  // Payroll · the access filter itself, both halves.
  const payrollService = requireSource("src/lib/payroll/service.ts");
  assert.match(
    payrollService,
    /return quotedOrClause\("hr_id", "ilike", value\);/,
    "buildPayrollIdentityOrClause must quote the id it filters on",
  );
  assert.match(
    payrollService,
    /targetHrIds\.map\(\(id\) => quotedOrClause\(column, "ilike", id\)\)/,
    "and the batch collector's per-id arms must be quoted too",
  );

  // CRM plan board · the one site where the OLD guard dropped rows rather than mis-filtering them.
  const planBoard = requireSource("src/lib/crm/plan-board.ts");
  assert.match(
    planBoard,
    /part\.map\(\(id\) => quotedOrClause\("agent_hr_id", "ilike", id\)\)/,
    "the week-plan read must quote each agent id",
  );
  assert.doesNotMatch(
    planBoard,
    /HR_ID_FILTER_SAFE/,
    "and must not reinstate the shape allow-list — it made the filter safe by DROPPING ids, which " +
      "silently removed a rep's whole week from his manager's board",
  );

  // Outstation expenses · three builders, two columns.
  const outstation = requireSource("src/lib/outstation/expenses.ts");
  assert.match(
    outstation,
    /quotedOrClause\("hr_id", "ilike", normalized\)/,
    "the single-id expense filter must be quoted",
  );
  assert.match(
    outstation,
    /normalized\.map\(\(id\) => quotedOrClause\("hr_id", "ilike", id\)\)/,
    "so must the multi-id one",
  );
  assert.match(
    outstation,
    /normalized\.map\(\(id\) => quotedOrClause\("employee_hr_id", "ilike", id\)\)/,
    "and so must the employee_hr_id variant",
  );

  // Joining form · a national id and a mobile number, both typed by a candidate.
  const joiningForm = requireSource("src/lib/offers/joining-form-service.ts");
  assert.match(
    joiningForm,
    /quotedOrClause\("national_id", "eq", answers\.nationalId\)/,
    "the duplicate check must quote the national id",
  );
  assert.match(
    joiningForm,
    /quotedOrClause\("mobile_number", "eq", answers\.mobileNumber\)/,
    "and the mobile number",
  );

  // Market awareness · the `own` visibility narrowing, which existed TWICE verbatim.
  const marketAwareness = requireSource("src/lib/market-awareness/service.ts");
  assert.match(
    marketAwareness,
    /\.map\(\(value\) => quotedOrClause\("requester_hr_id", "eq", value\)\)/,
    "ownActivityFilter must build its three casing arms through the shared builder",
  );
  assert.doesNotMatch(
    marketAwareness,
    /requester_hr_id\.eq\.\$\{/,
    "and the copy of that clause inlined in listActivities must stay deleted — two copies of one " +
      "rule is how the quoting got fixed in one of them and not the other",
  );

  // Notifications · the viewer's own user id and HR id, in both reads.
  assert.match(
    requireSource("src/lib/notifications/in-app.ts"),
    /quotedOrClause\("user_id", "eq", identity\.userId\),\s*quotedOrClause\("hr_id", "eq", employeeHrId\)/,
    "the in-app notification read must quote both identity arms",
  );
  assert.match(
    requireSource("src/lib/notifications/unread.ts"),
    /quotedOrClause\("user_id", "eq", identity\.userId\),\s*quotedOrClause\("hr_id", "eq", viewerHrId\)/,
    "and so must the unread count",
  );

  // Action centre · eleven history reads share one clause builder.
  assert.match(
    requireSource("src/lib/action-center/service.ts"),
    /actorHrIds\.map\(\(id\) => quotedOrClause\(column, "ilike", id\)\)/,
    "decidedByAnyOfMine must quote each login id — it feeds every history read at once",
  );

  // Internal messages · the inbox's four arms and the read-receipt's two.
  const internalMessages = requireSource("src/lib/internal-messages/service.ts");
  for (const column of ["recipient_hr_id", "recipient_login_id", "sender_hr_id", "sender_login_id"]) {
    assert.ok(
      internalMessages.includes(`quotedOrClause("${column}", "eq", sender.`),
      `the inbox filter's ${column} arm must be quoted`,
    );
  }
  assert.doesNotMatch(
    internalMessages,
    /recipient_hr_id\.eq\.\$\{/,
    "and no arm may be spliced raw again — this read is who may see a message",
  );

  // CRM reads · the second of the four list-quoting copies, now an alias.
  assert.match(
    crmReads,
    /const quotedInList = sharedQuotedInList;/,
    "crm/reads must alias the shared list quoting rather than hold its own",
  );
  assert.doesNotMatch(
    crmReads,
    /function quotedInList\(/,
    "and must not define it locally again",
  );

  // Hiring manager notify · the third copy, which dropped the ids it could not quote.
  const hiringManagerNotify = requireSource("src/lib/recruitment/hiring-manager-notify.ts");
  assert.match(
    hiringManagerNotify,
    /hr_id\.in\.\(\$\{quotedInList\(seatHolderIds\)\}\)/,
    "the seat-holder list must be quoted by the shared builder",
  );
  assert.doesNotMatch(
    hiringManagerNotify,
    /\[",\(\)\]/,
    "and must not drop an id that carries a quote or a parenthesis — dropping a seat holder " +
      "removes a manager from the notification this function exists to send",
  );

  // CV lookup · the fourth copy, correct on `,()` and blind to the wildcards.
  const cvLookup = requireSource("src/lib/recruitment/cv-lookup.ts");
  assert.match(
    cvLookup,
    /ilikeAnyFilter\(APPLICATION_SEARCH_COLUMNS, cleaned\)/,
    "the application half must build its filter through ilikeAnyFilter",
  );
  assert.doesNotMatch(
    cvLookup,
    /function ilikeClause\(/,
    "and must not keep its own clause builder — it quoted correctly but passed `%` straight " +
      "through, so a query of `%` matched every candidate",
  );

  // System audit · a drop set that cost real rows, replaced by quoting.
  const incidentsLookup = requireSource("src/lib/system-audit/incidents-lookup.ts");
  assert.match(
    incidentsLookup,
    /return ilikeContainsValue\(searchable\);/,
    "personSearchPattern must delegate to the shared contains value",
  );
  assert.ok(
    !incidentsLookup.includes('[,().:"'),
    "and must not strip `,().:` out of the typed text again — `Ahmed (Acting)` and `B.10` could " +
      "not be found at all while it did",
  );

  // Employee portal · one arm quoted, one deliberately left alone.
  const employeePortal = requireSource("src/lib/employee-portal/service.ts");
  assert.match(
    employeePortal,
    /quotedOrClause\("employee_hr_id", "eq", canonicalHrId\)/,
    "the announcement read's own-id arm must be quoted",
  );
  assert.match(
    employeePortal,
    /recipients\.cs\.\{\$\{canonicalHrId\}\}/,
    "while the array-literal `cs.{…}` arm stays as it was — its escaping is a different grammar " +
      "and has not been measured against production, so changing it here would be a guess",
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

  // ── MR-B04 · the repo-wide sweep · every `.ilike.${…}` and `.eq.${…}` in the tree ───────────
  //
  // The census found its sites by reading 156 `.or(` calls one at a time. That is not repeatable,
  // so the rule it produced is mechanical instead: wherever a value is spliced straight after
  // `.ilike.` or `.eq.` inside a filter string, that value must come from the shared quoting, or
  // its exemption must be WRITTEN DOWN here with the reason it is safe.
  //
  // Deliberately NOT a broader regex. Widening the pattern until it matched everything would have
  // caught the same 28 lines and also every `.gte.` and `.is.` in the tree, where the grammar is
  // different and the answer is not "quote it" — and the exemptions would then be a list nobody
  // could read. The scope is what makes the rule enforceable.
  //
  // `.in.(…)` is the one other grammar where the answer IS quoting, and it is a SECOND sweep below
  // rather than another operator in this one: the value there is a whole list, so the member
  // separator `,` is structural too and the rule is "quoted PER MEMBER, through quotedInList()",
  // not "quoted". Its own exemptions are almost all numeric id lists, which this sweep has none of.
  const QUOTING_PRODUCER =
    /\b(?:quotePostgrestValue|ilikeExactValue|ilikeContainsValue|ilikeContainsPattern|ilikeAnyFilter|quotedInList|quotedOrClause|personSearchPattern|searchableTerm)\s*\(/;
  const BARE_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

  /** The expression inside each `${…}` that sits immediately after `.ilike.` or `.eq.`. */
  const splicedValues = (line: string): string[] => {
    const found: string[] = [];
    const marker = /\.(?:ilike|eq)\.\$\{/g;
    let hit: RegExpExecArray | null;
    while ((hit = marker.exec(line)) !== null) {
      const start = hit.index + hit[0].length;
      let depth = 1;
      let i = start;
      for (; i < line.length && depth > 0; i += 1) {
        if (line[i] === "{") depth += 1;
        else if (line[i] === "}") depth -= 1;
      }
      if (depth === 0) found.push(line.slice(start, i - 1).trim());
    }
    return found;
  };

  // Exemptions, each one measured on 2026-10-23 and keyed by the exact line rather than a line
  // number, so moving the code keeps the exemption and CHANGING it loses it.
  const SPLICE_EXEMPT: Record<string, Record<string, string>> = {
    "src/lib/direct-orders/service.ts": {
      "...statusGroup.unbookedStatuses.map((s) => `and(status.eq.${s},sales_month.is.null)`),":
        "`s` is a member of the module's own status vocabulary (resolveDirectOrderStatusGroupFilter), never user text",
      "...statusGroup.bookedStatuses.map((s) => `and(status.eq.${s},sales_month.not.is.null)`),":
        "same vocabulary, the booked half",
      "if (looksLikeDirectOrderId(q)) clauses.push(`id.eq.${q}`);":
        "guarded by looksLikeDirectOrderId, which is isUuid() — the arm exists only when `q` is a uuid",
    },
    "src/lib/payroll/service.ts": {
      ".or(`year.lt.${year},and(year.eq.${year},month.lt.${month})`)":
        "`year` and `month` are typed `number`",
    },
    "src/lib/recruitment/inbound/whatsapp-classify-session.ts": {
      ".or(`applied_at.is.null,applied_candidate_id.eq.${input.candidateId}`)":
        "the candidate id is a uuid this code read back out of the database, not typed input",
    },
    "src/lib/recruitment/inbound/whatsapp-screening-questions-session.ts": {
      ".or(`applied_at.is.null,applied_candidate_id.eq.${input.candidateId}`)":
        "the same read in the screening-questions session",
    },
    "src/lib/whatsapp-inbox/store.ts": {
      ".or(`phone_norm.eq.${waId},phone.ilike.*${tail},whatsapp.ilike.*${tail}`)":
        "`waId` is normalizePhone()'s output — digits only, nothing else survives it",
    },
    "src/lib/employees/employee-cv-candidates.ts": {
      ".map((value) => `full_name.ilike.${value}`);":
        "the chained map two lines above produced every member with ilikeContainsValue(token), so " +
        "this arrow's parameter IS a quoted value — the only site where the producer is on a " +
        "different line of the same expression",
    },
    "src/lib/crm/plan-entry-keyset.ts": {
      "idClauses.push(`and(crm_plan_entry_id.eq.${id},or(agent_hr_id.gt.${quotePostgrestValue(hr)},agent_hr_id.is.null))`);":
        "`id` passed the INTEGER guard (/^-?\\d+$/) two lines above or the function threw — digits only",
      "return [`plan_date.gt.${date}`, ...idClauses.map((clause) => `and(plan_date.eq.${date},${clause})`)].join(\",\");":
        "`date` passed the ISO_DATE guard (/^\\d{4}-\\d{2}-\\d{2}$/) the line above or the function threw",
    },
  };
  // `src/lib/crm/plan-board.ts` is deliberately NOT in that list: its two matched arms are
  // `plan_month.eq.${Number(...)}` and `plan_year.eq.${Number(...)}`, which the numeric rule below
  // resolves on its own.

  const unquotedSplice: string[] = [];
  let splicesInspected = 0;
  let splicesExempt = 0;
  for (const file of listed) {
    const raw = readTracked(file);
    if (!raw) continue;
    const lines = stripComments(raw).split("\n");
    lines.forEach((line, i) => {
      const values = splicedValues(line);
      if (values.length === 0) return;
      const trimmed = line.trim();
      const exemption = SPLICE_EXEMPT[file]?.[trimmed];
      for (const value of values) {
        splicesInspected += 1;
        // Resolved in the value itself: a producer call, or a number, which has no grammar to break.
        if (QUOTING_PRODUCER.test(value) || /^Number\(/.test(value)) continue;
        // Resolved one hop back: a bare identifier whose NEAREST PRECEDING declaration produces a
        // quoted value. Nearest preceding, not first in the file — `internal-messages/service.ts`
        // holds an unquoted `const normalized = normalizeHrId(hrId)` above the quoted one that
        // feeds the filter, and a first-match lookup would read the wrong line and pass.
        if (BARE_IDENTIFIER.test(value)) {
          const declaration = new RegExp(`\\bconst\\s+${value}\\b\\s*=`);
          let resolved = false;
          for (let j = i; j >= 0; j -= 1) {
            if (!declaration.test(lines[j] as string)) continue;
            // THAT declaration's initializer only — up to its `;`. A fixed window of lines would
            // read the NEXT declaration too, and the outstation employee-lookup route is the proof:
            // its `const normalized` is followed immediately by `const pattern =
            // ilikeContainsValue(query)`, so a 3-line window called an unquoted `normalized`
            // quoted, on the strength of the line below it. Measured 2026-10-23 by breaking it.
            const window = lines.slice(j, j + 3).join("\n");
            const afterEquals = window.slice(window.indexOf("=") + 1);
            const semicolon = afterEquals.indexOf(";");
            resolved = QUOTING_PRODUCER.test(semicolon >= 0 ? afterEquals.slice(0, semicolon) : afterEquals);
            break;
          }
          if (resolved) continue;
        }
        if (exemption) {
          splicesExempt += 1;
          continue;
        }
        unquotedSplice.push(`${file}:${i + 1}  \${${value}}`);
      }
    });
  }
  assert.ok(
    splicesInspected >= 40,
    `the sweep must actually be reading the tree — it inspected only ${splicesInspected} spliced values`,
  );
  assert.deepEqual(
    unquotedSplice,
    [],
    "a value is spliced straight after `.ilike.` or `.eq.` in a PostgREST filter string without " +
      "going through the shared quoting. In that grammar `,` `(` `)` are structural, so such a " +
      "value can end its own condition and the request still returns HTTP 200 answering a filter " +
      "nobody wrote. Build it with quotedOrClause()/ilikeAnyFilter()/ilikeContainsValue(), or add " +
      `the line to SPLICE_EXEMPT above with the reason it is safe:\n  ${unquotedSplice.join("\n  ")}`,
  );
  // Asserted AFTER the list, deliberately: an exemption is keyed to the exact line, so editing an
  // exempt line loses its exemption, and the useful message in that case is the line itself rather
  // than this count. The count then catches the opposite drift — an exemption kept for code that no
  // longer needs it.
  assert.equal(splicesExempt, 10, "the written-down exemptions must all still be reached, and no more of them");

  // ── MR-B04 · the second sweep · every `in.(${…})` list in the tree ──────────────────────────
  //
  // The sweep above deliberately left this grammar out, and the census that followed found two
  // live copies of B04-02 inside it: `textInFilter` in `employees/employee-directory.ts` and
  // `reports/vacancies.ts`, each `value.replace(/"/g, '\\"')` — a member carrying a BACKSLASH
  // loses it, and a member ENDING in one escapes the closing quote and swallows the rest of the
  // list. Both fed a raw REST `hr_id=in.(…)` URL with hr ids in it. Two more hand-rolled the list
  // instead of the escaping: `rep-ranks/server/compute.ts` wrapped each key in bare quotes with no
  // escaping at all, and `security/login-security.ts` mapped the right primitive over the array
  // rather than calling the one builder for the list.
  //
  // Why `in.(…)` needs its OWN rule rather than another operator in the regex above: the value is
  // a whole list, so `,` separates members as well as conditions. Quoting one member is not the
  // answer — EVERY member is quoted, which is what quotedInList() is for.
  //
  // The second shape here, `.not(col, "in", `(…)`)`, is the typed builder handed a RAW list. The
  // method call quotes nothing: supabase-js passes the string through, so `(a,b)` is the same
  // transport as the filter-string form and breaks the same way.
  const IN_LIST_PRODUCER = /\b(?:quotedInList|quoteInList|sharedQuotedInList)\s*\(/;

  /** The expression inside each `${…}` that sits immediately after `in.(` or `"in", \`(`. */
  const inListValues = (line: string): string[] => {
    const found: string[] = [];
    const marker = /(?:\bin\.\(|"in",\s*`\()\$\{/g;
    let hit: RegExpExecArray | null;
    while ((hit = marker.exec(line)) !== null) {
      const start = hit.index + hit[0].length;
      let depth = 1;
      let i = start;
      for (; i < line.length && depth > 0; i += 1) {
        if (line[i] === "{") depth += 1;
        else if (line[i] === "}") depth -= 1;
      }
      if (depth === 0) found.push(line.slice(start, i - 1).trim());
    }
    return found;
  };

  // Exemptions, each one measured on 2026-10-23 and keyed by the exact line, same as above. Almost
  // all of them are NUMERIC id lists, which have no grammar to break; the rest are a module's own
  // vocabulary of snake_case literals, or a list of uuids this code read back out of the database.
  const IN_LIST_EXEMPT: Record<string, Record<string, string>> = {
    "app/api/admin/deductions/employees/route.ts": {
      "`employment_status.in.(${Array.from(ACTIVE_EMPLOYMENT_STATUSES).join(\",\")}),` +":
        'ACTIVE_EMPLOYMENT_STATUSES is the module\'s own Set(["active", "on_leave"]) — two literals, no input',
    },
    "src/lib/approvals/orphaned-requests.ts": {
      '.not("status", "in", `(${NO_ACTOR_EXPECTED.marketing.join(",")})`);':
        "NO_ACTOR_EXPECTED holds this file's own status vocabulary, written out as literals above",
      '.not("status", "in", `(${NO_ACTOR_EXPECTED["direct-order"].join(",")})`);':
        "the same vocabulary, the direct-order half",
      '.not("status", "in", `(${NO_ACTOR_EXPECTED.vacation.join(",")})`);':
        "the same vocabulary, the vacation half",
    },
    "src/lib/crm/reads.ts": {
      "return `agent_crm_id.in.(${list}),double_crm_id.in.(${list}),double2_crm_id.in.(${list})`;":
        "`list` is the numeric CRM ids, through `ids.map(Number).filter(Number.isFinite)` two lines " +
        "above — a non-finite id is dropped, so nothing but digits reaches the list (3 splices, one line)",
      "if (crmIds.length > 0) parts.push(`agent_crm_id.in.(${crmIds.join(\",\")})`);":
        "the same numeric filter for the check-in read; the hr half on the line below IS quoted",
    },
    "src/lib/direct-orders/service.ts": {
      "? `created_by_hr_id.in.(${quoteInList(myHrIdKeys)}),id.in.(${Array.from(fromApprovedOrders).join(\",\")})`":
        "the hr half is quoted; `fromApprovedOrders` is venue uuids this code read back out of " +
        "`String(row.pharmacy_id)` with the blanks filtered out — the same reason the `id.eq.${q}` " +
        "arm is exempt above",
      "...(statusGroup.statuses.length ? [`status.in.(${statusGroup.statuses.join(\",\")})`] : []),":
        "resolveDirectOrderStatusGroupFilter's own status vocabulary — the `.eq.` arms two lines " +
        "below are exempt for the same reason",
    },
    "src/lib/phoenix-crm/server/manager-old-crm-weeks.ts": {
      ".or(`own_contact_crm_id.in.(${list}),reference_contact_crm_id.in.(${list})`),":
        "`list` is a chunk of `contactIds: ReadonlyArray<number>` (2 splices, one line)",
    },
    "src/lib/phoenix-crm/server/signboard-sweep.ts": {
      ".or(`signboard_check.is.null,and(signboard_check->>verdict.eq.unjudged,signboard_check->>reason.in.(${reread}))`)":
        "SIGNBOARD_REREAD_REASONS joined — the module's own reason vocabulary, snake_case literals",
      ": query.or(`signboard_check.is.null,and(signboard_check->>verdict.eq.unjudged,signboard_check->>reason.in.(${reasons}))`);":
        "SIGNBOARD_BACKLOG_REASONS, the same vocabulary for the backlog page",
    },
    "src/lib/recruitment/workspace/completeness.ts": {
      "query = query.or(`declared_role_family.is.null,declared_role_family.in.(${codes.join(\",\")})`);":
        "`codes` is filtered by /^[a-z0-9_]+$/ on the line above, so a comma or a parenthesis cannot " +
        "survive into the list",
    },
    "src/lib/reports/vacancies.ts": {
      "return `in.(${idsToLoad.join(\",\")})`;":
        "inFilter, whose parameter is typed `number[]`; textInFilter beside it now goes through quotedInList",
    },
  };

  const unquotedInList: string[] = [];
  let inListsInspected = 0;
  let inListsExempt = 0;
  for (const file of listed) {
    const raw = readTracked(file);
    if (!raw) continue;
    const lines = stripComments(raw).split("\n");
    lines.forEach((line, i) => {
      const values = inListValues(line);
      if (values.length === 0) return;
      const trimmed = line.trim();
      const exemption = IN_LIST_EXEMPT[file]?.[trimmed];
      for (const value of values) {
        inListsInspected += 1;
        // `quoteInList` and `sharedQuotedInList` are the two local ALIASES of the shared builder,
        // and the assertions earlier in this file pin them as aliases — a `function quoteInList(`
        // or a second implementation is already red — so accepting the name here cannot accept a
        // reimplementation of it.
        if (IN_LIST_PRODUCER.test(value)) continue;
        // Resolved one hop back, the same rule the sweep above uses: a bare identifier whose
        // NEAREST PRECEDING declaration produces a quoted list. `crm/reads.ts` holds both an
        // unquoted numeric `const list` and a quoted `const list = quotedInList(values)` in
        // neighbouring functions, so nearest-preceding is what keeps the two apart.
        if (BARE_IDENTIFIER.test(value)) {
          const declaration = new RegExp(`\\bconst\\s+${value}\\b\\s*=`);
          let resolved = false;
          for (let j = i; j >= 0; j -= 1) {
            if (!declaration.test(lines[j] as string)) continue;
            const window = lines.slice(j, j + 3).join("\n");
            const afterEquals = window.slice(window.indexOf("=") + 1);
            const semicolon = afterEquals.indexOf(";");
            resolved = IN_LIST_PRODUCER.test(semicolon >= 0 ? afterEquals.slice(0, semicolon) : afterEquals);
            break;
          }
          if (resolved) continue;
        }
        if (exemption) {
          inListsExempt += 1;
          continue;
        }
        unquotedInList.push(`${file}:${i + 1}  \${${value}}`);
      }
    });
  }
  assert.ok(
    inListsInspected >= 25,
    `the in-list sweep must actually be reading the tree — it inspected only ${inListsInspected} lists`,
  );
  assert.deepEqual(
    unquotedInList,
    [],
    "a list is spliced into a PostgREST `in.(…)` without going through quotedInList(). In that " +
      "grammar `,` separates the members and `(` `)` close the list, so one member carrying either " +
      "silently changes which rows match — and a member ending in a backslash escapes the closing " +
      "quote and swallows the rest of the list. Build it with quotedInList(), or add the line to " +
      `IN_LIST_EXEMPT above with the reason it is safe:\n  ${unquotedInList.join("\n  ")}`,
  );
  assert.equal(
    inListsExempt,
    16,
    "the written-down in-list exemptions must all still be reached, and no more of them",
  );

  // ── a PLAIN ilike parameter is never quoted (review of #6350, 23 Oct 2026) ─────────────────────
  // `col=ilike.VALUE` and `.ilike(col, value)` send the value as a bare query parameter, where
  // nothing is structure and double quotes are two literal characters — so a quoted value matches
  // NOTHING. #6350 quoted the CRM-username and work-email duplicate checks that way: on production
  // the unquoted read found 1 row, the quoted one 0, and a taken username reached the unique index.
  // The quoting helpers belong inside an `or(…)`/`and(…)` group or an `in.(…)` list only.
  const QUOTING_HELPER = /\b(quotePostgrestValue|ilikeExactValue|ilikeContainsValue|quotedOrClause)\(/;
  const PLAIN_ILIKE = /(?:[?&`][A-Za-z_]+=i?like\.|\.i?like\()/;
  const quotedPlainIlike: string[] = [];
  let plainIlikesInspected = 0;
  for (const file of listed) {
    const raw = readTracked(file);
    if (!raw || !PLAIN_ILIKE.test(raw)) continue;
    const code = stripComments(raw);
    // A value quoted on one line and spliced on another is the same defect.
    const quotedNames = new Set(
      [...code.matchAll(/\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:quotePostgrestValue|ilikeExactValue|ilikeContainsValue|quotedOrClause)\(/g)]
        .map((m) => m[1]),
    );
    code.split("\n").forEach((line, i) => {
      if (!PLAIN_ILIKE.test(line)) return;
      plainIlikesInspected += 1;
      const fedByName = [...quotedNames].some((name) =>
        new RegExp(`(?:=i?like\\.\\$\\{[^}]*\\b${name}\\b|\\.i?like\\([^)]*,\\s*${name}\\s*\\))`).test(line),
      );
      if (QUOTING_HELPER.test(line) || fedByName) quotedPlainIlike.push(`${file}:${i + 1}`);
    });
  }
  assert.ok(
    plainIlikesInspected > 20,
    `the plain-ilike sweep must actually be reading the tree — it inspected only ${plainIlikesInspected} lines`,
  );
  assert.deepEqual(
    quotedPlainIlike,
    [],
    "a QUOTED value is sent as a plain `ilike` parameter. Outside an or/and group or an in-list the " +
      "quotes are literal characters, so the read silently matches nothing. Percent-encode the value " +
      `instead (searchableTerm() if wildcards must be blanked):\n  ${quotedPlainIlike.join("\n  ")}`,
  );
}
