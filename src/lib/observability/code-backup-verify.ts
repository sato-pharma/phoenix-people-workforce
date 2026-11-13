// The nightly backups, code and database, checked from production rather than from the job that makes them.
// A job that dies before it starts cannot report itself, so this reads what is really on Drive.
// The job is infra/code-backup/: backup.sh makes the code file, db-backup.sh the database file.

import { getDriveAccessToken } from "@/lib/recruitment/drive-storage";

export const CODE_BACKUP_FOLDER = "phoenix-code-backup";
export const CODE_BACKUP_MAX_AGE_HOURS = 36;
// Measured on the 26 Oct bundles: 453 MB. A file under this is missing most of what it should hold.
export const CODE_BACKUP_MIN_BYTES = 100 * 1024 * 1024;

// The database backup sits in its own folder, so neither job can prune or overwrite the other's files.
export const DB_BACKUP_FOLDER = "phoenix-db-backup";
// Half of the first full file (owner, 13 Nov 2026: "raise the backup size floor to half of tonight's file").
// That file, db-backup-2026-11-13.tar.age, is 331,201,672 bytes: 1,411 tables and 5,694,838 rows. The floor
// was 64 MB until then, set before any full file existed. A database only grows, so never lower this; the
// rule below it, under half of the night before, does the fine work from night to night.
export const DB_BACKUP_FIRST_FULL_FILE_BYTES = 331_201_672;
export const DB_BACKUP_MIN_BYTES = Math.floor(DB_BACKUP_FIRST_FULL_FILE_BYTES / 2);

const FOLDER_MIME = "application/vnd.google-apps.folder";
const READ_TIMEOUT_MS = 20_000;

export type CodeBackupFile = { createdTime: string; name: string; size: number };
export type CodeBackupVerdict = { detail: string; outcome: "fail" | "success" };

function megabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/** Newest first. Too small is judged two ways: against a floor, and against the file before it. */
export function assessCodeBackup(
  files: readonly CodeBackupFile[],
  nowMs: number,
  minBytes: number = CODE_BACKUP_MIN_BYTES,
): CodeBackupVerdict {
  const [newest, previous] = [...files].sort((a, b) => b.createdTime.localeCompare(a.createdTime));
  if (!newest) return { detail: "No backup file has reached Drive yet.", outcome: "fail" };
  const hours = Math.floor((nowMs - new Date(newest.createdTime).getTime()) / (60 * 60 * 1000));
  if (!(hours <= CODE_BACKUP_MAX_AGE_HOURS)) {
    return { detail: `The newest backup, ${newest.name}, is ${hours} hours old (limit ${CODE_BACKUP_MAX_AGE_HOURS}).`, outcome: "fail" };
  }
  if (newest.size < minBytes) {
    return { detail: `The newest backup, ${newest.name}, is only ${megabytes(newest.size)} (floor ${megabytes(minBytes)}).`, outcome: "fail" };
  }
  if (previous && newest.size < previous.size / 2) {
    return { detail: `The newest backup, ${newest.name}, is ${megabytes(newest.size)}, under half of the one before it (${megabytes(previous.size)}).`, outcome: "fail" };
  }
  return { detail: `${newest.name}, ${megabytes(newest.size)}, ${hours} hours old.`, outcome: "success" };
}

/** The database file is judged by the same three rules, against its own floor. */
export function assessDatabaseBackup(files: readonly CodeBackupFile[], nowMs: number): CodeBackupVerdict {
  return assessCodeBackup(files, nowMs, DB_BACKUP_MIN_BYTES);
}

async function driveList(token: string, query: string, extra: Record<string, string> = {}): Promise<Record<string, string>[]> {
  const params = new URLSearchParams({ fields: "files(id,name,size,createdTime)", pageSize: "20", q: `${query} and trashed=false`, ...extra });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(READ_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Google Drive answered ${res.status}`);
  const body = (await res.json()) as { files?: Record<string, string>[] };
  if (!Array.isArray(body.files)) throw new Error("Google Drive answered with no file list");
  return body.files;
}

function folderQuery(name: string, parent: string | null): string {
  const within = parent ? ` and '${parent}' in parents` : "";
  return `name='${name}' and mimeType='${FOLDER_MIME}'${within}`;
}

/** The files in the daily folder. An absent folder is no files; a Drive that cannot be read throws. */
export async function readCodeBackupFiles(folder: string = CODE_BACKUP_FOLDER): Promise<CodeBackupFile[]> {
  const token = await getDriveAccessToken();
  const [root] = await driveList(token, folderQuery(folder, null));
  if (!root) return [];
  const [daily] = await driveList(token, folderQuery("daily", root.id!));
  if (!daily) return [];
  const files = await driveList(token, `'${daily.id}' in parents and mimeType!='${FOLDER_MIME}'`, { orderBy: "createdTime desc" });
  return files.map((file) => ({ createdTime: file.createdTime ?? "", name: file.name ?? "", size: Number(file.size ?? 0) }));
}
