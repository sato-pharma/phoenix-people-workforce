import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, Fingerprint } from "lucide-react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { attendanceManagementPageItems } from "@/config/system-navigation";
import {
  buildPermissionLookup,
  canAccessFingerprintReport,
  getPermissionMatrix,
  resolveNavigationMode,
} from "@/lib/auth/permissions";
import { guardSeatPage } from "@/lib/auth/seat-page-guard";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { navigationItemVisible } from "@/lib/navigation/active-path";

export const dynamic = "force-dynamic";

const FINGERPRINT_REPORT_HREF = "/attendance/fingerprint-report";

export default async function AttendanceManagementPage() {
  const access = await resolveAccessContextFromPage();
  guardSeatPage(access, "/attendance");
  if (resolveNavigationMode(access) === "employee-portal") redirect("/employee-portals");

  const matrix = await getPermissionMatrix();
  const permissionLookup = buildPermissionLookup(matrix, access.role);
  // Fingerprint Report gets a page-scoped exception for CEO (see
  // canAccessFingerprintReport) even though the card's own gate — the
  // "employees" permission — stays Super Admin-only for every other role.
  //
  // That exception now governs every role, Super Admin included: the old bypass returned the whole
  // list for them and never reached this branch. It resolves to canAccess(employees, read), which
  // Super Admin holds, so the card still shows — and if a matrix override ever removed that grant,
  // the card would correctly stop showing instead of lingering on the strength of the role name.
  const canViewFingerprintReport = await canAccessFingerprintReport(access);

  const visibleTools = attendanceManagementPageItems.filter((item) => {
    if (item.href === FINGERPRINT_REPORT_HREF) return canViewFingerprintReport;
    return navigationItemVisible(item, permissionLookup, access.role);
  });

  // The hero eyebrow reads "Attendance", not "HR Operations". Two things were wrong with the seat
  // name, and the second is the one that mattered.
  //
  // First, an eyebrow is a DOMAIN label everywhere else in this shell — "Sales", "Leave",
  // "Coaching", "People" — never a role; and "HR Operations" is an internal role KEY besides, which
  // the owner's standing rule keeps out of the UI in favour of human-readable names (AGENTS.md §4).
  //
  // Second and worse: this hub serves BOTH HR seats. The HR Business Partner reaches it on
  // attendance:read, which her job description earns her by name — "identify turnover, vacancy,
  // attendance, performance or engagement patterns that need management attention" — so the old
  // eyebrow stamped her own page with the OTHER seat's name.
  //
  // "Attendance" / "Attendance Management" mirrors "Leave" / "Leave Management" on the sibling hub.
  return (
    <div className="space-y-6">
      <AdminPageHero
        description="Every attendance report, review queue, policy control, and calendar — in one place."
        eyebrow="Attendance"
        icon={<Fingerprint className="h-3.5 w-3.5" />}
        title="Attendance Management"
      />

      {visibleTools.length === 0 ? (
        <div className="border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
          No attendance management tools are available for your role.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {visibleTools.map((tool) => {
            const Icon = tool.icon;
            return (
              <Link
                className="group relative flex flex-col overflow-hidden border border-slate-200 bg-white p-5 shadow-[0_4px_16px_rgba(15,23,42,0.07)] transition duration-200 hover:-translate-y-1 hover:border-orange-300/70 hover:shadow-[0_16px_38px_rgba(15,23,42,0.13)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-2"
                href={tool.href}
                key={tool.href}
              >
                <span
                  aria-hidden="true"
                  className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-orange-500 via-orange-400 to-amber-300 opacity-70 transition-opacity duration-200 group-hover:opacity-100"
                />
                <div className="flex items-start gap-3">
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center bg-gradient-to-br from-orange-100 to-orange-50 text-orange-700 ring-1 ring-orange-200/70">
                    <Icon aria-hidden="true" className="h-5 w-5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <h3 className="text-sm font-bold tracking-[-0.01em] text-slate-950">{tool.label}</h3>
                    <p className="mt-1.5 text-xs leading-5 text-slate-500">{tool.description}</p>
                  </div>
                </div>
                <div className="mt-4 inline-flex items-center gap-1 text-xs font-bold text-orange-700">
                  Open
                  <ArrowRight aria-hidden="true" className="h-3.5 w-3.5 transition-transform duration-200 group-hover:translate-x-0.5" />
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
