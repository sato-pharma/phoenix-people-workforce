import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { derivedNotes, figuresOf, papersOf, renderLinePage, renderSummaryPage, restDayPhrase, stampOf } from "../scripts/field-day/print-day.mjs";
import { holidayNameOf, restDayOf, weekdayOf } from "../scripts/field-day/read-day.mjs";
import { stripComments } from "./support/comment-strip.ts";
import { assertFetchRetriesALostLock } from "./support/launcher-fetch-retry.ts";

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The Phoenix CRM field day papers — three for the district managers, one for the Chief Executive.
//
// They are COMPANY DOCUMENTS that leave the building in the owner's own hand, so they wear the house
// identity SATO-DIS-2026-01 v1.0 and are held to it here: the ink rule, square corners, no ellipsis,
// A4, both marks. Their FIGURES are read from production and cannot be checked here, which is the
// point of this file — it checks everything about the papers that does NOT depend on the day, against
// a fixture, so the suite never touches the database.
//
// The one thing it checks hardest is the running footer. The first cut of these papers used
// `position: fixed`, which Chrome paints OVER the text it is meant to sit below — the same defect
// `render-contract.ts` records for the employment contract — and a reader only sees it on page two.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** A day with one of everything the papers can draw, so nothing below passes by being absent. */
function fixture() {
  const rep = (over: Record<string, unknown> = {}) => ({
    name: "A Rep Name",
    title: "Medical Representative",
    area: "Gharbia 1 (Tanta)",
    planned: 14,
    am: 2,
    pm: 1,
    places: 2,
    kept: 2,
    accuracy: "4 – 8 m",
    validated: 2,
    list: 169,
    events: [
      { at: "10:05", what: "Validated", who: "مستشفي صدر المحلة", how: "photo 4 m · pin 3 m" },
      { at: "10:27", what: "Visit", who: "مستشفي صدر المحلة", how: "161 m · weak GPS" },
      { at: "11:10", what: "Visit", who: "مستشفي التعليمي", how: "waiting to be measured" },
    ],
    unplanned: [] as Array<Record<string, unknown>>,
    requests: [] as Array<Record<string, unknown>>,
    quiet: false,
    ...over,
  });
  const quiet = () => rep({ name: "A Quiet Rep", quiet: true, am: 0, pm: 0, places: 0, kept: 0, events: [], accuracy: "—", planned: 8 });
  const group = (over: Record<string, unknown> = {}) => ({
    line: "CNS",
    file: "CNS",
    dm: "A District Manager",
    vacant: ["Gharbia 2 (Mahalla)"],
    reps: [rep(), quiet()],
    ...over,
  });
  return {
    day: "2026-10-03",
    readAt: "21:00",
    groups: [
      // The first line carries a WITHDRAWN capture (2 taken, 1 kept), so the summary's
      // "the system caught what it should" section is exercised rather than silently skipped.
      group({ reps: [rep({ kept: 1 }), quiet()] }),
      group({ line: "Pedia", file: "Pedia", vacant: [] }),
      group({ line: "Anti Infective", file: "Anti-Infective" }),
    ],
    places: [
      { photo_accuracy_meters: 4, pin_accuracy_meters: 3 },
      { photo_accuracy_meters: 34, pin_accuracy_meters: 8 },
      { photo_accuracy_meters: 2000, pin_accuracy_meters: 2000 },
    ],
  };
}

/** Every `background:` declaration a sheet paints, so the ink rule can be read off the document. */
function backgrounds(html: string): string[] {
  return [...html.matchAll(/background:\s*([^;}]+)[;}]/g)].map((match) => match[1].trim());
}

