"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Download, Loader2, Search, Upload } from "lucide-react";

import type { CrmRegionResolutionAction, UnmappedCrmRegionRow } from "@/lib/crm/region-brick";

type ImportSummary = {
  blockedRows: Array<{ reason: string; row: number }>;
  ignored: number;
  mapped: number;
  message: string;
  skipped: number;
  totalRead: number;
};

/** Download-template + upload-mapping toolbar: round-trips the FULL region list (not just
 * unmapped ones — mapped/ignored regions are included pre-filled so a bulk correction pass is
 * possible too), matching the owner's own manually-built mapping spreadsheet's column headers
 * (CRM regionID / CRM region name / Brick ID) so that file uploads here unchanged. */
function TemplateToolbar({ onImported }: { onImported: (summary: ImportSummary) => void }) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFileChosen(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = ""; // allow re-choosing the same file name twice in a row
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const response = await fetch("/api/admin/crm/region-mapping/import", { method: "POST", body: formData });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        setError(payload.message ?? "Upload failed.");
        return;
      }
      onImported(payload as ImportSummary);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 border border-slate-200 bg-white px-4 py-3">
      <a
        href="/api/admin/crm/region-mapping/template"
        className="inline-flex h-9 items-center gap-2 border border-[#D8E0EA] bg-white px-3 text-xs font-bold text-[#0F172A] shadow-sm transition hover:border-[#FDBA74] hover:text-[#F97316]"
      >
        <Download className="h-3.5 w-3.5" />
        Download Template
      </a>
      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        disabled={uploading}
        className="inline-flex h-9 items-center gap-2 border border-[#D8E0EA] bg-white px-3 text-xs font-bold text-[#0F172A] shadow-sm transition hover:border-[#FDBA74] hover:text-[#F97316] disabled:opacity-50"
      >
        {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
        Upload Mapping
      </button>
      <input ref={fileInputRef} type="file" accept=".xlsx" className="hidden" onChange={handleFileChosen} />
      <p className="text-xs text-slate-500">
        Download every CRM region (mapped + unmapped), fill in Brick IDs in Excel, re-upload — bulk corrections apply in one pass.
      </p>
      {error && <p className="w-full text-[11px] font-medium text-rose-600">{error}</p>}
    </div>
  );
}

const RESOLUTION_OPTIONS: Array<{ label: string; value: CrmRegionResolutionAction }> = [
  { label: "Keep Pending", value: "pending" },
  { label: "Ignore (never map)", value: "ignored" },
  { label: "Map to Brick ID…", value: "mapped" },
];

function formatDate(value: string) {
  return new Date(value).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
}

