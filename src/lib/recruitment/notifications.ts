// Recruitment / ATS — scheduled work. Composed into the single daily cron
// (app/api/notifications/daily) — do NOT add a new Vercel cron (Hobby limit = 2).
//
// Phase 1: reflect candidate offer decisions onto linked applications so the
// pipeline stays in sync even without a manual UI action.

import { reconcileOfferStatuses } from "@/lib/recruitment/applications";

export type RecruitmentDailyResult =
  | { ok: true; reconciledOffers: number }
  | { ok: false; reconciledOffers: 0; error: string };

export async function runRecruitmentDailyNotifications(): Promise<RecruitmentDailyResult> {
  try {
    const reconciledOffers = await reconcileOfferStatuses();
    return { ok: true, reconciledOffers };
  } catch (error) {
    return {
      ok: false,
      reconciledOffers: 0,
      error: error instanceof Error ? error.message : "Recruitment daily processing failed.",
    };
  }
}
