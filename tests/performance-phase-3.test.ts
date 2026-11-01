import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { stripComments } from "./support/comment-strip.ts";
import { formatServerTiming, startServerTimer } from "../src/lib/http/server-timing.ts";
import {
  PAGE_TIMING_MAX_NAMES,
  admitPageTimingName,
  normalisePagePath,
  sanitizePageTimings,
} from "../src/lib/observability/page-timing-intake.ts";
import { drainTimings } from "../src/lib/observability/timings.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Performance phase 3 (2026-10-23): the guards that keep the speed work from quietly un-doing itself,
// and the timing that lets the next slow page be seen instead of guessed at.
//
//   A. A rep-scoped page never reads the whole company through the CRM door.
//   B. No new OFFSET walk over a unified CRM view (the keyset reader is the pattern).
//   C. The portal shell's data stays ONE parallel wave: no new sequential await in front of the page —
//      and since 1 Nov 2026 the shell's own data function and five portal pages hold their wave too.
//   D. No new direct read of lines / areas / departments beside the cached reference-list accessor.
//   E. Server-Timing carries durations only, and sits on the slow CRM and badge routes.
//   F. The browser timing beacon records a page SHAPE, a kind, a device class and durations, nothing identifying.
//
// Every ratchet is a baseline map that may only fall. Each pin is handed a broken copy and must fire.
// ─────────────────────────────────────────────────────────────────────────────

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const code = (source: string) => stripComments(source).replace(/\r\n/g, "\n");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(`${root}${dir}`)) {
    const relative = `${dir}/${name}`;
    const stat = statSync(`${root}${relative}`);
    if (stat.isDirectory()) out.push(...sourceFiles(relative));
    else if (/\.(ts|tsx)$/.test(name)) out.push(relative);
  }
  return out;
}

// ── A. Whole-company reads on a rep-scoped page ──────────────────────────────────────────────────

/** A key that narrows a door read to a person, a customer or a visit. The door refuses nothing without one. */
const NARROWING_KEY =
  /\b(agentCrmIds|agentHrIds|agentCrmOrHrIds|agentHrIdILike|doubleHrIds|contactCrmIds|visitIds)\b/;
const DOOR_CALL = /\b(queryVisitsLimited|queryVisits|queryCheckins|queryPlanEntries)\b\s*(<)?/g;

/** The argument text of every door call in the source (balanced parentheses, generics skipped). */
export function doorCallArguments(source: string): string[] {
  const text = code(source);
  const calls: string[] = [];
  for (const match of text.matchAll(DOOR_CALL)) {
    let index = (match.index ?? 0) + match[0].length;
    if (match[2]) {
      let depth = 1;
      while (index < text.length && depth > 0) {
        const char = text[index++];
        if (char === "<") depth += 1;
        else if (char === ">" && text[index - 2] !== "=") depth -= 1;
      }
      while (/\s/.test(text[index] ?? "")) index += 1;
    }
    if (text[index] !== "(") continue; // an import or a type, not a call
    let depth = 0;
    const start = index;
    for (; index < text.length; index += 1) {
      if (text[index] === "(") depth += 1;
      else if (text[index] === ")" && --depth === 0) break;
    }
    calls.push(text.slice(start, index + 1));
  }
  return calls;
}

/** Door calls with no narrowing key — each one is a whole-company read. */
export function wholeCompanyDoorReads(source: string): string[] {
  return doorCallArguments(source).filter((args) => !NARROWING_KEY.test(args));
}

const REP_SCOPED_FILES = [
  "src/lib/crm/rep-visits-data.ts",
  "src/lib/employee-portal/my-crm-visits.ts",
  "src/lib/crm/rep-day.ts",
  "src/lib/crm/plan-actuals-data.ts",
];

// ── B. OFFSET walks over a unified view ──────────────────────────────────────────────────────────

const UNIFIED_VIEW_REFERENCE = /crm_[a-z_]*_unified|[A-Z_]*UNIFIED[A-Z_]*/;

/** `.range(` calls per file, for the files that name a unified CRM view. Comments are not counted. */
export function offsetWalkCounts(files: Record<string, string>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [path, source] of Object.entries(files)) {
    const text = code(source);
    if (!UNIFIED_VIEW_REFERENCE.test(text)) continue;
    const n = (text.match(/\.range\(/g) ?? []).length;
    if (n > 0) counts[path] = n;
  }
  return counts;
}

