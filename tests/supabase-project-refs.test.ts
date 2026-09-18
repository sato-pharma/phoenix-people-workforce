import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  classifySupabaseLink,
  FOREIGN_REFS,
  PRODUCTION_REF,
  RETIRED_REFS,
  STAGING_REF,
} from "../scripts/repo-doctor-supabase-link.mjs";

/**
 * Every Supabase project ref hardcoded in this repository, held against the one table that is
 * actually maintained: AGENTS.md section 3.
 *
 * WHY THIS EXISTS. Two opposite failures have both happened here, and fixing either one alone
 * causes the other:
 *
 *   * TOO PERMISSIVE. staging-executive-dashboard-migration-reconciliation.ts took its approved
 *     target from PHOENIX_APPROVED_STAGING_REF with no allowlist, so it would reconcile ANY
 *     project the variable named. The account can see two that have nothing to do with this app,
 *     and on 2026-09-04 this checkout's Supabase CLI was linked to one of them.
 *
 *   * TOO STALE. That variable exists in the first place because the ref used to be hardcoded and
 *     rotted: it pointed at the oaifhavixhdtwmseshff sandbox long after the sandbox was deleted,
 *     and nothing noticed. scripts/staging-safe-rebuild.ts then repeated the pattern with
 *     izhmxvgiktiafqusolot, under a comment claiming it "still resolves to a real project" — and
 *     the test beside it PINNED that claim, so it was defended rather than looked up.
 *
 * Hardcoding is the safe half (an allowlist can be too strict but never too permissive). This test
 * supplies the missing half: it makes staleness fail loudly instead of silently. Change a ref in
 * AGENTS.md section 3 and every literal that disagrees is named here.
 */
