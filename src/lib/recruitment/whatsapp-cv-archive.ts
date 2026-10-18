// Recruitment / ATS — the WhatsApp CV Archive: what the Archive on the WhatsApp Applicants page says.
// Pure: the database half is whatsapp-cv-archive-loader.ts.
//
// WHAT IT IS. On 2026-10-18 the owner cleaned the recruitment module: every candidate received before
// Sunday 11 October 2026 was deleted (backed up first). Of the old WhatsApp CVs, the ones "perfectly
// sitting in a folder in their place" that "answered most of the questions we need" were kept —
// "make a folder in each folder called archive … at the end of the day, I want the recruitment module
// and screening to be clear and clean" — and, asked where that Archive lives, "in Phoenix as well".
//
// 🔴 SO AN ARCHIVED APPLICANT IS NOT A CANDIDATE. The rows live in their own tables
// (`ats_whatsapp_cv_archive`, `_files`) and the files in their own bucket (`recruitment-cv-archive`),
// so no pool, screening page, folder, manager shelf, tile, count or alert can reach them. Nothing
// here can be marked, booked or sent; the Archive only shows who they were and opens their CV.
//
// THE FOLDERS are the CV cabinet's own: WhatsApp line › job title › area (the area is missing for a
// title the bot does not ask an area for). Each one shows as "<folder> › Archive", the folder he asked
// for inside each folder.

export const ARCHIVE_FOLDER_NAME = "Archive";

/** The clean-up's cut-off: Sunday 11 October 2026, 00:00 Cairo — his "before Sunday, 11 October". */
export const RECRUITMENT_CLEANUP_CUT_AT = "2026-10-10T21:00:00.000Z";

/**
 * Whether a WhatsApp conversation still counts on WhatsApp Applicants. A conversation that joins to a
 * live candidate always does. One from BEFORE the clean-up that no longer joins to anyone belongs to a
 * person he had taken out (deleted, or moved to the Archive), so it is not "an applicant whose chat
 * could not be matched to a CV" — 705 such conversations would otherwise have filled that line under
 * every title on 2026-10-18. One from after the cut that does not join is still counted, as before: that
 * is the line's real job (a forwarder's chat, a CV not yet a candidate).
 */
export function countsOnWhatsAppApplicants(startedAt: string, joinedToCandidate: boolean): boolean {
  if (joinedToCandidate) return true;
  const started = Date.parse(startedAt);
  return !Number.isFinite(started) || started >= Date.parse(RECRUITMENT_CLEANUP_CUT_AT);
}

export type WhatsAppCvArchiveAnswer = { question: string; answer: string };

export type WhatsAppCvArchiveFile = {
  id: string;
  fileName: string;
  mimeType: string | null;
  sizeBytes: number | null;
};

export type WhatsAppCvArchivePerson = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  receivedAt: string;
  answers: WhatsAppCvArchiveAnswer[];
  files: WhatsAppCvArchiveFile[];
};

export type WhatsAppCvArchiveFolder = {
  key: string;
  /** The cabinet folder, outermost first, e.g. ["WhatsApp 01098500699", "Medical Representative", "Upper Egypt"]. */
  path: string[];
  people: WhatsAppCvArchivePerson[];
};

export type WhatsAppCvArchiveView = {
  folders: WhatsAppCvArchiveFolder[];
  people: number;
  files: number;
};

/** One archive row as the loader reads it. */
export type WhatsAppCvArchiveRow = {
  id: string;
  full_name: string | null;
  phone: string | null;
  whatsapp: string | null;
  email: string | null;
  job_title: string | null;
  region: string | null;
  area: string | null;
  background: string | null;
  experience: string | null;
  expected_salary: string | null;
  extra_answers: unknown;
  received_at: string;
  folder_path: string[] | null;
};

export type WhatsAppCvArchiveFileRow = {
  id: string;
  archive_id: string;
  file_name: string | null;
  mime_type: string | null;
  size_bytes: number | string | null;
};

