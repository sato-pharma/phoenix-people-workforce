// "Sync now" for the CRM first-visit / Early Birds boards.
//
// SCOPE NOTE — read before "optimising" this. `syncIReports360Visits` takes a DATE RANGE, not a
// roster: it mirrors the whole company-day from iReports360. "Scoped to your own team" is a READ
// guarantee delivered by getNsmCrmCompliance / the Early Birds scope resolver, not a write one.
// There is no per-roster vendor fetch to narrow this to, which is exactly why the global rate-limit
// bucket below exists — the work is shared, so the cost must be shared too.
//
// The client posts an EMPTY body. A `scope` field would let a District Manager claim "line".
import { NextResponse } from "next/server";

import { cairoTodayIso } from "@/lib/crm/dates";
import { syncIReports360Visits } from "@/lib/crm/sync";
import { resolveAccessContext } from "@/lib/auth/server";
import { assertPermission } from "@/lib/auth/permissions";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { assertApiRateLimit, isApiRateLimitError, rateLimitIdentity } from "@/lib/security/api-rate-limit";
import { logError } from "@/lib/observability/log";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// One day is a single vendor login plus two fetches and a batched upsert. The 45-day backfill route
// runs at 120s; 60 is ample here and keeps a stuck vendor from holding a request open.
export const maxDuration = 60;

/** Roles that may spend a vendor login. A Medical Rep reads the board but must not trigger a sync. */
const SYNC_ROLES = new Set([
  "District Manager",
  "Regional Manager",
  "National Sales Manager",
  "SFE Manager",
  "CEO",
  "Super Admin",
]);

export async function POST(request: Request) {
  const csrf = assertSameOriginMutation(request);
  if (csrf) return csrf;

  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "crm_visits", "read");

    if (access.scope !== "system" && !SYNC_ROLES.has(access.role)) {
      return NextResponse.json({ error: "not_a_sync_role" }, { status: 403 });
    }

    const actor = access.hrId || access.loginId || "unknown";

    // Per-actor: a human who clicks twice because nothing visibly moved is normal; four bounds a
    // stuck key.
    await assertApiRateLimit({
      identifier: rateLimitIdentity({ actor, request }),
      limit: 4,
      scope: "crm-early-birds-sync-actor",
      windowMs: 60_000,
    });
    // Global: the vendor login is the scarce resource. Without a shared bucket, forty managers
    // refreshing at 08:35 is forty logins in one minute against shared hosting whose own poller
    // already runs every fifteen minutes.
    await assertApiRateLimit({
      identifier: "crm-early-birds-sync-global",
      limit: 12,
      scope: "crm-early-birds-sync-global",
      windowMs: 60_000,
    });

    const date = cairoTodayIso();
    const result = await syncIReports360Visits({ dateFrom: date, dateTo: date, trigger: "manual" });

    return NextResponse.json({
      success: true,
      date,
      syncedAt: new Date().toISOString(),
      rowsFetched: result.rowsFetched,
      rowsUpserted: result.rowsUpserted,
      checkinsFetched: result.checkinsFetched,
      checkinsFailed: result.checkinsFailed,
      runId: result.runId,
    });
  } catch (error) {
    if (isApiRateLimitError(error)) {
      return NextResponse.json(
        { error: "rate_limited", retryAfterSeconds: error.retryAfterSeconds },
        { status: 429, headers: { "Retry-After": String(error.retryAfterSeconds) } },
      );
    }
    const message = clientSafeErrorMessage(error, "Sync failed.");
    if (message.startsWith("Forbidden:")) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    // The sync engine throws this exact message when the vendor env is absent. Surfacing it as a
    // 500 would read as a code fault rather than as configuration.
    if (/not configured/i.test(message)) {
      return NextResponse.json({ error: "crm_not_configured" }, { status: 503 });
    }
    logError("Early Birds manual sync failed", {
      labels: { event: "crm_early_birds_sync_failed" },
      error,
    });
    return NextResponse.json({ error: "sync_failed", message }, { status: 500 });
  }
}
