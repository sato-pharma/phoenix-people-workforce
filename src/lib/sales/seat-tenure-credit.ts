import { canonicalHrIdKey } from "@/lib/hr-id";
import type { AchievementRow } from "@/lib/sales/monthly-targets";
import { coversAsOf, periodEndDate } from "@/lib/sales/closing-performance-review";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// A SEAT'S PAST SALES RANK THE PERSON WHO MADE THEM (owner, 26 Oct 2026, multiple-choice answer:
// "Person who made them"). A rep is ranked only on the months he held the seat: an October hire
// leaves a July–September board, and a departed rep's months stay with that rep.
//
// The engine (`au.f_seat_occupant_asof`) answers a different question on purpose — "who holds this
// area's sales now" — so a seat occupied TODAY credits every past month to today's holder. That is
// right for the closing, wrong for a ranking. This module changes nothing in the engine and no
// number: it only re-labels WHICH PERSON a rep-seat month is credited to, for the rep leaderboards
// that ask for it. A month nobody held goes to nobody, and so lands in the page's "not attributed to
// a rep" figure — every total stays exactly what the closing published.
//
// WHO HELD IT: the occupancy row in force on the month's last day (half-open, the same `coversAsOf`
// and `periodEndDate` the performance review resolves its managers with; the latest start wins,
// as in arm 2 of `au.f_seat_occupant_asof`). AND HE MUST HAVE BEEN EMPLOYED THAT DAY — seating ran
// ahead of the hire date until 2026-11-03 (Jonia Wageh seated on Pedia UE1 on 20 Sep, hired 1 Oct),
// and closed spans from then still do; the owner's rule is that occupancy starts at the hiring date
// in the master (`au-occupancy-hiring-date-from-master`). A missing hire date never blocks a credit;
// a last working day before the month end does.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export type SeatOccupancyStretch = {
  seatId: string;
  occupantHrId: string;
  effectiveFrom: string;
  effectiveTo: string | null;
};

export type EmploymentDates = { hireDate: string | null; lastWorkingDate: string | null };

export type SeatTenure = {
  stretches: readonly SeatOccupancyStretch[];
  /** Keyed by `canonicalHrIdKey`. */
  employment: ReadonlyMap<string, EmploymentDates>;
};

function dateOnly(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null;
}

function employedOn(tenure: SeatTenure, hrId: string, asOf: string): boolean {
  const key = canonicalHrIdKey(hrId);
  const employment = key ? tenure.employment.get(key) : undefined;
  if (employment?.hireDate && employment.hireDate > asOf) return false;
  if (employment?.lastWorkingDate && employment.lastWorkingDate < asOf) return false;
  return true;
}

/**
 * The person who held `seatId` on `asOf` and was employed that day, or null. When two stretches
 * overlap (a hand-over), the latest start wins among the people employed that day — so a successor
 * seated before his hire date never pushes out the rep still working the seat. Pure.
 */
export function seatHolderOn(tenure: SeatTenure, seatId: string, asOf: string): string | null {
  const stretch = tenure.stretches
    .filter(
      (row) =>
        row.seatId === seatId &&
        coversAsOf(row.effectiveFrom, row.effectiveTo, asOf) &&
        employedOn(tenure, row.occupantHrId, asOf),
    )
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
  return stretch?.occupantHrId ?? null;
}

/** Which seat and which person on a row a board credits — the rep's, or the district manager's. */
type SeatGrain = { seat: "repSeatId" | "dmSeatId"; holder: "repHrId" | "dmHrId" };

function creditByTenure(rows: readonly AchievementRow[], tenure: SeatTenure, grain: SeatGrain): AchievementRow[] {
  const cache = new Map<string, string | null>();
  return rows.map((row) => {
    const seatId = row[grain.seat];
    if (!seatId) return row;
    const asOf = periodEndDate(row.period);
    if (!asOf) return row;
    const cacheKey = `${seatId}|${asOf}`;
    let holder = cache.get(cacheKey);
    if (holder === undefined) {
      holder = seatHolderOn(tenure, seatId, asOf);
      cache.set(cacheKey, holder);
    }
    const current = row[grain.holder];
    if (holder && current && canonicalHrIdKey(holder) === canonicalHrIdKey(current)) return row;
    if (!holder && !current) return row;
    return { ...row, [grain.holder]: holder };
  });
}

/**
 * The rows with each rep-seat month credited to the person who held the seat that month. Values,
 * targets and every other field are untouched; a row with no rep seat is returned as it is. Feed the
 * result to the rep LEADERBOARD only — never to a headline total. Pure.
 */
export function creditRepRowsByTenure(rows: readonly AchievementRow[], tenure: SeatTenure): AchievementRow[] {
  return creditByTenure(rows, tenure, { seat: "repSeatId", holder: "repHrId" });
}

/**
 * The same, one level up: each district-manager-seat month credited to the manager who held that
 * seat then (owner, 26 Oct 2026 — the DSMs boards follow the rep rule). Only `dmHrId` changes; a
 * month nobody held leaves the row with no manager, so it falls to "not attributed". Pure.
 */
export function creditDmRowsByTenure(rows: readonly AchievementRow[], tenure: SeatTenure): AchievementRow[] {
  return creditByTenure(rows, tenure, { seat: "dmSeatId", holder: "dmHrId" });
}

/** Every person-seat stretch and every employee's hire and last working dates, leavers included. */
export async function loadSeatTenure(): Promise<SeatTenure> {
  const supabase = getSupabaseAdmin();
  const [occupancy, employees] = await Promise.all([
    fetchAllRows<Record<string, unknown>>(
      () =>
        supabase
          .from("au_v_seat_occupancy_all")
          .select("seat_id, occupant_hr_id, effective_from, effective_to")
          .eq("node_type", "person")
          // effective_from alone is not unique, so pages could skip or repeat a row past 1,000.
          .order("seat_id", { ascending: true })
          .order("occupant_hr_id", { ascending: true }),
      "effective_from",
    ),
    fetchAllRows<Record<string, unknown>>(
      () => supabase.from("employees").select("hr_id, hire_date, last_working_date"),
      "hr_id",
    ),
  ]);
  const stretches: SeatOccupancyStretch[] = [];
  for (const row of occupancy) {
    const seatId = String(row.seat_id ?? "").trim();
    const occupantHrId = String(row.occupant_hr_id ?? "").trim();
    const effectiveFrom = dateOnly(row.effective_from);
    if (!seatId || !occupantHrId || !effectiveFrom) continue;
    stretches.push({ seatId, occupantHrId, effectiveFrom, effectiveTo: dateOnly(row.effective_to) });
  }
  const employment = new Map<string, EmploymentDates>();
  for (const row of employees) {
    const key = canonicalHrIdKey(String(row.hr_id ?? ""));
    if (!key) continue;
    employment.set(key, { hireDate: dateOnly(row.hire_date), lastWorkingDate: dateOnly(row.last_working_date) });
  }
  return { stretches, employment };
}
