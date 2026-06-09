import { NextResponse } from "next/server";

import { isForceTestingDelivery, isProductionRuntime, systemEmail } from "@/config/system-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const truthy = (value?: string) => ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());

export async function GET() {
  // Value-aware, not presence-only: EMAIL_NOTIFICATIONS_ENABLED="false" is "present" but
  // disables all email, so it must read as a failed check. PHOENIX_AUTH_SECRET is required
  // to sign one-click unsubscribe tokens.
  const checks = [
    { name: "RESEND_API_KEY", present: Boolean(process.env.RESEND_API_KEY?.trim()) },
    { name: "EMAIL_NOTIFICATIONS_ENABLED", present: truthy(process.env.EMAIL_NOTIFICATIONS_ENABLED) },
    { name: "NOTIFICATION_EMAIL_FROM", present: Boolean(process.env.NOTIFICATION_EMAIL_FROM || systemEmail.defaultFromEmail) },
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

  return NextResponse.json(
    {
      checks,
      deliveryMode,
      forceTesting,
      status: degraded ? "degraded" : "healthy",
      timestamp: new Date().toISOString(),
      warnings,
    },
    { status: degraded ? 503 : 200 },
  );
}
