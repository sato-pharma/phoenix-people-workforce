import { humanizeCode } from "@/lib/format/code-label";
import { redirect } from "next/navigation";

import { PremiumHero } from "@/components/ui/premium-hero";
import { PrivateCalendar } from "@/components/employee-portal/private-calendar";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { currentCairoDateOnlyIso, currentCairoDateParts } from "@/lib/i18n/format";
import { canUsePrivateCalendarAdminSurface, getPrivateCalendarWorkspace } from "@/lib/private-calendar/service";
import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
import {
  phxFieldClassName,
  phxSelectClassName,
} from "@/components/ui/form-tokens";

export const dynamic = "force-dynamic";

// The whole company lands in this list now, so it is capped for render cost and the cap is stated
// on screen. Name, line, area, department, title and status all narrow it below this.
const ROW_CAP = 100;

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// Every employee is reachable from this desk (owner, 2026-10-08: "make me able to filter on any
// emp here"). The surface is already gated to a private-calendar global viewer — Super Admin, CEO,
// system scope or a configured HR id — and such a viewer may read ANY employee's calendar
// (canReadPrivateCalendarEmployee), so the old NSM/PM/GPM/TM-or-head-office shortlist narrowed the
// picker and nothing else. Do not reintroduce a role shortlist here: it hid field reps and district
// managers whose calendars this desk is allowed to open.
type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function AdminPrivateCalendarsPage({ searchParams }: PageProps) {
  const access = await resolveAccessContextFromPage();
  if (!canUsePrivateCalendarAdminSurface(access)) {
    redirect("/employee-portals/private-calendar");
  }

  const now = new Date();
  const { year: currentYear, month: currentMonth } = currentCairoDateParts(now);
  const resolved = await searchParams;
  const getString = (key: string) => {
    const v = resolved[key];
    return Array.isArray(v) ? v[0] : (v ?? null);
  };

  const selectedHrId = getString("employee");
  const rawMonth = getString("month");
  const rawYear = getString("year");
  const nameFilter = (getString("name") ?? "").trim().toLowerCase();
  const lineFilter = getString("line") ?? "";
  const regionFilter = getString("region") ?? "";
  const departmentFilter = getString("department") ?? "";
  const titleFilter = (getString("title") ?? "").trim().toLowerCase();
  // Active-and-on-leave by default, because that is who somebody is normally looking for; "all"
  // keeps a leaver reachable, since a past month's calendar is exactly when one is wanted.
  const statusFilter = getString("status") === "all" ? "all" : "working";

  const month = rawMonth ? Math.max(1, Math.min(12, parseInt(rawMonth, 10))) : currentMonth;
  const year = rawYear ? parseInt(rawYear, 10) : currentYear;

  const directory = await getEmployeeDirectory().catch(() => null);
  const allEmployees = directory?.employees ?? [];

  const isWorking = (emp: (typeof allEmployees)[number]) => {
    const status = (emp.employmentStatus ?? "").toLowerCase();
    return status === "active" || status === "on_leave";
  };

  // The pool is the whole company. Only the employment-status choice narrows it, and the
  // dropdowns below are derived from that same pool so a filter can never offer an empty result.
  const pool = statusFilter === "all" ? allEmployees : allEmployees.filter(isWorking);

  // Derive unique lines, regions and departments for the filter dropdowns
  const lines = [...new Set(pool.map((e) => e.lineName).filter(Boolean) as string[])].sort();
  const regions = [...new Set(pool.map((e) => e.areaName).filter(Boolean) as string[])].sort();
  const departments = [...new Set(pool.map((e) => e.departmentName).filter(Boolean) as string[])].sort();

  // Name search spans the display name, the legal name, the nickname and the HR id — he searches
  // with whichever one he knows, and head-office people are often known by the nickname only.
  const matchesName = (emp: (typeof allEmployees)[number]) =>
    [emp.displayName, emp.fullName, emp.nickname, emp.hrId]
      .some((value) => (value ?? "").toLowerCase().includes(nameFilter));

  // Apply filters for the visible list. Sorted by name, because the directory query carries no
  // ORDER BY of its own and the list below is capped — an unsorted cap would show an arbitrary
  // slice of the company and look like the filter had lost people.
  const filtered = pool
    .filter((emp) => {
      if (nameFilter && !matchesName(emp)) return false;
      if (lineFilter && emp.lineName !== lineFilter) return false;
      if (regionFilter && emp.areaName !== regionFilter) return false;
      if (departmentFilter && emp.departmentName !== departmentFilter) return false;
      if (titleFilter && !(emp.jobTitle ?? "").toLowerCase().includes(titleFilter)) return false;
      return true;
    })
    .sort((left, right) => left.displayName.localeCompare(right.displayName, "en"));

  // If an employee is selected, load their calendar. Resolve against the WHOLE directory, never the
  // filtered list, so a link stays valid after the filters change and a leaver opens from status=all.
  let workspace = null;
  const selectedEmployee = selectedHrId ? allEmployees.find((e) => e.hrId === selectedHrId) ?? null : null;
  if (selectedHrId && selectedEmployee) {
    workspace = await getPrivateCalendarWorkspace({
      access,
      employeeHrId: selectedHrId,
      month,
      year,
      viewMode: "individual",
    }).catch(() => null);
  }

  const hasFilters = Boolean(
    nameFilter || lineFilter || regionFilter || departmentFilter || titleFilter || statusFilter === "all",
  );

  // Carried on every link so a chosen filter set survives opening a calendar and coming back.
  const filterParams: Record<string, string> = {
    ...(nameFilter ? { name: nameFilter } : {}),
    ...(lineFilter ? { line: lineFilter } : {}),
    ...(regionFilter ? { region: regionFilter } : {}),
    ...(departmentFilter ? { department: departmentFilter } : {}),
    ...(titleFilter ? { title: titleFilter } : {}),
    ...(statusFilter === "all" ? { status: "all" } : {}),
  };
  const backToListHref = `/admin/private-calendars?${new URLSearchParams({
    ...filterParams,
    month: String(month),
    year: String(year),
  }).toString()}`;

  return (
    <div className="space-y-6">
      <PremiumHero
        kicker="Private Calendars"
        title="Employee Private Calendar"
        subtitle="Filter the whole company by name, line, area, department, title or employment status, then open any employee's private calendar."
      />

      {/* Filter form */}
      <form className="border border-phx-line bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.06)]" method="get">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
          <div>
            <label className="mb-1 block text-phx-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">
              Name or HR ID
            </label>
            <input
              className={phxFieldClassName}
              defaultValue={nameFilter}
              name="name"
              placeholder="Search name, nickname or HR ID..."
              type="text"
            />
          </div>
          <div>
            <label className="mb-1 block text-phx-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">
              Line
            </label>
            <select
              className={phxSelectClassName}
              defaultValue={lineFilter}
              name="line"
            >
              <option value="">All Lines</option>
              {lines.map((l) => (
                <option key={l} value={l}>{l}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-phx-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">
              Region / Area
            </label>
            <select
              className={phxSelectClassName}
              defaultValue={regionFilter}
              name="region"
            >
              <option value="">All Regions</option>
              {regions.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-phx-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">
              Department
            </label>
            <select
              className={phxSelectClassName}
              defaultValue={departmentFilter}
              name="department"
            >
              <option value="">All Departments</option>
              {departments.map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-phx-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">
              Title
            </label>
            <input
              className={phxFieldClassName}
              defaultValue={titleFilter}
              name="title"
              placeholder="Filter by title..."
              type="text"
            />
          </div>
          <div>
            <label className="mb-1 block text-phx-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">
              Status
            </label>
            <select
              className={phxSelectClassName}
              defaultValue={statusFilter}
              name="status"
            >
              <option value="working">Active &amp; On Leave</option>
              <option value="all">Everyone, leavers included</option>
            </select>
          </div>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <div>
            <label className="mb-1 block text-phx-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">
              Month
            </label>
            <select
              className={phxSelectClassName}
              defaultValue={month}
              name="month"
            >
              {MONTHS.map((name, i) => (
                <option key={i + 1} value={i + 1}>{name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-phx-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">
              Year
            </label>
            <input
              className={phxFieldClassName}
              defaultValue={year}
              max={currentYear + 1}
              min={2024}
              name="year"
              type="number"
            />
          </div>
          <div className="mt-auto">
            <button
              className="border border-phx-ink bg-phx-ink px-4 py-1.5 text-sm font-black text-white transition hover:bg-[#1E293B]"
              type="submit"
            >
              Filter
            </button>
            {hasFilters && (
              <a
                className="ml-2 text-sm text-phx-ink-soft underline hover:text-phx-ink"
                href="/admin/private-calendars"
              >
                Clear
              </a>
            )}
          </div>
        </div>
      </form>

      {/* Employee results */}
      {!workspace && (
        <div className="border border-phx-line bg-white shadow-[0_1px_3px_rgba(15,23,42,0.06)]">
          <div className="border-b border-phx-line bg-phx-ink px-5 py-3">
            <h2 className="text-xs font-black uppercase tracking-[0.14em] text-white">
              {hasFilters
                ? `${filtered.length} employee${filtered.length !== 1 ? "s" : ""} found of ${pool.length}`
                : `All employees — ${pool.length} total`}
            </h2>
          </div>
          {filtered.length === 0 ? (
            <div className="p-8 text-center">
              <p className="text-sm font-black text-phx-ink">No employees match your filters</p>
              <p className="mt-1 text-sm text-phx-ink-soft">Try adjusting the filters above.</p>
            </div>
          ) : (
            /* table-fixed + colgroup, per the fits-the-screen golden rule: the whole company now
               lands here, and a long job title or department used to widen the table instead of
               wrapping inside its own cell. On a phone the three middle columns MERGE into the
               employee cell (`w-0` + `hidden`) rather than squeezing five columns into 375px. */
            <table className="w-full table-fixed border-collapse text-left">
              <colgroup>
                <col className="w-[58%] sm:w-[26%]" />
                <col className="w-0 sm:w-[22%]" />
                <col className="w-0 sm:w-[16%]" />
                <col className="w-0 sm:w-[20%]" />
                <col className="w-[42%] sm:w-[16%]" />
              </colgroup>
              <thead className="bg-phx-paper">
                <tr className="border-b border-phx-line text-phx-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">
                  <th className="px-5 py-3">Employee</th>
                  <th className="hidden px-5 py-3 sm:table-cell">Title</th>
                  <th className="hidden px-5 py-3 sm:table-cell">Line</th>
                  <th className="hidden px-5 py-3 sm:table-cell">Area / Department</th>
                  <th className="px-5 py-3">View Calendar</th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, ROW_CAP).map((emp) => {
                  const params = new URLSearchParams({
                    ...filterParams,
                    employee: emp.hrId,
                    month: String(month),
                    year: String(year),
                  });
                  const working = isWorking(emp);
                  return (
                    <tr
                      className="border-b border-phx-line bg-white text-sm last:border-b-0 hover:bg-[#FFFBF7]"
                      key={emp.hrId}
                    >
                      <td className="px-5 py-3 align-top">
                        <div className="break-words font-semibold text-phx-ink">{emp.displayName}</div>
                        {!working && (
                          <div className="mt-1 inline-block border border-phx-line bg-phx-paper px-1.5 py-0.5 text-phx-xs font-black uppercase tracking-[0.1em] text-phx-ink-soft">
                            {emp.employmentStatus ? humanizeCode(emp.employmentStatus) : "Not active"}
                          </div>
                        )}
                        {/* The merged phone view of the three columns hidden below sm. */}
                        <div className="mt-1 break-words text-phx-xs text-phx-ink-soft sm:hidden">
                          {[emp.jobTitle, emp.lineName, emp.areaName ?? "Head Office", emp.departmentName]
                            .filter(Boolean)
                            .join(" · ")}
                        </div>
                      </td>
                      <td className="hidden break-words px-5 py-3 align-top text-phx-ink-2 sm:table-cell">{emp.jobTitle ?? "—"}</td>
                      <td className="hidden break-words px-5 py-3 align-top text-phx-ink-2 sm:table-cell">{emp.lineName ?? "—"}</td>
                      <td className="hidden break-words px-5 py-3 align-top text-phx-ink-2 sm:table-cell">
                        <div>{emp.areaName ?? "Head Office"}</div>
                        {emp.departmentName && (
                          <div className="text-phx-xs text-phx-ink-faint">{emp.departmentName}</div>
                        )}
                      </td>
                      <td className="px-5 py-3 align-top">
                        <a
                          className="inline-flex items-center gap-1.5 border border-phx-ink bg-phx-ink px-3 py-1.5 text-xs font-black text-white transition hover:bg-[#1E293B]"
                          href={`/admin/private-calendars?${params.toString()}`}
                        >
                          View Calendar
                        </a>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {filtered.length > ROW_CAP && (
            <div className="border-t border-phx-line px-5 py-3 text-sm text-phx-ink-soft">
              Showing the first {ROW_CAP} of {filtered.length}, sorted by name — narrow the filters to reach the rest.
            </div>
          )}
        </div>
      )}

      {/* Calendar view */}
      {workspace && selectedEmployee && (
        <div className="space-y-4">
          <div className="flex items-center justify-between border border-phx-line bg-phx-ink px-5 py-3 shadow-[0_1px_3px_rgba(15,23,42,0.06)]">
            <div>
              <span className="text-xs font-black uppercase tracking-[0.14em] text-phx-ink-faint">
                Private Calendar
              </span>
              <div className="mt-0.5 font-black text-white">{selectedEmployee.displayName}</div>
              <div className="text-xs text-phx-ink-faint">
                {selectedEmployee.jobTitle ?? "—"} &middot; {selectedEmployee.lineName ?? "Head Office"}
                {selectedEmployee.areaName ? ` · ${selectedEmployee.areaName}` : ""}
              </div>
            </div>
            <a
              className="border border-phx-ink-2 px-3 py-1.5 text-xs font-black text-phx-ink-faint transition hover:border-white hover:text-white"
              href={backToListHref}
            >
              &larr; Back to list
            </a>
          </div>
          {/* The admin desk keeps the source trace (system, table, record ID) and HR IDs, which an
              employee's own calendar no longer prints. */}
          <PrivateCalendar
            initialWorkspace={workspace}
            showDeskDetail
            todayIso={currentCairoDateOnlyIso(now)}
            viewerHrId={access.hrId}
          />
        </div>
      )}

      {selectedHrId && !selectedEmployee && (
        <div className="border border-rose-200 bg-rose-50 p-6">
          <p className="text-sm font-black text-rose-700">
            No employee on record with HR ID {selectedHrId}.
          </p>
          <p className="mt-1 text-sm text-rose-700">
            Every employee is selectable from this desk, so this is a stale link rather than a permission limit.
          </p>
        </div>
      )}

      {/* A failed read says so, instead of dropping back to the list as if nothing had been asked. */}
      {selectedEmployee && !workspace && (
        <div className="border border-rose-200 bg-rose-50 p-6">
          <p className="text-sm font-black text-rose-700">
            The calendar for {selectedEmployee.displayName} could not be loaded for {MONTHS[month - 1]} {year}.
          </p>
          <p className="mt-1 text-sm text-rose-700">
            The read failed rather than coming back empty — try the month again, and tell me if it keeps failing.
          </p>
          <a className="mt-3 inline-block text-sm text-rose-700 underline" href={backToListHref}>
            Back to list
          </a>
        </div>
      )}
    </div>
  );
}

