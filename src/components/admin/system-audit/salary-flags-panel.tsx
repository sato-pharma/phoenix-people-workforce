"use client";

import { humanizeCode } from "@/lib/format/code-label";
import { CheckCircle2, Loader2 } from "lucide-react";
import { useState } from "react";

import { AdminInsightChip, AdminTableShell } from "@/components/admin/admin-design-system";
import { CheckTile } from "@/components/ui/form-kit";
import { phxButtonApproveDenseClassName, phxButtonGhostClassName } from "@/components/ui/form-tokens";
import type { SalaryFlag, SalaryFlagsResult } from "@/lib/admin/service";
import { cairoDateTime } from "@/lib/format/cairo-datetime";
import { cn } from "@/lib/utils";

/**
 * Salary flags on the System Audit page — moved here from the retired /admin/data-health page on
 * 23 Oct 2026, with two faults fixed: the list is never cut at a row limit (it stopped at 500
 * without saying so), and resolving a flag keeps whichever list the "Show resolved" toggle is on
 * (it used to reload the unresolved list and leave the toggle ticked over the wrong rows).
 *
 * Data comes in as props (loaded on the server by `getSalaryFlags(false, { withNames: true })`);
 * the toggle and the Resolve button talk to /api/admin/salary-flags.
 */

const PAGE_SIZE = 25;

function flagTypeLabel(value: string | null) {
  if (!value) return "Unspecified";
  return humanizeCode(value);
}

function severityLabel(value: string | null) {
  if (!value) return "Not set";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function severityTone(value: string | null) {
  if (value === "high") return "text-rose-700";
  if (value === "medium") return "text-amber-700";
  return "text-slate-600";
}

function EmployeeCell({ flag }: { flag: SalaryFlag }) {
  if (flag.employeeName) {
    return <p className="break-words text-sm font-bold text-slate-950">{flag.employeeName}</p>;
  }
  return (
    <p className="break-words text-sm font-semibold text-slate-600">
      {flag.hrId ? "Not found in the employee directory" : "No employee linked"}
    </p>
  );
}

function ResolveCell({
  flag,
  onResolve,
  resolving,
}: {
  flag: SalaryFlag;
  onResolve: (id: string) => void;
  resolving: boolean;
}) {
  if (flag.resolvedAt) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-700">
        <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
        Resolved {cairoDateTime(flag.resolvedAt)}
      </span>
    );
  }
  return (
    <button
      className={cn("inline-flex h-8 items-center gap-1.5 border px-3 text-xs font-bold transition disabled:opacity-50", phxButtonApproveDenseClassName)}
      disabled={resolving}
      onClick={() => onResolve(flag.id)}
      type="button"
    >
      {resolving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
      Resolve
    </button>
  );
}

