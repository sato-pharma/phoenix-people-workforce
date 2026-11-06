/**
 * Tripwire for the one silent failure PostgREST has: a read cut at its response ceiling.
 *
 * PostgREST stops a response at its `max-rows` setting (the Supabase default is 1,000) and says
 * nothing: no error, no marker in the body. Production's setting is unset today — measured
 * 2026-11-07, one unpaged request returned 105,103 rows — but it lives in the Supabase dashboard,
 * not in this repository. A restored or recreated project comes back with the default, and then
 * every unpaged read in the app is cut at 1,000 with nothing to say so.
 *
 * The only trace is in the response HEADERS, which this reads and the body it never touches: a read
 * that sent no `limit`, no `offset` and no `Range` and still answered `Content-Range: 0-999/…` was
 * stopped at the ceiling (`/N` with N above 1,000 is proof; `/*` means it cannot be told apart from a
 * table that happens to hold exactly 1,000 rows, so it is only a warning).
 *
 * It only ever logs. Throwing would break a page on a coincidence, and a pager always sends a
 * `limit`, so the code that pages correctly is never reported.
 */

/** PostgREST's default ceiling, and the size of one page in every pager in this repository. */
export const POSTGREST_ROW_CEILING = 1000;

const REST_PREFIX = "/rest/v1/";

export type RowCapFinding = {
  /** The relation read, with nothing after it: no filter value and no id ever reaches the log. */
  table: string;
  returned: number;
  /** The table's real size when the server said so; null when it answered `/*`. */
  total: number | null;
  /** True when the server itself reported more rows than it sent. */
  proven: boolean;
};

/**
 * Pure: was this read cut at the ceiling? `url` is the request URL; `hasRange` is true when the
 * request carried a `Range` header.
 */
export function rowCapFinding(
  call: { method: string; url: string; hasRange: boolean },
  response: { status: number; contentRange: string | null },
): RowCapFinding | null {
  if (call.method !== "GET" || call.hasRange) return null;
  if (response.status !== 200 && response.status !== 206) return null;

  let parsed: URL;
  try {
    parsed = new URL(call.url);
  } catch {
    return null;
  }
  if (!parsed.pathname.startsWith(REST_PREFIX)) return null;
  // A pager, a `.limit()` and a `.range()` all arrive as one of these two, and each asked for the size it wanted.
  if (parsed.searchParams.has("limit") || parsed.searchParams.has("offset")) return null;

  const match = /^(\d+)-(\d+)\/(\*|\d+)$/.exec(response.contentRange ?? "");
  if (!match) return null;
  const start = Number(match[1]);
  const returned = Number(match[2]) - start + 1;
  if (start !== 0 || returned !== POSTGREST_ROW_CEILING) return null;

  const total = match[3] === "*" ? null : Number(match[3]);
  // The server counted, and 1,000 is all there is: a table of exactly that size, not a cut.
  if (total !== null && total <= returned) return null;

  return {
    table: parsed.pathname.slice(REST_PREFIX.length).split("/")[0] ?? "",
    returned,
    total,
    proven: total !== null,
  };
}

const NOTE_EVERY_MS = 10 * 60 * 1000;
const lastNoted = new Map<string, number>();

/** Whether this relation was already reported in the last ten minutes. Records the report when it was not. */
export function shouldNoteRowCap(table: string, now = Date.now()): boolean {
  const last = lastNoted.get(table);
  if (last !== undefined && now - last < NOTE_EVERY_MS) return false;
  lastNoted.set(table, now);
  return true;
}

/** Test seam: forget every relation reported so far. */
export function resetRowCapNotes(): void {
  lastNoted.clear();
}
