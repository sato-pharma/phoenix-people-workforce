// Recruitment — interview REQUESTS: the two-step "ask, then HR gives it a time" flow.
//
// The owner, 2026-09-23: a District Manager (and above) or HR asks for an interview by choosing a DAY
// (no time), choosing the interviewer (their line's NSM, or the HR head) and attaching CVs — each an
// existing Recruitment candidate, or an outside person with a CV. HR + the system admin get the
// request ("Mina Masoud sent 2 CVs for Tuesday"), phone the candidates, and give each CV a real time,
// which turns it into booked slots that show on BOTH the requester's and the interviewer's calendar.
//
// This sits BESIDE the direct booking in interview-calendar.ts — nothing there changes. Scheduling a
// request item calls `createInterviewBooking` with a `requestLink`, so a scheduled request is an
// ordinary booking that also remembers who asked for it (ats_interview_bookings.requested_by_hr_id),
// which is how the requester's own calendar picks it up (mayReadBooking).
//
// The tables (ats_interview_requests, ats_interview_request_items, migration 20260923163000) are
// service-role only, exactly like the rest of the calendar. This file is the lock for them: every
// entry point resolves the caller and checks a right before it touches a row.

import { canonicalHrIdKey, hrIdForStorage, hrIdLookupKeys } from "@/lib/hr-id";
import { afterResponse } from "@/lib/http/after-response";
import { detectCvFileKind } from "@/lib/recruitment/cv-file-kind";
import { recruitmentDb, textOrNull } from "@/lib/recruitment/db";
import { getRecruitmentFileStorage } from "@/lib/recruitment/file-storage";
import { type FileDownload, getFileForDownload, listCandidateFilesByCandidate } from "@/lib/recruitment/files";
import type { RecruitmentFile } from "@/lib/recruitment/types";
import {
  assertCvsOpenTo,
  checkCvUpload,
  createInterviewBooking,
  type InterviewCalendarCaller,
  isSignedInCaller,
  loadPeople,
  mayReadRequest,
  mayRequestInterviews,
  requireCalendarAccess,
} from "@/lib/recruitment/interview-calendar";
import { isBookableDay, isDateKey, weekStartFor } from "@/lib/recruitment/interview-calendar-week";
import {
  notifyInterviewRequestCreated,
  notifyInterviewRequestScheduled,
} from "@/lib/recruitment/interview-request-notifications";
import {
  type InterviewBooking,
  type InterviewRequest,
  type InterviewRequestItem,
  isDistrictManagerOrAbove,
  readsInterviewRequestInbox,
} from "@/lib/recruitment/interview-calendar-types";

const REQUESTS = "ats_interview_requests";
const ITEMS = "ats_interview_request_items";

const MAX_ITEMS_PER_REQUEST = 25;
const MAX_NOTE = 1000;

// ── Row shapes ────────────────────────────────────────────────────────────────────────────────────

type RequestRow = {
  id: string;
  requested_by_hr_id: string;
  interviewer_hr_id: string;
  requested_day: string;
  line: string | null;
  note: string | null;
  status: string;
  created_at: string;
  updated_at: string;
};

const REQUEST_COLUMNS =
  "id,requested_by_hr_id,interviewer_hr_id,requested_day,line,note,status,created_at,updated_at";

type ItemRow = {
  id: string;
  request_id: string;
  candidate_id: string | null;
  external_name: string | null;
  external_phone: string | null;
  external_email: string | null;
  external_cv_file_id: string | null;
  external_cv_file_name: string | null;
  external_cv_mime_type: string | null;
  booking_id: string | null;
  created_at: string;
};

const ITEM_COLUMNS =
  "id,request_id,candidate_id,external_name,external_phone,external_email,external_cv_file_id,external_cv_file_name,external_cv_mime_type,booking_id,created_at";

// ── Inputs ────────────────────────────────────────────────────────────────────────────────────────

/** A CV as uploaded on a request — the same shape a booking's CV takes. */
export type InterviewRequestCvUpload = { fileName: string; mimeType: string; bytes: Buffer; sizeBytes: number };

/** One CV a requester attaches: a Recruitment candidate, or an outside person (with an optional CV). */
export type InterviewRequestItemInput = {
  candidateId?: string | null;
  external?: { name: string; phone?: string | null; email?: string | null } | null;
  cv?: InterviewRequestCvUpload | null;
};

