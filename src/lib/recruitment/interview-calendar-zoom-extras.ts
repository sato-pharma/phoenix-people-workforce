// Recruitment — the interview calendar's Zoom extras: polls, the invitation, and what Zoom reports
// after a meeting (who attended, poll answers, the AI Companion summary).
//
// The owner, 2026-09-18: "build Zoom attendance, polls, invitation and AI summary into the interview
// calendar". His answers in chat: polls BOTH as reusable sets and typed for one interview; everyone
// the calendar is shared with reads the reports, link holders included. The invitation is TEXT for
// the person booking to copy, or to open WhatsApp with — Phoenix sends nobody anything.
//
// Every function resolves the meeting through `resolveInterviewMeeting`, which passes the calendar's
// gate for the week the interview is in before anything is read. A slot in a session is held on the
// SESSION's one meeting, so its polls, attendance and summary are the session's.

import { hrIdForStorage } from "@/lib/hr-id";
import { isUuid } from "@/lib/http/uuid";
import { recruitmentDb } from "@/lib/recruitment/db";
import {
  errorText,
  pushWaitingPolls,
  requireCalendarAccess,
  resolveInterviewMeeting,
  type InterviewCalendarCaller,
  type InterviewMeeting,
  type InterviewMeetingTarget,
} from "@/lib/recruitment/interview-calendar";
import {
  checkPollQuestions,
  type InterviewAttendee,
  type InterviewMeetingSummary,
  type InterviewPoll,
  type InterviewPollAnswer,
  type InterviewPollQuestion,
  type InterviewPollSet,
  type InterviewZoomInsights,
} from "@/lib/recruitment/interview-calendar-types";
import {
  deleteZoomPoll,
  getZoomMeetingInvitation,
  getZoomMeetingSummary,
  getZoomPastMeeting,
  listZoomMeetingAttendance,
  listZoomPollAnswers,
  readZoomConfig,
  type ZoomConfig,
} from "@/lib/zoom/meetings";

const POLL_SETS = "ats_interview_poll_sets";
const POLLS = "ats_interview_zoom_polls";
const INSIGHTS = "ats_interview_zoom_insights";

// ── Reusable poll sets ──────────────────────────────────────────────────────────────────────────

type PollSetRow = { id: string; name: string; questions: unknown; updated_at: string };

function questionsOf(value: unknown): InterviewPollQuestion[] {
  const checked = checkPollQuestions(value);
  return "questions" in checked ? checked.questions : [];
}

function mapPollSet(row: PollSetRow): InterviewPollSet {
  return { id: row.id, name: row.name, questions: questionsOf(row.questions), updatedAt: row.updated_at };
}

function cleanName(value: unknown, what: string): string {
  const name = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!name) throw new Error(`Give the ${what} a name.`);
  if (name.length > 120) throw new Error(`Keep the ${what}'s name under 120 characters.`);
  return name;
}

function cleanQuestions(value: unknown): InterviewPollQuestion[] {
  const checked = checkPollQuestions(value);
  if ("error" in checked) throw new Error(checked.error);
  return checked.questions;
}

/** Poll sets are part of arranging interviews, so they are for those who can book. */
export async function listInterviewPollSets(caller: InterviewCalendarCaller): Promise<InterviewPollSet[]> {
  requireCalendarAccess(caller, "book", "any");
  const { data, error } = await recruitmentDb().from(POLL_SETS).select("id,name,questions,updated_at").order("name", { ascending: true });
  if (error) throw error;
  return ((data ?? []) as PollSetRow[]).map(mapPollSet);
}

export async function createInterviewPollSet(
  caller: InterviewCalendarCaller,
  input: { name?: unknown; questions?: unknown },
): Promise<InterviewPollSet[]> {
  requireCalendarAccess(caller, "book", "any");
  const actor = hrIdForStorage(caller.access.hrId);
  const { error } = await recruitmentDb()
    .from(POLL_SETS)
    .insert({ created_by_hr_id: actor, name: cleanName(input.name, "poll"), questions: cleanQuestions(input.questions), updated_by_hr_id: actor });
  if (error) throw error;
  return listInterviewPollSets(caller);
}