function clean(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** Every saved extra answer that is a real {question, answer} pair, in the order it was stored. */
function extraAnswers(value: unknown): WhatsAppCvArchiveAnswer[] {
  if (!Array.isArray(value)) return [];
  const answers: WhatsAppCvArchiveAnswer[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const question = clean((entry as { question?: unknown }).question);
    const answer = clean((entry as { answer?: unknown }).answer);
    if (question && answer) answers.push({ question, answer });
  }
  return answers;
}

/**
 * What they answered on WhatsApp, the five main questions first in the bot's own order, then every
 * other question they were asked. A question they did not answer is left out rather than shown blank.
 */
export function archiveAnswers(row: WhatsAppCvArchiveRow): WhatsAppCvArchiveAnswer[] {
  const place = [clean(row.area), clean(row.region)].filter(Boolean).join(", ");
  const main: Array<[string, string | null]> = [
    ["Job title", clean(row.job_title)],
    ["Area", place || null],
    ["Background", clean(row.background)],
    ["Experience", clean(row.experience)],
    ["Expected salary", clean(row.expected_salary)],
  ];
  return [
    ...main.filter((entry): entry is [string, string] => entry[1] !== null).map(([question, answer]) => ({ question, answer })),
    ...extraAnswers(row.extra_answers),
  ];
}

function sizeOf(value: number | string | null): number | null {
  const size = typeof value === "string" ? Number(value) : value;
  return typeof size === "number" && Number.isFinite(size) && size >= 0 ? size : null;
}

/** The folder's key: its path, joined by a character no folder name holds. */
export function archiveFolderKey(path: readonly string[]): string {
  return path.join("\u001f");
}

/**
 * The Archive, grouped by cabinet folder. Folders sort by their path, the way the cabinet lists them;
 * inside a folder the newest CV is first. A row with no folder path is filed under "Not filed" rather
 * than dropped, so the count on the page is always everyone in the table.
 */
export function buildWhatsAppCvArchiveView(
  rows: readonly WhatsAppCvArchiveRow[],
  files: readonly WhatsAppCvArchiveFileRow[],
): WhatsAppCvArchiveView {
  const filesByPerson = new Map<string, WhatsAppCvArchiveFile[]>();
  for (const file of files) {
    const list = filesByPerson.get(file.archive_id) ?? [];
    list.push({
      id: file.id,
      fileName: clean(file.file_name) ?? "CV",
      mimeType: clean(file.mime_type),
      sizeBytes: sizeOf(file.size_bytes),
    });
    filesByPerson.set(file.archive_id, list);
  }

  const folders = new Map<string, WhatsAppCvArchiveFolder>();
  let fileCount = 0;
  for (const row of rows) {
    const path = (row.folder_path ?? []).map((segment) => clean(segment)).filter((segment): segment is string => segment !== null);
    const folderPath = path.length > 0 ? path : ["Not filed"];
    const key = archiveFolderKey(folderPath);
    const folder = folders.get(key) ?? { key, path: folderPath, people: [] };
    const personFiles = (filesByPerson.get(row.id) ?? []).sort((a, b) => a.fileName.localeCompare(b.fileName));
    fileCount += personFiles.length;
    folder.people.push({
      id: row.id,
      name: clean(row.full_name) ?? "Name not on file",
      phone: clean(row.phone) ?? clean(row.whatsapp),
      email: clean(row.email),
      receivedAt: row.received_at,
      answers: archiveAnswers(row),
      files: personFiles,
    });
    folders.set(key, folder);
  }

  const sorted = [...folders.values()].sort((a, b) => a.key.localeCompare(b.key));
  for (const folder of sorted) {
    folder.people.sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt) || a.name.localeCompare(b.name));
  }
  return { folders: sorted, files: fileCount, people: rows.length };
}

/** The address that serves one archived CV. Only `whatsapp-cv-archive/[fileId]` answers it. */
export function archiveFileHref(fileId: string, mode: "inline" | "download"): string {
  const base = `/api/recruitment/whatsapp-cv-archive/${encodeURIComponent(fileId)}`;
  return mode === "inline" ? `${base}?disposition=inline` : base;
}
