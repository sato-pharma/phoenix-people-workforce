import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
  notifyDailyDeductionsReleased,
  releasedLineMonthKey,
  type ReleasedLineForNotice,
} from "../src/lib/daily-deductions/notify-release.ts";
import {
  buildDeductionEmailMetrics,
  buildDeductionEmailSummary,
} from "../src/lib/deductions/notify-deduction.ts";
import { deductionsCategories, deductionsCategoryNames } from "../src/lib/deductions/types.ts";

/**
 * A RELEASED DAILY DEDUCTION TELLS THE EMPLOYEE (owner, 2026-10-12: "i released a deduction the
 * employee not recieve an email").
 *
 * The defect, read off production the same day: he released one line at 14:13 Cairo — Nahed Tarek,
 * 11 October, no_records_activity, 1,032.26 EGP — and nothing at all was enqueued for her. The
 * monthly Deductions page has notified the employee since 2026-09-22; the daily Release button wrote
 * the snapshot and the audit log and notified nobody. Silence, not a delivery failure.
 *
 * What this pins:
 *
 *   1. the release path CALLS the notifier at all — the one assertion that fires if the silence
 *      ever comes back;
 *   2. the month label comes from the DAY the deduction charges, never from the clock;
 *   3. one notice per released line, carrying that line's own stable id, so a re-release of a line
 *      already in the snapshot re-sends nothing;
 *   4. a line whose row cannot be read back is reported as `not_found`, never counted as sent;
 *   5. the EMPLOYEE's email states the amount, the reason and the days (owner, 2026-10-12: asked
 *      whether to keep his 2026-09-22 "never email" rule after this silence was reported, he chose
 *      *add email, with the amount and the reason*) — while in-app and Telegram still say neither,
 *      and the MANAGER CC gets no email at all;
 *   6. the amount and the day count reach the notifier from the stored ROW, so the mail cannot
 *      state a figure the line did not freeze.
 */

function line(overrides: Partial<ReleasedLineForNotice> = {}): ReleasedLineForNotice {
  return {
    amount: 1032.26,
    category: "no_records_activity",
    dates: ["2026-10-11"],
    daysCount: 1,
    deductionDate: null,
    employeeHrId: "A-10",
    employeeHrIdCompact: "a10",
    employeeName: "Nahed Tarek",
    id: "line-1",
    rangeEnd: "2026-10-11",
    ...overrides,
  };
}

function theReleasePathActuallyNotifies(): void {
  const source = readFileSync(new URL("../src/lib/daily-deductions/release.ts", import.meta.url), "utf8");
  // THE HEADLINE ASSERTION. Take the call back out — or rename it to something that no longer
  // resolves — and this is the line that fires. The word boundary matters: a substring check passes
  // happily against a typo'd `notifyDailyDeductionsReleasedXX`, which notifies nobody.
  assert.match(
    source,
    /\?\?\s*notifyDailyDeductionsReleased\s*\)\s*\(/,
    "releaseDailyLines must CALL the notifier — releasing in silence is the defect this file exists for",
  );
  assert.match(
    source,
    /import \{[^}]*\bnotifyDailyDeductionsReleased\b[^}]*\} from "\.\/notify-release\.ts"/,
    "and import it from the one notifier, so there is a single wording and a single CC rule",
  );
  assert.ok(
    /notifications,/.test(source),
    "the outcome per line is recorded on the audit entry, so a report can never imply a notice that did not go out",
  );
}

function theMonthComesFromTheDayNotTheClock(): void {
  assert.equal(releasedLineMonthKey(line()), "2026-10");
  assert.equal(
    releasedLineMonthKey(line({ dates: ["2026-10-01", "2026-09-30"] })),
    "2026-09",
    "the earliest charged day decides the label, so a release spanning a month boundary names the right one",
  );
  assert.equal(
    releasedLineMonthKey(line({ dates: [], rangeEnd: "2026-09-30" })),
    "2026-09",
    "with no per-day dates the window's end is the fallback",
  );
  assert.equal(releasedLineMonthKey(line({ dates: ["nonsense"], rangeEnd: null })), "");
}

