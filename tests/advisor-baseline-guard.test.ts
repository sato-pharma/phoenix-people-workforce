import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { evaluateAdvisorCounts, type AdvisorCount } from "../scripts/check-advisor-baseline.ts";

// ─────────────────────────────────────────────────────────────────────────────
// The baseline document must not be allowed to rot again.
//
// docs/security/supabase-advisor-baseline.md decides which advisor findings are "accepted as
// by-design". It was last reviewed 2026-07-19. By 2026-09-29 production read:
//
//     rls_enabled_no_policy          it said INFO x23        live 176
//     unused_index                   it said INFO x326       live 615
//     function_search_path_mutable   it said REMEDIATED      live 10
//
// The third is the one that should sting: that document states in its own words that a
// reappearance of `function_search_path_mutable` "is a regression". It had reappeared, for ten
// functions, none of them the one it named — and nobody knew, because nothing in this
// repository had ever compared live advisor output to it. 153 tables joined an "accepted" list
// with nobody accepting them.
//
// So the bar for these tests is not "the comparison works". It is: the specific ways this
// mechanism could go quiet are each caught.
// ─────────────────────────────────────────────────────────────────────────────

type Baseline = Parameters<typeof evaluateAdvisorCounts>[0];

const REAL_BASELINE = JSON.parse(
  readFileSync(new URL("../scripts/advisor-baseline.json", import.meta.url), "utf8"),
) as Baseline;

/** The real production reading, 2026-09-29 — four of five validated against get_advisors. */
const PRODUCTION_TODAY: AdvisorCount[] = [
  { category: "rls_enabled_no_policy", current_count: 176 },
  { category: "function_search_path_mutable", current_count: 10 },
  { category: "extension_in_public", current_count: 1 },
  { category: "authenticated_security_definer_function_executable", current_count: 14 },
  { category: "unused_index", current_count: 615 },
  { category: "stats_age_hours", current_count: -1 },
];

const codes = (b: Baseline, live: AdvisorCount[]) =>
  evaluateAdvisorCounts(b, live).map((f) => f.code);

