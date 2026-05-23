"use client";

import {
  AlertCircle,
  BriefcaseBusiness,
  Building2,
  Download,
  FileSpreadsheet,
  Search,
  Upload,
  UsersRound,
  X,
} from "lucide-react";
import * as React from "react";
import ExcelJS from "exceljs";

import {
  AdminCallout,
  AdminInsightChip,
  AdminPageHero,
  AdminSectionHeader,
  AdminStatCard,
  AdminTableShell,
} from "@/components/admin/admin-design-system";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { LoadingSpinner } from "@/components/ui/loading-state";
import {
  cvDatabaseHeaders,
  formatDurationMonths,
  parseCvDatabaseWorkbook,
  rowsForCvWorkbook,
  summarizeCvDatabase,
  type CvDatabaseRow,
  type CvExperienceStatus,
} from "@/lib/cv/cv-database";
import { cn } from "@/lib/utils";

type ExperienceFilter = "all" | CvExperienceStatus;

const panelClassName =
  "rounded-[28px] border border-[#D8E0EA] bg-white/94 shadow-[0_18px_46px_rgba(15,23,42,0.08)] backdrop-blur";

function CvDatabaseShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative isolate min-h-[calc(100vh-8rem)] overflow-hidden rounded-[34px] border border-[#D8E0EA] bg-[radial-gradient(circle_at_top_left,rgba(14,165,233,0.12),transparent_32%),linear-gradient(135deg,#F8FAFC_0%,#FFFFFF_44%,#FFF7ED_100%)] p-4 shadow-[0_24px_70px_rgba(15,23,42,0.1)] sm:p-6">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-24 -top-28 h-72 w-72 rounded-full bg-[#F97316]/10 blur-3xl"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute bottom-10 left-1/4 h-64 w-64 rounded-full bg-[#0284C7]/8 blur-3xl"
      />
      <div className="relative z-10 space-y-6">{children}</div>
    </div>
  );
}

function emptyText(value: string | number | null | undefined) {
  return value === null || value === undefined || value === "" ? "-" : String(value);
}

function experienceLabel(status: CvExperienceStatus) {
  if (status === "experienced") return "Experienced";
  if (status === "fresh") return "Fresh";
  return "Unknown";
}

function experienceBadgeVariant(status: CvExperienceStatus) {
  if (status === "experienced") return "success" as const;
  if (status === "fresh") return "neutral" as const;
  return "warning" as const;
}

