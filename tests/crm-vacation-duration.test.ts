import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildVacationPeriod, nationalHolidayNamesByDate, type VacationDayRow } from "../src/lib/crm/master.ts";

// Regression for #1523. `buildVacationPeriod` summed 0.5 per AM/PM ROW and 1 per full-day ROW, but
// the iReports360 mirror really does carry duplicate rows for the same agent/date/AM-PM marker —
// 39 such groups covering 50 extra rows in production. A single AM half-day logged twice therefore
// read as a FULL day, and `half_days` (documented as "how many days of this period were halves")
// counted rows rather than dates, so the same duplicate also made half_days overshoot.
//
// The fix collapses per calendar DATE before summing:
//   any full-day marker on a date  -> 1 day
//   otherwise                      -> 0.5 x DISTINCT half markers, capped at 1
// so a genuine AM + PM pair is still a full day while a duplicated AM + AM is still a half. That
// distinction is the whole point, and it is what the AM+PM / AM+AM pairs below pin: any
// implementation that counts rows makes those two cases identical.
//
// The second half of this file covers the national-holiday LABEL on a vacation period, which used
// to come from a hand-rolled 2026 date map in the same module and now comes from the confirmed
// source (Google's Egypt feed + attendance_holiday_overrides).

let nextId = 1;

function day(date: string, ampm: string | null): VacationDayRow {
  return {
    agent_crm_id: 42,
    agent_hr_id: "PH-0042",
    agent_name: "Test Agent",
    ampm,
    comment: null,
    crm_visit_id: nextId++,
    visit_date: date,
    visit_type_description: "Annual Vacation",
  };
}

