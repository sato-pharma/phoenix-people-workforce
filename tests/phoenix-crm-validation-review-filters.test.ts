import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import {
  decidedByMatches,
  decidedSectionTitle,
  distinctValues,
  EMPTY_VALIDATION_REVIEW_FILTERS,
  hasActiveValidationReviewFilter,
  matchesValidationReviewFilters,
  validationReviewPeriodCutoff,
  withinValidationReviewPeriod,
  type ValidationReviewFilterable,
  type ValidationReviewFilters,
} from "../src/lib/phoenix-crm/validation-review-filters.ts";

/**
 * Phoenix CRM — the Place checks filter bar (owner, 2026-10-05: "filter by rep by line by region by
 * period by field by rejected by accepted by any single thing").
 *
 * The filter logic is a pure module so it can be exercised here directly — the board that uses it is a
 * client component the harness does not render, so the last section pins by source that the board wires
 * these functions and declares the admin surface the combo-box dropdowns need.
 */

const ROOT = new URL("../", import.meta.url);

function read(path: string): string {
  return stripComments(readFileSync(new URL(path, ROOT), "utf8").replace(/\r\n/g, "\n"));
}

function rowFor(overrides: Partial<ValidationReviewFilterable>): ValidationReviewFilterable {
  return {
    repName: "Mariam Adel",
    line: "Pedia",
    region: "Delta (1)",
    listType: "AM",
    customerName: "صيدلية التهامي",
    territory: "Tanta 2 · Pedia",
    speciality: null,
    placeLabel: null,
    address: null,
    brickName: null,
    areaName: null,
    ...overrides,
  };
}

function filtersFor(overrides: Partial<ValidationReviewFilters>): ValidationReviewFilters {
  return { ...EMPTY_VALIDATION_REVIEW_FILTERS, ...overrides };
}

