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
// THIS FILE IS THE LOCK. Every read and write goes through `requireInterviewCalendarRole` before it
// touches a row, and the tables are service-role only (migration 20260918195837), so there is no
// other road to them. The screens hide what a level cannot do; they are not what stops it.
//
// WHY THE OWNER IS "SYSTEM SCOPE". The owner is the Super Admin, the only account with system scope.
// Tying ownership to that rather than to one HR id means the check reads the same fact every other
// Super Admin gate reads, and survives the id being written in a different case.

import type { AccessContext } from "@/lib/auth/permissions";
import { ACTIVE_EMPLOYMENT_STATUSES_IN_LIST } from "@/lib/auth/session-lifecycle";
import { canonicalHrIdKey, hrIdForStorage, hrIdLookupKeys } from "@/lib/hr-id";
import { isUuid } from "@/lib/http/uuid";
import { createSystemNotification } from "@/lib/notifications/system";
import { recruitmentDb } from "@/lib/recruitment/db";
import { getFileForDownload, listCandidateFiles, type FileDownload } from "@/lib/recruitment/files";
import {
  interviewCalendarHref,
  isInterviewCalendarAccessLevel,
  isInterviewPlatform,
  resolveCalendarRole,
  roleMeets,
  type InterviewBooking,
  type InterviewBookingComment,
  type InterviewCalendarAccessLevel,
  type InterviewCalendarNeed,
  type InterviewCalendarPerson,
  type InterviewCalendarRole,
  type InterviewCalendarShare,
  type InterviewPlatform,
  type InterviewZoomStatus,
} from "@/lib/recruitment/interview-calendar-types";
import {
  DURATION_CHOICES,
  cairoDateKey,
  cairoLocalToUtc,
  cairoMinutesOfDay,
  formatDayLong,
  formatTimeOfDay,
  isBookableDay,
  isBookableWindow,
  isDateKey,
  weekInstantRange,
  weekStartFor,
} from "@/lib/recruitment/interview-calendar-week";
import {
  createZoomMeeting,
  deleteZoomMeeting,
  readZoomConfig,
  updateZoomMeeting,
  type ZoomConfig,
} from "@/lib/zoom/meetings";

const BOOKINGS = "ats_interview_bookings";
const SHARES = "ats_interview_calendar_shares";
const COMMENTS = "ats_interview_booking_comments";

const NOTE_LIMIT = 1000;

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

export function isInterviewCalendarOwner(access: AccessContext): boolean {
  return access.scope === "system";
}

export async function resolveInterviewCalendarRole(access: AccessContext): Promise<InterviewCalendarRole | null> {
  const isOwner = isInterviewCalendarOwner(access);
  if (isOwner) return "owner";
  if (!access.hrId) return null;
  return resolveCalendarRole({ isOwner, shareLevel: shareLevelFor(await loadShareRows(), access.hrId) });
}

const REFUSAL: Record<InterviewCalendarNeed, string> = {
  book: "Forbidden: only the calendar's owner and its editors can book, move or cancel interviews.",
  comment: "Forbidden: your access to the interview calendar is view-only.",
  share: "Forbidden: only the calendar's owner can share it.",
  view: "Forbidden: the interview calendar has not been shared with you.",
};

/** The one gate every route calls. Throws a "Forbidden:" error the routes turn into a 403. */
export async function requireInterviewCalendarRole(
  access: AccessContext,
  need: InterviewCalendarNeed,
): Promise<InterviewCalendarRole> {
  if (!access.loginId && !access.hrId) throw new Error(REFUSAL.view);
  const role = await resolveInterviewCalendarRole(access);
  if (!roleMeets(role, need)) throw new Error(REFUSAL[role ? need : "view"]);
  return role as InterviewCalendarRole;
}

/** Whether this person should be offered the calendar at all — the portal sidebar asks this. */
export async function hasInterviewCalendarAccess(access: AccessContext): Promise<boolean> {
  try {
    return (await resolveInterviewCalendarRole(access)) !== null;
  } catch {
    return false;
  }
}

// ── Names ───────────────────────────────────────────────────────────────────────────────────────

type EmployeeRow = { hr_id: string | null; full_name: string | null; nickname: string | null; job_title: string | null };

