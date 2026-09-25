import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stripSqlComments } from "./support/comment-strip.ts";

// THE CONFIDENTIAL REVEAL MUST REACH THE PANELS, OR THE FOOTER IS LYING.
//
// Audit run wf_2196360f-a88 (2026-09-05), ranked #2 of 58 confirmed defects. A CEO ticking
// "include confidential products" saw the headline Total Value quintuple while Top Customers,
// Top/Lowest Bricks, customerCount, bricksReached and customerTop10Share stayed on the remaining
// ~9% — under a footer reading "Confidential products (LA003 / LA004 / SS001) are included in this
// view." The same defect fired on every automated monthly executive email.
//
// It took BOTH halves to be wrong, and it takes both to stay right:
//
//   TS  — `geoArgsFor` omitted `p_exclude_codes` when the array was empty (exactly the revealed
//         case), so the SQL DEFAULT ARRAY['LA003','LA004','SS001'] re-applied the exclusion.
//   SQL — both functions ALSO carried an unconditional `not in ('LA003','LA004','SS001')` above
//         the parameterised clause, so no argument could ever have revealed them anyway.
//
// Measured on production 2026-07 after the fix: phx_exec_brick with an empty exclude set returns
// 60,358,813.15 EGP, exactly equal to the fact-rollup truth, and the DEFAULT call still returns
// 9,398,650.27 — byte-identical to its value before the migration.
//
// Pinned by substring, never by byte window: a fixed slice false-fails the moment the file shifts
// (AGENTS.md §2.1).

const DASHBOARD = fileURLToPath(new URL("../src/lib/sales/sos-dashboard.ts", import.meta.url));
const MIGRATION = fileURLToPath(
  new URL("../supabase/migrations/20260905143000_exec_panels_honour_the_confidential_reveal.sql", import.meta.url),
);

const RESTRICTED_PREDICATE = "not in ('LA003', 'LA004', 'SS001')";

function testGeoArgsAlwaysSendsTheExcludeSet() {
  const source = readFileSync(DASHBOARD, "utf8");
  const start = source.indexOf("const geoArgsFor");
  assert.ok(start > 0, "geoArgsFor must still exist — if it was renamed, re-point this test");
  const body = source.slice(start, start + 1200);

  assert.ok(
    body.includes("p_exclude_codes: trendExcludeCodes"),
    "geoArgsFor must pass p_exclude_codes to the geography RPCs",
  );
  // The regression shape: a conditional spread that DROPS the argument when the array is empty.
  assert.ok(
    !/\.\.\.\(\s*trendExcludeCodes\.length\s*>\s*0\s*\?/.test(body),
    "geoArgsFor must not make p_exclude_codes conditional on the array being non-empty — an empty " +
      "array IS the reveal, and omitting the argument lets the SQL DEFAULT re-exclude",
  );
}

function testMigrationRemovesTheUnconditionalPredicate() {
  const sql = readFileSync(MIGRATION, "utf8");

  // Both functions must be redefined by this migration.
  assert.ok(sql.includes("function public.phx_exec_brick"), "migration must redefine phx_exec_brick");
  assert.ok(sql.includes("function public.phx_exec_customers"), "migration must redefine phx_exec_customers");

  // The unconditional literal must appear ONLY in the explanatory comment, never in a where clause.
  const executable = stripSqlComments(sql);
  assert.ok(
    !executable.includes(RESTRICTED_PREDICATE),
    "the unconditional restricted-product predicate must not survive in executable SQL — it " +
      "overrides p_exclude_codes and is the whole defect",
  );

  // The parameterised clause must remain, in both bodies.
  const guarded = executable.split("cardinality(p_exclude_codes) = 0").length - 1;
  assert.equal(guarded, 2, "both functions must keep the parameterised p_exclude_codes clause");

  // And the DEFAULT must still be the three codes, so nothing is revealed to a caller that does
  // not explicitly ask. This is what keeps the change safe for every existing caller.
  const defaults = executable.split("default array['LA003'::text, 'LA004'::text, 'SS001'::text]").length - 1;
  assert.equal(defaults, 2, "both functions must keep excluding the three codes BY DEFAULT");
}

function testHeadOfficeLockIsUntouched() {
  // The Head Office golden rule rides on the same argument: callers who may not see HO add its
  // product codes to p_exclude_codes. That path must keep working, which it does precisely because
  // the parameterised clause survived.
  const source = readFileSync(DASHBOARD, "utf8");
  assert.ok(
    source.includes("headOfficeProductCodes"),
    "the Head Office product-code exclusion must still feed trendExcludeCodes",
  );
  assert.ok(
    source.includes("const trendExcludeCodes ="),
    "trendExcludeCodes must still be the single set passed to every RPC",
  );
}

export function runExecPanelsConfidentialRevealTests() {
  testGeoArgsAlwaysSendsTheExcludeSet();
  testMigrationRemovesTheUnconditionalPredicate();
  testHeadOfficeLockIsUntouched();
}
