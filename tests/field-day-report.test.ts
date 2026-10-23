import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  derivedNotes,
  figuresOf,
  papersOf,
  renderLinePage,
  renderSummaryPage,
  restDayPhrase,
  stampOf,
  assertPapersFit,
  supersedeLabel,
  supersedePaper,
  supersededPathFor,
  SUPERSEDED_DIR,
  verifyPaper,
  awaitPaper,
} from "../scripts/field-day/print-day.mjs";
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
    // One worst-of-two reading per place in `places` — what the Summary's accuracy sentence is counted from.
    readings: [4, 8],
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
  const quiet = () => rep({ name: "A Quiet Rep", quiet: true, am: 0, pm: 0, places: 0, kept: 0, events: [], accuracy: "—", readings: [] as number[], planned: 8 });
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
          readings: [] as number[],
        })),
      })),
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

  // 🔴 THE ACCURACY SENTENCE NEVER COUNTS A PLACE THE DENOMINATOR DOES NOT. On 7 October 2026 the
  // Summary told the Chief Executive "Of the 118 places captured, 96 were accurate to within 25 metres
  // and 143 within the 100 metres the company requires": the numerators were counted from a day-wide
  // list of every place created that day — 144, including 26 of reps under other district managers —
  // while the 118 summed the reps these papers cover. The old day-wide list is handed to the renderer
  // here, larger than the reps' own places and all within 25 m, exactly the shape that printed the lie.
  const staleDayWide = Array.from({ length: 10 }, () => ({ photo_accuracy_meters: 5, pin_accuracy_meters: 5 }));
  const mixed = { ...fixture(), places: staleDayWide } as ReturnType<typeof fixture> & { places: unknown[] };
  mixed.groups[1].reps[0] = { ...mixed.groups[1].reps[0], places: 3, readings: [4, 60, 2000] };
  const accuracy = (html: string) => {
    const match = html.match(/Of the (\d+) places captured, (\d+) were accurate to within 25 metres and\s+(\d+) within the 100 metres/);
    assert.ok(match, "the accuracy sentence is printed on a day with places");
    return { places: Number(match[1]), within25: Number(match[2]), within100: Number(match[3]) };
  };
  assert.deepEqual(
    accuracy(renderSummaryPage(mixed as never)),
    { places: 7, within25: 5, within100: 6 },
    "🔴 the numerators are counted from the same reps as the denominator, and a day-wide list beside them changes nothing",
  );
  const plain = accuracy(summary);
  assert.ok(plain.within25 <= plain.within100 && plain.within100 <= plain.places, "🔴 a numerator never prints above its denominator");
  assert.deepEqual(plain, { places: 6, within25: 6, within100: 6 }, "and the plain fixture reads its own reps");
  // A rep whose readings outnumber its places (a malformed read) is clamped, never printed past the denominator.
  const overfull = fixture();
  overfull.groups[0].reps[0] = { ...overfull.groups[0].reps[0], places: 1, readings: [1, 2, 3, 4] };
  const clamped = accuracy(renderSummaryPage(overfull as never));
  assert.ok(clamped.within100 <= clamped.places, "🔴 even from malformed input, within100 never exceeds the places captured");
  // The per-line papers read only their own reps for both sides of "of N captured", so kept <= captured.
  for (const group of day.groups) {
    const row = figuresOf(group as never);
    assert.ok(row.kept <= row.places, "a line paper never reports more places validated than captured");
    assert.match(renderLinePage(group as never, day as never), new RegExp(`<dd>${row.kept}<small>of ${row.places} captured at the door`), "the line paper prints its own reps' figures");
  }

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

  // 🔴 The task runs a COPY of the launcher in ~/.claude/scripts, so a rename here would leave the
  // installer copying a file that no longer exists — and only the PRINTER comes fresh from origin/main.
  const installer = readFileSync("scripts/field-day/install-task.ps1", "utf8");
  assert.match(installer, /Copy-Item[\s\S]{0,120}run-nightly\.mjs/, "the installer still copies the launcher by its real name");
  assert.match(installer, /field-day-nightly\.mjs/, "to the stable name the scheduled task invokes");

  const launcher = readFileSync("scripts/field-day/run-nightly.mjs", "utf8");
  assert.doesNotMatch(launcher, /supabase-js/, "the launcher stays node builtins only — it runs before node_modules exists");

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

  // ── 🔴 THE CLI NEVER LOGS A PAPER IT HAS NOT STAT-CHECKED ──
  // 2026-10-08/09: the loop printed all FOUR paths and exited 0 with only THREE PDFs on disk, and the
  // missing one was always Summary-for-the-CEO. The cause is Windows MAX_PATH, not a Chrome race —
  // proved by running the UNFIXED printer twice: a short FIELD_DAY_OUT wrote all four papers, a
  // 205-char one wrote three. Summary-for-the-CEO is simply the longest of the four names, so it is
  // the only path that crosses 260, which reads as "always the last paper". Chrome says "Failed to
  // write file … (0x3)" on the stderr the printer discarded, and exits 0; `console.log(pdfPath)` then
  // ran unconditionally, so the printer reported a paper it had not written.
  const cli = printer.slice(printer.indexOf("if (process.argv[1] &&"));
  assert.ok(cli.includes("printPaper({"), "the CLI prints each paper through the verifying printer");
  assert.ok(
    cli.indexOf("printPaper({") < cli.indexOf("console.log(pdfPath)"),
    "🔴 the path is logged only AFTER the file on disk has been stat-checked, never before",
  );
  assert.ok(cli.includes("assertPapersFit("), "and a FIELD_DAY_OUT too deep is refused BEFORE anything is printed");
  assert.match(cli, /assertPapersFit\(OUT, papers, \{ day: dayData\.day, label \}\)/, "🔴 measuring the ARCHIVE path too, which is the longer one");
  assert.ok(
    cli.indexOf("supersedeLabel()") < cli.indexOf("assertPapersFit("),
    "🔴 the label is read first, so the archive path the guard measures is the one supersedePaper will write",
  );
  assert.doesNotMatch(cli, /execFileSync/, "Chrome is no longer launched bare from the loop");
  assert.ok(!cli.includes('stdio: "pipe"'), "🔴 and its stderr — where “Failed to write file … (0x3)” rides — is no longer discarded");

  const printPaperSource = printer.slice(printer.indexOf("export function printPaper"), printer.indexOf("// `pathToFileURL`, never"));
  assert.ok(printPaperSource.includes("spawnSync("), "Chrome runs under spawnSync so both streams are readable");
  assert.ok(printPaperSource.includes("Failed to write"), "the line that names the real cause is the one kept for the log");
  assert.ok(printPaperSource.includes("verifyPaper("), "every print is verified against the file on disk");
  assert.ok(
    printPaperSource.indexOf("awaitPaper(") > -1 && printPaperSource.indexOf("awaitPaper(") < printPaperSource.indexOf("verifyPaper("),
    "🔴 and the verifier waits for Chrome's late write first — on 22 Oct the paper landed 5 s after Chrome exited 0",
  );

  // The wait itself, on a simulated clock: the 22 Oct shape, a file absent for 5 s, then growing, then settled.
  {
    let clock = 0;
    const sizes = new Map<number, number>([[5_000, 120_000], [5_500, 298_081], [6_000, 298_081]]);
    const fakeStat = () => {
      const size = sizes.get(clock);
      if (size === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return { size };
    };
    const landed = awaitPaper("late.bin", { stat: fakeStat as never, sleep: (ms: number) => { clock += ms; }, now: () => clock });
    assert.equal(landed, true, "🔴 a paper that lands 5 s after Chrome exits is waited for, not reported missing");
    assert.equal(clock, 6_000, "and only once its size has held across two reads — a half-written paper is not judged");

    clock = 0;
    const never = awaitPaper("never.bin", { stat: (() => { throw new Error("ENOENT"); }) as never, sleep: (ms: number) => { clock += ms; }, now: () => clock });
    assert.equal(never, false, "a paper that never lands gives up, so verifyPaper names it");
    assert.equal(clock, 30_000, "after 30 s, not forever");
  }
  assert.ok(printPaperSource.includes("throw new Error("), "🔴 and the failure is LOUD — run-nightly.mjs writes it into xlsx/field-day-task.log");
  // 🔴 No retry: the failure guarded here is a DETERMINISTIC path error, so a second attempt fails
  // identically. The earlier cut of this fix retried three times on a race that does not exist.
  assert.ok(!printer.includes("PAPER_ATTEMPTS"), "no retry loop — the guarded failure is deterministic");
  assert.ok(!printer.includes("--user-data-dir"), "🔴 and no per-invocation Chrome profile: there is no profile race to fix");

  // The path guard. 🔴 PLATFORM-NEUTRAL: the printer only ever runs on Windows, but this suite runs on
  // a LINUX runner, where `path.resolve("C:/fdshort", …)` resolves under the workspace instead and the
  // character count is different. An earlier cut hard-coded 67 and passed here while failing in CI.
  const fourPapers = papersOf(fixture()).map(({ file }) => ({ file }));
  assert.equal(fourPapers.length, 4, "three lines and the Chief Executive's summary");
  const root = path.sep === "\\" ? "C:/" : "/";
  const shortOut = path.resolve(root, "fdshort");
  const ceoPaper = path.resolve(shortOut, "Phoenix-CRM-Field-Day-2026-10-07-Summary-for-the-CEO.pdf");
  assert.equal(
    assertPapersFit(shortOut, fourPapers, { day: "2026-10-07" }),
    ceoPaper.length,
    "a shallow output folder fits, and the FULL path of the longest paper is what gets reported",
  );
  assert.ok(ceoPaper.length < 260, "and that folder is genuinely under the limit on this platform");
  // 240 characters of folder puts the CEO page past 260 on Windows and on Linux alike.
  const deepOut = path.resolve(root, "x".repeat(240));
  assert.throws(
    () => assertPapersFit(deepOut, fourPapers, { day: "2026-10-07" }),
    /too deep: the longest paper path is \d{3} characters and Windows stops at 260/,
    "🔴 a FIELD_DAY_OUT that cannot hold Summary-for-the-CEO is refused, naming the character count",
  );
  // 🔴 It is the LONGEST name that decides, not the LAST in the list. Summary-for-the-CEO happens to
  // be both, so this reverses the list: a guard that just took the last entry would measure CNS here.
  assert.equal(
    assertPapersFit(shortOut, [...fourPapers].reverse(), { day: "2026-10-07" }),
    ceoPaper.length,
    "🔴 the guard measures every name — reversing the papers gives the same longest path",
  );
  // 🔴 It is the LONGEST name that decides, not the last in the list: the guard must measure them all.
  let tooDeep = "";
  try {
    assertPapersFit(deepOut, fourPapers, { day: "2026-10-07" });
  } catch (error) {
    tooDeep = String((error as Error).message);
  }
  assert.match(tooDeep, /Summary-for-the-CEO/, "and it names Summary-for-the-CEO, the longest of the four");
  // The measured Windows geometry that produced the defect, as ARITHMETIC on the folder length: no
  // Windows path is resolved here, because this suite runs on Linux and would resolve it elsewhere.
  const winLen = (folderChars: number, file: string) => folderChars + `Phoenix-CRM-Field-Day-2026-10-07-${file}.pdf`.length;
  // 🔴 THE ARCHIVE PATH IS LONGER THAN THE PAPER IT PRESERVES — one more folder, plus
  // `-superseded-<sha>`. So a folder the four papers fit can still be one the archive cannot be
  // written into, where `copyFileSync` would stop the run with a bare ENOENT AFTER this guard passed.
  assert.equal(
    assertPapersFit(shortOut, fourPapers, { day: "2026-10-07", label: "abc1234" }),
    ceoPaper.length,
    "a shallow folder fits the paper and its archive alike, and the PAPER's length is still what is reported",
  );
  const archiveTooDeep = path.resolve(root, "y".repeat(180));
  assert.ok(
    path.resolve(archiveTooDeep, "Phoenix-CRM-Field-Day-2026-10-07-Summary-for-the-CEO.pdf").length < 260,
    "this folder is one the papers THEMSELVES fit — the paper guard above passes it",
  );
  assert.throws(
    () => assertPapersFit(archiveTooDeep, fourPapers, { day: "2026-10-07", label: "abc1234" }),
    /too deep to archive into: the longest archive path is \d{3} characters and Windows stops at 260/,
    "🔴 a folder that fits the papers but not their archives is refused BEFORE printing, naming the count",
  );
  assert.doesNotThrow(
    () => assertPapersFit(archiveTooDeep, fourPapers, { day: "2026-10-07" }),
    "and with no label there is no archive to measure — the paper check alone decides",
  );
  assert.equal(winLen(11, "Summary-for-the-CEO"), 67, "the 11-character folder of the short run that wrote all four papers");
  assert.ok(winLen(205, "Summary-for-the-CEO") > 260, "the 205-character folder that lost the CEO page");
  assert.ok(winLen(205, "Anti-Infective") <= 260, "while Anti-Infective still fitted, which is why it looked like the last paper");

  // The verifier itself, against real bytes. 🔴 The fixtures are `.bin`, never `.pdf`: a test must not
  // leave protected document types in a temp folder it then has to clear.
  const scratch = mkdtempSync(path.join(tmpdir(), "field-day-verify-"));
  try {
    const paper = path.join(scratch, "Phoenix-CRM-Field-Day-2026-10-07-Summary-for-the-CEO.bin");
    writeFileSync(paper, Buffer.concat([Buffer.from("%PDF-1.4"), Buffer.alloc(200_000, 0x20)]));
    assert.equal(verifyPaper(paper, { writtenAfter: Date.now() - 60_000 }), 200_008, "a real paper verifies and reports its size");

    assert.throws(
      () => verifyPaper(path.join(scratch, "never-written.bin")),
      /never-written.bin was not written/,
      "🔴 the paper Chrome exited 0 without writing is caught — this is the 2026-10-08 defect",
    );
    const stub = path.join(scratch, "stub.bin");
    writeFileSync(stub, "%PDF");
    assert.throws(() => verifyPaper(stub), /stub.bin is 4 bytes/, "a truncated stub is not a paper, though existsSync would pass it");
    const notPdf = path.join(scratch, "not-a-pdf.bin");
    writeFileSync(notPdf, Buffer.alloc(200_000, 0x41));
    assert.throws(() => verifyPaper(notPdf), /does not begin with %PDF/, "and neither is 200 KB of something else");
    assert.throws(
      () => verifyPaper(paper, { writtenAfter: Date.now() + 60_000 }),
      /is stale/,
      "a paper left by an EARLIER run of the same day is not mistaken for this run's work",
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  // ───────────────────────────────────────────────────────────────────────────────────────────────
  // THE PAPER ALREADY ON DISK IS THE ONE THAT WENT OUT — it is archived before it is replaced.
  //
  // The printer used to overwrite in place, so any session verifying a change silently replaced the
  // PDFs a district manager and the Chief Executive had already been sent. On 2026-10-08 three
  // sessions printed into the same `xlsx/` within seven minutes and it only ended well because the
  // content happened to be right. Fixtures are `.bin`, like the ones above: a real `.pdf` here would
  // be a protected document the archive hooks would then copy off to F:.
  const archiving = mkdtempSync(path.join(tmpdir(), "field-day-supersede-"));
  try {
    const paper = path.join(archiving, "Phoenix-CRM-Field-Day-2026-10-08-CNS.bin");

    assert.equal(supersedePaper(paper, { label: "abc1234" }), null, "the first print of a day supersedes nothing");
    assert.equal(readdirSync(archiving).length, 0, "and leaves no archive behind");

    writeFileSync(paper, "%PDF-1.4 the paper that went out", "utf8");
    const archive = supersedePaper(paper, { label: "abc1234" });
    assert.ok(
      archive?.endsWith("Phoenix-CRM-Field-Day-2026-10-08-CNS-superseded-abc1234.bin"),
      `the archive is keyed by the superseding commit, not a hand-typed PR number — got ${archive}`,
    );
    // 🔴 INTO field-day-superseded/, NOT BESIDE THE PAPER (owner, 2026-10-09). 40 archives had piled
    // up against 28 live papers, so the folder a person opens to find today's paper was mostly old
    // ones. The live papers stay at the top, where the hourly backup to F: looks.
    assert.equal(SUPERSEDED_DIR, "field-day-superseded", "the archive folder is the one the owner named");
    assert.equal(path.basename(path.dirname(archive!)), SUPERSEDED_DIR, "🔴 the archive lands inside field-day-superseded/");
    assert.deepEqual(
      readdirSync(archiving).sort(),
      ["Phoenix-CRM-Field-Day-2026-10-08-CNS.bin", SUPERSEDED_DIR],
      "🔴 and nothing but the live paper and that one folder is left at the top — no archive beside the paper",
    );
    assert.equal(
      supersededPathFor(paper, "abc1234"),
      archive,
      "🔴 one function answers where an archive goes, so the fit guard can never measure a path the copy does not use",
    );
    assert.ok(
      existsSync(paper),
      "🔴 BY COPY: the live paper must still be there. A rename would leave that path empty, and Chrome here exits 0 having written nothing, so a failed reprint would take the owner's only copy with it",
    );
    assert.equal(readFileSync(archive!, "utf8"), "%PDF-1.4 the paper that went out", "the archive is a faithful copy");

    writeFileSync(paper, "%PDF-1.4 a later reprint", "utf8");
    assert.equal(supersedePaper(paper, { label: "abc1234" }), archive, "a second run from the same commit reuses the name");
    assert.equal(
      readFileSync(archive!, "utf8"),
      "%PDF-1.4 the paper that went out",
      "🔴 the OLDEST archive wins — the first one is the paper that was actually sent, so a re-run must not overwrite it",
    );

    assert.match(
      supersedeLabel(),
      /^[0-9a-f]{7,}$|^nogit-\d{12}$/,
      "the label is the short sha this run prints from, falling back to the clock rather than losing the archive",
    );

    // The archive step must never be "simplified" later into a delete-then-write: these are
    // protected documents, and `scratchpad-guard.mjs` refuses a delete command that names one.
    const printer = readFileSync(new URL("../scripts/field-day/print-day.mjs", import.meta.url), "utf8");
    assert.equal((printer.match(/unlinkSync/g) ?? []).length, 0, "the printer never unlinks anything");
    assert.equal(
      (printer.match(/rmSync\(/g) ?? []).length,
      0,
      "the printer removes NOTHING: it once deleted its own per-run Chrome profile, and that profile went with the race that never existed",
    );
  } finally {
    rmSync(archiving, { recursive: true, force: true });
  }
}