export type CreateInterviewRequestInput = {
  requestedDay: unknown;
  interviewerHrId: unknown;
  note?: unknown;
  line?: unknown;
  items: InterviewRequestItemInput[];
};

/** What HR sends to give one CV on a request a real time — the same fields a booking takes. */
export type ScheduleInterviewRequestItemInput = {
  requestId: string;
  itemId: string;
  dateKey: unknown;
  startMinutes: unknown;
  durationMinutes?: unknown;
  platform: unknown;
  sessionId?: unknown;
  notes?: unknown;
  /** The job this interview is for — a request names a line, never a role, so HR names it here. */
  jobTitle?: unknown;
};

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────────

const FORBIDDEN_REQUEST =
  "Forbidden: only District Managers and above, and HR, can request interviews.";
const FORBIDDEN_READ =
  "Forbidden: this interview request is not one you asked for or were chosen to conduct.";

/**
 * The interviewer a request names, checked against Employee Master: a District Manager or above only
 * (owner, 2026-09-20 — the same rule a direct booking's interviewer passes).
 */
async function requireRequestInterviewer(value: unknown): Promise<{ hrId: string; name: string }> {
  if (typeof value !== "string" || value.trim() === "") throw new Error("Choose who will conduct the interview.");
  const person = (await loadPeople([value.trim()])).get(canonicalHrIdKey(value) ?? "");
  if (!person) throw new Error("That interviewer is not in Employee Master.");
  if (!isDistrictManagerOrAbove({ jobTitle: person.jobTitle })) {
    throw new Error("Interviewers are District Managers and above — choose someone at that level.");
  }
  return { hrId: person.hrId, name: person.name };
}

type CandidateNameRow = { id: string; full_name: string | null; applied_for_job_title: string | null };

async function loadCandidates(ids: Iterable<string>): Promise<Map<string, CandidateNameRow>> {
  const list = Array.from(new Set(Array.from(ids).filter(Boolean)));
  const out = new Map<string, CandidateNameRow>();
  if (list.length === 0) return out;
  const { data, error } = await recruitmentDb()
    .from("ats_candidates")
    .select("id,full_name,applied_for_job_title")
    .in("id", list);
  if (error) throw error;
  for (const row of (data ?? []) as CandidateNameRow[]) out.set(String(row.id), row);
  return out;
}

function cleanNote(value: unknown): string | null {
  const text = textOrNull(value);
  if (!text) return null;
  return text.length > MAX_NOTE ? text.slice(0, MAX_NOTE) : text;
}

function cleanExternalName(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error("Give the person's name, or pick a candidate from Recruitment.");
  return text.replace(/\s+/g, " ").slice(0, 200);
}

// ── The CV on a request item ─────────────────────────────────────────────────────────────────────

/**
 * The file a request item's "View CV" opens. Files arrive newest first; the newest CV the preview can
 * DRAW wins, and failing that the newest CV of any kind — so the viewer's Download still works for a
 * format it cannot draw, instead of the item reading "no CV" over a CV that is sitting right there.
 */
function pickCandidateCv(files: readonly RecruitmentFile[] | undefined): RecruitmentFile | null {
  const cvs = (files ?? []).filter((file) => file.kind === "cv");
  return cvs.find((file) => detectCvFileKind(file.mimeType ?? "", file.fileName) !== "unsupported") ?? cvs[0] ?? null;
}

// ── Hydration ────────────────────────────────────────────────────────────────────────────────────

