"use client";

import { useState, useCallback } from "react";
import { AlertTriangle, ChevronDown, ChevronUp, ClipboardList, Plus, RefreshCw, X } from "lucide-react";
import { ExportXlsxButton } from "@/components/ui/export-xlsx-button";
import { cairoDate } from "@/lib/format/cairo-datetime";
import { ReportItForm } from "@/components/report-it/report-it-form";
import type { ReportItReportRow } from "@/lib/report-it/types";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  PortalDesktopTable,
  PortalEmptyState,
  PortalRecordCard,
  PortalRecordFields,
  PortalResponsiveDataList,
} from "@/components/employee-portal/portal-primitives";
import {
  phxFieldClassName,
  phxLabelClassName,
} from "@/components/ui/form-tokens";


// ─── Premium design language (square corners, slate-900/orange) ──────────────

const fieldClass  = phxFieldClassName;
const selectClass = `${fieldClass} cursor-pointer`;
const microLabel = phxLabelClassName;
const btnDark =
  "inline-flex items-center gap-1.5 border border-slate-900 bg-slate-900 px-5 py-2 text-sm font-bold text-white transition hover:bg-slate-800 disabled:pointer-events-none disabled:opacity-50";
const btnGhost =
  "inline-flex items-center gap-1.5 border border-slate-300 bg-white px-4 py-2 text-sm font-bold text-slate-700 transition hover:bg-slate-100 disabled:pointer-events-none disabled:opacity-40";
// `btnOrange` lived here for the removed hero's `New Report` button, whose job the `New Report` tab
// already did. Removing the hero left it referenced nowhere, and an unused constant fails lint.

type Tab = "reports" | "submit";

// ─── XLSX export — every field in the Report It form ─────────────────────────

const FULL_EXPORT_COLUMNS = [
  // Metadata
  { key: "report_number", label: "Report #", width: 18 },
  { key: "submitted_at", label: "Submitted", width: 22 },
  { key: "submitted_by_hr_id", label: "HR ID", width: 12 },
  { key: "submitted_by_name", label: "Submitted By", width: 22 },
  { key: "submitted_by_role", label: "Role", width: 20 },
  { key: "department", label: "Department", width: 18 },
  { key: "line", label: "Line", width: 14 },
  { key: "area", label: "Area", width: 14 },
  { key: "status", label: "Status", width: 12 },
  // Patient
  { key: "patient_initials", label: "Patient Initials", width: 16 },
  { key: "patient_sex", label: "Patient Sex", width: 12 },
  { key: "patient_country", label: "Country", width: 14 },
  { key: "is_pregnant", label: "Pregnant", width: 10 },
  { key: "is_lactating", label: "Lactating", width: 10 },
  { key: "patient_weight", label: "Weight", width: 12 },
  { key: "patient_dob", label: "Date of Birth", width: 16 },
  { key: "patient_age_at_reaction", label: "Age at Reaction", width: 16 },
  { key: "patient_age_unit", label: "Age Unit", width: 10 },
  // Reactions
  { key: "reactions_count", label: "# Reactions", width: 12 },
  { key: "is_serious", label: "Serious Case", width: 12 },
  { key: "reactions_detail", label: "Reactions Detail", width: 90 },
  { key: "outcome_summary", label: "Outcomes Summary", width: 36 },
  // Medicines
  { key: "medicines_count", label: "# Medicines", width: 12 },
  { key: "suspected_medicines", label: "Suspected Medicines", width: 36 },
  { key: "medicines_detail", label: "Medicines Detail", width: 90 },
  // Additional
  { key: "current_illnesses", label: "Current Illnesses", width: 40 },
  { key: "additional_comments", label: "Additional Comments", width: 50 },
];

function fmtDateParts(d: { day: string; month: string; year: string }) {
  if (!d.day && !d.month && !d.year) return "";
  return [d.day, d.month, d.year].filter(Boolean).join("/");
}

