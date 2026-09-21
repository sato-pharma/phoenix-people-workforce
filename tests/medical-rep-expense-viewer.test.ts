import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { phoenixRoles, type PhoenixRole } from "../src/lib/auth/permissions.ts";
import { resolveJobFunctionRole } from "../src/lib/employees/job-function.ts";
import {
  MEDICAL_REP_ONLY_EXPENSE_REFUSAL,
  assertMedicalRepExpenseRole,
  isMedicalRepExpenseViewer,
  shouldBounceToExpenseDashboard,
} from "../src/lib/outstation/medical-rep-expense-viewer.ts";

// The two portal expense pages. On 2026-09-21 they redirected to each other about 1,350 times in
// 80 minutes for one viewer — a Medical Rep LOGIN whose HR job title was something else — and the
// local dev server grew to 9.9 GB. This pins the routing so no viewer can ever bounce between them.
const DASHBOARD = "/employee-portals/expense-dashboard";
const WORKSPACE = "/employee-portals/expenses";

type ExpensePage = typeof DASHBOARD | typeof WORKSPACE;

// A viewer as the two pages see one: the SESSION role every permission check reads, and the job
// title on the employee record that the workspace's service reads.
type Viewer = { role: PhoenixRole; jobTitle: string | null };

type Landing = {
  visited: ExpensePage[];
  shows: "dashboard" | "workspace" | "empty state";
  message?: string;
};

// What app/employee-portals/expense-dashboard/page.tsx decides once its sign-in and portal checks pass.
function dashboardStep(viewer: Viewer): ExpensePage | null {
  return isMedicalRepExpenseViewer({ role: viewer.role }) ? WORKSPACE : null;
}

// What app/employee-portals/expenses/page.tsx decides: the service resolves the job function the way
// getEmployeeIdentity does, gates it, and the page routes a refusal.
function workspaceStep(viewer: Viewer): { next: ExpensePage | null; loadError: unknown } {
  let loadError: unknown = null;
  try {
    assertMedicalRepExpenseRole(resolveJobFunctionRole(viewer.jobTitle ?? viewer.role));
  } catch (error) {
    loadError = error;
  }
  if (!loadError) return { next: null, loadError };
  return {
    next: shouldBounceToExpenseDashboard({ role: viewer.role }, loadError) ? DASHBOARD : null,
    loadError,
  };
}

function describeViewer(viewer: Viewer) {
  const title = viewer.jobTitle === null ? "no job title" : `job title "${viewer.jobTitle}"`;
  return `session role "${viewer.role}" and ${title}`;
}

// Follow the redirects from one page until a page renders. Reaching a page twice is the loop.
function open(viewer: Viewer, start: ExpensePage): Landing {
  const visited: ExpensePage[] = [start];
  let page: ExpensePage = start;
  for (;;) {
    let next: ExpensePage | null;
    let loadError: unknown = null;
    if (page === DASHBOARD) {
      next = dashboardStep(viewer);
    } else {
      ({ next, loadError } = workspaceStep(viewer));
    }

    if (!next) {
      if (page === DASHBOARD) return { visited, shows: "dashboard" };
      if (!loadError) return { visited, shows: "workspace" };
      return {
        visited,
        shows: "empty state",
        message: loadError instanceof Error ? loadError.message : String(loadError),
      };
    }

    assert.ok(
      !visited.includes(next),
      `the expense pages hand a viewer with ${describeViewer(viewer)} back and forth forever: ` +
        `${[...visited, next].join(" -> ")}. Every hop is a full server render; this is the loop ` +
        "that grew the dev server to 9.9 GB on 2026-09-21.",
    );
    visited.push(next);
    page = next;
  }
}

function occurrences(source: string, needle: string) {
  return source.split(needle).length - 1;
}

