import assert from "node:assert/strict";

import {
  normalizeActivityPath,
  resolveActivityModule,
} from "../src/lib/activity/modules.ts";
import {
  ACTIVE_VIEW_CAP_SECONDS,
  ENGAGEMENT_BAND_THRESHOLDS,
  TARGET_MINUTES_PER_WORKING_DAY,
  bandForScore,
  cappedDwellSeconds,
  computeEngagement,
} from "../src/lib/activity/engagement.ts";
import {
  BEACON_LAG_TOLERANCE_SECONDS,
  creditUncoveredSeconds,
  dwellIntervalForEvent,
} from "../src/lib/activity/dwell-union.ts";
import {
  createWorkingDayBaseline,
  expectedWorkingDaysInRange,
  listCairoDatesInRange,
} from "../src/lib/activity/working-baseline.ts";
import { isAttendanceScheduledWorkingDay } from "../src/lib/attendance/work-schedule.ts";
import { buildModuleJourney, type JourneyEvent } from "../src/lib/activity/module-journey.ts";
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
  assert.equal(resolveActivityModule("/admin/system-audit?tab=x").key, "system_audit");
  assert.equal(normalizeActivityPath("/Admin/System-Audit/"), "/admin/system-audit");
  // The pages System Audit replaced (23 Oct 2026) redirect to it, so their history reads as it too.
  assert.equal(resolveActivityModule("/admin/data-health").label, "System Audit");
  assert.equal(resolveActivityModule("/admin/system-issues").label, "System Audit");
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

  // Band edges, at the thresholds the module itself declares.
  assert.equal(ENGAGEMENT_BAND_THRESHOLDS.high, 60);
  assert.equal(ENGAGEMENT_BAND_THRESHOLDS.moderate, 30);
  assert.equal(bandForScore(60), "High");
  assert.equal(bandForScore(59), "Moderate");
  assert.equal(bandForScore(30), "Moderate");
  assert.equal(bandForScore(29), "Low");

  // Perfectly engaged → 100/High: full target minutes on every working day, six
  // modules, present on every one of them.
  const perfect = computeEngagement({
    activeSeconds: TARGET_MINUTES_PER_WORKING_DAY * 60 * 5,
    expectedWorkingDays: 5,
    distinctModules: 6,
    daysActive: 5,
  });
  assert.equal(perfect.score, 100);
  assert.equal(perfect.band, "High");
  assert.equal(perfect.usageScore, 1);
  assert.equal(perfect.activeMinutesPerWorkingDay, TARGET_MINUTES_PER_WORKING_DAY);

  // No activity at all → 0/Low.
  const empty = computeEngagement({
    activeSeconds: 0,
    expectedWorkingDays: 5,
    distinctModules: 0,
    daysActive: 0,
  });
  assert.equal(empty.score, 0);
  assert.equal(empty.band, "Low");

  // ── The deleted fallback ───────────────────────────────────────────────────
  // Until 2026-09-26 an input with no session baseline was handed activeRatio 1
  // — "no denominator, therefore fully engaged" — and it manufactured the single
  // High score in the whole measured population out of five minutes of activity.
  // Five minutes on one working day is now what it looks like.
  const fiveMinutesOnOneDay = computeEngagement({
    activeSeconds: 300,
    expectedWorkingDays: 1,
    distinctModules: 1,
    daysActive: 1,
  });
  assert.equal(fiveMinutesOnOneDay.usageScore, 300 / 60 / TARGET_MINUTES_PER_WORKING_DAY);
  assert.equal(fiveMinutesOnOneDay.score, 21);
  assert.equal(fiveMinutesOnOneDay.band, "Low");

  // The guard that keeps the fallback from coming back in another shape: usage
  // can only reach 1 on real measured minutes, never on their absence.
  for (const expectedWorkingDays of [1, 5, 22, 26]) {
    const none = computeEngagement({ activeSeconds: 0, expectedWorkingDays, distinctModules: 6, daysActive: 0 });
    assert.equal(none.usageScore, 0, "no active seconds must never earn usage credit");
    assert.ok(none.score < ENGAGEMENT_BAND_THRESHOLDS.high, "no active time can never reach High");
  }

  // More active time never lowers the score.
  const low = computeEngagement({ activeSeconds: 300, expectedWorkingDays: 5, distinctModules: 2, daysActive: 2 });
  const high = computeEngagement({ activeSeconds: 30_000, expectedWorkingDays: 5, distinctModules: 2, daysActive: 2 });
  assert.ok(high.score > low.score, "more active time should raise the score");

  // A zero or nonsense working-day count clamps to 1 rather than dividing by zero.
  const clamped = computeEngagement({ activeSeconds: 600, expectedWorkingDays: 0, distinctModules: 1, daysActive: 1 });
  assert.equal(clamped.activeMinutesPerWorkingDay, 10);
}