/** Baseline taken 2026-10-23. A file may go DOWN (move it to the keyset reader); a new file or a higher count fails. */
export const OFFSET_WALK_BASELINE: Record<string, number> = {
  "src/lib/crm/customer-brick.ts": 2,
  "src/lib/crm/master.ts": 3,
  "src/lib/crm/plan-board.ts": 1,
  "src/lib/crm/reads.ts": 4,
  "src/lib/crm/reps-list.ts": 2,
  "src/lib/crm/shared-customers.ts": 1,
  "src/lib/system-audit/detectors/visit-lifecycle.ts": 12,
};

export function ratchetExceeded(actual: Record<string, number>, baseline: Record<string, number>): string[] {
  const over: string[] = [];
  for (const [path, n] of Object.entries(actual)) {
    const allowed = baseline[path] ?? 0;
    if (n > allowed) over.push(`${path}: ${n} (allowed ${allowed})`);
  }
  return over;
}

// ── C. The portal shell's one wave ───────────────────────────────────────────────────────────────

/** The `await` expressions in the shell, in order. */
export function shellAwaits(source: string): string[] {
  return [...code(source).matchAll(/\bawait\s+([A-Za-z_.]+)/g)].map((m) => m[1]);
}

export const SHELL_AWAITS_BASELINE = ["assertPermission", "Promise.all", "locksPromise", "headers", "cookies"];

/**
 * Layer B of the speed root cause (1 Nov 2026): the five portal pages that used to queue their reads one
 * after the other, with the awaits each is allowed, in order. A page that grows a sequential await fails;
 * a page that loses one rewrites its line here so the gain is kept.
 */
export const PAGE_AWAITS_BASELINE: Record<string, string[]> = {
  "app/employee-portals/business-review/page.tsx": [
    "resolveAuthenticatedPageAccess",
    "searchParams",
    "loadReviewPortalScope",
    "Promise.all",
    "loadReviewConcentration",
    "loadReviewConcentration",
  ],
  "app/employee-portals/employee-360/page.tsx": [
    "getEmployeeDirectoryRows",
    "resolveEmployee",
    "resolveAuthenticatedPageAccess",
    "assertPermission",
    "searchParams",
    "getEmployeeDirectoryRows",
    "getEmployeeDirectoryRows",
    "resolveEmployee",
    "Promise.all",
    "Promise.all",
    "Promise.all",
  ],
  "app/employee-portals/fingerprint-analytics/page.tsx": ["resolveAccessContextFromPage", "canAccess", "Promise.all"],
  "app/employee-portals/interview-calendar/page.tsx": [
    "resolveAccessContextFromPage",
    "searchParams",
    "resolveInterviewCalendarRole",
    "Promise.all",
  ],
  "app/employee-portals/milestones/page.tsx": ["resolveAccessContextFromPage", "Promise.all"],
};

/** The reads the shell's data function starts in its FIRST wave (src/lib/employee-portal/service.ts). */
export const SHELL_DATA_FIRST_WAVE = [
  "resolvePortalCurrentUser(",
  "getEmployeeDirectory(",
  "personalMailboxConnected(",
  "resolveDirectManagerName(expectedHrId)",
  "uploadedEmployeePhotoUrl(expectedHrId)",
];

/** The text of the first `Promise.all([ … ])` after the named declaration, or null when there is none. */
export function firstWaveOf(source: string, declaration: string): string | null {
  const text = code(source);
  const start = text.indexOf(declaration);
  if (start < 0) return null;
  const wave = text.indexOf("Promise.all([", start);
  if (wave < 0) return null;
  const end = text.indexOf("]);", wave);
  return end < 0 ? null : text.slice(wave, end);
}

// ── D. Reference-list reads that bypass the cache ────────────────────────────────────────────────

