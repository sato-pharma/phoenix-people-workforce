import assert from "node:assert/strict";

import { computeSalesPacing } from "../src/lib/employee-portal/service.ts";
import { getPortalAttentionInbox } from "../src/lib/action-center/service.ts";
import type { AccessContext } from "../src/lib/auth/permissions.ts";

// Pure pacing helper that powers the Overview "Target Pacing" chip, plus the
// fail-closed guard on the portal attention inbox. Dates are passed explicitly so
// the assertions are deterministic regardless of when the suite runs.
export async function runPortalOverviewPacingTests() {
  // June 2026 has 30 days — used as the reference month throughout.

  // No target → "no_target" and a zeroed achievement (never a misleading number).
  const noTarget = computeSalesPacing(5000, 0, new Date(2026, 5, 15));
  assert.equal(noTarget.status, "no_target");
  assert.equal(noTarget.achievementPercent, 0);
  assert.equal(noTarget.daysInMonth, 30);
  assert.equal(noTarget.dayOfMonth, 15);

  // Behind pace: 20% achieved on the last day (expected ~100%).
  const behind = computeSalesPacing(20, 100, new Date(2026, 5, 30));
  assert.equal(behind.status, "behind");
  assert.equal(Math.round(behind.expectedPercent), 100);
  assert.equal(Math.round(behind.achievementPercent), 20);
  assert.ok(behind.deltaPercent < 0);

  // Ahead of pace: 80% achieved on day 6 (expected 20%).
  const ahead = computeSalesPacing(80, 100, new Date(2026, 5, 6));
  assert.equal(ahead.status, "ahead");
  assert.ok(ahead.deltaPercent > 0);

  // On pace: ~50% achieved at mid-month (expected ~50%, within the ±5pt band).
  const onTrack = computeSalesPacing(50, 100, new Date(2026, 5, 15));
  assert.equal(onTrack.status, "on_track");

  // The attention inbox fails closed (no DB work) when the caller has no HR_ID.
  const empty = await getPortalAttentionInbox({ hrId: "" } as unknown as AccessContext);
  assert.equal(empty.totalCount, 0);
  assert.equal(empty.approvalCount, 0);
  assert.equal(empty.returnedCount, 0);
  assert.equal(empty.items.length, 0);
}
