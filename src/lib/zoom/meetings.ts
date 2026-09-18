// Zoom — create, move and delete the meeting for a Zoom interview.
//
// The owner, 2026-09-18, choosing in chat how a Zoom interview gets its link: "Phoenix creates the
// Zoom meeting". So Phoenix talks to Zoom itself, with a Server-to-Server OAuth app on the company's
// Zoom account. Four variables, set in Railway by the owner and never written into this repository:
//
//   ZOOM_ACCOUNT_ID     the Zoom account the app was made in
//   ZOOM_CLIENT_ID      the app's client id
//   ZOOM_CLIENT_SECRET  the app's client secret
//   ZOOM_HOST_USER      the email of the Zoom user who hosts every interview
//
// UNTIL ALL FOUR ARE SET, NOTHING FAILS. A Zoom interview is still booked; it is stored as
// `not_connected` and the screen says in words that no link was created. The same when Zoom refuses:
// the booking stands, marked `failed` with Zoom's own reason, and it can be retried. A calendar that
// refused to book because a third party was down would be worse than one missing a link.
//
// NOTHING IS SENT TO THE CANDIDATE — also the owner's choice. The meeting is created on the host's
// account with no invitees; its join link sits on the interview for the people who share the
// calendar to pass on as they see fit.
//
// No SDK: three documented REST calls. `fetch` is injectable so the tests can prove the exact
// request without reaching Zoom.

export type ZoomConfig = {
  accountId: string;
  clientId: string;
  clientSecret: string;
  hostUser: string;
};

export type ZoomFetch = (input: string, init?: RequestInit) => Promise<Response>;

export class ZoomRequestError extends Error {
  // NOT a TypeScript parameter property: the test runner strips types and cannot compile one.
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ZoomRequestError";
    this.status = status;
  }
}

const TOKEN_URL = "https://zoom.us/oauth/token";
const API_BASE = "https://api.zoom.us/v2";

function clean(value: string | undefined): string {
  // Railway's `variables --stdin` has stored a byte-order mark inside a value before (AGENTS.md
  // §2.3). A BOM in a client id is an "invalid client" from Zoom with nothing on screen to explain it.
  return String(value ?? "").replace(/^﻿/, "").trim();
}

export function readZoomConfig(env: Record<string, string | undefined> = process.env): ZoomConfig | null {
  const config = {
    accountId: clean(env.ZOOM_ACCOUNT_ID),
    clientId: clean(env.ZOOM_CLIENT_ID),
    clientSecret: clean(env.ZOOM_CLIENT_SECRET),
    hostUser: clean(env.ZOOM_HOST_USER),
  };
  return config.accountId && config.clientId && config.clientSecret && config.hostUser ? config : null;
}

export function isZoomConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return readZoomConfig(env) !== null;
}

// One token per server process, reused until a minute before Zoom says it expires (an hour).
let cachedToken: { key: string; token: string; expiresAt: number } | null = null;

export function resetZoomTokenCacheForTests() {
  cachedToken = null;
}

async function zoomError(response: Response, fallback: string): Promise<ZoomRequestError> {
  const body = (await response.json().catch(() => null)) as { message?: unknown; reason?: unknown } | null;
  const said = typeof body?.message === "string" ? body.message : typeof body?.reason === "string" ? body.reason : "";
  return new ZoomRequestError(said ? `${fallback} (${response.status}: ${said})` : `${fallback} (${response.status})`, response.status);
}