async function oneNoticePerLineCarryingItsOwnStableId(): Promise<void> {
  const calls: Array<{ id: string; monthKey: string; employeeHrId: string; amount?: number | null; daysCount?: number | null }> = [];
  const outcomes = await notifyDailyDeductionsReleased({
    actorHrId: "B-10",
    loadLines: async () => [line(), line({ amount: 2500.5, category: "dsm_no_record", daysCount: 2, employeeHrId: "DM-0007", employeeHrIdCompact: "dm0007", employeeName: "Saad Mohamed Saad Salama", id: "line-2" })],
    notify: async ({ line: notice }) => {
      calls.push({ amount: notice.amount, daysCount: notice.daysCount, employeeHrId: notice.employeeHrId, id: notice.id, monthKey: notice.monthKey });
      return { ccHrIds: ["DM-0007", "B-1"], employeeNotified: true, status: "sent" as const };
    },
    pairs: [
      { category: "no_records_activity", employeeHrId: "A-10", employeeHrIdCompact: "a10" },
      { category: "dsm_no_record", employeeHrId: "DM-0007", employeeHrIdCompact: "dm0007" },
    ],
    publicationId: "pub-1",
  });

  assert.deepEqual(
    calls,
    [
      { amount: 1032.26, daysCount: 1, employeeHrId: "A-10", id: "line-1", monthKey: "2026-10" },
      { amount: 2500.5, daysCount: 2, employeeHrId: "DM-0007", id: "line-2", monthKey: "2026-10" },
    ],
    "each released line is notified once under its own line id — and its OWN stored amount and day count reach the email",
  );
  assert.deepEqual(
    outcomes.map((outcome) => [outcome.employeeHrId, outcome.status, outcome.ccCount]),
    [
      ["A-10", "sent", 2],
      ["DM-0007", "sent", 2],
    ],
  );
}

async function aPairWhoseRowCannotBeReadIsNeverCountedAsSent(): Promise<void> {
  let notified = 0;
  const outcomes = await notifyDailyDeductionsReleased({
    actorHrId: "B-10",
    // Only one of the two pairs comes back, and an unrelated category of the same person comes with
    // it — the read is per employee, so the pair filter is what keeps it honest.
    loadLines: async () => [line(), line({ category: "fingerprint", id: "line-stale" })],
    notify: async () => {
      notified += 1;
      return { ccHrIds: [], employeeNotified: true, status: "sent" as const };
    },
    pairs: [
      { category: "no_records_activity", employeeHrId: "A-10", employeeHrIdCompact: "a10" },
      { category: "dsm_no_record", employeeHrId: "DM-0007", employeeHrIdCompact: "dm0007" },
    ],
    publicationId: "pub-1",
  });

  assert.equal(notified, 1, "a category this release did not name is not notified");
  assert.deepEqual(
    outcomes.map((outcome) => [outcome.employeeHrId, outcome.status]),
    [
      ["A-10", "sent"],
      ["DM-0007", "not_found"],
    ],
    "the unread pair is reported, never silently dropped and never counted as sent",
  );
}

async function aFailedReadBackIsReportedAndNeverThrows(): Promise<void> {
  const outcomes = await notifyDailyDeductionsReleased({
    actorHrId: "B-10",
    loadLines: async () => {
      throw new Error("PostgREST exploded");
    },
    notify: async () => {
      throw new Error("must not be reached");
    },
    pairs: [{ category: "no_records_activity", employeeHrId: "A-10", employeeHrIdCompact: "a10" }],
    publicationId: "pub-1",
  });
  assert.deepEqual(
    outcomes.map((outcome) => outcome.status),
    ["not_found"],
    "the money is already committed when this runs — a read failure is reported, never thrown back into the release",
  );
}

/**
 * THE EMPLOYEE IS EMAILED; THE MANAGER CHAIN IS NOT.
 *
 * The owner's 2026-10-12 answer replaced his 2026-09-22 "a deduction notice never goes by email"
 * for the employee's OWN copy only. A manager's inbox must still not carry a colleague's figure, so
 * the CC declares no email channel and has no `email` block to carry content even if one were added.
 */
