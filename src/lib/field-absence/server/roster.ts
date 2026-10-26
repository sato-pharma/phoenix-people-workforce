/**
 * Field Absence Calendar — who was on a field seat, and on which days.
 *
 * 🔒 THE EU ORGANOGRAM IS THE DISTRIBUTION TRUTH (owner, 2026-10-12, `.claude/rules/org.md`). The
 * seat — its tier, line, area and region — comes from `au_v_org_tree`, which carries no date because
 * none of those properties moves; WHO sat in it, and WHEN, comes from `au_v_seat_occupancy_all`, the
 * dated history. Reading today's occupant for a past month would judge the wrong person, which is the
 * misattribution `closing-performance-review.ts` records.
 *
 * Leavers are read too (`includeInactive`): a rep who resigned on the 20th was still on his seat for
 * the first nineteen days, and those are his to account for. His last working day is the employee
 * record's, which the resignation workflow writes (every field resignation in October 2026 carried
 * the same day on both). Someone who declined the offer never started and is left out. Head Office
 * holds no seat, so it never appears. Vacant seats hold no person and list nobody.
 */

import { tidyAllCapitalsName } from "@/lib/employees/display-name";
import { getEmployeeDirectoryRows, isActiveLifecycleStatus } from "@/lib/employees/employee-directory";
import { canonicalHrIdForDisplay } from "@/lib/hr-id";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import type { FieldAbsenceScopeSeat } from "../access";
import {
  addDays,
  fieldAbsenceNeverStarted,
  isFieldAbsenceTier,
  isIsoDay,
  spanCovers,
  type FieldAbsencePerson,
  type FieldAbsenceSeatSpan,
} from "../rules";

type SeatRow = {
  seat_id: string | null;
  parent_seat_id: string | null;
  seat_tier: string | null;
  occupant_hr_id: string | null;
  line_code: string | null;
  line_name: string | null;
  area_name: string | null;
  region_name: string | null;
};

type OccupancyRow = {
  seat_id: string | null;
  occupant_hr_id: string | null;
  occupant_canonical_hr_id: string | null;
  effective_from: string | null;
  effective_to: string | null;
};

export type FieldAbsenceSeat = FieldAbsenceScopeSeat & {
  seatId: string;
  parentSeatId: string | null;
  lineName: string | null;
  areaName: string | null;
  regionName: string | null;
};

const text = (value: unknown): string | null => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : null;
};

/** The whole seat tree. ~140 rows; an unbounded read stops at 1,000 with no error, so that is refused. */
export async function loadFieldAbsenceSeats(): Promise<FieldAbsenceSeat[]> {
  const { data, error } = await getSupabaseAdmin()
    .from("au_v_org_tree")
    .select("seat_id, parent_seat_id, seat_tier, occupant_hr_id, line_code, line_name, area_name, region_name");
  if (error) throw new Error(`Could not read the organogram seats: ${error.message}`);
  const rows = (data ?? []) as SeatRow[];
  if (rows.length >= 1000) throw new Error(`au_v_org_tree returned ${rows.length} rows, at PostgREST's cap.`);
  return rows.flatMap((row) => {
    const seatId = text(row.seat_id);
    const tier = text(row.seat_tier);
    if (!seatId || !tier) return [];
    return [
      {
        areaName: text(row.area_name),
        lineCode: text(row.line_code),
        lineName: text(row.line_name),
        occupantHrId: text(row.occupant_hr_id),
        parentSeatId: text(row.parent_seat_id),
        regionName: text(row.region_name),
        seatId,
        tier,
      },
    ];
  });
}

async function loadOccupancy(start: string, end: string): Promise<OccupancyRow[]> {
  const { data, error } = await getSupabaseAdmin()
    .from("au_v_seat_occupancy_all")
    .select("seat_id, occupant_hr_id, occupant_canonical_hr_id, effective_from, effective_to")
    .eq("node_type", "person")
    // Overlapping the window, half-open: a stretch ending ON the first day did not cover it.
    .lte("effective_from", end)
    .or(`effective_to.is.null,effective_to.gt.${start}`);
  if (error) throw new Error(`Could not read the seat history: ${error.message}`);
  const rows = (data ?? []) as OccupancyRow[];
  if (rows.length >= 1000) throw new Error(`au_v_seat_occupancy_all returned ${rows.length} rows, at PostgREST's cap.`);
  return rows;
}