/**
 * The engagement scale has to SEPARATE people — the old one put 33 of 39 into a
 * single band, which is the defect this replaces. Seven archetypes drawn from
 * what the measured population actually looks like, over a 30-day window where
 * an office title is scheduled 26 working days.
 *
 * The scores are pinned EXACTLY, so moving TARGET_MINUTES_PER_WORKING_DAY comes
 * here and is re-argued rather than sliding through unnoticed. It has already
 * happened once: the constant shipped at 120 in the same pass, and production
 * showed that left only 3 people in High — too few to be a band. At 90 it is
 * 8 High / 18 Moderate / 26 Low.
 */
function testBandsSeparate() {
  const expectedWorkingDays = 26;
  const minutesPerDay = (minutes: number) => minutes * 60 * expectedWorkingDays;

  const archetypes = [
    { name: "heavy office user", activeSeconds: minutesPerDay(150), distinctModules: 8, daysActive: 26, score: 100, band: "High" },
    { name: "steady office user", activeSeconds: minutesPerDay(60), distinctModules: 8, daysActive: 22, score: 74, band: "High" },
    { name: "regular part-time user", activeSeconds: minutesPerDay(35), distinctModules: 6, daysActive: 14, score: 50, band: "Moderate" },
    { name: "bursty user", activeSeconds: minutesPerDay(28), distinctModules: 5, daysActive: 3, score: 36, band: "Moderate" },
    { name: "just above the Moderate floor", activeSeconds: minutesPerDay(22), distinctModules: 4, daysActive: 8, score: 32, band: "Moderate" },
    { name: "just below the Moderate floor", activeSeconds: minutesPerDay(20), distinctModules: 4, daysActive: 6, score: 29, band: "Low" },
    { name: "barely there", activeSeconds: minutesPerDay(1), distinctModules: 1, daysActive: 1, score: 4, band: "Low" },
  ] as const;

  const bands = new Set<string>();
  for (const archetype of archetypes) {
    const result = computeEngagement({
      activeSeconds: archetype.activeSeconds,
      expectedWorkingDays,
      distinctModules: archetype.distinctModules,
      daysActive: archetype.daysActive,
    });
    assert.equal(result.score, archetype.score, `${archetype.name} scored ${result.score}, expected ${archetype.score}`);
    assert.equal(result.band, archetype.band, `${archetype.name} landed in ${result.band}, expected ${archetype.band}`);
    bands.add(result.band);
  }

  assert.equal(bands.size, 3, "all three bands must be reachable by realistic people");

  // Two people three points apart, one each side of the Moderate floor: 22
  // minutes a working day over 8 days is Moderate, 20 minutes over 6 days is
  // Low. A boundary is where a silent rescale shows up first, so the pair is
  // pinned rather than the threshold alone.
  assert.ok(archetypes[4].score >= ENGAGEMENT_BAND_THRESHOLDS.moderate);
  assert.ok(archetypes[5].score < ENGAGEMENT_BAND_THRESHOLDS.moderate);
}

/**
 * Two browser WINDOWS are both `visible` at once and both accumulate dwell over
 * the same wall clock. Summing them counted one minute twice — 111% of a
 * person's own logged-in time, on production, printed as "Active min".
 */
