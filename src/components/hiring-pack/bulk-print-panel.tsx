"use client";

// Print one HR paper for many employees at once — the third way to fill a paper on the HR Forms drive.
//
// The owner, 2026-10-04: "i want to be able to select and multiple print for many employees example
// print contract or form1 or 6 or any other form for 15 20 maybe 30 employee at once".
//
// The mechanism and why it is built on the single-print route are in `@/lib/hiring-pack/bulk-print`.
// What lives here is only the screen: pick the people, answer the same two questions every HR print
// asks (copies, company address), watch the papers render, then open ONE joined PDF and print it once.

import { Download, FileText, Loader2, Printer, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { PAPER_ISSUED_EVENT } from "@/components/hiring-pack/issue-paper-reference";
import { PrintOptionsDialog, type PrintAnswer } from "@/components/hiring-pack/print-options-dialog";
import { Button } from "@/components/ui/button";
import { ChoiceGroup } from "@/components/ui/choice-group";
import { Input } from "@/components/ui/input";
import {
  BULK_PRINT_CONCURRENCY,
  BULK_PRINT_MAX_EMPLOYEES,
  bulkPrintFileName,
  bulkPrintUrl,
  filterBulkCandidates,
  joinPdfs,
  runPool,
  type BulkPrintOutcome,
  type BulkPrintScope,
} from "@/lib/hiring-pack/bulk-print";
import { documentDefaultCopies } from "@/lib/hiring-pack/document-registry";
import { candidateOptionLabel, type FormsDriveEntry } from "@/lib/hiring-pack/forms-drive";
import {
  documentTakesAddressChoice,
  type PrintAddressChoice,
} from "@/lib/hiring-pack/print-address";
import type { HiringPackCandidate } from "@/lib/hiring-pack/types";

const SCOPES: ReadonlyArray<{ label: string; value: BulkPrintScope }> = [
  { label: "Everyone", value: "all" },
  { label: "Current", value: "current" },
  { label: "Left", value: "left" },
];

type Failure = { hrId: string; message: string; name: string };

type Run =
  | { status: "idle" }
  | { done: number; status: "running"; total: number }
  | {
      failures: Failure[];
      fileName: string;
      pages: number;
      printed: number;
      status: "done";
      url: string;
    }
  | { message: string; status: "failed" };

/** Today in Cairo, as YYYY-MM-DD — the date in the saved file's name. */
function cairoToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Cairo" });
}

async function readFailure(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: string };
    return body.message ?? `Request failed (${response.status}).`;
  } catch {
    return `Request failed (${response.status}).`;
  }
}

