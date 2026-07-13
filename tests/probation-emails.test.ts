import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function src(p: string) { return readFileSync(p, "utf8"); }

export function runProbationEmailsTests() {
  const engine = src("src/lib/email-templates/service.ts");

  // ── P9-T01 templates registered in the admin email-template engine (not hardcoded) ──
  for (const key of ["probation_dv_snapshot", "probation_day30", "probation_day60", "probation_day75"]) {
    assert.ok(engine.includes(`"${key}"`), `${key} registered in the email-template engine`);
    // Category assigned.
    assert.match(engine, new RegExp(`${key}: "Employee Lifecycle"`), `${key} has a category`);
    // Default recipient rules present.
    assert.match(engine, new RegExp(`${key}: emptyRules\\(`), `${key} has default recipient rules`);
  }
  // Each milestone template has a DISTINCT purpose (not a shared body).
  assert.match(engine, /Day 30 — early progress review/i, "Day 30 = early progress");
  assert.match(engine, /Day 60 — escalation/i, "Day 60 = escalation/completion planning");
  assert.match(engine, /Day 75 — decision readiness/i, "Day 75 = decision readiness");
  // Day 75 must NOT auto-decide.
  assert.match(engine, /No automatic decision is made/i, "Day 75 explicitly makes no automatic decision");
  // Tokens added.
  assert.match(engine, /dvProgress\?: string \| null/, "dvProgress token added to EmailTemplateContext");
  assert.match(engine, /milestoneDay\?: string \| null/, "milestoneDay token added");
  // REGRESSION GUARD (prod incident 2026-07-14): the probation tokens must ALSO be in the render
  // allowlist (placeholderHints). Declaring them only on the type let the renderer strip them to empty,
  // so the DV-snapshot + milestone emails went out with blank DV date / evaluator / score / risk / day.
  for (const token of ["probationDay", "dvDate", "evaluatorName", "evaluatorRole", "visitCount", "dvProgress", "riskStatus", "provisionalScore", "daysRemaining", "milestoneDay"]) {
    assert.ok(engine.includes(`"${token}"`), `${token} is in the render allowlist (placeholderHints), not just the type`);
  }

  const emails = src("src/lib/probation/intelligence/probation-emails.ts");

  // ── P9-T04 recipients match the owner-confirmed matrix ──
  // CEO + HR always resolved.
  assert.match(emails, /activeHrIdsByRole\(\["CEO"\]\)/, "CEO resolved");
  assert.match(emails, /activeHrIdsByRole\(\["HR Manager", "Super Admin"\]\)/, "HR resolved");
  // DV snapshot includes evaluator + TM + PM/GPM + SFE.
  assert.match(emails, /includeEvaluator: d\.evaluator_hr_id, includeTm: true, includePmGpm: true, includeSfe: true/, "DV snapshot = full stakeholder set incl. evaluator/TM/PM·GPM/SFE");
  // Milestones include SFE (per confirmed matrix); DM+NSM+CEO+HR always.
  assert.match(emails, /resolveStakeholders\(c\.employee_hr_id, \{ includeSfe: true \}\)/, "milestone recipients include SFE");
  // NSM resolved by walking the management chain.
  assert.match(emails, /National Sales Manager/, "NSM resolved via role");
  // PM/GPM line-matched and excluded for CNS.
  assert.match(emails, /toLowerCase\(\) !== "cns"/, "PM/GPM not applicable to CNS");
  assert.match(emails, /pm\?\.lineId === employee\.lineId/, "PM/GPM matched by line");

  // ── P9-T05 dedup + template usage ──
  assert.match(emails, /idempotencyKey: `\$\{input\.idempotencyKeyBase\}:\$\{recipientHrId\}`/, "one email per (event, recipient) — deduped");
  assert.match(emails, /probation:dv-snapshot:\$\{d\.id\}/, "DV snapshot deduped per DV-Day");
  assert.match(emails, /probation:milestone:\$\{c\.id\}:day\$\{m\.day\}/, "milestone deduped per case+day");
  assert.match(emails, /templateKey: input\.templateKey/, "emits via the registered template key");
  // Milestones fire once each threshold is reached.
  assert.match(emails, /if \(day < m\.day \|\| day > m\.day \+ MILESTONE_GRACE_DAYS\) continue;/, "milestone fires only within the recent grace window (no stale backfill burst)");

  // ── Wiring ──
  const sync = src("src/lib/probation/intelligence/dv-sync.ts");
  assert.match(sync, /sendDvSnapshotEmail\(dvDayId, syncedAt\)\.catch/, "DV snapshot wired into the CRM sync (non-blocking)");
  assert.match(sync, /if \(r\.dv_status === "validated"\) newValidatedDvDayIds\.push/, "snapshot only for newly validated DV-Days");
  const cron = src("src/lib/notifications/scheduled-processing.ts");
  assert.match(cron, /processProbationMilestoneEmails\(\)/, "milestone sweep wired into the notifications cron");
}
