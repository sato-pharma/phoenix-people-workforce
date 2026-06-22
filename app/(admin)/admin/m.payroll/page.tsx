import Link from "next/link";
import { AlertTriangle, Download } from "lucide-react";

import { AdminCallout, AdminInsightChip, AdminPageHero, adminPanelClassName } from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { listSalaryBatches } from "@/lib/payroll/service";
import type { SalaryBatch } from "@/lib/payroll/types";
import { payrollMonths, payrollPeriodLabel, statusBadge } from "@/components/payroll/dashboard/shared";
import { formatDateTimeValue } from "@/lib/i18n/format";

export const dynamic = "force-dynamic";

type QueryValue = string | string[] | undefined;

type SearchParams = Promise<{
  month?: QueryValue;
  year?: QueryValue;
}>;

function asText(value: QueryValue) {
  return Array.isArray(value) ? value[0] : value ?? "";
}

function parsePayrollPeriod(
  monthInput: QueryValue,
  yearInput: QueryValue,
  referenceDate: Date,
) {
  const monthText = asText(monthInput);
  const yearText = asText(yearInput);
  const requestedMonth = Number(monthText);
  const requestedYear = Number(yearText);

  const fallbackMonth = referenceDate.getMonth() + 1;
  const fallbackYear = referenceDate.getFullYear();
  let month = fallbackMonth;
  let year = fallbackYear;
  let hasIssue = false;

  if (Number.isInteger(requestedMonth) && requestedMonth >= 1 && requestedMonth <= 12) {
    month = requestedMonth;
  } else if (monthText) {
    hasIssue = true;
  }

  if (Number.isInteger(requestedYear) && requestedYear >= 2000 && requestedYear <= fallbackYear + 2) {
    year = requestedYear;
  } else if (yearText) {
    hasIssue = true;
  }

  return { hasIssue, month, year };
}

