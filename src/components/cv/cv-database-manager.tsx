"use client";

import { BriefcaseBusiness, Building2, Download, GraduationCap, Search, UsersRound, X } from "lucide-react";
import Link from "next/link";
import * as React from "react";

import { AdminInsightChip, AdminPageHero, AdminStatCard, AdminTableShell } from "@/components/admin/admin-design-system";
import {
  adminChipDepthClassName,
  adminControlDepthClassName,
  adminRecessedDepthClassName,
} from "@/components/admin/admin-design-tokens";
import {
  PortalDesktopTable,
  PortalRecordCard,
  PortalRecordFields,
  PortalResponsiveDataList,
} from "@/components/employee-portal/portal-primitives";
import {
  RecruitmentEmptyState,
  RecruitmentPill,
  recruitmentToolbarClassName,
  type RecruitmentPillTone,
} from "@/components/recruitment/recruitment-premium";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatDurationMonths, type CvExperienceStatus } from "@/lib/cv/cv-database";
import {
  CV_LIBRARY_BLANK,
  experienceBandLabels,
  experienceBands,
  gradeFilterLabels,
  gradeFilterOptions,
  graduationBucketLabels,
  graduationBuckets,
  matchesExperienceBand,
  matchesGradeFilter,
  matchesGraduationBucket,
  summarizeCvLibrary,
  type CvLibraryRow,
  type ExperienceBand,
  type GradeFilter,
  type GraduationBucket,
} from "@/lib/cv/cv-library";
import type { BackgroundOutcome } from "@/lib/recruitment/candidate-background";
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
import { phxSelectClassName } from "@/components/ui/form-tokens";

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
 * NOTHING TRUNCATES, AND A LONG VALUE WRAPS. Until 2026-10-19 every line of every cell was
 * whitespace-nowrap and the table was allowed to be as wide as its widest real value. That rule
 * was written on 2026-08-30 and the owner superseded it on 2026-09-01: no horizontal scroll, and
 * where the two collide, wrapping wins. The Screening column then made the gap plain. Its question
 * labels run to 60 characters, and measured on production at 1,440px the table was 1,912px inside
 * a 1,405px holder. Every line now wraps inside its own fixed column (break-words): the table
 * fits, and a long job title or institute name takes a second line instead of a scroll. truncate
 * and line-clamp stay absent, because an ellipsis is the other half of the same rule.
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

function experiencePillTone(status: CvExperienceStatus): RecruitmentPillTone {
  if (status === "experienced") return "emerald";
  if (status === "fresh") return "slate";
  return "amber";
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

/**
 * The admin-defined extra questions, one "label: answer" line each, in the admin builder's own
 * order. A variable count, unlike StackedCell's fixed three slots, so it gets its own cell: nothing
 * at all for the (currently near-universal) case of zero answers, rather than an empty column that
 * still costs a header.
 */
function ScreeningAnswersCell({ row }: { row: CvLibraryRow }) {
  if (row.screeningAnswers.length === 0) return <td className={cellClassName} />;
  return (
    <td className={cellClassName}>
      {row.screeningAnswers.map((entry) => (
        <div className="mb-1.5 last:mb-0" key={entry.label}>
          <div className="break-words text-phx-2xs font-bold uppercase tracking-wider text-slate-400">
            {entry.label}
          </div>
          <div className="break-words font-semibold text-phx-ink">{entry.answer}</div>
        </div>
      ))}
    </td>
  );
}

function regionTitle(row: CvLibraryRow): string | undefined {
  if (row.regionForeignCountry) return `This CV gives an address in ${row.regionForeignCountry}.`;
  return row.regionDeclared ? DECLARED_REGION_TITLE : undefined;
}

const headCellClassName = "break-words px-3 py-3";
const cellClassName = "break-words px-3 py-4 align-top text-[13px] text-phx-ink-soft";

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
      <div className="break-words font-semibold text-phx-ink" title={title}>
        {primary}
      </div>
      {secondary ? (
        <div className="mt-0.5 break-words text-phx-xs text-slate-500" title={title}>
          {secondary}
        </div>
      ) : null}
      {tertiary ? (
        <div className="mt-0.5 break-words text-phx-xs text-slate-500" title={title}>
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
  "Screening answers",
] as const;

const exportWidths = [30, 14, 28, 26, 18, 14, 20, 26, 40, 18, 18, 22, 30, 44];

/** "Question: answer" pairs, joined so the export carries the same facts as the screen without one
 *  column per admin-defined question — the question list is unbounded and admin-growable. */
function screeningAnswersText(row: CvLibraryRow): string {
  return row.screeningAnswers.map((entry) => `${entry.label}: ${entry.answer}`).join("; ");
}

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
      screeningAnswersText(row),
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
    "inline-flex min-h-9 items-center border-b-2 px-3 text-xs font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400",
    active
      ? cn("border-orange-500 bg-white text-slate-950", adminChipDepthClassName)
      : "border-transparent text-slate-600 hover:bg-white/70 hover:text-slate-900",
  );
}

