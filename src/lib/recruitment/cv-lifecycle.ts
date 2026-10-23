// Recruitment / ATS — the full life of one CV, from reaching Phoenix to sitting in the owner's
// Google Drive, as the rows behind his live Google Sheet (owner request, 2026-09-04).
//
// WHAT HE ASKED FOR, IN HIS WORDS: "confirm that this is received on the system and ... received on
// Google Drive. And when did each folder receive it ... the fully life cycle of the CV starting
// from the candidate sending it to us" — plus, a moment later, "a dashboard that clearly shows
// every day how many CVs I received through which channels."
//
// So this module produces exactly two things, and the sheet renders them as two tabs:
//   * the LIFECYCLE table — one row per CV, every stage stamped in Cairo local time
//   * the DAILY table     — one row per Cairo day, one column per channel, ready to chart
//
// ─────────────────────────────────────────────────────────────────────────────
// THE HONEST LIMIT, STATED ONCE AND CARRIED INTO THE COLUMN NAMES.
//
// Phoenix does not know when the candidate pressed send. Meta's webhook carries a per-message
// timestamp; the intake queue's payload does not keep it (measured 2026-09-04: all 791 queued
// WhatsApp rows carry the same 14 keys, none of them a time). The earliest instant this system can
// prove is when the webhook ARRIVED — normally seconds later, but that is a proxy and not the
// thing itself.
//
// Every column here is therefore named for what it actually is: "Reached Phoenix", never "Sent".
// The row also publishes `timingSource` so the reader can see whether that stamp came from the
// queue (exact), from the intake event (a poll cycle later, up to ~10 minutes on email) or from the
// saved file itself (a hand upload, where nothing earlier exists). A sheet that quietly presented
// all three as one number would be the confidently-wrong answer this report exists to replace.
// ─────────────────────────────────────────────────────────────────────────────

import { csvCell } from "@/lib/export/csv-cell";
import { cairoDateTimeSortable } from "@/lib/format/cairo-datetime";
import { isUuid } from "@/lib/http/uuid";
import { cairoDayKey } from "@/lib/recruitment/candidate-stats";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * The view does the four-way join; see 20260905011500_cv_lifecycle_view_and_share_links.sql, and
 * 20260917190000_cv_lifecycle_view_exact_key_queue_join.sql for why it is written the way it is.
 */
const VIEW = "ats_v_cv_lifecycle";

/**
 * Rows per PostgREST request.
 *
 * NOT cosmetic. An unbounded `.select()` on this project stops at 1000 rows with no marker and no
 * error, and there are already 979 CVs — so the next few weeks would have silently truncated the
 * owner's report at exactly the point it started mattering. Paging with an explicit `.order()` is
 * the shape that survives; 500 keeps each response small enough to stay well inside the route's
 * time budget.
 */
const PAGE_SIZE = 500;

/** Hard stop, so a mistake here can never become an unbounded loop against production. */
const MAX_PAGES = 200;

export type CvLifecycleChannel = "whatsapp" | "email" | "upload";

/** How precise `reachedPhoenixAt` is. See the header — this is published, never inferred. */
export type CvLifecycleTimingSource = "queued" | "processed" | "saved";

