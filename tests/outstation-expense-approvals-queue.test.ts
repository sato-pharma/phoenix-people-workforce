import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { claimPreCut, verdictFromChecks } from "../src/lib/outstation/approvals/checks.ts";
import { approvePress, waitLabel } from "../src/lib/outstation/approvals/desk-view.ts";
import type { CheckKey, ClaimCheck, DeskClaim } from "../src/lib/outstation/approvals/types.ts";
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
  // Rebuilt from scratch on 2026-11-23 (approvals-desk/; owner: "REBUILD FROM SCRATCH", "Save at
  // once, with Undo"). The four things he chose on 7 Nov are all still on the page, in the shape
  // the new desk gives them:
  //
  //   Needs a look / Clean   → the two lanes, Your call and Ready, filed by the SERVER's checks;
  //   Decide-and-advance     → a press in the open trip moves to the next claim of the lane;
  //   Oldest first + wait    → the only order there is, with the wait on every waiting row;
  //   Idle-day deduction     → Approve names the pre-cut amount, "Keep full claim" beside it.
  //
  // Sections 1 and 2 above pin the older domain helpers, which the export route still reads.
  const dir = "src/components/outstation/approvals-desk";
  const reviewer = stripComments(readFileSync(`${dir}/desk-reviewer.tsx`, "utf8"));
  const decision = stripComments(readFileSync(`${dir}/desk-decision.tsx`, "utf8"));
  const row = stripComments(readFileSync(`${dir}/desk-row.tsx`, "utf8"));
  const workspace = stripComments(readFileSync(`${dir}/desk-workspace.tsx`, "utf8"));
  const queueRead = stripComments(readFileSync("src/lib/outstation/approvals/queue.ts", "utf8"));
  const claimRow = stripComments(readFileSync("src/lib/outstation/approvals/claim-row.ts", "utf8"));
  const exportRoute = stripComments(readFileSync("app/api/admin/outstation/expenses/export/route.ts", "utf8"));

  // Decide-and-advance: a press in the open trip is sent, then the reviewer moves on by itself —
  // the next claim of the lane, else the one before, else it closes. Undo comes back to the claim.
  assert.match(
    reviewer,
    /const pressAndMove = useCallback<OnPress>\(\s*\(decisions, claims\) => \{\s*onPress\(decisions, claims\);\s*setMode\("idle"\);\s*const target = next \?\? previous;\s*if \(target !== null\) onGo\(target\);\s*else onClose\(\);/,
    "HEADLINE: a press in the open trip opens the next claim of the lane, and closes when none is left",
  );
  assert.ok(reviewer.includes("onPress={pressAndMove}"), "and every decision made in the reviewer goes through it");
  assert.ok(
    reviewer.includes("if (press && press.claims.length === 1) go(press.claims[0].requestId);"),
    "HEADLINE: Undo returns to the claim it was pressed on",
  );
  assert.ok(workspace.includes("walk={laneClaims.map((claim) => claim.requestId)}"), "the walk is the lane on screen, in its order");

  // No key decides anything: the arrows walk, nothing else.
  const keys = reviewer.match(/const onKey = \(event: KeyboardEvent\) => \{[\s\S]*?\n {4}\};/)?.[0] ?? "";
  assert.ok(keys.length > 0, "the reviewer's key handler is found");
  assert.deepEqual(
    [...keys.matchAll(/event\.key === "(\w+)"/g)].map((match) => match[1]),
    ["ArrowRight", "ArrowLeft"],
    "HEADLINE: the only keys the reviewer answers are the two arrows",
  );
  assert.doesNotMatch(keys, /onPress|pressAndMove|onUndo/, "HEADLINE: no keyboard shortcut approves, rejects or undoes");
  assert.ok(keys.includes("if (typingIn(event.target) || otherDialogOpen()) return;"), "and never while he is typing a reason or a photo is zoomed");

  // Needs a look / Clean are the two lanes, and a claim's lane is the server's own checks.
  const pass = (key: CheckKey): ClaimCheck => ({ answer: "pass", key, label: key, sentence: `${key} passed.` });
  assert.equal(verdictFromChecks([pass("field_work"), pass("arrival_photo")]).lane, "ready", "HEADLINE: every check passed is Ready");
  const failed = verdictFromChecks([pass("field_work"), { answer: "fail", key: "departure_photo", label: "Departure photo", sentence: "The departure photo was taken 80 km from the arrival." }]);
  assert.equal(failed.lane, "your_call", "HEADLINE: one failed check is Your call");
  assert.equal(failed.reason, "The departure photo was taken 80 km from the arrival.", "and the lane's one reason is that check's own sentence");
  const unknown = verdictFromChecks([pass("field_work"), { answer: "unknown", key: "ticket", label: "Ticket", sentence: "The ticket could not be read." }]);
  assert.equal(unknown.lane, "your_call", "HEADLINE: unknown is never clean — a check that could not be made is Your call");
  assert.equal(verdictFromChecks([]).lane, "your_call", "and a claim nothing could be checked on is never a quiet Ready");
  assert.ok(workspace.includes('const laneClaims = queue && lane !== "history" ? claimsInLane(queue.claims, lane, view) : [];'), "the list on screen is the lane the server filed");
  assert.ok(row.includes("<FoundCell claim={claim} />"), "and every row says what the system found");

  // Oldest first + how long it has waited.
  assert.ok(
    queueRead.includes('.order("created_at", { ascending: true }).order("id", { ascending: true })'),
    "HEADLINE: the waiting list is read oldest first, and that is the only order",
  );
  assert.ok(
    claimRow.includes("daysWaiting: waiting ? daysBetween(text(row.created_at) || null, input.now) : 0,"),
    "HEADLINE: the wait is counted from the submission, and only a waiting claim carries one",
  );
  assert.ok(row.includes("<WaitFigure days={claim.daysWaiting} />"), "HEADLINE: a waiting row says how long it has waited");
  assert.ok(row.includes("waited {waitLabel(claim.daysWaiting).toLowerCase()}"), "and so does the phone card");
  assert.equal(waitLabel(0.4), "Today");
  assert.equal(waitLabel(1), "1 day");
  assert.equal(waitLabel(9.7), "9 days", "whole days, never a fraction");
  assert.doesNotMatch(row + workspace, /Date\.now\(\)/, "the clock is the server's, read once with the queue — never during render");

  // The export is every trip, narrowed only by what he typed in the search box. The route still
  // reads the older keys, so a link saved before the rebuild keeps working.
  assert.ok(
    workspace.includes(
      'const exportHref = view.search.trim() ? `/api/admin/outstation/expenses/export?search=${encodeURIComponent(view.search.trim())}` : "/api/admin/outstation/expenses/export";',
    ),
    "HEADLINE: the export narrows by the search and by nothing else",
  );
  assert.match(exportRoute, /triage: parseExpenseTripTriageFilter\(url\.searchParams\.get\("triage"\)\)/);

  // The idle-day cut (owner, 2026-11-07: "Approver sees it pre-cut"): the server works it out, the
  // Approve button names it, and "Keep full claim" is one press beside it. Nothing deducts alone.
  const cut = claimPreCut({ allowance: 600, idleDays: 5, total: 1200, tripDays: 6 });
  assert.deepEqual(
    cut && [cut.deduction, cut.payable],
    [500, 700],
    "HEADLINE: the pre-cut is the first share the idle-day rule offers: 5 of 6 days of a 600 allowance",
  );
  assert.equal(claimPreCut({ allowance: 0, idleDays: 2, total: 900, tripDays: 3 }), null, "no allowance, no cut: travel is never deducted for an idle day");
  assert.equal(claimPreCut({ allowance: 600, idleDays: 0, total: 900, tripDays: 3 }), null, "no idle day, no cut");
  const waitingClaim = { holdReason: null, preCut: cut, requestId: 5088, revision: "rev-5088", standing: "waiting", total: 1200 } as unknown as DeskClaim;
  assert.deepEqual(
    approvePress(waitingClaim),
    { action: "approve", approvedAmount: 700, requestId: 5088, revision: "rev-5088" },
    "HEADLINE: Approve on a trip with idle days sends the amount its own button names",
  );
  assert.deepEqual(
    approvePress(waitingClaim, { full: true }),
    { action: "approve", keepFull: true, requestId: 5088, revision: "rev-5088" },
    "HEADLINE: Keep full claim sends no amount and says keep-full: the claim is paid as claimed, on his word",
  );
  assert.deepEqual(
    approvePress({ ...waitingClaim, holdReason: "No payroll month is open." } as DeskClaim),
    { action: "approve", keepFull: true, requestId: 5088, revision: "rev-5088" },
    "a trip the payroll gate would hold carries no cut: a held claim cannot take a reduced amount, and its Approve says it pays in full",
  );
  assert.ok(decision.includes("onClick={() => onPress([approvePress(claim)], [claim])}"), "the Approve button sends that one press");
  assert.ok(decision.includes("{cut ? `${DESK_WORDS.approve} ${egp(cut.payable)}` : DESK_WORDS.approve}"), "HEADLINE: and names what it pays");
  // 🔴 A DECIDED claim draws no decision button (risk review, 23 Nov): History → Open → "Pay in full"
  // wrote a typed amount to NULL and moved his money.
  assert.ok(
    decision.includes('const acts = canDecide && !claim.locked && claim.standing === "waiting";'),
    "HEADLINE: only a waiting claim gets a decision button",
  );
  assert.ok(!/payInFull|changeAmount|Pay in full|Change amount/.test(decision), "the two buttons that re-decided a decided claim are gone");
  assert.equal((decision.match(/\{acts(?: && [^?]+)? \? \(/g) ?? []).length, 4, "Approve, Keep full claim, Reduce and Reject all hang on that one test");
  assert.equal((decision.match(/<button\b/g) ?? []).length - (decision.slice(decision.indexOf("export function DecisionPanel")).match(/<button\b/g) ?? []).length, 5, "and the row's decision draws those four and Open, which decides nothing");
  assert.match(
    decision,
    /\{acts && cut \? \(\s*<button className=\{approvalActionClassName\("neutral", size\)\} data-press="keep-full" onClick=\{\(\) => onPress\(\[approvePress\(claim, \{ full: true \}\)\], \[claim\]\)\}/,
    "HEADLINE: Keep full claim sits beside it wherever a cut is named",
  );
  assert.ok(!decision.includes("useEffect"), "HEADLINE: nothing deducts on its own: the decision box runs no effect at all");

  // The reason box opens EMPTY (it used to open holding the system's hold sentence, which the
  // employee was then sent). The system's sentence is one press away and is added to his words.
  assert.ok(decision.includes('const [reason, setReason] = useState("");'), "HEADLINE: the reason box opens empty");
  assert.ok(
    decision.includes("onClick={() => setReason(reason ? `${reason} ${claim.systemNote}` : String(claim.systemNote))}"),
    "HEADLINE: the system's sentence is added after the reviewer's own reason, never written over it",
  );
  assert.ok(decision.includes("{claim.systemNote && !reason.includes(claim.systemNote) ? ("), "and is offered once, not twice");

  // `reasonAfterIdleDayPick` is the 7 Nov rule for a share picked from a list. The desk has no such
  // list — the cut is on the Approve button — so no screen calls it since 23 Nov. It stays pinned.
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
}
