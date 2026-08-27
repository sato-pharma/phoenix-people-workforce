import assert from "node:assert/strict";

import {
  addDays,
  daysBetween,
  firstOfNextMonth,
  isIsoDate,
  parseLetterDate,
  todayInCairo,
  toLetterDate,
} from "@/lib/offers/dates";

export function runOfferDatesTests() {
  // ── The headline: the picker's format and the letter's format must survive each other ──
  //
  // The composer holds `2026-09-01` and the letter carries `01 September 2026`. If either
  // direction of that conversion shifts a day, an offer names a start date the candidate never
  // agreed to — and nothing about the letter looks wrong, so nobody catches it.
  for (const iso of [
    "2026-01-01",
    "2026-02-28",
    "2026-03-01",
    "2026-06-15",
    "2026-08-27",
    "2026-09-01",
    "2026-12-31",
    "2028-02-29",
  ]) {
    const printed = toLetterDate(iso);
    assert.equal(
      parseLetterDate(printed),
      iso,
      `${iso} printed as "${printed}" and did not read back as the same day — a date on a letter ` +
        "moved between the picker and the page",
    );
  }

  assert.equal(toLetterDate("2026-09-01"), "01 September 2026");
  assert.equal(toLetterDate("2026-08-27"), "27 August 2026");

  // Two-digit day, deliberately: this is the form the approved template letters already carry, and
  // changing it would restyle every offer issued in the first nine days of a month.
  assert.ok(
    toLetterDate("2026-09-01").startsWith("01 "),
    "the letter date must keep its two-digit day — the owner approved the template line by line",
  );

  // ── A bare date must not be dragged across midnight by a timezone ──
  //
  // `new Date("2026-09-01")` is midnight UTC. Read in any zone behind UTC that is 31 August, which
  // is how a start date silently becomes the day before.
  assert.equal(
    toLetterDate("2026-09-01"),
    "01 September 2026",
    "a bare calendar date must be read as UTC, never shifted into a local zone",
  );

  // ── Rejecting what is not a date, rather than guessing ──
  for (const bad of ["", "not a date", "2026-13-01", "2026-02-30", "2026-1-1", "01/09/2026"]) {
    assert.equal(toLetterDate(bad), "", `"${bad}" is not a date and must render as nothing, not as a guess`);
    assert.equal(isIsoDate(bad), false, `"${bad}" must not pass as an ISO date`);
  }

  // 2026 is not a leap year; 2028 is. A rolled-forward 29 February would be a real wrong date.
  assert.equal(isIsoDate("2026-02-29"), false, "29 February 2026 does not exist and must not roll into March");
  assert.equal(isIsoDate("2028-02-29"), true, "29 February 2028 does exist");

  // ── parseLetterDate is forgiving about shape, strict about meaning ──
  assert.equal(parseLetterDate("1 September 2026"), "2026-09-01", "a bare day is still a date somebody meant");
  assert.equal(parseLetterDate("1 september 2026"), "2026-09-01", "capitalisation is not meaning");
  assert.equal(parseLetterDate("32 September 2026"), null, "there is no 32nd of any month");
  assert.equal(parseLetterDate("1 Septembre 2026"), null, "an unknown month name must be null, not a guess");
  assert.equal(parseLetterDate(""), null);

  // ── Day arithmetic, including across the boundaries that break naive implementations ──
  assert.equal(addDays("2026-08-27", 7), "2026-09-03", "a week later must cross the month end");
  assert.equal(addDays("2026-12-28", 7), "2027-01-04", "a week later must cross the year end");
  assert.equal(addDays("2028-02-28", 1), "2028-02-29", "a leap day must be reachable");
  assert.equal(addDays("2026-02-28", 1), "2026-03-01", "and must not be invented in a non-leap year");
  assert.equal(addDays("", 7), "", "nothing plus seven days is still nothing");

  assert.equal(firstOfNextMonth("2026-08-27"), "2026-09-01");
  assert.equal(firstOfNextMonth("2026-12-15"), "2027-01-01", "December's next month is in the next year");
  assert.equal(firstOfNextMonth("2026-01-01"), "2026-02-01", "already on a first is still the NEXT month");
  assert.equal(firstOfNextMonth("bad"), "");

  assert.equal(daysBetween("2026-08-27", "2026-09-03"), 7);
  assert.equal(daysBetween("2026-09-03", "2026-08-27"), -7, "backwards must be negative, not absolute");
  assert.equal(daysBetween("2026-08-27", "2026-08-27"), 0);
  assert.equal(daysBetween("", "2026-08-27"), null, "an unset date cannot be compared and must answer null");

  // ── Today, in Cairo, not in UTC ──
  //
  // Cairo runs ahead of UTC, so late in the UTC evening the two disagree about the date. An offer
  // issued at 11pm Cairo is dated today here, not tomorrow.
  const lateUtcEvening = new Date("2026-08-27T22:30:00Z");
  assert.equal(
    todayInCairo(lateUtcEvening),
    "2026-08-28",
    "22:30 UTC is already the next day in Cairo, and the letter is dated where the company is",
  );
  assert.match(todayInCairo(), /^\d{4}-\d{2}-\d{2}$/, "today must come back in the format the picker accepts");
  assert.ok(isIsoDate(todayInCairo()), "today must be a date the rest of this module can read");
}