export type CvLifecycleRow = {
  appliedForJobTitle: string | null;
  candidateId: string | null;
  candidateName: string | null;
  candidatePhone: string | null;
  candidateStatus: string | null;
  channel: CvLifecycleChannel;
  driveError: string | null;
  driveFileId: string | null;
  driveFolder: string | null;
  fileId: string;
  fileName: string | null;
  folderFiledAt: string | null;
  folderKey: string | null;
  folderKind: string | null;
  mailboxLabel: string | null;
  mimeType: string | null;
  preferencesDeclaredAt: string | null;
  preferredAreaName: string | null;
  preferredRegionCode: string | null;
  queueAttempts: number | null;
  queueLastError: string | null;
  queueStatus: string | null;
  reachedPhoenixAt: string | null;
  savedInDriveAt: string | null;
  savedInPhoenixAt: string | null;
  senderDisplayName: string | null;
  sizeBytes: number | null;
  timingSource: CvLifecycleTimingSource;

  // ── The candidate themself. ──
  //
  // Everything below arrived with the 2026-09-05 view widening and is used ONLY by the `#DETAIL`
  // section. The `#LIFECYCLE` section deliberately does not print any of it: that table answers
  // "did this file make it through the pipeline", and it already has 26 columns.
  //
  // Every one of these was already in `ats_candidates` and simply never selected. The old view
  // exposed the DECLARED area, which only 12% of candidates ever answered, so the owner's sheet
  // showed an Area column that was blank seven times in eight while `governorate` — filled for 76%
  // — sat one join away. Reporting "we do not know" when the answer is on the row is the defect
  // this block exists to close.
  candidateAddress: string | null;
  candidateCreatedAt: string | null;
  candidateEmail: string | null;
  candidateSource: string | null;
  candidateStatusNote: string | null;
  currentEmployer: string | null;
  currentJobTitle: string | null;
  cvCertifications: string | null;
  cvEducation: string | null;
  cvLanguages: string | null;
  cvSkills: string | null;
  cvWorkHistory: string | null;
  dateOfBirth: string | null;
  declaredBackground: string | null;
  declaredExpectedSalary: string | null;
  declaredExperience: string | null;
  degree: string | null;
  expectedSalary: string | null;
  faculty: string | null;
  gender: string | null;
  governorate: string | null;
  grade: string | null;
  graduationYear: number | null;
  hasMedicalRepExperience: boolean | null;
  hasPriorWorkExperience: boolean | null;
  linkedinUrl: string | null;
  managerNotifiedAt: string | null;
  managerNotifiedName: string | null;
  maritalStatus: string | null;
  medicalRepEmployer: string | null;
  militaryStatus: string | null;
  nationality: string | null;
  noticePeriod: string | null;
  preferredRegionName: string | null;
  professionalSummary: string | null;
  screeningAgeBand: string | null;
  screeningBookingExperience: string | null;
  screeningCommute: string | null;
  screeningEnglishLevel: string | null;
  screeningMsOffice: string | null;
  screeningStartDate: string | null;
  sentForArea: string | null;
  sentForJobTitle: string | null;
  sentForLine: string | null;
  sentForRegion: string | null;
  university: string | null;
  yearsExperience: number | null;
};

type RawRow = Record<string, unknown>;

function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed === "" ? null : trimmed;
}

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * A date-only column, printed as a date and nothing else.
 *
 * `date_of_birth` is a Postgres `date`, so it arrives as "1997-04-11" and `new Date` reads that as
 * UTC MIDNIGHT. Put through the Cairo datetime formatter it printed "1997-04-11 02:00" — a time
 * nobody was born at, invented entirely by the +02:00 offset. This repo's own trap notes say it
 * plainly: a date-only column is not an instant, and formatting it in a timezone is the bug rather
 * than the fix. Egypt's offset is positive so the calendar day happened to survive; at a negative
 * offset the same code would have printed the day before somebody's birthday.
 */
function dateOnly(value: string | null): string {
  if (!value) return "";
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
  return match ? match[1]! : "";
}

/**
 * Tri-state, deliberately. `false` and "we never asked" are different answers about a candidate and
 * `num`/`text` would flatten both to null — which on "has medical-rep experience" would turn 87% of
 * a real answer set into blanks.
 */
function bool(value: unknown): boolean | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "boolean") return value;
  const raw = String(value).trim().toLowerCase();
  if (raw === "true" || raw === "t" || raw === "yes" || raw === "1") return true;
  if (raw === "false" || raw === "f" || raw === "no" || raw === "0") return false;
  return null;
}

function channelOf(value: unknown): CvLifecycleChannel {
  const raw = String(value ?? "").toLowerCase();
  if (raw === "whatsapp" || raw === "email") return raw;
  // Anything the view could not attribute is a hand upload. Deliberately a fallback rather than a
  // throw: a new intake channel must show up in the report as an unfamiliar row, never crash it.
  return "upload";
}

