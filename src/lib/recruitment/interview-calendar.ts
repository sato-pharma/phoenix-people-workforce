// Recruitment — the interview calendar: book an interview from any CV, see the week, share it.
//
// The owner, 2026-09-18: from any CV, on any screen, with none of the pipeline's steps, "schedule an
// interview": a date, a time, In office or Zoom. Then a week calendar — per day, per hour — that
// exports to PDF or Excel with every name opening its CV, and that he can share from Phoenix as
// Viewer, Commenter or Editor. His answers in chat decided the rest:
//
//   · Nothing is sent to the candidate. The calendar is the whole of it.
//   · Only he and the people he shares it with can see it.
//   · Phoenix creates the Zoom meeting itself (src/lib/zoom/meetings.ts).
//   · Sunday to Thursday, 9:00 AM to 5:00 PM, half-hour rows (interview-calendar-week.ts).
//
// The same evening he asked for more, and answered each question in chat:
//
//   · A COPY LINK "exactly as Google Sheets" — a level (viewer, commenter, editor), the whole calendar
//     or one week, switched off and on by him. Holding it VIEWS with no sign-in; commenting and
//     editing take a Phoenix sign-in, which then gives the link's level (interview-calendar-links.ts).
//   · A Zoom BLOCK ("day 20 from 11 a.m. to 3 p.m.") — both kinds: a SESSION, one meeting cut into
//     slots of 15 to 60 minutes with a candidate in each; and single interviews up to the whole day.
//   · Pressable empty cells that book a Phoenix candidate OR someone from outside — a name, a phone,
//     an e-mail and a CV, added to Recruitment by default or kept on the booking only.
//   · Zoom's attendance, polls, invitation and AI summary on each interview, for everyone it is
//     shared with (interview-calendar-zoom-extras.ts).
//
// THIS FILE IS THE LOCK. Every read and write resolves who is asking into a CALLER — their own
// level (owner or a share) and the copy link they hold, if any — and passes `requireCalendarAccess`
// for the WEEK it touches before it touches a row. The tables are service-role only (migrations
// 20260918195837 and 20260918215608), so there is no other road to them. The screens hide what a
// level cannot do; they are not what stops it.
//
// WHY THE OWNER IS "THE SUPER ADMIN". The owner is the only account holding that role. Tying
// ownership to the role rather than to one HR id means the check reads the same fact every other
// Super Admin gate reads, and survives the id being written in a different case. It is the ROLE, not
// the scope: a signed-in Super Admin's scope is "company" (isInterviewCalendarOwner explains). HR
// Operations is an owner too, as the calendar's admin (owner, 2026-09-21).

import { assertPermission, canAccess, type AccessContext } from "@/lib/auth/permissions";
import { ACTIVE_EMPLOYMENT_STATUSES_IN_LIST } from "@/lib/auth/session-lifecycle";
import { canonicalHrIdKey, hrIdForStorage, hrIdLookupKeys } from "@/lib/hr-id";
import { isUuid } from "@/lib/http/uuid";
import { createSystemNotification } from "@/lib/notifications/system";
import { logError } from "@/lib/observability/log";
import { listOfferJobTitles } from "@/lib/offers/service";
import { calendarCandidateNotice, resolveCalendarCandidate } from "@/lib/recruitment/calendar-candidate-resolve";
import { candidateStatusLabels, normalizeCandidateStatus, statusChangeRefusal } from "@/lib/recruitment/candidate-status";
import {
  createCandidate,
  findCandidatesByPhoneNorm,
  getCandidate,
  setCandidateRating,
  updateCandidateStatus,
} from "@/lib/recruitment/candidates";
import { primaryCvFile } from "@/lib/recruitment/cv-file-choice";
import { detectCvFileKind } from "@/lib/recruitment/cv-file-kind";
import { recruitmentDb } from "@/lib/recruitment/db";
import { mirrorCandidateCvsToDrive } from "@/lib/recruitment/drive-cv-mirror";
import { getRecruitmentFileStorage } from "@/lib/recruitment/file-storage";
import {
  cvContentFingerprint,
  findCandidateIdByContentFingerprint,
  getFileForDownload,
  listCandidateFiles,
  listCandidateFilesByCandidate,
  uploadCandidateFile,
  type FileDownload,
} from "@/lib/recruitment/files";
import {
  bestCalendarRole,
  effectiveCalendarRole,
  interviewCalendarHref,
  isInterviewCalendarAccessLevel,
  isInterviewCalendarOwner,
  isDistrictManagerOrAbove,
  interviewAwaitsOutcome,
  interviewOutcomeCandidateEffect,
  interviewOutcomeLabels,
  isInterviewPlatform,
  isInterviewVerdict,
  readInterviewOutcome,
  resolveCalendarRole,
  roleMeets,
  seesWholeInterviewCalendar,
  sessionSlotStarts,
  type DueZoomInterview,
  type InterviewBooking,
  type InterviewBookingComment,
  type InterviewChange,
  type InterviewScorecard,
  type InterviewVerdict,
  type InterviewCalendarAccessLevel,
  type InterviewCalendarLinkGrant,
  type InterviewCalendarNeed,
  type InterviewCalendarPerson,
  type InterviewCalendarRole,
  type InterviewCalendarShare,
  type InterviewManagerShareItem,
  type InterviewManagerSharePlan,
  type InterviewOutcome,
  type InterviewPlatform,
  type InterviewSession,
  type InterviewZoomStatus,
} from "@/lib/recruitment/interview-calendar-types";
import {
  ALL_DURATION_CHOICES,
  MAX_DURATION_MINUTES,
  SESSION_SLOT_CHOICES,
  cairoDateKey,
  cairoLocalToUtc,
  cairoMinutesOfDay,
  formatDayLong,
  formatTimeOfDay,
  formatWeekRange,
  isBookableDay,
  isBookableWindow,
  isDateKey,
  weekInstantRange,
  weekStartFor,
} from "@/lib/recruitment/interview-calendar-week";
import { INTERVIEW_OUTCOME_WINDOW_DAYS } from "@/lib/recruitment/interview-outcome-window";
import { canOpenWhatsAppApplications } from "@/lib/recruitment/whatsapp-application-access";
import { findWhatsAppApplicationSessionId } from "@/lib/recruitment/whatsapp-applicants-loader";
import { ilikeAnyFilter, ilikeContainsValue } from "@/lib/supabase/search-filter";
import {
  createZoomMeeting,
  createZoomPoll,
  deleteZoomMeeting,
  getZoomHostStartUrl,
  readZoomConfig,
  updateZoomMeeting,
  zoomMeetingIdFromJoinUrl,
  type ZoomConfig,
} from "@/lib/zoom/meetings";

const BOOKINGS = "ats_interview_bookings";
const SESSIONS = "ats_interview_sessions";
const SHARES = "ats_interview_calendar_shares";
const COMMENTS = "ats_interview_booking_comments";
const SCORECARDS = "ats_interview_scorecards";
const CHANGES = "ats_interview_booking_changes";
const LINKS = "ats_interview_calendar_links";
const POLLS = "ats_interview_zoom_polls";

const NOTE_LIMIT = 1000;
const DECLINE_REASON_LIMIT = 500;

// ── Who is asking ───────────────────────────────────────────────────────────────────────────────

type ShareRow = {
  hr_id: string;
  access_level: string;
  shared_by_hr_id: string | null;
  created_at: string;
  updated_at: string;
};

async function loadShareRows(): Promise<ShareRow[]> {
  const { data, error } = await recruitmentDb()
    .from(SHARES)
    .select("hr_id,access_level,shared_by_hr_id,created_at,updated_at")
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as ShareRow[];
}

function shareLevelFor(rows: readonly ShareRow[], hrId: string | null | undefined): InterviewCalendarAccessLevel | null {
  const key = canonicalHrIdKey(hrId);
  if (!key) return null;
  const row = rows.find((entry) => canonicalHrIdKey(entry.hr_id) === key);
  return row && isInterviewCalendarAccessLevel(row.access_level) ? row.access_level : null;
}

export { isInterviewCalendarOwner };

/** Signed in to Phoenix — a real session, not the guest context a request with no cookie gets. */
export function isSignedInCaller(access: AccessContext): boolean {
  return access.source !== "guest" && Boolean(access.loginId || access.hrId);
}

/**
 * Whether the calendar's owner chose this person to conduct at least one interview — and they are a
 * District Manager or above. That, and only that, gives the `interviewer` role: a Medical Rep chosen
 * before the rule existed holds nothing, and neither does anyone chosen for no interview.
 */
async function isChosenInterviewer(access: AccessContext): Promise<boolean> {
  if (!access.hrId) return false;
  const { data, error } = await recruitmentDb()
    .from(BOOKINGS)
    .select("id")
    .in("interviewer_hr_id", hrIdLookupKeys(access.hrId))
    .limit(1);
  if (error) throw error;
  if (!data || data.length === 0) return false;
  const person = (await loadPeople([access.hrId])).get(canonicalHrIdKey(access.hrId) ?? "");
  return isDistrictManagerOrAbove({ jobTitle: person?.jobTitle ?? null, role: access.role });
}

/**
 * Whether this seat may REQUEST interviews — and so is shown the calendar as a `requester` by their
 * seat, before any booking names them. A District Manager or above, or HR (owner, 2026-09-23 —
 * "district managers and up + HR"). A Medical Rep cannot: the same line that keeps candidates' CVs to
 * District-Manager-and-above. HR is read from the app role; the ladder from role first, then job title.
 */
export function isInterviewRequesterSeat(access: AccessContext, person: InterviewCalendarPerson | null): boolean {
  const role = (access.role ?? "").trim();
  if (/^hr\b/i.test(role) || /human resources/i.test(role)) return true;
  return isDistrictManagerOrAbove({ jobTitle: person?.jobTitle ?? null, role });
}

/** May this caller ask for an interview: an owner, or a requester-eligible seat. */
export async function mayRequestInterviews(access: AccessContext): Promise<boolean> {
  if (!isSignedInCaller(access)) return false;
  if (isInterviewCalendarOwner(access)) return true;
  if (!access.hrId) return false;
  const person = (await loadPeople([access.hrId])).get(canonicalHrIdKey(access.hrId) ?? "") ?? null;
  return isInterviewRequesterSeat(access, person);
}

/**
 * Their OWN level: the owner, a share he made, `interviewer` for a District Manager or above he chose
 * to conduct an interview, else `requester` for any District Manager / above / HR seat. A share
 * outranks the two seat roles (a Viewer sees the whole calendar). A copy link is not this — see the
 * caller below.
 */
export async function resolveInterviewCalendarRole(access: AccessContext): Promise<InterviewCalendarRole | null> {
  if (access.source === "guest") return null;
  const isOwner = isInterviewCalendarOwner(access);
  if (isOwner) return "owner";
  if (!access.hrId) return null;
  const shared = resolveCalendarRole({ isOwner, shareLevel: shareLevelFor(await loadShareRows(), access.hrId) });
  if (shared) return shared;
  // The CEO reads the WHOLE calendar (owner, 2026-09-26) — as a Viewer, above the own-only tier, so
  // mayReadBooking serves him every interview, not only the ones he was chosen for. A share he holds
  // (checked just above) still wins if it is higher; his seat still lets him request an interview.
  if (seesWholeInterviewCalendar(access)) return "viewer";
  if (await isChosenInterviewer(access)) return "interviewer";
  // A District Manager or above, or HR, holds the calendar as a requester by their seat — so it shows
  // in their sidebar and they can ask for an interview even before any booking names them.
  const person = (await loadPeople([access.hrId])).get(canonicalHrIdKey(access.hrId) ?? "") ?? null;
  return isInterviewRequesterSeat(access, person) ? "requester" : null;
}

/**
 * May this caller read THIS booking? Everyone whose level on the booking's week is above `interviewer`
 * reads all of them; an interviewer reads only the ones they were chosen for. Every place that serves a
 * booking to a `view` caller asks this — the gate alone would hand an interviewer the whole calendar.
 */
export function mayReadBooking(
  caller: InterviewCalendarCaller,
  row: {
    starts_at: string;
    interviewer_hr_id: string | null;
    requested_by_hr_id?: string | null;
    panelist_hr_ids?: string[] | null;
    shared_with_hr_ids?: string[] | null;
  },
): boolean {
  const role = calendarRoleFor(caller, weekOfInstant(row.starts_at));
  if (!role) return false;
  // Everyone above the own-only tier (a Viewer and up) reads every booking.
  if (role !== "interviewer" && role !== "requester") return true;
  // The own-only tier — an interviewer or a requester — reads ONLY the interviews it is part of: the
  // ones it was chosen to conduct (as the lead OR anywhere on the panel), the ones it requested, and
  // the ones the owner shared with it one by one (owner, 2026-10-26 — a district manager sees only
  // the interviews for their own region, never the whole calendar). A District Manager who does more
  // than one of these sees them all.
  const viewer = canonicalHrIdKey(caller.access.hrId);
  if (!viewer) return false;
  return (
    viewer === canonicalHrIdKey(row.interviewer_hr_id) ||
    viewer === canonicalHrIdKey(row.requested_by_hr_id) ||
    isOnPanel(viewer, row.panelist_hr_ids) ||
    isOnPanel(viewer, row.shared_with_hr_ids)
  );
}

/** Whether a canonical hr-id key is one of a booking's additional panel members. */
function isOnPanel(viewerKey: string | null, panelistHrIds: string[] | null | undefined): boolean {
  if (!viewerKey || !panelistHrIds?.length) return false;
  return panelistHrIds.some((hrId) => canonicalHrIdKey(hrId) === viewerKey);
}

/**
 * May this caller read THIS request? The same lens as a booking: everyone above the own-only tier
 * (a Viewer and up — HR, the owner) reads every request; the own-only tier reads only the requests it
 * is part of — the ones it asked for, and the ones it was chosen to conduct.
 */
export function mayReadRequest(
  caller: InterviewCalendarCaller,
  row: { interviewer_hr_id: string | null; requested_by_hr_id?: string | null },
): boolean {
  const role = calendarRoleFor(caller, "any");
  if (!role) return false;
  if (role !== "interviewer" && role !== "requester") return true;
  const viewer = canonicalHrIdKey(caller.access.hrId);
  if (!viewer) return false;
  return viewer === canonicalHrIdKey(row.interviewer_hr_id) || viewer === canonicalHrIdKey(row.requested_by_hr_id);
}

/**
 * Sessions (group interviews) belong to the calendar's people (Viewer and up), never to the own-only
 * tier — an interviewer or a requester, who each see only the interviews they are part of.
 */
function mayReadSessions(caller: InterviewCalendarCaller, weekStart: string): boolean {
  const role = calendarRoleFor(caller, weekStart);
  return role !== null && role !== "interviewer" && role !== "requester";
}

const NOT_YOURS = "Forbidden: this interview is not one you were chosen to conduct.";

/**
 * How long the sidebar's yes/no is kept per person. It only decides whether a LINK shows: the page and
 * every route behind it still resolve the role fresh, so a share switched off is refused at once and
 * at worst the link lingers this long. Before it the answer cost three round trips (shares, bookings,
 * the person) on every portal document load, for a Medical Rep who can never hold the calendar too.
 */
const CALENDAR_ACCESS_TTL_MS = 2 * 60_000;
const CALENDAR_ACCESS_MAX_PEOPLE = 2000;
const calendarAccessCache = new Map<string, { at: number; value: Promise<boolean> }>();

/** Whether this person should be offered the calendar at all — the portal sidebar asks this. */
export async function hasInterviewCalendarAccess(access: AccessContext): Promise<boolean> {
  const key = `${access.source}|${canonicalHrIdKey(access.hrId) ?? ""}|${access.loginId ?? ""}|${access.role ?? ""}|${access.scope ?? ""}`;
  const now = Date.now();
  const cached = calendarAccessCache.get(key);
  if (cached && now - cached.at < CALENDAR_ACCESS_TTL_MS) return cached.value;
  const value = resolveInterviewCalendarRole(access).then(
    (role) => role !== null,
    () => {
      // A failed read is answered "no" and not kept, so the next load asks again.
      calendarAccessCache.delete(key);
      return false;
    },
  );
  if (calendarAccessCache.size >= CALENDAR_ACCESS_MAX_PEOPLE) calendarAccessCache.clear();
  calendarAccessCache.set(key, { at: now, value });
  return value;
}

/**
 * Everything the gate needs about who is asking: their own level, and the copy link they came
 * through. Resolved once per request, then asked about each week the request touches.
 */
export type InterviewCalendarCaller = {
  access: AccessContext;
  own: InterviewCalendarRole | null;
  link: InterviewCalendarLinkGrant | null;
};

/** The header a caller may carry the link in; the `link` query parameter works the same. */
export const INTERVIEW_CALENDAR_LINK_HEADER = "x-interview-calendar-link";

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{32,128}$/;

export function linkTokenFrom(request: Request | null | undefined): string | null {
  if (!request) return null;
  const fromQuery = new URL(request.url).searchParams.get("link");
  const token = (fromQuery ?? request.headers.get(INTERVIEW_CALENDAR_LINK_HEADER) ?? "").trim();
  return token || null;
}

export type InterviewCalendarLinkRow = {
  id: string;
  token: string;
  access_level: string;
  week_start: string | null;
  guest_cvs: boolean | null;
  is_active: boolean | null;
  created_by_hr_id: string | null;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
  use_count: number | null;
};

export const LINK_COLUMNS =
  "id,token,access_level,week_start,guest_cvs,is_active,created_by_hr_id,created_at,updated_at,last_used_at,use_count";

export async function loadInterviewCalendarLinkByToken(token: string): Promise<InterviewCalendarLinkRow | null> {
  // A token that could not have been minted is not looked up at all.
  if (!TOKEN_SHAPE.test(token)) return null;
  const { data, error } = await recruitmentDb().from(LINKS).select(LINK_COLUMNS).eq("token", token).maybeSingle();
  if (error) throw error;
  return (data as InterviewCalendarLinkRow | null) ?? null;
}

/** The grant a link row gives — none when it is switched off. */
export function grantFromLinkRow(row: InterviewCalendarLinkRow, signedIn: boolean): InterviewCalendarLinkGrant | null {
  if (row.is_active === false || !isInterviewCalendarAccessLevel(row.access_level)) return null;
  return {
    accessLevel: row.access_level,
    guestCvs: row.guest_cvs !== false,
    id: row.id,
    signedIn,
    weekStart: row.week_start ? String(row.week_start).slice(0, 10) : null,
  };
}

const LINK_OFF = "Forbidden: this link to the interview calendar was switched off, or it does not exist.";

export async function interviewCalendarCaller(access: AccessContext, request?: Request | null): Promise<InterviewCalendarCaller> {
  const signedIn = isSignedInCaller(access);
  const own = signedIn || access.source === "system" ? await resolveInterviewCalendarRole(access) : null;
  const token = linkTokenFrom(request);
  let link: InterviewCalendarLinkGrant | null = null;
  if (token) {
    const row = await loadInterviewCalendarLinkByToken(token);
    link = row ? grantFromLinkRow(row, signedIn) : null;
    // A dead link refuses — unless the person holds the calendar in their own right anyway.
    if (!link && !own) throw new Error(LINK_OFF);
  }
  return { access, link, own };
}

/** A week (its Sunday), the calendar as a whole (null), or "any week at all". */
export type CalendarWeek = string | null | "any";

export function calendarRoleFor(caller: Pick<InterviewCalendarCaller, "own" | "link">, week: CalendarWeek): InterviewCalendarRole | null {
  return week === "any" ? bestCalendarRole(caller) : effectiveCalendarRole(caller, week);
}

