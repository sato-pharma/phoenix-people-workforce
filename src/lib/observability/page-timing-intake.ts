// What /api/telemetry/page-timing will accept from a browser, and nothing else.
//
// WHY IT IS NARROW. The beacon is open to any caller, so everything it stores is decided here: a PAGE
// SHAPE (never a URL with a query, a name or an id), a KIND (a hard load, or a tap inside the app), a
// DEVICE CLASS (low or high, read off the core count and the memory — never a user agent) and
// MILLISECONDS. No user id, no name, no address and no business data reaches the process-health line
// or the page_timings table, and the number of distinct page names is capped so an anonymous script
// cannot grow the in-process map.
//
// Pure, so every rule is tested without a request. No node: imports; the browser beacon imports it too.

import { hrNamespaceRemainder, isHrRewritablePath } from "@/lib/navigation/shell-headers";

/** A hard-load beacon is ~200 bytes; a batch of ten taps is ~700. */
export const PAGE_TIMING_MAX_BODY_BYTES = 1_024;
/** Distinct page shapes the process will keep; the application has about 520 pages. */
export const PAGE_TIMING_MAX_NAMES = 600;
/** Beacons one address may send per window; a person opens a page every few seconds at most. */
export const PAGE_TIMING_RATE_LIMIT = 60;
export const PAGE_TIMING_RATE_WINDOW_MS = 60_000;
/** Anything above two minutes is a sleeping tab, not a page load. */
export const PAGE_TIMING_MAX_MS = 120_000;
/** Taps one beacon may carry. The browser sends a batch at this many, or when the tab hides. */
export const PAGE_TIMING_SOFT_BATCH_LIMIT = 10;

/**
 * The first part of every signed-in page's address, and only those. Every page under them is timed: the
 * portal, the admin shell and the office sections (sales, the workspace, recruitment, attendance, coaching,
 * leave, Customer 360, probation and the rest). Until 19 November 2026 only the portal and the admin shell
 * were kept, so 106 office pages were never timed (enterprise audit, F-PLT-015). Public, print and share
 * pages stay out: login, password set-up and reset, privacy, terms, share, join, print, the connector, dev
 * and the WhatsApp link.
 *
 * tests/page-timings.test.ts reads app/ and fails when a section is added or removed without this list.
 */
export const PAGE_TIMING_SECTIONS: readonly string[] = [
  "employee-portals",
  "admin",
  // The office sections, in app/(admin)/.
  "attendance",
  "business-cards",
  "business-review",
  "coaching",
  "contracts",
  "customer-360",
  "cv-database",
  "cv-lookup",
  "devices",
  "employee-360",
  "employees",
  "hiring-documents",
  "hiring-pack",
  "hr-calendar",
  "hr-reminders",
  "hr-reports",
  "leave-management",
  "mailbox-offboarding",
  "medical-insurance",
  "milestones",
  "new-hire-mailboxes",
  "offers",
  "organogram",
  "payroll",
  "probation",
  "recruitment",
  "reports",
  "resignations",
  "retention",
  "sales",
  "spotlight",
  "workspace",
  // Signed-in pages at the top of app/.
  "employee",
  "marketing-requests",
  "overview",
  "payslips",
];

/**
 * Page names that hold a digit and are not ids. Every other part holding a digit is an id and becomes
 * `:id`; before 19 November 2026 these two did too, so the Employee 360 pages were filed as `:id`.
 */
export const PAGE_TIMING_DIGIT_PAGE_NAMES: readonly string[] = ["customer-360", "employee-360"];

/** Parts after the section. The deepest page today has four (a rep's day: `/admin/field-crm/day/:id/:id`). */
const PAGE_TIMING_MAX_DEPTH = 5;

const SECTIONS = new Set(PAGE_TIMING_SECTIONS);
const DIGIT_PAGE_NAMES = new Set(PAGE_TIMING_DIGIT_PAGE_NAMES);
const PAGE_NAME = /^[a-z][a-z-]{0,48}$/;

/**
 * `/employee-portals/phoenix-crm/visits?x=1` -> `/employee-portals/phoenix-crm/visits`; ids -> `:id`.
 * Null if the page is not a signed-in page, is deeper than the application goes, or has a part that is
 * neither a page name nor an id.
 *
 * An `/hr` address is filed as the page it serves: the HR seats (HR Operations, HR Resourcing) browse
 * every page under `/hr/…`, which `proxy.ts` rewrites to the bare page, so `/hr/employees/record-gaps`
 * is `/employees/record-gaps`. Until 19 Nov 2026 the `hr` part was read as an unknown section and every
 * HR seat's page was dropped — 11 page views that morning, none timed. `/hr/api/…` is not a page and
 * stays refused, and `/hr/login` is still the public login.
 */
