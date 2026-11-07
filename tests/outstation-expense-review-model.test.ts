import assert from "node:assert/strict";

import { APPROVED_STATUS, PENDING_STATUS, REJECTED_STATUS, expenseApprovalState } from "../src/lib/outstation/approval-state.ts";
import {
  DECISION_DRAFT_MAX_AGE_MS,
  type Decision,
  type LoadedRecord,
  TRIP_TABS,
  computeReviewStats,
  countOutOf,
  countReviewTabs,
  countUnsaved,
  decisionStateLabel,
  exportTriageForTab,
  inReviewTab,
  isUnsaved,
  rowApproveBlock,
  nextAwaitingTrip,
  openingTab,
  parseExpenseDecisionDraft,
  positionIn,
  reasonAfterChip,
  reasonChipsFor,
  restorableDraft,
  reviewAdvice,
  savedDecision,
  tabRows,
} from "../src/components/outstation/expense-review/review-model.ts";

// Expense approvals, rebuilt from scratch in the Phoenix CRM identity (owner, 2026-11-07 ~03:20:
// "RETIRE THE CURRENT EXPENSE APPROVAL AND REBUILD FROM SCRATCH SAME PHOENIX CRM IDENTITY"). Every
// rule of the new screen that is not money lives in review-model.ts as a pure function, so it is
// tested here by BEHAVIOUR — the tab a trip sits in, every count, the next trip, the reasons offered
// and the draft that carries unsaved decisions across a reload — rather than by reading its source.

function trip(overrides: Partial<LoadedRecord> & { tripId: string }): LoadedRecord {
  return {
    allowance: 300,
    amWorkload: 0,
    date: "2026-10-12",
    description: "",
    from: "Tanta",
    hr: "Mona Saleh",
    hrNotes: "",
    km: 120,
    location: "Alexandria",
    meetingAmount: 0,
    other: 0,
    pmWorkload: 0,
    requestType: "outstation",
    row: 1,
    specialist: "Medical Rep",
    status: PENDING_STATUS,
    to: "Alexandria",
    toDate: "2026-10-12",
    total: 1000,
    transportationType: "Train",
    travelCost: 700,
    tripType: "outstation",
    hrApproved: false,
    hrComment: "",
    ...overrides,
  };
}

const clean = (tripId: string, extra: Partial<LoadedRecord> = {}) =>
  trip({ tripId, workloadMatchStatus: "matched", departurePhotoFlagged: false, ...extra });
const look = (tripId: string, extra: Partial<LoadedRecord> = {}) =>
  trip({ tripId, workloadMatchStatus: "no_activity", departurePhotoFlagged: false, ...extra });

const stored = (record: LoadedRecord): Decision => savedDecision(record);

