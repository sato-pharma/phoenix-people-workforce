import assert from "node:assert/strict";

// The per-person .ics calendar feed (owner, 2026-09-26: make the interview calendar relevant daily —
// interviews appear in the person's own Outlook/Google/phone calendar). These check the EMITTED
// calendar text, not the source: a feed a calendar app cannot parse is worse than none.

import { calendarFeedPath, renderCalendarFeed } from "@/lib/recruitment/interview-calendar-ics";
import type { FeedInterview } from "@/lib/recruitment/interview-calendar";

function sample(overrides: Partial<FeedInterview> = {}): FeedInterview {
  return {
    candidateName: "Mona Adel",
    durationMinutes: 30,
    id: "11111111-1111-1111-1111-111111111111",
    interviewerName: "Omar Gawish",
    notes: null,
    platform: "zoom",
    sessionTitle: null,
    startsAt: "2026-09-27T08:00:00.000Z",
    updatedAt: "2026-09-26T10:00:00.000Z",
    zoomJoinUrl: "https://zoom.us/j/123",
    ...overrides,
  };
}

export function runInterviewCalendarIcsTests() {
  // An empty feed is still a valid calendar — a stale or unknown token returns this, never an error.
  const empty = renderCalendarFeed([], new Date("2026-09-26T12:00:00Z"));
  assert.match(empty, /^BEGIN:VCALENDAR\r\n/, "starts with a VCALENDAR");
  assert.match(empty, /VERSION:2\.0/, "declares iCalendar 2.0");
  assert.match(empty, /END:VCALENDAR\r\n$/, "ends with a VCALENDAR, CRLF-terminated");
  assert.doesNotMatch(empty, /BEGIN:VEVENT/, "no events when there are none");

  // One interview becomes one event, timed in UTC, ending exactly its duration later.
  const one = renderCalendarFeed([sample()], new Date("2026-09-26T12:00:00Z"));
  assert.match(one, /BEGIN:VEVENT[\s\S]*END:VEVENT/, "an interview is a VEVENT");
  assert.match(one, /DTSTART:20260927T080000Z/, "DTSTART is the interview's UTC instant");
  assert.match(one, /DTEND:20260927T083000Z/, "DTEND is DTSTART plus the duration (30 min)");
  assert.match(one, /UID:11111111-1111-1111-1111-111111111111@/, "a stable UID per interview, so a refresh updates rather than duplicates");
  assert.match(one, /SUMMARY:Interview . Mona Adel/, "the summary names the candidate");
  assert.match(one, /LOCATION:https:\/\/zoom\.us\/j\/123/, "a Zoom interview's location is its join link");

  // RFC 5545 text escaping: a comma and semicolon in a name must be backslash-escaped.
  const escaped = renderCalendarFeed([sample({ candidateName: "Adel, Mona; Sr" })], new Date("2026-09-26T12:00:00Z"));
  assert.match(escaped, /SUMMARY:Interview . Adel\\, Mona\\; Sr/, "commas and semicolons are escaped");

  // An office interview reads as the office, not a blank location.
  const office = renderCalendarFeed([sample({ platform: "in_office", zoomJoinUrl: null })], new Date("2026-09-26T12:00:00Z"));
  assert.match(office, /LOCATION:In office/, "an in-office interview's location is the office label");

  // The subscription path is under the calendar's own API and carries the token.
  assert.equal(calendarFeedPath("abc123"), "/api/recruitment/interview-calendar/ics/abc123", "the feed path carries the token");
}
