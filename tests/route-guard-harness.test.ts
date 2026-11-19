import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { permissionMatrix, phoenixRoles, retiredPhoenixRoles, type PhoenixRole } from "../src/lib/auth/permissions.ts";
import {
  findAccessRegistryEntry,
  normalizeRoutePattern,
  type AccessRegistryEntry,
  type HttpMethod,
  type PermissionRequirement,
} from "../src/lib/security/access-registry.ts";

// THE ROUTE GUARD HARNESS (REC-080, 19 Nov 2026). Every route file under app/api that changes data is
// CALLED — its real POST, PATCH, PUT and DELETE handlers, through Next's own request scope — once as a
// signed-out visitor and once as a role that should be refused, and each call must be refused before it
// writes anything. The expected answer comes from the access registry (src/lib/security/access-registry.ts):
//
//   - a signed-in route refuses the signed-out visitor with 401 or 403;
//   - a route that declares a permission refuses the first role holding NONE of it with 401 or 403
//     (Medical Rep first, then the other seats in the order below);
//   - a route that declares no permission (it checks the caller's own record) is called with a role
//     and no HR id, and must answer 400 or above;
//   - a scheduled-job, webhook or machine route, called without its secret, must answer 400 or above;
//   - a public link route, called with a link that does not exist, must write nothing;
//   - a dev-only route is skipped: the harness itself runs with NODE_ENV=development, which opens it.
//
// Every call, whatever its answer, must leave ZERO writes (a database insert, update, delete or function
// call other than the meter and the refusal's audit row, a storage or sign-in change) and ZERO calls to any
// other host. The database is a stand-in that answers like an empty PostgREST; nothing leaves the machine
// and no environment file is read (.env.local points at PRODUCTION).
//
// An answer that breaks the rule fails this test unless it is listed below WITH ITS REASON — so a route
// that starts allowing more than its registry entry says goes red the day it changes. A listed answer
// that has since improved prints a note and never fails: a red suite on main holds the production deploy.
//
// The work is split into PART_COUNT registrations, each one child process over one slice of the route
// files, because the hang watch stops any single test after 180 s (scripts/run-tests-sharded-shard.mjs).

const PART_COUNT = 16;
const MUTATING: readonly HttpMethod[] = ["POST", "PATCH", "PUT", "DELETE"];
const PLACEHOLDER_ID = "00000000-0000-4000-8000-000000000000";
const NOBODY_HR_ID = "GUARD-HARNESS-NOBODY";
const SLICE_TIMEOUT_MS = 165_000;
const DRIVER = "tests/support/route-guard-driver.mjs";
const STAND_IN_SUPABASE = "https://guard-harness.invalid";

/** Function calls that are not writes of business data: the request meter. */
const INFRASTRUCTURE_RPCS: Readonly<Record<string, string>> = {
  api_rate_limit_consume: "the shared request meter counts the call before any check; it stores no business data",
  phx_auth_session_bundle: "the login check itself (read-only)",
};

/** Read-only database functions (`language sql stable`): calling one reads, it never writes. */
const READ_ONLY_RPCS: Readonly<Record<string, string>> = {
  phx_marketing_roi_latest_validated_period: "the ROI reports' sales-loaded-through month (stable, read-only)",
};

/** Tables a refused call may write to. */
const INFRASTRUCTURE_TABLES: Readonly<Record<string, string>> = {
  api_rate_limit_buckets: "the request meter's fallback store",
  audit_logs: "a refusal is recorded in the audit log by design",
};

// ── The known gaps, by kind ──────────────────────────────────────────────────────────────────────────
// Each reason was read off the route's own answer in the harness run of 19 Nov 2026; apart from the four
// WRITE_GAPS lines nothing was written, and nothing was sent anywhere. The first kinds are follow-up work: the route judges its input
// before it refuses the caller, so a stranger learns whether a body is good. The seventeen calls that looked
// their record up first (the interview calendar, a company calendar event, a marketing conversation) now refuse
// a signed-out caller before any lookup, and are judged like every other route.
const BODY_FIRST = "answers 400 on the harness's empty body before any refusal of this caller; nothing is written";
const MARKETING_ROLE_LIST =
  "the real gate is the marketing role list (assertMarketingWorkspaceAccess), which admits the Financial Advisor — " +
  "the registry's expenses label is not what the route checks; answers 400 on the empty body, nothing is written";
const PLANS_MOVED = "a retired weekly Plans endpoint: answers 409 (plans moved) to everyone before any check; nothing is written";
const REFUSAL_AS_400 = "the refusal itself (Forbidden: Employee cannot create …) is answered 400 instead of 403; nothing is written";
const INPUT_AS_500 = "the interview calendar judges the body before the caller and answers its own input refusal as 500; nothing is written";
const MULTIPART_FIRST =
  "reads the body as multipart form data before it refuses the caller, so the harness's JSON body throws a 500; nothing is written";
const SIGN_IN_AS_500 = "the sign-in refusal (Authentication is required) is answered as a 500 AI failure instead of 401; nothing is written";
const ROI_READ_ONLY =
  "a read-only report that uses POST only to carry its filter: the Medical Rep is a marketing role and sees only their own " +
  "requests, and with no HR id that is none, so 200 with no rows";
