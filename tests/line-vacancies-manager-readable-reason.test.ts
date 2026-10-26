import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  describeVacancyReason,
  formatVacancyDate,
  formatVacancyLabel,
  loadVacancyPredecessors,
  loadVacancySeatPlaces,
} from "../src/lib/employees/vacancy-display.ts";
import { fakeSupabaseClient } from "./fixtures/fake-supabase-table.ts";

/**
 * Line Vacancies, as a MANAGER reads it (owner, 2026-10-26, on production as the Pedia National
 * Sales Manager, 17 open vacancies).
 *
 * Four defects were on that one page, and three of them are pinned here:
 *   1. the engine's internal journal (`position_vacancies.note`) was printed to every manager —
 *      HR codes, mechanism names and ISO dates — instead of a plain-English reason, and the raw
 *      note was supposed to stay with Super Admin / HR;
 *   2. the vacancy code appeared TWICE, the second time spelled out into dot-separated words
 *      ("Sales · Pedia · Sharkia · #2 · Medical · Representative");
 *   3. a row whose own `area_id` is null rendered "Unknown Area" although its organogram seat
 *      knows exactly where it sits (VAC-PD0019-DWF → SEAT-PED-REP-D24 → Sharkia 1 / Delta (2)).
 * The fourth (a vacancy with no seat adopting its region's DM) lives in the database and is pinned
 * by the migration's own functions, not by this file.
 *
 * The note gate is asserted against the PAGE SOURCE on purpose. It is the only one of the three
 * that cannot be proved from a pure function: the defect was not a bad string, it was a field
 * rendered with no permission check in front of it, and the thing that must never come back is the
 * unguarded `{vacancy.note}` in the JSX. The reason lines ARE pure functions, and are proved by
 * calling them.
 */

const PAGE = path.join(process.cwd(), "app", "employee-portals", "vacancies", "page.tsx");
const SERVICE = path.join(process.cwd(), "src", "lib", "employee-portal", "service.ts");

// `core.autocrlf=true` on the owner's machine and LF on the CI runner, so the split takes both.
function sourceLines(file: string): string[] {
  return fs.readFileSync(file, "utf8").split(/\r?\n/);
}

