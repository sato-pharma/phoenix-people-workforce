"use client";

import Link from "next/link";
import { useState } from "react";
import { Eye, EyeOff, MinusCircle } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { MedicalRepPortalData } from "@/lib/employee-portal/service";

function egp(value: number) {
  return new Intl.NumberFormat("en-US", {
    currency: "EGP",
    maximumFractionDigits: 0,
    style: "currency",
  }).format(Number.isFinite(value) ? value : 0);
}

function payrollStatusTone(value: string) {
  const normalized = value.toLowerCase();
  if (normalized.includes("paid") || normalized.includes("approved") || normalized.includes("finalized")) {
    return "success" as const;
  }
  if (
    normalized.includes("pending") ||
    normalized.includes("processing") ||
    normalized.includes("draft")
  ) {
    return "warning" as const;
  }
  if (normalized.includes("rejected") || normalized.includes("failed")) {
    return "danger" as const;
  }
  return "neutral" as const;
}

function PayrollStat({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  const [isValueVisible, setIsValueVisible] = useState(false);
  const toggleLabel = isValueVisible ? `Hide ${label}` : `Show ${label}`;

  return (
    <div className="group relative overflow-hidden rounded border border-slate-200/90 bg-gradient-to-br from-white to-slate-50/50 px-4 py-3 shadow-[0_4px_14px_rgba(15,23,42,0.04)] transition-all duration-150 ease-out hover:-translate-y-px hover:shadow-md hover:border-slate-300">
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 text-phx-2xs font-bold uppercase tracking-[0.12em] text-slate-500">{label}</p>
        <button
          aria-label={toggleLabel}
          aria-pressed={isValueVisible}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded border border-slate-200 bg-white text-slate-500 shadow-sm transition hover:border-orange-200 hover:bg-orange-50 hover:text-orange-600 focus-visible:outline-2 focus-visible:outline-orange-500 focus-visible:outline-offset-1"
          onClick={() => setIsValueVisible((current) => !current)}
          title={toggleLabel}
          type="button"
        >
          {isValueVisible ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
        </button>
      </div>
      <p className="mt-1.5 font-mono text-xl font-semibold text-slate-900 tabular-nums">
        {isValueVisible ? value : "******"}
      </p>
    </div>
  );
}

export function PayrollSummaryPanel({ data }: { data: MedicalRepPortalData }) {
  if (data.empty.payroll) {
    return (
      <Card className="rounded border border-slate-100 bg-white p-6 shadow-[0_10px_24px_rgba(15,23,42,0.05)]">
        <div className="flex h-full flex-col items-center justify-center text-center">
          <div className="flex h-11 w-11 items-center justify-center rounded bg-slate-50 text-slate-500">
            <MinusCircle className="h-5 w-5" />
          </div>
          <p className="mt-3 text-sm font-semibold text-slate-900">Payroll Unavailable</p>
          <p className="mt-1 text-sm text-slate-600">Payslip data has not been uploaded yet.</p>
          <Button className="mt-4" disabled variant="secondary">View Payslip</Button>
        </div>
      </Card>
    );
  }

  const gross = Math.max(1, data.payroll.grossSalary);
  const additionsRatio = Math.min(100, Math.round((Math.max(0, data.payroll.totalAdditions) / gross) * 100));
  const deductionsRatio = Math.min(100, Math.round((Math.max(0, data.payroll.totalDeductions) / gross) * 100));
  const netRatio = Math.min(100, Math.round((Math.max(0, data.payroll.netSalary) / gross) * 100));

  return (
    <Card className="rounded border border-slate-100 bg-white p-6 shadow-[0_10px_24px_rgba(15,23,42,0.05)]">
      <div className="flex items-center justify-between">
        <p className="text-lg font-semibold text-slate-900">Payroll Summary</p>
        <Link className="text-sm font-medium text-orange-600 hover:text-orange-700" href="/payslips">
          View Payslips
        </Link>
      </div>
      <p className="mt-3 text-xs uppercase tracking-[0.12em] text-slate-500">Latest Payslip</p>
      <p className="mt-1 text-sm text-slate-600">{data.payroll.latestBatchLabel}</p>
      <p className="mt-3 text-3xl font-semibold text-slate-900">{egp(data.payroll.netSalary)}</p>
      <p className="text-sm text-slate-500">Net Pay</p>

      <div className="mt-5 space-y-2 rounded border border-slate-100 bg-slate-50/70 p-3">
        <div className="flex items-center justify-between text-sm"><span className="text-slate-500">Gross</span><span className="font-semibold text-slate-900">{egp(data.payroll.grossSalary)}</span></div>
        <div className="flex items-center justify-between text-sm"><span className="text-slate-500">Additions</span><span className="font-semibold text-emerald-600">{egp(data.payroll.totalAdditions)}</span></div>
        <div className="flex items-center justify-between text-sm"><span className="text-slate-500">Deductions</span><span className="font-semibold text-rose-600">{egp(data.payroll.totalDeductions)}</span></div>
      </div>

      <div className="mt-4 space-y-2">
        <div>
          <div className="mb-1 flex items-center justify-between text-xs text-slate-500"><span>Net Pay</span><span>{netRatio}%</span></div>
          <div className="h-2 rounded-sm bg-slate-100"><div className="h-2 rounded-sm bg-orange-500" style={{ width: `${netRatio}%` }} /></div>
        </div>
        <div>
          <div className="mb-1 flex items-center justify-between text-xs text-slate-500"><span>Additions</span><span>{additionsRatio}%</span></div>
          <div className="h-2 rounded-sm bg-slate-100"><div className="h-2 rounded-sm bg-emerald-500" style={{ width: `${additionsRatio}%` }} /></div>
        </div>
        <div>
          <div className="mb-1 flex items-center justify-between text-xs text-slate-500"><span>Deductions</span><span>{deductionsRatio}%</span></div>
          <div className="h-2 rounded-sm bg-slate-100"><div className="h-2 rounded-sm bg-rose-400" style={{ width: `${deductionsRatio}%` }} /></div>
        </div>
      </div>

      <div className="mt-4 rounded border border-slate-100 bg-white px-3 py-2 text-sm text-slate-700">
        Incentive = <span className="font-semibold text-slate-900">{additionsRatio}%</span> of your gross pay
      </div>
    </Card>
  );
}

export function PayrollPayslipsSection({ data }: { data: MedicalRepPortalData }) {
  const [isBreakdownVisible, setIsBreakdownVisible] = useState(false);
  const payrollMissing = data.empty.payroll;
  const latestStatus = data.payroll.latestBatchStatus?.replace(/_/g, " ") ?? "Unknown";
  const historyRows = [...data.payroll.payslipRows];
  const hasRows = historyRows.length > 0;
  const payslip = data.payroll.latestPayslip;
  const breakdownToggleLabel = isBreakdownVisible ? "Hide salary breakdown" : "Show salary breakdown";
  const breakdownRows = [
    {
      formula: "Net Salary - Extra Cost of Living - Fuel Allowance",
      label: "Base Salary",
      value: payslip.baseSalary,
    },
    {
      formula: "Base Salary + Extra Cost of Living + Fuel Allowance",
      label: "Net Salary",
      value: payslip.netSalary,
    },
    {
      formula: "Base Salary x 70%",
      label: "Basic Salary",
      value: payslip.basicSalary,
    },
    {
      formula: "Base Salary + Social Insurance + Income Tax",
      label: "Gross Salary",
      value: payslip.grossSalary,
    },
  ].sort((left, right) => left.value - right.value || left.label.localeCompare(right.label));

  return (
    <section id="payroll" className="space-y-4">
      {payrollMissing ? (
        <div className="rounded border border-slate-200 bg-white p-6 shadow-[0_8px_24px_rgba(15,23,42,0.05)]">
          <div className="flex flex-col gap-4 rounded border border-slate-100 bg-slate-50/70 p-6">
            <div className="mx-auto flex max-w-md flex-col items-center text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded bg-white text-slate-500 shadow">
                <MinusCircle className="h-5 w-5" />
              </div>
              <p className="mt-4 text-sm font-semibold text-slate-900">Payroll Unavailable</p>
              <p className="mt-1 text-sm text-slate-600">Payslip data has not been uploaded yet.</p>
              <Button className="mt-5 rounded" disabled variant="secondary">
                View Payslip
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="rounded border border-slate-200 bg-white p-4 shadow-[0_8px_24px_rgba(15,23,42,0.05)] sm:p-6">
            <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
              <div className="min-w-0 space-y-3">
                <p className="inline-flex w-fit items-center rounded border border-orange-100 bg-orange-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.14em] text-[#B45309]">
                  Payroll
                </p>
                <h2 className="text-[1.4rem] font-semibold leading-tight text-slate-900">
                  Payroll & Payslips
                </h2>
                <p className="text-sm leading-6 text-slate-600">
                  Track your latest compensation, review monthly earnings components, and open historical payslip files.
                </p>
              </div>
              <div className="flex flex-wrap gap-2 text-xs">
                <Badge className="h-7 px-3 py-1" variant="neutral">
                  Latest period {data.payroll.latestBatchLabel}
                </Badge>
                <Badge className="h-7 px-3 py-1" variant={payrollStatusTone(latestStatus)}>
                  {latestStatus}
                </Badge>
                {hasRows ? (
                  <Badge className="h-7 px-3 py-1" variant="neutral">
                    {historyRows.length} records
                  </Badge>
                ) : null}
              </div>
            </div>

            <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <PayrollStat label="Gross Salary" value={egp(payslip.grossSalary)} />
              <PayrollStat label="Net Salary" value={egp(payslip.netSalary)} />
              <PayrollStat label="Basic Salary" value={egp(payslip.basicSalary)} />
              <PayrollStat label="Base Salary" value={egp(payslip.baseSalary)} />
            </div>
          </div>

          <div className="grid gap-4 xl:grid-cols-[1.1fr_1.5fr]">
            <Card className="rounded border border-slate-200 bg-white p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-slate-900">Salary Breakdown</p>
                  <p className="mt-1 text-xs text-slate-500">
                    Fixed breakdown using the standard payroll salary policy.
                  </p>
                </div>
                <button
                  aria-label={breakdownToggleLabel}
                  aria-pressed={isBreakdownVisible}
                  className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded border border-slate-200 bg-white text-slate-500 shadow-sm transition hover:border-orange-200 hover:bg-orange-50 hover:text-orange-600 focus-visible:outline-2 focus-visible:outline-orange-500 focus-visible:outline-offset-1"
                  onClick={() => setIsBreakdownVisible((current) => !current)}
                  title={breakdownToggleLabel}
                  type="button"
                >
                  {isBreakdownVisible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>

              <div className="mt-4 divide-y divide-slate-100 rounded border border-slate-100">
                {breakdownRows.map((row) => (
                  <div className="grid gap-2 px-3 py-3 sm:grid-cols-[1fr_auto]" key={row.label}>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-slate-900">{row.label}</p>
                      <p className="mt-0.5 text-xs text-slate-500">{row.formula}</p>
                    </div>
                    <p className="font-mono text-sm font-semibold text-slate-900 tabular-nums">
                      {isBreakdownVisible ? egp(row.value) : "******"}
                    </p>
                  </div>
                ))}
              </div>
            </Card>

            <Card className="rounded border border-slate-200 bg-white p-4 sm:p-5">
              <div className="mb-3 flex items-center justify-between">
                <p className="text-sm font-semibold text-slate-900">Payslip History</p>
                <span className="rounded border border-slate-200 px-3 py-1 text-xs text-slate-500">
                  {historyRows.length} record{historyRows.length === 1 ? "" : "s"}
                </span>
              </div>
              {/* Mobile: premium card list (tables are desktop-only) */}
              <div className="max-h-[320px] space-y-2 overflow-y-auto md:hidden">
                {historyRows.length === 0 ? (
                  <p className="rounded border border-slate-100 bg-slate-50/60 px-3 py-6 text-center text-sm text-slate-500">
                    No payroll history records found yet.
                  </p>
                ) : (
                  historyRows.map((row) => (
                    <div
                      className="flex items-center justify-between gap-3 rounded border border-slate-100 bg-white px-3 py-2.5"
                      key={`m-${row.id}`}
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-slate-900">{row.label}</p>
                        <Badge
                          className="mt-1 whitespace-nowrap px-2 py-0.5 text-phx-2xs"
                          variant={payrollStatusTone(row.status)}
                        >
                          {row.status.replace(/_/g, " ")}
                        </Badge>
                      </div>
                      <Link className="shrink-0" href={`/api/payroll/${row.id}/payslips`} target="_blank">
                        <Button className="h-8 px-3 text-xs" variant="secondary">
                          View
                        </Button>
                      </Link>
                    </div>
                  ))
                )}
              </div>

              {/* Desktop: full table */}
              <div className="hidden max-h-[320px] overflow-y-auto overflow-x-hidden rounded border border-slate-100 md:block">
                <table className="w-full border-collapse table-fixed text-left text-xs sm:text-sm">
                  <colgroup>
                    <col className="w-[32%]" />
                    <col className="w-[34%]" />
                    <col className="w-[34%]" />
                  </colgroup>
                  <thead>
                    <tr>
                      <th className="border border-slate-100 bg-slate-50 px-2 py-2 text-phx-2xs font-bold uppercase tracking-[0.14em] text-slate-500 sm:px-3">Month</th>
                      <th className="border border-slate-100 bg-slate-50 px-2 py-2 text-phx-2xs font-bold uppercase tracking-[0.14em] text-slate-500 sm:px-3">Status</th>
                      <th className="border border-slate-100 bg-slate-50 px-2 py-2 text-right text-phx-2xs font-bold uppercase tracking-[0.14em] text-slate-500 sm:px-3">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {historyRows.length === 0 ? (
                      <tr>
                        <td className="border border-slate-100 px-3 py-6 text-center text-slate-500" colSpan={3}>
                          No payroll history records found yet.
                        </td>
                      </tr>
                    ) : (
                      historyRows.map((row) => (
                        <tr className="transition hover:bg-slate-50/60" key={row.id}>
                          <td className="border border-slate-100 px-2 py-2.5 font-medium text-slate-900 sm:px-3">{row.label}</td>
                          <td className="border border-slate-100 px-2 py-2.5 sm:px-3">
                            <Badge className="max-w-full whitespace-nowrap px-2 py-0.5 text-phx-2xs sm:px-2.5 sm:text-xs" variant={payrollStatusTone(row.status)}>
                              {row.status.replace(/_/g, " ")}
                            </Badge>
                          </td>
                          <td className="border border-slate-100 px-2 py-2.5 text-right sm:px-3">
                            <Link href={`/api/payroll/${row.id}/payslips`} target="_blank">
                              <Button className="h-8 max-w-full px-2 text-phx-xs sm:px-3 sm:text-xs" variant="secondary">
                                <span className="sm:hidden">View</span>
                                <span className="hidden sm:inline">View payslip</span>
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
        </div>
      )}
    </section>
  );
}
