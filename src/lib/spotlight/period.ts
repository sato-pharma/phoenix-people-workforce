// Spotlight — which months a window covers, and whether it is allowed to leave the building.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 🔒 COMPLETED PERIODS ONLY. Owner's decision when the module was specified.
//
// A spotlight is a published number. The closing golden rule already forbids releasing a closing
// during the month it covers, for a reason that applies here word for word: the sheet goes to the
// whole company and a sent picture cannot be recalled. A half-month award is worse than a wrong one,
// because nothing on the page tells the reader it is half a month.
//
// So the gate is on the WINDOW, not the file: a month becomes selectable on the first day of the
// next month, Africa/Cairo; a quarter on the first day after its last month; a half likewise. The
// refusal names the date it becomes available, because "not allowed" without a date reads as a bug.
//
// Everything here is pure — "today" is passed in — so every boundary is testable without a clock.
// The one impure entry point is `cairoToday()`, and it exists precisely so the rest never needs a
// Date. Africa/Cairo, never UTC: at 23:00 Cairo on the 31st, UTC is still the 31st at 21:00, but at
// 01:00 Cairo on the 1st, UTC is the PREVIOUS day — so a UTC clock would keep refusing the month
// for its first two hours and nobody would understand why.

import { currentCairoDateParts } from "@/lib/i18n/format";

import type { PeriodKey, SpotlightWindow, SpotlightWindowKind } from "./types";

const PERIOD_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;
const QUARTER_PATTERN = /^(\d{4})-Q([1-4])$/;
const SEMESTER_PATTERN = /^(\d{4})-S([12])$/;
const YEAR_PATTERN = /^(\d{4})$/;

/** The earliest month the sales engine holds. Below this a window is empty, not merely thin. */
export const SPOTLIGHT_FLOOR: PeriodKey = "2026-01";

export function isPeriodKey(value: unknown): value is PeriodKey {
  return typeof value === "string" && PERIOD_PATTERN.test(value);
}

/** `{ year, month }` in Africa/Cairo. The only impure function in this file. */
export function cairoToday(): { year: number; month: number; day: number } {
  const parts = currentCairoDateParts();
  return { year: parts.year, month: parts.month, day: parts.day };
}

export function isValidWindow(window: SpotlightWindow | null | undefined): window is SpotlightWindow {
  if (!window || typeof window.key !== "string") return false;
  if (window.kind === "month") return PERIOD_PATTERN.test(window.key);
  if (window.kind === "quarter") return QUARTER_PATTERN.test(window.key);
  if (window.kind === "semester") return SEMESTER_PATTERN.test(window.key);
  if (window.kind === "year") return YEAR_PATTERN.test(window.key);
  return false;
}

/** Every month the window covers, ascending. Empty for a malformed window. */
export function windowPeriods(window: SpotlightWindow): PeriodKey[] {
  if (!isValidWindow(window)) return [];
  if (window.kind === "month") return [window.key];

  const build = (year: number, firstMonth: number, count: number) =>
    Array.from({ length: count }, (_, index) => {
      const month = firstMonth + index;
      return `${year}-${String(month).padStart(2, "0")}`;
    });

  if (window.kind === "year") return build(Number(window.key), 1, 12);
  if (window.kind === "quarter") {
    const [, yearText, quarterText] = QUARTER_PATTERN.exec(window.key)!;
    return build(Number(yearText), (Number(quarterText) - 1) * 3 + 1, 3);
  }
  const [, yearText, halfText] = SEMESTER_PATTERN.exec(window.key)!;
  return build(Number(yearText), halfText === "2" ? 7 : 1, 6);
}