/** A change to a set reaches the interviews it is added to from now on; polls already added keep their copy. */
export async function updateInterviewPollSet(
  caller: InterviewCalendarCaller,
  setId: string,
  patch: { name?: unknown; questions?: unknown },
): Promise<InterviewPollSet[]> {
  requireCalendarAccess(caller, "book", "any");
  if (!isUuid(setId)) throw new Error("Poll not found.");
  const update: Record<string, unknown> = { updated_at: new Date().toISOString(), updated_by_hr_id: hrIdForStorage(caller.access.hrId) };
  if (patch.name !== undefined) update.name = cleanName(patch.name, "poll");
  if (patch.questions !== undefined) update.questions = cleanQuestions(patch.questions);
  const { data, error } = await recruitmentDb().from(POLL_SETS).update(update).eq("id", setId).select("id");
  if (error) throw error;
  if (!data || data.length === 0) throw new Error("Poll not found.");
  return listInterviewPollSets(caller);
}

export async function deleteInterviewPollSet(caller: InterviewCalendarCaller, setId: string): Promise<InterviewPollSet[]> {
  requireCalendarAccess(caller, "book", "any");
  if (!isUuid(setId)) throw new Error("Poll not found.");
  const { error } = await recruitmentDb().from(POLL_SETS).delete().eq("id", setId);
  if (error) throw error;
  return listInterviewPollSets(caller);
}

// ── Polls on one meeting ────────────────────────────────────────────────────────────────────────

type PollRow = {
  id: string;
  booking_id: string | null;
  session_id: string | null;
  poll_set_id: string | null;
  title: string;
  questions: unknown;
  zoom_meeting_id: string | null;
  zoom_poll_id: string | null;
  status: string;
  error: string | null;
};

const POLL_COLUMNS = "id,booking_id,session_id,poll_set_id,title,questions,zoom_meeting_id,zoom_poll_id,status,error";

function ownerColumn(meeting: InterviewMeeting): [string, string] {
  return "bookingId" in meeting.pollOwner ? ["booking_id", meeting.pollOwner.bookingId] : ["session_id", meeting.pollOwner.sessionId];
}

async function pollRowsFor(meeting: InterviewMeeting): Promise<PollRow[]> {
  const [column, id] = ownerColumn(meeting);
  const { data, error } = await recruitmentDb().from(POLLS).select(POLL_COLUMNS).eq(column, id).order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as PollRow[];
}

async function mapPolls(rows: readonly PollRow[]): Promise<InterviewPoll[]> {
  const setIds = Array.from(new Set(rows.map((row) => row.poll_set_id).filter((id): id is string => Boolean(id))));
  const names = new Map<string, string>();
  if (setIds.length > 0) {
    const { data, error } = await recruitmentDb().from(POLL_SETS).select("id,name").in("id", setIds);
    if (error) throw error;
    for (const row of (data ?? []) as Array<{ id: string; name: string }>) names.set(row.id, row.name);
  }
  return rows.map((row) => ({
    error: row.error,
    fromSetName: row.poll_set_id ? names.get(row.poll_set_id) ?? null : null,
    id: row.id,
    questions: questionsOf(row.questions),
    status: row.status === "created" || row.status === "failed" ? row.status : "pending",
    title: row.title,
  }));
}

export async function listInterviewPolls(caller: InterviewCalendarCaller, target: InterviewMeetingTarget): Promise<InterviewPoll[]> {
  const meeting = await resolveInterviewMeeting(caller, target);
  return mapPolls(await pollRowsFor(meeting));
}

/**
 * Add a poll — from a saved set, or typed for this one meeting. Saved first, then put on Zoom when
 * the meeting exists; a meeting made later picks up every poll still waiting for it.
 */
