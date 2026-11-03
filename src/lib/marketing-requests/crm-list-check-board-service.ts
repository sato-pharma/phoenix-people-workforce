/**
 * The server half of the list-check board: reads what `buildListCheckBoard` sums.
 *
 * 🔴 Reads only. The one write the board has is `decideMarketingListCheck`, behind its own route.
 * 🔴 Visits come from `phoenix_crm_countable_visits` with `customer_validated = true`, the one predicate for
 * a visit that counts, so copied iReports360 history and an unapproved off-plan visit stay out.
 * 🔴 A doctor's objection reaches only the managers' audience of Objections by doctor (owner, 2026-11-03):
 * it is withheld from the Marketing Manager, who reads this board for the money.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { AccessContext } from "@/lib/auth/permissions";
import { forbiddenError } from "@/lib/http/api-errors";
import {
  buildListCheckBoard,
  checkForRequest,
  latestRaisedObjection,
  type ListCheckBoard,
  type ListCheckBoardRow,
  type ListCheckRequesterShare,
} from "@/lib/marketing-requests/crm-list-check-board";
import { indexSeats, seatKey } from "@/lib/marketing-requests/crm-list-check";
import { DOCTOR_PLACE_COLUMNS, nearestDoctorPhotoPath, type DoctorPlaceRow } from "@/lib/marketing-requests/crm-list-check-flags";
import {
  canDecideListCheck,
  canReadListCheckBoard,
  LIST_CHECK_STATE_LABELS,
  LIST_CHECK_STATE_ORDER,
  currentListCheckRows,
  LIST_CHECKED_VALIDATION_STATUSES,
  listCheckIsFar,
  type ListCheckState,
} from "@/lib/marketing-requests/crm-list-check-rules";
import { loadMarketingEvidencePhotosByEntityIds } from "@/lib/marketing-requests/evidence-photo-storage";
import { roiValueBucket } from "@/lib/marketing-requests/roi-report-service";
import { raisedObjection } from "@/lib/phoenix-crm/field-heard";
import { chunk, textOrNull } from "@/lib/phoenix-crm/server/db";
import { loadPhoenixCrmOrg } from "@/lib/phoenix-crm/server/org";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { seatOccupants } from "@/lib/phoenix-crm/scope";
import { visitObjectionLabel } from "@/lib/phoenix-crm/visit-outcome";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

const PHOENIX_CRM_PHOTO_BUCKET = "phoenix-crm-photos";
const DOCTOR_PHOTO_URL_SECONDS = 15 * 60;
const IN_CHUNK = 100;

const CHECK_COLUMNS =
  "id, customer_id, line_id, state, reason, matched_crm_customer_id, matched_name, seat_id, list_type, metres_apart, area_code, area_name, looks_like_nursery, left_list_at, checked_at, decided_state, decided_by_hr_id, decided_at, line:lines(name)";

/** The roles who may read a doctor's objections here: the company-wide readers of the managers' report. */
function readsDoctorObjections(role: string | null | undefined): boolean {
  return role === "Super Admin" || role === "SFE Manager" || role === "CEO";
}

async function readIn(supabase: SupabaseClient, table: string, columns: string, column: string, ids: readonly string[]): Promise<Row[]> {
  const rows: Row[] = [];
  for (const part of chunk([...new Set(ids)], IN_CHUNK)) {
    const { data, error } = await supabase.from(table).select(columns).in(column, part);
    if (error) throw error;
    rows.push(...((data ?? []) as unknown as Row[]));
  }
  return rows;
}

