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

/**
 * FROZEN: what production read on 2026-09-29, before Phase 4 touched anything. Four of the five
 * were validated against a live `get_advisors` run that day. Kept as a historical fixture so the
 * "July would have caught this" proof below keeps testing the drift that actually happened,
 * rather than drifting along with the database.
 */
const PRODUCTION_2026_09_29: AdvisorCount[] = [
  { category: "rls_enabled_no_policy", current_count: 176 },
  { category: "function_search_path_mutable", current_count: 10 },
  { category: "extension_in_public", current_count: 1 },
  { category: "authenticated_security_definer_function_executable", current_count: 14 },
  { category: "unused_index", current_count: 615 },
  { category: "stats_age_hours", current_count: -1 },
];

/**
 * The reading the SHIPPED baseline is set from, after Phase 4.
 *
 * `function_search_path_mutable` is 0 because all ten were pinned in
 * 20260929215727_phase4_schema_hygiene.sql, and the baseline holds it at a hard floor of zero.
 *
 * 🔴 Production itself currently reads `rls_enabled_no_policy` 177, ONE ABOVE this. That is
 * another session's pre-image table (`public.hiring_document_definitions_pre_20260930`), created
 * while Phase 4 was in flight and deliberately NOT absorbed into the baseline — raising the
 * number to go green is the exact drift this whole mechanism exists to stop, and the table is
 * not this session's to move (AGENTS.md section 5). The gate is therefore knowingly red on that
 * one finding until its owner retires it.
 *
 * 🔴 `authenticated_security_definer_function_executable` is 11, LOWERED from 14 on 2026-10-08
 * after a per-function audit against live production. The three that left are the three PR #5489
 * revoked on 2026-10-08 at 10:14:50 Cairo, in
 * `20261008032000_revoke_authenticated_execute_on_unreferenced_access_helpers.sql` —
 * `current_access_is_admin()`, `current_access_line()`, `current_access_manager_hr_id()` — and
 * no live policy references any of them, so nothing broke. (Corrected the same day: this first
 * credited the hand-run `phoenix-security-definer-execute-lockdown.sql`, which revokes the same
 * three; the real cause is that dated, self-guarding migration.)
 * This is the one direction that is safe to follow down: `evaluateAdvisorCounts` treats
 * a FALL as news rather than an error, so the baseline must come down with it or the gate keeps
 * 3 functions' worth of headroom it is not entitled to. The 11 that remain are each accounted
 * for in docs/security/supabase-advisor-baseline.md — 5 load-bearing in live RLS (81 policies
 * across 23 payroll/deductions/sales tables hang off `current_access_can_manage_employees()`
 * alone), 6 referenced by no live policy. `PRODUCTION_2026_09_29` above keeps the historical 14.
 */
const PRODUCTION_TODAY: AdvisorCount[] = [
  // 212, RAISED from 210 on 2026-10-13 — `public.database_restarts` (the Postgres crash-restart
  // log) and `public.address_brick_moves_20261013` (that day's brick-move pre-image), both triaged
  // by name in the baseline document, and neither reachable by a browser role: of the whole live
  // reading only 6 tables grant `anon`/`authenticated` anything and all 6 are Supabase-managed
  // `storage.*`, which the advisor's set excludes. 210 came from the 2026-10-09 triage, which
  // absorbed the 2026-09-30 "knowingly red at 177" pre-image table.
  // 260, RAISED from 212 on 2026-10-23 — 48 joined, all triaged in the baseline document: 42 in
  // the dated schema phx_backup_20261017, 3 in au (bak_20261015*), and 3 new server-only public
  // tables. None grants anon or authenticated anything (0 of all 260, read live that day).
  // 272, RAISED from 260 on 2026-10-26 — production read 267 (7 new server-only public tables), and
  // the audit change set adds 5 on purpose: the payroll resync outbox, the 3 notification-backup
  // tables with row security switched on, and deductions_categories with its open policy dropped.
  // 20261026120600 refuses to apply if any of them still grants a browser role anything.
  // 274, RAISED from 272 on 2026-10-27 — the two 26 Oct photo-point pre-images (oids 480362,
  // 480377), moved with the brick-move pre-image out of public into dated schemas by
  // 20261027235603; they leave the count when that schema retires. 0 browser grants, read live.
  { category: "rls_enabled_no_policy", current_count: 274 },
  { category: "function_search_path_mutable", current_count: 0 },
  // 0 since 2026-10-23: pg_trgm moved to `extensions` in 20261023043536 (was 1).
  { category: "extension_in_public", current_count: 0 },
  { category: "authenticated_security_definer_function_executable", current_count: 11 },
  // 842 = the highest daily reading to 2026-10-23 (the drift run that day; 833 an hour later);
  // raised from 722, which was itself the highest reading 1-9 October.
  { category: "unused_index", current_count: 842 },
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
    "the shipped baseline must be exactly PRODUCTION_TODAY's reading — no headroom",
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
    r.category === "rls_enabled_no_policy" ? { ...r, current_count: 275 } : r,
  );
  const growth = evaluateAdvisorCounts(REAL_BASELINE, grew);
  const exceeded = growth.find((f) => f.code === "advisor_baseline_exceeded");
  assert.ok(exceeded, "a single new untriaged table must fail the check");
  assert.equal(exceeded!.severity, "error");
  assert.match(exceeded!.message, /275/);
  assert.match(exceeded!.message, /\+1/, "the message must say HOW MUCH it grew, not just that it did");
  // 🔴 pg_trgm left `public` on 2026-10-23, so the floor is zero: an extension installed back into
  // `public` is growth, and fails.
  const backInPublic = evaluateAdvisorCounts(
    REAL_BASELINE,
    PRODUCTION_TODAY.map((r) => (r.category === "extension_in_public" ? { ...r, current_count: 1 } : r)),
  );
  assert.ok(
    backInPublic.some((f) => f.code === "advisor_baseline_exceeded" && /extension_in_public/.test(f.message)),
    "an extension back in public fails the check — the floor is zero since pg_trgm moved",
  );

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
  const wouldHaveCaught = evaluateAdvisorCounts(julyBaseline, PRODUCTION_2026_09_29)
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

  // ── the search_path floor ────────────────────────────────────────────────
  // 🔴 Phase 4 pinned all ten, so this is held at ZERO — not at "however many there are now".
  // Gating the LIVE count at 0 is stronger than a check over migration text, because it also
  // catches a function created through execute_sql, which is how most of this schema arrived
  // and the exact blind spot that let check:sql-backups stay green over the pre-image tables.
  assert.equal(
    REAL_BASELINE.categories.function_search_path_mutable.accepted,
    0,
    "the search_path baseline is a hard floor of zero — never 'however many exist today'",
  );
  const oneUnpinned = PRODUCTION_TODAY.map((r) =>
    r.category === "function_search_path_mutable" ? { ...r, current_count: 1 } : r,
  );
  const unpinnedV = evaluateAdvisorCounts(REAL_BASELINE, oneUnpinned)
    .find((f) => f.code === "advisor_baseline_exceeded");
  assert.ok(unpinnedV, "a SINGLE new unpinned function must fail the check");
  assert.match(unpinnedV!.message, /function_search_path_mutable/);

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
