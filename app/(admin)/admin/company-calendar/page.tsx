import { redirect } from "next/navigation";

import { CompanyCalendar } from "@/components/employee-portal/company-calendar";
import {
  canAccessSystemAdministratorWorkspace,
  resolveNavigationMode,
} from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getCompanyCalendarWorkspace } from "@/lib/calendar/service";
import { currentCairoDateParts } from "@/lib/i18n/format";

export const dynamic = "force-dynamic";

// Admin-shell host of the portal Company Calendar (company events, public holidays, approved
// leave, plan days, team birthdays) for the CEO / Super Admin. The workspace is company-wide
// by design; month navigation and event edits go through /api/calendar with its own checks.

export default async function AdminCompanyCalendarPage() {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) redirect("/login");
  if (resolveNavigationMode(access) === "employee-portal") redirect("/employee-portals");
  // Role gate only — the portal equivalent (app/employee-portals/calendar) requires no
  // resource permission either (the workspace is company-visible by design), and the CEO
  // role does not hold hr_calendar in the effective permission matrix. Mutations still go
  // through /api/calendar, which enforces its own checks.
  //
  // Finance Manager added 2026-08-10 (owner). He has been in CALENDAR_MANAGER_ROLES
  // (src/lib/calendar/logic.ts) the whole time and /api/calendar already accepted his writes —
  // but this page was Super-Admin-only and the portal mount bounces admin-shell roles, so
  // canManageCompanyCalendar returning true for him was dead code with no screen behind it.
  // Same shape as his two other dedicated pages (finance-command-center, finance-leave-management).
  const allowed = access.role === "Finance Manager" || canAccessSystemAdministratorWorkspace(access);
  if (!allowed) {
    redirect("/admin");
  }


  const { year, month } = currentCairoDateParts();
  let workspace = null;
  try {
    workspace = await getCompanyCalendarWorkspace(access, year, month);
  } catch {
    workspace = null;
  }

  // The reach of what the viewer CREATES is not the same as what they can READ, and the header used
  // to state the read side ("company-wide") as if it covered both. An admin-tier manager publishes
  // to everyone; a line-scoped one (the Finance Manager, since canPublishCompanyWide is false for
  // him) creates events that only their own line ever sees. Both numbers come from the workspace so
  // this line can never disagree with what the editor below actually does. Line named in words,
  // never a code.
  const publishesCompanyWide = workspace?.canPublishCompanyWide ?? true;
  const viewerLineName = workspace?.viewerLineName?.trim() || null;
  const reachSentence = publishesCompanyWide
    ? "the same live calendar the employee portal uses, company-wide."
    : viewerLineName
      ? `the same live calendar the employee portal uses. Events you create are seen by ${viewerLineName} only.`
      : "the same live calendar the employee portal uses. Events you create are seen by your own line only.";

  return (
    <div className="mx-auto max-w-7xl space-y-5 p-6">
      <div className="flex items-center gap-3 border-b border-border pb-5">
        <div className="h-12 w-1 shrink-0 bg-phx-accent" />
        <div>
          <p className="mb-0.5 text-phx-2xs font-bold uppercase tracking-widest text-phx-accent">Company · Events</p>
          <h1 className="text-2xl font-bold leading-tight text-foreground">Events Calendar</h1>
          <p className="mt-0.5 whitespace-nowrap text-xs text-muted-foreground">
            Company and team events, public holidays, approved leave, plan days and team birthdays —
            {" "}{reachSentence}
          </p>
        </div>
      </div>

      {workspace ? (
        <CompanyCalendar initialWorkspace={workspace} />
      ) : (
        <div className="border border-amber-200 bg-amber-50 px-5 py-4">
          <p className="text-sm font-black text-amber-900">Calendar unavailable</p>
          <p className="mt-1 text-xs font-medium text-amber-800">
            We could not load the company calendar right now. This is a data-source state, not an empty month —
            please refresh in a moment.
          </p>
        </div>
      )}
    </div>
  );
}