export function runPhoenixCrmValidationReviewFiltersTests(): void {
  // ── distinctValues: dedup, drop blanks, sort ─────────────────────────────────────────────────────
  assert.deepEqual(
    distinctValues(["Pedia", "CNS", "Pedia", null, "", "   ", undefined, "Anti Infective"]),
    ["Anti Infective", "CNS", "Pedia"],
    "distinct values are deduped, blank-free and sorted for the dropdown",
  );
  assert.deepEqual(distinctValues([]), [], "no rows means an empty option list");

  // ── validationReviewPeriodCutoff ─────────────────────────────────────────────────────────────────
  const now = Date.UTC(2026, 9, 5, 9, 0, 0); // 2026-10-05
  assert.equal(validationReviewPeriodCutoff("all", now), null, '"any time" has no cutoff');
  assert.equal(validationReviewPeriodCutoff("7", now), now - 7 * 86_400_000, "7 days is now minus seven days");
  assert.equal(validationReviewPeriodCutoff("30", now), now - 30 * 86_400_000, "30 days is now minus thirty days");
  const today = validationReviewPeriodCutoff("today", now);
  assert.ok(today !== null && today <= now, '"today" starts at or before now');
  assert.ok(today !== null && now - today < 86_400_000, '"today" is within the last day');

  // ── withinValidationReviewPeriod ─────────────────────────────────────────────────────────────────
  const cutoff = now - 7 * 86_400_000;
  assert.equal(withinValidationReviewPeriod("2026-10-04T10:00:00.000Z", cutoff), true, "a row inside the window is kept");
  assert.equal(withinValidationReviewPeriod("2026-09-01T10:00:00.000Z", cutoff), false, "a row older than the window is dropped");
  assert.equal(withinValidationReviewPeriod("2026-09-01T10:00:00.000Z", null), true, "no cutoff keeps everything");
  assert.equal(withinValidationReviewPeriod("not a date", cutoff), true, "an unreadable date is kept, never silently dropped");

  // ── matchesValidationReviewFilters: each dimension on its own ─────────────────────────────────────
  const base = rowFor({});
  assert.equal(matchesValidationReviewFilters(base, EMPTY_VALIDATION_REVIEW_FILTERS), true, "no filter matches every row");

  assert.equal(matchesValidationReviewFilters(base, filtersFor({ rep: "Mariam Adel" })), true, "the rep matches");
  assert.equal(matchesValidationReviewFilters(base, filtersFor({ rep: "Someone Else" })), false, "another rep does not");

  assert.equal(matchesValidationReviewFilters(base, filtersFor({ line: "Pedia" })), true, "the line matches");
  assert.equal(matchesValidationReviewFilters(base, filtersFor({ line: "CNS" })), false, "another line does not");

  assert.equal(matchesValidationReviewFilters(base, filtersFor({ region: "Delta (1)" })), true, "the region matches");
  assert.equal(matchesValidationReviewFilters(base, filtersFor({ region: "Upper Egypt" })), false, "another region does not");

  const seated = rowFor({ areaName: "Tanta 2" });
  assert.equal(matchesValidationReviewFilters(seated, filtersFor({ area: "Tanta 2" })), true, "the area matches");
  assert.equal(matchesValidationReviewFilters(seated, filtersFor({ area: "Qalubeya" })), false, "another area does not");

  assert.equal(matchesValidationReviewFilters(base, filtersFor({ list: "AM" })), true, "the AM list matches");
  assert.equal(matchesValidationReviewFilters(base, filtersFor({ list: "PM" })), false, "the PM list does not");

  // A row with no line/region/area is excluded by that filter, never treated as a wildcard.
  const unseated = rowFor({ line: null, region: null, areaName: null });
  assert.equal(matchesValidationReviewFilters(unseated, filtersFor({ line: "Pedia" })), false, "a row with no line fails a line filter");
  assert.equal(matchesValidationReviewFilters(unseated, filtersFor({ region: "Delta (1)" })), false, "a row with no region fails a region filter");
  assert.equal(matchesValidationReviewFilters(unseated, filtersFor({ area: "Tanta 2" })), false, "a row with no area fails an area filter");
  assert.equal(matchesValidationReviewFilters(unseated, EMPTY_VALIDATION_REVIEW_FILTERS), true, "but is shown when nothing filters it");

  // Free text searches name, rep, territory, speciality, place label, brick, area and address.
  const rich = rowFor({ speciality: "Pediatrics", placeLabel: "Nile Tower, floor 3", brickName: "Tanta East", areaName: "Tanta 2", address: "15 El Geish Street" });
  assert.equal(matchesValidationReviewFilters(rich, filtersFor({ text: "التهامي" })), true, "the Arabic customer name is searchable");
  assert.equal(matchesValidationReviewFilters(rich, filtersFor({ text: "pediatr" })), true, "the speciality is searchable, case-insensitively");
  assert.equal(matchesValidationReviewFilters(rich, filtersFor({ text: "nile tower" })), true, "the place label is searchable");
  assert.equal(matchesValidationReviewFilters(rich, filtersFor({ text: "tanta east" })), true, "the brick is searchable");
  assert.equal(matchesValidationReviewFilters(rich, filtersFor({ text: "el geish" })), true, "the address is searchable");
  assert.equal(matchesValidationReviewFilters(rich, filtersFor({ text: "nothing here" })), false, "an unmatched search drops the row");
  assert.equal(matchesValidationReviewFilters(rich, filtersFor({ text: "   " })), true, "a whitespace-only search is treated as no search");

  // Two dimensions at once both have to hold.
  assert.equal(matchesValidationReviewFilters(base, filtersFor({ line: "Pedia", rep: "Mariam Adel" })), true, "both set and both match");
  assert.equal(matchesValidationReviewFilters(base, filtersFor({ line: "Pedia", rep: "Someone Else" })), false, "both set, one fails");

  // ── hasActiveValidationReviewFilter: the outcome alone does not count ─────────────────────────────
  assert.equal(hasActiveValidationReviewFilter(EMPTY_VALIDATION_REVIEW_FILTERS), false, "nothing set is not an active filter");
  assert.equal(hasActiveValidationReviewFilter(filtersFor({ outcome: "approved" })), false, "the outcome selector alone is not a narrowing filter");
  for (const active of [{ rep: "x" }, { line: "x" }, { region: "x" }, { area: "x" }, { list: "x" }, { period: "7" as const }, { decider: "x" }, { text: "x" }]) {
    assert.equal(hasActiveValidationReviewFilter(filtersFor(active)), true, `a set ${Object.keys(active)[0]} is an active filter`);
  }
  assert.equal(hasActiveValidationReviewFilter(filtersFor({ text: "   " })), false, "a whitespace-only search is not an active filter");

  // ── Decided by (owner, 2026-10-26: "view only approved by me or only by khaled bedair") ───────────
  assert.equal(decidedByMatches("Khaled Bedair", ""), true, "nobody chosen passes a decided row");
  assert.equal(decidedByMatches(null, ""), true, "nobody chosen passes a waiting row too");
  assert.equal(decidedByMatches("Khaled Bedair", "Khaled Bedair"), true, "his own decision passes his name");
  assert.equal(decidedByMatches("Omar Gawish", "Khaled Bedair"), false, "another person's decision does not");
  assert.equal(decidedByMatches(null, "Khaled Bedair"), false, "a row nobody decided passes no decider");
  assert.equal(decidedByMatches("The system", "The system"), true, "the system's own approvals are a decider of their own");
  assert.equal(decidedSectionTitle(filtersFor({ decider: "Khaled Bedair", outcome: "approved" }), false), "Approved by Khaled Bedair");
  assert.equal(decidedSectionTitle(filtersFor({ decider: "Khaled Bedair", outcome: "rejected" }), false), "Rejected by Khaled Bedair");
  assert.equal(decidedSectionTitle(filtersFor({ decider: "Khaled Bedair" }), false), "Decided by Khaled Bedair", "a chosen decider drops the 14-day words");
  assert.equal(decidedSectionTitle(filtersFor({}), false), "Decided in the last 14 days");
  assert.equal(decidedSectionTitle(filtersFor({ decider: "Khaled Bedair" }), true), "Settled in the last 14 days", "a manager's board never names a decider");

  // ── The board wires the pure logic, declares the admin surface, and owns the search ──────────────
  const board = read("src/components/phoenix-crm/validation-reviews-board.tsx");
  assert.match(board, /from "@\/lib\/phoenix-crm\/validation-review-filters"/, "the board reads its logic from the pure module, never a second copy");
  assert.match(board, /<CrmSurfaceProvider surface="admin">/, "the admin surface turns the filter dropdowns into combo boxes the Super Admin types into");
  assert.match(board, /showSearch=\{false\}/, "the board owns the search, so the validated list's own box is turned off");
  for (const key of ["vr-outcome", "vr-rep", "vr-line", "vr-region", "vr-area", "vr-list", "vr-period", "vr-search"]) {
    assert.ok(board.includes(`"${key}"`), `the board offers the ${key} control`);
  }

  // The page hands the board every set — and, since 2026-10-08, the customers waiting to be captured
  // again and which reads hit their ceiling — rather than rendering the sections itself.
  // Asserted one prop at a time rather than as one literal line: the element wrapped across six lines
  // when the Polyclinics set joined it (2026-10-09), and a single-line pattern reads that formatting
  // as a missing set. What is pinned is that every set reaches the board and the page draws none itself.
  const page = read("app/(admin)/admin/field-crm/validation-reviews/page.tsx");
  // The one-by-one review's wrapper (2026-10-18) hands every prop on to the board unchanged.
  assert.ok(page.includes("<ValidationReviewsBoard") || page.includes("<PlaceChecksWithDeck"), "the page delegates the sections to the board");
  // 🔴 THE 14-DAY READ WOULD HAVE HIDDEN 86 OF HIS 480 DECISIONS: the Super Admin's page reads every
  // decision, its cards count only the recent ones, and the board shows the older ones only while a
  // decider is chosen. The manager's box is never drawn.
  assert.match(page, /loadValidationReviews\(viewer, \{ everyDecision: true \}\)/, "the page reads every decision, not the 14-day window");
  assert.match(page, /realDecided = real\(decided\)\.filter\(\(row\) => row\.recent\)/, "the 14-day cards still count only the recent decisions");
  assert.match(board, /filters\.decider \? everyDecided : everyDecided\.filter\(\(row\) => row\.recent\)/, "the older decisions show only while a decider is chosen");
  assert.match(board, /\{team \? null : \(\s*<CrmField htmlFor="vr-decider"/, "the Decided by box is the company board's alone");
  for (const prop of ["capped={capped}", "decided={recentDecided}", "onDemand={onDemand}", "pending={waiting}", "reopened={reopened}", "sharedPlaces={sharedPlaces}", "validated={seatedInUse}"]) {
    assert.ok(page.includes(prop), `the board is handed ${prop}`);
  }
}
