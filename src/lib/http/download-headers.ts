/**
 * The cache header every generated download carries — a workbook, a PDF, a template.
 *
 * An export is built for ONE signed-in person from live data: a payroll month, a deductions list,
 * a rep's plans. Without a Cache-Control header the browser (and anything between it and the
 * server) is free to keep the bytes and hand them back later — to the next person on a shared
 * office machine, or to the same person after the data has changed. `private, no-store` says:
 * never keep it anywhere.
 *
 * Spread it first so a route can still add its own headers:
 *
 *     headers: { ...DOWNLOAD_NO_STORE_HEADERS, "Content-Disposition": …, "Content-Type": … }
 *
 * `tests/cache-audit-p3.test.ts` fails any route that sends a Content-Disposition header with no
 * Cache-Control beside it.
 */
export const DOWNLOAD_NO_STORE_HEADERS = { "Cache-Control": "private, no-store" } as const;
