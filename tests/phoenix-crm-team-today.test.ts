import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import { emptyTeamToday, summarizeTeamToday, teamTodayLine, teamTodayTone } from "../src/lib/phoenix-crm/team-today.ts";

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
      { planSent: true, amPlanned: 2, amPlannedDone: 1, pmPlanned: 1, pmPlannedDone: 0, amLogged: 1, pmLogged: 1, lastVisitAt: "2026-09-30T15:40:00.000Z" },
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

    assert.equal(teamTodayTone(gz6), "progress");
    assert.equal(
      teamTodayTone({ ...gz6, amPlannedDone: 2, pmPlannedDone: 1 }),
      "good",
      "every planned stop done, AM and PM each",
    );
    assert.equal(teamTodayTone({ ...emptyTeamToday(), planSent: true, amPlanned: 2 }), "idle");
    assert.equal(teamTodayTone(emptyTeamToday()), "none");
  }

  // ── Read in batches, on the visit day, from SENT plans ───────────────────────────────────────────
  {
    const team = source("src/lib/phoenix-crm/server/team.ts");
    assert.match(team, /loadTeamToday\(seatIds, isTest, viewer\.visitDay\)/, "the rep's VISIT day — until 02:00 the day that just ended");
    assert.match(team, /\.in\("seat_id", part\)/, "batched by seat, never one query per rep");
    assert.match(team, /\.in\("status", \["submitted", "approved"\]\)/, "a sent plan is submitted or approved — the rep's own test");
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
