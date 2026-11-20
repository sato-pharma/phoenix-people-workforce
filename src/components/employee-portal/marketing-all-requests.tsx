"use client";

import { useEffect, useMemo, useState } from "react";
import { Download, RefreshCcw } from "lucide-react";

import {
  LANDING_INK,
  LandingMeta,
  landingActionClassName,
} from "@/components/employee-portal/landing-kit";
import {
  PortalDesktopTable,
  PortalEmptyState,
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
import { formatStableCurrency } from "@/lib/format/stable-currency";
import { adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";

const PAGE_SIZE = 25;

function emptyWorkspace(): MarketingAllRequestsWorkspace {
  return {
    rows: [],
    summary: { approved: 0, imported: 0, inApproval: 0, phoenix: 0, returned: 0, total: 0 },
  };
}

/**
 * The status's tone as coloured small text — never a filled pill (the landing kit). Whole literals,
 * so Tailwind ships every one.
 */
function statusTextClass(status: MarketingAllRequestsRow["status"]): string {
  if (status === "approved" || status === "active" || status === "roi_tracking" || status === "closed") return "text-emerald-700";
  if (status === "rejected") return "text-rose-700";
  if (status === "pending_approval" || status === "returned" || status === "finance_hold") return "text-amber-700";
  return "text-slate-500";
}

function statusLabel(status: MarketingAllRequestsRow["status"]) {
  return marketingRequestStatusLabel(status);
}

/** The status in its colour, in small capitals. */
function StatusMark({ status }: { status: MarketingAllRequestsRow["status"] }) {
  return (
    <span className={`break-words text-phx-xs font-bold uppercase tracking-[0.08em] ${statusTextClass(status)}`}>
      {statusLabel(status)}
    </span>
  );
}

/** One figure of the register's strip: a small-capital label over the number in its tone. */
function RegisterFigure({ label, tone = LANDING_INK, value }: { label: string; tone?: string; value: number }) {
  return (
    <div className="min-w-0 border-b border-r border-slate-200 bg-white px-3 py-2.5 sm:px-4">
      <p className="break-words text-phx-xs font-bold uppercase tracking-[0.1em] text-slate-500">{label}</p>
      <p className={`mt-1 text-[22px] font-bold leading-none tracking-[-0.02em] tabular-nums ${tone}`}>{value}</p>
    </div>
  );
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
  return `EGP ${formatStableCurrency(Math.round(value), "en-US", { maximumFractionDigits: 0 })}`;
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
  return <span className={value ? "text-slate-700" : "text-slate-500"} dir="auto">{value || "Not captured"}</span>;
}

/** The request code as plain monospace — never a tinted chip. */
function CodeCell({ value }: { value: string | null | undefined }) {
  return <span className="break-all font-mono text-phx-xs font-bold text-slate-600">{value || "-"}</span>;
}

function RequestRowCard({ row }: { row: MarketingAllRequestsRow }) {
  return (
    <PortalRecordCard
      accent={row.status === "rejected" ? "rose" : row.status === "pending_approval" || row.status === "returned" ? "amber" : "emerald"}
      meta={<CodeCell value={row.requestCode} />}
      status={<StatusMark status={row.status} />}
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
      {/* The four counts on hairlines in one white panel, Refresh in the last cell — never a tile on
          a panel. The cells draw their own right/bottom hairlines and the grid is pulled 1px under
          the clipped frame, so the wrap at two columns leaves white, not a grey hole. */}
      <section className={`@container min-w-0 overflow-hidden border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
        <div className="-mb-px -mr-px grid grid-cols-2 @3xl:grid-cols-5">
          {/* Counts describe the Phoenix side only — see the summary comment in the service. */}
          <RegisterFigure label="Submitted on Phoenix" value={workspace.summary.phoenix} />
          <RegisterFigure label="In approval" tone="text-amber-700" value={workspace.summary.inApproval} />
          <RegisterFigure label="Returned" tone="text-rose-700" value={workspace.summary.returned} />
          <RegisterFigure label="Approved" tone="text-emerald-700" value={workspace.summary.approved} />
          <div className="flex min-w-0 items-center border-b border-r border-slate-200 bg-white px-3 py-2.5 sm:px-4">
            <button
              className={landingActionClassName("outline", "w-full")}
              onClick={() => void loadWorkspace()}
              type="button"
            >
              {isLoading ? (
                <LoadingSpinner className="h-3.5 w-3.5 text-current" />
              ) : (
                <RefreshCcw aria-hidden="true" className="h-3.5 w-3.5" />
              )}
              Refresh
            </button>
          </div>
        </div>
      </section>

      {message ? (
        <div className={`flex min-w-0 gap-3 border border-slate-200 bg-white px-3 py-2.5 sm:px-4 ${adminSoftDepthClassName}`} role="alert">
          <span aria-hidden="true" className="w-1 shrink-0 self-stretch bg-amber-400" />
          <p className="min-w-0 break-words text-phx-sm font-semibold text-slate-700">{message}</p>
        </div>
      ) : null}

      {/* Archived/imported is kept behind its own switch rather than mixed in — owner instruction
          2026-08-03. Both counts stay visible so the archive is never hidden, only separated. */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          aria-pressed={scope === "phoenix"}
          className={landingActionClassName(scope === "phoenix" ? "solid" : "outline")}
          onClick={() => selectScope("phoenix")}
          type="button"
        >
          Submitted on Phoenix ({workspace.summary.phoenix})
        </button>
        <button
          aria-pressed={scope === "imported"}
          className={landingActionClassName(scope === "imported" ? "solid" : "outline")}
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
          className={landingActionClassName("outline", "bg-white sm:ml-auto")}
          download
          href="/api/marketing-requests/report/export"
        >
          <Download aria-hidden="true" className="h-3.5 w-3.5" />
          Download full report
        </a>
      </div>

      <PortalSection
        actions={<LandingMeta items={[`${scopedRows.length} requests`]} />}
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
              <div aria-busy="true" className="px-3 py-5 text-phx-sm font-semibold text-slate-500 sm:px-4">
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
              <thead className="border-b border-slate-200 text-left text-phx-xs font-bold uppercase tracking-[0.1em] text-slate-500">
                <tr>
                  <th className="break-words px-3 py-2.5" scope="col">Request Code</th>
                  <th className="break-words px-3 py-2.5" scope="col">Status</th>
                  <th className="break-words px-3 py-2.5" scope="col">Pending With</th>
                  <th className="break-words px-3 py-2.5" scope="col">Customer</th>
                  <th className="break-words px-3 py-2.5" scope="col">Requester</th>
                  <th className="break-words px-3 py-2.5" scope="col">Line</th>
                  <th className="break-words px-3 py-2.5" scope="col">Area</th>
                  <th className="break-words px-3 py-2.5" scope="col">Estimated Cost</th>
                  <th className="break-words px-3 py-2.5" scope="col">Pay Date</th>
                  <th className="break-words px-3 py-2.5" scope="col">Submitted</th>
                  <th className="break-words px-3 py-2.5" scope="col">ROI Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 bg-white">
                {pagedRows.map((row: MarketingAllRequestsRow) => (
                  <tr className="align-top text-phx-sm font-semibold transition-colors hover:bg-slate-50 motion-reduce:transition-none" key={row.id}>
                    <td className="min-w-0 px-3 py-2.5"><CodeCell value={row.requestCode} /></td>
                    <td className="min-w-0 px-3 py-2.5">
                      <StatusMark status={row.status} />
                    </td>
                    <td className={`min-w-0 break-words px-3 py-2.5 ${LANDING_INK}`}>{trackingText(row)}</td>
                    <td className="min-w-0 break-words px-3 py-2.5"><TextCell value={row.customerName} /></td>
                    <td className="min-w-0 break-words px-3 py-2.5"><TextCell value={row.requesterName} /></td>
                    <td className="min-w-0 break-words px-3 py-2.5"><TextCell value={row.lineName} /></td>
                    <td className="min-w-0 break-words px-3 py-2.5"><TextCell value={row.areaName} /></td>
                    <td className={`min-w-0 break-words px-3 py-2.5 font-bold tabular-nums ${LANDING_INK}`}>{egp(row.estimatedCost)}</td>
                    <td className="min-w-0 break-words px-3 py-2.5 tabular-nums"><TextCell value={cairoDate(row.payDate)} /></td>
                    <td className="min-w-0 break-words px-3 py-2.5 tabular-nums"><TextCell value={cairoDate(row.submittedAt)} /></td>
                    <td className="min-w-0 break-words px-3 py-2.5">
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
            className={landingActionClassName("outline", "disabled:opacity-40")}
            disabled={safePage <= 1}
            onClick={() => setPage((current) => Math.max(1, current - 1))}
            type="button"
          >
            Previous
          </button>
          <button
            className={landingActionClassName("outline", "disabled:opacity-40")}
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
