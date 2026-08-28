"use client";

import { useState } from "react";
import { usePathname, useRouter } from "next/navigation";

import { cn } from "@/lib/utils";
import { SearchableSelect } from "@/components/ui/searchable-select";
import type { CrmIntegrityData, CrmIntegrityRow } from "@/lib/crm-integrity/types";

// Vendor CRM timestamps (visit_date / check_date) are zone-less Cairo wall-clock stored as +00,
// so their clock reading is ALREADY Cairo-local. Render as-is with timeZone "UTC" — this is a
// client component, so without it the browser's own zone (Cairo) would double-add the offset and
// show check-in times 2–3h late.
function formatDate(value: string) {
  return new Date(value).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
}

function formatTime(value: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
}

function ContactMatchBadge({ row }: { row: CrmIntegrityRow }) {
  if (row.contactMatchState === "exact_contact_match") {
    return <span className="inline-flex w-fit items-center border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-700">Exact contact match</span>;
  }
  if (row.contactMatchState === "nearest_different_contact") {
    return <span className="inline-flex w-fit items-center border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-700">Different contact</span>;
  }
  return <span className="inline-flex w-fit items-center border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-500">No check-in</span>;
}

function SaveLagBadge({ row }: { row: CrmIntegrityRow }) {
  if (!row.saveLagFlag) return <span className="text-slate-400">—</span>;
  const hours = row.saveLagHours != null ? `${row.saveLagHours >= 0 ? "" : "−"}${Math.abs(row.saveLagHours).toFixed(1)}h` : "";
  if (row.saveLagFlag === "next_day_or_later") {
    return (
      <span className="inline-flex w-fit flex-col gap-0.5">
        <span className="inline-flex w-fit items-center border border-rose-200 bg-rose-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-rose-700">Saved later</span>
        <span className="text-[11px] text-slate-500">{hours}</span>
      </span>
    );
  }
  return (
    <span className="inline-flex w-fit flex-col gap-0.5">
      <span className="inline-flex w-fit items-center border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-700">Same day</span>
      <span className="text-[11px] text-slate-500">{hours}</span>
    </span>
  );
}

function SpeedFeasibilityBadge({ row }: { row: CrmIntegrityRow }) {
  if (!row.speedFeasibilityFlag) return <span className="text-slate-400">—</span>;
  const detail =
    row.impliedSpeedKmh != null && row.distanceFromPreviousCheckinKm != null
      ? `${row.impliedSpeedKmh.toFixed(0)} km/h over ${row.distanceFromPreviousCheckinKm.toFixed(1)} km`
      : "";
  if (row.speedFeasibilityFlag === "impossible_speed") {
    return (
      <span className="inline-flex w-fit flex-col gap-0.5">
        <span className="inline-flex w-fit items-center border border-rose-200 bg-rose-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-rose-700">Impossible speed</span>
        <span className="text-[11px] text-slate-500">{detail}</span>
      </span>
    );
  }
  if (row.speedFeasibilityFlag === "unknown") {
    return <span className="inline-flex w-fit items-center border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-500">No prior check-in</span>;
  }
  return (
    <span className="inline-flex w-fit flex-col gap-0.5">
      <span className="inline-flex w-fit items-center border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-700">OK</span>
      <span className="text-[11px] text-slate-500">{detail}</span>
    </span>
  );
}

