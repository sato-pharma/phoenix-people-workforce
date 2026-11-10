import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import { emptyTeamToday, summarizeTeamToday, teamTodayLine, teamTodayTone } from "../src/lib/phoenix-crm/team-today.ts";
import { kpiHoldBackOf } from "../src/lib/phoenix-crm/unplanned-rules.ts";

/**
 * Phoenix CRM — each rep's day on his managers' Team tab (owner, 2026-09-30: "the easiest CRM, yet
 * controlled"). The figures are the rep's own work, AM and PM apart, read in batches.
 */

const ROOT = new URL("../", import.meta.url);

function source(path: string): string {
  return stripComments(readFileSync(new URL(path, ROOT), "utf8"));
}

export function runPhoenixCrmTeamTodayTests(): void {
  // ── The figures ────────────────────────────────────────────────────────────────────────────────
  {
    const figures = summarizeTeamToday({
      seatIds: ["gz6", "gz7", "vacant"],
      seatsWithPlan: new Set(["gz6"]),
      planned: [
        { seatId: "gz6", customerId: "a1", listType: "AM" },
        { seatId: "gz6", customerId: "a2", listType: "AM" },
        { seatId: "gz6", customerId: "p1", listType: "PM" },
        { seatId: "gz6", customerId: "p1", listType: "PM" }, // a stray duplicate row is one stop
        { seatId: "elsewhere", customerId: "x", listType: "PM" }, // not asked for: ignored
      ],
      visits: [
        { seatId: "gz6", customerId: "a1", listType: "AM", capturedAt: "2026-09-30T07:10:00.000Z" },
        { seatId: "gz6", customerId: "p9", listType: "PM", capturedAt: "2026-09-30T15:40:00.000Z" }, // off the plan
        { seatId: "gz7", customerId: "p3", listType: "PM", capturedAt: "2026-09-30T12:00:00.000Z" },
      ],
    });
    const gz6 = figures.get("gz6");
    assert.ok(gz6, "every seat asked for gets an answer");
    assert.deepEqual(
      { ...gz6 },
      {
        planSent: true,
        amPlanned: 2,
        amPlannedDone: 1,
        pmPlanned: 1,
        pmPlannedDone: 0,
        amLogged: 1,
        pmLogged: 1,
        awaitingApproval: 0,
        awaitingValidation: 0,
        lastVisitAt: "2026-09-30T15:40:00.000Z",
      },
      "planned-done counts planned customers visited; an off-plan visit counts in logged only",
    );
    assert.equal(figures.get("gz7")?.planSent, false, "no plan sent is said, never read as zero done");
    assert.equal(figures.get("gz7")?.pmLogged, 1);
    assert.deepEqual({ ...figures.get("vacant") }, { ...emptyTeamToday() }, "a territory with nothing today reads nothing, never a gap");
    assert.equal(figures.has("elsewhere"), false, "a seat outside the viewer's scope never appears");

    // The line: AM and PM APART — never one combined figure (the call rate is never averaged).
    const line = teamTodayLine(gz6, "17:40");
    assert.equal(line, "Planned AM 1 of 2 · PM 0 of 1 · logged 1 AM · 1 PM, last at 17:40");
    assert.doesNotMatch(line, /\b3\b/, "no total of AM and PM anywhere in the line");
    assert.equal(teamTodayLine(emptyTeamToday(), null), "No plan sent for today · no visit logged yet");
    assert.equal(
      teamTodayLine({ ...gz6, pmPlanned: 0, pmPlannedDone: 0 }, "04:41"),
      "Planned AM 1 of 2 · PM none planned · logged 1 AM · 1 PM, last at 04:41",
      "a list with nothing planned says so — never \"PM 0 of 0\" (browser walk, 2026-09-30)",
    );

    // When he pressed "Show your manager you started working", it opens the line (owner, 2026-10-03).
    assert.equal(
      teamTodayLine(gz6, "17:40", "08:42"),
      "Started 08:42 · Planned AM 1 of 2 · PM 0 of 1 · logged 1 AM · 1 PM, last at 17:40",
      "the start comes first, before the plan's progress",
    );
    // 🔴 AND NOTHING WHEN HE DID NOT PRESS IT. There is no "not started" half: it would put a flag on
    // every row before the first press of a morning, and the press was never required of him.
    assert.equal(teamTodayLine(gz6, "17:40", null), line, "no press leaves the line exactly as it was");
    assert.equal(
      /start/i.test(teamTodayLine(emptyTeamToday(), null, null)),
      false,
      "and the word appears nowhere on a row with no plan, no visit and no press",
    );

    assert.equal(teamTodayTone(gz6), "progress");
    assert.equal(
      teamTodayTone({ ...gz6, amPlannedDone: 2, pmPlannedDone: 1 }),
      "good",
      "every planned stop done, AM and PM each",
    );
    assert.equal(teamTodayTone({ ...emptyTeamToday(), planSent: true, amPlanned: 2 }), "idle");
    assert.equal(teamTodayTone(emptyTeamToday()), "none");
  }

  // ── "Logged" counts what the KPIs count, and names what it held back (re-audit, 2026-10-22) ───────
  {
    const figures = summarizeTeamToday({
      seatIds: ["gz6"],
      seatsWithPlan: new Set(["gz6"]),
      planned: [{ seatId: "gz6", customerId: "a1", listType: "AM" }],
      visits: [
        { seatId: "gz6", customerId: "a1", listType: "AM", capturedAt: "2026-10-18T07:10:00.000Z", holdBack: null },
        { seatId: "gz6", customerId: "x1", listType: "AM", capturedAt: "2026-10-18T08:00:00.000Z", holdBack: "approval" },
        { seatId: "gz6", customerId: "x2", listType: "PM", capturedAt: "2026-10-18T09:00:00.000Z", holdBack: "approval" },
        { seatId: "gz6", customerId: "n1", listType: "PM", capturedAt: "2026-10-18T10:00:00.000Z", holdBack: "validation" },
        { seatId: "gz6", customerId: "r1", listType: "PM", capturedAt: "2026-10-18T11:00:00.000Z", holdBack: "refused" },
      ],
    });
    const gz6 = figures.get("gz6")!;
    assert.equal(gz6.amLogged, 1, "an off-plan visit still waiting for approval is in no KPI, so not in logged");
    assert.equal(gz6.pmLogged, 0, "nor one whose customer is not validated, nor a refused one");
    assert.equal(gz6.awaitingApproval, 2);
    assert.equal(gz6.awaitingValidation, 1);
    assert.equal(gz6.amPlannedDone, 1, "the plan's progress is untouched");
    assert.equal(gz6.lastVisitAt, "2026-10-18T11:00:00.000Z", "the clock is his activity, counted or not");
    assert.equal(
      teamTodayLine(gz6, "14:00"),
      "Planned AM 1 of 1 · PM none planned · logged 1 AM · 0 PM, last at 14:00 · 2 waiting for approval, 1 waiting for customer validation, not counted yet",
      "what is held back is named on the line, never hidden from the manager",
    );

    // The reason, asked in visitCountsInKpi's own order.
    const base = { customerValidated: true, isUnplanned: false, unplannedKind: null, unplannedStatus: null } as const;
    assert.equal(kpiHoldBackOf(base), null, "a planned visit to a validated customer counts");
    assert.equal(kpiHoldBackOf({ ...base, customerValidated: false, isUnplanned: true, unplannedKind: "out_of_plan", unplannedStatus: "refused" }), "validation", "validation first, whatever the approval says");
    assert.equal(kpiHoldBackOf({ ...base, isUnplanned: true, unplannedKind: "out_of_plan", unplannedStatus: "manager_pending" }), "approval");
    assert.equal(kpiHoldBackOf({ ...base, isUnplanned: true, unplannedKind: "out_of_plan", unplannedStatus: null }), "approval", "no approval row yet is waiting, never refused");
    assert.equal(kpiHoldBackOf({ ...base, isUnplanned: true, unplannedKind: "out_of_plan", unplannedStatus: "refused" }), "refused");
    assert.equal(kpiHoldBackOf({ ...base, isUnplanned: true, unplannedKind: "out_of_plan", unplannedStatus: "approved" }), null);
    assert.equal(kpiHoldBackOf({ ...base, isUnplanned: true, unplannedKind: "out_of_list", unplannedStatus: null }), null, "an out-of-list visit to a validated customer counts");
    // A visit held for the SFE after five far refusals from one spot (owner, 2026-11-10) waits for him, or is refused for good.
    assert.equal(kpiHoldBackOf({ ...base, farHoldStatus: "sfe_pending" }), "approval", "a held visit waits for the SFE");
    assert.equal(kpiHoldBackOf({ ...base, farHoldStatus: "refused" }), "refused", "a held visit the SFE refused never counts");
    assert.equal(kpiHoldBackOf({ ...base, farHoldStatus: "approved" }), null, "an approved hold counts");
    assert.equal(kpiHoldBackOf({ ...base, customerValidated: false, farHoldStatus: "sfe_pending" }), "validation", "validation first, whatever the hold says");

    const onlyWaiting = { ...emptyTeamToday(), awaitingApproval: 1 };
    assert.notEqual(teamTodayLine(onlyWaiting, "09:00"), "No plan sent for today · no visit logged yet", "a rep whose only visit waits for approval did work today");
    assert.equal(teamTodayTone({ ...onlyWaiting, planSent: true, amPlanned: 2 }), "progress", "and his row is not idle");

    const team = source("src/lib/phoenix-crm/server/team.ts");
    assert.match(team, /holdBack: teamTodayHoldBack\(row, farHolds\.get\(String\(row\.id\)\) \?\? null\)/, "every visit on the line carries its hold-back, the SFE's hold included");
    assert.match(team, /const farHolds = await loadUncountedFarVisitHolds\(\{ from: date, to: date \}\);/, "the day's far-visit holds are read once");
    assert.match(team, /unplanned:phoenix_crm_unplanned_visits!visit_id\(status\)/, "the approval is read with the visit");
    assert.match(team, /customer:phoenix_crm_customers!customer_id\(validated_at\)/, "and the customer's validation");
  }

  // ── Read in batches, on the visit day, from SENT plans ───────────────────────────────────────────
  {
    const team = source("src/lib/phoenix-crm/server/team.ts");
    assert.match(team, /loadTeamToday\(seatIds, isTest, viewer\.visitDay\)/, "the rep's VISIT day — until 02:00 the day that just ended");
    assert.match(team, /\.in\("seat_id", part\)/, "batched by seat, never one query per rep");
    // A sent plan is submitted or approved — the rep's own test — asked of THIS DAY (owner, 2026-10-02,
    // "Still planned"): a week returned for one other day still stands as sent on this one.
    assert.match(team, /\.in\("status", \[\.\.\.PLAN_STATUSES_WITH_SENT_DAYS\]\)/, "every plan that can hold a sent day is read");
    assert.match(team, /if \(!plan \|\| !isPlanDaySent\(\{ \.\.\.plan, date \}\)\) continue;/, "and kept only when it is sent on the day — the rep's own test");
    assert.doesNotMatch(team, /for \(const seat of seats\)[\s\S]{0,200}await /, "no per-territory await loop");
  }

  // ── On the screen, and nothing that judges him ─────────────────────────────────────────────────
  {
    const tab = source("src/components/phoenix-crm/team-tab.tsx");
    assert.match(tab, /<TodayLine row=\{row\} \/>/, "the day's line is on the card and in the table");
    assert.match(tab, /scope="col">\s*Customer list and today\s*<\/th>/, "on desktop the day rides in the list's own column");
    assert.match(tab, /<CrmTable columns=\{\["26%", "22%", null, "18%"\]\}>/, "merged, never a fifth column squeezed in (fits-the-screen)");
    const block = /function TodayLine\([\s\S]*?\n\}/.exec(tab)?.[0] ?? "";
    assert.ok(block, "the line is one component");
    assert.doesNotMatch(block, /rounded|distance|accuracy|flag|mock/i, "square, and no integrity signal in a manager's day line");
    assert.doesNotMatch(source("src/lib/phoenix-crm/team-today.ts"), /distance|accuracy|mock|integrity_/i, "the figures carry no integrity signal");
  }

  console.log("phoenix-crm team today: OK");
}
