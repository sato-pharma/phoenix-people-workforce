import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  EXPLAIN_MAX_DAYS,
  EXPLAIN_REASON_CODES,
  EXPLAIN_REASONS,
  caseDates,
  explainDatesPhrase,
  explainDayLabel,
  explainDetailProgress,
  explainReasonPhrase,
  explanationFacts,
  explanationSummary,
  explanationVerifySource,
  initialConfirmationStatus,
  validateExplanation,
  validateExplanationReason,
  type DisputeExplanation,
} from "@/lib/dispute-center/explain-reasons";
import { currentVerificationSourceText } from "@/lib/private-calendar/verification-sources";

/**
 * THE REASON LIST BEHIND EVERY DISPUTE (owner, 2026-11-16: "make the rep write whatever he wants … find a
 * more professional, easier, accurate way"; "manager first then me but remove device problem choice").
 *
 * An employee no longer says the calendar or a deduction is WRONG in free text; he EXPLAINS the day from a
 * short list and names who can confirm it. Pinned here, for different reasons each:
 *
 *   1. The list itself — Training, Meeting, Double visit, Something else. No device problem (the owner
 *      removed it), no leave (leave is requested, never explained), no unlogged visit.
 *   2. The check — a reason is required, "Something else" needs real words, a named reason needs a
 *      confirmer, a calendar explanation covers 14 days at most and never a future day. A deduction's
 *      days are its own, so only the reason part is checked there.
 *   3. What the reviewer reads — the confirmer's answer as the case's first facts, in the right tone.
 *   4. How a day reads — "Thu 12 Nov", a training week folded to "7–12 Nov", a gap never bridged
 *      ("7–9 Nov and 12 Nov" claims no day that was not explained), and the word counter under
 *      "Something else" agreeing with the server about "enough" on every input.
 *   5. The wiring the pure half cannot prove: every dispute box opens with the list, the three modules
 *      refuse a day explained in another, the confirmer is told in-app and by push and never by email,
 *      and the Super Admin's inbox never calls the employee's day "wrong" and never bulk-accepts an
 *      unconfirmed or free-text request.
 *
 * Pure and source-level: the server half (explanations.ts) imports the Supabase client, so it is read as
 * text here, exactly as the gap-notice suite reads its server half.
 */

const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

const TODAY = "2026-11-16";

function refusal(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}

function explanation(overrides: Partial<DisputeExplanation>): DisputeExplanation {
  return {
    caseKind: "calendar",
    caseRef: "case-1",
    confirmationNote: null,
    confirmationStatus: "awaiting",
    confirmedAt: null,
    confirmerHrId: "B-20",
    confirmerName: "Ahmed Ali",
    createdAt: "2026-11-16T08:00:00Z",
    dates: ["2026-11-10"],
    detailText: "",
    employeeHrId: "B-30",
    employeeName: "Sara Hassan",
    groupId: "group-1",
    id: "explanation-1",
    reasonCode: "training",
    ...overrides,
  };
}

