import { isIsoDay } from "@/lib/phoenix-crm/calendar";
import { readTestFlag, territoryForDayWrite, territoryForRead, territoryForView, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { textOrNull, throwIfError } from "@/lib/phoenix-crm/server/db";
import { notFoundError, validationError } from "@/lib/http/api-errors";
import { listInterviewsConductedBy, type ConductedInterview } from "@/lib/recruitment/interview-calendar";
import { addDays, cairoLocalToUtc } from "@/lib/recruitment/interview-calendar-week";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * Phoenix CRM — the interviews on an Interviews day (owner, 2026-10-29: "if interviews attach the cvs
 * and scheduled time", and "Both").
 *
 * An Interviews day carries the interviews themselves, each with the candidate's name, the time and the
 * CV, from two places:
 *
 *   - the ones already BOOKED in the hiring calendar for that person and day — read live while the day
 *     is being recorded, and copied (source `calendar`) the moment it is saved, so a later edit of the
 *     calendar never rewrites what the day recorded. Their CV is the calendar's own guarded link: this
 *     module never copies or re-serves a candidate's CV, and the calendar's door decides who opens it.
 *   - the ones the person ADDS by hand (source `added`), with the CV uploaded into this module's own
 *     private bucket and opened through a ten-minute signed link.
 *
 * A RECORD ONLY, like the day activity it belongs to (2026-09-26): nothing here is read by a report
 * function and nothing here moves a figure. This is the ONE file that opens the CV bucket.
 */

export const PHOENIX_CRM_INTERVIEW_CV_BUCKET = "phoenix-crm-interview-cvs";

/** The hiring calendar's own CV limit, so a CV the calendar takes is never refused here. */
export const DAY_INTERVIEW_CV_MAX_BYTES = 10 * 1024 * 1024;

const SIGNED_URL_SECONDS = 600;

const CV_TYPES: Readonly<Record<string, string>> = {
  "application/pdf": ".pdf",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

/** By extension, for the phone that sends a CV with no type at all. */
const CV_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

type Row = Record<string, unknown>;

export type DayInterview = {
  /** The stored row's id; null on a booked interview read live and not saved yet. */
  id: string | null;
  source: "calendar" | "added";
  candidateName: string;
  /** The instant, as stored. */
  scheduledAt: string;
  durationMinutes: number | null;
  /** The uploaded CV's own name; null on a booked interview. */
  cvFileName: string | null;
  /** Where the CV opens — the calendar's own door, or this module's signed link; null when there is none. */
  cvUrl: string | null;
};

const COLUMNS = "id, source, candidate_name, scheduled_at, duration_minutes, calendar_cv_url, cv_file_name, is_test";

function mapRow(row: Row): DayInterview | null {
  const id = textOrNull(row.id);
  const scheduledAt = textOrNull(row.scheduled_at);
  const candidateName = textOrNull(row.candidate_name);
  if (!id || !scheduledAt || !candidateName) return null;
  const source = row.source === "added" ? "added" : "calendar";
  const duration = Number(row.duration_minutes);
  return {
    id,
    source,
    candidateName,
    scheduledAt,
    durationMinutes: Number.isFinite(duration) && duration > 0 ? duration : null,
    cvFileName: textOrNull(row.cv_file_name),
    cvUrl:
      source === "added"
        ? `/api/phoenix-crm/day-interviews/cv?id=${encodeURIComponent(id)}${row.is_test === true ? "&test=true" : ""}`
        : textOrNull(row.calendar_cv_url),
  };
}

function fromCalendar(interview: ConductedInterview): DayInterview {
  return {
    id: null,
    source: "calendar",
    candidateName: interview.candidateName,
    scheduledAt: interview.startsAt,
    durationMinutes: interview.durationMinutes > 0 ? interview.durationMinutes : null,
    cvFileName: null,
    cvUrl: interview.cvUrl,
  };
}

function byTime(a: DayInterview, b: DayInterview): number {
  return a.scheduledAt.localeCompare(b.scheduledAt) || a.candidateName.localeCompare(b.candidateName);
}

/** The interviews a person conducts on one Cairo day, read live from the hiring calendar. */
async function bookedOn(hrId: string | null | undefined, date: string): Promise<ConductedInterview[]> {
  if (!hrId) return [];
  return listInterviewsConductedBy(hrId, cairoLocalToUtc(date, 0), cairoLocalToUtc(addDays(date, 1), 0));
}

async function storedOn(seatId: string, isTest: boolean, date: string, source?: "calendar" | "added"): Promise<DayInterview[]> {
  let query = getSupabaseAdmin()
    .from("phoenix_crm_day_interviews")
    .select(COLUMNS)
    .eq("seat_id", seatId)
    .eq("is_test", isTest)
    .eq("activity_date", date);
  if (source) query = query.eq("source", source);
  const { data, error } = await query;
  throwIfError(error);
  return ((data ?? []) as Row[]).flatMap((row) => mapRow(row) ?? []).sort(byTime);
}

/**
 * The interviews on a day.
 *
 * With no `date`, it is the viewer's OWN day being recorded (the Interviews entry): the interviews
 * booked for him in the hiring calendar today, read live, beside the ones he has added. With a `date`,
 * it is a recorded day being read — by him or by anyone who reads the territory — and it is what was
 * saved, exactly.
 */
export async function loadDayInterviews(
  viewer: PhoenixCrmViewer,
  raw: { seatId: unknown; test: unknown; date?: unknown },
): Promise<{ date: string; booked: DayInterview[]; added: DayInterview[]; saved: DayInterview[] }> {
  if (isIsoDay(raw.date)) {
    const { seat, isTest } = territoryForView(viewer, raw.seatId, readTestFlag(raw.test));
    return { date: raw.date, booked: [], added: [], saved: await storedOn(seat.seatId, isTest, raw.date) };
  }
  const { seat, isTest } = territoryForDayWrite(viewer, raw.seatId, readTestFlag(raw.test));
  const date = viewer.visitDay;
  const [booked, added] = await Promise.all([bookedOn(seat.occupantHrId, date), storedOn(seat.seatId, isTest, date, "added")]);
  return { date, booked: booked.map(fromCalendar).sort(byTime), added, saved: [] };
}

function cvTypeOf(file: File): string | null {
  const declared = file.type.trim().toLowerCase();
  if (CV_TYPES[declared]) return declared;
  const dot = file.name.lastIndexOf(".");
  return dot >= 0 ? (CV_TYPE_BY_EXTENSION[file.name.slice(dot).toLowerCase()] ?? null) : null;
}

/** "14:30" → minutes after midnight, or null. */
function minutesOf(value: unknown): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value ?? "").trim());
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function storageSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_");
}