export function SalaryFlagsPanel({
  initialFlags,
  loadError = null,
}: {
  initialFlags: SalaryFlagsResult | null;
  loadError?: string | null;
}) {
  const [data, setData] = useState<SalaryFlagsResult | null>(initialFlags);
  const [showResolved, setShowResolved] = useState(false);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(loadError);
  const [page, setPage] = useState(1);

  const flags = data?.flags ?? [];
  const pageCount = Math.max(1, Math.ceil(flags.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const visible = flags.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  async function readError(response: Response, fallback: string) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    return body?.message ?? fallback;
  }

  async function handleToggle(next: boolean) {
    setShowResolved(next);
    setPage(1);
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/admin/salary-flags?showResolved=${next}`, { cache: "no-store" });
      if (!response.ok) throw new Error(await readError(response, "Salary flags could not be loaded."));
      setData((await response.json()) as SalaryFlagsResult);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Salary flags could not be loaded.");
    } finally {
      setLoading(false);
    }
  }

  async function handleResolve(id: string) {
    setResolvingId(id);
    setError(null);
    try {
      const response = await fetch("/api/admin/salary-flags", {
        body: JSON.stringify({ id, showResolved }),
        headers: { "Content-Type": "application/json" },
        method: "PATCH",
      });
      if (!response.ok) throw new Error(await readError(response, "The flag could not be resolved."));
      setData((await response.json()) as SalaryFlagsResult);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The flag could not be resolved.");
    } finally {
      setResolvingId(null);
    }
  }

  const unresolvedChip = data
    ? `${data.unresolvedCount} unresolved`
    : "Unresolved count unavailable";

  return (
    <section className="@container" id="salary-flags">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex items-start gap-3">
          <span aria-hidden="true" className="mt-1 h-9 w-1.5 shrink-0 bg-gradient-to-b from-orange-500 to-amber-400" />
          <div>
            <p className="text-phx-xs font-bold uppercase tracking-[0.22em] text-orange-600">Payroll anomalies</p>
            <h2 className="mt-1 text-xl font-bold tracking-[-0.025em] text-slate-950">Salary flags</h2>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <AdminInsightChip tone={data && data.unresolvedCount > 0 ? "orange" : data ? "emerald" : "slate"}>
            {unresolvedChip}
          </AdminInsightChip>
          <CheckTile checked={showResolved} onChange={(next) => void handleToggle(next)}>
            <span className="text-sm font-semibold text-slate-700">Show resolved</span>
          </CheckTile>
        </div>
      </div>

      <AdminTableShell
        description={
          showResolved
            ? "Every salary flag, newest first, resolved ones included. Times are Cairo."
            : "Every unresolved salary flag, newest first. Times are Cairo."
        }
        title={showResolved ? "All salary flags" : "Unresolved salary flags"}
      >
        {error ? (
          <p className="border-b border-rose-200 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-800" role="alert">
            {error}
          </p>
        ) : null}
        {loading ? (
          <p className="flex items-center gap-2 px-4 py-6 text-sm text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading salary flags
          </p>
        ) : !data ? (
          <p className="px-4 py-6 text-sm font-semibold text-slate-600">Unavailable — the salary flags could not be read.</p>
        ) : flags.length === 0 ? (
          <p className="px-4 py-6 text-sm text-slate-500">
            {showResolved ? "No salary flag has ever been raised." : "No unresolved salary flags."}
          </p>
        ) : (
          <>
            <table className="hidden w-full table-fixed text-left @min-[820px]:table">
              <colgroup>
                <col className="w-[22%]" />
                <col className="w-[20%]" />
                <col className="w-[25%]" />
                <col className="w-[16%]" />
                <col className="w-[17%]" />
              </colgroup>
              <thead className="bg-slate-50 text-phx-xs font-bold uppercase tracking-[0.16em] text-slate-500">
                <tr>
                  <th className="px-4 py-3">Employee</th>
                  <th className="px-4 py-3">Flag</th>
                  <th className="px-4 py-3">Message</th>
                  <th className="px-4 py-3">Raised</th>
                  <th className="px-4 py-3">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {visible.map((flag) => (
                  <tr className="align-top" key={flag.id}>
                    <td className="px-4 py-3"><EmployeeCell flag={flag} /></td>
                    <td className="px-4 py-3">
                      <p className="break-words text-sm font-semibold text-slate-800">{flagTypeLabel(flag.flagType)}</p>
                      <p className={cn("mt-0.5 text-xs font-bold", severityTone(flag.severity))}>
                        {severityLabel(flag.severity)} severity
                      </p>
                    </td>
                    <td className="px-4 py-3 text-sm leading-relaxed text-slate-700">
                      <p className="whitespace-pre-wrap break-words">{flag.message ?? "No message recorded"}</p>
                    </td>
                    <td className="px-4 py-3 text-xs font-semibold text-slate-600">{cairoDateTime(flag.createdAt)}</td>
                    <td className="px-4 py-3">
                      <ResolveCell flag={flag} onResolve={(id) => void handleResolve(id)} resolving={resolvingId === flag.id} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <ul className="divide-y divide-slate-200 @min-[820px]:hidden">
              {visible.map((flag) => (
                <li className="space-y-2 px-4 py-3" key={flag.id}>
                  <EmployeeCell flag={flag} />
                  <p className="text-sm font-semibold text-slate-800">
                    {flagTypeLabel(flag.flagType)}
                    <span className={cn("ml-2 text-xs font-bold", severityTone(flag.severity))}>
                      {severityLabel(flag.severity)} severity
                    </span>
                  </p>
                  <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-700">
                    {flag.message ?? "No message recorded"}
                  </p>
                  <p className="text-xs font-semibold text-slate-500">Raised {cairoDateTime(flag.createdAt)}</p>
                  <ResolveCell flag={flag} onResolve={(id) => void handleResolve(id)} resolving={resolvingId === flag.id} />
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-4 py-3">
              <p className="text-xs font-semibold text-slate-500">
                Showing {(currentPage - 1) * PAGE_SIZE + 1}–{Math.min(currentPage * PAGE_SIZE, flags.length)} of {flags.length}
              </p>
              {pageCount > 1 ? (
                <div className="flex items-center gap-2">
                  <button
                    className={phxButtonGhostClassName}
                    disabled={currentPage <= 1}
                    onClick={() => setPage(currentPage - 1)}
                    type="button"
                  >
                    Previous
                  </button>
                  <span className="text-xs font-semibold text-slate-600">
                    Page {currentPage} of {pageCount}
                  </span>
                  <button
                    className={phxButtonGhostClassName}
                    disabled={currentPage >= pageCount}
                    onClick={() => setPage(currentPage + 1)}
                    type="button"
                  >
                    Next
                  </button>
                </div>
              ) : null}
            </div>
          </>
        )}
      </AdminTableShell>
    </section>
  );
}
