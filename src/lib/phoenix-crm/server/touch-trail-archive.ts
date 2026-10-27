import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";

import { cairoBusinessDay } from "@/lib/phoenix-crm/calendar";
import { throwIfError } from "@/lib/phoenix-crm/server/db";
import {
  ARCHIVE_FILE_ROWS,
  ARCHIVE_MAX_DAYS_PER_RUN,
  ARCHIVE_READ_PAGE,
  ARCHIVE_RUN_BUDGET_MS,
  TOUCH_TRAIL_ARCHIVE_BUCKET,
  archiveObjectPath,
  checkArchiveBody,
  deleteSlices,
  firstKeptTrailDay,
  toNdjson,
} from "@/lib/phoenix-crm/touch-trail-archive";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * Phoenix CRM — moving touches older than 30 days out of the database (owner, 2026-10-27).
 *
 * The rules are in `src/lib/phoenix-crm/touch-trail-archive.ts`; this is the half that touches the
 * database and the bucket. One file at a time, oldest day first: read up to `ARCHIVE_FILE_ROWS` rows by
 * keyset, gzip them, upload, download again and check the bytes and the rows, then delete exactly those
 * ids. A failure anywhere before the delete leaves every row where it was.
 *
 * Safe to fire twice and safe to stop half-way: the rows still in the table ARE the work left, so the
 * next run simply finds them. No lease is needed — two runs at once read the same rows, write the same
 * file name, and the second delete removes nothing.
 */

const TABLE = "phoenix_crm_touch_trail";
const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export type TouchTrailArchiveDay = { day: string; rows: number; files: number; finished: boolean };

export type TouchTrailArchiveResult = {
  /** Today's visit day, and the oldest day the database keeps. */
  today: string;
  firstKeptDay: string;
  days: TouchTrailArchiveDay[];
  rowsArchived: number;
  rowsDeleted: number;
  /** True when the run stopped for its time budget or its day cap with older days still waiting. */
  moreWaiting: boolean;
  dryRun: boolean;
};

type TrailRow = Record<string, unknown> & { id: number };

/** The oldest visit day still in the table that is due for the archive, or null when none is. */
async function oldestDueDay(firstKept: string): Promise<string | null> {
  const { data, error } = await getSupabaseAdmin()
    .from(TABLE)
    .select("visit_day")
    .lt("visit_day", firstKept)
    .order("visit_day", { ascending: true })
    .limit(1);
  throwIfError(error);
  const day = (data?.[0] as { visit_day?: unknown } | undefined)?.visit_day;
  return typeof day === "string" ? day : null;
}

/** Up to one file's rows of one day, every column, keyset-paged past PostgREST's 1,000-row ceiling. */
async function readFileRows(day: string, afterId: number): Promise<TrailRow[]> {
  const rows: TrailRow[] = [];
  let cursor = afterId;
  while (rows.length < ARCHIVE_FILE_ROWS) {
    const page = Math.min(ARCHIVE_READ_PAGE, ARCHIVE_FILE_ROWS - rows.length);
    const { data, error } = await getSupabaseAdmin()
      .from(TABLE)
      .select("*")
      .eq("visit_day", day)
      .gt("id", cursor)
      .order("id", { ascending: true })
      .limit(page);
    throwIfError(error);
    const batch = (data ?? []) as Array<Record<string, unknown>>;
    for (const raw of batch) {
      const id = Number(raw.id);
      // An id that does not read back cannot be named in a delete, so the run stops rather than
      // archiving a row it could never remove — or removing one it never archived.
      if (!Number.isSafeInteger(id) || id <= cursor) throw new Error(`The touch trail returned an unusable id (${String(raw.id)}) on ${day}.`);
      rows.push({ ...raw, id });
      cursor = id;
    }
    if (batch.length < page) break;
  }
  return rows;
}