export async function runLineVacanciesManagerReadableReasonTests() {
  /* ---------- 1. the raw journal is gated, and the reason is not ---------- */

  const pageLines = sourceLines(PAGE);
  const noteLines = pageLines
    .map((text, index) => ({ line: index + 1, text }))
    .filter((entry) => entry.text.includes("vacancy.note"));

  // Both views print it — the desktop table and the mobile card — so the count is the guard
  // against a gate being added to one and forgotten on the other.
  assert.equal(
    noteLines.length,
    4,
    `expected the raw note in exactly two guarded places (the gate line and the value line, in each of the two views); found ${noteLines.length}: ${noteLines
      .map((entry) => entry.line)
      .join(", ")}`,
  );

  // THE HEADLINE ASSERTION. Every single place the page touches the engine journal stands behind
  // the permission flag; an unguarded `{vacancy.note}` is the exact defect he reported.
  for (const entry of noteLines) {
    const guarded =
      entry.text.includes("canSeeVacancyJournal && vacancy.note") ||
      /^\s*\{vacancy\.note\}\s*$/.test(entry.text);
    assert.ok(
      guarded,
      `page.tsx:${entry.line} prints the engine journal with no permission gate — a manager must never see position_vacancies.note: ${entry.text.trim()}`,
    );
  }

  const gate = pageLines.find((text) => text.includes("const canSeeVacancyJournal"));
  assert.ok(gate, "page.tsx must derive canSeeVacancyJournal before rendering the note");
  assert.match(
    gate,
    /canAccess\(access, "vacancies", "create"\)/,
    'the journal gate must be vacancies:create — the permission only Super Admin and HR offboarding hold ("Super Admin / HR", his words)',
  );

  // The reason, by contrast, is shown to everyone who can see the page at all.
  assert.ok(
    pageLines.some((text) => /\{vacancy\.reason\}/.test(text)),
    "page.tsx must render the plain-English reason",
  );
  assert.ok(
    !pageLines.some(
      (text) => text.includes("vacancy.reason") && text.includes("canSeeVacancyJournal"),
    ),
    "the plain-English reason is for MANAGERS — it must not be gated behind the journal permission",
  );

  // The two local formatters the page used to carry are gone; the domain module owns both now
  // (his rule: domain logic in src/lib/<domain>, not in the page).
  for (const vanished of ["function formatVacancyCode", "function formatDate"]) {
    assert.ok(
      !pageLines.some((text) => text.includes(vanished)),
      `page.tsx must not re-declare ${vanished} — it belongs to src/lib/employees/vacancy-display.ts`,
    );
  }

  // The square-edge golden rule: the only radius token allowed on this page is rounded-none.
  const rounded = pageLines.filter(
    (text) => /\brounded/.test(text) && !/\brounded-none\b/.test(text),
  );
  assert.deepEqual(
    rounded,
    [],
    `the square-edge rule: no rounded corners on Line Vacancies, and Card's own default is rounded-xl — ${rounded.join(" | ")}`,
  );

  /* ---------- 2. the code, once ---------- */

  assert.equal(
    formatVacancyLabel("vacancy_12_sales_pedia_sharkia_2_medical_representative"),
    "VAC-012",
    "a legacy vacancy_<n>_… code reads as VAC-012, never spelled out into words",
  );
  assert.equal(
    formatVacancyLabel("VAC-PD0019-DWF"),
    "VAC-PD0019-DWF",
    "a modern code is already the identifier a person reads and is returned unchanged",
  );
  assert.ok(
    !formatVacancyLabel("vacancy_12_sales_pedia_sharkia_2_medical_representative").includes("·"),
    "the dot-separated second line is the defect he reported; it must not come back",
  );
  assert.equal(formatVacancyLabel(null), "", "a missing code prints nothing, never 'null'");

  // The page prints the label and nothing else in that cell — the old else-branch that printed the
  // raw code underneath it is what made the code appear twice.
  const labelCalls = pageLines.filter((text) => text.includes("formatVacancyLabel(vacancy.vacancyCode)"));
  assert.equal(
    labelCalls.length,
    2,
    `the code is printed once per view (desktop table + mobile card); found ${labelCalls.length} call sites`,
  );
  assert.ok(
    !pageLines.some((text) => /\{vacancy\.vacancyCode\}/.test(text)),
    "the raw vacancy code must never be rendered beside its own formatted label",
  );

  /* ---------- 3. the dates, "30 Sep 2026" ---------- */

  assert.equal(
    formatVacancyDate("2026-09-30"),
    "30 Sep 2026",
    "his stated date form, and a date-only column must not shift a day: new Date('2026-09-30') is UTC midnight",
  );
  assert.equal(formatVacancyDate("2026-08-09"), "9 Aug 2026", "no leading zero on the day");
  assert.ok(
    !formatVacancyDate("2026-09-30").includes(","),
    "the old page formatter was en-US, which prints 'Sep 30, 2026'",
  );
  assert.equal(
    formatVacancyDate("2026-01-31T22:30:00Z"),
    "1 Feb 2026",
    "a real timestamp is read in Africa/Cairo, the only timezone this app reports in",
  );
  assert.equal(formatVacancyDate(null), "", "a missing date prints nothing");
  assert.equal(formatVacancyDate("not a date"), "", "an unparseable value prints nothing, never 'Invalid Date'");

  /* ---------- 4. the reason, built from the structured fields only ---------- */

  assert.equal(
    describeVacancyReason({
      displayName: "Bahaa Gamal",
      effectiveDate: "2026-08-09",
      employmentStatus: "resigned",
    }),
    "Replacing Bahaa Gamal, who resigned. Last working day 9 Aug 2026.",
    "a plain-English reason: the NAME, why, and the date in his form",
  );
  assert.equal(
    describeVacancyReason({
      displayName: "Mohamed Ahmed",
      effectiveDate: "2026-10-01",
      employmentStatus: "declined_offer",
    }),
    "Replacing Mohamed Ahmed, who declined the offer. Last working day 1 Oct 2026.",
    "declined_offer is its own sentence, never the raw status code",
  );
  assert.equal(
    describeVacancyReason({
      displayName: "Someone Else",
      effectiveDate: null,
      employmentStatus: "a_status_nobody_has_mapped_yet",
    }),
    "Replacing Someone Else, who left the company.",
    "an unmapped status degrades to plain English — never an underscored code on a manager's screen",
  );
  assert.equal(
    describeVacancyReason(null),
    null,
    "four of the seventeen open Pedia vacancies record no predecessor: they get NO reason line, and the caller must not fall back to the note",
  );
  assert.equal(
    describeVacancyReason({ displayName: "   ", effectiveDate: "2026-08-09", employmentStatus: "resigned" }),
    null,
    "a predecessor the employees read could not name says nothing at all",
  );

  /* ---------- 5. the predecessors are read off the LEFT employees' rows ---------- */

  const employees = fakeSupabaseClient({
    employees: [
      {
        employment_status: "resigned",
        full_name: "BAHAA GAMAL ALI",
        hr_id: "PD-0101",
        last_working_date: "2026-08-09",
        nickname: null,
        resignation_date: "2026-07-20",
      },
      {
        // The real shape of the two declined-offer rows: the offer lapsed TEN DAYS after the last
        // working day the vacancy is really dated from, so last_working_date must win.
        employment_status: "declined_offer",
        full_name: "Nada Samir Hassan",
        hr_id: "PD-0102",
        last_working_date: "2026-10-01",
        nickname: null,
        resignation_date: "2026-10-10",
      },
    ],
  });

  const predecessors = await loadVacancyPredecessors(
    ["PD-0101", "PD-0102", "PD-9999", null, undefined, ""],
    employees as never,
  );

  assert.equal(predecessors.size, 2, "both predecessors are found in one chunked read");
  assert.equal(
    describeVacancyReason(predecessors.get("PD-0101")),
    "Replacing Bahaa Gamal Ali, who resigned. Last working day 9 Aug 2026.",
    "an ALL-CAPITALS stored name is tidied before a manager reads it",
  );
  assert.equal(
    describeVacancyReason(predecessors.get("PD-0102")),
    "Replacing Nada Samir Hassan, who declined the offer. Last working day 1 Oct 2026.",
    "effectiveDate prefers last_working_date: resignation_date on this row is ten days later",
  );
  assert.equal(
    predecessors.get("PD-9999"),
    null,
    "an HR id with no employees row is null, not a guess",
  );
  assert.equal(predecessors.get(null), null, "a vacancy with no predecessor is null");

  // A failed read costs the reason line and nothing else — the vacancies page still renders.
  const failing = fakeSupabaseClient({ employees: [] }, { failOn: { employees: "boom" } });
  const noneFound = await loadVacancyPredecessors(["PD-0101"], failing as never);
  assert.equal(noneFound.size, 0, "a failed employees read must not throw the vacancies page away");

  /* ---------- 6. the seat answers where the vacancy row forgot ---------- */

  // The area list comes from `loadReferenceAreas()`, the shared one-minute list — NOT from a
  // second query of `areas`, which performance phase 3 ratchets to zero. It holds BOTH spellings:
  // the organogram's own codes sit on rows whose line_id is null, and a line-scoped slug row
  // ("sharkia_2") is the decoy that must not be matched.
  const referenceAreas = [
    { code: "sharkia_2", id: 77, line_id: 2, name: "Sharkia 2", is_active: true, updated_at: null },
    { code: "D24", id: 1110, line_id: null, name: "Sharkia 1", is_active: true, updated_at: null },
  ];
  const readReferenceAreas = async () => referenceAreas;

  // `areas` FAILS on this fake client on purpose: a direct read of the table would resolve no id
  // at all, so the areaId assertion below is what catches a re-added query.
  const organogram = fakeSupabaseClient(
    {
      areas: [{ code: "D24", id: 1110, line_id: null }],
      au_v_org_tree: [
        {
          area_code: "D24",
          area_name: "Sharkia 1",
          region_name: "Delta (2)",
          seat_id: "SEAT-PED-REP-D24",
        },
      ],
    },
    { failOn: { areas: "areas must not be read directly — use the shared reference list" } },
  );

  const places = await loadVacancySeatPlaces(
    ["SEAT-PED-REP-D24", "SEAT-DOES-NOT-EXIST", null, ""],
    organogram as never,
    readReferenceAreas,
  );
  const place = places.get("SEAT-PED-REP-D24");
  assert.ok(place, "the seat the organogram knows must resolve");
  assert.equal(place?.areaName, "Sharkia 1", "VAC-PD0019-DWF read 'Unknown Area' with this one join away");
  assert.equal(place?.regionName, "Delta (2)", "the region comes from the same seat row");
  assert.equal(
    place?.areaId,
    1110,
    "the numeric id matters as much as the name: buildSeatHireHref carries it into the Add Employee prefill",
  );
  assert.equal(
    places.get("SEAT-DOES-NOT-EXIST"),
    null,
    "an unknown seat is null — the page then shows what it showed before, never a wrong area",
  );
  assert.equal(places.size, 1, "only the seats asked about are indexed");

  const noSeats = await loadVacancySeatPlaces(
    [null, undefined, "  "],
    organogram as never,
    async () => {
      throw new Error("no seat ids means no area list read either");
    },
  );
  assert.equal(noSeats.size, 0, "no seat ids means no read at all: the normal case costs nothing");

  // 🔴 A VACANCY'S AREA COMES FROM THE AU ORGANOGRAM (owner, 2026-10-26). The seat answers first
  // and the row's stored area_id is the FALLBACK, so a seat the organogram moves moves here too.
  // The one exception is a seat that names no area at all — a District Manager seat owns a region —
  // and there the row's own area must still be shown rather than nothing.
  const serviceText = sourceLines(SERVICE).join("\n");
  assert.match(
    serviceText,
    /const seatPlace = seatPlaces\?\.get\(row\.seat_id \?\? null\) \?\? null;/,
    "every seat on the list is looked up, not only the rows whose own area_id is null",
  );
  assert.match(
    serviceText,
    /areaId: \(seatNamesTheArea \? seatPlace\?\.areaId : null\) \?\? row\.area_id \?\? null/,
    "the organogram seat's area id comes BEFORE the row's own — the organogram is the authority",
  );
  assert.match(
    serviceText,
    /areaName: \(seatNamesTheArea \? seatPlace\?\.areaName : null\) \?\? row\.areas\?\.name \?\? null/,
    "the organogram seat's area name comes BEFORE the row's own",
  );
  assert.match(
    serviceText,
    /const seatNamesTheArea = seatPlace\?\.areaName !== null && seatPlace\?\.areaName !== undefined;/,
    "a DM seat names no area, and must fall back to the row rather than blank the column",
  );
}
