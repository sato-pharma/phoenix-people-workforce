"use client";

// WHO CAN BE PRINTED — the whole payroll on one screen.
//
// THE PROBLEM IT SOLVES. The fill screen next door answers "what is this person missing?" perfectly,
// one person at a time. What nobody could see was the shape of the backlog: that most people are
// complete, that the ones who are not are mostly missing the SAME value, and that every Form 1 in
// the company is held up by two blank fields in a config file rather than by anything HR forgot to
// type. Answering that 108 times by hand is why the work went back to Excel.
//
// THE COMPANY BLOCKERS ARE SHOWN ONCE, AT THE TOP. `collectHiringPackGaps` reports them against
// every employee, which is right for one person looking at one form and wrong for a board — 108
// copies of "the tax registration number is missing" buries the per-person gaps under it and makes
// two missing values look like two hundred problems. Here they are one callout with the number of
// people they hold up, which is the size of the fix stated honestly.
//
// DESIGN IDENTITY is the fill screen's: the same `AdminTableShell`, the same stat cards, the same
// chips. It is one workflow — this half says who to open, that half opens them.
//
// FITS THE SCREEN. A plain `table-fixed` with a `<colgroup>` and three columns, never a min-width
// under an `overflow-x-auto`, and cards below `lg` instead of a squeezed table. Long values WRAP;
// nothing is cut with an ellipsis. Adding a fourth column is what breaks this — merge into an
// existing one instead. It WAS four: Contract and Form 1 each had a `w-[12%]` column, which
// measured 73px of content against a 95px `Company` pill, so the pill crossed into its neighbour.
// See `PapersCell` — merging was the fix, and shrinking the type would have been the bug.

import { AlertTriangle, CheckCircle2, FileSignature, IdCard, Search, ShieldAlert, Users } from "lucide-react";
import { useMemo, useState } from "react";

import {
  AdminCallout,
  AdminInsightChip,
  AdminStatCard,
  AdminTableShell,
} from "@/components/admin/admin-design-system";
import { Input } from "@/components/ui/input";
import { READINESS_DOCUMENTS } from "@/lib/hiring-pack/readiness";
import type { DerivedValue, HiringPackReadiness, ReadinessRow } from "@/lib/hiring-pack/readiness";
import { cn } from "@/lib/utils";

type StatusKey = "ready" | "company" | "blocked";

const STATUS_LABELS: Record<StatusKey, string> = {
  ready: "Printable now",
  company: "Waiting on the company",
  blocked: "Waiting on this person",
};

/**
 * One person, one verdict.
 *
 * OWN BLOCKERS OUTRANK THE COMPANY ONES. Somebody missing their own national ID is not "waiting on
 * the company" even though the company values are also missing — filling the two settings would not
 * make their paper printable, and putting them in that bucket would overstate what those two values
 * are worth.
 */
function rowStatus(row: ReadinessRow): StatusKey {
  if (READINESS_DOCUMENTS.some((document) => row.blockers[document].length > 0)) return "blocked";
  if (READINESS_DOCUMENTS.some((document) => row.readyExceptCompanySettings[document])) return "company";
  return "ready";
}

/**
 * What this person is missing, each value named once.
 *
 * The contract and Form 1 ask for many of the same things, so an undeduplicated list prints "Arabic
 * name" twice and reads like two separate problems.
 */
function missingLabels(row: ReadinessRow): string[] {
  const seen = new Map<string, string>();
  for (const document of READINESS_DOCUMENTS) {
    for (const gap of row.blockers[document]) seen.set(gap.field, gap.labelEn);
  }
  return [...seen.values()];
}

function statusPill(ready: boolean, waitingOnCompany: boolean) {
  if (ready) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-bold text-emerald-700 ring-1 ring-emerald-200">
        <CheckCircle2 className="h-3.5 w-3.5" /> Ready
      </span>
    );
  }
  if (waitingOnCompany) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2.5 py-1 text-xs font-bold text-amber-800 ring-1 ring-amber-200">
        <ShieldAlert className="h-3.5 w-3.5" /> Company
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-2.5 py-1 text-xs font-bold text-rose-700 ring-1 ring-rose-200">
      <AlertTriangle className="h-3.5 w-3.5" /> Blocked
    </span>
  );
}

/**
 * Both papers, labelled, in ONE column.
 *
 * They had a column each until the layout was measured at 1280px: the `Company` pill wants 95px and
 * a `w-[12%]` cell offers 73px, so it reached 10px past its own cell into the next one — and
 * `Company` is what 104 of the 108 rows carry for Form 1 today, so that was the ordinary case and
 * not an edge one. A percentage column cannot hold a fixed-width pill; it only gets tighter as the
 * window narrows, and the page's own `scrollWidth` never saw it because two `overflow-hidden`
 * ancestors sit above this board. Merging is the golden rule's own answer — never shrink the type —
 * and it has the second benefit that this cell and the mobile card are now the same markup.
 */
function PapersCell({ row }: { row: ReadinessRow }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-bold text-slate-500">Contract</span>
        {statusPill(row.ready.contract, row.readyExceptCompanySettings.contract)}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-bold text-slate-500">Form 1</span>
        {statusPill(row.ready.form1, row.readyExceptCompanySettings.form1)}
      </div>
    </div>
  );
}