export function runCrmVacationDurationTests() {
  // ── AM + PM on one date is a full day; AM + AM (a duplicate) is still a half ─────
  // Row-counting gives 1 for BOTH, so these two assertions together are what separates a correct
  // implementation from the one this test exists to prevent.
  {
    const amPm = buildVacationPeriod([day("2026-07-01", "AM"), day("2026-07-01", "PM")]);
    assert.equal(amPm.duration, 1, "a real AM + PM pair on one date is a full day");
    assert.equal(amPm.half_days, 0, "a date that resolved to a full day is not a half-day");

    const amAm = buildVacationPeriod([day("2026-07-02", "AM"), day("2026-07-02", "AM")]);
    assert.equal(amAm.duration, 0.5, "a duplicated AM half-day must stay half a day, not become a full one");
    assert.equal(amAm.half_days, 1, "half_days counts DATES that resolved to half a day");
  }

  // ── A lone half-day, and a lone full day ────────────────────────────────────────
  {
    const half = buildVacationPeriod([day("2026-07-01", "AM")]);
    assert.equal(half.duration, 0.5, "a single AM row is half a day");
    assert.equal(half.half_days, 1);

    const full = buildVacationPeriod([day("2026-07-01", null)]);
    assert.equal(full.duration, 1, "a row with no AM/PM marker is a full day");
    assert.equal(full.half_days, 0);
  }

  // ── A duplicated FULL day must not become two days ──────────────────────────────
  {
    const period = buildVacationPeriod([day("2026-07-01", null), day("2026-07-01", null)]);
    assert.equal(period.duration, 1, "the same full day logged twice is still one day");
    assert.equal(period.half_days, 0);
  }

  // ── A full-day marker wins over a half on the same date ─────────────────────────
  {
    const period = buildVacationPeriod([day("2026-07-01", "AM"), day("2026-07-01", null)]);
    assert.equal(period.duration, 1, "any full-day marker on a date makes that date a whole day");
    assert.equal(period.half_days, 0, "a date resolved by a full-day marker is not counted as a half");
  }

  // ── Three markers on one date still cap at a single day ─────────────────────────
  {
    const period = buildVacationPeriod([day("2026-07-01", "AM"), day("2026-07-01", "PM"), day("2026-07-01", "AM")]);
    assert.equal(period.duration, 1, "0.5 per DISTINCT marker, capped at 1 — a date can never exceed one day");
    assert.equal(period.half_days, 0);
  }

  // ── A multi-day run mixes full, half and duplicated dates correctly ─────────────
  {
    const period = buildVacationPeriod([
      day("2026-07-01", null), // full                     -> 1
      day("2026-07-02", "AM"),
      day("2026-07-02", "PM"), // real AM+PM pair          -> 1
      day("2026-07-03", "PM"),
      day("2026-07-03", "PM"), // duplicated PM half       -> 0.5
      day("2026-07-04", "AM"), // lone AM half             -> 0.5
    ]);
    assert.equal(period.duration, 3, "6 rows across 4 dates = 1 + 1 + 0.5 + 0.5 (row-counting gives 3.5)");
    assert.equal(period.half_days, 2, "only 07-03 and 07-04 resolved to half a day");
    assert.equal(period.from_date, "2026-07-01");
    assert.equal(period.to_date, "2026-07-04");
  }

  // ── Duplicates must not disturb the period's identity or its raw payload ────────
  // vacation_id is the MIN crm_visit_id of the run and is what cross-references a period between
  // views, so the de-duplication must not drop the row that carries the lowest id.
  {
    const rows = [day("2026-07-01", "AM"), day("2026-07-01", "AM"), day("2026-07-02", "PM")];
    const ids = rows.map((r) => r.crm_visit_id as number);
    const period = buildVacationPeriod(rows);
    assert.equal(period.vacation_id, Math.min(...ids), "vacation_id stays the earliest CRM visit id");
    assert.deepEqual(
      (period.raw_payload as { visit_ids: number[] }).visit_ids,
      ids,
      "raw_payload keeps EVERY underlying row, including the duplicates — the collapse is for counting only",
    );
    assert.equal(period.duration, 1, "0.5 (duplicated AM) + 0.5 (PM) = 1");
  }

  // ── A timestamped visit_date is collapsed on its calendar date ──────────────────
  // visit_date is sliced to YYYY-MM-DD everywhere else in this function; two rows for the same date
  // must group together even when one carries a time component.
  {
    const period = buildVacationPeriod([day("2026-07-01T00:00:00Z", "AM"), day("2026-07-01", "AM")]);
    assert.equal(period.duration, 0.5, "same calendar date must collapse regardless of a time suffix");
    assert.equal(period.half_days, 1);
  }

  // ── The national-holiday label comes from the CONFIRMED source, not a hand-rolled map ──────────
  // This module used to carry its own 2026 date -> name map, and it disagreed with
  // attendance_holiday_overrides + Google's Egypt feed on four entries at once. The rows below are
  // the CONFIRMED shape `getConfirmedNationalHolidaysForPeriods` returns (spans, with an override's
  // observed date already substituted for its official one), and `nationalHolidayNamesByDate` is
  // the expansion the master builder injects into `buildVacationPeriod`.
  //
  // Each wrong date cost twice: a rep's ordinary leave on a working day read as a national holiday,
  // so the day was excused; and the real day off carried no label unless his own comment named it.
  {
    const confirmed = nationalHolidayNamesByDate([
      // Eid al-Fitr — confirmed 19 and 20 March. The old map said 20, 21 and 22.
      { endDate: "2026-03-19", name: "Eid el Fitr Holiday", startDate: "2026-03-19" },
      { endDate: "2026-03-20", name: "Eid el Fitr", startDate: "2026-03-20" },
      // Eid al-Adha — one multi-day SPAN, which is how the confirmed source returns it.
      { endDate: "2026-05-30", name: "Eid al-Adha", startDate: "2026-05-27" },
      // 30 June Revolution — override row 1 on production: official 2026-06-30, observed 2026-07-02.
      { endDate: "2026-07-02", name: "30 June Revolution", startDate: "2026-07-02" },
      // Prophet's Birthday — confirmed 27 August. The old map said the 26th.
      { endDate: "2026-08-27", name: "Prophet Mohamed's Birthday Holiday", startDate: "2026-08-27" },
      // Armed Forces Day — official 6 October (a TUESDAY in 2026), observed Thursday 8 October.
      { endDate: "2026-10-08", name: "Armed Forces Day", startDate: "2026-10-08" },
    ]);

    const labelOn = (date: string) => buildVacationPeriod([day(date, null)], confirmed).national_holiday;

    // A multi-day span labels EVERY one of its days, not just the first.
    for (const date of ["2026-05-27", "2026-05-28", "2026-05-29", "2026-05-30"]) {
      assert.equal(labelOn(date), "Eid al-Adha", `${date} is inside the confirmed Eid al-Adha span`);
    }
    assert.equal(labelOn("2026-05-31"), null, "the day after the span ends is an ordinary working day");

    // The three dates the hand-rolled map had wrong.
    assert.equal(
      labelOn("2026-07-02"),
      "30 June Revolution",
      "the 30 June Revolution day off is observed on 2 July — override row 1 on production",
    );
    assert.equal(
      labelOn("2026-06-30"),
      null,
      "30 June 2026 is a working day: the day off was postponed to 2 July, and the old map labelled the wrong one",
    );
    assert.equal(
      labelOn("2026-08-27"),
      "Prophet Mohamed's Birthday Holiday",
      "the Prophet's Birthday is confirmed on 27 August",
    );
    assert.equal(labelOn("2026-08-26"), null, "26 August 2026 is a working day — the old map was a day early");
    assert.equal(
      labelOn("2026-03-19"),
      "Eid el Fitr Holiday",
      "Eid al-Fitr starts on 19 March, which the old map missed entirely",
    );
    assert.equal(labelOn("2026-03-20"), "Eid el Fitr", "20 March is the second confirmed Eid al-Fitr day");
    assert.equal(labelOn("2026-03-21"), null, "21 March 2026 is a working day — the old map ran Eid two days long");
    assert.equal(labelOn("2026-03-22"), null, "22 March 2026 is a working day — the old map ran Eid two days long");

    // #5079's ruling, now pinned through the confirmed source. Owner, 2026-10-01: 6 October 2026
    // falls on a TUESDAY, so the day off is observed on Thursday 8 October. Keeping both halves here
    // means the ruling survives the map's removal.
    assert.equal(
      new Date("2026-10-06T00:00:00Z").getUTCDay(),
      2,
      "2026-10-06 must be a Tuesday — that is why the day off moved to Thursday 8 October",
    );
    assert.equal(
      labelOn("2026-10-08"),
      "Armed Forces Day",
      "the observed day off, Thursday 8 October, carries the holiday name",
    );
    assert.equal(
      labelOn("2026-10-06"),
      null,
      "6 October 2026 is a working day — leave logged on it is an ordinary vacation, not a national holiday",
    );

    // A period is flagged when ANY of its days is a holiday, and takes that day's name.
    const straddling = buildVacationPeriod(
      [day("2026-10-07", null), day("2026-10-08", null), day("2026-10-09", null)],
      confirmed,
    );
    assert.equal(straddling.national_holiday, "Armed Forces Day", "a run containing the day off is flagged with its name");
    assert.equal(straddling.duration, 3, "the label never changes the duration");
  }

  // ── A malformed or empty confirmed set degrades to NO label, never to a stale date ─────────────
  // Google's feed can be unreachable. This is a LABEL, not money, so the accepted failure is a
  // national vacation reading as an ordinary one — and `loadConfirmedNationalHolidayNames` swallows
  // the error so the Vacations tab still renders. What must NEVER happen is a date surviving from a
  // hardcoded list after the authority has moved it.
  {
    assert.equal(nationalHolidayNamesByDate([]).size, 0);
    assert.equal(
      nationalHolidayNamesByDate([{ endDate: null, name: "Nonsense", startDate: "not-a-date" }]).size,
      0,
      "a malformed span is skipped, never expanded",
    );
    assert.equal(
      nationalHolidayNamesByDate([{ endDate: "2026-01-07", name: "Coptic Christmas", startDate: "2026-01-07" }]).get("2026-01-07"),
      "Coptic Christmas",
      "endDate equal to startDate is a single day",
    );
    assert.equal(
      nationalHolidayNamesByDate([{ name: "Labour Day", startDate: "2026-05-01" }]).get("2026-05-01"),
      "Labour Day",
      "an absent endDate is a single day",
    );
    assert.equal(
      buildVacationPeriod([day("2026-10-08", null)]).national_holiday,
      null,
      "with NO confirmed map the date carries no label — nothing may resurrect a hardcoded holiday calendar",
    );
    assert.equal(
      buildVacationPeriod([day("2026-10-08", null)], new Map()).national_holiday,
      null,
      "an empty confirmed map (a Google outage) labels nothing by date",
    );
  }

  // ── The comment keyword fallback survives, and is what carries a degraded read ─────────────────
  {
    const spoken = (comment: string) => {
      const row = day("2026-10-08", null);
      row.comment = comment;
      return buildVacationPeriod([row]).national_holiday;
    };
    assert.equal(spoken("اجازة رسمي"), "National Holiday", "an Arabic official-holiday comment still labels the period");
    assert.equal(spoken("Eid vacation"), "National Holiday", "an English holiday comment still labels the period");
    assert.equal(spoken("sick"), null, "an ordinary comment still labels nothing");

    // A confirmed date beats the generic keyword name.
    const row = day("2026-10-08", null);
    row.comment = "اجازة رسمي";
    assert.equal(
      buildVacationPeriod([row], new Map([["2026-10-08", "Armed Forces Day"]])).national_holiday,
      "Armed Forces Day",
      "a confirmed date names the holiday; the keyword fallback only ever answers the generic name",
    );
  }

  // ── The hand-rolled calendar must not come back ─────────────────────────────────────────────────
  // The rot this fixes is a date literal in this module's source. A map keyed by YYYY-MM-DD cannot
  // be anything but stale: Islamic and Coptic holidays move every year, and the observed day off is
  // postponed by a decision nobody can compute.
  {
    const master = readFileSync("src/lib/crm/master.ts", "utf8");
    assert.ok(
      master.includes('from "@/lib/vacation/national-holidays"'),
      "the holiday names are read from the confirmed source",
    );
    assert.doesNotMatch(
      master,
      /\["\d{4}-\d{2}-\d{2}",\s*"/,
      "no date-keyed holiday map in this module — the confirmed source owns the calendar",
    );
    // And the read of that source can never throw out of the master builder: an unreachable Google
    // feed must cost a LABEL, not the whole Vacations tab.
    const loader = master.slice(master.indexOf("async function loadConfirmedNationalHolidayNames("));
    assert.ok(
      loader.slice(0, loader.indexOf("\n}\n")).includes("} catch {"),
      "the confirmed-holiday read is wrapped — a Google outage degrades the label, it does not empty the tab",
    );
  }

  console.log(
    "crm vacation duration: per-date collapse passed (AM+PM = 1 day, AM+AM = 0.5); holiday labels read the confirmed source (2 Jul, 27 Aug, 19-20 Mar, 8 Oct)",
  );
}