/**
 * Add one interview by hand to today's Interviews day: the candidate's name, the time and the CV, all
 * three required. Today only — the date is the viewer's visit day, never taken from the form, exactly
 * like the day activity itself.
 */
export async function addDayInterview(viewer: PhoenixCrmViewer, form: FormData): Promise<DayInterview> {
  const { seat, isTest } = territoryForDayWrite(viewer, form.get("seatId"), readTestFlag(form.get("test")));
  const date = viewer.visitDay;

  const candidateName = String(form.get("candidateName") ?? "").replace(/\s+/g, " ").trim();
  if (candidateName.length < 2 || candidateName.length > 200) throw validationError("Write the candidate's name.");
  const minutes = minutesOf(form.get("time"));
  if (minutes === null) throw validationError("Choose the time of the interview.");
  const file = form.get("cv");
  if (!(file instanceof File) || file.size === 0) throw validationError("Attach the candidate's CV.");
  if (file.size > DAY_INTERVIEW_CV_MAX_BYTES) throw validationError("The CV is larger than 10 MB. Attach a smaller file.");
  const mimeType = cvTypeOf(file);
  if (!mimeType) throw validationError("Attach the CV as a PDF, a Word file or a photo.");
  const fileName = (file.name || `CV${CV_TYPES[mimeType]}`).slice(-200);

  const [year, month] = date.split("-");
  const path = `${isTest ? "test/" : ""}${storageSegment(seat.seatId)}/${year}/${month}/${crypto.randomUUID()}${CV_TYPES[mimeType]}`;
  const bucket = getSupabaseAdmin().storage.from(PHOENIX_CRM_INTERVIEW_CV_BUCKET);
  const { error: uploadError } = await bucket.upload(path, Buffer.from(await file.arrayBuffer()), { contentType: mimeType, upsert: false });
  throwIfError(uploadError);

  const { data, error } = await getSupabaseAdmin()
    .from("phoenix_crm_day_interviews")
    .insert({
      activity_date: date,
      candidate_name: candidateName,
      created_by_hr_id: viewer.hrId,
      cv_file_name: fileName,
      cv_mime_type: mimeType,
      cv_path: path,
      is_test: isTest,
      person_hr_id: seat.occupantHrId ?? null,
      scheduled_at: cairoLocalToUtc(date, minutes).toISOString(),
      seat_id: seat.seatId,
      source: "added",
    })
    .select(COLUMNS)
    .single();
  if (error) {
    // The row is the only way to reach the file, so a file without one is removed at once.
    await getSupabaseAdmin().storage.from(PHOENIX_CRM_INTERVIEW_CV_BUCKET).remove([path]);
    throwIfError(error);
  }
  const added = mapRow(data as Row);
  if (!added) throw new Error("The added interview could not be read back.");
  return added;
}

/** Remove one interview added by hand to today's day, with its CV. A booked one is the calendar's to change. */
export async function removeDayInterview(viewer: PhoenixCrmViewer, raw: { id?: unknown; seatId: unknown; test: unknown }): Promise<{ id: string }> {
  const { seat, isTest } = territoryForDayWrite(viewer, raw.seatId, readTestFlag(raw.test));
  const id = textOrNull(raw.id);
  if (!id) throw validationError("Choose the interview to remove.");
  const { data, error } = await getSupabaseAdmin()
    .from("phoenix_crm_day_interviews")
    .select("id, cv_path")
    .eq("id", id)
    .eq("seat_id", seat.seatId)
    .eq("is_test", isTest)
    .eq("activity_date", viewer.visitDay)
    .eq("source", "added")
    .maybeSingle();
  throwIfError(error);
  if (!data) throw notFoundError("That interview is not on today's record.");
  const { error: deleteError } = await getSupabaseAdmin().from("phoenix_crm_day_interviews").delete().eq("id", id);
  throwIfError(deleteError);
  const path = textOrNull((data as Row).cv_path);
  if (path) await getSupabaseAdmin().storage.from(PHOENIX_CRM_INTERVIEW_CV_BUCKET).remove([path]);
  return { id };
}

