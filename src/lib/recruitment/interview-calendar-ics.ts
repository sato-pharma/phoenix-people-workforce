// The interview calendar's per-person .ics SUBSCRIPTION FEED.
//
// The owner, 2026-09-26: make the calendar "relevant for everyone daily". A person subscribes once,
// from their normal calendar app (Outlook, Google, the phone), and their own interviews — the ones
// they conduct or asked for — appear there and refresh on their own, with no new habit.
//
// The feed is reached by a bearer token, because a calendar app cannot sign in to Phoenix. The token
// resolves to one hr id and the feed carries ONLY that person's own interviews — never anyone
// else's. An unknown or retired token returns a valid EMPTY calendar, never an error, so a stale
// subscription just goes quiet instead of breaking the person's calendar app.

import { randomBytes } from "node:crypto";

import { hrIdForStorage } from "@/lib/hr-id";
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

/** The .ics text for a feed token: that person's interviews from a month back to six months on. */
export async function buildCalendarFeedForToken(token: string, now: Date = new Date()): Promise<string> {
  const hrId = await hrIdForFeedToken(token);
  const interviews = hrId ? await listInterviewsForCalendarFeed(hrId, new Date(now.getTime() - 30 * DAY_MS), new Date(now.getTime() + 180 * DAY_MS)) : [];
  return renderCalendarFeed(interviews, now);
}

async function hrIdForFeedToken(token: string): Promise<string | null> {
  if (!token || token.length < 32 || token.length > 128) return null;
  const { data } = await recruitmentDb().from(TOKENS).select("hr_id").eq("token", token).maybeSingle();
  const hrId = data?.hr_id;
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
