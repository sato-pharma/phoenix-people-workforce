import { namesByHrId } from "@/lib/employees/names-by-hr-id";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import type { DisputeCaseEvent, DisputeCaseEventType, DisputeCaseKind } from "./types.ts";

// The history of a dispute — every decision, every reopen request and reopening, every refund — in
// `dispute_case_events`, which is append-only in the database itself (a trigger refuses UPDATE and
// DELETE). It is what makes "everything is saved, nothing disappears" true across a reopen: the
// module's own row is overwritten by the next decision, the history row never is.

type EventRow = {
  actor_hr_id: string | null;
  actor_role: string | null;
  case_kind: DisputeCaseKind;
  case_ref: string;
  created_at: string;
  details: Record<string, unknown> | null;
  event_type: DisputeCaseEventType;
  id: string;
  note: string | null;
};

const EVENT_COLUMNS = "id, case_kind, case_ref, event_type, actor_hr_id, actor_role, note, details, created_at";

function isMissingTable(error: unknown): boolean {
  const code = String((error as { code?: unknown } | null)?.code ?? "");
  const message = String((error as { message?: unknown } | null)?.message ?? "").toLowerCase();
  return code === "PGRST205" || code === "42P01" || message.includes("could not find the table");
}

/** Full names for HR ids, keyed by canonical key. Best-effort: a failed read leaves names null. */
export async function resolvePeopleNames(hrIds: Array<string | null | undefined>): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  // Display names: everything this map feeds is a screen or a notification (owner, 2026-11-03).
  const index = await namesByHrId(hrIds);
  for (const id of hrIds) {
    const key = canonicalHrIdKey(id);
    const name = index.get(id);
    if (key && name) names.set(key, name);
  }
  return names;
}

export function nameFor(names: Map<string, string>, hrId: string | null | undefined): string | null {
  const key = canonicalHrIdKey(hrId);
  return key ? names.get(key) ?? null : null;
}

/** One event to write — what `recordCaseEvent` takes, and what `recordCaseEvents` writes several of at once. */
export type CaseEventInput = {
  kind: DisputeCaseKind;
  ref: string;
  eventType: DisputeCaseEventType;
  actorHrId: string | null;
  actorRole: string | null;
  note?: string | null;
  details?: Record<string, unknown>;
};

function eventInsertRow(input: CaseEventInput) {
  return {
    actor_hr_id: input.actorHrId,
    actor_role: input.actorRole,
    case_kind: input.kind,
    case_ref: input.ref,
    details: input.details ?? {},
    event_type: input.eventType,
    note: input.note?.trim() || null,
  };
}

/**
 * Several events in ONE insert — all of them land, or none. A dispute decision writes its refund
 * events and its "decided" event together as its last write (F-PAY-005): the events table is
 * append-only, so an event written before a later step failed could never be taken back.
 */
export async function recordCaseEvents(inputs: CaseEventInput[]): Promise<void> {
  if (inputs.length === 0) return;
  const { error } = await getSupabaseAdmin().from("dispute_case_events").insert(inputs.map(eventInsertRow));
  if (error) throw error;
}

export async function recordCaseEvent(input: CaseEventInput): Promise<DisputeCaseEvent> {
  const { data, error } = await getSupabaseAdmin()
    .from("dispute_case_events")
    .insert(eventInsertRow(input))
    .select(EVENT_COLUMNS)
    .single();
  if (error) throw error;
  const row = data as EventRow;
  const names = await resolvePeopleNames([row.actor_hr_id]);
  return mapEvent(row, names);
}

function mapEvent(row: EventRow, names: Map<string, string>): DisputeCaseEvent {
  return {
    actorHrId: row.actor_hr_id,
    actorName: nameFor(names, row.actor_hr_id),
    actorRole: row.actor_role,
    createdAt: row.created_at,
    details: row.details ?? {},
    eventType: row.event_type,
    id: row.id,
    note: row.note,
  };
}

function compareEventsOldestFirst(left: DisputeCaseEvent, right: DisputeCaseEvent): number {
  const byTime = (Date.parse(left.createdAt) || 0) - (Date.parse(right.createdAt) || 0);
  if (byTime !== 0) return byTime;
  return Number(left.eventType === "decided") - Number(right.eventType === "decided");
}

/**
 * Every event for a set of cases of one kind, oldest first, keyed by case ref. One read for a whole
 * inbox. A table not yet migrated reads as no history rather than failing the screen.
 */
export async function listCaseEvents(kind: DisputeCaseKind, refs: string[]): Promise<Map<string, DisputeCaseEvent[]>> {
  const byRef = new Map<string, DisputeCaseEvent[]>();
  const ids = Array.from(new Set(refs.filter(Boolean)));
  if (ids.length === 0) return byRef;
  const rows: EventRow[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    // Every event of this batch of cases, page by page: a batch of 200 cases holds more than a
    // thousand events once each has a few, and a case missing its history would read as untouched.
    try {
      rows.push(
        ...(await fetchAllRows<EventRow>(
          () =>
            getSupabaseAdmin()
              .from("dispute_case_events")
              .select(EVENT_COLUMNS)
              .eq("case_kind", kind)
              .in("case_ref", ids.slice(i, i + 200))
              .order("created_at", { ascending: true }),
          "id",
        )),
      );
    } catch (error) {
      if (isMissingTable(error)) return byRef;
      throw error;
    }
  }
  const names = await resolvePeopleNames(rows.map((row) => row.actor_hr_id));
  for (const row of rows) {
    const list = byRef.get(row.case_ref) ?? [];
    list.push(mapEvent(row, names));
    byRef.set(row.case_ref, list);
  }
  // Events written by one insert share one timestamp (recordCaseEvents). Oldest first, and within one
  // moment the "decided" event last — it is the one a decision writes after its refunds.
  for (const list of byRef.values()) list.sort(compareEventsOldestFirst);
  return byRef;
}