/** A ten-minute link to an added interview's CV, for anyone who reads that territory. */
export async function signedDayInterviewCvUrl(viewer: PhoenixCrmViewer, raw: { id: unknown; test: unknown }): Promise<string> {
  const id = textOrNull(raw.id);
  if (!id) throw notFoundError("That CV is not on record.");
  const { data, error } = await getSupabaseAdmin()
    .from("phoenix_crm_day_interviews")
    .select("seat_id, is_test, cv_path")
    .eq("id", id)
    .maybeSingle();
  throwIfError(error);
  const row = data as Row | null;
  const path = textOrNull(row?.cv_path);
  if (!row || !path) throw notFoundError("That CV is not on record.");
  // The row's own world must be the one asked for; territoryForRead then decides the territory.
  // A test account also opens a real day's CV, the days it now reads (owner, 2026-11-09).
  const rowIsTest = row.is_test === true;
  if (rowIsTest !== readTestFlag(raw.test) && !(viewer.isTestPersona && !rowIsTest)) throw notFoundError("That CV is not on record.");
  territoryForRead(viewer, row.seat_id, row.is_test === true);
  const { data: signed, error: signError } = await getSupabaseAdmin()
    .storage.from(PHOENIX_CRM_INTERVIEW_CV_BUCKET)
    .createSignedUrl(path, SIGNED_URL_SECONDS);
  throwIfError(signError);
  if (!signed?.signedUrl) throw notFoundError("That CV is not on record.");
  return signed.signedUrl;
}

/**
 * Before an Interviews day is saved: the interviews it will carry. Refused when there are none — an
 * Interviews day lists its interviews (owner, 2026-10-29).
 */
export async function interviewsForDaySave(
  seat: { seatId: string; occupantHrId?: string | null },
  isTest: boolean,
  date: string,
): Promise<ConductedInterview[]> {
  const [booked, added] = await Promise.all([bookedOn(seat.occupantHrId, date), storedOn(seat.seatId, isTest, date, "added")]);
  if (booked.length + added.length === 0) {
    throw validationError(
      "An Interviews day lists its interviews, and none is booked for you in the hiring calendar today. Open Add visit, choose Interviews, and add each one with its time and CV.",
      "interviews_required",
    );
  }
  return booked;
}

/** Once an Interviews day is saved: its booked interviews, copied as they stand now. */
export async function snapshotBookedInterviews(
  seat: { seatId: string; occupantHrId?: string | null },
  isTest: boolean,
  date: string,
  booked: readonly ConductedInterview[],
  actorHrId: string,
): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { error: clearError } = await supabase
    .from("phoenix_crm_day_interviews")
    .delete()
    .eq("seat_id", seat.seatId)
    .eq("is_test", isTest)
    .eq("activity_date", date)
    .eq("source", "calendar");
  throwIfError(clearError);
  if (booked.length === 0) return;
  const { error } = await supabase.from("phoenix_crm_day_interviews").insert(
    booked.map((interview) => ({
      activity_date: date,
      booking_id: interview.bookingId,
      calendar_cv_url: interview.cvUrl,
      candidate_name: interview.candidateName.slice(0, 200) || "A candidate",
      created_by_hr_id: actorHrId,
      duration_minutes: interview.durationMinutes > 0 ? Math.min(interview.durationMinutes, 1440) : null,
      is_test: isTest,
      person_hr_id: seat.occupantHrId ?? null,
      scheduled_at: interview.startsAt,
      seat_id: seat.seatId,
      source: "calendar",
    })),
  );
  throwIfError(error);
}

/** The day is cleared or recorded as something else: its interviews go, and the CVs added by hand with them. */
export async function dropDayInterviews(seatId: string, isTest: boolean, date: string): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("phoenix_crm_day_interviews")
    .select("id, cv_path")
    .eq("seat_id", seatId)
    .eq("is_test", isTest)
    .eq("activity_date", date);
  throwIfError(error);
  const rows = (data ?? []) as Row[];
  if (rows.length === 0) return;
  const { error: deleteError } = await supabase
    .from("phoenix_crm_day_interviews")
    .delete()
    .eq("seat_id", seatId)
    .eq("is_test", isTest)
    .eq("activity_date", date);
  throwIfError(deleteError);
  const paths = rows.flatMap((row) => textOrNull(row.cv_path) ?? []);
  if (paths.length > 0) await supabase.storage.from(PHOENIX_CRM_INTERVIEW_CV_BUCKET).remove(paths);
}