export function runOutstationExpenseReviewModelTests() {
  // ── 1. The tabs read the STORED decision, so a row never moves when it is decided ───────────
  const waitingClean = clean("T-1");
  const waitingLook = look("T-2");
  const unread = trip({ tripId: "T-3" }); // an imported-shaped row with no reading at all
  const approved = clean("T-4", { hrApproved: true, status: APPROVED_STATUS });
  const adjusted = clean("T-5", { approvedAmount: 700, hrApproved: true, hrComment: "Two idle days.", status: APPROVED_STATUS });
  const rejected = look("T-6", { status: REJECTED_STATUS, hrComment: "No field activity." });
  const history = clean("T-7", { date: "2026-06-20" });
  const records = [waitingClean, waitingLook, unread, approved, adjusted, rejected, history];

  assert.equal(inReviewTab(waitingClean, "clean"), true, "HEADLINE: a waiting trip the system found nothing in is in Clean");
  assert.equal(inReviewTab(waitingClean, "look"), false);
  assert.equal(inReviewTab(waitingLook, "look"), true, "HEADLINE: a waiting trip with no field activity is in Needs a look");
  assert.equal(inReviewTab(unread, "awaiting"), true, "a trip with no system reading still waits");
  assert.equal(inReviewTab(unread, "look") || inReviewTab(unread, "clean"), false, "and is never filed as clean or as a look on a guess");
  assert.equal(inReviewTab(approved, "approved"), true);
  assert.equal(inReviewTab(approved, "awaiting"), false, "a decided trip never waits");
  assert.equal(inReviewTab(adjusted, "adjusted"), true, "HEADLINE: an approval below the claim is in Adjusted");
  assert.equal(inReviewTab(adjusted, "approved"), true, "...and still in Approved");
  assert.equal(inReviewTab(rejected, "rejected"), true);
  assert.equal(inReviewTab(rejected, "adjusted"), false, "a rejection is never an adjustment");
  assert.equal(inReviewTab(history, "history"), true, "HEADLINE: a trip before July is in Before July");
  for (const tab of ["look", "clean", "awaiting", "approved", "adjusted", "rejected"] as const) {
    assert.equal(inReviewTab(history, tab), false, `imported history is values only — never in "${tab}"`);
  }
  for (const record of records) assert.equal(inReviewTab(record, "all"), true, "All trips holds every trip");

  assert.deepEqual(
    countReviewTabs(records),
    { look: 1, clean: 1, awaiting: 3, approved: 2, adjusted: 1, rejected: 1, history: 1, all: 7 },
    "HEADLINE: each tab's count is the number of trips it shows",
  );
  assert.deepEqual([...TRIP_TABS], ["look", "clean", "awaiting", "approved", "adjusted", "rejected", "history", "all"]);

  // A live decision does NOT move a row: membership is a function of the record alone.
  const approvedOnScreen = { ...stored(waitingLook), hrApproved: true, status: APPROVED_STATUS };
  assert.equal(inReviewTab(waitingLook, "look"), true, "HEADLINE: approving a trip on screen leaves it in Needs a look until Save");
  assert.equal(expenseApprovalState(approvedOnScreen), "approved", "while its live state is already approved");

  // The rows of a tab: All trips ranks the STORED decision, undecided first; inside, the reviewer's order.
  const big = clean("B", { total: 5000 });
  const small = clean("S", { total: 200 });
  const old = clean("O", { total: 900, submittedAt: "2026-10-01T08:00:00Z" });
  const recent = clean("R", { total: 950, submittedAt: "2026-10-20T08:00:00Z" });
  const done = clean("D", { total: 9000, hrApproved: true, status: APPROVED_STATUS });
  assert.deepEqual(tabRows([small, done, big], "all", "value").map((r) => r.tripId), ["B", "S", "D"], "HEADLINE: All trips puts every waiting trip first, then the decided ones");
  assert.deepEqual(tabRows([recent, old], "clean", "oldest").map((r) => r.tripId), ["O", "R"], "Oldest first is honoured in a tab");
  assert.deepEqual(tabRows([recent, old], "clean", "value").map((r) => r.tripId), ["R", "O"], "Biggest first is honoured in a tab");

  assert.equal(exportTriageForTab("look"), "look", "the export carries the tab's triage");
  assert.equal(exportTriageForTab("clean"), "clean");
  assert.equal(exportTriageForTab("approved"), "", "any other tab exports without a triage");
  assert.equal(exportTriageForTab("employees"), "");

  assert.equal(openingTab(countReviewTabs(records)), "look", "the page opens on Needs a look when it has trips");
  assert.equal(openingTab(countReviewTabs([waitingClean])), "clean", "...else on the first tab with something in it");
  assert.equal(openingTab(countReviewTabs([])), "look", "an empty queue opens on Needs a look");

  // ── 2. The six tiles count the LIVE decisions; each one can say "of N" ───────────────────────
  const live: Record<string, Decision> = {
    "T-1": { ...stored(waitingClean), hrApproved: true, status: APPROVED_STATUS }, // approved a moment ago, unsaved
  };
  const decisionFor = (record: LoadedRecord) => live[record.tripId] ?? stored(record);
  const stats = computeReviewStats(records, decisionFor);
  assert.equal(stats.pending, 2, "HEADLINE: a trip approved a moment ago is no longer counted as waiting");
  assert.equal(stats.pendingValue, 2000);
  assert.equal(stats.look, 1);
  assert.equal(stats.clean, 0, "the clean trip just approved has left the Clean tile");
  assert.equal(stats.approved, 3, "and is counted as approved before it is saved");
  assert.equal(stats.approvedValue, 1000 + 1000 + 700);
  assert.equal(stats.adjusted, 1);
  assert.equal(stats.adjustedDelta, 300, "Adjusted carries how much below the claim");
  assert.equal(stats.rejected, 1);
  assert.equal(
    stats.pending + stats.approved + stats.rejected,
    records.length - 1,
    "every trip is counted once, and imported history never waits",
  );

  // On the old page the Adjusted figure alone had no "of N" (live tour of 636f0fc). Every tile now
  // goes through countOutOf, so all six read the same way.
  const overall = computeReviewStats([...records, look("T-8"), clean("T-9", { approvedAmount: 600, hrApproved: true, status: APPROVED_STATUS })], decisionFor);
  for (const key of ["pending", "look", "clean", "approved", "adjusted", "rejected"] as const) {
    const shown = countOutOf(stats[key], overall[key]);
    assert.equal(shown.value, stats[key], `the ${key} tile shows its own count`);
    assert.equal(shown.of, overall[key] === stats[key] ? null : overall[key], `HEADLINE: the ${key} tile says "of N" exactly when narrowed and different`);
  }
  assert.deepEqual(countOutOf(2, 3), { of: 3, value: 2 }, "HEADLINE: Adjusted reads \"2 of 3\" when narrowed");
  assert.deepEqual(countOutOf(5, 5), { of: null, value: 5 }, "never \"5 of 5\"");

  // The tiles and the tabs count the same trips: imported history is in neither (live tour of
  // d67cacc read "Approved 453" over a tab of 129, and "Rejected 58" over 39).
  const pastTrips = [
    clean("H-1", { date: "2026-05-04", approvedAmount: 900, hrApproved: true, status: APPROVED_STATUS }),
    clean("H-2", { date: "2026-06-11", approvedAmount: 300, hrApproved: true, status: APPROVED_STATUS, total: 500 }),
  ];
  const withHistory = computeReviewStats([...records, ...pastTrips], decisionFor);
  for (const key of ["pending", "look", "clean", "approved", "approvedValue", "adjusted", "adjustedDelta", "rejected"] as const) {
    assert.equal(withHistory[key], stats[key], `HEADLINE: imported history is never in the ${key} tile`);
  }
  assert.deepEqual(countOutOf(5, null), { of: null, value: 5 }, "and nothing when the list is not narrowed");

  // ── 3. Moving through the trips ──────────────────────────────────────────────────────────────
  const walk = [clean("A"), clean("B2", { hrApproved: true, status: APPROVED_STATUS }), clean("C"), clean("H", { date: "2026-05-01" }), clean("E")];
  const walkFor = (record: LoadedRecord) => stored(record);
  assert.equal(nextAwaitingTrip(walk, "A", walkFor), "C", "HEADLINE: the next trip is the next one still waiting — decided trips are skipped");
  assert.equal(nextAwaitingTrip(walk, "C", walkFor), "E", "imported history is never offered");
  assert.equal(nextAwaitingTrip(walk, "E", walkFor), "A", "from the last, it wraps to the first still waiting");
  const decidedA = (record: LoadedRecord) => (record.tripId === "A" ? { ...stored(record), hrApproved: true, status: APPROVED_STATUS } : stored(record));
  assert.equal(nextAwaitingTrip(walk, "E", decidedA), "C", "a trip just approved on screen is never offered again");
  assert.equal(nextAwaitingTrip([clean("Only")], "Only", walkFor), null, "nothing left waiting answers none");
  assert.equal(nextAwaitingTrip(walk, "missing", walkFor), "A", "a trip no longer in the walk starts from the top");

  assert.deepEqual(positionIn(walk, "C"), { index: 3, total: 5 }, "\"3 of 5\"");
  assert.equal(positionIn(walk, "missing"), null);
  assert.equal(positionIn(walk, null), null);

  // ── 4. Unsaved decisions ─────────────────────────────────────────────────────────────────────
  const decisions: Record<string, Decision> = {
    "T-1": { ...stored(waitingClean), hrApproved: true, status: APPROVED_STATUS },
    "T-2": { ...stored(waitingLook) }, // touched but unchanged
    "T-7": { ...stored(history), hrApproved: true, status: APPROVED_STATUS }, // history can never be saved
  };
  assert.equal(countUnsaved(records, decisions), 1, "HEADLINE: Save N counts only decisions that differ from the stored row");
  assert.equal(isUnsaved(waitingClean, decisions), true);
  assert.equal(isUnsaved(waitingLook, decisions), false, "a decision equal to the stored row is not unsaved");
  assert.equal(isUnsaved(history, decisions), false, "imported history is never unsaved");
  assert.equal(
    isUnsaved(waitingLook, { "T-2": { ...stored(waitingLook), approvedAmount: 1000.3 } }),
    false,
    "the half-pound rounding of a number input is not a change",
  );
  assert.equal(
    isUnsaved(rejected, { "T-6": { ...stored(rejected), status: PENDING_STATUS } }),
    true,
    "HEADLINE: Undo rejection is a change Save must send",
  );

  // A row's own Approve follows the batch rule: a trip with idle days and an allowance goes only from
  // the opened trip, where its pre-cut is shown (owner, 2026-11-07: "then don't count 26").
  assert.equal(rowApproveBlock(waitingClean, stored(waitingClean)), null, "a clean trip can be approved from its row");
  assert.equal(rowApproveBlock(waitingLook, stored(waitingLook)), "pre-cut", "HEADLINE: a trip with idle days is never approved in full from its row");
  assert.equal(rowApproveBlock({ ...waitingLook, allowance: 0 }, stored(waitingLook)), null, "with no allowance there is nothing to cut");
  assert.equal(
    rowApproveBlock(waitingLook, { ...stored(waitingLook), approvedAmount: 850, hrComment: "Two idle days." }),
    null,
    "a cut already chosen, with its reason, can go",
  );
  assert.equal(rowApproveBlock(waitingLook, { ...stored(waitingLook), approvedAmount: 850 }), "reason", "a changed amount with no reason cannot");
  assert.equal(
    rowApproveBlock({ ...waitingLook, workloadMatchStatus: "matched" }, stored(waitingLook)),
    null,
    "once the opened trip's live read finds every day worked, the hold lifts",
  );

  // The draft keeps the retired page's shape exactly, so the decisions left unsaved there come back.
  const now = Date.UTC(2026, 10, 7, 1, 30);
  const legacy = JSON.stringify({
    decisions: {
      "T-1": { approvedAmount: 1000, hrApproved: true, hrComment: "", status: APPROVED_STATUS },
      "T-2": { approvedAmount: 700, hrApproved: true, hrComment: "Two idle days.", status: APPROVED_STATUS },
      broken: { approvedAmount: "700", hrApproved: true, hrComment: "", status: APPROVED_STATUS },
      noFlag: { approvedAmount: 700, hrComment: "", status: APPROVED_STATUS },
      nothing: null,
    },
    savedAt: now - 60_000,
  });
  const draft = parseExpenseDecisionDraft(legacy, now);
  assert.ok(draft, "HEADLINE: a draft written by the retired screen is read back by the new one");
  assert.deepEqual(Object.keys(draft).sort(), ["T-1", "T-2"], "a half-shaped entry is dropped, never sent to Save");
  assert.equal(draft["T-2"].approvedAmount, 700);
  assert.equal(parseExpenseDecisionDraft(legacy, now + DECISION_DRAFT_MAX_AGE_MS + 1), null, "a draft older than a week belongs to another sitting");
  assert.equal(parseExpenseDecisionDraft("{not json", now), null);
  assert.equal(parseExpenseDecisionDraft(null, now), null);
  assert.equal(parseExpenseDecisionDraft(JSON.stringify({ decisions: {}, savedAt: now }), now), null, "an empty draft restores nothing");
  assert.equal(parseExpenseDecisionDraft(JSON.stringify({ decisions: { "T-1": legacyEntry() } }), now), null, "a draft with no time is never trusted");

  const restored = restorableDraft([waitingClean, { ...waitingLook, approvedAmount: 700, hrApproved: true, hrComment: "Two idle days.", status: APPROVED_STATUS }], draft);
  assert.deepEqual(Object.keys(restored), ["T-1"], "HEADLINE: an entry already saved meanwhile is not restored — no phantom \"1 unsaved\"");
  assert.deepEqual(restorableDraft([], draft), {}, "an entry for a trip no longer in the queue is not restored");

  // ── 5. The state pill ────────────────────────────────────────────────────────────────────────
  assert.equal(decisionStateLabel(stored(waitingClean), waitingClean).label, "Waiting");
  assert.equal(decisionStateLabel(stored(approved), approved).label, "Approved");
  assert.equal(decisionStateLabel(stored(adjusted), adjusted).label, "Approved · adjusted");
  assert.equal(decisionStateLabel(stored(rejected), rejected).label, "Rejected");
  assert.equal(decisionStateLabel(stored(history), history).label, "Before July · values only");

  // ── 6. The reasons offered are true of THIS trip, and never write over the reviewer's words ──
  const someIdle = reasonChipsFor({ idle: { idleDays: 2, tripDays: 3 }, record: waitingLook });
  assert.deepEqual(someIdle.map((chip) => chip.key), ["idle-days"], "HEADLINE: the live day-by-day read decides the field-work reason");
  assert.equal(someIdle[0].text, "2 of the 3 days of this trip had no field activity.");
  const allIdle = reasonChipsFor({ idle: { idleDays: 3, tripDays: 3 }, record: waitingClean });
  assert.equal(allIdle[0].key, "no-activity");
  assert.equal(allIdle[0].text, "No field activity was recorded on any of the 3 days of this trip.");
  assert.equal(reasonChipsFor({ idle: { idleDays: 1, tripDays: 1 }, record: waitingClean })[0].text, "No field activity was recorded on the day of this trip.");
  assert.deepEqual(reasonChipsFor({ idle: { idleDays: 0, tripDays: 3 }, record: waitingLook }), [], "HEADLINE: once the live read finds every day worked, the stored stamp offers no reason");
  assert.deepEqual(reasonChipsFor({ idle: null, record: waitingLook }).map((chip) => chip.key), ["no-activity"], "before the read, the stored stamp speaks");
  assert.deepEqual(reasonChipsFor({ idle: null, record: trip({ tripId: "P", workloadMatchStatus: "partial" }) }).map((chip) => chip.key), ["idle-days"]);
  assert.deepEqual(reasonChipsFor({ idle: null, record: waitingClean }), [], "HEADLINE: a clean trip is offered no reason at all");

  const everything = reasonChipsFor({
    duplicateOf: ["OUTSTATION-1182"],
    idle: null,
    record: trip({ tripId: "X", km: 30, departurePhotoFlagged: true, departurePhotoNoGps: true }),
  });
  assert.deepEqual(everything.map((chip) => chip.key), ["duplicate", "distance", "departure-photo"], "a flagged photo names the flag once, not the missing position as well");
  assert.match(everything[0].text, /OUTSTATION-1182/, "the duplicate reason names the other trip");
  assert.match(everything[1].text, /30 km/);
  assert.deepEqual(
    reasonChipsFor({ idle: null, record: trip({ tripId: "G", departurePhotoNoGps: true }) }).map((chip) => chip.key),
    ["departure-gps"],
  );
  assert.deepEqual(reasonChipsFor({ idle: null, record: trip({ tripId: "K", km: 59 }) }), [], "within the tolerance is not under the floor");
  for (const chip of everything) assert.doesNotMatch(chip.text, /\b(he|she|his|her)\b/i, "a reason the employee reads never genders them");

  const chips = reasonChipsFor({ duplicateOf: ["OUTSTATION-9"], idle: { idleDays: 1, tripDays: 2 }, record: waitingLook });
  const [idleChip, duplicateChip] = chips;
  const held = "Held: no field activity recorded.";
  assert.equal(reasonAfterChip({ chips, current: "", picked: idleChip, systemText: held }), idleChip.text, "an empty box takes the sentence");
  assert.equal(reasonAfterChip({ chips, current: held, picked: idleChip, systemText: held }), idleChip.text, "HEADLINE: the system's hold sentence is replaced by the reason picked");
  assert.equal(reasonAfterChip({ chips, current: idleChip.text, picked: duplicateChip, systemText: held }), duplicateChip.text, "picking another chip swaps, never stacks two");
  const own = "Called the employee, who was at the clinic.";
  assert.equal(reasonAfterChip({ chips, current: own, picked: idleChip, systemText: held }), `${own}\n${idleChip.text}`, "HEADLINE: the reviewer's own words are kept and the reason goes on a new line");
  assert.equal(reasonAfterChip({ chips, current: `${own}\n${idleChip.text}`, picked: idleChip, systemText: held }), `${own}\n${idleChip.text}`, "the same reason is never added twice");

  // ── 7. The one sentence of advice agrees with the tiles ──────────────────────────────────────
  const money = (value: number) => `EGP ${value.toLocaleString("en-US")}`;
  const many = computeReviewStats([clean("1", { total: 400 }), clean("2", { total: 600 }), look("3", { total: 1500 }), trip({ tripId: "4", total: 100 })], stored);
  assert.equal(
    reviewAdvice(many, money),
    "4 trips are waiting, worth EGP 2,600: 2 clean trips could be approved together in the Clean tab; 1 needs a look first; 1 has no system reading.",
    "HEADLINE: the advice names what is waiting, what it is worth and what can be done in one go",
  );
  assert.equal(
    reviewAdvice(computeReviewStats([look("1", { total: 250 })], stored), money),
    "1 trip is waiting, worth EGP 250: 1 needs a look first.",
  );
  assert.equal(reviewAdvice(computeReviewStats([approved], stored), money), "Nothing is waiting — every trip here has been decided.");
  assert.equal(reviewAdvice(computeReviewStats([], stored), money), "Nothing is waiting for a decision.");
}

function legacyEntry(): Decision {
  return { approvedAmount: 1000, hrApproved: true, hrComment: "", status: APPROVED_STATUS };
}
