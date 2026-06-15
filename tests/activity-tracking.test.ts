import assert from "node:assert/strict";

import {
  normalizeActivityPath,
  resolveActivityModule,
} from "../src/lib/activity/modules.ts";
import {
  ACTIVE_VIEW_CAP_SECONDS,
  bandForScore,
  cappedDwellSeconds,
  computeEngagement,
} from "../src/lib/activity/engagement.ts";
import {
  ACTIVITY_CONTROL_ACCESS_ROLES,
  ACTIVITY_TRACKING_SHOW_EMPLOYEE_NOTICE,
  canAccessActivityControlCenter,
  permissionMatrix,
  phoenixRoles,
} from "../src/lib/auth/permissions.ts";

function testModuleResolver() {
  // Longest-prefix wins: specific routes beat their parents.
  assert.equal(resolveActivityModule("/sales/weekly/dashboard").key, "weekly_sales");
  assert.equal(resolveActivityModule("/sales/import").key, "source_of_sales");
  assert.equal(resolveActivityModule("/sales").key, "sales");
  assert.equal(resolveActivityModule("/admin/report-it/new").key, "report_it");
  assert.equal(resolveActivityModule("/admin").key, "command_center");

  // Query strings + casing + trailing slashes are normalised away.
  assert.equal(resolveActivityModule("/admin/data-health?tab=x").key, "data_health");
  assert.equal(normalizeActivityPath("/Admin/Data-Health/"), "/admin/data-health");
  assert.equal(normalizeActivityPath("admin/logs"), "/admin/logs");

  // Employee portal maps to friendly modules; activity-control resolves itself.
  assert.equal(resolveActivityModule("/employee-portals/report-it").key, "report_it");
  assert.equal(resolveActivityModule("/employee-portals").key, "employee_portal");
  assert.equal(resolveActivityModule("/admin/activity-control").key, "activity_control");

  // Root and unknown paths fall back cleanly.
  assert.equal(resolveActivityModule("/").key, "home");
  assert.equal(resolveActivityModule("/totally/unknown/path").key, "other");
}

function testEngagementEngine() {
  // Dwell capping: normal values pass through; runaway tabs are capped; junk is 0.
  assert.equal(cappedDwellSeconds(5000), 5);
  assert.equal(cappedDwellSeconds(9_999_999_999), ACTIVE_VIEW_CAP_SECONDS);
  assert.equal(cappedDwellSeconds(-10), 0);
  assert.equal(cappedDwellSeconds(null), 0);

  // Bands.
  assert.equal(bandForScore(80), "High");
  assert.equal(bandForScore(50), "Moderate");
  assert.equal(bandForScore(10), "Low");

  // Perfectly engaged → 100/High.
  const perfect = computeEngagement({ activeSeconds: 1800, sessionSeconds: 1800, distinctModules: 5, pageViews: 25 });
  assert.equal(perfect.score, 100);
  assert.equal(perfect.band, "High");
  assert.equal(perfect.activeRatio, 1);

  // No activity at all → 0/Low.
  const empty = computeEngagement({ activeSeconds: 0, sessionSeconds: 0, distinctModules: 0, pageViews: 0 });
  assert.equal(empty.score, 0);
  assert.equal(empty.band, "Low");

  // When session length is unknown, any active time counts as fully active.
  const noSession = computeEngagement({ activeSeconds: 300, sessionSeconds: 0, distinctModules: 1, pageViews: 1 });
  assert.equal(noSession.activeRatio, 1);
  // 0.55*1 + 0.20*(1/5) + 0.25*(1/25) = 0.60 → 60.
  assert.equal(noSession.score, 60);
  assert.equal(noSession.band, "Moderate");

  // More active time never lowers the score.
  const low = computeEngagement({ activeSeconds: 300, sessionSeconds: 3600, distinctModules: 2, pageViews: 4 });
  const high = computeEngagement({ activeSeconds: 3000, sessionSeconds: 3600, distinctModules: 2, pageViews: 4 });
  assert.ok(high.score > low.score, "more active time should raise the score");
}

function testPermissionGate() {
  // Super Admin gets read + export; nobody else gets the resource at all.
  assert.deepEqual(permissionMatrix["Super Admin"].user_activity, ["read", "export"]);
  for (const role of phoenixRoles) {
    if (role === "Super Admin") continue;
    assert.equal(
      permissionMatrix[role].user_activity,
      undefined,
      `${role} must not have any user_activity permission by default`,
    );
  }

  // Access helper: Super Admin or system scope only.
  assert.equal(canAccessActivityControlCenter({ role: "Super Admin", scope: "company" }), true);
  assert.equal(canAccessActivityControlCenter({ role: "CEO", scope: "company" }), false);
  assert.equal(canAccessActivityControlCenter({ role: "Employee", scope: "self" }), false);
  assert.equal(canAccessActivityControlCenter({ role: "Employee", scope: "system" }), true);

  assert.deepEqual([...ACTIVITY_CONTROL_ACCESS_ROLES], ["Super Admin"]);
  // Owner chose the silent default for v1.
  assert.equal(ACTIVITY_TRACKING_SHOW_EMPLOYEE_NOTICE, false);
}

export function runActivityTrackingTests() {
  testModuleResolver();
  testEngagementEngine();
  testPermissionGate();
}
