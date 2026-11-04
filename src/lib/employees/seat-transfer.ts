import type { SupabaseClient } from "@supabase/supabase-js";

import type { AccessContext } from "@/lib/auth/permissions";
import { invalidateExecutiveDashboardCache } from "@/lib/dashboard/invalidation";
import { hrIdForStorage } from "@/lib/hr-id";
import { loadReferenceLines, type ReferenceLine } from "@/lib/reference/reference-lists";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * Seat transfer — the app-side caller for public.phx_transfer_au_seat.
 *
 * Moving an active employee between au seats (or seating an unseated one) used to be
 * hand-written SQL every time the auto-seat chain misfired. This service is the safe,
 * audited path: the RPC derives the source seat from the person's own open span,
 * refuses cross-line moves and occupied targets, and syncs the employee master
 * (area/region/manager) so the legacy columns follow the seat model.
 *
 * Super Admin only: seat moves rewrite live org structure that payroll, targets and
 * sales attribution hang off — server-side enforcement here, not just hidden UI.
 */

export type SeatTransferSeatOption = {
  seatId: string;
  seatTier: string;
  lineCode: string;
  areaName: string | null;
  regionName: string | null;
  label: string;
  /** Set on another line's seats, where choosing one moves the person to that line. */
  lineName?: string | null;
};

export type SeatTransferOptions = {
  employee: {
    hrId: string;
    fullName: string;
    employmentStatus: string | null;
    lineCode: string | null;
    lineName: string | null;
  };
  currentSeats: SeatTransferSeatOption[];
  vacantSeats: SeatTransferSeatOption[];
  /** Vacant seats on every OTHER line — choosing one is a line move. */
  otherLineVacantSeats: SeatTransferSeatOption[];
};

export type SeatTransferInput = {
  toSeatId: string;
  effectiveDate?: string | null;
  fromSeatId?: string | null;
  reason?: string | null;
  /**
   * The chosen seat is on another line. Routes to phx_move_employee_to_line, which also moves the
   * employee's line, fills the seat's vacancy and opens one for the seat left. Both functions check
   * the lines themselves (the transfer refuses another line, the line move refuses the same line),
   * so a wrong flag is refused, never applied.
   */
  moveLine?: boolean;
};

export type SeatTransferResult = {
  mode: "seated" | "transferred";
  employeeHrId: string;
  fromSeatId: string | null;
  toSeatId: string;
  effectiveDate: string;
  occupancyId: number;
  employeesSync: Record<string, unknown>;
  lineMove?: {
    fromLine: string | null;
    toLine: string;
    vacanciesFilled: string[];
    vacancyOpened: string | null;
  };
};

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

type TreeRow = {
  seat_id: string;
  seat_tier: string;
  line_code: string;
  area_name: string | null;
  region_name: string | null;
  seat_display_label: string | null;
  occupant_hr_id: string | null;
  is_vacant: boolean;
  is_other_pseudo_dm: boolean;
};

function hrKey(value: string | null | undefined): string {
  return (value ?? "").trim().toUpperCase();
}

function toSeatOption(row: TreeRow): SeatTransferSeatOption {
  return {
    seatId: row.seat_id,
    seatTier: row.seat_tier,
    lineCode: row.line_code,
    areaName: row.area_name,
    regionName: row.region_name,
    label: row.seat_display_label?.trim() || row.seat_id,
  };
}

function assertSeatTransferActor(access: AccessContext): void {
  if (access.scope === "system" || access.role === "Super Admin") return;
  throw new Error(`Forbidden: ${access.role} cannot move employees between organogram seats.`);
}