async function loadPeople(hrIds: Iterable<string | null | undefined>): Promise<Map<string, InterviewCalendarPerson>> {
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

function personName(people: Map<string, InterviewCalendarPerson>, hrId: string | null | undefined): string | null {
  const key = canonicalHrIdKey(hrId);
  return key ? people.get(key)?.name ?? null : null;
}

// ── Bookings: reading ───────────────────────────────────────────────────────────────────────────

type BookingRow = {
  id: string;
  candidate_id: string;
  starts_at: string;
  duration_minutes: number;
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
  "id,candidate_id,starts_at,duration_minutes,platform,zoom_status,zoom_meeting_id,zoom_join_url,zoom_error,notes,created_by_hr_id,updated_by_hr_id,created_at,updated_at";

async function loadCandidates(ids: readonly string[]): Promise<Map<string, CandidateRow>> {
  const byId = new Map<string, CandidateRow>();
  const unique = Array.from(new Set(ids));
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

function asPlatform(value: string): InterviewPlatform {
  return isInterviewPlatform(value) ? value : "in_office";
}

function asZoomStatus(value: string): InterviewZoomStatus {
  return value === "created" || value === "not_connected" || value === "failed" ? value : "not_needed";
}

async function hydrate(rows: readonly BookingRow[], viewerHrId: string | null): Promise<InterviewBooking[]> {
  if (rows.length === 0) return [];
  const [candidates, comments] = await Promise.all([
    loadCandidates(rows.map((row) => row.candidate_id)),
    loadComments(rows.map((row) => row.id)),
  ]);
  const people = await loadPeople([...rows.map((row) => row.created_by_hr_id), ...comments.map((comment) => comment.author_hr_id)]);
  const viewerKey = canonicalHrIdKey(viewerHrId);

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
    const candidate = candidates.get(String(row.candidate_id));
    const platform = asPlatform(row.platform);
    return {
      bookedByName: personName(people, row.created_by_hr_id),
      candidateId: String(row.candidate_id),
      candidateJobTitle: candidate?.applied_for_job_title?.trim() || null,
      candidateName: candidate?.full_name?.trim() || "Unnamed candidate",
      comments: commentsByBooking.get(row.id) ?? [],
      createdAt: row.created_at,
      dateKey: cairoDateKey(at),
      durationMinutes: Number(row.duration_minutes),
      id: row.id,
      notes: row.notes,
      platform,
      startMinutes: cairoMinutesOfDay(at),
      startsAt: row.starts_at,
      updatedAt: row.updated_at,
      // An office interview never carries a link, whatever the row says (the table forbids it too).
      zoomError: platform === "zoom" ? row.zoom_error : null,
      zoomJoinUrl: platform === "zoom" ? row.zoom_join_url : null,
      zoomStatus: asZoomStatus(row.zoom_status),
    };
  });
}

export async function listInterviewBookingsForWeek(weekStart: string, viewerHrId: string | null): Promise<InterviewBooking[]> {
  if (!isDateKey(weekStart)) throw new Error("Choose a week to show.");
  const { from, to } = weekInstantRange(weekStartFor(weekStart));
  const { data, error } = await recruitmentDb()
    .from(BOOKINGS)
    .select(BOOKING_COLUMNS)
    .gte("starts_at", from.toISOString())
    .lt("starts_at", to.toISOString())
    .order("starts_at", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw error;
  return hydrate((data ?? []) as BookingRow[], viewerHrId);
}

/** A candidate's interviews from today on — the schedule dialog shows them before booking another. */
export async function listUpcomingInterviewsForCandidate(
  candidateId: string,
  viewerHrId: string | null,
  now: Date = new Date(),
): Promise<InterviewBooking[]> {
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
  return hydrate((data ?? []) as BookingRow[], viewerHrId);
}

/** Every interview on one day, for the dialog's time chips: a taken half hour is marked, not hidden. */
export async function listInterviewBookingsForDay(dateKey: string, viewerHrId: string | null): Promise<InterviewBooking[]> {
  if (!isDateKey(dateKey)) throw new Error("Choose a date.");
  const { data, error } = await recruitmentDb()
    .from(BOOKINGS)
    .select(BOOKING_COLUMNS)
    .gte("starts_at", cairoLocalToUtc(dateKey, 0).toISOString())
    .lt("starts_at", cairoLocalToUtc(dateKey, 24 * 60).toISOString())
    .order("starts_at", { ascending: true });
  if (error) throw error;
  return hydrate((data ?? []) as BookingRow[], viewerHrId);
}

async function loadBookingRow(bookingId: string): Promise<BookingRow> {
  if (!isUuid(bookingId)) throw new Error("Interview not found.");
  const { data, error } = await recruitmentDb().from(BOOKINGS).select(BOOKING_COLUMNS).eq("id", bookingId).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Interview not found.");
  return data as BookingRow;
}

export async function getInterviewBooking(bookingId: string, viewerHrId: string | null): Promise<InterviewBooking> {
  const [booking] = await hydrate([await loadBookingRow(bookingId)], viewerHrId);
  return booking;
}

// ── Bookings: writing ───────────────────────────────────────────────────────────────────────────

export type InterviewBookingInput = {
  candidateId: string;
  dateKey: string;
  startMinutes: number;
  durationMinutes: number;
  platform: InterviewPlatform;
  notes: string | null;
};

/** The request, checked. Every refusal is a sentence the person booking can act on. */
export function validateInterviewBookingInput(input: {
  candidateId?: unknown;
  dateKey?: unknown;
  startMinutes?: unknown;
  durationMinutes?: unknown;
  platform?: unknown;
  notes?: unknown;
}): InterviewBookingInput {
  const candidateId = typeof input.candidateId === "string" ? input.candidateId.trim() : "";
  if (!isUuid(candidateId)) throw new Error("Choose the candidate to interview.");
  const dateKey = typeof input.dateKey === "string" ? input.dateKey.trim() : "";
  if (!isDateKey(dateKey)) throw new Error("Choose a date for the interview.");
  if (!isBookableDay(dateKey)) throw new Error("Interviews are booked Sunday to Thursday only.");
  const startMinutes = Number(input.startMinutes);
  const durationMinutes = Number(input.durationMinutes);
  if (!(DURATION_CHOICES as readonly number[]).includes(durationMinutes)) {
    throw new Error("Choose how long the interview is: 30, 45 or 60 minutes.");
  }
  if (!isBookableWindow(startMinutes, durationMinutes)) {
    throw new Error("An interview starts at 9:00 AM or later and ends by 5:00 PM.");
  }
  if (!isInterviewPlatform(input.platform)) throw new Error("Choose In office or Zoom.");
  const notes = typeof input.notes === "string" ? input.notes.trim() : "";
  if (notes.length > NOTE_LIMIT) throw new Error(`Keep the note under ${NOTE_LIMIT} characters.`);
  return { candidateId, dateKey, durationMinutes, notes: notes || null, platform: input.platform, startMinutes };
}

function zoomTopic(candidateName: string): string {
  return `Interview · ${candidateName}`;
}

type ZoomOutcome = {
  zoom_status: InterviewZoomStatus;
  zoom_meeting_id: string | null;
  zoom_join_url: string | null;
  zoom_error: string | null;
};

const OFFICE: ZoomOutcome = { zoom_error: null, zoom_join_url: null, zoom_meeting_id: null, zoom_status: "not_needed" };

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

async function newMeeting(config: ZoomConfig | null, input: InterviewBookingInput, candidateName: string): Promise<ZoomOutcome> {
  if (!config) return { zoom_error: null, zoom_join_url: null, zoom_meeting_id: null, zoom_status: "not_connected" };
  try {
    const meeting = await createZoomMeeting(config, {
      dateKey: input.dateKey,
      durationMinutes: input.durationMinutes,
      startMinutes: input.startMinutes,
      topic: zoomTopic(candidateName),
    });
    return { zoom_error: null, zoom_join_url: meeting.joinUrl, zoom_meeting_id: meeting.id, zoom_status: "created" };
  } catch (error) {
    return { zoom_error: errorText(error), zoom_join_url: null, zoom_meeting_id: null, zoom_status: "failed" };
  }
}

async function candidateNameFor(candidateId: string): Promise<string> {
  const candidate = (await loadCandidates([candidateId])).get(candidateId);
  if (!candidate) throw new Error("Candidate not found.");
  return candidate.full_name?.trim() || "Unnamed candidate";
}

export async function createInterviewBooking(
  access: AccessContext,
  raw: Parameters<typeof validateInterviewBookingInput>[0],
  zoomConfig: ZoomConfig | null = readZoomConfig(),
): Promise<InterviewBooking> {
  await requireInterviewCalendarRole(access, "book");
  const input = validateInterviewBookingInput(raw);
  const candidateName = await candidateNameFor(input.candidateId);
  const zoom = input.platform === "zoom" ? await newMeeting(zoomConfig, input, candidateName) : OFFICE;
  const actor = hrIdForStorage(access.hrId);

  const { data, error } = await recruitmentDb()
    .from(BOOKINGS)
    .insert({
      candidate_id: input.candidateId,
      created_by_hr_id: actor,
      duration_minutes: input.durationMinutes,
      notes: input.notes,
      platform: input.platform,
      starts_at: cairoLocalToUtc(input.dateKey, input.startMinutes).toISOString(),
      updated_by_hr_id: actor,
      ...zoom,
    })
    .select(BOOKING_COLUMNS)
    .single();
  if (error) {
    // The meeting was made for a booking that did not save. Take it back rather than leave a stray
    // meeting on the host's Zoom calendar that nothing in Phoenix points at.
    if (zoom.zoom_meeting_id && zoomConfig) await deleteZoomMeeting(zoomConfig, zoom.zoom_meeting_id).catch(() => undefined);
    throw error;
  }
  const [booking] = await hydrate([data as BookingRow], access.hrId);
  return booking;
}

export async function updateInterviewBooking(
  access: AccessContext,
  bookingId: string,
  patch: { dateKey?: unknown; startMinutes?: unknown; durationMinutes?: unknown; platform?: unknown; notes?: unknown },
  zoomConfig: ZoomConfig | null = readZoomConfig(),
): Promise<InterviewBooking> {
  await requireInterviewCalendarRole(access, "book");
  const row = await loadBookingRow(bookingId);
  const at = new Date(row.starts_at);
  const input = validateInterviewBookingInput({
    candidateId: row.candidate_id,
    dateKey: patch.dateKey ?? cairoDateKey(at),
    durationMinutes: patch.durationMinutes ?? row.duration_minutes,
    notes: patch.notes === undefined ? row.notes : patch.notes,
    platform: patch.platform ?? row.platform,
    startMinutes: patch.startMinutes ?? cairoMinutesOfDay(at),
  });
  const moved =
    input.dateKey !== cairoDateKey(at) ||
    input.startMinutes !== cairoMinutesOfDay(at) ||
    input.durationMinutes !== Number(row.duration_minutes);

  let zoom: ZoomOutcome;
  if (input.platform === "in_office") {
    // Now in the office: the meeting goes. Best effort — a meeting Zoom will not delete is not a
    // reason to refuse the move, and it can do no harm once nothing in Phoenix points at it.
    if (row.zoom_meeting_id && zoomConfig) await deleteZoomMeeting(zoomConfig, row.zoom_meeting_id).catch(() => undefined);
    zoom = OFFICE;
  } else if (row.zoom_status === "created" && row.zoom_meeting_id) {
    zoom = { zoom_error: null, zoom_join_url: row.zoom_join_url, zoom_meeting_id: row.zoom_meeting_id, zoom_status: "created" };
    if (moved) {
      if (!zoomConfig) {
        zoom = { ...zoom, zoom_error: "Zoom is no longer connected, so the meeting kept its old time.", zoom_status: "failed" };
      } else {
        try {
          await updateZoomMeeting(zoomConfig, row.zoom_meeting_id, {
            dateKey: input.dateKey,
            durationMinutes: input.durationMinutes,
            startMinutes: input.startMinutes,
            topic: zoomTopic(await candidateNameFor(row.candidate_id)),
          });
        } catch (error) {
          // The link still works; it is the meeting's time on Zoom that is now wrong. Say so.
          zoom = { ...zoom, zoom_error: `${errorText(error)} The meeting kept its old time on Zoom.`, zoom_status: "failed" };
        }
      }
    }
  } else {
    // Zoom with no meeting yet — newly switched, never connected, or refused last time. Try now.
    zoom = await newMeeting(zoomConfig, input, await candidateNameFor(row.candidate_id));
  }

  const { data, error } = await recruitmentDb()
    .from(BOOKINGS)
    .update({
      duration_minutes: input.durationMinutes,
      notes: input.notes,
      platform: input.platform,
      starts_at: cairoLocalToUtc(input.dateKey, input.startMinutes).toISOString(),
      updated_at: new Date().toISOString(),
      updated_by_hr_id: hrIdForStorage(access.hrId),
      ...zoom,
    })
    .eq("id", row.id)
    .select(BOOKING_COLUMNS)
    .single();
  if (error) throw error;
  const [booking] = await hydrate([data as BookingRow], access.hrId);
  return booking;
}

/** Try Zoom again for a Zoom interview that has no meeting. */
export async function retryInterviewZoomMeeting(
  access: AccessContext,
  bookingId: string,
  zoomConfig: ZoomConfig | null = readZoomConfig(),
): Promise<InterviewBooking> {
  await requireInterviewCalendarRole(access, "book");
  const row = await loadBookingRow(bookingId);
  if (row.platform !== "zoom") throw new Error("This interview is in the office, so it has no Zoom meeting.");
  if (row.zoom_status === "created" && row.zoom_meeting_id) return getInterviewBooking(row.id, access.hrId);
  if (!zoomConfig) throw new Error("Zoom is not connected to Phoenix yet.");
  return updateInterviewBooking(access, bookingId, {}, zoomConfig);
}

/** Cancel: the interview leaves the calendar, its notes with it, and its Zoom meeting is deleted. */
export async function cancelInterviewBooking(
  access: AccessContext,
  bookingId: string,
  zoomConfig: ZoomConfig | null = readZoomConfig(),
): Promise<{ id: string }> {
  await requireInterviewCalendarRole(access, "book");
  const row = await loadBookingRow(bookingId);
  if (row.zoom_meeting_id && zoomConfig) await deleteZoomMeeting(zoomConfig, row.zoom_meeting_id).catch(() => undefined);
  const { error } = await recruitmentDb().from(BOOKINGS).delete().eq("id", row.id);
  if (error) throw error;
  return { id: row.id };
}

// ── Comments ────────────────────────────────────────────────────────────────────────────────────

export async function addInterviewComment(access: AccessContext, bookingId: string, body: unknown): Promise<InterviewBooking> {
  await requireInterviewCalendarRole(access, "comment");
  const text = typeof body === "string" ? body.trim() : "";
  if (!text) throw new Error("Write the note first.");
  if (text.length > NOTE_LIMIT) throw new Error(`Keep the note under ${NOTE_LIMIT} characters.`);
  const author = hrIdForStorage(access.hrId);
  if (!author) throw new Error("Forbidden: a note needs a person behind it, and this account has no HR record.");
  const row = await loadBookingRow(bookingId);
  const { error } = await recruitmentDb().from(COMMENTS).insert({ author_hr_id: author, body: text, booking_id: row.id });
  if (error) throw error;
  return getInterviewBooking(row.id, access.hrId);
}

// ── Sharing ─────────────────────────────────────────────────────────────────────────────────────

export async function listInterviewCalendarShares(access: AccessContext): Promise<InterviewCalendarShare[]> {
  await requireInterviewCalendarRole(access, "share");
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

/** People the owner can share with: current employees, by name. */
export async function searchInterviewCalendarPeople(access: AccessContext, query: unknown): Promise<InterviewCalendarPerson[]> {
  await requireInterviewCalendarRole(access, "share");
  // Anything that could break out of a PostgREST filter is dropped rather than escaped.
  const text = (typeof query === "string" ? query : "").replace(/[,()*%"\\:]/g, " ").replace(/\s+/g, " ").trim();
  if (text.length < 2) return [];
  const { data, error } = await recruitmentDb()
    .from("employees")
    .select("hr_id,full_name,nickname,job_title")
    .filter("employment_status", "in", ACTIVE_EMPLOYMENT_STATUSES_IN_LIST)
    .or(`full_name.ilike.*${text}*,nickname.ilike.*${text}*,job_title.ilike.*${text}*`)
    .order("full_name", { ascending: true })
    .limit(15);
  if (error) throw error;
  return ((data ?? []) as EmployeeRow[])
    .filter((row) => row.hr_id && (row.nickname || row.full_name))
    .map((row) => ({
      hrId: hrIdForStorage(row.hr_id) ?? String(row.hr_id),
      jobTitle: row.job_title ?? null,
      name: String(row.nickname || row.full_name).trim(),
    }));
}

export async function shareInterviewCalendar(
  access: AccessContext,
  input: { hrId?: unknown; accessLevel?: unknown },
): Promise<InterviewCalendarShare[]> {
  await requireInterviewCalendarRole(access, "share");
  const level = input.accessLevel;
  if (!isInterviewCalendarAccessLevel(level)) throw new Error("Choose Viewer, Commenter or Editor.");
  const requested = typeof input.hrId === "string" ? input.hrId.trim() : "";
  const person = (await loadPeople([requested])).get(canonicalHrIdKey(requested) ?? "");
  if (!person) throw new Error("That person is not in the employee directory.");
  if (canonicalHrIdKey(person.hrId) === canonicalHrIdKey(access.hrId)) throw new Error("This is your own calendar already.");

  const rows = await loadShareRows();
  const existing = rows.find((row) => canonicalHrIdKey(row.hr_id) === canonicalHrIdKey(person.hrId));
  const now = new Date().toISOString();
  if (existing) {
    const { error } = await recruitmentDb()
      .from(SHARES)
      .update({ access_level: level, shared_by_hr_id: hrIdForStorage(access.hrId), updated_at: now })
      .eq("hr_id", existing.hr_id);
    if (error) throw error;
  } else {
    const { error } = await recruitmentDb()
      .from(SHARES)
      .insert({ access_level: level, hr_id: person.hrId, shared_by_hr_id: hrIdForStorage(access.hrId) });
    if (error) throw error;
  }

  if (!existing || existing.access_level !== level) {
    await notifyShared(person, level, now);
  }
  return listInterviewCalendarShares(access);
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

export async function unshareInterviewCalendar(access: AccessContext, hrId: string): Promise<InterviewCalendarShare[]> {
  await requireInterviewCalendarRole(access, "share");
  const key = canonicalHrIdKey(hrId);
  const rows = await loadShareRows();
  const existing = rows.find((row) => canonicalHrIdKey(row.hr_id) === key);
  if (existing) {
    const { error } = await recruitmentDb().from(SHARES).delete().eq("hr_id", existing.hr_id);
    if (error) throw error;
  }
  return listInterviewCalendarShares(access);
}

// ── The CVs on the calendar ─────────────────────────────────────────────────────────────────────

/**
 * Anyone the calendar is shared with opens the CVs ON it — and only those.
 *
 * Proved per request: the candidate must hold at least one interview on the calendar, and the file
 * must be that candidate's (so a file id cannot be swapped for someone else's document). This is the
 * calendar's own door, beside the recruitment file routes rather than through them, because a viewer
 * may hold no recruitment grant at all: the owner decides who sees these CVs by sharing the calendar.
 */
async function assertCandidateOnCalendar(candidateId: string) {
  if (!isUuid(candidateId)) throw new Error("Candidate not found.");
  const { data, error } = await recruitmentDb().from(BOOKINGS).select("id").eq("candidate_id", candidateId).limit(1);
  if (error) throw error;
  if (!data || data.length === 0) throw new Error("Forbidden: this candidate is not on the interview calendar.");
}

export type InterviewCalendarFile = { id: string; kind: string; fileName: string; mimeType: string | null; createdAt: string };

export async function listInterviewCalendarCandidateFiles(access: AccessContext, candidateId: string): Promise<InterviewCalendarFile[]> {
  await requireInterviewCalendarRole(access, "view");
  await assertCandidateOnCalendar(candidateId);
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
  access: AccessContext,
  candidateId: string,
  fileId: string,
): Promise<FileDownload | null> {
  await requireInterviewCalendarRole(access, "view");
  await assertCandidateOnCalendar(candidateId);
  const files = await listCandidateFiles(candidateId);
  if (!files.some((file) => file.id === fileId)) throw new Error("Forbidden: that file does not belong to this candidate.");
  return getFileForDownload(fileId);
}

// ── Small readers the routes share ──────────────────────────────────────────────────────────────

export function describeInterviewSlot(booking: Pick<InterviewBooking, "dateKey" | "startMinutes">): string {
  return `${formatDayLong(booking.dateKey)}, ${formatTimeOfDay(booking.startMinutes)}`;
}
