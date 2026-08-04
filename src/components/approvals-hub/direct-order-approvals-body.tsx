import Link from "next/link";

import { formatDealValueLabelled } from "@/lib/direct-orders/approval-fields";
import type { DirectOrderApprovalListItem, DirectOrderWorkspaceData } from "@/lib/direct-orders/types";

const money = (value: number) => `${Math.round(value).toLocaleString("en-US")} EGP`;
const shortDate = (value: string | null) => (value ? String(value).slice(0, 10) : "—");

function StatusPill({ status }: { status: DirectOrderApprovalListItem["status"] }) {
  const tone: Record<string, string> = {
    pending_approval: "bg-amber-100 text-amber-800",
    approved: "bg-emerald-100 text-emerald-800",
    rejected: "bg-rose-100 text-rose-800",
    returned: "bg-slate-200 text-slate-700",
    reversed: "bg-slate-200 text-slate-700",
    draft: "bg-slate-100 text-slate-600",
  };
  return (
    <span className={`inline-block px-2 py-0.5 text-[10px] font-black uppercase tracking-wider ${tone[status] ?? "bg-slate-100 text-slate-600"}`}>
      {status.replace(/_/g, " ")}
    </span>
  );
}

function Table({ rows, base, showWaiting }: { rows: DirectOrderApprovalListItem[]; base: string; showWaiting: boolean }) {
  if (rows.length === 0) {
    return <p className="px-4 py-6 text-sm text-slate-500">Nothing here right now.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[1040px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-[#e4e9ec] bg-slate-50 text-left text-[11px] font-black uppercase tracking-wider text-slate-500">
            <th className="px-3 py-2">Requester</th>
            <th className="px-3 py-2">Product</th>
            <th className="px-3 py-2 text-right">Qty</th>
            {/* NOT "Bonus": a discount deal's percentage was rendered under that header, so 20% off
                read as a 20% giveaway. The cell now names its own kind — see formatDealValueLabelled. */}
            <th className="px-3 py-2 text-right">Bonus / Discount</th>
            <th className="px-3 py-2 text-right">Value</th>
            <th className="px-3 py-2">Pharmacy</th>
            <th className="px-3 py-2">Geography</th>
            <th className="px-3 py-2">Medical rep</th>
            {showWaiting ? <th className="px-3 py-2">Waiting on</th> : <th className="px-3 py-2">Status</th>}
            <th className="px-3 py-2">Submitted</th>
            <th className="px-3 py-2" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-b border-[#eef1f3] hover:bg-orange-50/40">
              <td className="px-3 py-2">
                <div className="font-bold text-slate-900">{row.requesterName}</div>
                <div className="text-[11px] text-slate-500">{row.requesterRole}</div>
              </td>
              <td className="px-3 py-2">
                <div className="font-semibold text-slate-800">{row.productName}</div>
                <div className="text-[11px] text-slate-500">{row.line}</div>
              </td>
              <td className="px-3 py-2 text-right tabular-nums">{row.qty.toLocaleString("en-US")}</td>
              <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">
                {formatDealValueLabelled(row)}
                {row.bonusOverCap ? (
                  <span className="ml-1.5 inline-block rounded-full bg-rose-100 px-1.5 py-0.5 text-[9px] font-black uppercase tracking-wide text-rose-700">
                    over cap
                  </span>
                ) : null}
              </td>
              <td className="whitespace-nowrap px-3 py-2 text-right font-bold tabular-nums">
                {money(row.salesValue)}
              </td>
              <td className="whitespace-nowrap px-3 py-2">
                <div className="text-slate-800">{row.pharmacyName}</div>
                <div className="text-[11px] text-slate-500">{row.pharmacyCode}</div>
              </td>
              {/* Names, never codes — the codes are one click away on the detail. */}
              <td className="whitespace-nowrap px-3 py-2">
                <div className="text-slate-800">{row.areaName || "—"}</div>
                <div className="text-[11px] text-slate-500">{row.brickName || "—"}</div>
              </td>
              <td className="whitespace-nowrap px-3 py-2 text-slate-700">
                {row.medicalRepVacant ? "Vacant" : row.medicalRepName || "—"}
              </td>
              <td className="whitespace-nowrap px-3 py-2">{showWaiting ? row.activeStepLabel || "—" : <StatusPill status={row.status} />}</td>
              <td className="px-3 py-2 text-slate-600">{shortDate(row.createdAt)}</td>
              <td className="px-3 py-2 text-right">
                <Link href={`${base}/${encodeURIComponent(row.id)}`} className="font-bold text-orange-600 hover:text-orange-700">
                  {showWaiting ? "Review →" : "View"}
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function DirectOrderApprovalsBody({ data, backHrefBase }: { data: DirectOrderWorkspaceData; backHrefBase: string }) {
  return (
    <div className="space-y-6">
      <section className="border border-[#e4e9ec] bg-white">
        <header className="flex items-center justify-between border-b border-[#e4e9ec] bg-slate-900 px-4 py-2.5">
          <h3 className="text-[11px] font-black uppercase tracking-[0.14em] text-white">Awaiting your response</h3>
          <span className="text-[11px] font-bold text-orange-300">{data.awaiting.length} pending</span>
        </header>
        <Table rows={data.awaiting} base={backHrefBase} showWaiting />
      </section>

      <section className="border border-[#e4e9ec] bg-white">
        <header className="border-b border-[#e4e9ec] bg-slate-100 px-4 py-2.5">
          <h3 className="text-[11px] font-black uppercase tracking-[0.14em] text-slate-600">Your response history</h3>
        </header>
        <Table rows={data.history} base={backHrefBase} showWaiting={false} />
      </section>
    </div>
  );
}