const BEACON_204 = "a page beacon that answers 204 to everyone by design, so a page never sees an error; with no signed-in seat it records nothing";
const SEAT_VIEW_EXIT = "leaving a seat view always succeeds by design: it clears the caller's own seat-view cookie and writes nothing without a seat view";
const OWN_LAYOUT = "resets the caller's own sidebar layout; with no HR id there is no layout to reset, so 200 with nothing written";
const OWN_DEVICE = "registers the caller's own phone for push; with no HR id it skips (200, skipped) and writes nothing";
const TEST_TO_SELF =
  "sends a test notice to the caller themselves; the harness's caller has no HR id, so it records the notice and its " +
  "delivery rows with no recipient, and nothing leaves the machine";
const PASSKEY_CHALLENGE =
  "the first step of a passkey sign-in: it clears expired challenges and stores a one-time challenge for the browser to " +
  "sign; there is no session yet, by design";

/**
 * Answers that do not meet the rule but are known and explained — `"<METHOD> <route> <caller>"` → reason.
 * The call must still write nothing; a write needs its own line in WRITE_GAPS.
 */
const ANSWER_GAPS: Readonly<Record<string, string>> = {
  // BODY_FIRST (81)
  "PATCH /api/admin/business-card-requests refused-role": BODY_FIRST,
  "PATCH /api/admin/business-card-requests signed-out": BODY_FIRST,
  "PATCH /api/admin/support-requests refused-role": BODY_FIRST,
  "PATCH /api/admin/support-requests signed-out": BODY_FIRST,
  "PATCH /api/employee-portal/account-activation refused-role": BODY_FIRST,
  "PATCH /api/marketing-requests/control signed-out": BODY_FIRST,
  "PATCH /api/marketing-requests/pharmacy-code-recheck signed-out": BODY_FIRST,
  "PATCH /api/recruitment/interview-calendar/bookings/:id/outcome signed-out": BODY_FIRST,
  "POST /api/admin/outstation/:id/evidence refused-role": BODY_FIRST,
  "POST /api/admin/outstation/:id/evidence signed-out": BODY_FIRST,
  "POST /api/admin/outstation/:id/journey-stop refused-role": BODY_FIRST,
  "POST /api/admin/outstation/:id/journey-stop signed-out": BODY_FIRST,
  "POST /api/admin/outstation/:id/recalculate-distance refused-role": BODY_FIRST,
  "POST /api/admin/outstation/:id/recalculate-distance signed-out": BODY_FIRST,
  "POST /api/admin/outstation/:id/reminder refused-role": BODY_FIRST,
  "POST /api/admin/outstation/:id/reminder signed-out": BODY_FIRST,
  "POST /api/admin/outstation/:id/workload refused-role": BODY_FIRST,
  "POST /api/admin/outstation/:id/workload signed-out": BODY_FIRST,
  "POST /api/approvals/bulk-decision signed-out": BODY_FIRST,
  "POST /api/automated-payroll/runs signed-out": BODY_FIRST,
  "POST /api/automated-payroll/runs/:runId/steps/:stepKey/confirm signed-out": BODY_FIRST,
  "POST /api/automated-payroll/runs/:runId/steps/:stepKey/import signed-out": BODY_FIRST,
  "POST /api/automated-payroll/settings/carry-late-expenses signed-out": BODY_FIRST,
  "POST /api/contracts/:id/workflow refused-role": BODY_FIRST,
  "POST /api/contracts/:id/workflow signed-out": BODY_FIRST,
  "POST /api/customer-pharmacy-mapping/:id/decision signed-out": BODY_FIRST,
  "POST /api/devices refused-role": BODY_FIRST,
  "POST /api/devices signed-out": BODY_FIRST,
  "POST /api/direct-orders/:id/decision refused-role": BODY_FIRST,
  "POST /api/direct-orders/:id/decision signed-out": BODY_FIRST,
  "POST /api/direct-orders/held/decision refused-role": BODY_FIRST,
  "POST /api/direct-orders/held/decision signed-out": BODY_FIRST,
  "POST /api/direct-orders/pharmacies/registry refused-role": BODY_FIRST,
  "POST /api/direct-orders/pharmacies/registry signed-out": BODY_FIRST,
  "POST /api/direct-orders/pharmacy-validations/:id/decision refused-role": BODY_FIRST,
  "POST /api/direct-orders/pharmacy-validations/:id/decision signed-out": BODY_FIRST,
  "POST /api/dispute-center/cases/:kind/:ref/assist signed-out": BODY_FIRST,
  "POST /api/dispute-center/cases/:kind/:ref/decide signed-out": BODY_FIRST,
  "POST /api/dispute-center/cases/:kind/:ref/messages signed-out": BODY_FIRST,
  "POST /api/dispute-center/cases/:kind/:ref/reopen signed-out": BODY_FIRST,
  "POST /api/excuses/:id/decision signed-out": BODY_FIRST,
  "POST /api/excuses/:id/reassign signed-out": BODY_FIRST,
  "POST /api/mailbox-offboarding refused-role": BODY_FIRST,
  "POST /api/mailbox-offboarding signed-out": BODY_FIRST,
  "POST /api/market-awareness/:activityId/decision refused-role": BODY_FIRST,
  "POST /api/market-awareness/:activityId/decision signed-out": BODY_FIRST,
  "POST /api/marketing-requests/:id/decision signed-out": BODY_FIRST,
  "POST /api/marketing-requests/:id/license-verdict signed-out": BODY_FIRST,
  "POST /api/marketing-requests/ceo-approvals/export signed-out": BODY_FIRST,
  "POST /api/marketing-requests/finance-hold signed-out": BODY_FIRST,
  "POST /api/marketing-requests/list-check/decide signed-out": BODY_FIRST,
  "POST /api/payroll/:id/workflow refused-role": BODY_FIRST,
  "POST /api/payroll/:id/workflow signed-out": BODY_FIRST,
  "POST /api/private-calendar/disputes/:id/decide refused-role": BODY_FIRST,
  "POST /api/private-calendar/disputes/:id/decide signed-out": BODY_FIRST,
  "POST /api/private-calendar/disputes/decide-many refused-role": BODY_FIRST,
  "POST /api/private-calendar/disputes/decide-many signed-out": BODY_FIRST,
  "POST /api/probation/scorecards refused-role": BODY_FIRST,
  "POST /api/resignations/:id/workflow refused-role": BODY_FIRST,
  "POST /api/resignations/:id/workflow signed-out": BODY_FIRST,
  "POST /api/sales/imports/:id/:action refused-role": BODY_FIRST,
  "POST /api/sales/imports/:id/:action signed-out": BODY_FIRST,
  "POST /api/support/requests refused-role": BODY_FIRST,
  "POST /api/territory-management/area-consolidation/:areaId/apply signed-out": BODY_FIRST,
  "POST /api/vacations/requests/:id/assign refused-role": BODY_FIRST,
  "POST /api/vacations/requests/:id/assign signed-out": BODY_FIRST,
  "POST /api/vacations/requests/:id/decision refused-role": BODY_FIRST,
  "POST /api/vacations/requests/:id/decision signed-out": BODY_FIRST,
  "POST /api/weekly-plans/:id/decision refused-role": BODY_FIRST,
  "POST /api/weekly-plans/:id/decision signed-out": BODY_FIRST,
  "POST /api/weekly-plans/:id/edit-request-decision refused-role": BODY_FIRST,
  "POST /api/weekly-plans/:id/edit-request-decision signed-out": BODY_FIRST,
  "POST /api/weekly-plans/:id/move-period refused-role": BODY_FIRST,
  "POST /api/weekly-plans/:id/move-period signed-out": BODY_FIRST,
  "POST /api/weekly-plans/:id/reassign refused-role": BODY_FIRST,
  "POST /api/weekly-plans/:id/reassign signed-out": BODY_FIRST,
  "POST /api/weekly-plans/:id/visit-details refused-role": BODY_FIRST,
  "POST /api/weekly-plans/:id/visit-details signed-out": BODY_FIRST,
  "POST /api/weekly-plans/decisions/batch refused-role": BODY_FIRST,
  "POST /api/weekly-plans/decisions/batch signed-out": BODY_FIRST,
  "PUT /api/automated-payroll/runs/:runId/steps/:stepKey signed-out": BODY_FIRST,
  // MARKETING_ROLE_LIST (5)
  "PATCH /api/marketing-requests/control refused-role": MARKETING_ROLE_LIST,
  "POST /api/marketing-requests/:id/comment refused-role": MARKETING_ROLE_LIST,
  "POST /api/marketing-requests/:id/decision refused-role": MARKETING_ROLE_LIST,
  "POST /api/marketing-requests/ceo-approvals/export refused-role": MARKETING_ROLE_LIST,
  "POST /api/marketing-requests/list-check/decide refused-role": MARKETING_ROLE_LIST,
  // PLANS_MOVED (14)
  "PATCH /api/weekly-plans/:id refused-role": PLANS_MOVED,
  "PATCH /api/weekly-plans/:id signed-out": PLANS_MOVED,
  "POST /api/weekly-plans refused-role": PLANS_MOVED,
  "POST /api/weekly-plans signed-out": PLANS_MOVED,
  "POST /api/weekly-plans/:id/acknowledge refused-role": PLANS_MOVED,
  "POST /api/weekly-plans/:id/acknowledge signed-out": PLANS_MOVED,
  "POST /api/weekly-plans/:id/cancel refused-role": PLANS_MOVED,
  "POST /api/weekly-plans/:id/cancel signed-out": PLANS_MOVED,
  "POST /api/weekly-plans/:id/comments refused-role": PLANS_MOVED,
  "POST /api/weekly-plans/:id/comments signed-out": PLANS_MOVED,
  "POST /api/weekly-plans/:id/request-edit refused-role": PLANS_MOVED,
  "POST /api/weekly-plans/:id/request-edit signed-out": PLANS_MOVED,
  "POST /api/weekly-plans/:id/request-visit-details refused-role": PLANS_MOVED,
  "POST /api/weekly-plans/:id/request-visit-details signed-out": PLANS_MOVED,
  // REFUSAL_AS_400 (2)
  "POST /api/business-card-requests signed-out": REFUSAL_AS_400,
  "POST /api/support/requests signed-out": REFUSAL_AS_400,
  // INPUT_AS_500 (3)
  "POST /api/recruitment/interview-calendar/bookings signed-out": INPUT_AS_500,
  "POST /api/recruitment/interview-calendar/requests/:id/schedule signed-out": INPUT_AS_500,
  "POST /api/recruitment/interview-calendar/sessions signed-out": INPUT_AS_500,
  // MULTIPART_FIRST (4)
  "POST /api/marketing-requests/bulk-upload refused-role": MULTIPART_FIRST,
  "POST /api/marketing-requests/finance-evidence refused-role": MULTIPART_FIRST,
  "POST /api/marketing-requests/finance-evidence signed-out": MULTIPART_FIRST,
  "POST /api/recruitment/interview-calendar/bookings/:id/cv signed-out": MULTIPART_FIRST,
  // SIGN_IN_AS_500 (1)
  "POST /api/recruitment/candidates/:id/cv-extract signed-out": SIGN_IN_AS_500,
  // ROI_READ_ONLY (5)
  "POST /api/marketing-requests/coverage-report refused-role": ROI_READ_ONLY,
  "POST /api/marketing-requests/coverage-report/export refused-role": ROI_READ_ONLY,
  "POST /api/marketing-requests/roi-tracker refused-role": ROI_READ_ONLY,
  "POST /api/marketing-requests/roi-tracking refused-role": ROI_READ_ONLY,
  "POST /api/marketing-requests/roi-tracking/export refused-role": ROI_READ_ONLY,
  // BEACON_204 (8)
  "POST /api/activity/track refused-role": BEACON_204,
  "POST /api/activity/track signed-out": BEACON_204,
  "POST /api/phoenix-crm/notices/seen refused-role": BEACON_204,
  "POST /api/phoenix-crm/notices/seen signed-out": BEACON_204,
  "POST /api/phoenix-crm/refused-readings refused-role": BEACON_204,
  "POST /api/phoenix-crm/refused-readings signed-out": BEACON_204,
  "POST /api/phoenix-crm/visit-resend-report refused-role": BEACON_204,
  "POST /api/phoenix-crm/visit-resend-report signed-out": BEACON_204,
  // SEAT_VIEW_EXIT (2)
  "POST /api/admin/seat-view/exit refused-role": SEAT_VIEW_EXIT,
  "POST /api/admin/seat-view/exit signed-out": SEAT_VIEW_EXIT,
  // OWN_LAYOUT (1)
  "DELETE /api/navigation/personal-layout refused-role": OWN_LAYOUT,
  // OWN_DEVICE (1)
  "POST /api/notifications/push/register refused-role": OWN_DEVICE,
  // TEST_TO_SELF (2)
  "POST /api/integrations/telegram/test refused-role": TEST_TO_SELF,
  "POST /api/notifications/push/test refused-role": TEST_TO_SELF,
};

