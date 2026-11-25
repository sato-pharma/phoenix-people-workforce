/**
 * Doctor list validation, by medical rep — the read (owner, 26 Nov 2026). Read LIVE on every call: the page and the
 * export never serve a stored copy, so an export taken after a validation already counts it.
 *
 * WHO READS IT: the Super Admin and the SFE Manager — the same two readers as the refused-readings board, because the
 * blocked tries it counts come from that board's table, and it is where the SFE sees who still has a list to do.
 * Anyone else is told nothing exists here (a 404 from the route, a redirect from the page).
 *
 * The figures are computed by `buildValidationProgress` (validation-progress-rules.ts); this file only gathers rows.
 */

import { notFoundError } from "@/lib/http/api-errors";
import { hrIdLookupKeys } from "@/lib/hr-id";
import {
  buildValidationProgress,
  type ValidationCustomerRow,
  type ValidationProgressReport,
  type ValidationRefusalRow,
  type ValidationSeat,
} from "@/lib/phoenix-crm/validation-progress-rules";
import { type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { chunk, throwIfError } from "@/lib/phoenix-crm/server/db";
import { loadPhoenixCrmOrg } from "@/lib/phoenix-crm/server/org";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { personKey, seatOccupants } from "@/lib/phoenix-crm/scope";
import { mapWithConcurrency } from "@/lib/reconciliation/concurrency";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin, toQueryError } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

export function canReadValidationProgress(viewer: PhoenixCrmViewer): boolean {
  return viewer.isSuperAdmin || viewer.isSfeManager;
}

const text = (value: unknown): string | null => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : null;
};

/** Hire dates keyed by upper-case HR id, every spelling of each id asked (production stores hr_id mixed-case). */
async function loadHireDates(hrIds: readonly string[]): Promise<Map<string, string | null>> {
  const lookup = [...new Set(hrIds.flatMap((hrId) => hrIdLookupKeys(hrId)))];
  const supabase = getSupabaseAdmin();
  const batches = await mapWithConcurrency(chunk(lookup, 50), 4, async (part) => {
    const { data, error } = await supabase.from("employees").select("hr_id, hire_date").in("hr_id", part);
    throwIfError(error);
    return (data ?? []) as Row[];
  });
  const dates = new Map<string, string | null>();
  for (const row of batches.flat()) {
    const key = personKey(text(row.hr_id));
    if (!key || dates.get(key)) continue;
    dates.set(key, text(row.hire_date)?.slice(0, 10) ?? null);
  }
  return dates;
}

export async function loadValidationProgress(viewer: PhoenixCrmViewer): Promise<ValidationProgressReport> {
  if (!canReadValidationProgress(viewer)) throw notFoundError("Not found.");
  const supabase = getSupabaseAdmin();

  const [customerRows, refusalRows, org] = await Promise.all([
    fetchAllRows<Row>(
      () =>
        supabase
          .from("phoenix_crm_customers")
          .select("id, seat_id, list_type, name, speciality, grade, status")
          .eq("is_test", false)
          .in("list_type", ["AM", "PM"])
          .in("status", ["active", "pending"]),
      "id",
    ).catch((error: unknown) => {
      throw toQueryError(error);
    }),
    fetchAllRows<Row>(
      () =>
        supabase
          .from("phoenix_crm_refused_readings")
          .select("id, customer_id, rep_hr_id, reason, visit_date")
          .eq("is_test", false)
          .eq("subject_kind", "place"),
      "id",
    ).catch((error: unknown) => {
      throw toQueryError(error);
    }),
    loadPhoenixCrmOrg(),
  ]);

  const customers: ValidationCustomerRow[] = customerRows.flatMap((row) => {
    const id = text(row.id);
    const seatId = text(row.seat_id);
    if (!id || !seatId) return [];
    return [
      {
        id,
        seatId,
        listType: row.list_type === "AM" ? "AM" : "PM",
        name: text(row.name) ?? "Unnamed customer",
        speciality: text(row.speciality),
        grade: text(row.grade),
        validated: row.status === "active",
      },
    ];
  });
  const refusals: ValidationRefusalRow[] = refusalRows.map((row) => ({
    customerId: text(row.customer_id),
    repHrId: personKey(text(row.rep_hr_id)),
    reason: text(row.reason) ?? "",
    visitDate: text(row.visit_date) ?? "",
  }));

  const seatIds = [...new Set(customers.map((customer) => customer.seatId))];
  const occupantsOf = new Map(seatIds.map((seatId) => [seatId, org.seats.get(seatId) ? seatOccupants(org.seats.get(seatId)!) : []] as const));
  const managerSeatOf = new Map(seatIds.map((seatId) => [seatId, org.seats.get(seatId)?.parentSeatId ?? null] as const));
  const managerPeople = [...managerSeatOf.values()].flatMap((parent) => (parent && org.seats.get(parent) ? seatOccupants(org.seats.get(parent)!) : []));
  const repPeople = [...occupantsOf.values()].flat();
  const [names, hireDates] = await Promise.all([
    loadPeopleNames([...repPeople, ...managerPeople, ...refusals.map((refusal) => refusal.repHrId)]),
    loadHireDates([...new Set(repPeople)]),
  ]);

  const seats = new Map<string, ValidationSeat>();
  for (const seatId of seatIds) {
    const seat = org.seats.get(seatId);
    const parent = managerSeatOf.get(seatId);
    const managers = parent && org.seats.get(parent) ? seatOccupants(org.seats.get(parent)!) : [];
    seats.set(seatId, {
      seatId,
      people: (occupantsOf.get(seatId) ?? []).map((hrId) => ({ hrId, name: nameOf(names, hrId), hireDate: hireDates.get(hrId) ?? null })),
      lineName: seat?.lineName ?? "",
      areaName: seat?.areaName ?? seat?.regionName ?? "",
      managerName: managers.length > 0 ? [...new Set(managers.map((hrId) => nameOf(names, hrId)))].join(" / ") : "No district manager",
    });
  }

  return buildValidationProgress({ customers, refusals, seats, peopleNames: names });
}
