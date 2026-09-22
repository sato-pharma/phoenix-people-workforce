import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  currentCairoMonthWindow,
  isHiredInsideWindow,
  resolveHiredWindow,
} from "../src/lib/recruitment/dashboard.ts";

// ─────────────────────────────────────────────────────────────────────────────
// The HR command centre's "Hired" tile counted every application that ever reached the hired
// stage, captioned "converted to employees".
//
// That total is TRUE and it is the wrong number in that position. It sits in a row with "In
// Screening", "Interviewing" and "Active Candidates" — all counts of the pipeline AS IT STANDS —
// so read across, a lifetime total says the company hired that many people recently. It would
// still read 47 with the last hire two years behind it, and nothing on the tile would say so.
//
// Production held 2 hired applications when this was fixed (2026-09-22), both stamped 2026-09-11,
// so every candidate window read 2 and the defect was not yet visible. It was going to be.
//
// The owner's decision, 2026-09-22: "make it by default cairo current month but i have the option
// to date picker from to". So the tile counts a window, defaulting to the running Cairo month,
// and the caption NAMES that window instead of leaving it to be inferred.
//
// Pinned here: the day-boundary arithmetic, Cairo (not UTC) day attribution, the normalisation of
// everything a picker can hand back, and the fact that the lifetime figure survives under its own
// name rather than being redefined in place.
// ─────────────────────────────────────────────────────────────────────────────

function hired(stamp: string | null) {
  return { lastStageChangedAt: stamp as string, stage: "hired" as const };
}