/** Writes a call is known to make before it is refused — key as above → the tables and the reason. */
const WRITE_GAPS: Readonly<Record<string, { reason: string; targets: readonly string[] }>> = {
  "POST /api/auth/biometric/login/options refused-role": { reason: PASSKEY_CHALLENGE, targets: ["app_auth_webauthn_challenges"] },
  "POST /api/auth/biometric/login/options signed-out": { reason: PASSKEY_CHALLENGE, targets: ["app_auth_webauthn_challenges"] },
  "POST /api/integrations/telegram/test refused-role": { reason: TEST_TO_SELF, targets: ["notification_events", "notification_deliveries"] },
  "POST /api/notifications/push/test refused-role": { reason: TEST_TO_SELF, targets: ["notification_events", "notification_deliveries"] },
};

/** Route files the harness cannot call at all — `"<route>"` → reason. */
// Empty since 19 Nov 2026. Six routes sat here until the reply template imported the email layout by
// the alias the test loader stubs (it used a relative .tsx path) and the stub gained the data grid the
// production-planning sweeps render. Every route file is now called.
const NOT_CALLABLE: Readonly<Record<string, string>> = {};

// ── The Early Birds decision (F-CRM-016) ─────────────────────────────────────────────────────────────
// Until 19 Nov 2026 it checked only that the district was inside the caller's Early Birds scope, AFTER
// reading the body, so a `{}` body answered 400 invalid_decision whoever sent it. Pull request 566 put
// early_birds:approve first, so the harness judges it like every other signed-in route (401/403 from
// both callers), and the ratchet test below goes red if the line is ever taken out again while the
// fix's own test still exists.
const EARLY_BIRDS_ROUTE_FILE = "app/api/approvals/early-bird/[id]/decision/route.ts";
const EARLY_BIRDS_ROUTE = "/api/approvals/early-bird/:id/decision";
const EARLY_BIRDS_GUARD = `assertPermission(access, "early_birds", "approve")`;
const EARLY_BIRDS_FIX_TEST = "tests/early-birds-decision-permission.test.ts";

