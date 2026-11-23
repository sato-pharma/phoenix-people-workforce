/**
 * Phoenix CRM — keeping the system's advice beside a place-check decision, and reading the 30-day
 * agreement back (the rebuild, 23 Nov 2026; rule and wording in `place-check-stored-advice.ts`).
 *
 * 🔴 KEPT ON THE FIRST DECISION OF A WAITING ROW ONLY. A take-back, and a rejection approved after all,
 * change the outcome and never the advice: the write below lands only where nothing is kept yet.
 *
 * 🔴 A WRITE THAT FAILS LOSES ONE COUNT AND NOTHING ELSE. The decision is already committed when this
 * runs, so it never throws and never undoes anything; the failure is logged.
 */

import { logError } from "@/lib/observability/log";
import type { PlaceCheckAdvice } from "@/lib/phoenix-crm/place-check-advice";
import {
  AGREEMENT_WINDOW_DAYS,
  placeCheckAgreement,
  storedAdviceOf,
  type AgreementDecision,
  type PlaceCheckAgreement,
} from "@/lib/phoenix-crm/place-check-stored-advice";
import { readEveryPage } from "@/lib/phoenix-crm/server/paged-read";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

/** A bound on memory: far above a month of decisions (2,426 reviews in the module's first two months). */
const AGREEMENT_READ_MAX = 20_000;

async function keepQuietly(table: "phoenix_crm_validation_reviews" | "phoenix_crm_shared_places", id: string, advice: PlaceCheckAdvice | null): Promise<void> {
  if (!advice) return;
  try {
    const { error } = await getSupabaseAdmin().from(table).update(storedAdviceOf(advice)).eq("id", id).is("system_advice_at_decision", null);
    if (error) throw error;
  } catch (error) {
    logError("Phoenix CRM place-check advice was not kept with its decision", {
      error,
      labels: { event: "phoenix_crm_place_check_advice_not_kept" },
      context: { table },
    });
  }
}

/** The advice a waiting review carried, kept once it is decided. Null (it was not waiting) keeps nothing. */
export function keepReviewAdviceQuietly(reviewId: string, advice: PlaceCheckAdvice | null): Promise<void> {
  return keepQuietly("phoenix_crm_validation_reviews", reviewId, advice);
}

/** The same for a held building. */
export function keepBuildingAdviceQuietly(sharedPlaceId: string, advice: PlaceCheckAdvice | null): Promise<void> {
  return keepQuietly("phoenix_crm_shared_places", sharedPlaceId, advice);
}

/**
 * Every decision of the last 30 days that kept an advice, reviews and buildings together, reduced to the
 * page's meter. Test entries are nowhere in it. Throws when either read fails: the page then says the
 * count could not be read, never a share of part of it.
 */
export async function loadPlaceCheckAgreement(now: number = Date.now()): Promise<PlaceCheckAgreement> {
  const since = new Date(now - AGREEMENT_WINDOW_DAYS * 86_400_000).toISOString();
  const [reviews, buildings] = await Promise.all([
    readEveryPage<Row>(
      () =>
        getSupabaseAdmin()
          .from("phoenix_crm_validation_reviews")
          .select("id, status, system_advice_at_decision, system_advice_code_at_decision, system_approved_rule")
          .not("system_advice_at_decision", "is", null)
          .in("status", ["approved", "rejected"])
          .eq("is_test", false)
          .gte("decided_at", since)
          .order("decided_at", { ascending: true })
          .order("id", { ascending: true }),
      { maxRows: AGREEMENT_READ_MAX, whenFull: "refuse", what: "Phoenix CRM place-check decisions with advice" },
    ),
    readEveryPage<Row>(
      () =>
        getSupabaseAdmin()
          .from("phoenix_crm_shared_places")
          .select("id, status, system_advice_at_decision, system_advice_code_at_decision")
          .not("system_advice_at_decision", "is", null)
          .in("status", ["active", "retired"])
          .eq("is_test", false)
          .gte("decided_at", since)
          .order("decided_at", { ascending: true })
          .order("id", { ascending: true }),
      { maxRows: AGREEMENT_READ_MAX, whenFull: "refuse", what: "Phoenix CRM building decisions with advice" },
    ),
  ]);
  if (reviews.error) throw reviews.error;
  if (buildings.error) throw buildings.error;
  const text = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : null);
  const decisions: AgreementDecision[] = [
    ...reviews.rows.map((row) => ({
      advice: text(row.system_advice_at_decision),
      code: text(row.system_advice_code_at_decision),
      outcome: row.status === "approved" ? ("approved" as const) : ("rejected" as const),
      bySystem: text(row.system_approved_rule) !== null,
    })),
    // A building in use was approved; a retired one was rejected. No building is approved by the system.
    ...buildings.rows.map((row) => ({
      advice: text(row.system_advice_at_decision),
      code: text(row.system_advice_code_at_decision),
      outcome: row.status === "active" ? ("approved" as const) : ("rejected" as const),
      bySystem: false,
    })),
  ];
  return placeCheckAgreement(decisions);
}