export function BulkPrintPanel({
  candidates,
  defaultCopies,
  entry,
}: {
  /** The people this paper offers — already narrowed to leavers for a leaving paper. */
  candidates: HiringPackCandidate[];
  /** The standing copy count of the paper: a company template's own, or the built-in's. */
  defaultCopies?: number;
  entry: FormsDriveEntry;
}) {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<BulkPrintScope>("all");
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [asking, setAsking] = useState(false);
  const [startEachOnNewSheet, setStartEachOnNewSheet] = useState(false);
  const [lastAddress, setLastAddress] = useState<PrintAddressChoice | null>(null);
  const [run, setRun] = useState<Run>({ status: "idle" });
  const urlRef = useRef<string | null>(null);

  // A finished run holds a Blob URL; letting go of it is the only thing that frees the joined file.
  const releaseUrl = useCallback(() => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
  }, []);
  useEffect(() => releaseUrl, [releaseUrl]);

  const shown = useMemo(
    () => filterBulkCandidates(candidates, query, scope),
    [candidates, query, scope],
  );
  const shownIds = useMemo(() => shown.map((candidate) => candidate.hrId), [shown]);
  const allShownSelected = shownIds.length > 0 && shownIds.every((hrId) => selected.has(hrId));
  const chosen = useMemo(
    () => candidates.filter((candidate) => selected.has(candidate.hrId)),
    [candidates, selected],
  );
  const running = run.status === "running";
  const overLimit = chosen.length > BULK_PRINT_MAX_EMPLOYEES;

  const toggle = useCallback((hrId: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(hrId)) next.delete(hrId);
      else next.add(hrId);
      return next;
    });
  }, []);

  const toggleShown = useCallback(() => {
    setSelected((current) => {
      const next = new Set(current);
      if (shownIds.every((hrId) => next.has(hrId))) {
        for (const hrId of shownIds) next.delete(hrId);
      } else {
        for (const hrId of shownIds) next.add(hrId);
      }
      return next;
    });
  }, [shownIds]);

  const start = useCallback(
    async (answer: PrintAnswer) => {
      setAsking(false);
      if (answer.address) setLastAddress(answer.address);
      releaseUrl();
      const people = chosen;
      setRun({ done: 0, status: "running", total: people.length });

      const outcomes = await runPool<HiringPackCandidate, BulkPrintOutcome>(
        people,
        BULK_PRINT_CONCURRENCY,
        async (person) => {
          const response = await fetch(
            bulkPrintUrl({
              address: answer.address,
              copies: answer.copies,
              document: entry.document,
              hrId: person.hrId,
              versionId: entry.versionId,
            }),
            { cache: "no-store" },
          );
          if (!response.ok) return { hrId: person.hrId, message: await readFailure(response), ok: false };
          if (!(response.headers.get("content-type") ?? "").includes("application/pdf")) {
            return { hrId: person.hrId, message: "The server did not return a PDF.", ok: false };
          }
          return { bytes: new Uint8Array(await response.arrayBuffer()), hrId: person.hrId, ok: true };
        },
        (person, error) => ({
          hrId: person.hrId,
          message: error instanceof Error ? error.message : "Could not render this paper.",
          ok: false,
        }),
        (done, total) => setRun({ done, status: "running", total }),
      );

      // A paper that rendered counts as printed even if the join below fails: the register already
      // took its number, exactly as it does for a single print.
      window.dispatchEvent(new Event(PAPER_ISSUED_EVENT));

      const nameOf = new Map(people.map((person) => [person.hrId, person.fullName]));
      const failures: Failure[] = [];
      const parts: Uint8Array[] = [];
      for (const outcome of outcomes) {
        if (outcome.ok) parts.push(outcome.bytes);
        else
          failures.push({
            hrId: outcome.hrId,
            message: outcome.message,
            name: nameOf.get(outcome.hrId) ?? outcome.hrId,
          });
      }

      if (parts.length === 0) {
        setRun({
          message:
            failures[0]?.message ??
            "No paper could be prepared. Nothing was joined and nothing needs printing.",
          status: "failed",
        });
        return;
      }

      try {
        const joined = await joinPdfs(parts, { startEachOnNewSheet });
        const blob = new Blob([joined.bytes as BlobPart], { type: "application/pdf" });
        const url = URL.createObjectURL(blob);
        urlRef.current = url;
        setRun({
          failures,
          fileName: bulkPrintFileName(entry.document, parts.length, cairoToday()),
          pages: joined.pages,
          printed: parts.length,
          status: "done",
          url,
        });
      } catch (cause) {
        setRun({
          message: cause instanceof Error ? cause.message : "The papers could not be joined into one file.",
          status: "failed",
        });
      }
    },
    [chosen, entry.document, entry.versionId, releaseUrl, startEachOnNewSheet],
  );

  return (
    <div className="flex flex-col gap-4">
      {asking ? (
        <PrintOptionsDialog
          askAddress={documentTakesAddressChoice(entry.document)}
          defaultCopies={defaultCopies ?? documentDefaultCopies(entry.document)}
          initialAddress={lastAddress}
          onCancel={() => setAsking(false)}
          onConfirm={(answer) => void start(answer)}
          registeredAddress={null}
          title={`${entry.label} — ${chosen.length} ${chosen.length === 1 ? "employee" : "employees"}`}
        />
      ) : null}

      <p className="flex items-start gap-2 border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-phx-ink-soft">
        <Printer className="mt-0.5 h-4 w-4 shrink-0 text-phx-accent-press" />
        <span>
          Tick the people, press Print, and answer the copies question once for all of them. Every
          paper is filled from that person&apos;s own record and takes its own number in the register;
          they are joined into one PDF so the printer dialog — and its double-sided tick — is used once.
        </span>
      </p>

      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
        <div className="relative min-w-0">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-phx-ink-faint" />
          <Input
            aria-label="Search employees"
            className="h-10 rounded-none pl-9"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by HR ID, name or job title"
            value={query}
          />
        </div>
        <ChoiceGroup
          aria-label="Which employees to list"
          className="grid-cols-3"
          onChange={setScope}
          options={SCOPES}
          value={scope}
        />
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <label className="inline-flex items-center gap-2 font-semibold text-phx-ink">
          <input
            checked={allShownSelected}
            className="h-4 w-4 accent-orange-600"
            disabled={shownIds.length === 0 || running}
            onChange={toggleShown}
            type="checkbox"
          />
          {allShownSelected ? "Clear the" : "Select all"} {shownIds.length} shown
        </label>
        <span className="font-semibold text-phx-ink-soft">
          {chosen.length} selected{chosen.length > shown.length ? " (including some not shown)" : ""}
        </span>
        {chosen.length > 0 ? (
          <button
            className="font-semibold text-phx-accent-press hover:underline disabled:opacity-50"
            disabled={running}
            onClick={() => setSelected(new Set())}
            type="button"
          >
            Clear selection
          </button>
        ) : null}
      </div>

      {candidates.length === 0 ? (
        <p className="border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-phx-ink-soft">
          Nobody is offered for this paper yet.
        </p>
      ) : shown.length === 0 ? (
        <p className="border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-phx-ink-soft">
          Nobody matches that search.
        </p>
      ) : (
        <ul className="max-h-96 overflow-y-auto border border-slate-200">
          {shown.map((candidate) => {
            const on = selected.has(candidate.hrId);
            return (
              <li className="border-b border-slate-100 last:border-b-0" key={candidate.hrId}>
                <label
                  className={`flex min-w-0 cursor-pointer items-start gap-3 px-4 py-2.5 text-sm ${
                    on ? "bg-orange-50/60" : "hover:bg-slate-50"
                  }`}
                >
                  <input
                    checked={on}
                    className="mt-0.5 h-4 w-4 shrink-0 accent-orange-600"
                    disabled={running}
                    onChange={() => toggle(candidate.hrId)}
                    type="checkbox"
                  />
                  <span className="min-w-0 break-words text-phx-ink">{candidateOptionLabel(candidate)}</span>
                </label>
              </li>
            );
          })}
        </ul>
      )}

      <label className="inline-flex items-start gap-2 text-sm text-phx-ink-soft">
        <input
          checked={startEachOnNewSheet}
          className="mt-0.5 h-4 w-4 shrink-0 accent-orange-600"
          disabled={running}
          onChange={(event) => setStartEachOnNewSheet(event.target.checked)}
          type="checkbox"
        />
        <span>
          Start each person on a fresh sheet — adds a blank back page after any paper with an odd number
          of pages, so a double-sided print never puts two people on one sheet. Form 1 and Form 6 never
          need it.
        </span>
      </label>

      {overLimit ? (
        <p className="border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {BULK_PRINT_MAX_EMPLOYEES} people is the most one run prepares. Untick{" "}
          {chosen.length - BULK_PRINT_MAX_EMPLOYEES} and print the rest in a second run.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          className="gap-2 rounded-none"
          disabled={chosen.length === 0 || overLimit || running}
          onClick={() => setAsking(true)}
          type="button"
        >
          <Printer className="h-4 w-4" />
          Print for {chosen.length} {chosen.length === 1 ? "employee" : "employees"}
        </Button>
        {running ? (
          <span className="inline-flex items-center gap-2 text-sm font-semibold text-phx-ink-soft">
            <Loader2 className="h-4 w-4 animate-spin" />
            Preparing {run.done} of {run.total}
          </span>
        ) : null}
      </div>

      {running ? (
        <div
          aria-label="Papers prepared"
          aria-valuemax={run.total}
          aria-valuemin={0}
          aria-valuenow={run.done}
          className="h-2 w-full bg-slate-100"
          role="progressbar"
        >
          <div
            className="h-2 bg-orange-500 transition-all"
            style={{ width: `${run.total === 0 ? 0 : Math.round((run.done / run.total) * 100)}%` }}
          />
        </div>
      ) : null}

      {run.status === "failed" ? (
        <p className="border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">{run.message}</p>
      ) : null}

      {run.status === "done" ? (
        <div className="flex flex-col gap-3 border border-emerald-200 bg-emerald-50 px-4 py-4">
          <p className="flex items-start gap-2 text-sm font-semibold text-emerald-900">
            <FileText className="mt-0.5 h-4 w-4 shrink-0" />
            {run.printed} {run.printed === 1 ? "paper is" : "papers are"} ready in one file — {run.pages}{" "}
            {run.pages === 1 ? "page" : "pages"}. Open it and print it once; for Form 1 and Form 6 tick
            “Print on both sides” and keep the scale at 100%.
          </p>
          <div className="flex flex-wrap gap-3">
            <Button
              className="gap-2 rounded-none"
              onClick={() => window.open(run.url, "_blank", "noopener,noreferrer")}
              type="button"
            >
              <Printer className="h-4 w-4" />
              Open to print
            </Button>
            <a
              className="inline-flex h-8 items-center gap-2 border border-slate-300 bg-white px-3 text-sm font-medium text-slate-800 hover:bg-slate-50"
              download={run.fileName}
              href={run.url}
            >
              <Download className="h-4 w-4" />
              Download the PDF
            </a>
          </div>
          {run.failures.length > 0 ? (
            <div className="border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-900">
              <p className="font-semibold">
                {run.failures.length} {run.failures.length === 1 ? "paper" : "papers"} could not be prepared
                and {run.failures.length === 1 ? "is" : "are"} not in the file:
              </p>
              <ul className="mt-1.5 flex flex-col gap-1">
                {run.failures.map((failure) => (
                  <li className="break-words" key={failure.hrId}>
                    <span className="font-semibold">{failure.name}</span> — {failure.message}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
