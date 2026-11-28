import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments, stripSqlComments } from "./support/comment-strip.ts";

import { fieldWeekStart } from "../src/lib/phoenix-crm/calendar.ts";
import {
  FOCUS_NO_BRICK,
  FOCUS_NO_GRADE,
  FOCUS_PERIOD_MAX_DAYS,
  FOCUS_REASON_PICKS,
  focusPeriodWeeks,
  focusReasonPickLabel,
  focusStandingText,
  focusVisitKindLabel,
  focusWeekCounts,
  focusWeeklyAverage,
  groupFocusEntries,
  readFocusPeriod,
  readFocusReason,
  readFocusReasonPick,
} from "../src/lib/phoenix-crm/focus-list-rules.ts";
import { buildOrgIndex, type OrgSeat } from "../src/lib/phoenix-crm/scope.ts";
import { focusListDeliveries, type FocusListNotice } from "../src/lib/phoenix-crm/server/notifications.ts";

/**
 * Phoenix CRM — the Focus list (owner, 2026-11-28): "every medical rep … an empty tab called Focus list … the rep
 * must say why … grouped by grade, grouped by brick … the district manager … keep him or return him … tracks the
 * frequency of visits … a manager can also choose from the rep list and push him."
 *
 *   1. The reason is written and required; the pick beside it is optional, and anything unknown is no pick.
 *   2. The period is the manager's From–To, never a future day, never over a year; the weeks are field weeks.
 *   3. Grouped by grade, then brick, with the two "not known" groups last.
 *   4. Who is told: a rep's push waits for his reviewing manager (SFE on a vacant chain); a manager's push, keep
 *      and return tell the rep; the rep's own return tells his manager; nobody is told of his own step; and the
 *      rep's copy never names a visit or a count (Golden rule #1).
 *   5. The table is the service role's alone, the read function too, and a customer has one open row at most.
 *   6. The rep's own view never carries the tracking.
 */

function seat(overrides: Partial<OrgSeat> & Pick<OrgSeat, "seatId" | "tier" | "path">): OrgSeat {
  return {
    parentSeatId: overrides.path.length > 1 ? overrides.path[overrides.path.length - 2] : null,
    occupantHrId: null,
    lineCode: "pedia",
    lineName: "Pedia",
    areaName: null,
    regionName: null,
    seatLabel: null,
    ...overrides,
  };
}

const DM = seat({ seatId: "SEAT-DM", tier: "DM", path: ["SEAT-DM"], occupantHrId: "PD-0100" });
const REP = seat({ seatId: "SEAT-REP", tier: "REP", path: ["SEAT-DM", "SEAT-REP"], occupantHrId: "PD-0200", areaName: "Nasr City" });
const VACANT_CHAIN_REP = seat({ seatId: "SEAT-LONE", tier: "REP", path: ["SEAT-LONE"], occupantHrId: "PD-0300", areaName: "Fayoum" });

const names = new Map([
  ["PD-0100", "Mona Adel"],
  ["PD-0200", "Karim Samy"],
  ["PD-0300", "Hady Fathy"],
]);

function notice(overrides: Partial<FocusListNotice>): FocusListNotice {
  return {
    kind: "focus_list",
    step: "pushed",
    org: buildOrgIndex([DM, REP, VACANT_CHAIN_REP]),
    seat: REP,
    focusId: "focus-1",
    customerName: "Dr Salma Nabil",
    actorHrId: "PD-0200",
    actedAs: "rep",
    note: "Writes a competitor's antibiotic every week.",
    ...overrides,
  };
}

