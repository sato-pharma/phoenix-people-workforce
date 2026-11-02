/**
 * Phoenix CRM — what a plan says about ONE day, for every reader that asks "is this day on a sent
 * plan" (owner, 2026-10-02, "Still planned").
 *
 * The rule is pure and lives in plan-rules.ts (`planDayStatus`): a week returned for ONE day still
 * stands on its other days as it stood when the day was returned, and only that day waits for the rep
 * to send the week again. This reads the two facts the rule needs beyond the plan row — and only for a
 * week returned for one day, so every other plan costs nothing more than the row its reader already
 * has:
 *
 *   - whether an edit request was acknowledged AFTER the return, which opens the whole week to the rep
 *     (plan-rules.ts `standingReturnedDay`), so no day of it is authority any more;
 *   - what the week was when the day was returned — its return event's `from_status` — so a week
 *     approved before the return is still approved on its other days (Today shows the approved plan
 *     only).
 *
 * The readers: the rep's Planned visit list and Today (visits.ts `plannedCustomersOn`), the Super
 * Admin's missed record, the Team tab's day line and the frequency report's planned days. The save
 * itself asks the same question in the database (phoenix_crm_save_visit), so none of them can disagree
 * with the stamp a visit gets.
 */

import { standingReturnedDay } from "@/lib/phoenix-crm/plan-rules";
import { chunk, textOrNull, throwIfError } from "@/lib/phoenix-crm/server/db";
import { editAcknowledgedAt, loadPlanEditState } from "@/lib/phoenix-crm/server/plan-edits";
import type { PhoenixCrmPlanStatus } from "@/lib/phoenix-crm/types";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { mapWithConcurrency } from "@/lib/reconciliation/concurrency";

type Row = Record<string, unknown>;

/** The plan row's columns the rule reads, beside the reader's own `id`. */
export const PLAN_DAY_COLUMNS = "status, returned_day, decided_at";

/** Every status a plan holding a sent day can have: sent, approved, and returned for ONE day. */
export const PLAN_STATUSES_WITH_SENT_DAYS: ReadonlyArray<PhoenixCrmPlanStatus> = ["submitted", "approved", "returned"];

/** One plan, as `planDayStatus` reads it — add the day and ask. */
export type PlanDayFacts = {
  status: PhoenixCrmPlanStatus | null;
  /** The STANDING one-day return, or null. */
  returnedDay: string | null;
  /** What the week was when its one day was returned; null when no day stands returned. */
  returnedFrom: PhoenixCrmPlanStatus | null;
};

function planStatusOf(value: unknown): PhoenixCrmPlanStatus | null {
  return value === "draft" || value === "submitted" || value === "approved" || value === "returned" ? value : null;
}

/**
 * Per plan id: its facts. `rows` carry `id` and `PLAN_DAY_COLUMNS`.
 *
 * A caller that already holds the plans' edit requests and their 'returned' events — the planned-day
 * bundle (visits.ts `loadPlannedDay`, 2 Nov 2026) reads them in the same statement as the plan — hands
 * them in as `edits` and `returns`, and the rule is asked with no read of its own. `returns` must be
 * newest first (created_at, then id), the order `loadReturnedFrom` reads them in.
 */
export async function loadPlanDayFacts(
  rows: ReadonlyArray<Row>,
  isTest: boolean,
  options: { edits?: ReadonlyArray<Row>; returns?: ReadonlyArray<Row> } = {},
): Promise<Map<string, PlanDayFacts>> {
  const facts = new Map<string, PlanDayFacts>();
  const oneDay: Row[] = [];
  for (const row of rows) {
    const status = planStatusOf(row.status);
    const storedDay = status === "returned" ? textOrNull(row.returned_day) : null;
    facts.set(String(row.id), { status, returnedDay: storedDay, returnedFrom: null });
    if (storedDay) oneDay.push(row);
  }
  if (oneDay.length === 0) return facts;

  const ids = oneDay.map((row) => String(row.id));
  const [edits, returnedFrom] = await Promise.all([
    loadPlanEditState(ids, isTest, { names: false, rows: options.edits }),
    options.returns ? foldReturnedFrom(options.returns) : loadReturnedFrom(ids),
  ]);
  for (const row of oneDay) {
    const id = String(row.id);
    const entry = facts.get(id);
    if (!entry) continue;
    const returnedDay = standingReturnedDay({
      status: entry.status,
      returnedDay: entry.returnedDay,
      decidedAt: textOrNull(row.decided_at),
      editAcknowledgedAt: editAcknowledgedAt(edits.get(id) ?? null),
    });
    facts.set(id, { status: entry.status, returnedDay, returnedFrom: returnedDay ? (returnedFrom.get(id) ?? null) : null });
  }
  return facts;
}

/**
 * What each plan was when it was last returned — its latest RETURN event's `from_status`.
 *
 * 🔴 The return EVENT, never the latest event with `to_status` 'returned'. A plan save writes a 'saved'
 * event with `from_status` = `to_status` = the plan's status, so once the rep saves his returned day the
 * newest 'returned' row is a save that reads "returned from returned" — and an approved week's other
 * days would lose their approval on Today. Found 2026-10-02, before any plan was returned on production.
 */
async function loadReturnedFrom(planIds: ReadonlyArray<string>): Promise<Map<string, PhoenixCrmPlanStatus | null>> {
  // Four chunks at a time, merged in chunk order (2026-10-31, "fix the slowest five pages"): on a wide scope the chunks
  // were read one after another.
  const answers = await mapWithConcurrency(chunk([...planIds], 50), 4, async (batch) =>
    getSupabaseAdmin()
      .from("phoenix_crm_plan_events")
      .select("plan_id, from_status")
      .in("plan_id", batch)
      .eq("event_type", "returned")
      .order("created_at", { ascending: false })
      .order("id", { ascending: false }),
  );
  const rows: Row[] = [];
  for (const { data, error } of answers) {
    throwIfError(error);
    rows.push(...((data ?? []) as Row[]));
  }
  return foldReturnedFrom(rows);
}

/** The first 'returned' event seen per plan wins — so `rows` are newest first, the read's own order. */
export function foldReturnedFrom(rows: ReadonlyArray<Row>): Map<string, PhoenixCrmPlanStatus | null> {
  const out = new Map<string, PhoenixCrmPlanStatus | null>();
  for (const row of rows) {
    const id = String(row.plan_id);
    if (!out.has(id)) out.set(id, planStatusOf(row.from_status));
  }
  return out;
}