function rowToFullExport(r: ReportItReportRow) {
  const p = r.report_payload;

  const reactionsDetail = p.reactions
    .map((rx, i) => {
      const parts: string[] = [`${i + 1}. ${rx.symptom || "—"}`];
      if (rx.startDate.year) parts.push(`Start: ${fmtDateParts(rx.startDate)}`);
      if (rx.endDate.year) parts.push(`End: ${fmtDateParts(rx.endDate)}`);
      if (rx.duration && rx.durationUnit) parts.push(`Duration: ${rx.duration} ${rx.durationUnit}`);
      if (rx.outcome) parts.push(`Outcome: ${rx.outcome}`);
      if (rx.isSerious) parts.push(`Serious: ${rx.isSerious}`);
      if (rx.seriousnessReasons.length) parts.push(`Reasons: ${rx.seriousnessReasons.join(", ")}`);
      return parts.join(" | ");
    })
    .join("\n");

  const medicinesDetail = p.medicines
    .map((m, i) => {
      const parts: string[] = [
        `${i + 1}. ${m.name || "—"}${m.probablyCausingReaction ? " [SUSPECTED]" : ""}`,
      ];
      if (m.producer) parts.push(`Producer: ${m.producer}`);
      if (m.batchNumber) parts.push(`Batch: ${m.batchNumber}`);
      if (m.dosage) parts.push(`Dose: ${m.dosage}`);
      if (m.adminRoute) parts.push(`Route: ${m.adminRoute}`);
      if (m.startDate.year) parts.push(`Start: ${fmtDateParts(m.startDate)}`);
      if (m.endDate.year) parts.push(`End: ${fmtDateParts(m.endDate)}`);
      if (m.duration && m.durationUnit) parts.push(`Duration: ${m.duration} ${m.durationUnit}`);
      if (m.reasonForTaking) parts.push(`Reason: ${m.reasonForTaking}`);
      if (m.actionTaken) parts.push(`Action: ${m.actionTaken}`);
      return parts.join(" | ");
    })
    .join("\n");

  return {
    report_number: r.report_number,
    submitted_at: new Date(r.created_at).toLocaleString(),
    submitted_by_hr_id: r.submitted_by_hr_id ?? "",
    submitted_by_name: r.submitted_by_name ?? "",
    submitted_by_role: r.submitted_by_role ?? "",
    department: r.department ?? "",
    line: r.line ?? "",
    area: r.area ?? "",
    status: r.status,
    patient_initials: p.patientInitials || r.patient_initials || "",
    patient_sex: p.patientSex || r.patient_sex || "",
    patient_country: p.country || r.patient_country,
    is_pregnant: p.isPregnant ? "Yes" : "No",
    is_lactating: p.isLactating ? "Yes" : "No",
    patient_weight: p.weight || "",
    patient_dob: fmtDateParts(p.dateOfBirth),
    patient_age_at_reaction: p.ageAtReaction || "",
    patient_age_unit: p.ageUnit || "",
    reactions_count: String(p.reactions.length),
    is_serious: r.is_serious ? "Yes" : "No",
    reactions_detail: reactionsDetail,
    outcome_summary: r.outcome_summary ?? "",
    medicines_count: String(p.medicines.length),
    suspected_medicines: r.suspected_medicines.join("; "),
    medicines_detail: medicinesDetail,
    current_illnesses: p.currentIllnesses || "",
    additional_comments: p.additionalComments || "",
  };
}

// ─── Chips ────────────────────────────────────────────────────────────────────

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

