/**
 * Phoenix CRM — what a week's sends kept, read for the review (owner, 2026-10-02).
 *
 * Every send keeps what was sent on its own 'submitted' plan event (supabase/migrations/
 * 20261002120049_phoenix_crm_plan_review.sql). This reads those events, newest first, for the weeks a
 * reviewer is about to decide; plan-review-rules.ts `sentChangesOf` compares the last two, so a week
 * that comes back after a return or an acknowledged edit shows only what changed since the send
 * before it. Read only for the people who decide the week — never for the rep.
 */

import type { SentEvent } from "@/lib/phoenix-crm/plan-review-rules";
import { chunk, textOrNull, throwIfError } from "@/lib/phoenix-crm/server/db";
import { mapWithConcurrency } from "@/lib/reconciliation/concurrency";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

/** Each plan's 'submitted' events, newest first. A plan never sent has none. */
export async function loadPlanSends(planIds: ReadonlyArray<string>): Promise<Map<string, SentEvent[]>> {
  const sends = new Map<string, SentEvent[]>();
  const ids = [...new Set(planIds)];
  if (ids.length === 0) return sends;
  // Four chunks at a time, merged in chunk order (2 Nov 2026, the speed root cause): a reviewer's month
  // board read the chunks one after another.
  const answers = await mapWithConcurrency(chunk(ids, 50), 4, async (batch) =>
    getSupabaseAdmin()
      .from("phoenix_crm_plan_events")
      .select("id, plan_id, details, created_at")
      .in("plan_id", batch)
      .eq("event_type", "submitted")
      .order("created_at", { ascending: false })
      .order("id", { ascending: false }),
  );
  for (const { data, error } of answers) {
    throwIfError(error);
    for (const row of (data ?? []) as Row[]) {
      const planId = String(row.plan_id);
      const list = sends.get(planId) ?? [];
      list.push({ sentAt: textOrNull(row.created_at), details: row.details ?? null });
      sends.set(planId, list);
    }
  }
  return sends;
}