const REFERENCE_READ =
  /\.from\(\s*["'](lines|areas|departments)["']\s*\)|supabaseRest\(\s*["'](lines|areas|departments)["']/g;

/** Direct reads of the three cached reference lists, per file. */
export function referenceReadCounts(files: Record<string, string>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [path, source] of Object.entries(files)) {
    if (path === "src/lib/reference/reference-lists.ts") continue;
    const n = (code(source).match(REFERENCE_READ) ?? []).length;
    if (n > 0) counts[path] = n;
  }
  return counts;
}

/** Baseline taken 2026-10-23. Never raised: a new read goes through src/lib/reference/reference-lists.ts. */
export const REFERENCE_READ_BASELINE: Record<string, number> = {
  "src/lib/attendance/fingerprint-report.ts": 1,
  "src/lib/attendance/roster.ts": 1,
  "src/lib/business-review/portal-scope.ts": 1,
  "src/lib/business-review/sources/field-link.ts": 1,
  "src/lib/crm/coverage-filters-data.ts": 1,
  "src/lib/crm/master.ts": 2,
  "src/lib/direct-orders/campaign-link.ts": 3,
  "src/lib/direct-orders/rep-area-view-service.ts": 2,
  "src/lib/employees/region-resolver.ts": 2,
  "src/lib/employees/seat-transfer.ts": 1,
  "src/lib/hiring-documents/service.ts": 1,
  "src/lib/hiring-pack/service.ts": 1,
  "src/lib/imports/employee-import-existing-state.ts": 4,
  "src/lib/marketing-requests/direct-order-venue-sync.ts": 1,
  "src/lib/marketing-requests/request-report-service.ts": 2,
  "src/lib/marketing-requests/validated-customer-transfer.ts": 5,
  "src/lib/marketing-requests/venue-territory.ts": 3,
  "src/lib/offers/joining-form-service.ts": 2,
  "src/lib/org/employee-seat-drift.ts": 1,
  "src/lib/sales/medical-rep-area-scope.ts": 1,
  "src/lib/sales/portal-sos-dashboard.ts": 1,
  "src/lib/territory-management/area-consolidation.ts": 3,
  "src/lib/verified-captures/direct-orders.ts": 1,
  "src/lib/verified-captures/marketing.ts": 2,
  "src/lib/weekly-planning/planning-areas.ts": 1,
  "app/api/admin/users/bulk/route.ts": 1,
  "app/api/imports/employees/confirm/route.ts": 2,
};

// ── E. Server-Timing ─────────────────────────────────────────────────────────────────────────────

export const TIMED_ROUTES = [
  { file: "app/api/phoenix-crm/overview/route.ts", label: "crm_overview" },
  { file: "app/api/phoenix-crm/today/route.ts", label: "crm_today" },
  { file: "app/api/phoenix-crm/visits/route.ts", label: "crm_visits" },
  { file: "app/api/phoenix-crm/plans/route.ts", label: "crm_plans" },
  // 1 Nov 2026 (the speed root cause): the List, the board and Add Visit — the three the rep opens most.
  { file: "app/api/phoenix-crm/list/route.ts", label: "crm_list" },
  { file: "app/api/phoenix-crm/list/board/route.ts", label: "crm_list_board" },
  { file: "app/api/phoenix-crm/visits/form/route.ts", label: "crm_visit_form" },
];

/** What a timed route is missing. */
export function timedRouteMissing(source: string, label: string, header = "timer.headers()"): string[] {
  const text = code(source);
  const missing: string[] = [];
  if (!text.includes(`startServerTimer("${label}")`)) missing.push("its timer");
  if (!text.includes("timer.measure(")) missing.push("a measured stage");
  if (!/GET[\s\S]*?\{ headers: timer\.headers\(\) \}/.test(text) || !text.includes(header)) missing.push("the Server-Timing header on the GET answer");
  return missing;
}

// ── F. The browser beacon ────────────────────────────────────────────────────────────────────────

/** What would let the beacon identify a person or keep business data. */
export function beaconRouteLeaks(source: string): string[] {
  const text = code(source);
  const leaks: string[] = [];
  for (const forbidden of ["resolveAccessContext", "getSupabaseAdmin", "supabase", "cookies(", "logAppError", "hrId", "loginId", "request.headers.get(\"user-agent\")"]) {
    if (text.includes(forbidden)) leaks.push(forbidden);
  }
  return leaks;
}

export async function runPerformancePhase3Tests() {
  // ── A ───────────────────────────────────────────────────────────────────────────────────────────
  for (const file of REP_SCOPED_FILES) {
    const source = read(file);
    assert.ok(doorCallArguments(source).length > 0, `${file}: the detector finds its door calls`);
    assert.deepEqual(wholeCompanyDoorReads(source), [], `${file} reads through the door only with a person, customer or visit key`);
  }
  const rep = read("src/lib/crm/rep-visits-data.ts");
  const stripped = rep.replace(/\.\.\.\(hrId \? \{ agentHrIdILike: hrId \} : \{\}\),/, "").replace("agentHrIdILike: hrId,", "");
  assert.notEqual(stripped, rep, "broken copy did not change the source: whole-company read");
  assert.ok(wholeCompanyDoorReads(stripped).length > 0, "broken copy must fire: a door read with no person key");
  assert.equal(
    wholeCompanyDoorReads("const a = await queryVisits<{ x: number }>({ dateFrom: d, dateTo: d });").length,
    1,
    "a generic-typed whole-company read is found",
  );
  assert.equal(wholeCompanyDoorReads("import { queryVisits } from '@/lib/crm/reads';").length, 0, "an import is not a call");

  // ── B ───────────────────────────────────────────────────────────────────────────────────────────
  const scanned = Object.fromEntries([...sourceFiles("src"), ...sourceFiles("app")].map((f) => [f, read(f)]));
  const offsets = offsetWalkCounts(scanned);
  assert.deepEqual(ratchetExceeded(offsets, OFFSET_WALK_BASELINE), [], "no new OFFSET walk over a unified CRM view (use walkMasterExportPages' keyset pattern, docs/crm-ordered-door-pages.md)");
  assert.ok(Object.keys(OFFSET_WALK_BASELINE).length > 0, "the OFFSET baseline is not empty");
  assert.deepEqual(
    ratchetExceeded({ ...offsets, "src/lib/crm/brand-new-reader.ts": 1 }, OFFSET_WALK_BASELINE),
    ["src/lib/crm/brand-new-reader.ts: 1 (allowed 0)"],
    "broken copy must fire: a new file walking a unified view by OFFSET",
  );
  const firstOffset = Object.keys(OFFSET_WALK_BASELINE)[0]!;
  assert.equal(ratchetExceeded({ ...offsets, [firstOffset]: OFFSET_WALK_BASELINE[firstOffset]! + 1 }, OFFSET_WALK_BASELINE).length, 1, "broken copy must fire: one more .range( in a known file");
  for (const [path, allowed] of Object.entries(OFFSET_WALK_BASELINE)) {
    assert.ok((offsets[path] ?? 0) <= allowed, `${path} stays at or under its baseline`);
    assert.ok((offsets[path] ?? 0) === allowed, `${path} fell below its baseline of ${allowed} — lower the baseline so the gain is kept`);
  }

  // ── C ───────────────────────────────────────────────────────────────────────────────────────────
  const shell = read("src/components/employee-portal/employee-portal-server-shell.tsx");
  assert.deepEqual(shellAwaits(shell), SHELL_AWAITS_BASELINE, "the portal shell awaits only: permission, the one four-read wave, the module locks, headers, cookies");
  const brokenShell = shell.replace("[data, hasDeviceMapping,", "const extra = await loadSomethingNew(); [data, hasDeviceMapping,");
  assert.notEqual(brokenShell, shell, "broken copy did not change the shell source");
  assert.notDeepEqual(shellAwaits(brokenShell), SHELL_AWAITS_BASELINE, "broken copy must fire: a new sequential await in the shell");
  assert.equal((code(shell).match(/Promise\.all\(/g) ?? []).length, 1, "the shell has exactly one Promise.all");

  // Layer B (1 Nov 2026): the shell's DATA is one wave too, and the five pages stop queueing their reads.
  const shellData = read("src/lib/employee-portal/service.ts");
  const shellWave = firstWaveOf(shellData, "export const getEmployeePortalShellData");
  assert.ok(shellWave, "getEmployeePortalShellData starts with a Promise.all wave");
  for (const readName of SHELL_DATA_FIRST_WAVE) {
    assert.ok(shellWave.includes(readName), `the shell data's first wave starts ${readName}`);
  }
  assert.ok(
    code(shellData).includes("? [expectedManager, expectedPhotoUrl]"),
    "the manager and photo read in the first wave are USED when the session's person is the viewer",
  );
  const brokenShellData = shellData.replace("expectedHrId ? resolveDirectManagerName(expectedHrId) : Promise.resolve(null),", "");
  assert.notEqual(brokenShellData, shellData, "broken copy did not change the shell data source");
  const brokenWave = firstWaveOf(brokenShellData, "export const getEmployeePortalShellData");
  assert.ok(brokenWave && !brokenWave.includes("resolveDirectManagerName(expectedHrId)"), "broken copy must fire: the manager's name dropped out of the wave");

  const mapping = code(read("src/lib/attendance/device-user-mapping.ts"));
  assert.ok(mapping.includes("unstable_cache(") && mapping.includes("tags: [DEVICE_MAPPING_CACHE_TAG]"), "the device-mapping read is remembered under its bare tag");
  const saveStart = mapping.indexOf("export async function saveAttendanceDeviceUserMapping");
  assert.ok(saveStart > 0 && mapping.indexOf("invalidateDeviceMappingCache(", saveStart) > saveStart, "saving a device mapping busts the tag");
  assert.ok(code(read("src/lib/dashboard/invalidation.ts")).includes("export const DEVICE_MAPPING_CACHE_TAG"), "the device-mapping tag is declared beside the other bare tags");

  for (const [page, awaits] of Object.entries(PAGE_AWAITS_BASELINE)) {
    assert.deepEqual(shellAwaits(read(page)), awaits, `${page} awaits exactly its baseline — a new sequential await goes inside the wave, a lost one lowers the baseline`);
  }
  const milestones = read("app/employee-portals/milestones/page.tsx");
  const brokenMilestones = milestones.replace("await Promise.all(", "await loadSomethingFirst(); await Promise.all(");
  assert.notEqual(brokenMilestones, milestones, "broken copy did not change the milestones page");
  assert.notDeepEqual(shellAwaits(brokenMilestones), PAGE_AWAITS_BASELINE["app/employee-portals/milestones/page.tsx"], "broken copy must fire: a new await in front of a page's wave");

  // ── D ───────────────────────────────────────────────────────────────────────────────────────────
  const references = referenceReadCounts(scanned);
  assert.deepEqual(ratchetExceeded(references, REFERENCE_READ_BASELINE), [], "no new direct read of lines / areas / departments (use src/lib/reference/reference-lists.ts)");
  assert.deepEqual(
    ratchetExceeded(referenceReadCounts({ ...scanned, "src/lib/x/new.ts": 'const r = await supabase.from("areas").select("id");' }), REFERENCE_READ_BASELINE),
    ["src/lib/x/new.ts: 1 (allowed 0)"],
    "broken copy must fire: a new direct areas read",
  );
  for (const [path, allowed] of Object.entries(REFERENCE_READ_BASELINE)) {
    assert.equal(references[path] ?? 0, allowed, `${path} matches its reference-read baseline — lower it when a read moves to the accessor`);
  }

  // ── E ───────────────────────────────────────────────────────────────────────────────────────────
  assert.equal(formatServerTiming([{ name: "load", ms: 12.34 }, { name: "total", ms: 20 }]), "load;dur=12.3, total;dur=20");
  assert.equal(formatServerTiming([{ name: "Bad Name", ms: 1 }, { name: "ok", ms: -1 }, { name: "nan", ms: Number.NaN }, { name: "9x", ms: 1 }]), null, "invalid names and durations are dropped");
  assert.equal(formatServerTiming([{ name: "a".repeat(40), ms: 1 }]), null, "a name over 32 characters is dropped");
  assert.equal(formatServerTiming([{ name: "hr_id;desc=\"B-10\"", ms: 1 }]), null, "a name that tries to smuggle a description is dropped");
  const timer = startServerTimer("phase3_probe");
  assert.equal(await timer.measure("work", async () => 7), 7, "measure hands the result back");
  await assert.rejects(() => timer.measure("fails", async () => { throw new Error("boom"); }), /boom/, "measure rethrows");
  timer.lap("access");
  const header = timer.headers()["Server-Timing"] ?? "";
  assert.match(header, /^work;dur=[\d.]+, fails;dur=[\d.]+, access;dur=[\d.]+, total;dur=[\d.]+$/, "the header lists the stages and a total, durations only");
  const drained = drainTimings();
  assert.ok(drained["route_phase3_probe_work"] && drained["route_phase3_probe_total"], "each stage reaches the process-health timings");

  for (const { file, label } of TIMED_ROUTES) {
    const source = read(file);
    assert.deepEqual(timedRouteMissing(source, label), [], `${file} sends Server-Timing`);
    // EVERY header, not the first: a route that answers JSON twice (the board's vacant territory) must fire too.
    assert.ok(timedRouteMissing(source.split(", { headers: timer.headers() }").join(""), label).length > 0, `${file}: broken copy must fire without the header`);
    assert.ok(timedRouteMissing(source.replace(`startServerTimer("${label}")`, "null"), label).length > 0, `${file}: broken copy must fire without the timer`);
  }
  const badge = code(read("app/api/approvals/badge-counts/route.ts"));
  assert.ok(badge.includes("formatServerTiming(") && badge.includes('"Server-Timing": serverTiming'), "badge-counts answers with Server-Timing");

  // ── F ───────────────────────────────────────────────────────────────────────────────────────────
  assert.equal(normalisePagePath("/employee-portals/phoenix-crm/visits?seat=ab12&x=1#top"), "/employee-portals/phoenix-crm/visits", "query and hash are dropped");
  assert.equal(normalisePagePath("/employee-portals/employees/5f1c2d3e-aaaa-bbbb-cccc-1234567890ab"), "/employee-portals/employees/:id", "an id segment becomes :id");
  assert.equal(normalisePagePath("/admin/payroll/2026-10"), "/admin/payroll/:id", "a segment with digits becomes :id");
  assert.equal(normalisePagePath("/login"), null, "a page outside the portal and admin is refused");
  assert.equal(normalisePagePath("/employee-portals/a/b/c/d/e"), null, "a path deeper than three segments is refused");
  assert.equal(normalisePagePath("/employee-portals/Omar Gawish"), null, "a segment with spaces is refused");
  assert.equal(normalisePagePath("https://evil.example/employee-portals"), null, "an absolute URL is refused");
  assert.deepEqual(
    sanitizePageTimings({ path: "/employee-portals", fcp: 812.4, lcp: 1503, hrId: "B-10", name: "Omar" }),
    [{ device: "unknown", kind: "hard", metrics: { fcp: 812, lcp: 1503 }, path: "/employee-portals" }],
    "unknown fields such as an id or a name are dropped (the first beacon's shape is still read; tests/page-timings.test.ts has the rest)",
  );
  assert.deepEqual(sanitizePageTimings({ path: "/employee-portals", fcp: -5, lcp: 9_999_999 }), [], "negative and absurd numbers are dropped");
  assert.deepEqual(sanitizePageTimings({ path: "/employee-portals" }), [], "a beacon with no number is dropped");
  const known = new Set<string>();
  for (let i = 0; i < PAGE_TIMING_MAX_NAMES; i += 1) assert.ok(admitPageTimingName(known, `/admin/p${i}`), "names below the cap are admitted");
  assert.equal(admitPageTimingName(known, "/admin/one-too-many"), false, "a new name over the cap is refused");
  assert.equal(admitPageTimingName(known, "/admin/p0"), true, "a known name is still admitted at the cap");

  const beaconRoute = read("app/api/telemetry/page-timing/route.ts");
  assert.deepEqual(beaconRouteLeaks(beaconRoute), [], "the beacon route reads no session, database, cookie or user agent");
  assert.ok(beaconRouteLeaks(beaconRoute.replace("export async function POST", "const a = resolveAccessContext;\nexport async function POST")).length > 0, "broken copy must fire: the beacon route resolving a session");
  assert.ok(code(beaconRoute).includes("PAGE_TIMING_MAX_BODY_BYTES") && code(beaconRoute).includes("withinRateLimit("), "the beacon route caps the body and rate-limits per address");

  const layout = code(read("app/layout.tsx"));
  assert.ok(layout.includes("<PageTimingBeacon />"), "the root layout mounts the timing beacon");
  assert.ok(!code(layout.replace("<PageTimingBeacon />", "")).includes("<PageTimingBeacon />"), "broken copy must fire: the layout without the beacon");
  const beacon = code(read("src/components/layout/page-timing-beacon.tsx"));
  assert.ok(beacon.includes("navigator.sendBeacon(") && beacon.includes("window.location.pathname"), "the beacon sends the bare path with sendBeacon");
  assert.ok(!/location\.(search|href|hash)|document\.cookie|localStorage/.test(beacon), "the beacon never reads the query, the full URL, a cookie or storage");

  const registry = code(read("src/lib/security/access-registry.ts"));
  assert.ok(registry.includes('pattern: "/api/telemetry/page-timing"'), "the beacon route is in the access registry");
}