export function runMedicalRepExpenseViewerTests() {
  // 1. The viewer that looped: a Medical Rep login whose HR job title says otherwise. The dashboard
  //    still sends the login to the workspace once, and the workspace renders its own unavailable
  //    state, which names the refusal, instead of sending it back.
  for (const jobTitle of ["Office Coordinator", "Senior Medical Representative", ""]) {
    const mismatched: Viewer = { role: "Medical Rep", jobTitle };

    const fromDashboard = open(mismatched, DASHBOARD);
    assert.deepEqual(
      fromDashboard.visited,
      [DASHBOARD, WORKSPACE],
      `a Medical Rep login still goes from the dashboard to the workspace, exactly once (${describeViewer(mismatched)})`,
    );
    assert.equal(
      fromDashboard.shows,
      "empty state",
      `the workspace keeps a Medical Rep login it refuses on its own empty state, never back to the dashboard (${describeViewer(mismatched)})`,
    );
    assert.equal(
      fromDashboard.message,
      MEDICAL_REP_ONLY_EXPENSE_REFUSAL,
      "the empty state names the refusal, so a login role that disagrees with the job title is visible as an HR data fix",
    );

    const fromWorkspace = open(mismatched, WORKSPACE);
    assert.deepEqual(fromWorkspace.visited, [WORKSPACE], "opened directly, the workspace does not redirect this viewer at all");
    assert.equal(fromWorkspace.shows, "empty state");
  }

  // 2. A genuine Medical Rep is unchanged: the dashboard sends him to the workspace and it renders.
  for (const jobTitle of ["Medical Representative", "Medical Rep", null]) {
    const rep: Viewer = { role: "Medical Rep", jobTitle };
    assert.deepEqual(
      open(rep, DASHBOARD),
      { visited: [DASHBOARD, WORKSPACE], shows: "workspace" },
      `a Medical Rep is sent to his workspace, which renders (${describeViewer(rep)}; a missing title falls back to the session role)`,
    );
    assert.deepEqual(open(rep, WORKSPACE), { visited: [WORKSPACE], shows: "workspace" });
  }

  // 3. A District Manager is unchanged: the workspace refuses him and sends him to the dashboard once.
  const districtManager: Viewer = { role: "District Manager", jobTitle: "District Sales Manager" };
  assert.deepEqual(
    open(districtManager, WORKSPACE),
    { visited: [WORKSPACE, DASHBOARD], shows: "dashboard" },
    "a viewer the workspace refuses and the dashboard keeps is still sent to the dashboard, once",
  );
  assert.deepEqual(open(districtManager, DASHBOARD), { visited: [DASHBOARD], shows: "dashboard" });

  // 4. An acting District Manager (DM login role, Medical Representative title) is unchanged: she
  //    still submits through the workspace, whose policy is keyed on her job title, and the
  //    dashboard her sidebar links to still renders for her.
  const actingDistrictManager: Viewer = { role: "District Manager", jobTitle: "Medical Representative" };
  assert.deepEqual(
    open(actingDistrictManager, WORKSPACE),
    { visited: [WORKSPACE], shows: "workspace" },
    "an acting District Manager keeps her Medical Rep workspace; this fix changes routing only",
  );
  assert.deepEqual(open(actingDistrictManager, DASHBOARD), { visited: [DASHBOARD], shows: "dashboard" });

  // 5. The helper's answers, for every session role.
  let refusal: unknown = null;
  try {
    assertMedicalRepExpenseRole("Employee");
  } catch (error) {
    refusal = error;
  }
  assert.ok(refusal instanceof Error, "the workspace gate refuses a non-Medical Rep job function");
  assert.equal(refusal.message, MEDICAL_REP_ONLY_EXPENSE_REFUSAL);
  assert.doesNotThrow(() => assertMedicalRepExpenseRole("Medical Rep"));
  for (const employeeRole of [null, undefined, "", "District Manager", "National Sales Manager"]) {
    assert.throws(
      () => assertMedicalRepExpenseRole(employeeRole),
      { message: MEDICAL_REP_ONLY_EXPENSE_REFUSAL },
      `the workspace gate refuses ${JSON.stringify(employeeRole)}`,
    );
  }

  for (const role of phoenixRoles) {
    assert.equal(
      isMedicalRepExpenseViewer({ role }),
      role === "Medical Rep",
      `only the Medical Rep session role is a Medical Rep for the expense pages (${role})`,
    );
    assert.equal(
      shouldBounceToExpenseDashboard({ role }, refusal),
      role !== "Medical Rep",
      `the workspace bounces its refusal to the dashboard exactly when the dashboard would keep the viewer (${role})`,
    );
    for (const otherFailure of [
      new Error("Your employee profile is not linked yet. Please contact HR."),
      new Error("Your employee profile is not available in the employee directory. Please contact HR before submitting an outstation request."),
      MEDICAL_REP_ONLY_EXPENSE_REFUSAL,
      null,
    ]) {
      assert.equal(
        shouldBounceToExpenseDashboard({ role }, otherFailure),
        false,
        `any failure other than the thrown refusal renders the workspace's empty state (${role}: ${String(otherFailure)})`,
      );
    }
  }

  // 6. Every session role against a spread of job titles, from both pages: at most one redirect,
  //    never a page twice, and each viewer lands where the routing rule says.
  const jobTitles: (string | null)[] = [
    null,
    "",
    "Medical Representative",
    "Senior Medical Representative",
    "District Sales Manager",
    "Office Coordinator",
    ...phoenixRoles,
  ];
  for (const role of phoenixRoles) {
    for (const jobTitle of jobTitles) {
      const viewer: Viewer = { role, jobTitle };
      const sessionRep = role === "Medical Rep";
      const workspaceAdmits = resolveJobFunctionRole(jobTitle ?? role) === "Medical Rep";

      const fromDashboard = open(viewer, DASHBOARD);
      assert.deepEqual(
        { visited: fromDashboard.visited, shows: fromDashboard.shows },
        sessionRep
          ? { visited: [DASHBOARD, WORKSPACE], shows: workspaceAdmits ? "workspace" : "empty state" }
          : { visited: [DASHBOARD], shows: "dashboard" },
        `opening the dashboard with ${describeViewer(viewer)}`,
      );

      const fromWorkspace = open(viewer, WORKSPACE);
      assert.deepEqual(
        { visited: fromWorkspace.visited, shows: fromWorkspace.shows },
        workspaceAdmits
          ? { visited: [WORKSPACE], shows: "workspace" }
          : sessionRep
            ? { visited: [WORKSPACE], shows: "empty state" }
            : { visited: [WORKSPACE, DASHBOARD], shows: "dashboard" },
        `opening the workspace with ${describeViewer(viewer)}`,
      );
    }
  }

  // 7. Both pages ask the helper, and nothing else, before redirecting to the other. The simulation
  //    above models these exact calls, so a page that goes back to its own role check would pass it
  //    while looping again.
  const dashboardSource = readFileSync("app/employee-portals/expense-dashboard/page.tsx", "utf8");
  const workspaceSource = readFileSync("app/employee-portals/expenses/page.tsx", "utf8");
  const serviceSource = readFileSync("src/lib/outstation/service.ts", "utf8");

  assert.match(
    dashboardSource,
    /import \{ isMedicalRepExpenseViewer \} from "@\/lib\/outstation\/medical-rep-expense-viewer";/,
  );
  assert.equal(
    occurrences(dashboardSource, 'redirect("/employee-portals/expenses")'),
    1,
    "the dashboard has one redirect to the workspace",
  );
  assert.match(
    dashboardSource,
    /if \(isMedicalRepExpenseViewer\(access\)\) \{\s*redirect\("\/employee-portals\/expenses"\);\s*\}/,
    "the dashboard's redirect to the workspace is decided by isMedicalRepExpenseViewer alone",
  );
  assert.doesNotMatch(dashboardSource, /\bisMedicalRep\(/, "the dashboard must not ask its own Medical Rep question");

  assert.match(
    workspaceSource,
    /import \{ shouldBounceToExpenseDashboard \} from "@\/lib\/outstation\/medical-rep-expense-viewer";/,
  );
  assert.equal(
    occurrences(workspaceSource, 'redirect("/employee-portals/expense-dashboard")'),
    1,
    "the workspace has one redirect to the dashboard",
  );
  assert.match(
    workspaceSource,
    /if \(shouldBounceToExpenseDashboard\(access, loadError\)\) \{\s*redirect\("\/employee-portals\/expense-dashboard"\);\s*\}/,
    "the workspace's redirect to the dashboard is decided by shouldBounceToExpenseDashboard alone",
  );
  assert.doesNotMatch(
    workspaceSource,
    /only medical rep users/i,
    "the workspace must not recognise the refusal by its own string match",
  );
  assert.doesNotMatch(workspaceSource, /\bisMedicalRep\(/);
  assert.match(workspaceSource, /title="Outstation Expenses Unavailable"/, "the workspace's existing empty state is what a refused Medical Rep login sees");

  assert.match(
    serviceSource,
    /employeeRole: resolveJobFunctionRole\(employee\?\.jobTitle \?\? access\.role\),/,
    "the simulation above models exactly this job-function resolution; change the two together",
  );
  assert.match(serviceSource, /assertMedicalRepExpenseRole\(identity\.employeeRole\);/);
  assert.doesNotMatch(
    serviceSource,
    /only Medical Rep users can use simple expense submission/,
    "the refusal is written once, in the helper, so the page that recognises it can never drift from the service that throws it",
  );
}
