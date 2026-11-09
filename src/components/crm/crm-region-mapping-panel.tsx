"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Download, Loader2, Search, Upload } from "lucide-react";

import {
  PortalDesktopTable,
  PortalRecordCard,
  PortalRecordFields,
  PortalResponsiveDataList,
} from "@/components/employee-portal/portal-primitives";
import type { CrmRegionResolutionAction, UnmappedCrmRegionRow } from "@/lib/crm/region-brick";
import type { SuggestionConfidence } from "@/lib/crm/region-brick-suggest";
import { formatStableEnGb } from "@/lib/format/cairo-datetime";
import {
  phxFieldClassName,
  phxSelectClassName,
} from "@/components/ui/form-tokens";
import { cn } from "@/lib/utils";

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
        className="inline-flex h-9 items-center gap-2 border border-phx-line bg-white px-3 text-xs font-bold text-phx-ink shadow-sm transition hover:border-phx-accent-line hover:text-phx-accent"
      >
        <Download className="h-3.5 w-3.5" />
        Download Template
      </a>
      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        disabled={uploading}
        className="inline-flex h-9 items-center gap-2 border border-phx-line bg-white px-3 text-xs font-bold text-phx-ink shadow-sm transition hover:border-phx-accent-line hover:text-phx-accent disabled:opacity-50"
      >
        {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
        Upload Mapping
      </button>
      <input ref={fileInputRef} type="file" accept=".xlsx" className="hidden" onChange={handleFileChosen} />
      <p className="text-xs text-slate-500">
        Download every CRM region (mapped + unmapped), fill in Brick IDs in Excel, re-upload — bulk corrections apply in one pass.
      </p>
      {error && <p className="w-full text-phx-xs font-medium text-rose-600">{error}</p>}
    </div>
  );
}

const RESOLUTION_OPTIONS: Array<{ label: string; value: CrmRegionResolutionAction }> = [
  { label: "Keep Pending", value: "pending" },
  { label: "Ignore (never map)", value: "ignored" },
  { label: "Map to Brick ID…", value: "mapped" },
];

