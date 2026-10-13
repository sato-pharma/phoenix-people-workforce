/**
 * THE OFFICE-ALLOCATION BOARD ROW, AS A PURE FUNCTION.
 *
 * Moved out of `sources.ts` unchanged so it can be checked WITHOUT a database. The behaviour is
 * byte-identical to what lived there; `sources.ts` re-exports this, so every caller and the adapter
 * itself still reach it by the same name from the same place.
 *
 * 🔴 WHY IT HAD TO MOVE, AND WHAT MUST NOT COME BACK. `sources.ts` is a registry of ~30 `@/lib/**`
 * service modules, one of which heads to `getSupabaseAdmin` from `@/lib/supabase/server`. Nothing
 * reaches the network at import time — the client is built inside the call — but a Supabase client
 * and `@/lib/env` land in the process the moment anything imports it, which is why this gate was
 * the ONE candidate left out of `pnpm run check:contracts` when that was built. Its own imports are
 * `@/lib/sales/office-distributor` (whose only import, `@/lib/sales/contracts`, has none of its
 * own), the import-free `./types` and `./item-fields`, and a type-only import that
 * `--experimental-strip-types` erases. **Adding a service import here silently puts this gate back
 * in the PR-only pile** — `tests/check-contracts.test.ts` walks the graph transitively and fails
 * instead of letting that happen quietly.
 */

import type { OfficeAllocationDriftReport } from "@/lib/sales/office-allocation-drift";
import { isOfficeRespreadPair } from "@/lib/sales/office-distributor";

import { ageDaysSince, plural } from "./item-fields";
import { needsYouDestinations, type NeedsYouItem } from "./types";

/**
 * A month whose committed Office spread no longer matches where the golden rule would put those
 * units today — one item per drifted LINE, which in practice is CNS, the only line that carries an
 * Office channel at all.
 *
 * 🔴 THE LINE TOTAL IS IDENTICAL ON BOTH SIDES BY CONSTRUCTION, which is the whole reason this row
 * exists. Today's side is today's area shares applied to the line's OWN stored Office total, so the
 * units never change in aggregate — only which area holds them. The publication drift check
 * compares a line's total units, one scalar, so it reads clean through every difference counted
 * here, and the note says that in plain words rather than leaving him to infer it.
 *
 * 🔴 NO EGP, AND NO INSTRUCTION TO RE-COMMIT. The report carries units only, and the board links to
 * the Sales Import wizard without ever proposing the upload — re-committing the Office book of a
 * month whose figures were announced restates a published number, which his 2026-09-07 rule
 * forbids. A period that is already published therefore drops to `worth-knowing`: the spread still
 * disagrees with the rule, but the fix is ruled out, so it is not a decision waiting on him.
 *
 * The age is measured from the FIRST base move after the commit — the instant the spread actually
 * went stale — not from the commit itself, which was correct when it was written.
 */
export function officeAllocationDriftItems(
  reports: readonly OfficeAllocationDriftReport[],
  publishedPeriods: readonly string[],
  now: Date,
): NeedsYouItem[] {
  const items: NeedsYouItem[] = [];
  for (const report of reports) {
    if (!report.drifted) continue;
    const published = publishedPeriods.includes(report.period);
    // Oldest first, so the earliest move after the commit is the age — `baseTouchedAfterCommit` is
    // sorted newest first by its producer, and reading [0] would report the freshest move as the
    // moment it went stale.
    const causes = [...report.baseTouchedAfterCommit].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    const wentStaleAt = causes[0]?.updatedAt ?? null;

    for (const line of report.lines) {
      const moved = Math.round(line.unitsThatWouldMove);
      if (moved <= 0) continue;
      const areas = line.areas.length;
      // 🔴 A MONTH THE READ-TIME RESPREAD COVERS IS NOT HIS TO ACT ON, AND IS STILL REPORTED.
      // From the January 2026 closing on CNS the closing recomputes the spread on every read
      // (closing-office-respread.ts), so this difference lives in the STORED rows only — no closing
      // figure, tab or workbook is wrong, and re-committing the Office book would fix nothing that
      // is broken. It stays on the board because this board may never under-report: the stored rows
      // are what a re-upload, a re-map or any reader of the raw table meets. Same treatment as a
      // published month — worth-knowing, not yours.
      const respread = isOfficeRespreadPair(line.lineCode, report.period);

      const note: string[] = [];
      if (causes.length > 0) {
        // Names, never codes — and spelled out rather than cut off at an ellipsis.
        const names = causes.map((cause) => cause.distributorName);
        note.push(
          `${names.join(", ")} ${plural(names.length, "was", "were")} written after the Office book `
          + "was committed, which moved the value base the spread was frozen against.",
        );
      } else {
        note.push(
          "No distributor book was written after the Office commit, so the move came from the "
          + "customer map rather than an upload.",
        );
      }
      note.push(
        "Both sides hold the same units for the line, so the published-closing drift check reads "
        + "clean through this.",
      );
      if (respread) {
        note.push(
          `The closing already respreads ${report.period}'s Office units on today's shares, so every `
          + "closing figure, tab and workbook is right and this difference is in the stored rows "
          + "only — here to be known, not acted on.",
        );
      }
      if (published) {
        note.push(
          `${report.period} is published, so re-committing its Office book would restate an `
          + "announced figure — this row is here to be known, not acted on.",
        );
      }
      note.push("scripts/check-office-allocation-drift.ts answers the same question for any other month.");

      items.push({
        key: `office-allocation-drift:${report.period}:${line.lineCode}`,
        sourceId: "office-allocation-drift",
        kind: "flag",
        lane: published || respread ? "worth-knowing" : "yours",
        label:
          `${line.lineCode} ${report.period}: ${moved.toLocaleString("en-US")} of `
          + `${Math.round(line.officeUnits).toLocaleString("en-US")} Office units `
          + `(${line.percentOfOfficeUnits.toFixed(2)}%) sit in a different area from the one the rule `
          + `gives them today`,
        // Areas IS a count — of the places holding a difference, the same meaning the published
        // closing drift row gives it.
        count: areas > 0 ? areas : null,
        people: [],
        href: needsYouDestinations["office-allocation-drift"].href,
        externalUrl: null,
        oldestAt: wentStaleAt,
        ageDays: ageDaysSince(wentStaleAt, now),
        // No upstream SLA exists for this, exactly as for the published-closing drift row.
        overdue: false,
        note: note.join(" "),
      });
    }
  }
  return items;
}
