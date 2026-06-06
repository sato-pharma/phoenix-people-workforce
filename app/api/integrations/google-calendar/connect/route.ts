import crypto from "crypto";
import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import {
  buildGoogleCalendarAuthorizationUrl,
  googleCalendarRedirectUri,
  isGoogleCalendarConfigured,
} from "@/lib/weekly-planning/google-calendar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function stateSecret() {
  return process.env.GOOGLE_CALENDAR_TOKEN_SECRET?.trim() || process.env.AUTH_SECRET?.trim() || "phoenix-google-calendar";
}

function signState(payload: string) {
  return crypto.createHmac("sha256", stateSecret()).update(payload).digest("base64url");
}

function encodeState(input: Record<string, unknown>) {
  const payload = Buffer.from(JSON.stringify(input)).toString("base64url");
  return `${payload}.${signState(payload)}`;
}

export async function GET(request: Request) {
  try {
    if (!isGoogleCalendarConfigured()) {
      return NextResponse.json(
        {
          error: "google_calendar_not_configured",
          message: "Google Calendar OAuth is not configured.",
          success: false,
        },
        { status: 409 },
      );
    }
    const access = await resolveAccessContext(request);
    if (access.source === "guest" || (!access.loginId && !access.hrId)) {
      return NextResponse.json({ error: "forbidden", message: "Sign in is required.", success: false }, { status: 403 });
    }
    const url = new URL(request.url);
    const state = encodeState({
      hrId: access.hrId,
      loginId: access.loginId,
      nonce: crypto.randomUUID(),
      returnTo: url.searchParams.get("returnTo") || "/employee-portals/plans",
      ts: Date.now(),
    });
    return NextResponse.redirect(buildGoogleCalendarAuthorizationUrl({
      redirectUri: googleCalendarRedirectUri(request),
      state,
    }));
  } catch (error) {
    return NextResponse.json(
      {
        error: "google_calendar_connect_failed",
        message: error instanceof Error ? error.message : "Unable to start Google Calendar connection.",
        success: false,
      },
      { status: 400 },
    );
  }
}
