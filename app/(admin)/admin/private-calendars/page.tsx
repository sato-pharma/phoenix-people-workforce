import { redirect } from "next/navigation";

import { PrivateCalendar } from "@/components/employee-portal/private-calendar";
import { PremiumHero } from "@/components/ui/premium-hero";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canUsePrivateCalendarAdminSurface, getPrivateCalendarWorkspace } from "@/lib/private-calendar/service";
import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
import { resolveJobFunctionRole } from "@/lib/employees/job-function";

export const dynamic = "force-dynamic";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const ELIGIBLE_ROLES = new Set([
  "National Sales Manager",
  "Product Manager",
  "Group Product Manager",
  "Training Manager",
]);

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function AdminPrivateCalendarsPage({ searchParams }: PageProps) {
  const access = await resolveAccessContextFromPage();
  if (!canUsePrivateCalendarAdminSurface(access)) {
    redirect("/employee-portals/private-calendar");
  }

  const now = new Date();
  const resolved = await searchParams;
  const getString = (key: string) => {
    const v = resolved[key];
    return Array.isArray(v) ? v[0] : (v ?? null);
  };

  const selectedHrId = getString("employee");
  const rawMonth = getString("month");
  const rawYear = getString("year");
  const nameFilter = (getString("name") ?? "").toLowerCase();
  const lineFilter = getString("line") ?? "";
  const regionFilter = getString("region") ?? "";
  const titleFilter = (getString("title") ?? "").toLowerCase();

  const month = rawMonth ? Math.max(1, Math.min(12, parseInt(rawMonth, 10))) : now.getUTCMonth() + 1;
  const year = rawYear ? parseInt(rawYear, 10) : now.getUTCFullYear();

  // Load and filter to eligible employees (NSM/PM/GPM/TM or head-office = no area)
  const directory = await getEmployeeDirectory().catch(() => null);
  const allEmployees = directory?.employees ?? [];

  const eligible = allEmployees.filter((emp) => {
    const status = (emp.employmentStatus ?? "").toLowerCase();
    if (status !== "active" && status !== "on_leave") return false;
    const role = resolveJobFunctionRole(emp.jobTitle);
    // Head-office: no area assigned + not a field Medical Rep / District Manager
    const isHeadOffice = emp.areaName === null && role !== "Medical Rep" && role !== "District Manager" && role !== "Regional Manager";
    return ELIGIBLE_ROLES.has(role) || isHeadOffice;
  });

  // Derive unique lines and regions for filter dropdowns
  const lines = [...new Set(eligible.map((e) => e.lineName).filter(Boolean) as string[])].sort();
  const regions = [...new Set(eligible.map((e) => e.areaName).filter(Boolean) as string[])].sort();

  // Apply filters for the visible list
  const filtered = eligible.filter((emp) => {
    if (nameFilter && !emp.fullName.toLowerCase().includes(nameFilter)) return false;
    if (lineFilter && emp.lineName !== lineFilter) return false;
    if (regionFilter && emp.areaName !== regionFilter) return false;
    if (titleFilter && !(emp.jobTitle ?? "").toLowerCase().includes(titleFilter)) return false;
    return true;
  });

  // If an employee is selected, load their calendar
  let workspace = null;
  const selectedEmployee = selectedHrId ? eligible.find((e) => e.hrId === selectedHrId) ?? null : null;
  if (selectedHrId && selectedEmployee) {
    workspace = await getPrivateCalendarWorkspace({
      access,
      employeeHrId: selectedHrId,
      month,
      year,
      viewMode: "individual",
    }).catch(() => null);
  }

  const hasFilters = nameFilter || lineFilter || regionFilter || titleFilter;

  return (
    <div className="space-y-6">
      <PremiumHero
        kicker="Private Calendars"
        title="Employee Private Calendar"
        subtitle="Select a head-office or senior field employee to view their private calendar."
      />

      {/* Filter form */}
      <form className="border border-[#E2E8F0] bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.06)]" method="get">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div>
            <label className="mb-1 block text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]">
              Name
            </label>
            <input
              className="w-full border border-[#E2E8F0] bg-white px-3 py-1.5 text-sm text-[#0F172A] focus:outline-none focus:ring-1 focus:ring-[#F97316]"
              defaultValue={nameFilter}
              name="name"
              placeholder="Search by name..."
              type="text"
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]">
              Line
            </label>
            <select
              className="w-full border border-[#E2E8F0] bg-white px-3 py-1.5 text-sm text-[#0F172A] focus:outline-none focus:ring-1 focus:ring-[#F97316]"
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
            <label className="mb-1 block text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]">
              Region / Area
            </label>
            <select
              className="w-full border border-[#E2E8F0] bg-white px-3 py-1.5 text-sm text-[#0F172A] focus:outline-none focus:ring-1 focus:ring-[#F97316]"
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
            <label className="mb-1 block text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]">
              Title
            </label>
            <input
              className="w-full border border-[#E2E8F0] bg-white px-3 py-1.5 text-sm text-[#0F172A] focus:outline-none focus:ring-1 focus:ring-[#F97316]"
              defaultValue={titleFilter}
              name="title"
              placeholder="Filter by title..."
              type="text"
            />
          </div>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <div>
            <label className="mb-1 block text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]">
              Month
            </label>
            <select
              className="border border-[#E2E8F0] bg-white px-3 py-1.5 text-sm text-[#0F172A] focus:outline-none focus:ring-1 focus:ring-[#F97316]"
              defaultValue={month}
              name="month"
            >
              {MONTHS.map((name, i) => (
                <option key={i + 1} value={i + 1}>{name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]">
              Year
            </label>
            <input
              className="border border-[#E2E8F0] bg-white px-3 py-1.5 text-sm text-[#0F172A] focus:outline-none focus:ring-1 focus:ring-[#F97316]"
              defaultValue={year}
              max={now.getUTCFullYear() + 1}
              min={2024}
              name="year"
              type="number"
            />
          </div>
          <div className="mt-auto">
            <button
              className="border border-[#0F172A] bg-[#0F172A] px-4 py-1.5 text-sm font-black text-white transition hover:bg-[#1E293B]"
              type="submit"
            >
              Filter
            </button>
            {hasFilters && (
              <a
                className="ml-2 text-sm text-[#64748B] underline hover:text-[#0F172A]"
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
        <div className="border border-[#E2E8F0] bg-white shadow-[0_1px_3px_rgba(15,23,42,0.06)]">
          <div className="border-b border-[#E2E8F0] bg-[#0F172A] px-5 py-3">
            <h2 className="text-xs font-black uppercase tracking-[0.14em] text-white">
              {hasFilters ? `${filtered.length} employee${filtered.length !== 1 ? "s" : ""} found` : `Eligible employees — ${eligible.length} total`}
            </h2>
          </div>
          {filtered.length === 0 ? (
            <div className="p-8 text-center">
              <p className="text-sm font-black text-[#0F172A]">No employees match your filters</p>
              <p className="mt-1 text-sm text-[#64748B]">Try adjusting the filters above.</p>
            </div>
          ) : (
            <table className="w-full border-collapse text-left">
              <thead className="bg-[#F8FAFC]">
                <tr className="border-b border-[#E2E8F0] text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]">
                  <th className="px-5 py-3">Employee</th>
                  <th className="px-5 py-3">Title</th>
                  <th className="px-5 py-3">Line</th>
                  <th className="px-5 py-3">Area</th>
                  <th className="px-5 py-3">View Calendar</th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, 50).map((emp) => {
                  const params = new URLSearchParams({
                    employee: emp.hrId,
                    month: String(month),
                    year: String(year),
                    ...(nameFilter ? { name: nameFilter } : {}),
                    ...(lineFilter ? { line: lineFilter } : {}),
                    ...(regionFilter ? { region: regionFilter } : {}),
                    ...(titleFilter ? { title: titleFilter } : {}),
                  });
                  return (
                    <tr
                      className="border-b border-[#E2E8F0] bg-white text-sm last:border-b-0 hover:bg-[#FFFBF7]"
                      key={emp.hrId}
                    >
                      <td className="px-5 py-3">
                        <div className="font-semibold text-[#0F172A]">{emp.fullName}</div>
                        <div className="font-mono text-[11px] text-[#94A3B8]">{emp.hrId}</div>
                      </td>
                      <td className="px-5 py-3 text-[#475569]">{emp.jobTitle ?? "—"}</td>
                      <td className="px-5 py-3 text-[#475569]">{emp.lineName ?? "—"}</td>
                      <td className="px-5 py-3 text-[#475569]">{emp.areaName ?? "Head Office"}</td>
                      <td className="px-5 py-3">
                        <a
                          className="inline-flex items-center gap-1.5 border border-[#0F172A] bg-[#0F172A] px-3 py-1.5 text-xs font-black text-white transition hover:bg-[#1E293B]"
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
          {filtered.length > 50 && (
            <div className="border-t border-[#E2E8F0] px-5 py-3 text-sm text-[#64748B]">
              Showing 50 of {filtered.length} — refine your filters to narrow down.
            </div>
          )}
        </div>
      )}

      {/* Calendar view */}
      {workspace && selectedEmployee && (
        <div className="space-y-4">
          <div className="flex items-center justify-between border border-[#E2E8F0] bg-[#0F172A] px-5 py-3 shadow-[0_1px_3px_rgba(15,23,42,0.06)]">
            <div>
              <span className="text-xs font-black uppercase tracking-[0.14em] text-[#94A3B8]">
                Private Calendar
              </span>
              <div className="mt-0.5 font-black text-white">{selectedEmployee.fullName}</div>
              <div className="text-xs text-[#94A3B8]">
                {selectedEmployee.jobTitle ?? "—"} &middot; {selectedEmployee.lineName ?? "Head Office"}
                {selectedEmployee.areaName ? ` · ${selectedEmployee.areaName}` : ""}
              </div>
            </div>
            <a
              className="border border-[#475569] px-3 py-1.5 text-xs font-black text-[#94A3B8] transition hover:border-white hover:text-white"
              href={`/admin/private-calendars?name=${nameFilter}&line=${lineFilter}&region=${regionFilter}&title=${titleFilter}&month=${month}&year=${year}`}
            >
              &larr; Back to list
            </a>
          </div>
          <PrivateCalendar initialWorkspace={workspace} />
        </div>
      )}

      {selectedHrId && !selectedEmployee && (
        <div className="border border-rose-200 bg-rose-50 p-6">
          <p className="text-sm font-black text-rose-700">Employee not found or not eligible for private calendar access.</p>
        </div>
      )}
    </div>
  );
}
