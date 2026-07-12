import assert from "node:assert/strict";

import type { LoginSecuritySignals, WeeklyHealthSummary } from "../src/lib/error-monitor/service.ts";
import {
  buildWeeklyHealthDigestMessage,
  runWeeklySystemHealthDigest,
} from "../src/lib/notifications/weekly-system-health-digest.ts";

function summary(overrides: Partial<WeeklyHealthSummary> = {}): WeeklyHealthSummary {
  return {
    activeSignatures: 1,
    distinctSignatures: 3,
    newSignatures: 2,
    resolvedSignatures: 2,
    topErrors: [
      { count: 12, label: "Payroll", route: "/admin/payroll", status: "active" },
      { count: 4, label: "Sales", route: null, status: "resolved" },
    ],
    totalErrors: 18,
    windowDays: 7,
    ...overrides,
  };
}

function security(overrides: Partial<LoginSecuritySignals> = {}): LoginSecuritySignals {
  return {
    blockedIps: [{ ip: "197.36.86.34" }] as unknown as LoginSecuritySignals["blockedIps"],
    bruteForceIps: [
      { blocked: true, credentialStuffing: true, distinctAccounts: 4, failCount: 17, ip: "197.36.86.34", lastSeen: "2026-07-11T10:00:00Z" },
    ],
    hammeredAccounts: [],
    lockedAccounts: [
      { failedAttempts: 5, hrId: "B-59", lastFailedAt: "2026-07-11T10:00:00Z", lockedUntil: "2026-07-11T10:30:00Z", name: "Test User" },
    ],
    newLocationLogins: [],
    truncated: false,
    windowDays: 7,
    ...overrides,
  };
}

export function runWeeklySystemHealthDigestTests() {
  // ── Populated digest: counts, top errors with status badges, security hotspots ──
  const msg = buildWeeklyHealthDigestMessage(summary(), security(), "12 Jul 2026");
  assert.match(msg, /Weekly System Health — 12 Jul 2026/);
  assert.match(msg, /Errors: 18 total across 3 type\(s\)/);
  assert.match(msg, /Resolved on live build: 2/);
  assert.match(msg, /Still active: 1/);
  assert.match(msg, /New error type\(s\) this week: 2/);
  // Top errors carry the deploy-aware status badge and a (global) label for a null route.
  assert.match(msg, /1\. 12× Payroll \/admin\/payroll — 🔴 active/);
  assert.match(msg, /2\. 4× Sales \(global\) — ✅ resolved/);
  // Security hotspots surface the brute-force IP, its flags, and the blocked count.
  assert.match(msg, /Brute-force IPs: 1/);
  assert.match(msg, /197\.36\.86\.34 — 17 fails \/ 4 account\(s\).*credential-stuffing.*⛔ blocked/);
  assert.match(msg, /Locked accounts now: 1/);
  assert.match(msg, /Blocked IPs: 1/);
  assert.match(msg, /Full dashboard → \/admin\/system-issues/);

  // ── Clean week: celebratory empties, never a misleading blank ──
  const clean = buildWeeklyHealthDigestMessage(
    summary({ activeSignatures: 0, distinctSignatures: 0, newSignatures: 0, resolvedSignatures: 0, topErrors: [], totalErrors: 0 }),
    security({ blockedIps: [] as unknown as LoginSecuritySignals["blockedIps"], bruteForceIps: [], lockedAccounts: [] }),
    "12 Jul 2026",
  );
  assert.match(clean, /Top errors: none captured this week 🎉/);
  assert.match(clean, /No suspicious login activity ✅/);

  // ── Weekday self-gate: off-day run skips BEFORE any DB access (Mon 2026-07-13, Cairo) ──
  return runWeeklySystemHealthDigest({ now: new Date("2026-07-13T09:00:00Z") }).then((result) => {
    assert.equal(result.skipped, true);
    assert.equal(result.delivered, 0);
    assert.equal(result.reason, "not the weekly digest day");
  });
}
