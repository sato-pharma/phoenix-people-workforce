"use client";

import { CheckCircle2, Clock, Inbox, XCircle } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { AdminStatCard } from "@/components/admin/admin-design-system";
import { DirectOrderStatusPill } from "@/components/direct-orders/direct-order-status-pill";
import { formatDealValueLabelled } from "@/lib/direct-orders/approval-fields";
import type { DirectOrderApprovalListItem, DirectOrderWorkspaceData } from "@/lib/direct-orders/types";

const money = (value: number) => `${Math.round(value).toLocaleString("en-US")} EGP`;
const shortDate = (value: string | null) => (value ? String(value).slice(0, 10) : "—");

// The status pill lives at @/components/direct-orders/direct-order-status-pill. It was a local copy
// here and three near-identical copies elsewhere, which is exactly why "Approved" could not be made
// to say "awaiting Finance month" without the same edit landing in four files (spec C2).

type TabKey = "awaiting" | "held" | "history";

const EDGE_TONE: Record<TabKey, string> = {
  awaiting: "border-l-amber-400",
  held: "border-l-orange-400",
  history: "border-l-slate-300",
};

/** One clickable row-card — the queue's job is to help you find and prioritize what to open next;
 *  the rich detail (evidence, pricing, history, chain) lives on the order's own page. */
function RequestRow({ row, base, showWaiting, tab }: { row: DirectOrderApprovalListItem; base: string; showWaiting: boolean; tab: TabKey }) {
  return (
    <Link
      href={`${base}/${encodeURIComponent(row.id)}`}
      className={`block border border-[#e4e9ec] border-l-[3px] bg-white px-4 py-3 transition-colors hover:bg-orange-50/40 ${EDGE_TONE[tab]}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-bold text-slate-900">{row.requesterName}</p>
          <p className="text-[11px] text-slate-500">
            {row.requesterRole} · {row.productName} × {row.qty.toLocaleString("en-US")}
          </p>
        </div>
        <div className="text-right">
          <p className="font-black tabular-nums text-slate-900">{money(row.salesValue)}</p>
          <p className="text-[11px] text-slate-500">{formatDealValueLabelled(row)}</p>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500">
        <span className="min-w-0 truncate">
          {row.pharmacyName} · {row.areaName || "—"} · {row.medicalRepVacant ? "Vacant rep" : row.medicalRepName || "—"}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {row.bonusOverCap ? (
            <span className="inline-block rounded-full bg-rose-100 px-1.5 py-0.5 text-[9px] font-black uppercase tracking-wide text-rose-700">
              over cap
            </span>
          ) : null}
          {showWaiting ? (
            <span className="font-bold text-slate-600">{row.activeStepLabel || "—"}</span>
          ) : (
            <DirectOrderStatusPill status={row.status} salesMonth={row.salesMonth} />
          )}
          <span>{shortDate(row.createdAt)}</span>
        </span>
      </div>
    </Link>
  );
}

function Rail({ rows, base, showWaiting, tab, emptyLabel }: { rows: DirectOrderApprovalListItem[]; base: string; showWaiting: boolean; tab: TabKey; emptyLabel: string }) {
  if (rows.length === 0) {
    return <p className="border border-[#e4e9ec] bg-white px-4 py-8 text-center text-sm text-slate-500">{emptyLabel}</p>;
  }
  return (
    <div className="space-y-2">
      {rows.map((row) => (
        <RequestRow key={row.id} row={row} base={base} showWaiting={showWaiting} tab={tab} />
      ))}
    </div>
  );
}

export function DirectOrderApprovalsBody({ data, backHrefBase }: { data: DirectOrderWorkspaceData; backHrefBase: string }) {
  const [tab, setTab] = useState<TabKey>("awaiting");

  // Split from the SAME already-fetched `history` list — no new query. "History" is every request
  // where this viewer decided a step, regardless of outcome; approved/rejected are read off the
  // row's own status rather than fetched separately.
  const approvedCount = data.history.filter((row) => row.status === "approved").length;
  const rejectedCount = data.history.filter((row) => row.status === "rejected" || row.status === "returned").length;
  const awaitingValue = data.awaiting.reduce((sum, row) => sum + row.salesValue, 0);
  const heldValue = data.held.reduce((sum, row) => sum + row.salesValue, 0);

  const TABS: Array<{ key: TabKey; label: string; count: number }> = [
    { key: "awaiting", label: "Awaiting", count: data.awaiting.length },
    { key: "held", label: "Held", count: data.held.length },
    { key: "history", label: "History", count: data.history.length },
  ];

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <AdminStatCard
          description={`${money(awaitingValue)} to decide`}
          icon={<Inbox className="h-4 w-4" />}
          label="Awaiting your response"
          size="compact"
          tone="orange"
          value={data.awaiting.length}
        />
        <AdminStatCard
          description={`${money(heldValue)} parked, pharmacy not yet confirmed`}
          icon={<Clock className="h-4 w-4" />}
          label="Held"
          size="compact"
          tone="blue"
          value={data.held.length}
        />
        <AdminStatCard
          description="Decided by you"
          icon={<CheckCircle2 className="h-4 w-4" />}
          label="Approved"
          size="compact"
          tone="emerald"
          value={approvedCount}
        />
        <AdminStatCard
          description="Rejected or returned by you"
          icon={<XCircle className="h-4 w-4" />}
          label="Rejected"
          size="compact"
          tone="rose"
          value={rejectedCount}
        />
      </div>

      <div className="-mx-1 overflow-x-auto px-1">
        <div className="inline-flex min-w-max border border-slate-300 bg-white p-1" role="tablist">
          {TABS.map(({ key, label, count }) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              onClick={() => setTab(key)}
              className={`px-3 py-1.5 text-[12px] font-black uppercase tracking-wide transition-colors ${
                tab === key ? "bg-slate-900 text-white" : "text-slate-500 hover:bg-slate-100"
              }`}
            >
              {label} <span className="ml-1 opacity-70">{count}</span>
            </button>
          ))}
        </div>
      </div>

      {tab === "awaiting" ? (
        <Rail rows={data.awaiting} base={backHrefBase} showWaiting tab="awaiting" emptyLabel="Nothing awaiting your response right now." />
      ) : tab === "held" ? (
        <Rail
          rows={data.held}
          base={backHrefBase}
          showWaiting={false}
          tab="held"
          emptyLabel="No held requests in your scope right now."
        />
      ) : (
        <Rail rows={data.history} base={backHrefBase} showWaiting={false} tab="history" emptyLabel="No decisions on record yet." />
      )}
    </div>
  );
}
