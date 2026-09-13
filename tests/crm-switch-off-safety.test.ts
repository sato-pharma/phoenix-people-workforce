import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { summarizeFieldWorkforceMirrorFreshness } from "../src/lib/field-workforce-compliance/live-snapshots.ts";
import { JOB_SCHEDULES, watchedJobSchedules } from "../src/lib/observability/job-schedule.ts";
import { detectDvDays } from "../src/lib/probation/intelligence/dv-detection.ts";
import type { RawDvVisitRow } from "../src/lib/probation/intelligence/dv-source.ts";

// What must keep working, stay quiet, or stop crying wolf once iReports360 is switched off and Phoenix
// records visits itself. Each block names the finding it pins. The pure rules are exercised for real;
// the paths that only exist behind a database read or a client component are pinned by source shape.

const read = (path: string) => readFileSync(path, "utf8");

const VENDOR_JOB_SLUGS = [
  "phoenix-crm-contact-lists",
  "phoenix-ireports360-live-poll",
  "phoenix-ireports360-sync",
  "phoenix-reconcile-visits",
];

function dvRow(over: Partial<RawDvVisitRow>): RawDvVisitRow {
  return {
    id: "r1",
    crm_visit_id: 1,
    visit_date: "2026-10-01",
    visit_type: 0,
    visit_type_description: "Regular",
    agent_hr_id: "B-178",
    agent_name: "Emp",
    double_crm_id: 9,
    double_hr_id: "A-12",
    double_name: "Eval",
    contact_name: "Dr",
    customer_name: null,
    comment: null,
    ampm: "AM",
    ...over,
  };
}

