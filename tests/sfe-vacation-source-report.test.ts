import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { adminNavigationSections } from "../src/config/system-navigation.ts";
import {
  canApproveCompanyVacationReportRow,
  canReadCompanyVacationReport,
  permissionActions,
  permissionMatrix,
  permissionResources,
  phoenixRoles,
  type PhoenixRole,
} from "../src/lib/auth/permissions.ts";
import { getSections, type PermissionLookup } from "../src/lib/navigation/active-path.ts";
import type { CompanyVacationReportRow } from "../src/lib/vacation/company-vacation-report.ts";
import {
  companyVacationSourceSystem,
  COMPANY_VACATION_REPORT_SOURCES,
  COMPANY_VACATION_SOURCE_SYSTEMS,
} from "../src/lib/vacation/company-vacation-report-source.ts";
import { generateCompanyVacationReportWorkbook } from "../src/lib/vacation/company-vacation-report-export.ts";
import {
  describeCompanyVacationReportFilters,
  filterCompanyVacationReportRows,
  isCompanyVacationReportApplied,
  parseCompanyVacationReportFilters,
  companyVacationReportFilterParams,
  COMPANY_VACATION_REPORT_FILTER_KEYS,
  NO_COMPANY_VACATION_REPORT_FILTERS,
} from "../src/lib/vacation/company-vacation-report-filters.ts";
import {
  companyVacationReportRangeParams,
  COMPANY_VACATION_REPORT_DEFAULT_START_DATE,
  COMPANY_VACATION_REPORT_EARLIEST_DATE,
  isIsoDateOnly,
  resolveCompanyVacationReportRange,
} from "../src/lib/vacation/company-vacation-report-range.ts";

/**
 * The SFE Manager's vacation report (owner request, 2026-08-27): he sees every employee's leave
 * org-wide with the SOURCE of each day on the row — a request submitted through Phoenix, or a
 * vacation the field CRM recorded on its own — and he can export it. He cannot add anything.
 *
 * Four things have to hold, and only the first is obvious:
 *
 *  1. He can READ the report and he CANNOT approve from it — two independent gates, so widening
 *     one can never quietly widen the other.
 *  2. The Source System answer is derivable for EVERY source value, and the exhaustive
 *     `Record<CompanyVacationReportSource, ...>` lookups built on that union really are exhaustive.
 *     `next.config` sets `typescript: { ignoreBuildErrors: true }`, so a Record missing a key
 *     compiles, builds and DEPLOYS — the workbook would hand ExcelJS `undefined` as an ARGB fill.
 *     The type-level half of that guard lives in company-vacation-report.ts; this is the runtime
 *     half, which is the only half the build actually runs.
 *  3. The new column and the new filter reach the workbook, because the owner's standing rule is
 *     that an export matches the screen it came from.
 *  4. The row is really on his sidebar — a page he cannot navigate to is not a report he has.
 */

const EXPORT_ROUTE_SOURCE = readFileSync(
  new URL("../app/api/vacation/company-report/export/route.ts", import.meta.url),
  "utf8",
);
const APPROVE_ROUTE_SOURCE = readFileSync(
  new URL("../app/api/vacation/company-report/approve/route.ts", import.meta.url),
  "utf8",
);
const TABLE_SOURCE = readFileSync(
  new URL("../src/components/vacation/company-vacation-report-table.tsx", import.meta.url),
  "utf8",
);
const PAGE_SOURCE = readFileSync(
  new URL("../app/(admin)/admin/vacation-report/page.tsx", import.meta.url),
  "utf8",
);
const SOURCE_MODULE = readFileSync(
  new URL("../src/lib/vacation/company-vacation-report-source.ts", import.meta.url),
  "utf8",
);
const FILTERS_MODULE = readFileSync(
  new URL("../src/lib/vacation/company-vacation-report-filters.ts", import.meta.url),
  "utf8",
);
const REPORT_MODULE = readFileSync(
  new URL("../src/lib/vacation/company-vacation-report.ts", import.meta.url),
  "utf8",
);

/** scope "company" is what every real non-Super-Admin session carries; "system" is only ever set
 * on the internal systemAccessContext object, which is paired with role "Super Admin". */
