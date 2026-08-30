import { usesOrganogramRegions } from "@/lib/sales/closing-organogram-regions";
import { resolveTargetLineCode } from "@/lib/sales/monthly-targets";

// ─────────────────────────────────────────────────────────────────────────────
// GOLDEN RULE — the lines Weekly Sales is actually about. Locked by the owner 2026-08-26.
//
// The owner tracks weekly sales for THREE lines: CNS, Anti Infective and Pedia. Head Office —
// Lacto Basic 1 & 2, Satoslim, Royanoxicam — is NOT tracked weekly. Its branches carry no area, no
// region and no manager, and THAT IS CORRECT: there is nothing to map, and a session that "fixes"
// it is fixing something that was never broken.
//
// This is not a rounding detail. Measured in production 2026-08-26, Head Office is EGP 297,229,509 —
// 78% of everything in the weekly tables. Any unscoped weekly number is therefore dominated by a
// line the owner does not follow, which is exactly how an audit that day came to report "80.8% of
// weekly money reaches no manager". Scoped to the three tracked lines the same figure is 12.8%.
// The unscoped number was alarming and meaningless; the scoped one is small, true and actionable.
//
// WHY THIS DELEGATES INSTEAD OF LISTING THE THREE LINES AGAIN
// The same three lines are already declared once, in closing-organogram-regions.ts, as the field-
// sales lines whose closing follows the organogram. Two hand-maintained copies of one list drift,
// and the copy nobody remembers is the one that silently goes wrong. So there is one list, and the
// coupling is deliberate: a NEW field-sales line added there becomes tracked weekly too, which is
// the behaviour you want — and that file already carries "ask the owner first, every time" on
// changing it, so the gate is real rather than implied.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Does the owner track this line in Weekly Sales? Takes the official line NAME as it appears on a
 * weekly row ("Anti Infective", "Head Office"), not a line code.
 *
 * An unrecognised or blank line is NOT tracked. That is the safe direction: a line nobody can name
 * must not silently join the totals the owner reads as his field-force performance.
 */
export function isWeeklyTrackedLine(officialLine: string | null | undefined): boolean {
  return usesOrganogramRegions(resolveTargetLineCode(String(officialLine ?? "").trim()));
}

/** Human-readable scope, for the one line of text that must appear wherever a scoped total is shown. */
export const WEEKLY_TRACKED_LINES_LABEL = "CNS, Anti Infective and Pedia";

export const WEEKLY_TRACKED_SCOPE_NOTE =
  `Weekly Sales covers the lines tracked weekly — ${WEEKLY_TRACKED_LINES_LABEL}. ` +
  "Head Office is not used in weekly or monthly sales and is excluded.";

/**
 * The Line filter's option list: tracked lines only.
 *
 * Until 2026-08-30 Head Office stayed selectable on purpose, so that the rule was a default scope
 * rather than a deletion. The owner closed that: *"remove head office from the line filter"*, on the
 * back of *"The head office will not be used in the weekly sales or monthly sales."* An option
 * nobody may act on is worse than no option — it invites the one selection the rule forbids, and the
 * book that comes back is indistinguishable from a real one.
 *
 * Head Office was measured at **90.2% of weekly VALUE** on 2026-08-30 (EGP 37,568,199 against the
 * three tracked lines' 4,089,756 combined), so a stray selection does not merely skew a total — it
 * becomes the total.
 *
 * This trims the OPTIONS only. `applyWeeklyTrackedLineScope`'s `includeUntracked` hatch still
 * answers an explicit `?line=Head Office`, so nothing became unreachable to a caller that names it;
 * the UI simply no longer offers it, and no screen can reach it by clicking.
 */
export function weeklyTrackedLineOptions(lines: string[]): string[] {
  return lines.filter((line) => isWeeklyTrackedLine(line));
}

/**
 * Drop the rows of lines that are not tracked weekly.
 *
 * `includeUntracked` is the escape hatch: when the CALLER names a line, that request wins, so no
 * data becomes unreachable to something that asks for it by name. Since 2026-08-30 the UI can no
 * longer be that caller for Head Office — `weeklyTrackedLineOptions` keeps it out of the dropdown —
 * so in practice this now fires only for an explicit `?line=` on the API. Kept deliberately: the
 * weekly import and any admin check of a Head Office upload still need a way to see those rows, and
 * a rule about REPORTING should not make data unreadable. The owner's standing rule is that an
 * export must match the screen, so both sides call this and both carry WEEKLY_TRACKED_SCOPE_NOTE.
 */
export function applyWeeklyTrackedLineScope<T extends { officialLine: string | null }>(
  rows: T[],
  options?: { includeUntracked?: boolean },
): T[] {
  if (options?.includeUntracked) return rows;
  return rows.filter((row) => isWeeklyTrackedLine(row.officialLine));
}
