import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import { lastVisitAndTotalText, plannerRowInsight, totalVisitsText, visitTallyText } from "../src/components/phoenix-crm/labels.ts";
import type { PlanEntryRow } from "../src/lib/crm/plan-board.ts";
import { buildPlanDoctorDays } from "../src/lib/crm/plan-doctors.ts";
import {
  contactTalliesRecord,
  emptyVisitTallies,
  foldVisitTallies,
  mergeVisitTallies,
  NO_VISITS,
  talliesRecord,
  tallyForContact,
  tallyForCustomer,
} from "../src/lib/phoenix-crm/visit-tally.ts";

/**
 * The visit tally on every screen that shows a rep's weekly plan (owner, 19 Nov 2026: "in every screen that shows
 * the reps weekly plan must show this dr when was the last visit and the count of his visits in this month and total
 * count of visits to this dr").
 *
 * Five screens: the rep's own planner (and the manager reviewing it), the Reps List's plan tab, Plan Verification,
 * the district manager's plan board and the daily plan report. One database function counts, one pure module folds,
 * one sentence words it — and a failed read draws NOTHING, never "No visit recorded yet" about a doctor who was seen.
 */

function source(path: string): string {
  return stripComments(readFileSync(path, "utf8"));
}

function entry(overrides: Partial<PlanEntryRow>): PlanEntryRow {
  return {
    address: null,
    ampm: "AM",
    contactCrmId: null,
    contactName: "Dr Test",
    frequency: null,
    grade: "A",
    onRepList: false,
    planDate: "2026-11-17",
    region: null,
    speciality: null,
    ...overrides,
  } as PlanEntryRow;
}

