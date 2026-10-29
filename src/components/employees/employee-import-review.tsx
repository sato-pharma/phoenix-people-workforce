"use client";

import { AlertCircle, ArrowRight, Check, Download, X } from "lucide-react";
import * as React from "react";

import type { EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import {
  buildImportChangePreview,
  type ImportPersonChanges,
} from "@/lib/employees/employee-import-change-preview";
import { buildFixListEntries } from "@/lib/employees/employee-import-findings";
import type { EmployeeImportDryRunResponse } from "@/lib/imports/employee-import-types";
import { cn } from "@/lib/utils";

/**
 * The step between "here is a file" and "write it to the database".
 *
 * WHAT IT REPLACES. A summary bar of counts, the first TEN findings followed by "+N more", and a
 * Confirm button. On a file of any real size that asks someone to approve a number: it never said
 * whose salary moved, which manager was reassigned, or that one row would rename a person. For an
 * import that reaches payroll, approving a count is approving nothing.
 *
 * SO IT SHOWS CHANGES, NOT COUNTS. Every matched row is diffed against the record it will update
 * and only the fields that actually differ are listed, with money changes counted separately
 * because those are the ones worth a second look. The diff runs against the directory this page
 * already holds, so it costs no extra request.
 *
 * NOTHING IS TRUNCATED INTO A DEAD END. Long lists collapse behind a "Show all" that reveals them
 * in place — never "+240 more" with no way to see the 240. The full findings also download as a
 * workbook, which is the only form you can actually work through beside the sheet you are editing.
 *
 * ## The two golden rules this file obeys
 *
 * SQUARE EDGES. Nothing here is rounded. `tokens.css` ships `--phx-radius: 4px` and calls it "the
 * default for cards, inputs and buttons", so a component copied from a sibling inherits a rounded
 * corner silently — which is exactly why this one builds its own surfaces rather than reusing
 * `Card` (`rounded-xl`) or `Button`.
 *
 * FITS THE SCREEN. Every table is `w-full table-fixed` over a `<colgroup>` summing to 100%, with
 * no min-width floor and no `overflow-x-auto` — that pairing IS the bug the rule forbids. Long
 * values WRAP; nothing is truncated with an ellipsis, and nothing that can grow is
 * `whitespace-nowrap`, because clipped content adds nothing to `scrollWidth` and would certify a
 * layout that is in fact hanging off the side. Mobile gets cards, desktop gets the table.
 */

/** How many rows of a long list are shown before the reader asks for the rest. */
const COLLAPSED_ROWS = 20;

export type EmployeeImportReviewProps = {
  /** The directory the page already has — the "before" side of every diff. */
  employees: EmployeeDirectoryRow[];
  fileName: string;
  isConfirming: boolean;
  isDownloading: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  onDownloadFixList: () => void;
  preview: EmployeeImportDryRunResponse;
};

function Tile({
  caption,
  label,
  tone,
  value,
}: {
  caption: string;
  label: string;
  tone: "ok" | "info" | "danger" | "warn" | "muted";
  value: number;
}) {
  const toneClass = {
    danger: "text-phx-danger",
    info: "text-phx-info",
    muted: "text-text-secondary",
    ok: "text-phx-ok",
    warn: "text-phx-warn",
  }[tone];

  return (
    <div className="border border-border bg-card p-3">
      <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-secondary">{label}</p>
      <p className={cn("mt-1 text-2xl font-bold tabular-nums", toneClass)}>{value}</p>
      <p className="mt-1 text-[11px] leading-snug text-text-secondary">{caption}</p>
    </div>
  );
}

function SectionHeading({ children, note }: { children: React.ReactNode; note?: string }) {
  return (
    <div className="border-b border-border pb-2">
      <h3 className="text-sm font-bold text-text">{children}</h3>
      {note ? <p className="mt-1 text-xs leading-snug text-text-secondary">{note}</p> : null}
    </div>
  );
}

function ShowAllButton({
  hidden,
  onClick,
}: {
  hidden: number;
  onClick: () => void;
}) {
  return (
    <button
      className="mt-2 border border-border bg-card px-3 py-2 text-xs font-semibold text-text hover:bg-phx-info-bg focus-visible:outline-2 focus-visible:outline-phx-info"
      onClick={onClick}
      type="button"
    >
      {`Show all — ${hidden} more`}
    </button>
  );
}

function PersonChanges({ person }: { person: ImportPersonChanges }) {
  return (
    <div className="border border-border bg-card">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 border-b border-border px-3 py-2">
        <span className="text-sm font-bold text-text">{person.fullName}</span>
        {person.rowNumber === null ? null : (
          <span className="text-xs text-text-secondary">{`row ${person.rowNumber} in your file`}</span>
        )}
        <span className="ms-auto text-xs font-semibold text-text-secondary">
          {`${person.changes.length} change${person.changes.length === 1 ? "" : "s"}`}
        </span>
      </div>

      {/* Desktop: three fixed columns. Mobile: the same rows, stacked. */}
      <table className="hidden w-full table-fixed md:table">
        <colgroup>
          <col style={{ width: "34%" }} />
          <col style={{ width: "33%" }} />
          <col style={{ width: "33%" }} />
        </colgroup>
        <thead>
          <tr className="border-b border-border">
            <th className="px-3 py-1.5 text-start text-[11px] font-semibold uppercase tracking-[0.08em] text-text-secondary">
              Field
            </th>
            <th className="px-3 py-1.5 text-start text-[11px] font-semibold uppercase tracking-[0.08em] text-text-secondary">
              Now
            </th>
            <th className="px-3 py-1.5 text-start text-[11px] font-semibold uppercase tracking-[0.08em] text-text-secondary">
              Becomes
            </th>
          </tr>
        </thead>
        <tbody>
          {person.changes.map((change) => (
            <tr className="border-b border-border last:border-b-0" key={change.label}>
              <td className="break-words px-3 py-1.5 align-top text-xs font-semibold text-text">
                {change.label}
                {change.isMoney ? (
                  <span className="ms-2 text-[10px] font-bold uppercase tracking-[0.08em] text-phx-warn">
                    money
                  </span>
                ) : null}
              </td>
              <td className="break-words px-3 py-1.5 align-top text-xs text-text-secondary">{change.before}</td>
              <td
                className={cn(
                  "break-words px-3 py-1.5 align-top text-xs font-semibold",
                  change.isMoney ? "text-phx-warn" : "text-text",
                )}
              >
                {change.after}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <ul className="md:hidden">
        {person.changes.map((change) => (
          <li className="border-b border-border px-3 py-2 last:border-b-0" key={change.label}>
            <p className="text-xs font-semibold text-text">
              {change.label}
              {change.isMoney ? (
                <span className="ms-2 text-[10px] font-bold uppercase tracking-[0.08em] text-phx-warn">money</span>
              ) : null}
            </p>
            <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
              <span className="break-words text-text-secondary">{change.before}</span>
              <ArrowRight aria-hidden className="h-3 w-3 shrink-0 text-text-secondary" />
              <span
                className={cn("break-words font-semibold", change.isMoney ? "text-phx-warn" : "text-text")}
              >
                {change.after}
              </span>
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function EmployeeImportReview({
  employees,
  fileName,
  isConfirming,
  isDownloading,
  onCancel,
  onConfirm,
  onDownloadFixList,
  preview,
}: EmployeeImportReviewProps) {
  const [moneyOnly, setMoneyOnly] = React.useState(false);
  const [showAllPeople, setShowAllPeople] = React.useState(false);
  const [showAllFindings, setShowAllFindings] = React.useState(false);

  const changePreview = React.useMemo(
    () =>
      buildImportChangePreview({
        employees,
        records: preview.rowsToUpdate ?? [],
        socialInsuranceJobTitles: preview.socialInsuranceJobTitles,
      }),
    [employees, preview.rowsToUpdate, preview.socialInsuranceJobTitles],
  );

  const findings = React.useMemo(() => buildFixListEntries(preview), [preview]);
  const blockingCount = findings.filter((finding) => finding.severity === "Blocks the row").length;

  const shownPeople = React.useMemo(() => {
    const people = moneyOnly
      ? changePreview.people
          .map((person) => ({ ...person, changes: person.changes.filter((change) => change.isMoney) }))
          .filter((person) => person.changes.length > 0)
      : changePreview.people;
    return people;
  }, [changePreview.people, moneyOnly]);

  const visiblePeople = showAllPeople ? shownPeople : shownPeople.slice(0, COLLAPSED_ROWS);
  const visibleFindings = showAllFindings ? findings : findings.slice(0, COLLAPSED_ROWS);

  const missingColumns = preview.missingRequiredColumns ?? [];
  const blockedByColumns = missingColumns.length > 0;
  const creating = preview.rowsToInsert?.length ?? 0;
  const updating = preview.rowsToUpdate?.length ?? 0;

  return (
    <section className="border border-border bg-card">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border p-4">
        <div>
          <h2 className="text-base font-bold text-text">Review this import</h2>
          <p className="mt-1 break-words text-xs text-text-secondary">
            {`Nothing is written until you confirm. Reading ${fileName}.`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            className="inline-flex items-center gap-2 border border-border bg-card px-3 py-2 text-xs font-semibold text-text hover:bg-phx-info-bg focus-visible:outline-2 focus-visible:outline-phx-info disabled:opacity-60"
            disabled={isDownloading}
            onClick={onDownloadFixList}
            type="button"
          >
            <Download aria-hidden className="h-4 w-4" />
            Download what to fix
          </button>
          <button
            className="inline-flex items-center gap-2 border border-border bg-card px-3 py-2 text-xs font-semibold text-text hover:bg-phx-danger-bg focus-visible:outline-2 focus-visible:outline-phx-danger"
            onClick={onCancel}
            type="button"
          >
            <X aria-hidden className="h-4 w-4" />
            Cancel
          </button>
          <button
            className="inline-flex items-center gap-2 border border-phx-ok bg-phx-ok px-4 py-2 text-xs font-bold text-white hover:opacity-90 focus-visible:outline-2 focus-visible:outline-phx-ok disabled:opacity-60"
            disabled={isConfirming || blockedByColumns}
            onClick={onConfirm}
            type="button"
          >
            <Check aria-hidden className="h-4 w-4" />
            {isConfirming ? "Importing…" : "Confirm import"}
          </button>
        </div>
      </header>

      <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-4">
        <Tile
          caption="New Employee IDs. Each becomes an active employee."
          label="People created"
          tone="ok"
          value={creating}
        />
        <Tile
          caption="Matched to an existing person. Only filled cells are written."
          label="People updated"
          tone="info"
          value={updating}
        />
        <Tile
          caption="Blocked rows are skipped. The rest still import."
          label="Rows skipped"
          tone={preview.failedRows ? "danger" : "muted"}
          value={preview.failedRows ?? 0}
        />
        <Tile
          caption="These import as they are — check the value is what you meant."
          label="To review"
          tone={preview.warningRows ? "warn" : "muted"}
          value={preview.warningRows ?? 0}
        />
      </div>

      {blockedByColumns ? (
        <div className="mx-4 mb-4 border-s-4 border-s-phx-danger border-y border-e border-border bg-phx-danger-bg p-3">
          <p className="flex items-start gap-2 text-xs font-bold text-phx-danger">
            <AlertCircle aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="break-words">
              {`Nothing can import: the header row is missing ${missingColumns.join(", ")}. This usually means the file was rebuilt by hand — download the template again and paste your values into it.`}
            </span>
          </p>
        </div>
      ) : null}

      {/* ── what actually changes ── */}
      <div className="space-y-3 border-t border-border p-4">
        <SectionHeading
          note={
            changePreview.people.length === 0
              ? "None of the matched rows change anything — every filled cell already agrees with the record. A blank cell is skipped, never written."
              : `${changePreview.fieldChangeCount} field${changePreview.fieldChangeCount === 1 ? "" : "s"} across ${changePreview.people.length} ${changePreview.people.length === 1 ? "person" : "people"}${changePreview.moneyChangeCount > 0 ? `, ${changePreview.moneyChangeCount} of them money` : ""}. ${changePreview.unchangedPeopleCount} matched ${changePreview.unchangedPeopleCount === 1 ? "row changes" : "rows change"} nothing.`
          }
        >
          What changes
        </SectionHeading>

        {changePreview.moneyChangeCount > 0 ? (
          <div className="flex flex-wrap gap-2">
            <button
              className={cn(
                "border px-3 py-1.5 text-xs font-semibold focus-visible:outline-2 focus-visible:outline-phx-info",
                moneyOnly ? "border-border bg-card text-text-secondary" : "border-phx-info bg-phx-info-bg text-phx-info",
              )}
              onClick={() => setMoneyOnly(false)}
              type="button"
            >
              All changes
            </button>
            <button
              className={cn(
                "border px-3 py-1.5 text-xs font-semibold focus-visible:outline-2 focus-visible:outline-phx-warn",
                moneyOnly ? "border-phx-warn bg-phx-warn-bg text-phx-warn" : "border-border bg-card text-text-secondary",
              )}
              onClick={() => setMoneyOnly(true)}
              type="button"
            >
              {`Money only — ${changePreview.moneyChangeCount}`}
            </button>
          </div>
        ) : null}

        {visiblePeople.length > 0 ? (
          <div className="space-y-3">
            {visiblePeople.map((person) => (
              <PersonChanges key={person.hrId} person={person} />
            ))}
          </div>
        ) : null}

        {shownPeople.length > visiblePeople.length ? (
          <ShowAllButton hidden={shownPeople.length - visiblePeople.length} onClick={() => setShowAllPeople(true)} />
        ) : null}
      </div>

      {/* ── findings ── */}
      {findings.length > 0 ? (
        <div className="space-y-3 border-t border-border p-4">
          <SectionHeading
            note={`${blockingCount} block a row and will be skipped; ${findings.length - blockingCount} import as they are. Row is the row number in your own file.`}
          >
            {`What to fix — ${findings.length}`}
          </SectionHeading>

          <table className="hidden w-full table-fixed md:table">
            <colgroup>
              <col style={{ width: "9%" }} />
              <col style={{ width: "23%" }} />
              <col style={{ width: "17%" }} />
              <col style={{ width: "51%" }} />
            </colgroup>
            <thead>
              <tr className="border-y border-border bg-phx-info-bg/40">
                <th className="px-3 py-2 text-start text-[11px] font-semibold uppercase tracking-[0.08em] text-text-secondary">
                  Row
                </th>
                <th className="px-3 py-2 text-start text-[11px] font-semibold uppercase tracking-[0.08em] text-text-secondary">
                  Person
                </th>
                <th className="px-3 py-2 text-start text-[11px] font-semibold uppercase tracking-[0.08em] text-text-secondary">
                  Column
                </th>
                <th className="px-3 py-2 text-start text-[11px] font-semibold uppercase tracking-[0.08em] text-text-secondary">
                  What to fix
                </th>
              </tr>
            </thead>
            <tbody>
              {visibleFindings.map((finding, index) => (
                <tr className="border-b border-border" key={`${finding.code}-${finding.rowNumber ?? "file"}-${index}`}>
                  <td className="px-3 py-2 align-top text-xs font-semibold tabular-nums text-text">
                    {finding.rowNumber ?? "file"}
                  </td>
                  <td className="break-words px-3 py-2 align-top text-xs text-text">
                    <span className="font-semibold">{finding.fullName}</span>
                  </td>
                  <td className="break-words px-3 py-2 align-top text-xs text-text-secondary">{finding.column}</td>
                  <td className="break-words px-3 py-2 align-top text-xs">
                    <span
                      className={cn(
                        "font-semibold",
                        finding.severity === "Blocks the row" ? "text-phx-danger" : "text-phx-warn",
                      )}
                    >
                      {finding.severity === "Blocks the row" ? "Blocks — " : "Review — "}
                    </span>
                    <span className="text-text">{finding.message}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <ul className="space-y-2 md:hidden">
            {visibleFindings.map((finding, index) => (
              <li
                className="border border-border bg-card p-3"
                key={`${finding.code}-${finding.rowNumber ?? "file"}-${index}`}
              >
                <p className="flex flex-wrap items-baseline gap-x-2 text-xs">
                  <span className="font-bold text-text">{finding.fullName}</span>
                  <span className="text-text-secondary">
                    {finding.rowNumber === null ? "whole file" : `row ${finding.rowNumber}`}
                  </span>
                </p>
                <p className="mt-1 text-xs text-text-secondary">{finding.column}</p>
                <p className="mt-1 break-words text-xs">
                  <span
                    className={cn(
                      "font-semibold",
                      finding.severity === "Blocks the row" ? "text-phx-danger" : "text-phx-warn",
                    )}
                  >
                    {finding.severity === "Blocks the row" ? "Blocks — " : "Review — "}
                  </span>
                  <span className="text-text">{finding.message}</span>
                </p>
              </li>
            ))}
          </ul>

          {findings.length > visibleFindings.length ? (
            <ShowAllButton
              hidden={findings.length - visibleFindings.length}
              onClick={() => setShowAllFindings(true)}
            />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
