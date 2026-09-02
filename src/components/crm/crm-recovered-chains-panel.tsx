"use client";

import { ArrowRight, Link2 } from "lucide-react";

import {
  PortalDesktopTable,
  PortalRecordCard,
  PortalRecordFields,
  PortalResponsiveDataList,
} from "@/components/employee-portal/portal-primitives";
import { ExportXlsxButton } from "@/components/ui/export-xlsx-button";
import type { ExportColumn, ExportRow } from "@/lib/export/table-workbook";
import type { DoubleVisitRecoveredChain } from "@/lib/double-visit-analytics/types";

// DATE-ONLY (`double_visit_reports.activity_date`, a `date` column), which `new Date` parses as UTC
// midnight. UTC here is CORRECT and must stay: it is what stops the calendar day being shifted by a
// zone offset. Not an instant — do not "fix" this one to Cairo.
function formatDate(value: string) {
  return new Date(value).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
}

/** The hinge → resolved-MR chain, rendered identically in the mobile card and the desktop row so
 * the two can never tell a different story about who actually got the credit.
 *
 * Both names NOWRAP only from `md` up, where this renders inside PortalDesktopTable — that table
 * is `hidden overflow-x-auto md:block` with a 960px min-width, so a long name scrolls inside the
 * table rather than moving the page. BELOW md the same markup sits in a mobile card whose
 * container (`border border-slate-200 bg-white`) has no `overflow-hidden`, so an overflowing
 * name extends the PAGE. Measured at 375px in DM Sans against the real shell width (`main` is
 * `px-3`, so 351px of content): the hinge-manager span pushed `documentElement.scrollWidth` past
 * 375 at a 55-character name, and the longest `employees.full_name` company-wide is 52 — three
 * characters of margin. The parent is already `flex flex-wrap`, so wrapping needs nothing else.
 * Same fix and same reasoning as PortalRecordCard's title (#2268). */
function ResolvedChain({ chain }: { chain: DoubleVisitRecoveredChain }) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5 text-phx-xs font-medium text-slate-600">
        <span className="break-words text-slate-400 md:whitespace-nowrap">{chain.hingeManagerName ?? "hinge manager"}</span>
        <ArrowRight className="h-3 w-3 text-emerald-500" />
        <span className="inline-flex items-center gap-1 break-words bg-emerald-50 px-2 py-0.5 text-phx-xs font-bold text-emerald-700 md:whitespace-nowrap">
          {chain.resolvedMrName ?? chain.resolvedMrHrId ?? "MR"}
        </span>
      </div>
      {chain.customerSample.length > 0 && (
        <p className="mt-1 text-phx-2xs text-slate-400">{chain.customerSample.join(" · ")}</p>
      )}
    </>
  );
}

/** Double-visits that looked like "manager visiting a manager" but were actually re-credited to the
 * real Medical Rep the convoy saw, via a same-day chain match. Ported verbatim from the former
 * Visits Report page's Recovered Chains tab — no other CRM surface computes this. */
