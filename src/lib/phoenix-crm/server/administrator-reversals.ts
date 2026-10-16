/**
 * Phoenix CRM — the Administrator takes back a decision that was already taken (owner, 2026-10-08).
 *
 * Reads the decided items he can still reverse (the Team tab lists them, only for him) and does the
 * reversal through one of three database functions, each of which refuses what cannot be put back
 * (migration 20261008190000). The rules and wording live in `administrator-reversal-rules.ts`.
 *
 * 🔴 EVERY act is checked twice: `canOverrideDecision` here (the Administrator, a real entry — never a
 * test one), and again by the route's `phoenix_crm`/`approve` permission. The kind and the id come from
 * the body, but WHAT is reversed and whether it still can be is read from the row and the database, never
 * trusted from the screen.
 */

import { addDaysIso } from "@/lib/crm/dates";
import { conflictError, forbiddenError, notFoundError, validationError } from "@/lib/http/api-errors";
import { formatPhoenixLongDate } from "@/lib/i18n/format";
import {
  ADMINISTRATOR_REVERSAL_DAYS,
  ADMINISTRATOR_REVERSAL_NOTE_MAX,
  isAdministratorReversalKind,
  type AdministratorReversalKind,
  type ReversibleItem,
} from "@/lib/phoenix-crm/administrator-reversal-rules";
import { requestKindLabel } from "@/lib/phoenix-crm/list-request-rules";
import { canOverrideDecision, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { callPhoenixCrm, chunk, textOrNull, throwIfError } from "@/lib/phoenix-crm/server/db";
import { notifyPhoenixCrm } from "@/lib/phoenix-crm/server/notifications";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { describeTerritory } from "@/lib/phoenix-crm/server/territory";
import { isUuid } from "@/lib/phoenix-crm/plan-rules";
import type { PhoenixCrmRequestKind } from "@/lib/phoenix-crm/types";
import { mapWithConcurrency } from "@/lib/reconciliation/concurrency";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

/** The first instant a decision still counts as recent: fourteen days back. */
function sinceIso(): string {
  return new Date(Date.now() - ADMINISTRATOR_REVERSAL_DAYS * 86400000).toISOString();
}

function requestKindOf(value: unknown): PhoenixCrmRequestKind {
  return value === "drop" || value === "add" || value === "restore" ? value : "grade";
}

/**
 * The decided items the Administrator can still take back, newest first — or null for anyone else, so the
 * payload of every other viewer carries nothing of it.
 *
 * A reopened week is listed only while it CAN close again (the rep has not touched it and its week has not
 * passed): the same test the database function applies, so he is never offered a button that must refuse.
 */
export async function loadReversibleItems(viewer: PhoenixCrmViewer, isTest: boolean): Promise<ReversibleItem[] | null> {
  if (!canOverrideDecision(viewer, isTest)) return null;
  const seatIds = viewer.scopeTerritories.map((entry) => entry.seatId);
  if (seatIds.length === 0) return [];
  const since = sinceIso();
  const lastLiveWeek = addDaysIso(viewer.cairoToday, -5);
  const db = getSupabaseAdmin();

  // Each batch's three reads run together, and the batches four at a time, handed back in batch order.
  // Every read is a keyset walk, so a busy fortnight on a national scope is never cut short at
  // PostgREST's silent 1,000 rows; the list is sorted by decision time below, as it always was.
  const batches = await mapWithConcurrency(chunk([...new Set(seatIds)], 100), 4, (part) =>
    Promise.all([
      fetchAllRowsKeyset<Row>(
        () =>
          db
            .from("phoenix_crm_list_requests")
            .select("id, seat_id, kind, customer_name, requested_by_hr_id, decided_at")
            .in("seat_id", part)
            .eq("is_test", false)
            .eq("status", "approved")
            .not("customer_id", "is", null)
            .gte("decided_at", since),
        { cursorColumn: "id", cursorOf: (row) => String(row.id) },
      ),
      fetchAllRowsKeyset<Row>(
        () =>
          db
            .from("phoenix_crm_unplanned_visits")
            .select("visit_id, seat_id, rep_hr_id, visit_date, version, decided_at, customer:phoenix_crm_customers!customer_id(name)")
            .in("seat_id", part)
            .eq("is_test", false)
            .eq("status", "approved")
            .gte("decided_at", since),
        { cursorColumn: "visit_id", cursorOf: (row) => String(row.visit_id) },
      ),
      fetchAllRowsKeyset<Row>(
        () =>
          db
            .from("phoenix_crm_plan_edit_requests")
            .select("id, seat_id, week_start, rep_hr_id, version, reopened_plan_version, decided_at, plan:phoenix_crm_plans!plan_id(status, version)")
            .in("seat_id", part)
            .eq("is_test", false)
            .eq("status", "reopened")
            .gte("week_start", lastLiveWeek)
            .gte("decided_at", since),
        { cursorColumn: "id", cursorOf: (row) => String(row.id) },
      ),
    ]),
  );
  const requests: Row[] = batches.flatMap(([requestRows]) => requestRows);
  const visits: Row[] = batches.flatMap(([, visitRows]) => visitRows);
  const edits: Row[] = batches.flatMap(([, , editRows]) => editRows);

  // A reopened week still exactly as the reopening left it: a draft at the version it made.
  const untouched = edits.filter((row) => {
    const plan = (Array.isArray(row.plan) ? row.plan[0] : row.plan) as Row | null | undefined;
    return plan?.status === "draft" && Number(plan.version) === Number(row.reopened_plan_version);
  });

  const names = await loadPeopleNames([
    ...requests.map((row) => textOrNull(row.requested_by_hr_id)),
    ...visits.map((row) => textOrNull(row.rep_hr_id)),
    ...untouched.map((row) => textOrNull(row.rep_hr_id)),
  ]);
  const territoryNameOf = (seatId: unknown): string => {
    const seat = viewer.org.seats.get(String(seatId));
    return seat ? describeTerritory(viewer.org, seat, names).name : "Territory";
  };

  const items: ReversibleItem[] = [
    ...requests.map(
      (row): ReversibleItem => ({
        kind: "request",
        id: String(row.id),
        version: null,
        label: `Approved ${requestKindLabel(requestKindOf(row.kind)).toLowerCase()}`,
        subject: String(row.customer_name),
        repName: nameOf(names, textOrNull(row.requested_by_hr_id)),
        territoryName: territoryNameOf(row.seat_id),
        decidedAt: String(row.decided_at),
      }),
    ),
    ...visits.map((row): ReversibleItem => {
      const customer = (Array.isArray(row.customer) ? row.customer[0] : row.customer) as Row | null | undefined;
      return {
        kind: "visit",
        id: String(row.visit_id),
        version: Number(row.version),
        label: "Approved off-plan visit",
        subject: `${textOrNull(customer?.name) ?? "A customer"} · ${formatPhoenixLongDate(String(row.visit_date))}`,
        repName: nameOf(names, textOrNull(row.rep_hr_id)),
        territoryName: territoryNameOf(row.seat_id),
        decidedAt: String(row.decided_at),
      };
    }),
    ...untouched.map(
      (row): ReversibleItem => ({
        kind: "plan_edit",
        id: String(row.id),
        version: Number(row.version),
        label: "Reopened week",
        subject: `Week starting ${formatPhoenixLongDate(String(row.week_start))}`,
        repName: nameOf(names, textOrNull(row.rep_hr_id)),
        territoryName: territoryNameOf(row.seat_id),
        decidedAt: String(row.decided_at),
      }),
    ),
  ];
  return items.sort((left, right) => right.decidedAt.localeCompare(left.decidedAt));
}

/** Reverse one decided item. The route is POST-only and permission-checked; this checks WHO. */
export async function reverseDecision(viewer: PhoenixCrmViewer, raw: unknown): Promise<{ kind: AdministratorReversalKind; id: string; status: "refused" }> {
  const body = (raw ?? {}) as Record<string, unknown>;
  const kind = body.kind;
  if (!isAdministratorReversalKind(kind)) throw validationError("Choose what to reverse.");
  const id = String(body.id ?? "");
  if (!isUuid(id)) throw validationError("Choose what to reverse.");
  const note = String(body.note ?? "").trim().replace(/\s+/g, " ");
  if (!note) throw validationError("Write the comment first. The rep reads it.");
  if (note.length > ADMINISTRATOR_REVERSAL_NOTE_MAX) throw validationError(`Keep the comment under ${ADMINISTRATOR_REVERSAL_NOTE_MAX} characters.`);
  const expectedVersion = body.expectedVersion === undefined || body.expectedVersion === null ? null : Number(body.expectedVersion);
  if (kind !== "request" && (expectedVersion === null || !Number.isInteger(expectedVersion) || expectedVersion < 1)) {
    throw validationError("Reload the page and try again.");
  }

  if (kind === "plan_edit") return reversePlanEdit(viewer, id, note, expectedVersion as number);
  if (kind === "visit") return reverseVisit(viewer, id, note, expectedVersion as number);
  return reverseRequest(viewer, id, note);
}

function assertAdministrator(viewer: PhoenixCrmViewer, isTest: boolean): void {
  if (!canOverrideDecision(viewer, isTest)) throw forbiddenError("Only the Administrator reverses a decision, and only on a real entry.");
}

async function reversePlanEdit(viewer: PhoenixCrmViewer, requestId: string, note: string, expectedVersion: number) {
  const { data, error } = await getSupabaseAdmin()
    .from("phoenix_crm_plan_edit_requests")
    .select("id, seat_id, week_start, rep_hr_id, is_test")
    .eq("id", requestId)
    .maybeSingle();
  throwIfError(error);
  const row = data as Row | null;
  if (!row) throw notFoundError("This request is no longer there. Reload the page.");
  assertAdministrator(viewer, row.is_test === true);
  const seat = viewer.org.seats.get(String(row.seat_id));
  if (!seat) throw notFoundError("This territory is no longer in the organogram. Reload the page.");
  const result = await callPhoenixCrm<Row>("phoenix_crm_reverse_plan_edit_request", {
    p: { request_id: requestId, actor_hr_id: viewer.hrId, note, expected_version: expectedVersion, is_test: false },
  });
  await notifyPhoenixCrm(
    {
      kind: "plan_edit",
      org: viewer.org,
      seat,
      requestId,
      version: Number(result.version),
      weekStart: String(row.week_start),
      status: "refused",
      repHrId: String(row.rep_hr_id),
      actorHrId: viewer.hrId,
      note,
      reversed: true,
    },
    false,
  );
  return { kind: "plan_edit" as const, id: requestId, status: "refused" as const };
}

async function reverseVisit(viewer: PhoenixCrmViewer, visitId: string, note: string, expectedVersion: number) {
  const { data, error } = await getSupabaseAdmin()
    .from("phoenix_crm_unplanned_visits")
    .select("visit_id, seat_id, rep_hr_id, visit_date, clarification, is_test, customer:phoenix_crm_customers!customer_id(name)")
    .eq("visit_id", visitId)
    .maybeSingle();
  throwIfError(error);
  const row = data as Row | null;
  if (!row) throw notFoundError("This visit is no longer there. Reload the page.");
  assertAdministrator(viewer, row.is_test === true);
  const seat = viewer.org.seats.get(String(row.seat_id));
  if (!seat) throw notFoundError("This territory is no longer in the organogram. Reload the page.");
  const customer = (Array.isArray(row.customer) ? row.customer[0] : row.customer) as Row | null | undefined;
  const result = await callPhoenixCrm<Row>("phoenix_crm_reverse_unplanned_visit", {
    p: { visit_id: visitId, actor_hr_id: viewer.hrId, note, expected_version: expectedVersion, is_test: false },
  });
  await notifyPhoenixCrm(
    {
      kind: "unplanned_visit_decided",
      org: viewer.org,
      seat,
      visitId,
      version: Number(result.version),
      repHrId: String(row.rep_hr_id),
      customerName: textOrNull(customer?.name) ?? "A customer",
      visitDate: String(row.visit_date),
      status: "refused",
      deciderHrId: viewer.hrId,
      note,
      reversed: true,
      clarification: textOrNull(row.clarification),
    },
    false,
  );
  return { kind: "visit" as const, id: visitId, status: "refused" as const };
}

async function reverseRequest(viewer: PhoenixCrmViewer, requestId: string, note: string) {
  const { data, error } = await getSupabaseAdmin()
    .from("phoenix_crm_list_requests")
    .select("id, seat_id, kind, status, customer_name, proposed_grade, requested_by_hr_id, is_test")
    .eq("id", requestId)
    .maybeSingle();
  throwIfError(error);
  const row = data as Row | null;
  if (!row) throw notFoundError("This request is no longer there. Reload the page.");
  assertAdministrator(viewer, row.is_test === true);
  if (row.status !== "approved") throw conflictError("This request is not approved any more. Reload the page.");
  const seat = viewer.org.seats.get(String(row.seat_id));
  if (!seat) throw notFoundError("This territory is no longer in the organogram. Reload the page.");
  await callPhoenixCrm<Row>("phoenix_crm_reverse_list_request", {
    p: { request_id: requestId, actor_hr_id: viewer.hrId, note, is_test: false },
  });
  await notifyPhoenixCrm(
    {
      kind: "request_decided",
      seat,
      requestId,
      requestKind: requestKindOf(row.kind),
      status: "refused",
      deciderHrId: viewer.hrId,
      requesterHrId: String(row.requested_by_hr_id),
      customerName: String(row.customer_name),
      proposedGrade: textOrNull(row.proposed_grade),
      note,
      reversed: true,
    },
    false,
  );
  return { kind: "request" as const, id: requestId, status: "refused" as const };
}
