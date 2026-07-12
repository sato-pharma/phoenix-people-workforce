import assert from "node:assert/strict";

import { redactForAi } from "../src/lib/error-monitor/ai-redact.ts";

export function runErrorMonitorAiRedactTests() {
  // ── Employee codes / hr_ids embedded in free text are masked ────────────────
  assert.equal(redactForAi("Forbidden: employee B-59 cannot read expenses"), "Forbidden: employee [id] cannot read expenses");
  assert.equal(redactForAi("hr_id a-3 mismatch"), "hr_id [id] mismatch");
  assert.equal(redactForAi("PHX-1 and b-28 both failed"), "[id] and [id] both failed");

  // ── Route params collapsed to :id ───────────────────────────────────────────
  assert.equal(redactForAi("GET /employee-360/B-59 -> 403"), "GET /employee-360/:id -> 403");
  assert.equal(redactForAi("/admin/users/42 not found"), "/admin/users/:id not found");

  // ── Emails and UUIDs masked ─────────────────────────────────────────────────
  assert.equal(redactForAi("failed for ahmed@satopharma.com"), "failed for [email]");
  assert.equal(redactForAi("row 3f261e33-168b-3d9d-ec4b-e4a7f6fe2a5d missing"), "row [uuid] missing");

  // ── Long digit runs masked ──────────────────────────────────────────────────
  assert.equal(redactForAi("order 1234567 not found"), "order [num] not found");

  // ── Ordinary technical text is LEFT INTACT (no over-redaction) ──────────────
  assert.equal(redactForAi("Switched to client-side rendering"), "Switched to client-side rendering");
  assert.equal(redactForAi("server-rendered HTML did not match"), "server-rendered HTML did not match");
  assert.equal(redactForAi("Cannot read properties of undefined (reading 'call')"), "Cannot read properties of undefined (reading 'call')");
  assert.equal(redactForAi(""), "");
  assert.equal(redactForAi(null), "");
}