function context(role: PhoenixRole) {
  return { role, scope: "company" as const };
}

function lookupForRole(role: PhoenixRole): PermissionLookup {
  const lookup: PermissionLookup = {};
  for (const resource of permissionResources) {
    for (const action of permissionActions) {
      lookup[`${resource}:${action}`] = permissionMatrix[role][resource]?.includes(action) ?? false;
    }
  }
  return lookup;
}

/** Mirrors app-shell.tsx. The system-administrator waiver is no longer a flag the caller passes —
 * getSections applies it itself, to `roles` only, and honours excludedRoles and permissions for
 * every role including Super Admin. Passing `role` is all a caller needs. */
function sidebarHrefsFor(role: PhoenixRole): string[] {
  return getSections(adminNavigationSections, "admin", lookupForRole(role), role)
    .flatMap((section) => section.items.map((item) => item.href));
}

function row(overrides: Partial<CompanyVacationReportRow> & { hrId: string }): CompanyVacationReportRow {
  return {
    balanceAfterDays: null,
    balanceBeforeDays: null,
    dayPart: null,
    detail: "annual",
    employeeName: "Test Employee",
    endDate: "2026-03-01",
    hasBalance: null,
    jobTitle: "Medical Representative",
    lineName: "CNS",
    requestId: null,
    source: "HR Approved",
    startDate: "2026-03-01",
    workingDays: 1,
    ...overrides,
  };
}

