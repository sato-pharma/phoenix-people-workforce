import crypto from "crypto";

import type { EmployeePlanCalendarSyncStatus } from "@/lib/weekly-planning/plan-v1";

type GoogleTokenResponse = {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
};

export type GoogleCalendarConnection = {
  accessTokenEncrypted: string | null;
  calendarId: string;
  refreshTokenEncrypted: string | null;
  tokenExpiresAt: string | null;
};

export type GoogleCalendarEventInput = {
  area?: string | null;
  attendees?: string | null;
  date: string;
  endTime?: string | null;
  locationText?: string | null;
  notes?: string | null;
  objective?: string | null;
  planKind: "weekly" | "monthly";
  startTime?: string | null;
  title: string;
};

export type GoogleCalendarSyncResult =
  | {
      employeeCalendarEventId: string | null;
      error: null;
      sharedCalendarEventId: string | null;
      status: Extract<EmployeePlanCalendarSyncStatus, "synced">;
    }
  | {
      employeeCalendarEventId?: null;
      error: string;
      sharedCalendarEventId?: null;
      status: Extract<EmployeePlanCalendarSyncStatus, "blocked" | "failed">;
    };

function secretKey() {
  const raw = process.env.GOOGLE_CALENDAR_TOKEN_SECRET?.trim();
  if (!raw) return null;
  return Uint8Array.from(crypto.createHash("sha256").update(raw).digest());
}

export function isGoogleCalendarConfigured() {
  return Boolean(
    process.env.GOOGLE_CALENDAR_CLIENT_ID?.trim() &&
      process.env.GOOGLE_CALENDAR_CLIENT_SECRET?.trim() &&
      process.env.GOOGLE_CALENDAR_TOKEN_SECRET?.trim(),
  );
}

export function sharedGoogleCalendarId() {
  return process.env.GOOGLE_CALENDAR_SHARED_ID?.trim() || null;
}

export function encryptGoogleCalendarToken(token: string) {
  const rawKey = secretKey();
  if (!rawKey) {
    throw new Error("GOOGLE_CALENDAR_TOKEN_SECRET is not configured.");
  }
  const key = crypto.createSecretKey(rawKey);
  const iv = Uint8Array.from(crypto.randomBytes(12));
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  let encrypted = cipher.update(token, "utf8", "base64url");
  encrypted += cipher.final("base64url");
  const tag = Uint8Array.from(cipher.getAuthTag());
  return [Buffer.from(iv).toString("base64url"), Buffer.from(tag).toString("base64url"), encrypted].join(".");
}

export function decryptGoogleCalendarToken(payload: string | null | undefined) {
  if (!payload) return null;
  const rawKey = secretKey();
  if (!rawKey) {
    throw new Error("GOOGLE_CALENDAR_TOKEN_SECRET is not configured.");
  }
  const key = crypto.createSecretKey(rawKey);
  const [ivRaw, tagRaw, encryptedRaw] = payload.split(".");
  if (!ivRaw || !tagRaw || !encryptedRaw) throw new Error("Stored Google Calendar token is malformed.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Uint8Array.from(Buffer.from(ivRaw, "base64url")));
  decipher.setAuthTag(Uint8Array.from(Buffer.from(tagRaw, "base64url")));
  let decrypted = decipher.update(encryptedRaw, "base64url", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

export function googleCalendarRedirectUri(request?: Request) {
  const configured = process.env.GOOGLE_CALENDAR_REDIRECT_URI?.trim();
  if (configured) return configured;
  const appUrl = (
    process.env.PHOENIX_APP_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    (request ? new URL(request.url).origin : "")
  ).trim().replace(/\/+$/, "");
  return `${appUrl}/api/integrations/google-calendar/callback`;
}

export function buildGoogleCalendarAuthorizationUrl(input: {
  redirectUri: string;
  state: string;
}) {
  const clientId = process.env.GOOGLE_CALENDAR_CLIENT_ID?.trim();
  if (!clientId) throw new Error("GOOGLE_CALENDAR_CLIENT_ID is not configured.");
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("scope", [
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/userinfo.email",
  ].join(" "));
  url.searchParams.set("state", input.state);
  return url.toString();
}

export async function exchangeGoogleCalendarCode(input: {
  code: string;
  redirectUri: string;
}): Promise<GoogleTokenResponse> {
  const clientId = process.env.GOOGLE_CALENDAR_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CALENDAR_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) throw new Error("Google Calendar OAuth credentials are not configured.");

  const response = await fetch("https://oauth2.googleapis.com/token", {
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code: input.code,
      grant_type: "authorization_code",
      redirect_uri: input.redirectUri,
    }),
    method: "POST",
  });
  const payload = await response.json().catch(() => null) as (GoogleTokenResponse & { error_description?: string }) | null;
  if (!response.ok) {
    throw new Error(payload?.error_description ?? `Google token exchange failed with ${response.status}.`);
  }
  return payload ?? {};
}

