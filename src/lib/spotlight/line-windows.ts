// Spotlight — which windows the picker offers for a chosen set of lines.
//
// 🔴 A MONTH IS OFFERED FOR THE LINES THAT HAVE PUBLISHED IT (owner, 2026-11-04). Each line publishes
// its closing on its own day, so on the day Anti-Infective published October, CNS and Pedia had not,
// and a gate that waited for all three hid October from a sheet that is only about Anti-Infective.
// The sheet's rows are filtered to the chosen lines before anything is added up (`rowPassesFilters`
// in rank.ts), so a sheet narrowed to one line never carries another line's sale — and the gate asks
// exactly the lines the sheet reads. No line chosen means the three tracked lines, as everywhere else
// in the Spotlight, so the default sheet still waits for all of them.
//
// Pure and client-safe on purpose: the picker (a client component) builds its key with `lineSetKey`,
// and the server fills the table with `windowsByLineSet`, so both sides spell a line set one way.
// It must not import rank.ts, which pulls in server-only modules.

import { selectableWindows } from "./period";
import type { PeriodKey, SpotlightWindow, SpotlightWindowKind } from "./types";

/** The lines a Spotlight reads when none is chosen. Kept equal to TRACKED_LINES in rank.ts by a test. */
export const SPOTLIGHT_DEFAULT_LINES = ["cns", "pedia", "anti_infective"] as const;

export type SpotlightWindows = Record<SpotlightWindowKind, SpotlightWindow[]>;

export const NO_SPOTLIGHT_WINDOWS: SpotlightWindows = { month: [], quarter: [], semester: [], year: [] };

/** The lines a selection reads: what was ticked, lowercased and de-duplicated, or the three tracked ones. */
export function spotlightLines(lines: readonly string[] | null | undefined): string[] {
  const chosen = [...new Set((lines ?? []).map((line) => line.trim().toLowerCase()).filter(Boolean))].sort();
  return chosen.length > 0 ? chosen : [...SPOTLIGHT_DEFAULT_LINES].sort();
}

/** One spelling of a line set, so a ticked order or a case never changes the answer. */
export function lineSetKey(lines: readonly string[] | null | undefined): string {
  return spotlightLines(lines).join("|");
}

/** Every non-empty combination of the tracked lines, which is every set the picker can build. */
function lineSets(): string[][] {
  const lines = [...SPOTLIGHT_DEFAULT_LINES].sort();
  const sets: string[][] = [];
  for (let mask = 1; mask < 1 << lines.length; mask += 1) {
    sets.push(lines.filter((_, index) => mask & (1 << index)));
  }
  return sets;
}

/**
 * The windows for every set of lines, keyed by `lineSetKey`.
 *
 * `isReleased` answers whether a month is published on ALL of the given lines, and is passed in so
 * this file stays free of the database. A line set that is not in the table (a line the Spotlight
 * does not track) offers nothing, which is how an unknown line fails closed in the picker.
 */
export function windowsByLineSet(
  isReleased: (period: PeriodKey, lines: readonly string[]) => boolean,
  today?: { year: number; month: number },
): Record<string, SpotlightWindows> {
  const out: Record<string, SpotlightWindows> = {};
  for (const lines of lineSets()) {
    const released = (period: PeriodKey) => isReleased(period, lines);
    out[lineSetKey(lines)] = {
      month: selectableWindows("month", today, 18, released),
      quarter: selectableWindows("quarter", today, 8, released),
      semester: selectableWindows("semester", today, 4, released),
      year: selectableWindows("year", today, 4, released),
    };
  }
  return out;
}

/**
 * The period in force: the one picked while it is still on offer, else the newest on offer, else none.
 * Ticking another line can take a month away, and the sheet must never be asked for it then.
 */
export function windowKeyInForce(available: readonly SpotlightWindow[], picked: string): string {
  return available.some((window) => window.key === picked) ? picked : (available[0]?.key ?? "");
}

/** What the picker shows for the lines ticked now. */
export function windowsForLines(
  table: Record<string, SpotlightWindows>,
  lines: readonly string[] | null | undefined,
): SpotlightWindows {
  return table[lineSetKey(lines)] ?? NO_SPOTLIGHT_WINDOWS;
}
