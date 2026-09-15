import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { enforceAttendanceDigestEmailBlock, isAttendanceDigestModule } from "../src/lib/notifications/attendance-digest-channel-guard.ts";
import { resolveNotificationPolicy } from "../src/lib/notifications/policy.ts";
import { defaultTelegramPolicyFor } from "../src/lib/notifications/telegram-governance.ts";

// Owner rule (2026-09-15): when a week of attendance is released, the employee is told IN-APP and
// by TELEGRAM. Never email.
//
// Three independent things have to hold, and the notice is only as quiet as the weakest one:
//   1. the policy row must not ASK for email
//   2. the guard must strip email even when something else asks for it anyway — the
//      Telegram-failure fallback re-enters with ["email","in_app"], and an unlinked employee is
//      the EXPECTED case
//   3. Telegram must be explicitly allowed, or the unknown-module fail-safe disables it

export function runAttendanceDigestEmailBlockTests() {
  {
    const policy = resolveNotificationPolicy({ module: "attendance_digest", eventType: "week_released" });
    assert.equal(policy.channels.includes("email"), false, "the attendance_digest policy row must not request email");
    assert.equal(policy.channels.includes("telegram"), true, "Telegram is one of the two delivery channels");
    assert.equal(policy.channels.includes("in_app"), true, "in-app is the other");
  }

  {
    assert.deepEqual(
      enforceAttendanceDigestEmailBlock(["email", "in_app"], "attendance_digest"),
      ["in_app"],
      "a release notice must never be emailed — this is the Telegram-failure fallback shape",
    );
    assert.deepEqual(
      enforceAttendanceDigestEmailBlock(["in_app", "email", "telegram"], "attendance_digest"),
      ["in_app", "telegram"],
      "email is stripped and the two authorized channels survive",
    );
    assert.deepEqual(enforceAttendanceDigestEmailBlock(["email"], "attendance_digest"), [], "email-only resolves to NOTHING");
    assert.deepEqual(enforceAttendanceDigestEmailBlock(["in_app", "email"], "  Attendance_Digest "), ["in_app"]);

    // The neighbouring attendance module keeps its own rules; a guard that widened would silence it.
    for (const other of ["attendance", "early_birds", "payroll", "vacation", null, undefined]) {
      assert.deepEqual(
        enforceAttendanceDigestEmailBlock(["in_app", "email"], other),
        ["in_app", "email"],
        `${String(other)} must be left alone by the attendance_digest guard`,
      );
    }
  }

  {
    // The guard is only enforcement if the delivery path actually calls it.
    const system = readFileSync("src/lib/notifications/system.ts", "utf8");
    assert.match(
      system,
      /enforceAttendanceDigestEmailBlock\(/,
      "system.ts must run the attendance_digest guard — a guard nothing calls blocks nothing",
    );
  }

  {
    const policy = defaultTelegramPolicyFor("attendance_digest");
    assert.equal(
      policy.enabled,
      true,
      "attendance_digest needs an explicit Telegram policy — with email blocked, the unknown-module fail-safe would leave in-app as the ONLY channel",
    );
    assert.equal(policy.genericOnly, false, "a generic ping does not tell the employee there is a deadline");
  }

  assert.equal(isAttendanceDigestModule("attendance_digest"), true);
  assert.equal(isAttendanceDigestModule("attendance"), false, "the plain attendance module is a different module");
  assert.equal(isAttendanceDigestModule(null), false);
}