function occupantKey(row: OccupancyRow): string | null {
  return canonicalHrIdForDisplay(row.occupant_canonical_hr_id ?? row.occupant_hr_id);
}

/**
 * Every person who held a field seat on any day of [start, end], with each dated stretch.
 * `seats` is passed in because the service reads it once for the scope as well.
 */
export async function loadFieldAbsenceRoster(input: {
  seats: readonly FieldAbsenceSeat[];
  start: string;
  end: string;
  today: string;
}): Promise<FieldAbsencePerson[]> {
  const [occupancy, directory] = await Promise.all([
    loadOccupancy(input.start, input.end),
    getEmployeeDirectoryRows({ includeInactive: true }),
  ]);

  const seatById = new Map(input.seats.map((seat) => [seat.seatId, seat]));
  const employeeByKey = new Map(directory.map((employee) => [canonicalHrIdForDisplay(employee.hrId), employee]));
  const nameOf = (key: string | null) => {
    if (!key) return null;
    const employee = employeeByKey.get(key);
    // "SAHAR EL GALLAD" and "Aya Mamdouh sdeek Ali" are stored that way; the calendar shows title case.
    return employee ? tidyAllCapitalsName(employee.displayName || employee.fullName) : null;
  };

  const occupancyBySeat = new Map<string, OccupancyRow[]>();
  for (const row of occupancy) {
    const seatId = text(row.seat_id);
    if (!seatId) continue;
    occupancyBySeat.set(seatId, [...(occupancyBySeat.get(seatId) ?? []), row]);
  }

  /** Whoever held the nearest OCCUPIED seat above `seatId` on `day` — a vacant DM seat passes upward. */
  const managerOn = (seatId: string, day: string): string | null => {
    let parent = seatById.get(seatId)?.parentSeatId ?? null;
    for (let hops = 0; parent && hops < 10; hops += 1) {
      const holder = (occupancyBySeat.get(parent) ?? []).find((row) =>
        isIsoDay(row.effective_from) && spanCovers({ from: row.effective_from, to: isIsoDay(row.effective_to) ? row.effective_to : null }, day),
      );
      const name = holder ? nameOf(occupantKey(holder)) : null;
      if (name) return name;
      parent = seatById.get(parent)?.parentSeatId ?? null;
    }
    return null;
  };

  const people = new Map<string, FieldAbsencePerson>();
  for (const row of occupancy) {
    const seatId = text(row.seat_id);
    const seat = seatId ? seatById.get(seatId) : undefined;
    const key = occupantKey(row);
    if (!seat || !key || !isFieldAbsenceTier(seat.tier) || !isIsoDay(row.effective_from)) continue;
    const to = isIsoDay(row.effective_to) ? row.effective_to : null;
    // The manager as he stood at the end of this stretch inside the window, or today if sooner.
    const lastDay = [input.end, input.today, to ? addDays(to, -1) : input.end].sort()[0];
    const span: FieldAbsenceSeatSpan = {
      areaName: seat.areaName,
      from: row.effective_from,
      lineCode: seat.lineCode,
      lineName: seat.lineName,
      managerName: managerOn(seat.seatId, lastDay < row.effective_from ? row.effective_from : lastDay),
      regionName: seat.regionName,
      seatId: seat.seatId,
      tier: seat.tier,
      to,
    };
    const employee = employeeByKey.get(key);
    if (employee && fieldAbsenceNeverStarted(employee.employmentStatus)) continue;
    const person = people.get(key) ?? {
      // A seat holder missing from the directory is taken as employed: nothing says otherwise.
      employmentActive: employee ? isActiveLifecycleStatus(employee.employmentStatus) : true,
      hireDate: employee?.hireDate ?? null,
      key,
      lastWorkingDate: employee?.lastWorkingDate ?? null,
      // Names, never codes: a seat holder missing from the directory is said as exactly that.
      name: nameOf(key) ?? "Name not on the employee record",
      spans: [],
    };
    person.spans.push(span);
    people.set(key, person);
  }
  return [...people.values()];
}
