// Recruitment — the interview calendar's shapes and its four levels of access.
//
// PURE AND CLIENT-SAFE: the screens import it for labels and for what to draw, and the server
// imports the same predicates to decide what to allow. The screen hiding a button is manners; the
// route refusing the request is the lock (src/lib/recruitment/interview-calendar.ts).
//
// WHO SEES THE CALENDAR — the owner's own choice, 2026-09-18: "Only you + people you share with".
//   owner      the Super Admin, and HR Operations as its admin (owner, 2026-09-21). Books, moves,
//              cancels, comments, shares, exports, records outcomes.
//   editor     a person he shared it with as Editor — books, moves and cancels too, and comments.
//   commenter  sees the calendar and opens the CVs on it, and leaves notes on an interview.
//   viewer     sees the calendar and opens the CVs on it.
// Everyone who can see it can export it. Nobody but an owner can share it.

export type InterviewCalendarAccessLevel = "viewer" | "commenter" | "editor";
/**
 * `interviewer` is NOT a level the owner grants: it is what a District Manager or above holds for
 * the interviews he chose them to conduct (owner, 2026-09-20). It sees the calendar's window with
 * ONLY their own interviews in it — opens the CV, starts Zoom, records how it went — and meets no
 * need above "view", so it can never book, move, cancel, comment or share. Every place that serves
 * a booking to a `view` caller must also ask `mayReadBooking` (interview-calendar.ts).
 *
 * `requester` is likewise NOT a level the owner grants: it is what any District Manager or above —
 * and HR — holds by their seat (owner, 2026-09-23). It lets them open the calendar and ASK for an
 * interview (choose a day, attach CVs, choose the interviewer) without seeing the whole calendar:
 * like `interviewer`, it sees ONLY the interviews they are part of — the ones they requested, plus
 * any they were chosen to conduct — and it can never comment or share. A District Manager may also
 * book his own time as the interviewer (interview-calendar.ts, `canSelfBook`).
 */
export type InterviewCalendarRole = "owner" | InterviewCalendarAccessLevel | "interviewer" | "requester";

export const INTERVIEW_CALENDAR_ACCESS_LEVELS: readonly InterviewCalendarAccessLevel[] = ["viewer", "commenter", "editor"];

