import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
  enforceAttendanceAlertEmailBlock,
  isAttendanceIngestionAlertEvent,
} from "@/lib/notifications/attendance-alert-channel-guard";

const systemSource = readFileSync(
  new URL("../src/lib/notifications/system.ts", import.meta.url),
  "utf8",
);
const ingestionSource = readFileSync(
  new URL("../src/lib/attendance/ingestion-health.ts", import.meta.url),
  "utf8",
);
const policySource = readFileSync(
  new URL("../src/lib/notifications/policy.ts", import.meta.url),
  "utf8",
);

/**
 * OWNER RULE: the attendance ingestion alert must NEVER be delivered by email.
 * In-app and push only.
 *
 * Email was already "retired" for this alert in two co-operating places — the
 * `channels` passed at the call site, and the policy.ts entry. Two values that
 * must agree are exactly what drifts apart, and a Telegram-failure fallback can
 * re-enter the pipeline with `channels: ["email","in_app"]` regardless of both.
 * This asserts the hard post-filter, so the rule survives a future edit to either
 * config.
 *
 * Also covered: a DISABLED alert must stay silent. Before this, the disabled path
 * still emitted, resolved zero recipients, and wrote a fail-closed
 * "no exact authorized recipient was resolved" row per channel every night — which
 * reads like a broken security control rather than an admin toggle, and cost a full
 * investigation to trace back to a switch flipped on 2026-07-24.
 */
export function runAttendanceAlertNoEmailTests() {
  const ALL = ["in_app", "email", "push", "telegram"] as const;

  // ── The rule, behaviourally ────────────────────────────────────────────────
  const blocked = enforceAttendanceAlertEmailBlock(ALL, "attendance", "attendance_agent_ingestion_stalled");
  assert.ok(!blocked.includes("email"), "the attendance ingestion alert must never keep an email channel");
  assert.ok(blocked.includes("in_app"), "in_app must survive the block");
  assert.ok(blocked.includes("push"), "push must survive the block");

  // Even if a caller explicitly asks for email only, it must resolve to no email.
  assert.deepEqual(
    enforceAttendanceAlertEmailBlock(["email"], "attendance", "attendance_agent_ingestion_stalled"),
    [],
    "an explicit email-only request for this alert must resolve to no channel at all, not to email",
  );

  // ── It must not over-reach ────────────────────────────────────────────────
  // Ordinary attendance notifications to employees keep their email.
  assert.ok(
    enforceAttendanceAlertEmailBlock(ALL, "attendance", "shift_updated").includes("email"),
    "other attendance notifications must keep email — the block is keyed on the stall alert only",
  );
  assert.ok(
    enforceAttendanceAlertEmailBlock(ALL, "payroll", "attendance_agent_ingestion_stalled").includes("email"),
    "the block must be scoped to the attendance module, not the event name alone",
  );

  assert.equal(isAttendanceIngestionAlertEvent("attendance", "attendance_agent_ingestion_stalled"), true);
  assert.equal(isAttendanceIngestionAlertEvent("Attendance", "ATTENDANCE_AGENT_INGESTION_STALLED"), true, "matching must be case-insensitive");
  assert.equal(isAttendanceIngestionAlertEvent("attendance", "shift_updated"), false);
  assert.equal(isAttendanceIngestionAlertEvent(null, null), false);

  // ── The guard must actually be wired into the resolved channel list ────────
  assert.match(
    systemSource,
    /enforceAttendanceAlertEmailBlock\([\s\S]{0,80}input\.module, input\.eventType\)/,
    "basePolicyChannels must apply the attendance email block to the RESOLVED channels, or the guard is decorative",
  );

  // The policy entry must still say in_app + push, so config and guard agree.
  assert.match(
    policySource,
    /"attendance\.attendance_agent_ingestion_stalled": \{ channels: \["in_app", "push"\]/,
    "the policy entry for the stall alert must stay in_app + push",
  );

  // ── A disabled alert must short-circuit before emitting ────────────────────
  assert.match(
    ingestionSource,
    /if \(!\(await resolveNotificationRoleEnabled\("attendance_ingestion_alert"\)\)\) \{\s*\n\s*return \{ notified: false/,
    "runAttendanceIngestionAlert must return early when the alert is disabled, instead of emitting a notification that resolves nobody and logs a fail-closed governance error every night",
  );

  // ── Enabled-but-nobody-deliverable must report the real problem ────────────
  assert.match(
    ingestionSource,
    /if \(superAdminHrIds\.length === 0\) \{[\s\S]{0,220}enabled but resolved no active recipient/,
    "an enabled alert with no resolvable recipient must surface that plainly, not manufacture a governance-failure row",
  );

  // ── The call site must not reintroduce email ───────────────────────────────
  assert.match(
    ingestionSource,
    /channels: \["in_app", "push"\]/,
    "the alert call site must keep in_app + push only",
  );
}