/** "August 2026" / "Q3 2026" / "Semester 2 2026" / "2026". */
export function windowLabel(window: SpotlightWindow): string {
  if (!isValidWindow(window)) return "";
  if (window.kind === "year") return window.key;
  if (window.kind === "quarter") return `${window.key.slice(5)} ${window.key.slice(0, 4)}`;
  // "Semester 2 2026", never "H2 2026" (owner, 2026-09-23: "call it semester 1 and 2 and s1 and s2
  // not h1 and h2"). The KEY keeps its `2026-S2` form — only the words a person reads changed.
  // Mirrored in src/components/spotlight/spotlight-workspace.tsx, which carries its own copy for
  // the client bundle; the two must say the same thing.
  if (window.kind === "semester") return `Semester ${window.key.slice(6)} ${window.key.slice(0, 4)}`;
  const [, year, month] = PERIOD_PATTERN.exec(window.key)!;
  const name = new Date(Date.UTC(Number(year), Number(month) - 1, 1)).toLocaleDateString("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  return name;
}

/**
 * The first Cairo day on which the window may be exported — the day after its last month ends.
 *
 * Returned as `{ year, month, day: 1 }` because that is always the first of the following month:
 * a window is done the instant its final month is done, and no window ends mid-month.
 */
export function availableFrom(window: SpotlightWindow): { year: number; month: number; day: 1 } | null {
  const periods = windowPeriods(window);
  const last = periods.at(-1);
  if (!last) return null;
  const year = Number(last.slice(0, 4));
  const month = Number(last.slice(5, 7));
  return month === 12 ? { year: year + 1, month: 1, day: 1 } : { year, month: month + 1, day: 1 };
}

export type WindowGate =
  | { allowed: true; periods: PeriodKey[]; label: string }
  | { allowed: false; reason: string };

/**
 * Whether this window may be spotlighted as of `today`.
 *
 * REFUSES rather than silently clamping. A window quietly shortened to the months that have
 * finished would print "Q3 2026" over two months of data, which is the exact failure the gate
 * exists to prevent — and it would look completely normal.
 */
export function gateWindow(
  window: SpotlightWindow,
  today: { year: number; month: number } = cairoToday(),
  /**
   * Whether a month's closing is published. A finished month is not yet a published one: from the
   * first of November to the day October publishes, October passes every test above (owner,
   * 2026-11-04). Passed in rather than read, so this file stays pure and client-safe.
   */
  isPublished?: (period: PeriodKey) => boolean,
): WindowGate {
  if (!isValidWindow(window)) {
    return { allowed: false, reason: "That is not a month, quarter or half I can read." };
  }
  const periods = windowPeriods(window);
  const label = windowLabel(window);

  if (periods[0]! < SPOTLIGHT_FLOOR) {
    return {
      allowed: false,
      reason: `${label} starts before ${SPOTLIGHT_FLOOR}, which is the earliest month the sales engine holds.`,
    };
  }

  const from = availableFrom(window)!;
  const nowKey = today.year * 12 + today.month;
  const fromKey = from.year * 12 + from.month;
  if (nowKey < fromKey) {
    const when = new Date(Date.UTC(from.year, from.month - 1, 1)).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    });
    return {
      allowed: false,
      reason:
        `${label} has not finished yet. A spotlight is a published number, so it is available`
        + ` from ${when}, Cairo time — the day after the window closes.`,
    };
  }

  if (isPublished && !periods.every(isPublished)) {
    return {
      allowed: false,
      reason: `${label} holds a month whose closing is not published yet. A spotlight is a published number.`,
    };
  }

  return { allowed: true, periods, label };
}

/** Every window of a kind that is already complete, newest first. What the picker offers. */
export function selectableWindows(
  kind: SpotlightWindowKind,
  today: { year: number; month: number } = cairoToday(),
  count = 18,
  isPublished?: (period: PeriodKey) => boolean,
): SpotlightWindow[] {
  const out: SpotlightWindow[] = [];
  const step = kind === "month" ? 1 : kind === "quarter" ? 3 : kind === "semester" ? 6 : 12;

  // Walk back from the month before the current one — the newest month that can possibly be
  // complete — and keep the windows whose own gate passes. Deriving the list from the SAME gate
  // the export uses is what stops the picker offering something the export then refuses.
  for (let back = 1; back <= count * step + step && out.length < count; back += 1) {
    const absolute = today.year * 12 + (today.month - 1) - back;
    const year = Math.floor(absolute / 12);
    const month = (absolute % 12) + 1;
    const period = `${year}-${String(month).padStart(2, "0")}`;
    if (period < SPOTLIGHT_FLOOR) break;

    let window: SpotlightWindow;
    if (kind === "month") window = { kind, key: period };
    else if (kind === "quarter") window = { kind, key: `${year}-Q${Math.floor((month - 1) / 3) + 1}` };
    else if (kind === "semester") window = { kind, key: `${year}-S${month <= 6 ? 1 : 2}` };
    else window = { kind, key: String(year) };

    if (out.some((existing) => existing.key === window.key)) continue;
    if (gateWindow(window, today, isPublished).allowed) out.push(window);
  }
  return out;
}

/**
 * Why a spotlight cannot be run right now, in words, or null when it can.
 *
 * 🔴 A DISABLED BUTTON AND A BROKEN BUTTON LOOK THE SAME. This exists because they were the same
 * thing: the workspace disabled "Show me" whenever no period was selected and said nothing about
 * it, and the first person to pick Year — where the list is legitimately empty until January 2027 —
 * reported the button as doing nothing. He was right. It did nothing, for a good reason nobody
 * could see.
 *
 * Pure and here rather than in the component, so the wording is testable and so the rule that
 * decides it lives beside the gate that causes it.
 */
export function blockedReason(kind: SpotlightWindowKind, hasSelectableWindow: boolean): string | null {
  if (hasSelectableWindow) return null;
  if (kind === "year") {
    return "No calendar year has finished within the sales data, which starts in January 2026."
      + " The first will be 2026, from 1 January 2027. Choose Month, Quarter or Half year.";
  }
  const noun = kind === "semester" ? "half year" : kind;
  return `No ${noun} has finished yet, so there is nothing to spotlight. Choose a different period type.`;
}
