import { NextResponse } from "next/server";

import { logError, logInfo, logWarning } from "@/lib/observability/log";
import { WHATSAPP_CONNECT_LINK_SCOPE, WHATSAPP_CONNECT_LINK_TTL_SECONDS, readWhatsAppConnectLink } from "@/lib/recruitment/inbound/whatsapp-connect-link";
import { WHATSAPP_EMBEDDED_SIGNUP_APP_ID } from "@/lib/recruitment/inbound/whatsapp-embedded-signup";
import { assertApiRateLimit, isApiRateLimitError, rateLimitIdentity } from "@/lib/security/api-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GRAPH_HOST = "https://graph.facebook.com";
// Both Graph calls are bounded so a slow or hung Meta response cannot pin a serverless worker open.
const GRAPH_TIMEOUT_MS = 15_000;

// Mirror whatsapp-health.ts's graphApiVersion() so every Graph call in the integration speaks the
// same version without adding a required env var.
function graphApiVersion(): string {
  return process.env.WHATSAPP_GRAPH_API_VERSION?.trim() || "v23.0";
}

// fetch with a hard timeout. On timeout the abort rejects, which the callers already treat as a
// Graph failure (502 for the exchange, a logged warning for the subscribe).
//
// `AbortSignal.timeout` rather than a hand-rolled AbortController: this helper RETURNS the response
// and both callers then read `.json()` off it, so clearing a manual timer in a `finally` here would
// have cancelled the deadline before the body those callers actually wait on had arrived — the same
// defect that let a CRM sync burn 301 seconds on 2026-09-02 (fetchJson in the iReports360 client, since retired).
// This signal stays armed across the caller's body read.
async function fetchWithTimeout(input: URL | string, init: RequestInit = {}): Promise<Response> {
  return await fetch(input, { ...init, signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS) });
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
 * No session is required — the handset has none — but a ONE-TIME CONNECT LINK is (13 Nov 2026, S01
 * F-PLT-008): a Super Admin makes it on Inbound CV Intake Health, and the page sends its ticket as
 * `link`. A connection is finished only for a live, genuine ticket, and the ticket is spent before Meta
 * is called, so one link connects one number within 30 minutes (whatsapp-connect-link.ts). The code
 * itself is valid only for this app + secret. It writes no business data (only the shared
 * api_rate_limit buckets) and returns nothing sensitive to the browser.
 */
export async function POST(request: Request) {
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  if (!appSecret) {
    logWarning("WhatsApp embedded-signup exchange called but WHATSAPP_APP_SECRET is not configured", {
      labels: { event: "embedded_signup_misconfigured" },
    });
    return NextResponse.json({ ok: false, error: "not_configured" }, { status: 500 });
  }

  // Public, unauthenticated endpoint — rate-limit by IP so it cannot be hammered to burn the Meta
  // app's OAuth budget or hold workers open. A one-time onboarding the owner runs on a phone must
  // never be blocked because the bucket store hiccuped, so a store error counts this address in this
  // process instead (onStoreError "memory", a bounded map). It used to let the request through with
  // no limit at all (audit, 2026-10-26, point 21). A genuine over-limit returns 429 either way.
  try {
    await assertApiRateLimit({
      identifier: rateLimitIdentity({ request }),
      limit: 10,
      onStoreError: "memory",
      scope: "whatsapp-embedded-signup-exchange",
      windowMs: 60_000,
    });
  } catch (error) {
    if (isApiRateLimitError(error)) {
      return NextResponse.json(
        { ok: false, error: "rate_limited", retryAfterSeconds: error.retryAfterSeconds },
        { status: 429, headers: { "Retry-After": String(error.retryAfterSeconds) } },
      );
    }
    // A store outage never reaches here (it is counted in memory above), so this is the limiter
    // failing in a way nothing anticipated — refused, never waved through.
    logWarning("WhatsApp embedded-signup rate-limit check failed; refused", {
      error,
      labels: { event: "embedded_signup_rate_limit_error" },
    });
    return NextResponse.json({ ok: false, error: "rate_limit_unavailable" }, { status: 503 });
  }

  let body: { code?: unknown; wabaId?: unknown; link?: unknown };
  try {
    body = (await request.json()) as { code?: unknown; wabaId?: unknown; link?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }

  // The one-time connect link: read first, spent before Meta is called, so a link that has been used
  // or has run out connects nothing.
  const link = readWhatsAppConnectLink(body.link);
  if (!link) {
    return NextResponse.json({ ok: false, error: "link_invalid" }, { status: 403 });
  }
  try {
    await assertApiRateLimit({
      identifier: link.nonce,
      limit: 1,
      scope: WHATSAPP_CONNECT_LINK_SCOPE,
      windowMs: (WHATSAPP_CONNECT_LINK_TTL_SECONDS + 60) * 1000,
    });
  } catch (error) {
    if (isApiRateLimitError(error)) {
      return NextResponse.json({ ok: false, error: "link_used" }, { status: 403 });
    }
    // The store could not say whether this link was already used: refused, never waved through.
    logWarning("WhatsApp connect link could not be spent; refused", {
      error,
      labels: { event: "whatsapp_connect_link_store_error" },
    });
    return NextResponse.json({ ok: false, error: "link_unavailable" }, { status: 503 });
  }
  logInfo("WhatsApp connect link spent", {
    labels: { event: "whatsapp_connect_link_spent", made_by: link.madeBy },
  });

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

    const tokenResponse = await fetchWithTimeout(tokenUrl, { cache: "no-store" });
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
      const subscribeResponse = await fetchWithTimeout(
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
