import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function setEntries(text: string, declaration: RegExp, label: string) {
  const match = text.match(declaration);
  assert.ok(match, `${label} must still exist`);
  return (match?.[1] ?? "")
    .split(",")
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

/**
 * 159 official workflow emails were refused by the email identity guard and written off as
 * `notification_deliveries.status = 'skipped'` — a status nothing alarms on and no dashboard
 * counts, so the loss stayed invisible for months. Measured on production 2026-09-06.
 *
 * The guard was RIGHT every time. `resolvedEmailIdentity()` refuses to send an official
 * workflow email whose data subject it cannot identify, because the alternative is mailing one
 * employee's details under another employee's name. Three callers were wrong, in three
 * different ways that shared the one symptom:
 *
 *   plan_awaiting_verification  60 rows, 0 sent, 2026-08-29 -> 09-04.  CONFLICTING subject.
 *       (Its sender, src/lib/crm/plan-notifications.ts, went with iReports360 on 6 November 2026.)
 *       The caller put the rep in `subjectHrId` and the rep's MANAGER in `email.employeeHrId`,
 *       so two different people claimed the single subject slot (PD-0010, a District Sales
 *       Manager; B-58, his Medical Representative). `email.employeeHrId` is the SUBJECT, not
 *       the recipient — it drives the employee contact lookup, the detail tokens and the
 *       manager-chain CC. Naming the manager there would, once unblocked, have CC'd the
 *       manager's OWN manager on every rep plan notice.
 *
 *   excuse_sla_reminder         27 rows, 0 sent, 2026-08-08 -> 09-06.  MISSING subject. The
 *       query never selected `employee_hr_id`, so no subject could be passed at all.
 *
 *   drift_alert (weekly_plans)  25 rows, 0 sent, 2026-08-16 -> 09-06.  NO subject EXISTS. It
 *       is a digest of many employees addressed to admin role recipients, so it is exempted as
 *       an aggregate digest rather than handed an invented subject.
 *
 * The rule this pins: every official workflow email supplies EXACTLY ONE subject HR ID — never
 * zero, never two — and a digest with no single subject is exempted by event type rather than
 * given a fake one. The final section pins that the guard itself was not weakened to achieve
 * any of that, which is the failure mode this fix had to avoid.
 */
export function runEmailIdentityGuardCallersTests() {
  const systemSource = source("src/lib/notifications/system.ts");
  const excusesServiceSource = source("src/lib/excuses/service.ts");
  const outstationSource = source("src/lib/outstation/service.ts");

  // ── excuse_sla_reminder: the subject is the EMPLOYEE whose excuse is pending ────────────
  assert.match(
    excusesServiceSource,
    /\.select\("id, employee_hr_id, employee_name, excuse_date, excuse_type, created_at, manager_hr_id"\)/,
    "runExcuseSlaDaily must select employee_hr_id — without it there is no subject to pass and the email " +
      "half of every reminder is refused (27 skipped, zero sent)",
  );
  assert.match(
    excusesServiceSource,
    /subjectHrId: String\(row\.employee_hr_id\),/,
    "the excuse SLA reminder must name the employee whose excuse is pending as its subject, not the " +
      "manager who approves it",
  );
  assert.match(
    excusesServiceSource,
    /recipientHrId: String\(row\.manager_hr_id\),/,
    "the manager remains the recipient of the excuse SLA reminder — subject and recipient are different " +
      "people here, which is exactly why the subject has to be passed explicitly",
  );

  // ── drift_alert: a genuine digest, exempted rather than given an invented subject ───────
  const digestEventTypes = setEntries(
    systemSource,
    /const aggregateDigestEventTypes = new Set\(\[([^\]]*)\]\);/,
    "aggregateDigestEventTypes",
  );
  assert.ok(
    digestEventTypes.includes("drift_alert"),
    "drift_alert must be exempt as an aggregate digest: both emitters roll many employees into one " +
      "operational message for admin role recipients, so there is no single data subject to name",
  );
  assert.ok(
    digestEventTypes.includes("high_risk_digest"),
    "the pre-existing high_risk_digest exemption must survive",
  );

  // Neither drift emitter may satisfy the guard by inventing a subject instead.
  for (const path of ["src/lib/weekly-planning/drift-check.ts", "src/lib/excuses/drift-check.ts"]) {
    assert.doesNotMatch(
      source(path),
      /subjectHrId/,
      `${path} is a digest with no single data subject — it must stay exempt by event type and must never ` +
        "name an arbitrary employee as the subject of a report that is not about them",
    );
  }

  // ── outstation_departure_photo_due: the one whose loss reached nobody ───────────────────
  // 8 reminders lost their email; push covered 5 and three employees were told nothing at all on
  // any channel. Expense evidence that is never requested is a claim that later lacks it.
  assert.match(
    outstationSource,
    /subjectHrId: row\.employeeHrId,/,
    "the departure-photo reminder must keep its subject HR ID — this is the one guard skip that reached nobody",
  );

  // Its sibling had the SAME missing-subject fault, but latent: outstation_sla_reminder has never
  // produced a single delivery row in production, so nothing had ever exercised it. Left alone it
  // would have refused its email the first time the job fired, as a brand-new silent skip.
  assert.match(
    outstationSource,
    /subjectHrId: String\(row\.employee_hr_id\),/,
    "the outstation SLA reminder must name the requesting employee as its subject — the recipients are " +
      "the approvers, and module outstation is guarded, so without it the first-ever fire is refused",
  );

  // ── Both outstation reminders must offer the in-app channel (owner decision 2026-09-06) ────
  // Email was refused by the guard and push is separately unreliable here ("OneSignal is not
  // configured", "No active push subscription"), which is how three departure-photo reminders
  // reached nobody on any channel. in_app is the channel that cannot fail for want of external
  // configuration, and the module's two other notifications already carry it.
  assert.equal(
    (outstationSource.match(/channels: \["in_app", "email", "push"\],/g) ?? []).length,
    2,
    "both outstation reminders (departure photo, SLA) must include in_app alongside email and push",
  );
  assert.doesNotMatch(
    outstationSource,
    /channels: \["email", "push"\]/,
    "no outstation notification may ship with email+push only — that combination is what let three " +
      "departure-photo reminders reach nobody at all",
  );

  // ── THE GUARD ITSELF MUST NOT HAVE BEEN WEAKENED ───────────────────────────────────────
  // Every assertion above is satisfiable by gutting resolvedEmailIdentity() instead of fixing the
  // callers. These pin that nobody did.
  assert.match(
    systemSource,
    /Conflicting subject HR IDs were provided for email identity/,
    "the conflicting-identity refusal must remain: two candidate subjects must never be silently resolved to one",
  );
  assert.match(
    systemSource,
    /Subject employee HR ID is missing for an official workflow email\./,
    "the missing-subject refusal must remain",
  );
  assert.match(
    systemSource,
    /if \(unique\.length > 1\) \{/,
    "the conflict branch must still fire on more than one distinct candidate",
  );
  assert.match(
    systemSource,
    /if \(required && !subjectHrId\) \{/,
    "an official workflow email with no subject must still be refused",
  );

  // The modules whose mail is per-employee must all stay inside the guard. Dropping any one of
  // them would make a caller "pass" by no longer being checked at all.
  const workflowModules = setEntries(
    systemSource,
    /const employeeSubjectWorkflowModules = new Set\(\[([\s\S]*?)\]\);/,
    "employeeSubjectWorkflowModules",
  );
  for (const moduleName of [
    "excuse",
    "excuses",
    "outstation",
    "probation",
    "resignations",
    "vacation",
    "weekly_plans",
  ]) {
    assert.ok(
      workflowModules.includes(moduleName),
      `"${moduleName}" must stay in employeeSubjectWorkflowModules — removing a module is how a caller stops ` +
        "being checked without anyone noticing the guard was disarmed",
    );
  }

  // The exemption is by EVENT TYPE and applies only when no candidate was supplied. If a digest
  // ever does carry a subject, it must still be verified rather than waved through.
  assert.match(
    systemSource,
    /function emailSubjectIdentityRequired\(input: CreateSystemNotificationInput, hasSubjectCandidate: boolean\) \{\s*\n\s*if \(hasSubjectCandidate\) return true;/,
    "a supplied subject must always be verified — the digest exemption may only apply when no candidate was " +
      "passed at all",
  );

  // ── A GUARD REJECTION MUST BE VISIBLE SOMEWHERE ────────────────────────────────────────
  // The whole reason 159 refusals went unnoticed for 68 days is that a refusal is recorded as
  // status='skipped', which nothing alarms on and no dashboard counts. Fixing the callers stops
  // today's bleed; this reconciliation check is what makes the NEXT one visible within a day.
  const reconciliationSource = source("src/lib/reconciliation/checks/notifications-integrity.ts");
  const emailModuleSource = source("src/lib/notifications/email.ts");

  assert.match(
    reconciliationSource,
    /id: "email-identity-guard-refused-no-official-workflow-email",/,
    "the guard-rejection reconciliation check must exist — a refusal that alarms nothing is how this " +
      "defect stayed invisible for 68 days",
  );
  assert.match(
    reconciliationSource,
    /emailIdentityGuardRefusedNothing,\s*\n\];/,
    "the check must be REGISTERED in notificationsIntegrityReconciliationChecks — an unregistered check " +
      "never runs, which is the same silence it was written to end",
  );
  assert.match(
    reconciliationSource,
    /expectation: "holds",/,
    "the check must expect to hold: the steady state after #3354 and #3358 is zero refusals",
  );

  // It must match on the guard's OWN prefix, imported rather than copied. A copy silently empties
  // the check the day somebody rewords the refusal, and an empty check reports green.
  assert.match(
    emailModuleSource,
    /export const identityGuardFailurePrefix = "Email identity guard failed";/,
    "the guard failure prefix must be exported so the check can match the guard's own wording",
  );
  assert.match(
    reconciliationSource,
    /import \{ identityGuardFailurePrefix \} from "@\/lib\/notifications\/email";/,
    "the check must import the prefix, never restate it — a copy drifts and a drifted check reports green",
  );
  assert.match(
    reconciliationSource,
    /\.ilike\("last_error", `\$\{identityGuardFailurePrefix\}%`\)/,
    "the check must filter on the guard prefix",
  );

  // Scope: guard refusals ONLY. Counting every 'skipped' row would fire constantly on legitimate
  // skips and become wallpaper — the failure mode this repo has already lived through with a
  // session count that read 9 for hours while nobody acted.
  assert.doesNotMatch(
    reconciliationSource,
    /const emailIdentityGuardRefusedNothing[\s\S]*?holds: rejections\.length >= /,
    "the check must breach on ANY guard refusal, never on a threshold above zero",
  );
  assert.match(
    reconciliationSource,
    /holds: rejections\.length === 0,/,
    "one refused official workflow email is already a defect — the check holds only at zero",
  );
}
