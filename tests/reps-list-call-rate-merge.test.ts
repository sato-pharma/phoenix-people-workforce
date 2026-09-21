import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  AM_CALL_RATE_TARGET,
  PM_CALL_RATE_TARGET,
  type CallRateReport,
  type CallRateSlice,
  type RepCallRate,
} from "../src/lib/crm/call-rate.ts";
import { CALL_RATE_TAB, callRateHref } from "../src/lib/crm/reps-list-call-rate-route.ts";
import { buildRepsPlansBoard } from "../src/lib/crm/reps-plans.ts";

// Reps Plans merged into Reps List — owner, 2026-09-21: "merge the 2 modules into 1 module WHICH
// REPS LIST", and, with it, "already the reps list contains the plan, so make sure you're not
// duplicating data".
//
// What is pinned here is the merge itself, not the board: the board's rules keep their own suite
// (tests/crm-reps-plans.test.ts). Four things can break the merge while every one of those rules
// stays green:
//
//   • the REP carried across the tab strip. Reps List keys a rep by his hr id; the call-rate board
//     keys him by CRM account. Without the bridge, a manager who reads a rep's contact list and
//     presses Call rate lands on the whole team instead of that rep.
//   • the OLD ADDRESSES. Bookmarks and shared links to /reps-plans must land on the same board and
//     the same window, not on the contact list and not on a 404.
//   • DUPLICATION. The tab brings only what Reps List lacked; the weekly plans are read on the plans
//     tab and must not be re-assembled under a second label.
//   • the GATE. The tab keeps the Reps Plans gate, which is narrower than the Reps List one — the
//     CEO reads Reps List and never had Reps Plans.

function slice(target: number, verified: number, workingDays: number): CallRateSlice {
  const verifiedRate = workingDays > 0 ? verified / workingDays : null;
  return {
    verified,
    unverified: 0,
    campaign: 0,
    total: verified,
    verifiedRate,
    totalRate: verifiedRate,
    target,
    attainmentPct: verifiedRate == null ? null : (verifiedRate / target) * 100,
  };
}

function rep(name: string, crmId: number, hrId: string | null, am: number, pm: number): RepCallRate {
  const workingDays = 10;
  return {
    agentCrmId: crmId,
    agentHrId: hrId,
    agentName: name,
    workingDays,
    am: slice(AM_CALL_RATE_TARGET, am, workingDays),
    pm: slice(PM_CALL_RATE_TARGET, pm, workingDays),
    pharmacy: {
      verified: 0,
      unverified: 0,
      campaign: 0,
      total: 0,
      verifiedRate: 0,
      totalRate: 0,
      target: null,
      attainmentPct: null,
    },
    unspecified: 0,
    campaignShare: 0,
    campaignOverLimitDays: [],
    campaignOnlyDays: 0,
  };
}

function report(reps: RepCallRate[]): CallRateReport {
  return { dateFrom: "2026-08-01", dateTo: "2026-08-31", workingDays: 10, holidayDays: 0, campaignLimit: 3, reps };
}

