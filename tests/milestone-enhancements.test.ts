import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { permissionMatrix, permissionResources } from "@/lib/auth/permissions";
import {
  MILESTONE_CARD_LAYOUT_SCRIPT,
  milestoneCardHtml,
  milestoneCardSvg,
  milestoneCardsHtml,
  type MilestoneCardInput,
} from "@/lib/milestones/card";
import { occurrenceKey, type MilestonePrintHistoryRow } from "@/lib/milestones/ledger";
import { MILESTONE_BATCH_MAX } from "@/lib/milestones/render";
import { buildMilestonePrintHistoryEntry } from "@/lib/milestones/service";
import { buildMilestonePrintHistoryWorkbook } from "@/lib/milestones/print-history-export";
import {
  MilestoneSpecError,
  birthdayCitation,
  birthdayEyebrow,
  birthdaySpec,
  birthdayTileNumeral,
  birthdayTileUnit,
  calendarMilestoneSpecs,
  firstSatoBirthday,
  formatMilestoneSpec,
  monthDayOf,
  parseMilestoneSpec,
  satoBirthdayOrdinal,
  type PlainDate,
} from "@/lib/milestones/periods";
import { buildHrCalendarEvents } from "@/lib/hr-calendar/calendar-logic";

/**
 * The six milestone enhancements the owner approved on 2026-09-23 — the invariants that would break
 * each of them silently.
 *
 * These read the emitted string, the pure arithmetic, or the route source (AGENTS.md §2.1); none
 * needs a browser or the database, so they run in the ordinary `test` job. The two that a comment
 * flags "break the fix": the batch layout walking every card, and the birthday ordinal counting the
 * hire-day birthday as the first — restore from git, never `git checkout --` over your own change.
 */
