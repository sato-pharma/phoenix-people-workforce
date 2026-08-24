import { NextResponse } from "next/server";

import { logError, logInfo, logWarning } from "@/lib/observability/log";
import { WHATSAPP_EMBEDDED_SIGNUP_APP_ID } from "@/lib/recruitment/inbound/whatsapp-embedded-signup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GRAPH_HOST = "https://graph.facebook.com";

// Mirror whatsapp-health.ts's graphApiVersion() so every Graph call in the integration speaks the
// same version without adding a required env var.
function graphApiVersion(): string {
  return process.env.WHATSAPP_GRAPH_API_VERSION?.trim() || "v23.0";
}

/**
 * Completes the WhatsApp coexistence connection begun on /whatsapp-connect.
 *
 * The client sends the one-time authorization `code` returned by the Facebook Embedded Signup dialog
 * plus the `wabaId` the handset joined. This route:
 *   1. exchanges the code for a business access token (server-only — needs WHATSAPP_APP_SECRET),
 *   2. subscribes THIS app to that WABA's webhooks, so the handset's inbound messages are delivered
 *      to the existing /api/webhooks/whatsapp endpoint and flow into recruitment intake.
 *
 * No session is required: the code is only valid for this app + secret and is issued by Facebook only
 * to a person who already holds a role on the app (Standard Access), so it cannot be forged, and the
 * only side effect — subscribing our own app to a WABA — is idempotent and harmless. It never touches
 * our own database or returns anything sensitive to the browser.
 */
export async function POST(request: Request) {
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  if (!appSecret) {
    logWarning("WhatsApp embedded-signup exchange called but WHATSAPP_APP_SECRET is not configured", {
      labels: { event: "embedded_signup_misconfigured" },
    });
    return NextResponse.json({ ok: false, error: "not_configured" }, { status: 500 });
  }

  let body: { code?: unknown; wabaId?: unknown };
  try {
    body = (await request.json()) as { code?: unknown; wabaId?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }

  const code = typeof body.code === "string" ? body.code.trim() : "";
  const wabaId = typeof body.wabaId === "string" ? body.wabaId.trim() : "";
  if (!code) {
    return NextResponse.json({ ok: false, error: "missing_code" }, { status: 400 });
  }

  const version = graphApiVersion();

  // 1) Code -> business access token. redirect_uri is intentionally absent: the JS SDK embedded
  //    signup flow does not use one.
  let accessToken: string;
  try {
    const tokenUrl = new URL(`${GRAPH_HOST}/${version}/oauth/access_token`);
    tokenUrl.searchParams.set("client_id", WHATSAPP_EMBEDDED_SIGNUP_APP_ID);
    tokenUrl.searchParams.set("client_secret", appSecret);
    tokenUrl.searchParams.set("code", code);

    const tokenResponse = await fetch(tokenUrl, { cache: "no-store" });
    const tokenJson = (await tokenResponse.json().catch(() => null)) as
      | { access_token?: string; error?: { message?: string } }
      | null;

    if (!tokenResponse.ok || !tokenJson?.access_token) {
      logError("WhatsApp embedded-signup code exchange failed", {
        labels: { event: "embedded_signup_exchange_failed", status: String(tokenResponse.status) },
        context: { graphError: tokenJson?.error?.message ?? null },
      });
      return NextResponse.json({ ok: false, error: "exchange_failed" }, { status: 502 });
    }
    accessToken = tokenJson.access_token;
  } catch (error) {
    logError("WhatsApp embedded-signup code exchange threw", {
      error,
      labels: { event: "embedded_signup_exchange_error" },
    });
    return NextResponse.json({ ok: false, error: "exchange_error" }, { status: 502 });
  }

  // 2) Subscribe this app to the joined WABA so its inbound routes to our webhook. Idempotent, and
  //    best-effort: a missing waba_id or an already-subscribed WABA must not fail the whole connect,
  //    since the app may already be subscribed at the account level.
  if (wabaId) {
    try {
      const subscribeResponse = await fetch(
        `${GRAPH_HOST}/${version}/${encodeURIComponent(wabaId)}/subscribed_apps`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}` },
          cache: "no-store",
        },
      );
      if (subscribeResponse.ok) {
        logInfo("WhatsApp embedded-signup subscribed the app to the WABA", {
          labels: { event: "embedded_signup_subscribed" },
        });
      } else {
        const subscribeJson = (await subscribeResponse.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        logWarning("WhatsApp embedded-signup could not subscribe the app to the WABA", {
          labels: { event: "embedded_signup_subscribe_failed", status: String(subscribeResponse.status) },
          context: { graphError: subscribeJson?.error?.message ?? null },
        });
      }
    } catch (error) {
      logWarning("WhatsApp embedded-signup subscribe threw", {
        error,
        labels: { event: "embedded_signup_subscribe_error" },
      });
    }
  } else {
    logWarning("WhatsApp embedded-signup finished without a WABA id", {
      labels: { event: "embedded_signup_no_waba_id" },
    });
  }

  return NextResponse.json({ ok: true });
}
