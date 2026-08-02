import assert from "node:assert/strict";

import {
  computeCrmDelta,
  DAY_TICK_SECONDS,
  FAST_TICK_SECONDS,
  NIGHT_TICK_SECONDS,
  resolvePollPlan,
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