function earlyBirdsGuardInPlace(): boolean {
  return existsSync(EARLY_BIRDS_ROUTE_FILE) && readFileSync(EARLY_BIRDS_ROUTE_FILE, "utf8").includes(EARLY_BIRDS_GUARD);
}

// ── The routes ───────────────────────────────────────────────────────────────────────────────────────
type Caller = "signed-out" | "refused-role";
type Expectation = "refusal" | "rejection" | "no-write" | "skip";

type PlannedCall = {
  callers: { headers: Record<string, string>; label: Caller }[];
  expectations: Record<Caller, Expectation>;
  method: HttpMethod;
  refusedRole: string | null;
};

type Job = {
  calls: PlannedCall[];
  file: string;
  params: Record<string, string>;
  route: string;
  urlPath: string;
};

function walkRouteFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return walkRouteFiles(fullPath);
    return entry.name === "route.ts" ? [fullPath] : [];
  });
}

function mutatingMethods(source: string): HttpMethod[] {
  const found = new Set<HttpMethod>();
  for (const match of source.matchAll(/export\s+(?:async\s+)?(?:function|const)\s+(POST|PATCH|PUT|DELETE)\b/g)) {
    found.add(match[1] as HttpMethod);
  }
  return MUTATING.filter((method) => found.has(method));
}