export function CrmRecoveredChainsPanel({ chains }: { chains: DoubleVisitRecoveredChain[] }) {
  const totalVisits = chains.reduce((sum, chain) => sum + chain.visitCount, 0);
  const exportColumns: ExportColumn[] = [
    { key: "date", label: "Date" },
    { key: "creditedManager", label: "Credited Manager" },
    { key: "creditedManagerHrId", label: "Credited Manager HR ID" },
    { key: "viaManager", label: "Via (hinge manager)" },
    { key: "viaManagerHrId", label: "Via HR ID" },
    { key: "resolvedMr", label: "Resolved MR" },
    { key: "resolvedMrHrId", label: "Resolved MR HR ID" },
    { key: "area", label: "Area" },
    { key: "line", label: "Line" },
    { key: "customers", label: "Customer Sample" },
    { key: "visits", label: "Visits", numeric: true },
  ];
  const exportRows: ExportRow[] = chains.map((chain) => ({
    date: chain.activityDate,
    creditedManager: chain.higherManagerName ?? "—",
    creditedManagerHrId: chain.higherManagerHrId ?? "—",
    viaManager: chain.hingeManagerName ?? "—",
    viaManagerHrId: chain.hingeManagerHrId ?? "—",
    resolvedMr: chain.resolvedMrName ?? "—",
    resolvedMrHrId: chain.resolvedMrHrId ?? "—",
    area: chain.areaName ?? "—",
    line: chain.lineName ?? "—",
    customers: chain.customerSample.join(", ") || "—",
    visits: chain.visitCount,
  }));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 border border-slate-200 bg-white px-4 py-3">
        <p className="max-w-3xl text-sm font-medium text-slate-600">
          <span className="mr-1.5 inline-flex items-center gap-1 font-bold text-emerald-700"><Link2 className="h-3.5 w-3.5" />Recovered via chain:</span>
          {chains.length} double {chains.length === 1 ? "visit" : "visits"} ({totalVisits} activity{" "}
          {totalVisits === 1 ? "count" : "counts"}) in the selected range that looked like a manager visiting a manager
          were re-credited to the real Medical Rep the convoy actually saw — matched by the same-day double visit the
          hinge manager performed.
        </p>
        {chains.length > 0 && (
          <ExportXlsxButton
            title="Double Visit Recovered Chains"
            subtitle={`${chains.length} recovered rows`}
            sheetName="Recovered Chains"
            columns={exportColumns}
            rows={exportRows}
          />
        )}
      </div>

      {/* Desktop keeps the six-column table; mobile gets one card per chain — AGENTS.md §4. */}
      <div className="border border-slate-200 bg-white">
        <PortalResponsiveDataList
          empty={<p className="px-3 py-8 text-center text-sm text-slate-500">No recovered chains in this date range.</p>}
          getKey={(chain) => String(chain.id)}
          items={chains}
          renderCard={(chain) => (
            <PortalRecordCard
              accent="emerald"
              meta={`${formatDate(chain.activityDate)} · ${chain.higherManagerHrId ?? "no HR ID"}`}
              status={<span className="text-sm font-black tabular-nums text-slate-900">{chain.visitCount}</span>}
              title={chain.higherManagerName ?? "—"}
            >
              <div className="mb-3">
                <ResolvedChain chain={chain} />
              </div>
              <PortalRecordFields
                fields={[
                  { label: "Area", value: chain.areaName ?? "—" },
                  { label: "Line", value: chain.lineName ?? "—" },
                ]}
              />
            </PortalRecordCard>
          )}
          renderTable={() => (
            <PortalDesktopTable minWidth="960px">
              <thead className="bg-slate-900">
                <tr>
                  <th className="px-3 py-3 text-left text-phx-2xs font-black uppercase tracking-wider text-slate-300">Date</th>
                  <th className="px-3 py-3 text-left text-phx-2xs font-black uppercase tracking-wider text-slate-300">Credited Manager</th>
                  <th className="px-3 py-3 text-left text-phx-2xs font-black uppercase tracking-wider text-slate-300">Resolved Chain</th>
                  <th className="px-3 py-3 text-left text-phx-2xs font-black uppercase tracking-wider text-slate-300">Area</th>
                  <th className="px-3 py-3 text-left text-phx-2xs font-black uppercase tracking-wider text-slate-300">Line</th>
                  <th className="px-3 py-3 text-right text-phx-2xs font-black uppercase tracking-wider text-slate-300">Visits</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-orange-100">
                {chains.map((chain, index) => (
                  <tr key={chain.id} className={index % 2 === 0 ? "bg-white" : "bg-emerald-50/30"}>
                    <td className="whitespace-nowrap px-3 py-2.5">{formatDate(chain.activityDate)}</td>
                    <td className="px-3 py-2.5">
                      <p className="font-medium text-slate-900">{chain.higherManagerName ?? "—"}</p>
                      <p className="text-phx-xs text-slate-400">{chain.higherManagerHrId ?? "no HR ID"}</p>
                    </td>
                    <td className="px-3 py-2.5">
                      <ResolvedChain chain={chain} />
                    </td>
                    <td className="px-3 py-2.5">{chain.areaName ?? "—"}</td>
                    <td className="px-3 py-2.5">{chain.lineName ?? "—"}</td>
                    <td className="px-3 py-2.5 text-right font-bold tabular-nums">{chain.visitCount}</td>
                  </tr>
                ))}
              </tbody>
            </PortalDesktopTable>
          )}
        />
      </div>
    </div>
  );
}
