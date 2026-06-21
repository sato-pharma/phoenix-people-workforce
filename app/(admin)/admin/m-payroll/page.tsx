import Link from "next/link";
import { redirect } from "next/navigation";
import { FileDown, FileSpreadsheet, CheckCircle, Clock, AlertCircle } from "lucide-react";

import { AdminInsightChip, AdminPageHero } from "@/components/admin/admin-design-system";
import { Badge } from "@/components/ui/badge";
import { canAccessSystemAdministratorWorkspace } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { listSalaryBatches } from "@/lib/payroll/service";

export const dynamic = "force-dynamic";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function periodLabel(month: number, year: number) {
  return `${MONTHS[month - 1]} ${year}`;
}

function batchStatusBadge(status: string) {
  if (status === "approved" || status === "locked") {
    return (
      <Badge className="border-emerald-200 bg-emerald-50 text-emerald-700">
        <CheckCircle className="mr-1 h-3 w-3" />
        {status.charAt(0).toUpperCase() + status.slice(1)}
      </Badge>
    );
  }
  if (status === "rejected") {
    return (
      <Badge className="border-rose-200 bg-rose-50 text-rose-700">
        <AlertCircle className="mr-1 h-3 w-3" />
        Rejected
      </Badge>
    );
  }
  return (
    <Badge className="border-amber-200 bg-amber-50 text-amber-700">
      <Clock className="mr-1 h-3 w-3" />
      {status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}
    </Badge>
  );
}

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function MPayrollPage({ searchParams }: PageProps) {
  const access = await resolveAccessContextFromPage();

  const isAllowed = access.role === "CEO" || canAccessSystemAdministratorWorkspace(access);
  if (!isAllowed) {
    redirect("/admin");
  }

  const now = new Date();
  const resolved = await searchParams;
  const rawMonth = Array.isArray(resolved.month) ? resolved.month[0] : resolved.month;
  const rawYear = Array.isArray(resolved.year) ? resolved.year[0] : resolved.year;
  const month = rawMonth ? Math.max(1, Math.min(12, parseInt(rawMonth, 10))) : now.getUTCMonth() + 1;
  const year = rawYear ? parseInt(rawYear, 10) : now.getUTCFullYear();

  const allBatches = await listSalaryBatches().catch(() => []);
  const periodBatches = allBatches.filter((b) => b.month === month && b.year === year);

  const years = [...new Set(allBatches.map((b) => b.year))].sort((a, b) => b - a);
  if (!years.includes(year)) years.unshift(year);

  return (
    <div className="space-y-6">
      <AdminPageHero
        eyebrow="CEO VIEW"
        title="CEO Payroll View"
        description={`Salary sheets uploaded by HR — ${periodLabel(month, year)}`}
        badges={
          <div className="flex flex-wrap gap-2">
            <AdminInsightChip>{periodLabel(month, year)}</AdminInsightChip>
            <AdminInsightChip tone={periodBatches.length > 0 ? "orange" : "slate"}>
              {periodBatches.length} sheet{periodBatches.length !== 1 ? "s" : ""}
            </AdminInsightChip>
          </div>
        }
      />

      {/* Period picker */}
      <form className="flex items-center gap-3 border border-[#E2E8F0] bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.06)]">
        <label className="text-sm font-black text-[#0F172A]">Period</label>
        <select
          className="border border-[#E2E8F0] bg-white px-3 py-1.5 text-sm text-[#0F172A] focus:outline-none focus:ring-1 focus:ring-[#F97316]"
          defaultValue={month}
          name="month"
        >
          {MONTHS.map((name, i) => (
            <option key={i + 1} value={i + 1}>
              {name}
            </option>
          ))}
        </select>
        <select
          className="border border-[#E2E8F0] bg-white px-3 py-1.5 text-sm text-[#0F172A] focus:outline-none focus:ring-1 focus:ring-[#F97316]"
          defaultValue={year}
          name="year"
        >
          {years.map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
        <button
          className="border border-[#0F172A] bg-[#0F172A] px-4 py-1.5 text-sm font-black text-white transition hover:bg-[#1E293B]"
          type="submit"
        >
          View
        </button>
      </form>

      {/* Batch list */}
      {periodBatches.length === 0 ? (
        <div className="border border-[#E2E8F0] bg-white p-10 text-center shadow-[0_1px_3px_rgba(15,23,42,0.06)]">
          <FileSpreadsheet className="mx-auto mb-3 h-8 w-8 text-[#CBD5E1]" />
          <p className="text-sm font-black text-[#0F172A]">No salary sheets found</p>
          <p className="mt-1 text-sm text-[#64748B]">
            HR has not uploaded any payroll for {periodLabel(month, year)} yet.
          </p>
        </div>
      ) : (
        <div className="border border-[#E2E8F0] bg-white shadow-[0_1px_3px_rgba(15,23,42,0.06)]">
          <div className="border-b border-[#E2E8F0] bg-[#0F172A] px-5 py-3">
            <h2 className="text-xs font-black uppercase tracking-[0.14em] text-white">
              Salary Sheets — {periodLabel(month, year)}
            </h2>
          </div>
          <table className="w-full border-collapse text-left">
            <thead className="bg-[#F8FAFC]">
              <tr className="border-b border-[#E2E8F0] text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]">
                <th className="px-5 py-3">File Name</th>
                <th className="px-5 py-3">Period</th>
                <th className="px-5 py-3">Status</th>
                <th className="px-5 py-3">Uploaded By</th>
                <th className="px-5 py-3">Uploaded At</th>
                <th className="px-5 py-3">Download</th>
              </tr>
            </thead>
            <tbody>
              {periodBatches.map((batch) => (
                <tr
                  className="border-b border-[#E2E8F0] bg-white text-sm last:border-b-0 hover:bg-[#FFFBF7]"
                  key={batch.id}
                >
                  <td className="px-5 py-4">
                    <div className="flex items-center gap-2">
                      <FileSpreadsheet className="h-4 w-4 flex-shrink-0 text-[#94A3B8]" />
                      <span className="font-semibold text-[#0F172A]">{batch.fileName}</span>
                    </div>
                  </td>
                  <td className="px-5 py-4 text-[#475569]">{periodLabel(batch.month, batch.year)}</td>
                  <td className="px-5 py-4">{batchStatusBadge(batch.status)}</td>
                  <td className="px-5 py-4 text-[#475569]">{batch.uploadedBy ?? "—"}</td>
                  <td className="px-5 py-4 text-[#475569]">
                    {new Date(batch.createdAt).toLocaleDateString("en-EG", {
                      day: "numeric",
                      month: "short",
                      year: "numeric",
                    })}
                  </td>
                  <td className="px-5 py-4">
                    <Link
                      className="inline-flex items-center gap-2 border border-[#0F172A] bg-[#0F172A] px-3 py-1.5 text-xs font-black text-white transition hover:bg-[#1E293B]"
                      href={`/api/payroll/${batch.id}/download`}
                    >
                      <FileDown className="h-3.5 w-3.5" />
                      XLSX
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Recent history summary */}
      {allBatches.length > 0 && (
        <div className="border border-[#E2E8F0] bg-white shadow-[0_1px_3px_rgba(15,23,42,0.06)]">
          <div className="border-b border-[#E2E8F0] bg-[#F8FAFC] px-5 py-3">
            <h2 className="text-xs font-black uppercase tracking-[0.14em] text-[#64748B]">
              Recent Periods
            </h2>
          </div>
          <div className="flex flex-wrap gap-2 p-4">
            {[...new Set(allBatches.map((b) => `${b.year}-${String(b.month).padStart(2, "0")}`))]
              .sort()
              .reverse()
              .slice(0, 12)
              .map((key) => {
                const [y, m] = key.split("-").map(Number);
                const count = allBatches.filter((b) => b.year === y && b.month === m).length;
                const isActive = y === year && m === month;
                return (
                  <Link
                    className={`border px-3 py-1.5 text-xs font-black transition ${
                      isActive
                        ? "border-[#F97316] bg-[#F97316] text-white"
                        : "border-[#E2E8F0] bg-white text-[#0F172A] hover:border-[#F97316]/50 hover:text-[#F97316]"
                    }`}
                    href={`/admin/m-payroll?month=${m}&year=${y}`}
                    key={key}
                  >
                    {periodLabel(m, y)}
                    <span className="ml-1 opacity-60">({count})</span>
                  </Link>
                );
              })}
          </div>
        </div>
      )}
    </div>
  );
}