function timingSourceOf(value: unknown): CvLifecycleTimingSource {
  const raw = String(value ?? "").toLowerCase();
  return raw === "queued" || raw === "processed" ? raw : "saved";
}

function mapRow(row: RawRow): CvLifecycleRow {
  return {
    appliedForJobTitle: text(row.applied_for_job_title),
    candidateId: text(row.candidate_id),
    candidateName: text(row.candidate_name),
    candidatePhone: text(row.candidate_phone),
    candidateStatus: text(row.candidate_status),
    channel: channelOf(row.channel),
    driveError: text(row.drive_error),
    driveFileId: text(row.drive_file_id),
    driveFolder: text(row.drive_folder),
    fileId: String(row.file_id ?? ""),
    fileName: text(row.file_name),
    folderFiledAt: text(row.folder_filed_at),
    folderKey: text(row.folder_key),
    folderKind: text(row.folder_kind),
    mailboxLabel: text(row.mailbox_label),
    mimeType: text(row.mime_type),
    preferencesDeclaredAt: text(row.preferences_declared_at),
    preferredAreaName: text(row.preferred_area_name),
    preferredRegionCode: text(row.preferred_region_code),
    queueAttempts: num(row.queue_attempts),
    queueLastError: text(row.queue_last_error),
    queueStatus: text(row.queue_status),
    reachedPhoenixAt: text(row.reached_phoenix_at),
    savedInDriveAt: text(row.saved_in_drive_at),
    savedInPhoenixAt: text(row.saved_in_phoenix_at),
    senderDisplayName: text(row.sender_display_name),
    sizeBytes: num(row.size_bytes),
    timingSource: timingSourceOf(row.timing_source),

    candidateAddress: text(row.candidate_address),
    candidateCreatedAt: text(row.candidate_created_at),
    candidateEmail: text(row.candidate_email),
    candidateSource: text(row.candidate_source),
    candidateStatusNote: text(row.candidate_status_note),
    currentEmployer: text(row.current_employer),
    currentJobTitle: text(row.current_job_title),
    cvCertifications: text(row.cv_certifications),
    cvEducation: text(row.cv_education),
    cvLanguages: text(row.cv_languages),
    cvSkills: text(row.cv_skills),
    cvWorkHistory: text(row.cv_work_history),
    dateOfBirth: text(row.date_of_birth),
    declaredBackground: text(row.declared_background),
    declaredExpectedSalary: text(row.declared_expected_salary),
    declaredExperience: text(row.declared_experience),
    degree: text(row.degree),
    expectedSalary: text(row.expected_salary),
    faculty: text(row.faculty),
    gender: text(row.gender),
    governorate: text(row.governorate),
    grade: text(row.grade),
    graduationYear: num(row.graduation_year),
    hasMedicalRepExperience: bool(row.has_medical_rep_experience),
    hasPriorWorkExperience: bool(row.has_prior_work_experience),
    linkedinUrl: text(row.linkedin_url),
    managerNotifiedAt: text(row.manager_notified_at),
    managerNotifiedName: text(row.manager_notified_name),
    maritalStatus: text(row.marital_status),
    medicalRepEmployer: text(row.medical_rep_employer),
    militaryStatus: text(row.military_status),
    nationality: text(row.nationality),
    noticePeriod: text(row.notice_period),
    preferredRegionName: text(row.preferred_region_name),
    professionalSummary: text(row.professional_summary),
    screeningAgeBand: text(row.screening_age_band),
    screeningBookingExperience: text(row.screening_booking_experience),
    screeningCommute: text(row.screening_commute),
    screeningEnglishLevel: text(row.screening_english_level),
    screeningMsOffice: text(row.screening_ms_office),
    screeningStartDate: text(row.screening_start_date),
    sentForArea: text(row.sent_for_area),
    sentForJobTitle: text(row.sent_for_job_title),
    sentForLine: text(row.sent_for_line),
    sentForRegion: text(row.sent_for_region),
    university: text(row.university),
    yearsExperience: num(row.years_experience),
  };
}

