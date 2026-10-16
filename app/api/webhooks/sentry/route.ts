import { NextResponse } from "next/server";

import { logWarning } from "@/lib/observability/log";
import {
  buildSentryAlertMessage,
  forwardSentryAlertToAdminTelegram,
  verifySentrySignature,
} from "@/lib/observability/sentry-alert-webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Sentry's internal integration posts here when an alert rule fires or an issue is created, signed with the
// integration's client secret (HMAC-SHA256 of the raw body, hex, in `sentry-hook-signature`). The secret lives in
// SENTRY_WEBHOOK_SECRET; with it unset the route refuses everything rather than accept an unsigned alert.
export async function POST(request: Request) {
  const secret = process.env.SENTRY_WEBHOOK_SECRET?.trim();
  if (!secret) {
    logWarning("Sentry webhook received but SENTRY_WEBHOOK_SECRET is not configured", {
      labels: { event: "webhook_misconfigured", webhook: "sentry" },
    });
    return NextResponse.json({ message: "SENTRY_WEBHOOK_SECRET is not configured." }, { status: 500 });
  }

  const body = await request.text();
  if (!verifySentrySignature(body, request.headers.get("sentry-hook-signature"), secret)) {
    logWarning("Rejected Sentry webhook with an invalid signature", {
      labels: { event: "webhook_signature_invalid", webhook: "sentry" },
    });
    return NextResponse.json({ message: "Invalid Sentry webhook signature." }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return NextResponse.json({ message: "Invalid Sentry webhook JSON." }, { status: 400 });
  }

  const alert = buildSentryAlertMessage(request.headers.get("sentry-hook-resource"), payload);
  if (!alert) return NextResponse.json({ ok: true, ignored: true });

  const delivered = await forwardSentryAlertToAdminTelegram(alert);
  return NextResponse.json({ ok: true, delivered });
}