// ─── Detail drawer (all payload fields) ──────────────────────────────────────

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
  const p = report.report_payload;
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
          <button onClick={onClose} className="p-1 text-slate-400 transition hover:text-white" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-5 p-5">
          {/* Submitter */}
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

          {/* Patient */}
          <div className="space-y-2">
            <SectionHeading>Patient Information</SectionHeading>
            <DetailRow label="Initials" value={p.patientInitials} />
            <DetailRow label="Sex" value={p.patientSex} />
            <DetailRow label="Pregnant" value={p.isPregnant ? "Yes" : "No"} />
            <DetailRow label="Lactating" value={p.isLactating ? "Yes" : "No"} />
            <DetailRow label="Weight" value={p.weight ? `${p.weight} kg` : undefined} />
            <DetailRow label="Date of Birth" value={fmtDateParts(p.dateOfBirth)} />
            <DetailRow
              label="Age at Reaction"
              value={p.ageAtReaction && p.ageUnit ? `${p.ageAtReaction} ${p.ageUnit}` : p.ageAtReaction}
            />
            <DetailRow label="Country" value={p.country} />
          </div>

          {/* Reactions */}
          <div className="space-y-3">
            <SectionHeading>Reactions ({p.reactions.length})</SectionHeading>
            {p.reactions.map((rx, i) => (
              <div key={rx.id} className="space-y-1.5 border border-slate-100 bg-slate-50 p-3">
                <p className="text-xs font-black uppercase text-slate-500">Reaction {i + 1}</p>
                <DetailRow label="Symptom" value={rx.symptom} />
                <DetailRow label="Start Date" value={fmtDateParts(rx.startDate)} />
                <DetailRow label="End Date" value={fmtDateParts(rx.endDate)} />
                <DetailRow
                  label="Duration"
                  value={rx.duration && rx.durationUnit ? `${rx.duration} ${rx.durationUnit}` : undefined}
                />
                <DetailRow label="Outcome" value={rx.outcome} />
                <DetailRow label="Serious" value={rx.isSerious} />
                {rx.seriousnessReasons.length > 0 && (
                  <div className="flex gap-3 text-sm">
                    <span className="w-40 shrink-0 text-phx-xs font-black uppercase tracking-wide text-slate-400">
                      Reasons
                    </span>
                    <div className="flex flex-1 flex-wrap gap-1">
                      {rx.seriousnessReasons.map((r, j) => (
                        <span
                          key={j}
                          className="border border-rose-200 bg-rose-50 px-1.5 py-0.5 text-phx-2xs font-bold text-rose-700"
                        >
                          {r}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Medicines */}
          <div className="space-y-3">
            <SectionHeading>Medicines ({p.medicines.length})</SectionHeading>
            {p.medicines.map((m, i) => (
              <div
                key={m.id}
                className={[
                  "space-y-1.5 border p-3",
                  m.probablyCausingReaction
                    ? "border-amber-200 bg-amber-50/60"
                    : "border-slate-100 bg-slate-50",
                ].join(" ")}
              >
                <div className="flex items-center justify-between">
                  <p className="text-xs font-black uppercase text-slate-500">Medicine {i + 1}</p>
                  {m.probablyCausingReaction && (
                    <span className="border border-amber-300 bg-amber-100 px-1.5 py-0.5 text-phx-2xs font-bold text-amber-800">
                      Probably Causing
                    </span>
                  )}
                </div>
                <DetailRow label="Name" value={m.name} />
                <DetailRow label="Producer" value={m.producer} />
                <DetailRow label="Batch Number" value={m.batchNumber} />
                <DetailRow label="Dosage" value={m.dosage} />
                <DetailRow label="Admin Route" value={m.adminRoute} />
                <DetailRow label="Start Date" value={fmtDateParts(m.startDate)} />
                <DetailRow label="End Date" value={fmtDateParts(m.endDate)} />
                <DetailRow
                  label="Duration"
                  value={m.duration && m.durationUnit ? `${m.duration} ${m.durationUnit}` : undefined}
                />
                <DetailRow label="Reason for Taking" value={m.reasonForTaking} />
                <DetailRow label="Action Taken" value={m.actionTaken} />
              </div>
            ))}
          </div>

          {/* Additional info */}
          {(p.currentIllnesses || p.additionalComments) && (
            <div className="space-y-2">
              <SectionHeading>Additional Information</SectionHeading>
              {p.currentIllnesses && <DetailRow label="Current Illnesses" value={p.currentIllnesses} />}
              {p.additionalComments && <DetailRow label="Comments" value={p.additionalComments} />}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Filter bar ───────────────────────────────────────────────────────────────

type Filters = { submittedBy: string; isSerious: string; dateFrom: string; dateTo: string; department: string };
function emptyFilters(): Filters {
  return { submittedBy: "", isSerious: "", dateFrom: "", dateTo: "", department: "" };
}

// ─── Main component ───────────────────────────────────────────────────────────

const LIMIT = 50;

type Props = {
  initialRows: ReportItReportRow[];
  initialTotal: number;
};

export function ReportItEmployeeDashboard({ initialRows, initialTotal }: Props) {
  const [tab, setTab] = useState<Tab>("reports");
  const [rows, setRows] = useState(initialRows);
  const [total, setTotal] = useState(initialTotal);
  const [offset, setOffset] = useState(0);
  const [filters, setFilters] = useState<Filters>(emptyFilters());
  const [showFilters, setShowFilters] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReportItReportRow | null>(null);

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
      if (!res.ok) throw new Error(data.error ?? "Failed to load.");
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

  const handleSubmitSuccess = useCallback(() => {
    setTab("reports");
    void fetchReports(emptyFilters(), 0);
  }, [fetchReports]);

  return (
    <div className="space-y-5">
      {/* 🔴 A SECOND DARK HERO USED TO STAND HERE, AND IT MUST NOT COME BACK.
          `EmployeePortalPageShell` already paints the navy command header for this page — the
          `Pharmacovigilance` badge, the title `Report It Dashboard` and the description — and this
          block repeated all three VERBATIM, so the page shipped with two stacked dark headers
          (owner, 2026-09-30: "fix the duplicated header on report it too"). Nothing was lost with
          it: its `New Report` button was itself a second copy of the `New Report` TAB below. */}

      {/* Tabs */}
      <div className="flex border-b border-slate-200">
        <button
          type="button"
          className={[
            "px-5 py-2.5 text-phx-xs font-black uppercase tracking-wide border-b-2 -mb-px transition",
            tab === "reports"
              ? "border-orange-500 text-orange-600"
              : "border-transparent text-slate-500 hover:text-slate-800",
          ].join(" ")}
          onClick={() => setTab("reports")}
        >
          <span className="flex items-center gap-1.5">
            <ClipboardList className="h-3.5 w-3.5" />
            All Reports {total > 0 && `(${total})`}
          </span>
        </button>
        <button
          type="button"
          className={[
            "px-5 py-2.5 text-phx-xs font-black uppercase tracking-wide border-b-2 -mb-px transition",
            tab === "submit"
              ? "border-orange-500 text-orange-600"
              : "border-transparent text-slate-500 hover:text-slate-800",
          ].join(" ")}
          onClick={() => setTab("submit")}
        >
          <span className="flex items-center gap-1.5">
            <Plus className="h-3.5 w-3.5" />
            New Report
          </span>
        </button>
      </div>

      {/* ── Submit tab ── */}
      {tab === "submit" && (
        <div>
          <div className="mb-4">
            <button type="button" className={btnGhost} onClick={() => setTab("reports")}>
              ← Back to All Reports
            </button>
          </div>
          <ReportItForm onSubmitSuccess={handleSubmitSuccess} />
        </div>
      )}

      {/* ── Reports tab ── */}
      {tab === "reports" && (
        <div className="space-y-4">
          {/* Filters */}
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
                  <button type="button" className={btnGhost} onClick={clearFilters}>
                    Clear
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Toolbar */}
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
              columns={FULL_EXPORT_COLUMNS}
              rows={rows.map(rowToFullExport)}
            />
          </div>

          {/* Error */}
          {error && (
            <div className="flex items-center gap-2 border border-rose-300 bg-rose-50 px-3 py-2 text-sm font-bold text-rose-800">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              {error}
            </div>
          )}

          {/* Table — black header, thin light-orange grid; card list on mobile */}
          <div className="border border-slate-200">
            <PortalResponsiveDataList
              items={rows}
              getKey={(row) => row.id}
              empty={
                <PortalEmptyState
                  title="No reports found"
                  message={loading ? "Loading…" : "Adjust the filters above or submit a new report."}
                />
              }
              renderCard={(row) => (
                <PortalRecordCard
                  accent={row.is_serious ? "rose" : "slate"}
                  title={row.report_number}
                  meta={
                    <>
                      {new Date(row.created_at).toLocaleDateString()}
                      {" · "}
                      {row.submitted_by_name ?? "—"}
                    </>
                  }
                  status={<SeriousChip serious={row.is_serious} />}
                  actions={
                    <button
                      type="button"
                      onClick={() => setSelected(row)}
                      className="text-xs font-bold text-orange-600 hover:text-orange-700"
                    >
                      View full report →
                    </button>
                  }
                >
                  <PortalRecordFields
                    fields={[
                      {
                        label: "Patient",
                        value: `${row.patient_initials ?? "—"}${row.patient_sex ? ` (${row.patient_sex})` : ""}`,
                      },
                      { label: "Reactions", value: row.reactions_summary.join(", ") || "—" },
                      { label: "Outcome", value: row.outcome_summary ?? "—" },
                    ]}
                  />
                </PortalRecordCard>
              )}
              renderTable={() => (
                <PortalDesktopTable
                  cols={
                    <colgroup>
                      <col className="w-[12%]" />
                      <col className="w-[12%]" />
                      <col className="w-[18%]" />
                      <col className="w-[10%]" />
                      <col className="w-[24%]" />
                      <col className="w-[8%]" />
                      <col className="w-[16%]" />
                    </colgroup>
                  }
                >
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
                    {rows.map((row) => (
                      <tr
                        key={row.id}
                        className="cursor-pointer border-t border-orange-100 bg-white transition hover:bg-orange-50/60"
                        onClick={() => setSelected(row)}
                      >
                        <td className="px-3 py-2 font-mono text-xs font-bold text-orange-600">
                          {row.report_number}
                        </td>
                        <td className="break-words px-3 py-2 text-xs text-slate-500">
                          {new Date(row.created_at).toLocaleDateString()}
                        </td>
                        <td className="px-3 py-2">
                          <span className="text-sm font-bold text-slate-900">{row.submitted_by_name ?? "—"}</span>
                        </td>
                        <td className="px-3 py-2 text-xs text-slate-700">
                          {row.patient_initials ?? "—"}
                          {row.patient_sex && <span className="ml-1 text-slate-500">({row.patient_sex})</span>}
                        </td>
                        <td className="break-words px-3 py-2 text-xs text-slate-700">
                          <span>{row.reactions_summary.join(", ") || "—"}</span>
                        </td>
                        <td className="px-3 py-2">
                          <SeriousChip serious={row.is_serious} />
                        </td>
                        <td className="break-words px-3 py-2 text-xs text-slate-700">
                          <span>{row.outcome_summary ?? "—"}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </PortalDesktopTable>
              )}
            />
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

          {selected && <ReportDetailDrawer report={selected} onClose={() => setSelected(null)} />}
        </div>
      )}
    </div>
  );
}
