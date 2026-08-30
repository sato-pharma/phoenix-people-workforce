"use client";

import { BriefcaseBusiness, Building2, Download, GraduationCap, Search, UsersRound, X } from "lucide-react";
import Link from "next/link";
import * as React from "react";

import { AdminPageHero, AdminStatCard, AdminTableShell } from "@/components/admin/admin-design-system";
import {
  PortalDesktopTable,
  PortalEmptyState,
  PortalRecordCard,
  PortalRecordFields,
  PortalResponsiveDataList,
} from "@/components/employee-portal/portal-primitives";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatDurationMonths, type CvExperienceStatus } from "@/lib/cv/cv-database";
import { CV_LIBRARY_BLANK, summarizeCvLibrary, type CvLibraryRow } from "@/lib/cv/cv-library";
import {
  candidateRegionCodes,
  candidateRegionLabels,
  foreignRegionLabel,
  type CandidateRegionCode,
} from "@/lib/recruitment/candidate-region";
import {
  candidateRoleFamilies,
  candidateRoleFamilyLabels,
  candidateRoleFamilyOrNull,
  type CandidateRoleFamily,
} from "@/lib/recruitment/candidate-role-family";
import { cn } from "@/lib/utils";

/**
 * CV Database — rebuilt from scratch on 2026-08-30, at the owner's instruction.
 *
 * WHAT CHANGED AND WHY. The previous screen worked, but it wore a look nothing else in the module
 * wears: its own CvDatabaseShell — a radial-gradient backdrop with two blurred colour blobs —
 * wrapped around a twelve-column table 1,560px wide. The standing rule is to inspect the sibling
 * pages and match their exact design identity rather than invent a one-off, and the sibling here is
 * the Recruitment workspace: plain space-y-6, AdminPageHero, a four-card stat grid, AdminTableShell
 * around the list. That is what this page is built out of now, so the two screens a recruiter moves
 * between look like one product rather than two.
 *
 * The table went from twelve columns to eight by adopting the module's own two-line cell idiom — a
 * primary value with its companion fact beneath it, which is how the recruitment pool's Region cell
 * already reads. Nothing was dropped: every fact that was on screen is still on screen, and the
 * export still carries each one in a column of its own.
 *
 * THEN EIGHT TO FOUR, on 2026-08-30, because eight still scrolled sideways. Measured in Chrome on
 * the owner's own viewport: the eight-column table was 2,460px inside a 1,758px container — 702px
 * of horizontal scroll. Ten nowrap fields laid side by side is simply more than a screen has, so
 * four of the eight columns were folded into their neighbours as extra STACKED LINES rather than
 * removed: "Doing now" and "Experience" became one Work column, and Governorate and "Wants to
 * work" joined Region under one Where column. A column costs its widest value plus padding on
 * every row; a line costs nothing horizontally beyond its own text. Same facts, same order of
 * reading, 1,555px instead of 2,460px — it now fits the owner's screen with 203px to spare.
 *
 * NOTHING TRUNCATES AND NOTHING WRAPS. Every line of every cell is whitespace-nowrap; the table is
 * allowed to be as wide as its widest real value and PortalDesktopTable scrolls it. truncate and
 * line-clamp are deliberately absent — an ellipsis is exactly what the owner's rule forbids, and a
 * further line here is a separate element, never a wrapped one. That is also the honest limit of
 * this fix: a handful of CVs carry 90-100 character free-text job titles and institute names, and
 * a string that wide cannot be made narrower without breaking one of those two rules. They set the
 * 1,555px floor, so a container below that scrolls again — there is no layout that avoids it while
 * the text may neither wrap nor truncate.
 *
 * THE MOBILE CARDS AND THE EXPORT ARE UNCHANGED. Folding a column is a layout decision about one
 * screen: the export still declares all thirteen columns and the phone card still lists every
 * field with its own label, because "an export must match the screen" means the same facts, not
 * the same shape.
 */

