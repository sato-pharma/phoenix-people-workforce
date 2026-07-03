import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Contract guards for the live settlement dashboard
 * (src/lib/attendance/settlement-dashboard.ts): real-time digest-status
 * counts + the pending-action list + the one-click remind-all it hosts.
 */
export function runAttendanceSettlementDashboardTests() {
  const service = readFileSync("src/lib/attendance/settlement-dashboard.ts", "utf8");

  // 1. Only "sent" digests are pending action — draft/settled/auto_confirmed/
  //    void must never appear in the reminder list.
  assert.match(
    service,
    /const pendingRows = rows\.filter\(\(row\) => row\.status === "sent"\);/,
    "pendingDigests must be scoped to exactly the 'sent' (awaiting response) status",
  );

  // 2. remind-all re-uses the real digest-sent notifier rather than a
  //    bespoke reminder path, so employees see the same message shape.
  assert.match(
    service,
    /await notifyDigestSent\(/,
    "remindAllPendingDigests must reuse notifyDigestSent, not a bespoke notification path",
  );

  // 3. Best-effort fan-out: one failed reminder must never abort the rest.
  assert.match(
    service,
    /try \{\s*await notifyDigestSent\(/,
    "each reminder send must be individually try/caught inside the Promise.all map",
  );

  // 4. Cycle resolution defers to the real digest-cycle + settings modules
  //    rather than reimplementing the 24->24 window math.
  assert.match(service, /resolveDigestCycle\(cairoTodayIso\(\), settings\.cycleAnchorDay\)/, "dashboard cycle resolution must reuse resolveDigestCycle, not duplicate the window math");

  // 5. Routes are registered with the correct guard.
  const registry = readFileSync("src/lib/security/access-registry.ts", "utf8");
  for (const pattern of ["/api/attendance/settlement-dashboard", "/api/attendance/settlement-dashboard/remind-all"]) {
    assert.ok(registry.includes(`pattern: "${pattern}"`), `access registry must contain an entry for ${pattern}`);
  }

  // 6. Remind-all is a mutation (sends notifications) and must be CSRF-guarded.
  const remindRoute = readFileSync("app/api/attendance/settlement-dashboard/remind-all/route.ts", "utf8");
  assert.match(remindRoute, /assertSameOriginMutation\(request\)/, "remind-all route must enforce same-origin CSRF protection");
  assert.match(remindRoute, /assertAttendanceSetupPermission\(access, "update"\)/, "remind-all route must require update permission, not just read");

  const dashboardRoute = readFileSync("app/api/attendance/settlement-dashboard/route.ts", "utf8");
  assert.match(dashboardRoute, /assertAttendanceSetupPermission\(access, "read"\)/, "dashboard read route must require attendance-setup read permission");
}
