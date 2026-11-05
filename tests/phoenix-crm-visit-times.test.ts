import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import { buildPlannerInsights } from "../src/lib/phoenix-crm/plan-insight.ts";
import { buildCustomerVisitTimes, compareMoments, momentOf, type LastVisitRow } from "../src/lib/phoenix-crm/visit-times-rules.ts";

/**
 * "Show visit times" on a plan board (owner, 2026-11-05: "make a toggle … shows the time of this customer …
 * when he is validating … the day and time of the last visit … at the district manager, you will show either
 * this visit was done for him or no, and for the rep and its timing … If off, no show. As it is now, if off").
 */

const DM = "B-118";

function visit(customerId: string, visitDate: string, capturedAt: string | null, overrides: Partial<LastVisitRow> = {}): LastVisitRow {
  return {
    customerId,
    visitDate,
    capturedAt,
    imported: false,
    kind: "single",
    managerHrId: null,
    seniorHrId: null,
    productManagerHrId: null,
    companionHrIds: [],
    ...overrides,
  };
}

function source(path: string): string {
  return stripComments(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
}

export function runPhoenixCrmVisitTimesTests(): void {
  // ── 1. An iReports360 copy has no clock: its midnight stamp is never a time ────────────────────
  assert.deepEqual(momentOf({ visitDate: "2026-07-25", capturedAt: "2026-07-24T21:00:00+00:00", imported: true }), { date: "2026-07-25", at: null });
  assert.equal(momentOf({ visitDate: "2026-11-04", capturedAt: "2026-11-04T09:31:38Z" }).at, "2026-11-04T09:31:38Z");
  assert.ok(compareMoments({ date: "2026-11-04", at: "2026-11-04T10:00:00Z" }, { date: "2026-11-04", at: "2026-11-04T09:00:00Z" }) > 0, "the later time wins a day");
  assert.ok(compareMoments({ date: "2026-11-05", at: null }, { date: "2026-11-04", at: "2026-11-04T23:00:00Z" }) > 0, "the later day wins whatever the time");

  // ── 2. The rep's last visit, its time, and whether the manager was on it ──────────────────────
  const times = buildCustomerVisitTimes({
    plannerHrId: DM,
    latest: [
      visit("c1", "2026-11-01", "2026-11-01T08:00:00Z"),
      visit("c1", "2026-11-03", "2026-11-03T09:31:00Z", { kind: "double", managerHrId: DM }),
      visit("c2", "2026-10-20", "2026-10-20T07:00:00Z"),
    ],
    named: [
      visit("c1", "2026-11-03", "2026-11-03T09:31:00Z", { kind: "double", managerHrId: DM }),
      visit("c1", "2026-10-02", "2026-10-02T09:00:00Z", { kind: "double", managerHrId: DM }),
      // Named as manager on a visit that is not a double: his rule refuses it, so it is never "with the rep".
      visit("c2", "2026-10-25", "2026-10-25T09:00:00Z", { kind: "single", managerHrId: DM }),
    ],
    own: [
      { customerId: "c2", managerCustomerId: null, visitDate: "2026-10-28", capturedAt: "2026-10-28T10:15:00Z" },
      { customerId: null, managerCustomerId: "o1", visitDate: "2026-10-30", capturedAt: "2026-10-30T11:00:00Z" },
    ],
    hours: [{ customerId: "c1", label: null, timings: [{ weekday: 6, startMinute: 840, endMinute: 960, season: "normal" }] }],
  });
  assert.deepEqual(times.c1.rep, { date: "2026-11-03", at: "2026-11-03T09:31:00Z", withYou: true }, "the newest visit, with its time, and he was on it");
  assert.deepEqual(times.c1.you, { date: "2026-11-03", at: "2026-11-03T09:31:00Z", how: "with_rep" });
  assert.equal(times.c1.hours.length, 1, "the hours the rep saved on the place");
  assert.deepEqual(times.c2.rep, { date: "2026-10-20", at: "2026-10-20T07:00:00Z", withYou: false }, "a visit without him says so");
  assert.deepEqual(times.c2.you, { date: "2026-10-28", at: "2026-10-28T10:15:00Z", how: "single" }, "his own single visit, never the refused candidate");
  assert.deepEqual(times["m:o1"], { hours: [], you: { date: "2026-10-30", at: "2026-10-30T11:00:00Z", how: "single" } }, "his own list has no rep line");

  // ── 3. The rep's own "Last seen" carries the time of HIS visit only ───────────────────────────
  const insights = buildPlannerInsights({
    customers: [
      { customerId: "p1", savedDays: true, referenceContactCrmId: null },
      { customerId: "p2", savedDays: true, referenceContactCrmId: 7 },
      { customerId: "p3", savedDays: true, referenceContactCrmId: null },
    ],
    visits: [
      { customerId: "p1", visitDate: "2026-11-02", capturedAt: "2026-11-02T08:00:00Z", nextStep: null, nextStepOn: null },
      { customerId: "p1", visitDate: "2026-11-02", capturedAt: "2026-11-02T12:00:00Z", nextStep: null, nextStepOn: null },
      { customerId: "p2", visitDate: "2026-10-01", capturedAt: "2026-10-01T08:00:00Z", nextStep: null, nextStepOn: null },
      { customerId: "p3", visitDate: "2026-10-05", capturedAt: "2026-10-04T21:00:00Z", nextStep: null, nextStepOn: null, imported: true },
    ],
    history: new Map([[7, { lastVisitedOn: "2026-10-09" }]]),
  });
  assert.equal(insights.get("p1")?.lastVisitAt, "2026-11-02T12:00:00Z", "the later of two visits on one day");
  assert.equal(insights.get("p2")?.lastVisitAt, null, "an iReports360 visit is the latest, and it has no time");
  assert.equal(insights.get("p3")?.lastVisitAt, null, "a copied visit has no clock");

  // ── 4. Off is as it was: nothing is read and nothing is drawn until the switch is on ─────────────
  const board = source("src/components/phoenix-crm/manager-plan-board.tsx");
  assert.equal((board.match(/on: showTimes/g) ?? []).length, 2, "both of his customer lists read the times only while the switch is on");
  assert.equal((board.match(/\{showTimes \? (\(\s*)?<CustomerVisitTimesLines/g) ?? []).length, 3, "every customer card draws the lines only while it is on");
  const toggle = source("src/components/phoenix-crm/visit-times.tsx");
  assert.match(toggle, /useSyncExternalStore\(subscribe, read, \(\) => false\)/, "off on the server and the first render");
  assert.match(toggle, /=== "1"/, "off unless he turned it on");
  const day = source("src/components/phoenix-crm/plan-day-panel.tsx");
  assert.match(day, /withTime: showTimes/, "the rep's day adds the time only while the switch is on");
}
