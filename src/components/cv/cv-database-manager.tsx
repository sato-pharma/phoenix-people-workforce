"use client";

import { BriefcaseBusiness, Building2, Download, GraduationCap, Search, UsersRound, X } from "lucide-react";
import Link from "next/link";
import * as React from "react";

import {
  AdminInsightChip,
  AdminPageHero,
  AdminSectionHeader,
  AdminStatCard,
  AdminTableShell,
} from "@/components/admin/admin-design-system";
import {
  PortalDesktopTable,
  PortalEmptyState,
  PortalRecordCard,
  PortalRecordFields,
  PortalResponsiveDataList,
} from "@/components/employee-portal/portal-primitives";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { formatDurationMonths, type CvExperienceStatus } from "@/lib/cv/cv-database";
import { CV_LIBRARY_BLANK, summarizeCvLibrary, type CvLibraryRow } from "@/lib/cv/cv-library";
import { cn } from "@/lib/utils";

type ExperienceFilter = "all" | CvExperienceStatus;

const panelClassName =
  "rounded-[28px] border border-[#D8E0EA] bg-white/94 shadow-[0_18px_46px_rgba(15,23,42,0.08)] backdrop-blur";

// Every data cell. `whitespace-nowrap` rather than a fixed width and a clamp: the owner's rule is
// that nothing truncates with an ellipsis and nothing wraps to a second line, and the honest way to
// honour both is to let the table be as wide as its widest real value and let PortalDesktopTable's
// own `overflow-x-auto` wrapper scroll. The previous version used `line-clamp-2`, which broke both
// halves of that rule at once.
const cellClassName = "whitespace-nowrap px-4 py-4 text-[#64748B]";
const headCellClassName = "whitespace-nowrap px-4 py-3";

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
  return value === null || value === undefined || value === "" ? CV_LIBRARY_BLANK : String(value);
}

function experienceLabel(status: CvExperienceStatus) {
  if (status === "experienced") return "Experienced";
  if (status === "fresh") return "Fresh";
  return "Not stated";
}

function experienceBadgeVariant(status: CvExperienceStatus) {
  if (status === "experienced") return "success" as const;
  if (status === "fresh") return "neutral" as const;
  return "warning" as const;
}

function experienceCardAccent(status: CvExperienceStatus) {
  if (status === "experienced") return "emerald" as const;
  if (status === "fresh") return "slate" as const;
  return "amber" as const;
}

const exportHeaders = [
  "Candidate",
  "CV received",
  "Current role",
  "Employer",
  "Total experience",
  "Medical sales",
  "Medical sales duration",
  "Medical sales employer",
  "Education",
  "Governorate",
  "CV file",
] as const;

const exportWidths = [30, 14, 28, 26, 18, 14, 20, 26, 40, 18, 30];

