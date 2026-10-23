import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// ─────────────────────────────────────────────────────────────────────────────
// NINE READS RESOLVE THE EXCLUDED PRODUCT CODES ONCE PER CALL, NOT ONCE PER ROW.
//
// `p_exclude_codes text[]` is filtered with `<> ALL (select upper(btrim(c)) from unnest(…) as c)`.
// A bare sublink there is an uncorrelated SubPlan, and Postgres re-executes it for every candidate
// row rather than once: measured on production 2026-10-23 against `phx_exec_customers` over one
// line-month, `SubPlan` with loops=295,418 and 1,322 ms, against `InitPlan` with loops=1 and
// 357 ms — both readings taken WARM at shared hit=8,304 with zero disk reads, because the first
// old-form reading came off disk and would have overstated the gain.
//
// Wrapping the same sublink as `ALL (ARRAY(select …))` makes it an uncorrelated scalar the planner
// lifts to an InitPlan. The edit is SEVEN BYTES per site — `array(` and one `)` — and nothing else.
//
// 🔴 `array_agg` IS NOT THE SAME FIX AND MUST NOT BE SUBSTITUTED. `ARRAY(subquery)` yields an empty
// array for an empty input, so the test stays TRUE and nothing is filtered out. `array_agg` over an
// empty set yields NULL, and `v <> all (NULL::text[])` is NULL, not TRUE — which drops EVERY row
// silently. That is why no coalesce is needed here, and why one must never be introduced by routing
// this through an aggregate instead.
//
// Equivalence was proven BEFORE the migrations were written, three independent ways: a 28-case
// truth table over every array shape including the NULL corners; both predicates evaluated over the
// whole relation, 853,159 rows × 5 array shapes = 4,265,795 comparisons with 0 differences; and a
// byte-level proof that stripping the inserted wrap reproduces production's own
// `pg_get_functiondef` output exactly.
//
// `phx_closing_channel_totals` is deliberately NOT in this list: it already resolves the array once
// into a local variable, which is the same win by another route. `phx_exec_sos_trend` does not
// carry the shape at all.
//
// This pins the SHAPE of whichever migration LAST defines each function, so a later redefinition is
// held to the same rule.
// ─────────────────────────────────────────────────────────────────────────────

const MIGRATIONS = fileURLToPath(new URL("../supabase/migrations/", import.meta.url));

/**
 * Function → how many exclude-codes membership tests its body carries, and how many of them are
 * fronted by a short-circuit guard.
 *
 * THREE guard shapes are live, and all three are correct. The five analytics reads write
 * `p_exclude_codes is null or …`; the three exec reads write `cardinality(p_exclude_codes) = 0
 * or …`; the marketing dashboard has NO guard at all. The unguarded one is not an oversight and
 * must not be "fixed": `unnest(NULL)` yields no rows, `ARRAY()` over no rows yields an EMPTY array
 * rather than NULL, and `v <> all ('{}')` is TRUE — so a NULL array excludes nothing, which is the
 * intent. It read the same way before the wrap, where `<> ALL` over an empty sublink is also TRUE.
 * `cardinality(NULL) = 0` is itself NULL, so those sites lean on the same property for their
 * second arm; the guard is a short-circuit, not the correctness.
 *
 * The counts are pinned so that removing a short-circuit, or adding a site, is noticed.
 */
const FUNCTIONS: Record<string, { sites: number; guards: number }> = {
  analytics_sos_by_area: { sites: 1, guards: 1 },
  analytics_sos_by_area_line: { sites: 1, guards: 1 },
  analytics_sos_by_line: { sites: 1, guards: 1 },
  analytics_sos_by_period: { sites: 1, guards: 1 },
  analytics_sos_by_product: { sites: 1, guards: 1 },
  phx_exec_brick: { sites: 1, guards: 1 },
  phx_exec_customers: { sites: 2, guards: 2 },
  phx_exec_distributor_product: { sites: 2, guards: 2 },
  phx_marketing_roi_customer_dashboard: { sites: 1, guards: 0 },
};