export function runPhoenixCrmFocusListTests(): void {
  // ── 1. The reason ──────────────────────────────────────────────────────────────────────────────
  {
    assert.equal(readFocusReason("").ok, false, "a push with no reason is refused");
    assert.equal(readFocusReason("  ok ").ok, false, "two letters are not a reason");
    assert.equal(readFocusReason(null).ok, false);
    assert.deepEqual(readFocusReason("  High   prescriber \n of Amoxil "), { ok: true, reason: "High prescriber of Amoxil" });
    assert.equal(readFocusReason("x".repeat(501)).ok, false, "the table's own check caps it at 500");
    assert.equal(readFocusReasonPick("key_opinion_leader"), "key_opinion_leader");
    assert.equal(readFocusReasonPick("anything else"), null, "an unknown pick is no pick, never a refusal");
    assert.equal(readFocusReasonPick(undefined), null);
    assert.equal(focusReasonPickLabel("competitor_prescriber"), "Writes a competitor");
    assert.equal(focusReasonPickLabel(null), null);
    const sql = stripSqlComments(readFileSync("supabase/migrations/20261128135234_phoenix_crm_focus_list.sql", "utf8"));
    for (const pick of FOCUS_REASON_PICKS) assert.match(sql, new RegExp(`'${pick.value}'`), `the table accepts the pick ${pick.value}`);
    assert.match(sql, /char_length\(btrim\(reason\)\) between 3 and 500/, "and holds the same two bounds as readFocusReason");
  }

  // ── 2. The period and its weeks ────────────────────────────────────────────────────────────────
  {
    const today = "2026-11-28";
    assert.deepEqual(readFocusPeriod(null, null, today), { from: "2026-11-01", to: today }, "no choice: the last four field weeks");
    assert.deepEqual(readFocusPeriod("2026-11-01", "2026-12-15", today), { from: "2026-11-01", to: today }, "never a future day");
    assert.deepEqual(readFocusPeriod("2026-11-20", "2026-11-05", today), { from: "2026-11-05", to: "2026-11-20" }, "a start after the end is swapped");
    const long = readFocusPeriod("2024-01-01", "2026-11-28", today);
    const days = (Date.parse(long.to) - Date.parse(long.from)) / 86_400_000 + 1;
    assert.equal(days, FOCUS_PERIOD_MAX_DAYS, "a span over a year is cut to the year ending on To");
    assert.deepEqual(readFocusPeriod("not a day", "2026-11-10", today), { from: "2026-10-14", to: "2026-11-10" });

    const period = { from: "2026-11-01", to: "2026-11-28" };
    const weeks = focusPeriodWeeks(period);
    assert.equal(weeks[0], fieldWeekStart("2026-11-01"), "the first week is the field week the period starts in");
    assert.ok(weeks.every((week) => fieldWeekStart(week) === week), "every week is a Saturday field-week start");
    assert.equal(weeks[weeks.length - 1], fieldWeekStart("2026-11-28"));
    const counts = focusWeekCounts(["2026-11-02", "2026-11-03", "2026-11-25", "2026-10-30", "2026-11-29"], period);
    assert.equal(counts.length, weeks.length, "every week is listed, a zero included");
    assert.equal(counts.reduce((sum, week) => sum + week.visits, 0), 3, "a visit outside the period is not counted");
    assert.equal(counts.find((week) => week.weekStart === fieldWeekStart("2026-11-02"))?.visits, 2);
    assert.equal(focusWeeklyAverage(3, period), Math.round((3 / weeks.length) * 10) / 10);
    assert.equal(focusWeeklyAverage(0, period), 0);
    assert.equal(focusVisitKindLabel("double"), "Double visit");
    assert.equal(focusVisitKindLabel("something new"), "Visit", "an unknown kind is a visit, never a code");
  }

  // ── 3. Grade, then brick ───────────────────────────────────────────────────────────────────────
  {
    const groups = groupFocusEntries([
      { customerName: "Zeina", grade: "B", brick: "Rehab" },
      { customerName: "Amr", grade: null, brick: "Rehab" },
      { customerName: "Hoda", grade: "A", brick: null },
      { customerName: "Bassem", grade: "A", brick: "Tagamoa" },
      { customerName: "Adel", grade: "A", brick: "Tagamoa" },
    ]);
    assert.deepEqual(
      groups.map((group) => group.grade),
      ["A", "B", FOCUS_NO_GRADE],
      "grades read A, B … with no grade last",
    );
    assert.deepEqual(groups[0].bricks.map((brick) => brick.brick), ["Tagamoa", FOCUS_NO_BRICK], "an unknown brick goes last");
    assert.deepEqual(groups[0].bricks[0].entries.map((entry) => entry.customerName), ["Adel", "Bassem"], "by name inside a brick");
    assert.equal(groups[0].count, 3);
    assert.equal(focusStandingText("waiting", "rep"), "Waiting for your manager");
    assert.equal(focusStandingText("kept", "rep"), "Kept by your manager");
    assert.equal(focusStandingText("kept", "manager"), "Added by your manager");
  }

  // ── 4. Who is told ─────────────────────────────────────────────────────────────────────────────
  {
    const [waiting, ...noMore] = focusListDeliveries(notice({}), names, "PD-0100", ["SFE-1"]);
    assert.equal(noMore.length, 0);
    assert.deepEqual(waiting.recipients, ["PD-0100"], "a rep's push goes to his reviewing manager");
    assert.equal(waiting.eventType, "focus_list_waiting");
    assert.equal(waiting.idempotencyKey, "phoenix_crm:focus:focus-1:waiting", "the key the keep and the return withdraw");
    assert.equal(waiting.tab, "focus");
    assert.match(waiting.message, /Karim Samy put .*Dr Salma Nabil.* \(PM\) on the Nasr City · Pedia Focus list\. Reason: Writes a competitor/);

    const [vacant] = focusListDeliveries(notice({ seat: VACANT_CHAIN_REP, actorHrId: "PD-0300" }), names, null, ["SFE-1", "SFE-2"]);
    assert.deepEqual(vacant.recipients, ["SFE-1", "SFE-2"], "a vacant chain is told SFE, never nobody");
    assert.match(vacant.message, /yours to decide/);

    const repCopies = [
      ...focusListDeliveries(notice({ actedAs: "manager", actorHrId: "PD-0100" }), names, "PD-0100", []),
      ...focusListDeliveries(notice({ step: "kept", actedAs: "manager", actorHrId: "PD-0100", note: null }), names, "PD-0100", []),
      ...focusListDeliveries(notice({ step: "returned", actedAs: "manager", actorHrId: "PD-0100", note: null }), names, "PD-0100", []),
    ];
    assert.deepEqual(
      repCopies.map((delivery) => [delivery.eventType, delivery.recipients.join(",")]),
      [
        ["focus_list_added", "PD-0200"],
        ["focus_list_kept", "PD-0200"],
        ["focus_list_returned", "PD-0200"],
      ],
      "a manager's push, keep and return each tell the rep",
    );
    for (const delivery of repCopies) {
      assert.doesNotMatch(`${delivery.title} ${delivery.message}`, /\bvisit|\bcount|\btrack/i, `the rep's copy names no visit or count: ${delivery.message}`);
    }

    const [ownReturn] = focusListDeliveries(notice({ step: "returned", note: null }), names, "PD-0100", []);
    assert.equal(ownReturn.eventType, "focus_list_returned");
    assert.deepEqual(ownReturn.recipients, ["PD-0100"], "the rep's own return tells his manager");

    assert.deepEqual(
      focusListDeliveries(notice({ actedAs: "rep", actorHrId: "PD-0100" }), names, "PD-0100", []),
      [],
      "nobody is told of his own step",
    );
  }

  // ── 5. The table and the read function ─────────────────────────────────────────────────────────
  {
    const sql = stripSqlComments(readFileSync("supabase/migrations/20261128135234_phoenix_crm_focus_list.sql", "utf8"));
    assert.match(sql, /alter table public\.phoenix_crm_focus_customers enable row level security;/);
    assert.match(sql, /revoke all on table public\.phoenix_crm_focus_customers from public, anon, authenticated;/);
    assert.match(
      sql,
      /revoke execute on function public\.phoenix_crm_focus_visits\(uuid\[\], boolean, date, date\) from public, anon, authenticated;/,
      "the browser key cannot call the tracking read",
    );
    assert.match(sql, /create unique index if not exists phoenix_crm_focus_customers_open_customer_idx[\s\S]*?where returned_at is null;/, "one open row per customer");
  }

  // ── 6. The rep's view carries no tracking ──────────────────────────────────────────────────────
  {
    const service = stripComments(readFileSync("src/lib/phoenix-crm/server/focus-list.ts", "utf8"));
    assert.match(service, /const period = repMode \? null : readFocusPeriod\(/, "the rep's read asks for no period");
    assert.match(service, /if \(!repMode && period\) \{\s+const days =/, "and the tracking is filled for a manager alone");
    assert.match(service, /canKeep: !repMode && decides && reviewStatus === "waiting",/, "and only a manager keeps");
    assert.match(service, /review_status: pushedAs === "manager" \? "kept" : "waiting",/, "a manager's own push is kept at once");
  }
}