export function runCrmSwitchOffSafetyTests() {
  // F1a — a Phoenix double visit carries a NEGATIVE id and must still form a probation DV-Day.
  {
    const { dvDays, unresolved } = detectDvDays([
      dvRow({ id: "p1", crm_visit_id: -41 }),
      dvRow({ id: "p2", crm_visit_id: -42, ampm: "PM" }),
    ]);
    assert.equal(unresolved.length, 0, "F1a: a negative (Phoenix) visit id is a real id, not a missing one");
    assert.equal(dvDays.length, 1, "F1a: two Phoenix double visits on one day form one DV-Day");
    assert.deepEqual([...dvDays[0].crmVisitIds].sort((a, b) => a - b), [-42, -41], "F1a: both Phoenix ids are kept");

    const zero = detectDvDays([dvRow({ id: "z1", crm_visit_id: 0 })]);
    assert.equal(zero.dvDays.length, 0, "F1a: id 0 still forms nothing");
    assert.equal(zero.unresolved[0]?.reason, "missing_crm_visit_id", "F1a: id 0 is still reported as missing");
  }

  // F2 — the heartbeat sweep stops watching the four vendor jobs once the vendor is stood down.
  {
    const tagged = JOB_SCHEDULES.filter((job) => job.vendorSync).map((job) => job.slug).sort();
    assert.deepEqual(tagged, [...VENDOR_JOB_SLUGS].sort(), "F2: exactly the four vendor jobs are tagged vendorSync");

    const retired = watchedJobSchedules(JOB_SCHEDULES, "vendor_sync_retired").map((job) => job.slug);
    for (const slug of VENDOR_JOB_SLUGS) {
      assert.ok(!retired.includes(slug), `F2: ${slug} is not watched once the vendor is retired`);
    }
    assert.equal(retired.length, JOB_SCHEDULES.length - VENDOR_JOB_SLUGS.length, "F2: every other job is still watched");
    assert.equal(watchedJobSchedules(JOB_SCHEDULES, null).length, JOB_SCHEDULES.length, "F2: before retirement every job is watched");

    const heartbeat = read("src/lib/observability/job-heartbeat.ts");
    assert.match(
      heartbeat,
      /declarations:\s*watchedJobSchedules\(JOB_SCHEDULES,\s*vendorStandDown\)/,
      "F2: sweepJobHeartbeats assesses watchedJobSchedules, not the raw JOB_SCHEDULES",
    );
    assert.match(heartbeat, /const vendorStandDown = await resolveVendorSyncStandDown\(\);/, "F2: the sweep reads the stand-down");
  }

  // F3 — reconciliation check 10 holds once iReports360 is retired instead of reporting a breach.
  {
    const source = read("src/lib/reconciliation/checks/crm-sales.ts");
    const start = source.indexOf("const visitsSyncHasARecentSuccess");
    assert.ok(start >= 0, "F3: check 10 is still defined");
    const check = source.slice(start, source.indexOf("\n};", start));
    const standDown = check.indexOf("await resolveVendorSyncStandDown()");
    const retiredDetail = check.indexOf('detail: "iReports360 retired; Phoenix records visits directly."');
    assert.ok(standDown >= 0, "F3: check 10 asks the stand-down");
    assert.ok(retiredDetail > standDown, "F3: check 10 returns the retired detail after the stand-down question");
    assert.match(check.slice(standDown, retiredDetail), /holds: true/, "F3: the retired outcome holds");
  }

  // F4 — the live-snapshot page stops calling the data stale once the vendor sync is retired.
  {
    const nowIso = "2026-10-15T09:00:00.000Z";
    const oldRun = [{ completedAt: "2026-09-01T06:00:00.000Z", startedAt: "2026-09-01T05:59:00.000Z", status: "success" }];
    const retired = summarizeFieldWorkforceMirrorFreshness({ monthKey: "2026-10", nowIso, runs: oldRun, vendorSyncRetired: true });
    assert.equal(retired.isStale, false, "F4: an old last sync is not stale once the vendor is retired");
    assert.equal(retired.isOpenMonth, true, "F4: the open-month notice still shows");
    const noRuns = summarizeFieldWorkforceMirrorFreshness({ monthKey: "2026-10", nowIso, runs: [], vendorSyncRetired: true });
    assert.equal(noRuns.isStale, false, "F4: no sync run at all is not stale once the vendor is retired");
    const live = summarizeFieldWorkforceMirrorFreshness({ monthKey: "2026-10", nowIso, runs: oldRun });
    assert.equal(live.isStale, true, "F4: before retirement an old last sync is still stale");

    const route = read("app/api/admin/field-workforce-compliance/live-snapshots/[monthKey]/route.ts");
    assert.match(route, /vendorSyncRetired: vendorStandDown !== null/, "F4: the route passes the stand-down through");
  }

  // F5 — from the cutover day the NSM board counts the day as checked, so it never waits for a sync.
  {
    const source = read("src/lib/employee-portal/nsm-crm-compliance.ts");
    const start = source.indexOf("export async function getNsmCrmCompliance");
    const body = source.slice(start, source.indexOf("\n}\n", start));
    assert.match(
      body,
      /vendorSyncStandDownReason\(setting\)\s*\|\|\s*isOnOrAfterCrmCutover\(setting, date\)\s*\?\s*new Date\(\)\.toISOString\(\)/,
      "F5: on or after the cutover, or once stood down, lastSyncRunAt is now",
    );
    assert.match(body, /getLatestSuccessfulSyncRunFor\(date\)/, "F5: before the cutover the vendor ledger is still read");

    const board = read("src/components/employee-portal/dashboards/crm-first-visit-board.tsx");
    assert.doesNotMatch(board, /iReports360 sent no usable clock/, "F5: the no-clock badge no longer names the vendor");
  }

  // F6 — every board mounts the server-decided sync action, never the raw button.
  {
    const callers = [
      "src/components/employee-portal/dashboards/nsm-command-center.tsx",
      "src/components/employee-portal/dashboards/rm-command-center.tsx",
      "src/components/employee-portal/dashboards/dsm-command-center.tsx",
      "app/employee-portals/early-birds/page.tsx",
      "app/(admin)/admin/early-birds/page.tsx",
    ];
    for (const path of callers) {
      const source = read(path);
      assert.match(source, /<EarlyBirdsSyncAction \/>/, `F6: ${path} mounts EarlyBirdsSyncAction`);
      assert.doesNotMatch(source, /<EarlyBirdsSyncButton \/>/, `F6: ${path} no longer mounts the raw button`);
    }
    const action = read("src/components/crm/early-birds-sync-action.tsx");
    assert.match(action, /if \(await resolveVendorSyncStandDown\(\)\) return null;/, "F6: the action renders nothing once retired");
  }

  // F7 — a Phoenix plan (negative id) gets no verify action and says where it is reviewed.
  {
    const button = read("src/components/crm/plan-verify-button.tsx");
    assert.match(button, /const phoenixPlan = plan\.crmPlanId < 0;/, "F7: the button recognises a Phoenix plan");
    assert.match(button, /const action: PlanVerificationAction \| null = phoenixPlan\s*\?\s*null/, "F7: a Phoenix plan has no action");
    assert.match(button, /phoenixPlan \? "Reviewed in Phoenix"/, "F7: a Phoenix plan reads Reviewed in Phoenix");

    const route = read("app/api/crm/plan-verification/verify/route.ts");
    const negative = route.indexOf("crmPlanId < 0");
    const standDown = route.indexOf("await resolveVendorSyncStandDown()");
    assert.ok(negative >= 0 && standDown >= 0, "F7: the route has both refusals");
    assert.ok(negative < standDown, "F7: the negative-id answer comes before the generic retired 409");
  }

  // F8 — the CRM hub's sync panel says the vendor is retired and offers no backfill.
  {
    const panel = read("src/components/crm/crm-sync-status-panel.tsx");
    assert.match(panel, /iReports360 was retired on \{formatCairoDay\(retiredAt\)\}\. Phoenix records visits directly\./, "F8: one retired line");
    assert.match(panel, /function formatCairoDay[\s\S]*?timeZone: "Africa\/Cairo"/, "F8: the retirement day is a Cairo day");
    const hide = panel.indexOf("{retiredAt ? null : (");
    const backfill = panel.indexOf("Run backfill");
    assert.ok(hide >= 0 && hide < backfill, "F8: the backfill control sits inside the retired guard");

    const page = read("app/(admin)/admin/crm/page.tsx");
    assert.match(page, /retiredAt=\{vendorSyncRetiredAt\}/, "F8: the hub passes the retirement to the panel");
    assert.match(page, /setting\.vendorSyncRetiredAt/, "F8: the hub reads the retirement from the cutover setting");
  }
}
