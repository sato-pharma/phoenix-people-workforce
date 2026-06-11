"use client";

import { AlertTriangle, CalendarX, CheckCircle2, FileSpreadsheet, MapPin, ShieldAlert, Users } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

import { AdminCallout, AdminInsightChip, AdminPageHero, AdminStatCard, AdminTableShell } from "@/components/admin/admin-design-system";
import { Badge } from "@/components/ui/badge";
import { formatNumber } from "@/lib/sales/format";
import type { SiDataQuality } from "@/lib/sales/intelligence/types";

const pct = (part: number, whole: number) => (whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : "—");

function GapTile({ icon: Icon, label, value }: { icon: typeof Users; label: string; value: number }) {
  const danger = value > 0;
  return (
    <div className={`flex items-center gap-3 border p-3 ${danger ? "border-rose-200 bg-rose-50" : "border-emerald-200 bg-emerald-50"}`}>
      <span className={`flex h-9 w-9 items-center justify-center ${danger ? "bg-rose-100 text-rose-600" : "bg-emerald-100 text-emerald-600"}`}>
        <Icon className="h-4 w-4" />
      </span>
      <div>
        <p className="text-[10px] font-black uppercase tracking-wide text-[#64748B]">{label}</p>
        <p className={`text-lg font-black ${danger ? "text-rose-700" : "text-emerald-700"}`}>{formatNumber(value)}</p>
      </div>
    </div>
  );
}