async function hydrateRequests(rows: readonly RequestRow[]): Promise<InterviewRequest[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const { data: itemData, error } = await recruitmentDb()
    .from(ITEMS)
    .select(ITEM_COLUMNS)
    .in("request_id", ids)
    .order("created_at", { ascending: true });
  if (error) throw error;
  const items = (itemData ?? []) as ItemRow[];

  const people = await loadPeople(rows.flatMap((row) => [row.requested_by_hr_id, row.interviewer_hr_id]));
  const candidateIds = items.map((item) => item.candidate_id).filter((id): id is string => Boolean(id));
  const candidates = await loadCandidates(candidateIds);
  // One chunked read for every candidate on the screen — never one per card.
  const candidateFiles = await listCandidateFilesByCandidate(candidateIds);

  const itemsByRequest = new Map<string, ItemRow[]>();
  for (const item of items) {
    const bucket = itemsByRequest.get(item.request_id) ?? [];
    bucket.push(item);
    itemsByRequest.set(item.request_id, bucket);
  }

  const nameOf = (hrId: string): string => people.get(canonicalHrIdKey(hrId) ?? "")?.name || hrId;

  return rows.map((row) => {
    const rowItems = itemsByRequest.get(row.id) ?? [];
    const hydratedItems: InterviewRequestItem[] = rowItems.map((item) => {
      const candidate = item.candidate_id ? candidates.get(item.candidate_id) : undefined;
      const external = !item.candidate_id;
      const candidateCv = item.candidate_id ? pickCandidateCv(candidateFiles.get(item.candidate_id)) : null;
      const externalCv = external && item.external_cv_file_id;
      return {
        cvFileName: candidateCv ? candidateCv.fileName : externalCv ? item.external_cv_file_name?.trim() || "CV" : null,
        cvMimeType: candidateCv ? candidateCv.mimeType : externalCv ? item.external_cv_mime_type ?? null : null,
        hasCv: Boolean(candidateCv) || Boolean(externalCv),
        id: item.id,
        booked: Boolean(item.booking_id),
        bookingId: item.booking_id,
        candidateId: item.candidate_id,
        candidateJobTitle: candidate?.applied_for_job_title?.trim() || null,
        candidateName: candidate?.full_name?.trim() || item.external_name?.trim() || "Unnamed candidate",
        external,
        externalCvFileName: external && item.external_cv_file_id ? item.external_cv_file_name?.trim() || "CV" : null,
        externalCvMimeType: external && item.external_cv_file_id ? item.external_cv_mime_type ?? null : null,
        externalEmail: external ? item.external_email?.trim() || null : null,
        externalHasCv: external && Boolean(item.external_cv_file_id),
        externalPhone: external ? item.external_phone?.trim() || null : null,
      };
    });
    return {
      createdAt: row.created_at,
      id: row.id,
      interviewerHrId: row.interviewer_hr_id,
      interviewerName: nameOf(row.interviewer_hr_id),
      items: hydratedItems,
      line: row.line?.trim() || null,
      note: row.note?.trim() || null,
      pendingItemCount: hydratedItems.filter((item) => !item.booked).length,
      requestedByHrId: row.requested_by_hr_id,
      requestedByName: nameOf(row.requested_by_hr_id),
      requestedDay: String(row.requested_day).slice(0, 10),
      status: row.status === "scheduled" || row.status === "cancelled" ? row.status : "pending",
      updatedAt: row.updated_at,
    };
  });
}

async function loadRequestRow(requestId: string): Promise<RequestRow> {
  const { data, error } = await recruitmentDb().from(REQUESTS).select(REQUEST_COLUMNS).eq("id", requestId).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("That interview request is no longer there.");
  return data as RequestRow;
}

/** Reload one request, hydrated for the screen — the internal path, after the caller is already gated. */
async function reloadRequest(requestId: string): Promise<InterviewRequest> {
  const [request] = await hydrateRequests([await loadRequestRow(requestId)]);
  return request;
}

/**
 * Read one request for a caller — the public path the GET route uses. A CV is PII, so this is gated the
 * same way a booking is (mayReadRequest): HR and the owners read any request; the own-only tier — a
 * requester or the chosen interviewer — reads only the requests they are part of.
 */
export async function getInterviewRequest(
  caller: InterviewCalendarCaller,
  requestId: string,
): Promise<InterviewRequest> {
  const row = await loadRequestRow(requestId);
  if (!mayReadRequest(caller, row)) throw new Error(FORBIDDEN_READ);
  const [request] = await hydrateRequests([row]);
  return request;
}

/**
 * The bytes of the CV on one request item — the door "View CV" on a request waiting for a time opens.
 *
 * THE CALENDAR'S OWN CV DOORS CANNOT SERVE THIS. They prove a candidate holds an INTERVIEW in a week
 * open to the caller, and a request that has not been given a time has no interview yet — so before this,
 * the inbox could say "CV attached" and nothing more, and HR could not open the CV they were about to
 * phone the candidate about. The proof here is the request's own: the caller may read THIS request
 * (HR and the owners any; a requester or the chosen interviewer only their own), the item must belong
 * to it, and a link holder who is not signed in opens it only when the link's CVs are on.
 */
