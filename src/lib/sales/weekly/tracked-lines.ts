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
  "Head Office is not tracked weekly and is excluded; select it in the Line filter to see it.";

/**
 * Drop the rows of lines that are not tracked weekly.
 *
 * `includeUntracked` is the deliberate escape hatch: when the viewer names a line in the Line
 * filter, that request wins — the rule is a DEFAULT SCOPE, not a deletion, and no data becomes
 * unreachable. The owner's standing rule is that an export must match the screen, so both sides
 * call this and both carry WEEKLY_TRACKED_SCOPE_NOTE.
 */
export function applyWeeklyTrackedLineScope<T extends { officialLine: string | null }>(
  rows: T[],
  options?: { includeUntracked?: boolean },
): T[] {
  if (options?.includeUntracked) return rows;
  return rows.filter((row) => isWeeklyTrackedLine(row.officialLine));
}
