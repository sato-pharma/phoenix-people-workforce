/**
 * ORGANOGRAM SEAT DRIFT — where an employee's own record disagrees with the seat they occupy.
 *
 * `public.au_v_employee_seat_drift` has carried this answer all along: it compares
 * `employees.area_id`, `employees.region_code` and `employees.manager_hr_id` against the seat each
 * active person holds in the EU organogram, which is the source of truth for every employee's
 * distribution (owner, 2026-10-12 — `docs/eu-organogram-is-the-distribution-truth.md`). What did
 * not exist was anything that READ it as an alarm. Its four callers all use it as a lookup table:
 * `src/lib/weekly-planning/planning-areas.ts`, the two CRM coverage loaders and
 * `src/lib/employee-360/brick-coverage.ts` take the seat columns and ignore the drift booleans
 * entirely.
 *
 * 🔴 WHAT THAT SILENCE COST, ON 2026-10-15. A new medical rep was hired into the Behira 1 rep seat
 * on 8 October and her `employees.area_id` was edited on 13 October to the id of Behira 2 — another
 * rep's area. The weekly and monthly plan has NO rep dropdown: it auto-assigns the rep from the
 * picked area, and `medicalRepOptionsForEmployee` takes that area from the EMPLOYEE record, letting
 * the seat fill only a blank. So she vanished from her own area, which then showed no rep at all,
 * and in the area she had been moved into she lost to the alphabetically earlier rep already there.
 * No warning fired — the "needs an assigned Medical Rep" amber only appears for an area that
 * already has one. This view had been flagging the exact mismatch since the 13th, and it took a
 * district manager noticing a missing name two days later. One row of production data fixed it; no
 * code was wrong.
 *
 * 🔴 NO SEAT AT ALL IS NOT DRIFT, AND THE VIEW IS RIGHT TO OMIT IT. Sixteen people sit in the
 * directory with no seat in the EU organogram — Admins, Finance, Human Resources, Marketing, QPPV,
 * R&D and SFE, the owner among them. The seat model is the FIELD FORCE. The view starts from the
 * seated and joins outward, so they never appear here; widening this read to "has no seat" would
 * put all sixteen of them on the board on every load, for ever.
 *
 * 🔴 AND `stale_marker` IS DELIBERATELY NOT A SELECTOR. It reports a leftover
 * `pending_manager_replacement_for_hr_id` on somebody whose parent seat is already occupied by
 * another person — a marker that was not cleared, not a disagreement between the record and the
 * seat. It is a different question with a different fix, and folding it in here would make a row
 * that says "the record and the seat disagree" when they do not.
 *
 * THE READ IS SMALL AND IT IS MEASURED. Against production (`ozucdzovmcqvepbozvqf`) on 2026-10-15:
 * the whole view is 97 seated actives, one pass, `Execution Time: 3.228 ms` with 0 drifted rows —
 * so the source declares no `cost` and joins the board's light lane. The three name lookups below
 * run ONLY when something has drifted, which on a healthy day is never.
 */

import { namesByHrId } from "@/lib/employees/names-by-hr-id";
import { orgSeatTitle } from "@/lib/org/seat-titles";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/** Which of the three facts the record and the seat disagree about. */
export type EmployeeSeatDriftFactKind = "area" | "region" | "manager";

/**
 * One disagreement, with both sides already resolved to NAMES.
 *
 * The resolution happens HERE rather than in the renderer because only this module holds the
 * lookups — `areas`, `au_v_regions` and the employee directory. A `null` on either side means that
 * side holds nothing at all, which is a real and different state from holding the wrong thing: four
 * of the six rows corrected on 2026-10-12 had NO area on file, and those reps were shown "We don't
 * have your area on file yet" rather than being quietly scoped somewhere wrong.
 */
export type EmployeeSeatDriftFact = {
  kind: EmployeeSeatDriftFactKind;
  /** What `employees` says, as a name. `null` when the record holds nothing. */
  employeeValue: string | null;
  /** What the seat says, as a name. `null` when the seat side could not be named. */
  seatValue: string | null;
};

export type EmployeeSeatDrift = {
  hrId: string;
  /** The person, as a person is called. */
  name: string;
  /**
   * The seat as a whole noun phrase — "the Behira 1 Medical Representative seat". A PHRASE rather
   * than a bare descriptor because the fallback has to read as English too: a tier the title map
   * has not met yet, on a seat with no area name, gives "the seat they hold", and a caller that
   * wrapped a bare descriptor in "the … seat" would print "the the seat they hold seat". Never a
   * seat code.
   */
  seat: string;
  /** At least one, else this person would not be here. */
  facts: readonly EmployeeSeatDriftFact[];
};

type DriftRow = {
  hr_id?: string | null;
  full_name?: string | null;
  seat_tier?: string | null;
  seat_area_id?: number | string | null;
  employee_area_id?: number | string | null;
  seat_area_name?: string | null;
  seat_region_code?: string | null;
  employee_region_code?: string | null;
  seat_manager_hr_id?: string | null;
  employee_manager_hr_id?: string | null;
  area_id_drifted?: boolean | null;
  region_code_drifted?: boolean | null;
  manager_drifted?: boolean | null;
};

