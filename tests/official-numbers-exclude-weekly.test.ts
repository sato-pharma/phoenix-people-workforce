import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// RULE #1 — "Monthly Closing is the ONLY sales truth" (owner's standing rule).
//
// Every official company/individual sales number in this system is produced by ONE engine:
// loadAchievementRange (vs-target.ts) feeding the two canonical twins — dashboard-canonical.ts
// for the admin surfaces (/admin Total Sales KPI, CEO health tile, SFE targets widget, the
// monthly dashboard page/API/XLSX) and portal-sales-canonical.ts for the portal surfaces
// (incentive tab, MR hero, 4-month trend, my-dashboard, Top Achievers). The WEEKLY pipeline
// (src/lib/sales/weekly/*) is depot data on a separate, parallel track — it is deliberately
// excluded from official numbers (Marketing ROI is the one documented exception).
//
// This was the one closing rule with no mechanical lock: nothing turned a PR red if the weekly
// pipeline leaked into an official number. This test is that lock. It pins the tightest TRUE
// invariant — not "no surface may mention weekly" (several surfaces legitimately render weekly
// as a SEPARATE labelled section, e.g. ceo/command-center and portal-sos-dashboard), but that
// the four modules that PRODUCE the official numbers never import the weekly pipeline at all,
// and that the two twins do source from the canonical engine.

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

// The modules that produce every official company/individual sales number. If none of these
// imports the weekly pipeline, no official number can be derived from weekly data.
const CANONICAL_TRUTH_MODULES = [
  { label: "vs-target.ts (loadAchievementRange — the engine)", path: "../src/lib/sales/vs-target.ts" },
  { label: "monthly-targets.ts (achievement rows + targets)", path: "../src/lib/sales/monthly-targets.ts" },
  { label: "dashboard-canonical.ts (admin twin)", path: "../src/lib/sales/dashboard-canonical.ts" },
  { label: "portal-sales-canonical.ts (portal twin)", path: "../src/lib/employee-portal/portal-sales-canonical.ts" },
] as const;

// The two twins must keep sourcing from the canonical engine, not re-derive numbers themselves.
const CANONICAL_TWINS = [
  { label: "dashboard-canonical.ts", path: "../src/lib/sales/dashboard-canonical.ts" },
  { label: "portal-sales-canonical.ts", path: "../src/lib/employee-portal/portal-sales-canonical.ts" },
] as const;

// A module KNOWN to import the weekly pipeline, used only to prove the detector is not vacuous.
// portal-sos-dashboard.ts imports @/lib/sales/weekly/access for the shared tracked-line scope.
const WEEKLY_CONSUMER_CONTROL = {
  label: "portal-sos-dashboard.ts",
  path: "../src/lib/sales/portal-sos-dashboard.ts",
};

// Every module specifier that appears in an import / export-from / dynamic import() statement.
function moduleSpecifiersFrom(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /\b(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/g, // import/export ... from "x"
    /\bimport\s+["']([^"']+)["']/g, // bare side-effect import "x"
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, // dynamic import("x")
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      specifiers.push(match[1]);
    }
  }
  return specifiers;
}

function isWeeklySpecifier(specifier: string): boolean {
  return specifier.includes("/weekly/") || specifier.endsWith("/weekly");
}

export function runOfficialNumbersExcludeWeeklyTests() {
  // ── The rule: the official-number engine never imports the weekly pipeline ──
  for (const mod of CANONICAL_TRUTH_MODULES) {
    const weeklyImports = moduleSpecifiersFrom(read(mod.path)).filter(isWeeklySpecifier);
    assert.deepEqual(
      weeklyImports,
      [],
      `RULE #1: ${mod.label} must not import the weekly pipeline — Monthly Closing is the only `
        + `official sales truth. Weekly is depot data on a separate track and must never reach an `
        + `official number. Found: ${weeklyImports.join(", ")}`,
    );
  }

  // ── The other half: the twins actually source from the canonical engine ──
  // A twin that stopped importing vs-target would pass the check above while quietly re-deriving
  // official numbers from some other source — the rule is "comes FROM Monthly Closing", not merely
  // "does not come from weekly".
  for (const twin of CANONICAL_TWINS) {
    assert.ok(
      read(twin.path).includes('from "@/lib/sales/vs-target"'),
      `RULE #1: ${twin.label} must source official numbers from the canonical engine `
        + `(@/lib/sales/vs-target / loadAchievementRange), not re-derive them.`,
    );
  }

  // ── Discrimination: the detector must actually fire on a real weekly consumer ──
  // Without this, a broken specifier scan (e.g. a regex that never matches) would let every
  // assertion above pass vacuously while the rule went unguarded.
  const controlWeekly = moduleSpecifiersFrom(read(WEEKLY_CONSUMER_CONTROL.path)).filter(isWeeklySpecifier);
  assert.ok(
    controlWeekly.length > 0,
    `detector sanity: ${WEEKLY_CONSUMER_CONTROL.label} is a known weekly consumer and MUST trip the `
      + `weekly-import detector. If it does not, the scan is vacuous and the assertions above prove nothing.`,
  );
}
