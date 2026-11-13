import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  isBeforeProbationEmailFreshStart,
  isDateBeforeProbationEmailFreshStart,
  PROBATION_EMAIL_FRESH_START_ISO,
} from "../src/lib/probation/intelligence/email-fresh-start.ts";
import { phoenixRoles } from "../src/lib/auth/permissions.ts";
import { getTemplatePlaceholderHints } from "../src/lib/email-templates/service.ts";
import { contextVariables } from "../src/lib/email-templates/render-core.ts";

function src(p: string) { return readFileSync(p, "utf8"); }

export function runProbationEmailsTests() {
  const engine = src("src/lib/email-templates/service.ts");

  // ── P9-T01 templates registered in the admin email-template engine (not hardcoded) ──
  for (const key of ["probation_dv_snapshot", "probation_weekly_digest", "probation_day30", "probation_day60", "probation_day75"]) {
    assert.ok(engine.includes(`"${key}"`), `${key} registered in the email-template engine`);
    // Category assigned. (Reassigned from "Employee Lifecycle" to the finer-grained
    // "Probation" module category — 2026-07-22 admin email-templates page regrouping.)
    assert.match(engine, new RegExp(`${key}: "Probation"`), `${key} has a category`);
    // Default recipient rules present.
    assert.match(engine, new RegExp(`${key}: emptyRules\\(`), `${key} has default recipient rules`);
  }
  // Each milestone template has a DISTINCT purpose (not a shared body).
  assert.match(engine, /Day 30 — early progress review/i, "Day 30 = early progress");
  assert.match(engine, /Day 60 — escalation/i, "Day 60 = escalation/completion planning");
  assert.match(engine, /Day 75 — decision readiness/i, "Day 75 = decision readiness");
  // Day 75 must NOT auto-decide.
  assert.match(engine, /No automatic decision is made/i, "Day 75 explicitly makes no automatic decision");
  // The automated-reminder note (owner, 2026-09-29): every milestone template says, in one line, that
  // it is an automated Day 30/60/75 probation reminder — in BOTH the HTML and the text body, so the
  // recipient knows the mail is system-generated whichever the client renders.
  const automatedNote = (engine.match(/This is an automated Day 30 \/ 60 \/ 75 probation reminder\./g) ?? []).length;
  assert.equal(automatedNote, 6, "each of the 3 milestone templates carries the automated-reminder note in both bodyHtml and bodyText");
  // Tokens added.
  assert.match(engine, /dvProgress\?: string \| null/, "dvProgress token added to EmailTemplateContext");
  assert.match(engine, /milestoneDay\?: string \| null/, "milestoneDay token added");
  // REGRESSION GUARD (prod incidents 2026-07-14). A probation email token must be in THREE places:
  // (1) EmailTemplateContext type, (2) placeholderHints (editor validation allowlist), and CRUCIALLY
  // (3) contextVariables() — the render map that interpolate() reads. Missing (3) is what shipped the
  // blank DV date / evaluator / score / risk / day emails (the first hotfix only fixed (2)).
  // (2) and (3) now derive from TOKEN_REGISTRY (2026-07-23 consolidation — see token-registry.ts),
  // so this checks the real runtime behavior of getTemplatePlaceholderHints()/contextVariables()
  // rather than scanning for the specific hand-listed source patterns that no longer exist.
  const placeholderHints = new Set<string>(getTemplatePlaceholderHints());
  const renderedKeys = new Set(Object.keys(contextVariables({}, "Team")));
  for (const token of ["probationDay", "dvDate", "evaluatorName", "evaluatorRole", "visitCount", "dvProgress", "riskStatus", "provisionalScore", "daysRemaining", "milestoneDay"]) {
    assert.ok(placeholderHints.has(token), `${token} is in the placeholderHints allowlist`);
    assert.ok(renderedKeys.has(token), `${token} is mapped in contextVariables() render map`);
  }

  // The emitter internals, recipient matrix, dedup keys and daily-cap assertions that lived
  // here all read probation-emails.ts, which was deleted 2026-08-02 (all three of its exports
  // were uncalled). The template-engine, placeholder-token and wiring guards are unaffected.

  assert.ok(
    !(phoenixRoles as readonly string[]).includes("HR Manager"),
    'resolveBroadcastRoleIds\'s legacy (non-override) activeHrIdsByRole(["HR Manager", "Super Admin"]) call effectively resolves Super Admin accounts only — "HR Manager" is a job title, not a real PhoenixRole, so it can never match a row (regression guard: goes red the moment "HR Manager" is ever promoted to a real role, which would silently expand DV-snapshot/milestone broadcast recipients)',
  );

  // ── Wiring ──
  // MOD-1: the per-DV-day snapshot email is NO LONGER fired from the CRM sync (replaced by the weekly
  // digest). The tracked ids are retained for telemetry only.
  const sync = src("src/lib/probation/intelligence/dv-sync.ts");
  assert.doesNotMatch(sync, /sendDvSnapshotEmail\(/, "per-DV-day snapshot email is no longer wired into the CRM sync (MOD-1)");
  assert.match(sync, /if \(r\.dv_status === "validated"\) newValidatedDvDayIds\.push/, "newly-validated DV-Days are still tracked (telemetry)");
  // Both probation email sweeps were RETIRED 2026-08-02 at the owner's request: the day 30/60/75
  // milestone emails (5-minute cron) and the weekly Double-Visit digest (daily cron). These
  // assertions are inverted rather than deleted so a future re-wiring is a deliberate act that
  // has to update this test, not an accident.
  const cron = src("src/lib/notifications/scheduled-processing.ts");
  assert.doesNotMatch(cron, /processProbationMilestoneEmails\(/, "probation milestone sweep was retired — it must not be re-wired into the notifications cron");
  const dailyRoute = src("app/api/cron/daily/_lib/daily-job-runners.ts");
  assert.doesNotMatch(dailyRoute, /processProbationWeeklyDigest\(/, "probation weekly digest was retired — it must not be re-wired into the daily cron");

  // ── FRESH START (owner directive 2026-07-17): no catch-up emails on re-enable ──
  // Behavioral: the cutoff helpers classify pre-reset vs post-reset activity correctly.
  const cutoffDay = PROBATION_EMAIL_FRESH_START_ISO.slice(0, 10);
  assert.equal(isBeforeProbationEmailFreshStart("2026-07-01T09:00:00Z"), true, "a pre-reset timestamp is suppressed");
  assert.equal(isBeforeProbationEmailFreshStart("2026-08-01T09:00:00Z"), false, "a post-reset timestamp emails");
  assert.equal(isBeforeProbationEmailFreshStart(null), false, "a null timestamp is not treated as pre-reset");
  assert.equal(isDateBeforeProbationEmailFreshStart("2026-07-16"), true, "a milestone crossed before the reset day is suppressed");
  assert.equal(isDateBeforeProbationEmailFreshStart(cutoffDay), false, "a crossing on the reset day itself emails");
  // The sweeps that consumed this cutoff (SLA reminders, milestone emails, weekly digest) were all
  // retired and their modules deleted, so there is no longer a caller to assert it against. The
  // helper itself is kept and tested above: it is exported, and the cutoff semantics are the
  // owner directive, not an implementation detail of any one sweep.
}
