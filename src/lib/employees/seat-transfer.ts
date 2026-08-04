import type { SupabaseClient } from "@supabase/supabase-js";

import type { AccessContext } from "@/lib/auth/permissions";
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
};

export type SeatTransferInput = {
  toSeatId: string;
  effectiveDate?: string | null;
  fromSeatId?: string | null;
  reason?: string | null;
};

export type SeatTransferResult = {
  mode: "seated" | "transferred";
  employeeHrId: string;
  fromSeatId: string | null;
  toSeatId: string;
  effectiveDate: string;
  occupancyId: number;
  employeesSync: Record<string, unknown>;
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
): Promise<SeatTransferOptions> {
  assertSeatTransferActor(access);

  const hrId = employeeHrId.trim();
  if (!hrId) throw new Error("Employee HR ID is required.");

  const { data: employeeRow, error: employeeError } = await client
    .from("employees")
    .select("hr_id, full_name, line_id, employment_status")
    .eq("hr_id", hrId)
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

  const { data, error } = await client.rpc("phx_transfer_au_seat", {
    p_actor: actor,
    p_effective_date: effectiveDate,
    p_employee_hr_id: hrId,
    p_from_seat_id: input.fromSeatId?.trim() || null,
    p_reason: input.reason?.trim() || null,
    p_to_seat_id: toSeatId,
  });
  if (error) throw new Error(error.message);

  return data as SeatTransferResult;
}
