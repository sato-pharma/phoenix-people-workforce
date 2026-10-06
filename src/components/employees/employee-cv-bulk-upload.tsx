"use client";

import { CheckCircle2, FolderOpen, Loader2, X } from "lucide-react";
import * as React from "react";

import {
  matchCvFolder,
  type BulkCvEmployee,
  type BulkCvMatch,
} from "@/lib/employees/employee-cv-bulk";
// employee-cv-limits, NOT employee-cv: the server module pulls in node:crypto and the service-role
// client, and importing either into this client bundle is a webpack build error.
import {
  EMPLOYEE_CV_ACCEPT_ATTRIBUTE,
  MAX_EMPLOYEE_CV_BYTES,
  employeeCvHref,
} from "@/lib/employees/employee-cv-limits";
import { phxSelectClassName } from "@/components/ui/form-tokens";

/**
 * File a whole folder of CVs in one sitting.
 *
 * 184 people on this system have no CV on their record and most of those documents exist only in
 * an HR folder, named however the sender named them. One upload at a time through the record panel
 * is 96 separate journeys; this is the same act done once.
 *
 * 🔴 IT UPLOADS WHAT SOMEBODY CONFIRMED, NEVER WHAT IT MATCHED. Every file gets a row, every row
 * names the person it would be filed under, and a row the matcher is not sure about starts EMPTY
 * and cannot be sent until a person picks. The rule and the measurements behind it are in
 * employee-cv-bulk.ts; the short version is that a stranger's CV filed permanently under an
 * employee's name, and downloadable afterwards from the organogram, is worse than no CV at all.
 *
 * IT REUSES THE PER-EMPLOYEE ROUTE, one POST per confirmed row. No bulk endpoint, so there is no
 * second code path that could ever disagree with the single-file one about what a CV may be, who
 * may attach it, or what happens to the object already on the record.
 */

type RowStatus = "done" | "failed" | "pending" | "uploading";

type Row = BulkCvMatch & {
  file: File;
  message: string | null;
  status: RowStatus;
};

function rejectionFor(file: File): string | null {
  if (file.size > MAX_EMPLOYEE_CV_BYTES) return "Larger than 15 MB";
  if (file.size === 0) return "Empty file";
  if (!/\.(pdf|docx?|jpe?g|png|webp)$/i.test(file.name)) return "Not a CV file type";
  return null;
}

