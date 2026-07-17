// Per-recipient daily cap for probation notifications (MOD-3, owner request 2026-07-17).
//
// A manager/employee receives at most PROBATION_DAILY_NOTIFICATION_CAP probation notification
// EVENTS per Cairo day — an event that fans to email + in-app + Telegram counts as ONE. Overflow
// is simply NOT sent this run; because the probation sweeps (weekly DV digest, Day 30/60/75
// milestones, SLA reminders) are all idempotent per (event, recipient), the next day's sweep
// re-emits when the recipient is back under the cap. This is why "defer to next day" needs no
// deferred-delivery machinery here.
//
// The System Admin account (PHX-1) is EXEMPT — it must receive every probation notification for
// oversight. The cap is a courtesy backstop, so it FAILS OPEN: any query error yields a cap that
// allows everything rather than silently dropping legitimate mail.

import { normalizeHrId } from "@/lib/auth/permissions";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export const PROBATION_DAILY_NOTIFICATION_CAP = 2;
// Accounts exempt from the cap. PHX-1 is the "Phoenix System Administrator" oversight account.
export const CAP_EXEMPT_HR_IDS = ["PHX-1"];

const CAIRO_TZ = "Africa/Cairo";

/** Cairo-local calendar date (YYYY-MM-DD) for an instant. en-CA formats as ISO date parts. */
function cairoDateKey(when: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: CAIRO_TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(when);
}

export type ProbationDailyCap = {
  readonly cairoDate: string;
  /**
   * True if `recipientHrId` may receive one more probation notification event today. Increments an
   * in-memory within-run tally when it returns true. Exempt accounts always return true and are
   * never counted. Synchronous by design — safe to call while building each event's recipient set
   * inside the sweeps' Promise.all fan-out (JS runs the synchronous portions in order, no race).
   */
  allow(recipientHrId: string | null | undefined): boolean;
};

/**
 * Pure, DB-free cap gate over a pre-loaded per-recipient baseline. Extracted so the exempt/counting
 * logic is unit-testable without a live Supabase. `baseline` holds today's already-sent event count
 * per normalized HR_ID; `exemptHrIds` never count and always pass.
 */
export function createCapGate(
  cairoDate: string,
  baseline: Map<string, number>,
  exemptHrIds: string[] = CAP_EXEMPT_HR_IDS,
): ProbationDailyCap {
  const exempt = new Set(exemptHrIds.map((h) => normalizeHrId(h)).filter(Boolean) as string[]);
  const withinRun = new Map<string, number>();
  return {
    cairoDate,
    allow(recipientHrId) {
      const hr = normalizeHrId(recipientHrId);
      if (!hr) return false;
      if (exempt.has(hr)) return true;
      const used = (baseline.get(hr) ?? 0) + (withinRun.get(hr) ?? 0);
      if (used >= PROBATION_DAILY_NOTIFICATION_CAP) return false;
      withinRun.set(hr, (withinRun.get(hr) ?? 0) + 1);
      return true;
    },
  };
}

/**
 * Load today's per-recipient probation notification counts and return a stateful cap gate.
 * Counts DISTINCT probation notification events per recipient for the current Cairo day.
 */
export async function createProbationDailyCap(now: Date = new Date()): Promise<ProbationDailyCap> {
  const cairoDate = cairoDateKey(now);
  const baseline = new Map<string, number>();

  try {
    const supabase = getSupabaseAdmin();
    // A generous UTC lower bound (36h back) that safely covers any Cairo day; the exact Cairo-day
    // match is applied in JS below, so we never have to compute the tz boundary in SQL.
    const sinceIso = new Date(now.getTime() - 36 * 60 * 60 * 1000).toISOString();
    const { data: events } = await supabase
      .from("notification_events")
      .select("id, created_at")
      .eq("module", "probation")
      .gte("created_at", sinceIso);

    const todayEventIds = ((events ?? []) as Array<{ id: string; created_at: string }>)
      .filter((e) => cairoDateKey(new Date(e.created_at)) === cairoDate)
      .map((e) => e.id);

    if (todayEventIds.length > 0) {
      const { data: deliveries } = await supabase
        .from("notification_deliveries")
        .select("notification_event_id, recipient_hr_id")
        .in("notification_event_id", todayEventIds);

      // Count DISTINCT events per recipient (email+in_app+telegram of one event are separate
      // delivery rows but must count as a single notification toward the cap).
      const seen = new Map<string, Set<string>>();
      for (const row of (deliveries ?? []) as Array<{ notification_event_id: string; recipient_hr_id: string | null }>) {
        const hr = normalizeHrId(row.recipient_hr_id);
        if (!hr) continue;
        let set = seen.get(hr);
        if (!set) { set = new Set(); seen.set(hr, set); }
        set.add(row.notification_event_id);
      }
      for (const [hr, set] of seen) baseline.set(hr, set.size);
    }
  } catch {
    // Fail open — a transient DB error must never suppress probation mail.
    return { cairoDate, allow: () => true };
  }

  return createCapGate(cairoDate, baseline);
}