/** What each derived value is called, and where it actually came from. */
const DERIVED_LABELS: Record<DerivedValue, string> = {
  birthDate: "date of birth",
  birthPlace: "place of birth",
  jobTitleAr: "Arabic job title",
  nationality: "nationality",
  qualification: "qualification",
};

const DERIVED_SOURCES: Record<DerivedValue, string> = {
  birthDate: "the national ID",
  birthPlace: "the national ID",
  jobTitleAr: "the Arabic list",
  nationality: "the company default",
  qualification: "the Arabic list",
};

/**
 * "date of birth and place of birth from the national ID; nationality from the company default".
 *
 * This line used to read "N values read from the national ID" for everything, which was already
 * wrong for the two Arabic-list values and would have credited the national ID with knowing a
 * person's nationality. A derived value is only honest if it says where it came from — that is the
 * whole reason these are shown rather than quietly filled in.
 */
function describeDerived(derived: readonly DerivedValue[]): string {
  const bySource = new Map<string, string[]>();
  for (const value of derived) {
    const source = DERIVED_SOURCES[value];
    bySource.set(source, [...(bySource.get(source) ?? []), DERIVED_LABELS[value]]);
  }

  return [...bySource.entries()]
    .map(([source, names]) => `${joinWords(names)} from ${source}`)
    .join("; ");
}

