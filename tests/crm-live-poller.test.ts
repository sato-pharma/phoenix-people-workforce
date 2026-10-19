import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import {
  computeCrmDelta,
  CONTACT_LIST_SYNC_EARLIEST_CAIRO_MINUTES,
  CONTACT_LIST_SYNC_FAILURE_RETRY_GAP_MS,
  CONTACT_LIST_SYNC_LATEST_CAIRO_MINUTES,
  CONTACT_LIST_SYNC_MIN_GAP_MS,
  DAY_TICK_SECONDS,
  DEEP_RUN_MIN_SPAN_DAYS,
  FAST_TICK_SECONDS,
  nextSeedHold,
  NIGHT_TICK_SECONDS,
  PARITY_SWEEP_EARLIEST_CAIRO_MINUTES,
  PARITY_SWEEP_FAILURE_RETRY_GAP_MS,
  PARITY_SWEEP_MIN_GAP_MS,
  PLAN_SYNC_FAILURE_RETRY_GAP_MS,
  PLAN_SYNC_MIN_GAP_MS,
  PROBATION_DV_LOOKBACK_DAYS,
  readDeepRunMarkers,
  RECONCILE_FAILURE_RETRY_GAP_MS,
  RECONCILE_MIN_GAP_MS,
  resolveDueScheduledWork,
  resolvePollPlan,
  ROLLING_SYNC_FAILURE_RETRY_GAP_MS,
  ROLLING_SYNC_MIN_GAP_MS,
  SEED_HOLD_MAX_MS,
  stableStringify,
  startLiveCrmPoller,
  WIDE_PROBE_EVERY_N_TICKS,
  type SnapshotMemo,
} from "../src/lib/crm/live-poller.ts";
import { CONTACT_SYNC_SLICE_COUNT } from "../src/lib/crm/contacts-sync.ts";
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

