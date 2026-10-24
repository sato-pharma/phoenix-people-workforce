import { redirect } from "next/navigation";

import { EmployeeOrganogramDashboard } from "@/components/employee-portal/employee-organogram-dashboard";
import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { ScopeBadge } from "@/components/employee-portal/scope-badge";
import { assertPermission, canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
import {
  canAccessCompanyOrganogram,
  canAccessHeadOffice,
  getOrganogramReport,
  isLineScopedOrganogramRole,
  resolveOrganogramLinesForEmployee,
} from "@/lib/reports/organogram";
import {
  errorMessage,
  isDatabaseSchemaMissing,
  isSupabaseEnvMissing,
  isSupabaseTimeout,
} from "@/lib/reports/vacancies";

export const dynamic = "force-dynamic";

// Print stylesheet + dir="auto" are now provided automatically by
// EmployeePortalPageShell.

/* ---------- error handling ---------- */

function organogramPageError(error: unknown) {
  if (isSupabaseTimeout(error))
    return "Supabase request timed out. Check your connection and try again.";
  if (isSupabaseEnvMissing(error))
    return "Supabase environment variables are missing.";
  if (isDatabaseSchemaMissing(error))
    return "Supabase schema is not ready. Run supabase/phoenix-schema.sql in Supabase SQL editor.";
  return errorMessage(error);
}

/* ---------- page ---------- */

export default async function EmployeePortalOrganogramPage() {
  const access = await resolveAuthenticatedPageAccess();

  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/overview");
  }

  // Company-wide roles (Training Manager / Marketing Manager / CEO / Super Admin) reach the
  // organogram via canAccessCompanyOrganogram; line roles via isLineScopedOrganogramRole.
  // The page previously checked only the latter, redirecting TM/MM away despite their access.
  const isCompanyScoped = canAccessCompanyOrganogram(access);
  // The same entitlement that keeps the Head Office rows in the report decides
  // whether the picker may offer them. Company scope alone is not enough — a
  // Marketing/Training Manager is company-scoped and has Head Office stripped,
  // and a line-scoped viewer only ever holds Office rows as chain context.
  const showHeadOfficeLine = isCompanyScoped && canAccessHeadOffice(access);
  if (!isCompanyScoped && !isLineScopedOrganogramRole(access)) {
    redirect("/employee-portals");
  }

  await assertPermission(access, "organogram", "read");

  // Asked now, beside the report rather than after it (2026-10-24): the answer needs nothing the
  // report reads. It is still awaited below, where a failure throws exactly as before; the empty
  // catch only stops Node calling it unhandled while the report is running.
  const canAddEmployeeLoad = canAccess(access, "employees", "create");
  canAddEmployeeLoad.catch(() => undefined);

  let initialError: string | null = null;
  let initialReport = null;
  // fixedLine locks the UI filter to one line; for multi-line users it stays null
  // because the report is already pre-filtered server-side via lineNames.
  let fixedLine: string | null = null;
  // showLinePicker renders the horizontal line-select buttons. Company-wide roles
  // (MM/TM) always get it. Line-scoped roles get it too when they resolve to more
  // than one line (e.g. a Product Manager with a line_scope_override spanning two
  // lines, such as Anti infective + Pedia) — otherwise they'd land on a dead-end
  // "select a line" screen with no way to actually select one.
  let showLinePicker = false;

  try {
    if (isCompanyScoped) {
      initialReport = await getOrganogramReport(access, { mode: "company" });
      showLinePicker = true;
    } else {
      const resolvedLines = await resolveOrganogramLinesForEmployee(access);
      if (!resolvedLines || resolvedLines.length === 0) {
        initialError = "Unable to resolve your Organogram line scope.";
      } else {
        if (resolvedLines.length === 1) {
          fixedLine = resolvedLines[0];
        } else {
          showLinePicker = true;
        }
        initialReport = await getOrganogramReport(access, { lineNames: resolvedLines, mode: "line" });
      }
    }
  } catch (error) {
    initialError = organogramPageError(error);
  }

  // Surface the domain diagnostic (denied scope / unresolved line / Head Office)
  // instead of silently rendering an empty "pick a line" chart. Unavailable data
  // must explain itself, never look like a legitimate empty result.
  if (!initialError && initialReport?.diagnostic) {
    initialError = initialReport.diagnostic.message;
  }

  // The same capability POST /api/employees asserts. Decides only whether an OPEN SEAT
  // popup offers the way through to a pre-filled Add Employee form — the organogram is
  // readable by plenty of roles that may not hire.
  // employees:create, not update, since the HR Operations Specialist seat (2026-10-20): she edits
  // the master but does not add to it, and POST /api/employees asserts create on every add.
  const canAddEmployee = await canAddEmployeeLoad;

  if (initialError) {
    return (
      <EmployeePortalEmptyState
        message={initialError}
        title="Organogram Unavailable"
      />
    );
  }

  return (
    <EmployeePortalPageShell
      badge="People Operations"
      description="Understand reporting structure and role relationships for your territory."
      errorBoundaryTitle="Organogram unavailable"
      title="Organogram"
    >
      <div className="flex flex-wrap items-center gap-2">
        <ScopeBadge scope={access.scope} />
      </div>
      <EmployeeOrganogramDashboard
        canAddEmployee={canAddEmployee}
        fixedLine={fixedLine}
        initialError={initialError}
        initialReport={initialReport}
        showHeadOfficeLine={showHeadOfficeLine}
        showLinePicker={showLinePicker}
      />
    </EmployeePortalPageShell>
  );
}