/** "a", "a and b", "a, b and c" — never a trailing "and" on a single item. */
function joinWords(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

function MissingCell({ row }: { row: ReadinessRow }) {
  const labels = missingLabels(row);

  return (
    <div className="flex flex-col gap-1.5">
      {labels.length === 0 ? (
        <span className="text-sm font-semibold text-emerald-700">Nothing — both papers print.</span>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {labels.map((label) => (
            <span
              className="rounded-md bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700"
              key={label}
            >
              {label}
            </span>
          ))}
        </div>
      )}
      {row.derived.length > 0 ? (
        <span className="text-xs font-medium text-slate-500">Filled in for you: {describeDerived(row.derived)}</span>
      ) : null}
      {row.idConflict ? (
        <span className="text-xs font-semibold leading-5 text-amber-700">{row.idConflict}</span>
      ) : null}
    </div>
  );
}

export function HiringPackReadinessBoard({
  onSelect,
  readiness,
  selectedHrId,
}: {
  onSelect: (hrId: string) => void;
  readiness: HiringPackReadiness;
  selectedHrId: string;
}) {
  const { rows, summary } = readiness;

  const counts = useMemo(() => {
    const tally: Record<StatusKey, number> = { ready: 0, company: 0, blocked: 0 };
    for (const row of rows) tally[rowStatus(row)] += 1;
    return tally;
  }, [rows]);

  // Opens on the actionable list. Everyone else is already summarised in the cards above it, so
  // landing on 90 rows that need nothing would bury the 18 that do.
  const [status, setStatus] = useState<StatusKey | "all">(counts.blocked > 0 ? "blocked" : "all");
  const [search, setSearch] = useState("");

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (status !== "all" && rowStatus(row) !== status) return false;
      if (!needle) return true;
      return [row.hrId, row.fullName, row.nameAr, row.jobTitle]
        .filter((value): value is string => Boolean(value))
        .some((value) => value.toLowerCase().includes(needle));
    });
  }, [rows, search, status]);

  const chips: { key: StatusKey | "all"; label: string; count: number }[] = [
    { key: "all", label: "Everyone", count: rows.length },
    { key: "ready", label: STATUS_LABELS.ready, count: counts.ready },
    { key: "company", label: STATUS_LABELS.company, count: counts.company },
    { key: "blocked", label: STATUS_LABELS.blocked, count: counts.blocked },
  ];

  return (
    <AdminTableShell
      action={
        <div className="flex flex-wrap items-center gap-2">
          <AdminInsightChip tone="emerald">{summary.ready.contract} contracts ready</AdminInsightChip>
          <AdminInsightChip tone="orange">{summary.ready.form1} Form 1 ready</AdminInsightChip>
        </div>
      }
      description="Every active employee, and exactly what stands between them and a signed contract or a filed Form 1. Open anyone from here — the fill screen below jumps to them."
      title="Who can be printed"
    >
      <div className="flex flex-col gap-5 px-5 py-5 sm:px-6">
        {summary.companyBlockers.length > 0 ? (
          <AdminCallout tone="danger">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="flex flex-col gap-1">
              <span className="font-bold">
                {summary.unlockedByCompanySettings.form1 + summary.unlockedByCompanySettings.contract > 0
                  ? `${summary.unlockedByCompanySettings.form1} people are complete and waiting only on the company.`
                  : "The company registration values are missing."}
              </span>
              <span className="leading-6">
                {summary.companyBlockers.map((gap) => `${gap.labelEn} (${gap.labelAr})`).join(" · ")}
                {" — these are the company's own registration numbers, the same on every form. They are set once, "}
                {"in the system settings, and every Form 1 above unblocks at the same moment."}
              </span>
            </div>
          </AdminCallout>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <AdminStatCard
            description="Active employees on the board."
            icon={<Users className="h-5 w-5" />}
            label="People"
            tone="blue"
            value={summary.people}
          />
          <AdminStatCard
            description={`${summary.blocked.contract} still need something of their own.`}
            icon={<FileSignature className="h-5 w-5" />}
            label="Contracts printable"
            tone="emerald"
            value={`${summary.ready.contract} of ${summary.people}`}
          />
          <AdminStatCard
            description={
              summary.companyBlockers.length > 0
                ? "Held up by the company values, not by these people."
                : `${summary.blocked.form1} still need something of their own.`
            }
            icon={<ShieldAlert className="h-5 w-5" />}
            label="Form 1 printable"
            tone={summary.companyBlockers.length > 0 ? "rose" : "emerald"}
            value={`${summary.ready.form1} of ${summary.people}`}
          />
          <AdminStatCard
            description={`${summary.arabicAnswersOutstanding} Arabic wordings are still unconfirmed.`}
            icon={<IdCard className="h-5 w-5" />}
            label="Waiting on the Arabic"
            tone="violet"
            value={summary.peopleWaitingOnArabicSeeds}
          />
        </div>

        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap gap-2">
            {chips.map((chip) => (
              <button
                className={cn(
                  "rounded-full border px-3 py-1.5 text-xs font-bold transition-colors",
                  status === chip.key
                    ? "border-slate-900 bg-slate-900 text-white"
                    : "border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:text-slate-900",
                )}
                key={chip.key}
                onClick={() => setStatus(chip.key)}
                type="button"
              >
                {chip.label} · {chip.count}
              </button>
            ))}
          </div>
          <label className="relative block w-full lg:max-w-xs">
            <span className="sr-only">Search the board</span>
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              className="pl-9"
              onChange={(event) => setSearch(event.target.value)}
              placeholder="HR ID, name or job title"
              value={search}
            />
          </label>
        </div>

        {visible.length === 0 ? (
          <p className="rounded-xl border border-dashed border-slate-200 px-4 py-6 text-center text-sm font-semibold text-slate-500">
            {search.trim()
              ? "Nobody on this list matches that search."
              : "Nobody is in this state — try another filter above."}
          </p>
        ) : (
          <>
            {/* Desktop. Four columns, fixed, no horizontal scroll — see the note at the top. */}
            <div className="hidden lg:block">
              <table className="w-full table-fixed border-collapse text-left">
                <colgroup>
                  <col className="w-[30%]" />
                  <col className="w-[24%]" />
                  <col className="w-[46%]" />
                </colgroup>
                <thead>
                  <tr className="border-b border-slate-200 text-xs font-bold uppercase tracking-wide text-slate-500">
                    <th className="px-3 py-2.5">Employee</th>
                    <th className="px-3 py-2.5">Papers</th>
                    <th className="px-3 py-2.5">What is still missing</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((row) => (
                    <tr
                      className={cn(
                        "border-b border-slate-100 align-top",
                        row.hrId === selectedHrId ? "bg-orange-50/70" : "hover:bg-slate-50/80",
                      )}
                      key={row.hrId}
                    >
                      <td className="px-3 py-3">
                        <button
                          className="text-left text-sm font-bold text-slate-900 underline-offset-4 hover:text-phx-accent-press hover:underline"
                          onClick={() => onSelect(row.hrId)}
                          type="button"
                        >
                          {row.fullName}
                        </button>
                        <p className="mt-0.5 text-xs font-medium leading-5 text-slate-500">
                          {row.hrId}
                          {row.jobTitle ? ` · ${row.jobTitle}` : ""}
                        </p>
                        {row.nameAr ? (
                          <p className="mt-0.5 text-xs font-semibold text-slate-600" dir="rtl">
                            {row.nameAr}
                          </p>
                        ) : null}
                      </td>
                      <td className="px-3 py-3">
                        <PapersCell row={row} />
                      </td>
                      <td className="px-3 py-3">
                        <MissingCell row={row} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile. Cards, never the table — the admin shell's rule, and four columns cannot fit 375px. */}
            <ul className="flex flex-col gap-3 lg:hidden">
              {visible.map((row) => (
                <li
                  className={cn(
                    "rounded-xl border p-4",
                    row.hrId === selectedHrId ? "border-orange-300 bg-orange-50/70" : "border-slate-200 bg-white",
                  )}
                  key={row.hrId}
                >
                  <button
                    className="text-left text-sm font-bold text-slate-900 underline-offset-4 hover:underline"
                    onClick={() => onSelect(row.hrId)}
                    type="button"
                  >
                    {row.fullName}
                  </button>
                  <p className="mt-0.5 text-xs font-medium leading-5 text-slate-500">
                    {row.hrId}
                    {row.jobTitle ? ` · ${row.jobTitle}` : ""}
                  </p>
                  <div className="mt-2.5">
                    <PapersCell row={row} />
                  </div>
                  <div className="mt-3">
                    <MissingCell row={row} />
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </AdminTableShell>
  );
}
