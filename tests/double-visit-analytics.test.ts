import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildExecutiveSummary,
  buildManagerMrPairs,
  buildManagerSummariesDetailed,
  resolveDoubleVisitAccessScope,
  resolveDoubleVisitChains,
} from "../src/lib/double-visit-analytics/service.ts";
import { normalizeHrIdForAccess } from "../src/lib/auth/permissions.ts";
import type { EmployeeDirectoryRow } from "../src/lib/employees/employee-directory.ts";
import type { DoubleVisitKpis, DoubleVisitLogEntry } from "../src/lib/double-visit-analytics/types.ts";
import { canonicalHrIdKey } from "../src/lib/hr-id.ts";

type DvRowInput = {
  area?: string | null;
  date: string;
  dvHrId: string;
  dvName?: string;
  line?: string | null;
  period?: "AM" | "PM" | "UNKNOWN";
  visit: number;
  visitedHrId?: string | null;
  visitedName?: string;
};

function dvRow(input: DvRowInput): Record<string, unknown> {
  return {
    activity_date: input.date,
    area_name: input.area ?? null,
    double_visitor_hr_id: input.dvHrId,
    double_visitor_name: input.dvName ?? null,
    id: `${input.dvHrId}-${input.date}-${input.visitedHrId ?? "x"}-${input.period ?? "PM"}-${input.visit}`,
    line_name: input.line ?? null,
    period: input.period ?? "PM",
    visit_type: null,
    visit_type_description: null,
    source_record_id: null,
    source_type: "ireports360",
    visit_count: input.visit,
    visited_employee_hr_id: input.visitedHrId ?? null,
    visited_employee_name: input.visitedName ?? null,
    visited_employee_status: input.visitedHrId ? "active_mapped" : "unmapped",
  };
}

type DvRows = Parameters<typeof buildManagerSummariesDetailed>[0];
const asRows = (rows: Array<Record<string, unknown>>) => rows as unknown as DvRows;

function logEntry(input: DvRowInput): DoubleVisitLogEntry {
  return {
    area: input.area ?? null,
    date: input.date,
    doubleVisitorHrId: input.dvHrId,
    doubleVisitorName: input.dvName ?? null,
    period: input.period ?? "PM",
    visitCount: input.visit,
    visitedHrId: input.visitedHrId ?? null,
    visitedName: input.visitedName ?? null,
    visitedStatus: "active_mapped",
  };
}

const zeroKpis: DoubleVisitKpis = {
  activeCalendarDays: 0,
  activeDoubleVisitDays: 0,
  activeMappedVisitCount: 0,
  amPmRatio: null,
  amVisitCount: 0,
  averageVisitsPerDoubleVisitDay: 0,
  averageVisitsPerDoubleVisitor: 0,
  doubleVisitorCount: 0,
  mrCoverageCount: 0,
  pharmacyVisitCount: 0,
  pmVisitCount: 0,
  totalVisits: 0,
  vacantOrUnmappedShare: 0,
  vacantOrUnmappedVisitCount: 0,
};

function employee(input: Partial<EmployeeDirectoryRow>): EmployeeDirectoryRow {
  return {
    areaName: null,
    crmId: null,
    departmentName: null,
    displayName: input.displayName ?? input.fullName ?? "Employee",
    employmentStatus: "active",
    fullName: input.fullName ?? "Employee",
    hrId: input.hrId ?? "E-1",
    jobTitle: input.jobTitle ?? "Medical Representative",
    lineName: null,
    managerHrId: null,
    managerName: null,
    positionTitle: input.positionTitle ?? "Medical Representative",
    regionName: null,
    ...input,
  } as EmployeeDirectoryRow;
}

