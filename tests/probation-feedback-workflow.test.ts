import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { DEFAULT_PROBATION_CONFIG, DEFAULT_SCORECARD_DIMENSIONS } from "../src/lib/probation/intelligence/config.ts";
import { validateScorecard } from "../src/lib/probation/intelligence/scorecard.ts";
import { computeFeedbackSla, slaReminderKey } from "../src/lib/probation/intelligence/feedback-sla.ts";
import { resolveFeedbackAuth } from "../src/lib/probation/intelligence/feedback-workflow.ts";

function src(p: string) { return readFileSync(p, "utf8"); }

function fullScores(value = 7): Record<string, number> {
  const s: Record<string, number> = {};
  for (const d of DEFAULT_SCORECARD_DIMENSIONS) s[d] = value;
  return s;
}

export function runProbationFeedbackWorkflowTests() {
  const cfg = DEFAULT_PROBATION_CONFIG;

  // ── Scorecard (P4-T03) ──
  {
    const ok = validateScorecard({ scores: fullScores(8), recommendation: "on_track", strengths: "Strong closing" }, cfg);
    assert.equal(ok.ok, true, "complete scorecard validates");
    if (ok.ok) assert.equal(ok.scores.communication, 8);
  }
  // missing a dimension
  {
    const s = fullScores(); delete s.communication;
    const r = validateScorecard({ scores: s, recommendation: "on_track", strengths: "x" }, cfg);
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(r.errors.some((e) => e.includes("communication")));
  }
  // out of range + non-integer
  assert.equal(validateScorecard({ scores: { ...fullScores(), communication: 11 }, recommendation: "on_track", strengths: "x" }, cfg).ok, false);
  assert.equal(validateScorecard({ scores: { ...fullScores(), communication: 7.5 }, recommendation: "on_track", strengths: "x" }, cfg).ok, false);
  // unknown dimension
  assert.equal(validateScorecard({ scores: { ...fullScores(), made_up: 5 }, recommendation: "on_track", strengths: "x" }, cfg).ok, false);
  // missing / invalid recommendation
  assert.equal(validateScorecard({ scores: fullScores(), recommendation: null, strengths: "x" }, cfg).ok, false);
  assert.equal(validateScorecard({ scores: fullScores(), recommendation: "great", strengths: "x" }, cfg).ok, false);
  // no narrative (bare scores) rejected
  assert.equal(validateScorecard({ scores: fullScores(), recommendation: "on_track" }, cfg).ok, false);

  // ── SLA (P4-T06) ── anchor midnight of dv_date; due 24 / escalate 48 / overdue 72.
  {
    const dv = "2026-06-01"; // anchor 2026-06-01T00:00Z
    assert.equal(computeFeedbackSla(dv, "2026-06-01T12:00:00Z", cfg.sla).state, "pending", "before 24h = pending");
    assert.equal(computeFeedbackSla(dv, "2026-06-02T01:00:00Z", cfg.sla).state, "due", "past 24h = due");
    assert.equal(computeFeedbackSla(dv, "2026-06-03T01:00:00Z", cfg.sla).state, "escalated", "past 48h = escalated");
    assert.equal(computeFeedbackSla(dv, "2026-06-04T02:00:00Z", cfg.sla).state, "overdue", "past 72h = overdue");
    const od = computeFeedbackSla(dv, "2026-06-05T00:00:00Z", cfg.sla);
    assert.ok(od.hoursOverdue > 0, "overdue hours tracked");
    // Dedup key is state-specific.
    assert.notEqual(slaReminderKey("dv1", "due"), slaReminderKey("dv1", "overdue"));
  }

  // ── Row-level auth (P4-T05) ──
  {
    const evaluator = { role: "District Manager" as const, scope: "team" as const, hrId: "A-12" };
    assert.equal(resolveFeedbackAuth(evaluator, "A-12").isOwner, true, "evaluator owns their DV-Day feedback");
    assert.equal(resolveFeedbackAuth(evaluator, "A-12").canAct, true);
    const unrelated = { role: "District Manager" as const, scope: "team" as const, hrId: "X-9" };
    assert.equal(resolveFeedbackAuth(unrelated, "A-12").canAct, false, "unrelated manager cannot act");
    const admin = { role: "Super Admin" as const, scope: "company" as const, hrId: "B-10" };
    const a = resolveFeedbackAuth(admin, "A-12");
    assert.equal(a.canAct, true, "admin can act");
    assert.equal(a.isOverride, true, "admin acting on someone else's DV-Day is an override");
    // case-insensitive hr id match
    assert.equal(resolveFeedbackAuth({ role: "National Sales Manager" as const, scope: "line" as const, hrId: "a-12" }, "A-12").isOwner, true);
  }

  // ── Workflow guarantees (source assertions) ──
  const wf = src("src/lib/probation/intelligence/feedback-workflow.ts");
  assert.match(wf, /version_number: 1,\s*\n\s*action: "submit"/, "submit writes immutable version 1");
  assert.match(wf, /dv_status: "feedback_completed"/, "submit advances the DV-Day");
  assert.match(wf, /feedback already exists for this DV-Day/i, "duplicate submission blocked (P4-T09)");
  assert.match(wf, /an edit reason is required/i, "edit requires a reason (P4-T08)");
  assert.match(wf, /current\.currentVersion \+ 1/, "edit bumps the version");

  // The feedback SLA reminder sweep was retired 2026-08-02 (owner request) and its module
  // deleted, so the assertions that pinned its dedup key, recipient ladder, daily cap and
  // plain-English copy went with it. The scorecard/versioning guards above are unaffected.

  // ZEBRA TABLE GUARD (2026-07-17 owner report): the shared metadata-row table every
  // notification-type email renders through (probation and everything else) had no row styling —
  // a flat, hard-to-scan list. Fixed once, in the shared component, not just for probation.
  const layout = src("src/emails/phoenix-email-layout.tsx");
  assert.match(layout, /const isAlt = index % 2 === 1;/,
    "the shared metadata table alternates row background (zebra striping)");
  assert.match(layout, /phoenix-metadata-row-alt/,
    "alternating rows carry a class so dark-mode styles can re-tint the stripe");

  // ── Routes: coarse gate is probation:read; mutations CSRF-guarded ──
  const submitRoute = src("app/api/probation/dv/[dvDayId]/feedback/route.ts");
  assert.match(submitRoute, /assertPermission\(access, "probation", "read"\)/, "submit route gates on probation:read, not probation:update");
  assert.match(submitRoute, /assertSameOriginMutation/, "submit route is CSRF-guarded");
  const editRoute = src("app/api/probation/dv-feedback/[feedbackId]/route.ts");
  assert.match(editRoute, /assertSameOriginMutation/, "edit route is CSRF-guarded");
}
