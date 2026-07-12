import assert from "node:assert/strict";

import {
  deriveAppErrorStatus,
  deriveFailedLoginStatus,
  deriveGcpStatus,
  signatureKey,
} from "../src/lib/error-monitor/derived-status.ts";

export function runErrorMonitorDerivedStatusTests() {
  // ── signatureKey: stable module|route grouping, null route normalized ──────
  assert.equal(signatureKey("payroll", "/admin/payroll"), "payroll|/admin/payroll");
  assert.equal(signatureKey("payroll", null), "payroll|");

  // ── deriveAppErrorStatus: Active iff the signature occurred on the current release ─
  const active = new Set<string>(["payroll|/admin/payroll", "auth|"]);
  assert.equal(deriveAppErrorStatus("payroll|/admin/payroll", active), "active");
  assert.equal(deriveAppErrorStatus("auth|", active), "active");
  // Not on current release (old/null-release error) → Resolved, no human action.
  assert.equal(deriveAppErrorStatus("sales|/sales", active), "resolved");
  assert.equal(deriveAppErrorStatus("anything|", new Set()), "resolved");

  // ── deriveGcpStatus: Active iff the entry is on the current Cloud Run revision ──
  assert.equal(deriveGcpStatus("phoenix-hr-00066-toh", "phoenix-hr-00066-toh"), "active");
  assert.equal(deriveGcpStatus("phoenix-hr-00032-bfm", "phoenix-hr-00066-toh"), "resolved");
  // No revision on either side (e.g. local dev) → Resolved, never a false Active.
  assert.equal(deriveGcpStatus(null, "phoenix-hr-00066-toh"), "resolved");
  assert.equal(deriveGcpStatus("phoenix-hr-00066-toh", null), "resolved");

  // ── deriveFailedLoginStatus: Active iff the last failure is within the window ──
  const now = new Date("2026-07-12T12:00:00Z").getTime();
  const oneHourAgo = new Date("2026-07-12T11:00:00Z").toISOString();
  const threeDaysAgo = new Date("2026-07-09T12:00:00Z").toISOString();
  assert.equal(deriveFailedLoginStatus(oneHourAgo, now), "active");
  assert.equal(deriveFailedLoginStatus(threeDaysAgo, now), "resolved");
  // Exactly at the 24h boundary counts as still active (<=).
  const exactly24h = new Date("2026-07-11T12:00:00Z").toISOString();
  assert.equal(deriveFailedLoginStatus(exactly24h, now), "active");
  // Unparseable timestamp never falsely reads Active.
  assert.equal(deriveFailedLoginStatus("not-a-date", now), "resolved");
}