export async function addInterviewPoll(
  caller: InterviewCalendarCaller,
  target: InterviewMeetingTarget,
  input: { pollSetId?: unknown; title?: unknown; questions?: unknown },
  zoomConfig: ZoomConfig | null = readZoomConfig(),
): Promise<InterviewPoll[]> {
  const meeting = await resolveInterviewMeeting(caller, target);
  requireCalendarAccess(caller, "book", meeting.weekStart);
  if (meeting.viaSession) throw new Error("This interview is a slot in a session — add the poll on the session, where its meeting is.");
  if (meeting.platform !== "zoom") throw new Error("Polls run inside Zoom, and this interview is in the office.");

  let title: string;
  let questions: InterviewPollQuestion[];
  let pollSetId: string | null = null;
  if (typeof input.pollSetId === "string" && input.pollSetId.trim()) {
    if (!isUuid(input.pollSetId.trim())) throw new Error("Poll not found.");
    const { data, error } = await recruitmentDb().from(POLL_SETS).select("id,name,questions,updated_at").eq("id", input.pollSetId.trim()).maybeSingle();
    if (error) throw error;
    if (!data) throw new Error("That saved poll was deleted.");
    const set = mapPollSet(data as PollSetRow);
    if (set.questions.length === 0) throw new Error("That saved poll has no questions.");
    pollSetId = set.id;
    title = set.name;
    questions = set.questions;
  } else {
    title = cleanName(input.title, "poll");
    questions = cleanQuestions(input.questions);
  }

  const [column, id] = ownerColumn(meeting);
  const { error } = await recruitmentDb()
    .from(POLLS)
    .insert({ [column]: id, created_by_hr_id: hrIdForStorage(caller.access.hrId), poll_set_id: pollSetId, questions, status: "pending", title });
  if (error) throw error;
  await pushWaitingPolls(zoomConfig, meeting.pollOwner, meeting.meetingId);
  return mapPolls(await pollRowsFor(meeting));
}

async function loadPoll(pollId: string): Promise<PollRow> {
  if (!isUuid(pollId)) throw new Error("Poll not found.");
  const { data, error } = await recruitmentDb().from(POLLS).select(POLL_COLUMNS).eq("id", pollId).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Poll not found.");
  return data as PollRow;
}

function targetOfPoll(poll: PollRow): InterviewMeetingTarget {
  return poll.session_id ? { id: poll.session_id, kind: "session" } : { id: String(poll.booking_id), kind: "booking" };
}

/** Take a poll off the interview — and off the Zoom meeting, when it was put there. */
export async function removeInterviewPoll(
  caller: InterviewCalendarCaller,
  pollId: string,
  zoomConfig: ZoomConfig | null = readZoomConfig(),
): Promise<InterviewPoll[]> {
  const poll = await loadPoll(pollId);
  const meeting = await resolveInterviewMeeting(caller, targetOfPoll(poll));
  requireCalendarAccess(caller, "book", meeting.weekStart);
  if (poll.zoom_poll_id && poll.zoom_meeting_id && zoomConfig) {
    await deleteZoomPoll(zoomConfig, poll.zoom_meeting_id, poll.zoom_poll_id).catch(() => undefined);
  }
  const { error } = await recruitmentDb().from(POLLS).delete().eq("id", poll.id);
  if (error) throw error;
  return mapPolls(await pollRowsFor(meeting));
}

/** Try Zoom again for the polls it refused, or that were waiting for a meeting. */
export async function retryInterviewPoll(
  caller: InterviewCalendarCaller,
  pollId: string,
  zoomConfig: ZoomConfig | null = readZoomConfig(),
): Promise<InterviewPoll[]> {
  const poll = await loadPoll(pollId);
  const meeting = await resolveInterviewMeeting(caller, targetOfPoll(poll));
  requireCalendarAccess(caller, "book", meeting.weekStart);
  if (!zoomConfig) throw new Error("Zoom is not connected to Phoenix yet.");
  if (!meeting.meetingId) throw new Error("The interview has no Zoom meeting yet — create the meeting first, and its polls follow.");
  await pushWaitingPolls(zoomConfig, meeting.pollOwner, meeting.meetingId);
  return mapPolls(await pollRowsFor(meeting));
}

