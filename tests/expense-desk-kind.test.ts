/**
 * Expense Approvals — THE KIND FILTER, THE TRIP-DATE FILTER AND THE THURSDAY FLAG, pinned.
 *
 * Owner, 2026-11-23: "I want to be able to filter by, for example, meeting, for example, other, for
 * example, traveling. And I want you to flag any meeting that is not on Thursday." and, minutes
 * later, "AND FILTER BY PERIOD OR MONTH OR DATE".
 *
 *   1. A claim's kind is its own expense type: Traveling, Meeting or Other. A type nobody
 *      recognises is Traveling — checked as a trip, never excused as a cost.
 *   2. Meetings are held on a Thursday. A claimed meeting on another day FAILS its check, in words.
 *      A claim of several days passes when one of its days is a Thursday.
 *   3. 🔴 The flag is a flag: it files the claim in Your call and never rejects it. A Traveling
 *      claim with a meeting amount on a Wednesday is no longer Ready; the same claim on a Thursday is.
 *   4. The kind and the trip dates live in the address and narrow a waiting lane; the figure on a
 *      kind button is read from the lane before the kind narrows it.
 *   5. A month is its first day to its last; one day is From and To the same; a trip of several
 *      days is in a period when any of its days is; From after To is read the other way round.
 *   6. "Not a Thursday" is offered as a one-press reason only when that check failed.
 *   7. The claim the server sends carries its kind, and the meeting amount is the one payroll reads.
 *   8. History filters on the server (it is read a page at a time): the kind and the trip dates
 *      reach the query, and the page draws both filters.
 */
import assert from "node:assert/strict";
import fs from "node:fs";

import { judgeClaim, runClaimChecks, CHECK_LABEL, type ClaimCheckFacts, type FieldWorkDay } from "@/lib/outstation/approvals/checks";
import { ALL_KINDS_LABEL, CLAIM_KINDS, CLAIM_KIND_LABEL, claimKindFilter, claimKindFromParam, claimKindOf, kindCounts } from "@/lib/outstation/approvals/claim-kind";
import { buildDeskClaim, DESK_CLAIM_COLUMNS, type ClaimRow } from "@/lib/outstation/approvals/claim-row";
import { DEFAULT_DESK_VIEW, claimsInLane, deskViewFromSearch, deskViewToSearch, reasonChips } from "@/lib/outstation/approvals/desk-view";
import { MEETING_WEEKDAY, isMeetingDay, meetingDayVerdict, weekdayOf } from "@/lib/outstation/approvals/meeting-day";
import {
  NO_PERIOD,
  claimInPeriod,
  dayAfter,
  dayParam,
  hasPeriod,
  monthLabel,
  monthPeriod,
  periodMonth,
  periodWords,
  recentMonths,
  tripPeriodOf,
  withFrom,
  withTo,
} from "@/lib/outstation/approvals/trip-period";
import type { ClaimCheck, ClaimKind, DeskClaim } from "@/lib/outstation/approvals/types";

const day = (date: string): FieldWorkDay => ({ atDestination: true, beforePhoenix: false, date, meetings: 0, positioned: true, visits: 4 });

/** A District Manager's one-day car trip, everything in order, read on 23 Nov. */
function facts(date: string, over: Partial<ClaimCheckFacts> = {}): ClaimCheckFacts {
  return {
    arrival: { capturedOn: date, hasPosition: true, onFile: true, uploaded: false },
    attachments: 0,
    departure: { capturedOn: date, flags: [], hasPosition: true, kmFromArrival: 1.2, minutesAfterArrival: 240, onFile: true },
    duplicateTickets: [],
    duplicateTrips: [],
    eligibilityReason: null,
    eligibilityStatus: "eligible",
    evidenceGateStatus: "complete",
    expenseType: "traveling",
    fieldWork: { days: [day(date)], homeDays: [], km: null },
    hasNoTicketFare: false,
    role: "District Manager",
    today: "2026-11-23",
    transportation: "car",
    tripDates: [date],
    ...over,
  };
}

const WEDNESDAY = "2026-11-18";
const THURSDAY = "2026-11-19";