export function runSfeVacationSourceReportTests() {
  // -- (1) Read is widened to the SFE Manager; approve is NOT -----------------------------------
  assert.equal(
    canReadCompanyVacationReport(context("SFE Manager")),
    true,
    "the SFE Manager must be able to open the company vacation report - this is the whole request",
  );
  assert.equal(canReadCompanyVacationReport(context("Super Admin")), true, "Super Admin keeps the access he already had");
  assert.equal(
    canApproveCompanyVacationReportRow(context("SFE Manager")),
    false,
    "the SFE Manager must NOT be able to turn a CRM Signal into a real, balance-deducting vacation - the owner said he can read and export, and cannot add",
  );
  assert.equal(canApproveCompanyVacationReportRow(context("Super Admin")), true, "Super Admin keeps the approve authority");

  // Named exhaustively over phoenixRoles so a NEW role cannot be admitted by default.
  //
  // HR Operations joined on 2026-08-29, by the owner's ruling that the seat carries company scope.
  // It is a widening somebody DID ask for, which is the only reason this list moved: the guard
  // caught the change on the first CI run and made the edit deliberate, which is what it is for.
  // Her job description's second area is "Maintain leave balances and ensure approved leave is
  // correctly recorded", and this report is that. Membership of companyVacationReportReaderRoles is
  // what admits her, NOT her scope - the predicate short-circuits on scope === "system" and hers is
  // "company", so the named set remains the only door. The approvers assertion below is unchanged,
  // and it is the half that matters: she reads and exports this report and can turn nothing on it
  // into a balance-deducting request.
  const readers = phoenixRoles.filter((role) => canReadCompanyVacationReport(context(role)));
  assert.deepEqual(
    [...readers].sort(),
    ["HR Administration", "HR Operations", "SFE Manager", "Super Admin"],
    "exactly four roles may read the company vacation report - a fifth arriving here is a widening nobody asked for",
  );
  const approvers = phoenixRoles.filter((role) => canApproveCompanyVacationReportRow(context(role)));
  assert.deepEqual([...approvers].sort(), ["Super Admin"], "approving from this report stays Super Admin only");

  // The UI gate is a courtesy; the server gate is the boundary. Pinned as source because the
  // failure mode is silent - a route that stops asserting still returns 200.
  assert.ok(
    EXPORT_ROUTE_SOURCE.includes("assertCompanyVacationReportReadAccess(access"),
    "the export route must assert the READ gate, or the SFE Manager's Export Excel link 403s",
  );
  assert.ok(
    APPROVE_ROUTE_SOURCE.includes("assertSystemAdministratorWorkspaceAccess(access"),
    "the approve route must keep asserting system-administrator access - hiding the button is not the boundary",
  );
  assert.ok(
    !APPROVE_ROUTE_SOURCE.includes("assertCompanyVacationReportReadAccess"),
    "the approve route must never fall back to the read gate",
  );
  assert.ok(
    PAGE_SOURCE.includes("canReadCompanyVacationReport(access)") && PAGE_SOURCE.includes("canApproveCompanyVacationReportRow(access)"),
    "the page must ask BOTH questions - who may open it, and who may write from it",
  );
  assert.ok(
    TABLE_SOURCE.includes("canApprove: boolean;") && TABLE_SOURCE.includes("{canApprove ? ("),
    "the table must take canApprove and render the Review column conditionally, not always",
  );
  assert.ok(
    !/canApprove\s*=\s*(true|false)/.test(TABLE_SOURCE),
    "canApprove must have no default - a new surface must be made to decide, not inherit write controls by omission",
  );

  // -- (2) Source System, for every source value there is ----------------------------------------
  // Runtime proof the exported list really is the whole union: parsed off the type declaration
  // itself, so adding a seventh member without listing it fails here even though the build ignores
  // type errors. Parsed by regex on the declaration rather than a fixed byte window - a slice goes
  // false-red the moment anything above it shifts.
  const declaration = /export type CompanyVacationReportSource =\s*([^;]*);/.exec(SOURCE_MODULE);
  assert.ok(declaration, "CompanyVacationReportSource must still be a plain union declaration");
  const declared = [...declaration[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(
    [...COMPANY_VACATION_REPORT_SOURCES].sort(),
    [...declared].sort(),
    "COMPANY_VACATION_REPORT_SOURCES must list every member of the union - the Records keyed on it are only as exhaustive as this list",
  );

  // The source vocabulary lives in a leaf module with no server imports, because the table is a
  // client component and company-vacation-report.ts reaches node:crypto through @/lib/crm/reads.
  // Importing a VALUE from it there fails the build outright (UnhandledSchemeError) — a type-only
  // import is what has always kept that page compiling. This pins the split.
  //
  // Checked by walking the actual import statements rather than with one clever negative-lookahead
  // regex: what this guards against is a hard build error, so the check has to be unambiguous
  // about which statement it is objecting to.
  const serverModuleImports = [...TABLE_SOURCE.matchAll(/import\s+(type\s+)?\{[^}]*\}\s*from\s*"@\/lib\/vacation\/company-vacation-report";/g)];
  assert.ok(serverModuleImports.length > 0, "the table still reads the row type from the report module");
  for (const statement of serverModuleImports) {
    assert.ok(
      statement[1],
      `the client table must not take a VALUE import from company-vacation-report - that drags node:crypto into the client bundle and 500s the page. Offending statement: ${statement[0]}`,
    );
  }
  assert.ok(
    SOURCE_MODULE.includes("export function companyVacationSourceSystem"),
    "the Phoenix/CRM mapping must live in the leaf module the client can import",
  );
  assert.equal(
    (SOURCE_MODULE.match(/^import\s/gm) ?? []).length,
    0,
    "the leaf module must import nothing at all - staying off the server graph is the only reason it exists",
  );
  // The filter module is ALSO on the client bundle (the table imports values from it), so the same
  // hazard applies one step further out: it may import company-vacation-report for the row TYPE and
  // nothing else, and every VALUE it imports must come from a module with no imports of its own.
  // That is what let the leave-type vocabulary move here when the leaf's zero-import rule refused
  // it - so it has to be checked, not assumed.
  const filterModuleImports = [...FILTERS_MODULE.matchAll(/import\s+(type\s+)?\{[^}]*\}\s*from\s*"@\/lib\/vacation\/company-vacation-report";/g)];
  for (const statement of filterModuleImports) {
    assert.ok(
      statement[1],
      `the filter module must not take a VALUE import from company-vacation-report - the client table imports it, so that drags node:crypto into the bundle. Offending statement: ${statement[0]}`,
    );
  }
  for (const leafPath of ["../src/lib/hr-id.ts", "../src/lib/vacation/types.ts"]) {
    const leaf = readFileSync(new URL(leafPath, import.meta.url), "utf8");
    assert.equal(
      (leaf.match(/^import\s/gm) ?? []).length,
      0,
      `${leafPath} is imported for VALUES by company-vacation-report-filters, which the client table bundles - it must stay import-free or the whole chain stops being client-safe`,
    );
  }
  assert.ok(
    REPORT_MODULE.includes('export type { CompanyVacationReportSource } from "@/lib/vacation/company-vacation-report-source"'),
    "company-vacation-report must re-export the source TYPE only - a value re-export quietly undoes the split",
  );

  const systems = new Set<string>();
  for (const source of COMPANY_VACATION_REPORT_SOURCES) {
    const system = companyVacationSourceSystem(source);
    assert.ok(
      (COMPANY_VACATION_SOURCE_SYSTEMS as readonly string[]).includes(system),
      `"${source}" must resolve to a real source system, got ${String(system)}`,
    );
    systems.add(system);
  }
  assert.deepEqual(
    [...systems].sort(),
    ["CRM", "Phoenix"],
    "both answers must actually occur - a mapping that said Phoenix for everything would pass a weaker check",
  );

  for (const crmSource of ["CRM Signal — Vacation", "CRM Signal — Half-Day (Attendance Partial)"] as const) {
    assert.equal(companyVacationSourceSystem(crmSource), "CRM", `${crmSource} was read out of the CRM, nobody submitted it here`);
  }
  for (const hrSource of ["HR Approved", "HR Pending", "HR Rejected", "HR Cancelled"] as const) {
    assert.equal(companyVacationSourceSystem(hrSource), "Phoenix", `${hrSource} is a request submitted on Phoenix, not a CRM reading`);
  }

  // -- (3) The filter, and the workbook that has to agree with it ---------------------------------
  const rows = [
    row({ hrId: "HR-1", source: "HR Approved" }),
    row({ hrId: "HR-2", source: "HR Pending" }),
    row({ hrId: "HR-3", source: "CRM Signal — Vacation" }),
    row({ hrId: "HR-4", source: "CRM Signal — Half-Day (Attendance Partial)" }),
  ];

  assert.deepEqual(
    filterCompanyVacationReportRows(rows, { ...NO_COMPANY_VACATION_REPORT_FILTERS, sourceSystem: "CRM" }).map((r) => r.hrId),
    ["HR-3", "HR-4"],
    "CRM narrows to both CRM Signal flavours in one click - that is why this filter exists beside the detailed Source one",
  );
  assert.deepEqual(
    filterCompanyVacationReportRows(rows, { ...NO_COMPANY_VACATION_REPORT_FILTERS, sourceSystem: "Phoenix" }).map((r) => r.hrId),
    ["HR-1", "HR-2"],
    "Phoenix narrows to the requests actually submitted on this system, at any status",
  );
  assert.equal(
    filterCompanyVacationReportRows(rows, { ...NO_COMPANY_VACATION_REPORT_FILTERS, sourceSystem: "Invented" }).length,
    0,
    "an unrecognised value matches nothing - the safe direction, since the alternative silently WIDENS an export past the screen",
  );
  assert.equal(
    filterCompanyVacationReportRows(rows, NO_COMPANY_VACATION_REPORT_FILTERS).length,
    rows.length,
    "the default filter is inactive",
  );

  // The export link is a plain GET, so the filter only reaches the workbook if it survives a round
  // trip through the query string.
  const params = companyVacationReportFilterParams({ ...NO_COMPANY_VACATION_REPORT_FILTERS, sourceSystem: "CRM" });
  assert.equal(params.get("sourceSystem"), "CRM", "the export link must carry the source-system filter");
  assert.equal(
    parseCompanyVacationReportFilters(params).sourceSystem,
    "CRM",
    "the export route must read it back off the query string",
  );
  assert.equal(
    companyVacationReportFilterParams(NO_COMPANY_VACATION_REPORT_FILTERS).has("sourceSystem"),
    false,
    "an unfiltered export keeps its plain URL",
  );
  assert.ok(
    describeCompanyVacationReportFilters({ ...NO_COMPANY_VACATION_REPORT_FILTERS, sourceSystem: "CRM" })?.includes("Source: CRM"),
    "a filtered workbook has to say so on its own face - it gets forwarded without the screen it came from",
  );

  const sheet = generateCompanyVacationReportWorkbook({ endDate: "2026-03-31", rows, startDate: "2026-03-01" })
    .getWorksheet("Company Vacation Report");
  assert.ok(sheet, "the workbook must still carry its named sheet");
  const headers = (sheet.getRow(6).values as unknown[]).slice(1).map(String);
  assert.ok(
    headers.includes("Source System"),
    `the workbook must carry the Source System column the screen shows; got ${headers.join(", ")}`,
  );
  const systemColumn = headers.indexOf("Source System") + 1;
  assert.deepEqual(
    rows.map((_, index) => sheet.getRow(7 + index).getCell(systemColumn).value),
    ["Phoenix", "Phoenix", "CRM", "CRM"],
    "every exported row must answer the source question the same way the screen does",
  );
  for (const [index] of rows.entries()) {
    const fill = sheet.getRow(7 + index).getCell(1).fill as { fgColor?: { argb?: string } };
    assert.match(
      String(fill?.fgColor?.argb),
      /^FF[0-9A-F]{6}$/,
      "every source must have a real workbook fill - an unlisted one writes `undefined` as an ARGB, which the build would never catch",
    );
  }

  // -- (4) The row is really on his sidebar, once, and on nobody else's ---------------------------
  const sfeHrefs = sidebarHrefsFor("SFE Manager");
  assert.ok(
    sfeHrefs.includes("/admin/vacation-report"),
    "the SFE Manager must have a sidebar row for it - a page he cannot navigate to is not a report he has",
  );
  assert.equal(
    sfeHrefs.filter((href) => href === "/admin/vacation-report").length,
    1,
    "exactly one row - two rows onto the same page is the failure excludedRoles exists to prevent",
  );
  // -- REPOINTED 2026-09-05 ----------------------------------------------------------------------
  //
  // This was "and on nobody else's": a loop asserting no other role held the href at all. Its
  // stated reason was that Super Admin "already reaches the page from the hub" - which is exactly
  // what stopped being true. The owner ruled that no rail row may open a page of modules, so every
  // hub's cards became rail rows, and this page is a card on the People Management hub. Both roles
  // named on that card - Super Admin and HR Operations, added 2026-08-29 by the owner - now hold a
  // row onto it, in the promoted band, under the card's own name.
  //
  // Nothing widened: the band carries the hub row's gate (NavigationSection.gate), so a row appears
  // only for someone who could have opened that hub AND been shown that card, which both of them
  // could. The card's own comment still says HR Operations "never SEES this card"; that was written
  // about her /hr rail and it stays true there - she reaches the report from /hr/admin/vacation-report
  // - but the shell is chosen by the ADDRESS, not the account (resolveShellNavigationMode), so on an
  // /admin URL she has always had the People Management hub too.
  //
  // What the assertion protects is unchanged and is now stated as the measurement it always was:
  // the SFE Manager's own row is his, nobody holds TWO rows onto this page, and the only other
  // holders are the two the card names.
  const vacationReportRowsFor = (role: PhoenixRole): string[] =>
    sidebarHrefsFor(role).filter((href) => href === "/admin/vacation-report");
  const holders = phoenixRoles.filter((role) => vacationReportRowsFor(role).length > 0);
  assert.deepEqual(
    [...holders].sort(),
    ["HR Operations", "SFE Manager", "Super Admin"],
    "only the SFE Manager's own row and the two roles the People Management card names may reach this page from the rail",
  );
  for (const role of holders) {
    assert.equal(
      vacationReportRowsFor(role).length,
      1,
      `${role} must hold exactly one row onto this page - two rows onto one page is the failure excludedRoles exists to prevent`,
    );
  }

  // -- (5) The range is two date pickers that RE-QUERY, not a client-side slice -------------------
  // Owner instruction 2026-08-27: "date picker to date picker ... and only appear what I filter
  // on". The distinction that matters is that the pickers drive the QUERY: a client-side date
  // filter can only ever hide rows the page already loaded, so picking a start earlier than the
  // last load would silently return nothing at all.
  const TODAY = "2026-08-27";

  assert.deepEqual(
    resolveCompanyVacationReportRange({}, TODAY),
    { endDate: TODAY, startDate: COMPANY_VACATION_REPORT_DEFAULT_START_DATE },
    "an unparameterised page load must resolve to the default report, not an empty one",
  );
  assert.deepEqual(
    resolveCompanyVacationReportRange({ endDate: "2026-06-30", startDate: "2025-03-01" }, TODAY),
    { endDate: "2026-06-30", startDate: "2025-03-01" },
    "a picked range must be honoured verbatim, INCLUDING a start before the old hard-coded 2026-01-01 - that is the whole reason it re-queries",
  );
  assert.deepEqual(
    resolveCompanyVacationReportRange({ endDate: "2026-03-01", startDate: "2026-06-30" }, TODAY),
    { endDate: "2026-06-30", startDate: "2026-03-01" },
    "a reversed pair is a mis-click and must be swapped - returning an empty report reads as a broken system rather than as backwards input",
  );
  for (const bad of ["", "yesterday", "2026-13-01", "2026-02-31", "26-01-01", "2026-1-1"]) {
    assert.equal(
      isIsoDateOnly(bad),
      false,
      `"${bad}" must not be accepted as a date - a shape-only check passes 2026-02-31 straight through to the database`,
    );
    assert.equal(
      resolveCompanyVacationReportRange({ startDate: bad }, TODAY).startDate,
      COMPANY_VACATION_REPORT_DEFAULT_START_DATE,
      `an unusable start ("${bad}") must fall back to the default rather than throw - a forwarded bad link should show the report, not an error page`,
    );
  }
  assert.equal(
    resolveCompanyVacationReportRange({ startDate: "0202-01-01" }, TODAY).startDate,
    COMPANY_VACATION_REPORT_EARLIEST_DATE,
    "a mistyped year must be clamped - one page load must not become a full-table scan",
  );
  const rangeParams = companyVacationReportRangeParams({ endDate: "2026-06-30", startDate: "2026-02-01" });
  assert.equal(rangeParams.get("startDate"), "2026-02-01");
  assert.equal(
    rangeParams.get("endDate"),
    "2026-06-30",
    "BOTH keys must always be written - a link carrying only one resolves the other from a default, so forwarding it tomorrow moves the window",
  );

  // The pickers are in the main bar with real labels, and they navigate rather than setState.
  for (const label of ["Report start date", "Report end date"]) {
    assert.ok(
      TABLE_SOURCE.includes(`aria-label="${label}"`),
      `the table must render a labelled "${label}" picker - an unlabelled date input cannot be found by anything, including this test`,
    );
  }
  assert.ok(
    /const runQuery = \([\s\S]{0,600}?router\.push\(/.test(TABLE_SOURCE),
    "the panel must navigate (router.push) so the report is re-queried - narrowing local state would make an earlier start date return nothing",
  );
  assert.equal(
    /const \[(fromDate|toDate)/.test(TABLE_SOURCE),
    false,
    "the table must hold NO second date state - a queried range plus a local range narrowing it is how a screen shows less than its own header says it covers",
  );
  assert.ok(
    PAGE_SOURCE.includes("resolveCompanyVacationReportRange") && PAGE_SOURCE.includes("searchParams"),
    "the page must resolve its range from the URL - otherwise the pickers navigate and nothing changes",
  );
  assert.ok(
    EXPORT_ROUTE_SOURCE.includes("resolveCompanyVacationReportRange"),
    "the export must resolve the range through the SAME helper as the page, or a forwarded link can hand the database a date the picker could never produce",
  );
  assert.equal(
    /REPORT_START_DATE|DEFAULT_START_DATE\s*=/.test(PAGE_SOURCE + EXPORT_ROUTE_SOURCE),
    false,
    "no hard-coded start may survive on either side - a second default is a second answer to what the report covers",
  );

  // Adding a column widened this table, and src/components/vacation is treated as PORTAL-OWNED by
  // tests/employee-portal-navigation.test.ts, which fails any `min-w-[1100px]`+ table on the
  // grounds that a wide desktop table is not a mobile data strategy. That guard lives in a suite
  // nobody runs while working on this report, so it only spoke on CI, after the push. Restated
  // here, next to the column that caused it.
  for (const width of [...TABLE_SOURCE.matchAll(/min-w-\[(\d+)px\]/g)].map((match) => Number(match[1]))) {
    assert.ok(
      width < 1100,
      `min-w-[${width}px] breaks the portal-owned width ceiling in tests/employee-portal-navigation.test.ts - tighten the table (cell padding, a narrower column) rather than raising the ceiling`,
    );
  }
  // The rewrite answers that guard properly instead of negotiating with it: the desktop table
  // declares no min-width at all (like its sibling src/components/vacation/vacation-report.tsx),
  // and mobile gets real cards - which is the owner's standing admin-shell rule anyway, and the
  // thing the portal guard was actually asking for.
  assert.ok(
    TABLE_SOURCE.includes('className="hidden md:block"') &&
      !/overflow-x-auto/.test(TABLE_SOURCE.slice(TABLE_SOURCE.indexOf('className="hidden md:block"'), TABLE_SOURCE.indexOf("Mobile cards (below md)"))) &&
      /<table className="w-full table-fixed border-collapse/.test(TABLE_SOURCE) &&
      /<colgroup>/.test(TABLE_SOURCE),
    "the desktop table must be the md-and-up branch, fixed-layout with a colgroup, fitting the page instead of scrolling sideways",
  );
  assert.ok(
    /md:hidden[\s\S]{0,400}<VacationRowCard/.test(TABLE_SOURCE),
    "mobile must get real cards, not a sideways-scrolling desktop table - the owner's admin-shell rule, and the reason the portal width guard exists",
  );

  // -- (6) The page opens EMPTY, and every control he named is on the one panel -------------------
  // Owner instruction 2026-08-27, rejecting the first build: "I don't want the page very long like
  // this ... the page is empty, but I have advanced filters through everything I need. I filter,
  // and then the data I want appears, not all of this." Two independent halves: the page must not
  // READ before Apply (the CRM visit scan across the range is the expensive part), and the table
  // must not RENDER a result set before then.
  assert.ok(
    /applied[\s\S]{0,200}getCompanyVacationReport\(/.test(PAGE_SOURCE),
    "the page must gate the range read on `applied` - an ungated read is the long whole-company page the owner rejected, and it carries the expensive CRM visit scan",
  );
  assert.ok(
    PAGE_SOURCE.includes("isCompanyVacationReportApplied(params)"),
    "the page must read the applied marker off the URL - without it a forwarded link cannot reproduce what the sender saw",
  );
  assert.ok(
    TABLE_SOURCE.includes("{!applied ? ("),
    "the table must render an explicit empty state before anything is applied - a silently blank screen reads as a broken report, not as an invitation",
  );
  assert.equal(
    isCompanyVacationReportApplied(new URLSearchParams("startDate=2026-01-01&endDate=2026-08-27")),
    false,
    "a bare range URL is NOT an applied query - 'no filters' and 'nothing asked for yet' have to stay different states or the page loads the whole company again",
  );
  assert.equal(
    isCompanyVacationReportApplied(new URLSearchParams("applied=1")),
    true,
    "the marker the Apply button writes must read back as applied",
  );

  // Every control he listed, by name. A dropdown that quietly stops being rendered is a filter he
  // asked for and no longer has, and nothing else in the suite would notice.
  for (const control of ["Employee", "Job Title", "Line", "Source", "Detail Type", "Leave Type", "Has Balance", "Search"]) {
    assert.ok(
      TABLE_SOURCE.includes(`<span className={labelClass}>${control}</span>`),
      `the Advanced Filters panel must carry a "${control}" control - the owner named all eight, plus the two date pickers`,
    );
  }
  for (const key of ["employeeHrId", "jobTitle", "leaveType"] as const) {
    assert.ok(
      (COMPANY_VACATION_REPORT_FILTER_KEYS as readonly string[]).includes(key),
      `${key} must be one of the shared filter keys - a filter missing from that list works on screen and vanishes from the export`,
    );
  }
  assert.deepEqual(
    filterCompanyVacationReportRows(rows, { ...NO_COMPANY_VACATION_REPORT_FILTERS, employeeHrId: "hr-3" }).map((r) => r.hrId),
    ["HR-3"],
    "the Employee filter must match through the canonical HR ID key - the two source tables spell the same id in different cases",
  );
}