/** The last row of a page: where the next page starts, in the feed's own total order. */
export type CvLifecycleCursor = { fileId: string; savedInPhoenixAt: string };

// What PostgREST hands back for a timestamptz and a uuid. Anything else in a cursor means the view
// changed shape under us, and splicing an unexpected string into a filter is how a page silently
// matches nothing — so it throws instead.
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}(:\d{2})?|Z)$/;

/**
 * The PostgREST `or` filter for "every row AFTER this cursor" under
 * `ORDER BY saved_in_phoenix_at DESC, file_id DESC`:
 *
 *   saved_in_phoenix_at < T  OR  (saved_in_phoenix_at = T AND file_id < F)
 *
 * The second leg is not optional. Every file saved in one transaction shares `now()`, so a batch
 * import stamps many CVs with the SAME instant; a plain `saved_in_phoenix_at < T` would skip the
 * rest of that batch the moment it straddled a page boundary.
 *
 * Values are double-quoted because a timestamp carries `.` and `:`, both reserved inside a
 * PostgREST logic tree. The timestamp goes back exactly as PostgREST sent it — microseconds and
 * offset intact — so the equality leg compares the stored instant, not a millisecond-rounded copy
 * (a JavaScript `Date` would round, and then drop or repeat a row at that boundary).
 */
export function cvLifecycleRowsAfter(cursor: CvLifecycleCursor): string {
  const savedAt = cursor.savedInPhoenixAt.trim();
  const fileId = cursor.fileId.trim();
  if (!TIMESTAMP_RE.test(savedAt)) throw new Error(`CV lifecycle cursor has an unexpected timestamp: ${savedAt}`);
  if (!isUuid(fileId)) throw new Error(`CV lifecycle cursor has an unexpected file id: ${fileId}`);
  return `saved_in_phoenix_at.lt."${savedAt}",and(saved_in_phoenix_at.eq."${savedAt}",file_id.lt."${fileId}")`;
}

/**
 * Every CV, newest first.
 *
 * Ordered by `saved_in_phoenix_at` and NOT by the arrival stamp, deliberately: `saved_in_phoenix_at`
 * is the one column in the view that is never null, and paging on a nullable sort key is how rows
 * go missing between pages. `file_id` breaks ties so the order is total — without it two CVs saved
 * in the same millisecond can appear on two consecutive pages, or on neither.
 *
 * PAGED BY CURSOR, NOT BY OFFSET (2026-09-17). An OFFSET page makes the database build, sort and
 * throw away every row before it, so the third page computed all 1,429 rows to return 429 — and
 * the cost grew with the square of the CV count. Measured on production this read was 11.5% of
 * all database time. A cursor page filters on the sort key instead (pushed down to `ats_files`),
 * so each page does the work for its own rows only. The rows and their order are the same; the one
 * difference is an improvement: a CV arriving mid-read can no longer push an older row onto the
 * next page and print it twice.
 */
export async function loadCvLifecycle(): Promise<CvLifecycleRow[]> {
  const supabase = getSupabaseAdmin();
  const rows: CvLifecycleRow[] = [];
  let cursor: CvLifecycleCursor | null = null;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    let query = supabase
      .from(VIEW)
      .select("*")
      .order("saved_in_phoenix_at", { ascending: false })
      .order("file_id", { ascending: false })
      .limit(PAGE_SIZE);
    if (cursor) query = query.or(cvLifecycleRowsAfter(cursor));

    const { data, error } = await query;
    if (error) throw error;

    const batch = (data ?? []) as RawRow[];
    for (const row of batch) rows.push(mapRow(row));
    // A short page is the last page. Checking the length rather than asking for a count keeps this
    // to one round trip per page.
    if (batch.length < PAGE_SIZE) break;

    const last = batch[batch.length - 1]!;
    cursor = { fileId: String(last.file_id ?? ""), savedInPhoenixAt: String(last.saved_in_phoenix_at ?? "") };
  }

  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// The daily dashboard
// ─────────────────────────────────────────────────────────────────────────────

