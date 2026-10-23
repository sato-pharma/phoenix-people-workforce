// What /api/telemetry/page-timing will accept from a browser, and nothing else.
//
// WHY IT IS NARROW. The beacon is open to any caller, so everything it stores is decided here: a PAGE
// SHAPE (never a URL with a query, a name or an id) and TWO NUMBERS (milliseconds to first content and to
// largest content). No user id, no name, no business data ever reaches the process-health line, and the
// number of distinct page names is capped so an anonymous script cannot grow the in-process timing map.
//
// Pure, so every rule is tested without a request. No node: imports.

/** A real beacon is ~100 bytes. */
export const PAGE_TIMING_MAX_BODY_BYTES = 1_024;
/** Distinct page shapes the process will keep; the portal has far fewer than this. */
export const PAGE_TIMING_MAX_NAMES = 300;
/** Beacons one address may send per window; a person opens a page every few seconds at most. */
export const PAGE_TIMING_RATE_LIMIT = 60;
export const PAGE_TIMING_RATE_WINDOW_MS = 60_000;
/** Anything above two minutes is a sleeping tab, not a page load. */
export const PAGE_TIMING_MAX_MS = 120_000;

const PAGE_SHAPE = /^\/(employee-portals|admin)(\/([a-z][a-z-]{0,48}|:id)){0,3}$/;

/** `/employee-portals/phoenix-crm/visits?x=1` -> `/employee-portals/phoenix-crm/visits`; ids -> `:id`. Null if not a portal page. */
export function normalisePagePath(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 200) return null;
  const bare = raw.split(/[?#]/)[0]!.toLowerCase().replace(/\/+$/, "");
  const shaped = bare
    .split("/")
    .map((segment) => (/\d/.test(segment) ? ":id" : segment))
    .join("/");
  return PAGE_SHAPE.test(shaped) ? shaped : null;
}

export type PageTimingReport = { path: string; firstContentMs: number | null; largestContentMs: number | null };

function milliseconds(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > PAGE_TIMING_MAX_MS) return null;
  return Math.round(value);
}

/** The report, or null when the path is not a portal page or neither number is usable. Unknown fields are dropped. */
export function sanitizePageTiming(parsed: unknown): PageTimingReport | null {
  if (!parsed || typeof parsed !== "object") return null;
  const body = parsed as Record<string, unknown>;
  const path = normalisePagePath(body.path);
  if (!path) return null;
  const firstContentMs = milliseconds(body.fcp);
  const largestContentMs = milliseconds(body.lcp);
  if (firstContentMs === null && largestContentMs === null) return null;
  return { path, firstContentMs, largestContentMs };
}

/** True when this path may be recorded: already known, or the cap still has room. Adds it when new. */
export function admitPageTimingName(known: Set<string>, path: string): boolean {
  if (known.has(path)) return true;
  if (known.size >= PAGE_TIMING_MAX_NAMES) return false;
  known.add(path);
  return true;
}
