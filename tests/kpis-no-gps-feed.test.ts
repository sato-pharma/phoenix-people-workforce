import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { computeCallRate, type VisitForCallRate } from "../src/lib/crm/call-rate.ts";
import type { CheckinForMatch } from "../src/lib/crm/checkin-match.ts";
import { kpiIndexOf } from "../src/lib/crm/kpi-index.ts";
import {
  applyPhoenixKpis,
  buildKpiPodium,
  joinKpiRows,
  sumKpiTeamTotals,
  type KpiRepRow,
} from "../src/lib/crm/kpis-board.ts";
import { amBandOf, applyKpiFilters, EMPTY_KPI_FILTERS, kpiFlagsOf, pmBandOf } from "../src/lib/crm/kpis-filters.ts";
import type { PhoenixRepKpis } from "../src/lib/crm/phoenix-kpi-rules.ts";

// OWNER'S RULING A1, 2026-09-21: "use A1 no GPS feed for reps without check-ins" — shipped on the Reps
// List Call rate tab (#4173) — and then "apply A1 to the KPIs board too".
//
// Before the CRM cutover the KPIs board scores AM, PM and pharmacy on GPS-PROVED calls only, so a rep
// whose account sent no check-in at all read a red 0% of target however much he worked, sat on the
// podium's "0%" places, and dragged the team's call rate down with his working days. The ruling, on
// this board: his row reads "No GPS feed", his proved rates and attainment are blank, his calls and
// his days leave the team's call-rate sums — and coverage and frequency, which never read GPS, keep
// scoring him.
//
// The rule is `hasNoGpsFeed` from crm/call-rate.ts, the same one Reps List uses, so its narrowness
// carries over and is pinned again here: a LIVE feed that proves nothing keeps its real 0%.

// 2026-08-01 is a Saturday, so 1–5 August is five Sat–Wed working days.
const WINDOW = { dateFrom: "2026-08-01", dateTo: "2026-08-05" };
const COMPANY = { kind: "company", basis: "company", label: "test" } as const;

function visit(crmId: number, contact: number, overrides: Partial<VisitForCallRate> = {}): VisitForCallRate {
  return {
    agent_crm_id: crmId,
    agent_hr_id: `AI-000${crmId}`,
    agent_name: `Rep ${crmId}`,
    ampm: "PM",
    comment: null,
    contact_crm_id: contact,
    crm_save_date: "2026-08-02T11:00:00",
    speciality: null,
    visit_date: "2026-08-02",
    visit_type: 0,
    visit_type_description: "Regular Visit",
    ...overrides,
  };
}

function checkin(crmId: number, contact: number, overrides: Partial<CheckinForMatch> = {}): CheckinForMatch {
  return { agent_crm_id: crmId, contact_crm_id: contact, check_date: "2026-08-02T10:55:00", ...overrides };
}

const range = (from: number, count: number) => Array.from({ length: count }, (_, index) => from + index);

// Rep 1 — five proved PM visits.
// Rep 2 — ten PM and two AM visits and NO check-in at all: the ruling's case.
// Rep 3 — four PM visits and a LIVE feed that proves none of them.
// Rep 4 — campaign calls only.
// Rep 5 — three PM visits and one contact-less check-in: the feed exists.
const VISITS: VisitForCallRate[] = [
  ...range(101, 5).map((contact) => visit(1, contact)),
  ...range(201, 10).map((contact) => visit(2, contact)),
  ...range(221, 2).map((contact) => visit(2, contact, { ampm: "AM" })),
  ...range(301, 4).map((contact) => visit(3, contact)),
  ...range(1, 4).map(() => visit(4, 0, { visit_type: -8, visit_type_description: "Campaign (Prospection)" })),
  ...range(501, 3).map((contact) => visit(5, contact)),
];
const CHECKINS: CheckinForMatch[] = [
  ...range(101, 5).map((contact) => checkin(1, contact)),
  checkin(3, 999),
  checkin(3, 998, { check_date: "2026-08-03T09:00:00" }),
  checkin(5, 0),
];