export function DataQualityCenter({ data, error }: { data: SiDataQuality | null; error: string | null }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  if (error || !data) {
    return (
      <div className="min-h-[60vh] p-5">
        <AdminCallout tone="danger">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
          <div>
            <p className="font-semibold">Data Quality Center could not load.</p>
            <p className="mt-1 text-sm">{error ?? "No data available."}</p>
          </div>
        </AdminCallout>
      </div>
    );
  }

  const incompleteMonths = data.monthCompletion.filter((month) => !month.complete);
  const validPct = pct(data.rowQuality.importableRows, data.rowQuality.totalRows);

  function selectPeriod(value: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("period", value);
    startTransition(() => router.push(`?${params.toString()}`));
  }

  return (
    <div className="space-y-5 p-4 sm:p-5 xl:p-6">
      <AdminPageHero
        actions={(
          <Link href="/sales-intelligence">
            <span className="inline-flex h-10 items-center gap-2 border border-white/20 bg-white/10 px-3 text-xs font-black text-white transition hover:bg-white/20">← Dashboard</span>
          </Link>
        )}
        badges={(
          <>
            <AdminInsightChip tone="orange">{data.period ?? "No month"}</AdminInsightChip>
            <AdminInsightChip tone={incompleteMonths.length > 0 ? "slate" : "emerald"}>
              {incompleteMonths.length} incomplete month{incompleteMonths.length === 1 ? "" : "s"}
            </AdminInsightChip>
          </>
        )}
        description="Upload pipeline health: validated files by month, row validation quality, reference-mapping gaps, and month completion. A month is incomplete until every expected distributor has uploaded."
        eyebrow="Sales Intelligence"
        icon={<ShieldAlert className="h-5 w-5" />}
        title="Data Quality Center"
      />

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-black uppercase tracking-[0.16em] text-[#64748B]">Month</span>
        <select
          className="h-9 border border-[#D8E0EA] bg-white px-3 text-sm font-bold text-[#0F172A] outline-none focus:border-[#6B8FB5]"
          disabled={pending || data.availablePeriods.length === 0}
          onChange={(event) => selectPeriod(event.target.value)}
          value={data.period ?? ""}
        >
          {data.availablePeriods.length === 0 ? <option value="">No validated month</option> : data.availablePeriods.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
      </div>

      {/* Quality KPIs */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <AdminStatCard description={`${formatNumber(data.rowQuality.importableRows)} of ${formatNumber(data.rowQuality.totalRows)} rows`} icon={<CheckCircle2 className="h-4 w-4" />} label="Valid Rows" tone="emerald" value={validPct} variant="full" />
        <AdminStatCard description="rows needing a second look" icon={<AlertTriangle className="h-4 w-4" />} label="Warning Rows" tone="orange" value={formatNumber(data.rowQuality.warningRows)} />
        <AdminStatCard description="rows that failed validation" icon={<ShieldAlert className="h-4 w-4" />} label="Failed Rows" tone="rose" value={formatNumber(data.rowQuality.failedRows)} />
        <AdminStatCard description="months missing a distributor" icon={<CalendarX className="h-4 w-4" />} label="Incomplete Months" tone="violet" value={formatNumber(incompleteMonths.length)} />
      </div>

      {/* Reference-mapping gaps */}
      <AdminTableShell description={`Rows in ${data.period ?? "the latest month"} with an unmapped reference (null). These appear in totals but resolve to “—”.`} title="Reference Mapping Gaps">
        <div className="grid grid-cols-2 gap-3 p-4 md:grid-cols-4 md:p-5">
          <GapTile icon={Users} label="Unmapped Customer" value={data.mappingGaps.missingCustomer} />
          <GapTile icon={MapPin} label="Missing Area" value={data.mappingGaps.missingArea} />
          <GapTile icon={MapPin} label="Missing Region" value={data.mappingGaps.missingRegion} />
          <GapTile icon={MapPin} label="Missing Brick" value={data.mappingGaps.missingBrick} />
        </div>
      </AdminTableShell>

      {/* Month completion */}
      <AdminTableShell description="Each validated month and whether every expected distributor has uploaded." title="Month Completion">
        <div className="space-y-3 p-4 md:p-5">
          {data.monthCompletion.length === 0 ? (
            <p className="text-sm text-[#94A3B8]">No validated months yet.</p>
          ) : (
            data.monthCompletion.map((month) => (
              <div className={`flex flex-col gap-2 border p-3 sm:flex-row sm:items-center sm:justify-between ${month.complete ? "border-emerald-200 bg-emerald-50/50" : "border-amber-200 bg-amber-50/50"}`} key={month.period}>
                <div className="flex items-center gap-3">
                  <Badge variant={month.complete ? "success" : "warning"}>{month.complete ? "Complete" : "Incomplete"}</Badge>
                  <span className="text-sm font-black text-[#0F172A]">{month.period}</span>
                  <span className="text-xs font-bold text-[#64748B]">{month.uploaded.length}/{month.expected.length} distributors</span>
                </div>
                {!month.complete && (
                  <span className="text-xs font-bold text-amber-700">Missing: {month.missing.join(", ")}</span>
                )}
              </div>
            ))
          )}
        </div>
      </AdminTableShell>

      {/* Files by month */}
      <AdminTableShell description="Every uploaded Source-of-Sales workbook, grouped by month." title="Uploaded Files">
        <div className="space-y-6 p-4 md:p-5">
          {data.filesByMonth.length === 0 ? (
            <p className="text-sm text-[#94A3B8]">No uploads yet.</p>
          ) : (
            data.filesByMonth.map((month) => (
              <div key={month.period} className="space-y-2">
                <p className="text-xs font-black uppercase tracking-wide text-[#0F172A]">{month.period}</p>
                <div className="overflow-x-auto border border-[#E2E8F0]">
                  <table className="w-full min-w-[760px] text-left text-sm">
                    <thead>
                      <tr>
                        <th className="px-3 py-2 text-xs font-black uppercase tracking-wide">Distributor</th>
                        <th className="px-3 py-2 text-xs font-black uppercase tracking-wide">Status</th>
                        <th className="px-3 py-2 text-right text-xs font-black uppercase tracking-wide">Total</th>
                        <th className="px-3 py-2 text-right text-xs font-black uppercase tracking-wide">Valid</th>
                        <th className="px-3 py-2 text-right text-xs font-black uppercase tracking-wide">Warn</th>
                        <th className="px-3 py-2 text-right text-xs font-black uppercase tracking-wide">Failed</th>
                        <th className="px-3 py-2 text-xs font-black uppercase tracking-wide">File</th>
                      </tr>
                    </thead>
                    <tbody>
                      {month.batches.map((batch, index) => (
                        <tr key={`${batch.distributorCode}:${batch.fileName}:${index}`}>
                          <td className="px-3 py-2 font-bold text-[#0F172A]">{batch.distributorName}</td>
                          <td className="px-3 py-2"><Badge variant={batch.status === "validated" ? "success" : "danger"}>{batch.status}</Badge></td>
                          <td className="px-3 py-2 text-right text-[#0F172A]">{formatNumber(batch.totalRows)}</td>
                          <td className="px-3 py-2 text-right text-emerald-700">{formatNumber(batch.importableRows)}</td>
                          <td className="px-3 py-2 text-right text-amber-700">{formatNumber(batch.warningRows)}</td>
                          <td className="px-3 py-2 text-right text-rose-700">{formatNumber(batch.failedRows)}</td>
                          <td className="max-w-[220px] truncate px-3 py-2 text-[#64748B]" title={batch.fileName}>
                            <FileSpreadsheet className="mr-1 inline h-3.5 w-3.5" />{batch.fileName}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))
          )}
        </div>
      </AdminTableShell>
    </div>
  );
}