// ── The invitation ──────────────────────────────────────────────────────────────────────────────

export type InterviewInvitation = {
  text: string;
  joinUrl: string | null;
  /** The number WhatsApp should open on — an outside person's, for those who can book; else none. */
  phone: string | null;
};

/** Zoom's own invitation text for the meeting — the same "Copy invitation" gives in Zoom. */
export async function getInterviewInvitation(
  caller: InterviewCalendarCaller,
  target: InterviewMeetingTarget,
  zoomConfig: ZoomConfig | null = readZoomConfig(),
): Promise<InterviewInvitation> {
  const meeting = await resolveInterviewMeeting(caller, target);
  if (meeting.platform !== "zoom") throw new Error("This interview is in the office, so there is no Zoom invitation.");
  if (!meeting.meetingId) throw new Error("There is no Zoom meeting yet — press Try Zoom again first.");
  if (!zoomConfig) throw new Error("Zoom is not connected to Phoenix yet.");
  const text = await getZoomMeetingInvitation(zoomConfig, meeting.meetingId);
  return { joinUrl: meeting.joinUrl, phone: meeting.externalPhone, text };
}

// ── After the meeting ───────────────────────────────────────────────────────────────────────────

/** Zoom's reports are read again at most this often on their own… */
const INSIGHTS_FRESH_MS = 15 * 60_000;
/** …and a person pressing Refresh cannot ask Zoom more than once a minute. */
const INSIGHTS_REFRESH_FLOOR_MS = 60_000;

type InsightsRow = {
  zoom_meeting_id: string;
  instance_uuid: string | null;
  started_at: string | null;
  ended_at: string | null;
  attendance: unknown;
  attendance_note: string | null;
  poll_results: unknown;
  poll_note: string | null;
  summary: unknown;
  summary_note: string | null;
  fetched_at: string;
};

const INSIGHTS_COLUMNS =
  "zoom_meeting_id,instance_uuid,started_at,ended_at,attendance,attendance_note,poll_results,poll_note,summary,summary_note,fetched_at";

function emptyInsights(state: InterviewZoomInsights["state"], note: string | null): InterviewZoomInsights {
  return {
    attendance: { data: null, note },
    endedAt: null,
    fetchedAt: null,
    polls: { data: null, note },
    startedAt: null,
    state,
    summary: { data: null, note },
  };
}

function fromRow(row: InsightsRow): InterviewZoomInsights {
  return {
    attendance: { data: Array.isArray(row.attendance) ? (row.attendance as InterviewAttendee[]) : null, note: row.attendance_note },
    endedAt: row.ended_at,
    fetchedAt: row.fetched_at,
    polls: { data: Array.isArray(row.poll_results) ? (row.poll_results as InterviewPollAnswer[]) : null, note: row.poll_note },
    startedAt: row.started_at,
    state: "ready",
    summary: {
      data: row.summary && typeof row.summary === "object" ? (row.summary as InterviewMeetingSummary) : null,
      note: row.summary_note,
    },
  };
}

const NOT_HELD_NOTE =
  "Zoom has no record of this meeting being held — nobody joined it, or Zoom is still writing its report (that can take a few minutes after the meeting ends).";
const NO_SUMMARY_NOTE = "Zoom has no AI summary for this meeting — AI Companion's meeting summary was not running in it.";