function rowsFor(basis: "verified" | "submitted"): KpiRepRow[] {
  const report = computeCallRate(VISITS, CHECKINS, { ...WINDOW, basis });
  assert.equal(report.basis, basis);
  return joinKpiRows({
    callRates: report.reps,
    docLists: [],
    scope: COMPANY,
    workingDays: report.workingDays,
    amTarget: 2,
    pmTarget: 10,
    basis: report.basis,
  });
}

function rowOf(rows: readonly KpiRepRow[], crmId: number): KpiRepRow {
  const found = rows.find((row) => row.agentCrmId === crmId);
  assert.ok(found, `rep ${crmId} is on the board`);
  return found;
}

export function runKpisNoGpsFeedTests() {
  const rows = rowsFor("verified");
  assert.equal(rows.length, 5, "every rep is LISTED — the ruling marks a row, it never drops one");

  // ── 1. The flagged row: no proved rate, no attainment, reported calls kept ─────────────────────
  const flagged = rowOf(rows, 2);
  assert.equal(flagged.noGpsFeed, true, "real visits and no check-in at all is the ruling's case");
  assert.equal(flagged.hasCallRate, true, "he DID log calls — he is not the 'logged nothing' row");
  assert.equal(flagged.amRate, null, "no proved AM rate — not 0.00 against a target he had no means to beat");
  assert.equal(flagged.pmRate, null);
  assert.equal(flagged.pharmacyRate, null);
  assert.equal(flagged.amAttainmentPct, null, "and no % of target, so no red 0%");
  assert.equal(flagged.pmAttainmentPct, null);
  assert.equal(flagged.amReported, 2, "every call he reported stays on his row");
  assert.equal(flagged.pmReported, 10);
  assert.equal(flagged.pmReportedRate, 2, "ten PM calls over five working days");
  assert.equal(flagged.amReportedRate, 0.4);
  assert.equal(amBandOf(flagged), "noplan", "AM reads 'Not measurable', never 'Behind'");
  assert.equal(pmBandOf(flagged), "noplan");
  const flags = kpiFlagsOf(flagged);
  assert.ok(flags.includes("no-gps-feed"), "the row carries the No GPS feed marker");
  assert.ok(!flags.includes("no-calls"), "and not 'Logged no calls at all', which would be false");
  assert.deepEqual(
    applyKpiFilters(rows, { ...EMPTY_KPI_FILTERS, flags: ["no-gps-feed"] }).map((row) => row.agentCrmId),
    [2],
    "a manager can filter the board to exactly the phones to chase",
  );

  // His overall KPI leaves AM and PM out for the RIGHT reason.
  const index = kpiIndexOf({ ...flagged });
  const am = index.components.find((component) => component.key === "am");
  assert.equal(am?.excludedBecause, "no GPS feed", "the overall line says why, not 'no working days'");

  // ── 2. The narrowness — the same rule as Reps List ─────────────────────────────────────────────
  const liveButUnproved = rowOf(rows, 3);
  assert.equal(liveButUnproved.noGpsFeed, false, "a LIVE feed that proves nothing is a finding, not an excuse");
  assert.equal(liveButUnproved.pmRate, 0);
  assert.equal(liveButUnproved.pmAttainmentPct, 0, "and keeps its real 0%");
  assert.equal(rowOf(rows, 4).noGpsFeed, false, "campaign calls only: nothing a feed could have proved");
  assert.equal(rowOf(rows, 5).noGpsFeed, false, "a contact-less check-in means the feed exists");
  assert.equal(rowOf(rows, 1).noGpsFeed, false);
  assert.equal(rowOf(rows, 1).pmAttainmentPct, 10, "five proved PM calls of the fifty asked for");

  // ── 3. The podium never puts him on a "0%" place ───────────────────────────────────────────────
  // Rep 1 leads PM at 10%; the rest are at 0% and tie-break by name. With him in, "Rep 2" would take
  // second place on BOTH call-rate boards on the strength of a feed that failed.
  const podium = buildKpiPodium(rows);
  assert.deepEqual(
    podium.pmCallRate.map((entry) => entry.repName),
    ["Rep 1", "Rep 3", "Rep 4"],
    "the PM board skips the rep with no GPS feed",
  );
  assert.deepEqual(podium.amCallRate.map((entry) => entry.repName), ["Rep 1", "Rep 3", "Rep 4"]);
  assert.ok(!podium.pharmacyCallRate.some((entry) => entry.repName === "Rep 2"));

  // ── 4. The team sums: his calls and his days leave the call rate TOGETHER ──────────────────────
  const totals = sumKpiTeamTotals(rows);
  assert.equal(totals.reps, 5, "he is still a rep in reach — the head count and coverage keep him");
  assert.equal(totals.repWorkingDays, 4 * 5, "the call-rate denominator is the other four reps' days");
  assert.equal(totals.pmVerified, 5);
  assert.equal(totals.pmReported, 5 + 4 + 4 + 3, "his ten reported PM calls leave with his days, not half in");
  assert.equal(totals.amReported, 0, "and his two AM calls too");
  assert.equal(totals.pmVerified / totals.repWorkingDays, 0.25, "5 proved over 20 rep-days — with him in, 0.20");
  assert.equal(totals.totalCalls, 5 + 12 + 4 + 4 + 3, "the raw count of calls logged is not a rate, and keeps him");

  // ── 5. From the CRM cutover nobody is marked ───────────────────────────────────────────────────
  const submitted = rowsFor("submitted");
  const submittedRow = rowOf(submitted, 2);
  assert.equal(submittedRow.noGpsFeed, false, "under the submitted basis GPS decides nothing");
  assert.equal(submittedRow.pmRate, 2, "every submitted regular visit counts: ten over five days");
  assert.equal(sumKpiTeamTotals(submitted).repWorkingDays, 5 * 5, "and everyone is in the team figures");

  // The Phoenix restamp clears the flag, so a row scored by those rules is never excused by it.
  const phoenix: PhoenixRepKpis = {
    workingDays: 5,
    am: { visits: 2, rate: 0.4, target: 2, meets: false, attainmentPct: 20 },
    pm: { visits: 10, rate: 2, target: 10, meets: false, attainmentPct: 20 },
    pharmacy: { visits: 0, rate: 0, target: null, meets: null, attainmentPct: null },
    campaignVisits: 0,
    regularNoCheckin: 0,
    coverage: { planned: 0, visited: 0, missed: 0, pct: null, plannedOffList: 0 },
    frequency: { judged: 0, met: 0, below: 0, ungraded: 0, pct: null },
    followUp: null,
  };
  const restamped = applyPhoenixKpis({ ...flagged }, phoenix);
  assert.equal(restamped.noGpsFeed, false, "the Phoenix rules never carry the pre-cutover marker");

  // ── 6. The screens say it ──────────────────────────────────────────────────────────────────────
  const view = readFileSync("src/components/crm/kpis-board-view.tsx", "utf8");
  assert.ok(view.includes('const NO_GPS_FEED = "No GPS feed";'), "one wording for every cell and card");
  assert.ok(view.includes("if (row.noGpsFeed) return NO_GPS_FEED;"), "the AM, PM and pharmacy figures print the marker");
  assert.ok(view.includes("board.noGpsFeedShown > 0"), "the banner above the tiles says how many are left out, and why");
  const board = readFileSync("src/lib/crm/kpis-board.ts", "utf8");
  assert.ok(
    board.includes('basis: callRate.basis ?? "verified",'),
    "the live board hands the join the report's own basis, so the cutover switches the rule off",
  );
  const portalSnapshot = readFileSync("src/lib/employee-portal/home-snapshot.ts", "utf8");
  assert.ok(portalSnapshot.includes("noGpsFeed: row.noGpsFeed,"), "the rep's own home tile reads the same flag");
  const portal = readFileSync("src/components/employee-portal/portal-command-center.tsx", "utf8");
  assert.ok(portal.includes("kpis?.noGpsFeed ? ("), "and says No GPS feed rather than drawing three 0.00s");
}
