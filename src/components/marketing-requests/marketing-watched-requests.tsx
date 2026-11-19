"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { CheckCircle2, Eye, History, MessageSquareText, Search, Undo2, XCircle } from "lucide-react";

import { egp, formatDate } from "@/components/employee-portal/marketing-approval-chain";
import {
  PortalDesktopTable,
  PortalMetricCard,
  PortalRecordCard,
  PortalResponsiveDataList,
} from "@/components/employee-portal/portal-primitives";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { adminControlDepthClassName, adminPanelDepthClassName } from "@/components/admin/admin-design-tokens";
import type {
  MarketingApproverHistoryOutcome,
  MarketingWatchedRequestRow,
  MarketingWatchedRequestsWorkspace,
} from "@/lib/marketing-requests/service";

/**
 * The watched-products list (owner, 2026-11-19) — every marketing request for the products this
 * viewer follows by name, newest first, history included. Read-only: each row opens the request's
 * Case File, which holds the full approval trail and the conversation he comments in. There is no
 * decision control here or there, because a watcher holds no rung.
 */

type OutcomeFilter = "all" | "in_flight" | "approved" | "returned" | "rejected" | "ended";

const OUTCOME_FILTERS: ReadonlyArray<{ key: OutcomeFilter; label: string }> = [
  { key: "all", label: "All" },
  { key: "in_flight", label: "In approval" },
  { key: "approved", label: "Approved" },
  { key: "returned", label: "Returned" },
  { key: "rejected", label: "Rejected" },
  { key: "ended", label: "Closed or cancelled" },
];

const OUTCOME_VARIANT: Record<MarketingApproverHistoryOutcome, "neutral" | "success" | "warning" | "danger"> = {
  approved: "success",
  archived: "neutral",
  awaiting_next_stage: "warning",
  cancelled: "danger",
  closed: "neutral",
  in_flight: "warning",
  rejected: "danger",
  returned: "warning",
};

function matchesOutcome(row: MarketingWatchedRequestRow, filter: OutcomeFilter): boolean {
  if (filter === "all") return true;
  if (filter === "ended") return row.outcome === "closed" || row.outcome === "cancelled" || row.outcome === "archived";
  return row.outcome === filter;
}

function caseFileHref(row: MarketingWatchedRequestRow): string {
  return `/marketing-requests/${encodeURIComponent(row.id)}`;
}

function filterButtonClassName(active: boolean): string {
  return active
    ? "min-h-9 border border-slate-900 bg-slate-900 px-3 text-phx-sm font-bold text-white"
    : `min-h-9 border border-slate-200 bg-white px-3 text-phx-sm font-bold text-slate-600 hover:border-orange-200 hover:text-orange-700 ${adminControlDepthClassName}`;
}

function OpenRecordLink({ row }: { row: MarketingWatchedRequestRow }) {
  return (
    <Link
      className={`inline-flex min-h-9 items-center gap-1.5 border border-slate-300 bg-white px-3 text-phx-sm font-bold text-slate-700 transition hover:border-orange-200 hover:bg-orange-50 hover:text-orange-700 ${adminControlDepthClassName}`}
      href={caseFileHref(row)}
    >
      <Eye className="h-3.5 w-3.5 shrink-0" />
      Open and comment
    </Link>
  );
}

function WhereItIs({ row }: { row: MarketingWatchedRequestRow }) {
  return (
    <div className="min-w-0 space-y-1">
      <Badge variant={OUTCOME_VARIANT[row.outcome]}>{row.outcomeLabel}</Badge>
      {row.waitingFor ? (
        <span className="block break-words text-phx-xs font-semibold text-slate-600">With {row.waitingFor}</span>
      ) : null}
    </div>
  );
}

