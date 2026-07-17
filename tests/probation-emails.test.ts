import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function src(p: string) { return readFileSync(p, "utf8"); }

export function runProbationEmailsTests() {
  const engine = src("src/lib/email-templates/service.ts");

  // ── P9-T01 templates registered in the admin email-template engine (not hardcoded) ──
  for (const key of ["probation_dv_snapshot", "probation_weekly_digest", "probation_day30", "probation_day60", "probation_day75"]) {
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
  // REGRESSION GUARD (prod incidents 2026-07-14). A probation email token must be in THREE places:
  // (1) EmailTemplateContext type, (2) placeholderHints (editor validation allowlist), and CRUCIALLY
  // (3) contextVariables() — the render map that interpolate() reads. Missing (3) is what shipped the
  // blank DV date / evaluator / score / risk / day emails (the first hotfix only fixed (2)).
  const renderCore = src("src/lib/email-templates/render-core.ts");
  for (const token of ["probationDay", "dvDate", "evaluatorName", "evaluatorRole", "visitCount", "dvProgress", "riskStatus", "provisionalScore", "daysRemaining", "milestoneDay"]) {
    assert.ok(engine.includes(`"${token}"`), `${token} is in the placeholderHints allowlist`);
    assert.ok(renderCore.includes(`${token}: text(input.${token})`), `${token} is mapped in contextVariables() render map (render-core.ts)`);
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

  // ── MOD-1 (2026-07-17): WEEKLY digest replaces the per-DV-day snapshot email ──
  // Owner report: one probation email fired on EVERY validated Double-Visit day flooded ~8
  // stakeholders' inboxes. Replaced by a single weekly digest per probationer, to the line
  // management chain, greeting "Dear Line {Line} Managers".
  assert.match(engine, /probation_weekly_digest: "Employee Lifecycle"/, "weekly digest has a category");
  assert.match(engine, /greeting: "Dear Line \{\{line\}\} Managers,"/,
    'weekly digest greets the line management chain by line name ("Dear Line Pedia Managers,")');
  assert.match(emails, /export async function processProbationWeeklyDigest/, "weekly digest sweep exists");
  assert.match(emails, /cairoWeekday\(now\) !== WEEKLY_DIGEST_WEEKDAY/, "weekly digest self-gates to one Cairo weekday (safe to call daily)");
  assert.match(emails, /templateKey: "probation_weekly_digest"/, "digest emits via the registered weekly template");
  assert.match(emails, /idempotencyKeyBase: `probation:weekly-digest:\$\{c\.id\}:\$\{weekStart\}`/, "one digest per (probationer, week) — deduped");
  assert.match(emails, /\.filter\(\(c\) => c\.status === "active"\)/, "digest is per active probationer");
  assert.match(emails, /includeTm: true, includePmGpm: true, includeSfe: true/, "digest goes to TM + PM/GPM + SFE (line chain), plus DM/NSM/CEO/HR defaults");

  // ── MOD-3 (2026-07-17): per-recipient daily cap gates the milestone + digest fan-out too ──
  assert.match(emails, /const allowed = input\.cap \? recipients\.filter\(\(h\) => input\.cap!\.allow\(h\)\) : recipients/,
    "emitToRecipients drops over-cap recipients when a daily cap is supplied");
  assert.match(emails, /const cap = await createProbationDailyCap\(/, "milestone + weekly sweeps build the daily cap");

  // ── Wiring ──
  // MOD-1: the per-DV-day snapshot email is NO LONGER fired from the CRM sync (replaced by the weekly
  // digest). The tracked ids are retained for telemetry only.
  const sync = src("src/lib/probation/intelligence/dv-sync.ts");
  assert.doesNotMatch(sync, /sendDvSnapshotEmail\(/, "per-DV-day snapshot email is no longer wired into the CRM sync (MOD-1)");
  assert.match(sync, /if \(r\.dv_status === "validated"\) newValidatedDvDayIds\.push/, "newly-validated DV-Days are still tracked (telemetry)");
  const cron = src("src/lib/notifications/scheduled-processing.ts");
  assert.match(cron, /processProbationMilestoneEmails\(\)/, "milestone sweep wired into the notifications cron");
  const dailyRoute = src("app/api/notifications/daily/route.ts");
  assert.match(dailyRoute, /processProbationWeeklyDigest\(\)/, "weekly digest wired into the daily notifications cron");
}
