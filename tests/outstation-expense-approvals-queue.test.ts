import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  compareExpenseApprovalTrips,
  expenseTripAwaitingLabel,
  expenseTripDaysAwaiting,
  expenseTripTriage,
  liveWorkloadMatchStatus,
  matchesExpenseTripTriage,
  withLiveWorkloadStatus,
} from "../src/lib/outstation/expense-approval-triage.ts";
import {
  countActiveExpenseApprovalFilters,
  matchesExpenseApprovalFilters,
  parseExpenseTripTriageFilter,
} from "../src/lib/outstation/expense-approval-filters.ts";
import { idleDayDeductionSuggestions, reasonAfterIdleDayPick } from "../src/lib/outstation/idle-day-deduction.ts";
import { mapOutstationRequestRowToPayrollApproval } from "../src/lib/outstation/payroll-expense-mapping.ts";
import { stripComments } from "./support/comment-strip.ts";

// Expense Approvals, working the queue (owner, 2026-11-07 ~01:45, choosing from the enhancements
// offered): "Rail filter: Needs a look / Clean", "Suggested deduction for idle days",
// "Decide-and-advance", and "Oldest first + awaiting N days". On the idle-day rule he answered
// "LET ME DECIDE": the screen OFFERS the allowance share; later that night he chose "Approver sees
// it pre-cut" — Approve applies the per-idle-day share unless he keeps the full claim
// (tests/outstation-crm-trip-evidence.test.ts pins the pre-cut).