export async function listSeatTransferOptions(
  employeeHrId: string,
  access: AccessContext,
  client: SupabaseClient = getSupabaseAdmin(),
  loadLines: () => Promise<Array<Pick<ReferenceLine, "code" | "name">>> = loadReferenceLines,
): Promise<SeatTransferOptions> {
  assertSeatTransferActor(access);

  const hrId = employeeHrId.trim();
  if (!hrId) throw new Error("Employee HR ID is required.");
  // employees.hr_id is stored canonical-uppercase; a raw case-sensitive .eq() on the trimmed
  // path segment would silently return no row for a mixed-case id (same defect class as
  // vacancy-closer.ts's manager_hr_id match — AGENTS.md 2.1, "HR ids are MIXED CASE").
  const canonicalHrId = hrIdForStorage(hrId) ?? hrId;

  const { data: employeeRow, error: employeeError } = await client
    .from("employees")
    .select("hr_id, full_name, line_id, employment_status")
    .eq("hr_id", canonicalHrId)
    .maybeSingle();
  if (employeeError) throw new Error(`Employee lookup failed: ${employeeError.message}`);
  if (!employeeRow) throw new Error(`Employee ${hrId} not found.`);

  let lineCode: string | null = null;
  let lineName: string | null = null;
  if (employeeRow.line_id !== null && employeeRow.line_id !== undefined) {
    const { data: lineRow, error: lineError } = await client
      .from("lines")
      .select("code, name")
      .eq("id", employeeRow.line_id)
      .maybeSingle();
    if (lineError) throw new Error(`Line lookup failed: ${lineError.message}`);
    lineCode = lineRow?.code ?? null;
    lineName = lineRow?.name ?? null;
  }

  let currentSeats: SeatTransferSeatOption[] = [];
  let vacantSeats: SeatTransferSeatOption[] = [];
  let otherLineVacantSeats: SeatTransferSeatOption[] = [];

  if (lineCode) {
    const [{ data: otherTree, error: otherTreeError }, lineRows] = await Promise.all([
      client
        .from("au_v_org_tree")
        .select(
          "seat_id, seat_tier, line_code, area_name, region_name, seat_display_label, occupant_hr_id, is_vacant, is_other_pseudo_dm",
        )
        .neq("line_code", lineCode)
        .eq("is_vacant", true),
      loadLines(),
    ]);
    if (otherTreeError) throw new Error(`Seat lookup failed: ${otherTreeError.message}`);
    const lineNameByCode = new Map(lineRows.map((line) => [line.code, line.name]));
    otherLineVacantSeats = ((otherTree ?? []) as TreeRow[])
      .filter((row) => row.is_vacant && !row.is_other_pseudo_dm)
      .map((row) => ({ ...toSeatOption(row), lineName: lineNameByCode.get(row.line_code) ?? row.line_code }))
      .sort((left, right) =>
        (left.lineName ?? "").localeCompare(right.lineName ?? "") ||
        left.seatTier.localeCompare(right.seatTier) ||
        left.label.localeCompare(right.label),
      );
  }

  if (lineCode) {
    const { data: treeData, error: treeError } = await client
      .from("au_v_org_tree")
      .select(
        "seat_id, seat_tier, line_code, area_name, region_name, seat_display_label, occupant_hr_id, is_vacant, is_other_pseudo_dm",
      )
      .eq("line_code", lineCode);
    if (treeError) throw new Error(`Seat lookup failed: ${treeError.message}`);

    const rows = (treeData ?? []) as TreeRow[];
    const employeeKey = hrKey(employeeRow.hr_id);
    currentSeats = rows.filter((row) => hrKey(row.occupant_hr_id) === employeeKey).map(toSeatOption);
    vacantSeats = rows
      .filter((row) => row.is_vacant && !row.is_other_pseudo_dm)
      .map(toSeatOption)
      .sort((left, right) =>
        left.seatTier === right.seatTier
          ? left.label.localeCompare(right.label)
          : left.seatTier.localeCompare(right.seatTier),
      );
  }

  return {
    employee: {
      hrId: employeeRow.hr_id,
      fullName: employeeRow.full_name ?? employeeRow.hr_id,
      employmentStatus: employeeRow.employment_status ?? null,
      lineCode,
      lineName,
    },
    currentSeats,
    vacantSeats,
    otherLineVacantSeats,
  };
}

export async function transferEmployeeSeat(
  employeeHrId: string,
  input: SeatTransferInput,
  actor: string,
  access: AccessContext,
  client: SupabaseClient = getSupabaseAdmin(),
): Promise<SeatTransferResult> {
  assertSeatTransferActor(access);

  const hrId = employeeHrId.trim();
  if (!hrId) throw new Error("Employee HR ID is required.");
  const toSeatId = input.toSeatId?.trim();
  if (!toSeatId) throw new Error("Destination seat is required.");
  const effectiveDate = input.effectiveDate?.trim() || null;
  if (effectiveDate && !ISO_DATE_PATTERN.test(effectiveDate)) {
    throw new Error("Effective date must be YYYY-MM-DD.");
  }

  // A line move: the same seat transfer plus the employee's line, the destination seat's open
  // vacancy filled and one opened for the seat left — in one transaction. Salary, HR ID, CRM id and
  // history stay; the person is never resigned and re-hired.
  const { data, error } = input.moveLine
    ? await client.rpc("phx_move_employee_to_line", {
        p_actor: actor,
        p_effective_date: effectiveDate,
        p_employee_hr_id: hrId,
        p_reason: input.reason?.trim() || null,
        p_to_seat_id: toSeatId,
      })
    : await client.rpc("phx_transfer_au_seat", {
        p_actor: actor,
        p_effective_date: effectiveDate,
        p_employee_hr_id: hrId,
        p_from_seat_id: input.fromSeatId?.trim() || null,
        p_reason: input.reason?.trim() || null,
        p_to_seat_id: toSeatId,
      });
  if (error) throw new Error(error.message);

  // The RPC just moved a seat in au_v_org_tree — bust the cached org tree (shared "sos-reference"
  // tag) so the CRM sync panel and every other org-scoped read see it immediately, not after the
  // cache's 300s TTL. This was the one write path with no invalidation call at all.
  invalidateExecutiveDashboardCache("employee seat transfer", ["employees", "vacancies"]);

  return data as SeatTransferResult;
}
