import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  AM_CALL_RATE_TARGET,
  PM_CALL_RATE_TARGET,
  computeCallRate,
  type CallRateReport,
  type CallRateSlice,
  type RepCallRate,
  type VisitForCallRate,
} from "../src/lib/crm/call-rate.ts";
import { buildCoverageFilterTree } from "../src/lib/crm/coverage-filters.ts";
import {
  buildRepsPlansBoard,
  indexRepsPlansTerritories,
  repsPlansRange,
  resolveRepsPlansMonth,
  toRepsPlansRow,
} from "../src/lib/crm/reps-plans.ts";

// Tests for the Reps Plans board shaping (src/lib/crm/reps-plans.ts).
//
// The rules under test are the ones a reader of the screen would be misled by if they broke:
//
//   • the LIVE-MONTH CAP. The denominator is the calendar count of Sat-Wed, so scoring the whole of
//     August on the 12th divides a third of a month's work by a full month of days and shows the
//     entire field force failing. This is the single most likely way the page lies.
//   • the COMPANY RATE denominator, which is working days x reps, not working days. Get it wrong and
//     the tile reads 87x too high against a target of 2.
//   • the REP FILTER not moving the totals above it.
//   • UNPROVEN counting campaign calls AND check-in-less visits, because either one alone
//     understates it.
//
// Fixtures are built as CallRateReport objects directly for the shaping tests, plus one end-to-end
// case through computeCallRate so the two modules are proved to actually connect.

function slice(target: number, parts: Partial<CallRateSlice>, workingDays: number): CallRateSlice {
  const verified = parts.verified ?? 0;
  const unverified = parts.unverified ?? 0;
  const campaign = parts.campaign ?? 0;
  const total = verified + unverified + campaign;
  const verifiedRate = workingDays > 0 ? verified / workingDays : null;
  return {
    verified,
    unverified,
    campaign,
    total,
    verifiedRate,
    totalRate: workingDays > 0 ? total / workingDays : null,
    target,
    attainmentPct: verifiedRate == null ? null : (verifiedRate / target) * 100,
  };
}

function rep(
  name: string,
  workingDays: number,
  am: Partial<CallRateSlice>,
  pm: Partial<CallRateSlice>,
  extra: Partial<RepCallRate> = {},
): RepCallRate {
  return {
    agentCrmId: extra.agentCrmId ?? null,
    agentHrId: extra.agentHrId ?? null,
    agentName: name,
    workingDays,
    am: slice(AM_CALL_RATE_TARGET, am, workingDays),
    pm: slice(PM_CALL_RATE_TARGET, pm, workingDays),
    unspecified: extra.unspecified ?? 0,
    campaignShare: extra.campaignShare ?? 0,
    campaignOverLimitDays: extra.campaignOverLimitDays ?? [],
    campaignOnlyDays: extra.campaignOnlyDays ?? 0,
  };
}

function report(workingDays: number, reps: RepCallRate[]): CallRateReport {
  return { dateFrom: "2026-08-01", dateTo: "2026-08-31", workingDays, campaignLimit: 3, reps };
}

