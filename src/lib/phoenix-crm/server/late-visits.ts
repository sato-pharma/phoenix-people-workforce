/**
 * Phoenix CRM — a held visit that missed its window: filed by the phone, decided by the Super Admin alone.
 *
 * Owner, 24 Nov 2026: "never any visit to be lost from either a rep or from the manager", and on the visit a phone
 * held past two hours or across 02:00: "SUPER ADMIN APPROVE IT ONLY SUPER ADMIN". The rules are pure and live in
 * `@/lib/phoenix-crm/late-visit-rules`; this file is their I/O.
 *
 * 🔴 A FILED VISIT COUNTS IN NOTHING. It is a row in its own table that no figure, board or notice reads. Approving it
 * goes through the SAME door that enters a missed record (`enterMissedVisit`, `enterManagerMissedVisit`), so every
 * rule that door keeps — one visit a customer a day, a leaver's day refused, the line's products, an off-plan visit
 * raising its manager-then-SFE approval — holds here too, and a refusal is that door's own sentence.
 *
 * 🔴 THE PERSON COMES FROM THE SESSION, NEVER THE BODY, and an id another person filed is never overwritten.
 */

import { conflictError, forbiddenError, notFoundError, validationError } from "@/lib/http/api-errors";
import {
  managerApprovalBody,
  parseLateVisitFiling,
  pressedWithNoLocation,
  territoryApprovalBody,
  type LateVisitItem,
  type LateVisitKind,
  type LateVisitsBoard,
  type LateVisitStatus,
} from "@/lib/phoenix-crm/late-visit-rules";
import { isUuid } from "@/lib/phoenix-crm/plan-rules";
import { managersInScope, personKey, territoryName } from "@/lib/phoenix-crm/scope";
import { productManagerRowKey } from "@/lib/phoenix-crm/team-calendar";
import { canEnterMissedRecords, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { enterManagerMissedVisit } from "@/lib/phoenix-crm/server/manager-missed-records";
import { enterMissedVisit } from "@/lib/phoenix-crm/server/missed-records";
import { loadPeopleNames } from "@/lib/phoenix-crm/server/people";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";

const TABLE = "phoenix_crm_late_visits";
const COLUMNS =
  "id, kind, sender_hr_id, seat_id, customer_id, customer_name, pressed_at_device, pressed_day, arrived_at, body, status, decided_by_hr_id, decided_at, approved_visit_id";
/** How far back the decided list reaches. The pending list has no limit: nothing waiting is ever hidden. */
const DECIDED_SHOWN_DAYS = 30;

type Row = Record<string, unknown>;

// ── The phone files one ─────────────────────────────────────────────────────────────────────────

/**
 * Files one held visit that missed its window. Answers when it is on file; throws when it is not, and the phone then
 * keeps it as it did before this existed. Filing the same visit twice answers the same.
 */
export async function fileLateVisit(viewer: Pick<PhoenixCrmViewer, "hrId" | "config" | "isTestPersona">, raw: unknown): Promise<{ filed: true }> {
  const sender = personKey(viewer.hrId);
  if (!sender) throw forbiddenError();
  // A test persona's visit has no real day to be entered on; its phone keeps it as it always did.
  if (viewer.isTestPersona) throw conflictError("Not filed.", "late_visit_not_filed");
  if (!viewer.config.settings.visitResendEnabled) throw conflictError("Not filed.", "late_visit_not_filed");
  const parsed = parseLateVisitFiling(raw);
  if (!parsed.ok) throw validationError(parsed.error);
  const filing = parsed.value;

  const supabase = getSupabaseAdmin();
  const inserted = await supabase.from(TABLE).upsert(
    {
      id: filing.id,
      kind: filing.kind,
      sender_hr_id: sender,
      seat_id: filing.seatId,
      customer_id: filing.customerId,
      customer_name: filing.customerName,
      pressed_at_device: filing.pressedAtDevice,
      pressed_day: filing.pressedDay,
      body: filing.body,
      is_test: false,
    },
    { onConflict: "id", ignoreDuplicates: true },
  );
  if (inserted.error) throw new Error(inserted.error.message);
  // Read back: on file only when it is THIS person's. An id somebody else filed is answered as not filed.
  const mine = await supabase.from(TABLE).select("id").eq("id", filing.id).eq("sender_hr_id", sender);
  if (mine.error) throw new Error(mine.error.message);
  if ((mine.data ?? []).length === 0) throw conflictError("Not filed.", "late_visit_not_filed");
  return { filed: true };
}

// ── The Super Admin's list ──────────────────────────────────────────────────────────────────────

const CAIRO_TEXT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Cairo",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function cairoText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : CAIRO_TEXT.format(at);
}

function assertSuperAdmin(viewer: PhoenixCrmViewer): void {
  if (!canEnterMissedRecords(viewer)) throw forbiddenError("Only the Super Admin decides a visit that reached Phoenix late.");
}

function visitLabelOf(kind: LateVisitKind, body: Row): string {
  if (kind === "manager_single") return "Own single visit";
  return body.visitType === "out_of_plan" || body.visitType === "out_of_list" ? "Off plan" : "Planned";
}