export function CrmIntegrityWorkspace({
  data,
  initialFilters,
}: {
  data: CrmIntegrityData;
  initialFilters: { agent: string };
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [dateFrom, setDateFrom] = useState(data.dateFrom);
  const [dateTo, setDateTo] = useState(data.dateTo);
  const [agent, setAgent] = useState(initialFilters.agent);

  function applyFilters(overrides?: { page?: number }) {
    const params = new URLSearchParams({
      dateFrom,
      dateTo,
      page: String(overrides?.page ?? 1),
      pageSize: String(data.pageSize),
    });
    if (agent) params.set("agent", agent);
    router.push(`${pathname}?${params.toString()}`);
  }

  const totalPages = Math.max(1, Math.ceil(data.totalCount / data.pageSize));

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs font-black uppercase tracking-[0.18em] text-orange-600">Field coaching</p>
        <h1 className="mt-2 text-3xl font-black tracking-tight text-slate-950">CRM Integrity</h1>
        <p className="mt-2 max-w-3xl text-sm font-medium text-slate-600">
          Correlates every visit against its best-matching GPS check-in — exact contact match first, nearest same-day fallback
          second — and flags visits saved well after the fact or agents moving faster than physically possible between
          check-ins. Read-only, admin review only. {data.totalCount} visits in the selected range.
        </p>
      </div>

      {!data.schemaReady ? (
        <div className="border border-slate-200 bg-white px-5 py-8 text-center text-sm text-slate-500">
          ireports360_checkins table is not provisioned yet.
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-3 border border-slate-200 bg-white px-4 py-3">
            <label className="flex flex-col gap-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">
              From
              <input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} className="h-9 border border-phx-line bg-white px-2 text-sm" />
            </label>
            <label className="flex flex-col gap-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">
              To
              <input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} className="h-9 border border-phx-line bg-white px-2 text-sm" />
            </label>
            <label className="flex w-56 flex-col gap-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">
              Agent
              <SearchableSelect value={agent} onValueChange={setAgent} placeholder="All agents">
                <option value="">All agents</option>
                {data.filters.agents.map((name) => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </SearchableSelect>
            </label>
            <button type="button" onClick={() => applyFilters()} className="h-9 border border-phx-line bg-white px-3 text-xs font-bold text-phx-ink shadow-sm transition hover:border-phx-accent-line hover:text-phx-accent">
              Apply
            </button>
          </div>

          <div className="overflow-x-auto border border-slate-200 bg-white">
            <table className="w-full min-w-[1600px] text-left text-sm">
              <thead className="bg-slate-900">
                <tr>
                  <th className="px-3 py-3 text-[10px] font-black uppercase tracking-wider text-slate-300">Date</th>
                  <th className="px-3 py-3 text-[10px] font-black uppercase tracking-wider text-slate-300">Agent</th>
                  <th className="px-3 py-3 text-[10px] font-black uppercase tracking-wider text-slate-300">Visit Contact</th>
                  <th className="px-3 py-3 text-[10px] font-black uppercase tracking-wider text-slate-300">Contact Match</th>
                  <th className="px-3 py-3 text-[10px] font-black uppercase tracking-wider text-slate-300">Check-in Contact</th>
                  <th className="px-3 py-3 text-[10px] font-black uppercase tracking-wider text-slate-300">Check-in Time / GPS</th>
                  <th className="px-3 py-3 text-[10px] font-black uppercase tracking-wider text-slate-300">Save Lag</th>
                  <th className="px-3 py-3 text-[10px] font-black uppercase tracking-wider text-slate-300">Speed Feasibility</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-orange-100">
                {data.rows.length === 0 ? (
                  <tr><td colSpan={8} className="px-3 py-8 text-center text-sm text-slate-500">No visits match these filters.</td></tr>
                ) : (
                  data.rows.map((row, index) => (
                    <tr key={row.id} className={index % 2 === 0 ? "bg-white" : "bg-orange-50/30"}>
                      <td className="whitespace-nowrap px-3 py-2.5">{formatDate(row.visitDate)}</td>
                      <td className="px-3 py-2.5">
                        <p className="font-medium text-slate-900">{row.agentName ?? "—"}</p>
                        <p className={cn("text-[11px]", row.agentHrId ? "text-slate-400" : "text-rose-500")}>{row.agentHrId ?? "unmapped"}</p>
                      </td>
                      <td className="px-3 py-2.5">{row.contactName ?? row.customerName ?? "—"}</td>
                      <td className="px-3 py-2.5"><ContactMatchBadge row={row} /></td>
                      <td className="px-3 py-2.5">
                        {row.contactMatchState === "no_checkin" ? (
                          <span className="text-slate-400">—</span>
                        ) : (
                          <span className={cn(row.contactMatchState === "nearest_different_contact" ? "font-medium text-amber-700" : "text-slate-700")}>
                            {row.checkinContactName ?? "—"}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        {row.checkinDate ? (
                          <>
                            <p className="font-medium text-slate-900">{formatTime(row.checkinDate)}</p>
                            <p
                              className="max-w-[220px] truncate text-[11px] text-slate-500"
                              title={row.checkinLat != null && row.checkinLon != null ? `${row.checkinLat}, ${row.checkinLon}` : undefined}
                            >
                              {row.checkinAddress || (row.checkinLat != null && row.checkinLon != null ? `${row.checkinLat.toFixed(5)}, ${row.checkinLon.toFixed(5)}` : "—")}
                            </p>
                          </>
                        ) : (
                          <span className="text-slate-400">No check-in</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5"><SaveLagBadge row={row} /></td>
                      <td className="px-3 py-2.5"><SpeedFeasibilityBadge row={row} /></td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between border border-slate-200 bg-white px-4 py-3 text-sm">
            <span className="text-slate-500">
              Page {data.page} of {totalPages} · {data.totalCount} total visits
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={data.page <= 1}
                onClick={() => applyFilters({ page: data.page - 1 })}
                className="h-9 border border-phx-line bg-white px-3 text-xs font-bold text-phx-ink shadow-sm transition hover:border-phx-accent-line hover:text-phx-accent disabled:opacity-40"
              >
                Previous
              </button>
              <button
                type="button"
                disabled={data.page >= totalPages}
                onClick={() => applyFilters({ page: data.page + 1 })}
                className="h-9 border border-phx-line bg-white px-3 text-xs font-bold text-phx-ink shadow-sm transition hover:border-phx-accent-line hover:text-phx-accent disabled:opacity-40"
              >
                Next
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
