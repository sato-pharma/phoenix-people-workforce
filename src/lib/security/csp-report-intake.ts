/**
 * REPORT-ONLY CONTENT SECURITY POLICY REPORTS (S01, F-PLT-011, 13 Nov 2026).
 *
 * A page carries `pageReportOnlyContentSecurityPolicy` (content-security-policy.ts) beside its enforced
 * policy, and the browser reports what that stricter policy WOULD have blocked to
 * app/api/security/csp-report/route.ts. These are the pure parts: reading both report formats, and
 * reducing each report to three words that carry no person and no secret.
 *
 *   directive  one of the measured directives, or the report is dropped
 *   blocked    `inline`, `eval`, `data`, `blob`, or the blocked address's ORIGIN only — never its path
 *              or query, which can carry a signed storage token
 *   page       the page's SHAPE (an id becomes `:id`), or `srcdoc` for a document written into a frame
 *
 * Nothing here touches a database. The route counts each shape in process memory and logs it the
 * first time and at every tenth power, so the measurement costs a log line, never a query.
 */

/** A browser batches; a batch bigger than this is refused unread. */
export const CSP_REPORT_MAX_BODY_BYTES = 32 * 1024;
/** Reports one address may send a minute. A page with many inline styles sends one per element. */
export const CSP_REPORT_RATE_LIMIT = 120;
export const CSP_REPORT_RATE_WINDOW_MS = 60_000;
/** Distinct (directive, blocked, page) shapes one process counts; past this a new shape is not kept. */
export const CSP_REPORT_MAX_SHAPES = 500;
/** Reports read from one batch. */
const MAX_REPORTS_PER_BATCH = 50;

const MEASURED_DIRECTIVES = new Set(["style-src", "style-src-elem", "style-src-attr", "img-src"]);

export type CspViolation = {
  directive: string;
  blocked: string;
  page: string;
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** `style-src-elem 'self' …` (an old browser's violated-directive) -> `style-src-elem`. */
function directiveOf(value: string): string | null {
  const name = value.split(/\s+/)[0]?.toLowerCase() ?? "";
  return MEASURED_DIRECTIVES.has(name) ? name : null;
}

/** What was blocked, reduced to a keyword or an origin. */
export function blockedSourceOf(value: string): string {
  const lower = value.toLowerCase();
  if (lower === "" || lower === "inline" || lower === "self") return "inline";
  if (lower === "eval" || lower === "wasm-eval") return "eval";
  if (lower === "data" || lower.startsWith("data:")) return "data";
  if (lower === "blob" || lower.startsWith("blob:")) return "blob";
  try {
    const url = new URL(value);
    if (url.protocol === "https:" || url.protocol === "http:") return url.origin.toLowerCase();
  } catch {
    // Not an address: fall through.
  }
  return "other";
}

/** `/admin/employees/B-10?tab=x` -> `/admin/employees/:id`; a frame's written document -> `srcdoc`. */
export function pageShapeOf(value: string): string {
  if (value === "about:srcdoc") return "srcdoc";
  if (value.startsWith("about:")) return "about";
  if (value.startsWith("blob:")) return "blob";
  let pathname: string;
  try {
    pathname = new URL(value).pathname;
  } catch {
    return "other";
  }
  const shaped = pathname
    .toLowerCase()
    .replace(/\/+$/, "")
    .split("/")
    .slice(0, 6)
    .map((segment) => (/\d/.test(segment) || segment.length > 40 || !/^[a-z0-9._-]*$/.test(segment) ? ":id" : segment))
    .join("/");
  return shaped === "" ? "/" : shaped;
}

/**
 * One violation from either format, or null when it is not one this policy measures:
 *
 *   report-uri   { "csp-report": { "document-uri", "violated-directive", "effective-directive",
 *                  "blocked-uri", "disposition" } }                         (Firefox, Safari)
 *   report-to    [{ "type": "csp-violation", "body": { "documentURL", "effectiveDirective",
 *                  "blockedURL", "disposition" } }, …]                       (Chromium)
 *
 * Only a REPORT disposition is read: an enforced policy's violation is not ours to count here.
 */
function violationOf(body: Record<string, unknown>): CspViolation | null {
  const disposition = text(body.disposition ?? "report").toLowerCase();
  if (disposition !== "report") return null;
  const directive = directiveOf(
    text(body.effectiveDirective ?? body["effective-directive"]) || text(body["violated-directive"]),
  );
  if (!directive) return null;
  return {
    directive,
    blocked: blockedSourceOf(text(body.blockedURL ?? body["blocked-uri"])),
    page: pageShapeOf(text(body.documentURL ?? body["document-uri"])),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseCspReports(parsed: unknown): CspViolation[] {
  const out: CspViolation[] = [];
  if (isRecord(parsed) && isRecord(parsed["csp-report"])) {
    const violation = violationOf(parsed["csp-report"]);
    if (violation) out.push(violation);
    return out;
  }
  if (!Array.isArray(parsed)) return out;
  for (const entry of parsed.slice(0, MAX_REPORTS_PER_BATCH)) {
    if (!isRecord(entry) || entry.type !== "csp-violation" || !isRecord(entry.body)) continue;
    const violation = violationOf(entry.body);
    if (violation) out.push(violation);
  }
  return out;
}

/**
 * Counts a violation's shape; answers the new count when it should be logged (the first sighting and
 * 10, 100, 1,000 …), null otherwise. A full map keeps counting what it holds and drops new shapes.
 */
export function countCspViolation(counts: Map<string, number>, violation: CspViolation): number | null {
  const key = `${violation.directive} ${violation.blocked} ${violation.page}`;
  const previous = counts.get(key);
  if (previous === undefined && counts.size >= CSP_REPORT_MAX_SHAPES) return null;
  const next = (previous ?? 0) + 1;
  counts.set(key, next);
  return /^10*$/.test(String(next)) ? next : null;
}
