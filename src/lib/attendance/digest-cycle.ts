// Digest cycle + settlement-week tiling for the weekly-digest model.
//
// Owner-confirmed (2026-07-03):
//   • The payroll/fingerprint month runs day-24 -> day-24 (anchor configurable,
//     attendance_digest_settings.cycle_anchor_day, default 24).
//   • Each cycle is tiled into EXACTLY four settlement weeks. Weeks 1-3 are seven
//     days; week 4 absorbs the remaining days up to the cycle end, so all four
//     digests land and settle before the cut-off.
//
// Pure calendar arithmetic (UTC, no timezone) so it is deterministic and testable.

export type DigestCycle = {
  /** 'YYYY-MM' of the month the cycle ends in (the "July cycle" ends 23 Jul). */
  cycleKey: string;
  /** Inclusive ISO start date (the anchor day of the previous month). */
  startIso: string;
  /** Inclusive ISO end date (the day before the next anchor). */
  endIso: string;
  anchorDay: number;
};

export type SettlementWeek = {
  /** 1..4 */
  index: number;
  startIso: string;
  endIso: string;
};

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function toUtcDate(iso: string): Date {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function toIso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  const date = toUtcDate(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return toIso(date);
}

/** Whole days from `startIso` to `endIso` inclusive (>= 1 for start <= end). */
export function inclusiveDayCount(startIso: string, endIso: string): number {
  const ms = toUtcDate(endIso).getTime() - toUtcDate(startIso).getTime();
  return Math.floor(ms / 86_400_000) + 1;
}

/**
 * The day-24 -> day-24 cycle that contains `dateIso`.
 * A date on/after the anchor day belongs to the cycle starting that month;
 * a date before it belongs to the cycle that started the previous month.
 */
export function resolveDigestCycle(dateIso: string, anchorDay = 24): DigestCycle {
  const [year, month, day] = dateIso.split("-").map(Number);

  let startYear = year;
  let startMonth = month;
  if (day < anchorDay) {
    startMonth = month - 1;
    if (startMonth < 1) {
      startMonth = 12;
      startYear = year - 1;
    }
  }

  const startIso = `${startYear}-${pad2(startMonth)}-${pad2(anchorDay)}`;

  let endMonthYear = startYear;
  let endMonth = startMonth + 1;
  if (endMonth > 12) {
    endMonth = 1;
    endMonthYear += 1;
  }
  const nextAnchorIso = `${endMonthYear}-${pad2(endMonth)}-${pad2(anchorDay)}`;
  const endIso = addDays(nextAnchorIso, -1);

  return {
    cycleKey: `${endMonthYear}-${pad2(endMonth)}`,
    startIso,
    endIso,
    anchorDay,
  };
}

/**
 * Tile a cycle into exactly four settlement weeks. Weeks 1-3 are seven days;
 * week 4 runs from day 22 of the cycle to the cycle end (absorbing the extras).
 */
export function tileSettlementWeeks(cycle: DigestCycle): SettlementWeek[] {
  const weeks: SettlementWeek[] = [];
  let weekStart = cycle.startIso;

  for (let index = 1; index <= 3; index += 1) {
    const weekEnd = addDays(weekStart, 6);
    // Never run a fixed week past the cycle end (defensive; real 24->24 cycles
    // are ~30 days so this clamp does not trigger in practice).
    const clampedEnd = weekEnd > cycle.endIso ? cycle.endIso : weekEnd;
    weeks.push({ index, startIso: weekStart, endIso: clampedEnd });
    weekStart = addDays(clampedEnd, 1);
    if (weekStart > cycle.endIso) break;
  }

  if (weeks.length < 4 && weekStart <= cycle.endIso) {
    weeks.push({ index: 4, startIso: weekStart, endIso: cycle.endIso });
  }

  return weeks;
}

/** The 1..4 settlement-week index that contains `dateIso`, or null if outside the cycle. */
export function settlementWeekForDate(dateIso: string, cycle: DigestCycle): number | null {
  if (dateIso < cycle.startIso || dateIso > cycle.endIso) return null;
  const week = tileSettlementWeeks(cycle).find(
    (candidate) => dateIso >= candidate.startIso && dateIso <= candidate.endIso,
  );
  return week ? week.index : null;
}
