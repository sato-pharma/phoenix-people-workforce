import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  computeCallRate,
  hasNoGpsFeed,
  zeroRepCallRate,
  type RepCallRate,
  type VisitForCallRate,
} from "../src/lib/crm/call-rate.ts";
import type { CheckinForMatch } from "../src/lib/crm/checkin-match.ts";
import { buildRepsPlansBoard, toRepsPlansRow } from "../src/lib/crm/reps-plans.ts";

// OWNER'S RULING A1, 2026-09-21: "use A1 no GPS feed for reps without check-ins".
//
// Before the CRM cutover the call rate counts only GPS-PROVED visits. A rep whose account sent no
// check-in at all in the window therefore read a red 0% however much he worked — the board was
// measuring his phone's feed, not him. Measured on production for 1–21 September: 17 accounts with
// real visits and not one check-in. The ruling: show "No GPS feed" instead of 0%, and leave him out
// of the team figures.
//
// What is pinned is the NARROWNESS of the rule as much as the rule, because every widening of it
// hides a real finding:
//   • a rep whose feed is LIVE but whose visits match no check-in keeps his real 0% — that gap is
//     what the board exists to show;
//   • a rep with campaign calls only, or with no visits at all, keeps his zero — no feed could have
//     proved work he did not report;
//   • from the CRM cutover ("submitted" basis) GPS decides nothing, so nobody is excused;
//   • a hand-built report that never counted the feed is never read as "no feed".

// 2026-08-01 is a Saturday, so 1–5 August is five Sat–Wed working days.
const WINDOW = { dateFrom: "2026-08-01", dateTo: "2026-08-05" };
const WORKING_DAYS = 5;

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

// Rep 1 — five proved PM visits: the feed is live and it proves his work.
// Rep 2 — ten PM and two AM visits and NO check-in at all: the case the ruling is about.
// Rep 3 — four PM visits and a LIVE feed that proves none of them (check-ins at other doctors).
// Rep 4 — campaign calls only and no check-in: nothing a feed could have proved.
// Rep 5 — three PM visits and ONE contact-less check-in: the phone reported GPS, so the feed exists
//          even though no visit could match it.
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

function repOf(reps: readonly RepCallRate[], crmId: number): RepCallRate {
  const found = reps.find((rep) => rep.agentCrmId === crmId);
  assert.ok(found, `rep ${crmId} reached the report`);
  return found;
}