/** Signs both photos for the rows still waiting on a person. A failure leaves the row without its photos, never without the board. */
async function loadQueuePhotos(
  supabase: SupabaseClient,
  queue: ReadonlyArray<{ checkId: string; crmCustomerId: string | null; customerId: string; point: { lat: unknown; lon: unknown } }>,
): Promise<Map<string, { customer: string | null; doctor: string | null }>> {
  const out = new Map<string, { customer: string | null; doctor: string | null }>();
  if (queue.length === 0) return out;
  try {
    const crmIds = queue.map((row) => row.crmCustomerId).filter((id): id is string => id !== null);
    const [customerPhotos, placeRows] = await Promise.all([
      loadMarketingEvidencePhotosByEntityIds({ entityIds: queue.map((row) => row.customerId), entityType: "customer", supabase }),
      (async () => {
        const rows: DoctorPlaceRow[] = [];
        for (const part of chunk([...new Set(crmIds)], IN_CHUNK)) {
          const { data, error } = await supabase
            .from("phoenix_crm_places")
            .select(DOCTOR_PLACE_COLUMNS)
            .in("customer_id", part)
            .eq("is_test", false)
            .eq("status", "active")
            .not("photo_path", "is", null);
          if (error) throw error;
          rows.push(...((data ?? []) as DoctorPlaceRow[]));
        }
        return rows;
      })(),
    ]);
    const placesByCrm = new Map<string, DoctorPlaceRow[]>();
    for (const row of placeRows) {
      const crmId = String(row.customer_id);
      placesByCrm.set(crmId, [...(placesByCrm.get(crmId) ?? []), row]);
    }
    const doctorPathByCheck = new Map(
      queue.map((row) => [row.checkId, row.crmCustomerId ? nearestDoctorPhotoPath(placesByCrm.get(row.crmCustomerId) ?? [], row.point) : null]),
    );
    const paths = [...new Set([...doctorPathByCheck.values()].filter((path): path is string => path !== null))];
    const signedByPath = new Map<string, string>();
    if (paths.length > 0) {
      const signed = await supabase.storage.from(PHOENIX_CRM_PHOTO_BUCKET).createSignedUrls(paths, DOCTOR_PHOTO_URL_SECONDS);
      signed.data?.forEach((result, index) => {
        if (result?.signedUrl && !result.error) signedByPath.set(paths[index], result.signedUrl);
      });
    }
    for (const row of queue) {
      const path = doctorPathByCheck.get(row.checkId);
      out.set(row.checkId, {
        customer: customerPhotos.get(row.customerId)?.signedUrl ?? null,
        doctor: path ? (signedByPath.get(path) ?? null) : null,
      });
    }
  } catch (error) {
    console.error("[marketing-list-check] the board's photos could not be read; the queue shows without them", error);
  }
  return out;
}

