"use client";

import { useState, useCallback } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ExportXlsxButton } from "@/components/ui/export-xlsx-button";
import { AlertTriangle, ChevronDown, ChevronUp, RefreshCw, X } from "lucide-react";
import type { ReportItKpis } from "@/lib/report-it/service";
import type { ReportItReportRow } from "@/lib/report-it/types";

// ─── KPI Card ─────────────────────────────────────────────────────────────────

function KpiCard({ label, value, highlight }: { label: string; value: number; highlight?: boolean }) {
  return (
    <div className={["border p-4 space-y-1", highlight ? "border-warning bg-warning/5" : "bg-card"].join(" ")}>
      <p className="text-xs text-text-secondary font-medium uppercase tracking-wide">{label}</p>
      <p className={["text-2xl font-bold tabular-nums", highlight ? "text-warning" : ""].join(" ")}>
        {value.toLocaleString()}
      </p>
    </div>
  );
}

// ─── Detail Drawer ─────────────────────────────────────────────────────────────

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  if (!value && value !== 0) return null;
  return (
    <div className="flex gap-3 text-sm">
      <span className="text-text-secondary w-40 shrink-0">{label}</span>
      <span className="flex-1">{value}</span>
    </div>
  );
}

function ReportDetailDrawer({ report, onClose }: { report: ReportItReportRow; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-end">
      <div className="fixed inset-0 bg-black/30" onClick={onClose} />
      <div className="relative z-10 h-full w-full max-w-xl bg-bg border-l shadow-xl overflow-y-auto p-6 space-y-5">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-base font-semibold">Report Detail</h2>
            <p className="text-xs text-text-secondary font-mono mt-0.5">{report.report_number}</p>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-bg-muted">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-text-secondary border-b pb-1">Submitter</p>
          <DetailRow label="HR ID" value={report.submitted_by_hr_id} />
          <DetailRow label="Name" value={report.submitted_by_name} />
          <DetailRow label="Role" value={report.submitted_by_role} />
          <DetailRow label="Department" value={report.department} />
          <DetailRow label="Line" value={report.line} />
          <DetailRow label="Area" value={report.area} />
          <DetailRow label="Submitted" value={new Date(report.created_at).toLocaleString()} />
        </div>

        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-text-secondary border-b pb-1">Patient</p>
          <DetailRow label="Initials" value={report.patient_initials} />
          <DetailRow label="Sex" value={report.patient_sex} />
          <DetailRow label="Country" value={report.patient_country} />
        </div>

        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-text-secondary border-b pb-1">Reactions</p>
          {report.reactions_summary.length > 0 ? (
            <ul className="list-disc list-inside text-sm space-y-1">
              {report.reactions_summary.map((r, i) => <li key={i}>{r}</li>)}
            </ul>
          ) : (
            <p className="text-sm text-text-secondary">—</p>
          )}
          <DetailRow
            label="Serious"
            value={report.is_serious ? <Badge variant="danger">Yes — Serious</Badge> : <Badge variant="neutral">No</Badge>}
          />
          <DetailRow label="Outcome" value={report.outcome_summary} />
        </div>

        {report.suspected_medicines.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-text-secondary border-b pb-1">Suspected Medicines</p>
            <div className="flex flex-wrap gap-1">
              {report.suspected_medicines.map((m, i) => (
                <Badge key={i} variant="warning">{m}</Badge>
              ))}
            </div>
          </div>
        )}

        {(report.report_payload.currentIllnesses || report.report_payload.additionalComments) && (
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-text-secondary border-b pb-1">Additional Info</p>
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

const fieldClass = "w-full rounded border border-border bg-card px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30";

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
    <div className="space-y-6">
      {/* KPIs */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <KpiCard label="Total Reports" value={kpis.total} />
        <KpiCard label="Serious" value={kpis.serious} highlight={kpis.serious > 0} />
        <KpiCard label="This Month" value={kpis.thisMonth} />
        <KpiCard label="With Suspected Medicine" value={kpis.withSuspectedMedicine} />
      </div>

      {/* Filter bar */}
      <div className="border bg-card">
        <button
          type="button"
          className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium hover:bg-bg-muted/50 transition"
          onClick={() => setShowFilters((v) => !v)}
        >
          <span>Filters</span>
          {showFilters ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>

        {showFilters && (
          <div className="px-4 pb-4 border-t pt-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            <div>
              <label className="text-xs font-medium text-text-secondary block mb-1">Submitted by (HR ID or name)</label>
              <Input
                value={filters.submittedBy}
                onChange={(e) => setFilters((f) => ({ ...f, submittedBy: e.target.value }))}
                placeholder="Search…"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-text-secondary block mb-1">Seriousness</label>
              <select
                value={filters.isSerious}
                onChange={(e) => setFilters((f) => ({ ...f, isSerious: e.target.value }))}
                className={fieldClass}
              >
                <option value="">All</option>
                <option value="true">Serious only</option>
                <option value="false">Non-serious only</option>
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-text-secondary block mb-1">Department</label>
              <Input
                value={filters.department}
                onChange={(e) => setFilters((f) => ({ ...f, department: e.target.value }))}
                placeholder="Filter by department"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-text-secondary block mb-1">From date</label>
              <Input
                type="date"
                value={filters.dateFrom}
                onChange={(e) => setFilters((f) => ({ ...f, dateFrom: e.target.value }))}
              />
            </div>
            <div>
              <label className="text-xs font-medium text-text-secondary block mb-1">To date</label>
              <Input
                type="date"
                value={filters.dateTo}
                onChange={(e) => setFilters((f) => ({ ...f, dateTo: e.target.value }))}
              />
            </div>
            <div className="flex items-end gap-2">
              <Button onClick={applyFilters} disabled={loading}>
                {loading && <RefreshCw className="h-3.5 w-3.5 animate-spin mr-1" />}
                Apply
              </Button>
              <Button variant="secondary" onClick={clearFilters}>Clear</Button>
            </div>
          </div>
        )}
      </div>

      {/* Table toolbar */}
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-text-secondary">
          {loading ? "Loading…" : `${total.toLocaleString()} report${total !== 1 ? "s" : ""}`}
        </p>
        <ExportXlsxButton
          title="Pharmacovigilance Reports"
          subtitle={`Exported ${new Date().toLocaleDateString()}`}
          sheetName="Reports"
          columns={EXPORT_COLUMNS}
          rows={rows.map(rowToExport)}
        />
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-center gap-2 text-sm text-danger bg-danger/5 border border-danger/20 rounded px-3 py-2">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {/* Table */}
      <div className="overflow-x-auto border">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-[#0F172A] text-white">
              <th className="px-3 py-2.5 text-left font-medium text-xs">Report #</th>
              <th className="px-3 py-2.5 text-left font-medium text-xs">Date</th>
              <th className="px-3 py-2.5 text-left font-medium text-xs">Submitted By</th>
              <th className="px-3 py-2.5 text-left font-medium text-xs">Patient</th>
              <th className="px-3 py-2.5 text-left font-medium text-xs">Reactions</th>
              <th className="px-3 py-2.5 text-left font-medium text-xs">Serious</th>
              <th className="px-3 py-2.5 text-left font-medium text-xs">Outcome</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && !loading && (
              <tr>
                <td colSpan={7} className="text-center py-10 text-text-secondary text-sm">
                  No reports found.
                </td>
              </tr>
            )}
            {rows.map((row, i) => (
              <tr
                key={row.id}
                className={[
                  "border-b border-primary/10 cursor-pointer transition",
                  i % 2 === 0 ? "bg-white hover:bg-primary/5" : "bg-bg-muted/30 hover:bg-primary/5",
                ].join(" ")}
                onClick={() => setSelected(row)}
              >
                <td className="px-3 py-2 font-mono text-xs text-primary font-medium">{row.report_number}</td>
                <td className="px-3 py-2 text-xs text-text-secondary whitespace-nowrap">
                  {new Date(row.created_at).toLocaleDateString()}
                </td>
                <td className="px-3 py-2">
                  <span className="font-medium text-sm">{row.submitted_by_name ?? "—"}</span>
                  {row.submitted_by_hr_id && (
                    <span className="ml-1 text-xs text-text-secondary">({row.submitted_by_hr_id})</span>
                  )}
                </td>
                <td className="px-3 py-2 text-xs">
                  {row.patient_initials ?? "—"}
                  {row.patient_sex && <span className="ml-1 text-text-secondary">({row.patient_sex})</span>}
                </td>
                <td className="px-3 py-2 text-xs max-w-[180px]">
                  <span className="line-clamp-2">{row.reactions_summary.join(", ") || "—"}</span>
                </td>
                <td className="px-3 py-2">
                  {row.is_serious ? (
                    <Badge variant="danger">Yes</Badge>
                  ) : (
                    <Badge variant="neutral">No</Badge>
                  )}
                </td>
                <td className="px-3 py-2 text-xs max-w-[140px]">
                  <span className="line-clamp-1">{row.outcome_summary ?? "—"}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {(hasPrev || hasMore) && (
        <div className="flex items-center justify-between text-sm">
          <Button
            variant="secondary"
            onClick={() => { void fetchReports(filters, offset - LIMIT); }}
            disabled={!hasPrev || loading}
          >
            Previous
          </Button>
          <span className="text-text-secondary text-xs">
            {offset + 1}–{Math.min(offset + LIMIT, total)} of {total}
          </span>
          <Button
            variant="secondary"
            onClick={() => { void fetchReports(filters, offset + LIMIT); }}
            disabled={!hasMore || loading}
          >
            Next
          </Button>
        </div>
      )}

      {/* Detail drawer */}
      {selected && (
        <ReportDetailDrawer report={selected} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}