export function runSupabaseProjectRefsTests() {
  const agents = readFileSync("AGENTS.md", "utf8");

  // ── 1. WHAT AGENTS.md SECTION 3 ACTUALLY SAYS ──────────────────────────────
  // Parsed from the table rather than restated, so this test cannot drift from the doc it checks.
  const rows = agents
    .split("\n")
    .map((line) => /^\s*\|\s*`([a-z]{20})`\s*\|(.*)$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ ref: m[1], rest: m[2] }));

  assert.equal(rows.length, 3, "AGENTS.md section 3 must list exactly the three projects the account can see");

  const production = rows.filter((r) => /\*\*PRODUCTION\*\*/.test(r.rest));
  const staging = rows.filter((r) => /\*\*STAGING\*\*/.test(r.rest));
  const unrelated = rows.filter((r) => /unrelated/.test(r.rest));

  assert.equal(production.length, 1, "exactly one row may be marked PRODUCTION");
  assert.equal(staging.length, 1, "exactly one row may be marked STAGING");
  assert.equal(unrelated.length, 1, "one of the three projects is unrelated to this app");

  // ── 2. THE CLASSIFIER AGREES WITH THE DOC ──────────────────────────────────
  assert.equal(PRODUCTION_REF, production[0].ref, "repo-doctor-supabase-link.mjs production ref is stale");
  assert.equal(STAGING_REF, staging[0].ref, "repo-doctor-supabase-link.mjs staging ref is stale");
  assert.deepEqual(
    [...FOREIGN_REFS.keys()].sort(),
    unrelated.map((r) => r.ref).sort(),
    "the projects the classifier calls foreign must be exactly the ones AGENTS.md calls unrelated",
  );

  const deadFromDoc = /Dead refs[\s\S]*?`([a-z]{20})`\s+and\s+`([a-z]{20})`/.exec(agents);
  assert.ok(deadFromDoc, "AGENTS.md section 3 must still name its dead refs");
  assert.deepEqual(
    [...RETIRED_REFS.keys()].sort(),
    [deadFromDoc[1], deadFromDoc[2]].sort(),
    "the classifier's retired refs must be exactly the ones AGENTS.md calls dead",
  );

  // A dead ref must never be reachable as a live target through any of the three buckets.
  for (const dead of RETIRED_REFS.keys()) {
    assert.ok(dead !== PRODUCTION_REF && dead !== STAGING_REF, `${dead} is dead and cannot be a target`);
    assert.ok(!FOREIGN_REFS.has(dead), `${dead} is dead, not foreign`);
  }

  // ── 3. EVERY GUARD'S OWN LITERALS ──────────────────────────────────────────
  // The two migration guards hardcode their refs on purpose. This is what stops that going stale.
  const applier = readFileSync("scripts/apply-migrations-to-staging.ts", "utf8");
  assert.match(applier, new RegExp(`STAGING_PROJECT_REF = "${STAGING_REF}"`));
  assert.match(applier, new RegExp(`PRODUCTION_PROJECT_REF = "${PRODUCTION_REF}"`));

  const reconciliation = readFileSync(
    "scripts/staging-executive-dashboard-migration-reconciliation.ts",
    "utf8",
  );
  assert.match(reconciliation, new RegExp(`stagingProjectRef = "${STAGING_REF}"`));
  assert.match(reconciliation, new RegExp(`blockedProductionRef = "${PRODUCTION_REF}"`));
  // The env var stays required and fail-closed — that half was deliberate. What it may no longer
  // do is name a different project and have the run proceed.
  assert.match(reconciliation, /PHOENIX_APPROVED_STAGING_REF is required/);
  assert.match(reconciliation, /The variable confirms the target; it cannot choose a different/);
  for (const foreign of FOREIGN_REFS.keys()) {
    assert.ok(
      reconciliation.includes(foreign),
      `the reconciliation guard must name ${foreign} so a refusal says WHICH project it is`,
    );
  }

  // ── 4. THE LINK CLASSIFIER'S BRANCHES ──────────────────────────────────────
  // Absent and unreadable both mean "no link in effect", and that is the SAFE state, not an error.
  for (const empty of [null, "", "   "]) {
    const v = classifySupabaseLink({ projectRef: empty, linkedName: null });
    assert.equal(v.state, "unlinked");
    assert.equal(v.severity, "ok");
  }

  assert.equal(classifySupabaseLink({ projectRef: STAGING_REF, linkedName: null }).severity, "ok");

  const prod = classifySupabaseLink({ projectRef: PRODUCTION_REF, linkedName: "Phoenix HR" });
  assert.equal(prod.state, "production");
  assert.equal(prod.severity, "warn");

  // The one that actually happened: linked to a live project belonging to something else.
  const foreignVerdict = classifySupabaseLink({
    projectRef: [...FOREIGN_REFS.keys()][0],
    linkedName: "Future Talents Hub",
  });
  assert.equal(foreignVerdict.state, "foreign");
  assert.equal(foreignVerdict.severity, "alarm", "a foreign live project is the loudest case");
  assert.ok(
    foreignVerdict.lines.some((l) => /NOT A PHOENIX PROJECT/.test(l)),
    "the foreign verdict must say so in words, not leave it to be inferred from a ref",
  );

  // A dead ref cannot be written to, so it must NOT be reported at the same volume as a live one.
  const retired = classifySupabaseLink({ projectRef: [...RETIRED_REFS.keys()][0], linkedName: null });
  assert.equal(retired.state, "retired");
  assert.equal(retired.severity, "note");

  const unknown = classifySupabaseLink({ projectRef: "abcdefghijklmnopqrst", linkedName: null });
  assert.equal(unknown.state, "unknown");
  assert.equal(unknown.severity, "alarm", "an unrecognised ref must stop a run, not be assumed safe");

  // ── 5. THE CHECK IS ACTUALLY WIRED INTO THE REPORT ─────────────────────────
  // supabase/.temp is gitignored, so this section is the ONLY thing that can ever see the link.
  const doctor = readFileSync("scripts/repo-doctor.mjs", "utf8");
  assert.match(doctor, /repo-doctor-supabase-link\.mjs/);
  assert.match(doctor, /SUPABASE CLI LINK/);
  assert.match(doctor, /primaryRoot, "supabase", "\.temp"/);
}