export function MarketingWatchedRequests({ workspace }: { workspace: MarketingWatchedRequestsWorkspace }) {
  const [product, setProduct] = useState<string>("all");
  const [outcome, setOutcome] = useState<OutcomeFilter>("all");
  const [search, setSearch] = useState("");

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return workspace.rows.filter((row) => {
      if (product !== "all" && !row.productNames.includes(product)) return false;
      if (!matchesOutcome(row, outcome)) return false;
      if (!needle) return true;
      return [row.requestCode, row.requestTitle, row.customerName, row.requesterName]
        .some((value) => value.toLowerCase().includes(needle));
    });
  }, [outcome, product, search, workspace.rows]);

  const { summary } = workspace;
  const productsLabel = workspace.productNames.join(" and ") || "your products";

  return (
    <div className="space-y-4">
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-5">
        <PortalMetricCard accent="slate" icon={History} label="All requests" note={`Every ${productsLabel} request`} value={summary.total} />
        <PortalMetricCard accent="amber" icon={MessageSquareText} label="In approval" value={summary.inApproval} />
        <PortalMetricCard accent="emerald" icon={CheckCircle2} label="Approved" value={summary.approved} />
        <PortalMetricCard accent="sky" icon={Undo2} label="Returned" value={summary.returned} />
        <PortalMetricCard accent="rose" icon={XCircle} label="Rejected" value={summary.rejected} />
      </div>

      <Card className={`border border-slate-200 bg-white p-0 ${adminPanelDepthClassName}`}>
        <div className="space-y-3 border-b border-slate-100 px-4 py-3">
          <p className="text-phx-sm font-medium leading-snug text-slate-600">
            You follow {productsLabel}. You are told every time one of these requests moves and every time someone
            comments on it. Open a request to read its full approval trail and to comment — you hold no approval
            step on them, so there is nothing to approve or reject.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {workspace.productNames.length > 1 ? (
              <div className="flex flex-wrap gap-2" role="group" aria-label="Product">
                <button className={filterButtonClassName(product === "all")} onClick={() => setProduct("all")} type="button">
                  All products
                </button>
                {workspace.productNames.map((name) => (
                  <button className={filterButtonClassName(product === name)} key={name} onClick={() => setProduct(name)} type="button">
                    {name}
                  </button>
                ))}
              </div>
            ) : null}
            <div className="flex flex-wrap gap-2" role="group" aria-label="Status">
              {OUTCOME_FILTERS.map((filter) => (
                <button className={filterButtonClassName(outcome === filter.key)} key={filter.key} onClick={() => setOutcome(filter.key)} type="button">
                  {filter.label}
                </button>
              ))}
            </div>
          </div>
          <label className={`flex min-h-10 w-full items-center gap-2 border border-slate-200 bg-white px-3 sm:max-w-sm ${adminControlDepthClassName}`}>
            <Search className="h-4 w-4 shrink-0 text-slate-400" />
            <input
              aria-label="Search requests"
              className="min-w-0 flex-1 bg-transparent text-phx-md font-medium text-slate-800 outline-none placeholder:text-slate-400"
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Request, customer or requester"
              type="search"
              value={search}
            />
          </label>
        </div>

        <PortalResponsiveDataList
          empty={
            <p className="px-4 py-8 text-center text-phx-md font-medium text-slate-500">
              {workspace.rows.length === 0 ? `No marketing request has been raised for ${productsLabel} yet.` : "No request matches these filters."}
            </p>
          }
          getKey={(row) => row.id}
          items={rows}
          renderCard={(row) => (
            <PortalRecordCard
              actions={<OpenRecordLink row={row} />}
              meta={`${row.requestCode} · ${formatDate(row.raisedAt)}`}
              status={<WhereItIs row={row} />}
              title={row.requestTitle}
            >
              <div className="grid grid-cols-2 gap-2 text-phx-sm">
                <div className="min-w-0">
                  <span className="block text-phx-xs font-bold uppercase tracking-[0.12em] text-slate-400">Customer</span>
                  <span className="block break-words font-semibold text-slate-700">{row.customerName}</span>
                </div>
                <div className="min-w-0">
                  <span className="block text-phx-xs font-bold uppercase tracking-[0.12em] text-slate-400">Estimated cost</span>
                  <span className="block font-black text-slate-950">{egp(row.estimatedCost)}</span>
                </div>
                <div className="col-span-2 min-w-0">
                  <span className="block text-phx-xs font-bold uppercase tracking-[0.12em] text-slate-400">Products</span>
                  <span className="block break-words font-semibold text-slate-700">{row.productNames.join(", ")}</span>
                </div>
              </div>
            </PortalRecordCard>
          )}
          renderTable={() => (
            <PortalDesktopTable
              cols={
                <colgroup>
                  <col className="w-[30%]" />
                  <col className="w-[16%]" />
                  <col className="w-[22%]" />
                  <col className="w-[11%]" />
                  <col className="w-[9%]" />
                  <col className="w-[12%]" />
                </colgroup>
              }
            >
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-phx-xs font-black uppercase tracking-[0.12em] text-slate-500">
                  <th className="px-3 py-2.5">Request</th>
                  <th className="px-3 py-2.5">Products</th>
                  <th className="px-3 py-2.5">Where it is</th>
                  <th className="px-3 py-2.5">Estimated cost</th>
                  <th className="px-3 py-2.5">Raised</th>
                  <th className="px-3 py-2.5 text-right">Record</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr className="border-b border-slate-100 align-top transition hover:bg-orange-50/30" key={row.id}>
                    <td className="px-3 py-2.5">
                      <span className="block break-words text-phx-xs font-bold text-slate-500">{row.requestCode}</span>
                      <span className="block break-words text-phx-md font-black text-slate-950">{row.requestTitle}</span>
                      <span className="block break-words text-phx-xs font-medium text-slate-500">Customer: {row.customerName}</span>
                    </td>
                    <td className="break-words px-3 py-2.5 text-phx-sm font-semibold text-slate-700">{row.productNames.join(", ")}</td>
                    <td className="px-3 py-2.5"><WhereItIs row={row} /></td>
                    <td className="break-words px-3 py-2.5 text-phx-md font-black text-slate-950">{egp(row.estimatedCost)}</td>
                    <td className="break-words px-3 py-2.5 text-phx-sm font-bold text-slate-700">{formatDate(row.raisedAt)}</td>
                    <td className="px-3 py-2.5 text-right"><OpenRecordLink row={row} /></td>
                  </tr>
                ))}
              </tbody>
            </PortalDesktopTable>
          )}
        />
      </Card>
    </div>
  );
}
