/**
 * The limits on the shared table export, `POST /api/exports/table` (2026-10-26).
 *
 * That route turns the columns and rows a screen already shows into a styled workbook, for about 25
 * screens. It takes the rows from the caller and builds the whole workbook in memory, so until these
 * limits it would take any number of requests, of any size, from anyone signed in: a script could keep
 * a server busy building workbooks for minutes at a time. It still needs only a session — the rows are
 * ones the caller can already see, so there is no permission to add — but now:
 *
 *   - one person may ask for at most 10 exports a minute (`assertExportRateLimit`, under its own
 *     scope, so a burst here never spends the allowance of the other export routes);
 *   - the request may carry at most 10 MB. A declared size over that is refused before the body is
 *     read or anyone is looked up, and a body with no (or a false) size is counted as it is read and
 *     refused the moment it passes the cap. 10 MB is the most that reaches the route anyway — the
 *     proxy in front of every /api route cuts a body there — so nothing that worked before is
 *     refused: what changes is a clear answer instead of a body cut short and an "Export failed.";
 *   - one export holds at most 20,000 rows, answered with a 413 that says so and what to do.
 */

export const TABLE_EXPORT_RATE_LIMIT_SCOPE = "export:table";

/** 10 MB — the same ceiling the proxy puts on a body (`proxyClientMaxBodySize`'s default). */
export const TABLE_EXPORT_MAX_BODY_BYTES = 10 * 1024 * 1024;

export const TABLE_EXPORT_MAX_ROWS = 20_000;

export const TABLE_EXPORT_BODY_TOO_LARGE_MESSAGE =
  "This export is larger than 10 MB, the most one export can carry. Filter the table to fewer rows and export again.";

/** Is a declared Content-Length over the cap? A missing or unreadable header is not (the read is capped too). */
export function tableExportBodyTooLarge(contentLength: string | null): boolean {
  if (contentLength === null || contentLength.trim() === "") return false;
  const length = Number(contentLength);
  return Number.isFinite(length) && length > TABLE_EXPORT_MAX_BODY_BYTES;
}

/** The 413 text for an export over the row cap, or null when the rows fit. */
export function tableExportRowCapMessage(rowCount: number): string | null {
  if (rowCount <= TABLE_EXPORT_MAX_ROWS) return null;
  const count = (value: number) => value.toLocaleString("en-US");
  return (
    `This table has ${count(rowCount)} rows, and one export holds at most ${count(TABLE_EXPORT_MAX_ROWS)}. ` +
    "Filter it to fewer rows and export again."
  );
}

export type TableExportBodyRead =
  | { ok: true; payload: unknown }
  | { error: "invalid_body" | "too_large"; message: string; ok: false; status: 400 | 413 };

/**
 * Read the request body, at most `TABLE_EXPORT_MAX_BODY_BYTES` of it, and only then parse it. The
 * read stops (and the stream is cancelled) as soon as the body passes the cap, so an oversized body
 * with no honest Content-Length is never held whole.
 */
export async function readTableExportBody(request: Request): Promise<TableExportBodyRead> {
  const bytes = await readAtMost(request, TABLE_EXPORT_MAX_BODY_BYTES);
  if (!bytes) {
    return { error: "too_large", message: TABLE_EXPORT_BODY_TOO_LARGE_MESSAGE, ok: false, status: 413 };
  }
  try {
    return { ok: true, payload: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return {
      error: "invalid_body",
      message: "The export request could not be read. Press Export again.",
      ok: false,
      status: 400,
    };
  }
}

async function readAtMost(request: Request, maxBytes: number): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