export async function getInterviewRequestItemCv(
  caller: InterviewCalendarCaller,
  requestId: string,
  itemId: string,
): Promise<FileDownload | null> {
  requireCalendarAccess(caller, "view", "any");
  const request = await loadRequestRow(requestId);
  if (!mayReadRequest(caller, request)) throw new Error(FORBIDDEN_READ);
  assertCvsOpenTo(caller);

  const { data, error } = await recruitmentDb()
    .from(ITEMS)
    .select(ITEM_COLUMNS)
    .eq("id", itemId)
    .eq("request_id", requestId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("That CV is no longer on the request.");
  const item = data as ItemRow;

  if (item.candidate_id) {
    const file = pickCandidateCv((await listCandidateFilesByCandidate([item.candidate_id])).get(item.candidate_id));
    return file ? getFileForDownload(file.id) : null;
  }
  if (!item.external_cv_file_id) return null;
  const downloaded = await getRecruitmentFileStorage().downloadFile(item.external_cv_file_id);
  return {
    bytes: Buffer.from(downloaded.bytes),
    fileName: item.external_cv_file_name?.trim() || downloaded.fileName || "cv",
    kind: "binary",
    mimeType: item.external_cv_mime_type || downloaded.mimeType || "application/octet-stream",
  };
}

// ── Create (step 1) ──────────────────────────────────────────────────────────────────────────────

/**
 * A requester (a District Manager and above, or HR) asks for interviews on a DAY. No time is set — HR
 * gives each CV a time later. Returns the request, ready for the screen.
 */
export async function createInterviewRequest(
  caller: InterviewCalendarCaller,
  input: CreateInterviewRequestInput,
): Promise<InterviewRequest> {
  if (!(await mayRequestInterviews(caller.access))) throw new Error(FORBIDDEN_REQUEST);

  if (!isDateKey(input.requestedDay)) throw new Error("Choose the day for the interviews.");
  const day = input.requestedDay;
  if (!isBookableDay(day)) throw new Error("Interviews run Sunday to Thursday — choose one of those days.");

  const interviewer = await requireRequestInterviewer(input.interviewerHrId);

  const rawItems = Array.isArray(input.items) ? input.items : [];
  if (rawItems.length === 0) throw new Error("Attach at least one CV to the request.");
  if (rawItems.length > MAX_ITEMS_PER_REQUEST) throw new Error(`A request holds up to ${MAX_ITEMS_PER_REQUEST} CVs.`);

  // Resolve every item BEFORE writing anything, so a bad one fails the whole request cleanly.
  type Resolved =
    | { kind: "candidate"; candidateId: string }
    | {
        kind: "external";
        name: string;
        phone: string | null;
        email: string | null;
        cv: ReturnType<typeof checkCvUpload> | null;
      };
  const wantedCandidateIds = rawItems
    .map((item) => (typeof item.candidateId === "string" && item.candidateId.trim() ? item.candidateId.trim() : null))
    .filter((id): id is string => Boolean(id));
  const knownCandidates = await loadCandidates(wantedCandidateIds);

  const resolved: Resolved[] = rawItems.map((item) => {
    const candidateId = typeof item.candidateId === "string" && item.candidateId.trim() ? item.candidateId.trim() : null;
    if (candidateId) {
      if (!knownCandidates.has(candidateId)) throw new Error("One of the chosen candidates is no longer in Recruitment.");
      return { candidateId, kind: "candidate" };
    }
    if (!item.external) throw new Error("Each CV is a Recruitment candidate or an outside person — one of the two.");
    return {
      cv: item.cv ? checkCvUpload(item.cv) : null,
      email: textOrNull(item.external.email),
      kind: "external",
      name: cleanExternalName(item.external.name),
      phone: textOrNull(item.external.phone),
    };
  });

  const requestedBy = hrIdForStorage(caller.access.hrId);
  const { data: created, error: reqError } = await recruitmentDb()
    .from(REQUESTS)
    .insert({
      interviewer_hr_id: hrIdForStorage(interviewer.hrId),
      line: cleanNote(input.line),
      note: cleanNote(input.note),
      requested_by_hr_id: requestedBy,
      requested_day: day,
      status: "pending",
    })
    .select(REQUEST_COLUMNS)
    .single();
  if (reqError) throw reqError;
  const request = created as RequestRow;

  // Upload any CVs, then write the items. An upload that fails aborts before the item row is written;
  // items already written for earlier CVs stay on the (now partly built) request rather than being
  // rolled back — the requester sees what landed and can add the rest.
  const storage = getRecruitmentFileStorage();
  const itemRows: Record<string, unknown>[] = [];
  for (const item of resolved) {
    if (item.kind === "candidate") {
      itemRows.push({ candidate_id: item.candidateId, request_id: request.id });
      continue;
    }
    const row: Record<string, unknown> = {
      external_email: item.email,
      external_name: item.name,
      external_phone: item.phone,
      request_id: request.id,
    };
    if (item.cv) {
      if (!storage.supportsUpload) throw new Error("CV uploads are not switched on in Phoenix yet, so attach the person without the file.");
      const stored = await storage.uploadFile({ bytes: item.cv.bytes, fileName: item.cv.fileName, mimeType: item.cv.mimeType });
      if (!stored.driveFileId) throw new Error("A CV could not be stored — try the request again.");
      row.external_cv_file_id = stored.driveFileId;
      row.external_cv_file_name = item.cv.fileName;
      row.external_cv_mime_type = item.cv.mimeType;
    }
    itemRows.push(row);
  }

  const { error: itemError } = await recruitmentDb().from(ITEMS).insert(itemRows);
  if (itemError) throw itemError;

  const hydrated = await reloadRequest(request.id);
  // Tell HR + the system admin — "Mina Masoud sent 2 CVs for Tuesday". Best-effort: never throws, and it goes
  // out AFTER the reply (afterResponse) — the request is saved, and the fan-out was awaited before the answer.
  await afterResponse("interview_request_notice:created", () => notifyInterviewRequestCreated(hydrated));
  return hydrated;
}

// ── Queues (read) ────────────────────────────────────────────────────────────────────────────────

/**
 * Who may READ the waiting list: a caller with book rights on the calendar — HR and the owners — and
 * the Talent Acquisition seat, READ-ONLY (owner, 2026-10-18). That seat is a Viewer, so every other
 * door here — giving a CV its time, withdrawing someone else's request — still asks for book rights
 * and refuses her. Exported so the rule is run by a test, not only read from source.
 */
export function assertMayReadRequestInbox(caller: InterviewCalendarCaller): void {
  if (isSignedInCaller(caller.access) && readsInterviewRequestInbox(caller.access)) return;
  requireCalendarAccess(caller, "book", "any");
}

/**
 * The HR inbox: requests waiting for a time (and recently scheduled ones), soonest day first. Read
 * through `assertMayReadRequestInbox`: book rights, or the Talent Acquisition seat reading it.
 */
export async function listInterviewRequestsInbox(
  caller: InterviewCalendarCaller,
  options: { includeCancelled?: boolean } = {},
): Promise<InterviewRequest[]> {
  assertMayReadRequestInbox(caller);
  let query = recruitmentDb().from(REQUESTS).select(REQUEST_COLUMNS);
  if (!options.includeCancelled) query = query.neq("status", "cancelled");
  const { data, error } = await query.order("requested_day", { ascending: true }).order("created_at", { ascending: true });
  if (error) throw error;
  return hydrateRequests((data ?? []) as RequestRow[]);
}

/** A requester's own requests — the ones they asked for. */
export async function listMyInterviewRequests(caller: InterviewCalendarCaller): Promise<InterviewRequest[]> {
  if (!(await mayRequestInterviews(caller.access))) throw new Error(FORBIDDEN_REQUEST);
  const keys = hrIdLookupKeys(caller.access.hrId ?? "");
  if (keys.length === 0) return [];
  const { data, error } = await recruitmentDb()
    .from(REQUESTS)
    .select(REQUEST_COLUMNS)
    .in("requested_by_hr_id", keys)
    .order("requested_day", { ascending: false })
    .order("created_at", { ascending: false });
  if (error) throw error;
  return hydrateRequests((data ?? []) as RequestRow[]);
}

// ── Schedule (step 2) ──────────────────────────────────────────────────────────────────────────────

/**
 * HR gives one CV on a request a real time. It becomes an ordinary booking (with the request's chosen
 * interviewer and a link back to who asked), the item remembers its booking, and the request flips to
 * `scheduled` once at least one of its CVs has a time.
 */
export async function scheduleInterviewRequestItem(
  caller: InterviewCalendarCaller,
  input: ScheduleInterviewRequestItemInput,
): Promise<{ booking: InterviewBooking; request: InterviewRequest }> {
  const inSession = typeof input.sessionId === "string" && input.sessionId.trim() !== "";
  if (!inSession) {
    if (!isDateKey(input.dateKey)) throw new Error("Choose the day and time for the interview.");
    requireCalendarAccess(caller, "book", weekStartFor(input.dateKey));
  } else {
    requireCalendarAccess(caller, "book", "any");
  }

  const request = await loadRequestRow(input.requestId);
  if (request.status === "cancelled") throw new Error("That request was cancelled.");

  const { data: itemData, error: itemErr } = await recruitmentDb()
    .from(ITEMS)
    .select(ITEM_COLUMNS)
    .eq("id", input.itemId)
    .eq("request_id", input.requestId)
    .maybeSingle();
  if (itemErr) throw itemErr;
  if (!itemData) throw new Error("That CV is no longer on the request.");
  const item = itemData as ItemRow;
  if (item.booking_id) throw new Error("That CV already has a time — it is booked.");

  const raw: Record<string, unknown> = {
    dateKey: input.dateKey,
    durationMinutes: input.durationMinutes,
    interviewerHrId: request.interviewer_hr_id,
    jobTitle: input.jobTitle,
    notes: input.notes,
    platform: input.platform,
    sessionId: input.sessionId,
    startMinutes: input.startMinutes,
  };
  let externalCv: { fileId: string; fileName: string; mimeType: string | null } | null = null;
  if (item.candidate_id) {
    raw.candidateId = item.candidate_id;
  } else {
    raw.external = { email: item.external_email, name: item.external_name ?? "", phone: item.external_phone };
    raw.addToRecruitment = false; // keep them on the request/booking; HR chose not to add them to Recruitment
    if (item.external_cv_file_id) {
      externalCv = {
        fileId: item.external_cv_file_id,
        fileName: item.external_cv_file_name?.trim() || "CV",
        mimeType: item.external_cv_mime_type ?? null,
      };
    }
  }

  const { booking } = await createInterviewBooking(caller, raw, {
    externalCv,
    requestLink: { requestId: request.id, requestedByHrId: request.requested_by_hr_id },
  });

  const { error: linkErr } = await recruitmentDb().from(ITEMS).update({ booking_id: booking.id }).eq("id", item.id);
  if (linkErr) throw linkErr;

  if (request.status !== "scheduled") {
    await recruitmentDb().from(REQUESTS).update({ status: "scheduled", updated_at: new Date().toISOString() }).eq("id", request.id);
  }

  const updated = await reloadRequest(request.id);
  // Tell the requester their interview is booked, and the interviewer they have one to conduct. The
  // reminder job (interview-reminders.ts) then nags the interviewer until an outcome is recorded. After the
  // reply (afterResponse): the booking is saved, and both notices swallow their own failures.
  await afterResponse("interview_request_notice:scheduled", () => notifyInterviewRequestScheduled(updated, booking));
  return { booking, request: updated };
}

// ── Cancel ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Withdraw a request while it is still waiting. The requester (their own request) or a caller with
 * book rights may cancel; once any CV has a time, the interviews themselves are cancelled instead.
 */
export async function cancelInterviewRequest(caller: InterviewCalendarCaller, requestId: string): Promise<InterviewRequest> {
  const request = await loadRequestRow(requestId);

  const canBook = (() => {
    try {
      requireCalendarAccess(caller, "book", "any");
      return true;
    } catch {
      return false;
    }
  })();
  const mine = Boolean(caller.access.hrId) && canonicalHrIdKey(caller.access.hrId) === canonicalHrIdKey(request.requested_by_hr_id);
  if (!canBook && !mine) throw new Error("Forbidden: this is not your request to cancel.");

  if (request.status === "cancelled") return reloadRequest(request.id);

  const { data: bookedData, error: bookedErr } = await recruitmentDb()
    .from(ITEMS)
    .select("id")
    .eq("request_id", request.id)
    .not("booking_id", "is", null)
    .limit(1);
  if (bookedErr) throw bookedErr;
  if ((bookedData ?? []).length > 0) {
    throw new Error("Some CVs on this request already have times — cancel those interviews instead.");
  }

  const { error } = await recruitmentDb()
    .from(REQUESTS)
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .eq("id", request.id);
  if (error) throw error;
  return reloadRequest(request.id);
}
