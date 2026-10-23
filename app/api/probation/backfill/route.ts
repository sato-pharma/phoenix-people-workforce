import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { isProbationAdministrator } from "@/lib/probation/service";
import { runProbationCaseBackfill } from "@/lib/probation/intelligence/backfill";
import { syncProbationDvDays } from "@/lib/probation/intelligence/dv-sync";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The recurring iReports360 cron only ingests the last ~10 days of double-visits, so a rep hired 70
// days ago would launch scored on near-empty evidence. This one-time window covers the full 90-day
// probation span so every in-window case is reconstructed from its real DV history at go-live.
const HISTORY_LOOKBACK_DAYS = 95;

// Go-live backfill: provision probation cases for employees already inside their 90-day window (the
// hire trigger only fires for FUTURE inserts, so existing probationers would otherwise have no case),
// then run a one-time historical DV sync so those cases are scored on full evidence. Dry-run by
// default — pass { confirm: true } to write. Probation-administrator only; both steps are idempotent.
export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "probation", "update");
    if (!isProbationAdministrator(access)) {
      return NextResponse.json({ error: "Forbidden: the probation backfill is restricted to probation administrators." }, { status: 403 });
    }

    const body = await request.json().catch(() => ({}));
    const confirm = body?.confirm === true;
    const actor = access.loginId ?? access.hrId ?? access.role;

    const report = await runProbationCaseBackfill({ dryRun: !confirm, actor });

    // After provisioning cases (write mode only), reconstruct each case's full DV history once so the
    // launch cohort isn't scored on just the recurring cron's 10-day window. Idempotent (safe to re-run).
    let dvHistory: { window: { dateFrom: string; dateTo: string }; inserted: number; detected: number } | null = null;
    if (confirm) {
      const now = new Date();
      const dateTo = now.toISOString().slice(0, 10);
      const dateFrom = new Date(now.getTime() - HISTORY_LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
      const sync = await syncProbationDvDays(getSupabaseAdmin(), { dateFrom, dateTo });
      dvHistory = { window: sync.window, inserted: sync.inserted, detected: sync.detected };
    }

    return NextResponse.json({ report, dvHistory }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (isForbiddenError(error)) return NextResponse.json({ error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
    return NextResponse.json({ error: String((error as { message?: unknown })?.message ?? error) }, { status: 500 });
  }
}