function testDwellUnion() {
  const minute = 60_000;
  const at = (minutes: number) => Date.UTC(2026, 5, 15, 9, minutes, 0);

  // Two windows over exactly the same ten minutes → ten minutes, not twenty.
  const sameWindow = creditUncoveredSeconds([
    { startMs: at(0), endMs: at(10) },
    { startMs: at(0), endMs: at(10) },
  ]);
  assert.equal(sameWindow.reduce((sum, seconds) => sum + seconds, 0), 600);

  // Partial overlap: 09:00–09:10 and 09:05–09:20 → 20 minutes of union.
  const partial = creditUncoveredSeconds([
    { startMs: at(0), endMs: at(10) },
    { startMs: at(5), endMs: at(20) },
  ]);
  assert.equal(partial[0], 600);
  // 09:05–09:20 is fifteen minutes, but its first five are already covered — it
  // is credited 09:10–09:20 alone.
  assert.equal(partial[1], 600, "the second view is credited only for the part nothing else covered");
  assert.equal(partial.reduce((sum, seconds) => sum + seconds, 0), 1200);

  // An interval wholly inside another earns nothing at all.
  const contained = creditUncoveredSeconds([
    { startMs: at(0), endMs: at(30) },
    { startMs: at(5), endMs: at(6) },
  ]);
  assert.equal(contained[1], 0);
  assert.equal(contained.reduce((sum, seconds) => sum + seconds, 0), 1800);

  // NO gap tolerance: a break between two views is time nobody was on a page.
  const gapped = creditUncoveredSeconds([
    { startMs: at(0), endMs: at(5) },
    { startMs: at(6), endMs: at(10) },
  ]);
  assert.equal(gapped.reduce((sum, seconds) => sum + seconds, 0), 540, "the 60s gap is not credited to anyone");

  // Order independence — PostgREST's row order must not change a number.
  const forwards = creditUncoveredSeconds([
    { startMs: at(0), endMs: at(10) },
    { startMs: at(5), endMs: at(20) },
    { startMs: at(25), endMs: at(30) },
  ]);
  const backwards = creditUncoveredSeconds([
    { startMs: at(25), endMs: at(30) },
    { startMs: at(5), endMs: at(20) },
    { startMs: at(0), endMs: at(10) },
  ]);
  assert.equal(
    forwards.reduce((sum, seconds) => sum + seconds, 0),
    backwards.reduce((sum, seconds) => sum + seconds, 0),
  );

  // Junk intervals are dropped rather than credited.
  const junk = creditUncoveredSeconds([
    { startMs: at(10), endMs: at(5) },
    { startMs: Number.NaN, endMs: at(5) },
    { startMs: at(0), endMs: at(1) },
  ]);
  assert.deepEqual(junk, [0, 0, 60]);

  // ── The per-event interval, and the beacon-lag guard ───────────────────────
  const entered = new Date(at(0)).toISOString();
  const delivered = new Date(at(10)).toISOString();

  // A well-behaved beacon: arrival ≈ entered + dwell, so `entered_at` is trusted.
  const trusted = dwellIntervalForEvent({ createdAtIso: delivered, enteredAtIso: entered, dwellSeconds: 600 });
  assert.deepEqual(trusted, { startMs: at(0), endMs: at(10) });

  // A suspended tab: the beacon lands hours after the dwell it reports, so the
  // interval is anchored to arrival instead of stretching across the gap.
  const lateArrival = new Date(at(0) + 4 * 60 * minute).toISOString();
  const suspended = dwellIntervalForEvent({ createdAtIso: lateArrival, enteredAtIso: entered, dwellSeconds: 600 });
  assert.deepEqual(suspended, { startMs: at(0) + 4 * 60 * minute - 600_000, endMs: at(0) + 4 * 60 * minute });

  // Exactly at the tolerance the reported entry is still trusted.
  const atTolerance = new Date(at(10) + BEACON_LAG_TOLERANCE_SECONDS * 1000).toISOString();
  assert.deepEqual(dwellIntervalForEvent({ createdAtIso: atTolerance, enteredAtIso: entered, dwellSeconds: 600 }), {
    startMs: at(0),
    endMs: at(10),
  });

  // No dwell, or no usable timestamp at all, produces no interval.
  assert.equal(dwellIntervalForEvent({ createdAtIso: delivered, enteredAtIso: entered, dwellSeconds: 0 }), null);
  assert.equal(dwellIntervalForEvent({ createdAtIso: null, enteredAtIso: null, dwellSeconds: 600 }), null);

  // ── The two invariants the page depends on ────────────────────────────────
  // A forgotten tab is capped BEFORE the union, so it cannot swallow the real
  // page views sitting inside the hours it claims.
  const windowLengthSeconds = 24 * 60 * 60;
  const capped = cappedDwellSeconds(9 * 60 * 60 * 1000);
  const intervals = [
    { startMs: at(0), endMs: at(0) + capped * 1000 },
    { startMs: at(45), endMs: at(50) },
  ];
  const credited = creditUncoveredSeconds(intervals);
  const total = credited.reduce((sum, seconds) => sum + seconds, 0);
  assert.equal(capped, ACTIVE_VIEW_CAP_SECONDS, "a nine-hour dwell is capped at the display cap first");
  assert.ok(total <= windowLengthSeconds, "credited seconds can never exceed the window");
  assert.ok(
    total <= capped + 5 * 60,
    "credited seconds can never exceed the sum of the capped dwells they came from",
  );
}