const REFUSAL: Record<InterviewCalendarNeed, string> = {
  book: "Forbidden: only the calendar's owner and its editors can book, move or cancel interviews.",
  comment: "Forbidden: your access to the interview calendar is view-only.",
  share: "Forbidden: only the calendar's owner can share it.",
  view: "Forbidden: the interview calendar has not been shared with you.",
};

function refusalFor(caller: InterviewCalendarCaller, need: InterviewCalendarNeed, role: InterviewCalendarRole | null, week: CalendarWeek): string {
  if (!role) {
    if (caller.link?.weekStart && week !== "any") return `Forbidden: this link opens only the week of ${formatWeekRange(caller.link.weekStart)}.`;
    if (!caller.link && !isSignedInCaller(caller.access)) return "Forbidden: sign in to Phoenix to open the interview calendar.";
    return REFUSAL.view;
  }
  const linkLevel = caller.link && !caller.link.signedIn ? caller.link.accessLevel : null;
  if (linkLevel && need !== "share" && roleMeets(linkLevel, need)) {
    return "Forbidden: sign in to Phoenix to comment or edit — until you do, this link lets you view.";
  }
  return REFUSAL[need];
}

/**
 * THE ONE GATE. Throws a "Forbidden:" error the routes turn into a 403.
 *
 * `week` is the Sunday of the week the request touches — the level a person holds can differ by
 * week, because a copy link may open one week only. A move checks both the week it leaves and the
 * week it lands in. `null` asks about the calendar as a whole (sharing it); "any" about anywhere on it.
 */
export function requireCalendarAccess(caller: InterviewCalendarCaller, need: InterviewCalendarNeed, week: CalendarWeek): InterviewCalendarRole {
  const role = calendarRoleFor(caller, week);
  if (roleMeets(role, need)) return role as InterviewCalendarRole;
  throw new Error(refusalFor(caller, need, role, week));
}

/**
 * Who may search for the person to conduct an interview. Booking rights (owner, editor, HR) pass, and
 * so does a requester or a chosen interviewer: the request flow's whole point is that a District
 * Manager who cannot book still names who will conduct the interview (owner, 2026-09-23). Requiring
 * "book" here was the bug that made the picker read "Nobody matches that" for every requester. A plain
 * viewer or commenter has no reason to pick an interviewer, so they get the ordinary book refusal.
 */
export function assertMayPickInterviewer(caller: InterviewCalendarCaller): void {
  const role = calendarRoleFor(caller, "any");
  if (roleMeets(role, "book") || role === "requester" || role === "interviewer") return;
  requireCalendarAccess(caller, "book", "any");
}

/**
 * The book gate, plus the one exception the owner asked for (2026-09-23): a District Manager may
 * "slot himself" — book a standalone interview where HE is the interviewer — even though a requester
 * seat cannot otherwise book. It is only ever his OWN time: the chosen interviewer must be the caller.
 * Everyone with real book rights (owner, editor, HR) passes straight through.
 */
export function assertMayBookInterview(caller: InterviewCalendarCaller, week: CalendarWeek, interviewerHrId: unknown): void {
  const role = calendarRoleFor(caller, week);
  if (roleMeets(role, "book")) return;
  if ((role === "requester" || role === "interviewer") && isSignedInCaller(caller.access)) {
    const me = canonicalHrIdKey(caller.access.hrId);
    const chosen = canonicalHrIdKey(typeof interviewerHrId === "string" ? interviewerHrId : "");
    if (me && chosen && me === chosen) return;
  }
  throw new Error(refusalFor(caller, "book", role, week));
}

/**
 * Whether a caller may reach into Recruitment from the calendar — find a candidate to book, or add an
 * outside person to Recruitment while booking. Recruitment's own grant, or being an OWNER of the
 * calendar: the owner gave HR Operations "full access and control" of it (2026-09-21), and she holds
 * no `candidates` grant, so without this the calendar's admin could not book a Phoenix candidate.
 * Only here, only from the calendar — it opens nothing else in Recruitment.
 */
async function mayUseRecruitmentFromCalendar(access: AccessContext, action: "read" | "create"): Promise<boolean> {
  if (!isSignedInCaller(access)) return false;
  if (isInterviewCalendarOwner(access)) return true;
  return canAccess(access, "candidates", action).catch(() => false);
}

/** The same rule as a refusal: an owner passes; everyone else needs Recruitment's own grant. */
async function assertMayUseRecruitmentFromCalendar(access: AccessContext, action: "read" | "create"): Promise<void> {
  if (isSignedInCaller(access) && isInterviewCalendarOwner(access)) return;
  await assertPermission(access, "candidates", action);
}

/** What a caller may do outside the calendar's own tables, for the screen to draw the right choices. */
export async function interviewCalendarAbilities(access: AccessContext): Promise<{ canSearchCandidates: boolean; canAddToRecruitment: boolean }> {
  if (!isSignedInCaller(access)) return { canAddToRecruitment: false, canSearchCandidates: false };
  const [search, add] = await Promise.all([
    mayUseRecruitmentFromCalendar(access, "read"),
    mayUseRecruitmentFromCalendar(access, "create"),
  ]);
  return { canAddToRecruitment: Boolean(add), canSearchCandidates: Boolean(search) };
}

// ── Names ───────────────────────────────────────────────────────────────────────────────────────

type EmployeeRow = { hr_id: string | null; full_name: string | null; nickname: string | null; job_title: string | null };

export async function loadPeople(hrIds: Iterable<string | null | undefined>): Promise<Map<string, InterviewCalendarPerson>> {
  const people = new Map<string, InterviewCalendarPerson>();
  const keys = Array.from(new Set(Array.from(hrIds).flatMap((id) => (id ? hrIdLookupKeys(id) : []))));
  if (keys.length === 0) return people;
  const { data, error } = await recruitmentDb()
    .from("employees")
    .select("hr_id,full_name,nickname,job_title")
    .in("hr_id", keys);
  if (error) throw error;
  for (const row of (data ?? []) as EmployeeRow[]) {
    const key = canonicalHrIdKey(row.hr_id);
    const name = String(row.nickname || row.full_name || "").trim();
    if (key && name) people.set(key, { hrId: hrIdForStorage(row.hr_id) ?? String(row.hr_id), jobTitle: row.job_title ?? null, name });
  }
  return people;
}

export function personName(people: Map<string, InterviewCalendarPerson>, hrId: string | null | undefined): string | null {
  const key = canonicalHrIdKey(hrId);
  return key ? people.get(key)?.name ?? null : null;
}

// ── Rows ────────────────────────────────────────────────────────────────────────────────────────

type BookingRow = {
  id: string;
  candidate_id: string | null;
  session_id: string | null;
  starts_at: string;
  duration_minutes: number;
  platform: string;
  zoom_status: string;
  zoom_meeting_id: string | null;
  zoom_join_url: string | null;
  zoom_error: string | null;
  notes: string | null;
  external_name: string | null;
  external_phone: string | null;
  external_email: string | null;
  external_cv_file_id: string | null;
  external_cv_file_name: string | null;
  external_cv_mime_type: string | null;
  interviewer_hr_id: string | null;
  panelist_hr_ids: string[] | null;
  shared_with_hr_ids: string[] | null;
  interview_area: string | null;
  interview_line: string | null;
  interview_job_title: string | null;
  interviewer_confirmation: string | null;
  interviewer_confirmation_at: string | null;
  interviewer_confirmation_by_hr_id: string | null;
  decline_reason: string | null;
  outcome: string | null;
  outcome_set_by_hr_id: string | null;
  outcome_set_at: string | null;
  request_id: string | null;
  requested_by_hr_id: string | null;
  created_by_hr_id: string | null;
  updated_by_hr_id: string | null;
  created_at: string;
  updated_at: string;
};

type SessionRow = {
  id: string;
  title: string | null;
  starts_at: string;
  duration_minutes: number;
  slot_minutes: number;
  platform: string;
  zoom_status: string;
  zoom_meeting_id: string | null;
  zoom_join_url: string | null;
  zoom_error: string | null;
  notes: string | null;
  created_by_hr_id: string | null;
  updated_by_hr_id: string | null;
  created_at: string;
  updated_at: string;
};

type CommentRow = { id: string; booking_id: string; author_hr_id: string; body: string; created_at: string };
type CandidateRow = { id: string; full_name: string | null; applied_for_job_title: string | null };

const BOOKING_COLUMNS =
  "id,candidate_id,session_id,starts_at,duration_minutes,platform,zoom_status,zoom_meeting_id,zoom_join_url,zoom_error,notes,external_name,external_phone,external_email,external_cv_file_id,external_cv_file_name,external_cv_mime_type,interviewer_hr_id,panelist_hr_ids,shared_with_hr_ids,interview_area,interview_line,interview_job_title,interviewer_confirmation,interviewer_confirmation_at,interviewer_confirmation_by_hr_id,decline_reason,outcome,outcome_set_by_hr_id,outcome_set_at,request_id,requested_by_hr_id,created_by_hr_id,updated_by_hr_id,created_at,updated_at";

const SESSION_COLUMNS =
  "id,title,starts_at,duration_minutes,slot_minutes,platform,zoom_status,zoom_meeting_id,zoom_join_url,zoom_error,notes,created_by_hr_id,updated_by_hr_id,created_at,updated_at";

async function loadCandidates(ids: readonly string[]): Promise<Map<string, CandidateRow>> {
  const byId = new Map<string, CandidateRow>();
  const unique = Array.from(new Set(ids.filter(Boolean)));
  // Chunked at 50: a PostgREST `.in()` with several hundred ids answers zero rows and no error.
  for (let index = 0; index < unique.length; index += 50) {
    const { data, error } = await recruitmentDb()
      .from("ats_candidates")
      .select("id,full_name,applied_for_job_title")
      .in("id", unique.slice(index, index + 50));
    if (error) throw error;
    for (const row of (data ?? []) as CandidateRow[]) byId.set(String(row.id), row);
  }
  return byId;
}

async function loadSessionsById(ids: readonly string[]): Promise<Map<string, SessionRow>> {
  const byId = new Map<string, SessionRow>();
  const unique = Array.from(new Set(ids.filter(Boolean)));
  for (let index = 0; index < unique.length; index += 50) {
    const { data, error } = await recruitmentDb().from(SESSIONS).select(SESSION_COLUMNS).in("id", unique.slice(index, index + 50));
    if (error) throw error;
    for (const row of (data ?? []) as SessionRow[]) byId.set(String(row.id), row);
  }
  return byId;
}

async function loadComments(bookingIds: readonly string[]): Promise<CommentRow[]> {
  const rows: CommentRow[] = [];
  for (let index = 0; index < bookingIds.length; index += 50) {
    const { data, error } = await recruitmentDb()
      .from(COMMENTS)
      .select("id,booking_id,author_hr_id,body,created_at")
      .in("booking_id", bookingIds.slice(index, index + 50))
      .order("created_at", { ascending: true });
    if (error) throw error;
    rows.push(...((data ?? []) as CommentRow[]));
  }
  return rows;
}

type ScorecardRow = { booking_id: string; evaluator_hr_id: string; rating: number; verdict: string; comment: string | null; updated_at: string };

async function loadScorecards(bookingIds: readonly string[]): Promise<ScorecardRow[]> {
  const rows: ScorecardRow[] = [];
  for (let index = 0; index < bookingIds.length; index += 50) {
    const { data, error } = await recruitmentDb()
      .from(SCORECARDS)
      .select("booking_id,evaluator_hr_id,rating,verdict,comment,updated_at")
      .in("booking_id", bookingIds.slice(index, index + 50))
      .order("updated_at", { ascending: true });
    if (error) throw error;
    rows.push(...((data ?? []) as ScorecardRow[]));
  }
  return rows;
}

type ChangeRow = { id: string; booking_id: string; actor_hr_id: string | null; kind: string; summary: string; created_at: string };

async function loadBookingChanges(bookingIds: readonly string[]): Promise<ChangeRow[]> {
  const rows: ChangeRow[] = [];
  for (let index = 0; index < bookingIds.length; index += 50) {
    const { data, error } = await recruitmentDb()
      .from(CHANGES)
      .select("id,booking_id,actor_hr_id,kind,summary,created_at")
      .in("booking_id", bookingIds.slice(index, index + 50))
      .order("created_at", { ascending: false });
    if (error) throw error;
    rows.push(...((data ?? []) as ChangeRow[]));
  }
  return rows;
}

/**
 * Append one entry to a booking's change history. BEST-EFFORT and swallowed: the history is a record
 * of a change that already happened, so a failure to log it must never undo or block the change
 * itself. The `kind` is a short slug; the `summary` is the human line shown in the detail view.
 */
async function recordBookingChange(bookingId: string, actorHrId: string | null, kind: string, summary: string): Promise<void> {
  try {
    await recruitmentDb().from(CHANGES).insert({ actor_hr_id: actorHrId, booking_id: bookingId, kind, summary });
  } catch {
    // A change already landed; a missing history line is not worth failing the mutation for.
  }
}

/** Is this caller ON the interview — the lead, or one of the panel — so they may file their own scorecard? */
function isInterviewAttendee(caller: InterviewCalendarCaller, row: { interviewer_hr_id: string | null; panelist_hr_ids?: string[] | null }): boolean {
  if (!isSignedInCaller(caller.access)) return false;
  const viewer = canonicalHrIdKey(caller.access.hrId);
  if (!viewer) return false;
  return viewer === canonicalHrIdKey(row.interviewer_hr_id) || isOnPanel(viewer, row.panelist_hr_ids);
}

function asInterviewVerdict(value: string): InterviewVerdict {
  return isInterviewVerdict(value) ? value : "no";
}

/**
 * File (or update) the signed-in caller's OWN scorecard for an interview: an overall rating 1-5 and a
 * verdict, plus an optional note. Only someone ON the interview — the lead or a panel member — may,
 * and only their own row (owner, 2026-09-26). It records an opinion; it moves nothing in Recruitment.
 */
