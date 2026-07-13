import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function src(p: string) { return readFileSync(p, "utf8"); }

// Enhancement E3 — probation intelligence notifications also emit on Telegram with full content.
// (Delivery itself is gated by the global switch, bot token, and per-user opt-in — admin/DB, not code.)
export function runProbationTelegramChannelTests() {
  const emails = src("src/lib/probation/intelligence/probation-emails.ts");
  assert.match(
    emails,
    /channels: \["in_app", "email", "telegram"\]/,
    "DV-snapshot + milestone emitter includes the telegram channel",
  );

  const sla = src("src/lib/probation/intelligence/feedback-sla-reminders.ts");
  assert.match(
    sla,
    /channels: \["in_app", "email", "telegram"\]/,
    "feedback SLA reminders include the telegram channel",
  );
}
