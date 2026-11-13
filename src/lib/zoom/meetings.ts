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
// No SDK: documented REST calls only. `fetch` is injectable so the tests can prove the exact
// request without reaching Zoom.

export type ZoomConfig = {
  accountId: string;
  clientId: string;
  clientSecret: string;
  hostUser: string;
};

export type ZoomFetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * How long one Zoom call may take (integration audit, 13 Nov 2026, ISS-011). None of the seven calls here had a deadline, so a
 * Zoom that accepted the connection and then said nothing held the interview-booking request open
 * until the platform cut it. A call that runs out throws, and every caller already treats a throw as
 * "Zoom did not answer": the interview is saved without a meeting link and says so.
 */
export const ZOOM_CALL_DEADLINE_MS = 15_000;
const zoomDeadline = () => AbortSignal.timeout(ZOOM_CALL_DEADLINE_MS);

export class ZoomRequestError extends Error {
  // NOT a TypeScript parameter property: the test runner strips types and cannot compile one.
  readonly status: number;
  /** Zoom's own error code, when it sent one (3001: no such meeting or not ended; 124: bad token). */
  readonly code: number | null;

  constructor(message: string, status: number, code: number | null = null) {
    super(message);
    this.name = "ZoomRequestError";
    this.status = status;
    this.code = code;
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
  const body = (await response.json().catch(() => null)) as { code?: unknown; message?: unknown; reason?: unknown } | null;
  const said = typeof body?.message === "string" ? body.message : typeof body?.reason === "string" ? body.reason : "";
  const code = typeof body?.code === "number" ? body.code : null;
  return new ZoomRequestError(said ? `${fallback} (${response.status}: ${said})` : `${fallback} (${response.status})`, response.status, code);
}

export async function zoomAccessToken(config: ZoomConfig, fetchImpl: ZoomFetch = fetch, now: number = Date.now()): Promise<string> {
  const key = `${config.accountId}:${config.clientId}`;
  if (cachedToken && cachedToken.key === key && cachedToken.expiresAt > now) return cachedToken.token;

  const url = `${TOKEN_URL}?grant_type=account_credentials&account_id=${encodeURIComponent(config.accountId)}`;
  const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
  const response = await fetchImpl(url, { headers: { Authorization: `Basic ${basic}` }, method: "POST", signal: zoomDeadline() });
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
 * arithmetic and the meeting shows the same hour the calendar does. Nobody in before the host: an
 * interview must not start without the interviewer.
 *
 * NO WAITING ROOM — the owner, 2026-09-20, after a live interview: "the meeting was by permission and I
 * had to accept the employees entering". With `join_before_host: false` a candidate who arrives early
 * still waits for the interviewer to start it, and once it has started they walk straight in; the
 * waiting room only added a click per person. (Zoom can still force a waiting room from the account's
 * own settings, which no API field overrides.)
 */
export function zoomMeetingBody(input: ZoomMeetingInput) {
  const hours = String(Math.floor(input.startMinutes / 60)).padStart(2, "0");
  const minutes = String(input.startMinutes % 60).padStart(2, "0");
  return {
    duration: input.durationMinutes,
    settings: {
      join_before_host: false,
      waiting_room: false,
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
    signal: zoomDeadline(),
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

/**
 * The link that opens a meeting AS ITS HOST, so it starts by itself. The `join_url` is the guest link:
 * opened by the interviewer it lands them in the meeting as a guest, waiting for a host who never
 * arrives, until they start it from the Zoom app by hand (owner, 2026-09-20). The `start_url` carries
 * the host's own token and expires, so it is asked for fresh each time — never stored — and handed
 * only to the person whose interview it is.
 */
export async function getZoomHostStartUrl(config: ZoomConfig, meetingId: string, fetchImpl: ZoomFetch = fetch): Promise<string> {
  const body = await zoomGetJson(config, `/meetings/${encodeURIComponent(meetingId)}`, "Zoom did not give the host link", fetchImpl);
  const startUrl = typeof body.start_url === "string" ? body.start_url : "";
  if (!startUrl.startsWith("https://")) throw new ZoomRequestError("Zoom answered without a host link", 502);
  return startUrl;
}

/** The meeting id inside a Zoom join link (`https://zoom.us/j/96901316749?pwd=…`), or null. */
export function zoomMeetingIdFromJoinUrl(joinUrl: string): string | null {
  const match = /\/j\/(\d{8,13})(?:[/?#]|$)/.exec(joinUrl);
  return match ? match[1] : null;
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
    signal: zoomDeadline(),
  });
  if (!response.ok) throw await zoomError(response, "Zoom did not move the meeting");
}

/** A meeting Zoom no longer has is already deleted, so a 404 counts as done. */
export async function deleteZoomMeeting(config: ZoomConfig, meetingId: string, fetchImpl: ZoomFetch = fetch): Promise<void> {
  const token = await zoomAccessToken(config, fetchImpl);
  const response = await fetchImpl(`${API_BASE}/meetings/${encodeURIComponent(meetingId)}`, {
    headers: { Authorization: `Bearer ${token}` },
    method: "DELETE",
    signal: zoomDeadline(),
  });
  if (!response.ok && response.status !== 404) throw await zoomError(response, "Zoom did not delete the meeting");
}

// ── After the meeting, and around it — the owner's request of 2026-09-18 ───────────────────────
//
// "build Zoom attendance, polls, invitation and AI summary into the interview calendar". Each is a
// documented REST call, covered by the scopes the owner granted the app that day:
//
//   invitation     GET  /meetings/{id}/invitation
//   the meeting    GET  /report/meetings/{id}, else GET /past_meetings/{id}
//   attendance     GET  /report/meetings/{uuid}/participants, else /past_meetings/{uuid}/participants
//   AI summary     GET  /meetings/{uuid}/meeting_summary
//   polls          POST /meetings/{id}/polls, DELETE /meetings/{id}/polls/{pollId}
//   poll answers   GET  /report/meetings/{id}/polls
//
// NOTHING HERE SENDS ANYTHING TO ANYONE. The invitation is TEXT handed back to the screen, for the
// person who books to copy or pass on themselves.

async function zoomGetJson(config: ZoomConfig, path: string, fallback: string, fetchImpl: ZoomFetch): Promise<Record<string, unknown>> {
  const token = await zoomAccessToken(config, fetchImpl);
  const response = await fetchImpl(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${token}` }, method: "GET", signal: zoomDeadline() });
  if (!response.ok) throw await zoomError(response, fallback);
  return ((await response.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
}

/**
 * A meeting UUID in a path. Zoom's rule: a UUID that begins with "/" or holds "//" is encoded TWICE,
 * or the request lands on the wrong address and answers 404 for a meeting that exists.
 */
export function zoomUuidPath(uuid: string): string {
  const once = encodeURIComponent(uuid);
  return uuid.startsWith("/") || uuid.includes("//") ? encodeURIComponent(once) : once;
}

/** "Not held yet / no such instance" — an empty answer, not a failure. */
export function isNotHeldYet(error: unknown): boolean {
  return error instanceof ZoomRequestError && (error.status === 404 || error.code === 3001);
}

/** The invitation text Zoom writes for a meeting — the one its own "Copy invitation" gives. */
export async function getZoomMeetingInvitation(config: ZoomConfig, meetingId: string, fetchImpl: ZoomFetch = fetch): Promise<string> {
  const body = await zoomGetJson(config, `/meetings/${encodeURIComponent(meetingId)}/invitation`, "Zoom did not give the invitation", fetchImpl);
  const text = typeof body.invitation === "string" ? body.invitation.trim() : "";
  if (!text) throw new ZoomRequestError("Zoom answered without an invitation", 502);
  return text;
}

export type ZoomPastMeeting = { uuid: string; startTime: string | null; endTime: string | null };

function readPastMeeting(body: Record<string, unknown>): ZoomPastMeeting | null {
  const uuid = typeof body.uuid === "string" ? body.uuid : "";
  if (!uuid) return null;
  return {
    endTime: typeof body.end_time === "string" ? body.end_time : null,
    startTime: typeof body.start_time === "string" ? body.start_time : null,
    uuid,
  };
}

/**
 * The last time a meeting was actually held, or null when it has not been (Zoom answers 404, or code
 * 3001). The report is asked first; if the account's plan does not carry reports, the past-meeting
 * record answers the same question.
 */
export async function getZoomPastMeeting(config: ZoomConfig, meetingId: string, fetchImpl: ZoomFetch = fetch): Promise<ZoomPastMeeting | null> {
  try {
    return readPastMeeting(await zoomGetJson(config, `/report/meetings/${encodeURIComponent(meetingId)}`, "Zoom has no report for the meeting", fetchImpl));
  } catch (error) {
    if (isNotHeldYet(error)) return null;
    try {
      return readPastMeeting(
        await zoomGetJson(config, `/past_meetings/${encodeURIComponent(meetingId)}`, "Zoom has no record of the meeting being held", fetchImpl),
      );
    } catch (second) {
      if (isNotHeldYet(second)) return null;
      throw second;
    }
  }
}

export type ZoomAttendee = { name: string; email: string | null; joinedAt: string | null; leftAt: string | null; seconds: number };

/**
 * Who joined, and for how long — one row per PERSON. Zoom lists a row for every time someone joined,
 * so a dropped connection and a rejoin read as two; they are summed here, earliest join to latest
 * leave. Keyed by e-mail when Zoom has one, else by the name shown in the meeting.
 */
export function mergeZoomParticipants(rows: ReadonlyArray<Record<string, unknown>>): ZoomAttendee[] {
  const byPerson = new Map<string, ZoomAttendee>();
  for (const row of rows) {
    const name = typeof row.name === "string" && row.name.trim() ? row.name.trim() : "Unnamed participant";
    const emailRaw = typeof row.user_email === "string" ? row.user_email.trim() : typeof row.email === "string" ? row.email.trim() : "";
    const email = emailRaw || null;
    const key = (email ?? `name:${name}`).toLowerCase();
    const joinedAt = typeof row.join_time === "string" ? row.join_time : null;
    const leftAt = typeof row.leave_time === "string" ? row.leave_time : null;
    const seconds = typeof row.duration === "number" && Number.isFinite(row.duration) ? Math.max(0, row.duration) : 0;
    const seen = byPerson.get(key);
    if (!seen) {
      byPerson.set(key, { email, joinedAt, leftAt, name, seconds });
      continue;
    }
    seen.seconds += seconds;
    if (joinedAt && (!seen.joinedAt || joinedAt < seen.joinedAt)) seen.joinedAt = joinedAt;
    if (leftAt && (!seen.leftAt || leftAt > seen.leftAt)) seen.leftAt = leftAt;
  }
  return [...byPerson.values()].sort((left, right) => (left.joinedAt ?? "").localeCompare(right.joinedAt ?? ""));
}

async function pagedParticipants(config: ZoomConfig, path: string, fetchImpl: ZoomFetch): Promise<Array<Record<string, unknown>>> {
  const rows: Array<Record<string, unknown>> = [];
  let pageToken = "";
  // Walks until Zoom sends no further token, with no page ceiling; a token it repeats would only loop, so that ends the walk.
  const seenTokens = new Set<string>();
  while (true) {
    const query = `?page_size=300${pageToken ? `&next_page_token=${encodeURIComponent(pageToken)}` : ""}`;
    const body = await zoomGetJson(config, `${path}${query}`, "Zoom did not give the attendance", fetchImpl);
    if (Array.isArray(body.participants)) rows.push(...(body.participants as Array<Record<string, unknown>>));
    pageToken = typeof body.next_page_token === "string" ? body.next_page_token : "";
    if (!pageToken || seenTokens.has(pageToken)) break;
    seenTokens.add(pageToken);
  }
  return rows;
}

/** Attendance for one held meeting (its instance UUID). The report first; the past-meeting list if not. */
export async function listZoomMeetingAttendance(config: ZoomConfig, instanceUuid: string, fetchImpl: ZoomFetch = fetch): Promise<ZoomAttendee[]> {
  try {
    return mergeZoomParticipants(await pagedParticipants(config, `/report/meetings/${zoomUuidPath(instanceUuid)}/participants`, fetchImpl));
  } catch (error) {
    try {
      return mergeZoomParticipants(await pagedParticipants(config, `/past_meetings/${zoomUuidPath(instanceUuid)}/participants`, fetchImpl));
    } catch (second) {
      if (isNotHeldYet(error) && isNotHeldYet(second)) return [];
      throw second;
    }
  }
}

export type ZoomMeetingSummary = {
  title: string | null;
  overview: string | null;
  details: Array<{ label: string; summary: string }>;
  nextSteps: string[];
  content: string | null;
};

function summaryText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function readZoomSummary(body: Record<string, unknown>): ZoomMeetingSummary {
  const details = Array.isArray(body.summary_details)
    ? (body.summary_details as Array<Record<string, unknown>>)
        .map((item) => ({ label: summaryText(item.label) ?? "", summary: summaryText(item.summary) ?? "" }))
        .filter((item) => item.label || item.summary)
    : [];
  const nextSteps = Array.isArray(body.next_steps)
    ? (body.next_steps as unknown[]).map((step) => summaryText(step)).filter((step): step is string => Boolean(step))
    : [];
  return {
    content: summaryText(body.summary_content),
    details,
    nextSteps,
    overview: summaryText(body.summary_overview),
    title: summaryText(body.summary_title),
  };
}

/**
 * The AI Companion's summary of one held meeting, or null when there is none — Zoom writes one only
 * when AI Companion's meeting summary is switched on for the account and was running in the meeting.
 */
export async function getZoomMeetingSummary(config: ZoomConfig, instanceUuid: string, fetchImpl: ZoomFetch = fetch): Promise<ZoomMeetingSummary | null> {
  try {
    const summary = readZoomSummary(
      await zoomGetJson(config, `/meetings/${zoomUuidPath(instanceUuid)}/meeting_summary`, "Zoom did not give the meeting summary", fetchImpl),
    );
    return summary.overview || summary.content || summary.details.length > 0 || summary.nextSteps.length > 0 ? summary : null;
  } catch (error) {
    if (isNotHeldYet(error)) return null;
    throw error;
  }
}

export type ZoomPollQuestion = { name: string; type: "single" | "multiple" | "short_answer"; answers: string[] };

/**
 * The poll as Zoom wants it. A written answer makes it an "advanced poll" (poll_type 2); choice
 * questions alone are a plain poll (poll_type 1), which every account can run.
 */
export function zoomPollBody(input: { title: string; questions: readonly ZoomPollQuestion[] }) {
  const advanced = input.questions.some((question) => question.type === "short_answer");
  return {
    anonymous: false,
    poll_type: advanced ? 2 : 1,
    questions: input.questions.map((question) =>
      question.type === "short_answer"
        ? { answer_required: false, name: question.name.slice(0, 255), type: "short_answer" }
        : {
            answer_required: false,
            answers: question.answers.map((answer) => answer.slice(0, 200)),
            name: question.name.slice(0, 255),
            type: question.type,
          },
    ),
    title: input.title.slice(0, 64),
  };
}

export async function createZoomPoll(
  config: ZoomConfig,
  meetingId: string,
  input: { title: string; questions: readonly ZoomPollQuestion[] },
  fetchImpl: ZoomFetch = fetch,
): Promise<string> {
  const token = await zoomAccessToken(config, fetchImpl);
  const response = await fetchImpl(`${API_BASE}/meetings/${encodeURIComponent(meetingId)}/polls`, {
    body: JSON.stringify(zoomPollBody(input)),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    method: "POST",
    signal: zoomDeadline(),
  });
  if (!response.ok) throw await zoomError(response, "Zoom did not add the poll");
  const body = (await response.json().catch(() => ({}))) as { id?: unknown };
  const id = typeof body.id === "string" || typeof body.id === "number" ? String(body.id) : "";
  if (!id) throw new ZoomRequestError("Zoom added the poll but did not say which it was", 502);
  return id;
}

/** A poll Zoom no longer has is already gone, so a 404 counts as done. */
export async function deleteZoomPoll(config: ZoomConfig, meetingId: string, pollId: string, fetchImpl: ZoomFetch = fetch): Promise<void> {
  const token = await zoomAccessToken(config, fetchImpl);
  const response = await fetchImpl(`${API_BASE}/meetings/${encodeURIComponent(meetingId)}/polls/${encodeURIComponent(pollId)}`, {
    headers: { Authorization: `Bearer ${token}` },
    method: "DELETE",
    signal: zoomDeadline(),
  });
  if (!response.ok && response.status !== 404) throw await zoomError(response, "Zoom did not remove the poll");
}

export type ZoomPollAnswer = { participant: string; email: string | null; question: string; answer: string; at: string | null };

/** Every answer given, one row per person per question. Zoom joins a multiple choice with ";". */
export function readZoomPollAnswers(body: Record<string, unknown>): ZoomPollAnswer[] {
  const rows: ZoomPollAnswer[] = [];
  const people = Array.isArray(body.questions) ? (body.questions as Array<Record<string, unknown>>) : [];
  for (const person of people) {
    const participant = typeof person.name === "string" && person.name.trim() ? person.name.trim() : "Unnamed participant";
    const email = typeof person.email === "string" && person.email.trim() ? person.email.trim() : null;
    const details = Array.isArray(person.question_details) ? (person.question_details as Array<Record<string, unknown>>) : [];
    for (const detail of details) {
      rows.push({
        answer: typeof detail.answer === "string" ? detail.answer : "",
        at: typeof detail.date_time === "string" ? detail.date_time : null,
        email,
        participant,
        question: typeof detail.question === "string" ? detail.question : "",
      });
    }
  }
  return rows;
}

export async function listZoomPollAnswers(config: ZoomConfig, meetingIdOrUuid: string, fetchImpl: ZoomFetch = fetch): Promise<ZoomPollAnswer[]> {
  try {
    return readZoomPollAnswers(
      await zoomGetJson(config, `/report/meetings/${zoomUuidPath(meetingIdOrUuid)}/polls`, "Zoom did not give the poll answers", fetchImpl),
    );
  } catch (error) {
    if (isNotHeldYet(error)) return [];
    throw error;
  }
}
