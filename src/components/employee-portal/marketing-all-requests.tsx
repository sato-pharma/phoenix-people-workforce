"use client";

import { useEffect, useMemo, useState } from "react";
import { Download, RefreshCcw } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  PortalDesktopTable,
  PortalEmptyState,
  PortalMetricCard,
  PortalPagination,
  PortalRecordCard,
  PortalRecordFields,
  PortalResponsiveDataList,
  PortalSection,
} from "@/components/employee-portal/portal-primitives";
import { LoadingSpinner } from "@/components/ui/loading-state";
import type {
  MarketingAllRequestsRow,
  MarketingAllRequestsWorkspace,
} from "@/lib/marketing-requests/types";
import { forecastRoiStatusLabel, marketingRequestStatusLabel } from "@/lib/marketing-requests/roi-labels";
import { formatStableEnGb } from "@/lib/format/cairo-datetime";
import { adminControlDepthClassName } from "@/components/admin/admin-design-tokens";

const PAGE_SIZE = 25;

function emptyWorkspace(): MarketingAllRequestsWorkspace {
  return {
    rows: [],
    summary: { approved: 0, imported: 0, inApproval: 0, phoenix: 0, returned: 0, total: 0 },
  };
}

function statusVariant(status: MarketingAllRequestsRow["status"]): "success" | "warning" | "danger" | "neutral" {
  if (status === "approved" || status === "active" || status === "roi_tracking" || status === "closed") return "success";
  if (status === "rejected") return "danger";
  if (status === "pending_approval" || status === "returned" || status === "finance_hold") return "warning";
  return "neutral";
}

function statusLabel(status: MarketingAllRequestsRow["status"]) {
  return marketingRequestStatusLabel(status);
}

/**
 * "Amr Elsabey — NSM Approval (step 1 of 4)".
 *
 * The whole point of the register: a request that is stopped must say WHERE and WITH WHOM without
 * anyone opening it. A request with no chain yet (a draft) says so plainly rather than rendering
 * an empty cell, which would read as missing data.
 */
function trackingText(row: MarketingAllRequestsRow) {
  if (!row.currentStepName) return "Not submitted yet";
  const step = row.stepSequence && row.totalGatingSteps
    ? ` (step ${row.stepSequence} of ${row.totalGatingSteps})`
    : "";
  return `${row.currentApproverName || "Unassigned"} — ${row.currentStepName}${step}`;
}

function egp(value: number) {
  return `EGP ${Math.round(value).toLocaleString("en-US")}`;
}

function cairoDate(value: string | null) {
  if (!value) return "Not set";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Not set";
  return formatStableEnGb(parsed, {
    day: "2-digit",
    month: "short",
    timeZone: "Africa/Cairo",
    year: "numeric",
  });
}

function TextCell({ value }: { value: string | null | undefined }) {
  return <span className="text-slate-700">{value || "Not captured"}</span>;
}

function CodeCell({ value }: { value: string | null | undefined }) {
  return (
    <span className="bg-slate-100 px-2 py-1 font-mono text-xs font-bold text-slate-700">
      {value || "-"}
    </span>
  );
}

function RequestRowCard({ row }: { row: MarketingAllRequestsRow }) {
  return (
    <PortalRecordCard
      accent={row.status === "rejected" ? "rose" : row.status === "pending_approval" || row.status === "returned" ? "amber" : "emerald"}
      meta={<CodeCell value={row.requestCode} />}
      status={<Badge variant={statusVariant(row.status)}>{statusLabel(row.status)}</Badge>}
      title={row.customerName}
    >
      <PortalRecordFields
        fields={[
          { label: "Pending with", value: trackingText(row) },
          { label: "Requester", value: row.requesterName },
          { label: "Line", value: row.lineName || "Not captured" },
          { label: "Area", value: row.areaName || "Not captured" },
          { label: "Cost", value: egp(row.estimatedCost) },
          { label: "Pay date", value: cairoDate(row.payDate) },
        ]}
      />
    </PortalRecordCard>
  );
}

/**
 * Which half of the register is on screen.
 *
 * Defaults to "phoenix" because that is the live work. In production 217 of 218 rows are a June
 * spreadsheet import; showing them together buried the one real request under 217 dead ones.
 */
type RegisterScope = "phoenix" | "imported";