export function runCrmRepsPlansTests() {
  // ── month resolution ──────────────────────────────────────────────────────
  assert.equal(resolveRepsPlansMonth("2026-07", "2026-08-12"), "2026-07", "a valid month is kept");
  assert.equal(resolveRepsPlansMonth(undefined, "2026-08-12"), "2026-08", "no month falls back to today's month");
  assert.equal(resolveRepsPlansMonth("2026-13", "2026-08-12"), "2026-08", "month 13 is rejected, not clamped");
  assert.equal(resolveRepsPlansMonth("august", "2026-08-12"), "2026-08", "a non-key string is rejected");
  assert.equal(resolveRepsPlansMonth("2026-00", "2026-08-12"), "2026-08", "month 00 is rejected");

  // ── the live-month cap ────────────────────────────────────────────────────
  // THE bug this guards: without the cap, a rep on the 12th is scored against 23 working days he has
  // not worked yet, and every rate on the page reads roughly a third of the truth.
  const live = repsPlansRange("2026-08", "2026-08-12");
  assert.equal(live.dateFrom, "2026-08-01");
  assert.equal(live.dateTo, "2026-08-12", "a live month stops at today");
  assert.equal(live.monthEnd, "2026-08-31", "the month's real end is still reported");
  assert.equal(live.isCurrentMonth, true);

  const past = repsPlansRange("2026-07", "2026-08-12");
  assert.equal(past.dateTo, "2026-07-31", "a finished month is scored to its own last day");
  assert.equal(past.isCurrentMonth, false);

  const lastDayOfMonth = repsPlansRange("2026-08", "2026-08-31");
  assert.equal(lastDayOfMonth.dateTo, "2026-08-31", "the last day of the live month is inclusive");
  assert.equal(lastDayOfMonth.isCurrentMonth, true);

  assert.equal(repsPlansRange("2026-02", "2026-08-12").dateTo, "2026-02-28", "February 2026 ends on the 28th");
  assert.equal(repsPlansRange("2024-02", "2026-08-12").dateTo, "2024-02-29", "a leap February ends on the 29th");
  assert.equal(repsPlansRange("2026-12", "2026-08-12").dateTo, "2026-12-31", "December rolls the year, not the month");

  // A month still in the future is not "current", so it is scored whole and simply has no data.
  const future = repsPlansRange("2026-09", "2026-08-12");
  assert.equal(future.isCurrentMonth, false);
  assert.equal(future.dateTo, "2026-09-30");

  // ── one rep's row ─────────────────────────────────────────────────────────
  // 10 working days. AM: 20 verified = 2.00 against a target of 2 -> exactly on target.
  // PM: 40 verified, 10 unverified, 50 campaign -> proved 4.00 of 10, but REPORTED 10.00, which is
  // the shape the whole page exists to expose: a rep who looks perfect and can prove 40%.
  const showcase = toRepsPlansRow(
    rep(
      "Mohamed Khaled",
      10,
      { verified: 20 },
      { verified: 40, unverified: 10, campaign: 50 },
      { agentCrmId: 77, agentHrId: "HR-77", campaignShare: 50 / 120, campaignOnlyDays: 4, campaignOverLimitDays: [{ day: "2026-08-10", campaignCalls: 14, verifiedCalls: 0 }] },
    ),
  );
  assert.equal(showcase.repKey, "crm:77");
  assert.equal(showcase.am.verifiedRate, 2, "AM proved rate is verified / working days");
  assert.equal(showcase.am.attainmentPct, 100, "2.00 against a target of 2 is exactly 100%");
  assert.equal(showcase.pm.verifiedRate, 4, "PM proved rate counts only verified visits");
  assert.equal(showcase.pm.reportedRate, 10, "PM reported rate counts every row, including campaign");
  assert.equal(showcase.pm.attainmentPct, 40, "attainment is measured on the PROVED rate, never the reported one");
  assert.equal(showcase.verifiedCalls, 60);
  assert.equal(showcase.reportedCalls, 120);
  // Unproven = campaign (50) + no-check-in visits (10) = 60 of 120.
  assert.equal(showcase.unprovenPct, 50, "unproven counts campaign calls AND visits with no check-in");
  assert.equal(showcase.campaignSharePct, 42, "campaign share rounds 50/120 to 42%");
  assert.equal(showcase.flaggedDays, 1);
  assert.equal(showcase.worstCampaignDay, "2026-08-10");
  assert.equal(showcase.worstCampaignCalls, 14);
  assert.equal(showcase.campaignOnlyDays, 4);

  // Rounding must never round a miss up into a pass. 19.6 verified over 10 days is 1.96, which is
  // BELOW the target of 2 and has to keep reading as below.
  const nearMiss = toRepsPlansRow(rep("Near Miss", 100, { verified: 196 }, { verified: 1000 }));
  assert.equal(nearMiss.am.verifiedRate, 1.96);
  assert.equal(nearMiss.am.attainmentPct, 98, "1.96 of 2 is 98%, not 100%");

  // An unnamed rep still has to be identifiable in words — never a bare code (owner's standing rule).
  const unnamed = toRepsPlansRow(rep("", 10, { verified: 1 }, { verified: 1 }, { agentCrmId: 404 }));
  assert.equal(unnamed.repName, "Unnamed rep 404");
  assert.ok(!/^\d+$/.test(unnamed.repName), "a rep name is never a bare number");

  // A rep with no field work at all divides by nothing rather than reporting a false 0%.
  const idle = toRepsPlansRow(rep("Idle", 10, {}, {}));
  assert.equal(idle.reportedCalls, 0);
  assert.equal(idle.unprovenPct, null, "no calls means no unproven percentage, not 0%");
  assert.equal(idle.am.verifiedRate, 0, "zero calls over real working days is a real 0.00 rate");

  // ── company totals ────────────────────────────────────────────────────────
  // Two reps, 10 working days each. The denominator is 10 x 2 = 20, NOT 10: each rep owes 2 AM and
  // 10 PM every day, so the field-force rate stays on the same scale as the targets beside it.
  const twoReps = buildRepsPlansBoard(
    report(10, [
      rep("A", 10, { verified: 20 }, { verified: 100 }, { agentCrmId: 1 }),
      rep("B", 10, { verified: 20 }, { verified: 100 }, { agentCrmId: 2 }),
    ]),
    { month: "2026-08", isCurrentMonth: false },
  );
  assert.equal(twoReps.totals.reps, 2);
  assert.equal(twoReps.totals.am.verified, 40);
  assert.equal(twoReps.totals.am.verifiedRate, 2, "40 verified / (10 days x 2 reps) = 2.00, not 4.00");
  assert.equal(twoReps.totals.am.attainmentPct, 100);
  assert.equal(twoReps.totals.pm.verifiedRate, 10, "200 verified / 20 = 10.00");
  assert.equal(twoReps.totals.pm.attainmentPct, 100);
  assert.equal(twoReps.totals.repsOnTarget, 2, "both reps clear both targets");
  assert.equal(twoReps.totals.unprovenPct, 0, "every call was proved");
  assert.equal(twoReps.amTarget, AM_CALL_RATE_TARGET);
  assert.equal(twoReps.pmTarget, PM_CALL_RATE_TARGET);
  assert.equal(twoReps.monthLabel, "August 2026");

  // repsOnTarget needs BOTH. A rep who clears AM and misses PM is not on target.
  const mixed = buildRepsPlansBoard(
    report(10, [
      rep("Both", 10, { verified: 20 }, { verified: 100 }, { agentCrmId: 1 }),
      rep("AM only", 10, { verified: 20 }, { verified: 50 }, { agentCrmId: 2 }),
      rep("PM only", 10, { verified: 5 }, { verified: 100 }, { agentCrmId: 3 }),
    ]),
    { month: "2026-08", isCurrentMonth: false },
  );
  assert.equal(mixed.totals.repsOnTarget, 1, "clearing one of the two targets is not clearing the KPI");

  // The rep filter narrows the TABLE and must leave the tiles above it alone — those answer "how is
  // the field force doing", and silently rescoping them to one rep would be a different question
  // wearing the same label.
  const filtered = buildRepsPlansBoard(
    report(10, [
      rep("A", 10, { verified: 20 }, { verified: 100 }, { agentCrmId: 1 }),
      rep("B", 10, { verified: 0 }, { verified: 0 }, { agentCrmId: 2 }),
    ]),
    { month: "2026-08", isCurrentMonth: false, repKey: "crm:1" },
  );
  assert.equal(filtered.reps.length, 1, "the table shows the selected rep only");
  assert.equal(filtered.reps[0]?.repName, "A");
  assert.equal(filtered.appliedRepKey, "crm:1");
  assert.equal(filtered.totals.reps, 2, "the totals still cover the whole field force");
  assert.equal(filtered.totals.am.verifiedRate, 1, "20 verified / (10 x 2) = 1.00 — unchanged by the filter");
  assert.equal(filtered.repOptions.length, 2, "the picker still lists every rep");

  // An unknown rep key is ignored rather than emptying the board — a stale bookmark must not read as
  // "this rep did nothing".
  const unknownRep = buildRepsPlansBoard(
    report(10, [rep("A", 10, { verified: 20 }, { verified: 100 }, { agentCrmId: 1 })]),
    { month: "2026-08", isCurrentMonth: false, repKey: "crm:999" },
  );
  assert.equal(unknownRep.appliedRepKey, null);
  assert.equal(unknownRep.reps.length, 1, "an unknown rep filter falls back to everyone");

  // Nobody in the period: every rate is null, nothing divides by zero, nothing reads as a real 0%.
  const empty = buildRepsPlansBoard(report(23, []), { month: "2026-08", isCurrentMonth: false });
  assert.equal(empty.totals.reps, 0);
  assert.equal(empty.totals.am.verifiedRate, null);
  assert.equal(empty.totals.pm.attainmentPct, null);
  assert.equal(empty.totals.unprovenPct, null);
  assert.equal(empty.totals.campaignSharePct, 0);
  assert.equal(empty.reps.length, 0);

  // ── the LINE -> REGION cascade ────────────────────────────────────────────
  // Built through the REAL buildCoverageFilterTree rather than a hand-shaped tree, so these cases
  // break if the shared cascade's own rules move underneath this board — which is the whole reason
  // the board reuses it instead of owning a second copy.
  //
  // The fixture carries the two shapes that matter:
  //   • `ai / giza` is a target-carrying territory with NOBODY in the seat, so it must never be
  //     offered as a region on the Anti Infective line.
  //   • D holds an HR id the org model has no seat for, and E has no HR id at all. On production
  //     that group is ~15 of 87 reps and every one of them is ZERO-PROVED, which is exactly why a
  //     geography filter must not swallow them.
  const tree = buildCoverageFilterTree({
    lineNames: new Map([
      ["ai", "Anti Infective"],
      ["cns", "CNS"],
    ]),
    mapRows: [
      { areaCode: "D1", areaName: "Delta One", lineCode: "cns", regionCode: "delta", repSeatId: "S1" },
      { areaCode: "G1", areaName: "Giza One", lineCode: "cns", regionCode: "giza", repSeatId: "S2" },
      { areaCode: "D2", areaName: "Delta Two", lineCode: "ai", regionCode: "delta", repSeatId: "S3" },
      { areaCode: "G2", areaName: "Giza Two", lineCode: "ai", regionCode: "giza", repSeatId: "S4" },
    ],
    regionNames: new Map([
      ["delta", "Delta (1)"],
      ["giza", "Giza"],
    ]),
    seats: [
      { fullName: "Alia", hrId: "AI-0001", seatId: "S1", seatTier: "REP" },
      { fullName: "Basem", hrId: "AI-0002", seatId: "S2", seatTier: "REP" },
      { fullName: "Karim", hrId: "AI-0003", seatId: "S3", seatTier: "REP" },
      // S4 is deliberately unfilled — a vacant territory.
    ],
  });

  // The index keys on the BARE lowercased HR id, not on a `hr:` board key. Handing one board's key
  // shape to another matches nothing while looking perfectly correct, which is the trap recorded
  // against these two modules.
  const territoryIndex = indexRepsPlansTerritories(tree);
  assert.deepEqual(
    territoryIndex.get("ai-0001")?.map((t) => `${t.lineName} · ${t.regionName}`),
    ["CNS · Delta (1)"],
    "a seated rep resolves to his line and region by lowercased HR id",
  );
  assert.equal(territoryIndex.has("AI-0001"), false, "the index is not keyed by the raw-case id");
  assert.equal(territoryIndex.has("ai-0009"), false, "a rep with no seat is absent, never an empty entry");

  const geoReport = report(10, [
    rep("Alia", 10, { verified: 20 }, { verified: 100 }, { agentCrmId: 1, agentHrId: "AI-0001" }),
    rep("Basem", 10, { verified: 10 }, { verified: 50 }, { agentCrmId: 2, agentHrId: "AI-0002" }),
    rep("Karim", 10, { verified: 0 }, { verified: 20 }, { agentCrmId: 3, agentHrId: "AI-0003" }),
    // The two the filter must not swallow — no seat, and nothing proved.
    rep("Dalia", 10, { verified: 0, campaign: 40 }, { verified: 0, campaign: 60 }, { agentCrmId: 4, agentHrId: "AI-0009" }),
    rep("Emad", 10, { verified: 0, campaign: 30 }, { verified: 0, campaign: 30 }, { agentCrmId: 5 }),
  ]);

  // No geography picked: unchanged from before this feature existed — everyone in, everyone counted.
  const wide = buildRepsPlansBoard(geoReport, { month: "2026-08", isCurrentMonth: false, tree });
  assert.equal(wide.reps.length, 5, "no geography filter lists every rep");
  assert.equal(wide.totals.reps, 5, "and counts every rep in the tiles");
  assert.equal(wide.unseatedShown, 0, "nothing is 'shown outside the tiles' when nothing is filtered");
  assert.equal(wide.geographyLabel, null);
  assert.equal(wide.geographyAvailable, true);
  assert.deepEqual(
    wide.lineOptions.map((o) => o.name),
    ["Anti Infective", "CNS"],
    "lines are offered by NAME, never by code (owner's standing rule)",
  );
  assert.equal(
    wide.reps.find((r) => r.repName === "Dalia")?.territories.length,
    0,
    "a rep the org model has no seat for carries no territory",
  );

  // THE TILES RECOMPUTE. This is the half that separates line/region from the rep filter above.
  const cns = buildRepsPlansBoard(geoReport, {
    geography: { line: "cns" },
    isCurrentMonth: false,
    month: "2026-08",
    tree,
  });
  assert.equal(cns.appliedLine, "cns");
  assert.equal(cns.geographyLabel, "CNS", "the label names the line, never its code");
  assert.equal(cns.totals.reps, 2, "the tiles cover the two CNS reps only");
  // 20 + 10 verified AM over (10 working days x 2 reps) = 1.50, where the unfiltered board reads 0.60.
  assert.equal(cns.totals.am.verifiedRate, 1.5, "the AM tile is rescoped to the line");
  assert.equal(wide.totals.am.verifiedRate, 0.6, "and the unfiltered board still reads the whole force");

  // AND THE UNSEATED REPS SURVIVE IT — listed, marked, counted nowhere.
  assert.deepEqual(
    cns.reps.map((r) => r.repName).sort(),
    ["Alia", "Basem", "Dalia", "Emad"],
    "a line filter keeps the seatless reps on the board",
  );
  assert.equal(cns.unseatedShown, 2, "and says how many are being shown outside the tiles");
  assert.equal(
    cns.reps.some((r) => r.repName === "Karim"),
    false,
    "while a rep seated on ANOTHER line is genuinely filtered out",
  );
  // The proof that they are outside the tiles rather than merely late in the list: Dalia and Emad
  // carry 160 campaign calls between them, and none of it reaches the line's campaign figure.
  assert.equal(cns.totals.campaignCalls, 0, "seatless reps contribute nothing to a territory's rate");

  // Region is narrowed BY THE LINE — the owner's order, and the one that avoids the dead end.
  assert.deepEqual(
    cns.regionOptions.map((o) => o.name),
    ["Delta (1)", "Giza"],
    "CNS offers both of its regions",
  );
  const ai = buildRepsPlansBoard(geoReport, {
    geography: { line: "ai" },
    isCurrentMonth: false,
    month: "2026-08",
    tree,
  });
  assert.deepEqual(
    ai.regionOptions.map((o) => o.name),
    ["Delta (1)"],
    "Anti Infective offers only Delta — its Giza territory is VACANT, so offering it would resolve to nobody",
  );
  assert.deepEqual(
    ai.lineOptions.map((o) => o.name),
    ["Anti Infective", "CNS"],
    "the top of the cascade is never narrowed from below",
  );

  // Both levels together.
  const cnsDelta = buildRepsPlansBoard(geoReport, {
    geography: { line: "cns", region: "delta" },
    isCurrentMonth: false,
    month: "2026-08",
    tree,
  });
  assert.equal(cnsDelta.geographyLabel, "CNS · Delta (1)");
  assert.equal(cnsDelta.totals.reps, 1, "one seated rep in CNS/Delta");
  assert.equal(cnsDelta.totals.am.verifiedRate, 2, "20 verified / (10 x 1) = 2.00");
  assert.deepEqual(cnsDelta.reps.map((r) => r.repName).sort(), ["Alia", "Dalia", "Emad"]);

  // A stale or hand-edited URL is PRUNED, never rejected — it keeps as much as still makes sense
  // instead of dumping the viewer back to everything with no explanation.
  const bogusLine = buildRepsPlansBoard(geoReport, {
    geography: { line: "no-such-line", region: "delta" },
    isCurrentMonth: false,
    month: "2026-08",
    tree,
  });
  assert.equal(bogusLine.appliedLine, null, "an unknown line is dropped");
  assert.equal(bogusLine.appliedRegion, "delta", "while the region that IS real survives");
  const impossiblePair = buildRepsPlansBoard(geoReport, {
    geography: { line: "ai", region: "giza" },
    isCurrentMonth: false,
    month: "2026-08",
    tree,
  });
  assert.equal(impossiblePair.appliedLine, "ai");
  assert.equal(
    impossiblePair.appliedRegion,
    null,
    "a region the chosen line does not reach is pruned rather than rendering an empty board",
  );

  // The rep picker follows what is on screen, so it can never offer a rep the board is not showing.
  assert.deepEqual(
    cnsDelta.repOptions.map((o) => o.repName),
    ["Alia", "Dalia", "Emad"],
    "the rep picker lists exactly the visible reps",
  );

  // No org model at all: the pickers are HIDDEN, not rendered empty — an empty line picker would
  // read as "this company has no lines". The call rate itself is unaffected.
  const noTree = buildRepsPlansBoard(geoReport, {
    geography: { line: "cns" },
    isCurrentMonth: false,
    month: "2026-08",
    tree: null,
  });
  assert.equal(noTree.geographyAvailable, false);
  assert.deepEqual(noTree.lineOptions, []);
  assert.equal(noTree.appliedLine, null, "a line cannot be applied with no org model to resolve it");
  assert.equal(noTree.reps.length, 5, "and the board still shows every rep");
  assert.equal(noTree.totals.reps, 5);

  // ── end to end, through the real computeCallRate ──────────────────────────
  // Proves the two modules connect: 2026-08-01 is a Saturday, so 08-01..08-05 is Sat/Sun/Mon/Tue/Wed
  // — five working days. One rep records 1 verified PM visit and 12 campaign calls on one day.
  const visits: VisitForCallRate[] = [
    {
      agent_crm_id: 9,
      agent_hr_id: "HR-9",
      agent_name: "Field Rep",
      ampm: "PM",
      contact_crm_id: 501,
      crm_save_date: "2026-08-03 14:00:00",
      visit_date: "2026-08-03",
      visit_type: 0,
      visit_type_description: "Regular",
      comment: "clinic",
    },
    ...Array.from({ length: 12 }, (_, index) => ({
      agent_crm_id: 9,
      agent_hr_id: "HR-9",
      agent_name: "Field Rep",
      ampm: "PM",
      contact_crm_id: 0,
      crm_save_date: `2026-08-03 1${index % 10}:00:00`,
      visit_date: "2026-08-03",
      visit_type: -8,
      visit_type_description: "Campaign",
      comment: `prospect ${index}`,
    })),
  ];
  const checkins = [{ agent_crm_id: 9, contact_crm_id: 501, check_date: "2026-08-03 13:55:00" }];
  const liveBoard = buildRepsPlansBoard(
    computeCallRate(visits, checkins, { dateFrom: "2026-08-01", dateTo: "2026-08-05" }),
    { month: "2026-08", isCurrentMonth: true },
  );
  assert.equal(liveBoard.workingDays, 5, "2026-08-01..05 is Sat, Sun, Mon, Tue, Wed");
  const only = liveBoard.reps[0];
  assert.ok(only, "the rep reached the board");
  assert.equal(only.pm.verified, 1);
  assert.equal(only.pm.campaign, 12);
  assert.equal(only.pm.verifiedRate, 0.2, "1 proved visit over 5 working days is 0.20");
  assert.equal(only.pm.reportedRate, 2.6, "13 rows over 5 working days is 2.60 — thirteen times the proved rate");
  assert.equal(only.pm.attainmentPct, 2, "0.20 against a target of 10 is 2%");
  assert.equal(only.unprovenPct, 92, "12 of 13 reported calls can never be checked");
  assert.equal(only.flaggedDays, 1, "12 campaign calls in one day is over the limit of 3");
  assert.equal(only.worstCampaignCalls, 12);
  assert.equal(liveBoard.totals.repsOnTarget, 0);
  assert.equal(liveBoard.campaignLimit, 3, "the owner's daily campaign limit reaches the screen");

  // ── The column is LINE · REGION, and it must never call itself "Territory" ────────────────────
  //
  // This is a collision two green PRs made between them, neither able to see it. #2491 shortened
  // the mobile card title by moving the CRM handle's trailing bracket — "( Down-town / C )", an
  // AREA and a line letter — down to the card's meta line, and the desktop Rep cell renders that
  // same bracket inline. This branch then added a column of the ORG MODEL's line and region. Both
  // merged clean; the result put the line on one row twice, once labelled "Territory" and once not.
  //
  // The data is right and stays. The LABEL is what was wrong, so the label is pinned: one word for
  // one thing. The rep's CRM bracket is his area; this column is what the two pickers filter on.
  const repsPlansTables = readFileSync("src/components/crm/reps-plans-tables.tsx", "utf8");
  assert.ok(
    repsPlansTables.includes("Line · Region"),
    "the org-model column must be labelled Line · Region — the name of the two things it holds and the two pickers that filter it",
  );
  assert.ok(
    !/>\s*Territory\s*</.test(repsPlansTables) && !/label: "Territory"/.test(repsPlansTables),
    "and it must NOT be called Territory: the Rep column beside it already ends in the CRM handle's own territory bracket, so a second column of that name puts the line on the row twice under two names",
  );
  assert.ok(
    !repsPlansTables.includes("No territory"),
    "the marker follows the label — a rep with no org seat reads No seat, matching the note above the tiles, not a second sense of the word territory",
  );

  const repsPlansBoard = readFileSync("src/components/crm/reps-plans-board.tsx", "utf8");
  assert.ok(
    repsPlansBoard.includes(">No seat<"),
    "the note above the tiles must name the marker the table actually renders — it tells the reader what to look for, and a note pointing at a label that no longer exists is worse than no note",
  );
}