export function runDisputeExplanationsTests() {
  // ── 1 · The list ──────────────────────────────────────────────────────────────────────────────
  assert.deepEqual([...EXPLAIN_REASON_CODES], ["training", "meeting", "double_visit", "other"], "the four reasons, in this order");
  assert.deepEqual(EXPLAIN_REASONS.map((reason) => reason.code), [...EXPLAIN_REASON_CODES], "the radio list is the code list");
  const labels = EXPLAIN_REASONS.map((reason) => `${reason.label} ${reason.hint}`.toLowerCase()).join(" | ");
  assert.doesNotMatch(labels, /device|fingerprint/, "the owner removed the device-problem choice");
  assert.doesNotMatch(labels, /\bleave\b|vacation/, "leave is requested on the leave page, never a reason here");
  assert.deepEqual(
    EXPLAIN_REASONS.find((reason) => reason.code === "training")?.confirmerKinds,
    ["manager", "training_manager"],
    "a training is confirmed by the manager or the Training Manager who ran it",
  );
  assert.deepEqual(EXPLAIN_REASONS.find((reason) => reason.code === "meeting")?.confirmerKinds, ["manager"]);
  assert.deepEqual(EXPLAIN_REASONS.find((reason) => reason.code === "double_visit")?.confirmerKinds, ["manager"]);
  assert.deepEqual(EXPLAIN_REASONS.find((reason) => reason.code === "other")?.confirmerKinds, [], "Something else has nobody to confirm it");
  assert.equal(initialConfirmationStatus("training"), "awaiting");
  assert.equal(initialConfirmationStatus("other"), "not_needed");

  // ── 2 · The check ─────────────────────────────────────────────────────────────────────────────
  assert.equal(refusal(() => validateExplanation({ dates: [TODAY], reasonCode: "" }, TODAY)), "Choose a reason from the list.");
  assert.equal(refusal(() => validateExplanation({ dates: [TODAY], reasonCode: "device" }, TODAY)), "Choose a reason from the list.");
  assert.match(
    refusal(() => validateExplanation({ dates: [TODAY], detailText: "was busy", reasonCode: "other" }, TODAY)),
    /at least 4 words \(25 characters\)/,
    "Something else in two words is refused",
  );
  assert.match(
    refusal(() => validateExplanation({ dates: [TODAY], detailText: "a b c d e f g", reasonCode: "other" }, TODAY)),
    /25 characters/,
    "four words are not enough when they are too short to say anything",
  );
  const other = validateExplanation(
    { dates: [TODAY, "2026-11-15", TODAY], detailText: "  I was at the  Tanta  distributor all day  ", reasonCode: "other" },
    TODAY,
  );
  assert.deepEqual(other.dates, ["2026-11-15", TODAY], "the days come back unique and in order");
  assert.equal(other.detailText, "I was at the Tanta distributor all day", "the words are tidied");
  assert.equal(other.confirmerHrId, null, "Something else carries no confirmer even if one is sent");
  assert.equal(
    refusal(() => validateExplanation({ dates: [TODAY], reasonCode: "training" }, TODAY)),
    "Choose who can confirm this.",
    "a named reason needs its confirmer",
  );
  assert.equal(
    refusal(() => validateExplanation({ confirmerHrId: "B-20", dates: ["2026-11-17"], reasonCode: "meeting" }, TODAY)),
    "A day that has not happened yet cannot be explained.",
  );
  assert.equal(refusal(() => validateExplanation({ confirmerHrId: "B-20", dates: [], reasonCode: "meeting" }, TODAY)), "Choose at least one day.");
  const fifteen = Array.from({ length: EXPLAIN_MAX_DAYS + 1 }, (_, index) => `2026-10-${String(index + 1).padStart(2, "0")}`);
  assert.match(refusal(() => validateExplanation({ confirmerHrId: "B-20", dates: fifteen, reasonCode: "training" }, TODAY)), /14 days at most/);
  assert.equal(refusal(() => validateExplanation({ confirmerHrId: "B-20", dates: ["2026-02-30"], reasonCode: "training" }, TODAY)), "Pick a real date.");

  // A deduction's days are HR's, fixed on the deduction — a 22-day fingerprint deduction must still be
  // explainable, so only the reason part is checked for it.
  const reasonOnly = validateExplanationReason({ confirmerHrId: " B-20 ", reasonCode: "double_visit" });
  assert.deepEqual(reasonOnly, { confirmerHrId: "B-20", detailText: "", reasonCode: "double_visit" });
  assert.equal(refusal(() => validateExplanationReason({ reasonCode: "meeting" })), "Choose who can confirm this.");
  assert.deepEqual(
    caseDates(["2026-09-03", "2026-09-01T00:00:00Z", "junk", null, "2026-09-03", "2026-02-30"]),
    ["2026-09-01", "2026-09-03"],
    "a deduction's stored dates come back as clean, unique, ordered days",
  );
  assert.deepEqual(caseDates(null), [], "a deduction with no dates is explained with none");

  // ── 3 · What the reviewer reads ───────────────────────────────────────────────────────────────
  assert.equal(explanationSummary({ confirmerName: "Ahmed Ali", reasonCode: "training" }), "Training · confirmer: Ahmed Ali");
  assert.equal(
    explanationSummary({ detailText: "I was at the Tanta distributor all day", reasonCode: "other" }),
    "Something else: I was at the Tanta distributor all day",
  );
  const confirmed = explanationFacts(explanation({ confirmationNote: "He was with me", confirmationStatus: "confirmed" }));
  assert.deepEqual(confirmed[0], { label: "Their reason", value: "Training" });
  assert.deepEqual(confirmed[1], { label: "Confirmation", tone: "success", value: "Ahmed Ali: Confirmed — He was with me" });
  assert.equal(explanationFacts(explanation({ confirmationStatus: "declined" }))[1].tone, "danger", "a decline reads as a warning sign");
  assert.equal(explanationFacts(explanation({ confirmationStatus: "awaiting" }))[1].tone, "warning");
  assert.deepEqual(
    explanationFacts(explanation({ confirmerHrId: null, confirmerName: null, confirmationStatus: "not_needed", reasonCode: "other" }))[1],
    { label: "Confirmation", value: "Nobody to confirm it — their own words" },
  );

  // ── 4 · The wiring ────────────────────────────────────────────────────────────────────────────
  const server = read("src/lib/dispute-center/explanations.ts");
  // The confirmer's awaiting list is read whole and THEN cut to the open cases; a row cap first hid live requests behind old decided ones.
  const listFn = /export async function listExplanationGroupsAwaitingViewer\([\s\S]*?\n\}/.exec(server)?.[0] ?? "";
  assert.ok(listFn.includes("fetchAllRows"), "the confirmer's awaiting list is read whole, then cut to the open cases");
  assert.doesNotMatch(listFn, /\.limit\(/, "a row cap before withOpenCases hides newer live requests behind older decided ones");
  // The proof text names who was ASKED: it is saved at submission, before anyone answers.
  assert.equal(explanationVerifySource({ confirmerName: "Ahmed", reasonCode: "training" }), "Named confirmer: Ahmed");
  assert.doesNotMatch(explanationVerifySource({ confirmerName: "Ahmed", reasonCode: "meeting" }), /^Confirmed/);
  assert.equal(currentVerificationSourceText("Confirmed by Ahmed"), "Named confirmer: Ahmed", "a request filed before the wording was fixed reads as what it was");
  assert.equal(currentVerificationSourceText("Manager Confirmation"), "Manager Confirmation", "an ordinary option is left alone");
  const notice = server.slice(server.indexOf("export async function notifyExplanationConfirmer"), server.indexOf("// ── The confirmer's side"));
  assert.match(notice, /channels: \["in_app", "push"\]/, "the confirmer is told in-app and by push");
  assert.doesNotMatch(notice, /"email"/, "and never by email");
  assert.match(server, /otherKinds = \(\["calendar", "deduction", "daily"\] as const\)\.filter\(\(kind\) => kind !== input\.caseKind\)/,
    "a deduction dispute refuses a day already explained on the calendar or the other deduction box");

  const calendarSubmit = read("src/lib/private-calendar/disputes.ts");
  assert.match(calendarSubmit, /assertDaysNotExplainedElsewhere\(\{ dates, employeeHrId, otherKinds: \["deduction", "daily"\] \}\)/,
    "the calendar refuses a day already explained on a deduction dispute");
  assert.match(calendarSubmit, /assertDaysStillExplainable\(employeeHrId, dates\)/, "and a day whose payroll month is confirmed");
  const bulk = calendarSubmit.slice(calendarSubmit.indexOf("export async function decidePrivateCalendarDataDisputes"));
  assert.match(
    bulk.slice(0, bulk.indexOf(".update({")),
    /explained\.get\(id\)\?\.confirmationStatus !== "confirmed"/,
    "the server refuses to accept together any request the person named has not confirmed, before anything is written",
  );

  for (const [name, path] of [
    ["the daily deduction", "src/lib/dispute-center/daily.ts"],
    ["the monthly deduction", "src/lib/deductions/comments.ts"],
  ] as const) {
    const source = read(path);
    assert.match(source, /await prepareCaseExplanation\(\{/, `${name} dispute checks the explanation before anything is written`);
    assert.match(source, /await recordCaseExplanation\(\{/, `${name} dispute saves it once the dispute exists`);
  }

  for (const [name, path] of [
    ["the daily deduction box", "src/components/employee-portal/daily-deduction-dispute-box.tsx"],
    ["the monthly deduction box", "src/components/employee-portal/deductions-workspace.tsx"],
  ] as const) {
    const source = read(path);
    assert.match(source, /<ExplainReasonFields\b/, `${name} opens with the reason list`);
    assert.match(source, /explanation/, `${name} sends the explanation`);
    assert.doesNotMatch(source, /Why is this deduction wrong\?/, `${name} no longer asks why the deduction is wrong`);
  }

  const confirmersRoute = read("app/api/dispute-center/explanations/confirmers/route.ts");
  assert.match(confirmersRoute, /assertPermission\(access, "employee_profile", "read"\)/,
    "the Deductions page's employees can load who confirms (the calendar's attendance read is not theirs to need)");

  const inbox = read("src/components/admin/private-calendar-disputes-workspace.tsx");
  const sentence = inbox.slice(inbox.indexOf("function claimSentence"), inbox.indexOf("/** Which shelf"));
  assert.doesNotMatch(sentence, /is wrong/, "the inbox never says the employee's day is wrong");
  assert.match(inbox, /"\/api\/private-calendar\/disputes\/decide-many"/, "Accept all is one request");
  assert.match(inbox, /bulkAcceptable: code !== null && code !== "other"/, "never on Something else or a pre-list request");
  assert.match(inbox, /if \(dispute\.explanation\?\.confirmationStatus !== "confirmed"\) group\.bulkAcceptable = false;/,
    "and only where every request in the group was confirmed by the person named");
  assert.match(inbox, /armedGroup === groupKey \?/, "Accept all takes two clicks");

  // 4. How a day reads to a person. Names, never ISO strings; a span only where the days really run on.
  assert.equal(explainDayLabel("2026-11-12"), "Thu 12 Nov", "one day keeps its weekday");
  assert.equal(explainDayLabel("2026-02-30"), "2026-02-30", "a date that does not exist is shown as sent, never moved");
  assert.equal(explainDatesPhrase([]), "", "no days, no phrase");
  assert.equal(explainDatesPhrase(["2026-11-12"]), "Thu 12 Nov");
  assert.equal(
    explainDatesPhrase(["2026-11-07", "2026-11-08", "2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12"]),
    "7–12 Nov",
    "a training week folds into one span",
  );
  assert.equal(
    explainDatesPhrase(["2026-11-07", "2026-11-08", "2026-11-09", "2026-11-12"]),
    "7–9 Nov and 12 Nov",
    "a gap is never bridged: 10 and 11 Nov were not explained, so the phrase must not claim them",
  );
  assert.equal(
    explainDatesPhrase(["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-05", "2026-11-09"]),
    "30 Oct – 1 Nov, 5 Nov and 9 Nov",
    "a run across the month end names both months",
  );
  assert.equal(explainDatesPhrase(["2026-12-31", "2027-01-01"]), "31 Dec – 1 Jan", "and across the year end");
  assert.equal(
    explainDatesPhrase(["2026-11-09", "2026-11-07", "2026-11-08", "2026-11-08", "not a day"]),
    "7–9 Nov",
    "days arrive unsorted, repeated or broken and still read once, in order",
  );

  // September is the month the reader's ICU and the server's disagree on ("Sep" against "Sept"), so the
  // labels carry the app's own month table and never call Intl — a client component renders them.
  assert.equal(explainDayLabel("2026-09-15"), "Tue 15 Sept", "September is spelt the way the shipped month table spells it");
  assert.equal(explainDatesPhrase(["2026-09-29", "2026-09-30", "2026-10-01"]), "29 Sept – 1 Oct");
  assert.doesNotMatch(
    read("src/lib/dispute-center/explain-reasons.ts"),
    /Intl\.DateTimeFormat|toLocale(Date)?String/,
    "the day labels never ask the reader's ICU for a month name (React error #418, in September only)",
  );

  for (const code of EXPLAIN_REASON_CODES) {
    assert.ok(explainReasonPhrase(code).length > 0, `${code} reads in a sentence`);
    assert.doesNotMatch(explainReasonPhrase(code), /wrong/, `${code} never calls the day wrong`);
  }
  assert.equal(explainReasonPhrase("meeting"), "in a meeting");
  assert.equal(explainReasonPhrase("training"), "in training");

  const counted = explainDetailProgress("I was at the Tanta distributor all day");
  assert.deepEqual(counted, { chars: 38, enough: true, words: 8 }, "the counter counts what the employee typed");
  for (const text of [
    "",
    "short",
    "four words but tiny",
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "abcd efgh ijkl mnop qrst",
    "abcd efgh ijkl mnop qrstu",
    "  abcd			efgh     ijkl      mnop    ",
    "  I   was\tat the\r\n\r\n\r\n\r\nTanta distributor  ",
    "— — — — — — — — — — — — —",
    "كنت في اجتماع مع المدير طوال اليوم",
  ]) {
    const serverSaysEnough = refusal(() => validateExplanationReason({ detailText: text, reasonCode: "other" })) === "";
    assert.equal(
      explainDetailProgress(text).enough,
      serverSaysEnough,
      `the counter and the server agree about ${JSON.stringify(text)}`,
    );
  }
  assert.equal(explainDetailProgress("abcd efgh ijkl mnop qrst").enough, false, "24 characters is one short");
  assert.deepEqual(
    explainDetailProgress("  abcd			efgh     ijkl      mnop    "),
    { chars: 19, enough: false, words: 4 },
    "spaces typed to pad the box are not counted, exactly as the server does not count them",
  );
  assert.equal(explainDetailProgress("abcd efgh ijkl mnop qrstu").enough, true, "25 characters and 4 words is enough");

  // The days a send carries are the ones the picker still LISTS. Stepping to another month keeps earlier ticks in the
  // component's state while the picker shows only that month's days, so the button counted — and the post carried —
  // days the person could no longer see (ticked 3 and 5 Nov, moved to October: "Send for 3 days").
  const screen = readFileSync("src/components/employee-portal/private-calendar.tsx", "utf8").replace(/\r\n/g, "\n");
  assert.ok(
    screen.includes("const explainExtraDatesToSend = explainExtraDates.filter((date) => date !== selectedDate && explainableDays.includes(date));"),
    "the extras sent are only days still offered, never the selected day and never a day from a month no longer on screen",
  );
  assert.ok(screen.includes("explainExtraDatesToSend.length + 1"), "and the button counts exactly those");
}