type ExperienceFilter = "all" | CvExperienceStatus;

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

/** Shown on a region the applicant chose, so an inference is never read as a statement. */
const DECLARED_REGION_TITLE = "The applicant chose this themselves when they applied on WhatsApp.";

/**
 * What the Region cell explains on hover, or nothing when there is nothing to explain.
 *
 * Two different things can want saying and they never both apply: either a person chose this
 * region, or they live somewhere the company has no region for. Naming the country matters because
 * "Outside Egypt" on its own reads like a shrug, and the reader would have no way to tell it from
 * a gap in our data without looking at the Governorate column and knowing world geography.
 */
/**
 * Degree, faculty, institution — in that order, with the blanks removed rather than left as gaps.
 *
 * Compacting matters: a missing degree would otherwise push the faculty onto the second line and
 * leave the first one empty, which reads as a rendering fault rather than as a fact nobody has.
 */
function educationLines(row: CvLibraryRow): string[] {
  return [row.educationDegree, row.educationFaculty, row.educationInstitution].filter(Boolean);
}

function regionTitle(row: CvLibraryRow): string | undefined {
  if (row.regionForeignCountry) return `This CV gives an address in ${row.regionForeignCountry}.`;
  return row.regionDeclared ? DECLARED_REGION_TITLE : undefined;
}

const headCellClassName = "whitespace-nowrap px-3 py-3";
const cellClassName = "whitespace-nowrap px-3 py-4 align-top text-[13px] text-phx-ink-soft";

/**
 * One table cell, two facts.
 *
 * The second line is the module's established idiom — the recruitment pool's Region cell reads the
 * same way — and it is what let this table lose four columns without losing anything a reader had.
 * It renders nothing at all when there is no companion fact, rather than an em dash: a dash on the
 * second line reads as missing data, when the truth is that there is no second fact to give.
 */
function StackedCell({
  primary,
  secondary,
  tertiary,
  title,
}: {
  primary: React.ReactNode;
  secondary?: string;
  tertiary?: string;
  title?: string;
}) {
  return (
    <td className={cellClassName}>
      <div className="whitespace-nowrap font-semibold text-phx-ink" title={title}>
        {primary}
      </div>
      {secondary ? (
        <div className="mt-0.5 whitespace-nowrap text-phx-xs text-slate-500" title={title}>
          {secondary}
        </div>
      ) : null}
      {tertiary ? (
        <div className="mt-0.5 whitespace-nowrap text-phx-xs text-slate-500" title={title}>
          {tertiary}
        </div>
      ) : null}
    </td>
  );
}

/**
 * The export.
 *
 * One column per fact, even where the screen stacks two facts into a single cell — the standing
 * rule is that an export matches the screen, and a spreadsheet that merged them would be the one
 * thing nobody could then filter or pivot on. Headers, widths and values are three parallel lists,
 * and a registered test fails if they ever stop being the same length.
 */
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
  "Region",
  "Area asked for",
  "CV file",
] as const;

const exportWidths = [30, 14, 28, 26, 18, 14, 20, 26, 40, 18, 18, 22, 30];

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
      row.regionLabel,
      row.preferredArea,
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
      ? "border-phx-accent bg-phx-accent-soft text-phx-accent-press shadow-sm"
      : "border-[#D7E0EA] bg-white/95 text-phx-ink-soft hover:bg-phx-paper",
  );
}

const selectClassName =
  "h-10 rounded-2xl border border-[#D7E0EA] bg-white/95 px-3 text-xs font-bold text-phx-ink-soft shadow-sm";