export default async function MPayrollPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const access = await resolveAccessContextFromPage();
  await assertPermission(access, "payroll", "read");

  const now = new Date();
  const params = await searchParams;
  const { hasIssue, month, year } = parsePayrollPeriod(params.month, params.year, now);

  let batches: SalaryBatch[] = [];
  let fetchError: string | null = null;
  let availableYears: number[] = [];

  try {
    batches = await listSalaryBatches();
    const years = new Set<number>([year, year - 1, year + 1, year + 2]);
    batches.forEach((batch) => years.add(batch.year));
    availableYears = Array.from(years).sort((left, right) => right - left);
  } catch (error) {
    fetchError = error instanceof Error ? error.message : "Unable to load payroll batches.";
  }

  const periodBatches = batches.filter((batch) => batch.month === month && batch.year === year);
  const selectedDownloadUrl = `/api/payroll/template?ready=1&month=${month}&year=${year}`;
  const periodLabel = payrollPeriodLabel(month, year);

  return (
    <div className="space-y-6">
      <AdminPageHero
        actions={(
          <Link href={selectedDownloadUrl} target="_blank">
            <Button className="h-10 rounded-xl border border-[#FDBA74] bg-[#FFF7ED] px-5 font-semibold text-[#9A3412] hover:bg-[#FFEDD5]">
              <Download className="mr-2 h-4 w-4" />
              Download Payroll XLSX
            </Button>
          </Link>
        )}
        badges={(
          <div className="flex flex-wrap gap-2">
            <AdminInsightChip>M.payroll</AdminInsightChip>
            <AdminInsightChip tone="orange">{periodLabel}</AdminInsightChip>
          </div>
        )}
        description="Pick month and year, then download Phoenix-styled payroll data and review salary sheets uploaded by HR."
        eyebrow="CEO Payroll Console"
        icon={<Download className="h-3.5 w-3.5" />}
        title="M.payroll"
      />

      <Card className={`${adminPanelClassName} p-5`}>
        <form action="/admin/m.payroll" className="grid gap-4 md:grid-cols-[220px_160px_auto]">
          <label className="block">
            <span className="mb-1.5 block text-xs font-black uppercase tracking-[0.14em] text-[#64748B]">
              Month
            </span>
            <select
              className="h-11 w-full rounded-xl border border-[#D8E0EA] bg-white px-3 text-sm font-semibold text-[#0F172A] outline-none transition focus:border-[#FDBA74] focus:ring-2 focus:ring-[#F97316]/12"
              defaultValue={String(month)}
              name="month"
            >
              {payrollMonths.map((monthOption) => (
                <option key={monthOption.value} value={monthOption.value}>
                  {monthOption.label}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="mb-1.5 block text-xs font-black uppercase tracking-[0.14em] text-[#64748B]">
              Year
            </span>
            <select
              className="h-11 w-full rounded-xl border border-[#D8E0EA] bg-white px-3 text-sm font-semibold text-[#0F172A] outline-none transition focus:border-[#FDBA74] focus:ring-2 focus:ring-[#F97316]/12"
              defaultValue={String(year)}
              name="year"
            >
              {availableYears.map((yearOption) => (
                <option key={yearOption} value={yearOption}>
                  {yearOption}
                </option>
              ))}
            </select>
          </label>

          <Button className="h-11 rounded-xl px-6" type="submit">
            Apply Period
          </Button>
        </form>
      </Card>

      {hasIssue ? (
        <AdminCallout tone="warning">
          <AlertTriangle className="mt-0.5 h-4 w-4 text-[#B45309]" />
          <div>
            <p className="font-semibold">Invalid period detected</p>
            <p className="text-sm">
              The selected values were reset to the latest available period: {periodLabel}
            </p>
          </div>
        </AdminCallout>
      ) : null}

      {fetchError ? (
        <AdminCallout tone="danger">
          <AlertTriangle className="mt-0.5 h-4 w-4 text-[#B91C1C]" />
          <div>
            <p className="font-semibold">Unable to load payroll uploads</p>
            <p className="text-sm">{fetchError}</p>
          </div>
        </AdminCallout>
      ) : null}

      <Card className={`${adminPanelClassName} overflow-hidden p-0`}>
        <div className="border-b border-[#E2E8F0] bg-[#F8FAFC] p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-base font-bold text-[#0F172A]">Uploaded Salary Sheets</h2>
            <Badge variant="neutral">{periodBatches.length} sheets</Badge>
          </div>
          <p className="mt-2 text-sm text-[#64748B]">
            Period selected: {periodLabel} • Showing uploads stored in the payroll vault
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[680px] text-left text-sm">
            <thead>
              <tr className="border-b border-[#E2E8F0] bg-[#F8FAFC] text-xs font-black uppercase tracking-[0.12em] text-[#64748B]">
                <th className="px-3 py-3">Uploaded File</th>
                <th className="px-3 py-3">Uploaded by HR</th>
                <th className="px-3 py-3">Status</th>
                <th className="px-3 py-3">Uploaded At</th>
                <th className="px-3 py-3">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E2E8F0]">
              {fetchError || periodBatches.length === 0 ? (
                <tr>
                  <td className="px-3 py-8 text-center text-sm text-[#64748B]" colSpan={5}>
                    {fetchError
                      ? "Payroll batches could not be loaded."
                      : `No salary sheets were uploaded for ${periodLabel}.`}
                  </td>
                </tr>
              ) : (
                periodBatches.map((batch) => (
                  <tr className="transition-colors hover:bg-[#FCFDFE]" key={batch.id}>
                    <td className="px-3 py-3">
                      <p className="font-semibold text-[#0F172A]">{batch.fileName}</p>
                      <p className="mt-0.5 text-xs text-[#64748B]">Batch ID: {batch.id}</p>
                    </td>
                    <td className="px-3 py-3 text-[#0F172A]">{batch.uploadedBy ?? "System Upload"}</td>
                    <td className="px-3 py-3">{statusBadge(batch.status)}</td>
                    <td className="px-3 py-3 text-[#64748B]">{formatDateTimeValue(batch.createdAt)}</td>
                    <td className="px-3 py-3">
                      <Link href={`/api/payroll/${batch.id}/download`} target="_blank">
                        <Button className="h-9 px-3 py-1.5 text-xs" variant="secondary">
                          <Download className="mr-2 h-3.5 w-3.5" />
                          Download
                        </Button>
                      </Link>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
