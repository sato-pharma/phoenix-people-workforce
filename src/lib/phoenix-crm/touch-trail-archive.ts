/**
 * Phoenix CRM — the touch trail's 30-day window, and the archive that holds what is older.
 *
 * 🔴 OWNER, 2026-10-27, choosing among the options after the afternoon database stalls: "Archive after
 * 30 days". The trail was the biggest table on a production database that holds 4.3 GB on 2 GB of RAM —
 * 985 MB after 24 days, 95,000 to 181,000 rows on a field day — and nothing ever left it. Every night
 * a touch older than 30 days is written to a gzipped file in private storage, the file is read BACK and
 * checked, and only then are exactly those rows deleted from the database.
 *
 * FOUR RULES, AND THE FIRST IS WHY THIS FILE EXISTS.
 *
 *   1. 🔴 NOTHING IS DELETED THAT WAS NOT FIRST READ BACK FROM STORAGE. Production has no
 *      point-in-time recovery and the trail is evidence the owner asked for by name, so "uploaded" is
 *      not enough: the file is downloaded again, its bytes hashed against what was sent, and its lines
 *      counted and their first and last id compared (`checkArchiveBody`). Any mismatch stops the run
 *      with the rows still in the table.
 *   2. 🔴 THE DELETE NAMES EVERY ID IT REMOVES — NEVER A RANGE. A `visit_day`/`id` range would also take
 *      a row that arrived after the read (a late flush filed on an old day), and that row would be in
 *      no file. `deleteSlices` cuts the archived ids into slices short enough for one request URL.
 *   3. A FILE NAMES ITS FIRST AND LAST ID, so a run cut off half-way through a day never overwrites
 *      the part already archived: the next night reads the rows still in the table and writes them to
 *      a NEW name. One id may then sit in two files (archived, its delete lost); a reader of the
 *      archive takes each id once.
 *   4. GOLDEN RULE #1 IS UNTOUCHED. The archive is a private bucket only the service role reaches; the
 *      Super Admin is still the one reader, and a rep never learns either exists.
 */

/** How many visit days stay in the database, today included (owner, 2026-10-27: "30 days"). */
export const TOUCH_TRAIL_KEEP_DAYS = 30;

/** The private bucket the archive lives in, created by `20261027175121_phoenix_crm_touch_trail_archive.sql`. */
export const TOUCH_TRAIL_ARCHIVE_BUCKET = "phoenix-crm-touch-trail-archive";

/** PostgREST's silent ceiling on one response, so the keyset page size. */
export const ARCHIVE_READ_PAGE = 1_000;

/**
 * Rows in one archive file. About 1 MB gzipped, so a busy day (181,000 rows on 22 Oct) is ten files,
 * and the server never holds more than one file's rows at once.
 */
export const ARCHIVE_FILE_ROWS = 20_000;

/**
 * Ids in one delete request. Seven-digit ids and their commas come to about 3,200 characters of URL,
 * well inside what the API gateway takes.
 */
export const ARCHIVE_DELETE_SLICE = 400;

/** Days one night may archive. A backlog drains over several nights rather than in one long run. */
export const ARCHIVE_MAX_DAYS_PER_RUN = 2;

/** No new file is started after this long, so the run ends inside the route's 300-second limit. */
export const ARCHIVE_RUN_BUDGET_MS = 240_000;

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function shiftDay(day: string, days: number): string {
  const anchor = Date.parse(`${day}T00:00:00Z`);
  if (!DAY_PATTERN.test(day) || Number.isNaN(anchor)) throw new Error(`Not a calendar day: ${day}`);
  return new Date(anchor + days * 86_400_000).toISOString().slice(0, 10);
}

/** The oldest visit day the database keeps, given today's visit day. Anything before it is archived. */
export function firstKeptTrailDay(today: string): string {
  return shiftDay(today, -(TOUCH_TRAIL_KEEP_DAYS - 1));
}

/** True when a visit day's touches are in the archive rather than the database. */
export function isArchivedTrailDay(day: string, today: string): boolean {
  if (!DAY_PATTERN.test(day)) return false;
  return day < firstKeptTrailDay(today);
}

/** "2026-10-03" → "2026/10/2026-10-03/ids-257-9934.ndjson.gz" (rule 3). */
export function archiveObjectPath(day: string, firstId: number, lastId: number): string {
  if (!DAY_PATTERN.test(day)) throw new Error(`Not a calendar day: ${day}`);
  if (!Number.isSafeInteger(firstId) || !Number.isSafeInteger(lastId) || firstId > lastId) {
    throw new Error(`Not an id range: ${firstId}-${lastId}`);
  }
  return `${day.slice(0, 4)}/${day.slice(5, 7)}/${day}/ids-${firstId}-${lastId}.ndjson.gz`;
}

/** One JSON object per line, newline-terminated — the archive's text before it is gzipped. */
export function toNdjson(rows: ReadonlyArray<Record<string, unknown>>): string {
  return rows.map((row) => `${JSON.stringify(row)}\n`).join("");
}

/**
 * Does a downloaded, unzipped file hold exactly the rows that were written (rule 1)? Returns null when
 * it does, or the reason it does not — never a guess.
 */
export function checkArchiveBody(
  text: string,
  expected: { rows: number; firstId: number; lastId: number },
): string | null {
  const lines = text.split("\n").filter((line) => line.length > 0);
  if (lines.length !== expected.rows) return `the file holds ${lines.length} rows, ${expected.rows} were written`;
  let first: unknown;
  let last: unknown;
  try {
    first = (JSON.parse(lines[0] ?? "null") as { id?: unknown } | null)?.id;
    last = (JSON.parse(lines[lines.length - 1] ?? "null") as { id?: unknown } | null)?.id;
  } catch {
    return "the file does not read back as JSON lines";
  }
  if (Number(first) !== expected.firstId) return `the file starts at id ${String(first)}, not ${expected.firstId}`;
  if (Number(last) !== expected.lastId) return `the file ends at id ${String(last)}, not ${expected.lastId}`;
  return null;
}

/** The archived ids cut into delete requests (rule 2). */
export function deleteSlices(ids: ReadonlyArray<number>, size = ARCHIVE_DELETE_SLICE): number[][] {
  const slices: number[][] = [];
  for (let at = 0; at < ids.length; at += size) slices.push(ids.slice(at, at + size));
  return slices;
}