export async function loadLateVisits(viewer: PhoenixCrmViewer): Promise<LateVisitsBoard> {
  assertSuperAdmin(viewer);
  const since = new Date(Date.now() - DECIDED_SHOWN_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const [pendingRows, decidedRows] = await Promise.all([
    fetchAllRowsKeyset<Row>(() => getSupabaseAdmin().from(TABLE).select(COLUMNS).eq("status", "pending").eq("is_test", false), {
      cursorColumn: "id",
      cursorOf: (row) => String(row.id),
    }),
    fetchAllRowsKeyset<Row>(() => getSupabaseAdmin().from(TABLE).select(COLUMNS).neq("status", "pending").eq("is_test", false).gte("decided_at", since), {
      cursorColumn: "id",
      cursorOf: (row) => String(row.id),
    }),
  ]);
  const names = await loadPeopleNames([...pendingRows, ...decidedRows].flatMap((row) => [String(row.sender_hr_id ?? ""), String(row.decided_by_hr_id ?? "")]));
  const item = (row: Row): LateVisitItem => {
    const kind: LateVisitKind = row.kind === "manager_single" ? "manager_single" : "territory";
    const body = (row.body && typeof row.body === "object" ? row.body : {}) as Row;
    const seat = viewer.org.seats.get(String(row.seat_id ?? ""));
    const sender = String(row.sender_hr_id ?? "");
    const decider = typeof row.decided_by_hr_id === "string" ? row.decided_by_hr_id : null;
    return {
      id: String(row.id),
      kind,
      senderName: names.get(personKey(sender) ?? "") ?? sender,
      territoryName: seat ? territoryName(seat) : kind === "manager_single" ? "Own list" : "Territory",
      customerName: String(row.customer_name ?? "Customer"),
      pressedDay: String(row.pressed_day ?? ""),
      pressedAtText: cairoText(row.pressed_at_device),
      arrivedAtText: cairoText(row.arrived_at) ?? "",
      visitLabel: visitLabelOf(kind, body),
      withoutLocation: pressedWithNoLocation(kind, body),
      products: Array.isArray(body.products) ? body.products.filter((entry): entry is string => typeof entry === "string") : [],
      comment: typeof body.comment === "string" && body.comment.trim() ? body.comment.trim() : null,
      status: row.status === "approved" ? "approved" : row.status === "rejected" ? "rejected" : "pending",
      decidedByName: decider ? (names.get(personKey(decider) ?? "") ?? decider) : null,
      decidedAtText: cairoText(row.decided_at),
    };
  };
  const byArrival = (left: Row, right: Row) => String(right.arrived_at ?? "").localeCompare(String(left.arrived_at ?? ""));
  return { pending: [...pendingRows].sort(byArrival).map(item), decided: [...decidedRows].sort(byArrival).map(item) };
}

// ── His decision ────────────────────────────────────────────────────────────────────────────────

/** The calendar row key the manager door takes: his seat, or his product-manager row. */
function managerKeyOf(viewer: PhoenixCrmViewer, managerHrId: string): string {
  const key = personKey(managerHrId);
  const seat = managersInScope(viewer.org, viewer.hrId, viewer.basis).find((member) => personKey(member.hrId) === key)?.seat.seatId;
  return seat ?? productManagerRowKey(managerHrId);
}

export async function decideLateVisit(viewer: PhoenixCrmViewer, raw: unknown): Promise<{ status: Exclude<LateVisitStatus, "pending"> }> {
  assertSuperAdmin(viewer);
  const input = (raw && typeof raw === "object" ? raw : {}) as Row;
  if (!isUuid(input.id)) throw validationError("Reload the page and choose the visit again.");
  const decision = input.decision === "approve" ? "approve" : input.decision === "reject" ? "reject" : null;
  if (!decision) throw validationError("Choose approve or reject.");
  const id = String(input.id).toLowerCase();

  const supabase = getSupabaseAdmin();
  const read = await supabase.from(TABLE).select(COLUMNS).eq("id", id).eq("is_test", false);
  if (read.error) throw new Error(read.error.message);
  const row = (read.data ?? [])[0] as Row | undefined;
  if (!row) throw notFoundError("This visit is no longer waiting. Reload the page.");
  if (row.status !== "pending") throw conflictError("This visit was already decided. Reload the page.", "late_visit_decided");

  let approvedVisitId: string | null = null;
  if (decision === "approve") {
    const body = (row.body && typeof row.body === "object" ? row.body : {}) as Row;
    const pressedDay = String(row.pressed_day);
    const pressedAtDevice = typeof row.pressed_at_device === "string" ? row.pressed_at_device : null;
    if (row.kind === "manager_single") {
      await enterManagerMissedVisit(viewer, managerApprovalBody({ id, managerKey: managerKeyOf(viewer, String(row.sender_hr_id)), pressedDay, pressedAtDevice, body }));
    } else {
      const seat = viewer.org.seats.get(String(row.seat_id));
      const saved = await enterMissedVisit(
        viewer,
        territoryApprovalBody({
          id,
          seatId: String(row.seat_id),
          customerId: String(row.customer_id),
          pressedDay,
          pressedAtDevice,
          senderHrId: String(row.sender_hr_id),
          repHrId: seat?.occupantHrId ?? "",
          body,
        }),
      );
      approvedVisitId = saved.visitId;
    }
  }

  const now = new Date().toISOString();
  const status = decision === "approve" ? "approved" : "rejected";
  const updated = await supabase
    .from(TABLE)
    .update({ status, decided_by_hr_id: personKey(viewer.hrId), decided_at: now, approved_visit_id: approvedVisitId, updated_at: now })
    .eq("id", id)
    .eq("status", "pending")
    .select("id");
  if (updated.error) throw new Error(updated.error.message);
  // An approval already entered stands, and entering it again answers as the same visit: a lost decision is redone safely.
  if ((updated.data ?? []).length === 0) throw conflictError("This visit was already decided. Reload the page.", "late_visit_decided");
  return { status };
}
