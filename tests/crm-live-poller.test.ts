import assert from "node:assert/strict";

import {
  computeCrmDelta,
  DAY_TICK_SECONDS,
  FAST_TICK_SECONDS,
  NIGHT_TICK_SECONDS,
  PARITY_SWEEP_EARLIEST_CAIRO_MINUTES,
  PARITY_SWEEP_FAILURE_RETRY_GAP_MS,
  PARITY_SWEEP_MIN_GAP_MS,
  PLAN_SYNC_FAILURE_RETRY_GAP_MS,
  PLAN_SYNC_MIN_GAP_MS,
  RECONCILE_FAILURE_RETRY_GAP_MS,
  RECONCILE_MIN_GAP_MS,
  resolveDueScheduledWork,
  resolvePollPlan,
  ROLLING_SYNC_FAILURE_RETRY_GAP_MS,
  ROLLING_SYNC_MIN_GAP_MS,
  stableStringify,
  startLiveCrmPoller,
  WIDE_PROBE_EVERY_N_TICKS,
  type SnapshotMemo,
} from "../src/lib/crm/live-poller.ts";
import { filterRowsToUpsert } from "../src/lib/crm/sync.ts";
import type { IReports360Checkin, IReports360Visit } from "../src/lib/crm/client.ts";

function visit(overrides: Partial<IReports360Visit> = {}): IReports360Visit {
  return {
    agentID: 100,
    agentName: "Some Rep",
    ampm: "AM",
    attendance: null,
    callType: null,
    comment: null,
    contactID: null,
    contactName: null,
    contactGrade: null,
    customerName: null,
    doubleID: null,
    doubleName: null,
    id: 1,
    region: null,
    regionID: null,
    saveDate: null,
    speciality: null,
    visitDate: "2026-08-02",
    visitType: 0,
    visitTypeDescription: "Regular Visit",
    ...overrides,
  };
}

function checkin(overrides: Partial<IReports360Checkin> = {}): IReports360Checkin {
  return {
    address: null,
    agentID: 100,
    checkDate: "2026-08-02T09:15:00",
    contactID: null,
    contactName: null,
    id: 11,
    lat: 30.0444,
    lon: 31.2357,
    ...overrides,
  };
}

function memoOf(entries: Array<[number, { day: string; hash: string }]>): SnapshotMemo {
  return new Map(entries);
}