const ROLE_PREFERENCE: readonly PhoenixRole[] = [
  "Medical Rep",
  "Employee",
  ...phoenixRoles.filter((role) => role !== "Medical Rep" && role !== "Employee" && role !== "Super Admin" && !retiredPhoenixRoles.has(role)),
];

function requirementsOf(entry: AccessRegistryEntry): PermissionRequirement[] {
  if (!entry.permission) return [];
  return (Array.isArray(entry.permission) ? entry.permission : [entry.permission]) as PermissionRequirement[];
}

function holds(role: PhoenixRole, requirement: PermissionRequirement): boolean {
  const grants = (permissionMatrix[role] as Record<string, readonly string[] | undefined>)[requirement.resource];
  return grants?.includes(requirement.action) ?? false;
}

/** The first role, in preference order, holding none of the entry's declared permissions. */
function refusedRoleFor(entry: AccessRegistryEntry): PhoenixRole | null {
  const requirements = requirementsOf(entry);
  if (requirements.length === 0) return null;
  return ROLE_PREFERENCE.find((role) => requirements.every((requirement) => !holds(role, requirement))) ?? null;
}

const BASE_HEADERS: Record<string, string> = {
  "content-type": "application/json",
  host: "localhost:3000",
  origin: "http://localhost:3000",
};

function planCall(route: string, method: HttpMethod): PlannedCall {
  const entry = findAccessRegistryEntry(route, method) as AccessRegistryEntry | null;
  const refusedRole = entry ? refusedRoleFor(entry) : null;
  const roleHeaders: Record<string, string> = refusedRole
    ? { ...BASE_HEADERS, "x-phoenix-hr-id": NOBODY_HR_ID, "x-phoenix-role": refusedRole }
    : { ...BASE_HEADERS, "x-phoenix-role": "Medical Rep" };
  const callers: PlannedCall["callers"] = [
    { headers: { ...BASE_HEADERS }, label: "signed-out" },
    { headers: roleHeaders, label: "refused-role" },
  ];

  let expectations: Record<Caller, Expectation>;
  if (!entry || entry.authMode === "session") {
    expectations = { "refused-role": refusedRole ? "refusal" : "rejection", "signed-out": "refusal" };
  } else if (entry.authMode === "dev-only") {
    expectations = { "refused-role": "skip", "signed-out": "skip" };
  } else if (entry.authMode === "public-token") {
    expectations = { "refused-role": "no-write", "signed-out": "no-write" };
  } else {
    expectations = { "refused-role": "rejection", "signed-out": "rejection" };
  }
  return {
    callers: callers.filter((caller) => expectations[caller.label] !== "skip"),
    expectations,
    method,
    refusedRole: refusedRole ?? (entry?.authMode === "session" ? "Medical Rep (no HR id)" : null),
  };
}

