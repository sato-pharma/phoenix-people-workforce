import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";

// The CRM "single door" invariant (Phase 3 of the CRM single-source module).
//
// NO module outside src/lib/crm/ may run its own query against the iReports360 mirror tables
// (ireports360_visits / _checkins / _visits_sync_runs / _crm_identity_resolutions / _plan_entries
// and the _visits_effective view). Every consumer reads CRM data through the crm/reads.ts service
// functions instead, so the CRM module is the only code that touches the feed. This test fails
// loudly if a raw mirror `.from(...)` reappears anywhere else — the regression guard that keeps
// the centralization from eroding one convenient query at a time.

// `.from("ireports360_...")` — a raw string-literal mirror query.
const literalFrom =
  /\.from\(\s*["'`]ireports360_(?:visits|checkins|visits_sync_runs|crm_identity_resolutions|plan_entries|visits_effective)\b/;
// `.from(SOME_CONST)` where the const names a mirror table — the migrated local consts plus the
// canonical crm/tables constants (importing those into a non-CRM file and querying would bypass
// the door just as surely as a string literal).
const constFrom =
  /\.from\(\s*(?:visitsTable|checkinsTable|DV_SOURCE_TABLE|VISITS_MIRROR_TABLE|CRM_VISITS_TABLE|CRM_CHECKINS_TABLE|CRM_SYNC_RUNS_TABLE|CRM_IDENTITY_RESOLUTIONS_TABLE|CRM_PLAN_ENTRIES_TABLE|CRM_VISITS_EFFECTIVE_VIEW)\s*\)/;

function walkTsFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walkTsFiles(full, out);
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
}

export function runCrmSingleSourceTests() {
  const files: string[] = [];
  walkTsFiles("src", files);
  walkTsFiles("app", files);

  const violations: string[] = [];
  for (const file of files) {
    const rel = file.split(sep).join("/");
    // The CRM module itself IS the single door — it is allowed (indeed required) to query the mirror.
    if (rel.startsWith("src/lib/crm/")) continue;
    const source = readFileSync(file, "utf8");
    if (literalFrom.test(source) || constFrom.test(source)) violations.push(rel);
  }

  assert.deepEqual(
    violations,
    [],
    `These files query the iReports360 mirror directly instead of going through src/lib/crm/reads.ts:\n  ${violations.join("\n  ")}`,
  );

  // The read layer every consumer must use actually exists and exposes the shared primitives.
  const reads = readFileSync("src/lib/crm/reads.ts", "utf8");
  for (const fn of [
    "queryVisits",
    "queryVisitsLimited",
    "queryCheckins",
    "getDoubleVisitRows",
    "queryVisitsPage",
    "scanVisitsForRange",
    "getVisitAgentNames",
    "getMappedAgentHrIds",
    "getVisitsReportData",
  ]) {
    assert.match(reads, new RegExp(`export async function ${fn}\\b`), `crm/reads.ts exposes ${fn}()`);
  }

  // The resigned-agent exclusion stays the default everywhere — only an explicit,
  // documented opt-in (still going through the one door) may bypass it.
  assert.match(
    reads,
    /includeResignedAgents\?: boolean;/,
    "the door must expose an explicit opt-in to see resigned-agent rows, not require callers to bypass the door themselves",
  );
  assert.match(
    reads,
    /const excludedInList = options\.includeResignedAgents \? "" : await getEffectiveExcludedInList\(\);/,
    "the resigned-agent exclusion must default ON — only skipped when a caller explicitly opts in",
  );
}