export async function runCrmLivePollerTests() {
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
    lastContactListFailureMs: null,
    lastContactListSuccessMs: null,
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
  // And the same again for the contact-list sweep, the fifth job. It is due every FIVE MINUTES, so
  // it claims a freed slot more readily than any other — parking it is what keeps the assertions
  // below testing their own gap instead of the ranking. Its 06:00-22:00 window means the overnight
  // and 05:59 cases need no parking at all, which is why only the daytime ones carry it.
  const contactListsParked = { lastContactListSuccessMs: 100 * HOUR };
  // No history at all → the rolling sync fires on the first working-day tick (post-deploy catch-up).
  assert.equal(resolveDueScheduledWork({ ...monday10amCairo, ...noHistory }), "rolling-sync");
  // A recent rolling run parks it until the 3h gap has passed; the boundary itself fires.
  assert.equal(
    resolveDueScheduledWork({ ...monday10amCairo, ...noHistory, ...planJustRan, ...parityParked, ...contactListsParked, lastRollingSuccessMs: 100 * HOUR - ROLLING_SYNC_MIN_GAP_MS + 1 }),
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
    resolveDueScheduledWork({ ...monday10amCairo, ...noHistory, ...planJustRan, ...parityParked, ...contactListsParked, lastRollingFailureMs: 100 * HOUR - ROLLING_SYNC_FAILURE_RETRY_GAP_MS + 1 }),
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
    resolveDueScheduledWork({ ...monday10amCairo, ...noHistory, ...rollingParked, ...parityParked, ...contactListsParked, lastPlanSyncSuccessMs: 100 * HOUR - PLAN_SYNC_MIN_GAP_MS + 1 }),
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
    resolveDueScheduledWork({ ...monday10amCairo, ...noHistory, ...rollingParked, ...parityParked, ...contactListsParked, lastPlanSyncFailureMs: 100 * HOUR - PLAN_SYNC_FAILURE_RETRY_GAP_MS + 1 }),
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
    lastContactListSuccessMs: 100 * HOUR,
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

  // ── The hourly contact-list (assigned doctor list) sweep ─────────────────────────────────────
  //
  // The FIFTH scheduled job. Until 2026-09-21 `ireports360_contacts` had no in-process schedule at
  // all: the external cron swept twelve slices five minutes apart across a single hour, ONCE A DAY
  // at 05:00 Cairo, so a doctor assigned at 09:00 was invisible to Phoenix until the next morning
  // (measured on production 2026-09-21 — 9,245 rows across 66 agents written in one 05:00 burst,
  // the previous writes 09-19 05:00 and 09-16 05:00). The owner's instruction was "make it hourly".
  //
  // HOURLY IS THE GAP TIMES THE SLICE COUNT, NOT A SETTING OF ITS OWN. Twelve slices at a
  // five-minute gap is exactly one full roster an hour; changing either alone silently changes how
  // long a sweep takes, which is the defect the cron route's own banner warns about.
  const contactOnlyDue = {
    lastParitySweepSuccessMs: 100 * HOUR,
    lastPlanSyncSuccessMs: 100 * HOUR,
    lastReconcileSuccessMs: 100 * HOUR,
    lastRollingSuccessMs: 100 * HOUR,
  };
  assert.equal(
    resolveDueScheduledWork({ ...monday10amCairo, ...noHistory, ...contactOnlyDue }),
    "contact-lists",
    "with the other four parked the contact sweep takes the slot — the whole point of the job",
  );
  assert.equal(
    resolveDueScheduledWork({ ...monday10amCairo, ...noHistory, ...contactOnlyDue, lastPlanSyncSuccessMs: null }),
    "plan-sync",
    "the plan sync outranks it: the contact sweep is the most frequent job and must never hold a slot",
  );
  assert.equal(
    resolveDueScheduledWork({ ...monday10amCairo, ...noHistory, ...contactOnlyDue, lastParitySweepSuccessMs: null }),
    "contact-lists",
    "but it outranks the parity sweep — today's doctor list beats re-proving settled history",
  );
  // The CADENCE VALUES are pinned LITERALLY, never derived from the constants they guard — an
  // assertion written as `CONTACT_LIST_SYNC_MIN_GAP_MS - 1` moves with the value it is supposed to
  // be pinning and would pass against a deliberately broken constant.
  assert.equal(CONTACT_LIST_SYNC_MIN_GAP_MS, 5 * 60 * 1000, "five minutes per slice");
  assert.equal(CONTACT_LIST_SYNC_EARLIEST_CAIRO_MINUTES, 6 * 60, "06:00 Cairo — the working day opens");
  assert.equal(CONTACT_LIST_SYNC_LATEST_CAIRO_MINUTES, 22 * 60, "22:00 Cairo — nobody edits a doctor list overnight");
  assert.equal(CONTACT_LIST_SYNC_FAILURE_RETRY_GAP_MS, 15 * 60 * 1000, "a sick vendor gets 15 minutes, not a retry every tick");
  // THE HOURLY GUARANTEE ITSELF. 12 slices x a 5-minute gap = one full roster per hour; this is the
  // assertion that goes red if either half is changed without the other.
  assert.equal(
    (CONTACT_LIST_SYNC_MIN_GAP_MS * CONTACT_SYNC_SLICE_COUNT) / HOUR,
    1,
    "the gap and the slice count together must sweep the WHOLE roster in exactly one hour",
  );
  // Once every five minutes, not once every tick.
  assert.equal(
    resolveDueScheduledWork({ ...monday10amCairo, ...noHistory, ...contactOnlyDue, lastContactListSuccessMs: 100 * HOUR - 5 * 60 * 1000 + 1 }),
    null,
    "inside the five-minute gap → nothing due; a 20s tick must not re-sweep the same twelfth",
  );
  assert.equal(
    resolveDueScheduledWork({ ...monday10amCairo, ...noHistory, ...contactOnlyDue, lastContactListSuccessMs: 100 * HOUR - 5 * 60 * 1000 }),
    "contact-lists",
    "the five-minute boundary itself fires",
  );
  // The window is CLOSED at both ends — the one job whose cadence went up sixteenfold, so every
  // hour outside working hours would be a full roster of vendor requests bought for nothing.
  const atContactMinute = (minutesSinceMidnight: number) => ({
    ...noHistory,
    ...contactOnlyDue,
    lastParitySweepSuccessMs: 100 * HOUR,
    cairoDayOfWeek: 1,
    minutesSinceMidnight,
    nowMs: 100 * HOUR,
  });
  assert.equal(resolveDueScheduledWork(atContactMinute(6 * 60 - 1)), null, "05:59 Cairo is before the window opens");
  assert.equal(resolveDueScheduledWork(atContactMinute(6 * 60)), "contact-lists", "06:00 Cairo is the first slice of the day");
  assert.equal(resolveDueScheduledWork(atContactMinute(22 * 60 - 1)), "contact-lists", "21:59 Cairo is the last slice of the day");
  assert.equal(resolveDueScheduledWork(atContactMinute(22 * 60)), null, "22:00 Cairo closes it — the external 05:00 cron covers the night");
  // A failure backs off rather than re-serving the same twelfth against a vendor that cannot answer.
  assert.equal(
    resolveDueScheduledWork({ ...monday10amCairo, ...noHistory, ...contactOnlyDue, lastContactListFailureMs: 100 * HOUR - 15 * 60 * 1000 + 1 }),
    null,
    "a failed slice waits out its back-off",
  );
  assert.equal(
    resolveDueScheduledWork({ ...monday10amCairo, ...noHistory, ...contactOnlyDue, lastContactListFailureMs: 100 * HOUR - 15 * 60 * 1000 }),
    "contact-lists",
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

  // ── Probation Double-Visit capture rides every deep run ──────────────────────────────────────
  // Capture was called only from the two cron-job.org routes. When this poller took those runs
  // over, the jobs were switched off and no probation DV day was captured after 2026-08-16. The
  // poller must call it after both deep runs, and never let it fail the visits run.
  const pollerSource = readFileSync("src/lib/crm/live-poller.ts", "utf8");
  const scheduledWork = pollerSource.match(/async function runScheduledWork\([\s\S]*?\n\}\n/)?.[0] ?? "";
  assert.ok(scheduledWork, "runScheduledWork must exist");
  const successPath = scheduledWork.slice(0, scheduledWork.indexOf("} catch (error) {"));
  assert.match(
    successPath,
    /await runProbationDvCapture\(\s*\n\s*isReconcile\s*\n\s*\? resolveWideReconciliationSlice\(scheduledAt\)\s*\n\s*: \{ dateFrom: addDaysIso\(today, -PROBATION_DV_LOOKBACK_DAYS\), dateTo: today \},\s*\n\s*\);/,
    "both deep runs (rolling sync and wide reconcile) must capture probation DV days on success",
  );
  const capture = pollerSource.match(/async function runProbationDvCapture\([\s\S]*?\n\}\n/)?.[0] ?? "";
  assert.match(capture, /await syncProbationDvDays\(getSupabaseAdmin\(\), window\)/, "the capture must run syncProbationDvDays over the run's window");
  assert.match(capture, /\} catch \(error\) \{\s*\n\s*logError\(/, "a capture failure must be logged, never thrown into the visits run");
  assert.doesNotMatch(capture, /pingDeadMansSwitch|notifyIReports360SyncResult/, "a capture failure must not read as a broken visits sync");
  // A double visit can be saved up to 16 days late, so the rolling window must reach further back
  // than that.
  assert.ok(PROBATION_DV_LOOKBACK_DAYS >= 17, "the probation DV lookback must cover the 16-day late-save lag");

  // ── A contact-list slice that refreshed nothing must not advance the cursor ───────────────────
  // The predicate itself is pinned in crm-contact-lists.test.ts. This pins that BOTH schedulers
  // actually call it — a correct predicate nobody consults fixes nothing. Shape-pinned with block
  // comments stripped first, so the prose above cannot satisfy these assertions (AGENTS.md §2.1).
  const strip = (path: string) => stripComments(readFileSync(path, "utf8"));
  const pollerStripped = strip("src/lib/crm/live-poller.ts");
  const routeStripped = strip("app/api/cron/crm-contact-lists/route.ts");
  const contactBranch = pollerStripped.match(/async function runScheduledContactListSync\([\s\S]*?\n\}\n/)?.[0] ?? "";
  assert.ok(contactBranch, "runScheduledContactListSync must exist");
  assert.match(
    contactBranch,
    /const refreshedNothing = contactSyncSliceRefreshedNothing\(result\);/,
    "the in-process slice must ask the shared predicate whether it refreshed anything",
  );
  assert.match(
    contactBranch,
    /if \(refreshedNothing\) \{\s*\n\s*state\.lastContactListFailureMs = Date\.now\(\);\s*\n\s*\} else \{\s*\n\s*state\.contactListSlice = \(slice \+ 1\) % CONTACT_SYNC_SLICE_COUNT;\s*\n\s*state\.lastContactListSuccessMs = Date\.now\(\);/,
    "an all-failed slice must record a FAILURE and hold the cursor — never advance past the twelfth that got nothing",
  );
  assert.doesNotMatch(
    contactBranch,
    /result\.agents === 0/,
    "`result.agents === 0` counts ATTEMPTED agents and cannot see an all-failed slice — it must not come back",
  );
  assert.match(
    contactBranch,
    /refreshedNothing \|\| contactMaster\.status === "failed" \? "fail" : "success"/,
    "the in-process heartbeat must go red on a slice that refreshed nothing",
  );

  // ── Nothing on the poller's timer may call Next's cache bust ───────────────────────────────────
  // `revalidateTag`/`revalidatePath` need a request's work store and THROW without one (Next 16
  // `revalidate()`: "Invariant: static generation store missing"). Every function in this file runs
  // from the poller's timer, never a request, so the bust the contact-list slice used to make failed
  // on every slice and logged a false ERROR every five minutes, 06:00-22:00 Cairo (production,
  // 2026-09-21), while busting nothing. The counts it meant to bust catch up through their 300s TTL.
  assert.doesNotMatch(
    pollerStripped,
    /\brevalidate(Tag|Path)\s*\(/,
    "the in-process poller runs on a timer, where Next's cache bust always throws — it must never call one",
  );
  assert.doesNotMatch(
    pollerStripped,
    /from "next\/cache"/,
    "and it has no reason to import next/cache at all",
  );
  // The bust that CAN work stays where a request exists.
  assert.ok(
    routeStripped.indexOf("revalidateTag(CRM_CONTACT_LIST_SUMMARIES_CACHE_TAG") >
      routeStripped.indexOf("await refreshCrmContactMaster("),
    "the cron route still busts the list-summaries tag, after its master refresh",
  );

  // ── The list half is hourly; the contact master's ACTIVITY half must stay daily ───────────────
  // `contactMasterRefreshIncludesActivity` keys on the last slice of the sweep, written when a
  // sweep meant once a day. Under the hourly cursor that slice comes round every hour, so the pass
  // that reads every visit and plan row (2.5s measured, against a PostgREST cut at 8s) would run
  // ~16 times a day for nothing — visits never arrive through this job. Found by review 2026-09-21.
  assert.match(
    contactBranch,
    /const includeActivity =\s*\n\s*contactMasterRefreshIncludesActivity\(\{ slice, sliceOf: CONTACT_SYNC_SLICE_COUNT \}\) &&\s*\n\s*state\.contactActivityRebuiltOnCairoDay !== cairoToday;/,
    "the hourly sweep must gate the full activity pass on the Cairo DAY, not just on the last slice",
  );
  assert.match(
    contactBranch,
    /if \(includeActivity && contactMaster\.status === "refreshed"\) \{\s*\n\s*state\.contactActivityRebuiltOnCairoDay = cairoToday;/,
    "only a pass that landed may claim the day — a failed one must not lock out the next",
  );
  assert.doesNotMatch(
    contactBranch,
    /includeActivity: contactMasterRefreshIncludesActivity\(/,
    "passing the slice helper straight through is what made the daily pass hourly",
  );
  // The cron route genuinely runs once a day, so it keeps using the helper unqualified.
  assert.match(
    routeStripped,
    /includeActivity: contactMasterRefreshIncludesActivity\(\{ slice, sliceOf \}\)/,
    "the once-a-day cron route needs no day stamp — its last slice IS the daily sweep",
  );
  assert.match(
    routeStripped,
    /contactSyncSliceRefreshedNothing\(result\) \|\| contactMaster\.status === "failed" \? "fail" : "success"/,
    "the cron route must use the same predicate — the two schedulers cannot disagree on what green means",
  );
  assert.doesNotMatch(
    routeStripped,
    /result\.agents === 0/,
    "the route's own doc names 'a vendor session that rejects every agent' — `agents === 0` never caught it",
  );

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

  // ── A restart on a Sunday afternoon must still find that morning's reconcile ──────────────────
  // On 2026-10-11 the weekly reconcile ran at 04:00 Cairo and ran AGAIN at 17:35 after a deploy.
  // The poller remembers its last deep run by reading the newest 200 successful rows of
  // ireports360_visits_sync_runs, and by 17:35 the table had taken 231 small probe rows after the
  // 04:00 reconcile, so it was past row 200, the marker came back null and "Sunday, past 04:00,
  // never reconciled" fired again. The reader must ask for DEEP runs only. The fake below keeps
  // the table's real shape and applies the filters it is given, so a reader that stops asking for
  // deep runs sees the 200 newest probes and loses the reconcile.
  {
    type RunRow = { date_from: string; date_to: string; started_at: string; status: string };
    const rows: RunRow[] = [];
    const reconcileStartedMs = Date.parse("2026-10-10T22:00:13Z"); // 04:00:13 Cairo on Sunday 11 Oct
    rows.push({ date_from: "2026-08-12", date_to: "2026-09-11", started_at: new Date(reconcileStartedMs).toISOString(), status: "success" });
    const rollingStartedMs = Date.parse("2026-10-11T12:01:21Z"); // 15:01 Cairo
    rows.push({ date_from: "2026-10-01", date_to: "2026-10-11", started_at: new Date(rollingStartedMs).toISOString(), status: "success" });
    rows.push({ date_from: "2026-10-01", date_to: "2026-10-11", started_at: "2026-10-11T06:00:36Z", status: "success" });
    for (let i = 0; i < 231; i += 1) {
      // The small same-day and one-day probe rows the live poll writes all day.
      const startedAt = new Date(Date.parse("2026-10-10T22:30:00Z") + i * 3 * 60_000).toISOString();
      rows.push({ date_from: i % 2 === 0 ? "2026-10-11" : "2026-10-10", date_to: "2026-10-11", started_at: startedAt, status: "success" });
    }
    rows.push({ date_from: "2026-08-05", date_to: "2026-09-04", started_at: "2026-10-04T01:00:00Z", status: "failed" });
    const fakeSupabase = {
      from: () => {
        let filtered = rows.slice();
        const query = {
          select: () => query,
          eq: (column: string, value: string) => {
            filtered = filtered.filter((row) => (row as unknown as Record<string, string>)[column] === value);
            return query;
          },
          lte: (column: string, value: string) => {
            filtered = filtered.filter((row) => (row as unknown as Record<string, string>)[column] <= value);
            return query;
          },
          order: (column: string, options: { ascending: boolean }) => {
            filtered.sort((a, b) => ((a as unknown as Record<string, string>)[column] < (b as unknown as Record<string, string>)[column] ? 1 : -1) * (options.ascending ? -1 : 1));
            return query;
          },
          limit: (count: number) => Promise.resolve({ data: filtered.slice(0, count), error: null }),
        };
        return query;
      },
    } as never;
    assert.ok(rows.filter((row) => row.status === "success").length > 200, "the table must hold more successful rows than the reader's cap");

    const markers = await readDeepRunMarkers(fakeSupabase, "2026-10-11");
    assert.equal(
      markers.lastReconcileSuccessMs,
      reconcileStartedMs,
      "the 04:00 reconcile must still be remembered after 231 probe rows - otherwise a Sunday deploy re-runs the 30-day pull",
    );
    assert.equal(markers.lastRollingSuccessMs, rollingStartedMs, "the newest rolling sync is the other marker");
    assert.ok(DEEP_RUN_MIN_SPAN_DAYS >= 2, "probe windows reach back at most a day or two, so the deep threshold must clear them");

    // And a remembered reconcile is what keeps the weekly job from firing a second time.
    const sundayAfternoon = Date.parse("2026-10-11T14:35:00Z"); // 17:35 Cairo
    const dueAfterRestart = resolveDueScheduledWork({
      ...sunday5amCairo,
      ...noHistory,
      ...parityParkedSunday,
      lastReconcileSuccessMs: markers.lastReconcileSuccessMs,
      minutesSinceMidnight: 17 * 60 + 35,
      nowMs: sundayAfternoon,
    });
    assert.notEqual(dueAfterRestart, "wide-reconcile", "with its 04:00 run remembered, a 17:35 restart must not run the reconcile again");
  }

  // 🔴 A MARKER THE RESTART COULD NOT READ HOLDS ITS JOBS, READ AGAIN EVERY TICK (19 Oct 2026, 15:21
  //    Cairo: one marker read timed out in a database burst, and the first due tick would have re-run
  //    the 10-day sync — on a Sunday afternoon, the 30-day reconcile the block above stops).
  {
    assert.equal(resolveDueScheduledWork({ ...sunday5amCairo, ...noHistory }), "wide-reconcile", "unheld, an unknown reconcile runs");
    const deepHeld = resolveDueScheduledWork({ ...sunday5amCairo, ...noHistory, held: { deepRuns: true } });
    assert.ok(deepHeld !== "wide-reconcile" && deepHeld !== "rolling-sync", "held, neither deep run is weighed without its marker");
    assert.equal(
      resolveDueScheduledWork({ ...monday10amCairo, ...noHistory, held: { deepRuns: true } }),
      "plan-sync",
      "the jobs behind a held one still run",
    );
    assert.equal(
      resolveDueScheduledWork({ ...monday10amCairo, ...noHistory, ...contactListsParked, held: { deepRuns: true, planSync: true } }),
      "parity-sweep",
      "the doctor lists wait for their own marker",
    );
    assert.equal(
      resolveDueScheduledWork({
        ...monday10amCairo,
        ...noHistory,
        ...contactListsParked,
        held: { deepRuns: true, paritySweep: true, planSync: true },
      }),
      null,
      "and the parity sweep for its own: with all three held only the live poll runs",
    );

    assert.deepEqual(nextSeedHold(null, "read", 5), { event: "read", heldSinceMs: null }, "a marker read at the restart holds nothing");
    assert.deepEqual(nextSeedHold(null, "failed", 1_000), { event: "held", heldSinceMs: 1_000 }, "a failed read starts the hold");
    assert.deepEqual(
      nextSeedHold(1_000, "failed", 1_000 + SEED_HOLD_MAX_MS - 1),
      { event: "still-held", heldSinceMs: 1_000 },
      "a failure inside the limit keeps the FIRST failure's time",
    );
    assert.deepEqual(nextSeedHold(1_000, "read", 61_000), { event: "read", heldSinceMs: null }, "a later read lifts the hold");
    assert.deepEqual(
      nextSeedHold(1_000, "failed", 1_000 + SEED_HOLD_MAX_MS),
      { event: "gave-up", heldSinceMs: null },
      "at the limit the jobs run without the marker, as they always did",
    );
    assert.ok(SEED_HOLD_MAX_MS <= 30 * 60_000, "never held past half an hour: the rolling sync feeds payroll attendance");

    const source = stripComments(readFileSync("src/lib/crm/live-poller.ts", "utf8"));
    const tickBody = source.slice(source.indexOf("async function tick()"), source.indexOf("function scheduleNext()"));
    assert.ok(
      /if \(stillHeld\.length > 0\) await seedMarkers\(stillHeld\);[\s\S]*resolveDueScheduledWork\(\{[\s\S]*held: heldSeedGroups\(\),/.test(tickBody),
      "every tick reads a held marker again BEFORE it weighs a deep run, and passes the hold on",
    );
    assert.ok(source.includes("void seedMarkers(SEED_GROUPS)"), "a restart reads all three groups");
    const seedBody = source.slice(source.indexOf("async function seedMarkers("), source.indexOf("function heldSeedGroups("));
    assert.equal(seedBody.split("logError(").length - 1, 1, "one error row at most");
    assert.ok(/next\.event === "gave-up"\) \{\s*logError\(/.test(seedBody), "and only when the hold gives up");
    assert.ok(/next\.event === "held"\) \{\s*logWarning\(/.test(seedBody), "a first failure is a warning: the hold is the handling");
  }
}
