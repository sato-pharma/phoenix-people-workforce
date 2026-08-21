"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Search } from "lucide-react";

import {
  PortalDesktopTable,
  PortalRecordCard,
  PortalRecordFields,
  PortalResponsiveDataList,
} from "@/components/employee-portal/portal-primitives";
import type { UnmappedCrmIdentityRow, UnmappedCrmResolutionAction } from "@/lib/visits-report/types";

const RESOLUTION_OPTIONS: Array<{ label: string; value: UnmappedCrmResolutionAction }> = [
  { label: "Keep Pending", value: "pending" },
  { label: "Mark Resigned", value: "resigned" },
  { label: "Map to HR ID…", value: "mapped" },
];

function formatDate(value: string) {
  return new Date(value).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
}

function ResolutionCell({
  identity,
  onResolved,
}: {
  identity: UnmappedCrmIdentityRow;
  onResolved: (crmId: number, message: string) => void;
}) {
  const [action, setAction] = useState<UnmappedCrmResolutionAction>("pending");
  const [hrIdInput, setHrIdInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const trimmedHrId = hrIdInput.trim();
    if (action === "mapped" && !trimmedHrId) {
      setError("Enter an HR ID to map this identity.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/visits-report/resolve-identity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          crmId: identity.crmId,
          crmName: identity.name,
          mappedHrId: action === "mapped" ? trimmedHrId : undefined,
        }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        setError(payload.message ?? "Failed to save.");
        return;
      }
      const message =
        action === "mapped"
          ? `Mapped ${payload.updatedVisits} visit${payload.updatedVisits === 1 ? "" : "s"} to ${payload.resolvedEmployeeHrId} (${payload.resolvedEmployeeName}).`
          : action === "resigned"
            ? `Marked ${identity.name} as resigned — hidden from this list.`
            : `Kept ${identity.name} pending.`;
      onResolved(identity.crmId, message);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <select
          value={action}
          onChange={(event) => {
            setAction(event.target.value as UnmappedCrmResolutionAction);
            setError(null);
          }}
          className="h-8 border border-[#D8E0EA] bg-white px-2 text-xs text-slate-700"
        >
          {RESOLUTION_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
        {action === "mapped" && (
          <input
            type="text"
            value={hrIdInput}
            onChange={(event) => setHrIdInput(event.target.value)}
            placeholder="e.g. B-82"
            className="h-8 w-24 border border-[#D8E0EA] bg-white px-2 text-xs text-slate-800"
          />
        )}
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="inline-flex h-8 items-center gap-1.5 border border-[#D8E0EA] bg-white px-2.5 text-xs font-bold text-[#0F172A] shadow-sm transition hover:border-[#FDBA74] hover:text-[#F97316] disabled:opacity-50"
        >
          {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Save
        </button>
      </div>
      {error && <p className="text-[11px] font-medium text-rose-600">{error}</p>}
    </div>
  );
}

/** Aggregated punch-list of every unmapped CRM identity (one row per crm_id, not per visit) — replaces
 * the old raw per-visit "CRM Issues" dataset tab, which listed the same underlying problem one visit
 * row at a time. Ported from the former Visits Report page's Unmapped Agents tab; same resolve
 * endpoint, so a fix here and a fix there (if it still existed) could never disagree. */
export function CrmUnmappedIdentitiesPanel({
  identities,
  pathname,
}: {
  identities: UnmappedCrmIdentityRow[];
  pathname: string;
}) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState(identities);
  const [toast, setToast] = useState<string | null>(null);

  function handleResolved(crmId: number, message: string) {
    setRows((current) => current.filter((identity) => identity.crmId !== crmId));
    setToast(message);
  }

  const term = search.trim().toLowerCase();
  const filtered = term
    ? rows.filter((identity) => identity.name.toLowerCase().includes(term) || String(identity.crmId).includes(term))
    : rows;

  function viewInVisits(identity: UnmappedCrmIdentityRow) {
    const params = new URLSearchParams({
      dataset: "visits",
      dateFrom: identity.firstSeen,
      dateTo: identity.lastSeen,
      search: identity.name,
    });
    router.push(`${pathname}?${params.toString()}`);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 border border-slate-200 bg-white px-4 py-3">
        <p className="text-sm font-medium text-slate-600">
          {rows.length} unmapped CRM {rows.length === 1 ? "identity" : "identities"} across the full visit history — resolve
          each one as <span className="font-semibold text-slate-900">Resigned</span> (hide it),{" "}
          <span className="font-semibold text-slate-900">Map to HR ID</span> (fix it now and going forward), or{" "}
          <span className="font-semibold text-slate-900">Keep Pending</span>.
        </p>
        <div className="relative w-64">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by CRM name or ID…"
            className="h-9 w-full border border-[#D8E0EA] bg-white pl-8 pr-2 text-sm text-slate-800"
          />
        </div>
      </div>

      {toast && (
        <div className="flex items-center justify-between border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm font-medium text-emerald-800">
          {toast}
          <button type="button" onClick={() => setToast(null)} className="text-emerald-700 hover:text-emerald-900">Dismiss</button>
        </div>
      )}

      {/* Desktop keeps the eight-column punch list; mobile gets one card per identity, resolution
          control and all — AGENTS.md §4. Both halves drive the same handleResolved/viewInVisits. */}
      <div className="border border-slate-200 bg-white">
        <PortalResponsiveDataList
          empty={
            <p className="px-3 py-8 text-center text-sm text-slate-500">
              {rows.length === 0 ? "No unmapped CRM identities — everyone maps to an HR ID." : "No identities match this search."}
            </p>
          }
          getKey={(identity) => String(identity.crmId)}
          items={filtered}
          renderCard={(identity) => (
            <PortalRecordCard
              accent="rose"
              actions={
                <>
                  <ResolutionCell identity={identity} onResolved={handleResolved} />
                  <button
                    type="button"
                    onClick={() => viewInVisits(identity)}
                    className="h-8 border border-[#D8E0EA] bg-white px-2.5 text-xs font-bold text-[#0F172A] shadow-sm transition hover:border-[#FDBA74] hover:text-[#F97316]"
                  >
                    View in Visits
                  </button>
                </>
              }
              meta={`CRM ID ${identity.crmId} · ${identity.roles.join(" + ")}`}
              status={<span className="text-sm font-black text-rose-500">{identity.visitCount}</span>}
              title={identity.name}
            >
              <PortalRecordFields
                fields={[
                  { label: "First seen", value: formatDate(identity.firstSeen) },
                  { label: "Last seen", value: formatDate(identity.lastSeen) },
                ]}
              />
            </PortalRecordCard>
          )}
          renderTable={() => (
            <PortalDesktopTable minWidth="1100px">
              <thead className="bg-slate-900">
                <tr>
                  <th className="px-3 py-3 text-[10px] font-black uppercase tracking-wider text-slate-300">CRM ID</th>
                  <th className="px-3 py-3 text-[10px] font-black uppercase tracking-wider text-slate-300">CRM Name</th>
                  <th className="px-3 py-3 text-[10px] font-black uppercase tracking-wider text-slate-300">Seen As</th>
                  <th className="px-3 py-3 text-[10px] font-black uppercase tracking-wider text-slate-300">Unmapped Visits</th>
                  <th className="px-3 py-3 text-[10px] font-black uppercase tracking-wider text-slate-300">First Seen</th>
                  <th className="px-3 py-3 text-[10px] font-black uppercase tracking-wider text-slate-300">Last Seen</th>
                  <th className="px-3 py-3 text-[10px] font-black uppercase tracking-wider text-slate-300">Resolution</th>
                  <th className="px-3 py-3 text-[10px] font-black uppercase tracking-wider text-slate-300">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-orange-100">
                {filtered.map((identity) => (
                  <tr key={identity.crmId} className="odd:bg-white even:bg-orange-50/30">
                    <td className="whitespace-nowrap px-3 py-2.5 font-semibold text-slate-700">{identity.crmId}</td>
                    <td className="px-3 py-2.5 font-medium text-slate-900">{identity.name}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-slate-600">{identity.roles.join(" + ")}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 font-semibold text-rose-500">{identity.visitCount}</td>
                    <td className="whitespace-nowrap px-3 py-2.5">{formatDate(identity.firstSeen)}</td>
                    <td className="whitespace-nowrap px-3 py-2.5">{formatDate(identity.lastSeen)}</td>
                    <td className="px-3 py-2.5">
                      <ResolutionCell identity={identity} onResolved={handleResolved} />
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5">
                      <button
                        type="button"
                        onClick={() => viewInVisits(identity)}
                        className="h-8 border border-[#D8E0EA] bg-white px-2.5 text-xs font-bold text-[#0F172A] shadow-sm transition hover:border-[#FDBA74] hover:text-[#F97316]"
                      >
                        View in Visits
                      </button>
                    </td>
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