/** Write one file, read it back and check it (rule 1). Throws on any difference; deletes nothing. */
async function archiveFile(day: string, rows: TrailRow[]): Promise<void> {
  const firstId = rows[0]!.id;
  const lastId = rows[rows.length - 1]!.id;
  const path = archiveObjectPath(day, firstId, lastId);
  const body = await gzipAsync(Buffer.from(toNdjson(rows), "utf8"));
  const sent = createHash("sha256").update(body).digest("hex");

  const bucket = getSupabaseAdmin().storage.from(TOUCH_TRAIL_ARCHIVE_BUCKET);
  // `upsert`: a run that uploaded this exact file and then died before its delete re-reads the same
  // rows and writes the same name — the same bytes, so replacing it loses nothing.
  const uploaded = await bucket.upload(path, body, { contentType: "application/gzip", upsert: true });
  if (uploaded.error) throw uploaded.error;

  const downloaded = await bucket.download(path);
  if (downloaded.error || !downloaded.data) throw downloaded.error ?? new Error(`The archive file ${path} did not read back.`);
  const stored = Buffer.from(await downloaded.data.arrayBuffer());
  const received = createHash("sha256").update(stored).digest("hex");
  if (received !== sent) throw new Error(`The archive file ${path} read back different bytes from those written.`);
  const problem = checkArchiveBody((await gunzipAsync(stored)).toString("utf8"), { firstId, lastId, rows: rows.length });
  if (problem) throw new Error(`The archive file ${path} failed its check: ${problem}.`);
}

/** Delete exactly the archived ids (rule 2). Returns how many rows the database says it removed. */
async function deleteArchived(rows: TrailRow[]): Promise<number> {
  let deleted = 0;
  for (const slice of deleteSlices(rows.map((row) => row.id))) {
    const { count, error } = await getSupabaseAdmin().from(TABLE).delete({ count: "exact" }).in("id", slice);
    throwIfError(error);
    deleted += count ?? 0;
  }
  return deleted;
}

/**
 * The nightly run. `dryRun` reads which day is due and how many of its rows the first file would hold,
 * and writes nothing — the way to look at the job on production before it deletes anything.
 */
export async function runTouchTrailArchive(
  options: { dryRun?: boolean; now?: Date } = {},
): Promise<TouchTrailArchiveResult> {
  const started = Date.now();
  const dryRun = options.dryRun === true;
  const today = cairoBusinessDay(options.now ?? new Date());
  const firstKept = firstKeptTrailDay(today);
  const result: TouchTrailArchiveResult = {
    days: [],
    dryRun,
    firstKeptDay: firstKept,
    moreWaiting: false,
    rowsArchived: 0,
    rowsDeleted: 0,
    today,
  };

  while (result.days.length < ARCHIVE_MAX_DAYS_PER_RUN) {
    const day = await oldestDueDay(firstKept);
    if (!day) return result;
    const entry: TouchTrailArchiveDay = { day, files: 0, finished: false, rows: 0 };
    result.days.push(entry);

    if (dryRun) {
      entry.rows = (await readFileRows(day, 0)).length;
      return result;
    }

    let lastArchivedId = 0;
    for (;;) {
      if (Date.now() - started > ARCHIVE_RUN_BUDGET_MS) {
        result.moreWaiting = true;
        return result;
      }
      // Always from the start of what is left: archived rows are gone, so the next file begins at the
      // first row still in the table — including one a late flush filed on this day after the last read.
      const rows = await readFileRows(day, 0);
      if (rows.length === 0) {
        entry.finished = true;
        break;
      }
      // Ids only grow, so once a file's rows are deleted the next file starts past it. One that does
      // not means the delete did not land, and archiving the same rows again until the budget ran out
      // would only write the same file over and over.
      if (rows[0]!.id <= lastArchivedId) {
        throw new Error(`The touch trail rows of ${day} up to id ${lastArchivedId} were archived but are still in the table.`);
      }
      lastArchivedId = rows[rows.length - 1]!.id;
      await archiveFile(day, rows);
      entry.files += 1;
      entry.rows += rows.length;
      result.rowsArchived += rows.length;
      result.rowsDeleted += await deleteArchived(rows);
    }
  }

  result.moreWaiting = (await oldestDueDay(firstKept)) !== null;
  return result;
}