export function runFieldDayReportTests() {
  const day = fixture();
  const papers = papersOf(day as never);
  assert.deepEqual(papers.map((paper) => paper.file), ["CNS", "Pedia", "Anti-Infective", "Summary-for-the-CEO"], "three lines and the CEO's page");

  // The same day with nobody in the field and a reason for it: a confirmed public holiday, and a
  // Friday. Both wear the house identity below exactly as a working day's papers do.
  const off = (restDay: { kind: string; name: string }, dayIso: string) => {
    const base = fixture();
    return {
      ...base,
      day: dayIso,
      restDay,
      groups: base.groups.map((group) => ({
        ...group,
        // The first rep carries a name print-day.mjs holds an AUTHORED sentence for, so a day off is
        // held to dropping it rather than passing because no fixture name matched.
        reps: group.reps.map((rep, index) => ({
          ...rep,
          name: index === 0 ? "Yasmeen Samy Shawky Mahdy" : rep.name,
          quiet: true,
          am: 0,
          pm: 0,
          places: 0,
          kept: 0,
          events: [],
          accuracy: "—",
        })),
      })),
      places: [] as Array<Record<string, unknown>>,
    };
  };
  const holidayDay = off({ kind: "holiday", name: "Armed Forces Day" }, "2026-10-08");
  const fridayDay = off({ kind: "friday", name: "Friday" }, "2026-10-09");

  for (const paper of [...papers, ...papersOf(holidayDay as never), ...papersOf(fridayDay as never)]) {
    const html = paper.html;

    // ── The house identity ──────────────────────────────────────────────────────────────────────
    assert.match(html, /SATO-DIS-2026-01 v1\.0/, `${paper.file}: wears the house document code`);
    assert.match(html, /@page \{ size: A4 portrait;/, `${paper.file}: A4 portrait`);
    assert.match(html, /\* \{ box-sizing: border-box; border-radius: 0; \}/, `${paper.file}: the square-edge rule, on everything`);
    // Read each declaration's VALUE. `/border-radius:\s*(?!0)/` looks like this check and is not:
    // `\s*` backtracks to zero width so the lookahead sees the space, and `border-radius: 0` matches.
    for (const radius of [...html.matchAll(/border-radius:\s*([^;}]+)[;}]/g)].map((match) => match[1].trim())) {
      assert.equal(radius, "0", `${paper.file}: the square-edge rule — found a corner radius of "${radius}"`);
    }
    assert.doesNotMatch(html, /…|\.\.\.|text-overflow:\s*ellipsis/, `${paper.file}: the owner's no-ellipsis rule — text wraps, never truncates`);

    // 🔴 THE INK RULE. Colour is carried by lines and type; the ONLY painted area is the 6% zebra row
    // the owner asked for by name. The engine-turned band is a STROKED svg, which is line not area.
    const painted = backgrounds(html);
    assert.ok(painted.length >= 2, `${paper.file}: the sheet paints something — the scan still sees declarations`);
    for (const value of painted) {
      const isZebra = value === "#F2F6FA";
      const isBand = value.startsWith("url(\"data:image/svg+xml,") && value.includes("repeat-x");
      assert.ok(isZebra || isBand, `${paper.file}: the ink rule allows the 6% zebra row and the engine-turned band only — found "${value}"`);
    }
    assert.ok(painted.some((value) => value === "#F2F6FA"), `${paper.file}: the zebra row is the one approved fill and it is present`);
    const bandSvg = painted.find((value) => value.startsWith("url(\"data:image/svg+xml,")) ?? "";
    assert.ok(bandSvg.includes("fill%3D%22none%22") || bandSvg.includes("fill=%22none%22"), `${paper.file}: the band is stroked, never filled`);

    // Both marks, each in its own colours: Sato above, Phoenix below (owner, 2026-09-11).
    assert.match(html, /<header class="lh">[\s\S]*?alt="Sato Pharma"/, `${paper.file}: the Sato mark leads the letterhead`);
    assert.match(html, /<div class="foot">\s*\n?\s*<img alt="Phoenix Workforce"/, `${paper.file}: the Phoenix emblem sits at the foot`);
    // ALWAYS the on-light file on paper: the stock mark sets "SATO" in white and it vanishes.
    assert.ok(!html.includes("sato-pharma-logo.svg\""), `${paper.file}: never the white-wordmark mark on white paper`);

    // ── The running footer rides in a tfoot, which is the only thing Chrome repeats ─────────────
    assert.match(html, /<tfoot><tr><td><div class="foot">/, `${paper.file}: the footer is a table footer`);
    assert.doesNotMatch(html, /position:\s*fixed/, `${paper.file}: never a fixed footer — it paints over the text below it`);
    assert.match(html, /thead \{ display: table-header-group; \}/, `${paper.file}: a table that breaks repeats its own header`);

    // ── Fits the screen, and the page ───────────────────────────────────────────────────────────
    assert.match(html, /table \{ width: 100%; table-layout: fixed;/, `${paper.file}: fixed layout, so a long Arabic name wraps instead of widening the sheet`);
    assert.doesNotMatch(html, /overflow-x:\s*auto|min-width:\s*\d/, `${paper.file}: never a sideways scroller`);
    for (const colgroup of html.match(/<colgroup>[\s\S]*?<\/colgroup>/g) ?? []) {
      const widths = [...colgroup.matchAll(/width:(\d+)%/g)].map((match) => Number(match[1]));
      assert.equal(widths.reduce((sum, width) => sum + width, 0), 100, `${paper.file}: a colgroup's widths must total 100%`);
    }

    // Arabic is resolved PER CELL. A block-level dir would turn the Latin columns around with it.
    for (const cell of html.match(/<span class="who"[^>]*>/g) ?? []) {
      assert.match(cell, /dir="auto"/, `${paper.file}: every customer name carries its own direction`);
    }
  }

  // ── The line paper ────────────────────────────────────────────────────────────────────────────
  const line = renderLinePage(day.groups[0] as never, day as never);
  assert.match(line, /District Manager A District Manager/, "a line paper is addressed to its district manager");
  assert.match(line, /Vacant seat:/, "and states the seat nobody is carrying");
  assert.match(line, /A Quiet Rep/, "🔴 a rep who recorded nothing is still ON the paper — the absence is the finding");
  assert.match(line, /waiting to be measured/, "a visit to a customer with no place yet says so");
  assert.match(line, /How a visit gets its distance/, "and the paper explains what that means");

  // ── The Chief Executive's page ────────────────────────────────────────────────────────────────
  const summary = renderSummaryPage(day as never);
  assert.match(summary, /Prepared for Anwar Gaweesh, Chief Executive Officer/, "the summary is addressed");
  assert.doesNotMatch(summary, /A Rep Name|A Quiet Rep/, "🔴 and names NO rep — it reports the system, not a person");
  assert.doesNotMatch(summary, /hour by hour/, "nor the hour-by-hour detail, which is the managers' business");
  assert.match(summary, /1 place was\s+withdrawn/, "a withdrawn capture is reported as what the system caught");
  // Each line's figures roll up rather than being restated.
  const figures = day.groups.map((group) => figuresOf(group as never));
  const calls = figures.reduce((sum, row) => sum + row.am + row.pm, 0);
  assert.match(summary, new RegExp(`<dd>${calls}<small>`), `the calls figure is the sum of the lines (${calls})`);

  // ── A day off is not a day nobody worked ──────────────────────────────────────────────────────
  //
  // 🔴 THE DEFECT THESE PIN. Thursday 8 October 2026 was Armed Forces Day — the public holiday the
  // owner moved there from 6 October, confirmed in `attendance_holiday_overrides`. The papers printed
  // for it showed 0 of 15 reps working, told the Chief Executive that "15 reps recorded nothing today
  // … which the district managers are following", and repeated "Nothing was recorded today, and
  // nothing was planned for it either" under all fifteen names. On a holiday every one of those
  // sentences reads as a performance problem, on the one document that leaves the building.
  const holidayLine = renderLinePage(holidayDay.groups[0] as never, holidayDay as never);
  const holidaySummary = renderSummaryPage(holidayDay as never);
  const fridayLine = renderLinePage(fridayDay.groups[0] as never, fridayDay as never);
  const fridaySummary = renderSummaryPage(fridayDay as never);

  for (const [what, sheet] of [["the line paper", holidayLine], ["the CEO's page", holidaySummary]] as const) {
    assert.match(sheet, /Armed Forces Day/, `${what}: a public holiday is named, not left as a column of zeroes`);
    assert.match(sheet, /public holiday/, `${what}: and said to be a public holiday in words`);
    assert.doesNotMatch(sheet, /recorded nothing/, `🔴 ${what}: never "recorded nothing" on a public holiday`);
    assert.doesNotMatch(sheet, /Nothing was recorded today/, `🔴 ${what}: nor the working-day sentence under a rep's name`);
  }
  for (const [what, sheet] of [["the line paper", fridayLine], ["the CEO's page", fridaySummary]] as const) {
    assert.match(sheet, /the weekly day off/, `${what}: a Friday says why the field was empty too`);
    assert.doesNotMatch(sheet, /recorded nothing/, `🔴 ${what}: never "recorded nothing" on the weekly day off`);
  }
  // The managers' own paper still carries every rep, and still explains each absence once.
  assert.match(holidayLine, /A Quiet Rep/, "a rep is still ON the holiday paper — the paper reports the day, it does not hide it");
  assert.equal(
    (holidayLine.match(/Armed Forces Day, a public holiday\. Nothing was recorded, and nothing was expected to be\./g) ?? []).length,
    holidayDay.groups[0].reps.length,
    "and each rep's own note says the day was the holiday",
  );
  // 🔴 AND NO AUTHORED SENTENCE ABOUT A MORNING'S WORK ON A DAY THERE WAS NONE. Rendered from
  // production for 8 October, the holiday paper carried "The phone was on approximate location all
  // morning" — written about 3 October — directly beside "Nothing was recorded", under one name.
  const authored = /approximate location all morning/;
  const workedThatDay = fixture();
  workedThatDay.groups[0].reps[0].name = "Yasmeen Samy Shawky Mahdy";
  assert.match(
    renderLinePage(workedThatDay.groups[0] as never, workedThatDay as never),
    authored,
    "on a WORKING day the authored sentence is still the one thing on these papers a human wrote",
  );
  assert.doesNotMatch(holidayLine, authored, "🔴 but an authored note is about a day's captures, so a day off carries none");
  assert.doesNotMatch(fridayLine, authored, "🔴 nor does the weekly day off");

  // 🔴 AND NOT ON A LATER WORKING DAY EITHER — the half a day-off guard cannot reach. All six
  // sentences were keyed by rep NAME alone, with no date, so each printed on every paper its rep ever
  // appeared on: this 3 October judgement about a phone on approximate location went out again on
  // 7 October, and on every working day after it, to a district manager and in summary to the Chief
  // Executive. Keyed by Cairo day first, a note prints on the day it was written about and no other.
  const laterWorkingDay = { ...fixture(), day: "2026-10-07" };
  laterWorkingDay.groups[0].reps[0].name = "Yasmeen Samy Shawky Mahdy";
  const laterLine = renderLinePage(laterWorkingDay.groups[0] as never, laterWorkingDay as never);
  assert.doesNotMatch(laterLine, authored, "🔴 a 3 October judgement never prints on a 7 October paper");
  assert.match(laterLine, /Yasmeen Samy Shawky Mahdy/, "the rep is still on that paper, named");
  assert.match(laterLine, /waiting: the system measures it/, "and still carries what the data itself says about THAT day");

  // 🔴 The CEO's page drops the sections whose figures are empty rather than printing them as zeroes.
  assert.doesNotMatch(holidaySummary, /reps who hold a seat recorded real work/, "🔴 no performance sentence about a day off");
  assert.doesNotMatch(holidaySummary, /Of the 0 places captured/, "nor arithmetic about nothing");
  assert.doesNotMatch(holidaySummary, /which the district managers are following[\s\S]*recorded/, "nothing is handed to a manager to follow up");
  assert.match(holidaySummary, /No call was due on Armed Forces Day/, "and the lists are said to stand where the last working day left them");
  // A working day is untouched: its zero IS the finding, and it still reads as one.
  assert.match(renderSummaryPage(day as never), /reps recorded nothing/, "on a WORKING day a quiet rep is still reported as one");

  // ── Which day is a day off, and what it is called ─────────────────────────────────────────────
  assert.equal(weekdayOf("2026-10-08"), "Thursday", "the Cairo day string names its own weekday");
  assert.equal(weekdayOf("2026-10-09"), "Friday");
  assert.deepEqual(restDayOf("2026-10-08", { name: "Armed Forces Day" }), { kind: "holiday", name: "Armed Forces Day" });
  assert.deepEqual(restDayOf("2026-10-09", null), { kind: "friday", name: "Friday" }, "a Friday is a day off with no holiday at all");
  assert.equal(restDayOf("2026-10-08", null), null, "🔴 and a Thursday with no CONFIRMED holiday is a working day — the zero stands");
  assert.equal(restDayOf("2026-10-06", null), null, "6 October 2026 is a working day: the owner moved the day off to the 8th");
  // Google carries the substitute as its own `Day off for <X>` event, confirmed on the same date.
  assert.equal(holidayNameOf("Day off for Armed Forces Day"), "Armed Forces Day", "a paper names the holiday, never the mechanism");
  assert.equal(holidayNameOf("Armed Forces Day"), "Armed Forces Day");
  assert.equal(holidayNameOf(null), "a public holiday", "and a nameless row is still a day off");
  assert.equal(restDayPhrase({ kind: "holiday", name: "Armed Forces Day" }), "Armed Forces Day, a public holiday");
  assert.equal(restDayPhrase({ kind: "friday", name: "Friday" }), "Friday, the weekly day off");
  assert.equal(restDayPhrase(null), "");

  // ── The stamp says WHICH day and WHEN it was read — the day runs to 02:00, so a cut is a moment ──
  assert.equal(stampOf(day as never), "Saturday, 3 October 2026 · read at 21:00 Cairo");

  // ── The derived notes: what the data says, said in words, and never a guessed pronoun ─────────
  const quiet = derivedNotes({ quiet: true, planned: 8 } as never);
  assert.deepEqual(quiet, ["Nothing was recorded today, and 8 customers were planned for it."]);
  assert.deepEqual(derivedNotes({ quiet: true, planned: 0 } as never), ["Nothing was recorded today, and nothing was planned for it either."]);
  // 🔴 On a day off the SAME quiet rep is not described as a rep who did nothing — and the plan rows
  // the Suggest button may have left on the day are not held against anyone either.
  const onHoliday = derivedNotes({ quiet: true, planned: 2 } as never, { kind: "holiday", name: "Armed Forces Day" } as never);
  assert.deepEqual(onHoliday, ["Armed Forces Day, a public holiday. Nothing was recorded, and nothing was expected to be."]);
  const onFriday = derivedNotes({ quiet: true, planned: 0 } as never, { kind: "friday", name: "Friday" } as never);
  assert.deepEqual(onFriday, ["Friday, the weekly day off. Nothing was recorded, and nothing was expected to be."]);
  const busy = derivedNotes({
    quiet: false,
    events: [{ how: "waiting to be measured" }, { how: "waiting to be measured" }, { how: "12 m from the place" }],
    unplanned: [{ customer: "مستشفى أشمون العام", clarification: "مش اتسجلت اثناء عمل البلان بالخطأ" }],
    requests: [{ kind: "grade", customer_name: "احمد خالد" }],
  } as never);
  assert.match(busy[0], /^2 visits are to a customer who is not validated yet/, "the unmeasured visits are counted, not described");
  assert.match(busy[1], /was off plan — “مش اتسجلت اثناء عمل البلان بالخطأ” — so it waits with the district manager/);
  assert.match(busy[2], /A grade change was asked of the district manager for احمد خالد/);
  for (const note of [...quiet, ...busy, ...onHoliday, ...onFriday, ...Object.values({ fridaySummary, holidayLine, holidaySummary, line, summary })]) {
    for (const pronoun of [/\bhis\b/i, /\bher\b/i, /\bhers\b/i, /\bhim\b/i, /\bshe\b/i, /\bhe\b/i]) {
      assert.doesNotMatch(note, pronoun, `these papers name fourteen real people — never guess a pronoun: ${note.slice(0, 80)}`);
    }
  }

  // ── The reader reads production; nothing here may import it, or the suite would need the key ──
  const reader = readFileSync("scripts/field-day/read-day.mjs", "utf8");
  assert.match(reader, /export async function readDay/, "the day is read by a FUNCTION, so rendering can be tested without a database");
  assert.doesNotMatch(reader, /\.(insert|update|upsert|delete)\(/, "🔴 the reader only ever READS production");
  assert.match(reader, /for \(let from = 0; ; from \+= 1000\)/, "and pages past PostgREST's silent 1,000-row ceiling");
  // 🔴 THE HOLIDAY COMES FROM THE TABLE THE TS READERS USE, NEVER FROM A LIST OF DATES IN THIS FILE.
  // The owner moved the 6 October day off to the 8th from an admin screen; a hard-coded date here
  // would move everywhere except on the paper that reaches the Chief Executive.
  assert.match(reader, /from\("attendance_holiday_overrides"\)/, "the confirmed-holiday table is read directly — this file cannot import @/lib");
  assert.match(reader, /observed_date/, "and the day off is the OBSERVED range");
  assert.doesNotMatch(reader, /"\d{4}-\d{2}-\d{2}"/, "🔴 never a holiday date hard-coded into the reader");
  const printer = readFileSync("scripts/field-day/print-day.mjs", "utf8");
  assert.match(printer, /pathToFileURL\(process\.argv\[1\]\)/, "the CLI guard survives the space in “Phoenix Workforce”");
  assert.match(printer, /--git-common-dir/, "the papers land in the PRIMARY checkout's xlsx, which is the folder that is backed up");

  // ── 🔴 The 21:00 launcher shares its minute with the memory fold's: a lost fetch lock is retried ──
  // 2026-10-08: both fetched origin/main into the same .git in the same second, the field day lost the
  // lock and wrote no papers. The launcher must retry that, boundedly, and still fetch exactly once.
  assertFetchRetriesALostLock(stripComments(readFileSync("scripts/field-day/run-nightly.mjs", "utf8")), "scripts/field-day/run-nightly.mjs");
}
