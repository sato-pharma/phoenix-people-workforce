/**
 * One prepared board row — the case, its standing, its story, its map and everything the filters read.
 *
 * 🔴 IT IS A PURE MODULE AND NOT PART OF THE VIEW, BECAUSE TWO READERS MUST AGREE. The screen builds
 * these rows and filters them in memory; the XLSX export route builds the SAME rows from the SAME
 * loaded board and applies the SAME filters from the query string the screen put in the address. He
 * asked for "an export of what I am looking at", and the only way that stays true as either side is
 * touched is that there is one mapping and one matcher. A second copy in the route would have drifted
 * the first time a filter learned a new field — and nothing would have gone red, because each half
 * would still have been self-consistent.
 *
 * `IntegrityCase` comes in as a TYPE ONLY (erased at build), so this module stays importable from a
 * client component: a value import from `server/integrity-board.ts` would carry the service-role
 * Supabase client into the browser bundle.
 */

import {
  integrityDistanceBandOf,
  type IntegrityFilterable,
} from "@/lib/crm-integrity/integrity-board-filters";
import { buildCaseMap, type CaseMap } from "@/lib/crm-integrity/integrity-case-map";
import { caseStory, integritySourceStoryLabel, type CaseStory } from "@/lib/crm-integrity/integrity-case-story";
import { cairoDateTimeSortable } from "@/lib/format/cairo-datetime";
import type { IntegrityCase } from "@/lib/phoenix-crm/server/integrity-board";

export type IntegrityStandingOf = "open" | "settled" | "withdrawn";

/** One case with everything the screen and the export need computed once, rather than per keystroke. */
export type IntegrityBoardRow = {
  entry: IntegrityCase;
  standing: IntegrityStandingOf;
  story: CaseStory;
  /** Null when the case kept no usable reading — the panel then says so in words. */
  map: CaseMap | null;
  filterable: IntegrityFilterable;
};

/**
 * The Cairo DAY an instant falls on, as `yyyy-mm-dd` — what the two date filters compare against.
 *
 * Cairo and not UTC, because the day is picked on a calendar in Cairo: a capture at 01:30 local on
 * the 4th is 23:30 UTC on the 3rd, and filtering "the 4th" in UTC would hide it.
 */
export function integrityCairoDay(value: string | null): string | null {
  if (value === null || value === "") return null;
  const stamped = cairoDateTimeSortable(value);
  return stamped === "" ? null : stamped.slice(0, 10);
}

export function integrityBoardRow(entry: IntegrityCase, standing: IntegrityStandingOf): IntegrityBoardRow {
  // The map first: its spread is the one number the "how far apart" filter bands by, and the story
  // prints it too, so both must read the same measurement rather than two of their own.
  const map = buildCaseMap(
    entry.readings.map((reading) => ({
      label: reading.label,
      lat: reading.lat,
      lon: reading.lon,
      accuracyMeters: reading.accuracyMeters,
    })),
  );
  const story = caseStory({
    source: entry.source,
    subjectKind: entry.subjectKind,
    strong: entry.strong,
    flags: entry.flags,
    reasons: entry.reasons,
    repName: entry.repName,
    customerName: entry.customerName,
    customerList: entry.customerList,
    customerSpeciality: entry.customerSpeciality,
    subjectLabel: entry.subjectLabel,
    brickName: entry.brickName,
    brickDistanceKm: entry.brickDistanceKm,
    placeDistanceMeters: entry.placeDistanceMeters,
    readings: entry.readings,
    spreadMeters: map?.spreadMeters ?? null,
    accuracyMeters: entry.accuracyMeters,
    deviceMocked: entry.deviceMocked,
    signText: entry.signText,
    companionNames: entry.companionNames,
    replayByName: entry.replayByName,
    signals: entry.signals,
    photoPath: entry.photoPath,
    visitDate: entry.visitDate,
  });
  return {
    entry,
    standing,
    story,
    map,
    filterable: {
      repName: entry.repName,
      repLine: entry.repLine,
      repArea: entry.repArea,
      repRegion: entry.repRegion,
      customerName: entry.customerName,
      customerList: entry.customerList,
      customerSpeciality: entry.customerSpeciality,
      subjectLabel: entry.subjectLabel,
      brickName: entry.brickName,
      source: entry.source,
      sourceLabel: integritySourceStoryLabel(entry.source),
      flags: entry.flags,
      reasons: entry.reasons,
      strong: entry.strong,
      standing,
      hasPhoto: entry.photoPath !== null,
      // The visit's own day when it carries one, otherwise the day the capture was saved. A place
      // case has no visit date at all, and leaving it dayless would hide 161 of the 164 from a day
      // filter — which reads as "no cases" and means "no such field".
      visitDay: entry.visitDate !== null && entry.visitDate !== "" ? entry.visitDate.slice(0, 10) : integrityCairoDay(entry.capturedAt),
      filedDay: integrityCairoDay(entry.filedAt),
      spreadMeters: map?.spreadMeters ?? null,
      headline: story.headline,
      story: story.story,
    },
  };
}

/**
 * Every row a loaded board holds, open first, then withdrawn, then settled — the order the screen
 * builds them in, so the export's rows are the screen's rows before filtering.
 */
export function integrityBoardRows(board: {
  cases: ReadonlyArray<IntegrityCase>;
  withdrawn: ReadonlyArray<IntegrityCase>;
  settled: ReadonlyArray<IntegrityCase>;
}): IntegrityBoardRow[] {
  return [
    ...board.cases.map((entry) => integrityBoardRow(entry, "open")),
    ...board.withdrawn.map((entry) => integrityBoardRow(entry, "withdrawn")),
    ...board.settled.map((entry) => integrityBoardRow(entry, "settled")),
  ];
}

/** The band a row's spread falls in, in the reader's own words — `—` when it has fewer than two readings. */
export function integrityRowDistanceWords(row: IntegrityBoardRow, labels: Record<string, string>): string {
  const band = integrityDistanceBandOf(row.filterable.spreadMeters);
  return band === null ? "-" : (labels[band] ?? band);
}