export function runHiredTilePeriodTests() {
  // ── The default window is the whole running Cairo month ───────────────────
  assert.deepEqual(
    currentCairoMonthWindow(new Date("2026-09-22T12:00:00Z")),
    { fromIso: "2026-09-01", toIso: "2026-09-30" },
    "September is a 30-day month and the window must cover all of it",
  );
  assert.deepEqual(
    currentCairoMonthWindow(new Date("2026-01-15T12:00:00Z")),
    { fromIso: "2026-01-01", toIso: "2026-01-31" },
    "a 31-day month must not be cut to 30",
  );
  assert.deepEqual(
    currentCairoMonthWindow(new Date("2024-02-10T12:00:00Z")),
    { fromIso: "2024-02-01", toIso: "2024-02-29" },
    "RED a leap February must end on the 29th — a hardcoded 28 loses a whole day of hires",
  );
  assert.deepEqual(
    currentCairoMonthWindow(new Date("2026-02-10T12:00:00Z")),
    { fromIso: "2026-02-01", toIso: "2026-02-28" },
    "a non-leap February ends on the 28th",
  );
  // 23:30 UTC on 31 December is already 01:30 on 1 January in Cairo (UTC+2).
  assert.deepEqual(
    currentCairoMonthWindow(new Date("2025-12-31T23:30:00Z")),
    { fromIso: "2026-01-01", toIso: "2026-01-31" },
    "RED the month must be the CAIRO month — the owner reads every date in Cairo, never raw UTC",
  );

  // ── A hire is placed on its CAIRO day ─────────────────────────────────────
  const september = { fromIso: "2026-09-01", toIso: "2026-09-30" };
  assert.equal(
    isHiredInsideWindow(hired("2026-09-11T08:26:48.500117+00:00"), september),
    true,
    "a hire inside the window counts",
  );
  assert.equal(
    isHiredInsideWindow(hired("2026-09-01T00:30:00Z"), september),
    true,
    "the first day is INCLUSIVE",
  );
  assert.equal(
    isHiredInsideWindow(hired("2026-09-30T20:00:00Z"), september),
    true,
    "the last day is INCLUSIVE",
  );
  assert.equal(
    isHiredInsideWindow(hired("2026-08-31T23:30:00Z"), september),
    true,
    "RED 23:30 UTC on 31 August is already 1 September in Cairo — a UTC comparison drops this hire",
  );
  assert.equal(
    isHiredInsideWindow(hired("2026-09-30T22:30:00Z"), september),
    false,
    "RED 22:30 UTC on 30 September is already 1 October in Cairo — a UTC comparison counts it twice",
  );
  assert.equal(
    isHiredInsideWindow(hired("2026-08-15T10:00:00Z"), september),
    false,
    "a hire from a previous month must NOT count — this is the whole defect",
  );

  // ── Only hires, and only placeable ones ───────────────────────────────────
  assert.equal(
    isHiredInsideWindow({ lastStageChangedAt: "2026-09-11T08:00:00Z", stage: "hr_interview" }, september),
    false,
    "a candidate still interviewing is not a hire",
  );
  assert.equal(
    isHiredInsideWindow(hired(null), september),
    false,
    "a hire with no stamp cannot be placed in time — count it OUT of every window, never into all of them",
  );
  assert.equal(
    isHiredInsideWindow(hired("not-a-date"), september),
    false,
    "an unparseable stamp is not a date; it must not resolve to the epoch or to today",
  );

  // ── Whatever the picker hands back must stay usable ───────────────────────
  const now = new Date("2026-09-22T12:00:00Z");
  assert.deepEqual(
    resolveHiredWindow({}, now),
    { fromIso: "2026-09-01", toIso: "2026-09-30" },
    "no params means the running Cairo month — the owner's stated default",
  );
  assert.deepEqual(
    resolveHiredWindow({ from: "2026-07-01", to: "2026-07-31" }, now),
    { fromIso: "2026-07-01", toIso: "2026-07-31" },
    "a picked range is honoured verbatim",
  );
  assert.deepEqual(
    resolveHiredWindow({ from: "2026-07-31", to: "2026-07-01" }, now),
    { fromIso: "2026-07-01", toIso: "2026-07-31" },
    "RED a reversed range must be SWAPPED, never counted as zero — a tile reading 0 is a claim, and 'no hires' is the most misleading one it can make",
  );
  assert.deepEqual(
    resolveHiredWindow({ from: "rubbish", to: null }, now),
    { fromIso: "2026-09-01", toIso: "2026-09-30" },
    "a malformed bound falls back to the default rather than producing an authoritative-looking wrong count",
  );
  assert.deepEqual(
    resolveHiredWindow({ from: "2026-07-01" }, now),
    { fromIso: "2026-07-01", toIso: "2026-09-30" },
    "one bound is usable: the other keeps its default",
  );

  // ── The lifetime figure survives under its own name ───────────────────────
  // Redefining `hires` in place would silently change it for any future reader; the fix ADDS a
  // field instead, so both questions stay answerable and neither is disguised as the other.
  const dashboard = readFileSync(
    new URL("../src/lib/recruitment/dashboard.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    dashboard,
    /const hires = applications\.filter\(\(application\) => application\.stage === "hired"\)\.length;/,
    "`hires` must still be the lifetime total — the window is a SECOND field, not a redefinition",
  );
  assert.match(dashboard, /hiresInWindow/, "the windowed count must exist");

  // ── The tile must read the windowed figure, not the lifetime one ──────────
  const commandCenter = readFileSync(
    new URL("../src/lib/hr/command-center.ts", import.meta.url),
    "utf8",
  );
  const hiredTile = commandCenter
    .split("\n")
    .find((line) => line.includes('tile("hired"'));
  assert.ok(hiredTile, "the Hired tile must exist");
  assert.match(
    hiredTile,
    /dashboard\.summary\.hiresInWindow/,
    "RED the Hired tile must count the WINDOW — reading summary.hires puts a lifetime total beside four current-state figures",
  );
  assert.doesNotMatch(
    hiredTile,
    /summary\.hires\b(?!InWindow)/,
    "no part of the tile may fall back to the lifetime total",
  );
  assert.doesNotMatch(
    hiredTile,
    /"converted to employees"/,
    "the caption must NAME the window; 'converted to employees' is what let it read as a lifetime figure",
  );
  assert.match(
    commandCenter,
    /function hiredWindowCaption\(/,
    "the caption comes from one helper, so the figure and the words above it cannot drift",
  );
}
