// The interview calendar's per-person .ics SUBSCRIPTION FEED.
//
// The owner, 2026-09-26: make the calendar "relevant for everyone daily". A person subscribes once,
// from their normal calendar app (Outlook, Google, the phone), and their own interviews — the ones
// they conduct or asked for — appear there and refresh on their own, with no new habit.
//
// The feed is reached by a bearer token, because a calendar app cannot sign in to Phoenix. The token
// resolves to one hr id and the feed carries ONLY that person's own interviews — never anyone
// else's, and only while that person may still sign in (isCalendarFeedHolderActive). An unknown or
// retired token, or a token whose holder has left or lost their login, returns a valid EMPTY
// calendar, never an error, so a stale subscription just goes quiet instead of breaking the app.
// A read that FAILS is different: it throws CalendarFeedUnavailableError and the route answers 503,
// so the calendar app keeps the copy it has instead of wiping every interview on a database blip.

import { randomBytes } from "node:crypto";

import { isEmploymentAccessRevoked } from "@/lib/auth/session-lifecycle";
import { hrIdForStorage } from "@/lib/hr-id";
import { currentCairoDateOnlyIso } from "@/lib/i18n/format";
import { recruitmentDb } from "@/lib/recruitment/db";
import {
  isSignedInCaller,
  listInterviewsForCalendarFeed,
  type FeedInterview,
  type InterviewCalendarCaller,
} from "@/lib/recruitment/interview-calendar";
import { PLATFORM_LABEL } from "@/lib/recruitment/interview-calendar-types";

const TOKENS = "ats_interview_ics_feed_tokens";
const DAY_MS = 24 * 60 * 60 * 1000;

/** The route path (no origin) a calendar app subscribes to, for a given token. */
export function calendarFeedPath(token: string): string {
  return `/api/recruitment/interview-calendar/ics/${encodeURIComponent(token)}`;
}

/** A feed token: 32 random bytes, URL-safe — a bearer secret, like a copy link. */
export function newCalendarFeedToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * The signed-in person's own feed token, made once and kept. One row per hr id; a second call
 * returns the same token, so the subscription URL a person saved keeps working.
 */
export async function getOrCreateMyCalendarFeedToken(caller: InterviewCalendarCaller): Promise<string> {
  // The route's own gate: a feed token is minted only for a signed-in Phoenix person, and only their
  // own (keyed to their hr id). A copy-link holder with no sign-in cannot mint one.
  const hrId = hrIdForStorage(caller.access.hrId);
  if (!hrId || !isSignedInCaller(caller.access)) throw new Error("Sign in to Phoenix to add your interviews to your calendar.");
  const db = recruitmentDb();
  const existing = await db.from(TOKENS).select("token").eq("hr_id", hrId).maybeSingle();
  if (existing.data?.token) return existing.data.token as string;
  const token = newCalendarFeedToken();
  const inserted = await db.from(TOKENS).insert({ hr_id: hrId, token }).select("token").single();
  if (inserted.error) {
    // Two loads racing: the other insert won, so read the token it wrote rather than failing.
    const again = await db.from(TOKENS).select("token").eq("hr_id", hrId).maybeSingle();
    if (again.data?.token) return again.data.token as string;
    throw inserted.error;
  }
  return inserted.data.token as string;
}

/**
 * A read the feed depends on failed — the token, its holder or the interviews. The route answers it
 * with a 503: it serves nothing (fail closed), and unlike an empty calendar it does not tell the
 * subscriber's calendar app that every interview was cancelled (risk review, 26 Oct).
 */
export class CalendarFeedUnavailableError extends Error {
  constructor(what: string) {
    super(`The interview calendar feed could not read ${what}.`);
    this.name = "CalendarFeedUnavailableError";
  }
}

/**
 * The .ics text for a feed token: that person's interviews from a month back to six months on —
 * served only while that person may still sign in to Phoenix (isCalendarFeedHolderActive). Throws
 * CalendarFeedUnavailableError when a read fails, so a blip is never mistaken for "no interviews".
 */
export async function buildCalendarFeedForToken(token: string, now: Date = new Date()): Promise<string> {
  const hrId = await hrIdForFeedToken(token);
  const servable = hrId ? await feedHolderIsActive(hrId, now) : false;
  let interviews: FeedInterview[] = [];
  if (hrId && servable) {
    try {
      interviews = await listInterviewsForCalendarFeed(hrId, new Date(now.getTime() - 30 * DAY_MS), new Date(now.getTime() + 180 * DAY_MS));
    } catch {
      throw new CalendarFeedUnavailableError("the interviews");
    }
  }
  return renderCalendarFeed(interviews, now);
}

/**
 * Whether the person a feed token belongs to may still be served their interviews (audit point 18,
 * owner-approved 2026-10-26).
 *
 * A token used to outlive its holder: it is minted once and kept, so after someone was offboarded or
 * their login was disabled, the calendar app they had subscribed kept pulling candidate names, Zoom
 * links and notes indefinitely. Now the feed follows the same two facts a Phoenix session follows:
 *   - an ACTIVE login for that hr id (`app_auth_users.is_active`) — the immediate kill switch;
 *   - an employee record that does not revoke access (`isEmploymentAccessRevoked`, the session's own
 *     rule, so a departure filed for a future last working day keeps the notice period working).
 * No employee row at all is allowed when the login is active, exactly as a session allows it.
 *
 * A holder who fails either gets EXACTLY what an unknown token gets — a valid empty calendar — so the
 * answer says nothing about whether the token was ever real, and the subscriber's calendar app drops
 * the interviews it had synced instead of keeping its last copy (which a 404 would leave in place).
 */
