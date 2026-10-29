"use client";

import { useState, useCallback } from "react";
import { ExportXlsxButton } from "@/components/ui/export-xlsx-button";
import { AlertTriangle, ChevronDown, ChevronUp, RefreshCw, X } from "lucide-react";
import { cairoDate } from "@/lib/format/cairo-datetime";
import type { ReportItKpis } from "@/lib/report-it/service";
import type { ReportItReportRow } from "@/lib/report-it/types";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  phxFieldClassName,
  phxLabelClassName,
} from "@/components/ui/form-tokens";


// ─── Premium primitives (square corners, slate + orange) ─────────────────────

const fieldClass  = phxFieldClassName;
const selectClass = `${fieldClass} cursor-pointer`;
const microLabel = phxLabelClassName;

const btnGhost =
  "inline-flex items-center gap-1.5 border border-slate-300 bg-white px-4 py-2 text-sm font-bold text-slate-700 transition hover:bg-slate-100 disabled:pointer-events-none disabled:opacity-40";
const btnDark =
  "inline-flex items-center gap-1.5 border border-slate-900 bg-slate-900 px-5 py-2 text-sm font-bold text-white transition hover:bg-slate-800 disabled:pointer-events-none disabled:opacity-50";

function SeriousChip({ serious }: { serious: boolean }) {
  return serious ? (
    <span className="inline-block border border-rose-300 bg-rose-50 px-2 py-0.5 text-phx-xs font-bold text-rose-700">
      Serious
    </span>
  ) : (
    <span className="inline-block border border-slate-200 bg-slate-50 px-2 py-0.5 text-phx-xs font-bold text-slate-500">
      No
    </span>
  );
}

// ─── KPI Card ─────────────────────────────────────────────────────────────────

function KpiCard({ label, value, highlight }: { label: string; value: number; highlight?: boolean }) {
  const hot = Boolean(highlight) && value > 0;
  return (
    <div className="border border-slate-200 bg-white">
      <div className={["h-1", hot ? "bg-rose-600" : "bg-slate-900"].join(" ")} />
      <div className="p-4">
        <p className="text-phx-xs font-black uppercase tracking-wide text-slate-500">{label}</p>
        <p className={["mt-1 text-2xl font-black tabular-nums", hot ? "text-rose-600" : "text-slate-900"].join(" ")}>
          {value.toLocaleString()}
        </p>
      </div>
    </div>
  );
}

// ─── Detail Drawer ─────────────────────────────────────────────────────────────

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  if (!value && value !== 0) return null;
  return (
    <div className="flex gap-3 text-sm">
      <span className="w-40 shrink-0 pt-0.5 text-phx-xs font-black uppercase tracking-wide text-slate-400">
        {label}
      </span>
      <span className="flex-1 font-semibold text-slate-800">{value}</span>
    </div>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <p className="border-b border-slate-200 pb-1 text-phx-xs font-black uppercase tracking-wide text-slate-500">
      {children}
    </p>
  );
}