export async function refreshGoogleCalendarAccessToken(refreshToken: string): Promise<GoogleTokenResponse> {
  const clientId = process.env.GOOGLE_CALENDAR_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CALENDAR_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) throw new Error("Google Calendar OAuth credentials are not configured.");

  const response = await fetch("https://oauth2.googleapis.com/token", {
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
    method: "POST",
  });
  const payload = await response.json().catch(() => null) as (GoogleTokenResponse & { error_description?: string }) | null;
  if (!response.ok) {
    throw new Error(payload?.error_description ?? `Google token refresh failed with ${response.status}.`);
  }
  return payload ?? {};
}

export async function loadGoogleCalendarUserEmail(accessToken: string) {
  const response = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const payload = await response.json().catch(() => null) as { email?: string } | null;
  if (!response.ok) return null;
  return payload?.email ?? null;
}

function cairoDateTime(date: string, time: string) {
  return `${date}T${time.length === 5 ? `${time}:00` : time}`;
}

function buildEventBody(input: GoogleCalendarEventInput) {
  const description = [
    `Phoenix ${input.planKind} plan`,
    input.objective ? `Objective: ${input.objective}` : null,
    input.attendees ? `Attendees: ${input.attendees}` : null,
    input.area ? `Area: ${input.area}` : null,
    input.notes ? `Notes: ${input.notes}` : null,
  ].filter(Boolean).join("\n");

  const timed = Boolean(input.startTime && input.endTime);
  return {
    description,
    end: timed
      ? { dateTime: cairoDateTime(input.date, input.endTime as string), timeZone: "Africa/Cairo" }
      : { date: input.date },
    location: input.locationText ?? undefined,
    start: timed
      ? { dateTime: cairoDateTime(input.date, input.startTime as string), timeZone: "Africa/Cairo" }
      : { date: input.date },
    summary: `[Phoenix Plan] ${input.title}`,
  };
}

async function insertGoogleCalendarEvent(input: {
  accessToken: string;
  calendarId: string;
  event: GoogleCalendarEventInput;
}) {
  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(input.calendarId)}/events`,
    {
      body: JSON.stringify(buildEventBody(input.event)),
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    },
  );
  const payload = await response.json().catch(() => null) as { error?: { message?: string }; id?: string } | null;
  if (!response.ok || !payload?.id) {
    throw new Error(payload?.error?.message ?? `Google Calendar insert failed with ${response.status}.`);
  }
  return payload.id;
}

export async function createApprovedPlanCalendarEvents(input: {
  accessToken: string;
  employeeCalendarId: string;
  event: GoogleCalendarEventInput;
  sharedCalendarId: string;
}): Promise<GoogleCalendarSyncResult> {
  try {
    const employeeCalendarEventId = await insertGoogleCalendarEvent({
      accessToken: input.accessToken,
      calendarId: input.employeeCalendarId,
      event: input.event,
    });
    const sharedCalendarEventId = await insertGoogleCalendarEvent({
      accessToken: input.accessToken,
      calendarId: input.sharedCalendarId,
      event: input.event,
    });
    return {
      employeeCalendarEventId,
      error: null,
      sharedCalendarEventId,
      status: "synced",
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Google Calendar sync failed.",
      status: "failed",
    };
  }
}