const selectClassName =
  phxSelectClassName;

export function CvDatabaseManager({ rows }: { rows: CvLibraryRow[] }) {
  const [query, setQuery] = React.useState("");
  const [experienceFilter, setExperienceFilter] = React.useState<ExperienceFilter>("all");
  const [governorate, setGovernorate] = React.useState("");
  // Two of these ask a question the raw column cannot answer. "Upper Egypt" is four governorates,
  // and "district manager" is a family spelled three different ways in this pool, so both read a
  // domain classifier rather than the stored string.
  const [roleFilter, setRoleFilter] = React.useState<CandidateRoleFamily | "" | "unknown">("");
  const [regionFilter, setRegionFilter] = React.useState<CandidateRegionCode | "" | "unknown" | "foreign">("");
  // The field-force eligibility verdict — the owner's rule that a paramedical degree is refused for
  // a rep or a district manager and is normal for an office coordinator. `judgeBackground` has
  // answered this for every candidate since the background review shipped; nothing ever asked it.
  // 295 of 875 are paramedical, so a third of any unfiltered list cannot take the field job.
  const [backgroundFilter, setBackgroundFilter] = React.useState<BackgroundOutcome | "">("");
  const [graduationFilter, setGraduationFilter] = React.useState<GraduationBucket>("");
  const [experienceBand, setExperienceBand] = React.useState<ExperienceBand>("");
  // 318 candidates carry a grade in 98 distinct spellings, so the raw column could never be a facet.
  // `normalizeDegreeGrade` folds them to the four Egyptian names and refuses to guess at the ~50 that
  // are only a GPA or a letter — those get their own option rather than an invented grade.
  const [gradeFilter, setGradeFilter] = React.useState<GradeFilter>("");

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
      // Read off the row, which took it from `judgeBackground` — never re-decided here. A second
      // opinion about somebody's degree is how two screens start disagreeing about one person.
      if (backgroundFilter && row.backgroundOutcome !== backgroundFilter) return false;
      if (!matchesGraduationBucket(row, graduationFilter)) return false;
      if (!matchesExperienceBand(row, experienceBand)) return false;
      if (!matchesGradeFilter(row, gradeFilter)) return false;
      if (roleFilter) {
        // BOTH the job they hold and the job they asked us for. This read `currentJobTitle` alone,
        // so a CV sent in for a district manager seat off a senior medical rep's CV could only be
        // found under Medical Representative — on the screen whose entire job is finding a CV again.
        // 303 of the 649 candidates who stated a job were missing from a filter their own record
        // answered, measured on production 2026-09-18; this screen's filter was the blindest of the
        // three, because it never consulted the stated job at all.
        const families = [
          candidateRoleFamilyOrNull(row.currentJobTitle),
          candidateRoleFamilyOrNull(row.appliedForJobTitle),
        ].filter((family): family is CandidateRoleFamily => family !== null);
        if (roleFilter === "unknown" ? families.length > 0 : !families.includes(roleFilter)) return false;
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
  }, [backgroundFilter, experienceBand, experienceFilter, governorate, gradeFilter, graduationFilter, query, regionFilter, roleFilter, rows]);

  const hasActiveFilters = Boolean(
    query ||
      experienceFilter !== "all" ||
      governorate ||
      roleFilter ||
      regionFilter ||
      backgroundFilter ||
      graduationFilter ||
      experienceBand ||
      gradeFilter,
  );

  function clearFilters() {
    setQuery("");
    setExperienceFilter("all");
    setGovernorate("");
    setRoleFilter("");
    setRegionFilter("");
    setBackgroundFilter("");
    setGraduationFilter("");
    setExperienceBand("");
    setGradeFilter("");
  }

  return (
    <div className="space-y-6">
      <AdminPageHero
        actions={
          <Button
            className={cn("px-3 py-2 text-xs", adminControlDepthClassName, "disabled:shadow-none")}
            disabled={filteredRows.length === 0}
            onClick={() => void downloadWorkbook(filteredRows, "phoenix-cv-database-export.xlsx")}
            variant="secondary"
          >
            <Download className="mr-2 h-3.5 w-3.5" />
            Download what is on screen
          </Button>
        }
        badges={
          <AdminInsightChip tone="orange">
            {rows.length === 1 ? "1 CV on file" : `${rows.length} CVs on file`}
          </AdminInsightChip>
        }
        description="Every CV that has reached Phoenix, read as a library: what each person does now, how long they have sold pharmaceuticals, where they studied, where they live and where they asked to work. The same records as the Recruitment pool — open any row to read the CV itself."
        eyebrow="Recruitment"
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
            className={cn("h-10 gap-2", adminControlDepthClassName, "disabled:shadow-none")}
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
        <div className="p-4">
        <div className={cn(recruitmentToolbarClassName, "grid lg:grid-cols-[1.4fr_auto] lg:items-center")}>
          <label className="relative block">
            <span className="sr-only">Search the CV database</span>
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-phx-ink-soft" />
            <Input
              className="pl-9"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search name, role, employer, university, area..."
              value={query}
            />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <div
              aria-label="Medical sales experience"
              className={cn("flex flex-wrap gap-1 border border-slate-200 bg-slate-100/80 p-1", adminRecessedDepthClassName)}
              role="group"
            >
              {(
                [
                  ["all", "All"],
                  ["experienced", "Experienced"],
                  ["fresh", "Fresh"],
                  ["unknown", "Not stated"],
                ] as const
              ).map(([value, label]) => (
                <button
                  aria-pressed={experienceFilter === value}
                  className={filterButtonClassName(experienceFilter === value)}
                  key={value}
                  onClick={() => setExperienceFilter(value)}
                  type="button"
                >
                  {label}
                </button>
              ))}
            </div>
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
            {/*
              FIELD-FORCE ELIGIBILITY. The wording is deliberately about the FIELD FORCE and not
              about the person: a paramedical degree is a refusal for a rep or a district manager and
              is perfectly normal for an office coordinator, so a bare "Not eligible" would be a
              false statement about a third of this pool.
            */}
            <label className="sr-only" htmlFor="cv-database-background">
              Academic background
            </label>
            <select
              className={selectClassName}
              id="cv-database-background"
              onChange={(event) => setBackgroundFilter(event.target.value as BackgroundOutcome | "")}
              value={backgroundFilter}
            >
              <option value="">Any background</option>
              <option value="eligible">Field-force eligible</option>
              <option value="paramedical">Paramedical — not for the field</option>
              <option value="unknown">Background not known</option>
            </select>
            <label className="sr-only" htmlFor="cv-database-graduation">
              Graduation year
            </label>
            <select
              className={selectClassName}
              id="cv-database-graduation"
              onChange={(event) => setGraduationFilter(event.target.value as GraduationBucket)}
              value={graduationFilter}
            >
              <option value="">Any graduation year</option>
              {graduationBuckets.map((bucket) => (
                <option key={bucket} value={bucket}>
                  {graduationBucketLabels[bucket]}
                </option>
              ))}
            </select>
            {/*
              "A GPA or letter grade" is a real option, not a leftover. Around fifty of the 318
              graded CVs record only `3.67`, `65%`, `B+ (3.462/4.0)` or `CGPA: 8.60`, and naming
              those needs an awarding scale we do not have. Folding them into "not on file" would
              claim their record is empty when it is not.
            */}
            <label className="sr-only" htmlFor="cv-database-grade">
              Degree grade
            </label>
            <select
              className={selectClassName}
              id="cv-database-grade"
              onChange={(event) => setGradeFilter(event.target.value as GradeFilter)}
              value={gradeFilter}
            >
              <option value="">Any grade</option>
              {gradeFilterOptions.map((option) => (
                <option key={option} value={option}>
                  {gradeFilterLabels[option]}
                </option>
              ))}
            </select>
            <label className="sr-only" htmlFor="cv-database-experience-band">
              Years of experience
            </label>
            <select
              className={selectClassName}
              id="cv-database-experience-band"
              onChange={(event) => setExperienceBand(event.target.value as ExperienceBand)}
              value={experienceBand}
            >
              <option value="">Any experience</option>
              {experienceBands.map((band) => (
                <option key={band} value={band}>
                  {experienceBandLabels[band]}
                </option>
              ))}
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
        </div>
      </AdminTableShell>

      <AdminTableShell
        action={
          <span
            className={cn(
              "inline-flex items-center border border-orange-200 bg-orange-50 px-2.5 py-1 text-xs font-bold tabular-nums text-orange-800",
              adminChipDepthClassName,
            )}
          >
            {filteredRows.length} of {rows.length} shown
          </span>
        }
        description="The same candidates as the Recruitment pool. Open one to read the CV and its extracted fields."
        title="Candidate records"
      >
        <PortalResponsiveDataList
          empty={
            <RecruitmentEmptyState
              icon={<Search aria-hidden="true" className="h-5 w-5" />}
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
                <RecruitmentPill tone={experiencePillTone(row.medicalSales)}>{experienceLabel(row.medicalSales)}</RecruitmentPill>
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
                  ...row.screeningAnswers.map((entry) => ({ label: entry.label, value: entry.answer })),
                ]}
              />
            </PortalRecordCard>
          )}
          renderTable={() => (
            <PortalDesktopTable
              cols={
                <colgroup>
                  <col className="w-[22%]" />
                  <col className="w-[24%]" />
                  <col className="w-[20%]" />
                  <col className="w-[22%]" />
                  <col className="w-[12%]" />
                </colgroup>
              }
            >
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
                  {/* Empty for almost every existing candidate — the admin question list is new and
                      most rows predate it. Costs nothing until an admin adds a question and someone
                      answers it, same as every other "nothing at all when there's nothing to say"
                      cell on this table. */}
                  <th className={headCellClassName}>Screening</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-phx-line">
                {filteredRows.map((row) => (
                  <tr className="transition-colors hover:bg-phx-paper" key={row.id}>
                    <td className={cellClassName}>
                      <Link
                        className="break-words font-bold text-phx-ink underline-offset-2 hover:text-phx-accent-press hover:underline"
                        href={`/recruitment?candidate=${encodeURIComponent(row.id)}`}
                      >
                        {emptyText(row.name)}
                      </Link>
                      <div className="mt-0.5 break-words text-phx-xs text-slate-500">
                        {`CV received ${emptyText(row.receivedOn)}`}
                      </div>
                      {row.cvFileName ? (
                        <div className="mt-0.5 break-words text-phx-xs text-slate-500">
                          {row.cvFileName}
                        </div>
                      ) : null}
                    </td>
                    <td className={cellClassName}>
                      <div className="break-words font-semibold text-phx-ink">
                        {emptyText(row.currentJobTitle)}
                      </div>
                      {row.currentEmployer ? (
                        <div className="mt-0.5 break-words text-phx-xs text-slate-500">
                          {row.currentEmployer}
                        </div>
                      ) : null}
                      <span className="mt-1.5 inline-flex flex-wrap items-center gap-2">
                        <RecruitmentPill tone={experiencePillTone(row.medicalSales)}>
                          {experienceLabel(row.medicalSales)}
                        </RecruitmentPill>
                        {row.medicalSalesDuration ? <span>{row.medicalSalesDuration}</span> : null}
                      </span>
                      {row.medicalSalesEmployer ? (
                        <div className="mt-0.5 break-words text-phx-xs text-slate-500">
                          {row.medicalSalesEmployer}
                        </div>
                      ) : null}
                      {row.totalExperience ? (
                        <div className="mt-0.5 break-words text-phx-xs text-slate-500">
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
                    <ScreeningAnswersCell row={row} />
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