export function runCrmLivePollerTests() {
  // ── stableStringify: key order must not matter, nesting and arrays must ──────────────────────
  assert.equal(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }));
  assert.notEqual(stableStringify({ a: 1 }), stableStringify({ a: 2 }));
  assert.equal(stableStringify({ a: [{ z: 1, y: null }] }), stableStringify({ a: [{ y: null, z: 1 }] }));
  assert.notEqual(stableStringify([1, 2]), stableStringify([2, 1])); // array ORDER is content
  assert.equal(stableStringify(null), "null");

  // ── Cadence VALUES are the latency promise (owner requirement 2026-08-04: a CRM submission is
  // visible in Phoenix essentially live, all day). A regression back to slow ticks must fail here.
  assert.equal(FAST_TICK_SECONDS, 20, "compliance-window latency promise: ≤ ~20s");
  assert.equal(DAY_TICK_SECONDS, 30, "all-day latency promise: ≤ ~30s from 06:00 to midnight Cairo");
  assert.equal(NIGHT_TICK_SECONDS, 120, "overnight latency promise: ≤ ~2min");

  // ── resolvePollPlan: cadence tiers by Cairo wall-clock ───────────────────────────────────────
  assert.equal(resolvePollPlan(8 * 60, 1).intervalSeconds, FAST_TICK_SECONDS); // 08:00
  assert.equal(resolvePollPlan(12 * 60 + 30, 1).intervalSeconds, FAST_TICK_SECONDS); // 12:30 inclusive
  assert.equal(resolvePollPlan(12 * 60 + 31, 1).intervalSeconds, DAY_TICK_SECONDS); // 12:31
  assert.equal(resolvePollPlan(7 * 60 + 59, 1).intervalSeconds, DAY_TICK_SECONDS); // 07:59
  assert.equal(resolvePollPlan(23 * 60 + 59, 1).intervalSeconds, DAY_TICK_SECONDS); // 23:59
  assert.equal(resolvePollPlan(0, 1).intervalSeconds, NIGHT_TICK_SECONDS); // 00:00
  assert.equal(resolvePollPlan(5 * 60 + 59, 1).intervalSeconds, NIGHT_TICK_SECONDS); // 05:59
  assert.equal(resolvePollPlan(6 * 60, 1).intervalSeconds, DAY_TICK_SECONDS); // 06:00

  // Wide (yesterday+today) probe: every night tick, and every Nth day tick.
  assert.equal(resolvePollPlan(0, 3).includeYesterday, true);
  assert.equal(resolvePollPlan(10 * 60, WIDE_PROBE_EVERY_N_TICKS).includeYesterday, true);
  assert.equal(resolvePollPlan(10 * 60, WIDE_PROBE_EVERY_N_TICKS + 1).includeYesterday, false);

  // ── computeCrmDelta ──────────────────────────────────────────────────────────────────────────
  const day = "2026-08-02";
  const baseVisit = visit({ id: 1 });
  const baseCheckin = checkin({ id: 11 });
  const seeded = computeCrmDelta({
    checkinMemo: new Map(),
    fetchedCheckins: [baseCheckin],
    fetchedVisits: [baseVisit],
    visitMemo: new Map(),
    windowFrom: day,
    windowTo: day,
  });
  // Empty memo: everything fetched is "new".
  assert.deepEqual([...seeded.changedVisitIds], [1]);
  assert.deepEqual([...seeded.changedCheckinIds], [11]);
  assert.equal(seeded.deletionSuspected, false);

  // Same fetch against the adopted memo: nothing to do.
  const quiet = computeCrmDelta({
    checkinMemo: seeded.nextCheckinMemo,
    fetchedCheckins: [baseCheckin],
    fetchedVisits: [baseVisit],
    visitMemo: seeded.nextVisitMemo,
    windowFrom: day,
    windowTo: day,
  });
  assert.equal(quiet.changedVisitIds.size, 0);
  assert.equal(quiet.changedCheckinIds.size, 0);
  assert.equal(quiet.deletionSuspected, false);

  // A field edit on an existing visit is a change; the unchanged sibling is not.
  const edited = computeCrmDelta({
    checkinMemo: seeded.nextCheckinMemo,
    fetchedCheckins: [baseCheckin],
    fetchedVisits: [visit({ id: 1, comment: "edited later" }), visit({ id: 2 })],
    visitMemo: seeded.nextVisitMemo,
    windowFrom: day,
    windowTo: day,
  });
  assert.deepEqual([...edited.changedVisitIds].sort(), [1, 2]); // 1 edited, 2 brand-new
  assert.equal(edited.changedCheckinIds.size, 0);

  // A memo id inside the window that the fetch no longer returns → deletion suspected.
  const afterDeletion = computeCrmDelta({
    checkinMemo: seeded.nextCheckinMemo,
    fetchedCheckins: [baseCheckin],
    fetchedVisits: [], // visit 1 vanished from the CRM
    visitMemo: seeded.nextVisitMemo,
    windowFrom: day,
    windowTo: day,
  });
  assert.equal(afterDeletion.deletionSuspected, true);

  // A today-only probe must NOT forget (or "delete-suspect") yesterday's memo entries.
  const yesterday = "2026-08-01";
  const withYesterday = memoOf([
    [900, { day: yesterday, hash: "y-hash" }],
    [1, { day, hash: stableStringify(baseVisit) }],
  ]);
  const todayOnly = computeCrmDelta({
    checkinMemo: new Map(),
    fetchedCheckins: [],
    fetchedVisits: [baseVisit],
    visitMemo: withYesterday,
    windowFrom: day, // today-only window: yesterday's id 900 is out of scope
    windowTo: day,
  });
  assert.equal(todayOnly.deletionSuspected, false);
  assert.equal(todayOnly.nextVisitMemo.get(900)?.hash, "y-hash"); // carried over
  // ...but anything older than the 2-day retention horizon is pruned.
  const withAncient = memoOf([[800, { day: "2026-07-25", hash: "old" }]]);
  const pruned = computeCrmDelta({
    checkinMemo: new Map(),
    fetchedCheckins: [],
    fetchedVisits: [],
    visitMemo: withAncient,
    windowFrom: day,
    windowTo: day,
  });
  assert.equal(pruned.nextVisitMemo.has(800), false);

  // ── resolveDueScheduledWork: rolling sync + weekly reconcile + hourly doctor-list sync ───────
  const HOUR = 60 * 60 * 1000;
  const monday10amCairo = { cairoDayOfWeek: 1, minutesSinceMidnight: 10 * 60, nowMs: 100 * HOUR };
  const noHistory = {
    lastParitySweepFailureMs: null,
    lastParitySweepSuccessMs: null,
    lastPlanSyncFailureMs: null,
    lastPlanSyncSuccessMs: null,
    lastReconcileFailureMs: null,
    lastReconcileSuccessMs: null,
    lastRollingFailureMs: null,
    lastRollingSuccessMs: null,
  };
  // Spread into the assertions that are ABOUT the rolling sync, so "nothing due" keeps meaning
  // nothing — otherwise the plan sync would legitimately claim the freed slot and the assertion
  // would be testing the ranking rather than the gap it was written for.
  const planJustRan = { lastPlanSyncSuccessMs: 100 * HOUR };
  // Same reasoning for the parity sweep, which joined as the fourth job. It is ranked LAST, so it
  // is the one that claims any slot the other three leave empty — which is every assertion below
  // that expects null. Parking it keeps each of those testing its own gap instead of the ranking.
  // The two values track the two clocks in this section (nowMs 100h for the weekday cases,
  // 1000h for the Sunday reconcile ones); "parked" means it ran at that instant.
  const parityParked = { lastParitySweepSuccessMs: 100 * HOUR };
  const parityParkedSunday = { lastParitySweepSuccessMs: 1000 * HOUR };
  // No history at all → the rolling sync fires on the first working-day tick (post-deploy catch-up).
  assert.equal(resolveDueScheduledWork({ ...monday10amCairo, ...noHistory }), "rolling-sync");
  // A recent rolling run parks it until the 3h gap has passed; the boundary itself fires.
  assert.equal(
    resolveDueScheduledWork({ ...monday10amCairo, ...noHistory, ...planJustRan, ...parityParked, lastRollingSuccessMs: 100 * HOUR - ROLLING_SYNC_MIN_GAP_MS + 1 }),
    null,
    "inside the min gap → nothing due (a deploy restart must not immediately re-pull 10 days)",
  );
  assert.equal(
    resolveDueScheduledWork({ ...monday10amCairo, ...noHistory, lastRollingSuccessMs: 100 * HOUR - ROLLING_SYNC_MIN_GAP_MS }),
    "rolling-sync",
  );
  // Overnight (before 06:00 Cairo) the deep pull never runs — the 2-day probe owns the night.
  assert.equal(
    resolveDueScheduledWork({ ...noHistory, ...parityParked, cairoDayOfWeek: 1, minutesSinceMidnight: 5 * 60 + 59, nowMs: 100 * HOUR }),
    null,
  );
  // A recent FAILURE backs off instead of hammering a sick vendor every 20s tick.
  assert.equal(
    resolveDueScheduledWork({ ...monday10amCairo, ...noHistory, ...planJustRan, ...parityParked, lastRollingFailureMs: 100 * HOUR - ROLLING_SYNC_FAILURE_RETRY_GAP_MS + 1 }),
    null,
  );
  assert.equal(
    resolveDueScheduledWork({ ...monday10amCairo, ...noHistory, lastRollingFailureMs: 100 * HOUR - ROLLING_SYNC_FAILURE_RETRY_GAP_MS }),
    "rolling-sync",
  );

  // ── The hourly rep-doctor-list sync ──────────────────────────────────────────────────────────
  // It is RANKED LAST on purpose: the other two feed payroll attendance, and a doctor list loses
  // nothing by waiting one 20-second tick.
  const rollingParked = { lastRollingSuccessMs: 100 * HOUR };
  assert.equal(
    resolveDueScheduledWork({ ...monday10amCairo, ...noHistory, ...rollingParked }),
    "plan-sync",
    "with the deep visit jobs parked, the doctor lists take the slot — the whole point of the job",
  );
  assert.equal(
    resolveDueScheduledWork({ ...monday10amCairo, ...noHistory }),
    "rolling-sync",
    "both due → the visits sync wins; the doctor lists must never displace it",
  );
  assert.equal(
    resolveDueScheduledWork({ ...noHistory, cairoDayOfWeek: 0, minutesSinceMidnight: 7 * 60, nowMs: 1000 * HOUR, ...rollingParked, lastRollingSuccessMs: 1000 * HOUR }),
    "wide-reconcile",
    "the weekly reconcile outranks the doctor lists too",
  );
  assert.equal(
    resolveDueScheduledWork({ ...monday10amCairo, ...noHistory, ...rollingParked, ...parityParked, lastPlanSyncSuccessMs: 100 * HOUR - PLAN_SYNC_MIN_GAP_MS + 1 }),
    null,
    "inside the hourly gap → nothing due, so a deploy restart cannot re-pull the whole month on boot",
  );
  assert.equal(
    resolveDueScheduledWork({ ...monday10amCairo, ...noHistory, ...rollingParked, lastPlanSyncSuccessMs: 100 * HOUR - PLAN_SYNC_MIN_GAP_MS }),
    "plan-sync",
    "the hourly boundary itself fires",
  );
  assert.equal(
    resolveDueScheduledWork({ ...noHistory, ...parityParked, cairoDayOfWeek: 1, minutesSinceMidnight: 5 * 60 + 59, nowMs: 100 * HOUR, ...rollingParked }),
    null,
    "05:59 Cairo — nobody edits a doctor list overnight, so the list sync keeps the night quiet too",
  );
  assert.equal(
    resolveDueScheduledWork({ ...noHistory, cairoDayOfWeek: 1, minutesSinceMidnight: 6 * 60, nowMs: 100 * HOUR, ...rollingParked }),
    "plan-sync",
    "06:00 Cairo is the first slot of the day",
  );
  assert.equal(
    resolveDueScheduledWork({ ...monday10amCairo, ...noHistory, ...rollingParked, ...parityParked, lastPlanSyncFailureMs: 100 * HOUR - PLAN_SYNC_FAILURE_RETRY_GAP_MS + 1 }),
    null,
    "a failed plan sync backs off half an hour rather than retrying every tick against a sick vendor",
  );
  assert.equal(
    resolveDueScheduledWork({ ...monday10amCairo, ...noHistory, ...rollingParked, lastPlanSyncFailureMs: 100 * HOUR - PLAN_SYNC_FAILURE_RETRY_GAP_MS }),
    "plan-sync",
    "and recovers unattended once the back-off has passed",
  );
  // Sunday from 04:00 Cairo → the weekly reconcile, and it OUTRANKS a due rolling sync.
  const sunday5amCairo = { cairoDayOfWeek: 0, minutesSinceMidnight: 5 * 60, nowMs: 1000 * HOUR };
  assert.equal(resolveDueScheduledWork({ ...sunday5amCairo, ...noHistory }), "wide-reconcile");
  assert.equal(
    resolveDueScheduledWork({ ...sunday5amCairo, ...noHistory, ...parityParkedSunday, lastReconcileSuccessMs: 1000 * HOUR - RECONCILE_MIN_GAP_MS + 1 }),
    null,
    "reconcile already ran this week and 05:00 is before the rolling window opens → nothing due",
  );
  assert.equal(
    resolveDueScheduledWork({
      ...sunday5amCairo,
      minutesSinceMidnight: 7 * 60,
      ...noHistory,
      lastReconcileSuccessMs: 1000 * HOUR - RECONCILE_MIN_GAP_MS + 1,
    }),
    "rolling-sync",
    "reconcile already ran this week → from 06:00 the slot falls back to a due rolling sync",
  );
  assert.equal(
    resolveDueScheduledWork({ ...sunday5amCairo, cairoDayOfWeek: 0, minutesSinceMidnight: 3 * 60 + 59, ...noHistory, ...parityParkedSunday }),
    null,
    "Sunday before 04:00 Cairo is night — neither deep VISIT job runs (the parity sweep's own 02:00 window is open by now, so it is parked here to keep this about the reconcile)",
  );
  assert.equal(
    resolveDueScheduledWork({ ...sunday5amCairo, ...noHistory, ...parityParkedSunday, lastReconcileFailureMs: 1000 * HOUR - RECONCILE_FAILURE_RETRY_GAP_MS + 1, lastRollingSuccessMs: 1000 * HOUR }),
    null,
    "a failed reconcile backs off a full hour and must not fall through to rolling within its gap",
  );

  // ── The daily full-history parity sweep ──────────────────────────────────────────────────────
  //
  // The fourth scheduled job, and RANKED LAST of the four deliberately. It re-proves SETTLED
  // history, so it is the only one that loses nothing at all by waiting a tick — the other three
  // feed today's attendance, today's doctor list, and payroll. Its cadence is the guarantee behind
  // "the two modules never disagree": one 30-day window a day means every day of history is
  // re-verified against the CRM roughly every 8 days, forever, instead of never past 120 days.
  const otherJobsParked = {
    lastPlanSyncSuccessMs: 100 * HOUR,
    lastReconcileSuccessMs: 100 * HOUR,
    lastRollingSuccessMs: 100 * HOUR,
  };
  assert.equal(
    resolveDueScheduledWork({ ...monday10amCairo, ...noHistory, ...otherJobsParked }),
    "parity-sweep",
    "with the three live jobs parked, the sweep takes the slot — otherwise it would never run at all",
  );
  assert.equal(
    resolveDueScheduledWork({ ...monday10amCairo, ...noHistory }),
    "rolling-sync",
    "all four due → the visits sync wins; re-proving old history must never displace today's data",
  );
  assert.equal(
    resolveDueScheduledWork({ ...monday10amCairo, ...noHistory, ...otherJobsParked, lastPlanSyncSuccessMs: null }),
    "plan-sync",
    "even the doctor lists outrank it — the sweep is last of the four, not merely after the visit jobs",
  );
  // The CADENCE VALUES are pinned literally, exactly as the tick cadences are at the top of this
  // file, and NOT derived from the constants below. An assertion written as
  // `minutesSinceMidnight: PARITY_SWEEP_EARLIEST_CAIRO_MINUTES - 1` moves with the value it is
  // supposed to be guarding: setting the constant to 0 leaves it asserting that minute -1 is too
  // early, which is true of every possible schedule. Verified 2026-08-28 — that exact assertion
  // passed against a deliberately broken constant, which is why these are literals.
  assert.equal(PARITY_SWEEP_EARLIEST_CAIRO_MINUTES, 2 * 60, "02:00 Cairo — outside the working day, clear of the Sunday 04:00 reconcile");
  assert.equal(PARITY_SWEEP_MIN_GAP_MS, 20 * HOUR, "once a DAY; 20h not 24h so the run drifts earlier rather than skipping a day on a late tick");
  assert.equal(PARITY_SWEEP_FAILURE_RETRY_GAP_MS, 2 * HOUR, "a failing vendor gets 2h of quiet, not a retry every 20s tick");

  const atMinute = (minutesSinceMidnight: number) => ({
    ...noHistory,
    ...otherJobsParked,
    cairoDayOfWeek: 1,
    minutesSinceMidnight,
    nowMs: 100 * HOUR,
  });
  assert.equal(resolveDueScheduledWork(atMinute(119)), null, "01:59 Cairo is too early — nothing at all runs in that hour");
  assert.equal(
    resolveDueScheduledWork(atMinute(120)),
    "parity-sweep",
    "02:00 Cairo is the first slot, and the sweep owns the quiet hours the other three refuse",
  );
  // Once a day, not once a tick.
  assert.equal(
    resolveDueScheduledWork({ ...monday10amCairo, ...noHistory, ...otherJobsParked, lastParitySweepSuccessMs: 100 * HOUR - 20 * HOUR + 1 }),
    null,
    "inside the daily gap → nothing due, so a deploy restart cannot re-fetch a 30-day window on boot",
  );
  assert.equal(
    resolveDueScheduledWork({ ...monday10amCairo, ...noHistory, ...otherJobsParked, lastParitySweepSuccessMs: 100 * HOUR - 20 * HOUR }),
    "parity-sweep",
    "the daily boundary itself fires",
  );
  // A failure backs off rather than retrying every tick. The sweep's failure mode is a vendor that
  // cannot answer, and hammering it is what turns a slow morning into an outage.
  assert.equal(
    resolveDueScheduledWork({ ...monday10amCairo, ...noHistory, ...otherJobsParked, lastParitySweepFailureMs: 100 * HOUR - 2 * HOUR + 1 }),
    null,
    "a failed sweep waits out its back-off",
  );
  assert.equal(
    resolveDueScheduledWork({ ...monday10amCairo, ...noHistory, ...otherJobsParked, lastParitySweepFailureMs: 100 * HOUR - 2 * HOUR }),
    "parity-sweep",
    "and recovers unattended once the back-off has passed",
  );

  // ── filterRowsToUpsert (the engine seam's safety helper) ─────────────────────────────────────
  const rows = [{ crm_visit_id: 1 }, { crm_visit_id: 2 }, { crm_visit_id: 3 }];
  // No delta set → pass-through (every scheduled/manual caller today).
  assert.equal(filterRowsToUpsert(rows, (row) => row.crm_visit_id, undefined), rows);
  // Delta set → strict subset, input untouched (reconciliation keeps the full fetch).
  const subset = filterRowsToUpsert(rows, (row) => row.crm_visit_id, new Set([2]));
  assert.deepEqual(subset, [{ crm_visit_id: 2 }]);
  assert.equal(rows.length, 3);

  // ── startLiveCrmPoller guards: must refuse to start outside the Railway production service ───
  const savedFlag = process.env.PHOENIX_LIVE_CRM_POLL;
  const savedRailway = process.env.RAILWAY_ENVIRONMENT_NAME;
  try {
    delete process.env.PHOENIX_LIVE_CRM_POLL;
    assert.equal(startLiveCrmPoller().started, false);
    process.env.PHOENIX_LIVE_CRM_POLL = "true";
    delete process.env.RAILWAY_ENVIRONMENT_NAME;
    // Even with the flag on, a non-production build (this test run) and a non-Railway host must
    // both refuse — the first failing guard reports its reason.
    const refused = startLiveCrmPoller();
    assert.equal(refused.started, false);
    assert.ok(refused.reason, "a refusal must always carry a reason");
  } finally {
    if (savedFlag === undefined) delete process.env.PHOENIX_LIVE_CRM_POLL;
    else process.env.PHOENIX_LIVE_CRM_POLL = savedFlag;
    if (savedRailway === undefined) delete process.env.RAILWAY_ENVIRONMENT_NAME;
    else process.env.RAILWAY_ENVIRONMENT_NAME = savedRailway;
  }
}
