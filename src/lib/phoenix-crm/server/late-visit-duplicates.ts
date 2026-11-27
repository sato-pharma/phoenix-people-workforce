/**
 * Phoenix CRM — a filed late visit the person already logged again is closed by Phoenix as rejected, with its reason.
 *
 * Owner, 27 Nov 2026, on three "No location" visits whose reps had logged the same doctor again with location minutes
 * later: show that it happened, show it rejected and why, and never count it. The rule is pure and lives in
 * `@/lib/phoenix-crm/late-visit-rules` (`countedCopyOf`, `duplicateClosingReason`); this file is its I/O.
 *
 * 🔴 IT READS THE VISITS AND NEVER WRITES ONE. The only row it moves is the filed copy, pending → rejected, and only
 * while it is still pending, so a decision the Super Admin made in the same moment stands. A copy closed here is
 * exactly one the Approve button could only have been refused on: the missed-record door's "already visited" rule.
 *
 * 🔴 IT FAILS OPEN TO HIS DECISION. A read that does not answer leaves every row waiting, as it was before this
 * existed — never a row closed on a guess, and never a board or a badge that does not load.
 */

import {
  countedCopyOf,
  duplicateClosingReason,
  type CountedVisit,
  type LateVisitCandidate,
  type LateVisitKind,
} from "@/lib/phoenix-crm/late-visit-rules";
import { isUuid } from "@/lib/phoenix-crm/plan-rules";
import { logError } from "@/lib/observability/log";
import { loadManagerOwnVisitsOnDays } from "@/lib/phoenix-crm/server/manager-plan-readers";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";

const TABLE = "phoenix_crm_late_visits";

type Row = Record<string, unknown>;

const CAIRO_TEXT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Cairo",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function cairoText(value: string | null): string | null {
  if (!value) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : CAIRO_TEXT.format(at);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function candidateOf(row: Row): LateVisitCandidate & { id: string } {
  const kind: LateVisitKind = row.kind === "manager_single" ? "manager_single" : "territory";
  const body = (row.body && typeof row.body === "object" ? row.body : {}) as Row;
  return {
    id: String(row.id),
    kind,
    seatId: String(row.seat_id ?? ""),
    senderHrId: String(row.sender_hr_id ?? ""),
    customerId: String(row.customer_id ?? ""),
    managerCustomerId: isUuid(body.managerCustomerId) ? String(body.managerCustomerId).toLowerCase() : null,
    pressedDay: String(row.pressed_day ?? ""),
  };
}

function hasLocation(row: Row): boolean {
  return typeof row.lat === "number" && Number.isFinite(row.lat) && typeof row.lon === "number" && Number.isFinite(row.lon);
}

async function readCountedVisits(candidates: readonly LateVisitCandidate[]): Promise<CountedVisit[]> {
  const territory = candidates.filter((candidate) => candidate.kind === "territory");
  const manager = candidates.filter((candidate) => candidate.kind === "manager_single");
  const unique = (values: Array<string | null>) => [...new Set(values.filter((value): value is string => Boolean(value)))];

  const [territoryRows, managerRows] = await Promise.all([
    territory.length === 0
      ? Promise.resolve<Row[]>([])
      : fetchAllRowsKeyset<Row>(
          () =>
            getSupabaseAdmin()
              .from("phoenix_crm_visits")
              .select("id, seat_id, customer_id, visit_date, captured_at, created_at, lat, lon")
              .eq("is_test", false)
              .in("customer_id", unique(territory.map((candidate) => candidate.customerId)))
              .in("visit_date", unique(territory.map((candidate) => candidate.pressedDay))),
          { cursorColumn: "id", cursorOf: (row) => String(row.id) },
        ),
    loadManagerOwnVisitsOnDays({
      managerHrIds: manager.map((candidate) => candidate.senderHrId),
      days: manager.map((candidate) => candidate.pressedDay),
    }),
  ]);

  // A rep's visit, read here; a manager's own single visit comes through the module's adapter above.
  const counted = (row: Row): CountedVisit => ({
    kind: "territory",
    seatId: text(row.seat_id),
    managerHrId: null,
    customerId: text(row.customer_id)?.toLowerCase() ?? null,
    managerCustomerId: null,
    visitDate: String(row.visit_date ?? ""),
    loggedAt: text(row.captured_at) ?? text(row.created_at),
    withLocation: hasLocation(row),
  });
  return [
    ...territoryRows.map(counted),
    ...managerRows.map((visit): CountedVisit => ({ ...visit, kind: "manager_single", seatId: null })),
  ];
}

/**
 * Closes every waiting filed visit whose person already logged the same visit again and had it counted. Answers how
 * many it closed. Called before the Super Admin's list and the sidebar count read the waiting rows, so a copy never
 * waits for him and never pulses on the sidebar.
 */
export async function closeDuplicateLateVisits(): Promise<number> {
  try {
    const pending = await fetchAllRowsKeyset<Row>(
      () => getSupabaseAdmin().from(TABLE).select("id, kind, sender_hr_id, seat_id, customer_id, pressed_day, body").eq("status", "pending").eq("is_test", false),
      { cursorColumn: "id", cursorOf: (row) => String(row.id) },
    );
    if (pending.length === 0) return 0;
    const candidates = pending.map(candidateOf);
    const visits = await readCountedVisits(candidates);
    if (visits.length === 0) return 0;

    let closed = 0;
    for (const candidate of candidates) {
      const counted = countedCopyOf(candidate, visits);
      if (!counted) continue;
      const now = new Date().toISOString();
      const updated = await getSupabaseAdmin()
        .from(TABLE)
        .update({
          status: "rejected",
          decided_by_hr_id: null,
          decided_at: now,
          decision_reason: duplicateClosingReason(counted, cairoText(counted.loggedAt)),
          updated_at: now,
        })
        .eq("id", candidate.id)
        .eq("status", "pending")
        .select("id");
      if (updated.error) throw updated.error;
      closed += (updated.data ?? []).length;
    }
    return closed;
  } catch (error) {
    logError("Phoenix CRM could not close the late visits already logged again", {
      error,
      labels: { event: "phoenix_crm_late_visit_duplicates_failed" },
    });
    return 0;
  }
}
