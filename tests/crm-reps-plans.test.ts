import assert from "node:assert/strict";

import {
  AM_CALL_RATE_TARGET,
  PM_CALL_RATE_TARGET,
  computeCallRate,
  type CallRateReport,
  type CallRateSlice,
  type RepCallRate,
  type VisitForCallRate,
} from "../src/lib/crm/call-rate.ts";
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
    toRepsPlansRow(rep("Adel.Srour ( Down-town / C )", 20, {}, {}, { agentHrId: "HR-1", agentCrmId: 11 }), directory)
      .repName,
    "Adel Mahmoud Srour ( Down-town / C )",
    "the person comes from the directory, the territory from the CRM — and the hr id matched across case",
  );
  assert.equal(
    toRepsPlansRow(rep("Mervat.Fouad", 20, {}, {}, { agentHrId: "hr-3" }), directory).repName,
    "Mervat Fouad",
    "a CRM name with no trailing territory leaves just the real name — no empty brackets",
  );
  assert.equal(
    toRepsPlansRow(rep("Sameh.Shaaban ( Tanta / B )", 20, {}, {}, { agentHrId: "HR-99" }), directory).repName,
    "Sameh.Shaaban ( Tanta / B )",
    "no directory row keeps the CRM name whole — a name is not the place to start throwing",
  );
  assert.equal(
    toRepsPlansRow(rep("Mina.Farouk", 20, {}, {}, { agentCrmId: 44 }), directory).repName,
    "Mina.Farouk",
    "an agent with no hr id has nothing to look up",
  );
  assert.equal(
    toRepsPlansRow(rep("( Behira 2 / C )", 20, {}, {}, { agentHrId: "HR-1" }), directory).repName,
    "Adel Mahmoud Srour ( Behira 2 / C )",
    "the pathological row — a CRM name that is a territory and NOTHING else — gets a person",
  );
  assert.equal(
    toRepsPlansRow(rep("Ali (acting) Hassan", 20, {}, {}, { agentHrId: "HR-99" }), directory).repName,
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
}