export async function saveInterviewScorecard(
  caller: InterviewCalendarCaller,
  bookingId: string,
  input: { rating?: unknown; verdict?: unknown; comment?: unknown },
): Promise<InterviewBooking> {
  const row = await loadBookingRow(bookingId);
  requireCalendarAccess(caller, "view", weekOfInstant(row.starts_at));
  if (!isInterviewAttendee(caller, row)) {
    throw new Error("Only the interviewer or a panel member can score this interview.");
  }
  const rating = Number(input.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new Error("Give a rating from 1 to 5.");
  if (typeof input.verdict !== "string" || !isInterviewVerdict(input.verdict)) throw new Error("Choose a verdict.");
  const commentText = typeof input.comment === "string" ? input.comment.trim() : "";
  if (commentText.length > 2000) throw new Error("Keep the note under 2000 characters.");
  const evaluator = hrIdForStorage(caller.access.hrId);
  if (!evaluator) throw new Error("Sign in to Phoenix to score an interview.");
  const { error } = await recruitmentDb()
    .from(SCORECARDS)
    .upsert(
      {
        booking_id: row.id,
        comment: commentText || null,
        evaluator_hr_id: evaluator,
        rating,
        updated_at: new Date().toISOString(),
        verdict: input.verdict,
      },
      { onConflict: "booking_id,evaluator_hr_id" },
    );
  if (error) throw error;
  const [booking] = await hydrate([row], caller);
  return booking;
}

const INTERVIEW_PORTAL_BASE = "/employee-portals/interview-calendar";

/**
 * The chosen interviewer confirms ("I'll conduct it") or declines ("I can't") the assignment (owner,
 * 2026-09-26, Tier 3). Only the LEAD interviewer may answer, and only while the interview is still to
 * happen. A decline keeps the row so it can be reassigned, stops the reminders to him
 * (listInterviewsToRemindAbout skips a declined lead), and alerts the booker and the requester. Every
 * answer is written to the change history. Reassigning the interviewer clears the answer (see
 * updateInterviewBooking), so a new interviewer starts unanswered.
 */
export async function setInterviewerConfirmation(
  caller: InterviewCalendarCaller,
  bookingId: string,
  decision: unknown,
  reason?: unknown,
): Promise<InterviewBooking> {
  const row = await loadBookingRow(bookingId);
  requireCalendarAccess(caller, "view", weekOfInstant(row.starts_at));
  const viewer = canonicalHrIdKey(caller.access.hrId);
  if (!viewer || viewer !== canonicalHrIdKey(row.interviewer_hr_id)) {
    throw new Error("Only the interviewer chosen to conduct this interview can confirm or decline it.");
  }
  if (new Date().getTime() >= endsAt(row.starts_at, row.duration_minutes)) {
    throw new Error("This interview's time has passed — record its outcome instead.");
  }
  if (decision !== "confirmed" && decision !== "declined") throw new Error("Choose confirm or decline.");
  const declineReason = decision === "declined" && typeof reason === "string" ? reason.trim().slice(0, DECLINE_REASON_LIMIT) : null;
  const actor = hrIdForStorage(caller.access.hrId);
  const saved = await saveBooking(row.id, {
    interviewer_confirmation: decision,
    interviewer_confirmation_at: new Date().toISOString(),
    interviewer_confirmation_by_hr_id: actor,
    decline_reason: declineReason,
    updated_by_hr_id: actor,
  });
  const who = personName(await loadPeople([caller.access.hrId]), caller.access.hrId) ?? "The interviewer";
  const candidateName = row.candidate_id ? await candidateNameFor(row.candidate_id) : row.external_name?.trim() || "the candidate";
  if (decision === "confirmed") {
    await recordBookingChange(row.id, actor, "confirmed", `${who} confirmed they will conduct the interview.`);
  } else {
    await recordBookingChange(row.id, actor, "declined", `${who} declined the interview${declineReason ? `: ${declineReason}` : ""}.`);
    // Tell the people who arranged it, so it can be reassigned — the requester and the booker.
    const notify = new Set<string>();
    for (const hrId of [row.requested_by_hr_id, row.created_by_hr_id]) {
      const key = hrIdForStorage(hrId);
      if (key && canonicalHrIdKey(key) !== viewer) notify.add(key);
    }
    for (const recipient of notify) {
      await createSystemNotification({
        actionUrl: INTERVIEW_PORTAL_BASE,
        channels: ["in_app", "telegram"],
        eventType: "recruitment_interview_declined",
        message: `${who} declined the interview with ${candidateName}${declineReason ? ` (${declineReason})` : ""}. It needs a new interviewer.`,
        metadata: { idempotencyKey: `interview-declined:${row.id}:${actor ?? "?"}:${saved.interviewer_confirmation_at ?? ""}` },
        module: "recruitment",
        priority: "normal",
        recipientHrId: recipient,
        title: "An interview was declined",
      }).catch(() => {});
    }
  }
  const [booking] = await hydrate([saved], caller);
  return booking;
}

/**
 * Replace (or attach) the CV kept on an OUTSIDE candidate's interview (owner, 2026-09-26, Tier 3 —
 * edit the CV, e.g. one added after booking). An in-house candidate's CV lives on their Recruitment
 * record: one with NO readable CV gets it attached there (attachMissingCandidateCv); one who has one
 * is refused. Needs book-level access, like every other detail edit. Records the change.
 */
export async function replaceInterviewExternalCv(
  caller: InterviewCalendarCaller,
  bookingId: string,
  cv: { bytes: Buffer; fileName: string; mimeType: string },
): Promise<InterviewBooking> {
  const row = await loadBookingRow(bookingId);
  requireCalendarAccess(caller, "book", weekOfInstant(row.starts_at));
  if (row.candidate_id) return attachMissingCandidateCv(caller, row, row.candidate_id, cv);
  const storage = getRecruitmentFileStorage();
  if (!storage.supportsUpload) throw new Error("CV uploads are not switched on in Phoenix yet.");
  const stored = await storage.uploadFile({ bytes: cv.bytes, fileName: cv.fileName, mimeType: cv.mimeType });
  if (!stored.driveFileId) throw new Error("The CV could not be stored. Try again.");
  const actor = hrIdForStorage(caller.access.hrId);
  const saved = await saveBooking(row.id, {
    external_cv_file_id: stored.driveFileId,
    external_cv_file_name: cv.fileName,
    external_cv_mime_type: cv.mimeType,
    updated_by_hr_id: actor,
  });
  const who = personName(await loadPeople([caller.access.hrId]), caller.access.hrId) ?? "A colleague";
  await recordBookingChange(row.id, actor, "cv", `${who} ${row.external_cv_file_id ? "replaced" : "added"} the CV (${cv.fileName}).`);
  const [booking] = await hydrate([saved], caller);
  return booking;
}

/**
 * A CV added from the calendar for a Phoenix candidate who has none (owner, 2026-10-28: "No readable
 * CV is attached to this candidate"). Someone typed in while booking is added to Recruitment with or
 * without a CV, and until now nothing on the calendar could add one afterwards — this route refused
 * every in-house candidate, so the interview opened on that sentence for good.
 *
 * It ADDS a missing CV and never replaces one: a candidate who already has a readable CV keeps it,
 * and changing it stays on their Recruitment record. The file lands on the record itself, exactly as
 * a CV attached while booking does, so Recruitment, the pool and the calendar all read the same one.
 */
async function attachMissingCandidateCv(
  caller: InterviewCalendarCaller,
  row: BookingRow,
  candidateId: string,
  cv: { bytes: Buffer; fileName: string; mimeType: string },
): Promise<InterviewBooking> {
  await assertMayUseRecruitmentFromCalendar(caller.access, "create");
  const upload = checkCvUpload({ ...cv, sizeBytes: cv.bytes.length });
  const existing = await listCandidateFiles(candidateId);
  const hasReadableCv = existing.some(
    (file) => file.kind === "cv" && detectCvFileKind(file.mimeType ?? "", file.fileName) !== "unsupported",
  );
  if (hasReadableCv) throw new Error("This candidate already has a CV on their Recruitment record — change it there.");
  await uploadCandidateFile(caller.access, {
    bytes: upload.bytes,
    candidateId,
    fileName: upload.fileName,
    kind: "cv",
    mimeType: upload.mimeType,
    origin: "interview_calendar",
    sizeBytes: upload.sizeBytes,
  });
  // The same Drive mirror a CV attached while booking gets, for the same reason (see createInterviewBooking).
  await mirrorCandidateCvsToDrive(candidateId).catch(() => {});
  const actor = hrIdForStorage(caller.access.hrId);
  const who = personName(await loadPeople([caller.access.hrId]), caller.access.hrId) ?? "A colleague";
  await recordBookingChange(row.id, actor, "cv", `${who} added the CV (${upload.fileName}).`);
  const [booking] = await hydrate([row], caller);
  return booking;
}

function asPlatform(value: string): InterviewPlatform {
  return isInterviewPlatform(value) ? value : "in_office";
}

function asZoomStatus(value: string): InterviewZoomStatus {
  return value === "created" || value === "not_connected" || value === "failed" ? value : "not_needed";
}

function weekOfInstant(iso: string): string {
  return weekStartFor(cairoDateKey(new Date(iso)));
}

function endsAt(startsAt: string, minutes: number): number {
  return new Date(startsAt).getTime() + Number(minutes) * 60_000;
}

function mapSession(row: SessionRow, people: Map<string, InterviewCalendarPerson>, now: Date): InterviewSession {
  const at = new Date(row.starts_at);
  const platform = asPlatform(row.platform);
  return {
    createdByName: personName(people, row.created_by_hr_id),
    dateKey: cairoDateKey(at),
    durationMinutes: Number(row.duration_minutes),
    ended: now.getTime() >= endsAt(row.starts_at, row.duration_minutes),
    id: row.id,
    notes: row.notes,
    platform,
    slotMinutes: Number(row.slot_minutes),
    startMinutes: cairoMinutesOfDay(at),
    title: row.title?.trim() || null,
    zoomError: platform === "zoom" ? row.zoom_error : null,
    zoomJoinUrl: platform === "zoom" ? row.zoom_join_url : null,
    zoomStatus: platform === "zoom" ? asZoomStatus(row.zoom_status) : "not_needed",
  };
}

async function hydrate(rows: readonly BookingRow[], caller: InterviewCalendarCaller, now: Date = new Date()): Promise<InterviewBooking[]> {
  if (rows.length === 0) return [];
  const [candidates, comments, sessions, scorecards, changes] = await Promise.all([
    loadCandidates(rows.map((row) => row.candidate_id ?? "")),
    loadComments(rows.map((row) => row.id)),
    loadSessionsById(rows.map((row) => row.session_id ?? "")),
    loadScorecards(rows.map((row) => row.id)),
    loadBookingChanges(rows.map((row) => row.id)),
  ]);
  const people = await loadPeople([
    ...rows.map((row) => row.created_by_hr_id),
    ...rows.map((row) => row.interviewer_hr_id),
    ...rows.flatMap((row) => row.panelist_hr_ids ?? []),
    ...rows.map((row) => row.outcome_set_by_hr_id),
    ...rows.map((row) => row.interviewer_confirmation_by_hr_id),
    ...comments.map((comment) => comment.author_hr_id),
    ...scorecards.map((scorecard) => scorecard.evaluator_hr_id),
    ...changes.map((change) => change.actor_hr_id),
  ]);
  const viewerKey = canonicalHrIdKey(caller.access.hrId);

  // The change history, newest first — one line per recorded change, shown to everyone who can read
  // the booking (the same lens as its comments).
  const changesByBooking = new Map<string, InterviewChange[]>();
  for (const change of changes) {
    const list = changesByBooking.get(change.booking_id) ?? [];
    list.push({
      actorName: personName(people, change.actor_hr_id),
      at: change.created_at,
      id: change.id,
      kind: change.kind,
      summary: change.summary,
    });
    changesByBooking.set(change.booking_id, list);
  }

  // The panel's evaluations. Sensitive — shown only to those who can book (owner/editor/HR) or to
  // someone who is themselves ON the interview; never to a not-signed-in share-link guest.
  const scorecardsByBooking = new Map<string, InterviewScorecard[]>();
  for (const scorecard of scorecards) {
    const list = scorecardsByBooking.get(scorecard.booking_id) ?? [];
    list.push({
      comment: scorecard.comment?.trim() || null,
      evaluatorHrId: hrIdForStorage(scorecard.evaluator_hr_id) ?? scorecard.evaluator_hr_id,
      evaluatorName: personName(people, scorecard.evaluator_hr_id) ?? "An interviewer",
      mine: Boolean(viewerKey) && canonicalHrIdKey(scorecard.evaluator_hr_id) === viewerKey,
      rating: Number(scorecard.rating),
      updatedAt: scorecard.updated_at,
      verdict: asInterviewVerdict(scorecard.verdict),
    });
    scorecardsByBooking.set(scorecard.booking_id, list);
  }

  const commentsByBooking = new Map<string, InterviewBookingComment[]>();
  for (const comment of comments) {
    const list = commentsByBooking.get(comment.booking_id) ?? [];
    list.push({
      authorName: personName(people, comment.author_hr_id) ?? "A colleague",
      body: comment.body,
      createdAt: comment.created_at,
      id: comment.id,
      mine: Boolean(viewerKey) && canonicalHrIdKey(comment.author_hr_id) === viewerKey,
    });
    commentsByBooking.set(comment.booking_id, list);
  }

  return rows.map((row) => {
    const at = new Date(row.starts_at);
    const dateKey = cairoDateKey(at);
    const candidate = row.candidate_id ? candidates.get(String(row.candidate_id)) : undefined;
    const session = row.session_id ? sessions.get(String(row.session_id)) : undefined;
    // A slot in a session is held on the session's one meeting, in the session's place.
    const platform = session ? asPlatform(session.platform) : asPlatform(row.platform);
    const meeting = session ?? row;
    const external = !row.candidate_id;
    // An outside person's phone and e-mail go only to those who can book: the people arranging it.
    const reveal = external && roleMeets(effectiveCalendarRole(caller, weekStartFor(dateKey)), "book");
    // Scorecards: this viewer may FILE one only if they are on the interview; they SEE them if they
    // can book (owner/editor/HR) or are on it. A guest sees none.
    const canScore = isInterviewAttendee(caller, row);
    const seesScorecards = canScore || roleMeets(effectiveCalendarRole(caller, weekStartFor(dateKey)), "book");
    return {
      bookedByName: personName(people, row.created_by_hr_id),
      candidateId: row.candidate_id ? String(row.candidate_id) : null,
      candidateJobTitle: candidate?.applied_for_job_title?.trim() || null,
      candidateName: candidate?.full_name?.trim() || row.external_name?.trim() || "Unnamed candidate",
      canScoreInterview: canScore,
      scorecards: seesScorecards ? (scorecardsByBooking.get(row.id) ?? []) : [],
      comments: commentsByBooking.get(row.id) ?? [],
      createdAt: row.created_at,
      dateKey,
      durationMinutes: Number(row.duration_minutes),
      ended: now.getTime() >= endsAt(row.starts_at, row.duration_minutes),
      external,
      externalEmail: reveal ? row.external_email : null,
      externalCvFileName: external && row.external_cv_file_id ? row.external_cv_file_name?.trim() || "CV" : null,
      externalCvMimeType: external && row.external_cv_file_id ? row.external_cv_mime_type ?? null : null,
      externalHasCv: external && Boolean(row.external_cv_file_id),
      externalPhone: reveal ? row.external_phone : null,
      hasMeeting: platform === "zoom" && Boolean(meeting.zoom_meeting_id),
      id: row.id,
      interviewerHrId: hrIdForStorage(row.interviewer_hr_id) ?? null,
      interviewerName: personName(people, row.interviewer_hr_id),
      // Confirm/decline (owner, 2026-09-26): the chosen interviewer's own answer to the assignment.
      // Only the lead interviewer may answer, and only while an interview is still to happen.
      interviewerConfirmation: row.interviewer_confirmation === "confirmed" || row.interviewer_confirmation === "declined" ? row.interviewer_confirmation : null,
      confirmationAt: row.interviewer_confirmation_at,
      confirmedByName: personName(people, row.interviewer_confirmation_by_hr_id),
      declineReason: row.interviewer_confirmation === "declined" ? row.decline_reason?.trim() || null : null,
      canConfirmInterview:
        !session &&
        now.getTime() < endsAt(row.starts_at, row.duration_minutes) &&
        Boolean(viewerKey) &&
        viewerKey === canonicalHrIdKey(row.interviewer_hr_id),
      changeHistory: changesByBooking.get(row.id) ?? [],
      panelists: (row.panelist_hr_ids ?? [])
        .map((hrId) => ({ hrId: hrIdForStorage(hrId) ?? hrId, name: personName(people, hrId) }))
        .filter((member): member is { hrId: string; name: string } => Boolean(member.name)),
      // The area and line an interview is for — shown to everyone the calendar reaches, including a
      // not-signed-in share-link guest, exactly like the interviewer's name.
      area: row.interview_area?.trim() || null,
      line: row.interview_line?.trim() || null,
      // The job the interview is FOR — read by everyone the calendar reaches, like the area and the
      // interviewer's name; `candidateJobTitle` above stays what the candidate's own record says.
      jobTitle: row.interview_job_title?.trim() || null,
      notes: row.notes,
      canSetOutcome: canSetInterviewOutcome(caller, row.interviewer_hr_id),
      // Who may change the day/time/place: the booking tier as always, OR the District Manager who
      // REQUESTED this interview (owner, 2026-10-04). Never a session slot (HR re-slots those), never a
      // past interview, never a link guest. The server (updateInterviewBooking) re-checks and confines
      // a requester to the day/time/place.
      canReschedule:
        !session &&
        now.getTime() < endsAt(row.starts_at, row.duration_minutes) &&
        (roleMeets(effectiveCalendarRole(caller, weekStartFor(dateKey)), "book") ||
          (Boolean(viewerKey) && viewerKey === canonicalHrIdKey(row.requested_by_hr_id))),
      outcome: readInterviewOutcome(row.outcome),
      outcomeSetAt: row.outcome_set_at,
      outcomeSetByName: personName(people, row.outcome_set_by_hr_id),
      platform,
      sessionId: session ? session.id : null,
      sessionTitle: session ? session.title?.trim() || "Interview session" : null,
      startMinutes: cairoMinutesOfDay(at),
      startsAt: row.starts_at,
      updatedAt: row.updated_at,
      // An office interview never carries a link, whatever the row says (the table forbids it too).
      zoomError: platform === "zoom" ? meeting.zoom_error : null,
      zoomJoinUrl: platform === "zoom" ? meeting.zoom_join_url : null,
      zoomStatus: platform === "zoom" ? asZoomStatus(meeting.zoom_status) : "not_needed",
    };
  });
}

async function hydrateSessions(rows: readonly SessionRow[], now: Date = new Date()): Promise<InterviewSession[]> {
  if (rows.length === 0) return [];
  const people = await loadPeople(rows.map((row) => row.created_by_hr_id));
  return rows.map((row) => mapSession(row, people, now));
}

// ── Reading ─────────────────────────────────────────────────────────────────────────────────────

async function bookingsBetween(from: Date, to: Date): Promise<BookingRow[]> {
  const { data, error } = await recruitmentDb()
    .from(BOOKINGS)
    .select(BOOKING_COLUMNS)
    .gte("starts_at", from.toISOString())
    .lt("starts_at", to.toISOString())
    .order("starts_at", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as BookingRow[];
}

async function sessionsBetween(from: Date, to: Date): Promise<SessionRow[]> {
  const { data, error } = await recruitmentDb()
    .from(SESSIONS)
    .select(SESSION_COLUMNS)
    .gte("starts_at", from.toISOString())
    .lt("starts_at", to.toISOString())
    .order("starts_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as SessionRow[];
}

export type InterviewCalendarWeekData = { weekStart: string; bookings: InterviewBooking[]; sessions: InterviewSession[] };

export async function listInterviewCalendarWeek(caller: InterviewCalendarCaller, week: string): Promise<InterviewCalendarWeekData> {
  if (!isDateKey(week)) throw new Error("Choose a week to show.");
  const weekStart = weekStartFor(week);
  requireCalendarAccess(caller, "view", weekStart);
  const { from, to } = weekInstantRange(weekStart);
  const [bookings, sessions] = await Promise.all([bookingsBetween(from, to), sessionsBetween(from, to)]);
  return {
    bookings: await hydrate(bookings.filter((row) => mayReadBooking(caller, row)), caller),
    sessions: mayReadSessions(caller, weekStart) ? await hydrateSessions(sessions) : [],
    weekStart,
  };
}

/** Every interview and session on one day, for the dialog's time chips: a taken slot is marked, not hidden. */
export async function listInterviewCalendarDay(
  caller: InterviewCalendarCaller,
  dateKey: string,
): Promise<{ bookings: InterviewBooking[]; sessions: InterviewSession[] }> {
  if (!isDateKey(dateKey)) throw new Error("Choose a date.");
  requireCalendarAccess(caller, "view", weekStartFor(dateKey));
  const from = cairoLocalToUtc(dateKey, 0);
  const to = cairoLocalToUtc(dateKey, 24 * 60);
  const [bookings, sessions] = await Promise.all([bookingsBetween(from, to), sessionsBetween(from, to)]);
  return {
    bookings: await hydrate(bookings.filter((row) => mayReadBooking(caller, row)), caller),
    sessions: mayReadSessions(caller, weekStartFor(dateKey)) ? await hydrateSessions(sessions) : [],
  };
}

/**
 * How far back the calendar asks about a finished interview nobody has answered for.
 *
 * Fourteen days (owner, 2026-10-17: "age old unanswered interviews off the panel after 14 days"): the
 * point is to catch the round being worked on now, and a list that reaches back further is a list
 * nobody reads. An older one is not lost — it keeps its amber flag on its own week, and the automatic
 * settling (interview-outcome-settle.ts) still answers it when a hire or an offer arrives, however late; a
 * shortlist, back-up or rejection counts only inside its own 14 days.
 */
export const OUTCOME_PROMPT_LOOKBACK_DAYS = INTERVIEW_OUTCOME_WINDOW_DAYS;
/** At most this many are put in front of someone at once; the rest wait their turn. */
export const OUTCOME_PROMPT_LIMIT = 25;

/**
 * The finished interviews waiting for this caller to say how they went — newest first.
 *
 * WHY THE CALENDAR ASKS AT ALL. The outcome already drives the candidate's status, and the reminder
 * job has nagged the lead interviewer since 2026-09-23 — and 50 of the 68 interviews held from
 * 1 September 2026 still carried no outcome when this was measured on 15 October. So the calendar
 * itself asks, on the screen, where the person who can answer already is.
 *
 * It is SCOPED TO WHO CAN ANSWER: `canSetOutcome` is the lead interviewer or the calendar's owner,
 * exactly the gate `setInterviewOutcome` enforces. Handing a viewer a list they cannot act on would
 * be noise, and handing a link guest one would be a leak — `hydrate` has already decided both.
 */
export async function listInterviewsAwaitingOutcome(
  caller: InterviewCalendarCaller,
  now: Date = new Date(),
): Promise<InterviewBooking[]> {
  requireCalendarAccess(caller, "view", "any");
  const from = new Date(now.getTime() - OUTCOME_PROMPT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const rows = (await bookingsBetween(from, now)).filter((row) => !row.outcome && mayReadBooking(caller, row));
  if (rows.length === 0) return [];
  const bookings = await hydrate(rows, caller, now);
  return bookings
    .filter((booking) => interviewAwaitsOutcome(booking) && booking.canSetOutcome)
    .sort((a, b) => b.startsAt.localeCompare(a.startsAt))
    .slice(0, OUTCOME_PROMPT_LIMIT);
}

/** A candidate's interviews from today on — the schedule dialog shows them before booking another. */
export async function listUpcomingInterviewsForCandidate(
  caller: InterviewCalendarCaller,
  candidateId: string,
  now: Date = new Date(),
): Promise<InterviewBooking[]> {
  requireCalendarAccess(caller, "view", "any");
  if (!isUuid(candidateId)) throw new Error("Candidate not found.");
  const todayStart = cairoLocalToUtc(cairoDateKey(now), 0);
  const { data, error } = await recruitmentDb()
    .from(BOOKINGS)
    .select(BOOKING_COLUMNS)
    .eq("candidate_id", candidateId)
    .gte("starts_at", todayStart.toISOString())
    .order("starts_at", { ascending: true })
    .limit(20);
  if (error) throw error;
  // Only the weeks this person can see — a one-week link does not reveal the rest of the calendar.
  const visible = ((data ?? []) as BookingRow[]).filter((row) => mayReadBooking(caller, row));
  return hydrate(visible, caller, now);
}

async function loadBookingRow(bookingId: string): Promise<BookingRow> {
  if (!isUuid(bookingId)) throw new Error("Interview not found.");
  const { data, error } = await recruitmentDb().from(BOOKINGS).select(BOOKING_COLUMNS).eq("id", bookingId).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Interview not found.");
  return data as BookingRow;
}

async function loadSessionRow(sessionId: unknown): Promise<SessionRow> {
  if (typeof sessionId !== "string" || !isUuid(sessionId)) throw new Error("Interview session not found.");
  const { data, error } = await recruitmentDb().from(SESSIONS).select(SESSION_COLUMNS).eq("id", sessionId).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Interview session not found.");
  return data as SessionRow;
}

async function sessionBookingRows(sessionId: string): Promise<BookingRow[]> {
  const { data, error } = await recruitmentDb()
    .from(BOOKINGS)
    .select(BOOKING_COLUMNS)
    .eq("session_id", sessionId)
    .order("starts_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as BookingRow[];
}

// The host link, asked of Zoom and kept in this server's memory for 10 minutes (the screen polls every
// 15 seconds) — never written to the database. When Zoom will not give it the answer is null and the
// guest link is used instead.
const hostLinkCache = new Map<string, { url: string; until: number }>();

async function hostLinkFor(joinUrl: string, config: ZoomConfig | null, now: Date): Promise<string | null> {
  const meetingId = zoomMeetingIdFromJoinUrl(joinUrl);
  if (!config || !meetingId) return null;
  const cached = hostLinkCache.get(meetingId);
  if (cached && cached.until > now.getTime()) return cached.url;
  try {
    const url = await getZoomHostStartUrl(config, meetingId);
    hostLinkCache.set(meetingId, { until: now.getTime() + 10 * 60_000, url });
    return url;
  } catch {
    return null;
  }
}

/**
 * The Zoom interviews whose time has come for THIS person: they start within the next half minute or
 * began in the last 20 and have not ended. "Theirs" means they are the chosen interviewer, or the
 * calendar's owner with no interviewer chosen — so someone the calendar is merely shared with is
 * never sent to a meeting that is not theirs. One entry per meeting link (a session's slots share one).
 * The screen polls this and opens the link itself.
 *
 * WHAT IT OPENS is the HOST link when Zoom gives one, so the meeting starts by itself — the guest link
 * leaves the interviewer waiting as a guest until they start it from the Zoom app (owner, 2026-09-20).
 * When Zoom will not give the host link the guest link is sent instead and `asHost` says so, so the
 * interview is still opened and the screen words it right.
 */
export async function listDueZoomInterviews(
  caller: InterviewCalendarCaller,
  now: Date = new Date(),
  zoomConfig: ZoomConfig | null = readZoomConfig(),
): Promise<DueZoomInterview[]> {
  const viewer = canonicalHrIdKey(caller.access.hrId);
  if (!viewer || !isSignedInCaller(caller.access) || !calendarRoleFor(caller, "any")) return [];
  const rows = await bookingsBetween(new Date(now.getTime() - 20 * 60_000), new Date(now.getTime() + 30_000));
  const mine = rows.filter((row) => {
    const chosen = canonicalHrIdKey(row.interviewer_hr_id);
    return chosen ? chosen === viewer : caller.own === "owner";
  });
  if (mine.length === 0) return [];
  const due: DueZoomInterview[] = [];
  const seen = new Set<string>();
  for (const booking of await hydrate(mine, caller, now)) {
    if (booking.platform !== "zoom" || !booking.zoomJoinUrl || booking.ended || seen.has(booking.zoomJoinUrl)) continue;
    seen.add(booking.zoomJoinUrl);
    const hostUrl = await hostLinkFor(booking.zoomJoinUrl, zoomConfig, now);
    due.push({
      asHost: hostUrl !== null,
      bookingId: booking.id,
      candidateName: booking.candidateName,
      dateKey: booking.dateKey,
      openUrl: hostUrl ?? booking.zoomJoinUrl,
      startMinutes: booking.startMinutes,
    });
  }
  return due;
}

/** What a reminder needs to say about one interview, and to whom (one row per attendee). */
export type ReminderInterview = {
  id: string;
  interviewerHrId: string;
  interviewerJobTitle: string | null;
  /** True for the lead interviewer, false for a panel member. Only the lead is nagged to RECORD the
   * outcome (only the lead or the owner can); everyone gets the evening list and the one-hour nudge. */
  isLead: boolean;
  startsAt: string;
  durationMinutes: number;
  candidateName: string;
  platform: InterviewPlatform;
};

/**
 * The interviews between two instants that still have someone to remind, with ONE row PER ATTENDEE:
 * the lead interviewer AND every panel member (owner, 2026-09-26 — the whole panel is reminded, not
 * only the lead). Only interviews with no outcome recorded yet; a cancelled interview is a deleted
 * row, so it is simply not here. This is the reminder job's ONLY read of the calendar — a system read,
 * not a caller's, so it never goes through the gate; each row leaves the building only as a notice to
 * the one attendee named on it. The plan de-duplicates delivery per attendee by its own key.
 */
export async function listInterviewsToRemindAbout(from: Date, to: Date): Promise<ReminderInterview[]> {
  const rows = (await bookingsBetween(from, to)).filter((row) => !row.outcome && (row.interviewer_hr_id || (row.panelist_hr_ids?.length ?? 0) > 0));
  if (rows.length === 0) return [];
  const candidates = await loadCandidates(rows.map((row) => row.candidate_id ?? ""));
  const people = await loadPeople(rows.flatMap((row) => [row.interviewer_hr_id, ...(row.panelist_hr_ids ?? [])]));
  const sessions = await loadSessionsById(rows.map((row) => row.session_id ?? ""));
  return rows.flatMap((row) => {
    const candidate = row.candidate_id ? candidates.get(String(row.candidate_id)) : undefined;
    const session = row.session_id ? sessions.get(String(row.session_id)) : undefined;
    const candidateName = (candidate?.full_name || row.external_name || "A candidate").trim();
    const platform = session ? asPlatform(session.platform) : asPlatform(row.platform);
    // The lead first, then each panel member; de-duplicated so nobody on twice gets two reminders.
    // A lead who DECLINED is dropped — he answered "I can't", so he is not reminded (owner, 2026-09-26);
    // the interview stays for reassignment and the panel is still reminded.
    const lead = row.interviewer_confirmation === "declined" ? null : row.interviewer_hr_id;
    const attendees: string[] = [];
    const seen = new Set<string>();
    for (const hrId of [lead, ...(row.panelist_hr_ids ?? [])]) {
      const key = canonicalHrIdKey(hrId);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      attendees.push(hrId as string);
    }
    const leadKey = canonicalHrIdKey(row.interviewer_hr_id);
    return attendees.map((hrId) => ({
      candidateName,
      durationMinutes: Number(row.duration_minutes),
      id: row.id,
      interviewerHrId: hrIdForStorage(hrId) ?? String(hrId),
      interviewerJobTitle: people.get(canonicalHrIdKey(hrId) ?? "")?.jobTitle ?? null,
      isLead: Boolean(leadKey) && canonicalHrIdKey(hrId) === leadKey,
      platform,
      startsAt: row.starts_at,
    }));
  });
}

export async function getInterviewBooking(caller: InterviewCalendarCaller, bookingId: string): Promise<InterviewBooking> {
  const row = await loadBookingRow(bookingId);
  requireCalendarAccess(caller, "view", weekOfInstant(row.starts_at));
  if (!mayReadBooking(caller, row)) throw new Error(NOT_YOURS);
  const [booking] = await hydrate([row], caller);
  return booking;
}

/**
 * The signed-in person's OWN upcoming interviews — the ones they conduct (interviewer) or asked for
 * (requester) — from the start of today (Cairo) forward, still open (no outcome recorded). For the
 * "My interviews" strip on the portal (owner, 2026-09-26: make the calendar relevant to everyone
 * daily). A person always sees their own, so it is keyed on their hr id, not the calendar view gate.
 */
export async function listMyUpcomingInterviews(caller: InterviewCalendarCaller, now: Date = new Date()): Promise<InterviewBooking[]> {
  const me = canonicalHrIdKey(caller.access.hrId);
  if (!me) return [];
  const from = cairoLocalToUtc(cairoDateKey(now), 0);
  const to = new Date(from.getTime() + 21 * 24 * 60 * 60 * 1000);
  const rows = (await bookingsBetween(from, to)).filter(
    (row) =>
      !row.outcome &&
      (canonicalHrIdKey(row.interviewer_hr_id) === me ||
        canonicalHrIdKey(row.requested_by_hr_id) === me ||
        isOnPanel(me, row.panelist_hr_ids) ||
        isOnPanel(me, row.shared_with_hr_ids)),
  );
  return hydrate(rows.slice(0, 50), caller, now);
}

/** One interview as the .ics calendar feed shows it — names resolved; it is the person's own, so no reveal gate. */
export type FeedInterview = {
  id: string;
  candidateName: string;
  startsAt: string;
  durationMinutes: number;
  platform: InterviewPlatform;
  zoomJoinUrl: string | null;
  notes: string | null;
  interviewerName: string | null;
  sessionTitle: string | null;
  updatedAt: string;
};

/**
 * One person's interviews between two instants — those they conduct or asked for — for their private
 * .ics calendar feed (interview-calendar-ics.ts). A SYSTEM read keyed on the hr id the feed token
 * resolves to, never a caller's gate: the feed carries only that one person's own interviews. A
 * cancelled interview is a deleted row, so it simply drops out of the feed on the next refresh.
 */
export async function listInterviewsForCalendarFeed(hrId: string, from: Date, to: Date): Promise<FeedInterview[]> {
  const me = canonicalHrIdKey(hrId);
  if (!me) return [];
  const rows = (await bookingsBetween(from, to)).filter(
    (row) => canonicalHrIdKey(row.interviewer_hr_id) === me || canonicalHrIdKey(row.requested_by_hr_id) === me || isOnPanel(me, row.panelist_hr_ids),
  );
  if (rows.length === 0) return [];
  const candidates = await loadCandidates(rows.map((row) => row.candidate_id ?? ""));
  const people = await loadPeople(rows.map((row) => row.interviewer_hr_id));
  const sessions = await loadSessionsById(rows.map((row) => row.session_id ?? ""));
  return rows.map((row) => {
    const candidate = row.candidate_id ? candidates.get(String(row.candidate_id)) : undefined;
    const session = row.session_id ? sessions.get(String(row.session_id)) : undefined;
    return {
      candidateName: (candidate?.full_name || row.external_name || "A candidate").trim(),
      durationMinutes: Number(row.duration_minutes),
      id: row.id,
      interviewerName: row.interviewer_hr_id ? personName(people, row.interviewer_hr_id) : null,
      notes: row.notes ?? null,
      platform: session ? asPlatform(session.platform) : asPlatform(row.platform),
      sessionTitle: session?.title ?? null,
      startsAt: row.starts_at,
      updatedAt: row.updated_at,
      zoomJoinUrl: row.zoom_join_url ?? session?.zoom_join_url ?? null,
    };
  });
}

/** One interview a person conducts, as Phoenix CRM's Interviews day lists it (owner, 2026-10-29). */
export type ConductedInterview = {
  bookingId: string;
  candidateName: string;
  /** The instant, as stored. */
  startsAt: string;
  durationMinutes: number;
  /**
   * The calendar's OWN CV door for this interview, or null when no readable CV is kept: the newest
   * renderable CV on the candidate's record, or the CV kept on an outside person's booking. Only a link —
   * the door itself decides who opens it (`assertCandidateOnCalendar` / `mayReadBooking`, the Talent
   * Acquisition fence), so listing an interview here never widens who reads a CV.
   */
  cvUrl: string | null;
};

/**
 * The interviews one person CONDUCTS between two instants — the lead or anywhere on the panel; one they
 * only requested is not their interview. A SYSTEM read keyed on the hr id, like the .ics feed above: the
 * caller (Phoenix CRM) has already decided whose day it is, and it hands out only CV links that are
 * guarded again on their own. Earliest first.
 */
export async function listInterviewsConductedBy(hrId: string, from: Date, to: Date): Promise<ConductedInterview[]> {
  const me = canonicalHrIdKey(hrId);
  if (!me) return [];
  const rows = (await bookingsBetween(from, to)).filter(
    (row) => canonicalHrIdKey(row.interviewer_hr_id) === me || isOnPanel(me, row.panelist_hr_ids),
  );
  if (rows.length === 0) return [];
  const candidateIds = rows.flatMap((row) => (row.candidate_id ? [String(row.candidate_id)] : []));
  const [candidates, files] = await Promise.all([loadCandidates(candidateIds), listCandidateFilesByCandidate(candidateIds)]);
  return rows.map((row) => {
    const candidateId = row.candidate_id ? String(row.candidate_id) : null;
    const cv = candidateId ? primaryCvFile(files.get(candidateId) ?? []) : null;
    const cvUrl = candidateId
      ? cv
        ? `/api/recruitment/interview-calendar/candidates/${encodeURIComponent(candidateId)}/files/${encodeURIComponent(cv.id)}`
        : null
      : row.external_cv_file_id
        ? `/api/recruitment/interview-calendar/bookings/${encodeURIComponent(row.id)}/cv`
        : null;
    return {
      bookingId: row.id,
      candidateName: ((candidateId ? candidates.get(candidateId)?.full_name : null) || row.external_name || "A candidate").trim(),
      cvUrl,
      durationMinutes: Number(row.duration_minutes),
      startsAt: row.starts_at,
    };
  });
}

/** One interview as an attendee's PRIVATE CALENDAR shows it — see lib/private-calendar/interview-items.ts. */
export type PrivateCalendarInterviewRow = {
  id: string;
  startsAt: string;
  durationMinutes: number;
  leadHrId: string | null;
  /** The lead answered "I can't" — he is not expected there, so his calendar does not carry it. */
  leadDeclined: boolean;
  panelHrIds: string[];
  candidateName: string;
  jobTitle: string | null;
  area: string | null;
  line: string | null;
  platform: InterviewPlatform;
};

/**
 * Every interview starting between two instants, for the private calendar of the people who sit in it
 * (owner, 2026-10-29: "if he have an interview from calendar throw it in his private calendars"). A
 * SYSTEM read, like the reminder job's: the private calendar is already gated to the employee, his
 * managers and HR, and each row reaches only the attendees named on it. A cancelled interview is a
 * deleted row, so it simply is not here.
 */
export async function listInterviewsForPrivateCalendar(from: Date, to: Date): Promise<PrivateCalendarInterviewRow[]> {
  const rows = (await bookingsBetween(from, to)).filter((row) => row.interviewer_hr_id || (row.panelist_hr_ids?.length ?? 0) > 0);
  if (rows.length === 0) return [];
  const candidates = await loadCandidates(rows.map((row) => row.candidate_id ?? ""));
  const sessions = await loadSessionsById(rows.map((row) => row.session_id ?? ""));
  return rows.map((row) => {
    const candidate = row.candidate_id ? candidates.get(String(row.candidate_id)) : undefined;
    const session = row.session_id ? sessions.get(String(row.session_id)) : undefined;
    return {
      area: row.interview_area ?? null,
      candidateName: (candidate?.full_name || row.external_name || "Unnamed candidate").trim(),
      durationMinutes: Number(row.duration_minutes),
      id: String(row.id),
      jobTitle: row.interview_job_title ?? candidate?.applied_for_job_title ?? null,
      leadDeclined: row.interviewer_confirmation === "declined",
      leadHrId: row.interviewer_hr_id ?? null,
      line: row.interview_line ?? null,
      panelHrIds: (row.panelist_hr_ids ?? []).filter(Boolean),
      platform: session ? asPlatform(session.platform) : asPlatform(row.platform),
      startsAt: row.starts_at,
    };
  });
}

export async function getInterviewSession(
  caller: InterviewCalendarCaller,
  sessionId: string,
): Promise<{ session: InterviewSession; bookings: InterviewBooking[] }> {
  const row = await loadSessionRow(sessionId);
  requireCalendarAccess(caller, "view", weekOfInstant(row.starts_at));
  if (!mayReadSessions(caller, weekOfInstant(row.starts_at))) throw new Error(NOT_YOURS);
  const [session] = await hydrateSessions([row]);
  return { bookings: await hydrate(await sessionBookingRows(row.id), caller), session };
}

// ── Checking what was asked for ─────────────────────────────────────────────────────────────────

export type ExternalPersonInput = { name: string; phone: string | null; email: string | null };

export type InterviewBookingInput = {
  /** A Phoenix candidate — or null for someone from outside, described by `external`. */
  candidateId: string | null;
  external: ExternalPersonInput | null;
  dateKey: string;
  startMinutes: number;
  durationMinutes: number;
  platform: InterviewPlatform;
  notes: string | null;
};

function cleanNotes(value: unknown): string | null {
  const notes = typeof value === "string" ? value.trim() : "";
  if (notes.length > NOTE_LIMIT) throw new Error(`Keep the note under ${NOTE_LIMIT} characters.`);
  return notes || null;
}

/** Someone from outside Phoenix: a name always; a phone and an e-mail when known. */
export function validateExternalPerson(raw: unknown): ExternalPersonInput {
  const entry = (raw ?? {}) as Record<string, unknown>;
  const name = typeof entry.name === "string" ? entry.name.replace(/\s+/g, " ").trim() : "";
  if (name.length < 2) throw new Error("Write the name of the person to interview.");
  if (name.length > 200) throw new Error("Keep the name under 200 characters.");
  const phone = typeof entry.phone === "string" ? entry.phone.trim() : "";
  if (phone) {
    const digits = phone.replace(/\D/g, "");
    if (phone.length > 40 || digits.length < 7 || digits.length > 15) throw new Error("That phone number does not look right.");
  }
  const email = typeof entry.email === "string" ? entry.email.trim() : "";
  if (email && (email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw new Error("That e-mail address does not look right.");
  return { email: email || null, name, phone: phone || null };
}

/** A single interview's day, time and length. */
export function validateInterviewTime(input: { dateKey?: unknown; startMinutes?: unknown; durationMinutes?: unknown }) {
  const dateKey = typeof input.dateKey === "string" ? input.dateKey.trim() : "";
  if (!isDateKey(dateKey)) throw new Error("Choose a date for the interview.");
  if (!isBookableDay(dateKey)) throw new Error("Interviews are booked Sunday to Thursday only.");
  const startMinutes = Number(input.startMinutes);
  const durationMinutes = Number(input.durationMinutes);
  if (!ALL_DURATION_CHOICES.includes(durationMinutes)) {
    throw new Error("Choose how long the interview is: 30 minutes up to the whole day (8 hours).");
  }
  if (!isBookableWindow(startMinutes, durationMinutes)) {
    throw new Error("An interview starts at 9:00 AM or later and ends by 5:00 PM.");
  }
  return { dateKey, durationMinutes, startMinutes };
}

/** The request, checked. Every refusal is a sentence the person booking can act on. */
export function validateInterviewBookingInput(input: {
  candidateId?: unknown;
  external?: unknown;
  dateKey?: unknown;
  startMinutes?: unknown;
  durationMinutes?: unknown;
  platform?: unknown;
  notes?: unknown;
}): InterviewBookingInput {
  const candidateId = typeof input.candidateId === "string" ? input.candidateId.trim() : "";
  let external: ExternalPersonInput | null = null;
  if (candidateId) {
    if (!isUuid(candidateId)) throw new Error("Choose the candidate to interview.");
  } else if (input.external) {
    external = validateExternalPerson(input.external);
  } else {
    throw new Error("Choose the candidate to interview.");
  }
  const time = validateInterviewTime(input);
  if (!isInterviewPlatform(input.platform)) throw new Error("Choose In office or Zoom.");
  return { candidateId: candidateId || null, external, ...time, notes: cleanNotes(input.notes), platform: input.platform };
}

export type InterviewSessionInput = {
  title: string | null;
  dateKey: string;
  startMinutes: number;
  durationMinutes: number;
  slotMinutes: number;
  platform: InterviewPlatform;
  notes: string | null;
};

/** A session: one block of one day, under one meeting, cut into equal slots. */
export function validateInterviewSessionInput(input: {
  title?: unknown;
  dateKey?: unknown;
  startMinutes?: unknown;
  durationMinutes?: unknown;
  slotMinutes?: unknown;
  platform?: unknown;
  notes?: unknown;
}): InterviewSessionInput {
  const title = typeof input.title === "string" ? input.title.replace(/\s+/g, " ").trim() : "";
  if (title.length > 120) throw new Error("Keep the session's name under 120 characters.");
  const dateKey = typeof input.dateKey === "string" ? input.dateKey.trim() : "";
  if (!isDateKey(dateKey)) throw new Error("Choose the day of the session.");
  if (!isBookableDay(dateKey)) throw new Error("Interviews are booked Sunday to Thursday only.");
  const startMinutes = Number(input.startMinutes);
  const durationMinutes = Number(input.durationMinutes);
  if (!Number.isInteger(durationMinutes) || durationMinutes < 30 || durationMinutes > MAX_DURATION_MINUTES || durationMinutes % 15 !== 0) {
    throw new Error("Choose when the session ends: at least 30 minutes after it starts, and by 5:00 PM.");
  }
  if (!isBookableWindow(startMinutes, durationMinutes)) {
    throw new Error("A session starts at 9:00 AM or later and ends by 5:00 PM.");
  }
  const slotMinutes = Number(input.slotMinutes);
  if (!(SESSION_SLOT_CHOICES as readonly number[]).includes(slotMinutes)) throw new Error("Choose the slot length: 15, 30, 45 or 60 minutes.");
  if (slotMinutes > durationMinutes) throw new Error("The session is shorter than one slot.");
  if (!isInterviewPlatform(input.platform)) throw new Error("Choose In office or Zoom.");
  return { dateKey, durationMinutes, notes: cleanNotes(input.notes), platform: input.platform, slotMinutes, startMinutes, title: title || null };
}

// ── An outside person's CV ──────────────────────────────────────────────────────────────────────

export type InterviewCvUpload = { fileName: string; mimeType: string; bytes: Buffer; sizeBytes: number };

export const CV_UPLOAD_LIMIT_BYTES = 10 * 1024 * 1024;

const CV_TYPES: Record<string, string> = {
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  pdf: "application/pdf",
  png: "image/png",
  webp: "image/webp",
};

/** A CV as uploaded, checked: a PDF, a Word document or a picture, up to 10 MB. */
export function checkCvUpload(upload: InterviewCvUpload): InterviewCvUpload {
  if (!upload.sizeBytes || upload.bytes.length === 0) throw new Error("The CV file is empty.");
  if (upload.sizeBytes > CV_UPLOAD_LIMIT_BYTES || upload.bytes.length > CV_UPLOAD_LIMIT_BYTES) throw new Error("The CV is larger than 10 MB.");
  const extension = /\.([a-z0-9]+)$/i.exec(upload.fileName.trim())?.[1]?.toLowerCase() ?? "";
  const byExtension = CV_TYPES[extension];
  const mime = upload.mimeType.toLowerCase();
  const known = Object.values(CV_TYPES).includes(mime) ? mime : null;
  const mimeType = known ?? byExtension;
  if (!mimeType) throw new Error("Upload the CV as a PDF, a Word document or a picture.");
  const fileName = upload.fileName.trim().replace(/[\\/]+/g, " ").slice(-255) || `cv.${extension || "pdf"}`;
  return { ...upload, fileName, mimeType };
}

// ── Zoom, for bookings and sessions alike ──────────────────────────────────────────────────────

type ZoomOutcome = {
  zoom_status: InterviewZoomStatus;
  zoom_meeting_id: string | null;
  zoom_join_url: string | null;
  zoom_error: string | null;
};

const OFFICE: ZoomOutcome = { zoom_error: null, zoom_join_url: null, zoom_meeting_id: null, zoom_status: "not_needed" };

export function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

async function newMeeting(
  config: ZoomConfig | null,
  when: { dateKey: string; startMinutes: number; durationMinutes: number },
  topic: string,
): Promise<ZoomOutcome> {
  if (!config) return { zoom_error: null, zoom_join_url: null, zoom_meeting_id: null, zoom_status: "not_connected" };
  try {
    const meeting = await createZoomMeeting(config, { ...when, topic });
    return { zoom_error: null, zoom_join_url: meeting.joinUrl, zoom_meeting_id: meeting.id, zoom_status: "created" };
  } catch (error) {
    return { zoom_error: errorText(error), zoom_join_url: null, zoom_meeting_id: null, zoom_status: "failed" };
  }
}

function interviewTopic(name: string): string {
  return `Interview · ${name}`;
}

function sessionTopic(title: string | null): string {
  return title ? `Interviews · ${title}` : "Interviews";
}

export type PollOwner = { bookingId: string } | { sessionId: string };

function pollOwnerFilter(owner: PollOwner): [string, string] {
  return "bookingId" in owner ? ["booking_id", owner.bookingId] : ["session_id", owner.sessionId];
}

/**
 * Put every poll that is waiting for a meeting onto the one that now exists. A poll Zoom refuses is
 * kept, marked failed with Zoom's reason — it never blocks the interview.
 */
export async function pushWaitingPolls(config: ZoomConfig | null, owner: PollOwner, meetingId: string | null): Promise<void> {
  if (!config || !meetingId) return;
  const [column, id] = pollOwnerFilter(owner);
  const { data, error } = await recruitmentDb()
    .from(POLLS)
    .select("id,title,questions")
    .eq(column, id)
    .in("status", ["pending", "failed"]);
  if (error) throw error;
  for (const poll of (data ?? []) as Array<{ id: string; title: string; questions: unknown }>) {
    let patch: Record<string, unknown>;
    try {
      const pollId = await createZoomPoll(config, meetingId, {
        questions: Array.isArray(poll.questions) ? (poll.questions as Parameters<typeof createZoomPoll>[2]["questions"]) : [],
        title: poll.title,
      });
      patch = { error: null, status: "created", zoom_meeting_id: meetingId, zoom_poll_id: pollId };
    } catch (failure) {
      patch = { error: errorText(failure), status: "failed", zoom_meeting_id: meetingId, zoom_poll_id: null };
    }
    const { error: saveError } = await recruitmentDb()
      .from(POLLS)
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("id", poll.id);
    if (saveError) throw saveError;
  }
}

/** The meeting went away (now in the office, or moved into a session): its polls wait for the next. */
async function unhookPolls(owner: PollOwner): Promise<void> {
  const [column, id] = pollOwnerFilter(owner);
  const { error } = await recruitmentDb()
    .from(POLLS)
    .update({ error: null, status: "pending", updated_at: new Date().toISOString(), zoom_meeting_id: null, zoom_poll_id: null })
    .eq(column, id);
  if (error) throw error;
}

async function dropMeeting(config: ZoomConfig | null, meetingId: string | null) {
  // Best effort — a meeting Zoom will not delete is not a reason to refuse the change, and it can do
  // no harm once nothing in Phoenix points at it.
  if (meetingId && config) await deleteZoomMeeting(config, meetingId).catch(() => undefined);
}

// ── Booking ─────────────────────────────────────────────────────────────────────────────────────

async function candidateNameFor(candidateId: string): Promise<string> {
  const candidate = (await loadCandidates([candidateId])).get(candidateId);
  if (!candidate) throw new Error("Candidate not found.");
  return candidate.full_name?.trim() || "Unnamed candidate";
}

/** What a booking request may carry beyond the interview itself. */
export type InterviewBookingRequest = Parameters<typeof validateInterviewBookingInput>[0] & {
  /** Book into a slot of this session instead of on its own; `startMinutes` names the slot. */
  sessionId?: unknown;
  /** For someone from outside: also make them a Recruitment candidate (the default), or not. */
  addToRecruitment?: unknown;
  /** The employee who conducts the interview — the lead of the panel, optional. */
  interviewerHrId?: unknown;
  /** Additional panel members beyond the lead — optional; each also sees the interview. */
  panelistHrIds?: unknown;
  /** The sales Area and Line the interview is for — optional, shown in the calendar and share link. */
  area?: unknown;
  line?: unknown;
  /** The job the interview is for — optional, and carried onto a candidate this booking creates. */
  jobTitle?: unknown;
};

export type InterviewBookingResult = { booking: InterviewBooking; notice: string | null };

/** An interview's area or line label for storage — trimmed and capped; empty becomes null. */
function orgLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return null;
  if (text.length > 80) throw new Error("That area or line name is too long.");
  return text;
}

/**
 * The job the interview is for, as stored. Free text on purpose — the offer catalogue holds four
 * active titles and the calendar interviews for roles that are not in it, so the catalogue is
 * offered as suggestions (the datalist on the booking form) and never as the only answer. Blank is
 * a real answer: it means nobody named the role, not that the booking is wrong.
 */
export const INTERVIEW_JOB_TITLE_LIMIT = 120;

export function interviewJobTitleLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return null;
  if (text.length > INTERVIEW_JOB_TITLE_LIMIT) throw new Error(`Keep the job title under ${INTERVIEW_JOB_TITLE_LIMIT} characters.`);
  return text;
}

/**
 * The job titles offered as suggestions on the booking form — the offer catalogue's active titles,
 * names only.
 *
 * It goes through the CALENDAR's own gate rather than the offers permission, because the people who
 * book interviews are not the people who write offer letters: an Editor the owner shared the
 * calendar with holds no `offers:read`, and asking them for one to fill a suggestion list would
 * hand them the letters as well. Only the titles leave — never a figure from that catalogue.
 */
export async function listInterviewJobTitleOptions(caller: InterviewCalendarCaller): Promise<string[]> {
  requireCalendarAccess(caller, "book", "any");
  const titles = await listOfferJobTitles();
  return titles
    .filter((title) => title.active)
    .map((title) => title.title.trim())
    .filter((title) => title.length > 0);
}

function slotIsFree(session: SessionRow, startMinutes: number, taken: readonly BookingRow[], ignoreBookingId: string | null): void {
  const at = new Date(session.starts_at);
  const starts = sessionSlotStarts({
    durationMinutes: Number(session.duration_minutes),
    slotMinutes: Number(session.slot_minutes),
    startMinutes: cairoMinutesOfDay(at),
  });
  if (!starts.includes(startMinutes)) throw new Error("Choose one of the session's slots.");
  const instant = cairoLocalToUtc(cairoDateKey(at), startMinutes).getTime();
  if (taken.some((row) => row.id !== ignoreBookingId && new Date(row.starts_at).getTime() === instant)) {
    throw new Error("That slot is already taken — choose another.");
  }
}

/**
 * The interviewer a request names, checked against Employee Master: undefined when the request says
 * nothing (leave it as it is), null when it clears the interviewer, otherwise the employee's HR id.
 */
async function resolveInterviewer(value: unknown, current: string | null = null): Promise<string | null | undefined> {
  if (value === undefined) return undefined;
  if (value === null || (typeof value === "string" && value.trim() === "")) return null;
  if (typeof value !== "string") throw new Error("Choose the interviewer from the list.");
  const people = await loadPeople([value.trim()]);
  const person = people.get(canonicalHrIdKey(value) ?? "");
  if (!person) throw new Error("That interviewer is not in Employee Master.");
  // District Managers and above only (owner, 2026-09-20). Someone already chosen before the rule stays
  // on their interview — saving the booking again does not fail on it — but nobody new below that is.
  const unchanged = Boolean(current) && canonicalHrIdKey(current) === canonicalHrIdKey(person.hrId);
  if (!unchanged && !isDistrictManagerOrAbove({ jobTitle: person.jobTitle })) {
    throw new Error("Interviewers are District Managers and above — choose someone at that level.");
  }
  return person.hrId;
}

/**
 * The additional panel members, checked against Employee Master — District Managers and above, like
 * the lead — deduped, and never including the lead itself. `undefined` leaves the panel as it is;
 * anything else replaces it. Returns storage-form hr ids for the `panelist_hr_ids` column.
 */
async function resolvePanelists(value: unknown, leadHrId: string | null | undefined): Promise<string[] | undefined> {
  if (value === undefined) return undefined;
  if (value === null) return [];
  if (!Array.isArray(value)) throw new Error("Choose the panel members from the list.");
  const raw = value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "").map((entry) => entry.trim());
  if (raw.length === 0) return [];
  const leadKey = canonicalHrIdKey(leadHrId ?? "");
  const people = await loadPeople(raw);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const hrId of raw) {
    const key = canonicalHrIdKey(hrId);
    // Skip a blank, the lead (they are already on it), and a duplicate.
    if (!key || key === leadKey || seen.has(key)) continue;
    const person = people.get(key);
    if (!person) throw new Error("A panel member is not in Employee Master.");
    if (!isDistrictManagerOrAbove({ jobTitle: person.jobTitle })) {
      throw new Error("Panel members are District Managers and above — choose people at that level.");
    }
    seen.add(key);
    out.push(person.hrId);
  }
  return out;
}

export async function createInterviewBooking(
  caller: InterviewCalendarCaller,
  raw: InterviewBookingRequest,
  options: {
    cv?: InterviewCvUpload | null;
    zoomConfig?: ZoomConfig | null;
    requestLink?: { requestId: string; requestedByHrId: string } | null;
    /** A CV already in storage (from an interview request), carried onto the booking without re-upload. */
    externalCv?: { fileId: string; fileName: string; mimeType: string | null } | null;
  } = {},
): Promise<InterviewBookingResult> {
  const zoomConfig = options.zoomConfig === undefined ? readZoomConfig() : options.zoomConfig;
  const inSession = typeof raw.sessionId === "string" && raw.sessionId.trim() !== "";

  // WHERE and WHEN first — the gate is on the week it lands in, and nothing is written before it.
  let session: SessionRow | null = null;
  let input: InterviewBookingInput;
  if (inSession) {
    session = await loadSessionRow(raw.sessionId);
    const at = new Date(session.starts_at);
    const dateKey = cairoDateKey(at);
    requireCalendarAccess(caller, "book", weekStartFor(dateKey));
    const person = validateInterviewBookingInput({
      candidateId: raw.candidateId,
      dateKey,
      durationMinutes: 30,
      external: raw.external,
      notes: raw.notes,
      platform: session.platform,
      startMinutes: cairoMinutesOfDay(at),
    });
    const startMinutes = Number(raw.startMinutes);
    slotIsFree(session, startMinutes, await sessionBookingRows(session.id), null);
    input = { ...person, dateKey, durationMinutes: Number(session.slot_minutes), platform: asPlatform(session.platform), startMinutes };
  } else {
    input = validateInterviewBookingInput(raw);
    assertMayBookInterview(caller, weekStartFor(input.dateKey), raw.interviewerHrId);
  }
  const interviewerHrId = await resolveInterviewer(raw.interviewerHrId);
  const panelistHrIds = await resolvePanelists(raw.panelistHrIds, interviewerHrId);
  const cv = options.cv ? checkCvUpload(options.cv) : null;
  // Checked before anything is written, so a job title that is too long refuses the booking rather
  // than being silently dropped off a candidate that was already created.
  const jobTitle = interviewJobTitleLabel(raw.jobTitle);
  const addToRecruitment = raw.addToRecruitment !== false && raw.addToRecruitment !== "false";
  if (input.external && addToRecruitment) await assertMayUseRecruitmentFromCalendar(caller.access, "create");

  // WHO — a Phoenix candidate, an outside person made one now, or an outside person kept here only.
  let candidateId = input.candidateId;
  let name: string;
  let notice: string | null = null;
  const externalColumns: Record<string, string | null> = {};
  if (candidateId) {
    name = await candidateNameFor(candidateId);
  } else if (input.external && addToRecruitment) {
    // The same three questions inbound CV intake asks, in the same order and for the same reason:
    // the attached CV's own bytes first, then National ID and e-mail inside createCandidate. Booking
    // asked only the second pair until 2026-09-27, and a WhatsApp applicant has neither — so all
    // four byte-identical duplicate pairs on production were one `whatsapp` record and one
    // `interview_calendar` record. See calendar-candidate-resolve.ts for the measurement, and for
    // why the shared phone number is reported to the booker instead of deciding anything.
    const resolution = await resolveCalendarCandidate(
      { appliedForJobTitle: jobTitle, email: input.external.email, fullName: input.external.name, phone: input.external.phone },
      cv ? cv.bytes : null,
      {
        createCandidate: (identity) =>
          createCandidate({ ...identity, source: "interview_calendar" }, caller.access),
        fingerprintCv: cvContentFingerprint,
        findCvOwnerId: (contentMd5) => findCandidateIdByContentFingerprint(contentMd5),
        findPhoneTwins: (phoneNorm, excludeCandidateId) => findCandidatesByPhoneNorm(phoneNorm, excludeCandidateId),
        getCandidateById: async (id) => {
          const found = await getCandidate(id);
          return found ? { fullName: found.fullName, id: found.id } : null;
        },
        onLookupFailure: (stage, error) => {
          logError("Interview booking could not check whether this person is already on file", {
            error,
            labels: { event: `calendar_candidate_${stage}_lookup_failed` },
          });
        },
      },
    );
    candidateId = resolution.candidateId;
    name = resolution.fullName || input.external.name;
    notice = calendarCandidateNotice(resolution, { cvAttached: Boolean(cv) });
    if (cv) {
      await uploadCandidateFile(caller.access, {
        bytes: cv.bytes,
        candidateId,
        fileName: cv.fileName,
        kind: "cv",
        mimeType: cv.mimeType,
        origin: "interview_calendar",
        sizeBytes: cv.sizeBytes,
      });
      // The CV reaches the owner's Drive cabinet from HERE, because nothing else will bring it.
      // `mirrorCandidateCvsToDrive` runs on inbound intake and on a classification session, and a CV
      // attached while booking an interview passes through neither: measured on production
      // 2026-09-21, four of them sat in storage unmirrored for two days until a backfill was run by
      // hand. Best-effort and swallowed, exactly as the intake worker treats it — an interview must
      // still book when Drive is unreachable.
      await mirrorCandidateCvsToDrive(candidateId).catch(() => {});
    }
  } else if (input.external) {
    name = input.external.name;
    externalColumns.external_name = input.external.name;
    externalColumns.external_phone = input.external.phone;
    externalColumns.external_email = input.external.email;
    if (cv) {
      const storage = getRecruitmentFileStorage();
      if (!storage.supportsUpload) throw new Error("CV uploads are not switched on in Phoenix yet, so book without the file.");
      // Kept on the booking only, reachable through the calendar alone. The storage adapter has no
      // delete, so cancelling the interview leaves the file in storage with nothing pointing at it.
      const stored = await storage.uploadFile({ bytes: cv.bytes, fileName: cv.fileName, mimeType: cv.mimeType });
      if (!stored.driveFileId) throw new Error("The CV could not be stored, so the interview was not booked. Try again.");
      externalColumns.external_cv_file_id = stored.driveFileId;
      externalColumns.external_cv_file_name = cv.fileName;
      externalColumns.external_cv_mime_type = cv.mimeType;
    } else if (options.externalCv?.fileId) {
      // A CV already in storage (from an interview request HR is now giving a time): carry it onto
      // the booking as-is, without re-uploading — the request item already holds the stored file id.
      externalColumns.external_cv_file_id = options.externalCv.fileId;
      externalColumns.external_cv_file_name = options.externalCv.fileName;
      externalColumns.external_cv_mime_type = options.externalCv.mimeType ?? null;
    }
  } else {
    throw new Error("Choose the candidate to interview.");
  }

  // A slot shares its session's meeting; an interview on its own gets its own.
  const zoom = session ? OFFICE : input.platform === "zoom" ? await newMeeting(zoomConfig, input, interviewTopic(name)) : OFFICE;
  const actor = hrIdForStorage(caller.access.hrId);
  const { data, error } = await recruitmentDb()
    .from(BOOKINGS)
    .insert({
      candidate_id: candidateId,
      created_by_hr_id: actor,
      duration_minutes: input.durationMinutes,
      interviewer_hr_id: interviewerHrId ?? null,
      panelist_hr_ids: panelistHrIds ?? [],
      interview_area: orgLabel(raw.area),
      interview_line: orgLabel(raw.line),
      interview_job_title: jobTitle,
      notes: input.notes,
      platform: input.platform,
      request_id: options.requestLink?.requestId ?? null,
      requested_by_hr_id: options.requestLink ? hrIdForStorage(options.requestLink.requestedByHrId) : null,
      session_id: session?.id ?? null,
      starts_at: cairoLocalToUtc(input.dateKey, input.startMinutes).toISOString(),
      updated_by_hr_id: actor,
      ...externalColumns,
      ...zoom,
    })
    .select(BOOKING_COLUMNS)
    .single();
  if (error) {
    // The meeting was made for a booking that did not save. Take it back rather than leave a stray
    // meeting on the host's Zoom calendar that nothing in Phoenix points at.
    await dropMeeting(zoomConfig, zoom.zoom_meeting_id);
    throw error;
  }
  const bookedRow = data as BookingRow;
  const bookerName = personName(await loadPeople([caller.access.hrId]), caller.access.hrId) ?? "A colleague";
  await recordBookingChange(bookedRow.id, actor, "booked", `${bookerName} booked the interview.`);
  const [booking] = await hydrate([bookedRow], caller);
  return { booking, notice };
}

/**
 * The outside person's own name, phone and e-mail, edited on the booking after it was made — the
 * owner, 2026-09-26: a WhatsApp number forgotten when booking can be added later. Only for someone
 * kept on the calendar; a Recruitment candidate's contact details live on their candidate record,
 * not on the interview, so editing them here is refused with a sentence that says where to go.
 */
function resolveExternalContactPatch(row: BookingRow, value: unknown): Record<string, string | null> {
  if (value === undefined) return {};
  if (row.candidate_id) {
    throw new Error("This person is a Recruitment candidate — change their name, phone and e-mail on their candidate record.");
  }
  const person = validateExternalPerson(value);
  return { external_email: person.email, external_name: person.name, external_phone: person.phone };
}

export async function updateInterviewBooking(
  caller: InterviewCalendarCaller,
  bookingId: string,
  patch: {
    dateKey?: unknown;
    startMinutes?: unknown;
    durationMinutes?: unknown;
    platform?: unknown;
    notes?: unknown;
    sessionId?: unknown;
    interviewerHrId?: unknown;
    /** Additional panel members beyond the lead — replaces the panel when given. */
    panelistHrIds?: unknown;
    /** The sales Area and Line the interview is for — set either to change it, null to clear. */
    area?: unknown;
    line?: unknown;
    /** The job the interview is for — set to change it, null to clear. Never reaches the candidate:
     * the candidate's own record is written once, when the booking creates it. */
    jobTitle?: unknown;
    /** The outside person's own name, phone and e-mail — edited after booking, external only. */
    external?: unknown;
  },
  zoomConfig: ZoomConfig | null = readZoomConfig(),
): Promise<InterviewBooking> {
  const row = await loadBookingRow(bookingId);
  // The booking tier (owner/editor/HR) may change everything. The owner also let the DISTRICT MANAGER
  // WHO REQUESTED an interview change its day, time and place (2026-10-04) — so a requester passes the
  // gate on their OWN request's booking, and is held to day/time/place below. Everyone else still gets
  // the ordinary book refusal.
  const hasBook = roleMeets(calendarRoleFor(caller, weekOfInstant(row.starts_at)), "book");
  const callerKey = canonicalHrIdKey(caller.access.hrId);
  const isRequester =
    isSignedInCaller(caller.access) &&
    Boolean(row.requested_by_hr_id) &&
    Boolean(callerKey) &&
    callerKey === canonicalHrIdKey(row.requested_by_hr_id);
  if (!hasBook && !isRequester) requireCalendarAccess(caller, "book", weekOfInstant(row.starts_at));
  if (!hasBook) {
    // A requester changes only when and where — never who conducts it, the panel, the area/line, the
    // outside person's contact details, or which session it sits in. Those stay HR's.
    if (
      patch.interviewerHrId !== undefined ||
      patch.panelistHrIds !== undefined ||
      patch.area !== undefined ||
      patch.line !== undefined ||
      patch.jobTitle !== undefined ||
      patch.external !== undefined ||
      patch.sessionId !== undefined
    ) {
      throw new Error("You can change your interview's day, time and place — the interviewer, panel and area are HR's to change.");
    }
  }
  const at = new Date(row.starts_at);
  const notes = patch.notes === undefined ? row.notes : cleanNotes(patch.notes);
  const actor = hrIdForStorage(caller.access.hrId);
  const interviewerHrId = await resolveInterviewer(patch.interviewerHrId, row.interviewer_hr_id);
  // The panel is validated against the EFFECTIVE lead — the new interviewer if one is being set,
  // otherwise the one already on the row — so the lead is never also listed as a panel member.
  const effectiveLead = interviewerHrId === undefined ? row.interviewer_hr_id : interviewerHrId;
  const panelistHrIds = await resolvePanelists(patch.panelistHrIds, effectiveLead);
  const externalColumns = resolveExternalContactPatch(row, patch.external);
  const nameFor = async () => (row.candidate_id ? candidateNameFor(row.candidate_id) : row.external_name?.trim() || "Unnamed candidate");
  const timeChanged = [patch.dateKey, patch.startMinutes, patch.durationMinutes].some((value) => value !== undefined);
  // Reassigning the interviewer to a DIFFERENT person clears their predecessor's confirm/decline
  // answer, so the new interviewer starts unanswered (owner, 2026-09-26).
  const interviewerChanged = interviewerHrId !== undefined && canonicalHrIdKey(interviewerHrId) !== canonicalHrIdKey(row.interviewer_hr_id);
  const confirmationReset = interviewerChanged
    ? { decline_reason: null, interviewer_confirmation: null, interviewer_confirmation_at: null, interviewer_confirmation_by_hr_id: null }
    : {};
  const interviewerColumn = interviewerHrId === undefined ? {} : { interviewer_hr_id: interviewerHrId, ...confirmationReset };
  const panelistColumn = panelistHrIds === undefined ? {} : { panelist_hr_ids: panelistHrIds };
  const orgColumns: Record<string, unknown> = {};
  if (patch.area !== undefined) orgColumns.interview_area = orgLabel(patch.area);
  if (patch.line !== undefined) orgColumns.interview_line = orgLabel(patch.line);
  if (patch.jobTitle !== undefined) orgColumns.interview_job_title = interviewJobTitleLabel(patch.jobTitle);
  let update: Record<string, unknown>;

  // The change-history line for this edit, recorded after whichever save path runs. Interviewer set
  // wins over reschedule wins over a plain detail edit — the most notable single change.
  const editorName = personName(await loadPeople([caller.access.hrId]), caller.access.hrId) ?? "A colleague";
  const logEdit = async (savedRow: BookingRow) => {
    if (interviewerChanged) {
      const to = personName(await loadPeople([interviewerHrId as string]), interviewerHrId as string);
      await recordBookingChange(savedRow.id, actor, "interviewer", `${editorName} set the interviewer to ${to ?? "someone new"}.`);
    } else if (timeChanged || patch.platform !== undefined || patch.sessionId !== undefined) {
      await recordBookingChange(savedRow.id, actor, "rescheduled", `${editorName} changed the interview's time or place.`);
    } else {
      await recordBookingChange(savedRow.id, actor, "edited", `${editorName} edited the interview's details.`);
    }
  };

  // A DETAILS-ONLY edit — the interviewer, the note, or the outside person's name, phone and e-mail —
  // touches no time, place or session, so it needs no bookable window and works on a PAST interview
  // (the owner, 2026-09-26: "choose the interviewer for historical interviews"). The week gate above
  // has already run, and the Zoom meeting and the slot are left exactly as they are.
  const detailsOnly =
    patch.dateKey === undefined &&
    patch.startMinutes === undefined &&
    patch.durationMinutes === undefined &&
    patch.platform === undefined &&
    patch.sessionId === undefined;
  if (detailsOnly) {
    const saved = await saveBooking(row.id, { notes, ...interviewerColumn, ...panelistColumn, ...orgColumns, ...externalColumns, updated_by_hr_id: actor });
    await logEdit(saved);
    const [booking] = await hydrate([saved], caller);
    return booking;
  }

  const targetSessionId = typeof patch.sessionId === "string" && patch.sessionId.trim() ? patch.sessionId.trim() : null;
  if (targetSessionId) {
    // INTO a session's slot — the same session or another. It takes that session's meeting, so a
    // meeting of its own is given up.
    const session = await loadSessionRow(targetSessionId);
    const dateKey = cairoDateKey(new Date(session.starts_at));
    requireCalendarAccess(caller, "book", weekStartFor(dateKey));
    const startMinutes = patch.startMinutes === undefined ? cairoMinutesOfDay(at) : Number(patch.startMinutes);
    slotIsFree(session, startMinutes, await sessionBookingRows(session.id), row.id);
    if (row.zoom_meeting_id) {
      await dropMeeting(zoomConfig, row.zoom_meeting_id);
      await unhookPolls({ bookingId: row.id });
    }
    update = {
      duration_minutes: Number(session.slot_minutes),
      notes,
      platform: asPlatform(session.platform),
      session_id: session.id,
      starts_at: cairoLocalToUtc(dateKey, startMinutes).toISOString(),
      ...OFFICE,
    };
  } else if (row.session_id && !timeChanged && patch.sessionId !== null && patch.platform === undefined) {
    // Still in its slot — only the note changes.
    update = { notes };
  } else {
    // An interview on its own: moved, lengthened, switched between office and Zoom — or taken OUT
    // of its session to stand alone, when it gets a meeting of its own.
    const leavingSession = Boolean(row.session_id);
    const session = leavingSession ? await loadSessionRow(row.session_id) : null;
    const input = validateInterviewTime({
      dateKey: patch.dateKey ?? cairoDateKey(at),
      durationMinutes: patch.durationMinutes ?? (leavingSession ? Math.max(30, Number(row.duration_minutes)) : row.duration_minutes),
      startMinutes: patch.startMinutes ?? cairoMinutesOfDay(at),
    });
    const platform = patch.platform ?? (session ? session.platform : row.platform);
    if (!isInterviewPlatform(platform)) throw new Error("Choose In office or Zoom.");
    // The week the interview LANDS in is a book-tier check — but a requester has no book right, so for
    // them the gate above (their own request) is what authorises the move; the day itself is still held
    // to a bookable Sun–Thu future slot by validateInterviewTime.
    if (hasBook) requireCalendarAccess(caller, "book", weekStartFor(input.dateKey));
    const moved =
      input.dateKey !== cairoDateKey(at) || input.startMinutes !== cairoMinutesOfDay(at) || input.durationMinutes !== Number(row.duration_minutes);

    let zoom: ZoomOutcome;
    let fresh = false;
    if (platform === "in_office") {
      if (row.zoom_meeting_id) {
        await dropMeeting(zoomConfig, row.zoom_meeting_id);
        await unhookPolls({ bookingId: row.id });
      }
      zoom = OFFICE;
    } else if (!leavingSession && row.zoom_meeting_id && (row.zoom_status === "created" || row.zoom_status === "failed")) {
      zoom = { zoom_error: null, zoom_join_url: row.zoom_join_url, zoom_meeting_id: row.zoom_meeting_id, zoom_status: "created" };
      if (moved || row.zoom_status === "failed") {
        if (!zoomConfig) {
          zoom = { ...zoom, zoom_error: "Zoom is no longer connected, so the meeting kept its old time.", zoom_status: "failed" };
        } else {
          try {
            await updateZoomMeeting(zoomConfig, row.zoom_meeting_id, { ...input, topic: interviewTopic(await nameFor()) });
          } catch (error) {
            // The link still works; it is the meeting's time on Zoom that is now wrong. Say so.
            zoom = { ...zoom, zoom_error: `${errorText(error)} The meeting kept its old time on Zoom.`, zoom_status: "failed" };
          }
        }
      }
    } else {
      // Zoom with no meeting of its own yet — newly switched, out of a session, never connected, or
      // refused last time. Try now.
      zoom = await newMeeting(zoomConfig, input, interviewTopic(await nameFor()));
      fresh = zoom.zoom_status === "created";
    }
    update = {
      duration_minutes: input.durationMinutes,
      notes,
      platform,
      session_id: null,
      starts_at: cairoLocalToUtc(input.dateKey, input.startMinutes).toISOString(),
      ...zoom,
    };
    if (fresh) {
      const saved = await saveBooking(row.id, { ...update, ...interviewerColumn, ...panelistColumn, ...orgColumns, ...externalColumns, updated_by_hr_id: actor });
      await pushWaitingPolls(zoomConfig, { bookingId: row.id }, zoom.zoom_meeting_id);
      await logEdit(saved);
      const [booking] = await hydrate([saved], caller);
      return booking;
    }
  }

  const saved = await saveBooking(row.id, { ...update, ...interviewerColumn, ...panelistColumn, ...orgColumns, ...externalColumns, updated_by_hr_id: actor });
  await logEdit(saved);
  const [booking] = await hydrate([saved], caller);
  return booking;
}

async function saveBooking(id: string, update: Record<string, unknown>): Promise<BookingRow> {
  const { data, error } = await recruitmentDb()
    .from(BOOKINGS)
    .update({ ...update, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select(BOOKING_COLUMNS)
    .single();
  if (error) throw error;
  return data as BookingRow;
}

/** Try Zoom again for a Zoom interview that has no meeting. */
export async function retryInterviewZoomMeeting(
  caller: InterviewCalendarCaller,
  bookingId: string,
  zoomConfig: ZoomConfig | null = readZoomConfig(),
): Promise<InterviewBooking> {
  const row = await loadBookingRow(bookingId);
  requireCalendarAccess(caller, "book", weekOfInstant(row.starts_at));
  if (row.session_id) throw new Error("This interview is a slot in a session and uses the session's meeting — try again on the session.");
  if (row.platform !== "zoom") throw new Error("This interview is in the office, so it has no Zoom meeting.");
  if (row.zoom_status === "created" && row.zoom_meeting_id) return getInterviewBooking(caller, row.id);
  if (!zoomConfig) throw new Error("Zoom is not connected to Phoenix yet.");
  return updateInterviewBooking(caller, bookingId, {}, zoomConfig);
}

/** Cancel: the interview leaves the calendar, its notes and polls with it, and its Zoom meeting is deleted. */
export async function cancelInterviewBooking(
  caller: InterviewCalendarCaller,
  bookingId: string,
  zoomConfig: ZoomConfig | null = readZoomConfig(),
): Promise<{ id: string }> {
  const row = await loadBookingRow(bookingId);
  requireCalendarAccess(caller, "book", weekOfInstant(row.starts_at));
  // A slot's meeting is the session's and stays; only an interview's own meeting goes with it.
  if (!row.session_id) await dropMeeting(zoomConfig, row.zoom_meeting_id);
  const { error } = await recruitmentDb().from(BOOKINGS).delete().eq("id", row.id);
  if (error) throw error;
  return { id: row.id };
}

// ── The outcome of an interview ────────────────────────────────────────────────────────────────

/**
 * Who may say how an interview went: the calendar's OWNER, and the person who conducted it (the chosen
 * interviewer). The owner, 2026-09-20 — "the interviewer and the calendar owner only". Someone the
 * calendar is merely shared with, even at "book" level, may read the outcome and never set it, and a
 * copy link is never a person.
 */
export function canSetInterviewOutcome(caller: InterviewCalendarCaller, interviewerHrId: string | null | undefined): boolean {
  if (!isSignedInCaller(caller.access)) return false;
  if (caller.own === "owner") return true;
  const viewer = canonicalHrIdKey(caller.access.hrId);
  const chosen = canonicalHrIdKey(interviewerHrId);
  return Boolean(viewer && chosen && viewer === chosen);
}

export type InterviewOutcomeResult = {
  booking: InterviewBooking;
  /** What happened to the candidate in Recruitment, in a sentence — or null when nothing was to be said. */
  candidateNote: string | null;
};

/**
 * The outcome's effect on the candidate in Recruitment (see interviewOutcomeCandidateEffect). It NEVER
 * throws: the outcome is already saved on the interview by now, and a candidate record that cannot be
 * moved is told to the person in words instead of undoing what they just recorded.
 *
 * NOTHING IS SENT TO THE CANDIDATE. This writes a status and a star and their audit row — the same
 * two writes a screener makes by hand — and no notice of any kind, Rejected included.
 */
async function applyOutcomeToCandidate(
  caller: InterviewCalendarCaller,
  row: BookingRow,
  outcome: InterviewOutcome,
): Promise<string | null> {
  const effect = interviewOutcomeCandidateEffect(outcome);
  if (!effect.status && effect.rating === null) return null;
  if (!row.candidate_id) return "Marked on the interview only — this person is not in Recruitment.";
  try {
    const candidate = await getCandidate(row.candidate_id);
    if (!candidate) return "Marked on the interview, but the candidate could not be found in Recruitment.";
    const notes: string[] = [];
    const current = normalizeCandidateStatus(candidate.status);
    if (effect.status) {
      const refusal = current === "hired" ? "They are already hired, so their status was left as it is." : statusChangeRefusal(candidate.status, effect.status);
      if (refusal) {
        notes.push(current === "hired" ? refusal : "They were already sent to a hiring manager, so their status was left as it is.");
      } else if (current !== effect.status) {
        const day = cairoDateKey(new Date(row.starts_at));
        await updateCandidateStatus(caller.access, row.candidate_id, effect.status, `Interview outcome: ${interviewOutcomeLabels[outcome]} (${day})`);
        // A rejection the interview made carries its reason, so the workspace counts it with the
        // others ("Failed the interview") instead of as a rejection nobody explained. Only where the
        // status really moved here — a candidate already rejected keeps the reason HR gave.
        if (effect.status === "rejected") {
          const { error: reasonError } = await recruitmentDb()
            .from("ats_candidates")
            .update({ rejection_reason: "failed_interview" })
            .eq("id", row.candidate_id);
          if (reasonError) throw reasonError;
        }
        notes.push(`Their status is now ${candidateStatusLabels[effect.status]}.`);
      }
    }
    if (effect.rating !== null && candidate.rating !== effect.rating) {
      await setCandidateRating(caller.access, row.candidate_id, effect.rating);
      notes.push("Rated 3 stars, Top pick.");
    }
    return notes.length > 0 ? notes.join(" ") : null;
  } catch (error) {
    return `Marked on the interview, but the candidate could not be updated: ${errorText(error)}`;
  }
}

/**
 * Record — or clear, with null — how an interview went. Clearing removes the label only: the
 * candidate keeps whatever status they were given, because a status is a decision somebody may have
 * built on since.
 */
export async function setInterviewOutcome(
  caller: InterviewCalendarCaller,
  bookingId: string,
  rawOutcome: unknown,
): Promise<InterviewOutcomeResult> {
  const outcome = rawOutcome === null || rawOutcome === undefined || rawOutcome === "" ? null : readInterviewOutcome(rawOutcome);
  if (outcome === null && rawOutcome !== null && rawOutcome !== undefined && rawOutcome !== "") {
    throw new Error("That is not an interview outcome.");
  }
  const row = await loadBookingRow(bookingId);
  requireCalendarAccess(caller, "view", weekOfInstant(row.starts_at));
  if (!mayReadBooking(caller, row)) throw new Error(NOT_YOURS);
  if (!canSetInterviewOutcome(caller, row.interviewer_hr_id)) {
    throw new Error("Only the interviewer, or the owner of this calendar, can record how an interview went.");
  }
  const actor = hrIdForStorage(caller.access.hrId);
  const { error } = await recruitmentDb()
    .from(BOOKINGS)
    .update({
      outcome,
      outcome_set_at: outcome ? new Date().toISOString() : null,
      outcome_set_by_hr_id: outcome ? actor : null,
      updated_by_hr_id: actor,
    })
    .eq("id", row.id);
  if (error) throw error;
  const candidateNote = outcome ? await applyOutcomeToCandidate(caller, row, outcome) : null;
  const setterName = personName(await loadPeople([caller.access.hrId]), caller.access.hrId) ?? "A colleague";
  await recordBookingChange(
    row.id,
    actor,
    "outcome",
    outcome ? `${setterName} recorded the outcome: ${interviewOutcomeLabels[outcome]}.` : `${setterName} cleared the recorded outcome.`,
  );
  return { booking: await getInterviewBooking(caller, row.id), candidateNote };
}

// ── Sessions ────────────────────────────────────────────────────────────────────────────────────

export async function createInterviewSession(
  caller: InterviewCalendarCaller,
  raw: Parameters<typeof validateInterviewSessionInput>[0],
  zoomConfig: ZoomConfig | null = readZoomConfig(),
): Promise<InterviewSession> {
  const input = validateInterviewSessionInput(raw);
  requireCalendarAccess(caller, "book", weekStartFor(input.dateKey));
  const zoom = input.platform === "zoom" ? await newMeeting(zoomConfig, input, sessionTopic(input.title)) : OFFICE;
  const actor = hrIdForStorage(caller.access.hrId);
  const { data, error } = await recruitmentDb()
    .from(SESSIONS)
    .insert({
      created_by_hr_id: actor,
      duration_minutes: input.durationMinutes,
      notes: input.notes,
      platform: input.platform,
      slot_minutes: input.slotMinutes,
      starts_at: cairoLocalToUtc(input.dateKey, input.startMinutes).toISOString(),
      title: input.title,
      updated_by_hr_id: actor,
      ...zoom,
    })
    .select(SESSION_COLUMNS)
    .single();
  if (error) {
    await dropMeeting(zoomConfig, zoom.zoom_meeting_id);
    throw error;
  }
  const [session] = await hydrateSessions([data as SessionRow]);
  return session;
}

/**
 * Move, lengthen, shorten, rename or switch a session. Its booked slots move WITH it, keeping their
 * place in it. What it refuses rather than guesses: a new slot length while slots are booked, and a
 * shorter session that would leave a booked slot outside it.
 */
export async function updateInterviewSession(
  caller: InterviewCalendarCaller,
  sessionId: string,
  patch: Parameters<typeof validateInterviewSessionInput>[0],
  zoomConfig: ZoomConfig | null = readZoomConfig(),
): Promise<InterviewSession> {
  const row = await loadSessionRow(sessionId);
  requireCalendarAccess(caller, "book", weekOfInstant(row.starts_at));
  const at = new Date(row.starts_at);
  const input = validateInterviewSessionInput({
    dateKey: patch.dateKey ?? cairoDateKey(at),
    durationMinutes: patch.durationMinutes ?? row.duration_minutes,
    notes: patch.notes === undefined ? row.notes : patch.notes,
    platform: patch.platform ?? row.platform,
    slotMinutes: patch.slotMinutes ?? row.slot_minutes,
    startMinutes: patch.startMinutes ?? cairoMinutesOfDay(at),
    title: patch.title === undefined ? row.title : patch.title,
  });
  requireCalendarAccess(caller, "book", weekStartFor(input.dateKey));

  const booked = await sessionBookingRows(row.id);
  if (booked.length > 0 && input.slotMinutes !== Number(row.slot_minutes)) {
    throw new Error("The slot length can change only while no slot is booked — move or cancel its interviews first.");
  }
  const newStart = cairoLocalToUtc(input.dateKey, input.startMinutes).getTime();
  const shift = newStart - at.getTime();
  const newEnd = newStart + input.durationMinutes * 60_000;
  for (const booking of booked) {
    const start = new Date(booking.starts_at).getTime() + shift;
    if (start < newStart || start + Number(booking.duration_minutes) * 60_000 > newEnd) {
      const when = formatTimeOfDay(cairoMinutesOfDay(new Date(booking.starts_at)));
      throw new Error(`The session would no longer cover the interview booked at ${when} — move it first.`);
    }
  }

  const moved = shift !== 0 || input.durationMinutes !== Number(row.duration_minutes);
  let zoom: ZoomOutcome;
  let fresh = false;
  if (input.platform === "in_office") {
    if (row.zoom_meeting_id) {
      await dropMeeting(zoomConfig, row.zoom_meeting_id);
      await unhookPolls({ sessionId: row.id });
    }
    zoom = OFFICE;
  } else if (row.zoom_meeting_id && (row.zoom_status === "created" || row.zoom_status === "failed")) {
    zoom = { zoom_error: null, zoom_join_url: row.zoom_join_url, zoom_meeting_id: row.zoom_meeting_id, zoom_status: "created" };
    if (moved || input.title !== row.title || row.zoom_status === "failed") {
      if (!zoomConfig) {
        zoom = { ...zoom, zoom_error: "Zoom is no longer connected, so the meeting kept its old time.", zoom_status: "failed" };
      } else {
        try {
          await updateZoomMeeting(zoomConfig, row.zoom_meeting_id, { ...input, topic: sessionTopic(input.title) });
        } catch (error) {
          zoom = { ...zoom, zoom_error: `${errorText(error)} The meeting kept its old time on Zoom.`, zoom_status: "failed" };
        }
      }
    }
  } else {
    zoom = await newMeeting(zoomConfig, input, sessionTopic(input.title));
    fresh = zoom.zoom_status === "created";
  }

  const { data, error } = await recruitmentDb()
    .from(SESSIONS)
    .update({
      duration_minutes: input.durationMinutes,
      notes: input.notes,
      platform: input.platform,
      slot_minutes: input.slotMinutes,
      starts_at: new Date(newStart).toISOString(),
      title: input.title,
      updated_at: new Date().toISOString(),
      updated_by_hr_id: hrIdForStorage(caller.access.hrId),
      ...zoom,
    })
    .eq("id", row.id)
    .select(SESSION_COLUMNS)
    .single();
  if (error) throw error;
  // Its slots follow it, in the same place in it.
  for (const booking of booked) {
    const { error: slotError } = await recruitmentDb()
      .from(BOOKINGS)
      .update({
        platform: input.platform,
        starts_at: new Date(new Date(booking.starts_at).getTime() + shift).toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", booking.id);
    if (slotError) throw slotError;
  }
  if (fresh) await pushWaitingPolls(zoomConfig, { sessionId: row.id }, zoom.zoom_meeting_id);
  const [session] = await hydrateSessions([data as SessionRow]);
  return session;
}

export async function retryInterviewSessionZoom(
  caller: InterviewCalendarCaller,
  sessionId: string,
  zoomConfig: ZoomConfig | null = readZoomConfig(),
): Promise<InterviewSession> {
  const row = await loadSessionRow(sessionId);
  requireCalendarAccess(caller, "book", weekOfInstant(row.starts_at));
  if (row.platform !== "zoom") throw new Error("This session is in the office, so it has no Zoom meeting.");
  if (!zoomConfig) throw new Error("Zoom is not connected to Phoenix yet.");
  return updateInterviewSession(caller, sessionId, {}, zoomConfig);
}

/** Cancel a session: its meeting is deleted, and the interviews booked in its slots go with it. */
export async function cancelInterviewSession(
  caller: InterviewCalendarCaller,
  sessionId: string,
  zoomConfig: ZoomConfig | null = readZoomConfig(),
): Promise<{ id: string; interviews: number }> {
  const row = await loadSessionRow(sessionId);
  requireCalendarAccess(caller, "book", weekOfInstant(row.starts_at));
  const booked = await sessionBookingRows(row.id);
  await dropMeeting(zoomConfig, row.zoom_meeting_id);
  const { error } = await recruitmentDb().from(SESSIONS).delete().eq("id", row.id);
  if (error) throw error;
  return { id: row.id, interviews: booked.length };
}

// ── Whose meeting an interview is held on ──────────────────────────────────────────────────────

export type InterviewMeetingTarget = { kind: "booking" | "session"; id: string };

export type InterviewMeeting = {
  weekStart: string;
  platform: InterviewPlatform;
  /** The Zoom meeting — the booking's own, or its session's. */
  meetingId: string | null;
  joinUrl: string | null;
  startsAt: string;
  endsAt: string;
  /** Where its polls live: the session, for a slot or a session; the booking, for one on its own. */
  pollOwner: PollOwner;
  /** A slot in a session: its polls, attendance and summary are the session's. */
  viaSession: boolean;
  /** An outside person's phone, for WhatsApp — only when the caller can book. */
  externalPhone: string | null;
};

export async function resolveInterviewMeeting(caller: InterviewCalendarCaller, target: InterviewMeetingTarget): Promise<InterviewMeeting> {
  if (target.kind === "session") {
    const session = await loadSessionRow(target.id);
    const weekStart = weekOfInstant(session.starts_at);
    requireCalendarAccess(caller, "view", weekStart);
    if (!mayReadSessions(caller, weekStart)) throw new Error(NOT_YOURS);
    const platform = asPlatform(session.platform);
    return {
      endsAt: new Date(endsAt(session.starts_at, session.duration_minutes)).toISOString(),
      externalPhone: null,
      joinUrl: platform === "zoom" ? session.zoom_join_url : null,
      meetingId: platform === "zoom" ? session.zoom_meeting_id : null,
      platform,
      pollOwner: { sessionId: session.id },
      startsAt: session.starts_at,
      viaSession: false,
      weekStart,
    };
  }
  const row = await loadBookingRow(target.id);
  const weekStart = weekOfInstant(row.starts_at);
  requireCalendarAccess(caller, "view", weekStart);
  if (!mayReadBooking(caller, row)) throw new Error(NOT_YOURS);
  const canBook = roleMeets(calendarRoleFor(caller, weekStart), "book");
  const externalPhone = !row.candidate_id && canBook ? row.external_phone : null;
  if (row.session_id) {
    const session = await loadSessionRow(row.session_id);
    const platform = asPlatform(session.platform);
    return {
      endsAt: new Date(endsAt(session.starts_at, session.duration_minutes)).toISOString(),
      externalPhone,
      joinUrl: platform === "zoom" ? session.zoom_join_url : null,
      meetingId: platform === "zoom" ? session.zoom_meeting_id : null,
      platform,
      pollOwner: { sessionId: session.id },
      startsAt: session.starts_at,
      viaSession: true,
      weekStart,
    };
  }
  const platform = asPlatform(row.platform);
  return {
    endsAt: new Date(endsAt(row.starts_at, row.duration_minutes)).toISOString(),
    externalPhone,
    joinUrl: platform === "zoom" ? row.zoom_join_url : null,
    meetingId: platform === "zoom" ? row.zoom_meeting_id : null,
    platform,
    pollOwner: { bookingId: row.id },
    startsAt: row.starts_at,
    viaSession: false,
    weekStart,
  };
}

// ── Comments ────────────────────────────────────────────────────────────────────────────────────

export async function addInterviewComment(caller: InterviewCalendarCaller, bookingId: string, body: unknown): Promise<InterviewBooking> {
  const row = await loadBookingRow(bookingId);
  requireCalendarAccess(caller, "comment", weekOfInstant(row.starts_at));
  const text = typeof body === "string" ? body.trim() : "";
  if (!text) throw new Error("Write the note first.");
  if (text.length > NOTE_LIMIT) throw new Error(`Keep the note under ${NOTE_LIMIT} characters.`);
  const author = hrIdForStorage(caller.access.hrId);
  if (!author) throw new Error("Forbidden: a note needs a person behind it, and this account has no HR record.");
  const { error } = await recruitmentDb().from(COMMENTS).insert({ author_hr_id: author, body: text, booking_id: row.id });
  if (error) throw error;
  return getInterviewBooking(caller, row.id);
}

// ── Sharing with named people ───────────────────────────────────────────────────────────────────

export async function listInterviewCalendarShares(caller: InterviewCalendarCaller): Promise<InterviewCalendarShare[]> {
  requireCalendarAccess(caller, "share", null);
  const rows = await loadShareRows();
  const people = await loadPeople(rows.map((row) => row.hr_id));
  return rows
    .filter((row) => isInterviewCalendarAccessLevel(row.access_level))
    .map((row) => {
      const person = people.get(canonicalHrIdKey(row.hr_id) ?? "");
      return {
        accessLevel: row.access_level as InterviewCalendarAccessLevel,
        hrId: hrIdForStorage(row.hr_id) ?? row.hr_id,
        jobTitle: person?.jobTitle ?? null,
        name: person?.name ?? "A former employee",
        sharedAt: row.created_at,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

/** The typed text, whitespace collapsed — NOTHING is stripped out of it.
 *
 * It used to blank `,` `(` `)` `"` `\` `:` because the two searches below splice it into a
 * PostgREST `or(...)` expression, where those are structural. That made the filter safe and, at the
 * same moment, unable to find anyone: a company whose name holds a parenthesis, or an Arabic name
 * typed with a comma, lost the characters it would have matched on. The values are double-quoted
 * now (`@/lib/supabase/search-filter`), which is what PostgREST documents for exactly this, so the
 * characters reach the database as text. Wildcards are the one thing still neutralised, inside the
 * shared helper — see `searchableTerm`. */
function filterText(query: unknown): string {
  return (typeof query === "string" ? query : "").replace(/\s+/g, " ").trim();
}

/**
 * Current employees, by name or job title. For sharing the calendar (the owner only), or — with
 * `purpose: "interviewer"` — for choosing who conducts an interview (anyone who can book).
 */
/**
 * Each person's OWN sales area & line from their org seat (au_v_org_tree), for auto-filling an
 * interview's area & line when they are chosen as the interviewer. Null for a seat above District
 * Manager or an HR/CEO seat (no area/line). Best-effort: auto-fill is a convenience, so a failed read
 * simply returns no seats rather than failing the interviewer search.
 */
async function resolveSeatOrgForHrIds(hrIds: readonly string[]): Promise<Map<string, { area: string | null; line: string | null }>> {
  const out = new Map<string, { area: string | null; line: string | null }>();
  const keys = Array.from(new Set(hrIds.flatMap((id) => (id ? hrIdLookupKeys(id) : []))));
  if (keys.length === 0) return out;
  try {
    const { data, error } = await recruitmentDb()
      .from("au_v_org_tree")
      .select("occupant_hr_id,area_name,line_name")
      .in("occupant_hr_id", keys);
    if (error || !data) return out;
    for (const row of data as Array<{ occupant_hr_id: string | null; area_name: string | null; line_name: string | null }>) {
      const key = canonicalHrIdKey(row.occupant_hr_id);
      if (!key) continue;
      out.set(key, { area: row.area_name?.trim() || null, line: row.line_name?.trim() || null });
    }
  } catch {
    return out;
  }
  return out;
}

export async function searchInterviewCalendarPeople(
  caller: InterviewCalendarCaller,
  query: unknown,
  purpose: "share" | "interviewer" = "share",
): Promise<InterviewCalendarPerson[]> {
  if (purpose === "interviewer") assertMayPickInterviewer(caller);
  else requireCalendarAccess(caller, "share", null);
  const text = filterText(query);
  if (text.length < 2) return [];
  // Empty when the text was nothing but wildcards: `.or("")` is a 400, and a lone `%` would match
  // every employee rather than narrowing to one.
  const peopleFilter = ilikeAnyFilter(["full_name", "nickname", "job_title"], text);
  if (!peopleFilter) return [];
  const { data, error } = await recruitmentDb()
    .from("employees")
    .select("hr_id,full_name,nickname,job_title")
    .filter("employment_status", "in", ACTIVE_EMPLOYMENT_STATUSES_IN_LIST)
    .or(peopleFilter)
    .order("full_name", { ascending: true })
    // The interviewer picker drops everyone below District Manager after the read, so it reads wider
    // first — otherwise fifteen reps sharing a name would crowd out the manager being searched for.
    .limit(purpose === "interviewer" ? 80 : 15);
  if (error) throw error;
  const people = ((data ?? []) as EmployeeRow[])
    .filter((row) => row.hr_id && (row.nickname || row.full_name))
    .filter((row) => purpose !== "interviewer" || isDistrictManagerOrAbove({ jobTitle: row.job_title }))
    .map((row) => ({
      hrId: hrIdForStorage(row.hr_id) ?? String(row.hr_id),
      jobTitle: row.job_title ?? null,
      name: String(row.nickname || row.full_name).trim(),
    }))
    .slice(0, 15);
  // Only the interviewer picker needs each person's own area & line (to auto-fill the interview's).
  if (purpose !== "interviewer" || people.length === 0) return people;
  const seats = await resolveSeatOrgForHrIds(people.map((person) => person.hrId));
  return people.map((person) => {
    const seat = seats.get(canonicalHrIdKey(person.hrId) ?? "");
    return seat ? { ...person, area: seat.area, line: seat.line } : person;
  });
}

export async function shareInterviewCalendar(
  caller: InterviewCalendarCaller,
  input: { hrId?: unknown; accessLevel?: unknown },
): Promise<InterviewCalendarShare[]> {
  requireCalendarAccess(caller, "share", null);
  const level = input.accessLevel;
  if (!isInterviewCalendarAccessLevel(level)) throw new Error("Choose Viewer, Commenter or Editor.");
  const requested = typeof input.hrId === "string" ? input.hrId.trim() : "";
  const person = (await loadPeople([requested])).get(canonicalHrIdKey(requested) ?? "");
  if (!person) throw new Error("That person is not in the employee directory.");
  if (canonicalHrIdKey(person.hrId) === canonicalHrIdKey(caller.access.hrId)) throw new Error("This is your own calendar already.");

  const rows = await loadShareRows();
  const existing = rows.find((row) => canonicalHrIdKey(row.hr_id) === canonicalHrIdKey(person.hrId));
  const now = new Date().toISOString();
  if (existing) {
    const { error } = await recruitmentDb()
      .from(SHARES)
      .update({ access_level: level, shared_by_hr_id: hrIdForStorage(caller.access.hrId), updated_at: now })
      .eq("hr_id", existing.hr_id);
    if (error) throw error;
  } else {
    const { error } = await recruitmentDb()
      .from(SHARES)
      .insert({ access_level: level, hr_id: person.hrId, shared_by_hr_id: hrIdForStorage(caller.access.hrId) });
    if (error) throw error;
  }

  if (!existing || existing.access_level !== level) {
    await notifyShared(person, level, now);
  }
  return listInterviewCalendarShares(caller);
}

/**
 * Tell the person, in Phoenix, that the calendar is theirs to open.
 *
 * In-app and push ONLY. Recruitment notices are never emailed (owner rule), and Telegram is left
 * out on purpose: when a Telegram delivery fails, the notifier falls back to EMAIL, so asking for
 * Telegram here would be asking for an email on a bad day. A failed notice never undoes the share.
 */
async function notifyShared(person: InterviewCalendarPerson, level: InterviewCalendarAccessLevel, at: string) {
  const what =
    level === "editor"
      ? "You can book, move and cancel interviews on it."
      : level === "commenter"
        ? "You can see it, open the CVs on it and leave notes."
        : "You can see it and open the CVs on it.";
  await createSystemNotification({
    actionUrl: interviewCalendarHref(),
    channels: ["in_app", "push"],
    eventType: "interview_calendar_shared",
    message: `The interview calendar was shared with you. ${what}`,
    metadata: { idempotencyKey: `interview-calendar-shared:${canonicalHrIdKey(person.hrId)}:${level}:${at}` },
    module: "recruitment",
    priority: "normal",
    recipientHrId: person.hrId,
    title: "Interview calendar shared with you",
  }).catch((error) => {
    console.warn("[interview-calendar] share notice failed", errorText(error));
  });
}

export async function unshareInterviewCalendar(caller: InterviewCalendarCaller, hrId: string): Promise<InterviewCalendarShare[]> {
  requireCalendarAccess(caller, "share", null);
  const key = canonicalHrIdKey(hrId);
  const rows = await loadShareRows();
  const existing = rows.find((row) => canonicalHrIdKey(row.hr_id) === key);
  if (existing) {
    const { error } = await recruitmentDb().from(SHARES).delete().eq("hr_id", existing.hr_id);
    if (error) throw error;
  }
  return listInterviewCalendarShares(caller);
}

// ── Sharing one interviewer's interviews with one manager ───────────────────────────────────────
//
// The owner, 2026-10-26: "choose Ali Muhammad Ali and choose Zahra, the PDA Cairo district manager,
// and share. Only the interviews related to them appear." A national manager interviews for several
// regions in one week; each district manager is shown only the ones for their own region — never the
// whole calendar, which is what a calendar share gives. The manager's hr id is written onto each chosen
// booking (`shared_with_hr_ids`), and mayReadBooking lets them read exactly those, view only.
//
// The server SUGGESTS which interviews are the manager's, from the org tree: the interview's line is
// the manager's line, and its area is the manager's own area or sits in the manager's region. An
// interview with no area, or an area the org tree does not know, is never suggested — the owner ticks
// it himself. Nothing is shared on a suggestion alone: only the ticked set is saved.

/** How far ahead the list reaches — the interviews still to come, not the whole history. */
const MANAGER_SHARE_DAYS_AHEAD = 60;

/** A name compared loosely: case, spaces, brackets and dashes ignored ("Behira (1)" is "Behira 1"). */
function orgNameKey(value: string | null | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9؀-ۿ]+/g, "");
}

type OrgSeatRow = {
  occupant_hr_id: string | null;
  seat_tier: string | null;
  line_name: string | null;
  region_name: string | null;
  area_name: string | null;
};

type ManagerSeat = { line: string | null; region: string | null; area: string | null };

/** The manager's own seat: their line, and the region and area it covers (either may be empty). */
async function loadManagerSeat(hrId: string): Promise<ManagerSeat> {
  const { data, error } = await recruitmentDb()
    .from("au_v_org_tree")
    .select("occupant_hr_id,seat_tier,line_name,region_name,area_name")
    .in("occupant_hr_id", hrIdLookupKeys(hrId));
  if (error) throw error;
  // A person holding several seats is read at their broadest one with a line (fewest filled levels).
  const seat = ((data ?? []) as OrgSeatRow[])
    .filter((row) => row.line_name)
    .sort(
      (left, right) =>
        Number(Boolean(left.area_name)) - Number(Boolean(right.area_name)) ||
        Number(Boolean(left.region_name)) - Number(Boolean(right.region_name)),
    )[0];
  return {
    area: seat?.area_name?.trim() || null,
    line: seat?.line_name?.trim() || null,
    region: seat?.region_name?.trim() || null,
  };
}

type OrgAreaRegions = { byLineArea: Map<string, string>; byArea: Map<string, string>; regions: Map<string, string> };

/** Every area the org tree knows, per line, with the region it sits in — and the region names themselves. */
async function loadAreaRegions(): Promise<OrgAreaRegions> {
  const { data, error } = await recruitmentDb().from("au_v_org_tree").select("line_name,region_name,area_name").not("region_name", "is", null);
  if (error) throw error;
  const byLineArea = new Map<string, string>();
  const byArea = new Map<string, string>();
  const regions = new Map<string, string>();
  for (const row of (data ?? []) as Array<{ line_name: string | null; region_name: string | null; area_name: string | null }>) {
    const region = row.region_name?.trim();
    if (!region) continue;
    regions.set(orgNameKey(region), region);
    const area = orgNameKey(row.area_name);
    if (!area) continue;
    byLineArea.set(`${orgNameKey(row.line_name)}|${area}`, region);
    if (!byArea.has(area)) byArea.set(area, region);
  }
  return { byArea, byLineArea, regions };
}

/** The region an interview's area sits in — on its own line first, then any line, then an area named after a region. */
function regionForArea(orgAreas: OrgAreaRegions, line: string | null, area: string | null): string | null {
  const key = orgNameKey(area);
  if (!key) return null;
  return orgAreas.byLineArea.get(`${orgNameKey(line)}|${key}`) ?? orgAreas.byArea.get(key) ?? orgAreas.regions.get(key) ?? null;
}

/** Whether this interview is the manager's, and why — in the words the share dialog shows. */
export function suggestInterviewForManager(
  manager: ManagerSeat,
  interview: { line: string | null; area: string | null; region: string | null },
): { suggested: boolean; reason: string } {
  if (manager.line && interview.line && orgNameKey(manager.line) !== orgNameKey(interview.line)) {
    return { reason: `${interview.line} line, not the manager's line (${manager.line}).`, suggested: false };
  }
  if (!manager.region && !manager.area) {
    return manager.line && interview.line
      ? { reason: `On the manager's line (${manager.line}).`, suggested: true }
      : { reason: "No line to compare. Tick it if it is theirs.", suggested: false };
  }
  if (!interview.area) return { reason: "No area set on this interview. Tick it if it is theirs.", suggested: false };
  if (manager.area) {
    return orgNameKey(manager.area) === orgNameKey(interview.area)
      ? { reason: `In the manager's area (${manager.area}).`, suggested: true }
      : { reason: `${interview.area} is not the manager's area (${manager.area}).`, suggested: false };
  }
  if (!interview.region) return { reason: `${interview.area} is not on the org chart. Tick it if it is theirs.`, suggested: false };
  return orgNameKey(interview.region) === orgNameKey(manager.region)
    ? { reason: `${interview.area} is in the manager's region (${manager.region}).`, suggested: true }
    : { reason: `${interview.area} is in ${interview.region}, not ${manager.region}.`, suggested: false };
}

/** The interviewer's upcoming interviews — as the lead or on the panel — from the start of today (Cairo). */
async function upcomingInterviewsOf(interviewerHrId: string, now: Date): Promise<BookingRow[]> {
  const me = canonicalHrIdKey(interviewerHrId);
  if (!me) return [];
  const from = cairoLocalToUtc(cairoDateKey(now), 0);
  const to = new Date(from.getTime() + MANAGER_SHARE_DAYS_AHEAD * 24 * 60 * 60 * 1000);
  return (await bookingsBetween(from, to)).filter((row) => canonicalHrIdKey(row.interviewer_hr_id) === me || isOnPanel(me, row.panelist_hr_ids));
}

async function resolveManagerSharePeople(input: { interviewerHrId?: unknown; managerHrId?: unknown }) {
  const interviewerId = typeof input.interviewerHrId === "string" ? input.interviewerHrId.trim() : "";
  const managerId = typeof input.managerHrId === "string" ? input.managerHrId.trim() : "";
  if (!interviewerId) throw new Error("Choose the interviewer first.");
  if (!managerId) throw new Error("Choose the manager to share with.");
  const people = await loadPeople([interviewerId, managerId]);
  const interviewer = people.get(canonicalHrIdKey(interviewerId) ?? "");
  const manager = people.get(canonicalHrIdKey(managerId) ?? "");
  if (!interviewer) throw new Error("That interviewer is not in the employee directory.");
  if (!manager) throw new Error("That manager is not in the employee directory.");
  if (canonicalHrIdKey(interviewer.hrId) === canonicalHrIdKey(manager.hrId)) {
    throw new Error("Choose a different manager. The interviewer already sees their own interviews.");
  }
  // Below District Manager the calendar never opens at all (the requester seat rule), so a share
  // would reach nobody; say so rather than save a share nobody can read.
  if (!isDistrictManagerOrAbove({ jobTitle: manager.jobTitle })) {
    throw new Error(`${manager.name} is not a District Manager or above, so the interview calendar does not open for them.`);
  }
  return { interviewer, manager };
}

/** One interviewer's upcoming interviews, marked for one manager: already shared, suggested, and why. */
export async function getInterviewManagerSharePlan(
  caller: InterviewCalendarCaller,
  input: { interviewerHrId?: unknown; managerHrId?: unknown },
  now: Date = new Date(),
): Promise<InterviewManagerSharePlan> {
  requireCalendarAccess(caller, "share", null);
  const { interviewer, manager } = await resolveManagerSharePeople(input);
  const [rows, seat, orgAreas] = await Promise.all([upcomingInterviewsOf(interviewer.hrId, now), loadManagerSeat(manager.hrId), loadAreaRegions()]);
  const candidates = await loadCandidates(rows.map((row) => row.candidate_id ?? ""));
  const managerKey = canonicalHrIdKey(manager.hrId);
  const items: InterviewManagerShareItem[] = rows.map((row) => {
    const area = row.interview_area?.trim() || null;
    const line = row.interview_line?.trim() || null;
    const region = regionForArea(orgAreas, line, area);
    const candidate = row.candidate_id ? candidates.get(String(row.candidate_id)) : undefined;
    const verdict = suggestInterviewForManager(seat, { area, line, region });
    return {
      area,
      bookingId: row.id,
      candidateName: candidate?.full_name?.trim() || row.external_name?.trim() || "Unnamed candidate",
      durationMinutes: Number(row.duration_minutes),
      jobTitle: row.interview_job_title?.trim() || null,
      line,
      reason: verdict.reason,
      region,
      shared: isOnPanel(managerKey, row.shared_with_hr_ids),
      startsAt: row.starts_at,
      suggested: verdict.suggested,
    };
  });
  return {
    interviewer: { hrId: interviewer.hrId, jobTitle: interviewer.jobTitle, name: interviewer.name },
    items,
    manager: { ...seat, hrId: manager.hrId, jobTitle: manager.jobTitle, name: manager.name },
  };
}

/**
 * Save which of the interviewer's upcoming interviews the manager sees: the ticked ones gain the
 * manager, the unticked ones lose them. Only that interviewer's upcoming interviews can be touched —
 * an id from anywhere else in the request is ignored. The manager is told in Phoenix and on their
 * phone when something new is shared with them; never by email (the recruitment rule).
 */
export async function saveInterviewManagerShare(
  caller: InterviewCalendarCaller,
  input: { interviewerHrId?: unknown; managerHrId?: unknown; bookingIds?: unknown },
  now: Date = new Date(),
): Promise<InterviewManagerSharePlan> {
  requireCalendarAccess(caller, "share", null);
  if (!Array.isArray(input.bookingIds)) throw new Error("Tick the interviews to share.");
  const wanted = new Set(input.bookingIds.filter((id): id is string => typeof id === "string" && isUuid(id)));
  const { interviewer, manager } = await resolveManagerSharePeople(input);
  const managerKey = canonicalHrIdKey(manager.hrId);
  const managerStored = hrIdForStorage(manager.hrId) ?? manager.hrId;
  const actor = hrIdForStorage(caller.access.hrId);
  const rows = await upcomingInterviewsOf(interviewer.hrId, now);
  const added: BookingRow[] = [];
  for (const row of rows) {
    const current = row.shared_with_hr_ids ?? [];
    const has = isOnPanel(managerKey, current);
    const want = wanted.has(row.id);
    if (has === want) continue;
    const next = want ? [...current, managerStored] : current.filter((hrId) => canonicalHrIdKey(hrId) !== managerKey);
    const { error } = await recruitmentDb().from(BOOKINGS).update({ shared_with_hr_ids: next, updated_by_hr_id: actor }).eq("id", row.id);
    if (error) throw error;
    await recordBookingChange(row.id, actor, "shared", want ? `Shared with ${manager.name}.` : `No longer shared with ${manager.name}.`);
    if (want) added.push(row);
  }
  if (added.length > 0) await notifyInterviewsShared(manager, interviewer.name, added);
  return getInterviewManagerSharePlan(caller, { interviewerHrId: interviewer.hrId, managerHrId: manager.hrId }, now);
}

/** In-app and push only — never email, and never Telegram (whose failure falls back to email). */
async function notifyInterviewsShared(manager: InterviewCalendarPerson, interviewerName: string, rows: readonly BookingRow[]) {
  const first = rows[0];
  if (!first) return;
  const firstAt = new Date(first.starts_at);
  const firstDay = cairoDateKey(firstAt);
  const when = `${formatDayLong(firstDay)} at ${formatTimeOfDay(cairoMinutesOfDay(firstAt))}`;
  const what = rows.length === 1 ? `an interview ${interviewerName} is holding on ${when}` : `${rows.length} interviews ${interviewerName} is holding, the first on ${when}`;
  await createSystemNotification({
    actionUrl: interviewCalendarHref({ weekStart: weekStartFor(firstDay) }),
    channels: ["in_app", "push"],
    eventType: "interview_calendar_shared",
    message: `You can now see ${what}. It is on your interview calendar, with the CV.`,
    metadata: {
      idempotencyKey: `interview-calendar-interviews-shared:${canonicalHrIdKey(manager.hrId)}:${rows
        .map((row) => row.id)
        .sort()
        .join(",")}`,
    },
    module: "recruitment",
    priority: "normal",
    recipientHrId: manager.hrId,
    title: rows.length === 1 ? "An interview was shared with you" : "Interviews were shared with you",
  }).catch((error) => {
    console.warn("[interview-calendar] interview share notice failed", errorText(error));
  });
}

// ── Finding a candidate from an empty cell ──────────────────────────────────────────────────────

export type InterviewCandidateMatch = { id: string; name: string; jobTitle: string | null };

/**
 * Recruitment's candidates, by name, phone or e-mail — for booking from a pressed cell. It reads
 * Recruitment itself, so it needs Recruitment's own read grant as well as the right to book: sharing
 * the calendar is not a key to every applicant in the company.
 */
export async function searchInterviewCandidates(caller: InterviewCalendarCaller, query: unknown): Promise<InterviewCandidateMatch[]> {
  requireCalendarAccess(caller, "book", "any");
  await assertMayUseRecruitmentFromCalendar(caller.access, "read");
  const text = filterText(query);
  if (text.length < 2) return [];
  const value = ilikeContainsValue(text);
  if (!value) return [];
  const digits = text.replace(/\D/g, "");
  const clauses = [`full_name.ilike.${value}`, `email.ilike.${value}`];
  if (digits.length >= 5) {
    const digitsValue = ilikeContainsValue(digits);
    if (digitsValue) clauses.push(`phone.ilike.${digitsValue}`, `whatsapp.ilike.${digitsValue}`);
  }
  const { data, error } = await recruitmentDb()
    .from("ats_candidates")
    .select("id,full_name,applied_for_job_title")
    .or(clauses.join(","))
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) throw error;
  return ((data ?? []) as CandidateRow[]).map((row) => ({
    id: String(row.id),
    jobTitle: row.applied_for_job_title?.trim() || null,
    name: row.full_name?.trim() || "Unnamed candidate",
  }));
}

// ── The CVs on the calendar ─────────────────────────────────────────────────────────────────────

const GUEST_CVS_OFF = "Forbidden: the CVs on this link open only after signing in to Phoenix.";

export function assertCvsOpenTo(caller: InterviewCalendarCaller) {
  if (!isSignedInCaller(caller.access) && caller.access.source !== "system" && !caller.link?.guestCvs) throw new Error(GUEST_CVS_OFF);
}

/**
 * Anyone the calendar is shared with opens the CVs ON it — and only those, in the weeks open to them.
 *
 * Proved per request: the candidate must hold an interview in a week this caller can see, and the
 * file must be that candidate's (so a file id cannot be swapped for someone else's document). This is
 * the calendar's own door, beside the recruitment file routes rather than through them, because a
 * viewer may hold no recruitment grant at all: the owner decides who sees these CVs by sharing the
 * calendar. Someone holding only a link, not signed in, opens them unless the owner switched that off.
 */
async function assertCandidateOnCalendar(caller: InterviewCalendarCaller, candidateId: string) {
  if (!isUuid(candidateId)) throw new Error("Candidate not found.");
  const { data, error } = await recruitmentDb().from(BOOKINGS).select("starts_at,interviewer_hr_id,requested_by_hr_id,panelist_hr_ids,shared_with_hr_ids").eq("candidate_id", candidateId).limit(200);
  if (error) throw error;
  const rows = (data ?? []) as Array<{
    starts_at: string;
    interviewer_hr_id: string | null;
    requested_by_hr_id: string | null;
    panelist_hr_ids: string[] | null;
    shared_with_hr_ids: string[] | null;
  }>;
  if (rows.length === 0) throw new Error("Forbidden: this candidate is not on the interview calendar.");
  if (!rows.some((row) => mayReadBooking(caller, row))) {
    throw new Error("Forbidden: this candidate is not on the part of the calendar open to you.");
  }
  assertCvsOpenTo(caller);
}

export type InterviewCalendarFile = { id: string; kind: string; fileName: string; mimeType: string | null; createdAt: string };

export async function listInterviewCalendarCandidateFiles(caller: InterviewCalendarCaller, candidateId: string): Promise<InterviewCalendarFile[]> {
  requireCalendarAccess(caller, "view", "any");
  await assertCandidateOnCalendar(caller, candidateId);
  const files = await listCandidateFiles(candidateId);
  return files.map((file) => ({
    createdAt: file.createdAt,
    fileName: file.fileName,
    id: file.id,
    kind: file.kind,
    mimeType: file.mimeType,
  }));
}

export async function getInterviewCalendarCandidateFile(
  caller: InterviewCalendarCaller,
  candidateId: string,
  fileId: string,
): Promise<FileDownload | null> {
  requireCalendarAccess(caller, "view", "any");
  await assertCandidateOnCalendar(caller, candidateId);
  const files = await listCandidateFiles(candidateId);
  if (!files.some((file) => file.id === fileId)) throw new Error("Forbidden: that file does not belong to this candidate.");
  return getFileForDownload(fileId);
}

/** The WhatsApp conversation an interviewee's application is built from. It names nobody: the routes find the person from it. */
export type InterviewCalendarApplication = { sessionId: string };

/**
 * Whether the person opening this interview has an application to print, and which one.
 *
 * THE CV OPENS FOR ANYONE THE CALENDAR IS SHARED WITH; THE APPLICATION DOES NOT. It holds the phone, the
 * email and the salary they typed, so it is offered only to someone who could open the same file from
 * WhatsApp Applicants (`canOpenWhatsAppApplications`). Everyone else gets `null`, which the screen reads
 * as "draw no buttons", and the two routes behind the buttons refuse them again on their own. Null is also
 * the answer for a candidate who never applied on WhatsApp — there is no application to print.
 */
export async function getInterviewCalendarCandidateApplication(
  caller: InterviewCalendarCaller,
  candidateId: string,
): Promise<InterviewCalendarApplication | null> {
  requireCalendarAccess(caller, "view", "any");
  await assertCandidateOnCalendar(caller, candidateId);
  if (!isSignedInCaller(caller.access) || !(await canOpenWhatsAppApplications(caller.access))) return null;
  const sessionId = await findWhatsAppApplicationSessionId(candidateId);
  return sessionId ? { sessionId } : null;
}

/** The CV of someone from outside, kept on their booking alone. */
export async function getInterviewExternalCv(
  caller: InterviewCalendarCaller,
  bookingId: string,
): Promise<{ bytes: Buffer; mimeType: string; fileName: string }> {
  const row = await loadBookingRow(bookingId);
  requireCalendarAccess(caller, "view", weekOfInstant(row.starts_at));
  if (!mayReadBooking(caller, row)) throw new Error(NOT_YOURS);
  assertCvsOpenTo(caller);
  if (row.candidate_id || !row.external_cv_file_id) throw new Error("This interview has no CV kept on it.");
  const downloaded = await getRecruitmentFileStorage().downloadFile(row.external_cv_file_id);
  return {
    bytes: Buffer.from(downloaded.bytes),
    fileName: row.external_cv_file_name || downloaded.fileName || "cv",
    mimeType: row.external_cv_mime_type || downloaded.mimeType || "application/octet-stream",
  };
}

// ── Small readers the routes share ──────────────────────────────────────────────────────────────

export function describeInterviewSlot(booking: Pick<InterviewBooking, "dateKey" | "startMinutes">): string {
  return `${formatDayLong(booking.dateKey)}, ${formatTimeOfDay(booking.startMinutes)}`;
}