function claim(requestId: number, over: Partial<DeskClaim> = {}): DeskClaim {
  return {
    allowance: 200,
    approvedAmount: null,
    daysWaiting: 2,
    decidedAt: null,
    employeeName: `Employee ${requestId}`,
    employeeNote: null,
    employeeRole: "District Manager",
    from: "Cairo",
    holdReason: null,
    hrComment: "",
    hrId: null,
    kind: "traveling",
    locked: false,
    payable: 500,
    payoutMonth: 11,
    payoutYear: 2026,
    preCut: null,
    relatedRequestIds: [],
    requestId,
    revision: `rev-${requestId}`,
    standing: "waiting",
    submittedAt: "2026-11-20T08:00:00.000Z",
    systemNote: null,
    to: "Asyut",
    total: 500,
    transportation: "car",
    tripEnd: THURSDAY,
    tripId: `OUTSTATION-${requestId}`,
    tripStart: THURSDAY,
    tripType: "traveling",
    verdict: { checks: [], idleDates: [], lane: "ready", reason: null },
    ...over,
  } as DeskClaim;
}

const ids = (claims: ReadonlyArray<DeskClaim>) => claims.map((entry) => entry.requestId);
const code = (file: string) => fs.readFileSync(file, "utf8");

export function runExpenseDeskKindTests() {
  // 1. The kind is the claim's own expense type.
  assert.deepEqual([...CLAIM_KINDS], ["traveling", "meeting", "other"], "the order the filter prints them in");
  assert.deepEqual(CLAIM_KIND_LABEL, { meeting: "Meeting", other: "Other", traveling: "Traveling" });
  assert.equal(ALL_KINDS_LABEL, "All kinds");
  assert.equal(claimKindOf("meeting"), "meeting");
  assert.equal(claimKindOf(" Other "), "other");
  assert.equal(claimKindOf("traveling"), "traveling");
  assert.equal(claimKindOf(null), "traveling", "HEADLINE: a claim with no type is checked as a trip, never excused as a cost");
  assert.equal(claimKindOf("conference"), "traveling");
  assert.equal(claimKindFromParam("MEETING"), "meeting");
  assert.equal(claimKindFromParam("paid"), null, "junk in the address filters nothing");
  assert.equal(claimKindFromParam(null), null);
  assert.deepEqual(kindCounts([{ kind: "meeting" }, { kind: "other" }, { kind: "traveling" }, { kind: "traveling" }, {}]), { meeting: 1, other: 1, traveling: 3 });
  assert.deepEqual(claimKindFilter("meeting"), { column: "expense_type", pattern: "meeting" });
  assert.deepEqual(claimKindFilter("other"), { column: "expense_type", pattern: "other" });
  assert.deepEqual(
    claimKindFilter("traveling"),
    { or: "expense_type.is.null,and(expense_type.not.ilike.meeting,expense_type.not.ilike.other)" },
    "Traveling is every stored type that is not one of the other two, an empty one included — the same rule as claimKindOf",
  );

  // 2. Meetings are held on a Thursday.
  assert.equal(MEETING_WEEKDAY, 4);
  assert.equal(weekdayOf(THURSDAY), 4);
  assert.equal(weekdayOf("2026-11-23"), 1, "23 Nov 2026 is a Monday");
  assert.equal(weekdayOf("2026-02-31"), null, "a day that does not exist has no weekday");
  assert.equal(isMeetingDay(THURSDAY), true);
  assert.equal(isMeetingDay(WEDNESDAY), false);
  assert.equal(meetingDayVerdict({ dates: [WEDNESDAY], kind: "traveling", meetingCost: 0 }), null, "a trip that claims no meeting has no Thursday line");
  assert.equal(meetingDayVerdict({ dates: [WEDNESDAY], kind: "other", meetingCost: 0 }), null);
  assert.deepEqual(meetingDayVerdict({ dates: [THURSDAY], kind: "meeting", meetingCost: 0 }), { answer: "pass", sentence: "The meeting was on Thursday 19 Nov." });
  assert.deepEqual(
    meetingDayVerdict({ dates: ["2026-11-02"], kind: "meeting", meetingCost: 150 }),
    { answer: "fail", sentence: "The meeting was on Monday 2 Nov, not a Thursday." },
    "HEADLINE: a meeting on any other day fails, with the day in words",
  );
  assert.deepEqual(
    meetingDayVerdict({ dates: ["2026-11-02"], kind: "traveling", meetingCost: 150 }),
    { answer: "fail", sentence: "A meeting cost of EGP 150 was claimed on Monday 2 Nov, not a Thursday." },
    "a trip that carries a meeting amount is held to the same rule",
  );
  assert.equal(meetingDayVerdict({ dates: [THURSDAY], kind: "other", meetingCost: 140 })?.answer, "pass");
  assert.equal(
    meetingDayVerdict({ dates: [WEDNESDAY, THURSDAY, "2026-11-20"], kind: "traveling", meetingCost: 100 })?.answer,
    "pass",
    "a claim of several days does not say which day the meeting was, so one Thursday among them passes",
  );
  assert.deepEqual(meetingDayVerdict({ dates: ["2026-11-10", "2026-11-11"], kind: "traveling", meetingCost: 100 }), {
    answer: "fail",
    sentence: "A meeting cost of EGP 100 was claimed for 10 Nov to 11 Nov, with no Thursday among the 2 days.",
  });
  assert.equal(meetingDayVerdict({ dates: [], kind: "meeting", meetingCost: 0 })?.answer, "unknown", "no readable day is never a pass");

  // 3. The flag files the claim in Your call; it never rejects.
  const clean = judgeClaim(facts(WEDNESDAY));
  assert.equal(clean.lane, "ready");
  assert.ok(!clean.checks.some((entry) => entry.key === "meeting_day"), "a trip with no meeting amount has no Thursday line");
  const flagged = judgeClaim(facts(WEDNESDAY, { meetingCost: 150 }));
  assert.equal(flagged.lane, "your_call", "HEADLINE: a meeting cost claimed on a Wednesday is never Ready");
  assert.equal(flagged.reason, "A meeting cost of EGP 150 was claimed on Wednesday 18 Nov, not a Thursday.");
  const line = flagged.checks.find((entry) => entry.key === "meeting_day");
  assert.equal(line?.answer, "fail");
  assert.equal(line?.label, CHECK_LABEL.meeting_day);
  assert.equal(CHECK_LABEL.meeting_day, "Meeting day");
  const onThursday = judgeClaim(facts(THURSDAY, { meetingCost: 150 }));
  assert.equal(onThursday.lane, "ready", "the same claim on a Thursday passes every check");
  assert.equal(onThursday.checks.find((entry) => entry.key === "meeting_day")?.answer, "pass");
  const meeting = judgeClaim(facts(WEDNESDAY, { attachments: 1, expenseType: "meeting" }));
  assert.deepEqual(meeting.checks.map((entry) => entry.key), ["duplicate", "meeting_day", "amounts"]);
  assert.equal(meeting.reason, "The meeting was on Wednesday 18 Nov, not a Thursday.", "the Thursday sentence is the reason the row wears, ahead of 'read the invoice'");
  assert.equal(judgeClaim(facts(THURSDAY, { attachments: 1, expenseType: "meeting" })).reason, "A meeting or other cost: the amount is the employee's, so read the invoice.");
  assert.ok(!runClaimChecks(facts(WEDNESDAY, { attachments: 1, expenseType: "other" })).some((entry) => entry.key === "meeting_day"), "an Other claim with no meeting amount is not a meeting");

  // 4. The kind and the trip dates live in the address and narrow a waiting lane.
  assert.equal(DEFAULT_DESK_VIEW.kind, null);
  assert.equal(DEFAULT_DESK_VIEW.from, null);
  assert.equal(DEFAULT_DESK_VIEW.to, null);
  const view = { ...DEFAULT_DESK_VIEW, from: "2026-11-01", kind: "meeting" as ClaimKind, to: "2026-11-30" };
  assert.equal(deskViewToSearch(view), "?kind=meeting&from=2026-11-01&to=2026-11-30");
  assert.deepEqual(deskViewFromSearch(deskViewToSearch(view)), view, "a reload opens the same list");
  assert.deepEqual(deskViewFromSearch("?kind=paid&from=2026-02-31&to=soon"), DEFAULT_DESK_VIEW, "junk in the address filters nothing");
  assert.deepEqual(
    [deskViewFromSearch("?from=2026-11-30&to=2026-11-01").from, deskViewFromSearch("?from=2026-11-30&to=2026-11-01").to],
    ["2026-11-01", "2026-11-30"],
    "From after To is read the other way round",
  );
  const lane = [
    claim(1),
    claim(2, { kind: "meeting", tripEnd: "2026-11-12", tripStart: "2026-11-12" }),
    claim(3, { kind: "other", tripEnd: "2026-10-28", tripStart: "2026-10-28" }),
    claim(4, { tripEnd: "2026-11-02", tripStart: "2026-10-30" }),
  ];
  const none = { overSevenDays: false, search: "" };
  assert.deepEqual(ids(claimsInLane(lane, "ready", none)), [1, 2, 3, 4]);
  assert.deepEqual(ids(claimsInLane(lane, "ready", { ...none, kind: "meeting" })), [2], "HEADLINE: Meeting shows the meeting claims and nothing else");
  assert.deepEqual(ids(claimsInLane(lane, "ready", { ...none, kind: "other" })), [3]);
  assert.deepEqual(ids(claimsInLane(lane, "ready", { ...none, kind: "traveling" })), [1, 4]);
  assert.deepEqual(ids(claimsInLane(lane, "ready", { ...none, from: "2026-11-01", to: "2026-11-30" })), [1, 2, 4], "HEADLINE: November lists every trip with a day in November");
  assert.deepEqual(ids(claimsInLane(lane, "ready", { ...none, from: "2026-10-01", to: "2026-10-31" })), [3, 4], "a trip that began in October and ended in November is in both months");
  assert.deepEqual(ids(claimsInLane(lane, "ready", { ...none, from: "2026-11-12", to: "2026-11-12" })), [2], "one day");
  assert.deepEqual(ids(claimsInLane(lane, "ready", { ...none, from: "2026-11-12" })), [1, 2], "an open end");
  assert.deepEqual(ids(claimsInLane(lane, "ready", { ...none, to: "2026-10-29" })), [3]);
  assert.deepEqual(ids(claimsInLane(lane, "ready", { ...none, from: "2026-11-30", to: "2026-11-01" })), [1, 2, 4], "a reversed pair narrows the same as the pair in order");
  assert.deepEqual(ids(claimsInLane(lane, "ready", { ...none, from: "2026-11-01", kind: "traveling", to: "2026-11-30" })), [1, 4], "the kind and the dates narrow together");
  assert.deepEqual(
    kindCounts(claimsInLane(lane, "ready", { ...none, from: "2026-11-01", kind: null, to: "2026-11-30" })),
    { meeting: 1, other: 0, traveling: 2 },
    "the figure on a kind button is the lane as the dates leave it, before the kind narrows it",
  );

  // 5. The period.
  assert.equal(dayParam("2026-11-23"), "2026-11-23");
  assert.equal(dayParam("2026-02-31"), null);
  assert.equal(dayParam("23/11/2026"), null);
  assert.deepEqual(tripPeriodOf(null, undefined), NO_PERIOD);
  assert.equal(hasPeriod(NO_PERIOD), false);
  assert.equal(hasPeriod({ from: null, to: "2026-11-01" }), true);
  assert.deepEqual(monthPeriod("2026-11"), { from: "2026-11-01", to: "2026-11-30" });
  assert.deepEqual(monthPeriod("2028-02"), { from: "2028-02-01", to: "2028-02-29" }, "a leap February");
  assert.equal(monthPeriod("2026-13"), null);
  assert.equal(monthPeriod(""), null);
  assert.equal(periodMonth({ from: "2026-11-01", to: "2026-11-30" }), "2026-11");
  assert.equal(periodMonth({ from: "2026-11-01", to: "2026-11-29" }), null);
  assert.equal(periodMonth({ from: "2026-11-01", to: null }), null);
  assert.equal(monthLabel("2026-11"), "November 2026");
  assert.deepEqual(recentMonths("2026-11-23", 3), ["2026-11", "2026-10", "2026-09"]);
  assert.deepEqual(recentMonths("2027-01-31", 3), ["2027-01", "2026-12", "2026-11"], "over a year's end, and from a 31st");
  assert.equal(recentMonths("2026-11-23").length, 12);
  assert.equal(dayAfter("2026-11-30"), "2026-12-01");
  assert.equal(dayAfter("2026-12-31"), "2027-01-01");
  assert.deepEqual(withFrom(NO_PERIOD, "2026-11-12"), { from: "2026-11-12", to: "2026-11-12" }, "HEADLINE: one pick of From is that one day");
  assert.deepEqual(withFrom({ from: "2026-11-01", to: "2026-11-30" }, "2026-11-12"), { from: "2026-11-12", to: "2026-11-30" }, "a To already chosen is kept");
  assert.deepEqual(withFrom({ from: "2026-11-01", to: "2026-11-05" }, "2026-11-12"), { from: "2026-11-12", to: "2026-11-12" }, "a To left behind follows From");
  assert.deepEqual(withFrom({ from: "2026-11-01", to: "2026-11-30" }, ""), { from: null, to: "2026-11-30" });
  assert.deepEqual(withTo({ from: "2026-11-12", to: "2026-11-12" }, "2026-11-20"), { from: "2026-11-12", to: "2026-11-20" });
  assert.deepEqual(withTo({ from: "2026-11-12", to: "2026-11-20" }, "2026-11-05"), { from: "2026-11-12", to: "2026-11-05" }, "a To before From leaves From alone; the pair is read the other way round");
  assert.deepEqual(withTo({ from: "2026-11-12", to: "2026-11-20" }, "0202-11-20"), { from: "2026-11-12", to: null }, "a year still being typed is not a day yet");
  assert.deepEqual(withFrom({ from: null, to: "2026-11-20" }, "0002-11-12"), { from: null, to: "2026-11-20" });
  assert.equal(dayParam("0202-11-20"), null);
  assert.deepEqual(withTo({ from: "2026-11-12", to: "2026-11-20" }, ""), { from: "2026-11-12", to: null });
  assert.equal(claimInPeriod({ tripEnd: "2026-11-02", tripStart: "2026-10-30" }, NO_PERIOD), true);
  assert.equal(claimInPeriod({ tripEnd: "2026-11-02", tripStart: "2026-10-30" }, { from: "2026-11-02", to: "2026-11-02" }), true, "the last day of a trip counts");
  assert.equal(claimInPeriod({ tripEnd: "2026-11-02", tripStart: "2026-10-30" }, { from: "2026-11-03", to: null }), false);
  assert.equal(claimInPeriod({ tripEnd: "", tripStart: "2026-11-12" }, { from: "2026-11-12", to: "2026-11-12" }), true, "a trip with no end day is its one day");
  assert.equal(claimInPeriod({ tripEnd: "", tripStart: "" }, { from: "2026-11-12", to: null }), false, "a trip with no readable day is in no period");
  assert.equal(periodWords(NO_PERIOD), "");
  assert.equal(periodWords({ from: "2026-11-01", to: "2026-11-30" }), "November 2026");
  assert.equal(periodWords({ from: "2026-11-12", to: "2026-11-12" }), "12 Nov 2026");
  assert.equal(periodWords({ from: "2026-11-12", to: "2026-11-20" }), "12 Nov 2026 to 20 Nov 2026");
  assert.equal(periodWords({ from: "2026-11-12", to: null }), "12 Nov 2026 onward");
  assert.equal(periodWords({ from: null, to: "2026-11-20" }), "up to 20 Nov 2026");

  // 6. The one-press reason.
  const failedMeeting: ClaimCheck = { answer: "fail", key: "meeting_day", label: "Meeting day", sentence: "The meeting was on Monday 2 Nov, not a Thursday." };
  const chips = reasonChips(claim(9, { verdict: { checks: [failedMeeting], idleDates: [], lane: "your_call", reason: failedMeeting.sentence } }));
  assert.deepEqual(chips, [{ key: "meeting-day", label: "Not a Thursday", text: "The meeting on this claim was not held on a Thursday." }]);
  assert.deepEqual(
    reasonChips(claim(9, { verdict: { checks: [{ ...failedMeeting, answer: "pass" }], idleDates: [], lane: "ready", reason: null } })),
    [],
    "never offered on a claim whose meeting was on a Thursday",
  );

  // 7. The claim the server sends.
  const row = (over: ClaimRow = {}): ClaimRow => ({
    created_at: "2026-11-13T08:00:00.000Z",
    employee_hr_id: "PD-0015",
    employee_name: "Stored Name",
    employee_role: "District Manager",
    expected_total_amount: 400,
    expense_type: "traveling",
    id: 501,
    status: "submitted",
    to_label: "Asyut 2",
    transportation_type: "car",
    trip_end_date: "2026-11-10",
    trip_start_date: "2026-11-09",
    updated_at: "2026-11-13T08:05:00.000Z",
    ...over,
  });
  const context = { today: "2026-11-23" };
  const now = new Date("2026-11-23T08:00:00.000Z");
  const built = (over: ClaimRow = {}) => buildDeskClaim({ context, ledger: null, now, row: row(over) });
  assert.equal(built().kind, "traveling");
  assert.equal(built({ expense_type: "meeting" }).kind, "meeting");
  assert.equal(built({ expense_type: "other" }).kind, "other");
  assert.ok(!built().verdict.checks.some((entry) => entry.key === "meeting_day"));
  assert.equal(
    built({ meeting_amount: 100 }).verdict.checks.find((entry) => entry.key === "meeting_day")?.sentence,
    "A meeting cost of EGP 100 was claimed for 9 Nov to 10 Nov, with no Thursday among the 2 days.",
    "HEADLINE: the meeting amount on the stored claim reaches the Thursday check",
  );
  assert.ok(
    !built({ meeting_amount: 100, report_meeting_amount: 0 }).verdict.checks.some((entry) => entry.key === "meeting_day"),
    "the amount is the one payroll reads: a meeting amount already set to zero on review claims no meeting",
  );
  assert.equal(built({ expense_type: "meeting", trip_end_date: "2026-11-12", trip_start_date: "2026-11-12" }).verdict.checks.find((entry) => entry.key === "meeting_day")?.answer, "pass");
  for (const column of ["expense_type", "meeting_amount", "report_meeting_amount", "trip_start_date", "trip_end_date"]) {
    assert.ok(DESK_CLAIM_COLUMNS.split(", ").includes(column), `the desk reads ${column}`);
  }

  // 8. History filters on the server, and the page draws both filters.
  const history = code("src/lib/outstation/approvals/history.ts");
  assert.match(history, /const kindFilter = options\.kind \? claimKindFilter\(options\.kind\) : null;/);
  assert.match(history, /query = query\.or\(kindFilter\.or\)/);
  assert.match(history, /query = query\.ilike\(kindFilter\.column, kindFilter\.pattern\)/);
  assert.match(history, /const period = tripPeriodOf\(options\.from, options\.to\);/);
  assert.match(history, /if \(period\.from\) query = query\.gte\("trip_end_date", period\.from\);/, "a trip is in the period when it ENDED on or after From");
  assert.match(history, /if \(period\.to\) query = query\.lt\("trip_start_date", dayAfter\(period\.to\)\);/, "and BEGAN on or before To");
  const route = code("app/api/admin/outstation/approvals/history/route.ts");
  assert.match(route, /kind: claimKindFromParam\(url\.searchParams\.get\("kind"\)\)/);
  assert.match(route, /from: url\.searchParams\.get\("from"\)/);
  assert.match(route, /to: url\.searchParams\.get\("to"\)/);
  assert.ok(route.indexOf("assertOutstationExpenseApprovalReviewAccess") < route.indexOf("loadDeskHistory(access"), "the permission is checked before the read");
  const workspace = code("src/components/outstation/approvals-desk/desk-workspace.tsx");
  assert.match(workspace, /<DeskKindFilter counts=\{kinds\} kind=\{view\.kind\} onChoose=\{\(kind\) => desk\.setView\(\{ kind \}\)\} \/>/);
  assert.match(workspace, /<DeskPeriodFilter onChoose=\{\(period\) => desk\.setView\(period\)\} period=\{\{ from: view\.from, to: view\.to \}\} \/>/);
  assert.match(workspace, /kindCounts\(claimsInLane\(queue\.claims, lane, \{ \.\.\.view, kind: null \}\)\)/);
  assert.match(workspace, /<DeskHistory\s[\s\S]{0,60}?choice=\{view\.history\}\s+from=\{view\.from\}\s+kind=\{view\.kind\}\s[\s\S]{0,260}?\sto=\{view\.to\}\s/);
  const historyScreen = code("src/components/outstation/approvals-desk/desk-history.tsx");
  for (const param of ['params.set("kind", kind)', 'params.set("from", from)', 'params.set("to", to)']) {
    assert.ok(historyScreen.includes(param), `the History read carries ${param}`);
  }
  const kindFilter = code("src/components/outstation/approvals-desk/desk-kind-filter.tsx");
  assert.match(kindFilter, /aria-pressed=\{kind === entry\.key\}/);
  assert.match(kindFilter, /ALL_KINDS_LABEL/);
  const periodFilter = code("src/components/outstation/approvals-desk/desk-period-filter.tsx");
  assert.match(periodFilter, /onChoose\(monthPeriod\(event\.target\.value\) \?\? NO_PERIOD\)/);
  assert.match(periodFilter, /onChoose\(withFrom\(period, event\.target\.value\)\)/);
  assert.match(periodFilter, /onChoose\(withTo\(period, event\.target\.value\)\)/);
  assert.equal((periodFilter.match(/type="date"/g) ?? []).length, 2, "From and To");
}