export async function runMilestoneEnhancementsTests() {
  const root = process.cwd();

  const baseInput: MilestoneCardInput = {
    displayName: "Omar Gawish",
    roleLine: "HR Section Head · Head Office · Cairo",
    employeeId: "B-10",
    hireDate: { year: 2025, month: 5, day: 2 },
    spec: { count: 1, unit: "year" },
    on: { year: 2026, month: 5, day: 2 },
    citation: "On 2 May 2026, Omar Gawish completes a first year at Sato Pharma.",
    photoDataUri: null,
    initials: "OG",
  };

  // ── Change 7 · the CEO holds NO milestones grant ────────────────────────────────────────────
  // Deleted, not emptied: an empty array would still name him a holder to the union that builds the
  // resource list. So the key is absent from his block entirely.
  assert.equal(
    (permissionMatrix.CEO?.milestones ?? []).length,
    0,
    "the CEO must hold no milestones grant — the owner narrowed it to Super Admin only",
  );
  assert.ok(
    (permissionMatrix["Super Admin"]?.milestones ?? []).includes("export"),
    "Super Admin still holds milestones:export",
  );
  assert.ok(
    permissionResources.includes("milestones"),
    "milestones stays in permissionResources — the union alone fails OPEN",
  );

  // ── Change 2 · a single card's SVG stays byte-identical, and a batch addresses every card ────
  // Card 0 takes the empty prefix, so a single card that now travels the batch builder emits exactly
  // the SVG it always did. If this drifts, every printed single card changes overnight.
  assert.equal(
    milestoneCardHtml(baseInput),
    milestoneCardsHtml([baseInput]),
    "the single card IS the one-item batch — they must be the same document",
  );
  const soloSvg = milestoneCardSvg(baseInput, "trim", "");
  const twoCardHtml = milestoneCardsHtml([baseInput, { ...baseInput, displayName: "Second Person" }]);
  assert.ok(
    twoCardHtml.includes(soloSvg),
    "card 0 of a batch is byte-identical to the single card (empty prefix)",
  );
  assert.equal(
    (twoCardHtml.match(/data-card/g) ?? []).length,
    2,
    "a two-card batch emits two sheets",
  );
  assert.ok(
    twoCardHtml.includes('data-prefix=""') && twoCardHtml.includes('data-prefix="c1-"'),
    "card 0 takes the empty prefix and card 1 takes c1- so their ids never collide",
  );
  assert.ok(
    twoCardHtml.includes('id="c1-card-name"'),
    "the second card's name id is prefixed — cards 2..N are individually addressable",
  );

  // 🔴 BREAK-THE-FIX target. The layout pass must WALK every card, not reach for one fixed id — with
  // a singleton getElementById, cards 2..N print unfitted and render.ts's guard never catches it
  // because card 1 comes back valid. The guard is a COUNT check, not a presence check.
  assert.ok(
    MILESTONE_CARD_LAYOUT_SCRIPT.includes("querySelectorAll('[data-card]')"),
    "the layout pass walks [data-card], it does not fit a single fixed id",
  );
  assert.ok(
    MILESTONE_CARD_LAYOUT_SCRIPT.includes("cards: reports"),
    "the layout pass returns one report per card",
  );
  const renderSource = readFileSync(join(root, "src", "lib", "milestones", "render.ts"), "utf8");
  assert.ok(
    renderSource.includes("cards.length !== expected"),
    "the render guard is a COUNT check — cards 2..N unfitted must throw, not pass silently",
  );

  // ── Change 6 · the citation cannot overflow into the figures strip ──────────────────────────
  // The 25-year citation already ran past the two-line budget into the strip at y=752. A fit loop
  // with a floor keeps the new birthday wording from reopening it.
  assert.ok(
    MILESTONE_CARD_LAYOUT_SCRIPT.includes("CITE_FLOOR = 8.6") &&
      MILESTONE_CARD_LAYOUT_SCRIPT.includes("CITE_BUDGET = 2"),
    "the citation fits to a 2-line budget with an 8.6pt floor",
  );

  // ── Change 6 · the birthday ordinal counts SATO birthdays, and never the age ────────────────
  // Hired ON the birthday is the first. The next years count up from there. The age is never even
  // representable: MonthDay carries no year, and nothing here takes the birth year.
  const bd = monthDayOf("1990-05-03");
  assert.ok(bd, "a birth date reads to a month/day");
  const hiredOnBirthday: PlainDate = { year: 2020, month: 5, day: 3 };
  const first = firstSatoBirthday(hiredOnBirthday, bd);
  assert.deepEqual(first, { year: 2020, month: 5, day: 3 }, "hired on the birthday → the first is that day");
  assert.equal(satoBirthdayOrdinal({ year: 2020, month: 5, day: 3 }, first), 1, "that day is the FIRST birthday");
  assert.equal(satoBirthdayOrdinal({ year: 2023, month: 5, day: 3 }, first), 4, "three years on is the FOURTH");
  // Hired the day AFTER the birthday → the first Sato birthday is next year.
  const hiredDayAfter: PlainDate = { year: 2020, month: 5, day: 4 };
  assert.deepEqual(
    firstSatoBirthday(hiredDayAfter, bd),
    { year: 2021, month: 5, day: 3 },
    "hired the day after → the first birthday is next year",
  );

  assert.equal(birthdayTileNumeral(4), "04", "the tile numeral is the ordinal, two digits");
  assert.equal(birthdayTileUnit(), "birthday", "the tile word is BIRTHDAY, singular");
  assert.equal(birthdayEyebrow(1), "first birthday at Sato Pharma", "the eyebrow names the ordinal, not an age");
  const citation = birthdayCitation({ firstName: "Omar", ordinal: 4, on: { year: 2027, month: 9, day: 5 } });
  assert.ok(citation.includes("marks"), "a birthday is MARKED, never completed");
  assert.ok(citation.includes("fourth birthday at Sato Pharma"), "it names which Sato birthday it is");
  assert.ok(
    !/\bage\b/i.test(citation) && !/years old/i.test(citation) && !/\baged\b/i.test(citation),
    "a birthday card never states the person's age",
  );
  assert.equal(birthdaySpec(4), "b4", "a birthday's spec is b<ordinal>");
  assert.throws(
    () => parseMilestoneSpec("b4"),
    MilestoneSpecError,
    "a birthday spec is NOT a MilestoneSpec — the arithmetic must refuse it so callers branch",
  );

  // ── Change 1 · an occurrence's identity is its DERIVED date, never the typed one ─────────────
  const arithmetic = "2026-05-02";
  const keyA = occurrenceKey({ subjectHrId: "b-10", periodSpec: "1Y", derivedOn: arithmetic });
  const keyB = occurrenceKey({ subjectHrId: "B-10", periodSpec: "1y", derivedOn: arithmetic });
  assert.equal(keyA, keyB, "the key folds hr-id and spec casing so one feed cannot split an occasion");
  const keyOtherDate = occurrenceKey({ subjectHrId: "B-10", periodSpec: "1y", derivedOn: "2026-05-03" });
  assert.notEqual(keyA, keyOtherDate, "a different derived date is a different occurrence");
  const cardRoute = readFileSync(join(root, "app", "api", "milestones", "card", "route.ts"), "utf8");
  assert.ok(
    cardRoute.includes("derivedOn: built.derivedOn") && cardRoute.includes("milestoneOn: built.on"),
    "the print row's identity is the arithmetic date; the typed date rides only in milestoneOn",
  );

  // ── Change 3 · the seen route takes NO occurrence list from the client ──────────────────────
  const seenRoute = readFileSync(join(root, "app", "api", "milestones", "seen", "route.ts"), "utf8");
  assert.ok(
    seenRoute.includes("milestoneNoticeWindow()") && seenRoute.includes("listMilestoneNoticeOccasions"),
    "the seen route re-derives the canonical window server-side",
  );
  assert.ok(
    !seenRoute.includes("request.json"),
    "the seen route reads no body — a client cannot name what it silences",
  );
  assert.ok(
    seenRoute.includes('assertPermission(access, "milestones", "read")') &&
      seenRoute.includes("assertSameOriginMutation"),
    "the seen route asserts milestones:read and same-origin",
  );

  // ── Change 4 · the calendar ladder is first-month-then-yearly, clamped, capped at 60 ─────────
  const hire: PlainDate = { year: 2020, month: 5, day: 3 };
  const ladder = calendarMilestoneSpecs(hire, 2025).map(formatMilestoneSpec);
  assert.equal(ladder[0], "1m", "the ladder opens on the first month");
  assert.deepEqual(
    ladder.slice(1),
    ["1y", "2y", "3y", "4y", "5y", "6y"],
    "then every year — including the 4th, which the preset ladder skips",
  );
  assert.ok(!ladder.some((spec) => spec === "6m"), "no six-months in the calendar ladder");
  const capped = calendarMilestoneSpecs({ year: 1900, month: 1, day: 1 }, 2025).map(formatMilestoneSpec);
  assert.equal(capped[capped.length - 1], "60y", "the ladder caps at 60 years, the arithmetic ceiling");

  // The calendar dates from the milestone arithmetic (which CLAMPS), never the rolling Date helper.
  const calendarSource = readFileSync(join(root, "src", "lib", "hr-calendar", "calendar-logic.ts"), "utf8");
  assert.ok(!calendarSource.includes("monthDayDate"), "the rolling monthDayDate helper is gone");
  assert.ok(
    calendarSource.includes("calendarMilestoneSpecs") && calendarSource.includes("milestoneDate"),
    "the calendar dates events by the clamping milestone arithmetic",
  );

  // A 29-February birthday is CLAMPED to 28 February in a common year, so leap-day staff appear at
  // all — the old rollover pushed them to 1 March, matching no day of the month.
  const leapDayStaff = buildHrCalendarEvents(
    [
      {
        areaName: "",
        birthDate: "1992-02-29",
        fullName: "Leap Day",
        hireDate: "2019-06-01",
        hrId: "L-01",
        jobTitle: "",
        lineName: "",
        managerName: "",
        workEmail: null,
      },
    ],
    2, // February
    2026, // a common year
  );
  const birthday = leapDayStaff.find((event) => event.eventType === "birthday");
  assert.ok(birthday, "a leap-day birthday appears in February of a common year");
  assert.equal(birthday?.date, "2026-02-28", "clamped to the 28th, never rolled to 1 March");
  assert.ok(
    typeof birthday?.spec === "string" && /^b\d+$/.test(birthday.spec),
    "a calendar birthday carries a printable b<ordinal> spec",
  );

  // The service ladder rows carry their own printable spec; a plain arrival carries none.
  const serviceEvents = buildHrCalendarEvents(
    [
      {
        areaName: "",
        birthDate: "",
        fullName: "Service Person",
        hireDate: "2019-05-02",
        hrId: "S-01",
        jobTitle: "",
        lineName: "",
        managerName: "",
        workEmail: null,
      },
    ],
    5,
    2026,
  );
  const anniversary = serviceEvents.find((event) => event.eventType === "anniversary");
  assert.equal(anniversary?.spec, "7y", "the seventh anniversary prints a 7y card");
}

