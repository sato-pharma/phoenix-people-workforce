import { NextResponse } from "next/server";

import { isForceTestingDelivery, isProductionRuntime, systemEmail } from "@/config/system-settings";
import { resolveAccessContext } from "@/lib/auth/server";
import { callerMayReadEmailHealthDetail, publicEmailHealthBody } from "@/lib/email/email-health-access";
import { resolveEmailProviders } from "@/lib/email/email-providers";
import { assertCronAuthorized } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const truthy = (value?: string) => ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());

// The address stays public so an uptime monitor can poll it, and every caller gets the same status
// code (200 healthy, 503 degraded). Only the cron secret or a signed-in system administrator reads
// the detail below; everyone else gets { status, timestamp } (src/lib/email/email-health-access.ts).
export async function GET(request: Request) {
  // Value-aware, not presence-only: EMAIL_NOTIFICATIONS_ENABLED="false" is "present" but
  // disables all email, so it must read as a failed check. PHOENIX_AUTH_SECRET is required
  // to sign one-click unsubscribe tokens.
  const checks = [
    { name: "RESEND_API_KEY", present: Boolean(process.env.RESEND_API_KEY?.trim()) },
    { name: "EMAIL_NOTIFICATIONS_ENABLED", present: truthy(process.env.EMAIL_NOTIFICATIONS_ENABLED) },
    // Deliberately NOT OR'd with systemEmail.defaultFromEmail: that constant only backstops
    // the standalone send-phoenix-email helper's own path. The notification outbox — which
    // sends nearly all automated mail — reads process.env.NOTIFICATION_EMAIL_FROM directly with no
    // fallback and silently skips every send if it's unset (src/lib/notifications/email.ts).
    // Falling back to the code default here previously made this check report healthy while
    // that path was dead — the same failure shape as the 2026-07-11 EMAIL_NOTIFICATIONS_ENABLED
    // outage, just undetected.
    { name: "NOTIFICATION_EMAIL_FROM", present: Boolean(process.env.NOTIFICATION_EMAIL_FROM?.trim()) },
    { name: "NOTIFICATION_REPLY_TO", present: Boolean(process.env.NOTIFICATION_REPLY_TO || systemEmail.defaultReplyTo) },
    { name: "RESEND_WEBHOOK_SECRET", present: Boolean(process.env.RESEND_WEBHOOK_SECRET?.trim()) },
    { name: "CRON_SECRET", present: Boolean(process.env.CRON_SECRET?.trim()) },
    { name: "PHOENIX_AUTH_SECRET", present: Boolean(process.env.PHOENIX_AUTH_SECRET?.trim()) },
  ];

  const forceTesting = isForceTestingDelivery();
  const deliveryMode = (process.env.PHOENIX_EMAIL_DELIVERY_MODE ?? "").trim().toLowerCase() || "live";

  const warnings: string[] = [];
  // The one switch the old check missed: a production instance silently diverting ALL mail
  // to the test inboxes must report degraded, not healthy.
  if (isProductionRuntime() && (forceTesting || deliveryMode === "testing")) {
    warnings.push(
      "Email is redirected to testing recipients in production (PHOENIX_EMAIL_FORCE_TESTING / PHOENIX_EMAIL_DELIVERY_MODE). Real recipients are NOT receiving mail.",
    );
  }

  const missing = checks.some((check) => !check.present);
  const degraded = missing || warnings.length > 0;
  const status = degraded ? "degraded" : "healthy";
  const timestamp = new Date().toISOString();
  const init = { headers: { "cache-control": "no-store" }, status: degraded ? 503 : 200 };

  const detail = await callerMayReadEmailHealthDetail(request, {
    cronAuthorized: (req) => assertCronAuthorized(req, "health/email") === null,
    resolveAccess: resolveAccessContext,
  });
  if (!detail) {
    return NextResponse.json(publicEmailHealthBody({ status, timestamp }), init);
  }

  return NextResponse.json(
    {
      checks,
      // The failover chain as production will walk it (names only, never a key): "resend", then
      // "brevo" when the fallback is switched on — the only two accounts since 2026-11-06.
      providerChain: resolveEmailProviders().map((provider) => provider.name),
      deliveryMode,
      forceTesting,
      status,
      timestamp,
      warnings,
    },
    init,
  );
}
