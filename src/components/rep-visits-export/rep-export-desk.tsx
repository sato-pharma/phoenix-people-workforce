"use client";

import * as React from "react";
import { X } from "lucide-react";

import {
  phxButtonGhostClassName,
  phxButtonPrimaryClassName,
  phxCheckInputClassName,
  phxFieldClassName,
  phxLabelClassName,
  phxSelectClassName,
} from "@/components/ui/form-tokens";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  fileNameOf,
  probationMatches,
  retryWaitSeconds,
  reviewPeriodFor,
  REP_PROBATION_FILTERS,
  visitsPeriodFor,
  type RepProbationFilter,
  type RepProbationStanding,
} from "@/lib/rep-visits-export/desk";

export type RepExportDeskOption = {
  hrId: string;
  name: string;
  territory: string;
  line: string;
  hireDate: string | null;
  probation: RepProbationStanding;
};

const PROBATION_WORDS: Record<RepExportDeskOption["probation"], string> = {
  critical: "Probation: critical",
  warning: "Probation: warning",
  safe: "Probation: safe",
  overdue: "Probation ended, decision overdue",
  none: "",
  unread: "",
};

type Job = { hrId: string; name: string; url: string };
type Outcome = { hrId: string; name: string; fileName?: string; blob?: Blob; error?: string };
type Run = { label: string; done: number; total: number; waiting: string | null; outcomes: Outcome[]; finished: boolean; stopped: boolean };

/**
 * The Rep visits export page's rep desk (owner, 26 Nov 2026: "make me able to for example filter line pedia
 * probation status critical and filter from their hire date to utd", and of the download: "one or multiple as
 * i want").
 *
 * Filter the reps by line and by probation zone — the Probation tracker's own zones — then pick one rep, many,
 * or every rep that matches. Both downloads below read the same chosen reps. One rep saves its file as
 * before; several are made one after another and saved as one zip, with each rep that failed named and its
 * reason shown.
 *
 * "From each rep's hire date to today" gives every rep their own period: the visits from the hire date (at
 * most the export's day limit back), the review from the hire month (at most its month limit back).
 *
 * The routes allow ten exports a minute. A long run that meets the limit waits the time the route names and
 * carries on — it never drops a rep, and the limit is not raised for it.
 */