export function isCalendarFeedHolderActive(input: {
  hasActiveLogin: boolean;
  employmentStatus: string | null | undefined;
  lastWorkingDate?: string | null;
  todayCairo: string;
}): boolean {
  if (!input.hasActiveLogin) return false;
  return !isEmploymentAccessRevoked({
    employmentStatus: input.employmentStatus,
    lastWorkingDate: input.lastWorkingDate ?? null,
    todayCairo: input.todayCairo,
  });
}

/**
 * Reads both facts for the holder. A failed read throws CalendarFeedUnavailableError: no feed when it
 * cannot tell, and a 503 rather than the empty calendar, which would wipe the subscriber's copy. Only a
 * real token reaches this read, so during an outage a 503 here does tell a real token from a guessed
 * one; the caller cannot cause the outage, and the limits still bound the guessing.
 */
async function feedHolderIsActive(hrId: string, now: Date): Promise<boolean> {
  // Matched case-insensitively, with the LIKE wildcards escaped, so the token row's stored form of
  // the id finds the login and the employee whatever case they were written in.
  const hrPattern = hrId.trim().replace(/[\\%_]/g, (char) => `\\${char}`);
  if (!hrPattern) return false;
  let facts;
  try {
    const db = recruitmentDb();
    facts = await Promise.all([
      db.from("app_auth_users").select("login_id").ilike("hr_id", hrPattern).eq("is_active", true).limit(1),
      db.from("employees").select("employment_status, last_working_date").ilike("hr_id", hrPattern).limit(1).maybeSingle(),
    ]);
  } catch {
    throw new CalendarFeedUnavailableError("its holder");
  }
  const [login, employee] = facts;
  if (login.error || employee.error) throw new CalendarFeedUnavailableError("its holder");
  const row = employee.data as { employment_status?: string | null; last_working_date?: string | null } | null;
  return isCalendarFeedHolderActive({
    employmentStatus: row?.employment_status ?? null,
    hasActiveLogin: (login.data ?? []).length > 0,
    lastWorkingDate: row?.last_working_date ?? null,
    todayCairo: currentCairoDateOnlyIso(now),
  });
}

async function hrIdForFeedToken(token: string): Promise<string | null> {
  if (!token || token.length < 32 || token.length > 128) return null;
  let lookup;
  try {
    lookup = await recruitmentDb().from(TOKENS).select("hr_id").eq("token", token).maybeSingle();
  } catch {
    throw new CalendarFeedUnavailableError("the token");
  }
  if (lookup.error) throw new CalendarFeedUnavailableError("the token");
  const hrId = lookup.data?.hr_id;
  return typeof hrId === "string" && hrId.trim() ? hrId : null;
}

/** RFC 5545 text escaping: backslash, comma, semicolon, and newlines. */
function esc(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
}

/** An instant as a UTC iCalendar stamp, e.g. 20260926T131500Z. */
function icsStamp(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** Fold a content line to 75 octets, continuation lines beginning with a space (RFC 5545 §3.1). */
function fold(line: string): string {
  if (line.length <= 75) return line;
  const parts: string[] = [];
  let rest = line;
  parts.push(rest.slice(0, 75));
  rest = rest.slice(75);
  while (rest.length > 74) {
    parts.push(` ${rest.slice(0, 74)}`);
    rest = rest.slice(74);
  }
  if (rest.length > 0) parts.push(` ${rest}`);
  return parts.join("\r\n");
}

function eventLines(interview: FeedInterview, stamp: string): string[] {
  const place = interview.platform === "zoom" ? (interview.zoomJoinUrl ?? "Zoom") : PLATFORM_LABEL[interview.platform];
  const descriptionParts = [
    `Interview with ${interview.candidateName}`,
    interview.interviewerName ? `Interviewer: ${interview.interviewerName}` : null,
    interview.sessionTitle ? `Session: ${interview.sessionTitle}` : null,
    interview.zoomJoinUrl ? `Join: ${interview.zoomJoinUrl}` : null,
    interview.notes ? interview.notes : null,
  ].filter((part): part is string => Boolean(part));
  return [
    "BEGIN:VEVENT",
    fold(`UID:${interview.id}@phoenix-hr.satopharma.com`),
    `DTSTAMP:${stamp}`,
    `DTSTART:${icsStamp(interview.startsAt)}`,
    `DTEND:${icsStamp(new Date(new Date(interview.startsAt).getTime() + interview.durationMinutes * 60 * 1000).toISOString())}`,
    fold(`SUMMARY:${esc(`Interview — ${interview.candidateName}`)}`),
    fold(`LOCATION:${esc(place)}`),
    fold(`DESCRIPTION:${esc(descriptionParts.join("\n"))}`),
    `LAST-MODIFIED:${icsStamp(interview.updatedAt)}`,
    "END:VEVENT",
  ];
}

/** A whole VCALENDAR — valid even with no events, so a stale token returns an empty calendar. */
export function renderCalendarFeed(interviews: readonly FeedInterview[], now: Date = new Date()): string {
  const stamp = icsStamp(now.toISOString());
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Phoenix Workforce//Interview Calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Phoenix interviews",
    "X-WR-TIMEZONE:Africa/Cairo",
    "X-PUBLISHED-TTL:PT1H",
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    ...interviews.flatMap((interview) => eventLines(interview, stamp)),
    "END:VCALENDAR",
  ];
  // CRLF line endings, as the spec requires.
  return `${lines.join("\r\n")}\r\n`;
}
