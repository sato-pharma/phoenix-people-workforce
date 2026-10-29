import Link from "next/link";
import { redirect } from "next/navigation";
import { AlertTriangle, Download } from "lucide-react";

import { AdminCallout, AdminInsightChip, AdminPageHero, adminPanelClassName } from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { assertPermission, getPayrollScope } from "@/lib/auth/permissions";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
import { currentCairoDateParts } from "@/lib/i18n/format";
import { listSalaryBatches } from "@/lib/payroll/service";
import type { SalaryBatch } from "@/lib/payroll/types";
import { payrollMonths, payrollPeriodLabel, statusBadge } from "@/components/payroll/dashboard/shared";
import { formatDateTimeValue } from "@/lib/i18n/format";
import { phxSelectClassName } from "@/components/ui/form-tokens";

export const dynamic = "force-dynamic";

type QueryValue = string | string[] | undefined;

type SearchParams = Promise<{
  month?: QueryValue;
  year?: QueryValue;
  batchId?: QueryValue;
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

  // Cairo, not the runtime clock. This fallback is the displayed period, the batch filter and the
  // salary-template download URL, so on a UTC runtime in the first 2-3 hours of a Cairo month HR
  // would download the previous month's template, fill it in, and upload it against that period.
  // (It also bounds the year dropdown, which on 1 January would otherwise start a year early.)
  const { year: fallbackYear, month: fallbackMonth } = currentCairoDateParts(referenceDate);
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
  const access = await resolveAuthenticatedPageAccess();
  // The same company-scope gate as the operational payroll page (audit finding 51). This console
  // lists every salary batch in the company, and `payroll:read` alone is held by self-scope admin
  // roles such as SFE Manager; the sidebar hiding the link is presentation, not a boundary.
  if (getPayrollScope(access) !== "COMPANY") {
    redirect("/payslips");
  }
  await assertPermission(access, "payroll", "read");

  const now = new Date();
  const params = await searchParams;
  const requestedPeriod = parsePayrollPeriod(params.month, params.year, now);
  const selectedBatchId = asText(params.batchId).trim();

  let batches: SalaryBatch[] = [];
  let fetchError: string | null = null;
  let availableYears: number[] = [];

  try {
    batches = await listSalaryBatches();
    const years = new Set<number>([
      requestedPeriod.year,
      requestedPeriod.year - 1,
      requestedPeriod.year + 1,
      requestedPeriod.year + 2,
    ]);
    batches.forEach((batch) => years.add(batch.year));
    availableYears = Array.from(years).sort((left, right) => right - left);
  } catch (error) {
    fetchError = error instanceof Error ? error.message : "Unable to load payroll batches.";
  }

  const selectedBatch = selectedBatchId ? batches.find((batch) => batch.id === selectedBatchId) ?? null : null;
  const month = selectedBatch?.month ?? requestedPeriod.month;
  const year = selectedBatch?.year ?? requestedPeriod.year;
  const hasIssue = requestedPeriod.hasIssue;
  const periodBatches = batches.filter((batch) => batch.month === month && batch.year === year);
  const selectedDownloadUrl = `/api/payroll/template?ready=1&month=${month}&year=${year}`;
  const periodLabel = payrollPeriodLabel(month, year);

  return (
    <div className="space-y-6">
      <AdminPageHero
        actions={(
          <Link href={selectedDownloadUrl} target="_blank">
            <Button className="h-10 rounded-xl border border-phx-accent-line bg-phx-accent-soft px-5 font-semibold text-[#9A3412] hover:bg-[#FFEDD5]">
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
        description="Pick month and year, then download Phoenix-styled payroll data for that period and review salary sheets uploaded by HR."
        eyebrow="CEO Payroll Console"
        icon={<Download className="h-3.5 w-3.5" />}
        title="M.payroll"
      />

      <Card className={`${adminPanelClassName} p-5`}>
        <form action="/admin/m-payroll" className="grid gap-4 md:grid-cols-[220px_160px_auto]">
          <label className="block">
            <span className="mb-1.5 block text-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">
              Month
            </span>
            <select
              className={phxSelectClassName}
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
            <span className="mb-1.5 block text-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">
              Year
            </span>
            <select
              className={phxSelectClassName}
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

      {selectedBatchId && !selectedBatch && !fetchError ? (
        <AdminCallout tone="warning">
          <AlertTriangle className="mt-0.5 h-4 w-4 text-[#B45309]" />
          <div>
            <p className="font-semibold">Selected batch was not found</p>
            <p className="text-sm">
              The requested batch link no longer exists. Showing {periodLabel} instead.
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
        <div className="border-b border-phx-line bg-phx-paper p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-base font-bold text-phx-ink">Uploaded Salary Sheets</h2>
            <Badge variant="neutral">{periodBatches.length} sheets</Badge>
          </div>
          <p className="mt-2 text-sm text-phx-ink-soft">
            Period selected: {periodLabel} • Showing uploads stored in the payroll vault
          </p>
        </div>
        <table className="hidden w-full table-fixed border-collapse text-left text-sm md:table">
          <colgroup>
            <col className="w-[32%]" />
            <col className="w-[20%]" />
            <col className="w-[14%]" />
            <col className="w-[16%]" />
            <col className="w-[18%]" />
          </colgroup>
          <thead>
            <tr className="border-b border-phx-line bg-phx-paper text-xs font-black uppercase tracking-[0.12em] text-phx-ink-soft">
              <th className="px-3 py-3">Uploaded File</th>
              <th className="px-3 py-3">Uploaded by HR</th>
              <th className="px-3 py-3">Status</th>
              <th className="px-3 py-3">Uploaded At</th>
              <th className="px-3 py-3">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-phx-line">
            {fetchError || periodBatches.length === 0 ? (
              <tr>
                <td className="px-3 py-8 text-center text-sm text-phx-ink-soft" colSpan={5}>
                  {fetchError
                    ? "Payroll batches could not be loaded."
                    : `No salary sheets were uploaded for ${periodLabel}.`}
                </td>
              </tr>
            ) : (
              periodBatches.map((batch) => {
                const isSelected = selectedBatchId === batch.id;
                return (
                  <tr className={`align-top transition-colors ${isSelected ? "bg-phx-accent-soft" : "hover:bg-[#FCFDFE]"}`} key={batch.id}>
                    <td className="min-w-0 break-words px-3 py-3 font-semibold text-phx-ink">{batch.fileName}</td>
                    <td className="min-w-0 break-words px-3 py-3 text-phx-ink">{batch.uploadedBy ?? "System Upload"}</td>
                    <td className="min-w-0 break-words px-3 py-3">{statusBadge(batch.status)}</td>
                    <td className="min-w-0 break-words px-3 py-3 text-phx-ink-soft">{formatDateTimeValue(batch.createdAt)}</td>
                    <td className="px-3 py-3">
                      <div className="flex flex-wrap gap-2">
                        <Link href={`/api/payroll/${batch.id}/download`} target="_blank">
                          <Button className="h-9 px-3 py-1.5 text-xs" variant="secondary">
                            <Download className="mr-2 h-3.5 w-3.5" />
                            Download
                          </Button>
                        </Link>
                        <Link href={`/admin/m-payroll?batchId=${encodeURIComponent(batch.id)}`}>
                          <Button className="h-9 px-3 py-1.5 text-xs" variant="secondary">
                            Open batch
                          </Button>
                        </Link>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
        <div className="divide-y divide-phx-line md:hidden">
          {fetchError || periodBatches.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-phx-ink-soft">
              {fetchError
                ? "Payroll batches could not be loaded."
                : `No salary sheets were uploaded for ${periodLabel}.`}
            </p>
          ) : (
            periodBatches.map((batch) => (
              <div className={`min-w-0 space-y-1.5 px-4 py-3 ${selectedBatchId === batch.id ? "bg-phx-accent-soft" : ""}`} key={batch.id}>
                <div className="flex min-w-0 items-start justify-between gap-3">
                  <p className="min-w-0 break-words text-sm font-semibold text-phx-ink">{batch.fileName}</p>
                  {statusBadge(batch.status)}
                </div>
                <p className="text-xs text-phx-ink-soft">
                  {batch.uploadedBy ?? "System Upload"} · {formatDateTimeValue(batch.createdAt)}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Link href={`/api/payroll/${batch.id}/download`} target="_blank">
                    <Button className="h-9 px-3 py-1.5 text-xs" variant="secondary">
                      <Download className="mr-2 h-3.5 w-3.5" />
                      Download
                    </Button>
                  </Link>
                  <Link href={`/admin/m-payroll?batchId=${encodeURIComponent(batch.id)}`}>
                    <Button className="h-9 px-3 py-1.5 text-xs" variant="secondary">
                      Open batch
                    </Button>
                  </Link>
                </div>
              </div>
            ))
          )}
        </div>
      </Card>
    </div>
  );
}