function ResolutionCell({
  region,
  onResolved,
}: {
  region: UnmappedCrmRegionRow;
  onResolved: (crmRegionId: number, message: string) => void;
}) {
  const [action, setAction] = useState<CrmRegionResolutionAction>("pending");
  const [brickIdInput, setBrickIdInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const trimmedBrickId = brickIdInput.trim();
    if (action === "mapped" && !trimmedBrickId) {
      setError("Enter a brick ID to map this region.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/crm/resolve-region", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          brickId: action === "mapped" ? trimmedBrickId : undefined,
          crmRegionId: region.crmRegionId,
          crmRegionName: region.crmRegionName,
        }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        setError(payload.message ?? "Failed to save.");
        return;
      }
      const message =
        action === "mapped"
          ? `Mapped "${region.crmRegionName}" to brick ${payload.brickId} (area ${payload.areaId ?? "—"}, region ${payload.regionId ?? "—"}).`
          : action === "ignored"
            ? `Marked "${region.crmRegionName}" as ignored — hidden from this list.`
            : `Kept "${region.crmRegionName}" pending.`;
      onResolved(region.crmRegionId, message);
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
            setAction(event.target.value as CrmRegionResolutionAction);
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
            value={brickIdInput}
            onChange={(event) => setBrickIdInput(event.target.value)}
            placeholder="e.g. B100-11"
            className="h-8 w-28 border border-[#D8E0EA] bg-white px-2 text-xs text-slate-800"
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

/** Punch-list of every CRM region (iReports360's locality-level geography) that has no real Phoenix
 * brick assigned yet — an admin resolves each one as Ignored (hide it — e.g. a CRM geography
 * artifact not worth mapping), Map to Brick ID (assign the real source_of_sales_bricks brick,
 * validated server-side against the active brick master), or Keep Pending. Mirrors
 * CrmUnmappedIdentitiesPanel's UX exactly — same resolve/hide/toast pattern, different key
 * (crm_region_id) and target (a brick_id, not an employee hr_id). */
export function CrmRegionMappingPanel({
  regions,
  pathname,
}: {
  regions: UnmappedCrmRegionRow[];
  pathname: string;
}) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  // Derived from the `regions` prop (not copied into local state) so a server refresh — triggered
  // after a bulk upload — actually reaches this list. Single-row resolves apply optimistically via
  // `removedIds` until the next server refresh supersedes them with the authoritative list.
  const [removedIds, setRemovedIds] = useState<Set<number>>(new Set());
  const [toast, setToast] = useState<string | null>(null);
  const [importSummary, setImportSummary] = useState<ImportSummary | null>(null);

  const rows = regions.filter((region) => !removedIds.has(region.crmRegionId));

  function handleResolved(crmRegionId: number, message: string) {
    setRemovedIds((current) => new Set(current).add(crmRegionId));
    setToast(message);
  }

  function handleImported(summary: ImportSummary) {
    setImportSummary(summary);
    setToast(summary.message);
    setRemovedIds(new Set());
    router.refresh(); // re-fetch getUnmappedCrmRegions() server-side so the list drops newly-resolved rows
  }

  const term = search.trim().toLowerCase();
  const filtered = term
    ? rows.filter((region) => region.crmRegionName.toLowerCase().includes(term) || String(region.crmRegionId).includes(term))
    : rows;

  function viewInVisits(region: UnmappedCrmRegionRow) {
    const params = new URLSearchParams({
      dataset: "visits",
      dateFrom: region.firstSeen,
      dateTo: region.lastSeen,
      search: region.crmRegionName,
    });
    router.push(`${pathname}?${params.toString()}`);
  }

  return (
    <div className="space-y-4">
      <TemplateToolbar onImported={handleImported} />

      {importSummary && importSummary.blockedRows.length > 0 && (
        <div className="border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <p className="font-semibold">
            {importSummary.blockedRows.length} row{importSummary.blockedRows.length === 1 ? "" : "s"} rejected from the last upload:
          </p>
          <ul className="mt-1.5 max-h-40 space-y-0.5 overflow-y-auto text-xs">
            {importSummary.blockedRows.map((blocked) => (
              <li key={blocked.row}>Row {blocked.row}: {blocked.reason}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 border border-slate-200 bg-white px-4 py-3">
        <p className="text-sm font-medium text-slate-600">
          {rows.length} unmapped CRM {rows.length === 1 ? "region" : "regions"} across the full visit history — resolve
          each one as <span className="font-semibold text-slate-900">Ignore</span> (hide it, never map),{" "}
          <span className="font-semibold text-slate-900">Map to Brick ID</span> (assign the real Phoenix brick), or{" "}
          <span className="font-semibold text-slate-900">Keep Pending</span>.
        </p>
        <div className="relative w-64">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by CRM region name or ID…"
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

      <div className="overflow-x-auto border border-slate-200 bg-white">
        <table className="w-full min-w-[900px] text-left text-sm">
          <thead className="bg-slate-900">
            <tr>
              <th className="px-3 py-3 text-[10px] font-black uppercase tracking-wider text-slate-300">CRM Region ID</th>
              <th className="px-3 py-3 text-[10px] font-black uppercase tracking-wider text-slate-300">CRM Region Name</th>
              <th className="px-3 py-3 text-[10px] font-black uppercase tracking-wider text-slate-300">Visits (all time)</th>
              <th className="px-3 py-3 text-[10px] font-black uppercase tracking-wider text-slate-300">First Seen</th>
              <th className="px-3 py-3 text-[10px] font-black uppercase tracking-wider text-slate-300">Last Seen</th>
              <th className="px-3 py-3 text-[10px] font-black uppercase tracking-wider text-slate-300">Resolution</th>
              <th className="px-3 py-3 text-[10px] font-black uppercase tracking-wider text-slate-300">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-orange-100">
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-sm text-slate-500">
                  {rows.length === 0 ? "No unmapped CRM regions — every region maps to a brick." : "No regions match this search."}
                </td>
              </tr>
            ) : (
              filtered.map((region) => (
                <tr key={region.crmRegionId} className="odd:bg-white even:bg-orange-50/30">
                  <td className="whitespace-nowrap px-3 py-2.5 font-semibold text-slate-700">{region.crmRegionId}</td>
                  <td className="px-3 py-2.5 font-medium text-slate-900">{region.crmRegionName}</td>
                  <td className="whitespace-nowrap px-3 py-2.5 font-semibold text-rose-500">{region.visitCount}</td>
                  <td className="whitespace-nowrap px-3 py-2.5">{formatDate(region.firstSeen)}</td>
                  <td className="whitespace-nowrap px-3 py-2.5">{formatDate(region.lastSeen)}</td>
                  <td className="px-3 py-2.5">
                    <ResolutionCell region={region} onResolved={handleResolved} />
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5">
                    <button
                      type="button"
                      onClick={() => viewInVisits(region)}
                      className="h-8 border border-[#D8E0EA] bg-white px-2.5 text-xs font-bold text-[#0F172A] shadow-sm transition hover:border-[#FDBA74] hover:text-[#F97316]"
                    >
                      View in Visits
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