/**
 * The three enhancements the owner approved on 2026-09-23 — the print history and its export, the
 * "print all due" shortcut, and the raised batch ceiling.
 *
 * The batch/print-all flow is a browser interaction (one POST, one download) that CI cannot exercise
 * without Chromium; what is pinnable without a browser or database is here: the ceiling constant, the
 * history row shaping (names, Cairo time, occasion label, no age on a birthday), and that the export
 * emits a real .xlsx.
 */
export async function runMilestonePrintHistoryAndPagingTests() {
  // ── C: the paging ceiling was raised from 30 so a whole window prints as one download ──────────
  assert.equal(MILESTONE_BATCH_MAX, 150, "the batch ceiling is the raised per-download limit");
  assert.ok(MILESTONE_BATCH_MAX > 30, "the old 30-card cap was lifted");

  const resolve = (hrId: string | null): string | null =>
    hrId && hrId.trim().toUpperCase() === "B-10" ? "Omar Gawish" : null;

  // ── A: a service print row shapes to names, a Cairo time, and the occasion label ───────────────
  const serviceRow: MilestonePrintHistoryRow = {
    created_at: "2026-09-20T09:30:00Z",
    subject_hr_id: "p-12",
    printed_name: "Sara Adel",
    period_spec: "5y",
    derived_on: "2026-09-18",
    milestone_on: "2026-09-18",
    format: "pdf",
    variant: "trim",
    file_name: "sara.pdf",
    photo_source: "record",
    actor_hr_id: "b-10",
    actor_name: null,
    actor_login_id: "omar",
  };
  const service = buildMilestonePrintHistoryEntry(serviceRow, resolve);
  assert.equal(service.subjectName, "Sara Adel", "the printed name is who was congratulated");
  assert.equal(service.occasion, "Five years", "the occasion is worked from the stored spec");
  assert.equal(service.kind, "service", "a year spec is a service milestone");
  assert.equal(service.format, "PDF", "the format is upper-cased");
  assert.equal(service.actorName, "Omar Gawish", "the actor HR id resolves to a name");
  // en-GB short-month is 3 letters for every month but September, which ICU renders "Sept".
  assert.match(service.printedAt, /^\d{2} \w{3,4} 2026, \d{2}:\d{2}$/, "the print time is Cairo local, not raw UTC");
  assert.notEqual(service.printedAt, serviceRow.created_at, "the raw timestamptz is not shown");
  assert.match(service.milestoneOn, /September 2026/, "the milestone date is printed in full");

  // ── A: a birthday row names the ordinal birthday and NEVER an age ──────────────────────────────
  const birthdayRow: MilestonePrintHistoryRow = {
    ...serviceRow,
    subject_hr_id: "h-1",
    printed_name: "Mariam Adel",
    period_spec: "b4",
    derived_on: "2027-09-05",
    milestone_on: "2027-09-05",
  };
  const birthday = buildMilestonePrintHistoryEntry(birthdayRow, resolve);
  assert.equal(birthday.kind, "birthday", "a b<ordinal> spec is a birthday");
  assert.equal(birthday.occasion, "Fourth birthday", "the birthday counts the ordinal at Sato Pharma");
  assert.ok(!/\bage\b|years old/i.test(birthday.occasion), "a birthday occasion never states an age");

  // ── A: the actor falls back to the login id when no name resolves, and the subject to its id ───
  const anon = buildMilestonePrintHistoryEntry(
    { ...serviceRow, printed_name: "", subject_hr_id: "x-9", actor_hr_id: "z-0", actor_name: null, actor_login_id: "sys" },
    () => null,
  );
  assert.equal(anon.actorName, "sys", "an unresolved actor falls back to the login id");
  assert.equal(anon.subjectName, "x-9", "an empty printed name falls back to the subject id");

  // ── A: the export emits a real .xlsx (a ZIP, magic bytes PK) ───────────────────────────────────
  const workbook = await buildMilestonePrintHistoryWorkbook([service, birthday]);
  assert.ok(Buffer.isBuffer(workbook) && workbook.length > 0, "the export produces bytes");
  assert.equal(workbook[0], 0x50, "the export is a ZIP (xlsx) — byte 0 is 'P'");
  assert.equal(workbook[1], 0x4b, "the export is a ZIP (xlsx) — byte 1 is 'K'");
}