export function MarketingAllRequests() {
  const [workspace, setWorkspace] = useState<MarketingAllRequestsWorkspace>(emptyWorkspace);
  const [isLoading, setIsLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [scope, setScope] = useState<RegisterScope>("phoenix");

  async function loadWorkspace() {
    setIsLoading(true);
    setMessage(null);
    try {
      const response = await fetch("/api/marketing-requests/all", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) {
        setWorkspace(emptyWorkspace());
        setMessage(payload.message ?? "Unable to load the marketing request register.");
        return;
      }
      setWorkspace({
        rows: payload.rows ?? [],
        summary: payload.summary ?? emptyWorkspace().summary,
      });
      setPage(1);
    } catch {
      setWorkspace(emptyWorkspace());
      setMessage("Unable to load the marketing request register.");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void loadWorkspace();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, []);

  const scopedRows = useMemo(
    () => workspace.rows.filter((row) => (scope === "phoenix" ? row.isPhoenixSubmission : !row.isPhoenixSubmission)),
    [scope, workspace.rows],
  );
  const totalPages = Math.max(1, Math.ceil(scopedRows.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pagedRows = useMemo(
    () => scopedRows.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [safePage, scopedRows],
  );
  const pageLabel = scopedRows.length === 0
    ? "0 requests"
    : `${(safePage - 1) * PAGE_SIZE + 1}-${Math.min(safePage * PAGE_SIZE, scopedRows.length)} of ${scopedRows.length} requests`;

  function selectScope(next: RegisterScope) {
    setScope(next);
    setPage(1);
  }

  return (
    <div className="space-y-6">
      <PortalSection className="p-4 sm:p-5">
        <div className="grid gap-3 md:grid-cols-5">
          {/* Counts describe the Phoenix side only — see the summary comment in the service. */}
          <PortalMetricCard label="Submitted on Phoenix" value={workspace.summary.phoenix} />
          <PortalMetricCard accent="amber" label="In approval" value={workspace.summary.inApproval} />
          <PortalMetricCard accent="rose" label="Returned" value={workspace.summary.returned} />
          <PortalMetricCard accent="emerald" label="Approved" value={workspace.summary.approved} />
          <button
            className="flex min-h-[78px] items-center justify-center gap-2 rounded border border-slate-200 bg-white px-4 py-3 text-sm font-black text-slate-700 shadow-sm transition hover:border-orange-200 hover:bg-orange-50 hover:text-orange-700"
            onClick={() => void loadWorkspace()}
            type="button"
          >
            {isLoading ? <LoadingSpinner /> : <RefreshCcw className="h-4 w-4" />}
            Refresh
          </button>
        </div>
      </PortalSection>

      {message ? (
        <div className="rounded border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-900">
          {message}
        </div>
      ) : null}

      {/* Archived/imported is kept behind its own switch rather than mixed in — owner instruction
          2026-08-03. Both counts stay visible so the archive is never hidden, only separated. */}
      <div className="flex flex-wrap gap-2">
        <button
          className={`rounded border px-3.5 py-2 text-xs font-black transition ${
            scope === "phoenix"
              ? "border-orange-300 bg-orange-50 text-orange-800"
              : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
          }`}
          onClick={() => selectScope("phoenix")}
          type="button"
        >
          Submitted on Phoenix ({workspace.summary.phoenix})
        </button>
        <button
          className={`rounded border px-3.5 py-2 text-xs font-black transition ${
            scope === "imported"
              ? "border-orange-300 bg-orange-50 text-orange-800"
              : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
          }`}
          onClick={() => selectScope("imported")}
          type="button"
        >
          Archived / imported ({workspace.summary.imported})
        </button>
        {/* `download` is load-bearing, not decoration: the target is an API route that streams an
            .xlsx, and without it the @next/next/no-html-link-for-pages rule demands a <Link> that
            would hand a binary attachment to the client router. A plain GET also means a slow
            workbook never strands a spinner on screen. Server-side permission is enforced in the
            loader — this control is UX only. */}
        <a
          className={`ml-auto inline-flex items-center gap-2 rounded border border-slate-200 bg-white px-3.5 py-2 text-xs font-black text-slate-700 transition hover:border-orange-200 hover:bg-orange-50 hover:text-orange-700 ${adminControlDepthClassName}`}
          download
          href="/api/marketing-requests/report/export"
        >
          <Download className="h-3.5 w-3.5" />
          Download full report
        </a>
      </div>

      <PortalSection
        actions={<Badge variant="neutral">{scopedRows.length} requests</Badge>}
        eyebrow="Marketing Requests"
        title={
          scope === "phoenix"
            ? "Requests raised on Phoenix, and where each one is stopped"
            : "Archived requests loaded from the legacy spreadsheet import"
        }
      >
        <PortalResponsiveDataList
          breakpoint="lg"
          empty={
            !isLoading ? (
              <PortalEmptyState
                message={
                  scope === "phoenix"
                    ? "Every marketing request raised on Phoenix will appear here, with the step it is waiting on."
                    : "Requests loaded from the legacy spreadsheet import will appear here."
                }
                title={scope === "phoenix" ? "No Phoenix requests yet" : "No archived requests"}
              />
            ) : (
              <div className="px-4 py-8 text-center text-sm font-semibold text-slate-500">
                <span className="inline-flex items-center gap-2"><LoadingSpinner /> Loading marketing requests...</span>
              </div>
            )
          }
          getKey={(row) => row.id}
          items={pagedRows}
          renderCard={(row) => <RequestRowCard row={row} />}
          renderTable={() => (
            <PortalDesktopTable
              breakpoint="lg"
              cols={
                <colgroup>
                  <col className="w-[9%]" />
                  <col className="w-[8%]" />
                  <col className="w-[13%]" />
                  <col className="w-[11%]" />
                  <col className="w-[11%]" />
                  <col className="w-[8%]" />
                  <col className="w-[8%]" />
                  <col className="w-[8%]" />
                  <col className="w-[8%]" />
                  <col className="w-[8%]" />
                  <col className="w-[8%]" />
                </colgroup>
              }
            >
              <thead className="bg-slate-50 text-phx-xs font-black uppercase tracking-[0.12em] text-slate-500">
                <tr>
                  <th className="px-4 py-3">Request Code</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Pending With</th>
                  <th className="px-4 py-3">Customer</th>
                  <th className="px-4 py-3">Requester</th>
                  <th className="px-4 py-3">Line</th>
                  <th className="px-4 py-3">Area</th>
                  <th className="px-4 py-3">Estimated Cost</th>
                  <th className="px-4 py-3">Pay Date</th>
                  <th className="px-4 py-3">Submitted</th>
                  <th className="px-4 py-3">ROI Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {pagedRows.map((row: MarketingAllRequestsRow) => (
                  <tr className="text-sm font-semibold" key={row.id}>
                    <td className="px-4 py-3"><CodeCell value={row.requestCode} /></td>
                    <td className="px-4 py-3">
                      <Badge variant={statusVariant(row.status)}>{statusLabel(row.status)}</Badge>
                    </td>
                    <td className="px-4 py-3 text-slate-900">{trackingText(row)}</td>
                    <td className="px-4 py-3"><TextCell value={row.customerName} /></td>
                    <td className="px-4 py-3"><TextCell value={row.requesterName} /></td>
                    <td className="px-4 py-3"><TextCell value={row.lineName} /></td>
                    <td className="px-4 py-3"><TextCell value={row.areaName} /></td>
                    <td className="px-4 py-3 text-slate-900">{egp(row.estimatedCost)}</td>
                    <td className="px-4 py-3"><TextCell value={cairoDate(row.payDate)} /></td>
                    <td className="px-4 py-3"><TextCell value={cairoDate(row.submittedAt)} /></td>
                    <td className="px-4 py-3">
                      <TextCell value={row.roiStatus ? forecastRoiStatusLabel(row.roiStatus) : null} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </PortalDesktopTable>
          )}
        />
        <PortalPagination label={pageLabel}>
          <button
            className={`rounded border border-slate-200 bg-white px-3 py-1.5 text-xs font-black text-slate-600 disabled:opacity-40 disabled:shadow-none ${adminControlDepthClassName}`}
            disabled={safePage <= 1}
            onClick={() => setPage((current) => Math.max(1, current - 1))}
            type="button"
          >
            Previous
          </button>
          <button
            className={`rounded border border-slate-200 bg-white px-3 py-1.5 text-xs font-black text-slate-600 disabled:opacity-40 disabled:shadow-none ${adminControlDepthClassName}`}
            disabled={safePage >= totalPages}
            onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
            type="button"
          >
            Next
          </button>
        </PortalPagination>
      </PortalSection>
    </div>
  );
}