export function runOutstationExpenseApprovalsQueueTests() {
  // ── 1. Needs a look / Clean ─────────────────────────────────────────────────────────────────
  assert.deepEqual(expenseTripTriage({ departurePhotoFlagged: false, workloadMatchStatus: "matched" }), {
    reasons: [],
    triage: "clean",
  }, "HEADLINE: every day matched and an unflagged photo is clean");
  assert.deepEqual(expenseTripTriage({ departurePhotoFlagged: true, workloadMatchStatus: "matched" })?.reasons, [
    "Departure photo flagged",
  ]);
  assert.deepEqual(expenseTripTriage({ departurePhotoFlagged: false, workloadMatchStatus: "no_activity" })?.reasons, [
    "No field activity",
  ]);
  assert.deepEqual(expenseTripTriage({ departurePhotoFlagged: true, workloadMatchStatus: "partial" })?.reasons, [
    "Some days without field activity",
    "Departure photo flagged",
  ]);
  for (const unverified of ["manual", "manual_override", "stale_import"]) {
    assert.equal(
      expenseTripTriage({ departurePhotoFlagged: false, workloadMatchStatus: unverified })?.triage,
      "look",
      `HEADLINE: unknown is never clean — a "${unverified}" workload needs a look`,
    );
  }
  assert.equal(expenseTripTriage({}), null, "an imported row has no reading at all, never a quiet clean");
  // Owner's review, 2026-11-07: the trip's own photo tile warned "No GPS location" while the rail
  // filed the same trip as Clean. A departure photo with no position needs a look.
  assert.deepEqual(
    expenseTripTriage({ departurePhotoFlagged: false, departurePhotoNoGps: true, workloadMatchStatus: "matched" }),
    { reasons: ["Departure photo has no GPS"], triage: "look" },
    "HEADLINE: a departure photo with no GPS is never Clean",
  );
  assert.deepEqual(
    expenseTripTriage({ departurePhotoFlagged: true, departurePhotoNoGps: true, workloadMatchStatus: "matched" })?.reasons,
    ["Departure photo flagged"],
    "a flagged photo names the flag once, not both",
  );
  // ...and an opened trip's live day-by-day read outranks the stored stamp: a conference day is
  // worked (trip-day-meetings.ts), so the rail stops reading "No field activity" for it.
  assert.equal(liveWorkloadMatchStatus({ idleDays: 0, tripDays: 2 }), "matched", "HEADLINE: no idle day reads as matched");
  assert.equal(liveWorkloadMatchStatus({ idleDays: 1, tripDays: 2 }), "partial");
  assert.equal(liveWorkloadMatchStatus({ idleDays: 2, tripDays: 2 }), "no_activity");
  assert.equal(liveWorkloadMatchStatus(null), null, "no live read leaves the stored stamp");
  assert.equal(liveWorkloadMatchStatus({ idleDays: 0, tripDays: 0 }), null, "an empty read leaves it too");
  const stored = [
    { tripId: "OUTSTATION-1", workloadMatchStatus: "no_activity" },
    { tripId: "OUTSTATION-2", workloadMatchStatus: "no_activity" },
  ];
  const live = withLiveWorkloadStatus(stored, { "OUTSTATION-1": { idleDays: 0, tripDays: 1 } });
  assert.equal(live[0].workloadMatchStatus, "matched", "HEADLINE: the opened trip takes its live answer");
  assert.equal(expenseTripTriage(live[0])?.triage, "clean", "and leaves Needs a look");
  assert.equal(live[1], stored[1], "an unopened trip keeps its stored row untouched");
  assert.equal(withLiveWorkloadStatus(stored, {}), stored, "nothing opened, the same array — no re-render churn");
  assert.equal(matchesExpenseTripTriage({}, ""), true, "an imported row still shows under All");
  assert.equal(matchesExpenseTripTriage({}, "clean"), false);
  assert.equal(matchesExpenseTripTriage({}, "look"), false);

  // The rail's choice is a filter like the month and the employee: counted, and read strictly from the export URL.
  const trip = { date: "2026-10-10", departurePhotoFlagged: true, specialist: "Mona Khaled", workloadMatchStatus: "matched" };
  assert.equal(matchesExpenseApprovalFilters(trip, { employee: "", month: "", triage: "look" }), true);
  assert.equal(matchesExpenseApprovalFilters(trip, { employee: "", month: "", triage: "clean" }), false);
  assert.equal(matchesExpenseApprovalFilters(trip, { employee: "", month: "" }), true, "no triage key narrows nothing");
  assert.equal(countActiveExpenseApprovalFilters({ employee: "", month: "", sort: "oldest", triage: "look" }), 1, "the order is never counted as a filter");
  assert.equal(parseExpenseTripTriageFilter("look"), "look");
  assert.equal(parseExpenseTripTriageFilter("anything"), "", "an unknown export value narrows nothing");

  // The fields come from the request row the queue already loads (`select("*")`), read-side only.
  const mapped = mapOutstationRequestRowToPayrollApproval({
    created_at: "2026-10-16T09:00:00.000Z",
    departure_evidence_metadata: { flags: ["far_from_arrival"] },
    employee_name: "Mona Khaled",
    id: 5088,
    status: "submitted",
    trip_start_date: "2026-10-10",
    workload_match_status: "partial",
  });
  assert.equal(mapped.submittedAt, "2026-10-16T09:00:00.000Z", "HEADLINE: the wait is counted from the submission");
  assert.equal(mapped.departurePhotoFlagged, true, "HEADLINE: a stored departure-photo flag reaches the rail");
  assert.equal(mapped.workloadMatchStatus, "partial");
  const bare = mapOutstationRequestRowToPayrollApproval({ employee_name: "Mona Khaled", id: 5089, status: "submitted" });
  assert.equal(bare.departurePhotoFlagged, false);
  assert.equal(bare.workloadMatchStatus, "manual", "the same \"manual\" fallback the request read uses");

  // ── 2. Oldest first + awaiting N days ──────────────────────────────────────────────────────
  const now = Date.parse("2026-11-07T10:00:00.000Z");
  assert.equal(expenseTripDaysAwaiting("2026-10-31T10:00:00.000Z", now), 7);
  assert.equal(expenseTripDaysAwaiting("2026-11-07T08:00:00.000Z", now), 0);
  assert.equal(expenseTripDaysAwaiting("", now), null, "no submission time is no wait shown, never zero");
  assert.equal(expenseTripDaysAwaiting("not a date", now), null);
  assert.equal(expenseTripAwaitingLabel(0), "Submitted today");
  assert.equal(expenseTripAwaitingLabel(1), "Awaiting 1 day");
  assert.equal(expenseTripAwaitingLabel(7), "Awaiting 7 days");

  const queue = [
    { submittedAt: "2026-10-20T00:00:00.000Z", total: 900, tripId: "newer-big" },
    { submittedAt: undefined, total: 5000, tripId: "undated" },
    { submittedAt: "2026-10-01T00:00:00.000Z", total: 100, tripId: "oldest-small" },
  ];
  assert.deepEqual(
    [...queue].sort(compareExpenseApprovalTrips("oldest")).map((row) => row.tripId),
    ["oldest-small", "newer-big", "undated"],
    "HEADLINE: Oldest first puts the longest wait on top, and an undated row after every dated one",
  );
  assert.deepEqual(
    [...queue].sort(compareExpenseApprovalTrips("value")).map((row) => row.tripId),
    ["undated", "newer-big", "oldest-small"],
    "Biggest first is the queue's long-standing order",
  );

  // ── 3. The idle-day deduction: offered, never applied ───────────────────────────────────────
  const offered = idleDayDeductionSuggestions({ allowance: 600, idleDays: 5, total: 1200, tripDays: 6 });
  assert.deepEqual(
    offered.map((row) => [row.key, row.deduction]),
    [["per-idle-day", 500], ["whole-allowance", 600]],
    "HEADLINE: per idle day is allowance ÷ trip days × idle days; the whole allowance is the other choice",
  );
  assert.match(offered[0].reason, /5 of 6 days with no field activity/);
  assert.deepEqual(
    idleDayDeductionSuggestions({ allowance: 600, idleDays: 3, total: 1200, tripDays: 3 }).map((row) => row.key),
    ["whole-allowance"],
    "every day idle: the two shares are one sum, so one choice",
  );
  assert.deepEqual(idleDayDeductionSuggestions({ allowance: 0, idleDays: 2, total: 900, tripDays: 3 }), [], "no allowance, nothing offered — travel is never deducted for an idle day");
  assert.deepEqual(idleDayDeductionSuggestions({ allowance: 600, idleDays: 0, total: 900, tripDays: 3 }), []);
  assert.equal(idleDayDeductionSuggestions({ allowance: 100, idleDays: 1, total: 900, tripDays: 3 })[0].deduction, 33.33, "rounded to piastres");
  assert.equal(idleDayDeductionSuggestions({ allowance: 800, idleDays: 2, total: 500, tripDays: 2 })[0].deduction, 500, "never more than the claim");

  // ── 4. The screen ───────────────────────────────────────────────────────────────────────────
  // Rebuilt from scratch on 2026-11-07 (expense-review/): the hook holds the state and the save, the
  // model the tabs and the next trip, the reviewer the decision.
  const dir = "src/components/outstation/expense-review";
  const workspace = stripComments(readFileSync(`${dir}/use-expense-review.ts`, "utf8"));
  const model = stripComments(readFileSync(`${dir}/review-model.ts`, "utf8"));
  const rail = stripComments(readFileSync(`${dir}/review-queue-table.tsx`, "utf8"));
  const filtersBar = stripComments(readFileSync(`${dir}/review-filters.tsx`, "utf8"));
  const review = stripComments(readFileSync(`${dir}/review-deck/deck-days.tsx`, "utf8"));
  const deck = stripComments(readFileSync(`${dir}/review-deck/deck.tsx`, "utf8"));
  const bar = stripComments(readFileSync(`${dir}/review-deck/deck-decision.tsx`, "utf8"));
  const exportRoute = stripComments(readFileSync("app/api/admin/outstation/expenses/export/route.ts", "utf8"));

  // Decide-and-advance: Approve and Reject open the next trip awaiting a decision; Save, Undo and the
  // amount never move the reviewer.
  const handler = (name: string) => workspace.match(new RegExp(`${name}: \\(\\) => \\{[\\s\\S]*?\\n {4}\\},`))?.[0] ?? "";
  assert.match(handler("onApprove"), /setDecision\(selected, \{ hrApproved: true, status: APPROVED_STATUS \}\);\s*selectNextPending\(selected\.tripId\);/, "HEADLINE: Approve opens the next trip awaiting a decision");
  assert.match(handler("onReject"), /setDecision\(selected, \{ hrApproved: false, status: REJECTED_STATUS \}\);\s*selectNextPending\(selected\.tripId\);/, "HEADLINE: Reject opens the next trip awaiting a decision");
  const stays = workspace.match(/onSave: [^\n]*\n[\s\S]*?onUnreject: [^\n]*/)?.[0] ?? "";
  assert.ok(stays.length > 0 && !/selectNextPending/.test(stays), "Save and the two Undos never move to another trip");
  assert.doesNotMatch(workspace.match(/onChangeAmount: [^\n]*/)?.[0] ?? "", /selectNextPending/);
  assert.match(workspace, /const next = nextAwaitingTrip\(deckRows, fromTripId, decisionFor\);/, "HEADLINE: the next trip is the next one waiting in the reviewer's own frozen walk");
  // ...and the walk is the list as sorted: one comparator for the tab, the roll-up and the walk.
  assert.match(workspace, /const byValue = compareExpenseApprovalTrips\(filters\.sort\);/);
  assert.match(model, /\(tab === "all" \? rank\(left\) - rank\(right\) : 0\) \|\| order\(left, right\)/, "HEADLINE: All trips ranks undecided first, then the reviewer's own order");
  // No key decides anything: the arrows walk, nothing else.
  assert.doesNotMatch(deck, /onApprove\(\)[^;]*key|key[^;]*onApprove\(\)/, "no keyboard shortcut approves");

  // The tabs carry the choice, each awaiting row its reasons and its wait.
  assert.match(model, /return expenseTripTriage\(record\)\?\.triage === tab;/, "HEADLINE: Needs a look and Clean are tabs, read from the one triage rule");
  assert.match(filtersBar, /Oldest first/);
  assert.match(rail, /const awaiting = state === "pending" && !imported;/, "only an awaiting trip carries its wait");
  // Owner, 2026-11-07: "show the system's findings on decided rows too".
  assert.match(rail, /const reading = imported \? null : expenseTripTriage\(record\);/, "HEADLINE: a decided row keeps what the system found — only history has none");
  assert.match(rail, /reading\?\.triage === "look"/);
  assert.match(rail, /expenseTripDaysAwaiting\(record\.submittedAt, actions\.now\)/, "HEADLINE: an awaiting row says how long it has waited");
  const workspaceFile = stripComments(readFileSync(`${dir}/expense-review-workspace.tsx`, "utf8"));
  assert.match(workspaceFile, /const \[now\] = useState\(\(\) => Date\.now\(\)\);/, "the clock is read once, never during render");
  assert.match(workspace, /const triage = exportTriageForTab\(tab\);[\s\S]*?if \(triage\) params\.set\("triage", triage\);/, "HEADLINE: the export narrows by the same tab");
  assert.match(exportRoute, /triage: parseExpenseTripTriageFilter\(url\.searchParams\.get\("triage"\)\)/);
  assert.match(workspace, /setFilters\(\(current\) => \(\{ \.\.\.NO_EXPENSE_APPROVAL_FILTERS, sort: current\.sort \}\)\)/, "Clear filters keeps the order");

  // The idle-day offer: lifted from the field-work read, shown in the decision box, applied only on a click.
  assert.match(review, /onIdleDays\(record\.tripId, \{ idleDays: days\.filter\(\(day\) => !isWorkedTripDay\(day\)\)\.length, tripDays: days\.length \}\)/, "HEADLINE: the field work hands up its idle days — a meeting day is worked, never idle (owner, 2026-11-07)");
  assert.match(review, /workload\.matchStatus === "unmapped"\) return;/, "no CRM identity is not an idle day");
  assert.match(deck, /onIdleDays=\{review\.recordIdleDays\}/);
  assert.match(deck, /const idle = review\.idleByTrip\[record\.tripId\] \?\? null;/);
  assert.match(bar, /!locked && undecided && idle \? idleDayDeductionSuggestions\(/, "HEADLINE: offered only on an undecided trip a decider can change");
  assert.match(bar, /onClick=\{\(\) => applySuggestion\(suggestion\)\}/, "a share is applied only by a click");
  // The reason a share writes (owner's review, 2026-11-07): the box opens holding the system's hold
  // sentence, so "fill an empty box only" meant the share's reason never landed.
  const reasons = ["Allowance deducted for the idle days: 2.", "Allowance deducted in full: 2."];
  const held = "Held: no field activity recorded.";
  assert.equal(reasonAfterIdleDayPick({ current: "", picked: reasons[0], reasons, systemText: held }), reasons[0], "an empty box takes the reason");
  assert.equal(
    reasonAfterIdleDayPick({ current: held, picked: reasons[0], reasons, systemText: held }),
    `${held}\n${reasons[0]}`,
    "HEADLINE: the system's sentence gets the share's reason on a new line under it",
  );
  assert.equal(
    reasonAfterIdleDayPick({ current: `${held}\n${reasons[0]}`, picked: reasons[1], reasons, systemText: held }),
    `${held}\n${reasons[1]}`,
    "picking the other share swaps the reason, never stacks two",
  );
  assert.equal(reasonAfterIdleDayPick({ current: reasons[0], picked: reasons[1], reasons, systemText: "" }), reasons[1]);
  assert.equal(
    reasonAfterIdleDayPick({ current: "Called him, he was at the clinic.", picked: reasons[0], reasons, systemText: held }),
    null,
    "HEADLINE: the reviewer's own reason is never written over",
  );
  assert.match(bar, /const next = reasonAfterIdleDayPick\(\{/, "the decision box uses that one rule");
  assert.match(bar, /if \(next !== null\) onChangeReason\(next\);/, "and leaves the reviewer's words alone on null");
  // Approve and Reject are two equal halves of the pinned bar; Save sits on its own line under them.
  assert.match(bar, /<div className="grid min-w-0 grid-cols-2 gap-2">\s*<CrmButton\s+data-approve-precut=\{[^}]*\}\s+data-deck-approve/, "HEADLINE: Approve and Reject take the whole width, side by side");
  assert.match(bar, /data-save-cluster/, "and Save has its own line");
  assert.doesNotMatch(bar, /useEffect\([^)]*applySuggestion|onChangeAmount\(approvedAmountFromDeduction\(record\.total, suggestions\[/, "nothing deducts on its own");
}