const DRIFT_COLUMNS =
  "hr_id,full_name,seat_tier,seat_area_id,employee_area_id,seat_area_name,seat_region_code,"
  + "employee_region_code,seat_manager_hr_id,employee_manager_hr_id,"
  + "area_id_drifted,region_code_drifted,manager_drifted";

function trimmed(value: string | null | undefined): string | null {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : null;
}

/** The seat, said the way the organogram says it: its area and the job title of its tier. */
function describeSeat(row: DriftRow): string {
  const parts = [trimmed(row.seat_area_name), orgSeatTitle(row.seat_tier)].filter(
    (part): part is string => Boolean(part),
  );
  // Never the raw `seat_id`. A tier the title map has not met yet, on a seat with no area name,
  // leaves nothing a person could read — so it says so instead of printing a code.
  return parts.length > 0 ? `the ${parts.join(" ")} seat` : "the seat they hold";
}

/**
 * Every active person whose record disagrees with their seat, with both sides named.
 *
 * 🔴 IT THROWS ON A FAILED READ, and that is the whole contract with the Needs You board: an empty
 * array means "every seated person's record matches their seat", which is the one thing a failed
 * read must never be able to say. `service.ts` turns the rejection into the amber "could not be
 * read" row.
 */
export async function loadEmployeeSeatDrift(): Promise<EmployeeSeatDrift[]> {
  const supabase = getSupabaseAdmin();
  // The view is revoked from `public`, `anon` and `authenticated` — the service-role client is the
  // only way in, which is also why every caller of it is server-side.
  const { data, error } = await supabase
    .from("au_v_employee_seat_drift")
    .select(DRIFT_COLUMNS)
    .or("area_id_drifted.is.true,region_code_drifted.is.true,manager_drifted.is.true");
  if (error) throw new Error(error.message);

  const rows = ((data ?? []) as unknown) as DriftRow[];
  if (rows.length === 0) return [];

  // Only reached when something has drifted. On a healthy board nothing below this line runs.
  const employeeAreaIds = [
    ...new Set(
      rows
        .filter((row) => row.area_id_drifted === true)
        .map((row) => Number(row.employee_area_id))
        .filter((id) => Number.isFinite(id)),
    ),
  ];
  const managerHrIds = rows.flatMap((row) =>
    row.manager_drifted === true ? [row.seat_manager_hr_id, row.employee_manager_hr_id] : [],
  );

  const [areaNames, regionNames, managerNames] = await Promise.all([
    loadAreaNames(employeeAreaIds),
    loadRegionNames(),
    namesByHrId(managerHrIds),
  ]);

  const drifts: EmployeeSeatDrift[] = [];
  for (const row of rows) {
    const hrId = trimmed(row.hr_id);
    const name = trimmed(row.full_name);
    // A row with no id has nowhere to link and a row with no name cannot be printed without
    // breaking "names, never codes" — both are impossible against `employees`, and neither is worth
    // inventing a placeholder for.
    if (!hrId || !name) continue;

    const facts: EmployeeSeatDriftFact[] = [];
    if (row.area_id_drifted === true) {
      facts.push({
        kind: "area",
        employeeValue: areaNames.get(Number(row.employee_area_id)) ?? null,
        seatValue: trimmed(row.seat_area_name),
      });
    }
    if (row.region_code_drifted === true) {
      const employeeCode = trimmed(row.employee_region_code);
      const seatCode = trimmed(row.seat_region_code);
      facts.push({
        kind: "region",
        // A region whose code is not in `au_v_regions` falls back to NOTHING rather than to the
        // code: an unknown code on his screen is the same defect as an HR id on it.
        employeeValue: employeeCode ? regionNames.get(employeeCode) ?? null : null,
        seatValue: seatCode ? regionNames.get(seatCode) ?? null : null,
      });
    }
    if (row.manager_drifted === true) {
      facts.push({
        kind: "manager",
        employeeValue: managerNames.get(row.employee_manager_hr_id),
        seatValue: managerNames.get(row.seat_manager_hr_id),
      });
    }
    if (facts.length === 0) continue;

    drifts.push({ hrId, name, seat: describeSeat(row), facts });
  }

  // Alphabetical, so two reads of the same board list the same people in the same order — this view
  // carries no timestamp to sort by, and PostgREST's own order is not promised.
  return drifts.sort((left, right) => left.name.localeCompare(right.name));
}

async function loadAreaNames(ids: readonly number[]): Promise<Map<number, string>> {
  const names = new Map<number, string>();
  if (ids.length === 0) return names;
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("areas").select("id,name").in("id", [...ids]);
  // A lost area name costs this row the words "the record says X" and nothing else — the row still
  // reports the disagreement. Throwing here would lose the whole alarm over a label.
  if (error) return names;
  for (const row of ((data ?? []) as unknown) as Array<{ id?: number | null; name?: string | null }>) {
    const id = Number(row.id);
    const name = trimmed(row.name);
    if (Number.isFinite(id) && name) names.set(id, name);
  }
  return names;
}

async function loadRegionNames(): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("au_v_regions").select("region_code,region_name");
  if (error) return names;
  for (const row of ((data ?? []) as unknown) as Array<{
    region_code?: string | null;
    region_name?: string | null;
  }>) {
    const code = trimmed(row.region_code);
    const name = trimmed(row.region_name);
    if (code && name) names.set(code, name);
  }
  return names;
}