export async function loadListCheckBoard(access: Pick<AccessContext, "role">, now = new Date().toISOString()): Promise<ListCheckBoard> {
  if (!canReadListCheckBoard(access.role)) throw forbiddenError("You do not have access to the doctor-list check.");
  const supabase = getSupabaseAdmin();

  const checkRead = await supabase.from("marketing_customer_list_checks").select(CHECK_COLUMNS);
  if (checkRead.error) throw checkRead.error;
  const currentChecks = currentListCheckRows((checkRead.data ?? []) as unknown as Row[]);
  const customerIds = [...new Set(currentChecks.map((row) => String(row.customer_id)))];

  const [customerRows, requestRows, org] = await Promise.all([
    readIn(supabase, "marketing_customers", "id, display_name, captured_latitude, captured_longitude, active, merged_into_customer_id, validation_status", "id", customerIds),
    readIn(supabase, "marketing_requests", "customer_id, line_id, status, estimated_cost, pay_date, requester_hr_id", "customer_id", customerIds),
    loadPhoenixCrmOrg(),
  ]);
  const customerById = new Map(customerRows.map((row) => [String(row.id), row]));
  // A customer merged away, switched off or no longer validated leaves the check, so he leaves its counts too.
  const validated = new Set<string>(LIST_CHECKED_VALIDATION_STATUSES);
  const checks = currentChecks.filter((row) => {
    const customer = customerById.get(String(row.customer_id));
    return Boolean(customer) && customer?.active !== false && !customer?.merged_into_customer_id && validated.has(String(customer?.validation_status));
  });
  const lineName = new Map(
    checks
      .filter((row) => row.line_id !== null && row.line_id !== undefined)
      .map((row) => [Number(row.line_id), textOrNull((row.line as { name?: unknown } | null | undefined)?.name)]),
  );
  const seatById = new Map(org.territories.map((seat) => [seat.seatId, seat]));
  const seatsByKey = indexSeats(org.territories);
  const lineCode = new Map(org.territories.map((seat) => [seat.lineName, seat.lineCode]));

  type Money = { cost: number; count: number; firstPayDate: string | null; requesters: Set<string> };
  const lineOf = (row: Row) => (row.line_id === null || row.line_id === undefined ? null : Number(row.line_id));
  const checksByCustomer = new Map<string, Array<{ id: string; lineId: number | null }>>();
  for (const check of checks) {
    const customerId = String(check.customer_id);
    checksByCustomer.set(customerId, [...(checksByCustomer.get(customerId) ?? []), { id: String(check.id), lineId: lineOf(check) }]);
  }

  const moneyByCheck = new Map<string, Money>();
  const shares: Array<Omit<ListCheckRequesterShare, "requesterName"> & { requesterHrId: string | null }> = [];
  for (const request of requestRows) {
    if (roiValueBucket(String(request.status) as never) !== "approved") continue;
    const check = checkForRequest(checksByCustomer.get(String(request.customer_id)) ?? [], lineOf(request));
    if (!check) continue;
    const cost = Number(request.estimated_cost ?? 0) || 0;
    const money = moneyByCheck.get(check.id) ?? { cost: 0, count: 0, firstPayDate: null, requesters: new Set<string>() };
    money.cost += cost;
    money.count += 1;
    const payDate = textOrNull(request.pay_date);
    if (payDate && (!money.firstPayDate || payDate < money.firstPayDate)) money.firstPayDate = payDate;
    const requesterHrId = textOrNull(request.requester_hr_id);
    if (requesterHrId) money.requesters.add(requesterHrId);
    moneyByCheck.set(check.id, money);
    shares.push({ checkId: check.id, cost, requesterHrId });
  }

  const matchedIds = [...new Set(checks.map((row) => textOrNull(row.matched_crm_customer_id)).filter((id): id is string => id !== null))];
  const visitRows: Row[] = [];
  for (const part of chunk(matchedIds, IN_CHUNK)) {
    const rows = await fetchAllRowsKeyset<Row>(
      () =>
        supabase
          .from("phoenix_crm_countable_visits")
          .select("id, customer_id, visit_date, objection, objection_note")
          .in("customer_id", part)
          .eq("customer_validated", true)
          .eq("is_test", false),
      { cursorColumn: "id", cursorOf: (row) => String(row.id) },
    );
    visitRows.push(...rows);
  }
  const visitsByCrm = new Map<string, Row[]>();
  for (const visit of visitRows) {
    const crmId = String(visit.customer_id);
    visitsByCrm.set(crmId, [...(visitsByCrm.get(crmId) ?? []), visit]);
  }

  const seatsFor = (check: Row) => {
    const seatId = textOrNull(check.seat_id);
    const own = seatId ? seatById.get(seatId) : undefined;
    if (own) return [own];
    const lineId = lineOf(check);
    const code = lineId === null ? null : lineCode.get(lineName.get(lineId) ?? null);
    const key = seatKey(code, textOrNull(check.area_code));
    return (key && seatsByKey.get(key)) || [];
  };

  const people = await loadPeopleNames([
    ...checks.flatMap((check) => seatsFor(check).flatMap((seat) => seatOccupants(seat))),
    ...checks.map((check) => textOrNull(check.decided_by_hr_id)),
    ...shares.map((share) => share.requesterHrId),
  ]);

  const isOpen = (check: Row) => check.state === "check" && !check.decided_state;
  const photos = await loadQueuePhotos(
    supabase,
    checks.filter(isOpen).map((check) => {
      const customer = customerById.get(String(check.customer_id));
      return {
        checkId: String(check.id),
        crmCustomerId: textOrNull(check.matched_crm_customer_id),
        customerId: String(check.customer_id),
        point: { lat: customer?.captured_latitude, lon: customer?.captured_longitude },
      };
    }),
  );

  const showObjections = readsDoctorObjections(access.role);
  const rows: ListCheckBoardRow[] = checks.map((check) => {
    const checkId = String(check.id);
    const state = String(check.state) as ListCheckState;
    const customerId = String(check.customer_id);
    const money = moneyByCheck.get(checkId);
    const matchedCrmCustomerId = textOrNull(check.matched_crm_customer_id);
    const visits = matchedCrmCustomerId ? (visitsByCrm.get(matchedCrmCustomerId) ?? []) : [];
    const dates = visits.map((visit) => String(visit.visit_date)).sort();
    const firstPayDate = money?.firstPayDate ?? null;
    const seats = seatsFor(check);
    const metresApart = typeof check.metres_apart === "number" ? check.metres_apart : null;
    const seatId = textOrNull(check.seat_id);
    const photo = photos.get(checkId);
    return {
      approvedCost: money?.cost ?? 0,
      approvedRequests: money?.count ?? 0,
      checkId,
      customerId,
      customerName: textOrNull(customerById.get(customerId)?.display_name) ?? "Unnamed customer",
      customerPhotoUrl: photo?.customer ?? null,
      decidedAt: textOrNull(check.decided_at),
      decidedByName: textOrNull(check.decided_by_hr_id) ? nameOf(people, textOrNull(check.decided_by_hr_id)) : null,
      doctorPhotoUrl: photo?.doctor ?? null,
      far: listCheckIsFar(metresApart),
      firstPayDate,
      lastVisitDate: dates.at(-1) ?? null,
      latestObjection: showObjections
        ? latestRaisedObjection(
            visits.map((visit) => ({ objection: visit.objection, objectionNote: textOrNull(visit.objection_note), visitDate: String(visit.visit_date) })),
            (value) => {
              const raised = raisedObjection(value);
              return raised ? visitObjectionLabel(raised) : null;
            },
          )
        : null,
      leftListAt: textOrNull(check.left_list_at),
      lineName: lineName.get(lineOf(check) ?? -1) ?? null,
      listAreaName: seatId ? (seatById.get(seatId)?.areaName ?? null) : null,
      listType: textOrNull(check.list_type),
      looksLikeNursery: check.looks_like_nursery === true,
      marketingAreaName: textOrNull(check.area_name),
      matchedCrmCustomerId,
      matchedName: textOrNull(check.matched_name),
      metresApart,
      open: isOpen(check),
      reason: String(check.reason ?? ""),
      repNames: [...new Set(seats.flatMap((seat) => seatOccupants(seat)).map((hrId) => nameOf(people, hrId)))],
      requesterNames: [...new Set([...(money?.requesters ?? [])].map((hrId) => nameOf(people, hrId)))],
      state,
      stateLabel: LIST_CHECK_STATE_LABELS[state] ?? state,
      visitsSincePay: matchedCrmCustomerId && firstPayDate ? dates.filter((date) => date >= firstPayDate).length : null,
    };
  });

  return buildListCheckBoard({
    canDecide: canDecideListCheck(access.role),
    generatedAtIso: now,
    labels: LIST_CHECK_STATE_LABELS,
    order: LIST_CHECK_STATE_ORDER,
    requesterShares: shares.map((share) => ({
      checkId: share.checkId,
      cost: share.cost,
      requesterName: nameOf(people, share.requesterHrId, "Unknown requester"),
    })),
    rows,
    showObjections,
  });
}