export function RepExportDesk({
  options,
  today,
  visitsRoute,
  reviewRoute,
  visitsMaxDays,
  reviewMaxMonths,
  visitsDefaultFrom,
  reviewDefaultFrom,
}: {
  options: RepExportDeskOption[];
  today: string;
  visitsRoute: string;
  reviewRoute: string;
  visitsMaxDays: number;
  reviewMaxMonths: number;
  visitsDefaultFrom: string;
  reviewDefaultFrom: string;
}) {
  const currentMonth = today.slice(0, 7);
  const lines = React.useMemo(() => [...new Set(options.map((option) => option.line))].sort((a, b) => a.localeCompare(b)), [options]);
  const probationUnread = options.some((option) => option.probation === "unread");

  const [line, setLine] = React.useState("");
  const [probation, setProbation] = React.useState<RepProbationFilter>("any");
  const [chosen, setChosen] = React.useState<string[]>([]);
  const [pickerKey, setPickerKey] = React.useState(0);

  const [visitsFrom, setVisitsFrom] = React.useState(visitsDefaultFrom);
  const [visitsTo, setVisitsTo] = React.useState(today);
  const [visitsFromHire, setVisitsFromHire] = React.useState(false);
  const [reviewFrom, setReviewFrom] = React.useState(reviewDefaultFrom);
  const [reviewTo, setReviewTo] = React.useState(currentMonth);
  const [reviewFromHire, setReviewFromHire] = React.useState(false);

  const [run, setRun] = React.useState<Run | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  const stopRef = React.useRef(false);
  const busy = Boolean(run && !run.finished);

  const byId = React.useMemo(() => new Map(options.map((option) => [option.hrId, option])), [options]);
  const matching = React.useMemo(
    () => options.filter((option) => (!line || option.line === line) && probationMatches(option.probation, probation)),
    [options, line, probation],
  );
  const chosenSet = new Set(chosen);
  const pickable = matching.filter((option) => !chosenSet.has(option.hrId));
  const chosenReps = chosen.map((hrId) => byId.get(hrId)).filter((option): option is RepExportDeskOption => Boolean(option));

  function addRep(hrId: string) {
    if (!hrId || chosenSet.has(hrId)) return;
    setChosen((list) => [...list, hrId]);
    setPickerKey((key) => key + 1);
    setNote(null);
  }

  function addAllMatching() {
    setChosen((list) => [...list, ...pickable.map((option) => option.hrId)]);
    setNote(null);
  }

  function visitsJobs(): Job[] | string {
    const jobs: Job[] = [];
    for (const rep of chosenReps) {
      const period = visitsPeriodFor(rep, { from: visitsFrom, to: visitsTo, fromHire: visitsFromHire, today, maxDays: visitsMaxDays });
      if ("error" in period) return period.error;
      jobs.push({ hrId: rep.hrId, name: rep.name, url: `${visitsRoute}?${new URLSearchParams({ rep: rep.hrId, ...period })}` });
    }
    return jobs;
  }

  function reviewJobs(format: "xlsx" | "pdf"): Job[] | string {
    const jobs: Job[] = [];
    for (const rep of chosenReps) {
      const period = reviewPeriodFor(rep, { from: reviewFrom, to: reviewTo, fromHire: reviewFromHire, today, maxMonths: reviewMaxMonths });
      if ("error" in period) return period.error;
      jobs.push({ hrId: rep.hrId, name: rep.name, url: `${reviewRoute}?${new URLSearchParams({ rep: rep.hrId, ...period, format })}` });
    }
    return jobs;
  }

  async function start(label: string, zipName: string, planned: Job[] | string) {
    if (busy) return;
    if (!chosenReps.length) {
      setNote("Choose at least one rep.");
      return;
    }
    if (typeof planned === "string") {
      setNote(planned);
      return;
    }
    setNote(null);
    stopRef.current = false;
    const outcomes: Outcome[] = [];
    setRun({ label, done: 0, total: planned.length, waiting: null, outcomes: [], finished: false, stopped: false });
    for (const job of planned) {
      if (stopRef.current) break;
      const outcome = await fetchExport(job, (waiting) => setRun((current) => (current ? { ...current, waiting } : current)), stopRef);
      outcomes.push(outcome);
      setRun((current) => (current ? { ...current, done: outcomes.length, waiting: null, outcomes: [...outcomes] } : current));
    }
    const files = outcomes.filter((outcome) => outcome.blob && outcome.fileName);
    if (planned.length === 1 && files.length === 1) {
      saveBlob(files[0].blob as Blob, files[0].fileName as string);
    } else if (files.length) {
      const JSZip = (await import("jszip")).default;
      const zip = new JSZip();
      for (const file of files) zip.file(file.fileName as string, file.blob as Blob);
      saveBlob(await zip.generateAsync({ type: "blob" }), zipName);
    }
    setRun((current) => (current ? { ...current, finished: true, stopped: stopRef.current, waiting: null } : current));
  }

  const many = chosenReps.length > 1;
  const visitsZip = visitsFromHire
    ? `Rep visits - ${chosenReps.length} reps - from hire dates to ${today}.zip`
    : `Rep visits - ${chosenReps.length} reps - ${visitsFrom} to ${visitsTo}.zip`;
  const reviewZip = (format: "xlsx" | "pdf") =>
    `Effectiveness reviews - ${chosenReps.length} reps - ${reviewFromHire ? `from hire months to ${currentMonth}` : `${reviewFrom} to ${reviewTo}`} - ${format === "pdf" ? "PDF" : "Excel"}.zip`;
  const failures = run?.outcomes.filter((outcome) => outcome.error) ?? [];
  const saved = run?.outcomes.filter((outcome) => outcome.blob).length ?? 0;

  return (
    <div className="space-y-5">
      <section className="space-y-3 border border-slate-200 bg-white p-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="min-w-0">
            <span className={phxLabelClassName}>Line</span>
            <select className={phxSelectClassName} value={line} onChange={(event) => setLine(event.target.value)}>
              <option value="">All lines</option>
              {lines.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label className="min-w-0">
            <span className={phxLabelClassName}>Probation</span>
            <select
              className={phxSelectClassName}
              disabled={probationUnread}
              value={probationUnread ? "any" : probation}
              onChange={(event) => setProbation(event.target.value as RepProbationFilter)}
            >
              {REP_PROBATION_FILTERS.map((filter) => (
                <option key={filter.value} value={filter.value}>
                  {filter.label}
                </option>
              ))}
            </select>
          </label>
          <label className="min-w-0 sm:col-span-2">
            <span className={phxLabelClassName}>Add a rep</span>
            <SearchableSelect
              key={pickerKey}
              aria-label="Add a rep"
              className={phxSelectClassName}
              defaultValue=""
              disabled={busy}
              maxResults={Math.max(pickable.length, 1)}
              noResultsText={matching.length ? "Every matching rep is already chosen" : "No rep matches the filters"}
              placeholder="Type a name or a territory"
              onValueChange={addRep}
            >
              {pickable.map((option) => (
                <option key={option.hrId} value={option.hrId}>
                  {option.name} · {option.territory}
                </option>
              ))}
            </SearchableSelect>
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-slate-600">
            {matching.length === 1 ? "1 rep matches" : `${matching.length} reps match`}
            {chosenReps.length ? ` · ${chosenReps.length} chosen` : ""}
          </p>
          <button type="button" className={phxButtonGhostClassName} disabled={busy || !pickable.length} onClick={addAllMatching}>
            {pickable.length ? `Add all ${pickable.length} matching` : "Add all matching"}
          </button>
          <button type="button" className={phxButtonGhostClassName} disabled={busy || !chosen.length} onClick={() => setChosen([])}>
            Clear the chosen reps
          </button>
        </div>

        {probationUnread ? (
          <p className="text-sm text-amber-800">The probation tracker could not be read just now, so the probation filter is off. Reload the page to try again.</p>
        ) : null}

        {chosenReps.length ? (
          <ul className="flex flex-wrap gap-2" aria-label="Chosen reps">
            {chosenReps.map((rep) => (
              <li key={rep.hrId} className="flex min-w-0 max-w-full items-start gap-2 border border-slate-300 bg-white px-2.5 py-1.5 text-sm">
                <span className="min-w-0 break-words">
                  <span className="font-semibold text-slate-900">{rep.name}</span>
                  <span className="text-slate-500">
                    {" "}
                    · {rep.territory} · {rep.line}
                    {rep.hireDate ? ` · hired ${dayLabel(rep.hireDate)}` : " · no hire date on record"}
                    {PROBATION_WORDS[rep.probation] ? ` · ${PROBATION_WORDS[rep.probation]}` : ""}
                  </span>
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${rep.name}`}
                  className="shrink-0 text-slate-500 hover:text-slate-900 disabled:opacity-40"
                  disabled={busy}
                  onClick={() => setChosen((list) => list.filter((hrId) => hrId !== rep.hrId))}
                >
                  <X className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-slate-500">No rep chosen yet. Pick one or more above; both downloads below use them.</p>
        )}
      </section>

      {note ? <p className="border-l-2 border-rose-600 pl-3 text-sm font-semibold text-rose-700">{note}</p> : null}

      {run ? (
        <div className="space-y-2 border-l-2 border-slate-900 pl-3 text-sm text-slate-700" aria-live="polite">
          <p className="font-semibold text-slate-900">
            {run.label}:{" "}
            {run.finished
              ? `${saved} of ${run.total} made${run.stopped ? ", stopped before the rest" : ""}${saved > 1 ? ", saved as one zip" : saved === 1 ? ", saved" : ""}.`
              : `${run.done} of ${run.total} done${run.waiting ? ` · ${run.waiting}` : ""}`}
          </p>
          {failures.length ? (
            <ul className="space-y-1">
              {failures.map((failure) => (
                <li key={failure.hrId} className="text-rose-700">
                  {failure.name}: {failure.error}
                </li>
              ))}
            </ul>
          ) : null}
          {busy ? (
            <button type="button" className={phxButtonGhostClassName} onClick={() => (stopRef.current = true)}>
              Stop after this rep
            </button>
          ) : null}
        </div>
      ) : null}

      <section className="space-y-3">
        <h2 className="text-base font-semibold text-slate-900">Visits workbook</h2>
        <div className="grid grid-cols-1 gap-3 border border-slate-200 bg-white p-4 sm:grid-cols-2 lg:grid-cols-4">
          <label className="min-w-0">
            <span className={phxLabelClassName}>From</span>
            <input
              type="date"
              value={visitsFrom}
              max={today}
              disabled={visitsFromHire}
              onChange={(event) => setVisitsFrom(event.target.value)}
              className={phxFieldClassName}
            />
          </label>
          <label className="min-w-0">
            <span className={phxLabelClassName}>To</span>
            <input
              type="date"
              value={visitsTo}
              max={today}
              disabled={visitsFromHire}
              onChange={(event) => setVisitsTo(event.target.value)}
              className={phxFieldClassName}
            />
          </label>
          <label className="flex min-w-0 items-end gap-2 pb-2 text-sm text-slate-700">
            <input type="checkbox" className={phxCheckInputClassName} checked={visitsFromHire} onChange={(event) => setVisitsFromHire(event.target.checked)} />
            <span>From each rep&apos;s hire date to today</span>
          </label>
          <div className="flex min-w-0 items-end">
            <button type="button" className={phxButtonPrimaryClassName} disabled={busy} onClick={() => start("Visits workbook", visitsZip, visitsJobs())}>
              {many ? `Download ${chosenReps.length} workbooks` : "Download the workbook"}
            </button>
          </div>
        </div>
        <p className="text-sm leading-6 text-slate-600">
          Up to {visitsMaxDays} days at a time; from the hire date, a rep hired longer ago starts {visitsMaxDays} days back. Every visit the rep
          saved is listed, including visits still waiting for a decision. Brick sales appear only for months whose closing is published.
        </p>
      </section>

      <section className="space-y-3 border-t border-slate-200 pt-5">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Effectiveness review</h2>
          <p className="mt-1 text-sm leading-6 text-slate-600">
            The rep&apos;s area over the published closing months you choose: how many pharmacies bought each product each month, every
            pharmacy month by month, sales against target, the area&apos;s history before the rep, where the growth came from, and the
            KPIs against their targets beside the district colleagues.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-3 border border-slate-200 bg-white p-4 sm:grid-cols-2 lg:grid-cols-5">
          <label className="min-w-0">
            <span className={phxLabelClassName}>From month</span>
            <input
              type="month"
              value={reviewFrom}
              max={currentMonth}
              disabled={reviewFromHire}
              onChange={(event) => setReviewFrom(event.target.value)}
              className={phxFieldClassName}
            />
          </label>
          <label className="min-w-0">
            <span className={phxLabelClassName}>To month</span>
            <input
              type="month"
              value={reviewTo}
              max={currentMonth}
              disabled={reviewFromHire}
              onChange={(event) => setReviewTo(event.target.value)}
              className={phxFieldClassName}
            />
          </label>
          <label className="flex min-w-0 items-end gap-2 pb-2 text-sm text-slate-700">
            <input type="checkbox" className={phxCheckInputClassName} checked={reviewFromHire} onChange={(event) => setReviewFromHire(event.target.checked)} />
            <span>From each rep&apos;s hire month to this month</span>
          </label>
          <div className="flex min-w-0 items-end">
            <button type="button" className={phxButtonPrimaryClassName} disabled={busy} onClick={() => start("Effectiveness review, Excel", reviewZip("xlsx"), reviewJobs("xlsx"))}>
              {many ? `Download ${chosenReps.length} as Excel` : "Download Excel"}
            </button>
          </div>
          <div className="flex min-w-0 items-end">
            <button type="button" className={phxButtonPrimaryClassName} disabled={busy} onClick={() => start("Effectiveness review, PDF", reviewZip("pdf"), reviewJobs("pdf"))}>
              {many ? `Download ${chosenReps.length} as PDF` : "Download PDF"}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

/** One rep's file. A 429 waits the time the route names, then asks again; it never drops the rep. */
async function fetchExport(job: Job, onWait: (text: string | null) => void, stopRef: React.RefObject<boolean>): Promise<Outcome> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(job.url, { credentials: "same-origin", cache: "no-store" });
    } catch {
      return { hrId: job.hrId, name: job.name, error: "The connection dropped. Try this rep again." };
    }
    if (response.status === 429) {
      const seconds = retryWaitSeconds(response.headers.get("retry-after"));
      onWait(`waiting ${seconds} seconds: ten exports a minute is the limit`);
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
      onWait(null);
      if (stopRef.current) return { hrId: job.hrId, name: job.name, error: "Stopped before this rep." };
      continue;
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { message?: string } | null;
      return { hrId: job.hrId, name: job.name, error: body?.message || `The download failed (${response.status}).` };
    }
    const blob = await response.blob();
    return { hrId: job.hrId, name: job.name, blob, fileName: fileNameOf(response.headers.get("content-disposition")) ?? `${job.name}.bin` };
  }
  return { hrId: job.hrId, name: job.name, error: "The export limit did not clear. Try this rep again in a minute." };
}

function saveBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function dayLabel(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}