export async function zoomAccessToken(config: ZoomConfig, fetchImpl: ZoomFetch = fetch, now: number = Date.now()): Promise<string> {
  const key = `${config.accountId}:${config.clientId}`;
  if (cachedToken && cachedToken.key === key && cachedToken.expiresAt > now) return cachedToken.token;

  const url = `${TOKEN_URL}?grant_type=account_credentials&account_id=${encodeURIComponent(config.accountId)}`;
  const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
  const response = await fetchImpl(url, { headers: { Authorization: `Basic ${basic}` }, method: "POST" });
  if (!response.ok) throw await zoomError(response, "Zoom refused Phoenix's sign-in");
  const body = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
  if (typeof body.access_token !== "string" || !body.access_token) {
    throw new ZoomRequestError("Zoom answered the sign-in without a token", 502);
  }
  const lifetimeSeconds = typeof body.expires_in === "number" ? body.expires_in : 3600;
  cachedToken = { expiresAt: now + Math.max(60, lifetimeSeconds - 60) * 1000, key, token: body.access_token };
  return body.access_token;
}

export type ZoomMeetingInput = {
  topic: string;
  /** Cairo calendar day, YYYY-MM-DD. */
  dateKey: string;
  /** Minutes after Cairo midnight. */
  startMinutes: number;
  durationMinutes: number;
};

/**
 * The meeting as Zoom wants it: a scheduled meeting (type 2) at a Cairo wall-clock time.
 *
 * `start_time` is written WITHOUT a zone and `timezone` names Cairo, so Zoom does the daylight-saving
 * arithmetic and the meeting shows the same hour the calendar does. A waiting room, and nobody in
 * before the host: an interview must not start without the interviewer.
 */
export function zoomMeetingBody(input: ZoomMeetingInput) {
  const hours = String(Math.floor(input.startMinutes / 60)).padStart(2, "0");
  const minutes = String(input.startMinutes % 60).padStart(2, "0");
  return {
    duration: input.durationMinutes,
    settings: {
      join_before_host: false,
      waiting_room: true,
    },
    start_time: `${input.dateKey}T${hours}:${minutes}:00`,
    timezone: "Africa/Cairo",
    topic: input.topic.slice(0, 200),
    type: 2,
  };
}

export type ZoomMeeting = { id: string; joinUrl: string };

export async function createZoomMeeting(
  config: ZoomConfig,
  input: ZoomMeetingInput,
  fetchImpl: ZoomFetch = fetch,
): Promise<ZoomMeeting> {
  const token = await zoomAccessToken(config, fetchImpl);
  const response = await fetchImpl(`${API_BASE}/users/${encodeURIComponent(config.hostUser)}/meetings`, {
    body: JSON.stringify(zoomMeetingBody(input)),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    method: "POST",
  });
  if (!response.ok) throw await zoomError(response, "Zoom did not create the meeting");
  const body = (await response.json()) as { id?: unknown; join_url?: unknown };
  const id = typeof body.id === "number" || typeof body.id === "string" ? String(body.id) : "";
  const joinUrl = typeof body.join_url === "string" ? body.join_url : "";
  if (!id || !joinUrl.startsWith("https://")) {
    throw new ZoomRequestError("Zoom created a meeting but did not return its link", 502);
  }
  return { id, joinUrl };
}

export async function updateZoomMeeting(
  config: ZoomConfig,
  meetingId: string,
  input: ZoomMeetingInput,
  fetchImpl: ZoomFetch = fetch,
): Promise<void> {
  const token = await zoomAccessToken(config, fetchImpl);
  const response = await fetchImpl(`${API_BASE}/meetings/${encodeURIComponent(meetingId)}`, {
    body: JSON.stringify(zoomMeetingBody(input)),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    method: "PATCH",
  });
  if (!response.ok) throw await zoomError(response, "Zoom did not move the meeting");
}

/** A meeting Zoom no longer has is already deleted, so a 404 counts as done. */
export async function deleteZoomMeeting(config: ZoomConfig, meetingId: string, fetchImpl: ZoomFetch = fetch): Promise<void> {
  const token = await zoomAccessToken(config, fetchImpl);
  const response = await fetchImpl(`${API_BASE}/meetings/${encodeURIComponent(meetingId)}`, {
    headers: { Authorization: `Bearer ${token}` },
    method: "DELETE",
  });
  if (!response.ok && response.status !== 404) throw await zoomError(response, "Zoom did not delete the meeting");
}
