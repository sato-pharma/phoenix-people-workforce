import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
  crmInsightState,
  crmPlanMonthWindows,
  gradeFrequencyRows,
  shapeFrequency,
  shapeManagerPlanCompliance,
  shapeRepPlanCompliance,
  unreadCrmInsights,
  type ManagerPlanAdherenceInput,
} from "../src/lib/employee-360/crm-insights.ts";
import {
  employee360CrmInsightRoles,
  planEmployee360Sections,
  type Employee360SectionSignals,
} from "../src/lib/employee-360/report-sections.ts";
import type { Employee360RoleCategory } from "../src/lib/employee-360/roles.ts";
import { customerFrequencyRow, type CustomerFrequencyRow } from "../src/lib/phoenix-crm/customer-frequency.ts";
import { emptyPlanCounts, type PlanCounts } from "../src/lib/phoenix-crm/report-rules.ts";
import type { PhoenixCrmDoctorListType, PhoenixCrmGrade } from "../src/lib/phoenix-crm/types.ts";
import { stripComments } from "./support/comment-strip.ts";

// Employee 360's Phoenix CRM sections (owner, 2026-10-27): plan compliance and visit frequency by
// customer grade. The figures are Phoenix CRM's own report functions; what is pinned here is the
// shaping — drawn only with data, a failed read never a 0, grade rows in a fixed order, and which
// role's report carries which section.
export function runEmployee360CrmInsightsTests() {
  const ROLES: Employee360RoleCategory[] = [
    "medical-rep",
    "district-manager",
    "regional-manager",
    "national-sales-manager",
    "product-manager",
    "training-manager",
  ];

  // ── Which role carries which section ──────────────────────────────────────────────────────────
  assert.deepEqual(employee360CrmInsightRoles("medical-rep"), { repPlan: true, managerPlan: false, frequency: true });
  assert.deepEqual(employee360CrmInsightRoles("district-manager"), { repPlan: false, managerPlan: true, frequency: true });
  for (const role of ["regional-manager", "national-sales-manager", "product-manager", "training-manager"] as const) {
    assert.deepEqual(
      employee360CrmInsightRoles(role),
      { repPlan: false, managerPlan: true, frequency: false },
      `${role}: his own manager's plan, and no team frequency (one territory at a time is how it is read)`,
    );
  }

  const base: Employee360SectionSignals = {
    productiveVisits: 5,
    doublesReceived: 0,
    leadershipHasData: true,
    salesHasData: true,
    expensesHaveData: true,
  };
  for (const role of ROLES) {
    const roles = employee360CrmInsightRoles(role);
    const withData = planEmployee360Sections(role, { ...base, crmPlanCompliance: "data", crmFrequency: "data" }, true);
    assert.equal(withData.showCrmPlanCompliance, true, `${role}: plan compliance with figures is drawn`);
    assert.equal(withData.showCrmFrequency, roles.frequency, `${role}: frequency only where the role carries it`);

    const unread = planEmployee360Sections(role, { ...base, crmPlanCompliance: "unread", crmFrequency: "unread" }, true);
    assert.equal(unread.showCrmPlanCompliance, true, `${role}: a failed read is drawn, to say "Could not be read"`);
    assert.equal(unread.showCrmFrequency, roles.frequency, `${role}: a failed frequency read is drawn where the role carries it`);

    const empty = planEmployee360Sections(role, { ...base, crmPlanCompliance: "empty", crmFrequency: "empty" }, true);
    assert.equal(empty.showCrmPlanCompliance, false, `${role}: a section with no data is not drawn`);
    assert.equal(empty.showCrmFrequency, false, `${role}: an empty frequency is not drawn`);

    const notLoaded = planEmployee360Sections(role, base, true);
    assert.equal(notLoaded.showCrmPlanCompliance, false, `${role}: nothing loaded, nothing drawn`);
    assert.equal(notLoaded.showCrmFrequency, false, `${role}: nothing loaded, nothing drawn`);
  }

  // A loader that could not start says "unread" for exactly the sections the role carries.
  assert.deepEqual(unreadCrmInsights("medical-rep"), { planCompliance: { state: "unread" }, frequency: { state: "unread" } });
  assert.deepEqual(unreadCrmInsights("regional-manager"), { planCompliance: { state: "unread" }, frequency: null });
  assert.equal(crmInsightState(null), undefined);
  assert.equal(crmInsightState({ state: "unread" }), "unread");

  // ── The rep's plan: AM and PM summed over the months, a list with nothing planned left out ────
  const counts = (overrides: Partial<PlanCounts>): PlanCounts => ({ ...emptyPlanCounts(), ...overrides });
  assert.deepEqual(
    shapeRepPlanCompliance({
      from: "2026-10-01",
      to: "2026-10-20",
      months: [{ AM: counts({}), PM: counts({ unplanned: 4 }), leaveUnread: false }],
      shortened: false,
    }),
    { state: "empty" },
    "no planned customer at all is no section — an off-plan visit alone is not a plan",
  );
  const rep = shapeRepPlanCompliance({
    from: "2026-09-01",
    to: "2026-10-20",
    months: [
      { AM: counts({}), PM: counts({ planned: 10, visitedPlanned: 8, missed: 2, onLeave: 1 }), leaveUnread: false },
      { AM: counts({}), PM: counts({ planned: 10, visitedPlanned: 5, missed: 4, plannedWaiting: 1 }), leaveUnread: true },
    ],
    shortened: false,
  });
  assert.equal(rep.state, "data");
  if (rep.state !== "data" || rep.value.kind !== "rep") throw new Error("unreachable");
  assert.deepEqual(rep.value.lines.map((line) => line.listType), ["PM"], "the AM list, never planned, is not a row of zeros");
  assert.deepEqual(
    rep.value.lines[0],
    { listType: "PM", planned: 20, kept: 13, waiting: 1, missed: 6, onLeave: 1, keptPct: 65 },
    "the months' counts are summed, and plan kept is planKeptPercent of the sums (13 of 20)",
  );
  assert.equal(rep.value.leaveUnread, true, "one month whose leave could not be read says so for the section");

  // The period cut into the Plan vs actual report's calendar-month windows, clamped to today.
  assert.deepEqual(crmPlanMonthWindows("2026-08-15", "2026-10-27", "2026-10-20"), {
    windows: [
      { from: "2026-08-15", to: "2026-08-31" },
      { from: "2026-09-01", to: "2026-09-30" },
      { from: "2026-10-01", to: "2026-10-20" },
    ],
    shortened: false,
  });
  assert.deepEqual(crmPlanMonthWindows("2026-01-01", "2026-10-20", "2026-10-20", 2), {
    windows: [
      { from: "2026-09-01", to: "2026-09-30" },
      { from: "2026-10-01", to: "2026-10-20" },
    ],
    shortened: true,
  });
  assert.deepEqual(crmPlanMonthWindows("2026-11-01", "2026-11-30", "2026-10-20"), { windows: [], shortened: false });

  // ── A manager's plan: the sent weeks that touch the period, summed as a ratio ──────────────────
  const week = (overrides: Partial<ManagerPlanAdherenceInput>): ManagerPlanAdherenceInput => ({
    weekStart: "2026-10-10",
    weekEnd: "2026-10-15",
    status: "approved",
    checkable: 0,
    kept: 0,
    scorePct: null,
    ...overrides,
  });
  assert.deepEqual(
    shapeManagerPlanCompliance({ from: "2026-10-01", to: "2026-10-20", weeks: [], shortened: false }),
    { state: "empty" },
    "a manager who never sent a week has no section",
  );
  const manager = shapeManagerPlanCompliance({
    from: "2026-10-01",
    to: "2026-10-20",
    weeks: [
      week({ weekStart: "2026-09-12", weekEnd: "2026-09-17", checkable: 9, kept: 9, scorePct: 100 }),
      week({ weekStart: "2026-10-03", weekEnd: "2026-10-08", checkable: 1, kept: 1, scorePct: 100 }),
      week({ weekStart: "2026-10-17", weekEnd: "2026-10-22", status: "submitted", checkable: 3, kept: 1, scorePct: 33 }),
    ],
    shortened: false,
  });
  if (manager.state !== "data" || manager.value.kind !== "manager") throw new Error("expected manager data");
  assert.deepEqual(
    manager.value.weeks.map((row) => row.weekStart),
    ["2026-10-17", "2026-10-03"],
    "newest first, and a week wholly before the period is not read into it",
  );
  assert.equal(manager.value.weeks[0].statusLabel, "Waiting for approval", "the status reads as Phoenix CRM labels it");
  assert.deepEqual(
    manager.value.totals,
    { weeks: 2, closed: 4, done: 2, keptPct: 50 },
    "plan kept over the period is done over due on the sums (2 of 4), never the weeks' percentages averaged (67)",
  );
  const notYet = shapeManagerPlanCompliance({
    from: "2026-10-01",
    to: "2026-10-20",
    weeks: [week({ weekStart: "2026-10-17", weekEnd: "2026-10-22", checkable: 0, kept: 0, scorePct: null })],
    shortened: false,
  });
  if (notYet.state !== "data" || notYet.value.kind !== "manager") throw new Error("expected manager data");
  assert.equal(notYet.value.totals.keptPct, null, "a week with no closed customer is not measured — never 0%");

  // ── Frequency by grade ────────────────────────────────────────────────────────────────────────
  const settings = { gradeTargets: { PM: { A: 3, B: 2, C: 1 }, AM: { A: 1, B: null, C: null } } };
  const customer = (id: string, listType: PhoenixCrmDoctorListType, grade: PhoenixCrmGrade | null, visits: number): CustomerFrequencyRow =>
    customerFrequencyRow({ customerId: id, name: `Dr ${id}`, listType, grade, visits, planned: visits }, settings);
  const rows = [
    customer("1", "PM", null, 2),
    customer("2", "PM", "C", 1),
    customer("3", "AM", "B", 4),
    customer("4", "PM", "A", 1),
    customer("5", "AM", "A", 1),
    customer("6", "PM", "A", 4),
    customer("7", "PM", "B", 2),
  ];
  const grades = gradeFrequencyRows(rows);
  assert.deepEqual(
    grades.map((row) => row.label),
    ["Grade A · AM list", "Grade A · PM list", "Grade B · AM list", "Grade B · PM list", "Grade C · PM list", "No grade · PM list"],
    "one row per grade and list, A to C then no grade, AM before PM — whatever order the customers arrive in",
  );
  const pmA = grades.find((row) => row.label === "Grade A · PM list");
  assert.deepEqual(
    pmA && { customers: pmA.customers, target: pmA.target, visits: pmA.visits, averageVisits: pmA.averageVisits, under: pmA.under, onTarget: pmA.onTarget, over: pmA.over },
    { customers: 2, target: 3, visits: 5, averageVisits: 2.5, under: 1, onTarget: 0, over: 1 },
    "over the grade is counted apart from under — a deviation, never a bonus",
  );
  const amB = grades.find((row) => row.label === "Grade B · AM list");
  assert.equal(amB?.target, null, "an unset target stays unset — never a 0 that makes every visit 'over'");
  assert.equal(amB?.noTarget, 1);

  assert.deepEqual(shapeFrequency({ month: "2026-10", inProgress: true, reports: [] }), { state: "empty" }, "no territory read, no section");
  assert.deepEqual(
    shapeFrequency({ month: "2026-10", inProgress: true, reports: [{ rows: [], awaitingValidation: 3, leaveUnread: false }] }),
    { state: "empty" },
    "a list with no doctor is no section",
  );
  const frequency = shapeFrequency({
    month: "2026-10",
    inProgress: true,
    reports: [
      { rows: rows.slice(0, 3), awaitingValidation: 2, leaveUnread: false },
      { rows: rows.slice(3), awaitingValidation: 1, leaveUnread: false },
    ],
  });
  if (frequency.state !== "data") throw new Error("expected frequency data");
  assert.equal(frequency.value.territories, 2);
  assert.equal(frequency.value.totals.customers, 7, "the team's territories are joined before grouping");
  assert.equal(frequency.value.awaitingValidation, 3);

  // ── The drawing: "Could not be read" for a failed read, square, fits, no ellipsis ─────────────
  const ui = stripComments(readFileSync(new URL("../src/components/employee-360/crm-insights-sections.tsx", import.meta.url), "utf8"));
  assert.match(ui, /Could not be read\./, "a failed read says so in words");
  assert.match(ui, /insight\.state === "unread"/, "and the unread branch draws no figure");
  assert.match(ui, /insight\.state === "empty"\) return null/, "an empty section is not drawn");
  assert.doesNotMatch(ui, /rounded/, "square corners — no rounded class anywhere");
  assert.doesNotMatch(ui, /\btruncate\b|text-ellipsis|line-clamp|…/, "never truncated with an ellipsis");
  assert.doesNotMatch(ui, /overflow-x-auto|min-w-\[/, "no horizontal scroll");
  const tables = ui.match(/<table className="w-full table-fixed/g) ?? [];
  assert.equal(tables.length, 3, "every table is w-full table-fixed");
  assert.equal((ui.match(/<colgroup>/g) ?? []).length, 3, "and every table sizes its columns with a colgroup");
  assert.equal((ui.match(/sm:hidden/g) ?? []).length, 3, "and every table has its phone cards");

  // The view hands both states to the plan and draws through it.
  const view = stripComments(readFileSync(new URL("../src/components/employee-360/employee-360-view.tsx", import.meta.url), "utf8"));
  assert.match(view, /crmPlanCompliance: crmInsightState\(crmInsights\?\.planCompliance\)/);
  assert.match(view, /crmFrequency: crmInsightState\(crmInsights\?\.frequency\)/);
  assert.match(view, /showPlanCompliance=\{plan\.showCrmPlanCompliance\}/);
  for (const page of ["../app/(admin)/employee-360/[hrId]/page.tsx", "../app/employee-portals/employee-360/[hrId]/page.tsx"]) {
    const source = stripComments(readFileSync(new URL(page, import.meta.url), "utf8"));
    assert.match(source, /loadEmployee360CrmInsights\(/, `${page} loads the Phoenix CRM sections`);
    assert.match(source, /crmInsights=\{crmInsights\}/, `${page} hands them to the report`);
  }
}