type Definition = { file: string; header: string; body: string; tail: string };

function lastDefinition(functionName: string): Definition {
  const opener = new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${functionName}\\(`, "i");
  const files = readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .filter((name) => opener.test(readFileSync(join(MIGRATIONS, name), "utf8")));
  assert.ok(files.length > 0, `no migration defines public.${functionName}`);
  const file = files[files.length - 1];
  const sql = readFileSync(join(MIGRATIONS, file), "utf8").replace(/\r\n/g, "\n");
  const start = sql.search(opener);
  const parts = sql.slice(start).split("$function$");
  assert.ok(parts.length >= 3, `${file}: the body of public.${functionName} must sit between $function$ markers`);
  return { file, header: parts[0], body: parts[1], tail: parts.slice(2).join("$function$") };
}

function flat(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/** The hoisted shape: the membership test wrapped so the planner resolves it once. */
const WRAPPED = /<> all \(array\( ?select upper\(btrim\(([a-z]+)\)\) from unnest\(p_exclude_codes\) as \1 ?\)\)/g;
/** The same test left bare, which is the per-row SubPlan this file exists to keep out. */
const BARE = /<> all \( ?select upper\(btrim\(([a-z]+)\)\) from unnest\(p_exclude_codes\) as \1 ?\)/g;

function assertResolvedOnce(name: string, definition: Definition, expected: { sites: number; guards: number }): void {
  const body = flat(definition.body);
  const header = flat(definition.header);
  const where = `${definition.file} (public.${name})`;

  // ── 1. array_agg must never stand in for ARRAY(). Checked FIRST, because every later rule would
  //       also reject it, and this is the one that says why: over an empty set array_agg yields
  //       NULL, `v <> all (NULL)` is NULL rather than TRUE, and every row is dropped in silence.
  assert.ok(
    !/all \( ?(coalesce\( ?)?array_agg\(/.test(body),
    `RED ${where} resolves the excluded codes with array_agg — ARRAY(subquery) gives an empty array for an empty input, array_agg gives NULL and silently drops EVERY row`,
  );

  // ── 2. Every exclude-codes membership test is wrapped, and the expected number of them is there.
  const wrapped = body.match(WRAPPED) ?? [];
  assert.equal(
    wrapped.length,
    expected.sites,
    `RED ${where} must carry ${expected.sites} exclude-codes test(s) wrapped in array( … ) so the planner resolves them ONCE per call; found ${wrapped.length}`,
  );

  // ── 3. Not one is left bare. A bare sublink is the SubPlan re-executed per row.
  const bare = body.match(BARE) ?? [];
  assert.equal(
    bare.length,
    0,
    `RED ${where} leaves ${bare.length} exclude-codes test(s) as a bare sublink — wrap each in array( … ), it is a per-row SubPlan otherwise`,
  );

  // ── 4. No membership test against p_exclude_codes may open with anything but `array(`. This
  //       catches a NEW site added in the old shape, which rules 2 and 3 would both let through.
  for (let at = body.indexOf("<> all ("); at >= 0; at = body.indexOf("<> all (", at + 1)) {
    const window = body.slice(at, at + 220);
    if (!window.includes("unnest(p_exclude_codes)")) continue;
    assert.ok(
      window.startsWith("<> all (array("),
      `RED ${where} tests p_exclude_codes with an unwrapped "<> all (" — every one of them opens "<> all (array(" …${window.slice(0, 80)}`,
    );
  }

  // ── 5. The short-circuit guards stay as they are — either spelling, counted together. Correctness
  //       does not rest on them (see FUNCTIONS above), but silently dropping one costs the planner
  //       the cheap exit when the caller excludes nothing.
  const guards =
    body.split("p_exclude_codes is null").length - 1 + (body.split("cardinality(p_exclude_codes) = 0").length - 1);
  assert.equal(
    guards,
    expected.guards,
    `RED ${where} must keep ${expected.guards} short-circuit guard(s) — "p_exclude_codes is null or" or "cardinality(p_exclude_codes) = 0 or" — in front of its ${expected.sites} test(s); found ${guards}`,
  );

  // ── 6. The security settings the reads depend on.
  assert.ok(header.includes("security definer"), `RED ${where} must stay SECURITY DEFINER`);
}

export function runSalesReadsExcludeCodesOnceTests() {
  const names = Object.keys(FUNCTIONS);
  for (const name of names) assertResolvedOnce(name, lastDefinition(name), FUNCTIONS[name]);

  // ── Break tests. Each undoes the fix the way a real edit would, against a real definition, and
  //    the NEW assertion must fire. A test that cannot fail pins nothing.
  const subject = "phx_exec_customers";
  const base = lastDefinition(subject);
  const broke = (mutate: (d: Definition) => Definition, expect: RegExp, label: string) => {
    assert.throws(
      () => assertResolvedOnce(subject, mutate(base), FUNCTIONS[subject]),
      expect,
      `the ${label} break test did not fire`,
    );
  };

  // (a) the wrap removed from both sites — exactly the revert this file exists to catch
  broke(
    (d) => ({ ...d, body: d.body.replace(/<> all \(array\(([\s\S]*?)\)\)/g, "<> all ($1)") }),
    /must carry 2 exclude-codes test\(s\) wrapped/,
    "fully unwrapped",
  );

  // (b) ONE of the two sites unwrapped — the half-finished edit a wide change actually produces
  broke(
    (d) => ({ ...d, body: d.body.replace(/<> all \(array\(([\s\S]*?)\)\)/, "<> all ($1)") }),
    /must carry 2 exclude-codes test\(s\) wrapped/,
    "half unwrapped",
  );

  // (c) routed through array_agg instead — plans once, and drops every row when the caller
  //     passes no codes at all
  broke((d) => ({ ...d, body: d.body.replace(/all \(array\(/g, "all (array_agg(") }), /array_agg/, "array_agg substitution");

  // (d) a short-circuit guard dropped — phx_exec_customers uses the cardinality spelling
  broke(
    (d) => ({ ...d, body: d.body.replace("cardinality(p_exclude_codes) = 0", "false") }),
    /must keep 2 short-circuit guard\(s\)/,
    "lost short-circuit guard",
  );

  // (e) SECURITY DEFINER dropped. pg_get_functiondef emits it upper-cased, so the mutation has to
  //     match case-insensitively — a plain lower-case replace is a no-op here and pins nothing.
  broke(
    (d) => ({ ...d, header: d.header.replace(/security definer/i, "security invoker") }),
    /SECURITY DEFINER/,
    "security invoker",
  );

  // (f) a NEW unwrapped site beside the wrapped ones, written WITHOUT the upper(btrim(…)) spelling
  //     rule 3's pattern looks for — the shape a future site is likeliest to arrive in. Rule 2 still
  //     counts the two existing sites and rule 3 does not match this one, so rule 4 is the only rule
  //     that can catch it. Spelt the other way the assertion would come from rule 3, and rule 4
  //     would be an assertion no break test ever fires — which pins nothing.
  broke(
    (d) => ({
      ...d,
      body: d.body.replace(
        /(<> all \(array\(\s*select upper\(btrim\(([a-z]+)\)\) from unnest\(p_exclude_codes\) as \2\s*\)\))/,
        "$1 and zq <> all (select zz from unnest(p_exclude_codes) as zz)",
      ),
    }),
    /unwrapped "<> all \("/,
    "new site in the old shape",
  );

  const sites = Object.values(FUNCTIONS).reduce((total, f) => total + f.sites, 0);
  console.log(`sales reads exclude codes once: ${names.length} functions, ${sites} wrapped sites, 6 break tests passed`);
}