async function readFromZoom(config: ZoomConfig, meetingId: string): Promise<Omit<InsightsRow, "fetched_at">> {
  const row: Omit<InsightsRow, "fetched_at"> = {
    attendance: null,
    attendance_note: null,
    ended_at: null,
    instance_uuid: null,
    poll_note: null,
    poll_results: null,
    started_at: null,
    summary: null,
    summary_note: null,
    zoom_meeting_id: meetingId,
  };
  let past: Awaited<ReturnType<typeof getZoomPastMeeting>>;
  try {
    past = await getZoomPastMeeting(config, meetingId);
  } catch (error) {
    const note = `Zoom did not answer: ${errorText(error)}`;
    return { ...row, attendance_note: note, poll_note: note, summary_note: note };
  }
  if (!past) return { ...row, attendance_note: NOT_HELD_NOTE, poll_note: NOT_HELD_NOTE, summary_note: NOT_HELD_NOTE };
  row.instance_uuid = past.uuid;
  row.started_at = past.startTime;
  row.ended_at = past.endTime;

  // Each part stands alone: one Zoom refuses does not blank the others.
  const [attendance, polls, summary] = await Promise.allSettled([
    listZoomMeetingAttendance(config, past.uuid),
    listZoomPollAnswers(config, meetingId),
    getZoomMeetingSummary(config, past.uuid),
  ]);
  if (attendance.status === "fulfilled") {
    row.attendance = attendance.value;
    if (attendance.value.length === 0) row.attendance_note = "Zoom lists nobody who joined.";
  } else {
    row.attendance_note = `Zoom did not give the attendance: ${errorText(attendance.reason)}`;
  }
  if (polls.status === "fulfilled") {
    row.poll_results = polls.value;
    if (polls.value.length === 0) row.poll_note = "Nobody answered a poll in this meeting.";
  } else {
    row.poll_note = `Zoom did not give the poll answers: ${errorText(polls.reason)}`;
  }
  if (summary.status === "fulfilled") {
    row.summary = summary.value;
    if (!summary.value) row.summary_note = NO_SUMMARY_NOTE;
  } else {
    row.summary_note = `Zoom did not give the AI summary: ${errorText(summary.reason)}`;
  }
  return row;
}

/**
 * What Zoom reported for the meeting an interview was held on. Read from Zoom once the interview's
 * time is over, kept, and read again when the kept copy is older than fifteen minutes (Zoom finishes
 * its reports a little after a meeting ends) or when someone presses Refresh.
 */
export async function getInterviewZoomInsights(
  caller: InterviewCalendarCaller,
  target: InterviewMeetingTarget,
  options: { refresh?: boolean; zoomConfig?: ZoomConfig | null; now?: Date } = {},
): Promise<InterviewZoomInsights & { viaSession: boolean }> {
  const meeting = await resolveInterviewMeeting(caller, target);
  const now = options.now ?? new Date();
  const zoomConfig = options.zoomConfig === undefined ? readZoomConfig() : options.zoomConfig;
  if (meeting.platform !== "zoom" || !meeting.meetingId) {
    return { ...emptyInsights("no_meeting", "This interview has no Zoom meeting."), viaSession: meeting.viaSession };
  }
  if (now.getTime() < new Date(meeting.endsAt).getTime()) {
    return { ...emptyInsights("not_held", "Zoom reports on a meeting after it ends."), viaSession: meeting.viaSession };
  }

  const { data, error } = await recruitmentDb().from(INSIGHTS).select(INSIGHTS_COLUMNS).eq("zoom_meeting_id", meeting.meetingId).maybeSingle();
  if (error) throw error;
  const cached = (data as InsightsRow | null) ?? null;
  const age = cached ? now.getTime() - new Date(cached.fetched_at).getTime() : Number.POSITIVE_INFINITY;
  const stale = age >= INSIGHTS_FRESH_MS || (options.refresh === true && age >= INSIGHTS_REFRESH_FLOOR_MS);
  if (cached && !stale) return { ...fromRow(cached), viaSession: meeting.viaSession };
  if (!zoomConfig) {
    if (cached) return { ...fromRow(cached), viaSession: meeting.viaSession };
    return { ...emptyInsights("ready", "Zoom is not connected to Phoenix, so its reports cannot be read."), viaSession: meeting.viaSession };
  }

  const fresh = { ...(await readFromZoom(zoomConfig, meeting.meetingId)), fetched_at: now.toISOString() };
  const { error: saveError } = await recruitmentDb().from(INSIGHTS).upsert(fresh, { onConflict: "zoom_meeting_id" });
  if (saveError) console.warn("[interview-calendar] could not keep Zoom's report", saveError.message);
  return { ...fromRow(fresh), viaSession: meeting.viaSession };
}