function theEmployeeIsEmailedAndTheManagerChainIsNot(): void {
  const notifier = readFileSync(new URL("../src/lib/deductions/notify-deduction.ts", import.meta.url), "utf8");
  const channelLines = notifier.split("\n").filter((text) => text.trimStart().startsWith("channels:"));
  assert.equal(channelLines.length, 2, "exactly two sends: the employee's notice and the manager CC");

  const [employeeChannels, ccChannels] = channelLines;
  assert.ok(
    employeeChannels.includes('"in_app"') && employeeChannels.includes('"telegram"') && employeeChannels.includes('"email"'),
    "the employee's notice carries all three channels — the email is the owner's 2026-10-12 decision",
  );
  assert.ok(
    !ccChannels.includes('"email"'),
    "the manager CC is never emailed: his decision widened the EMPLOYEE's own copy, not who sees the figure",
  );

  // The employee's send is the only one with an `email` block, and the generic in-app/Telegram
  // message beside it still names no amount and no category.
  assert.equal((notifier.match(/^\s{6}email: \{/gm) ?? []).length, 1, "one email block, on the employee's send");
  const message = /message: `A payroll deduction has been recorded on your account for \$\{monthLabel\}\./.exec(notifier);
  assert.ok(message, "in-app and Telegram keep the generic sentence — a lock screen is read by whoever holds the phone");
}

/**
 * `Intl.NumberFormat` separates "EGP" from the figure with a NON-BREAKING space (U+00A0), so an
 * expectation typed with an ordinary space fails on a value that is correct. Normalise, then compare
 * the text — never loosen the assertion to a substring that would also pass on a missing amount.
 */
function plainSpaces(value: string | number): string {
  return String(value).replace(/ /g, " ");
}

/** The email names the amount, the reason and the days — and names NOTHING it was not given. */
function theEmailNamesTheAmountTheReasonAndTheDays(): void {
  const metrics = buildDeductionEmailMetrics(
    {
      amount: 1032.26,
      category: "no_records_activity",
      dates: ["2026-10-11"],
      daysCount: 1,
      employeeHrId: "A-10",
      employeeName: "Nahed Tarek",
      id: "line-1",
      monthKey: "2026-10",
    },
    "October 2026",
  );
  assert.deepEqual(
    metrics.map((metric) => ({ label: metric.label, value: plainSpaces(metric.value) })),
    [
      { label: "Employee", value: "Nahed Tarek" },
      { label: "Month", value: "October 2026" },
      { label: "Reason", value: "No records — no punch and no other activity recorded" },
      { label: "Days deducted", value: "1 day" },
      { label: "Amount deducted", value: "EGP 1,032.26" },
      { label: "Day charged", value: "Sunday, 11 October 2026" },
    ],
    "the released line the owner actually sent on 2026-10-12, as the employee would now read it",
  );

  const summary = buildDeductionEmailSummary(
    { amount: 1032.26, category: "no_records_activity", daysCount: 1, employeeHrId: "A-10", employeeName: "Nahed Tarek", id: "line-1", monthKey: "2026-10" },
    "October 2026",
  );
  assert.match(plainSpaces(summary), /EGP 1,032\.26/, "the amount is in the opening sentence, not only in the table");
  assert.match(summary, /Reason: No records/, "and so is the reason, in words");

  // A figure the caller could not resolve is OMITTED, never mailed as a confident zero.
  const bare = buildDeductionEmailMetrics(
    { amount: null, category: "loan", daysCount: null, employeeHrId: "B-12", employeeName: "Dina Hamdy", id: "line-2", monthKey: "2026-09" },
    "September 2026",
  );
  assert.deepEqual(bare.map((metric) => metric.label), ["Employee", "Month", "Reason"]);
  assert.ok(
    !buildDeductionEmailSummary(
      { amount: null, category: "loan", daysCount: null, employeeHrId: "B-12", employeeName: "Dina Hamdy", id: "line-2", monthKey: "2026-09" },
      "September 2026",
    ).includes("0.00"),
    "an unresolved amount must never reach an employee's inbox as 0.00",
  );

  // A half day reads as a half day, and a long month names ten days and counts the rest.
  const half = buildDeductionEmailMetrics(
    { amount: 508.33, category: "crm_half_day", daysCount: 0.5, employeeHrId: "PD-0014", employeeName: "Osama Mohamed El-said Mahmoud Ahmed", id: "line-3", monthKey: "2026-09" },
    "September 2026",
  );
  assert.ok(
    half.some((metric) => metric.label === "Days deducted" && metric.value === "half a day"),
    'a crm_half_day line reads "half a day" — "0.5 days" in a letter about someone\'s pay reads like a system string',
  );
  const many = buildDeductionEmailMetrics(
    {
      amount: 12000,
      category: "crm",
      dates: Array.from({ length: 13 }, (_, index) => `2026-09-${String(index + 1).padStart(2, "0")}`),
      daysCount: 13,
      employeeHrId: "MR-0001",
      employeeName: "A Rep",
      id: "line-4",
      monthKey: "2026-09",
    },
    "September 2026",
  );
  assert.match(String(many.at(-1)?.value), /and 3 more$/, "ten named days, the rest counted — the portal holds the full list");

  // Every category has a sentence. A new one that forgets this mails its raw code to an employee.
  for (const category of deductionsCategories) {
    const name = deductionsCategoryNames[category];
    assert.ok(name && name !== category, `category ${category} needs a human name for the email`);
  }
}

export async function runDailyDeductionsReleaseNoticeTests(): Promise<void> {
  theReleasePathActuallyNotifies();
  theMonthComesFromTheDayNotTheClock();
  await oneNoticePerLineCarryingItsOwnStableId();
  await aPairWhoseRowCannotBeReadIsNeverCountedAsSent();
  await aFailedReadBackIsReportedAndNeverThrows();
  theEmployeeIsEmailedAndTheManagerChainIsNot();
  theEmailNamesTheAmountTheReasonAndTheDays();
}
