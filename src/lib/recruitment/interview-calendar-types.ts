// Recruitment — the interview calendar's shapes and its four levels of access.
//
// PURE AND CLIENT-SAFE: the screens import it for labels and for what to draw, and the server
// imports the same predicates to decide what to allow. The screen hiding a button is manners; the
// route refusing the request is the lock (src/lib/recruitment/interview-calendar.ts).
//
// WHO SEES THE CALENDAR — the owner's own choice, 2026-09-18: "Only you + people you share with".
//   owner      the Super Admin. Books, moves, cancels, comments, shares, exports.
//   editor     a person he shared it with as Editor — books, moves and cancels too, and comments.
//   commenter  sees the calendar and opens the CVs on it, and leaves notes on an interview.
//   viewer     sees the calendar and opens the CVs on it.
// Everyone who can see it can export it. Nobody but the owner can share it.

export type InterviewCalendarAccessLevel = "viewer" | "commenter" | "editor";
export type InterviewCalendarRole = "owner" | InterviewCalendarAccessLevel;

export const INTERVIEW_CALENDAR_ACCESS_LEVELS: readonly InterviewCalendarAccessLevel[] = ["viewer", "commenter", "editor"];

export const ACCESS_LEVEL_LABEL: Record<InterviewCalendarRole, string> = {
  commenter: "Commenter",
  editor: "Editor",
  owner: "Owner",
  viewer: "Viewer",
};

export const ACCESS_LEVEL_HINT: Record<InterviewCalendarAccessLevel, string> = {
  commenter: "Sees the calendar, opens the CVs and leaves notes on an interview.",
  editor: "Also books, moves and cancels interviews.",
  viewer: "Sees the calendar and opens the CVs on it.",
};

export function isInterviewCalendarAccessLevel(value: unknown): value is InterviewCalendarAccessLevel {
  return value === "viewer" || value === "commenter" || value === "editor";
}

export function canBookInterviews(role: InterviewCalendarRole | null): boolean {
  return role === "owner" || role === "editor";
}

export function canCommentOnInterviews(role: InterviewCalendarRole | null): boolean {
  return role === "owner" || role === "editor" || role === "commenter";
}

export function canShareInterviewCalendar(role: InterviewCalendarRole | null): boolean {
  return role === "owner";
}

/** What a request needs, in the order the levels grant it. */
export type InterviewCalendarNeed = "view" | "comment" | "book" | "share";

export function roleMeets(role: InterviewCalendarRole | null, need: InterviewCalendarNeed): boolean {
  if (!role) return false;
  if (need === "view") return true;
  if (need === "comment") return canCommentOnInterviews(role);
  if (need === "book") return canBookInterviews(role);
  return canShareInterviewCalendar(role);
}

/**
 * Who a viewer is on the calendar, from facts the caller has already read.
 *
 * `isOwner` is the Super Admin (system scope). A share row is looked up by the caller with the HR id
 * compared case-insensitively — the shares table holds one row per person whatever the casing.
 * The owner outranks any share row naming him: he cannot demote himself by sharing with himself.
 */
export function resolveCalendarRole(input: {
  isOwner: boolean;
  shareLevel: InterviewCalendarAccessLevel | null;
}): InterviewCalendarRole | null {
  if (input.isOwner) return "owner";
  return input.shareLevel;
}

// ── Platform and Zoom ───────────────────────────────────────────────────────────────────────────

export type InterviewPlatform = "in_office" | "zoom";

export const PLATFORM_LABEL: Record<InterviewPlatform, string> = {
  in_office: "In office",
  zoom: "Zoom",
};

export function isInterviewPlatform(value: unknown): value is InterviewPlatform {
  return value === "in_office" || value === "zoom";
}

/**
 * What happened to a Zoom interview's meeting — stored, so the screen says it rather than guesses.
 *   not_needed     an office interview
 *   created        Phoenix created the meeting; the join link is on the booking
 *   not_connected  no Zoom account is connected to Phoenix yet; the interview still stands
 *   failed         Zoom refused; `zoomError` says why, and the interview still stands
 */
export type InterviewZoomStatus = "not_needed" | "created" | "not_connected" | "failed";

export function zoomStatusSentence(status: InterviewZoomStatus, error: string | null): string | null {
  if (status === "not_connected") return "Zoom is not connected to Phoenix yet, so no meeting link was created.";
  if (status === "failed") return error ? `Zoom did not create the meeting: ${error}` : "Zoom did not create the meeting.";
  return null;
}

// ── Records ─────────────────────────────────────────────────────────────────────────────────────

export type InterviewBookingComment = {
  id: string;
  authorName: string;
  body: string;
  createdAt: string;
  /** Whether the person reading wrote it. */
  mine: boolean;
};

export type InterviewBooking = {
  id: string;
  candidateId: string;
  candidateName: string;
  /** The job the CV applied for, when it names one. */
  candidateJobTitle: string | null;
  /** The instant, as stored. */
  startsAt: string;
  /** Cairo calendar day, YYYY-MM-DD. */
  dateKey: string;
  /** Minutes after Cairo midnight. */
  startMinutes: number;
  durationMinutes: number;
  platform: InterviewPlatform;
  zoomStatus: InterviewZoomStatus;
  zoomJoinUrl: string | null;
  zoomError: string | null;
  notes: string | null;
  bookedByName: string | null;
  createdAt: string;
  updatedAt: string;
  comments: InterviewBookingComment[];
};

export type InterviewCalendarShare = {
  hrId: string;
  name: string;
  jobTitle: string | null;
  accessLevel: InterviewCalendarAccessLevel;
  sharedAt: string;
};

export type InterviewCalendarPerson = {
  hrId: string;
  name: string;
  jobTitle: string | null;
};

export type InterviewCalendarMe = {
  role: InterviewCalendarRole | null;
  zoomConnected: boolean;
};

/**
 * The calendar's address in whichever shell the browser is in — a link pressed in the HR shell
 * stays in it (proxy.ts rewrites /hr/… onto the admin page, and the server cannot see that), and the
 * portal has its own twin. Anything else is the admin address, which the (admin) layout forwards
 * for anyone who belongs elsewhere.
 */
export function interviewCalendarBaseFor(pathname: string | null | undefined): string {
  const path = typeof pathname === "string" ? pathname : "";
  if (path === "/employee-portals" || path.startsWith("/employee-portals/")) return "/employee-portals/interview-calendar";
  if (path === "/hr" || path.startsWith("/hr/")) return "/hr/recruitment/interview-calendar";
  return "/recruitment/interview-calendar";
}

/** The one address the calendar lives at, in both shells. `open` lands on an interview with its CV up. */
export function interviewCalendarHref(input: { weekStart?: string | null; open?: string | null; base?: string } = {}): string {
  const params = new URLSearchParams();
  if (input.weekStart) params.set("week", input.weekStart);
  if (input.open) params.set("open", input.open);
  const query = params.toString();
  return `${input.base ?? "/recruitment/interview-calendar"}${query ? `?${query}` : ""}`;
}
