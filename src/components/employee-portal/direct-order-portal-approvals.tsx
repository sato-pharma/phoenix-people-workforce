"use client";

import Link from "next/link";
import { ChevronRight } from "lucide-react";

import {
  PortalDesktopTable,
  PortalEmptyState,
  PortalRecordCard,
  PortalRecordFields,
  PortalResponsiveDataList,
  PortalSection,
} from "@/components/employee-portal/portal-primitives";
import { DirectOrderStatusPill } from "@/components/direct-orders/direct-order-status-pill";
import { dealFieldLabel, formatDealValue, formatDealValueLabelled } from "@/lib/direct-orders/approval-fields";
import type { DirectOrderApprovalListItem, DirectOrderWorkspaceData } from "@/lib/direct-orders/types";

const money = (value: number) => `${Math.round(value).toLocaleString("en-US")} EGP`;
const shortDate = (value: string | null) => (value ? String(value).slice(0, 10) : "-");
// No local bonusCell: it fed a discount deal's percentage into a column headed "Bonus".
// The mobile card can label per field (dealFieldLabel); the desktop table has one fixed
// header, so its cell carries its own kind (formatDealValueLabelled).

// The tone map and the pill moved to @/components/direct-orders/direct-order-status-pill, which
// keeps the portal's rounded ring look under variant="ring". Four copies of this existed; that is
// why "Approved" could not be made to say "awaiting Finance month" in one edit (spec C2).

function ApprovalsList({ rows, base, showWaiting }: { rows: DirectOrderApprovalListItem[]; base: string; showWaiting: boolean }) {
  if (rows.length === 0) {
    return (
      <PortalEmptyState
        title={showWaiting ? "Nothing waiting on you" : "No response history yet"}
        message={showWaiting ? "Direct orders that need your approval will appear here." : "Requests you have approved, rejected, or returned will show up here."}
      />
    );
  }

  return (
    <PortalResponsiveDataList
      items={rows}
      getKey={(row) => row.id}
      empty={<PortalEmptyState title="Nothing here" message="Nothing to show right now." />}
      renderCard={(row) => (
        <PortalRecordCard
          title={row.productName}
          meta={`${row.requesterName} - ${row.requesterRole}`}
          status={<span className="whitespace-nowrap text-sm font-black text-slate-950">{money(row.salesValue)}</span>}
          accent={showWaiting ? "amber" : row.status === "approved" ? "emerald" : row.status === "rejected" ? "rose" : "slate"}
          actions={
            <Link
              href={`${base}/${encodeURIComponent(row.id)}`}
              className="flex h-11 flex-1 items-center justify-center gap-1 rounded bg-slate-900 text-sm font-black text-white transition hover:bg-black"
            >
              {showWaiting ? "Review" : "View"}
              <ChevronRight className="h-4 w-4" />
            </Link>
          }
        >
          <div className="mb-2">{showWaiting ? null : <DirectOrderStatusPill status={row.status} salesMonth={row.salesMonth} variant="ring" />}</div>
          <PortalRecordFields
            fields={[
              { label: "Line", value: row.line },
              { label: "Qty", value: row.qty.toLocaleString("en-US") },
              { label: dealFieldLabel(row), value: formatDealValue(row) },
              { label: "Pharmacy", value: row.pharmacyName },
              // The card used to drop the pharmacy code entirely — an approver on a phone
              // could not tell two same-named pharmacies apart.
              { label: "Code", value: row.pharmacyCode },
              { label: "Area", value: row.areaName || "-" },
              { label: "Brick", value: row.brickName || "-" },
              { label: "Medical rep", value: row.medicalRepVacant ? "Vacant" : row.medicalRepName || "-" },
              { label: showWaiting ? "Waiting on" : "Submitted", value: showWaiting ? row.activeStepLabel || "-" : shortDate(row.createdAt) },
            ]}
          />
        </PortalRecordCard>
      )}
      renderTable={() => (
        <PortalDesktopTable minWidth="1120px">
          <thead className="bg-slate-900 text-white">
            <tr>
              <th className="px-3 py-2 text-[11px] font-black uppercase tracking-wider">Requester</th>
              <th className="px-3 py-2 text-[11px] font-black uppercase tracking-wider">Product</th>
              <th className="px-3 py-2 text-right text-[11px] font-black uppercase tracking-wider">Qty</th>
              <th className="px-3 py-2 text-right text-[11px] font-black uppercase tracking-wider">Bonus / Discount</th>
              <th className="px-3 py-2 text-right text-[11px] font-black uppercase tracking-wider">Value</th>
              <th className="px-3 py-2 text-[11px] font-black uppercase tracking-wider">Pharmacy</th>
              <th className="px-3 py-2 text-[11px] font-black uppercase tracking-wider">Geography</th>
              <th className="px-3 py-2 text-[11px] font-black uppercase tracking-wider">Medical rep</th>
              <th className="px-3 py-2 text-[11px] font-black uppercase tracking-wider">{showWaiting ? "Waiting on" : "Status"}</th>
              <th className="px-3 py-2 text-[11px] font-black uppercase tracking-wider">Submitted</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={row.id} className={index % 2 ? "bg-slate-50" : "bg-white"}>
                <td className="px-3 py-2">
                  <div className="font-bold text-slate-900">{row.requesterName}</div>
                  <div className="text-[11px] text-slate-500">{row.requesterRole}</div>
                </td>
                <td className="px-3 py-2">
                  <div className="font-semibold text-slate-800">{row.productName}</div>
                  <div className="text-[11px] text-slate-500">{row.line}</div>
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{row.qty.toLocaleString("en-US")}</td>
                <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{formatDealValueLabelled(row)}</td>
                <td className="px-3 py-2 text-right font-bold tabular-nums">{money(row.salesValue)}</td>
                <td className="whitespace-nowrap px-3 py-2">
                  <div className="text-slate-800">{row.pharmacyName}</div>
                  <div className="text-[11px] text-slate-500">{row.pharmacyCode}</div>
                </td>
                {/* Names, never codes. */}
                <td className="whitespace-nowrap px-3 py-2">
                  <div className="text-slate-800">{row.areaName || "-"}</div>
                  <div className="text-[11px] text-slate-500">{row.brickName || "-"}</div>
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-slate-700">
                  {row.medicalRepVacant ? "Vacant" : row.medicalRepName || "-"}
                </td>
                <td className="whitespace-nowrap px-3 py-2">{showWaiting ? row.activeStepLabel || "-" : <DirectOrderStatusPill status={row.status} salesMonth={row.salesMonth} variant="ring" />}</td>
                <td className="px-3 py-2 text-slate-600">{shortDate(row.createdAt)}</td>
                <td className="px-3 py-2 text-right">
                  <Link href={`${base}/${encodeURIComponent(row.id)}`} className="font-bold text-orange-600 hover:text-orange-700">
                    {showWaiting ? "Review ->" : "View"}
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </PortalDesktopTable>
      )}
    />
  );
}

export function DirectOrderPortalApprovals({ data, backHrefBase }: { data: DirectOrderWorkspaceData; backHrefBase: string }) {
  return (
    <div className="space-y-5">
      <PortalSection eyebrow="Action needed" title="Awaiting your response" description={`${data.awaiting.length} pending`}>
        <ApprovalsList rows={data.awaiting} base={backHrefBase} showWaiting />
      </PortalSection>

      <PortalSection eyebrow="History" title="Your response history">
        <ApprovalsList rows={data.history} base={backHrefBase} showWaiting={false} />
      </PortalSection>
    </div>
  );
}