export type CvLifecycleDailyRow = {
  /** Cairo calendar day, YYYY-MM-DD. */
  day: string;
  email: number;
  /** Received that day but still not mirrored — the number that should be zero. */
  missingFromDrive: number;
  onDrive: number;
  total: number;
  upload: number;
  whatsapp: number;
};

/**
 * One row per Cairo day, one column per channel — the shape a stacked column chart wants.
 *
 * BUCKETED BY THE CAIRO DAY, NEVER THE SERVER'S. Railway runs in UTC and Cairo is UTC+2/+3, so a
 * CV that arrives at 01:30 Cairo belongs to today and would otherwise be counted as yesterday's for
 * the first two or three hours of every working day — visible in the report as a permanent dip at
 * the start of each morning that no one could explain.
 *
 * `onDrive` counts CVs FROM THAT DAY that reached Drive, not mirrors that happened that day. The
 * two differ whenever a backfill runs — the 2026-09-03 backfill mirrored six weeks of CVs in one
 * evening — and the question the column answers is "did that day's intake land safely", which is
 * the one worth asking.
 *
 * Days with no CVs at all are not emitted. A gap in a chart's x-axis reads as a quiet day, which
 * it was; inventing a zero row for every calendar day since July would bury the real ones.
 */
export function buildDailyChannelRollup(rows: readonly CvLifecycleRow[]): CvLifecycleDailyRow[] {
  const byDay = new Map<string, CvLifecycleDailyRow>();

  for (const row of rows) {
    // The arrival stamp is what "received on day X" means. It falls back to the saved stamp inside
    // the view, so this is never empty for a real row.
    const day = cairoDayKey(row.reachedPhoenixAt ?? row.savedInPhoenixAt);
    if (!day) continue;

    let bucket = byDay.get(day);
    if (!bucket) {
      bucket = { day, email: 0, missingFromDrive: 0, onDrive: 0, total: 0, upload: 0, whatsapp: 0 };
      byDay.set(day, bucket);
    }

    bucket.total += 1;
    bucket[row.channel] += 1;
    if (row.savedInDriveAt) bucket.onDrive += 1;
    else bucket.missingFromDrive += 1;
  }

  // Oldest first: a chart reads left to right in time, and the sheet's own sort can reverse it.
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}

export type CvLifecycleSummary = {
  cvsToday: number;
  driveFolders: number;
  generatedAt: string;
  missingFromDrive: number;
  onDrive: number;
  total: number;
  withDriveError: number;
};

