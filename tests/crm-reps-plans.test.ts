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
import { buildOrgPlacementTree, type OrgTreeNode } from "../src/lib/crm/org-placement.ts";
import {
  attainmentTone,
  buildRepsPlansBoard,
  repsPlansRange,
  resolveRepsPlansMonth,
  riskTone,
  shareTone,
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
  // No organogram passed here at all, deliberately: these cases predate it and pin how the board
  // reads when nothing is known about anyone — everyone scored. That is the fallback the noTree
  // case further down states explicitly.
  assert.equal(twoReps.totals.reps, 2, "with no organogram to classify anyone, every rep is scored");
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

  // ── the ORGANOGRAM, and the LINE -> REGION cascade ────────────────────────
  // Built through the REAL buildOrgPlacementTree from `au_v_org_tree`-shaped rows, so these cases
  // break if the resolution moves underneath the board.
  //
  // WHY THE WHOLE TREE AND NOT A REP SLICE. The first build of this filter resolved a person from
  // `au_v_line_area_map.rep_seat_id`, a column that by definition holds REP seats and nothing else.
  // Every District Manager, Acting DM, RSM and NSM fell straight through it and was rendered as
  // holding NO SEAT — 22 seated managers on production, each told he was not in the org chart. The
  // owner spotted it on sight, because he knows who his managers are. Hence Nabil and Sherif below:
  // if either ever reads as unplaced again, this test is what says so.
  //
  // The fixture carries the four shapes that matter:
  //   • a DM, who carries a cell of his OWN;
  //   • an NSM and a CEO, who carry NONE and must resolve to what sits beneath them;
  //   • `ai / giza`, a real territory with NOBODY in the seat — never offered as a filter, yet
  //     genuinely part of the CEO's coverage;
  //   • Dalia, whose HR id the organogram has no seat for, and Emad, who has no HR id at all. On
  //     production that group is ~15 of 87 and almost every one is ZERO-PROVED, which is exactly
  //     why a geography filter must not swallow them.
  const CNS_DELTA = { lineCode: "cns", lineName: "CNS", regionCode: "delta", regionName: "Delta (1)" };
  const CNS_GIZA = { lineCode: "cns", lineName: "CNS", regionCode: "giza", regionName: "Giza" };
  const AI_DELTA = { lineCode: "ai", lineName: "Anti Infective", regionCode: "delta", regionName: "Delta (1)" };
  const AI_GIZA = { lineCode: "ai", lineName: "Anti Infective", regionCode: "giza", regionName: "Giza" };

  const seat = (
    seatId: string,
    seatTier: string,
    occupantHrId: string | null,
    path: string[],
    cell?: { lineCode: string; lineName: string; regionCode: string; regionName: string },
  ): OrgTreeNode => ({
    seatId,
    path,
    seatTier,
    occupantHrId,
    lineCode: cell?.lineCode ?? null,
    lineName: cell?.lineName ?? null,
    regionCode: cell?.regionCode ?? null,
    regionName: cell?.regionName ?? null,
  });

  const tree = buildOrgPlacementTree([
    seat("CEO", "CEO", "AI-9000", []),
    seat("NSM-CNS", "NSM", "AI-0100", ["CEO"]),
    seat("DM-CNS-DELTA", "DM", "AI-0010", ["CEO", "NSM-CNS"], CNS_DELTA),
    seat("S1", "REP", "AI-0001", ["CEO", "NSM-CNS", "DM-CNS-DELTA"], CNS_DELTA),
    seat("S2", "REP", "AI-0002", ["CEO", "NSM-CNS"], CNS_GIZA),
    seat("S3", "REP", "AI-0003", ["CEO"], AI_DELTA),
    // Deliberately unfilled — a vacant territory.
    seat("S4", "REP", null, ["CEO"], AI_GIZA),
  ]);

  // The index keys on the BARE lowercased HR id, not on a `hr:` board key. Handing one board's key
  // shape to another matches nothing while looking perfectly correct, which is the trap recorded
  // against these modules.
  const cellsOf = (hrId: string) => tree.index.get(hrId)?.cells.map((c) => `${c.lineName} · ${c.regionName}`);
  assert.deepEqual(cellsOf("ai-0001"), ["CNS · Delta (1)"], "a rep resolves to his own cell by lowercased HR id");
  assert.equal(tree.index.has("AI-0001"), false, "the index is not keyed by the raw-case id");
  assert.equal(tree.index.has("ai-0009"), false, "someone with no seat is absent, never an empty entry");

  // THE REGRESSION. A District Manager holds a seat, a line and a region — he is not unplaced.
  assert.deepEqual(cellsOf("ai-0010"), ["CNS · Delta (1)"], "a DM resolves exactly as a rep does");
  assert.equal(tree.index.get("ai-0010")?.tierLabel, "District Manager", "and is named in words, never as a code");
  assert.equal(tree.index.get("ai-0010")?.scored, false, "but the 2 AM / 10 PM target is not his");
  assert.equal(tree.index.get("ai-0001")?.scored, true, "while it IS the medical rep's");

  // A seat above the area layer carries no line or region of its own and takes what is beneath it.
  // Getting this wrong is the same bug wearing a different hat: an NSM reading as unplaced.
  assert.deepEqual(cellsOf("ai-0100"), ["CNS · Delta (1)", "CNS · Giza"], "an NSM covers his line's regions");
  assert.deepEqual(
    cellsOf("ai-9000"),
    ["Anti Infective · Delta (1)", "Anti Infective · Giza", "CNS · Delta (1)", "CNS · Giza"],
    "and the CEO covers everything under him, both lines",
  );

  // A vacant territory is genuinely part of the CEO's coverage AND must never be offered as a
  // filter: picking it could only ever produce an empty board.
  assert.equal(
    tree.cells.some((c) => c.lineCode === "ai" && c.regionCode === "giza"),
    false,
    "a territory with nobody in the seat is not offered in the cascade",
  );

  const geoReport = report(10, [
    rep("Alia", 10, { verified: 20 }, { verified: 100 }, { agentCrmId: 1, agentHrId: "AI-0001" }),
    rep("Basem", 10, { verified: 10 }, { verified: 50 }, { agentCrmId: 2, agentHrId: "AI-0002" }),
    rep("Karim", 10, { verified: 0 }, { verified: 20 }, { agentCrmId: 3, agentHrId: "AI-0003" }),
    // A District Manager and an NSM, both with real field activity. Listed, scored on nothing.
    rep("Nabil", 10, { verified: 5 }, { verified: 5, campaign: 40 }, { agentCrmId: 10, agentHrId: "AI-0010" }),
    rep("Sherif", 10, { verified: 1 }, { verified: 2 }, { agentCrmId: 100, agentHrId: "AI-0100" }),
    // The two the filter must not swallow — no seat, and nothing proved.
    rep("Dalia", 10, { verified: 0, campaign: 40 }, { verified: 0, campaign: 60 }, { agentCrmId: 4, agentHrId: "AI-0009" }),
    rep("Emad", 10, { verified: 0, campaign: 30 }, { verified: 0, campaign: 30 }, { agentCrmId: 5 }),
  ]);

  // No geography picked: everyone is LISTED. Only the medical reps are counted.
  const wide = buildRepsPlansBoard(geoReport, { month: "2026-08", isCurrentMonth: false, tree });
  assert.equal(wide.reps.length, 7, "no geography filter lists every person");
  assert.equal(wide.totals.reps, 3, "the tiles are the three MEDICAL REPS — the target is theirs");
  assert.equal(wide.managersShown, 2, "and the board says how many managers are listed but unscored");
  assert.equal(wide.unplacedShown, 2, "and how many hold no seat at all");
  assert.equal(wide.geographyLabel, null);
  assert.equal(wide.geographyAvailable, true);
  assert.deepEqual(
    wide.lineOptions.map((o) => o.name),
    ["Anti Infective", "CNS"],
    "lines are offered by NAME, never by code (owner's standing rule)",
  );

  // OWNER'S RULE, 2026-08-28, in his words: "the KPI is two AM, ten PM, for medical reps. Don't
  // restrict the managers on AM and PM. Make their account appear, but not restrict them."
  const nabil = wide.reps.find((r) => r.repName === "Nabil");
  assert.ok(nabil, "the District Manager is on the board");
  assert.equal(nabil.seatTierLabel, "District Manager", "shown as what he is");
  assert.deepEqual(
    nabil.territories.map((t) => `${t.lineName} · ${t.regionName}`),
    ["CNS · Delta (1)"],
    "with his own territory — NOT the 'no seat' marker that put 22 real managers outside the org chart",
  );
  assert.equal(nabil.scored, false, "and measured against no target");
  assert.equal(nabil.am.verifiedRate, 0.5, "his real activity is still on the row — that is his account appearing");
  // The proof he is outside the tiles rather than merely low in the list: 40 campaign calls, none of
  // which reach the company figure. Dalia and Emad carry 160 more, equally excluded.
  assert.equal(wide.totals.campaignCalls, 0, "a manager's activity never moves a number he is not measured by");
  assert.equal(wide.totals.am.verifiedRate, 1, "30 verified AM / (10 days x 3 reps) = 1.00 — managers not in the divisor");
  assert.equal(wide.totals.repsOnTarget, 1, "only Alia clears both targets");
  assert.equal(
    wide.reps.find((r) => r.repName === "Dalia")?.territories.length,
    0,
    "someone the organogram has no seat for carries no territory",
  );
  assert.equal(wide.reps.find((r) => r.repName === "Dalia")?.scored, false, "and is not scored on a target either");

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
  // 20 + 10 verified AM over (10 working days x 2 reps) = 1.50, where the unfiltered board reads 1.00.
  assert.equal(cns.totals.am.verifiedRate, 1.5, "the AM tile is rescoped to the line");

  // The managers are REACHED by the filter exactly as a rep is — the DM by his own cell, the NSM by
  // what sits beneath him — and the unplaced survive it, listed and marked.
  assert.deepEqual(
    cns.reps.map((r) => r.repName).sort(),
    ["Alia", "Basem", "Dalia", "Emad", "Nabil", "Sherif"],
    "a line filter keeps its managers and the seatless people on the board",
  );
  assert.equal(cns.managersShown, 2, "both managers are listed outside the tiles");
  assert.equal(cns.unplacedShown, 2, "as are both people with no seat");
  assert.equal(
    cns.reps.some((r) => r.repName === "Karim"),
    false,
    "while a rep seated on ANOTHER line is genuinely filtered out",
  );
  assert.equal(cns.totals.campaignCalls, 0, "and nobody unscored contributes to the line's rate");

  // A manager on another line is filtered out like anyone else — being a manager is not a pass.
  const ai = buildRepsPlansBoard(geoReport, {
    geography: { line: "ai" },
    isCurrentMonth: false,
    month: "2026-08",
    tree,
  });
  assert.deepEqual(
    ai.reps.map((r) => r.repName).sort(),
    ["Dalia", "Emad", "Karim"],
    "the CNS DM and the CNS NSM are both out of an Anti Infective board",
  );
  assert.equal(ai.managersShown, 0);

  // Region is narrowed BY THE LINE — the owner's order, and the one that avoids the dead end.
  assert.deepEqual(
    cns.regionOptions.map((o) => o.name),
    ["Delta (1)", "Giza"],
    "CNS offers both of its regions",
  );
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
  assert.equal(cnsDelta.totals.reps, 1, "one medical rep in CNS/Delta");
  assert.equal(cnsDelta.totals.am.verifiedRate, 2, "20 verified / (10 x 1) = 2.00");
  assert.deepEqual(
    cnsDelta.reps.map((r) => r.repName).sort(),
    ["Alia", "Dalia", "Emad", "Nabil", "Sherif"],
    "his DM and his NSM belong to CNS/Delta as much as he does",
  );

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
    ["Alia", "Dalia", "Emad", "Nabil", "Sherif"],
    "the rep picker lists exactly the visible people",
  );

  // No organogram at all — the read failed, not "these people have no seat". The pickers are HIDDEN
  // rather than rendered empty (an empty line picker reads as "this company has no lines"), and the
  // board falls back to how it read before this feature existed: EVERYONE scored.
  //
  // The alternative is worse than it looks. Scoring only known reps when nothing is known scores
  // nobody, so one Supabase blip empties every tile on the page and the KPI reads "—" with no
  // explanation. A rule about whose target it is must not double as an outage.
  const noTree = buildRepsPlansBoard(geoReport, {
    geography: { line: "cns" },
    isCurrentMonth: false,
    month: "2026-08",
    tree: null,
  });
  assert.equal(noTree.geographyAvailable, false);
  assert.deepEqual(noTree.lineOptions, []);
  assert.equal(noTree.appliedLine, null, "a line cannot be applied with no org model to resolve it");
  assert.equal(noTree.reps.length, 7, "and the board still shows everyone");
  assert.equal(noTree.totals.reps, 7, "all of them scored, exactly as the page read before the organogram was wired in");
  assert.ok(noTree.totals.am.verifiedRate != null, "so the tiles still carry a number rather than blanking");
  assert.equal(noTree.managersShown, 0, "nobody is called a manager on the strength of a chart that could not be read");
  assert.equal(noTree.unplacedShown, 0, "and nobody is called unplaced by it either");

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
    "the marker follows the label — a person with no org seat reads Not in organogram, matching the note above the tiles, not a second sense of the word territory",
  );
  assert.ok(
    repsPlansTables.includes("Not in organogram"),
    "and the marker says WHERE the seat is missing from, because that is a gap in the org chart to close rather than a fault of the person on the row",
  );

  const repsPlansBoard = readFileSync("src/components/crm/reps-plans-board.tsx", "utf8");
  assert.ok(
    repsPlansBoard.includes(">Not in organogram<"),
    "the note above the tiles must name the marker the table actually renders — it tells the reader what to look for, and a note pointing at a label that no longer exists is worse than no note",
  );

  // The column exists only when the organogram was actually read, so the prop has to reach the
  // table. Dropping it in a merge would compile — and print "Not in organogram" against all 87 rows
  // on the one day the read fails, which reads as the company having lost its org chart overnight.
  assert.equal(
    repsPlansBoard.split("geographyAvailable={board.geographyAvailable}").length - 1,
    2,
    "both the pickers and the table are told whether the organogram was readable",
  );

  // ── the rep's NAME: the directory names the person, the CRM names the territory ────────────
  // Measured on the live August board before this fix: 84 of 87 rendered labels were CRM login
  // handles — "Adel.Srour ( Down-town / C )" — which is the standing rule against raw codes broken
  // on every row of the page. #2480 settled the rule on Doctor Coverage; these pin it here.
  //
  // The map is keyed LOWER-cased and the fixtures deliberately carry UPPER-cased hr ids, because
  // the ids arrive from the CRM mirror in mixed case and a case-sensitive lookup silently names
  // nobody while looking like it worked.
  const directory = new Map([
    ["hr-1", "Adel Mahmoud Srour"],
    ["hr-3", "Mervat Fouad"],
  ]);

  assert.equal(
    toRepsPlansRow(rep("Adel.Srour ( Down-town / C )", 20, {}, {}, { agentHrId: "HR-1", agentCrmId: 11 }), null, directory)
      .repName,
    "Adel Mahmoud Srour ( Down-town / C )",
    "the person comes from the directory, the territory from the CRM — and the hr id matched across case",
  );
  assert.equal(
    toRepsPlansRow(rep("Mervat.Fouad", 20, {}, {}, { agentHrId: "hr-3" }), null, directory).repName,
    "Mervat Fouad",
    "a CRM name with no trailing territory leaves just the real name — no empty brackets",
  );
  assert.equal(
    toRepsPlansRow(rep("Sameh.Shaaban ( Tanta / B )", 20, {}, {}, { agentHrId: "HR-99" }), null, directory).repName,
    "Sameh.Shaaban ( Tanta / B )",
    "no directory row keeps the CRM name whole — a name is not the place to start throwing",
  );
  assert.equal(
    toRepsPlansRow(rep("Mina.Farouk", 20, {}, {}, { agentCrmId: 44 }), null, directory).repName,
    "Mina.Farouk",
    "an agent with no hr id has nothing to look up",
  );
  assert.equal(
    toRepsPlansRow(rep("( Behira 2 / C )", 20, {}, {}, { agentHrId: "HR-1" }), null, directory).repName,
    "Adel Mahmoud Srour ( Behira 2 / C )",
    "the pathological row — a CRM name that is a territory and NOTHING else — gets a person",
  );
  assert.equal(
    toRepsPlansRow(rep("Ali (acting) Hassan", 20, {}, {}, { agentHrId: "HR-99" }), null, directory).repName,
    "Ali (acting) Hassan",
    "a bracket in the MIDDLE of a name is not a territory — the pattern is anchored at the end",
  );
  assert.equal(
    toRepsPlansRow(rep("", 20, {}, {}, { agentHrId: "hr-5" })).repName,
    "HR-5",
    "an hr id identifies a person when nothing else does",
  );
  assert.equal(
    toRepsPlansRow(rep("", 20, {}, {}, { agentCrmId: 77 })).repName,
    "Unnamed rep 77",
    "the last resort is still words, never a bare code",
  );

  // buildRepsPlansBoard must BIND the map rather than hand toRepsPlansRow the array index. `.map(fn)`
  // passes (value, index, array), so a bare `.map(toRepsPlansRow)` sends 0, 1, 2 where the directory
  // belongs — every row keeps its login handle and nothing anywhere reports a failure.
  const namedBoard = buildRepsPlansBoard(
    report(20, [
      rep("Adel.Srour ( Down-town / C )", 20, {}, {}, { agentCrmId: 11, agentHrId: "HR-1" }),
      rep("Mervat.Fouad", 20, {}, {}, { agentCrmId: 12, agentHrId: "hr-3" }),
    ]),
    { isCurrentMonth: false, month: "2026-08", repNameByHrId: directory },
  );
  assert.deepEqual(
    namedBoard.reps.map((row) => row.repName),
    ["Adel Mahmoud Srour ( Down-town / C )", "Mervat Fouad"],
    "every row is named, not only the first",
  );
  assert.deepEqual(
    namedBoard.repOptions.map((option) => option.repName),
    ["Adel Mahmoud Srour ( Down-town / C )", "Mervat Fouad"],
    "the rep picker carries the same real names",
  );
  assert.equal(
    buildRepsPlansBoard(report(20, [rep("Adel.Srour ( Down-town / C )", 20, {}, {}, { agentHrId: "HR-1" })]), {
      isCurrentMonth: false,
      month: "2026-08",
    }).reps[0]?.repName,
    "Adel.Srour ( Down-town / C )",
    "a failed directory read falls back to the CRM handle rather than taking the board down",
  );

  // ── tile tone: a colour is a CLAIM about the number under it ───────────────────────────────
  // Both bugs this replaced were the same shape — a threshold that could only ever say "fine".
  assert.equal(shareTone((5 / 87) * 100), "rose", "5 reps of 87 on target is not good news");
  assert.equal(shareTone(0), "rose");
  assert.equal(shareTone(29.9), "rose");
  assert.equal(shareTone(30), "amber");
  assert.equal(shareTone(69.9), "amber");
  assert.equal(shareTone(70), "emerald");
  assert.equal(shareTone(null), undefined, "no number, no claim");

  assert.equal(riskTone(17), "amber", "17% unproven is the number that shipped green");
  assert.notEqual(riskTone(17), "emerald", "and it must never be the same colour as proved work");
  assert.equal(riskTone(9.9), "emerald");
  assert.equal(riskTone(10), "amber");
  assert.equal(riskTone(24.9), "amber");
  assert.equal(riskTone(25), "rose");
  assert.equal(riskTone(100), "rose");
  assert.equal(riskTone(null), undefined);

  // Attainment keeps its own scale: 100% is the standard here, not a stretch.
  assert.equal(attainmentTone(100), "emerald");
  assert.equal(attainmentTone(99.9), "amber");
  assert.equal(attainmentTone(70), "amber");
  assert.equal(attainmentTone(69.9), "rose");
  assert.equal(attainmentTone(null), undefined);

  // ── Source contract ──────────────────────────────────────────────────────────────────
  // This board is the THIRD reader of the CRM's territory pattern, after Doctor Coverage and the
  // mobile card. #2491 moved the regex to src/lib/crm/rep-name.ts for exactly that reason, and its
  // own test pins coverage to import it — this pins the same thing here, because the copy this
  // board briefly carried is precisely what that extraction existed to prevent. Two copies is how
  // two boards start disagreeing about what a territory is.
  const boardSource = readFileSync("src/lib/crm/reps-plans.ts", "utf8");
  assert.ok(
    boardSource.includes('import { crmTerritoryFrom } from "@/lib/crm/rep-name";'),
    "Reps Plans must IMPORT the shared territory splitter, never carry its own copy of the pattern",
  );
  assert.ok(
    !boardSource.includes("const CRM_TERRITORY ="),
    "and it must not re-declare the pattern locally",
  );
}