async function downloadWorkbook(rows: CvLibraryRow[], fileName: string) {
  // Lazy-load exceljs (~1MB) only when an export is triggered, keeping it out of this client
  // component's initial bundle.
  const ExcelJS = (await import("exceljs")).default;
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("CV Database");
  sheet.columns = exportHeaders.map((header, index) => ({
    header,
    key: header,
    width: exportWidths[index],
  }));
  sheet.addRows(
    rows.map((row) => [
      row.name,
      row.receivedOn,
      row.currentJobTitle,
      row.currentEmployer,
      row.totalExperience,
      experienceLabel(row.medicalSales),
      row.medicalSalesDuration,
      row.medicalSalesEmployer,
      row.education,
      row.governorate,
      row.cvFileName,
    ]),
  );

  const output = await workbook.xlsx.writeBuffer();
  const blob = new Blob([output], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  window.URL.revokeObjectURL(url);
}

function filterButtonClassName(active: boolean) {
  return cn(
    "h-10 rounded-2xl border px-3 text-xs font-bold transition",
    active
      ? "border-[#F97316] bg-[#FFF7ED] text-[#C2410C] shadow-sm"
      : "border-[#D7E0EA] bg-white/95 text-[#64748B] hover:bg-[#F8FAFC]",
  );
}

/**
 * The candidate pool, read as a CV library.
 *
 * Rows arrive from the server — see app/(admin)/cv-database/page.tsx. This component used to own
 * its own data: an .xlsx parsed into React state, never persisted, gone on reload, and sharing
 * nothing with the 562 candidates in ats_candidates. The upload went with it — it wrote nothing
 * anywhere, so no capability is lost, and an importer that imports into a variable is the same lie
 * in a smaller box.
 */
export function CvDatabaseManager({ rows }: { rows: CvLibraryRow[] }) {
  const [query, setQuery] = React.useState("");
  const [experienceFilter, setExperienceFilter] = React.useState<ExperienceFilter>("all");
  const [governorate, setGovernorate] = React.useState("");

  const summary = React.useMemo(() => summarizeCvLibrary(rows), [rows]);

  // Built from the data: the governorates people actually live in change as the pool grows, and an
  // option nobody matches is noise.
  const governorateOptions = React.useMemo(
    () =>
      Array.from(new Set(rows.map((row) => row.governorate).filter(Boolean))).sort((left, right) =>
        left.localeCompare(right),
      ),
    [rows],
  );

  const filteredRows = React.useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return rows.filter((row) => {
      if (experienceFilter !== "all" && row.medicalSales !== experienceFilter) return false;
      if (governorate && row.governorate !== governorate) return false;
      if (!normalizedQuery) return true;

      const searchable = [
        row.name,
        row.receivedOn,
        row.currentJobTitle,
        row.currentEmployer,
        row.totalExperience,
        row.medicalSalesDuration,
        row.medicalSalesEmployer,
        row.education,
        row.governorate,
        row.cvFileName,
        experienceLabel(row.medicalSales),
      ]
        .join(" ")
        .toLowerCase();

      return searchable.includes(normalizedQuery);
    });
  }, [experienceFilter, governorate, query, rows]);

  const hasActiveFilters = Boolean(query || experienceFilter !== "all" || governorate);

  function clearFilters() {
    setQuery("");
    setExperienceFilter("all");
    setGovernorate("");
  }

  return (
    <CvDatabaseShell>
      <div className="space-y-6">
        <AdminPageHero
          actions={
            <div className="flex flex-wrap gap-2">
              <Button
                className="rounded-2xl px-3 py-2 text-xs shadow-sm"
                disabled={filteredRows.length === 0}
                onClick={() => void downloadWorkbook(filteredRows, "phoenix-cv-database-export.xlsx")}
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
              <AdminInsightChip>Employers: {summary.employers}</AdminInsightChip>
            </div>
          }
          description="Every CV in the candidate pool, read as a library: what each person does now, how long they have sold pharmaceuticals, where they studied and where they live. The same records as the Recruitment pool — open any row to read the CV itself."
          eyebrow="Candidate Database"
          icon={<BriefcaseBusiness className="h-3.5 w-3.5" />}
          title="CV Database"
        />

        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <AdminStatCard
            description="Everyone whose CV has reached Phoenix"
            icon={<UsersRound className="h-5 w-5" />}
            label="Candidates"
            tone="blue"
            value={summary.candidates}
          />
          <AdminStatCard
            description="Have sold pharmaceuticals before, according to their CV"
            icon={<BriefcaseBusiness className="h-5 w-5" />}
            label="Experienced"
            tone="emerald"
            value={summary.experienced}
          />
          <AdminStatCard
            description="No medical sales history on the CV"
            icon={<GraduationCap className="h-5 w-5" />}
            label="Fresh"
            tone="orange"
            value={summary.fresh}
          />
          <AdminStatCard
            description="Averaged over the candidates whose CV gives both a start and an end date"
            icon={<Building2 className="h-5 w-5" />}
            label="Avg Medical Sales"
            tone="violet"
            value={formatDurationMonths(summary.averageExperienceMonths) || CV_LIBRARY_BLANK}
          />
        </section>

        <AdminTableShell
          description="Search by name, role, employer, university, governorate or CV file. Download exports only the rows currently visible."
          title="Library Controls"
        >
          <div className="grid gap-3 p-4 lg:grid-cols-[1.4fr_auto] lg:items-end">
            <label className="relative block">
              <span className="sr-only">Search the CV database</span>
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#64748B]" />
              <Input
                className="h-11 rounded-2xl border-[#D7E0EA] bg-white/95 pl-9 shadow-sm"
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search name, role, employer, university..."
                value={query}
              />
            </label>
            <div className="flex flex-wrap gap-2">
              {(
                [
                  ["all", "All"],
                  ["experienced", "Experienced"],
                  ["fresh", "Fresh"],
                  ["unknown", "Not stated"],
                ] as const
              ).map(([value, label]) => (
                <button
                  className={filterButtonClassName(experienceFilter === value)}
                  key={value}
                  onClick={() => setExperienceFilter(value)}
                  type="button"
                >
                  {label}
                </button>
              ))}
              {governorateOptions.length > 1 ? (
                <label className="sr-only" htmlFor="cv-database-governorate">
                  Governorate
                </label>
              ) : null}
              {governorateOptions.length > 1 ? (
                <select
                  className="h-10 rounded-2xl border border-[#D7E0EA] bg-white/95 px-3 text-xs font-bold text-[#64748B] shadow-sm"
                  id="cv-database-governorate"
                  onChange={(event) => setGovernorate(event.target.value)}
                  value={governorate}
                >
                  <option value="">Any governorate</option>
                  {governorateOptions.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              ) : null}
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
            description="The same candidates as the Recruitment pool. Open one to read the CV and its extracted fields."
            title="Candidate Records"
          />
          <PortalResponsiveDataList
            items={filteredRows}
            getKey={(row) => row.id}
            empty={
              <PortalEmptyState
                title={rows.length === 0 ? "No candidates yet" : "No candidates match your filters"}
                message={
                  rows.length === 0
                    ? "A CV sent to the recruitment inbox or the WhatsApp number appears here automatically."
                    : "Try adjusting the search text or the filters above."
                }
              />
            }
            renderCard={(row) => (
              <PortalRecordCard
                title={emptyText(row.name)}
                meta={`CV received ${emptyText(row.receivedOn)}`}
                accent={experienceCardAccent(row.medicalSales)}
                status={
                  <Badge variant={experienceBadgeVariant(row.medicalSales)}>
                    {experienceLabel(row.medicalSales)}
                  </Badge>
                }
              >
                <PortalRecordFields
                  fields={[
                    { label: "Current role", value: emptyText(row.currentJobTitle) },
                    { label: "Employer", value: emptyText(row.currentEmployer) },
                    { label: "Total experience", value: emptyText(row.totalExperience) },
                    { label: "Medical sales", value: emptyText(row.medicalSalesDuration) },
                    { label: "Medical sales employer", value: emptyText(row.medicalSalesEmployer) },
                    { label: "Education", value: emptyText(row.education) },
                    { label: "Governorate", value: emptyText(row.governorate) },
                    { label: "CV file", value: emptyText(row.cvFileName) },
                  ]}
                />
              </PortalRecordCard>
            )}
            renderTable={() => (
              <PortalDesktopTable minWidth="1560px">
                <thead className="bg-[#F8FAFC] text-[10px] font-black uppercase tracking-[0.16em] text-[#64748B]">
                  <tr>
                    <th className={headCellClassName}>Candidate</th>
                    <th className={headCellClassName}>CV received</th>
                    <th className={headCellClassName}>Current role</th>
                    <th className={headCellClassName}>Employer</th>
                    <th className={headCellClassName}>Total experience</th>
                    <th className={headCellClassName}>Medical sales</th>
                    <th className={headCellClassName}>Medical sales employer</th>
                    <th className={headCellClassName}>Education</th>
                    <th className={headCellClassName}>Governorate</th>
                    <th className={headCellClassName}>CV file</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#E2E8F0]">
                  {filteredRows.map((row) => (
                    <tr className="transition-colors hover:bg-[#F8FAFC]" key={row.id}>
                      <td className="whitespace-nowrap px-4 py-4">
                        <Link
                          className="font-bold text-[#0F172A] underline-offset-2 hover:text-[#C2410C] hover:underline"
                          href={`/recruitment?candidate=${encodeURIComponent(row.id)}`}
                        >
                          {emptyText(row.name)}
                        </Link>
                      </td>
                      <td className={cellClassName}>{emptyText(row.receivedOn)}</td>
                      <td className={cellClassName}>{emptyText(row.currentJobTitle)}</td>
                      <td className={cellClassName}>{emptyText(row.currentEmployer)}</td>
                      <td className={cellClassName}>{emptyText(row.totalExperience)}</td>
                      <td className="whitespace-nowrap px-4 py-4">
                        <span className="inline-flex items-center gap-2">
                          <Badge variant={experienceBadgeVariant(row.medicalSales)}>
                            {experienceLabel(row.medicalSales)}
                          </Badge>
                          {row.medicalSalesDuration ? (
                            <span className="text-[#64748B]">{row.medicalSalesDuration}</span>
                          ) : null}
                        </span>
                      </td>
                      <td className={cellClassName}>{emptyText(row.medicalSalesEmployer)}</td>
                      <td className={cellClassName}>{emptyText(row.education)}</td>
                      <td className={cellClassName}>{emptyText(row.governorate)}</td>
                      <td className={cellClassName}>{emptyText(row.cvFileName)}</td>
                    </tr>
                  ))}
                </tbody>
              </PortalDesktopTable>
            )}
          />
        </Card>
      </div>
    </CvDatabaseShell>
  );
}
