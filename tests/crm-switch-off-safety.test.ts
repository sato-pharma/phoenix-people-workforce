import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import {
  adminHubPromotions,
  adminNavigationSectionSeeds,
  crmPageItems,
  hubPageItemGroups,
} from "../src/config/system-navigation.ts";
import { summarizeFieldWorkforceMirrorFreshness } from "../src/lib/field-workforce-compliance/live-snapshots.ts";
import { JOB_SCHEDULES } from "../src/lib/observability/job-schedule.ts";
import { detectDvDays } from "../src/lib/probation/intelligence/dv-detection.ts";
import type { RawDvVisitRow } from "../src/lib/probation/intelligence/dv-source.ts";
import { reconciliationChecks } from "../src/lib/reconciliation/checks/index.ts";
import { crmSalesReconciliationChecks } from "../src/lib/reconciliation/checks/crm-sales.ts";
import { stripComments } from "./support/comment-strip.ts";

// What must keep working, stay quiet, or stop crying wolf once iReports360 is switched off and Phoenix
// records visits itself. Each block names the finding it pins. The pure rules are exercised for real;
// the paths that only exist behind a database read or a client component are pinned by source shape.
// iReports360 was retired on 6 November 2026 and its code removed, so the blocks that once pinned a
// stand-down gate now pin that the vendor code is GONE and the module it fed was rewired, not closed.

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

  // F2 — the four vendor jobs left the schedule with the vendor, so the heartbeat sweep judges every job.
  {
    const declared = JOB_SCHEDULES.map((job) => job.slug);
    for (const slug of VENDOR_JOB_SLUGS) {
      assert.ok(!declared.includes(slug), `F2: ${slug} is no longer a declared job`);
    }
    const schedule = read("src/lib/observability/job-schedule.ts");
    assert.doesNotMatch(schedule, /watchedJobSchedules|vendorSync:/, "F2: the stand-down filter left with the vendor jobs");

    const heartbeat = read("src/lib/observability/job-heartbeat.ts");
    assert.match(heartbeat, /declarations:\s*JOB_SCHEDULES\b/, "F2: sweepJobHeartbeats assesses every declared job");
    assert.doesNotMatch(heartbeat, /resolveVendorSyncStandDown/, "F2: the sweep no longer asks the stand-down");
  }

  // F3 — reconciliation check 10 (the vendor sync's freshness) left with the vendor instead of holding forever.
  {
    const source = read("src/lib/reconciliation/checks/crm-sales.ts");
    assert.doesNotMatch(source, /visitsSyncHasARecentSuccess|SYNC_FRESHNESS_HOURS/, "F3: check 10 is gone, and nothing lists it");
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

  // F6 — Early Birds stays and keeps scoring from Phoenix CRM (owner, 6 November 2026: "donot close early
  // birds just make it grab its data from phx crm"); only its vendor Sync control left.
  {
    const pages = [
      "src/components/employee-portal/dashboards/nsm-command-center.tsx",
      "src/components/employee-portal/dashboards/rm-command-center.tsx",
      "src/components/employee-portal/dashboards/dsm-command-center.tsx",
      "app/employee-portals/early-birds/page.tsx",
      "app/(admin)/admin/early-birds/page.tsx",
    ];
    for (const path of pages) {
      assert.ok(existsSync(path), `F6: ${path} is still there`);
      assert.doesNotMatch(read(path), /EarlyBirdsSync(Action|Button)/, `F6: ${path} mounts no vendor Sync control`);
    }
    for (const path of [
      "src/components/crm/early-birds-sync-action.tsx",
      "src/components/crm/early-birds-sync-button.tsx",
      "app/api/crm/early-birds/sync/route.ts",
    ]) {
      assert.equal(existsSync(path), false, `F6: ${path} left with the vendor`);
    }
    const collect = read("src/lib/early-birds/collect.ts");
    assert.match(collect, /import \{[^}]*\bqueryVisits\b[^}]*\} from "@\/lib\/crm\/reads"/, "F6: Early Birds reads visits through the CRM read door");
    assert.match(collect, /import \{[^}]*\bqueryCheckins\b[^}]*\} from "@\/lib\/crm\/reads"/, "F6: and check-ins through it");
  }

  // F7 — the plan board's button, which only ever wrote into iReports360, now approves a sent Phoenix CRM
  // week through Phoenix's own decide route; an old-CRM plan is history in words.
  {
    assert.equal(existsSync("app/api/crm/plan-verification/verify/route.ts"), false, "F7: the vendor verify route is gone");
    assert.equal(existsSync("src/lib/crm/plan-verification-service.ts"), false, "F7: its vendor write service is gone");

    const button = read("src/components/crm/plan-verify-button.tsx");
    assert.match(button, /const phoenixPlan = plan\.crmPlanId < 0;/, "F7: the button recognises a Phoenix plan");
    assert.match(button, /phoenixStatus === "submitted"/, "F7: only a sent Phoenix week can be approved");
    assert.match(button, /fetch\("\/api\/phoenix-crm\/plans\/decide"/, "F7: it posts to Phoenix's own decide route");
    assert.match(button, /action: "approve"/, "F7: approve only — a return needs the Team tab's note");
    assert.match(button, /expectedVersion: plan\.phoenixVersion/, "F7: a stale version is refused by the route, not guessed");
    assert.match(button, /payload\.message \?\?/, "F7: the route's own refusal is what the screen shows");
    assert.doesNotMatch(button, /\/api\/crm\/plan-verification/, "F7: nothing still writes into the old CRM");
  }

  // F8 — the CRM hub's sync panel says the vendor is retired, keeps the run history, and offers no backfill.
  {
    const panel = read("src/components/crm/crm-sync-status-panel.tsx");
    assert.match(panel, /iReports360 was retired on \{formatCairoDay\(retiredAt\)\}\. Phoenix records visits directly\./, "F8: one retired line");
    assert.match(panel, /function formatCairoDay[\s\S]*?timeZone: "Africa\/Cairo"/, "F8: the retirement day is a Cairo day");
    assert.equal(panel.includes("Run backfill"), false, "F8: the backfill control left with the vendor");
    assert.equal(existsSync("app/api/admin/visits-report/backfill/route.ts"), false, "F8: and so did its route");

    const page = read("app/(admin)/admin/crm/page.tsx");
    assert.match(page, /retiredAt=\{vendorSyncRetiredAt\}/, "F8: the hub passes the retirement to the panel");
    assert.match(page, /setting\.vendorSyncRetiredAt/, "F8: the hub reads the retirement from the cutover setting");
  }

  // F9 — CRM Integrity matched iReports360 visits against iReports360 check-ins, so with the vendor
  // retired it could only compare a frozen archive with itself. Every link to it is gone and its route
  // is a pointer to Phoenix CRM's own integrity screens, behind the gate it always had (7 Nov 2026).
  {
    const RETIRED = "/admin/crm-integrity";
    const hrefsIn = (value: unknown, seen = new Set<unknown>()): string[] => {
      if (value === null || typeof value !== "object" || seen.has(value)) return [];
      seen.add(value);
      const own = value as Record<string, unknown>;
      const found = [own.href, ...(Array.isArray(own.hrefs) ? own.hrefs : [])].filter((h): h is string => typeof h === "string");
      return [...found, ...Object.values(own).flatMap((child) => hrefsIn(child, seen))];
    };
    assert.ok(hrefsIn(crmPageItems).includes("/admin/phoenix-crm/integrity"), "F9: the collector reads the hub cards it is meant to");
    assert.ok(hrefsIn(adminHubPromotions).includes("/admin/double-visit-analytics"), "F9: and the promoted bands");
    assert.equal(hrefsIn(crmPageItems).includes(RETIRED), false, "F9: no CRM hub card opens CRM Integrity");
    assert.equal(hrefsIn(hubPageItemGroups).includes(RETIRED), false, "F9: no hub card anywhere opens it");
    assert.equal(hrefsIn(adminHubPromotions).includes(RETIRED), false, "F9: no promoted band row opens it");
    assert.equal(hrefsIn(adminNavigationSectionSeeds).includes(RETIRED), false, "F9: no sidebar row opens it");
    assert.equal(read("app/(admin)/admin/crm/page.tsx").includes(`"${RETIRED}"`), false, "F9: the CRM workspace's tool buttons do not link it");
    assert.equal(read("src/components/admin/ceo-phase-b.tsx").includes(`"${RETIRED}"`), false, "F9: nor does the SFE Manager's quick navigation");

    for (const gone of [
      "src/lib/crm-integrity/service.ts",
      "src/lib/crm-integrity/correlation.ts",
      "src/lib/crm-integrity/types.ts",
      "src/components/crm-integrity/crm-integrity-workspace.tsx",
    ]) {
      assert.equal(existsSync(gone), false, `F9: ${gone} left with the vendor comparison`);
    }

    const pointer = stripComments(read("app/(admin)/admin/crm-integrity/page.tsx"));
    assert.match(pointer, /if \(!canUseAdminCrmWorkspace\(access\)\) \{\s*redirect\(resolveLandingPathForRole\(access\.role\)\);/, "F9: the route keeps its gate");
    assert.doesNotMatch(pointer, /@\/lib\/crm-integrity\/|crm-integrity-workspace|getCrmIntegrityData|@\/lib\/crm\/reads/, "F9: the route reads no vendor comparison");
    const listed = /const PHOENIX_INTEGRITY_HREFS = \[([\s\S]*?)\] as const;/.exec(pointer)?.[1] ?? "";
    const targets = [...listed.matchAll(/"(\/[^"]+)"/g)].map((match) => match[1]!);
    assert.equal(targets[0], "/admin/phoenix-crm/integrity", "F9: the pointer leads with Location Integrity");
    for (const href of targets) {
      assert.ok(crmPageItems.some((card) => card.href === href), `F9: ${href} is a live CRM hub card, so the pointer never renders an empty list`);
    }
  }

  // F10 — reconciliation check 9 compared the Unmapped Agents punch-list, derived from ireports360_visits,
  // with the visits door. Nothing writes that table since the retirement and a Phoenix visit always carries
  // an hr id, so the check is retired rather than left to agree with a frozen archive every night.
  {
    const ids = reconciliationChecks.map((check) => check.id);
    assert.equal(ids.includes("crm-recent-visits-all-resolve-to-an-employee"), false, "F10: check 9 no longer runs");
    assert.deepEqual(
      crmSalesReconciliationChecks.map((check) => check.id),
      ["sos-top-customers-one-row-per-customer", "sos-coverage-numerator-inside-master-denominator"],
      "F10: the CRM-and-sales domain keeps its two Source-of-Sales checks, untouched",
    );
    assert.equal(new Set(ids).size, ids.length, "F10: the registry still holds each check once");
  }
}