export const ACCESS_LEVEL_LABEL: Record<InterviewCalendarRole, string> = {
  commenter: "Commenter",
  editor: "Editor",
  interviewer: "Interviewer",
  owner: "Owner",
  requester: "Requester",
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

/**
 * Who may be chosen to conduct an interview, and so be shown the calendar: District Managers and
 * above — never a Medical Rep (owner, 2026-09-20: "no medical reps ... it's from district managers
 * and up").
 *
 * The app ROLE is read first because authority follows it, not the job title (an acting DM keeps her
 * Medical Representative title). A role on the ladder decides; otherwise the JOB TITLE does. Both
 * spellings of each seat are matched, as elsewhere. Anything unrecognised is refused: this gates who
 * sees candidates' CVs, so an unknown title fails closed.
 */
const BELOW_DISTRICT_MANAGER = /\b(medical rep|representative)/i;
const DISTRICT_MANAGER_AND_ABOVE = /\b(super admin|ceo|chief|president|director|head|vice|manager)\b/i;

export function isDistrictManagerOrAbove(input: { role?: string | null; jobTitle?: string | null }): boolean {
  const role = (input.role ?? "").trim();
  if (role) {
    if (BELOW_DISTRICT_MANAGER.test(role)) return false;
    if (DISTRICT_MANAGER_AND_ABOVE.test(role)) return true;
  }
  const title = (input.jobTitle ?? "").trim();
  if (!title || BELOW_DISTRICT_MANAGER.test(title)) return false;
  return DISTRICT_MANAGER_AND_ABOVE.test(title);
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
 * The calendar's owners: the Super Admin — the owner himself, the only account holding that role —
 * HR Operations, and a system context (a job, not a person).
 *
 * HR OPERATIONS IS AN OWNER BY THE OWNER'S OWN RULING, 2026-09-21: "make Yasmeena HR Operations
 * full access and control to it as admin". She is the only account holding that role. It is the
 * ROLE, not her HR id, for the same reason the Super Admin's is (interview-calendar.ts, "WHY THE
 * OWNER IS"); whoever holds the HR Operations seat runs the calendar with him. An owner outranks any
 * share row, so no one can demote her by sharing with her at a lower level.
 *
 * THE ROLE, NOT THE SCOPE, IS WHAT A SIGNED-IN OWNER CARRIES. `scopeForRole` gives a Super Admin
 * session "company", exactly as it gives the CEO, the Finance Manager and HR Operations; "system"
 * is only ever the synthetic `systemAccessContext`. A scope-only test therefore locked the owner out
 * of his own calendar and admitted no one — caught before merge on 2026-09-18, and pinned in
 * tests/interview-calendar.test.ts against contexts built by `createAccessContext`, the way a real
 * session builds them.
 */
export function isInterviewCalendarOwner(access: { role: string | null; scope: string }): boolean {
  return access.scope === "system" || access.role === "Super Admin" || access.role === "HR Operations";
}

/**
 * A seat that READS the whole interview calendar without owning it — the CEO (owner, 2026-09-26:
 * "anytime the CEO enters the interview calendar he sees the full calendar, doesn't need to see his
 * interviews only"). He resolves to a Viewer: above the own-only tier, so every booking is served to
 * him, but he changes nothing and cannot share the calendar. His seat still lets him REQUEST an
 * interview — `mayRequestInterviews` reads the seat, not this role — so nothing he had is removed.
 *
 * The Talent Acquisition seat (HR Resourcing) reads it the same way since 2026-10-08 — the owner's
 * answer in chat, "Full view built into her seat". A Viewer, like the CEO: every interview, and still
 * able to request one by her HR seat. Booking, moving or cancelling for others needs an Editor share.
 *
 * The HR Operations Specialist seat (HR Administration) reads it the same way since 2026-10-20 — the
 * owner's answer when her login left the HR Operations seat that owns the calendar: "She can view it
 * only". A Viewer, like the CEO; the owner right stays with the HR Operations seat (empty until a
 * hire, so the Super Admin runs it alone).
 */
export function seesWholeInterviewCalendar(access: { role: string | null }): boolean {
  return access.role === "CEO" || access.role === "HR Resourcing" || access.role === "HR Administration";
}

/**
 * A seat that READS the "Requests waiting for a time" list without being able to give a request a
 * time — the Talent Acquisition seat (owner, 2026-10-18: "let Talent Acquisition see waiting interview
 * requests on her calendar, read-only"). The list was for people with book rights, so her Viewer tier
 * showed her only the requests she asked for herself. Reading is all this opens: booking, moving and
 * withdrawing someone else's request stay behind `requireCalendarAccess(…, "book", …)`. The CEO is a
 * Viewer too and is deliberately NOT here — nobody asked for his.
 */
export function readsInterviewRequestInbox(access: { role: string | null }): boolean {
  return access.role === "HR Resourcing";
}

/**
 * Who a viewer is on the calendar, from facts the caller has already read.
 *
 * `isOwner` is `isInterviewCalendarOwner` above. A share row is looked up by the caller with the HR id
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

const RANK: Record<InterviewCalendarRole, number> = { commenter: 2, editor: 3, interviewer: 0, owner: 4, requester: 0, viewer: 1 };

/** The higher of two levels; null is no access. */
export function higherCalendarRole(
  left: InterviewCalendarRole | null,
  right: InterviewCalendarRole | null,
): InterviewCalendarRole | null {
  if (!left) return right;
  if (!right) return left;
  return RANK[left] >= RANK[right] ? left : right;
}

// ── Copy links ──────────────────────────────────────────────────────────────────────────────────

/**
 * What a COPY LINK gives the person holding it — the owner, 2026-09-18, "exactly as Google Sheets":
 * the link carries a level he chose, and may be limited to one week.
 *
 * Holding the link WITHOUT signing in VIEWS — the level he set applies only once the holder signs in
 * to Phoenix (his choice: "View without sign-in"). So a guest is always a viewer, whatever it says.
 */
export type InterviewCalendarLinkGrant = {
  id: string;
  /** The level the owner set on the link. */
  accessLevel: InterviewCalendarAccessLevel;
  /** The Sunday of the one week it opens, or null for the whole calendar. */
  weekStart: string | null;
  /** Whether a holder who has not signed in may open the CVs. */
  guestCvs: boolean;
  /** Whether the holder is signed in to Phoenix. */
  signedIn: boolean;
};

/** The level a link gives: its own once signed in, Viewer before. */
export function linkRole(link: Pick<InterviewCalendarLinkGrant, "accessLevel" | "signedIn">): InterviewCalendarAccessLevel {
  return link.signedIn ? link.accessLevel : "viewer";
}

/** Whether a link reaches this week at all — every week, for a whole-calendar link. */
export function linkCoversWeek(link: Pick<InterviewCalendarLinkGrant, "weekStart"> | null, weekStart: string | null): boolean {
  if (!link) return false;
  return link.weekStart === null || (weekStart !== null && link.weekStart === weekStart);
}

/**
 * Who someone is on ONE week of the calendar. Their own level (the owner, or a share he made) holds
 * on every week; a link's holds on the week it names, or on all of them when it names none. The
 * higher of the two wins. `weekStart` null asks about the calendar as a whole, which a week-limited
 * link does not answer.
 */
export function effectiveCalendarRole(
  input: {
    own: InterviewCalendarRole | null;
    link: Pick<InterviewCalendarLinkGrant, "accessLevel" | "signedIn" | "weekStart"> | null;
  },
  weekStart: string | null,
): InterviewCalendarRole | null {
  const fromLink = input.link && linkCoversWeek(input.link, weekStart) ? linkRole(input.link) : null;
  return higherCalendarRole(input.own, fromLink);
}

/** The highest level held ANYWHERE on the calendar — what decides which buttons a screen draws. */
export function bestCalendarRole(input: {
  own: InterviewCalendarRole | null;
  link: Pick<InterviewCalendarLinkGrant, "accessLevel" | "signedIn"> | null;
}): InterviewCalendarRole | null {
  return higherCalendarRole(input.own, input.link ? linkRole(input.link) : null);
}

/** A link as the owner's share dialog shows it. The token is his to copy again, as Sheets allows. */
export type InterviewCalendarLink = {
  id: string;
  token: string;
  accessLevel: InterviewCalendarAccessLevel;
  weekStart: string | null;
  guestCvs: boolean;
  isActive: boolean;
  createdAt: string;
  createdByName: string | null;
  lastUsedAt: string | null;
  useCount: number;
};

/** The link's own address — outside every shell, so it opens with no sign-in. */
export function interviewCalendarLinkPath(token: string): string {
  return `/share/interview-calendar/${encodeURIComponent(token)}`;
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

// ── The outcome of an interview ────────────────────────────────────────────────────────────────
//
// The owner, 2026-09-20: "an option on every interview — attended, didn't come, shortlisted, back-up,
// rejected, prioritized". Asked in chat, he chose ONE list of six (not attendance and decision apart),
// and that setting one of the decisions ALSO moves the candidate in Recruitment. Only the interviewer,
// or the calendar's owner, may set it.
//
// WHAT AN OUTCOME DOES TO THE CANDIDATE — pure, so the server and its test read the same table:
//
//   attended · did_not_come   the interview only; the candidate is not touched
//   will_reschedule · no_answer · withdrew   (Didn't come's reasons) the same — the interview only
//   shortlisted               status → Shortlisted
//   backup                    status → Back-up (a sixth candidate status, added the same day)
//   rejected                  status → Rejected            — NOTHING is ever sent to the candidate
//   prioritized               status → Shortlisted AND the 3-star "Top pick" rating
//
// An outside person (no Recruitment record) has the interview marked and nothing more.

// THE PICKER IS TWO STEPS (owner, 2026-09-20 — "separate attended and didn't come, then if attended
// cascade its options, and if didn't come cascade its options"). Step one is Attended or Didn't come;
// each opens its own follow-ups. The parent word stays a valid outcome on its own ("Attended" with no
// decision yet); a follow-up REPLACES it, so one interview still carries exactly one word. Didn't
// come's three reasons were his answer to "what should appear under it": they mark the interview only.
export const interviewOutcomeGroups = {
  attended: { followUps: ["shortlisted", "backup", "rejected", "prioritized"], parent: "attended" },
  did_not_come: { followUps: ["will_reschedule", "no_answer", "withdrew"], parent: "did_not_come" },
} as const;
export type InterviewOutcomeGroup = keyof typeof interviewOutcomeGroups;

export const interviewOutcomes = [
  "attended",
  "shortlisted",
  "backup",
  "rejected",
  "prioritized",
  "did_not_come",
  "will_reschedule",
  "no_answer",
  "withdrew",
] as const;
export type InterviewOutcome = (typeof interviewOutcomes)[number];

export const interviewOutcomeLabels: Record<InterviewOutcome, string> = {
  attended: "Attended",
  backup: "Back-up",
  did_not_come: "Didn't come",
  no_answer: "No answer",
  prioritized: "Prioritized",
  rejected: "Rejected",
  shortlisted: "Shortlisted",
  will_reschedule: "Will reschedule",
  withdrew: "Withdrew",
};

/** Which step-one choice an outcome sits under, or null for no outcome. */
export function interviewOutcomeGroup(outcome: InterviewOutcome | null | undefined): InterviewOutcomeGroup | null {
  if (!outcome) return null;
  for (const group of Object.keys(interviewOutcomeGroups) as InterviewOutcomeGroup[]) {
    const { followUps, parent } = interviewOutcomeGroups[group];
    if (outcome === parent || (followUps as readonly string[]).includes(outcome)) return group;
  }
  return null;
}

export function isInterviewOutcome(value: unknown): value is InterviewOutcome {
  return typeof value === "string" && (interviewOutcomes as readonly string[]).includes(value);
}

/** A stored or typed outcome, or null. Anything unrecognised is null — never a guess. */
export function readInterviewOutcome(value: unknown): InterviewOutcome | null {
  return isInterviewOutcome(value) ? value : null;
}

/**
 * An interview whose time has passed with nobody saying how it went.
 *
 * WHY IT IS ASKED ON THE SCREEN AND NOT ONLY BY THE REMINDER JOB. The outcome field has existed
 * since 2026-09-20 and already moves the candidate (`interviewOutcomeCandidateEffect`), and the
 * reminder job has nagged the lead interviewer since 2026-09-23 — and still, measured on production
 * 2026-10-15, 50 of the 68 interviews held from 1 September on carry no outcome at all. A notice in
 * a list somebody has to open is not the same as the calendar itself asking, so the calendar asks.
 *
 * `ended` is the booking's own Cairo-aware answer to "is its time over?" (hydrate computes it), so
 * this stays pure and the screen and the server agree on the same rule.
 */
export function interviewAwaitsOutcome(booking: Pick<InterviewBooking, "ended" | "outcome">): boolean {
  return booking.ended && booking.outcome === null;
}

/** The interviews waiting for someone to say how they went, soonest-finished first. */
export function interviewsAwaitingOutcome<T extends Pick<InterviewBooking, "ended" | "outcome">>(
  bookings: readonly T[],
): T[] {
  return bookings.filter((booking) => interviewAwaitsOutcome(booking));
}

export type InterviewOutcomeCandidateEffect = {
  status: "shortlisted" | "backup" | "rejected" | null;
  /** The 3-star "Top pick" rating, or null for none. */
  rating: 3 | null;
};

export function interviewOutcomeCandidateEffect(outcome: InterviewOutcome): InterviewOutcomeCandidateEffect {
  switch (outcome) {
    case "shortlisted":
      return { rating: null, status: "shortlisted" };
    case "backup":
      return { rating: null, status: "backup" };
    case "rejected":
      return { rating: null, status: "rejected" };
    case "prioritized":
      return { rating: 3, status: "shortlisted" };
    default:
      return { rating: null, status: null };
  }
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

/** An interviewer's verdict on a candidate — the panel's recommendation, not a lifecycle action. */
export type InterviewVerdict = "strong_yes" | "yes" | "no";

export const INTERVIEW_VERDICT_LABEL: Record<InterviewVerdict, string> = {
  no: "No",
  strong_yes: "Strong yes",
  yes: "Yes",
};

export const INTERVIEW_VERDICTS: readonly InterviewVerdict[] = ["strong_yes", "yes", "no"];

export function isInterviewVerdict(value: unknown): value is InterviewVerdict {
  return value === "strong_yes" || value === "yes" || value === "no";
}

/** One interviewer's scorecard for one interview: an overall rating 1-5 and a verdict, plus a note. */
export type InterviewScorecard = {
  evaluatorHrId: string;
  evaluatorName: string;
  rating: number;
  verdict: InterviewVerdict;
  comment: string | null;
  /** Whether the person reading filed it — their own is the editable one. */
  mine: boolean;
  updatedAt: string;
};

/** The interviewer's answer to the assignment (owner, 2026-09-26): confirmed, declined, or unanswered. */
export type InterviewConfirmation = "confirmed" | "declined";

/** One entry in a booking's change history — a change that already happened, newest first. */
export type InterviewChange = {
  id: string;
  /** A short slug for the kind of change — "booked", "rescheduled", "interviewer", "confirmed", … */
  kind: string;
  /** The human line shown in the detail view. */
  summary: string;
  /** Who made the change, when their name resolves. */
  actorName: string | null;
  /** The instant it was recorded. */
  at: string;
};

export type InterviewBooking = {
  id: string;
  /** The recruitment record — or null for someone from outside, kept on the calendar only. */
  candidateId: string | null;
  candidateName: string;
  /** Someone from outside Phoenix whom the booker chose NOT to add to Recruitment. */
  external: boolean;
  /** The outside person's phone and e-mail — sent only to those who can book, null for others. */
  externalPhone: string | null;
  externalEmail: string | null;
  /** Whether the outside person's CV is kept on the booking. */
  externalHasCv: boolean;
  /** That CV's file name and type, so it previews the way a Recruitment CV does. */
  externalCvFileName: string | null;
  externalCvMimeType: string | null;
  /** The session whose slot this interview fills; it then shares that session's one meeting. */
  sessionId: string | null;
  sessionTitle: string | null;
  /** The Zoom meeting the interview is held on exists — its own, or its session's. */
  hasMeeting: boolean;
  /** Whether its time is over (Cairo) — Zoom's reports only exist after. */
  ended: boolean;
  /** The job the CV applied for, when it names one. */
  candidateJobTitle: string | null;
  /**
   * The job THIS interview is for — chosen when it is booked, free text with the offer catalogue's
   * titles offered as suggestions, and null when nobody named one.
   *
   * Distinct from `candidateJobTitle` above on purpose: that is what the candidate's own record says
   * they applied for, which for someone the calendar created used to be nothing at all. This is what
   * the round is for, and it is what a candidate created from a booking is given.
   */
  jobTitle: string | null;
  /** The employee conducting it (HR id and name), when one was chosen — the lead of the panel. */
  interviewerHrId: string | null;
  interviewerName: string | null;
  /** Additional panel members beyond the lead. Each sees the interview and it appears on their .ics
   * feed; the lead stays the outcome-setter and Zoom host. Empty for a one-interviewer interview. */
  panelists: Array<{ hrId: string; name: string }>;
  /** The sales Area and Line the interview is for — optional, auto-filled from the interviewer's seat
   * and editable. Shown in the calendar and on the share link; null when not set. */
  area: string | null;
  line: string | null;
  /** The panel's evaluations — one per interviewer who has filed. Shown only to those who can book or
   * who are on the interview; never to a guest. Empty when none filed or the viewer may not see them. */
  scorecards: InterviewScorecard[];
  /** Whether THIS viewer may file their own scorecard — true only for someone on the interview. */
  canScoreInterview: boolean;
  /** The chosen interviewer's answer to the assignment, or null when unanswered (owner, 2026-09-26). */
  interviewerConfirmation: InterviewConfirmation | null;
  /** When that answer was given, and by whom (the interviewer's own name). */
  confirmationAt: string | null;
  confirmedByName: string | null;
  /** Why the interviewer declined, when they left a reason. Null unless declined. */
  declineReason: string | null;
  /** Whether THIS viewer may confirm/decline — true only for the lead interviewer, before it happens. */
  canConfirmInterview: boolean;
  /** The change history, newest first — shown to everyone who can read the booking. */
  changeHistory: InterviewChange[];
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
  /** What happened at the interview, once the interviewer has said. */
  outcome: InterviewOutcome | null;
  outcomeSetByName: string | null;
  outcomeSetAt: string | null;
  /** Whether THIS viewer may set the outcome: the interviewer, or the calendar's owner. */
  canSetOutcome: boolean;
  /**
   * Whether THIS viewer may change the interview's day, time and place.
   *
   * True for the calendar's booking tier (owner/editor/HR) as always — and, since the owner asked for
   * it, ALSO for the DISTRICT MANAGER WHO REQUESTED this interview, on their own request's booking. It
   * covers the day/time/place only; the interviewer, panel and area/line stay HR's, and a session slot
   * is never rescheduled this way. A past interview and a link guest are both false.
   */
  canReschedule: boolean;
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
  /** The person's own sales Area and Line from their org seat, when they hold one (null for a seat
   * above District Manager, or an HR/CEO seat). Used to auto-fill an interview's area & line. */
  area?: string | null;
  line?: string | null;
};

export type DueZoomInterview = {
  bookingId: string;
  candidateName: string;
  dateKey: string;
  startMinutes: number;
  /** What the screen opens: the host link when Zoom gave one (the meeting starts itself), else the guest link. */
  openUrl: string;
  asHost: boolean;
};

export type InterviewCalendarMe = {
  role: InterviewCalendarRole | null;
  zoomConnected: boolean;
  /** May search Recruitment's candidates from an empty cell (needs to be able to read them). */
  canSearchCandidates?: boolean;
  /** May add an outside person to Recruitment while booking them (needs to create candidates). */
  canAddToRecruitment?: boolean;
  /** May ask for an interview (a District Manager and above, or HR) — draws the Request button. */
  canRequest?: boolean;
  /** May give a request's CVs their times (HR and the calendar's owners) — draws the HR inbox. */
  canBook?: boolean;
};

// ── Interview requests (the two-step "ask for a day, HR books the time" flow) ─────────────────────
//
// The owner, 2026-09-23: a District Manager (and above) or HR asks for an interview by choosing a
// DAY (no time) and attaching CVs — uploaded, or picked from Recruitment — and the interviewer (the
// line's NSM, or the HR head). HR then phones the candidates and gives each CV a real time, which
// turns the request into booked slots that show on BOTH the requester's and the interviewer's
// calendar. This is added BESIDE the existing direct booking; nothing about direct booking changes.

export type InterviewRequestStatus = "pending" | "scheduled" | "cancelled";

export const INTERVIEW_REQUEST_STATUS_LABEL: Record<InterviewRequestStatus, string> = {
  cancelled: "Cancelled",
  pending: "Waiting for HR",
  scheduled: "Times booked",
};

export function isInterviewRequestStatus(value: unknown): value is InterviewRequestStatus {
  return value === "pending" || value === "scheduled" || value === "cancelled";
}

/** One CV on a request: a Recruitment candidate, or an outside person kept on the request only. */
export type InterviewRequestItem = {
  id: string;
  candidateId: string | null;
  candidateName: string;
  /** The job the CV applied for, when it names one. */
  candidateJobTitle: string | null;
  /** An outside person the requester did NOT add to Recruitment. */
  external: boolean;
  externalPhone: string | null;
  externalEmail: string | null;
  externalHasCv: boolean;
  externalCvFileName: string | null;
  externalCvMimeType: string | null;
  /**
   * The CV a reader can open from the request itself, for an in-house candidate AND an outside person
   * alike — so the inbox can draw one "View CV" control without knowing where the file is kept. Until
   * this existed a request waiting for a time showed "CV attached" as a sentence with nothing to press:
   * the calendar's CV doors open only a candidate who already holds a booking.
   */
  hasCv: boolean;
  cvFileName: string | null;
  cvMimeType: string | null;
  /** The booking this CV became once HR gave it a time, or null while it waits. */
  bookingId: string | null;
  booked: boolean;
};

export type InterviewRequest = {
  id: string;
  requestedByHrId: string;
  requestedByName: string;
  interviewerHrId: string;
  interviewerName: string;
  /** The Cairo day asked for, YYYY-MM-DD. No time — HR sets that per CV. */
  requestedDay: string;
  line: string | null;
  note: string | null;
  status: InterviewRequestStatus;
  items: InterviewRequestItem[];
  /** How many of its CVs still have no time booked. */
  pendingItemCount: number;
  createdAt: string;
  updatedAt: string;
};

// ── Sessions ────────────────────────────────────────────────────────────────────────────────────

/**
 * An interview SESSION — one meeting for a block of a day, cut into slots, a candidate to each
 * (the owner, 2026-09-18: "day 20 from 11 a.m. to 3 p.m."). Every slot shares the session's link.
 */
export type InterviewSession = {
  id: string;
  title: string | null;
  dateKey: string;
  startMinutes: number;
  durationMinutes: number;
  slotMinutes: number;
  platform: InterviewPlatform;
  zoomStatus: InterviewZoomStatus;
  zoomJoinUrl: string | null;
  zoomError: string | null;
  notes: string | null;
  createdByName: string | null;
  ended: boolean;
};

/** Every slot of a session, in order — the start minutes of each. */
export function sessionSlotStarts(session: Pick<InterviewSession, "startMinutes" | "durationMinutes" | "slotMinutes">): number[] {
  const starts: number[] = [];
  if (session.slotMinutes <= 0) return starts;
  for (let at = session.startMinutes; at + session.slotMinutes <= session.startMinutes + session.durationMinutes; at += session.slotMinutes) {
    starts.push(at);
  }
  return starts;
}

// ── Polls ───────────────────────────────────────────────────────────────────────────────────────

export type InterviewPollQuestionType = "single" | "multiple" | "short_answer";

export const POLL_QUESTION_TYPE_LABEL: Record<InterviewPollQuestionType, string> = {
  multiple: "Several answers",
  short_answer: "Written answer",
  single: "One answer",
};

export type InterviewPollQuestion = {
  name: string;
  type: InterviewPollQuestionType;
  /** The choices — two to ten for a choice question, none for a written answer. */
  answers: string[];
};

export type InterviewPollSet = {
  id: string;
  name: string;
  questions: InterviewPollQuestion[];
  updatedAt: string;
};

export type InterviewPoll = {
  id: string;
  title: string;
  questions: InterviewPollQuestion[];
  status: "pending" | "created" | "failed";
  error: string | null;
  fromSetName: string | null;
};

/**
 * A poll as typed, checked. Returns the clean poll or the sentence that says what to fix — shared by
 * the dialog (to say it before sending) and the server (to refuse it).
 */
export function checkPollQuestions(raw: unknown): { questions: InterviewPollQuestion[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { error: "Add at least one question." };
  if (raw.length > 25) return { error: "A poll holds up to 25 questions." };
  const questions: InterviewPollQuestion[] = [];
  for (const [index, item] of raw.entries()) {
    const entry = (item ?? {}) as Record<string, unknown>;
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    const number = index + 1;
    if (!name) return { error: `Question ${number} has no text.` };
    if (name.length > 255) return { error: `Question ${number} is longer than 255 characters.` };
    const type = entry.type;
    if (type !== "single" && type !== "multiple" && type !== "short_answer") return { error: `Choose what kind of answer question ${number} takes.` };
    const answers = type === "short_answer"
      ? []
      : (Array.isArray(entry.answers) ? entry.answers : []).map((answer) => (typeof answer === "string" ? answer.trim() : "")).filter(Boolean);
    if (type !== "short_answer" && answers.length < 2) return { error: `Question ${number} needs at least two choices.` };
    if (answers.length > 10) return { error: `Question ${number} has more than ten choices.` };
    if (answers.some((answer) => answer.length > 200)) return { error: `A choice in question ${number} is longer than 200 characters.` };
    questions.push({ answers, name, type });
  }
  return { questions };
}

// ── What Zoom reported ──────────────────────────────────────────────────────────────────────────

export type InterviewAttendee = {
  name: string;
  email: string | null;
  joinedAt: string | null;
  leftAt: string | null;
  /** Seconds in the meeting, summed over every time this person joined. */
  seconds: number;
};

export type InterviewPollAnswer = {
  participant: string;
  email: string | null;
  question: string;
  answer: string;
  at: string | null;
};

export type InterviewMeetingSummary = {
  title: string | null;
  overview: string | null;
  details: Array<{ label: string; summary: string }>;
  nextSteps: string[];
  /** Zoom's newer single-text summary, when it sends that instead. */
  content: string | null;
};

/** One section of a Zoom report: what it holds, or the sentence that says why it is empty. */
export type InterviewInsightPart<T> = { data: T | null; note: string | null };

export type InterviewZoomInsights = {
  /** "not_held" before the interview's time is over; "ready" after, whatever Zoom had. */
  state: "no_meeting" | "not_held" | "ready";
  fetchedAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  attendance: InterviewInsightPart<InterviewAttendee[]>;
  polls: InterviewInsightPart<InterviewPollAnswer[]>;
  summary: InterviewInsightPart<InterviewMeetingSummary>;
};

// ── WhatsApp, without sending anything ──────────────────────────────────────────────────────────

/**
 * A WhatsApp "click to chat" address with the text filled in. It OPENS WhatsApp on the person's own
 * phone or computer; nothing is sent until they press Send there (the owner's rule: Phoenix sends
 * the candidate nothing). With a phone, the chat opens on that number; without, WhatsApp asks who.
 */
export function whatsAppShareUrl(text: string, phone?: string | null): string {
  const digits = normalizeEgyptianMobile(phone);
  return `https://wa.me/${digits ?? ""}?text=${encodeURIComponent(text)}`;
}

/** 01xxxxxxxxx, +201xxxxxxxxx, 00201xxxxxxxxx → 201xxxxxxxxx; anything else international kept as digits. */
export function normalizeEgyptianMobile(phone: string | null | undefined): string | null {
  let digits = String(phone ?? "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (/^01[0125]\d{8}$/.test(digits)) return `2${digits}`;
  if (/^1[0125]\d{8}$/.test(digits)) return `20${digits}`;
  return digits.length >= 10 && digits.length <= 15 ? digits : null;
}

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