export function runAdvisorBaselineGuardTests() {
  // ── the shipped baseline must match production exactly, today ────────────
  // If this drifts, the very first run goes red and somebody has to look — which is the
  // entire point. A baseline padded "for headroom" is a baseline that tolerates the next
  // 153 tables silently.
  assert.deepEqual(
    evaluateAdvisorCounts(REAL_BASELINE, PRODUCTION_TODAY),
    [],
    "the shipped baseline must be exactly production's 2026-09-29 reading — no headroom",
  );
  assert.equal(REAL_BASELINE.project_ref, "ozucdzovmcqvepbozvqf");

  // Every category must carry a WHY. A number with no reason cannot be re-judged later, which
  // is how "accepted" became a list nobody could account for.
  for (const [name, entry] of Object.entries(REAL_BASELINE.categories)) {
    assert.ok(
      typeof entry.why === "string" && entry.why.length > 40,
      `${name} must record WHY its count is accepted, not just the number`,
    );
    assert.ok(Number.isInteger(entry.accepted) && entry.accepted >= 0, `${name} needs a real count`);
  }

  // ── growth is an error ───────────────────────────────────────────────────
  const grew = PRODUCTION_TODAY.map((r) =>
    r.category === "rls_enabled_no_policy" ? { ...r, current_count: 177 } : r,
  );
  const growth = evaluateAdvisorCounts(REAL_BASELINE, grew);
  const exceeded = growth.find((f) => f.code === "advisor_baseline_exceeded");
  assert.ok(exceeded, "a single new untriaged table must fail the check");
  assert.equal(exceeded!.severity, "error");
  assert.match(exceeded!.message, /177/);
  assert.match(exceeded!.message, /\+1/, "the message must say HOW MUCH it grew, not just that it did");

  // ── a fall is NOT an error ───────────────────────────────────────────────
  // Fixing something must never turn the build red, or the next person stops fixing things.
  const fixed = PRODUCTION_TODAY.map((r) =>
    r.category === "unused_index" ? { ...r, current_count: 400 } : r,
  );
  const improved = evaluateAdvisorCounts(REAL_BASELINE, fixed);
  assert.ok(
    improved.every((f) => f.severity !== "error"),
    "a count falling below its baseline must never be an error",
  );
  assert.ok(improved.some((f) => f.code === "advisor_baseline_improved"));

  // ── a category nobody has triaged is an error, not a shrug ───────────────
  // A NEW advisor category appearing is exactly the event this mechanism exists to notice.
  const newCategory = [
    ...PRODUCTION_TODAY,
    { category: "security_definer_view", current_count: 3 },
  ];
  const unknown = evaluateAdvisorCounts(REAL_BASELINE, newCategory);
  const unk = unknown.find((f) => f.code === "advisor_category_unknown");
  assert.ok(unk, "an advisor category missing from the baseline must fail, not default to fine");
  assert.equal(unk!.severity, "error");
  assert.match(unk!.message, /security_definer_view/);

  // ── the check going BLIND must not look like the check passing ───────────
  // 🔴 This is the failure the whole file is about. If the RPC stops reporting a category, the
  // silence is identical to "resolved". It must be an error.
  const wentBlind = PRODUCTION_TODAY.filter((r) => r.category !== "rls_enabled_no_policy");
  const blind = evaluateAdvisorCounts(REAL_BASELINE, wentBlind);
  const missing = blind.find((f) => f.code === "advisor_category_missing");
  assert.ok(missing, "a category disappearing from the RPC must be an error, not silence");
  assert.equal(missing!.severity, "error");
  assert.match(missing!.message, /rls_enabled_no_policy/);

  // An empty reading is the extreme of the same fault — every category goes missing.
  const nothing = evaluateAdvisorCounts(REAL_BASELINE, []);
  assert.equal(
    nothing.filter((f) => f.code === "advisor_category_missing").length,
    Object.keys(REAL_BASELINE.categories).length,
    "an empty RPC result must report every category as missing, not pass silently",
  );

  // ── stats_age_hours is context, never a graded category ──────────────────
  // It is reported alongside the others so `unused_index` can be read honestly, but it has no
  // baseline and must never be treated as one.
  assert.ok(
    !Object.keys(REAL_BASELINE.categories).includes("stats_age_hours"),
    "stats_age_hours is context for unused_index, not a category to grade",
  );
  assert.ok(
    !codes(REAL_BASELINE, PRODUCTION_TODAY).includes("advisor_category_unknown"),
    "stats_age_hours must be skipped, not reported as an untriaged category",
  );

  // ── the 2026-07-19 numbers must fail against today's database ────────────
  // The concrete regression, stated as a test: had this check existed in July, it would have
  // caught all three drifts. If this ever passes, the mechanism has stopped working.
  const julyBaseline: Baseline = {
    project_ref: "ozucdzovmcqvepbozvqf",
    last_reviewed: "2026-07-19",
    categories: {
      rls_enabled_no_policy: { accepted: 23, severity: "info", why: "the July record" },
      function_search_path_mutable: { accepted: 0, severity: "warn", why: "July called it remediated" },
      extension_in_public: { accepted: 1, severity: "warn", why: "not in the July doc at all" },
      authenticated_security_definer_function_executable: {
        accepted: 14,
        severity: "warn",
        why: "accepted in July and still 14",
      },
      unused_index: { accepted: 326, severity: "info", why: "the July record" },
    },
  };
  const wouldHaveCaught = evaluateAdvisorCounts(julyBaseline, PRODUCTION_TODAY)
    .filter((f) => f.code === "advisor_baseline_exceeded")
    .map((f) => f.message);
  assert.equal(
    wouldHaveCaught.length,
    3,
    "July's baseline must fail on exactly the three categories that really drifted",
  );
  for (const needle of ["rls_enabled_no_policy", "function_search_path_mutable", "unused_index"]) {
    assert.ok(
      wouldHaveCaught.some((m) => m.includes(needle)),
      `${needle} drifted since 2026-07-19 and the check must catch it`,
    );
  }
  // And it must NOT flag the one that genuinely did not move.
  assert.ok(
    !wouldHaveCaught.some((m) => m.includes("authenticated_security_definer")),
    "the SECURITY DEFINER helpers held at 14 since July — flagging them would be a false alarm",
  );

  // ── negative controls ────────────────────────────────────────────────────
  // Without these, a comparator that had stopped comparing would pass everything above.
  assert.equal(
    evaluateAdvisorCounts(REAL_BASELINE, PRODUCTION_TODAY).length,
    0,
    "the healthy case must produce NO findings — otherwise 'no errors' proves nothing",
  );
  const wayOver = PRODUCTION_TODAY.map((r) =>
    r.category === "extension_in_public" ? { ...r, current_count: 99 } : r,
  );
  assert.ok(
    evaluateAdvisorCounts(REAL_BASELINE, wayOver).some((f) => f.severity === "error"),
    "the exceeded detector must fire on the shape it exists to catch",
  );
}