export function EmployeeCvBulkUpload({
  employees,
  onUploaded,
}: {
  employees: readonly BulkCvEmployee[];
  /** Re-read the directory once anything has actually been filed. */
  onUploaded: () => Promise<void> | void;
}) {
  const [open, setOpen] = React.useState(false);
  const [rows, setRows] = React.useState<Row[]>([]);
  const [busy, setBusy] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const ready = rows.filter((row) => row.hrId && row.status === "pending");
  const done = rows.filter((row) => row.status === "done").length;
  const failed = rows.filter((row) => row.status === "failed").length;

  function take(fileList: FileList | null) {
    const files = Array.from(fileList ?? []);
    if (files.length === 0) return;
    const matches = matchCvFolder(
      files.map((file) => file.name),
      employees,
    );
    setRows(
      files.map((file, index) => {
        const match = matches[index] as BulkCvMatch;
        const rejection = rejectionFor(file);
        return {
          ...match,
          file,
          // A file the server would refuse never gets a person attached to it: the row is a
          // statement about a document, and this one is not one we can file.
          ...(rejection ? { certain: false, hrId: null } : {}),
          message: rejection,
          status: rejection ? "failed" : "pending",
        };
      }),
    );
  }

  function assign(index: number, hrId: string) {
    setRows((current) =>
      current.map((row, position) =>
        position === index
          ? { ...row, hrId: hrId || null, message: null, status: hrId ? "pending" : row.status }
          : row,
      ),
    );
  }

  async function uploadAll() {
    setBusy(true);
    let filed = 0;
    // Sequential, not Promise.all: each of these is a whole document on Egyptian mobile data, and
    // firing ninety at once is how a save that would have worked times out instead.
    for (const target of ready) {
      const index = rows.indexOf(target);
      setRows((current) =>
        current.map((row, position) => (position === index ? { ...row, status: "uploading" } : row)),
      );
      try {
        const body = new FormData();
        body.append("file", target.file);
        const response = await fetch(employeeCvHref(target.hrId ?? ""), { body, method: "POST" });
        const payload = (await response.json().catch(() => ({}))) as { message?: string };
        if (!response.ok) throw new Error(payload.message || "The upload was refused.");
        filed += 1;
        setRows((current) =>
          current.map((row, position) =>
            position === index ? { ...row, message: null, status: "done" } : row,
          ),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "The upload failed.";
        setRows((current) =>
          current.map((row, position) =>
            position === index ? { ...row, message, status: "failed" } : row,
          ),
        );
      }
    }
    setBusy(false);
    // Only when something actually landed — a run where every row failed has not changed the
    // directory, and re-reading it would suggest otherwise.
    if (filed > 0) await onUploaded();
  }

  if (!open) {
    return (
      <button
        className="inline-flex h-10 items-center gap-2 border border-phx-line bg-white px-3 text-xs font-bold text-phx-ink-2 transition hover:bg-phx-paper"
        onClick={() => setOpen(true)}
        type="button"
      >
        <FolderOpen aria-hidden="true" className="h-4 w-4" />
        Upload CVs
      </button>
    );
  }

  return (
    <div className="w-full border border-phx-line bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-black uppercase tracking-widest text-phx-ink-2">
            Upload CVs from a folder
          </p>
          <p className="mt-1 break-words text-phx-xs leading-5 text-phx-ink-faint">
            Choose the folder. Every file gets a row naming the person it would be filed under —
            check each one before uploading. A file we cannot place with certainty is left blank
            for you to choose, and somebody who already has a CV is never picked for you.
          </p>
        </div>
        <button
          aria-label="Close"
          className="shrink-0 p-1 text-phx-ink-faint transition hover:text-phx-ink-2"
          onClick={() => {
            setOpen(false);
            setRows([]);
          }}
          type="button"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          accept={EMPLOYEE_CV_ACCEPT_ATTRIBUTE}
          className="hidden"
          multiple
          onChange={(event) => take(event.target.files)}
          ref={inputRef}
          type="file"
          // A folder picker where the browser has one, an ordinary multi-select where it does not:
          // webkitdirectory is not in React's typings but every browser this app runs on supports
          // it, and without it HR would have to select ninety files by hand.
          {...({ webkitdirectory: "" } as Record<string, string>)}
        />
        <button
          className="inline-flex h-9 items-center gap-2 border border-phx-line bg-white px-3 text-xs font-bold text-phx-ink-2 transition hover:bg-phx-paper"
          onClick={() => inputRef.current?.click()}
          type="button"
        >
          <FolderOpen aria-hidden="true" className="h-3.5 w-3.5" />
          Choose folder
        </button>
        {rows.length > 0 ? (
          <button
            className="inline-flex h-9 items-center gap-2 border border-phx-accent bg-phx-accent px-3 text-xs font-bold text-white transition disabled:opacity-50"
            disabled={busy || ready.length === 0}
            onClick={() => void uploadAll()}
            type="button"
          >
            {busy ? <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" /> : null}
            Upload {ready.length} CV{ready.length === 1 ? "" : "s"}
          </button>
        ) : null}
        {done > 0 || failed > 0 ? (
          <span className="text-phx-xs font-semibold text-phx-ink-faint">
            {done} filed{failed > 0 ? ` · ${failed} not filed` : ""}
          </span>
        ) : null}
      </div>

      {rows.length > 0 ? (
        <ul className="mt-3 space-y-1">
          {rows.map((row, index) => (
            <li
              className="flex flex-wrap items-center justify-between gap-2 border border-phx-line p-2"
              key={`${row.fileName}-${index}`}
            >
              <div className="min-w-0 flex-1">
                <p className="break-words text-phx-xs font-semibold text-phx-ink-2">{row.fileName}</p>
                {row.message ? (
                  <p className="break-words text-phx-2xs text-rose-700">{row.message}</p>
                ) : row.wouldReplace && !row.hrId ? (
                  <p className="break-words text-phx-2xs text-phx-ink-faint">
                    That person already has a CV — choosing them replaces it.
                  </p>
                ) : null}
              </div>
              {row.status === "done" ? (
                <span className="inline-flex shrink-0 items-center gap-1 text-phx-xs font-bold text-emerald-700">
                  <CheckCircle2 aria-hidden="true" className="h-3.5 w-3.5" />
                  Filed
                </span>
              ) : (
                <select
                  aria-label={`Who is ${row.fileName}?`}
                  className={`${phxSelectClassName} min-w-0 max-w-full`}
                  disabled={busy || row.status === "uploading"}
                  onChange={(event) => assign(index, event.target.value)}
                  value={row.hrId ?? ""}
                >
                  <option value="">Choose the person…</option>
                  {/* The people this file could be, best first, then everybody else — so an
                      unmatched file is still one dropdown away from being filed. */}
                  {row.candidates.map((candidate) => (
                    <option key={candidate.hrId} value={candidate.hrId}>
                      {candidate.displayName}
                      {candidate.hasCv ? " (replaces their CV)" : ""}
                    </option>
                  ))}
                  <option disabled value="">
                    ──────────
                  </option>
                  {employees
                    .filter((person) => !row.candidates.some((c) => c.hrId === person.hrId))
                    .map((person) => (
                      <option key={person.hrId} value={person.hrId}>
                        {person.displayName}
                        {person.hasCv ? " (replaces their CV)" : ""}
                      </option>
                    ))}
                </select>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