export function normalisePagePath(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 200) return null;
  const asked = raw.split(/[?#]/)[0]!.toLowerCase().replace(/\/+$/, "");
  if (!asked.startsWith("/")) return null;
  const bare = isHrRewritablePath(asked) ? hrNamespaceRemainder(asked) : asked;
  const [section, ...rest] = bare.slice(1).split("/");
  if (!section || !SECTIONS.has(section) || rest.length > PAGE_TIMING_MAX_DEPTH) return null;
  const shaped = [section];
  for (const part of rest) {
    if (DIGIT_PAGE_NAMES.has(part)) shaped.push(part);
    else if (/\d/.test(part)) shaped.push(":id");
    else if (PAGE_NAME.test(part)) shaped.push(part);
    else return null;
  }
  return `/${shaped.join("/")}`;
}

/** `hard`: the document loaded (a sign-in, a bookmark, a reload). `soft`: a tap inside the app reached its page. */
export type PageTimingKind = "hard" | "soft";
/** `low`: four cores or fewer, or 4 GB or less — a rep's phone. `high`: more. `unknown`: the browser said neither. */
export type PageTimingDevice = "high" | "low" | "unknown";
/**
 * ttfb: the first byte · fcp: the first content painted · lcp: the largest content painted (the page looks
 * ready) · interactive: the document is parsed and the app can take a tap · first_data: the first answer
 * to the page's own data read landed (isPageDataRequest) · soft: a tap inside the app to its page rendering.
 * All in milliseconds.
 */
export type PageTimingMetric = "fcp" | "first_data" | "interactive" | "lcp" | "soft" | "ttfb";
export const PAGE_TIMING_METRICS: readonly PageTimingMetric[] = ["ttfb", "fcp", "lcp", "interactive", "first_data", "soft"];

export type PageTimingReport = {
  device: PageTimingDevice;
  kind: PageTimingKind;
  metrics: Partial<Record<PageTimingMetric, number>>;
  path: string;
};

/** The API families the shell calls on every page, whatever page it is. */
const SHELL_API_FAMILIES = ["/api/auth", "/api/activity", "/api/telemetry", "/api/notifications", "/api/messages", "/api/navigation"];
/** The sidebar's badges: `/api/approvals-hub/pending-count`, `/api/direct-orders/unbooked-count`. */
const SHELL_BADGE_ENDPOINT = /-count$/;

/**
 * True when this resource is the page's own data read: an API call on this site that is not the shell's
 * heartbeat, activity beacon, bell, envelope, navigation or sidebar badges. Those answer first on every
 * page, so counting them would report the heartbeat's speed as the moment the page had its data.
 */
export function isPageDataRequest(resourceUrl: string, origin: string): boolean {
  let url: URL;
  try {
    url = new URL(resourceUrl, origin);
  } catch {
    return false;
  }
  if (url.origin !== origin || !url.pathname.startsWith("/api/")) return false;
  if (SHELL_BADGE_ENDPOINT.test(url.pathname)) return false;
  return !SHELL_API_FAMILIES.some((family) => url.pathname === family || url.pathname.startsWith(`${family}/`));
}

/** Four cores or fewer, or 4 GB or less, is a rep's phone. Neither figure offered: unknown, never a guess. */
export function deviceClassOf(reading: { deviceMemory?: unknown; hardwareConcurrency?: unknown }): PageTimingDevice {
  const cores = typeof reading.hardwareConcurrency === "number" ? reading.hardwareConcurrency : null;
  const memory = typeof reading.deviceMemory === "number" ? reading.deviceMemory : null;
  if (cores === null && memory === null) return "unknown";
  return (cores !== null && cores <= 4) || (memory !== null && memory <= 4) ? "low" : "high";
}

/** The hard-load body's number fields, and the metric each feeds. */
const HARD_FIELDS: ReadonlyArray<readonly [key: string, metric: PageTimingMetric]> = [
  ["ttfb", "ttfb"],
  ["fcp", "fcp"],
  ["lcp", "lcp"],
  ["interactive", "interactive"],
  ["firstData", "first_data"],
];

function milliseconds(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > PAGE_TIMING_MAX_MS) return null;
  return Math.round(value);
}

/** The device class as the body spelt it; anything else is `unknown`, never a guess. */
export function pageTimingDevice(value: unknown): PageTimingDevice {
  return value === "low" || value === "high" ? value : "unknown";
}

function hardReport(body: Record<string, unknown>, device: PageTimingDevice): PageTimingReport | null {
  const path = normalisePagePath(body.path);
  if (!path) return null;
  const metrics: PageTimingReport["metrics"] = {};
  for (const [key, metric] of HARD_FIELDS) {
    const ms = milliseconds(body[key]);
    if (ms !== null) metrics[metric] = ms;
  }
  return Object.keys(metrics).length > 0 ? { device, kind: "hard", metrics, path } : null;
}

/**
 * The reports one beacon carries, or none. A body is
 * `{ device, hard?: { path, ttfb, fcp, lcp, interactive, firstData }, soft?: [{ path, ms }] }`; the first
 * beacon put the hard load's `path`, `fcp` and `lcp` at the top level, and a browser holding that bundle
 * for a day still sends it. Unknown fields are dropped; a path outside the signed-in sections, a
 * negative or absurd number, a tap with no page and anything past the tap limit are refused.
 */
export function sanitizePageTimings(parsed: unknown): PageTimingReport[] {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const body = parsed as Record<string, unknown>;
  const device = pageTimingDevice(body.device);
  const reports: PageTimingReport[] = [];
  const hard = body.hard && typeof body.hard === "object" && !Array.isArray(body.hard)
    ? (body.hard as Record<string, unknown>)
    : "path" in body
      ? body
      : null;
  if (hard) {
    const report = hardReport(hard, device);
    if (report) reports.push(report);
  }
  if (Array.isArray(body.soft)) {
    for (const item of body.soft.slice(0, PAGE_TIMING_SOFT_BATCH_LIMIT)) {
      if (!item || typeof item !== "object") continue;
      const tap = item as Record<string, unknown>;
      const path = normalisePagePath(tap.path);
      const ms = milliseconds(tap.ms);
      if (path && ms !== null) reports.push({ device, kind: "soft", metrics: { soft: ms }, path });
    }
  }
  return reports;
}

/** True when this path may be recorded: already known, or the cap still has room. Adds it when new. */
export function admitPageTimingName(known: Set<string>, path: string): boolean {
  if (known.has(path)) return true;
  if (known.size >= PAGE_TIMING_MAX_NAMES) return false;
  known.add(path);
  return true;
}