export function runDoubleVisitAnalyticsTests() {
  // ── Live-source rebuild (2026-07-04): structural checks that the module reads
  // ireports360_visits directly, applies the Regular(0)/Campaign(-8) double-visit filter, and
  // no longer has an import/publish/Excel path. ──────────────────────────────────────────────
  const service = readFileSync("src/lib/double-visit-analytics/service.ts", "utf8");
  assert.match(service, /DOUBLE_VISIT_TYPE_CODES = \[0, -8\]/, "double-visit definition is Regular(0)/Campaign(-8) only");
  assert.match(service, /getLiveDoubleVisitRows/, "module reads through the live loader");
  assert.match(service, /getDoubleVisitRows</, "live loader reads through the CRM single-door loader (crm/reads), not its own mirror query");
  assert.match(service, /CRM:\$\{visit\.double_crm_id\}/, "unmapped double-visitor still carries the CRM: sentinel the integrity report depends on");
  assert.doesNotMatch(service, /from\("double_visit_rows"\)|from\("double_visit_imports"\)/, "no live query against the removed import/publish tables remains");
  assert.doesNotMatch(service, /saveDoubleVisitPreview|publishDoubleVisitImport|buildAndSaveDoubleVisitFromMirror|buildAndSaveDoubleVisitExcelImport/, "import/publish/Excel machinery is fully removed");
  assert.match(service, /isAllowedDoubleVisitor\(/);
  assert.match(service, /filterRowsByAllowedDoubleVisitor\(/);
  assert.match(service, /isDisallowedExecutiveManager\(/);
  assert.match(service, /buildHeatmapRows\(mrScores, "areaName", areaBuckets\)/);
  assert.match(service, /buildHeatmapRows\(mrScores, "lineName", lineBuckets\)/);
  assert.match(service, /addWorksheet\("Manager Activity"\)/, "export must include a Manager Activity sheet");
  assert.match(service, /addWorksheet\("By Role"\)/, "export must include a By Role sheet");
  assert.match(service, /addWorksheet\("Insights"\)/, "export must include an Insights sheet");
  assert.match(service, /addWorksheet\("Weekly Trend"\)/, "export must include the new Weekly Trend sheet");
  assert.match(service, /addWorksheet\("Manager × MR Pairs"\)/, "export must include a Manager × MR Pairs sheet");
  assert.match(service, /buildManagerMrPairs\(data\.visitLog\)/, "pairs sheet must be built from the visit log");
  assert.doesNotMatch(
    service,
    /\.from\(\s*(visitsTable|["'`]ireports360_visits["'`])\s*\)/,
    "no direct ireports360_visits query remains — CRM data comes only through crm/reads (which keyset-pages past the PostgREST row cap)",
  );
  assert.match(service, /resolveDoubleVisitChains\(/, "same-day chain resolver is wired into the live loader");
  assert.match(service, /resolved_via_chain/, "chain-resolved rows are flagged so callers can audit them");
  assert.match(service, /export async function getDoubleVisitRecoveredChains/, "recovered chains are exposed as their own reusable loader (consumed by Visits Report, not the Integrity report)");

  const dvTypes = readFileSync("src/lib/double-visit-analytics/types.ts", "utf8");
  const integrityReportType = dvTypes.slice(dvTypes.indexOf("export type DoubleVisitIntegrityReport"));
  assert.doesNotMatch(integrityReportType, /recoveredChains/, "DoubleVisitIntegrityReport must not carry recoveredChains any more — that audit moved to Visits Report");
  assert.match(service, /double_visitor_hr_id\) === employeeKey/, "expense workload matching must use Double Visitor HR ID");
  assert.match(service, /loadDoubleVisitPrivateCalendarItems/, "private calendar must receive Double Visit evidence");
  assert.doesNotMatch(service, /title: "Performed Double Visits"/, "performed double-visit items must show the visit count, visited name(s), and area instead of a generic title");
  assert.doesNotMatch(service, /title: "Received Double Visit"/, "received double-visit items must show the visit count, double-visitor name(s), and area instead of a generic title");
  // One calendar item per person, day and KIND — Single, Double or Chain visit, one per companion, so a campaign visit
  // joins its day's entry (owner, 2026-10-29). Each fact once: who went is the title, the kind in Phoenix words leads
  // the month-grid line, then the visits AM · PM · PH apart, then the area.
  assert.match(
    service,
    /title: `With \$\{withNames\}`/,
    "a double-visit calendar card is titled with who went — the kind is its chip and the counts its time, never repeated",
  );
  assert.match(
    service,
    /chipLines: \[\s*`\$\{kindLabel\} with \$\{withNames\}`,\s*counts,\s*areaLabel,/,
    "a double-visit month-grid chip must read 'Double visit with <names>' / AM · PM · PH / area on separate lines",
  );
  assert.match(
    service,
    /const counts = privateCalendarTileCountsText\(split\);/,
    "the chip's visit count is the tile's own three figures, AM · PM · PH (owner, 2026-10-29), never a hand-built AM · PM pair",
  );
  assert.match(
    service,
    /const classified = classifyDoubleVisitRows\(rows\);/,
    "the calendar loader must pair a chain visit's two CRM halves so a chain stop counts once",
  );
  assert.match(
    service,
    /classified\.filter\(\(entry\) => !entry\.absorbed && selected\.has/,
    "a senior manager's half folded into the rep's row must never reach the rep's calendar a second time",
  );
  // THE AM · PM · PHARMACIES GOLDEN RULE: the old AM · PM pair filed every pharmacy among the PM
  // doctors, so it is gone from the calendar feed.
  assert.doesNotMatch(service, /function workloadTime\(/, "the AM · PM-only workload pair must not come back to the calendar");
  assert.doesNotMatch(service, /`AM\/PM: /, "the detail line must not label the pair 'AM/PM'");
  // `speciality` was the LAST select item until the Phoenix field set was appended on 2026-10-07, so
  // this pinned the end of the string. It pins the ITEM now — the guarantee is that the speciality is
  // read, not that nothing is read after it, and a tail pin goes red every time the list grows.
  assert.match(service, /visit_type_description, speciality, "/, "the double-visit read must carry the contact speciality that marks a pharmacy");
  // The outstation trip-workload fallback was the last count split on the raw CRM period; it moved to
  // the bucket helper in its own risk-reviewed change (2026-09-21). No count splits on the period now.
  assert.equal(
    (service.match(/row\.period === "(AM|PM)"\)\.reduce/g) ?? []).length,
    0,
    "no Double Visit Analytics count may bucket on the CRM period alone — that files every pharmacy among the PM doctors",
  );
  assert.equal(
    (service.match(/sumDoubleVisitSplit\(/g) ?? []).length,
    3,
    "the KPI band, each manager's summary and the outstation trip-workload fallback must all take their AM · PM · Pharmacies figures from the one bucket helper",
  );
  assert.equal(
    (service.match(/\{ header: "Pharmacy Visits", key: "pharmacyVisits", width: 16 \}/g) ?? []).length,
    3,
    "Manager Activity, By Role and Weekly Trend must each carry a Pharmacy Visits column beside AM and PM",
  );
  assert.match(service, /\{ metric: "Pharmacy Activity", value: data\.kpis\.pharmacyVisitCount \}/, "the workbook's summary names pharmacy activity apart");
  const dvWorkspace = readFileSync(new URL("../src/components/double-visit-analytics/double-visit-analytics-workspace.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(dvWorkspace, /<AmPmBar am=\{[^}]+\} pm=\{[^}]+\} \/>/, "every AM · PM bar on the dashboard must carry its pharmacies segment");
  assert.doesNotMatch(dvWorkspace, /e\.period === "(AM|PM)"|row\.period === "(AM|PM)"|e\.period === periodFilter/, "the dashboard must count and filter by the golden-rule bucket, never the raw CRM period");
  assert.match(dvWorkspace, /\["ALL", "AM", "PM", "Pharmacies"\] as PeriodFilter\[\]/, "the period filter must offer Pharmacies as its own choice");
  assert.match(
    dvWorkspace,
    /label="Pharmacy Visits" value=\{kpiPharmacy\.note \? kpiPharmacy\.value : fmt\(dashboard\.kpis\.pharmacyVisitCount/,
    "the KPI band must show pharmacy visits as their own figure — and say a Phoenix CRM band's was never recorded, never 0",
  );
  assert.doesNotMatch(dvWorkspace, />AM \/ PM</, "no column header may join AM and PM with a slash");
  // The private calendar DOES opt into seeing resigned-agent rows — a real double visit
  // the calendar owner performed stays real proof of field work even when the visited
  // party's resolved identity is a resigned employee. But it must never trust that
  // resolved identity for DISPLAY: dbRowFromMirrorVisit substitutes the raw CRM
  // name/area in that case (see memory crm-resigned-slot-reused-for-new-hire — the CRM
  // account is frequently just reused for a new hire, not a real visit with someone who
  // left), and the calendar item says plainly that the identity is unverified.
  assert.match(
    service,
    /getLiveDoubleVisitRows\(start, end, employees, \{\s*includeResignedAgents: true,/,
    "the private calendar loader must opt into seeing resigned-agent double-visit rows",
  );
  assert.match(
    service,
    /const preferRawLabel = visitedStatus === "resigned";/,
    "a resigned-employee resolution must fall back to the raw CRM label for display, never the resigned employee's own name/area",
  );
  assert.match(
    service,
    /const identityUnverified = side === "performed" && group\.some\(\(entry\) => entry\.row\.visited_employee_status === "resigned"\);/,
    "the private calendar must detect an unverified (resigned-resolved) identity from the row's already-computed status",
  );
  assert.match(
    service,
    /"Name from CRM, unmatched to an employee record"/,
    "the unverified-identity flag must show inside the same chip/box as the double-visit entry, not as a separate item",
  );
  // A stale resigned-employee resolution can still be corrected to the real, currently-active
  // employee — but the correction now comes from the SHARED identity override table
  // (ireports360_crm_identity_resolutions, tier 1 of the CRM waterfall), never from a hardcoded map
  // local to this module. The hardcoded version fixed Double Visit Analytics and only Double Visit
  // Analytics, which is exactly why the same misattributed work stayed invisible everywhere else.
  assert.doesNotMatch(
    service,
    /const CRM_AGENT_ID_HR_ID_CORRECTIONS/,
    "the hardcoded per-module corrections map must stay retired — corrections belong in the shared override table",
  );
  assert.doesNotMatch(
    service,
    /"AI-0003"|"B-164"/,
    "no employee hr id may be hardcoded in this module; the override table is the source of truth",
  );
  assert.match(
    service,
    /await getCrmIdentityResolutions\(\)/,
    "corrections must be read from the shared CRM identity override table",
  );
  assert.match(
    service,
    /const correctedHrId = !resolution && visit\.agent_crm_id != null\s*\n\s*\? resolveOverriddenHrId\(visit\)\s*\n\s*: undefined;/,
    "a correction must only apply when the same-day chain resolver did not already resolve the row, keyed strictly by agent_crm_id",
  );
  // ...and the correction answers through the shared waterfall on the row's own date, never as a bare
  // crm_id → hr_id lookup: a mapping to a leaver took every visit with the account's new holder
  // (account 1437, 26 Oct 2026). The behaviour is pinned by tests/double-visit-reseated-account-override.test.ts.
  assert.match(
    service,
    /resolveEmployeeHrId\(visit\.agent_crm_id, visit\.agent_name, identityMaps, visit\.visit_date\)/,
    "a saved CRM mapping must be applied through the shared waterfall, scoped to the visit date",
  );
  assert.doesNotMatch(
    service,
    /crmIdentityOverrides\.get\(/,
    "the bare crm_id → hr_id override lookup must stay retired",
  );
  assert.match(
    service,
    /agent_crm_id, agent_hr_id, agent_name/,
    "the mirror visit query must select agent_crm_id so corrections can be looked up",
  );
  const weeklyDigestRemoved = (() => {
    try {
      readFileSync("src/lib/double-visit-analytics/weekly-digest.ts", "utf8");
      return false;
    } catch {
      return true;
    }
  })();
  assert.ok(
    weeklyDigestRemoved,
    "the weekly double-visit digest was deleted by owner decision (2026-09-13): it never ran and its recipient lists disagreed — do not bring it back",
  );
  assert.match(service, /hireDate: employee\.hireDate/, "MR scores carry the rep's hire date");
  assert.doesNotMatch(service, /DSM Dashboard/i, "module service must not use DSM dashboard naming");

  const parserRemoved = (() => {
    try {
      readFileSync("src/lib/double-visit-analytics/parser.ts", "utf8");
      return false;
    } catch {
      return true;
    }
  })();
  assert.ok(parserRemoved, "the Excel/mirror-sync parser.ts must be deleted, not left dangling");

  const nav = readFileSync("src/config/system-navigation.ts", "utf8");
  assert.match(nav, /Double Visit Analytics/);
  assert.doesNotMatch(nav, /DSM Dashboard/i);

  const accessRegistry = readFileSync("src/lib/security/access-registry.ts", "utf8");
  assert.match(accessRegistry, /\/api\/admin\/double-visit-analytics\/export/);
  assert.match(accessRegistry, /double_visit_analytics/);
  assert.match(accessRegistry, /\/api\/outstation\/workload-evidence/);
  assert.doesNotMatch(accessRegistry, /double-visit-analytics\/imports/, "import/publish routes must be removed from the registry");

  const outstationService = readFileSync("src/lib/outstation/service.ts", "utf8");
  assert.match(outstationService, /resolveOutstationWorkloadPayload/);
  assert.match(outstationService, /workload_source_import_id/);
  assert.match(outstationService, /workload_evidence_snapshot/);

  const component = readFileSync("src/components/double-visit-analytics/double-visit-analytics-workspace.tsx", "utf8");
  assert.match(component, /type Tab = "summary"/, "Summary is the default tab");
  assert.doesNotMatch(component, /"overview"/, "Overview tab is folded into Summary");
  assert.doesNotMatch(component, /canImport|canPublish|ImportRow/, "import/publish UI is fully removed from the workspace");
  assert.match(component, /"trends"/, "the new Trends tab is present");
  assert.match(component, /visitsPerDay/, "per-pair intensity is computed client-side");
  assert.match(component, /dates: new Set/, "per-pair distinct days come from the visit log");

  // ── Manager summaries: personal-effort lens + team coverage ──────────────────
  const dsmEmployees = [
    employee({ fullName: "Saad Salama", hrId: "B-10", jobTitle: "District Sales Manager", positionTitle: "District Sales Manager" }),
    employee({ fullName: "MR 1", hrId: "M-1", managerHrId: "B-10" }),
    employee({ fullName: "MR 2", hrId: "M-2", managerHrId: "B-10" }),
    employee({ fullName: "MR 3", hrId: "M-3", managerHrId: "B-10" }),
    employee({ fullName: "MR 4", hrId: "M-4", managerHrId: "B-10" }),
    employee({ fullName: "MR 5", hrId: "M-5", managerHrId: "B-10" }),
    employee({ fullName: "Nahed", hrId: "A-10", jobTitle: "Product Manager", positionTitle: "Product Manager" }),
  ];
  const dsmRows = asRows([
    dvRow({ date: "2026-06-01", dvHrId: "B-10", period: "AM", visit: 2, visitedHrId: "M-1" }),
    dvRow({ date: "2026-06-02", dvHrId: "B-10", period: "PM", visit: 3, visitedHrId: "M-1" }),
    dvRow({ date: "2026-06-03", dvHrId: "B-10", period: "PM", visit: 2, visitedHrId: "M-2" }),
    dvRow({ date: "2026-06-04", dvHrId: "B-10", period: "PM", visit: 3, visitedHrId: "M-3" }),
    dvRow({ date: "2026-06-05", dvHrId: "A-10", period: "PM", visit: 4, visitedHrId: "M-1" }),
  ]);
  const { summaries: dsmSummaries } = buildManagerSummariesDetailed(dsmRows, dsmEmployees, "2026-06-30");
  const dsm = dsmSummaries.find((s) => s.managerName === "Saad Salama");
  assert.ok(dsm, "DSM summary present");
  assert.equal(dsm!.totalDvs, 10, "personal lens sums visit_count");
  assert.equal(dsm!.distinctMrs, 3, "DSM visited 3 distinct MRs");
  assert.equal(dsm!.activeDvDays, 4, "4 distinct DV dates");
  assert.equal(dsm!.callsPerActiveDay, 2.5, "calls/day = totalDvs / active days");
  assert.equal(dsm!.amVisits, 2);
  assert.equal(dsm!.pmVisits, 8);
  assert.equal(dsm!.pharmacyVisits, 0);

  // THE AM · PM · PHARMACIES GOLDEN RULE: a pharmacy visit the CRM tagged PM (or AM) is counted
  // under Pharmacies only — never among the PM doctors — and a row with no period stays out of all
  // three, as it always has on this screen.
  const pharmacyRows = asRows([
    dvRow({ date: "2026-06-01", dvHrId: "P-1", period: "PM", visit: 1, visitedHrId: "MA" }),
    { ...dvRow({ date: "2026-06-01", dvHrId: "P-1", period: "PM", visit: 1, visitedHrId: "MB" }), speciality: "Pharmacy" },
    { ...dvRow({ date: "2026-06-02", dvHrId: "P-1", period: "AM", visit: 1, visitedHrId: "MC" }), speciality: "pharmacy" },
    dvRow({ date: "2026-06-03", dvHrId: "P-1", period: "UNKNOWN", visit: 1, visitedHrId: "MD" }),
  ]);
  const pharmacySummary = buildManagerSummariesDetailed(pharmacyRows, [], "2026-06-30").summaries[0];
  assert.deepEqual(
    { am: pharmacySummary.amVisits, pharmacies: pharmacySummary.pharmacyVisits, pm: pharmacySummary.pmVisits, total: pharmacySummary.totalDvs },
    { am: 0, pharmacies: 2, pm: 1, total: 4 },
    "a pharmacy double visit is counted under Pharmacies, never in PM or AM, and the total still counts every visit",
  );
  assert.equal(pharmacySummary.phoenixVisits, undefined, "a vendor-only summary keeps its old shape");

  // PHOENIX CRM LOGS NO PHARMACY VISIT (2026-10-02): a district manager whose rides are a started team's
  // Phoenix CRM visits has his Phoenix share counted, so every screen and the workbook say the pharmacy
  // figure was never recorded — the figures themselves are untouched (src/lib/crm/visit-count-buckets.ts).
  const phoenixRows = asRows([
    { ...dvRow({ date: "2026-10-04", dvHrId: "D-1", period: "AM", visit: 1, visitedHrId: "MA" }), from_phoenix: true },
    { ...dvRow({ date: "2026-10-04", dvHrId: "D-1", period: "PM", visit: 2, visitedHrId: "MB" }), from_phoenix: true },
  ]);
  const phoenixSummary = buildManagerSummariesDetailed(phoenixRows, [], "2026-10-31").summaries[0];
  assert.deepEqual(
    { am: phoenixSummary.amVisits, pharmacies: phoenixSummary.pharmacyVisits, phoenix: phoenixSummary.phoenixVisits, pm: phoenixSummary.pmVisits },
    { am: 1, pharmacies: 0, phoenix: 3, pm: 2 },
  );
  assert.match(service, /notePharmacyCells\(activity, /, "the workbook leaves a Phoenix-only Pharmacy Visits cell blank, never 0");
  assert.match(service, /notePharmacyCells\(byRole, /);
  assert.match(service, /notePharmacyCells\(trend, /);
  assert.equal(dsm!.teamMrCount, 5, "team = active MR descendants");
  assert.equal(dsm!.coveragePct, 60, "visited 3 of 6-in-team rule (3/5)");
  assert.equal(dsm!.neglectedMrCount, 2);
  assert.equal(dsm!.roleCode, "DSM");
  assert.equal(dsm!.firstDvDate, "2026-06-01");
  assert.equal(dsm!.lastDvDate, "2026-06-04");
  assert.ok(dsm!.effectivenessScore != null, "effectiveness score is computed when coverage is known");
  const pmSummary = dsmSummaries.find((s) => s.managerName === "Nahed");
  assert.ok(pmSummary, "PM summary present");
  assert.equal(pmSummary!.roleCode, "PM");
  assert.equal(pmSummary!.teamMrCount, null, "PM has no org-team denominator");
  assert.equal(pmSummary!.coveragePct, null);
  assert.equal(pmSummary!.neglectedMrCount, null);
  assert.equal(pmSummary!.effectivenessScore, null, "no coverage denominator means no effectiveness score");

  // Concentration (top-4 share) + off-directory visitor.
  const concRows = asRows([
    dvRow({ date: "2026-06-01", dvHrId: "X-1", visit: 3, visitedHrId: "MA" }),
    dvRow({ date: "2026-06-01", dvHrId: "X-1", visit: 3, visitedHrId: "MB" }),
    dvRow({ date: "2026-06-02", dvHrId: "X-1", visit: 2, visitedHrId: "MC" }),
    dvRow({ date: "2026-06-02", dvHrId: "X-1", visit: 1, visitedHrId: "MD" }),
    dvRow({ date: "2026-06-03", dvHrId: "X-1", visit: 1, visitedHrId: "ME" }),
  ]);
  const conc = buildManagerSummariesDetailed(concRows, [], "2026-06-30").summaries[0];
  assert.equal(conc.distinctMrs, 5);
  assert.equal(conc.concentrationPct, 90, "top-4 of 9/10 visits = 90%");
  assert.equal(conc.inDirectory, false, "visitor absent from directory");
  assert.equal(conc.roleCode, null);
  assert.equal(conc.teamMrCount, null);

  // Over-focused threshold max(5, 2*avg).
  const ofRows = asRows([
    dvRow({ date: "2026-06-01", dvHrId: "Y-1", visit: 8, visitedHrId: "MA" }),
    dvRow({ date: "2026-06-02", dvHrId: "Y-1", visit: 1, visitedHrId: "MB" }),
    dvRow({ date: "2026-06-03", dvHrId: "Y-1", visit: 1, visitedHrId: "MC" }),
  ]);
  assert.equal(buildManagerSummariesDetailed(ofRows, [], "2026-06-30").summaries[0].overFocusedMrCount, 1);

  // Null-visited rows count as effort but not as a distinct MR.
  const nullRows = asRows([
    dvRow({ date: "2026-06-01", dvHrId: "Z-1", visit: 4, visitedHrId: null }),
    dvRow({ date: "2026-06-01", dvHrId: "Z-1", visit: 2, visitedHrId: "MA" }),
  ]);
  const nullSummary = buildManagerSummariesDetailed(nullRows, [], "2026-06-30").summaries[0];
  assert.equal(nullSummary.totalDvs, 6, "unmapped visits still count as effort");
  assert.equal(nullSummary.distinctMrs, 1, "unmapped visit does not add a distinct MR");

  // ── Executive summary: idle managers + insights ─────────────────────────────
  const execEmployees = [
    ...dsmEmployees,
    employee({ fullName: "Idle Boss", hrId: "B-99", jobTitle: "District Sales Manager", positionTitle: "District Sales Manager" }),
  ];
  const { summaries: execSummaries, visitedKeysByManager } = buildManagerSummariesDetailed(dsmRows, execEmployees, "2026-06-30");
  const execKpis: DoubleVisitKpis = { ...zeroKpis, amVisitCount: 113, pmVisitCount: 543, totalVisits: 656 };
  const exec = buildExecutiveSummary(execSummaries, [], execKpis, execEmployees, visitedKeysByManager);
  assert.ok(exec.idleManagers.some((m) => m.hrId === canonicalHrIdKey("B-99")), "DSM with zero DVs is idle");
  assert.ok(!exec.idleManagers.some((m) => m.hrId === canonicalHrIdKey("B-10")), "active DSM is not idle");
  // An idle field manager carries his team size (owner, 2026-10-20), counted like an active one's:
  // active medical reps only, anywhere beneath him; a role with no field team carries null.
  const idleTeamEmployees = [
    ...execEmployees,
    employee({ fullName: "Idle Team DSM", hrId: "B-98", jobTitle: "District Sales Manager", positionTitle: "District Sales Manager" }),
    employee({ fullName: "Idle Team Rep", hrId: "M-81", managerHrId: "B-98" }),
    employee({ fullName: "Left Rep", hrId: "M-82", managerHrId: "B-98", employmentStatus: "resigned" }),
    employee({ fullName: "Idle PM", hrId: "A-11", jobTitle: "Product Manager", positionTitle: "Product Manager" }),
  ];
  const idleTeamExec = buildExecutiveSummary(execSummaries, [], execKpis, idleTeamEmployees, visitedKeysByManager);
  assert.equal(idleTeamExec.idleManagers.find((m) => m.hrId === canonicalHrIdKey("B-98"))?.teamMrCount, 1, "an idle DSM's team is his active reps, never a leaver");
  assert.equal(idleTeamExec.idleManagers.find((m) => m.hrId === canonicalHrIdKey("B-99"))?.teamMrCount, 0, "an idle DSM with no reps has a team of 0");
  assert.equal(idleTeamExec.idleManagers.find((m) => m.hrId === canonicalHrIdKey("A-11"))?.teamMrCount, null, "a role with no field team carries no team size");
  assert.ok(exec.roleRollups.some((r) => r.roleCode === "DSM"), "DSM rollup present");
  assert.ok(exec.roleRollups.some((r) => r.roleCode === "PM"), "PM rollup present");
  const ampm = exec.insights.find((i) => i.id === "ampm-imbalance");
  assert.ok(ampm, "AM/PM imbalance insight present");
  assert.equal(ampm!.title, "AM · PM balance", "the balance insight never joins the pair with a slash");
  const withPharmacies = buildExecutiveSummary(execSummaries, [], { ...execKpis, pharmacyVisitCount: 40 }, execEmployees, visitedKeysByManager)
    .insights.find((i) => i.id === "ampm-imbalance");
  assert.match(withPharmacies!.detail, /113 AM vs 543 PM \(17% AM\), with 40 pharmacy visits counted apart\./, "pharmacy visits are named apart and never tip the AM · PM balance");
  assert.equal(ampm!.managerHrId, null, "org-wide insight has no manager link");
  exec.insights.forEach((insight, index) => assert.equal(insight.rank, index, "insight ranks are contiguous"));
  const severityWeight: Record<string, number> = { critical: 0, info: 2, positive: 3, warning: 1 };
  for (let i = 1; i < exec.insights.length; i += 1) {
    assert.ok(severityWeight[exec.insights[i - 1].severity] <= severityWeight[exec.insights[i].severity], "insights sorted by severity");
  }

  // ── Manager × MR pairs: "29 visits in how many days?" ───────────────────────
  const pairLog: DoubleVisitLogEntry[] = [
    logEntry({ date: "2026-06-01", dvHrId: "B-10", dvName: "Saad Salama", period: "AM", visit: 5, visitedHrId: "M-9", visitedName: "Ahmed Ashraf" }),
    logEntry({ date: "2026-06-01", dvHrId: "B-10", dvName: "Saad Salama", period: "PM", visit: 4, visitedHrId: "M-9", visitedName: "Ahmed Ashraf" }),
    logEntry({ date: "2026-06-02", dvHrId: "B-10", dvName: "Saad Salama", period: "PM", visit: 6, visitedHrId: "M-9", visitedName: "Ahmed Ashraf" }),
    logEntry({ date: "2026-06-03", dvHrId: "B-10", dvName: "Saad Salama", period: "PM", visit: 5, visitedHrId: "M-9", visitedName: "Ahmed Ashraf" }),
    logEntry({ date: "2026-06-04", dvHrId: "B-10", dvName: "Saad Salama", period: "PM", visit: 4, visitedHrId: "M-9", visitedName: "Ahmed Ashraf" }),
    logEntry({ date: "2026-06-05", dvHrId: "B-10", dvName: "Saad Salama", period: "PM", visit: 3, visitedHrId: "M-9", visitedName: "Ahmed Ashraf" }),
    logEntry({ date: "2026-06-06", dvHrId: "B-10", dvName: "Saad Salama", period: "PM", visit: 2, visitedHrId: "M-9", visitedName: "Ahmed Ashraf" }),
    logEntry({ date: "2026-06-02", dvHrId: "B-10", dvName: "Saad Salama", period: "PM", visit: 2, visitedHrId: "M-2", visitedName: "Other MR" }),
  ];
  const pairs = buildManagerMrPairs(pairLog);
  const topPair = pairs[0];
  assert.equal(topPair.mrName, "Ahmed Ashraf", "pairs sorted by visits desc");
  assert.equal(topPair.visits, 29, "29 total visits");
  assert.equal(topPair.days, 6, "AM+PM on the same date collapse to one day → 6 distinct days");
  assert.equal(topPair.visitsPerDay, 4.83, "29 visits across 6 days");
  assert.equal(topPair.firstDate, "2026-06-01");
  assert.equal(topPair.lastDate, "2026-06-06");
  assert.equal(pairs[1].visits, 2, "second pair after the heavy one");

  // ── PM/GPM double-visit scope = self + reporting chain, WIDENED to their whole product
  //    LINE. Production keys lines by numeric line_id (line_name is null on manager records),
  //    so the widening resolves the line via sameWorkforceLine(line_id) and pulls EVERY line
  //    member into allowedHrIds — including same-line peers who do NOT org-report to the PM.
  //    See resolveDoubleVisitAccessScope. Also covers the portal roles (DSM/RM/NSM/PM/GPM)
  //    that read the live source via getDoubleVisitReportData/getDoubleVisitDashboardData. ──
  const scopeEmployees = [
    employee({ fullName: "PM Owner", hrId: "A-10", lineId: 1, positionTitle: "Product Manager" }),
    employee({ fullName: "DSM Under PM", hrId: "B-10", lineId: 1, managerHrId: "A-10" }),
    employee({ fullName: "Rep One", hrId: "M-1", lineId: 1, managerHrId: "B-10" }),
    employee({ fullName: "Rep Two", hrId: "M-2", lineId: 1, managerHrId: "B-10" }),
    // Same line (line_id 1), reports OUTSIDE the PM's chain — visible via the LINE scope.
    employee({ fullName: "Same Line Peer", hrId: "M-9", lineId: 1, managerHrId: "B-77" }),
    // Different product line (line_id 2) — must NOT be visible.
    employee({ fullName: "Other Line Rep", hrId: "M-20", lineId: 2, managerHrId: "B-88" }),
  ];
  const k = (id: string) => normalizeHrIdForAccess(id) as string;
  const pmAccess = { hrId: "A-10", loginId: "A-10", role: "Product Manager", scope: "line", source: "session" };
  const pmScope = resolveDoubleVisitAccessScope(
    pmAccess as unknown as Parameters<typeof resolveDoubleVisitAccessScope>[0],
    scopeEmployees,
  );
  assert.equal(pmScope.all, false, "PM is not granted org-wide double-visit access");
  if (pmScope.all === false) {
    assert.ok(pmScope.allowedHrIds.has(k("A-10")), "PM sees herself");
    assert.ok(pmScope.allowedHrIds.has(k("B-10")), "PM sees the DSM reporting to her");
    assert.ok(pmScope.allowedHrIds.has(k("M-1")), "PM sees reps under her DSM");
    assert.ok(pmScope.allowedHrIds.has(k("M-2")), "PM sees reps under her DSM");
    // Widened to the whole product line (by line_id): a same-line peer OUTSIDE the reporting
    // chain IS in scope — this is what makes the GPM/PM "by manager" view whole.
    assert.ok(pmScope.allowedHrIds.has(k("M-9")), "PM sees a same-line peer via line widening");
    // ...but a different product line stays out of scope.
    assert.ok(!pmScope.allowedHrIds.has(k("M-20")), "PM does NOT see a different product line");
  }

  // DSM scope = reporting chain only (no line widening) — the portal's Double Visit Report
  // page (getDoubleVisitReportData) relies on exactly this scoping for DSM/RM.
  const dsmScope = resolveDoubleVisitAccessScope(
    { hrId: "B-10", loginId: "B-10", role: "District Manager", scope: "team", source: "session" } as unknown as Parameters<typeof resolveDoubleVisitAccessScope>[0],
    scopeEmployees,
  );
  assert.equal(dsmScope.all, false, "DSM is not granted org-wide double-visit access");
  if (dsmScope.all === false) {
    assert.ok(dsmScope.allowedHrIds.has(k("M-1")), "DSM sees direct reports");
    assert.ok(!dsmScope.allowedHrIds.has(k("M-9")), "DSM does NOT get the PM's line-wide widening");
  }

  // Regional Manager scope (owner rule 2026-07-18) = the RM's OWN line ∩ the regions his
  // direct-report DMs cover. His own region label is a coarse parent ("Alexandria + Delta") that
  // need not match the finer rep region labels, so the region set is derived from his DMs; the line
  // is bound by line_id. The previous area/line-label expansion leaked BOTH across lines and across
  // regions, so it is gone (allowedAreas/allowedLines stay empty).
  const regionEmployees = [
    employee({ fullName: "RM Owner", hrId: "R-1", jobTitle: "Regional Sales Manager", lineId: 1, regionName: "Alexandria + Delta" }),
    employee({ fullName: "His DM", hrId: "D-1", jobTitle: "District Sales Manager", lineId: 1, managerHrId: "R-1", regionName: "Delta (1)" }),
    // Same line, in a region his DM covers, but reports to a DIFFERENT DM — still in scope via line∩region.
    employee({ fullName: "In-Line In-Region", hrId: "M-40", lineId: 1, managerHrId: "B-99", regionName: "Delta (1)" }),
    // Same line, in a region he does NOT cover.
    employee({ fullName: "In-Line Out-Region", hrId: "M-41", lineId: 1, managerHrId: "B-99", regionName: "Upper Egypt" }),
    // Different line, in his region — must NOT leak across the line boundary.
    employee({ fullName: "Cross-Line In-Region", hrId: "M-42", lineId: 2, managerHrId: "B-99", regionName: "Delta (1)" }),
  ];
  const rmScope = resolveDoubleVisitAccessScope(
    { hrId: "R-1", loginId: "R-1", role: "Regional Manager", scope: "region", source: "session" } as unknown as Parameters<typeof resolveDoubleVisitAccessScope>[0],
    regionEmployees,
  );
  assert.equal(rmScope.all, false, "Regional Manager is not granted org-wide double-visit access");
  if (rmScope.all === false) {
    assert.ok(rmScope.allowedHrIds.has(k("M-40")), "RM sees a same-line rep in a region his DM covers");
    assert.ok(!rmScope.allowedHrIds.has(k("M-41")), "RM does NOT see a same-line rep in a region he doesn't cover");
    assert.ok(!rmScope.allowedHrIds.has(k("M-42")), "RM does NOT see a different-line rep even in his region");
    assert.equal(rmScope.allowedAreas.size, 0, "RM area allow-set stays empty (no cross-line area leak)");
    assert.equal(rmScope.allowedLines.size, 0, "RM line allow-set stays empty (no line-label leak)");
  }

  // line_name fallback: when line_id is absent, widening matches on the normalized line name.
  const nameScope = resolveDoubleVisitAccessScope(
    { hrId: "A-30", loginId: "A-30", role: "Group Product Manager", scope: "line", source: "session" } as unknown as Parameters<typeof resolveDoubleVisitAccessScope>[0],
    [
      employee({ fullName: "GPM Owner", hrId: "A-30", lineName: "CNS", positionTitle: "Group Product Manager" }),
      employee({ fullName: "CNS Peer", hrId: "M-31", lineName: "CNS", managerHrId: "B-99" }),
      employee({ fullName: "GI Rep", hrId: "M-32", lineName: "GI", managerHrId: "B-99" }),
    ],
  );
  assert.equal(nameScope.all, false);
  if (nameScope.all === false) {
    assert.ok(nameScope.allowedHrIds.has(k("M-31")), "GPM sees a same-line peer via line-name fallback");
    assert.ok(!nameScope.allowedHrIds.has(k("M-32")), "GPM does NOT see a different line");
    assert.ok(nameScope.allowedLines.has("cns"), "line label captured when present");
  }

  // A PM with nobody reporting to her and no resolvable line sees only herself.
  const loneScope = resolveDoubleVisitAccessScope(
    { hrId: "A-77", loginId: "A-77", role: "Group Product Manager", scope: "line", source: "session" } as unknown as Parameters<typeof resolveDoubleVisitAccessScope>[0],
    scopeEmployees,
  );
  assert.equal(loneScope.all, false);
  if (loneScope.all === false) {
    assert.deepEqual([...loneScope.allowedHrIds], [k("A-77")], "a GPM with no reports sees only herself");
  }

  // Training Manager keeps full read access (unchanged by this fix).
  const tmScope = resolveDoubleVisitAccessScope(
    { hrId: "T-1", loginId: "T-1", role: "Training Manager", scope: "line", source: "session" } as unknown as Parameters<typeof resolveDoubleVisitAccessScope>[0],
    scopeEmployees,
  );
  assert.equal(tmScope.all, true, "Training Manager retains org-wide double-visit visibility");

  // National Sales Manager is scoped to HIS OWN chain (self + everyone reporting up to him),
  // NOT company-wide. An unrelated branch that does not report to him stays out of scope.
  const nsmEmployees = [
    employee({ fullName: "NSM Owner", hrId: "N-1", positionTitle: "National Sales Manager" }),
    employee({ fullName: "RM Under NSM", hrId: "R-9", managerHrId: "N-1" }),
    employee({ fullName: "DSM Under RM", hrId: "D-9", managerHrId: "R-9" }),
    employee({ fullName: "Rep Under DSM", hrId: "M-50", managerHrId: "D-9" }),
    // A different NSM's rep — must NOT be visible.
    employee({ fullName: "Other Chain Rep", hrId: "M-99", managerHrId: "D-8" }),
  ];
  const nsmScope = resolveDoubleVisitAccessScope(
    { hrId: "N-1", loginId: "N-1", role: "National Sales Manager", scope: "line", source: "session" } as unknown as Parameters<typeof resolveDoubleVisitAccessScope>[0],
    nsmEmployees,
  );
  assert.equal(nsmScope.all, false, "NSM is not granted company-wide double-visit access");
  if (nsmScope.all === false) {
    assert.ok(nsmScope.allowedHrIds.has(k("N-1")), "NSM sees himself");
    assert.ok(nsmScope.allowedHrIds.has(k("R-9")), "NSM sees the RM reporting to him");
    assert.ok(nsmScope.allowedHrIds.has(k("D-9")), "NSM sees the DSM down his chain");
    assert.ok(nsmScope.allowedHrIds.has(k("M-50")), "NSM sees the rep down his chain");
    assert.ok(!nsmScope.allowedHrIds.has(k("M-99")), "NSM does NOT see a rep outside his chain");
  }

  // ── Portal-focus probation watchlist is intersected with the viewer's double-visit scope ────
  // getProbationRows is intentionally broader than the DV scope for some roles (an NSM gets his
  // whole line, but his double-visit scope is only his reporting chain), so the portal-focus
  // probation watchlist MUST be filtered down to the same filterEmployeesForDoubleVisitAccess set
  // the coverage roster uses — otherwise a viewer sees probation alarms for med reps outside his
  // double-visit scope (the coverage/trend blocks never had that leak).
  const focusFn = service.slice(
    service.indexOf("export async function getDoubleVisitPortalFocus"),
    service.indexOf("export async function getDoubleVisitReportData"),
  );
  assert.ok(focusFn.length > 0, "getDoubleVisitPortalFocus body located for scope-intersection check");
  assert.match(
    focusFn,
    /const scopedEmployees = filterEmployeesForDoubleVisitAccess\(employees, access\)/,
    "portal focus resolves the DV-scoped employee set",
  );
  assert.match(focusFn, /scopedHrKeys/, "portal focus builds a DV-scoped key set for the probation watchlist");
  assert.match(
    focusFn,
    /medicalRepProbationRows = probationRows\.filter\(\(row\) => \{[\s\S]*?scopedHrKeys\.has\(key\)/,
    "the probation watchlist is intersected against the DV-scoped key set (no cross-scope leak)",
  );

  // ── DV_ROLE_CODES: Marketing Manager and SFE Manager resolve to a role code ─────────────────
  const mmSfeEmployees = [
    employee({ fullName: "Marketing Boss", hrId: "A-9", jobTitle: "Marketing Manager", positionTitle: "Marketing Manager" }),
    employee({ fullName: "SFE Boss", hrId: "A-2", jobTitle: "SFE Manager", positionTitle: "SFE Manager" }),
  ];
  const mmSfeRows = asRows([
    dvRow({ date: "2026-06-01", dvHrId: "A-9", visit: 3, visitedHrId: "M-1" }),
    dvRow({ date: "2026-06-01", dvHrId: "A-2", visit: 2, visitedHrId: "M-2" }),
  ]);
  const { summaries: mmSfeSummaries } = buildManagerSummariesDetailed(mmSfeRows, mmSfeEmployees, "2026-06-30");
  const mmSummary = mmSfeSummaries.find((s) => s.managerName === "Marketing Boss");
  const sfeSummary = mmSfeSummaries.find((s) => s.managerName === "SFE Boss");
  assert.equal(mmSummary?.roleCode, "MM", "Marketing Manager resolves to a DV role code");
  assert.equal(sfeSummary?.roleCode, "SFE", "SFE Manager resolves to a DV role code");

  // ── Same-day chain resolution: senior manager rides along on a junior manager's DV ──────────
  // The CRM stores only one partner per visit row, so an NSM accompanying a DM who is himself
  // double-visiting an MR shows up as two records on the same day: NSM→DM (visited party is a
  // manager, normally discarded) and DM→MR. resolveDoubleVisitChains follows the hinge (the DM)
  // down to the real MR and re-credits the NSM. Modeled on the proven B-122/B-117/B-137 case.
  type MirrorInput = {
    agent: string;
    agentName?: string;
    ampm?: "AM" | "PM" | "UNKNOWN";
    contact?: string;
    date?: string;
    double: string;
    doubleName?: string;
    id: string;
  };
  const mirrorRow = (input: MirrorInput): Record<string, unknown> => ({
    agent_hr_id: input.agent,
    agent_name: input.agentName ?? null,
    ampm: input.ampm ?? "PM",
    contact_name: input.contact ?? null,
    crm_visit_id: 1,
    customer_name: null,
    double_crm_id: 1,
    double_hr_id: input.double,
    double_name: input.doubleName ?? null,
    id: input.id,
    visit_type: null,
    visit_type_description: null,
    visit_date: input.date ?? "2026-07-01",
  });
  type MirrorRows = Parameters<typeof resolveDoubleVisitChains>[0];
  const asMirror = (rows: Array<Record<string, unknown>>) => rows as unknown as MirrorRows;
  const cK = (id: string) => canonicalHrIdKey(id);
  const setOf = (...ids: string[]) => new Set(ids.map((id) => cK(id)).filter((k): k is string => Boolean(k)));

  // Proven case: NSM B-122 rode along with DM B-117, who double-visited MR B-137.
  const provenManagers = setOf("B-122", "B-117");
  const provenMrs = setOf("B-137");
  const provenRows = asMirror([
    mirrorRow({ id: "nsm-1", agent: "B-117", agentName: "Sameh", double: "B-122", doubleName: "Amr" }),
    mirrorRow({ id: "nsm-2", agent: "B-117", agentName: "Sameh", double: "B-122", doubleName: "Amr" }),
    mirrorRow({ id: "dm-1", agent: "B-137", agentName: "Samir Saad", double: "B-117", contact: "Dr A" }),
    mirrorRow({ id: "dm-2", agent: "B-137", agentName: "Samir Saad", double: "B-117", contact: "Dr B" }),
  ]);
  const proven = resolveDoubleVisitChains(provenRows, (k) => provenManagers.has(k), (k) => provenMrs.has(k));
  assert.equal(cK(proven.get("nsm-1")?.mrHrId ?? ""), cK("B-137"), "NSM's manager-visited row resolves to the real MR");
  assert.equal(cK(proven.get("nsm-2")?.mrHrId ?? ""), cK("B-137"), "every NSM→DM row on that day resolves to the MR");
  assert.equal(proven.get("nsm-1")?.hingeHrId, "B-117", "the hinge is the junior (DM) manager");
  assert.ok(proven.get("nsm-1")?.customerNames.includes("Dr A"), "recovered chain carries the real customers");
  assert.equal(proven.has("dm-1"), false, "a genuine manager→MR row is not itself a recovered chain");

  // No downstream MR → a real manager→manager visit stays flagged (never invented).
  const orphan = resolveDoubleVisitChains(
    asMirror([mirrorRow({ id: "x", agent: "B-117", double: "B-122" })]),
    (k) => provenManagers.has(k),
    (k) => provenMrs.has(k),
  );
  assert.equal(orphan.has("x"), false, "no same-day MR chain means no resolution");

  // Ambiguous: the DM double-visited TWO MRs that day (same period) → do not guess.
  const ambiguousMrs = setOf("B-137", "B-200");
  const ambiguous = resolveDoubleVisitChains(
    asMirror([
      mirrorRow({ id: "r", agent: "B-117", double: "B-122" }),
      mirrorRow({ id: "d1", agent: "B-137", double: "B-117" }),
      mirrorRow({ id: "d2", agent: "B-200", double: "B-117" }),
    ]),
    (k) => provenManagers.has(k),
    (k) => ambiguousMrs.has(k),
  );
  assert.equal(ambiguous.has("r"), false, "two downstream MRs on the same day is ambiguous → left flagged");

  // Period disambiguation: DM saw MR-AM in the morning and MR-PM in the afternoon; the NSM's
  // PM ride-along resolves to the PM MR, not the ambiguous whole-day union.
  const periodRes = resolveDoubleVisitChains(
    asMirror([
      mirrorRow({ id: "r", agent: "B-117", double: "B-122", ampm: "PM" }),
      mirrorRow({ id: "dAM", agent: "B-137", double: "B-117", ampm: "AM" }),
      mirrorRow({ id: "dPM", agent: "B-200", double: "B-117", ampm: "PM" }),
    ]),
    (k) => provenManagers.has(k),
    (k) => ambiguousMrs.has(k),
  );
  assert.equal(cK(periodRes.get("r")?.mrHrId ?? ""), cK("B-200"), "period picks the matching-half MR");

  // Multi-level convoy: GM → NSM → DM → MR all resolve transitively to the same MR.
  const chainManagers = setOf("G-1", "N-1", "D-1");
  const chainMrs = setOf("M-1");
  const multi = resolveDoubleVisitChains(
    asMirror([
      mirrorRow({ id: "gm", agent: "N-1", double: "G-1" }),
      mirrorRow({ id: "nsm", agent: "D-1", double: "N-1" }),
      mirrorRow({ id: "dm", agent: "M-1", double: "D-1" }),
    ]),
    (k) => chainManagers.has(k),
    (k) => chainMrs.has(k),
  );
  assert.equal(cK(multi.get("gm")?.mrHrId ?? ""), cK("M-1"), "GM resolves transitively through NSM+DM to the MR");
  assert.equal(cK(multi.get("nsm")?.mrHrId ?? ""), cK("M-1"), "NSM resolves through the DM to the MR");

  // The Data Integrity workspace no longer surfaces recovered chains — that audit moved to the
  // Visits Report page (Recovered Chains tab), per owner decision.
  const integrity = readFileSync("src/components/double-visit-analytics/double-visit-data-integrity-workspace.tsx", "utf8");
  assert.doesNotMatch(integrity, /Recovered Via Chain/i, "recovered-chain audit UI must not live on the Data Integrity page");
  assert.doesNotMatch(integrity, /recoveredChains/, "the Integrity workspace must not read recoveredChains any more");

  // The CRM hub page + its recovered-chains panel now own the Recovered Chains audit tab
  // (moved from the former Visits Report page when it merged into the hub).
  const crmHubPage = readFileSync("app/(admin)/admin/crm/page.tsx", "utf8");
  assert.match(crmHubPage, /getDoubleVisitRecoveredChains/, "the CRM hub page loads recovered chains");
  assert.match(crmHubPage, /view === "recovered"/, "the CRM hub page recognizes the recovered view");

  const recoveredChainsPanel = readFileSync("src/components/crm/crm-recovered-chains-panel.tsx", "utf8");
  assert.match(recoveredChainsPanel, /Recovered via chain/, "the CRM recovered-chains panel has its recovered-chain audit copy");
  assert.match(recoveredChainsPanel, /CrmRecoveredChainsPanel/, "the panel component is named CrmRecoveredChainsPanel");
  assert.match(recoveredChainsPanel, /DoubleVisitRecoveredChain/, "the panel types against the shared DoubleVisitRecoveredChain shape");
}
