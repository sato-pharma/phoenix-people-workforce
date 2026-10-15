/**
 * THE ORGANOGRAM SEAT-DRIFT BOARD ROWS, AS A PURE FUNCTION.
 *
 * Same split as `office-allocation-drift-items.ts`, and for the same reason: `sources.ts` reaches
 * ~30 `@/lib/**` service modules, one of which heads to `getSupabaseAdmin`, so a gate that imported
 * it could never run offline. This file's only runtime imports are the import-free `./item-fields`
 * and `./types`; the drift shape arrives through a type-only import that
 * `--experimental-strip-types` erases. **Adding a service import here puts this gate back in the
 * PR-only pile**, and `tests/check-contracts.test.ts` walks the graph transitively and fails rather
 * than letting that happen quietly.
 *
 * ONE ITEM PER PERSON, never one per disagreeing fact. A record edited to the wrong area usually
 * moves the region with it — the same typing mistake, one correction, and the owner reading two
 * rows about one person would reasonably conclude there were two problems.
 *
 * 🔴 IT PROPOSES NO REPAIR, AND THAT IS THE RULING, NOT A GAP. Which side is right is a human
 * judgement: on 2026-10-15 the SEAT was right and the record had been mis-edited, and after a real
 * transfer it is the other way round — the record is the newer truth and the seat is what has to
 * move. An automatic "fix" would have been wrong half the time and silent both times. The row links
 * to that person's own record on Employee Master and stops there, like every other row on this
 * board.
 */

import type { EmployeeSeatDrift, EmployeeSeatDriftFactKind } from "@/lib/org/employee-seat-drift";

import { needsYouDestinations, type NeedsYouItem } from "./types";

/** What each disagreeing fact is CALLED, in the sentence the owner reads. */
const FACT_NOUN: Record<EmployeeSeatDriftFactKind, string> = {
  area: "the area",
  region: "the region",
  manager: "the manager",
};

/** "the area", "the area and the manager", "the area, the region and the manager". */
function listNouns(nouns: readonly string[]): string {
  if (nouns.length <= 1) return nouns[0] ?? "";
  return `${nouns.slice(0, -1).join(", ")} and ${nouns[nouns.length - 1]}`;
}

/**
 * The two sides, side by side, in one sentence per fact.
 *
 * A `null` reads as "holds no X" rather than as an empty gap, because the two are different states
 * and the empty one is the more serious: four of the six rows corrected on 2026-10-12 had no area
 * on file at all, and those reps were being shown "We don't have your area on file yet" on every
 * territory screen.
 */
function sideBySide(
  kind: EmployeeSeatDriftFactKind,
  employeeValue: string | null,
  seatValue: string | null,
): string {
  const noun = kind === "area" ? "area" : kind === "region" ? "region" : "manager";
  const left = employeeValue ? `the record says ${employeeValue}` : `the record holds no ${noun}`;
  const right = seatValue ? `the seat says ${seatValue}` : `the seat names no ${noun}`;
  return `On the ${noun}, ${left} and ${right}.`;
}

/**
 * One row per person whose record disagrees with the seat they occupy.
 *
 * `count` is `null` on purpose — a person is not a quantity, the same reading `monthly-closings`
 * gives a month. And `oldestAt` is `null` because the view carries no timestamp: it compares two
 * current values and cannot say when they parted. An age invented from the employee's own
 * `updated_at` would be the age of the LAST edit to the row, not of the drift, and on the
 * 2026-10-15 case that would have read as two days when the record had been wrong since the hire.
 *
 * It takes no `now` for exactly that reason — a parameter nothing reads is an invitation to invent
 * an age out of whatever date is nearest.
 */
export function employeeSeatDriftItems(drifts: readonly EmployeeSeatDrift[]): NeedsYouItem[] {
  const items: NeedsYouItem[] = [];
  for (const drift of drifts) {
    if (drift.facts.length === 0) continue;
    const kinds = drift.facts.map((fact) => fact.kind);

    const note: string[] = drift.facts.map((fact) => sideBySide(fact.kind, fact.employeeValue, fact.seatValue));
    if (kinds.includes("area")) {
      // The consequence that made this source necessary, said plainly. The plan has no rep picker
      // at all — it matches the area by NAME against the EMPLOYEE record — so a drifted area does
      // not merely mislabel somebody, it takes them out of their own area's plan and hands that
      // area's slot to whoever else the name reaches.
      note.push(
        "The weekly and monthly plan has no rep picker: it takes the rep from the area on the "
        + "employee record, so while these disagree this person cannot be planned in the area they "
        + "actually sit in.",
      );
    }
    note.push(
      "Neither side is right by default — after a real transfer the record is the newer truth, and "
      + "after a mis-typed edit the seat is. Open the record on Employee Master and correct "
      + "whichever one moved.",
    );

    items.push({
      key: `organogram-seat-drift:${drift.hrId.toLowerCase()}`,
      sourceId: "organogram-seat-drift",
      kind: "flag",
      lane: "yours",
      // `drift.seat` arrives as a whole noun phrase ("the Behira 1 Medical Representative seat"),
      // so the fallback for a seat with no readable name still reads as English here.
      label:
        `${drift.name}: the employee record and ${drift.seat} disagree about `
        + `${listNouns(kinds.map((kind) => FACT_NOUN[kind]))}`,
      count: null,
      // Names, never HR ids — and the `NeedsYouItem` shape has nowhere to put an id even if an
      // adapter wanted to.
      people: [drift.name],
      // That person's own record, opened for editing. The id travels in the URL and nothing else
      // does; Employee Master finds them in the directory it loads for the viewer.
      href: `${needsYouDestinations["organogram-seat-drift"].href}?edit=${encodeURIComponent(drift.hrId)}`,
      externalUrl: null,
      oldestAt: null,
      ageDays: null,
      // No SLA exists upstream for a record correction, so none is invented here.
      overdue: false,
      note: note.join(" "),
    });
  }
  return items;
}
