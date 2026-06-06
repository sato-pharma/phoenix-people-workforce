import crypto from "crypto";
import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import {
  exchangeGoogleCalendarCode,
  googleCalendarRedirectUri,
  loadGoogleCalendarUserEmail,
} from "@/lib/weekly-planning/google-calendar";
import { saveGoogleCalendarConnection } from "@/lib/weekly-planning/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function stateSecret() {
  return process.env.GOOGLE_CALENDAR_TOKEN_SECRET?.trim() || process.env.AUTH_SECRET?.trim() || "phoenix-google-calendar";
}

function verifyState(state: string) {
  const [payload, signature] = state.split(".");
  if (!payload || !signature) throw new Error("Google Calendar state is invalid.");
  const expected = crypto.createHmac("sha256", stateSecret()).update(payload).digest("base64url");
  if (
    signature.length !== expected.length ||
    !crypto.timingSafeEqual(Uint8Array.from(Buffer.from(signature)), Uint8Array.from(Buffer.from(expected)))
  ) {
    throw new Error("Google Calendar state signature is invalid.");
  }
  const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
    returnTo?: string;
    ts?: number;
  };
  if (!parsed.ts || Date.now() - parsed.ts > 15 * 60 * 1000) {
    throw new Error("Google Calendar connection expired. Please try again.");
  }
  return parsed;
}

function redirectWithStatus(request: Request, returnTo: string | undefined, status: string) {
  const target = new URL(returnTo || "/employee-portals/plans", new URL(request.url).origin);
  target.searchParams.set("googleCalendar", status);
  return NextResponse.redirect(target);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const stateValue = url.searchParams.get("state") ?? "";
  let returnTo: string | undefined;
  try {
    const state = verifyState(stateValue);
    returnTo = state.returnTo;
    const code = url.searchParams.get("code");
    if (!code) throw new Error(url.searchParams.get("error") || "Google Calendar authorization code is missing.");
    const access = await resolveAccessContext(request);
    if (access.source === "guest" || (!access.loginId && !access.hrId)) {
      throw new Error("Sign in is required to connect Google Calendar.");
    }
    const token = await exchangeGoogleCalendarCode({
      code,
      redirectUri: googleCalendarRedirectUri(request),
    });
    if (!token.access_token) throw new Error("Google did not return an access token.");
    const googleEmail = await loadGoogleCalendarUserEmail(token.access_token);
    await saveGoogleCalendarConnection({
      access,
      accessToken: token.access_token,
      expiresIn: token.expires_in,
      googleEmail,
      refreshToken: token.refresh_token,
      scope: token.scope,
    });
    return redirectWithStatus(request, returnTo, "connected");
  } catch {
    return redirectWithStatus(request, returnTo, "failed");
  }
}
