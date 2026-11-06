"use client";

import { useState } from "react";
import { usePathname, useRouter } from "next/navigation";

import { SearchableSelect } from "@/components/ui/searchable-select";
import type { CrmIntegrityData, CrmIntegrityRow } from "@/lib/crm-integrity/types";
import { formatStableEnGb } from "@/lib/format/cairo-datetime";
import { phxFieldClassName } from "@/components/ui/form-tokens";
import { CrmCard, CrmCardsOnPhone, CrmFacts, CrmTable } from "@/components/phoenix-crm/ui";

// Both formatters below render with timeZone "UTC", for two DIFFERENT reasons — neither is a
// missed Cairo conversion, and "fixing" either one shifts a real number.
//
// formatDate takes `visit_date`, a plain `date` column: UTC midnight is what stops the calendar
// day being shifted by a zone offset.
//
// formatTime takes `check_date`, a `timestamptz` holding a VENDOR timestamp — iReports360 sends
// zone-less Africa/Cairo wall-clock which is stored verbatim (see the VENDOR TIMESTAMP INVARIANT
// in src/lib/crm/vendor-row-types.ts), so its clock reading is ALREADY Cairo-local. This is a client
// component, so rendering it in Africa/Cairo would double-add the offset and show check-in times
// 2–3h late.
function formatDate(value: string) {
  return formatStableEnGb(new Date(value), { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
}

function formatTime(value: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
}

function ContactMatchBadge({ row }: { row: CrmIntegrityRow }) {
  if (row.contactMatchState === "exact_contact_match") {
    return <span className="inline-flex w-fit items-center border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-phx-2xs font-bold uppercase tracking-wide text-emerald-700">Exact contact match</span>;
  }
  if (row.contactMatchState === "nearest_different_contact") {
    return <span className="inline-flex w-fit items-center border border-amber-200 bg-amber-50 px-2 py-0.5 text-phx-2xs font-bold uppercase tracking-wide text-amber-700">Different contact</span>;
  }
  return <span className="inline-flex w-fit items-center border border-slate-200 bg-slate-50 px-2 py-0.5 text-phx-2xs font-bold uppercase tracking-wide text-slate-500">No check-in</span>;
}

function SaveLagBadge({ row }: { row: CrmIntegrityRow }) {
  if (!row.saveLagFlag) return <span className="text-slate-400">—</span>;
  const hours = row.saveLagHours != null ? `${row.saveLagHours >= 0 ? "" : "−"}${Math.abs(row.saveLagHours).toFixed(1)}h` : "";
  if (row.saveLagFlag === "next_day_or_later") {
    return (
      <span className="inline-flex w-fit flex-col gap-0.5">
        <span className="inline-flex w-fit items-center border border-rose-200 bg-rose-50 px-2 py-0.5 text-phx-2xs font-bold uppercase tracking-wide text-rose-700">Saved later</span>
        <span className="text-phx-xs text-slate-500">{hours}</span>
      </span>
    );
  }
  return (
    <span className="inline-flex w-fit flex-col gap-0.5">
      <span className="inline-flex w-fit items-center border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-phx-2xs font-bold uppercase tracking-wide text-emerald-700">Same day</span>
      <span className="text-phx-xs text-slate-500">{hours}</span>
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
        <span className="inline-flex w-fit items-center border border-rose-200 bg-rose-50 px-2 py-0.5 text-phx-2xs font-bold uppercase tracking-wide text-rose-700">Impossible speed</span>
        <span className="text-phx-xs text-slate-500">{detail}</span>
      </span>
    );
  }
  if (row.speedFeasibilityFlag === "unknown") {
    return <span className="inline-flex w-fit items-center border border-slate-200 bg-slate-50 px-2 py-0.5 text-phx-2xs font-bold uppercase tracking-wide text-slate-500">No prior check-in</span>;
  }
  return (
    <span className="inline-flex w-fit flex-col gap-0.5">
      <span className="inline-flex w-fit items-center border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-phx-2xs font-bold uppercase tracking-wide text-emerald-700">OK</span>
      <span className="text-phx-xs text-slate-500">{detail}</span>
    </span>
  );
}

function AgentCell({ row }: { row: CrmIntegrityRow }) {
  return (
    <>
      <p className="font-medium text-slate-900">{row.agentName ?? "—"}</p>
      {row.agentHrId ? null : <p className="text-phx-xs text-rose-500">Unmapped</p>}
    </>
  );
}

// The visit's contact, how it matched, and the check-in's contact only when it is a different person
// (an exact match names the same contact, so it is said once).
function ContactCell({ row }: { row: CrmIntegrityRow }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <p className="break-words font-medium text-slate-900">{row.contactName ?? row.customerName ?? "—"}</p>
      <ContactMatchBadge row={row} />
      {row.contactMatchState === "nearest_different_contact" ? (
        <p className="break-words text-phx-xs font-medium text-amber-700">Checked in at {row.checkinContactName ?? "—"}</p>
      ) : null}
    </div>
  );
}

