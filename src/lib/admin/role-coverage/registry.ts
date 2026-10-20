import { systemAccessContext, type AccessContext } from "@/lib/auth/permissions";

import type { CoveragePerson, RoleCoverageDeclaration } from "./coverage-roles";

/**
 * THE MODULES THE ROLE COVERAGE AUDIT MEASURES — one entry per people list or person filter.
 *
 * Each entry names the roles that must appear in it (`applies`), the roles it leaves out ON PURPOSE
 * with the owner's reason (`leftOut`), and a `probe` that calls the very function the module's page
 * calls and returns the HR ids that list offers. The audit (`audit.ts`) scores the probe against
 * today's active roster, so the answer is what the page really shows — never what this file says
 * it should show. Adding a module that lists people? Add it here in the same PR;
 * tests/role-coverage-audit.test.ts refuses an entry with no applicable role, a left-out role
 * without a reason, or a role that is both.
 */
export type RoleCoverageProbeContext = {
  roster: readonly CoveragePerson[];
  access: AccessContext;
};

export type RoleCoverageModule = RoleCoverageDeclaration & {
  id: string;
  label: string;
  href: string;
  /** What the list is, in plain words. */
  population: string;
  /** The function the probe calls — the same one the page uses. */
  source: string;
  probe: (context: RoleCoverageProbeContext) => Promise<Iterable<string>>;
};

export const roleCoverageAccessContext: AccessContext = systemAccessContext;

// ── Helpers the probes share ─────────────────────────────────────────────────────────────────
// Every probe IMPORTS its module lazily, so loading this registry (the unit test does) pulls in no
// server module, and a module that fails to load fails its own row as "not measured" — never the
// whole audit.

function cairoMonth() {
  const todayIso = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Africa/Cairo",
    year: "numeric",
  }).format(new Date());
  const [year, month] = todayIso.split("-").map((part) => Number.parseInt(part, 10));
  return { todayIso, year, month, monthKey: todayIso.slice(0, 7) };
}