function urlFor(relativeFile: string): { params: Record<string, string>; urlPath: string } {
  const params: Record<string, string> = {};
  const segments = path
    .dirname(relativeFile)
    .replace(/\\/g, "/")
    .replace(/^app\//, "")
    .split("/")
    .filter((segment) => segment && !/^\(.*\)$/.test(segment))
    .map((segment) => {
      const dynamic = /^\[(.+)\]$/.exec(segment);
      if (!dynamic) return segment;
      params[dynamic[1]] = PLACEHOLDER_ID;
      return PLACEHOLDER_ID;
    });
  return { params, urlPath: `/${segments.join("/")}` };
}

let allJobsCache: Job[] | null = null;

export function routeGuardJobs(): Job[] {
  if (allJobsCache) return allJobsCache;
  const files = walkRouteFiles(path.join(process.cwd(), "app", "api"))
    .map((file) => path.relative(process.cwd(), file).replace(/\\/g, "/"))
    .sort();
  const jobs: Job[] = [];
  for (const file of files) {
    const methods = mutatingMethods(readFileSync(file, "utf8"));
    if (methods.length === 0) continue;
    const route = normalizeRoutePattern(file);
    const calls = methods.map((method) => planCall(route, method)).filter((call) => call.callers.length > 0);
    if (calls.length === 0) continue;
    jobs.push({ calls, file, route, ...urlFor(file) });
  }
  allJobsCache = jobs;
  return jobs;
}

/** Contiguous slices of the sorted list: neighbouring routes share most of their imports. */
export function routeGuardJobsForPart(part: number, jobs: Job[] = routeGuardJobs()): Job[] {
  const size = Math.ceil(jobs.length / PART_COUNT);
  return jobs.slice((part - 1) * size, part * size);
}

// ── Running a slice ──────────────────────────────────────────────────────────────────────────────────
type DriverEvent = { kind: string; method: string; target: string };
type DriverRecord =
  | { error?: string; file: string; ms?: number; ok: boolean; route: string; startupEvents?: DriverEvent[]; type: "import" }
  | {
      body?: string;
      caller: Caller | "*";
      events?: DriverEvent[];
      file: string;
      method: HttpMethod;
      missing?: boolean;
      ms?: number;
      route: string;
      status?: number | null;
      threw?: string | null;
      type: "call";
    }
  | { idleEvents: DriverEvent[]; type: "done"; unhandled: string[] };

// Typed as the process environment itself: Next declares NODE_ENV as required on it, so a plain string
// record is refused by spawnSync's `env` (TS2769) even though it carries NODE_ENV.
function cleanEnvironment(): NodeJS.ProcessEnv {
  const carried: Record<string, string> = {};
  const pathValue = process.env.PATH ?? process.env.Path;
  if (pathValue) carried.PATH = pathValue;
  for (const name of ["SystemRoot", "TEMP", "TMP", "HOME", "USERPROFILE"]) {
    const value = process.env[name];
    if (value) carried[name] = value;
  }
  return {
    ...carried,
    APP_ENV: "development",
    CRON_SECRET: "guard-harness-cron-secret-that-no-call-sends",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "guard-harness-anon-key",
    NEXT_PUBLIC_SUPABASE_URL: STAND_IN_SUPABASE,
    NODE_ENV: "development",
    PHOENIX_AUTH_SECRET: "guard-harness-auth-secret-0123456789abcdef0123456789abcdef",
    PHOENIX_EMAIL_FORCE_TESTING: "true",
    PHOENIX_ENABLE_DEV_AUTH_HEADERS: "true",
    SUPABASE_SERVICE_ROLE_KEY: "guard-harness-service-role-key",
  };
}

function runSlice(jobs: Job[]): { records: DriverRecord[]; seconds: number; stderr: string; timedOut: boolean } {
  const folder = mkdtempSync(path.join(os.tmpdir(), "route-guard-"));
  const jobsFile = path.join(folder, "jobs.json");
  const resultsFile = path.join(folder, "results.jsonl");
  writeFileSync(jobsFile, JSON.stringify(jobs));
  const startedAt = Date.now();
  try {
    const child = spawnSync(
      process.execPath,
      [
        "--max-old-space-size=3072",
        // Transforms, not only strips: seventeen routes reach a class with constructor parameter properties
        // (coaching, the WhatsApp inbox, ask-again, the pharmacy matches), which plain stripping refuses.
        "--experimental-transform-types",
        "--experimental-strip-types",
        "--experimental-specifier-resolution=node",
        "--experimental-loader",
        "./tests/alias-loader.mjs",
        DRIVER,
        jobsFile,
        resultsFile,
      ],
      { encoding: "utf8", env: cleanEnvironment(), maxBuffer: 64 * 1024 * 1024, timeout: SLICE_TIMEOUT_MS },
    );
    const text = existsSync(resultsFile) ? readFileSync(resultsFile, "utf8") : "";
    const records = text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as DriverRecord);
    const timedOut = Boolean(child.error && /ETIMEDOUT/.test(String(child.error)));
    return { records, seconds: (Date.now() - startedAt) / 1000, stderr: String(child.stderr ?? "").slice(-1500), timedOut };
  } finally {
    rmSync(folder, { force: true, recursive: true });
  }
}

// ── Judging ──────────────────────────────────────────────────────────────────────────────────────────
function isRefusal(status: number | null | undefined, threw: string | null | undefined): boolean {
  if (status === 401 || status === 403) return true;
  return status == null && Boolean(threw && /^(forbidden|unauthori[sz]ed)\b/i.test(threw));
}

function isRejection(status: number | null | undefined, threw: string | null | undefined): boolean {
  if (typeof status === "number") return status >= 400;
  return Boolean(threw);
}

function writesOf(events: DriverEvent[] | undefined): DriverEvent[] {
  return (events ?? []).filter((event) => {
    if (event.kind === "read") return false;
    if (event.kind === "rpc") return !(event.target in INFRASTRUCTURE_RPCS) && !(event.target in READ_ONLY_RPCS);
    if (event.kind === "db") return !(event.target in INFRASTRUCTURE_TABLES);
    return event.kind !== "outbound";
  });
}

function outboundOf(events: DriverEvent[] | undefined): DriverEvent[] {
  return (events ?? []).filter((event) => event.kind === "outbound");
}

function describe(event: DriverEvent): string {
  return `${event.kind}:${event.target}(${event.method})`;
}

function answerOf(status: number | null | undefined, threw: string | null | undefined): string {
  if (typeof status === "number") return String(status);
  return threw ? `threw "${threw.slice(0, 120)}"` : "no answer";
}

const EXPECTATION_WORDS: Record<Expectation, string> = {
  "no-write": "no write",
  refusal: "a refusal (401 or 403)",
  rejection: "an answer of 400 or above",
  skip: "skipped",
};

type Verdict = { calls: number; notes: string[]; problems: string[]; refusedByThrow: string[] };