function CheckinCell({ row }: { row: CrmIntegrityRow }) {
  if (!row.checkinDate) return <span className="text-slate-400">—</span>;
  const where =
    row.checkinAddress || (row.checkinLat != null && row.checkinLon != null ? `${row.checkinLat.toFixed(5)}, ${row.checkinLon.toFixed(5)}` : "");
  return (
    <>
      <p className="font-medium text-slate-900">{formatTime(row.checkinDate)}</p>
      {where ? <p className="break-words text-phx-xs text-slate-500">{where}</p> : null}
    </>
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
            <label className="flex flex-col gap-1 text-phx-2xs font-bold uppercase tracking-wider text-slate-500">
              From
              <input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} className={phxFieldClassName} />
            </label>
            <label className="flex flex-col gap-1 text-phx-2xs font-bold uppercase tracking-wider text-slate-500">
              To
              <input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} className={phxFieldClassName} />
            </label>
            <label className="flex w-56 flex-col gap-1 text-phx-2xs font-bold uppercase tracking-wider text-slate-500">
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

          {data.rows.length === 0 ? (
            <div className="border border-slate-200 bg-white px-3 py-8 text-center text-sm text-slate-500">No visits match these filters.</div>
          ) : (
            <div className="border border-slate-200 bg-white">
              <CrmTable columns={["12%", "14%", "24%", "20%", "15%", "15%"]}>
                <thead className="bg-slate-900">
                  <tr>
                    <th className="px-3 py-3 text-phx-2xs font-black uppercase tracking-wider text-slate-300">Date</th>
                    <th className="px-3 py-3 text-phx-2xs font-black uppercase tracking-wider text-slate-300">Agent</th>
                    <th className="px-3 py-3 text-phx-2xs font-black uppercase tracking-wider text-slate-300">Visit contact</th>
                    <th className="px-3 py-3 text-phx-2xs font-black uppercase tracking-wider text-slate-300">Check-in time / GPS</th>
                    <th className="px-3 py-3 text-phx-2xs font-black uppercase tracking-wider text-slate-300">Save lag</th>
                    <th className="px-3 py-3 text-phx-2xs font-black uppercase tracking-wider text-slate-300">Speed feasibility</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-orange-100">
                  {data.rows.map((row, index) => (
                    <tr key={row.id} className={index % 2 === 0 ? "bg-white" : "bg-orange-50/30"}>
                      <td className="min-w-0 break-words px-3 py-2.5">{formatDate(row.visitDate)}</td>
                      <td className="min-w-0 break-words px-3 py-2.5">
                        <AgentCell row={row} />
                      </td>
                      <td className="min-w-0 break-words px-3 py-2.5">
                        <ContactCell row={row} />
                      </td>
                      <td className="min-w-0 break-words px-3 py-2.5">
                        <CheckinCell row={row} />
                      </td>
                      <td className="min-w-0 break-words px-3 py-2.5"><SaveLagBadge row={row} /></td>
                      <td className="min-w-0 break-words px-3 py-2.5"><SpeedFeasibilityBadge row={row} /></td>
                    </tr>
                  ))}
                </tbody>
              </CrmTable>
              <CrmCardsOnPhone>
                {data.rows.map((row) => (
                  <CrmCard key={row.id} meta={formatDate(row.visitDate)} title={row.agentName ?? (row.agentHrId ? "—" : "Unmapped agent")}>
                    <div className="grid gap-3 text-sm">
                      <ContactCell row={row} />
                      <CheckinCell row={row} />
                      <CrmFacts
                        facts={[
                          { label: "Save lag", value: <SaveLagBadge row={row} /> },
                          { label: "Speed feasibility", value: <SpeedFeasibilityBadge row={row} /> },
                        ]}
                      />
                    </div>
                  </CrmCard>
                ))}
              </CrmCardsOnPhone>
            </div>
          )}

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