export function summarizeCvLifecycle(
  rows: readonly CvLifecycleRow[],
  now: Date = new Date(),
): CvLifecycleSummary {
  const today = cairoDayKey(now);
  let onDrive = 0;
  let withDriveError = 0;
  let cvsToday = 0;
  const folders = new Set<string>();

  for (const row of rows) {
    if (row.savedInDriveAt) onDrive += 1;
    if (row.driveError) withDriveError += 1;
    if (row.driveFolder) folders.add(row.driveFolder);
    if (cairoDayKey(row.reachedPhoenixAt ?? row.savedInPhoenixAt) === today) cvsToday += 1;
  }

  return {
    cvsToday,
    driveFolders: folders.size,
    generatedAt: now.toISOString(),
    missingFromDrive: rows.length - onDrive,
    onDrive,
    total: rows.length,
    withDriveError,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The CSV bundle the sheet pulls
// ─────────────────────────────────────────────────────────────────────────────

// `csvCell` is the shared one (`@/lib/export/csv-cell`): RFC4180 quoting — an Arabic candidate name
// containing a comma must survive the round trip — and a name from the public application form that
// starts with `=`, `+`, `-` or `@` is neutralised before the sheet opens it (audit S-APP-08).

const CHANNEL_LABELS: Record<CvLifecycleChannel, string> = {
  email: "Email",
  upload: "Uploaded by hand",
  whatsapp: "WhatsApp",
};

const TIMING_LABELS: Record<CvLifecycleTimingSource, string> = {
  // Said in words rather than in jargon: the owner reads this column, not an engineer.
  processed: "When Phoenix processed it (±1 poll)",
  queued: "Exact — webhook arrival",
  saved: "Only the saved time exists",
};

export const CV_LIFECYCLE_COLUMNS = [
  "#",
  "Candidate",
  "Phone",
  "Channel",
  "Sender / mailbox",
  "Applied for",
  "File",
  "Size (KB)",
  "Reached Phoenix",
  "Accuracy of that time",
  "Saved in Phoenix",
  "In Phoenix?",
  "Saved in Google Drive",
  "On Google Drive?",
  "Drive folder",
  "Phoenix → Drive (minutes)",
  "Drive problem",
  "Intake status",
  "Intake error",
  "Applicant answered at",
  "Filed folder",
  "Region",
  "Area",
  "Candidate status",
  "Open in Drive",
  "Open in Phoenix",
] as const;

/** Whole minutes between two instants, or null if either is missing. */
function minutesBetween(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  const a = new Date(from).getTime();
  const b = new Date(to).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 60_000);
}

function driveUrl(fileId: string | null): string {
  return fileId ? `https://drive.google.com/file/d/${fileId}/view` : "";
}

function phoenixUrl(baseUrl: string, candidateId: string | null): string {
  if (!candidateId) return "";
  return `${baseUrl.replace(/\/+$/, "")}/recruitment/candidates?candidate=${encodeURIComponent(candidateId)}`;
}

function folderLabel(row: CvLifecycleRow): string {
  if (!row.folderKind || !row.folderKey) return "";
  return `${row.folderKind}: ${row.folderKey}`;
}

export function cvLifecycleRowCells(
  row: CvLifecycleRow,
  index: number,
  baseUrl: string,
): Array<string | number | null> {
  return [
    index,
    row.candidateName ?? "",
    // Leading apostrophe so Sheets keeps the leading zero and does not render +20… in scientific
    // notation. Without it a phone column is unusable, which is a bug the marketing sheet had to
    // learn in production.
    row.candidatePhone ? `'${row.candidatePhone}` : "",
    CHANNEL_LABELS[row.channel],
    row.senderDisplayName ?? row.mailboxLabel ?? "",
    row.appliedForJobTitle ?? "",
    row.fileName ?? "",
    row.sizeBytes == null ? "" : Math.round(row.sizeBytes / 1024),
    cairoDateTimeSortable(row.reachedPhoenixAt),
    TIMING_LABELS[row.timingSource],
    cairoDateTimeSortable(row.savedInPhoenixAt),
    // A row exists at all only because the file was saved, so this is Yes by construction. It is
    // still printed, because the owner asked to see the confirmation and an implied yes is not one.
    "Yes",
    cairoDateTimeSortable(row.savedInDriveAt),
    row.savedInDriveAt ? "Yes" : "No",
    row.driveFolder ?? "",
    minutesBetween(row.savedInPhoenixAt, row.savedInDriveAt),
    row.driveError ?? "",
    row.queueStatus ?? "",
    row.queueLastError ?? "",
    cairoDateTimeSortable(row.preferencesDeclaredAt),
    folderLabel(row),
    row.preferredRegionCode ?? "",
    row.preferredAreaName ?? "",
    row.candidateStatus ?? "",
    driveUrl(row.driveFileId),
    phoenixUrl(baseUrl, row.candidateId),
  ];
}

/**
 * The detail sheet: everything Phoenix holds about the PERSON, one row each.
 *
 * ONE ROW PER CANDIDATE, NOT PER FILE — which is what makes this a different table rather than more
 * columns on the existing one. 982 files belong to 741 candidates, so a per-file detail sheet would
 * print the same person's education and work history two and three times and make a duplicate look
 * like two applicants.
 *
 * GROUPED, NOT ALPHABETICAL. The order below is the order a human reads a CV in — who they are,
 * where they are, what they studied, what they have done, what they told us, where they went. The
 * sheet paints a band over each group, so the grouping has to live here or the bands drift.
 */
export const CV_DETAIL_COLUMNS = [
  "#",
  "Candidate",
  "Phone",
  "Email",
  "Governorate",
  "Address",
  "Nationality",
  "Gender",
  "Date of birth",
  "Marital status",
  "Military status",
  "LinkedIn",

  "Faculty",
  "University",
  "Degree",
  "Graduation year",
  "Grade",
  "Education history",

  "Applied for",
  "Current job title",
  "Current employer",
  "Years of experience",
  "Worked before?",
  "Medical rep before?",
  "Medical rep employer",
  "Work history",
  "Skills",
  "Languages",
  "Certifications",
  "Professional summary",

  "Their own background",
  "Their own experience",
  "Salary they asked for",
  "Expected salary (on file)",
  "Notice period",
  "English level",
  "MS Office / Outlook",
  "Booking experience",
  "Can commute to Sheraton",
  "Can start",
  "Age band",

  "Prefers region",
  "Prefers area",
  "Filed folder",
  "Drive folder",
  "Sent for job title",
  "Sent for area",
  "Sent for region",
  "Sent for line",
  "Manager notified",
  "Manager notified at",

  "How they reached us",
  "Channel",
  "CVs on file",
  "Candidate status",
  "Status note",
  "Added to Phoenix",
  "Open in Phoenix",
] as const;

/** Yes / No / blank. A blank means nobody ever asked, which is not the same answer as No. */
function yesNo(value: boolean | null): string {
  if (value === null) return "";
  return value ? "Yes" : "No";
}

/**
 * The newest CV per candidate, plus how many that candidate has sent.
 *
 * `rows` arrives newest-first, so the FIRST row seen for a candidate id is the newest one and the
 * count is simply how many times the id recurs. Rows with no candidate id — a file that never got
 * attached to anybody — are kept individually and keyed by file id, because collapsing them all
 * under one blank key would silently hide every orphaned CV but the first, which is exactly the
 * kind of quiet loss this whole report exists to make visible.
 */
export function oneRowPerCandidate(
  rows: readonly CvLifecycleRow[],
): Array<{ cvCount: number; row: CvLifecycleRow }> {
  const byKey = new Map<string, { cvCount: number; row: CvLifecycleRow }>();
  for (const row of rows) {
    const key = row.candidateId ?? `file:${row.fileId}`;
    const seen = byKey.get(key);
    if (seen) seen.cvCount += 1;
    else byKey.set(key, { cvCount: 1, row });
  }
  return [...byKey.values()];
}

export function cvDetailRowCells(
  entry: { cvCount: number; row: CvLifecycleRow },
  index: number,
  baseUrl: string,
): Array<string | number | null> {
  const { cvCount, row } = entry;
  return [
    index,
    row.candidateName ?? "",
    // Leading apostrophe for the same reason as the lifecycle table: without it Sheets eats the
    // leading zero and renders +20... in scientific notation.
    row.candidatePhone ? `'${row.candidatePhone}` : "",
    row.candidateEmail ?? "",
    row.governorate ?? "",
    row.candidateAddress ?? "",
    row.nationality ?? "",
    row.gender ?? "",
    dateOnly(row.dateOfBirth),
    row.maritalStatus ?? "",
    row.militaryStatus ?? "",
    row.linkedinUrl ?? "",

    row.faculty ?? "",
    row.university ?? "",
    row.degree ?? "",
    row.graduationYear ?? "",
    row.grade ?? "",
    row.cvEducation ?? "",

    row.appliedForJobTitle ?? "",
    row.currentJobTitle ?? "",
    row.currentEmployer ?? "",
    row.yearsExperience ?? "",
    yesNo(row.hasPriorWorkExperience),
    yesNo(row.hasMedicalRepExperience),
    row.medicalRepEmployer ?? "",
    row.cvWorkHistory ?? "",
    row.cvSkills ?? "",
    row.cvLanguages ?? "",
    row.cvCertifications ?? "",
    row.professionalSummary ?? "",

    row.declaredBackground ?? "",
    row.declaredExperience ?? "",
    row.declaredExpectedSalary ?? "",
    row.expectedSalary ?? "",
    row.noticePeriod ?? "",
    row.screeningEnglishLevel ?? "",
    row.screeningMsOffice ?? "",
    row.screeningBookingExperience ?? "",
    row.screeningCommute ?? "",
    row.screeningStartDate ?? "",
    row.screeningAgeBand ?? "",

    row.preferredRegionName ?? row.preferredRegionCode ?? "",
    row.preferredAreaName ?? "",
    folderLabel(row),
    row.driveFolder ?? "",
    row.sentForJobTitle ?? "",
    row.sentForArea ?? "",
    row.sentForRegion ?? "",
    row.sentForLine ?? "",
    row.managerNotifiedName ?? "",
    cairoDateTimeSortable(row.managerNotifiedAt),

    row.candidateSource ?? "",
    CHANNEL_LABELS[row.channel],
    cvCount,
    row.candidateStatus ?? "",
    row.candidateStatusNote ?? "",
    cairoDateTimeSortable(row.candidateCreatedAt),
    phoenixUrl(baseUrl, row.candidateId),
  ];
}

export const CV_LIFECYCLE_DAILY_COLUMNS = [
  "Day",
  "WhatsApp",
  "Email",
  "Uploaded by hand",
  "Total received",
  "Reached Google Drive",
  "Still missing from Drive",
] as const;

/**
 * The whole bundle, in the `#SECTION` form both existing live sheets already use.
 *
 * Sections rather than three endpoints because Apps Script pays a round trip per fetch and the
 * sheet refreshes on a one-minute timer; one pull that fills every tab keeps the three tabs
 * consistent with each other, which three independent pulls could not guarantee.
 */
export function buildCvLifecycleCsv(input: {
  baseUrl: string;
  daily: readonly CvLifecycleDailyRow[];
  rows: readonly CvLifecycleRow[];
  summary: CvLifecycleSummary;
}): string {
  const { baseUrl, daily, rows, summary } = input;
  const out: string[] = [];

  out.push("#SUMMARY");
  out.push(["Metric", "Value"].map(csvCell).join(","));
  const summaryRows: Array<[string, string]> = [
    ["Report generated", cairoDateTimeSortable(summary.generatedAt)],
    ["CVs in total", String(summary.total)],
    ["CVs received today", String(summary.cvsToday)],
    ["Saved in Phoenix", String(summary.total)],
    ["Saved in Google Drive", String(summary.onDrive)],
    ["Still missing from Drive", String(summary.missingFromDrive)],
    ["Drive errors", String(summary.withDriveError)],
    ["Drive folders in use", String(summary.driveFolders)],
    // Stated in the data itself, not only in a comment nobody opens: the reader of this sheet must
    // not walk away believing Phoenix knows when the candidate pressed send.
    [
      "About \"Reached Phoenix\"",
      "The moment the CV reached Phoenix, not the moment the candidate sent it — WhatsApp does not pass the sender's own send time on to us. It is normally seconds later.",
    ],
  ];
  for (const [label, value] of summaryRows) out.push([label, value].map(csvCell).join(","));

  out.push("#DAILY");
  out.push(CV_LIFECYCLE_DAILY_COLUMNS.map(csvCell).join(","));
  for (const day of daily) {
    out.push(
      [day.day, day.whatsapp, day.email, day.upload, day.total, day.onDrive, day.missingFromDrive]
        .map(csvCell)
        .join(","),
    );
  }

  out.push("#LIFECYCLE");
  out.push(CV_LIFECYCLE_COLUMNS.map(csvCell).join(","));
  for (const [index, row] of rows.entries()) {
    out.push(cvLifecycleRowCells(row, index + 1, baseUrl).map(csvCell).join(","));
  }

  // One row per candidate rather than per file, so a person with three CVs is one applicant here.
  out.push("#DETAIL");
  out.push(CV_DETAIL_COLUMNS.map(csvCell).join(","));
  for (const [index, entry] of oneRowPerCandidate(rows).entries()) {
    out.push(cvDetailRowCells(entry, index + 1, baseUrl).map(csvCell).join(","));
  }

  // Leading BOM so Excel opens Arabic candidate names correctly instead of as mojibake.
  return `﻿${out.join("\r\n")}\r\n`;
}