export function judgeRouteGuardRecords(jobs: Job[], records: DriverRecord[]): Verdict {
  const problems: string[] = [];
  const notes: string[] = [];
  const refusedByThrow: string[] = [];
  let calls = 0;
  const imports = new Map<string, Extract<DriverRecord, { type: "import" }>>();
  const callRecords = new Map<string, Extract<DriverRecord, { type: "call" }>>();
  for (const record of records) {
    if (record.type === "import") imports.set(record.file, record);
    if (record.type === "call") callRecords.set(`${record.method} ${record.route} ${record.caller}`, record);
    if (record.type === "call" && record.missing) callRecords.set(`${record.method} ${record.route} *`, record);
  }

  for (const job of jobs) {
    const imported = imports.get(job.file);
    const notCallable = NOT_CALLABLE[job.route];
    if (!imported || !imported.ok) {
      const why = !imported ? "never reached (the slice ran out of time or crashed)" : `could not be imported: ${imported.error}`;
      if (notCallable) notes.push(`${job.route}: ${why} — listed: ${notCallable}`);
      else problems.push(`${job.route}: ${why}`);
      continue;
    }
    if (notCallable) notes.push(`${job.route} is listed in NOT_CALLABLE but was called; take the line out`);
    const startupWrites = writesOf(imported.startupEvents).concat(outboundOf(imported.startupEvents));
    if (startupWrites.length > 0) problems.push(`${job.route}: importing the file wrote or called out: ${startupWrites.map(describe).join(", ")}`);

    for (const planned of job.calls) {
      if (callRecords.has(`${planned.method} ${job.route} *`)) {
        problems.push(`${planned.method} ${job.route}: the file names the method but exports no handler for it`);
        continue;
      }
      for (const caller of planned.callers) {
        const key = `${planned.method} ${job.route} ${caller.label}`;
        const result = callRecords.get(key);
        if (!result) {
          problems.push(`${key}: never called (the slice ran out of time or crashed)`);
          continue;
        }
        calls += 1;
        const expectation = planned.expectations[caller.label];
        const who = caller.label === "refused-role" ? `${caller.label} [${planned.refusedRole ?? "Medical Rep"}]` : caller.label;
        const answer = answerOf(result.status, result.threw);
        const writes = writesOf(result.events);
        const outbound = outboundOf(result.events);

        const meets =
          expectation === "refusal"
            ? isRefusal(result.status, result.threw)
            : expectation === "rejection"
              ? isRejection(result.status, result.threw)
              : true;
        if (meets && result.status == null && result.threw) refusedByThrow.push(`${key} → ${answer}`);

        const answerGap = ANSWER_GAPS[key];
        if (!meets && !answerGap) {
          problems.push(`${planned.method} ${job.route} ${who} → ${answer}; expected ${EXPECTATION_WORDS[expectation]}${result.body ? ` — body: ${result.body.replace(/\s+/g, " ").slice(0, 100)}` : ""}`);
        } else if (meets && answerGap) {
          notes.push(`${key} now meets the rule; its ANSWER_GAPS line can go`);
        }

        const writeGap = WRITE_GAPS[key];
        const unexplained = writes.filter((event) => !writeGap?.targets.includes(event.target));
        if (unexplained.length > 0) {
          problems.push(`${planned.method} ${job.route} ${who} → ${answer} and WROTE: ${unexplained.map(describe).join(", ")}`);
        } else if (writeGap && writes.length === 0) {
          notes.push(`${key} no longer writes; its WRITE_GAPS line can go`);
        }
        if (outbound.length > 0) {
          problems.push(`${planned.method} ${job.route} ${who} → ${answer} and CALLED OUT: ${outbound.map(describe).join(", ")}`);
        }
      }
    }
  }
  return { calls, notes, problems, refusedByThrow };
}

async function runPart(part: number) {
  const jobs = routeGuardJobsForPart(part);
  assert.ok(jobs.length > 0, `route guard part ${part} of ${PART_COUNT} has no route files — the split or the walk is broken`);
  const run = runSlice(jobs);
  const done = run.records.find((record) => record.type === "done") as Extract<DriverRecord, { type: "done" }> | undefined;
  const verdict = judgeRouteGuardRecords(jobs, run.records);
  const header =
    `route guard part ${part} of ${PART_COUNT}: ${jobs.length} route files, ${verdict.calls} calls, ${run.seconds.toFixed(1)} s` +
    (run.timedOut ? `, STOPPED after ${SLICE_TIMEOUT_MS / 1000} s` : "") +
    (done ? "" : " — the driver did not finish");
  for (const note of verdict.notes) console.log(`  note: ${note}`);
  if (verdict.refusedByThrow.length > 0) {
    console.log(`  ${verdict.refusedByThrow.length} refusals were thrown, not answered (Next turns them into a 500): ${verdict.refusedByThrow.slice(0, 5).join("; ")}`);
  }
  assert.equal(
    verdict.problems.length,
    0,
    `${header}\n${verdict.problems.length} answers break the rule:\n  ${verdict.problems.join("\n  ")}\n` +
      "Each line is a route that answered more than its access-registry entry allows, or wrote, or called out, before refusing. " +
      "Fix the route; or, if the route is right and the registry is wrong, correct the entry; or list the answer in " +
      "ANSWER_GAPS / WRITE_GAPS / NOT_CALLABLE in tests/route-guard-harness.test.ts WITH ITS REASON." +
      (done?.unhandled.length ? `\nUnhandled in the child: ${done.unhandled.join(" | ")}` : "") +
      (done ? "" : `\nChild stderr (tail): ${run.stderr}`),
  );
  console.log(`  ${header}`);
}