export function runRepsListCallRateMergeTests() {
  // ── 1. The rep carried in from the contact list ──────────────────────────────────────────────
  // Reps List writes `hr:<hr id>` lower-cased (coverageRepKey); the directory spells the same id
  // upper-cased. Both sides are canonicalised, so the case must not matter.
  const team = report([
    rep("Aya", 1, "AI-0001", 20, 100),
    rep("Badr", 2, "AI-0002", 10, 50),
  ]);
  const carried = buildRepsPlansBoard(team, { isCurrentMonth: false, month: "2026-08", repKey: "hr:ai-0001" });
  assert.equal(
    carried.appliedRepKey,
    "crm:1",
    "a Reps List rep key resolves to that person's call-rate row — pressing Call rate on a rep's contact list opens THAT rep",
  );
  assert.equal(carried.reps.length, 1, "and the table narrows to him");
  assert.equal(carried.reps[0]?.repName, "Aya");
  assert.equal(carried.totals.reps, 2, "while the tiles above it still cover the whole team, exactly as a picker choice does");

  // The board's own key still wins untouched — the picker and the rows write `crm:…`.
  assert.equal(
    buildRepsPlansBoard(team, { isCurrentMonth: false, month: "2026-08", repKey: "crm:2" }).appliedRepKey,
    "crm:2",
    "the board's own key is applied as it always was",
  );

  // One person, two CRM accounts in the window: the report buckets per account, so he has two rows.
  // The busier account is the one he is working from, and it is the one that opens.
  const twoAccounts = report([
    rep("Aya", 7, "AI-0001", 2, 10),
    rep("Aya", 8, "AI-0001", 18, 90),
    rep("Badr", 2, "AI-0002", 10, 50),
  ]);
  assert.equal(
    buildRepsPlansBoard(twoAccounts, { isCurrentMonth: false, month: "2026-08", repKey: "hr:ai-0001" }).appliedRepKey,
    "crm:8",
    "a person with two accounts opens on the account carrying his calls",
  );

  // Somebody else's rep: the match runs over the viewer's scoped rows, so an hr key outside the
  // scope resolves to nothing — the same answer a guessed `crm:` key gets, and no oracle.
  const scoped = buildRepsPlansBoard(team, {
    isCurrentMonth: false,
    month: "2026-08",
    repKey: "hr:ai-0001",
    scope: { kind: "agents", basis: "team", agentHrIds: ["AI-0002"], label: "Badr's manager" },
  });
  assert.equal(scoped.appliedRepKey, null, "an hr key for a rep outside the viewer's scope applies nothing");
  assert.deepEqual(
    scoped.reps.map((row) => row.repName),
    ["Badr"],
    "and the board shows only the viewer's own reps, never the one named in the URL",
  );

  // A key that names nobody falls back to everyone rather than emptying the board.
  const nobody = buildRepsPlansBoard(team, { isCurrentMonth: false, month: "2026-08", repKey: "hr:ai-9999" });
  assert.equal(nobody.appliedRepKey, null);
  assert.equal(nobody.reps.length, 2, "an hr key nobody on the board holds shows every rep, never an empty table");
  assert.equal(
    buildRepsPlansBoard(team, { isCurrentMonth: false, month: "2026-08", repKey: "hr:" }).appliedRepKey,
    null,
    "an empty hr key applies nothing",
  );

  // ── 2. The old addresses forward with everything they carried ───────────────────────────────
  assert.equal(CALL_RATE_TAB, "call-rate");
  assert.equal(
    callRateHref({ basePath: "/admin/reps-list", query: undefined }),
    "/admin/reps-list?tab=call-rate",
    "a bare /admin/reps-plans lands on the Call rate tab, not the contact list",
  );
  assert.equal(
    callRateHref({
      basePath: "/employee-portals/reps-list",
      query: { line: "pedia", month: "2026-08", period: "w2", region: "delta", rep: "crm:12" },
    }),
    "/employee-portals/reps-list?tab=call-rate&month=2026-08&period=w2&line=pedia&region=delta&rep=crm%3A12",
    "every filter the old link carried is carried — the same board, the same window, the same rep",
  );
  assert.equal(
    callRateHref({ basePath: "/admin/reps-list", query: { month: "2026-08", rep: "crm:12" }, rep: "crm:12" }),
    "/admin/reps-list/call-rate/crm%3A12?month=2026-08",
    "an old drill-down lands on the new drill-down for the same rep, and the path carries the rep rather than the query",
  );
  assert.equal(
    callRateHref({ basePath: "/admin/reps-list", query: undefined, rep: "crm%3A12" }),
    "/admin/reps-list/call-rate/crm%3A12",
    "a segment that arrived still encoded is not encoded twice",
  );
  assert.equal(
    callRateHref({ basePath: "/employee-portals/reps-list", query: undefined, rep: "name:Aya Samir" }),
    "/employee-portals/reps-list/call-rate/name%3AAya%20Samir",
    "a name key is encoded once",
  );
  assert.equal(
    callRateHref({ basePath: "/admin/reps-list", query: undefined, rep: "100%" }),
    "/admin/reps-list/call-rate/100%25",
    "a malformed escape does not throw — it forwards, and the drill-down answers that nobody holds the key",
  );

  const stubs = [
    "app/(admin)/admin/reps-plans/page.tsx",
    "app/(admin)/admin/reps-plans/[rep]/page.tsx",
    "app/employee-portals/reps-plans/page.tsx",
    "app/employee-portals/reps-plans/[rep]/page.tsx",
  ];
  for (const file of stubs) {
    const source = readFileSync(file, "utf8");
    assert.ok(source.includes("redirect(callRateHref("), `${file} forwards to the Reps List Call rate tab`);
    assert.ok(
      !source.includes("buildRepsPlansBoard") && !source.includes("RepVisitsPageBody"),
      `${file} renders nothing of its own — a second live copy of the board is the module the owner merged away`,
    );
  }

  // ── 3. Nothing is duplicated ────────────────────────────────────────────────────────────────
  const loader = readFileSync("src/lib/crm/reps-list-call-rate.ts", "utf8");
  assert.ok(loader.includes("buildRepsPlansBoard("), "the tab is the call-rate board, assembled once for both shells");
  assert.ok(
    !loader.includes("getRepsWeeklyPlansBoard") && !loader.includes("reps-weekly-plans"),
    "and it carries none of the weekly plans — the owner: \"make sure you're not duplicating data\"; plans are read on the plans tab",
  );

  const pages = ["app/(admin)/admin/reps-list/page.tsx", "app/employee-portals/reps-list/page.tsx"];
  for (const file of pages) {
    const source = readFileSync(file, "utf8");
    assert.ok(source.includes("getRepsListCallRate("), `${file} reads the tab through the one shared loader`);
    assert.ok(
      !source.includes("loadCallRateReport"),
      `${file} must not fetch the visits itself — two fetches are how the two shells drift`,
    );
    // ── 4. The gate ──
    assert.ok(
      source.includes("const canSeeCallRate = canAccessRepsPlans(access);"),
      `${file} gates the tab on the Reps Plans roles, which are narrower than Reps List's`,
    );
    assert.ok(
      source.includes("resolveRepsListTab(params?.tab, canSeePlans, canSeeCallRate)"),
      `${file} resolves ?tab=call-rate THROUGH that gate, so a seat without it lands on the contact list`,
    );
  }

  const tabs = readFileSync("src/components/crm/reps-list-tabs.tsx", "utf8");
  assert.ok(
    tabs.includes('if (canSeeCallRate) tabs.push({ key: "call-rate", label: "Call rate" });'),
    "the strip offers the Call rate tab only to a viewer who may open it",
  );
  assert.ok(
    tabs.includes('if (value === CALL_RATE_TAB && canSeeCallRate) return "call-rate";'),
    "and a hand-typed ?tab=call-rate resolves through the same gate",
  );
  assert.ok(
    tabs.includes('input.tab !== "call-rate"'),
    "the area is not carried INTO the Call rate tab — that board has no area picker to show it in, so it would filter invisibly",
  );

  for (const file of [
    "app/(admin)/admin/reps-list/call-rate/[rep]/page.tsx",
    "app/employee-portals/reps-list/call-rate/[rep]/page.tsx",
  ]) {
    const source = readFileSync(file, "utf8");
    assert.ok(
      source.includes("canAccessDoctorList(access)") && source.includes("canAccessRepsPlans(access)"),
      `${file} is its own request, so it re-runs both gates rather than trusting the board that linked to it`,
    );
    assert.ok(source.includes('canAccess(access, "crm_visits", "read")'), `${file} checks the permission matrix too`);
    assert.ok(source.includes("RepVisitsPageBody"), `${file} renders the one shared drill-down body`);
  }

  // The board's own controls write the tab back, or the first click on a filter drops the viewer on
  // the contact list.
  const tables = readFileSync("src/components/crm/reps-plans-tables.tsx", "utf8");
  assert.ok(tables.includes('params.set("tab", CALL_RATE_TAB)'), "the board's filters keep the viewer on the Call rate tab");
  assert.ok(
    tables.includes("`${basePath}/${CALL_RATE_TAB}/${encodeURIComponent(row.repKey)}"),
    "a row opens the drill-down under Reps List",
  );
  const visits = readFileSync("src/components/crm/rep-visits-page.tsx", "utf8");
  assert.ok(visits.includes("tab: CALL_RATE_TAB"), "the drill-down's back link returns to the Call rate tab");
}