// DATE-ONLY (`firstSeen`/`lastSeen`, both min/max of `ireports360_visits.visit_date` — a `date` column,
// not the vendor's timestamptz — or, for a plan-only locality, its customers' contact-master dates, also
// `date` columns), which `new Date` parses as UTC midnight. UTC here is CORRECT and must stay: it is what
// stops the calendar day being shifted by a zone offset. Not an instant — do not "fix" this one to Cairo.
// A plan-only locality whose customers carry no date at all sends "", shown as a dash.
function formatDate(value: string) {
  if (!value) return "—";
  return formatStableEnGb(new Date(value), { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
}

/** A locality no visit carries — known only from reps' plans and doctor lists. Its id is a negative
 * stand-in made from its name (planOnlyCrmRegionId), so it is never shown as if it were the CRM's. */
function isPlanOnly(region: UnmappedCrmRegionRow) {
  return region.planOnlyCustomerCount !== null;
}

function regionIdLabel(region: UnmappedCrmRegionRow) {
  return isPlanOnly(region) ? "No CRM ID — plan only" : String(region.crmRegionId);
}

function planOnlyCustomersLabel(region: UnmappedCrmRegionRow) {
  const count = region.planOnlyCustomerCount ?? 0;
  return `${count} ${count === 1 ? "customer" : "customers"} on reps' plans or lists`;
}

const CONFIDENCE_CHIP: Record<SuggestionConfidence, string> = {
  confirmed: "border-emerald-300 bg-emerald-50 text-emerald-700",
  likely: "border-sky-300 bg-sky-50 text-sky-700",
  unsure: "border-amber-300 bg-amber-50 text-amber-700",
};

const CONFIDENCE_LABEL: Record<SuggestionConfidence, string> = {
  confirmed: "Name + area agree",
  likely: "Likely",
  unsure: "Needs a decision",
};

/**
 * The brick this region probably is, shown before anyone types anything.
 *
 * Arabic first, because that IS the brick's name — the English gloss beside it is the CRM's spelling,
 * and the whole reason these two halves never met is that nobody could see they were the same place.
 */
function SuggestionCell({ region }: { region: UnmappedCrmRegionRow }) {
  const suggestion = region.suggestion;
  if (!suggestion) {
    return <span className="text-xs text-slate-400">No brick matches this name</span>;
  }
  const place = [suggestion.areaName, suggestion.regionName].filter(Boolean).join(" · ");
  return (
    <span className="flex flex-col gap-0.5 leading-tight">
      <span className="flex flex-wrap items-center gap-1.5">
        <span className="font-bold text-slate-900" dir="auto">
          {suggestion.brickName}
        </span>
        <span className="text-phx-sm font-semibold text-slate-400">{suggestion.brickId}</span>
        <span
          className={`border px-1.5 py-0.5 text-phx-xs font-black uppercase tracking-[0.1em] ${CONFIDENCE_CHIP[suggestion.confidence]}`}
        >
          {CONFIDENCE_LABEL[suggestion.confidence]}
        </span>
      </span>
      {place ? <span className="text-phx-xs font-semibold text-slate-600">{place}</span> : null}
      <span className="text-phx-xs text-slate-500">{suggestion.reason}</span>
    </span>
  );
}

function ResolutionCell({
  region,
  onResolved,
}: {
  region: UnmappedCrmRegionRow;
  onResolved: (crmRegionId: number, message: string) => void;
}) {
  // Pre-loaded with the suggestion, so a region the two signals agree on is one click rather than a
  // brick id copied by hand out of a spreadsheet. An "unsure" suggestion is deliberately NOT
  // pre-loaded — it is a question, and pre-filling a question is how a guess becomes a record.
  const proposed = region.suggestion && region.suggestion.confidence !== "unsure" ? region.suggestion : null;
  const [action, setAction] = useState<CrmRegionResolutionAction>(proposed ? "mapped" : "pending");
  const [brickIdInput, setBrickIdInput] = useState(proposed?.brickId ?? "");
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
          className={phxSelectClassName}
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
            className={cn(phxFieldClassName, "w-28")}
          />
        )}
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="inline-flex h-8 items-center gap-1.5 border border-phx-line bg-white px-2.5 text-xs font-bold text-phx-ink shadow-sm transition hover:border-phx-accent-line hover:text-phx-accent disabled:opacity-50"
        >
          {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Save
        </button>
      </div>
      {error && <p className="text-phx-xs font-medium text-rose-600">{error}</p>}
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

  const counts = rows.reduce(
    (acc, region) => {
      if (!region.suggestion) acc.none += 1;
      else acc[region.suggestion.confidence] += 1;
      return acc;
    },
    { confirmed: 0, likely: 0, none: 0, unsure: 0 },
  );

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

      {/* What the matcher already worked out, before anyone reads a single row. The CRM writes these
          places in English and every Phoenix brick is written in Arabic, so nothing ever matched on
          text; the Arabic name key plus the visiting reps' own organogram area does most of it, and
          says plainly how much is left for a human. */}
      <div className="border-l-[3px] border-l-orange-500 bg-orange-50 px-4 py-2.5 text-xs font-semibold text-slate-700">
        <span className="font-black text-emerald-700">{counts.confirmed}</span> of these are already matched by their
        Arabic name AND confirmed by the area the visiting reps work in — those are pre-filled below and need one click.
        Another <span className="font-black text-sky-700">{counts.likely}</span> match on one signal with nothing to
        contradict them. <span className="font-black text-amber-700">{counts.unsure + counts.none}</span> genuinely need
        your decision — a name that reaches several bricks, or none at all.
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border border-slate-200 bg-white px-4 py-3">
        <p className="text-sm font-medium text-slate-600">
          {rows.length} unmapped CRM {rows.length === 1 ? "region" : "regions"} across every visit and every
          rep&rsquo;s plan and list — resolve
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
            className={cn(phxFieldClassName, "pl-8")}
          />
        </div>
      </div>

      {toast && (
        <div className="flex items-center justify-between border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm font-medium text-emerald-800">
          {toast}
          <button type="button" onClick={() => setToast(null)} className="text-emerald-700 hover:text-emerald-900">Dismiss</button>
        </div>
      )}

      {/* Desktop keeps the seven-column punch list; mobile gets one card per region, brick-mapping
          control and all — AGENTS.md §4. Mirrors CrmUnmappedIdentitiesPanel exactly, as ever. */}
      <div className="border border-slate-200 bg-white">
        <PortalResponsiveDataList
          breakpoint="lg"
          empty={
            <p className="px-3 py-8 text-center text-sm text-slate-500">
              {rows.length === 0 ? "No unmapped CRM regions — every region maps to a brick." : "No regions match this search."}
            </p>
          }
          getKey={(region) => String(region.crmRegionId)}
          items={filtered}
          renderCard={(region) => (
            <PortalRecordCard
              accent="rose"
              actions={
                <>
                  <ResolutionCell region={region} onResolved={handleResolved} />
                  {isPlanOnly(region) ? null : (
                    <button
                      type="button"
                      onClick={() => viewInVisits(region)}
                      className="h-8 border border-phx-line bg-white px-2.5 text-xs font-bold text-phx-ink shadow-sm transition hover:border-phx-accent-line hover:text-phx-accent"
                    >
                      View in Visits
                    </button>
                  )}
                </>
              }
              meta={
                isPlanOnly(region)
                  ? `Never visited — ${planOnlyCustomersLabel(region)}`
                  : `CRM Region ID ${region.crmRegionId}`
              }
              status={<span className="text-sm font-black text-rose-500">{region.visitCount}</span>}
              title={region.crmRegionName}
            >
              <PortalRecordFields
                fields={[
                  { label: "Suggested brick", value: <SuggestionCell region={region} /> },
                  { label: "First seen", value: formatDate(region.firstSeen) },
                  { label: "Last seen", value: formatDate(region.lastSeen) },
                ]}
              />
            </PortalRecordCard>
          )}
          renderTable={() => (
            <PortalDesktopTable
              breakpoint="lg"
              cols={
                <colgroup>
                  <col className="w-[9%]" />
                  <col className="w-[15%]" />
                  <col className="w-[12%]" />
                  <col className="w-[10%]" />
                  <col className="w-[10%]" />
                  <col className="w-[16%]" />
                  <col className="w-[16%]" />
                  <col className="w-[12%]" />
                </colgroup>
              }
            >
              <thead className="bg-slate-900">
                <tr>
                  <th className="px-3 py-3 text-phx-sm font-black uppercase tracking-wider text-slate-300">CRM Region ID</th>
                  <th className="px-3 py-3 text-phx-sm font-black uppercase tracking-wider text-slate-300">CRM Region Name</th>
                  <th className="px-3 py-3 text-phx-sm font-black uppercase tracking-wider text-slate-300">Visits (all time)</th>
                  <th className="px-3 py-3 text-phx-sm font-black uppercase tracking-wider text-slate-300">First Seen</th>
                  <th className="px-3 py-3 text-phx-sm font-black uppercase tracking-wider text-slate-300">Last Seen</th>
                  <th className="border-l border-slate-700 px-3 py-3 text-phx-sm font-black uppercase tracking-wider text-slate-300">
                    Suggested Brick
                  </th>
                  <th className="px-3 py-3 text-phx-sm font-black uppercase tracking-wider text-slate-300">Resolution</th>
                  <th className="px-3 py-3 text-phx-sm font-black uppercase tracking-wider text-slate-300">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-orange-100">
                {filtered.map((region) => (
                  <tr key={region.crmRegionId} className="odd:bg-white even:bg-orange-50/30">
                    <td className="break-words px-3 py-2.5 font-semibold text-slate-700">{regionIdLabel(region)}</td>
                    <td className="px-3 py-2.5 font-medium text-slate-900">{region.crmRegionName}</td>
                    <td className="px-3 py-2.5 font-semibold text-rose-500">
                      {region.visitCount}
                      {isPlanOnly(region) ? (
                        <span className="block text-phx-xs font-medium text-slate-500">
                          Never visited — {planOnlyCustomersLabel(region)}
                        </span>
                      ) : null}
                    </td>
                    <td className="break-words px-3 py-2.5">{formatDate(region.firstSeen)}</td>
                    <td className="break-words px-3 py-2.5">{formatDate(region.lastSeen)}</td>
                    <td className="border-l border-slate-100 px-3 py-2.5">
                      <SuggestionCell region={region} />
                    </td>
                    <td className="px-3 py-2.5">
                      <ResolutionCell region={region} onResolved={handleResolved} />
                    </td>
                    <td className="break-words px-3 py-2.5">
                      {isPlanOnly(region) ? (
                        <span className="text-xs text-slate-400">No visits to open</span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => viewInVisits(region)}
                          className="h-8 border border-phx-line bg-white px-2.5 text-xs font-bold text-phx-ink shadow-sm transition hover:border-phx-accent-line hover:text-phx-accent"
                        >
                          View in Visits
                        </button>
                      )}
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