export async function runRouteGuardHarnessPart1Tests() {
  await runPart(1);
}
export async function runRouteGuardHarnessPart2Tests() {
  await runPart(2);
}
export async function runRouteGuardHarnessPart3Tests() {
  await runPart(3);
}
export async function runRouteGuardHarnessPart4Tests() {
  await runPart(4);
}
export async function runRouteGuardHarnessPart5Tests() {
  await runPart(5);
}
export async function runRouteGuardHarnessPart6Tests() {
  await runPart(6);
}
export async function runRouteGuardHarnessPart7Tests() {
  await runPart(7);
}
export async function runRouteGuardHarnessPart8Tests() {
  await runPart(8);
}
export async function runRouteGuardHarnessPart9Tests() {
  await runPart(9);
}
export async function runRouteGuardHarnessPart10Tests() {
  await runPart(10);
}
export async function runRouteGuardHarnessPart11Tests() {
  await runPart(11);
}
export async function runRouteGuardHarnessPart12Tests() {
  await runPart(12);
}
export async function runRouteGuardHarnessPart13Tests() {
  await runPart(13);
}
export async function runRouteGuardHarnessPart14Tests() {
  await runPart(14);
}
export async function runRouteGuardHarnessPart15Tests() {
  await runPart(15);
}
export async function runRouteGuardHarnessPart16Tests() {
  await runPart(16);
}

// ── The ratchet's own checks (source only, fast) ─────────────────────────────────────────────────────
export function runRouteGuardHarnessRatchetTests() {
  const jobs = routeGuardJobs();

  // A source walk dies by matching nothing; 871 route files changed data on 19 Nov 2026.
  assert.ok(jobs.length >= 800, `the harness found only ${jobs.length} route files that change data (871 on 19 Nov 2026) — the walk or the method match is broken`);

  // The parts cover every route file exactly once.
  const seen = new Map<string, number>();
  for (let part = 1; part <= PART_COUNT; part += 1) {
    for (const job of routeGuardJobsForPart(part, jobs)) seen.set(job.file, (seen.get(job.file) ?? 0) + 1);
  }
  assert.equal(seen.size, jobs.length, "every route file that changes data is in exactly one part");
  assert.deepEqual([...seen.values()].filter((count) => count !== 1), [], "no route file is in two parts");

  // Every part function is the same shape, so none can be left out of the registration by accident.
  const runner = readFileSync("tests/run-tests.ts", "utf8");
  for (let part = 1; part <= PART_COUNT; part += 1) {
    assert.match(runner, new RegExp(`runRouteGuardHarnessPart${part}Tests\\)`), `part ${part} must be registered in tests/run-tests.ts`);
  }

  // The refused role really is refused by the matrix, and a signed-in route always gets one of the callers.
  const sample = jobs.flatMap((job) => job.calls.map((call) => ({ call, job })));
  const declared = sample.filter(({ call }) => call.expectations["refused-role"] === "refusal");
  assert.ok(declared.length >= 400, `only ${declared.length} calls had a refused role to try — the registry lookup is broken`);

  // The Early Birds decision (F-CRM-016, closed by pull request 566): its permission line stays, and the
  // harness demands 401/403 from it like every other signed-in route.
  assert.ok(existsSync(EARLY_BIRDS_ROUTE_FILE), `${EARLY_BIRDS_ROUTE_FILE} moved — update the Early Birds rule in this file`);
  assert.ok(existsSync(EARLY_BIRDS_FIX_TEST), `${EARLY_BIRDS_FIX_TEST} is gone — the F-CRM-016 fix lost its own test`);
  assert.ok(
    earlyBirdsGuardInPlace(),
    `HEADLINE: ${EARLY_BIRDS_ROUTE_FILE} no longer asserts ${EARLY_BIRDS_GUARD} — ` +
      "the F-CRM-016 fix was undone: a Medical Rep could decide their own district's Early Birds pick again.",
  );
  const earlyBirds = jobs.find((job) => job.route === EARLY_BIRDS_ROUTE)?.calls.find((call) => call.method === "POST");
  assert.ok(earlyBirds, "the harness must call the Early Birds decision route");
  assert.equal(earlyBirds.expectations["refused-role"], "refusal", "the Early Birds decision is refused before it reads anything");

  // The driver holds no expected answers: it records, the test judges.
  const driver = readFileSync(DRIVER, "utf8");
  assert.doesNotMatch(driver, /ANSWER_GAPS|WRITE_GAPS|NOT_CALLABLE|INFRASTRUCTURE_TABLES/, "the driver must not decide what passes");
  assert.doesNotMatch(driver, /env-file|\.env\.local|dotenv/, "the driver must never read an environment file (.env.local is PRODUCTION)");

  // Stale gap lines are reported, never failed.
  const keys = new Set(sample.flatMap(({ call, job }) => call.callers.map((caller) => `${call.method} ${job.route} ${caller.label}`)));
  for (const key of [...Object.keys(ANSWER_GAPS), ...Object.keys(WRITE_GAPS)]) {
    if (!keys.has(key)) console.log(`  note: the gap line "${key}" names no call the harness makes; it can go`);
  }
}
