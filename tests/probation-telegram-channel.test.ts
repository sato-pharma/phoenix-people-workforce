import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function src(p: string) { return readFileSync(p, "utf8"); }

// Enhancement E3 — probation intelligence notifications also emit on Telegram with full content.
// (Delivery itself is gated by the global switch, bot token, and per-user opt-in — admin/DB, not code.)
export function runProbationTelegramChannelTests() {
  const emails = src("src/lib/probation/intelligence/probation-emails.ts");
  assert.match(
    emails,
    /channels: \["in_app", "email", "telegram", "push"\]/,
    "DV-snapshot + milestone emitter includes the telegram and push channels",
  );

  // The feedback SLA reminder module was retired 2026-08-02, so there is no longer an SLA
  // emitter whose channel list needs asserting.
}