async function downloadWorkbook(rows: CvDatabaseRow[], fileName: string) {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("CV Database");

  worksheet.columns = [
    { header: cvDatabaseHeaders[0], width: 28 },
    { header: cvDatabaseHeaders[1], width: 18 },
    { header: cvDatabaseHeaders[2], width: 20 },
    { header: cvDatabaseHeaders[3], width: 14 },
    { header: cvDatabaseHeaders[4], width: 14 },
    { header: cvDatabaseHeaders[5], width: 18 },
    { header: cvDatabaseHeaders[6], width: 36 },
    { header: cvDatabaseHeaders[7], width: 34 },
  ];

  worksheet.addRows(rowsForCvWorkbook(rows));

  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

function downloadTemplate() {
  window.location.href = "/api/cv-database/template";
}

function filterButtonClassName(active: boolean) {
  return cn(
    "h-10 rounded-2xl border px-3 text-xs font-bold transition",
    active
      ? "border-[#F97316] bg-[#FFF7ED] text-[#C2410C] shadow-sm"
      : "border-[#D7E0EA] bg-white/95 text-[#64748B] hover:bg-[#F8FAFC]",
  );
}

export function CvDatabaseManager() {
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const [rows, setRows] = React.useState<CvDatabaseRow[]>([]);
  const [fileName, setFileName] = React.useState<string | null>(null);
  const [warnings, setWarnings] = React.useState<string[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [isUploading, setIsUploading] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [experienceFilter, setExperienceFilter] = React.useState<ExperienceFilter>("all");

  const summary = React.useMemo(() => summarizeCvDatabase(rows), [rows]);
  const filteredRows = React.useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return rows.filter((row) => {
      const searchable = [
        row.name,
        row.dateOfSendingCv,
        row.medicalSalesExp,
        row.from,
        row.to,
        row.duration,
        row.companies,
        row.cvName,
        experienceLabel(row.status),
      ].join(" ").toLowerCase();

      return (
        (!normalizedQuery || searchable.includes(normalizedQuery)) &&
        (experienceFilter === "all" || row.status === experienceFilter)
      );
    });
  }, [experienceFilter, query, rows]);

  const hasActiveFilters = Boolean(query || experienceFilter !== "all");

  async function uploadWorkbook(file: File | null) {
    if (!file) return;

    setIsUploading(true);
    setError(null);
    setWarnings([]);

    try {
      const result = await parseCvDatabaseWorkbook(await file.arrayBuffer(), file.name);
      setRows(result.rows);
      setFileName(result.fileName);
      setWarnings(result.warnings);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Unable to read CV workbook.");
      setRows([]);
      setFileName(null);
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function clearFilters() {
    setQuery("");
    setExperienceFilter("all");
  }

  return (
    <CvDatabaseShell>
      <div className="space-y-6">
        <AdminPageHero
          actions={
            <div className="flex flex-wrap gap-2">
              <Button
                className="rounded-2xl px-3 py-2 text-xs shadow-sm"
                onClick={downloadTemplate}
                variant="secondary"
              >
                <FileSpreadsheet className="mr-2 h-3.5 w-3.5" />
                Download Template
              </Button>
              <Button
                className="rounded-2xl bg-[#0F172A] px-3 py-2 text-xs text-white shadow-[0_14px_30px_rgba(15,23,42,0.18)] hover:bg-[#111827]"
                disabled={isUploading}
                onClick={() => fileInputRef.current?.click()}
                variant="secondary"
              >
                {isUploading ? <LoadingSpinner /> : <Upload className="mr-2 h-3.5 w-3.5" />}
                Upload Sheet
              </Button>
              <input
                ref={fileInputRef}
                accept=".xlsx,.xls"
                className="sr-only"
                onChange={(event) => void uploadWorkbook(event.target.files?.[0] ?? null)}
                type="file"
              />
              <Button
                className="rounded-2xl px-3 py-2 text-xs shadow-sm"
                disabled={filteredRows.length === 0}
                onClick={async () => {
                  await downloadWorkbook(filteredRows, "phoenix-cv-database-export.xlsx");
                }}
                variant="secondary"
              >
                <Download className="mr-2 h-3.5 w-3.5" />
                Download Visible
              </Button>
            </div>
          }
          badges={
            <div className="flex flex-wrap gap-2 text-xs">
              <AdminInsightChip>Total: {summary.candidates}</AdminInsightChip>
              <AdminInsightChip tone="orange">Experienced: {summary.experienced}</AdminInsightChip>
              <AdminInsightChip tone="slate">Fresh: {summary.fresh}</AdminInsightChip>
              <AdminInsightChip>Companies: {summary.companies}</AdminInsightChip>
            </div>
          }
        description="Upload the CV database workbook with Name, Date of sending CV, Medical Sales Exp?, From, To, Duration, Companies, and CV Name. The sheet is analyzed locally without linking candidates to HR_ID or employee master data."
          eyebrow="Candidate Database"
          icon={<BriefcaseBusiness className="h-3.5 w-3.5" />}
          title="CV Database"
        />

        {error ? (
          <AdminCallout tone="danger">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <h2 className="text-sm font-bold text-[#991B1B]">CV sheet upload failed</h2>
              <p className="mt-1 text-sm text-[#991B1B]">{error}</p>
            </div>
          </AdminCallout>
        ) : null}

        {warnings.length > 0 ? (
          <AdminCallout tone="warning">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <h2 className="text-sm font-bold text-[#92400E]">Workbook imported with notes</h2>
              <p className="mt-1 text-sm text-[#92400E]">{warnings.join(" ")}</p>
            </div>
          </AdminCallout>
        ) : null}

        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <AdminStatCard
            description={fileName ? `Loaded from ${fileName}` : "Upload the Excel CV database to populate this view"}
            icon={<UsersRound className="h-5 w-5" />}
            label="Candidates"
            tone="blue"
            value={summary.candidates}
          />
          <AdminStatCard
            description="Candidates with explicit or inferred medical sales promotion experience"
            icon={<BriefcaseBusiness className="h-5 w-5" />}
            label="Experienced"
            tone="emerald"
            value={summary.experienced}
          />
          <AdminStatCard
            description="Candidates marked as fresh or without medical sales history"
            icon={<UsersRound className="h-5 w-5" />}
            label="Fresh"
            tone="orange"
            value={summary.fresh}
          />
          <AdminStatCard
            description="Average duration from candidates where experience duration is readable"
            icon={<Building2 className="h-5 w-5" />}
            label="Avg Experience"
            tone="violet"
            value={formatDurationMonths(summary.averageExperienceMonths) || "-"}
          />
        </section>

        <AdminTableShell
          description="Search by candidate, company, CV file, or experience field. Download exports only the rows currently visible."
          title="CV Sheet Controls"
        >
          <div className="grid gap-3 p-4 lg:grid-cols-[1.4fr_auto] lg:items-end">
            <label className="relative block">
              <span className="sr-only">Search CV database</span>
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#64748B]" />
              <Input
                className="h-11 rounded-2xl border-[#D7E0EA] bg-white/95 pl-9 shadow-sm"
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search name, company, CV filename..."
                value={query}
              />
            </label>
            <div className="flex flex-wrap gap-2">
              {[
                ["all", "All"],
                ["experienced", "Experienced"],
                ["fresh", "Fresh"],
                ["unknown", "Unknown"],
              ].map(([value, label]) => (
                <button
                  className={filterButtonClassName(experienceFilter === value)}
                  key={value}
                  onClick={() => setExperienceFilter(value as ExperienceFilter)}
                  type="button"
                >
                  {label}
                </button>
              ))}
              <Button
                className="h-10 gap-2 rounded-2xl shadow-sm"
                disabled={!hasActiveFilters}
                onClick={clearFilters}
                variant="secondary"
              >
                <X className="h-4 w-4" />
                Clear
              </Button>
            </div>
          </div>
        </AdminTableShell>

        <Card className={`${panelClassName} overflow-hidden p-0`}>
          <AdminSectionHeader
            action={
              <Badge className="px-3 py-1 text-xs" variant="neutral">
                {filteredRows.length} visible
              </Badge>
            }
            description="This is a standalone candidate sheet, so no HR_ID or employee record link is required."
            title="Candidate Records"
          />
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="bg-[#F8FAFC] text-[10px] font-black uppercase tracking-[0.16em] text-[#64748B]">
                <tr>
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Date of sending CV</th>
                  <th className="px-4 py-3">Medical Sales Exp?</th>
                  <th className="px-4 py-3">From</th>
                  <th className="px-4 py-3">To</th>
                  <th className="px-4 py-3">Duration</th>
                  <th className="px-4 py-3">Companies</th>
                  <th className="px-4 py-3">CV Name</th>
                  <th className="px-4 py-3">Profile</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E2E8F0]">
                {filteredRows.length === 0 ? (
                  <tr>
                    <td className="px-4 py-10 text-center text-sm text-[#64748B]" colSpan={9}>
                      {rows.length === 0
                        ? "Upload the CV database Excel sheet to preview candidates here."
                        : "No candidates match the current filters."}
                    </td>
                  </tr>
                ) : (
                  filteredRows.map((row) => (
                    <tr className="transition-colors hover:bg-[#F8FAFC]" key={`${row.rowNumber}-${row.name}-${row.cvName}`}>
                      <td className="px-4 py-4">
                        <p className="font-bold text-[#0F172A]">{emptyText(row.name)}</p>
                        <p className="mt-1 text-xs text-[#64748B]">Sheet row {row.rowNumber}</p>
                      </td>
                      <td className="px-4 py-4 text-[#64748B]">{emptyText(row.dateOfSendingCv)}</td>
                      <td className="px-4 py-4 text-[#64748B]">{emptyText(row.medicalSalesExp)}</td>
                      <td className="px-4 py-4 text-[#64748B]">{emptyText(row.from)}</td>
                      <td className="px-4 py-4 text-[#64748B]">{emptyText(row.to)}</td>
                      <td className="px-4 py-4 text-[#0F172A]">
                        {emptyText(row.duration || formatDurationMonths(row.durationMonths))}
                      </td>
                      <td className="max-w-[320px] px-4 py-4 text-[#64748B]">
                        <span className="line-clamp-2">{emptyText(row.companies)}</span>
                      </td>
                      <td className="max-w-[280px] px-4 py-4 text-[#64748B]">
                        <span className="line-clamp-2">{emptyText(row.cvName)}</span>
                      </td>
                      <td className="px-4 py-4">
                        <Badge variant={experienceBadgeVariant(row.status)}>
                          {experienceLabel(row.status)}
                        </Badge>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </CvDatabaseShell>
  );
}
