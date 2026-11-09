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
import type { CrmCustomerResolutionAction, UnmappedCrmCustomerRow } from "@/lib/crm/customer-brick";
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

/** Download-template + upload-mapping toolbar: round-trips the FULL customer list (not just
 * unmapped ones — mapped/ignored customers are included pre-filled so a bulk correction pass is
 * possible too), one level finer than the Region Mapping tab's own toolbar. */
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
      const response = await fetch("/api/admin/crm/customer-mapping/import", { method: "POST", body: formData });
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
        href="/api/admin/crm/customer-mapping/template"
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
        Download every CRM customer (mapped + unmapped), fill in Brick IDs in Excel, re-upload — bulk corrections apply in one pass.
      </p>
      {error && <p className="w-full text-phx-xs font-medium text-rose-600">{error}</p>}
    </div>
  );
}

const RESOLUTION_OPTIONS: Array<{ label: string; value: CrmCustomerResolutionAction }> = [
  { label: "Keep Pending", value: "pending" },
  { label: "Ignore (never map)", value: "ignored" },
  { label: "Map to Brick ID…", value: "mapped" },
];

// DATE-ONLY (`firstSeen`/`lastSeen`: min/max of the visits' `visit_date`, or the contact master's
// `first_seen_on`/`last_visited_on` for a customer with no visit — all `date` columns, not the vendor's
// timestamptz), which `new Date` parses as UTC midnight. UTC here is CORRECT and must stay: it is what
// stops the calendar day being shifted by a zone offset. Not an instant — do not "fix" this one to
// Cairo. Blank when the contact master holds no date at all.
function formatDate(value: string) {
  if (!value) return "—";
  return formatStableEnGb(new Date(value), { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
}

/** A customer only on a rep's plan or doctor list has no visit to count or open in the Visits tab. */
function isNeverVisited(customer: UnmappedCrmCustomerRow) {
  return customer.visitCount === 0;
}

function visitCountLabel(customer: UnmappedCrmCustomerRow) {
  if (!isNeverVisited(customer)) return customer.visitCount.toLocaleString("en-GB");
  if (customer.source === "plan") return "Never visited — on a rep's plan";
  if (customer.source === "list") return "Never visited — on a rep's list";
  return "No visit on record";
}

function ResolutionCell({
  customer,
  onResolved,
}: {
  customer: UnmappedCrmCustomerRow;
  onResolved: (crmContactId: number, message: string) => void;
}) {
  const [action, setAction] = useState<CrmCustomerResolutionAction>("pending");
  const [brickIdInput, setBrickIdInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const trimmedBrickId = brickIdInput.trim();
    if (action === "mapped" && !trimmedBrickId) {
      setError("Enter a brick ID to map this customer.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/crm/resolve-customer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          brickId: action === "mapped" ? trimmedBrickId : undefined,
          crmContactId: customer.crmContactId,
          crmContactName: customer.crmContactName,
        }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        setError(payload.message ?? "Failed to save.");
        return;
      }
      const message =
        action === "mapped"
          ? `Mapped "${customer.crmContactName}" to brick ${payload.brickId} (area ${payload.areaId ?? "—"}, region ${payload.regionId ?? "—"}).`
          : action === "ignored"
            ? `Marked "${customer.crmContactName}" as ignored — hidden from this list.`
            : `Kept "${customer.crmContactName}" pending.`;
      onResolved(customer.crmContactId, message);
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
            setAction(event.target.value as CrmCustomerResolutionAction);
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

/** Punch-list of every CRM customer/contact (a doctor/pharmacy/hospital that was visited, or is only on
 * a rep's plan or doctor list) that has no real Phoenix brick from EITHER map — a contact its mapped
 * CRM locality already places is counted in the header, not listed (getCrmCustomerMappingPunchList).
 * An admin resolves each one as Ignored (hide it — e.g. a duplicate or
 * CRM-side artifact), Map to Brick ID (assign the real source_of_sales_bricks brick, validated
 * server-side against the CURRENT brick master), or Keep Pending. Mirrors CrmRegionMappingPanel's
 * UX exactly — same resolve/hide/toast pattern, different key (crm_contact_id) and one level finer
 * than region (a region groups many customers; a customer mapping is the most precise Phoenix can
 * resolve, and wins over its region's mapping wherever both exist). */
export function CrmCustomerMappingPanel({
  customers,
  ignoredCount,
  localityCount,
  mappedCount,
  pathname,
}: {
  customers: UnmappedCrmCustomerRow[];
  ignoredCount: number;
  localityCount: number;
  mappedCount: number;
  pathname: string;
}) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  // Derived from the `customers` prop (not copied into local state) so a server refresh — triggered
  // after a bulk upload — actually reaches this list. Single-row resolves apply optimistically via
  // `removedIds` until the next server refresh supersedes them with the authoritative list.
  const [removedIds, setRemovedIds] = useState<Set<number>>(new Set());
  const [toast, setToast] = useState<string | null>(null);
  const [importSummary, setImportSummary] = useState<ImportSummary | null>(null);

  const rows = customers.filter((customer) => !removedIds.has(customer.crmContactId));

  function handleResolved(crmContactId: number, message: string) {
    setRemovedIds((current) => new Set(current).add(crmContactId));
    setToast(message);
  }

  function handleImported(summary: ImportSummary) {
    setImportSummary(summary);
    setToast(summary.message);
    setRemovedIds(new Set());
    router.refresh(); // re-fetch getCrmCustomerMappingPunchList() server-side so the list drops newly-resolved rows
  }

  const term = search.trim().toLowerCase();
  const filtered = term
    ? rows.filter((customer) => customer.crmContactName.toLowerCase().includes(term) || String(customer.crmContactId).includes(term))
    : rows;

  function viewInVisits(customer: UnmappedCrmCustomerRow) {
    const params = new URLSearchParams({
      dataset: "visits",
      dateFrom: customer.firstSeen,
      dateTo: customer.lastSeen,
      search: customer.crmContactName,
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
          <span className="font-semibold text-slate-900">{mappedCount.toLocaleString("en-GB")}</span> mapped here ·{" "}
          <span className="font-semibold text-slate-900">{localityCount.toLocaleString("en-GB")}</span> placed through their
          CRM locality (Region Mapping tab) · <span className="font-semibold text-slate-900">{ignoredCount.toLocaleString("en-GB")}</span>{" "}
          ignored · <span className="font-semibold text-rose-600">{rows.length.toLocaleString("en-GB")}</span> still{" "}
          {rows.length === 1 ? "needs" : "need"} a brick, across every visit and every rep&rsquo;s plan and list — resolve each one as{" "}
          <span className="font-semibold text-slate-900">Ignore</span> (hide it, never map),{" "}
          <span className="font-semibold text-slate-900">Map to Brick ID</span> (assign the real Phoenix brick), or{" "}
          <span className="font-semibold text-slate-900">Keep Pending</span>.
        </p>
        <div className="relative w-64">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by CRM contact name or ID…"
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

      {/* Desktop keeps the seven-column punch list; mobile gets one card per customer, brick-mapping
          control and all — AGENTS.md §4. Mirrors CrmRegionMappingPanel exactly, as ever. */}
      <div className="border border-slate-200 bg-white">
        <PortalResponsiveDataList
          empty={
            <p className="px-3 py-8 text-center text-sm text-slate-500">
              {rows.length === 0
                ? "Every CRM customer has a brick — mapped here or through its CRM locality."
                : "No customers match this search."}
            </p>
          }
          getKey={(customer) => String(customer.crmContactId)}
          items={filtered}
          renderCard={(customer) => (
            <PortalRecordCard
              accent="rose"
              actions={
                <>
                  <ResolutionCell customer={customer} onResolved={handleResolved} />
                  {!isNeverVisited(customer) && (
                    <button
                      type="button"
                      onClick={() => viewInVisits(customer)}
                      className="h-8 border border-phx-line bg-white px-2.5 text-xs font-bold text-phx-ink shadow-sm transition hover:border-phx-accent-line hover:text-phx-accent"
                    >
                      View in Visits
                    </button>
                  )}
                </>
              }
              meta={`CRM Contact ID ${customer.crmContactId}`}
              status={
                <span className={isNeverVisited(customer) ? "text-xs font-bold text-slate-500" : "text-sm font-black text-rose-500"}>
                  {visitCountLabel(customer)}
                </span>
              }
              title={customer.crmContactName}
            >
              <PortalRecordFields
                fields={[
                  { label: "First seen", value: formatDate(customer.firstSeen) },
                  { label: "Last seen", value: formatDate(customer.lastSeen) },
                ]}
              />
            </PortalRecordCard>
          )}
          renderTable={() => (
            <PortalDesktopTable
              cols={
                <colgroup>
                  <col className="w-[9%]" />
                  <col className="w-[20%]" />
                  <col className="w-[12%]" />
                  <col className="w-[10%]" />
                  <col className="w-[10%]" />
                  <col className="w-[27%]" />
                  <col className="w-[12%]" />
                </colgroup>
              }
            >
              <thead className="bg-slate-900">
                <tr>
                  <th className="px-3 py-3 text-phx-sm font-black uppercase tracking-wider text-slate-300">CRM Contact ID</th>
                  <th className="px-3 py-3 text-phx-sm font-black uppercase tracking-wider text-slate-300">CRM Contact Name</th>
                  <th className="px-3 py-3 text-phx-sm font-black uppercase tracking-wider text-slate-300">Visits (all time)</th>
                  <th className="px-3 py-3 text-phx-sm font-black uppercase tracking-wider text-slate-300">First Seen</th>
                  <th className="px-3 py-3 text-phx-sm font-black uppercase tracking-wider text-slate-300">Last Seen</th>
                  <th className="px-3 py-3 text-phx-sm font-black uppercase tracking-wider text-slate-300">Resolution</th>
                  <th className="px-3 py-3 text-phx-sm font-black uppercase tracking-wider text-slate-300">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-orange-100">
                {filtered.map((customer) => (
                  <tr key={customer.crmContactId} className="odd:bg-white even:bg-orange-50/30">
                    <td className="break-words px-3 py-2.5 font-semibold text-slate-700">{customer.crmContactId}</td>
                    <td className="px-3 py-2.5 font-medium text-slate-900">{customer.crmContactName}</td>
                    <td className={isNeverVisited(customer) ? "px-3 py-2.5 text-xs font-semibold text-slate-500" : "break-words px-3 py-2.5 font-semibold text-rose-500"}>
                      {visitCountLabel(customer)}
                    </td>
                    <td className="break-words px-3 py-2.5">{formatDate(customer.firstSeen)}</td>
                    <td className="break-words px-3 py-2.5">{formatDate(customer.lastSeen)}</td>
                    <td className="px-3 py-2.5">
                      <ResolutionCell customer={customer} onResolved={handleResolved} />
                    </td>
                    <td className="break-words px-3 py-2.5">
                      {isNeverVisited(customer) ? (
                        <span className="text-xs text-slate-400">No visits to open</span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => viewInVisits(customer)}
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