export function runPhoenixCrmVisitTallyTests() {
  // ── 1. THE FOLD: one row per (seat, customer), merged per doctor ─────────────────────────────────
  {
    const tallies = foldVisitTallies([
      { seat_id: "s1", customer_id: "c1", contact_crm_id: 501, last_visit_on: "2026-11-10", month_visits: 1, total_visits: 9 },
      // The same customer met again on a second territory: the later day wins, the counts add.
      { seat_id: "s2", customer_id: "c1", contact_crm_id: 501, last_visit_on: "2026-11-17", month_visits: 2, total_visits: 5 },
      // A second customer sharing that contact merges into the contact's tally only.
      { seat_id: "s1", customer_id: "c2", contact_crm_id: "501", last_visit_on: "2026-10-02", month_visits: 0, total_visits: 1 },
      // No customer id: skipped. No contact id: kept by customer only.
      { seat_id: "s1", customer_id: null, contact_crm_id: 777, last_visit_on: "2026-11-01", month_visits: 1, total_visits: 1 },
      { seat_id: "s1", customer_id: "c3", contact_crm_id: null, last_visit_on: "2026-09-01T00:00:00", month_visits: "0", total_visits: "4" },
    ]);
    assert.equal(tallies.read, true);
    assert.deepEqual(tallies.byCustomer.get("c1"), { lastVisitOn: "2026-11-17", thisMonth: 3, total: 14 }, "one customer on two territories is one tally");
    assert.deepEqual(tallies.byContact.get(501), { lastVisitOn: "2026-11-17", thisMonth: 3, total: 15 }, "a contact sums every customer carrying it");
    assert.deepEqual(tallies.byCustomer.get("c3"), { lastVisitOn: "2026-09-01", thisMonth: 0, total: 4 }, "a timestamp is cut to its day; text counts are numbers");
    assert.equal(tallies.byContact.has(777), false, "a row with no customer is never counted");
    assert.deepEqual(mergeVisitTallies({ lastVisitOn: null, thisMonth: 0, total: 0 }, { lastVisitOn: "2026-11-01", thisMonth: 1, total: 1 }).lastVisitOn, "2026-11-01");

    // Read, and nobody visited him: NO_VISITS. The read failed: null — the screen draws nothing.
    assert.equal(tallyForCustomer(tallies, "c9"), NO_VISITS);
    assert.equal(tallyForCustomer(emptyVisitTallies(false), "c1"), null, "a failed read is null, never a zero");
    assert.equal(tallyForCustomer(tallies, null), null, "a row naming no customer is never said to have no visits");
    assert.equal(tallyForContact(tallies, 999), NO_VISITS);
    assert.equal(tallyForContact(tallies, null), null, "a row naming no contact is never said to have no visits");
    assert.equal(tallyForContact(emptyVisitTallies(false), 501), null);
    assert.deepEqual(contactTalliesRecord(tallies, [501, 999, null]), { "501": tallies.byContact.get(501), "999": NO_VISITS });
    assert.equal(contactTalliesRecord(emptyVisitTallies(false), [501]), null, "Plan Verification gets no record at all from a failed read");
    assert.deepEqual(talliesRecord(emptyVisitTallies(false), ["c1"]), {});
  }

  // ── 2. THE WORDS: last visit · this month · in total ──────────────────────────────────────────────
  {
    const tally = { lastVisitOn: "2026-11-17", thisMonth: 2, total: 14 };
    assert.equal(visitTallyText(tally, "2026-11-19"), "Last visit Tue 17 Nov · 2 visits this month · 14 visits in total");
    assert.equal(visitTallyText({ lastVisitOn: "2025-12-30", thisMonth: 0, total: 1 }, "2026-11-19"), "Last visit Tue 30 Dec 2025 · 0 visits this month · 1 visit in total", "last year's visit carries its year");
    assert.equal(visitTallyText(NO_VISITS, "2026-11-19"), "No visit recorded yet");
    assert.equal(lastVisitAndTotalText(tally, "2026-11-19"), "Last visit Tue 17 Nov · 14 visits in total", "the manager's board words no month — its pips are the month");
    assert.equal(lastVisitAndTotalText(NO_VISITS, "2026-11-19"), "No visit recorded yet");
    assert.equal(totalVisitsText(1), "1 visit in total");

    // The planner row: the rep's own insight speaks first; a reviewer reads none, and the tally gives the day.
    const context = { target: 3, today: "2026-11-19", weekStart: "2026-11-21" };
    const reviewer = plannerRowInsight({ insight: null, pending: false, places: [], visitsThisMonth: 2, tally } as never, context);
    assert.equal(reviewer.lastSeen, "Last seen Tue 17 Nov · 2 of 3 visits this month · 14 visits in total", "the manager reviewing the plan sees the same line");
    const failed = plannerRowInsight({ insight: null, pending: false, places: [], visitsThisMonth: 2, tally: null } as never, context);
    assert.equal(failed.lastSeen, null, "no insight and no tally: nothing is said");
  }

  // ── 3. THE REPS LIST'S PLAN TAB: each row carries its doctor's tally by contact ───────────────────
  {
    const tallies = foldVisitTallies([{ seat_id: "s1", customer_id: "c1", contact_crm_id: 501, last_visit_on: "2026-11-17", month_visits: 2, total_visits: 14 }]);
    const [day] = buildPlanDoctorDays([entry({ contactCrmId: 501 }), entry({ contactCrmId: 502, contactName: "Dr Other" })], new Map(), null, tallies);
    assert.deepEqual(
      day.rows.map((row) => [row.entry.contactCrmId, row.tally]),
      // AM, then by name: "Dr Other" before "Dr Test".
      [
        [502, NO_VISITS],
        [501, { lastVisitOn: "2026-11-17", thisMonth: 2, total: 14 }],
      ],
    );
    const [oldCrm] = buildPlanDoctorDays([entry({ contactCrmId: 501 })], new Map());
    assert.equal(oldCrm.rows[0].tally, null, "an old-CRM plan (no seat) draws no line");
  }

  // ── 4. THE DATABASE FUNCTION: the planner's own visits view, read-only, service role only ─────────
  {
    const sql = readFileSync("supabase/migrations/20261119152938_phoenix_crm_customer_visit_tally.sql", "utf8");
    assert.match(sql, /from public\.phoenix_crm_countable_visits_with_history v/, "the same view the planner's visits this month reads");
    assert.match(sql, /count\(\*\) filter \(where v\.visit_date >= p_month_start\)/);
    assert.match(sql, /v\.visit_date <= p_through/, "never a visit after today");
    assert.match(sql, /revoke execute on function public\.phoenix_crm_customer_visit_tally\(text\[\], boolean, date, date\) from public, anon, authenticated;/);
    assert.match(sql, /grant execute on function public\.phoenix_crm_customer_visit_tally\(text\[\], boolean, date, date\) to service_role;/);
    assert.match(
      sql.replace(/\r\n/g, "\n"),
      /\nstable\nsecurity definer\nset search_path to 'public'\nas \$\$/,
      "Phoenix CRM's function shape: read-only, owner's rights, a fixed search path",
    );

    const reader = source("src/lib/phoenix-crm/server/visit-tally.ts");
    assert.match(reader, /\.rpc\("phoenix_crm_customer_visit_tally"/);
    assert.match(reader, /fetchAllRows/, "paged, so a read across many territories never stops at a ceiling");
    assert.match(reader, /catch \(error\)[\s\S]*return emptyVisitTallies\(false\)/, "a failed read answers read: false, never throws");
  }

  // ── 5. EVERY SCREEN THAT SHOWS A REP'S WEEKLY PLAN reads it AND draws it ─────────────────────────
  {
    const READERS: Array<[string, RegExp]> = [
      ["src/lib/phoenix-crm/server/plans.ts", /loadVisitTallies\(\[seat\.seatId\], isTest, today\)/],
      ["src/lib/phoenix-crm/server/monthly-plans.ts", /loadVisitTallies\(\[seat\.seatId\], isTest, today\)/],
      ["src/lib/crm/reps-weekly-plans-board.ts", /loadVisitTallies\(\[selectedPlan\.phoenixSeatId\], false, todayIso\)/],
      ["src/lib/crm/plan-board.ts", /loadVisitTallies\(\[plan\.phoenixSeatId\], false, today\)/],
      ["src/lib/phoenix-crm/server/manager-customer-marks.ts", /loadVisitTallies\(seatIds, isTest, viewer\.cairoToday\)/],
      ["src/lib/phoenix-crm/server/daily-plan-report.ts", /loadVisitTallies\(\[seat\.seatId\], world\.isTest, viewer\.cairoToday\)/],
    ];
    for (const [file, call] of READERS) assert.match(source(file), call, `${file} reads the visit tally`);

    const DRAWERS: Array<[string, RegExp]> = [
      ["src/components/phoenix-crm/plan-day-panel.tsx", /<PlannedSeenLine\b/],
      ["src/components/crm/reps-list-tables.tsx", /<VisitTallyLine row=\{row\} today=\{today\} \/>/],
      ["src/components/crm/plan-verification-tables.tsx", /<PlanVisitLine row=\{row\} visits=\{visits\} \/>/],
      ["src/components/phoenix-crm/manager-customer-marks.tsx", /lastVisitAndTotalText\(insight\.tally, today\)/],
      ["src/components/phoenix-crm/daily-plan-report.tsx", /<TallyLine customer=\{customer\} today=\{today\} \/>/],
    ];
    for (const [file, draw] of DRAWERS) assert.match(source(file), draw, `${file} draws the visit line`);

    // Each drawer says nothing when the read failed.
    assert.match(source("src/components/crm/reps-list-tables.tsx"), /if \(!row\.tally\) return null;/);
    assert.match(source("src/components/phoenix-crm/daily-plan-report.tsx"), /if \(!customer\.tally\) return null;/);
    assert.match(source("src/components/crm/plan-verification-tables.tsx"), /if \(!visits \|\| !tally\) return null;/);

    // The Reps List board carries Cairo today from the server, never a browser clock.
    assert.match(source("src/components/crm/reps-weekly-plans-board.tsx"), /<PlanDoctorsTable days=\{board\.days\} today=\{board\.today\} \/>/);
    // The seat the tally is read on is the Phoenix plan's own.
    assert.match(source("src/lib/crm/plan-board.ts"), /seatId: row\.seat_id \? String\(row\.seat_id\) : null/);
  }
}