function nameKey(value: string | null | undefined) {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * A filter's choices are NAMES (that is what the person picks). They are turned back into HR ids
 * through the directory's full and display names, so a manager offered under either spelling counts.
 * A name nobody on the directory carries simply matches nobody.
 */
async function hrIdsForNames(names: Iterable<string | null | undefined>): Promise<string[]> {
  const { getEmployeeDirectoryRows } = await import("@/lib/employees/employee-directory");
  const rows = await getEmployeeDirectoryRows({ includeInactive: false });
  const byName = new Map<string, string>();
  for (const row of rows) {
    for (const name of [row.displayName, row.fullName]) {
      const key = nameKey(name);
      if (key && !byName.has(key)) byName.set(key, row.hrId);
    }
  }
  const hrIds: string[] = [];
  for (const name of names) {
    const hrId = byName.get(nameKey(name));
    if (hrId) hrIds.push(hrId);
  }
  return hrIds;
}

const FIELD_MANAGERS = ["District Manager", "Regional Manager", "National Sales Manager"] as const;

/**
 * Phoenix CRM builds its viewer from an HR record and refuses a context without one, so its probes
 * read as a Super Admin standing on the CEO's record — company-wide, read-only, exactly what the
 * Super Admin opening this audit is shown.
 */
async function phoenixCrmAuditViewer(roster: readonly CoveragePerson[], access: AccessContext) {
  const { resolvePhoenixCrmViewer } = await import("@/lib/phoenix-crm/server/access");
  const anchor = roster.find((person) => person.role === "CEO") ?? roster[0];
  if (!anchor) throw new Error("No active employee to read Phoenix CRM as.");
  return resolvePhoenixCrmViewer({ ...access, hrId: anchor.hrId, role: "Super Admin" });
}

export const ROLE_COVERAGE_MODULES: readonly RoleCoverageModule[] = [
  {
    id: "kpis-reports-to",
    label: "KPIs · Reports to filter",
    href: "/admin/kpis",
    population: "The managers the “Reports to” filter offers on this month's board. Choosing one keeps every rep beneath that manager.",
    source: "getKpisBoard → facets.managers",
    applies: FIELD_MANAGERS,
    async probe({ access }) {
      const [{ getKpisBoard }, { resolveRepsPlansMonth }] = await Promise.all([
        import("@/lib/crm/kpis-board"),
        import("@/lib/crm/reps-plans"),
      ]);
      const { todayIso } = cairoMonth();
      const board = await getKpisBoard({
        access,
        month: resolveRepsPlansMonth(undefined, todayIso),
        todayIso,
        includeReports: false,
      });
      return hrIdsForNames(board.facets.managers.map((option) => option.label));
    },
  },
  {
    id: "kpis-manager-rows",
    label: "KPIs · manager rows",
    href: "/admin/kpis",
    population: "The managers this month's board carries a row for — each one the average of the rows beneath that manager.",
    source: "getKpisBoard → managers",
    applies: FIELD_MANAGERS,
    async probe({ access }) {
      const [{ getKpisBoard }, { resolveRepsPlansMonth }] = await Promise.all([
        import("@/lib/crm/kpis-board"),
        import("@/lib/crm/reps-plans"),
      ]);
      const { todayIso } = cairoMonth();
      const board = await getKpisBoard({
        access,
        month: resolveRepsPlansMonth(undefined, todayIso),
        todayIso,
        includeReports: false,
      });
      return board.managers.map((manager) => manager.hrId);
    },
  },
  {
    id: "field-workforce-compliance-manager-filter",
    label: "Field Workforce Compliance · Manager filter",
    href: "/admin/field-workforce-compliance",
    population: "The managers the Manager filter offers on this month's live view. Choosing one keeps the manager's own row and everyone below it.",
    source: "getFieldWorkforceComplianceLiveView → managerFilterOptions",
    applies: FIELD_MANAGERS,
    async probe() {
      const [{ getFieldWorkforceComplianceLiveView }, { buildManagerChain, managerFilterOptions }] = await Promise.all([
        import("@/lib/field-workforce-compliance/live-snapshots"),
        import("@/lib/org/manager-filter"),
      ]);
      const view = await getFieldWorkforceComplianceLiveView({ monthKey: cairoMonth().monthKey });
      const rows = view.preview.employees;
      return hrIdsForNames(managerFilterOptions(rows, buildManagerChain(rows)));
    },
  },
  {
    id: "field-absence-roster",
    label: "Field Absence Calendar",
    href: "/admin/field-absence",
    population: "Everyone on a field seat this month — the people whose unseen working days the calendar lists.",
    source: "loadFieldAbsenceSeats → loadFieldAbsenceRoster",
    applies: ["Medical Rep", ...FIELD_MANAGERS],
    leftOut: {
      "Product Manager": "Holds no field seat, so the calendar has no seat to read that person from (owner, 2026-10-18).",
      "Group Product Manager": "Holds no field seat, so the calendar has no seat to read that person from (owner, 2026-10-18).",
      "Head Office": "The calendar is the field seats only (owner, 2026-10-18); office days are the fingerprint report's.",
    },
    async probe() {
      const { loadFieldAbsenceRoster, loadFieldAbsenceSeats } = await import("@/lib/field-absence/server/roster");
      const { todayIso, year, month } = cairoMonth();
      const start = `${year}-${String(month).padStart(2, "0")}-01`;
      const seats = await loadFieldAbsenceSeats();
      const roster = await loadFieldAbsenceRoster({ seats, start, end: todayIso, today: todayIso });
      return roster.map((person) => person.key);
    },
  },
  {
    id: "private-calendar-people",
    label: "Private Calendar · employee picker",
    href: "/workspace/private-calendar",
    population: "The people a company-wide viewer can open a private calendar for.",
    source: "getPrivateCalendarWorkspace → visibleEmployees",
    applies: ["Medical Rep", ...FIELD_MANAGERS, "Product Manager", "Group Product Manager", "Head Office"],
    async probe({ access }) {
      const { getPrivateCalendarWorkspace } = await import("@/lib/private-calendar/service");
      const { year, month } = cairoMonth();
      const workspace = await getPrivateCalendarWorkspace({ access, month, year });
      return workspace.visibleEmployees.map((employee) => employee.hrId);
    },
  },
  {
    id: "organogram-company",
    label: "Organogram · company chart",
    href: "/organogram",
    population: "Every person placed on the company organogram.",
    source: "getOrganogramReport(mode: company) → organogramRows",
    applies: ["Medical Rep", ...FIELD_MANAGERS, "Product Manager", "Group Product Manager", "Head Office", "CEO"],
    async probe({ access }) {
      const { getOrganogramReport } = await import("@/lib/reports/organogram");
      const report = await getOrganogramReport(access, { mode: "company" });
      return report.organogramRows.map((row) => row.hrId);
    },
  },
  {
    id: "employee-360-subjects",
    label: "Employee 360 · people list",
    href: "/employee-360",
    population: "The field-force people a company-wide viewer can open an Employee 360 report for.",
    source: "resolveEmployee360VisibleRows",
    // The Regional Sales Manager is back (owner, 2026-10-20: "bring him back but do not show empty
    // data, tailor the report on him"), after being removed for every viewer on 2026-07-30.
    applies: ["Medical Rep", ...FIELD_MANAGERS, "Product Manager", "Group Product Manager"],
    leftOut: {
      "Head Office": "Employee 360 is the field-force report; office staff are not its subjects.",
    },
    async probe({ access }) {
      const [{ getEmployeeDirectoryRows }, { resolveEmployee360VisibleRows }] = await Promise.all([
        import("@/lib/employees/employee-directory"),
        import("@/lib/employee-360/access"),
      ]);
      const rows = await getEmployeeDirectoryRows({ includeInactive: false });
      const visible = await resolveEmployee360VisibleRows(rows, access);
      return visible.map((row) => row.hrId);
    },
  },
  {
    id: "ceo-managers-on-leave",
    label: "CEO Command Center · Managers on leave",
    href: "/admin/ceo-command-center",
    population: "The managers the “Managers on leave today” card watches — everyone at least one active employee reports to.",
    source: "managerOnLeaveCandidates(getEmployeeDirectoryRows)",
    applies: FIELD_MANAGERS,
    leftOut: {
      "Medical Rep": "A medical rep manages nobody, so a rep is never a manager on leave.",
    },
    async probe() {
      const [{ getEmployeeDirectoryRows }, { managerOnLeaveCandidates }] = await Promise.all([
        import("@/lib/employees/employee-directory"),
        import("@/lib/ceo/command-center"),
      ]);
      const rows = await getEmployeeDirectoryRows({ includeInactive: false });
      return managerOnLeaveCandidates(rows).map((candidate) => candidate.hrId);
    },
  },
  {
    id: "sales-rankings-manager-filter",
    label: "Sales Rankings · Manager filter",
    href: "/sales/rankings",
    population: "The managers the Manager filter offers on the latest published window. Choosing one keeps everyone ranked beneath that manager.",
    source: "buildRankingsPage → managerOptions",
    applies: FIELD_MANAGERS,
    async probe() {
      const { buildRankingsPage } = await import("@/lib/sales/rankings-page");
      const page = await buildRankingsPage({});
      return hrIdsForNames(page.managerOptions.map((option) => option.label));
    },
  },
  {
    id: "dsms-performance-company",
    label: "DSMs Performance · company view",
    href: "/admin/field-sales/dsm-performance",
    population: "The district and regional managers ranked on the latest closed month, line by line.",
    source: "getCompanyDsmPerformance → dsms + regionalManagers",
    applies: ["District Manager", "Regional Manager"],
    async probe({ access }) {
      const { getCompanyDsmPerformance } = await import("@/lib/employee-portal/service");
      // The company view answers only a company-scoped reader; the audit reads as one.
      const data = await getCompanyDsmPerformance({ ...access, scope: "company" });
      if (!data) throw new Error("The company DSMs Performance view returned nothing.");
      return data.lines.flatMap((line) => [
        ...line.performance.dsms.map((dsm) => dsm.hrId),
        ...line.performance.regionalManagers.map((manager) => manager.hrId),
      ]);
    },
  },
  {
    id: "sales-vs-target-managers",
    label: "Sales vs Target · manager levels",
    href: "/sales/vs-target",
    population: "The district and regional managers the company dashboard rolls the latest period up to.",
    source: "buildVsTargetDashboard → managers + regionalManagers",
    applies: ["District Manager", "Regional Manager"],
    async probe({ access }) {
      const { buildVsTargetDashboard } = await import("@/lib/sales/vs-target-page");
      const data = await buildVsTargetDashboard({ ...access, scope: "company" }, null);
      return [...data.managers, ...data.regionalManagers].map((node) => node.key);
    },
  },
  {
    id: "early-birds-districts",
    label: "Early Birds · districts",
    href: "/admin/early-birds",
    population: "The district managers whose districts race on the company-wide board.",
    source: "resolveEarlyBirdsScope → districts",
    applies: ["District Manager"],
    async probe({ access }) {
      const { resolveEarlyBirdsScope } = await import("@/lib/early-birds/permissions");
      const scope = await resolveEarlyBirdsScope(access);
      return scope.districts.map((district) => district.hrId);
    },
  },
  {
    id: "phoenix-crm-visit-report-managers",
    label: "Phoenix CRM Visit Report · manager choice",
    href: "/admin/phoenix-crm/visit-report",
    population: "The managers the Visit Report can be run for — every manager above a territory, plus the lines' product managers.",
    source: "loadVisitReportScope → managers",
    applies: [...FIELD_MANAGERS, "Product Manager", "Group Product Manager"],
    async probe({ roster, access }) {
      const { loadVisitReportScope } = await import("@/lib/phoenix-crm/server/visit-report");
      const scope = await loadVisitReportScope(await phoenixCrmAuditViewer(roster, access));
      return scope.managers.map((manager) => manager.id);
    },
  },
  {
    id: "phoenix-crm-reports-manager-filter",
    label: "Phoenix CRM Reports · Manager filter",
    href: "/admin/phoenix-crm",
    population: "The managers the Reports tab's Manager filter offers. Choosing one keeps that manager's territories and everyone beneath them.",
    source: "loadReportScope → managers",
    applies: FIELD_MANAGERS,
    leftOut: {
      "Product Manager": "Holds no seat, so there is no territory to narrow to; the person appears as a row on the per-manager board instead.",
      "Group Product Manager": "Holds no seat, so there is no territory to narrow to; the person appears as a row on the per-manager board instead.",
    },
    async probe({ roster, access }) {
      const { loadReportScope } = await import("@/lib/phoenix-crm/server/reports");
      const scope = await loadReportScope(await phoenixCrmAuditViewer(roster, access));
      return scope.managers.map((manager) => manager.hrId);
    },
  },
];
