import assert from "node:assert/strict";

import { createCapGate, PROBATION_DAILY_NOTIFICATION_CAP } from "@/lib/probation/intelligence/notification-cap.ts";
import { auditProbationOutboundEmail, type NotificationEmailInput } from "@/lib/notifications/email.ts";

/**
 * MOD-3 + MOD-4 (owner request 2026-07-17) — behavioral tests for the two probation-email guards:
 *   MOD-3: a per-recipient daily cap of 2 probation notification events (System Admin exempt).
 *   MOD-4: a pre-send correctness audit that blocks broken probation emails before they fire.
 */
export function runProbationNotificationControlsTests() {
  // ── MOD-3: per-recipient daily cap ──────────────────────────────────────────────
  assert.equal(PROBATION_DAILY_NOTIFICATION_CAP, 2, "the cap is 2 probation notifications per recipient per day");

  {
    // A recipient with nothing sent yet gets exactly the cap, then is blocked.
    const gate = createCapGate("2026-07-17", new Map());
    assert.equal(gate.allow("B-100"), true, "1st notification allowed");
    assert.equal(gate.allow("B-100"), true, "2nd notification allowed (at the cap)");
    assert.equal(gate.allow("B-100"), false, "3rd notification blocked (over cap → defers to tomorrow)");
    // A different recipient has an independent budget.
    assert.equal(gate.allow("B-200"), true, "a different recipient is not affected by B-100's usage");
  }

  {
    // A recipient who already received 1 today gets only 1 more this run.
    // Baseline keys are canonical (lowercase) HR_IDs — exactly how createProbationDailyCap builds
    // them via normalizeHrId; allow() normalizes its argument the same way, so "B-100" matches.
    const gate = createCapGate("2026-07-17", new Map([["b-100", 1]]));
    assert.equal(gate.allow("B-100"), true, "1 already sent + 1 more = at the cap");
    assert.equal(gate.allow("B-100"), false, "the 2nd this-run would be the 3rd today → blocked");
  }

  {
    // A recipient already at the cap is blocked immediately.
    const gate = createCapGate("2026-07-17", new Map([["b-100", 2]]));
    assert.equal(gate.allow("B-100"), false, "already at the cap → blocked on the first check");
  }

  {
    // PHX-1 (System Admin) is EXEMPT — never blocked, never counted.
    const gate = createCapGate("2026-07-17", new Map([["phx-1", 99]]));
    for (let i = 0; i < 5; i++) {
      assert.equal(gate.allow("PHX-1"), true, "System Admin (PHX-1) is exempt from the daily cap");
    }
    // A null/blank recipient is never allowed (nothing to key on).
    assert.equal(gate.allow(null), false, "null recipient is not allowed");
    assert.equal(gate.allow("   "), false, "blank recipient is not allowed");
  }

  // ── MOD-4: pre-send correctness audit ───────────────────────────────────────────
  const base = (over: Partial<NotificationEmailInput> = {}): NotificationEmailInput => ({
    notificationType: "probation",
    subject: "Probation feedback needed — Momen Abdelhady",
    summary: "A Double-Visit day was completed with Momen Abdelhady.",
    title: "Probation feedback needed — Momen Abdelhady",
    employeeHrId: "AI-0002",
    metrics: [
      { label: "Employee", value: "Momen Abdelhady" },
      { label: "Visit date", value: "2026-06-23" },
      { label: "Status", value: "Feedback needed" },
    ],
    templateContext: { employeeName: "Momen Abdelhady", line: "Pedia" },
    ...over,
  });

  assert.equal(auditProbationOutboundEmail(base()).ok, true, "a well-formed probation email passes the audit");

  // Unresolved token anywhere user-facing is a hard fail.
  assert.equal(auditProbationOutboundEmail(base({ subject: "Probation feedback — {{employeeName}}" })).ok, false,
    "unresolved token in the subject is blocked");
  assert.equal(
    auditProbationOutboundEmail(base({ metrics: [{ label: "Employee", value: "{{employeeName}}" }] })).ok,
    false, "unresolved token in a metric value is blocked");
  assert.equal(
    auditProbationOutboundEmail(base({ templateContext: { employeeName: "Momen", digestTable: "{{digestTable}}" } })).ok,
    false, "unresolved token in a template-context value is blocked");

  // A blank subject AND title is a fail.
  assert.equal(auditProbationOutboundEmail(base({ subject: "  ", title: "" })).ok, false,
    "an email with no subject/title is blocked");
  // A blank subject alone (title present) still passes — the recipient sees the title.
  assert.equal(auditProbationOutboundEmail(base({ subject: "" })).ok, true,
    "a present title covers a blank subject");

  // The employee must be shown by NAME, never a bare HR_ID (CLAUDE.md "show names not codes").
  assert.equal(
    auditProbationOutboundEmail(base({ metrics: [{ label: "Employee", value: "AI-0002" }] })).ok,
    false, "an Employee metric that is the raw HR_ID is blocked");
  assert.equal(
    auditProbationOutboundEmail(base({ templateContext: { employeeName: "AI-0002" } })).ok,
    false, "an employeeName that is the raw HR_ID is blocked");
  // Case-insensitive HR_ID match.
  assert.equal(
    auditProbationOutboundEmail(base({ employeeHrId: "ai-0002", metrics: [{ label: "Employee", value: "AI-0002" }] })).ok,
    false, "the HR_ID match is case-insensitive");

  // Non-probation emails are NOT audited by this gate (it is probation-scoped) — but the function is
  // pure, so calling it on a clean payload still passes.
  assert.equal(auditProbationOutboundEmail(base({ notificationType: "general" })).ok, true,
    "a clean payload passes regardless of type (the gate is applied only to probation in the drain)");
}