export function CvDatabaseManager({ rows }: { rows: CvLibraryRow[] }) {
  const [query, setQuery] = React.useState("");
  const [experienceFilter, setExperienceFilter] = React.useState<ExperienceFilter>("all");
  const [governorate, setGovernorate] = React.useState("");
  // Two of these ask a question the raw column cannot answer. "Upper Egypt" is four governorates,
  // and "district manager" is a family spelled three different ways in this pool, so both read a
  // domain classifier rather than the stored string.
  const [roleFilter, setRoleFilter] = React.useState<CandidateRoleFamily | "" | "unknown">("");
  const [regionFilter, setRegionFilter] = React.useState<CandidateRegionCode | "" | "unknown" | "foreign">("");

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
      if (roleFilter) {
        const family = candidateRoleFamilyOrNull(row.currentJobTitle);
        if (roleFilter === "unknown" ? family !== null : family !== roleFilter) return false;
      }
      if (regionFilter) {
        // `row.regionCode` already honours the applicant's own WhatsApp answer and falls back to
        // the CV address. Re-deriving it here from the governorate is what made this screen
        // disagree with the recruitment pool about the same person.
        const region = row.regionCode;
        const foreign = Boolean(row.regionForeignCountry);
        // Three buckets, not two, because a null code has two very different causes. Somebody
        // living in Dubai is placed and will never have a region; somebody with no address on
        // their CV might have any. "Region not known" would be a lie about the first, so the
        // foreign rows are asked for on their own and excluded from the unknown bucket.
        if (regionFilter === "foreign") {
          if (!foreign) return false;
        } else if (regionFilter === "unknown") {
          if (region !== null || foreign) return false;
        } else if (region !== regionFilter) {
          return false;
        }
      }
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
        row.regionLabel,
        row.preferredArea,
        row.cvFileName,
        experienceLabel(row.medicalSales),
      ]
        .join(" ")
        .toLowerCase();

      return searchable.includes(normalizedQuery);
    });
  }, [experienceFilter, governorate, query, regionFilter, roleFilter, rows]);

  const hasActiveFilters = Boolean(query || experienceFilter !== "all" || governorate || roleFilter || regionFilter);

  function clearFilters() {
    setQuery("");
    setExperienceFilter("all");
    setGovernorate("");
    setRoleFilter("");
    setRegionFilter("");
  }

  return (
    <div className="space-y-6">
      <AdminPageHero
        actions={
          <Button
            className="rounded-2xl px-3 py-2 text-xs shadow-sm"
            disabled={filteredRows.length === 0}
            onClick={() => void downloadWorkbook(filteredRows, "phoenix-cv-database-export.xlsx")}
            variant="secondary"
          >
            <Download className="mr-2 h-3.5 w-3.5" />
            Download what is on screen
          </Button>
        }
        description="Every CV that has reached Phoenix, read as a library: what each person does now, how long they have sold pharmaceuticals, where they studied, where they live and where they asked to work. The same records as the Recruitment pool — open any row to read the CV itself."
        eyebrow="People Management"
        icon={<BriefcaseBusiness className="h-4 w-4" />}
        title="CV Database"
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <AdminStatCard
          description="Everyone whose CV has reached Phoenix."
          icon={<UsersRound className="h-5 w-5" />}
          label="Candidates"
          tone="blue"
          value={summary.candidates}
        />
        <AdminStatCard
          description="Have sold pharmaceuticals before, according to their CV."
          icon={<BriefcaseBusiness className="h-5 w-5" />}
          label="Experienced"
          tone="emerald"
          value={summary.experienced}
        />
        <AdminStatCard
          description="No medical sales history on the CV."
          icon={<GraduationCap className="h-5 w-5" />}
          label="Fresh"
          tone="orange"
          value={summary.fresh}
        />
        <AdminStatCard
          description="Averaged over the candidates whose CV gives both a start and an end date."
          icon={<Building2 className="h-5 w-5" />}
          label="Avg medical sales"
          tone="violet"
          value={formatDurationMonths(summary.averageExperienceMonths) || CV_LIBRARY_BLANK}
        />
      </div>

      <AdminTableShell
        action={
          <Button
            className="h-10 gap-2 rounded-2xl shadow-sm"
            disabled={!hasActiveFilters}
            onClick={clearFilters}
            variant="secondary"
          >
            <X className="h-4 w-4" />
            Clear
          </Button>
        }
        description="Search names, roles, employers, universities and areas. Region is where someone will work; Governorate is where they live."
        title="Find someone"
      >
        <div className="grid gap-3 p-4 lg:grid-cols-[1.4fr_auto] lg:items-center">
          <label className="relative block">
            <span className="sr-only">Search the CV database</span>
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-phx-ink-soft" />
            <Input
              className="h-11 rounded-2xl border-[#D7E0EA] bg-white/95 pl-9 shadow-sm"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search name, role, employer, university, area..."
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
            <label className="sr-only" htmlFor="cv-database-role">
              Role
            </label>
            <select
              className={selectClassName}
              id="cv-database-role"
              onChange={(event) => setRoleFilter(event.target.value as CandidateRoleFamily | "" | "unknown")}
              value={roleFilter}
            >
              <option value="">Any role</option>
              {candidateRoleFamilies.map((family) => (
                <option key={family} value={family}>
                  {candidateRoleFamilyLabels[family]}
                </option>
              ))}
              <option value="unknown">No job title on file</option>
            </select>
            <label className="sr-only" htmlFor="cv-database-region">
              Region
            </label>
            <select
              className={selectClassName}
              id="cv-database-region"
              onChange={(event) => setRegionFilter(event.target.value as CandidateRegionCode | "" | "unknown" | "foreign")}
              value={regionFilter}
            >
              <option value="">Any region</option>
              {candidateRegionCodes.map((code) => (
                <option key={code} value={code}>
                  {candidateRegionLabels[code]}
                </option>
              ))}
              <option value="foreign">{foreignRegionLabel}</option>
              <option value="unknown">Region not known</option>
            </select>
            {governorateOptions.length > 1 ? (
              <label className="sr-only" htmlFor="cv-database-governorate">
                Governorate
              </label>
            ) : null}
            {governorateOptions.length > 1 ? (
              <select
                className={selectClassName}
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
          </div>
        </div>
      </AdminTableShell>

      <AdminTableShell
        action={
          <Badge className="px-3 py-1 text-xs" variant="neutral">
            {filteredRows.length} of {rows.length} shown
          </Badge>
        }
        description="The same candidates as the Recruitment pool. Open one to read the CV and its extracted fields."
        title="Candidate records"
      >
        <PortalResponsiveDataList
          empty={
            <PortalEmptyState
              message={
                rows.length === 0
                  ? "A CV sent to the recruitment inbox or the WhatsApp number appears here automatically."
                  : "Try adjusting the search text or the filters above."
              }
              title={rows.length === 0 ? "No candidates yet" : "No candidates match your filters"}
            />
          }
          getKey={(row) => row.id}
          items={filteredRows}
          renderCard={(row) => (
            <PortalRecordCard
              accent={experienceCardAccent(row.medicalSales)}
              meta={`CV received ${emptyText(row.receivedOn)}`}
              status={
                <Badge variant={experienceBadgeVariant(row.medicalSales)}>{experienceLabel(row.medicalSales)}</Badge>
              }
              title={emptyText(row.name)}
            >
              <PortalRecordFields
                fields={[
                  { label: "Current role", value: emptyText(row.currentJobTitle) },
                  { label: "Employer", value: emptyText(row.currentEmployer) },
                  { label: "Total experience", value: emptyText(row.totalExperience) },
                  { label: "Medical sales", value: emptyText(row.medicalSalesDuration) },
                  { label: "Medical sales employer", value: emptyText(row.medicalSalesEmployer) },
                  { label: "Education", value: emptyText(row.education) },
                  { label: row.regionDeclared ? "Region (asked)" : "Region", value: emptyText(row.regionLabel) },
                  ...(row.preferredArea ? [{ label: "Area asked for", value: row.preferredArea }] : []),
                  { label: "Governorate", value: emptyText(row.governorate) },
                  { label: "CV file", value: emptyText(row.cvFileName) },
                ]}
              />
            </PortalRecordCard>
          )}
          renderTable={() => (
            <PortalDesktopTable minWidth="1280px">
              <thead className="bg-phx-paper text-phx-2xs font-black uppercase tracking-[0.16em] text-phx-ink-soft">
                <tr>
                  <th className={headCellClassName}>Candidate</th>
                  {/* Everything about their working life, in one column. Measured 2026-08-30: as
                      two columns ("Doing now" and "Experience") these cost 1110px side by side and
                      were what kept the table wider than its container even after everything else
                      had been folded. Stacked, the column costs only as much as its widest single
                      line. Vertical space is cheap here and horizontal space is not — that is the
                      whole trade, and it is the only one available when nothing may wrap or
                      truncate. */}
                  <th className={headCellClassName}>Work</th>
                  {/* Where they will WORK, which the Region filter keys on, with the area in the
                      applicant's own wording beneath it and where they LIVE below that. Three
                      different facts kept apart by line rather than by column — each one is labelled
                      in place, so nothing is lost by not giving each its own header. */}
                  <th className={headCellClassName}>Where</th>
                  <th className={headCellClassName}>Education</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-phx-line">
                {filteredRows.map((row) => (
                  <tr className="transition-colors hover:bg-phx-paper" key={row.id}>
                    <td className={cellClassName}>
                      <Link
                        className="whitespace-nowrap font-bold text-phx-ink underline-offset-2 hover:text-phx-accent-press hover:underline"
                        href={`/recruitment?candidate=${encodeURIComponent(row.id)}`}
                      >
                        {emptyText(row.name)}
                      </Link>
                      <div className="mt-0.5 whitespace-nowrap text-phx-xs text-slate-500">
                        {`CV received ${emptyText(row.receivedOn)}`}
                      </div>
                      {row.cvFileName ? (
                        <div className="mt-0.5 whitespace-nowrap text-phx-xs text-slate-500">
                          {row.cvFileName}
                        </div>
                      ) : null}
                    </td>
                    <td className={cellClassName}>
                      <div className="whitespace-nowrap font-semibold text-phx-ink">
                        {emptyText(row.currentJobTitle)}
                      </div>
                      {row.currentEmployer ? (
                        <div className="mt-0.5 whitespace-nowrap text-phx-xs text-slate-500">
                          {row.currentEmployer}
                        </div>
                      ) : null}
                      <span className="mt-1.5 inline-flex items-center gap-2 whitespace-nowrap">
                        <Badge variant={experienceBadgeVariant(row.medicalSales)}>
                          {experienceLabel(row.medicalSales)}
                        </Badge>
                        {row.medicalSalesDuration ? <span>{row.medicalSalesDuration}</span> : null}
                      </span>
                      {row.medicalSalesEmployer ? (
                        <div className="mt-0.5 whitespace-nowrap text-phx-xs text-slate-500">
                          {row.medicalSalesEmployer}
                        </div>
                      ) : null}
                      {row.totalExperience ? (
                        <div className="mt-0.5 whitespace-nowrap text-phx-xs text-slate-500">
                          {`${row.totalExperience} in total`}
                        </div>
                      ) : null}
                    </td>
                    <StackedCell
                      primary={emptyText(row.regionLabel)}
                      secondary={row.preferredArea}
                      tertiary={row.governorate ? `Lives in ${row.governorate}` : ""}
                      title={regionTitle(row)}
                    />
                    {/* Three lines, each a separately-extracted field. Whichever facts exist float
                        up, so a row that knows only where somebody studied still reads on the first
                        line rather than leaving a gap above it. */}
                    <StackedCell
                      primary={emptyText(educationLines(row)[0] ?? "")}
                      secondary={educationLines(row)[1] ?? ""}
                      tertiary={educationLines(row)[2] ?? ""}
                    />
                  </tr>
                ))}
              </tbody>
            </PortalDesktopTable>
          )}
        />
      </AdminTableShell>
    </div>
  );
}
