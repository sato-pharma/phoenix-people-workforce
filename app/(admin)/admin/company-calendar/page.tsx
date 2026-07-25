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
  if (!canAccessSystemAdministratorWorkspace(access)) {
    redirect("/admin");
  }

  const { year, month } = currentCairoDateParts();
  let workspace = null;
  try {
    workspace = await getCompanyCalendarWorkspace(access, year, month);
  } catch {
    workspace = null;
  }

  return (
    <div className="mx-auto max-w-7xl space-y-5 p-6">
      <div className="flex items-center gap-3 border-b border-border pb-5">
        <div className="h-12 w-1 shrink-0 bg-[#F97316]" />
        <div>
          <p className="mb-0.5 text-[10px] font-bold uppercase tracking-widest text-[#F97316]">Company · Events</p>
          <h1 className="text-2xl font-bold leading-tight text-foreground">Events Calendar</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Company and team events, public holidays, approved leave, plan days and team birthdays —
            the same live calendar the employee portal uses, company-wide.
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
