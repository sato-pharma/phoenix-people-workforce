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

import { cairoDateTimeSortable } from "@/lib/format/cairo-datetime";
import { cairoDayKey } from "@/lib/recruitment/candidate-stats";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/** The view does the four-way join; see 20260905011500_cv_lifecycle_view_and_share_links.sql. */
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
  };
}

/**
 * Every CV, newest first.
 *
 * Ordered by `saved_in_phoenix_at` and NOT by the arrival stamp, deliberately: `saved_in_phoenix_at`
 * is the one column in the view that is never null, and paging on a nullable sort key is how rows
 * go missing between pages. `file_id` breaks ties so the order is total — without it two CVs saved
 * in the same millisecond can appear on two consecutive pages, or on neither.
 */
export async function loadCvLifecycle(): Promise<CvLifecycleRow[]> {
  const supabase = getSupabaseAdmin();
  const rows: CvLifecycleRow[] = [];

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const from = page * PAGE_SIZE;
    const { data, error } = await supabase
      .from(VIEW)
      .select("*")
      .order("saved_in_phoenix_at", { ascending: false })
      .order("file_id", { ascending: false })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;

    const batch = (data ?? []) as RawRow[];
    for (const row of batch) rows.push(mapRow(row));
    // A short page is the last page. Checking the length rather than asking for a count keeps this
    // to one round trip per page.
    if (batch.length < PAGE_SIZE) break;
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

/** RFC4180 quoting — an Arabic candidate name containing a comma must survive the round trip. */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text_ = String(value);
  return /[",\n\r]/.test(text_) ? `"${text_.replace(/"/g, '""')}"` : text_;
}

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

  // Leading BOM so Excel opens Arabic candidate names correctly instead of as mojibake.
  return `﻿${out.join("\r\n")}\r\n`;
}