function ReportDetailDrawer({ report, onClose }: { report: ReportItReportRow; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-end">
      <div className="fixed inset-0 bg-black/40" onClick={onClose} />
      <div className="relative z-10 h-full w-full max-w-xl overflow-y-auto border-l border-slate-200 bg-white shadow-xl">
        {/* Dark command header */}
        <div className="flex items-start justify-between bg-slate-900 px-5 py-4">
          <div>
            <p className="text-phx-2xs font-black uppercase tracking-[0.25em] text-orange-400">Report Detail</p>
            <p className="mt-0.5 font-mono text-base font-black text-white">{report.report_number}</p>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-slate-400 transition hover:text-white"
            aria-label="Close detail"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-5 p-5">
          <div className="space-y-2">
            <SectionHeading>Submitter</SectionHeading>
            <DetailRow label="HR ID" value={report.submitted_by_hr_id} />
            <DetailRow label="Name" value={report.submitted_by_name} />
            <DetailRow label="Role" value={report.submitted_by_role} />
            <DetailRow label="Department" value={report.department} />
            <DetailRow label="Line" value={report.line} />
            <DetailRow label="Area" value={report.area} />
            <DetailRow label="Submitted" value={new Date(report.created_at).toLocaleString()} />
          </div>

          <div className="space-y-2">
            <SectionHeading>Patient</SectionHeading>
            <DetailRow label="Initials" value={report.patient_initials} />
            <DetailRow label="Sex" value={report.patient_sex} />
            <DetailRow label="Country" value={report.patient_country} />
          </div>

          <div className="space-y-2">
            <SectionHeading>Reactions</SectionHeading>
            {report.reactions_summary.length > 0 ? (
              <ul className="list-inside list-disc space-y-1 text-sm font-semibold text-slate-800">
                {report.reactions_summary.map((r, i) => <li key={i}>{r}</li>)}
              </ul>
            ) : (
              <p className="text-sm text-slate-400">—</p>
            )}
            <DetailRow label="Serious" value={<SeriousChip serious={report.is_serious} />} />
            <DetailRow label="Outcome" value={report.outcome_summary} />
          </div>

          {report.suspected_medicines.length > 0 && (
            <div className="space-y-2">
              <SectionHeading>Suspected Medicines</SectionHeading>
              <div className="flex flex-wrap gap-1.5">
                {report.suspected_medicines.map((m, i) => (
                  <span
                    key={i}
                    className="inline-block border border-amber-300 bg-amber-50 px-2 py-0.5 text-phx-xs font-bold text-amber-800"
                  >
                    {m}
                  </span>
                ))}
              </div>
            </div>
          )}

          {(report.report_payload.currentIllnesses || report.report_payload.additionalComments) && (
            <div className="space-y-2">
              <SectionHeading>Additional Info</SectionHeading>
              {report.report_payload.currentIllnesses && (
                <DetailRow label="Current illnesses" value={report.report_payload.currentIllnesses} />
              )}
              {report.report_payload.additionalComments && (
                <DetailRow label="Comments" value={report.report_payload.additionalComments} />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Filters ───────────────────────────────────────────────────────────────────

type Filters = {
  submittedBy: string;
  isSerious: string;
  dateFrom: string;
  dateTo: string;
  department: string;
};

function emptyFilters(): Filters {
  return { submittedBy: "", isSerious: "", dateFrom: "", dateTo: "", department: "" };
}

// ─── Export helpers ────────────────────────────────────────────────────────────

const EXPORT_COLUMNS = [
  { key: "report_number", label: "Report Number", width: 18 },
  { key: "submitted_at", label: "Submitted", width: 20 },
  { key: "submitted_by_hr_id", label: "HR ID", width: 12 },
  { key: "submitted_by_name", label: "Submitted By", width: 22 },
  { key: "department", label: "Department", width: 18 },
  { key: "line", label: "Line", width: 14 },
  { key: "patient_initials", label: "Patient Initials", width: 16 },
  { key: "patient_sex", label: "Sex", width: 10 },
  { key: "is_serious", label: "Serious", width: 10 },
  { key: "outcome_summary", label: "Outcome", width: 28 },
  { key: "reactions", label: "Reactions", width: 36 },
  { key: "suspected_medicines", label: "Suspected Medicines", width: 36 },
];

function rowToExport(r: ReportItReportRow) {
  return {
    report_number: r.report_number,
    submitted_at: new Date(r.created_at).toLocaleString(),
    submitted_by_hr_id: r.submitted_by_hr_id ?? "",
    submitted_by_name: r.submitted_by_name ?? "",
    department: r.department ?? "",
    line: r.line ?? "",
    patient_initials: r.patient_initials ?? "",
    patient_sex: r.patient_sex ?? "",
    is_serious: r.is_serious ? "Yes" : "No",
    outcome_summary: r.outcome_summary ?? "",
    reactions: r.reactions_summary.join("; "),
    suspected_medicines: r.suspected_medicines.join("; "),
  };
}

// ─── Main component ────────────────────────────────────────────────────────────

type Props = {
  kpis: ReportItKpis;
  initialRows: ReportItReportRow[];
  initialTotal: number;
};

const LIMIT = 50;

export function ReportItAdminDashboard({ kpis, initialRows, initialTotal }: Props) {
  const [rows, setRows] = useState(initialRows);
  const [total, setTotal] = useState(initialTotal);
  const [offset, setOffset] = useState(0);
  const [filters, setFilters] = useState<Filters>(emptyFilters());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReportItReportRow | null>(null);
  const [showFilters, setShowFilters] = useState(false);

  const fetchReports = useCallback(async (f: Filters, off: number) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: String(LIMIT), offset: String(off) });
      if (f.submittedBy) params.set("submittedBy", f.submittedBy);
      if (f.isSerious === "true" || f.isSerious === "false") params.set("isSerious", f.isSerious);
      if (f.dateFrom) params.set("dateFrom", f.dateFrom);
      if (f.dateTo) params.set("dateTo", f.dateTo);
      if (f.department) params.set("department", f.department);

      const res = await fetch(`/api/report-it/list?${params.toString()}`);
      const data = (await res.json()) as { rows?: ReportItReportRow[]; total?: number; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Failed to load reports.");
      setRows(data.rows ?? []);
      setTotal(data.total ?? 0);
      setOffset(off);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load reports.");
    } finally {
      setLoading(false);
    }
  }, []);

  const applyFilters = () => { void fetchReports(filters, 0); };
  const clearFilters = () => {
    const f = emptyFilters();
    setFilters(f);
    void fetchReports(f, 0);
  };

  const hasMore = offset + LIMIT < total;
  const hasPrev = offset > 0;

  return (
    <div className="space-y-5">
      {/* KPIs */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiCard label="Total Reports" value={kpis.total} />
        <KpiCard label="Serious" value={kpis.serious} highlight />
        <KpiCard label="This Month" value={kpis.thisMonth} />
        <KpiCard label="With Suspected Medicine" value={kpis.withSuspectedMedicine} />
      </div>

      {/* Filter bar */}
      <div className="border border-slate-200 bg-white">
        <button
          type="button"
          className="flex w-full items-center justify-between px-4 py-3 text-phx-xs font-black uppercase tracking-wide text-slate-700 transition hover:bg-slate-50"
          onClick={() => setShowFilters((v) => !v)}
        >
          <span>Filters</span>
          {showFilters ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>

        {showFilters && (
          <div className="grid grid-cols-1 gap-3 border-t border-slate-200 px-4 pb-4 pt-4 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <label className={microLabel}>Submitted by (HR ID or name)</label>
              <input
                value={filters.submittedBy}
                onChange={(e) => setFilters((f) => ({ ...f, submittedBy: e.target.value }))}
                placeholder="Search…"
                className={fieldClass}
              />
            </div>
            <div>
              <label className={microLabel}>Seriousness</label>
              <SearchableSelect
                value={filters.isSerious}
                onChange={(e) => setFilters((f) => ({ ...f, isSerious: e.target.value }))}
                className={selectClass}
              >
                <option value="">All</option>
                <option value="true">Serious only</option>
                <option value="false">Non-serious only</option>
              </SearchableSelect>
            </div>
            <div>
              <label className={microLabel}>Department</label>
              <input
                value={filters.department}
                onChange={(e) => setFilters((f) => ({ ...f, department: e.target.value }))}
                placeholder="Filter by department"
                className={fieldClass}
              />
            </div>
            <div>
              <label className={microLabel}>From date</label>
              <input
                type="date"
                value={filters.dateFrom}
                onChange={(e) => setFilters((f) => ({ ...f, dateFrom: e.target.value }))}
                className={fieldClass}
              />
            </div>
            <div>
              <label className={microLabel}>To date</label>
              <input
                type="date"
                value={filters.dateTo}
                onChange={(e) => setFilters((f) => ({ ...f, dateTo: e.target.value }))}
                className={fieldClass}
              />
            </div>
            <div className="flex items-end gap-2">
              <button type="button" className={btnDark} onClick={applyFilters} disabled={loading}>
                {loading && <RefreshCw className="h-3.5 w-3.5 animate-spin" />}
                Apply
              </button>
              <button type="button" className={btnGhost} onClick={clearFilters}>Clear</button>
            </div>
          </div>
        )}
      </div>

      {/* Table toolbar */}
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-semibold text-slate-600">
          {loading ? "Loading…" : `${total.toLocaleString()} report${total !== 1 ? "s" : ""}`}
        </p>
        <ExportXlsxButton
          title="Pharmacovigilance Reports"
          // Cairo-pinned via the shared formatter, not the runtime's own zone: this used to be
          // `new Date().toLocaleDateString()` with no timeZone, which renders in whichever zone
          // the RUNTIME happens to be in. This prop is only read inside ExportXlsxButton's click
          // handler (never rendered to the DOM), so unlike admin-profile-form.tsx it can't throw
          // a React hydration error — but the exported file's "Exported" date still shouldn't
          // depend on the caller's own zone rather than Phoenix's Cairo business date.
          subtitle={`Exported ${cairoDate(new Date().toISOString())}`}
          sheetName="Reports"
          columns={EXPORT_COLUMNS}
          rows={rows.map(rowToExport)}
        />
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-center gap-2 border border-rose-300 bg-rose-50 px-3 py-2 text-sm font-bold text-rose-800">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {/* Table — black header, thin light-orange grid */}
      <div className="border border-slate-200">
        <table className="hidden w-full table-fixed border-collapse text-sm md:table">
          <colgroup>
            <col className="w-[13%]" />
            <col className="w-[11%]" />
            <col className="w-[17%]" />
            <col className="w-[12%]" />
            <col className="w-[22%]" />
            <col className="w-[9%]" />
            <col className="w-[16%]" />
          </colgroup>
          <thead>
            <tr className="bg-slate-900 text-left text-phx-xs font-black uppercase tracking-wide text-white">
              <th className="px-3 py-2.5">Report #</th>
              <th className="px-3 py-2.5">Date</th>
              <th className="px-3 py-2.5">Submitted By</th>
              <th className="px-3 py-2.5">Patient</th>
              <th className="px-3 py-2.5">Reactions</th>
              <th className="px-3 py-2.5">Serious</th>
              <th className="px-3 py-2.5">Outcome</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && !loading && (
              <tr>
                <td colSpan={7} className="px-3 py-10 text-center text-sm font-semibold text-slate-500">
                  No reports found.
                </td>
              </tr>
            )}
            {rows.map((row) => (
              <tr
                key={row.id}
                className="cursor-pointer border-t border-orange-100 bg-white transition hover:bg-orange-50/60"
                onClick={() => setSelected(row)}
              >
                <td className="break-words px-3 py-2 font-mono text-xs font-bold text-orange-600">{row.report_number}</td>
                <td className="break-words px-3 py-2 text-xs text-slate-500">
                  {new Date(row.created_at).toLocaleDateString()}
                </td>
                <td className="break-words px-3 py-2 text-sm font-bold text-slate-900">{row.submitted_by_name ?? "—"}</td>
                <td className="break-words px-3 py-2 text-xs text-slate-700">
                  {row.patient_initials ?? "—"}
                  {row.patient_sex && <span className="ml-1 text-slate-500">({row.patient_sex})</span>}
                </td>
                <td className="break-words px-3 py-2 text-xs text-slate-700">{row.reactions_summary.join(", ") || "—"}</td>
                <td className="px-3 py-2">
                  <SeriousChip serious={row.is_serious} />
                </td>
                <td className="break-words px-3 py-2 text-xs text-slate-700">{row.outcome_summary ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="divide-y divide-orange-100 md:hidden">
          {rows.length === 0 && !loading && (
            <p className="px-3 py-10 text-center text-sm font-semibold text-slate-500">No reports found.</p>
          )}
          {rows.map((row) => (
            <button
              key={row.id}
              type="button"
              className="block w-full min-w-0 break-words bg-white px-3 py-3 text-left text-xs text-slate-700"
              onClick={() => setSelected(row)}
            >
              <span className="flex items-center justify-between gap-2">
                <span className="font-mono font-bold text-orange-600">{row.report_number}</span>
                <SeriousChip serious={row.is_serious} />
              </span>
              <span className="mt-1 block text-sm font-bold text-slate-900">{row.submitted_by_name ?? "—"}</span>
              <span className="block text-slate-500">{new Date(row.created_at).toLocaleDateString()}</span>
              <span className="block">Patient: {row.patient_initials ?? "—"}{row.patient_sex ? ` (${row.patient_sex})` : ""}</span>
              <span className="block">Reactions: {row.reactions_summary.join(", ") || "—"}</span>
              <span className="block">Outcome: {row.outcome_summary ?? "—"}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Pagination */}
      {(hasPrev || hasMore) && (
        <div className="flex items-center justify-between text-sm">
          <button
            type="button"
            className={btnGhost}
            onClick={() => { void fetchReports(filters, offset - LIMIT); }}
            disabled={!hasPrev || loading}
          >
            Previous
          </button>
          <span className="text-xs font-semibold text-slate-500">
            {offset + 1}–{Math.min(offset + LIMIT, total)} of {total}
          </span>
          <button
            type="button"
            className={btnGhost}
            onClick={() => { void fetchReports(filters, offset + LIMIT); }}
            disabled={!hasMore || loading}
          >
            Next
          </button>
        </div>
      )}

      {/* Detail drawer */}
      {selected && (
        <ReportDetailDrawer report={selected} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}
