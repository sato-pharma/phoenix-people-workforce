import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Business Review — the MEDICAL REP's from-scratch frontend (owner, 2026-09-30: "med reps need a
 * from scratch build to business review frontend tailored for them").
 *
 * This pins the decisions that a browser sweep cannot see at a glance and that a later session would
 * be tempted to "simplify" back into the manager dashboard:
 *
 *   - it is its OWN component, not BusinessReviewPortal scoped down;
 *   - it is BLIND (Phoenix CRM golden rule #1) — no integrity signal of any kind reaches it;
 *   - every number is the Monthly Closing's own — achievement is sum(graded)/sum(target), never
 *     sales/target and never an average of per-area percentages;
 *   - customer counts are UNIONS and stay per area, never summed into a headline that doubles a
 *     doctor who works two of his areas;
 *   - it fits the screen (no bare table, no horizontal scroll);
 *   - the rep reaches it, and the full pack export, BEFORE any of the manager machinery runs.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

export function runBusinessReviewRepFrontendTests() {
  const component = read("../src/components/business-review/rep-review.client.tsx");
  const page = read("../app/employee-portals/business-review/page.tsx");

  // ── it is its own thing, not the manager dashboard ────────────────────────────
  assert.ok(/export function RepBusinessReview\b/.test(component), "RepBusinessReview must be exported");
  // It may NAME the manager component in a comment (it explains why it is not that), but it must not
  // import or render it — that is the "from scratch" the owner asked for.
  assert.ok(
    !/<BusinessReviewPortal\b/.test(component) && !/import[^;]*\bBusinessReviewPortal\b/.test(component),
    "the rep frontend is built from scratch — it must not import or render the manager component",
  );

  // ── design identity: the portal primitives and the shared concentration panels ─
  for (const primitive of ["PortalSection", "PortalMetricCard", "PortalResponsiveDataList", "PortalDesktopTable"]) {
    assert.ok(component.includes(primitive), `the rep frontend reuses ${primitive} so it matches its sibling pages`);
  }
  assert.ok(
    component.includes("ConcentrationPanels"),
    "the 'where my sales came from' section reuses the shared ConcentrationPanels, never a second copy",
  );

  // ── golden rule #1: the rep's page is BLIND — no integrity signal, no manager furniture ─
  // Checked against CODE, not comments: the component's own header explains WHY it shows no
  // integrity signal, so it names "integrity" and "mock-location" in prose. Strip comments first,
  // then nothing an integrity signal would render may survive.
  const codeOnly = component
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  assert.ok(
    !/location-integrity|phoenix_crm_location_integrity/.test(component),
    "the rep frontend must not touch the integrity feed at all",
  );
  for (const forbidden of ["integrity", "mock", "spoof", "far from", "Far from"]) {
    assert.ok(!codeOnly.includes(forbidden), `a rep never sees an integrity signal — found "${forbidden}" in code`);
  }
  for (const forbidden of ["Exclude vacant", "exclude vacant", "district manager", "District manager", "League"]) {
    assert.ok(!codeOnly.includes(forbidden), `the rep frontend carries no manager furniture — found "${forbidden}" in code`);
  }

  // ── achievement is the closing's own arithmetic ───────────────────────────────
  assert.ok(component.includes("function sumSlices"), "the rep frontend rolls slices up the closing's way (sumSlices)");
  assert.ok(
    /\(100 \* graded\) \/ target/.test(component),
    "achievement is 100*graded/target — never sales/target, never an average of per-area percentages",
  );

  // ── customers are unions, kept per area; the visit split is the golden AM · PM · Pharmacies ─
  assert.ok(component.includes("formatVisitCountSplit"), "visits are shown AM · PM · Pharmacies, the owner's golden rule");
  assert.ok(
    !/\+\s*a\.customersTotal/.test(component) && !/\+\s*a\.customersAm/.test(component),
    "customer counts are unions — never summed across areas into a headline that doubles a shared doctor",
  );

  // ── fits the screen: no bare table, no horizontal scroll ──────────────────────
  assert.ok(!/<table\b/.test(component), "every table goes through PortalDesktopTable (table-fixed) — never a bare <table>");
  assert.ok(!component.includes("overflow-x"), "no horizontal scroll anywhere on the rep frontend");

  // ── the rep reaches his own page, and the full export, before the manager machinery ─
  assert.ok(page.includes("import { RepBusinessReview }"), "the portal page imports the rep frontend");
  assert.ok(page.includes("<RepBusinessReview"), "the portal page renders the rep frontend");
  assert.ok(/level="rep"/.test(page), "the rep is handed the pack export at level 'rep'");
  const repIntercept = page.indexOf('scope.kind === "rep"');
  const narrowedBlock = page.indexOf("if (narrowed)");
  assert.ok(repIntercept > -1, "the page has a rep branch");
  assert.ok(narrowedBlock > -1, "the page still has its manager narrowing block");
  assert.ok(
    repIntercept < narrowedBlock,
    "the rep is intercepted BEFORE the manager machinery (narrowed / company / line / seat), so none of it runs for him",
  );
  assert.ok(
    component.includes("picker"),
    "the rep frontend renders the export picker the page passes it",
  );
}
