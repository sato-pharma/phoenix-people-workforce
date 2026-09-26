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
import {
  SESSION_MERGE_GAP_SECONDS,
  collapseSessions,
  isMachineAccount,
  type SessionRow,
} from "../src/lib/activity/service.ts";

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

  // Root falls back cleanly.
  assert.equal(resolveActivityModule("/").key, "home");

  // ── The shell is not the module ────────────────────────────────────────────
  // The same feature under four shells is ONE module. Before this, 57% of all
  // active minutes sat in the "Command Center" / "Employee Portal" / "Other"
  // catch-alls, which told the owner nothing about what people actually use.
  for (const path of [
    "/admin/direct-orders",
    "/admin/direct-orders/new",
    "/employee-portals/direct-orders",
    "/employee-portals/direct-orders-in-my-area",
    "/admin/approvals/direct-orders",
  ]) {
    assert.equal(resolveActivityModule(path).key, "direct_orders", path);
    assert.equal(resolveActivityModule(path).label, "Direct Orders", path);
  }

  // The HR shell — including the "/hr/admin/..." double shell — resolves to the
  // feature, never to "Other".
  assert.equal(resolveActivityModule("/hr/recruitment").key, "recruitment");
  assert.equal(resolveActivityModule("/hr/hiring-pack").label, "HR Forms");
  assert.equal(resolveActivityModule("/hr/admin/hr-command-center").key, "hr_command_center");
  assert.equal(resolveActivityModule("/workspace/leave-management/vacation-request").key, "leave");

  // A bare shell path is still the shell's own landing page.
  assert.equal(resolveActivityModule("/admin").key, "command_center");
  assert.equal(resolveActivityModule("/employee-portals").key, "employee_portal");
  assert.equal(resolveActivityModule("/workspace").key, "my_workspace");

  // ── Real names, not "Other" ────────────────────────────────────────────────
  // The two biggest unmapped routes measured in production.
  assert.equal(resolveActivityModule("/employee-360").label, "Employee 360");
  assert.equal(resolveActivityModule("/hr/employee-360").label, "Employee 360");
  // A person's own 360 page is the same module, not one module per person.
  assert.equal(resolveActivityModule("/employee-360/b-10").key, "employee_360");
  assert.equal(resolveActivityModule("/employee-portals/employee-360/ai-0007").key, "employee_360");

  // A route with no rule is named from its own path instead of "Other".
  assert.equal(resolveActivityModule("/totally/unknown/path").label, "Totally");
  assert.equal(resolveActivityModule("/sales/diagnostics").label, "Sales · Diagnostics");
  // Acronyms survive derivation.
  assert.equal(resolveActivityModule("/employee-portals/kpis/call-rate/x").label, "KPIs");
  assert.equal(resolveActivityModule("/some-crm-thing").label, "Some CRM Thing");

  // "Other" is now reserved for a path with no nameable segment at all.
  assert.equal(resolveActivityModule("/12345").key, "other");

  // Every rule's prefix must be unique — a duplicate is a dead rule (the old map
  // listed "/sales/import" twice, so its second entry could never resolve).
  const seenLabels = new Map<string, string>();
  for (const path of ["/sales/import", "/sales/upload", "/sales/weekly", "/weekly-sales"]) {
    const resolved = resolveActivityModule(path);
    const existing = seenLabels.get(resolved.key);
    if (existing) assert.equal(resolved.label, existing, `${path} must label ${resolved.key} consistently`);
    seenLabels.set(resolved.key, resolved.label);
  }
}

function testMachineAccountsAreNotPeople() {
  // The HR canary login re-authenticates constantly: it owned 43% of all logical
  // sessions in the 7 days measured on 2026-09-26, with zero page views, which
  // halved the "Avg session" KPI. Owner's instruction: drop it from the figures.
  assert.equal(isMachineAccount(null, "admin-HR"), true);
  assert.equal(isMachineAccount(null, "admin-hr"), true);
  assert.equal(isMachineAccount("admin-hr", null), true);
  // Real people are never excluded.
  assert.equal(isMachineAccount("B-10", "b-10"), false);
  assert.equal(isMachineAccount(null, "ai-0007"), false);
  assert.equal(isMachineAccount(null, null), false);
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

function sessionRow(hrId: string, createdAt: string, lastSeenAt: string, extra: Partial<SessionRow> = {}): SessionRow {
  return {
    id: null,
    loginId: null,
    hrId,
    role: null,
    createdAt,
    lastSeenAt,
    revokedAt: null,
    revokedReason: null,
    idleExpiresAt: null,
    absoluteExpiresAt: null,
    ip: null,
    userAgent: null,
    ...extra,
  };
}

function testSessionCollapsing() {
  assert.equal(SESSION_MERGE_GAP_SECONDS, 1800);

  const rows: SessionRow[] = [
    // A-1: two rows 10 min apart -> merge into one 30-min logical session.
    sessionRow("A-1", "2026-06-15T09:00:00Z", "2026-06-15T09:10:00Z"),
    sessionRow("A-1", "2026-06-15T09:20:00Z", "2026-06-15T09:30:00Z"),
    // A-1: 90 min after the previous end -> separate logical session.
    sessionRow("A-1", "2026-06-15T11:00:00Z", "2026-06-15T11:05:00Z"),
    // B-2: different person, never merges with A-1.
    sessionRow("B-2", "2026-06-15T09:05:00Z", "2026-06-15T09:06:00Z"),
  ];

  // Order of input must not matter.
  const collapsed = collapseSessions([rows[2], rows[0], rows[3], rows[1]]);
  assert.equal(collapsed.length, 3, "4 rows for 2 people collapse to 3 logical sessions");

  const a1 = collapsed.filter((s) => s.hrId === "A-1").sort((x, y) => (x.startedAt < y.startedAt ? -1 : 1));
  assert.equal(a1.length, 2);
  // First A-1 session spans 09:00 -> 09:30 (1800s), built from 2 rows.
  assert.equal(a1[0].durationSeconds, 1800);
  assert.equal(a1[0].mergedRows, 2);
  assert.equal(a1[0].startedAt, "2026-06-15T09:00:00Z");
  // Second A-1 session is the standalone 5-min one.
  assert.equal(a1[1].durationSeconds, 300);
  assert.equal(a1[1].mergedRows, 1);

  const b2 = collapsed.filter((s) => s.hrId === "B-2");
  assert.equal(b2.length, 1);
  assert.equal(b2[0].durationSeconds, 60);

  // A burst of many rapid rows for one person collapses to a single session.
  const burst: SessionRow[] = Array.from({ length: 20 }, (_, i) => {
    const minute = String(i).padStart(2, "0");
    return sessionRow("A-12", `2026-06-15T08:${minute}:00Z`, `2026-06-15T08:${minute}:30Z`);
  });
  const burstCollapsed = collapseSessions(burst);
  assert.equal(burstCollapsed.length, 1, "20 rapid rows collapse to one logical session");
  assert.equal(burstCollapsed[0].mergedRows, 20);
}

export function runActivityTrackingTests() {
  testModuleResolver();
  testMachineAccountsAreNotPeople();
  testEngagementEngine();
  testPermissionGate();
  testSessionCollapsing();
}