/**
 * The working-day baseline must agree with the attendance engine exactly — the
 * whole reason it reuses `isAttendanceScheduledWorkingDay` rather than carrying
 * a second copy of the weekend rule.
 */
function testWorkingDayBaseline() {
  // 14 June 2026 is a Sunday; 20 June 2026 is the Saturday that closes that week.
  const fromIso = "2026-06-14T00:00:00Z";
  const toIso = "2026-06-20T20:00:00Z";
  const dates = listCairoDatesInRange(fromIso, toIso);
  assert.equal(dates.length, 7, "a Sunday-to-Saturday range is seven Cairo days");
  assert.equal(dates[0], "2026-06-14");
  assert.equal(dates[6], "2026-06-20");

  // An office title takes Friday AND Saturday off.
  assert.equal(expectedWorkingDaysInRange(fromIso, toIso, "HR Section Head"), 5);
  // A Medical Rep and a District Manager take Friday only.
  assert.equal(expectedWorkingDaysInRange(fromIso, toIso, "Medical Rep"), 6);
  assert.equal(expectedWorkingDaysInRange(fromIso, toIso, "District Manager"), 6);

  // Drift guard: whatever the attendance engine says, day by day, is what this
  // counts. If the weekend rule ever moves, this fails rather than diverging.
  for (const jobTitle of ["HR Section Head", "Medical Rep", "District Manager", null]) {
    const fromEngine = dates.filter((dateIso) => isAttendanceScheduledWorkingDay({ dateIso, jobTitle })).length;
    assert.equal(
      expectedWorkingDaysInRange(fromIso, toIso, jobTitle),
      Math.max(1, fromEngine),
      `the baseline disagrees with the attendance engine for ${jobTitle ?? "no title"}`,
    );
  }

  // A window of pure weekend clamps to 1 — never 0, which would divide by zero
  // and hand everybody a perfect score.
  assert.equal(expectedWorkingDaysInRange("2026-06-19T00:00:00Z", "2026-06-20T20:00:00Z", "HR Section Head"), 1);

  // The memoized baseline answers identically, and caches per title.
  const baseline = createWorkingDayBaseline(fromIso, toIso);
  assert.equal(baseline("HR Section Head"), 5);
  assert.equal(baseline("HR Section Head"), 5);
  assert.equal(baseline("Medical Rep"), 6);
  assert.equal(baseline("medical rep"), 6, "the cache key is case-insensitive, and so is the rule");
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

/**
 * The module journey — the owner's 2026-09-26 ask: which modules each person
 * entered, how long they stayed in each, and the workflow BETWEEN them.
 *
 * The three things that can silently go wrong here, and are pinned below:
 *   1. Consecutive views of one module must COLLAPSE into one run, or a person
 *      who opened six payroll pages reads as six separate visits.
 *   2. Leaving a module and coming BACK must NOT collapse — that return is the
 *      switching the whole feature exists to show.
 *   3. The totals must sum to the person's own credited active seconds, because
 *      the drawer prints them beside the Active tile and the owner reconciles
 *      the two by eye.
 */
function journeyEvent(
  moduleKey: string,
  createdAt: string,
  creditedSeconds: number,
  enteredAt: string | null = null,
): JourneyEvent {
  return {
    moduleKey,
    moduleLabel: moduleKey === "payroll" ? "Payroll" : moduleKey === "crm" ? "CRM" : "Recruitment",
    createdAt,
    enteredAt,
    creditedSeconds,
  };
}

function testModuleJourney() {
  const events: JourneyEvent[] = [
    journeyEvent("payroll", "2026-09-20T08:01:00Z", 60, "2026-09-20T08:00:00Z"),
    journeyEvent("payroll", "2026-09-20T08:03:00Z", 120),
    journeyEvent("crm", "2026-09-20T08:06:00Z", 180),
    journeyEvent("payroll", "2026-09-20T08:10:00Z", 240),
    journeyEvent("recruitment", "2026-09-20T08:20:00Z", 300),
    journeyEvent("crm", "2026-09-20T08:30:00Z", 100),
  ];
  const journey = buildModuleJourney(events);

  // 1. Consecutive same-module views collapse; a return does not.
  assert.equal(journey.visits.length, 5, "six views over four modules-in-a-row collapse to five runs");

  // The run list is newest first, the way the drawer reads it.
  assert.equal(journey.visits[0].moduleLabel, "CRM");
  assert.equal(journey.visits[journey.visits.length - 1].moduleLabel, "Payroll");

  // The first run starts at entered_at (when the page was OPENED), not at the
  // beacon's created_at — a minute of real dwell hangs on that one line.
  const firstRun = journey.visits[journey.visits.length - 1];
  assert.equal(firstRun.startedAtIso, "2026-09-20T08:00:00Z");
  assert.equal(firstRun.seconds, 180, "two consecutive payroll views credit 60 + 120 into one run");
  assert.equal(firstRun.views, 2);

  // 2. Payroll was entered TWICE — the return is a separate visit, but one total.
  const payroll = journey.totals.find((total) => total.moduleLabel === "Payroll");
  assert.ok(payroll, "Payroll must appear in the totals");
  assert.equal(payroll.visits, 2, "leaving Payroll and coming back is two visits, never one");
  assert.equal(payroll.views, 3);
  assert.equal(payroll.seconds, 420);

  // 3. The totals sum to exactly the credited seconds that feed the Active tile.
  const creditedTotal = events.reduce((sum, event) => sum + event.creditedSeconds, 0);
  const journeyTotal = journey.totals.reduce((sum, total) => sum + total.seconds, 0);
  assert.equal(journeyTotal, creditedTotal, "module time must reconcile with Active, not be a second measurement");
  assert.equal(creditedTotal, 1000);

  // Share is of the person's OWN time and sums to 100 (within rounding).
  const shareTotal = journey.totals.reduce((sum, total) => sum + total.sharePct, 0);
  assert.ok(Math.abs(shareTotal - 100) < 0.5, `shares must total ~100, got ${shareTotal}`);
  assert.equal(payroll.sharePct, 42);

  // Totals are biggest-first, which is the order the panel renders — Payroll 420s,
  // Recruitment 300s, then CRM's two runs at 180 + 100.
  assert.deepEqual(
    journey.totals.map((total) => total.moduleLabel),
    ["Payroll", "Recruitment", "CRM"],
  );
  assert.deepEqual(
    journey.totals.map((total) => total.seconds),
    [420, 300, 280],
  );

  // Transitions: every move from one module straight into another, and never a
  // module to ITSELF (a run cannot follow itself, so that pair cannot exist).
  assert.equal(
    journey.transitions.reduce((sum, transition) => sum + transition.count, 0),
    4,
    "five runs produce four moves",
  );
  for (const transition of journey.transitions) {
    assert.notEqual(transition.fromLabel, transition.toLabel, "a module never transitions to itself");
  }
  const payrollToCrm = journey.transitions.find((t) => t.fromLabel === "Payroll" && t.toLabel === "CRM");
  assert.ok(payrollToCrm);
  assert.equal(payrollToCrm.count, 1);

  // A repeated move is counted, not listed twice, and sorts to the front.
  const pingPong = buildModuleJourney([
    journeyEvent("payroll", "2026-09-20T08:00:00Z", 10),
    journeyEvent("crm", "2026-09-20T08:01:00Z", 10),
    journeyEvent("payroll", "2026-09-20T08:02:00Z", 10),
    journeyEvent("crm", "2026-09-20T08:03:00Z", 10),
    journeyEvent("payroll", "2026-09-20T08:04:00Z", 10),
    journeyEvent("crm", "2026-09-20T08:05:00Z", 10),
  ]);
  assert.equal(pingPong.transitions[0].fromLabel, "Payroll");
  assert.equal(pingPong.transitions[0].toLabel, "CRM");
  assert.equal(pingPong.transitions[0].count, 3);
  assert.equal(pingPong.totals.find((t) => t.moduleLabel === "Payroll")?.visits, 3);

  // An empty range produces an empty journey rather than throwing — the drawer
  // renders it for a person who has never opened a page.
  const empty = buildModuleJourney([]);
  assert.deepEqual(empty.totals, []);
  assert.deepEqual(empty.visits, []);
  assert.deepEqual(empty.transitions, []);

  // A person with zero credited seconds (every view overlapped another window)
  // must not divide by zero — shares fall to 0, not NaN.
  const zero = buildModuleJourney([journeyEvent("payroll", "2026-09-20T08:00:00Z", 0)]);
  assert.equal(zero.totals[0].sharePct, 0);
}

export function runActivityTrackingTests() {
  testModuleResolver();
  testMachineAccountsAreNotPeople();
  testEngagementEngine();
  testBandsSeparate();
  testDwellUnion();
  testModuleJourney();
  testWorkingDayBaseline();
  testPermissionGate();
  testSessionCollapsing();
}