export function runRepsPlansNoGpsFeedTests() {
  // ── 1. The feed is counted per rep, and it is the FEED, not the matches ─────────────────────────
  const report = computeCallRate(VISITS, CHECKINS, WINDOW);
  assert.equal(report.basis, "verified", "no cutover: the proved rule is in force, which is when A1 applies");
  assert.equal(repOf(report.reps, 1).gpsCheckins, 5);
  assert.equal(repOf(report.reps, 2).gpsCheckins, 0, "a rep whose account sent nothing counts zero check-ins");
  assert.equal(
    repOf(report.reps, 3).gpsCheckins,
    2,
    "a check-in at a doctor he never visited is still his feed — it counts though it proves nothing",
  );
  assert.equal(
    repOf(report.reps, 5).gpsCheckins,
    1,
    "a contact-less check-in counts too: the match index skips it, but the phone was reporting GPS",
  );

  // ── 2. Who is "no GPS feed", and who is not ─────────────────────────────────────────────────────
  assert.equal(hasNoGpsFeed(repOf(report.reps, 2)), true, "real visits and no check-in at all IS the ruling's case");
  assert.equal(hasNoGpsFeed(repOf(report.reps, 1)), false, "a proved rep is not");
  assert.equal(
    hasNoGpsFeed(repOf(report.reps, 3)),
    false,
    "a LIVE feed that proves none of his visits keeps his real 0% — that gap is what the board exists to show",
  );
  assert.equal(hasNoGpsFeed(repOf(report.reps, 4)), false, "campaign calls only: no feed could have proved them");
  assert.equal(hasNoGpsFeed(repOf(report.reps, 5)), false, "a contact-less check-in means the feed exists");
  assert.equal(
    hasNoGpsFeed(repOf(report.reps, 2), "submitted"),
    false,
    "from the CRM cutover GPS is evidence only, so a missing feed costs him nothing and excuses nothing",
  );
  const handBuilt: RepCallRate = { ...repOf(report.reps, 2) };
  delete handBuilt.gpsCheckins;
  assert.equal(hasNoGpsFeed(handBuilt), false, "a report that never counted the feed is never read as having none");

  const silent = zeroRepCallRate(WORKING_DAYS, { agentHrId: "ai-0009" });
  assert.equal(silent.gpsCheckins, 0);
  assert.equal(hasNoGpsFeed(silent), false, "the rep with no visits at all keeps his zero — he is not excused by it");
  const silentRow = toRepsPlansRow(silent);
  assert.equal(silentRow.noGpsFeed, false);
  assert.equal(silentRow.pm.verifiedRate, 0, "the silent roster row still reads 0.00, a measurement, not a blank");

  // Visits on a Thursday are outside every slice, so they are not work a feed could have proved.
  const thursdayOnly = computeCallRate([visit(6, 601, { visit_date: "2026-08-06" })], [], {
    dateFrom: "2026-08-01",
    dateTo: "2026-08-07",
  });
  assert.equal(hasNoGpsFeed(repOf(thursdayOnly.reps, 6)), false, "a Thursday-only rep has no scored visit to excuse");

  // ── 3. The board: the row reads "No GPS feed", the tiles leave him out ──────────────────────────
  // No organogram, so everyone on the feed is scored — the plainest board to count tiles on.
  const board = buildRepsPlansBoard(report, { isCurrentMonth: false, month: "2026-08" });
  const rowOf = (crmId: number) => {
    const row = board.reps.find((candidate) => candidate.agentCrmId === crmId);
    assert.ok(row, `rep ${crmId} is on the board`);
    return row;
  };

  const flagged = rowOf(2);
  assert.equal(flagged.noGpsFeed, true, "he is LISTED and marked, never dropped");
  assert.equal(flagged.pm.verifiedRate, null, "no proved rate — not 0.00 against a target he had no means to beat");
  assert.equal(flagged.pm.attainmentPct, null, "and no % of target, so no red 0%");
  assert.equal(flagged.am.verifiedRate, null);
  assert.equal(flagged.am.attainmentPct, null);
  assert.equal(flagged.pharmacy.verifiedRate, null);
  assert.equal(flagged.unprovenPct, null, "nor 100% unproven — that is a finding only when something could have proved them");
  assert.equal(flagged.pm.reportedRate, 2, "his REPORTED rate stays: ten PM visits over five working days");
  assert.equal(flagged.am.reportedRate, 0.4, "two AM visits over five working days");
  assert.equal(flagged.reportedCalls, 12, "and every call he reported is still counted on his row");

  const liveButUnproved = rowOf(3);
  assert.equal(liveButUnproved.noGpsFeed, false);
  assert.equal(liveButUnproved.pm.verifiedRate, 0, "a live feed that proves nothing reads its real 0.00");
  assert.equal(liveButUnproved.pm.attainmentPct, 0, "and its real 0%");
  assert.equal(liveButUnproved.unprovenPct, 100);

  assert.equal(board.noGpsFeedShown, 1, "the board counts the rows it marked, so the screen can say why the tiles cover fewer");
  assert.equal(board.totals.reps, 4, "four of the five reps are in the tiles — the one with no GPS feed is not");
  assert.equal(board.totals.pm.verified, 5, "the team's proved PM calls are rep 1's five");
  assert.equal(
    board.totals.pm.reported,
    5 + 4 + 4 + 3,
    "the team's reported PM calls leave out his ten: he is out of the team figures, not half in them",
  );
  assert.equal(
    board.totals.pm.verifiedRate,
    0.25,
    "5 proved PM calls over 5 days x 4 reps — with him in, the same team would read 0.20",
  );

  // Opening him alone keeps the tiles on the team, exactly as for any other rep.
  const opened = buildRepsPlansBoard(report, { isCurrentMonth: false, month: "2026-08", repKey: "crm:2" });
  assert.equal(opened.reps.length, 1);
  assert.equal(opened.reps[0]?.noGpsFeed, true, "the drill-down's row is the board's row, marked the same way");
  assert.equal(opened.totals.reps, 4);

  // From the cutover nobody is marked and everyone is counted.
  const submitted = buildRepsPlansBoard(computeCallRate(VISITS, CHECKINS, { ...WINDOW, basis: "submitted" }), {
    isCurrentMonth: false,
    month: "2026-08",
  });
  assert.equal(submitted.noGpsFeedShown, 0, "under the submitted basis the marker never appears");
  assert.equal(submitted.totals.reps, 5);
  const submittedRow = submitted.reps.find((row) => row.agentCrmId === 2);
  assert.equal(submittedRow?.noGpsFeed, false);
  assert.equal(submittedRow?.pm.verifiedRate, 2, "every submitted regular visit counts: ten over five days");

  // ── 4. The screen says it, in one wording, and the export carries it ────────────────────────────
  const tables = readFileSync("src/components/crm/reps-plans-tables.tsx", "utf8");
  assert.ok(tables.includes('const NO_GPS_FEED = "No GPS feed";'), "one wording for the cell, the card, the search and the export");
  assert.ok(tables.includes("{row.noGpsFeed ? ("), "the desktop Rep cell and the card render the marker");
  assert.ok(
    tables.includes('{ key: "gps_feed", label: "GPS Feed" }') && tables.includes("gps_feed: row.noGpsFeed ? NO_GPS_FEED"),
    "the export must match the screen — a blank proved rate in the file carries the same reason",
  );
  assert.ok(
    tables.includes('row.noGpsFeed ? "no GPS feed"'),
    "the phone card's meta line says no GPS feed rather than '0 proved'",
  );
  const boardView = readFileSync("src/components/crm/reps-plans-board.tsx", "utf8");
  assert.ok(boardView.includes("board.noGpsFeedShown > 0"), "the note above the tiles states how many are left out, and why");
  const drilldown = readFileSync("src/components/crm/rep-visits-page.tsx", "utf8");
  assert.ok(drilldown.includes("row.noGpsFeed ? ("), "the drill-down header carries the same marker as the board");
}
