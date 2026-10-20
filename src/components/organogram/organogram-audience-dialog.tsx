"use client";

/**
 * "Select people" — pick a slice of the organogram (a whole line, a region and its
 * team, or free-hand ticks), then copy their work emails to the clipboard or export
 * just that slice as a sheet.
 *
 * Presentation only: every rule — what a filter means, what an empty tick set means,
 * which emails come out, what the sheet's columns are — lives in
 * `@/lib/reports/organogram-audience`. The rows handed in are already scoped to the
 * viewer server-side, so this can only ever narrow what they were already shown.
 */

import { Check, ClipboardCopy, Loader2, Users, X } from "lucide-react";
import * as React from "react";
import { createPortal } from "react-dom";

import { ExportXlsxButton } from "@/components/ui/export-xlsx-button";
import { useDialogA11y } from "@/components/ui/use-dialog-a11y";
import {
  EMPTY_ORGANOGRAM_AUDIENCE_FILTERS,
  ORGANOGRAM_AUDIENCE_FACETS,
  ORGANOGRAM_AUDIENCE_FACET_LABELS,
  ORGANOGRAM_EXPORT_COLUMNS,
  buildOrganogramAudienceOptions,
  buildOrganogramExportRows,
  collectOrganogramAudienceEmails,
  isOrganogramCompanyEmail,
  filterOrganogramAudience,
  formatOrganogramEmailList,
  organogramAudienceKey,
  organogramAudienceName,
  organogramAudienceRole,
  resolveOrganogramAudienceSelection,
  type OrganogramAudienceFacet,
  type OrganogramAudienceFilters,
} from "@/lib/reports/organogram-audience";
import { fetchOrganogramMobileNumbers } from "@/lib/reports/organogram-contact-numbers-client";
import type { OrganogramRow } from "@/lib/reports/organogram-view-model";
import { cn } from "@/lib/utils";
import { phxFieldClassName } from "@/components/ui/form-tokens";

type Props = {
  onClose: () => void;
  rows: OrganogramRow[];
  scopeLabel: string;
};

/**
 * Clipboard write with the legacy fallback kept deliberately: `navigator.clipboard` is
 * undefined outside a secure context, and a hundred addresses is precisely the case
 * where "select it yourself" is not an acceptable answer.
 */
async function writeToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the textarea path
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand("copy");
    document.body.removeChild(area);
    return copied;
  } catch {
    return false;
  }
}

function FacetChip({
  active,
  label,
  onToggle,
}: {
  active: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <button
      aria-pressed={active}
      className={cn(
        "inline-flex h-7 shrink-0 items-center gap-1 whitespace-nowrap border px-2.5 text-phx-xs font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phx-accent/40",
        active
          ? "border-phx-accent bg-phx-accent-soft text-phx-accent-press"
          : "border-phx-line bg-white text-slate-600 hover:border-phx-accent-line hover:text-phx-accent",
      )}
      onClick={onToggle}
      type="button"
    >
      {active ? <Check aria-hidden className="h-3 w-3" /> : null}
      {label}
    </button>
  );
}

export function OrganogramAudienceDialog({ onClose, rows, scopeLabel }: Props) {
  const dialogRef = useDialogA11y<HTMLDivElement>({ open: true, onClose });

  const [filters, setFilters] = React.useState<OrganogramAudienceFilters>(
    EMPTY_ORGANOGRAM_AUDIENCE_FILTERS,
  );
  const [selectedKeys, setSelectedKeys] = React.useState<Set<string>>(new Set());
  const [copying, setCopying] = React.useState(false);
  const [copied, setCopied] = React.useState<{ ok: boolean; text: string } | null>(null);

  const options = React.useMemo(
    () => buildOrganogramAudienceOptions(rows, filters),
    [rows, filters],
  );
  const filtered = React.useMemo(
    () => filterOrganogramAudience(rows, filters),
    [rows, filters],
  );
  const picked = React.useMemo(
    () => resolveOrganogramAudienceSelection(filtered, selectedKeys),
    [filtered, selectedKeys],
  );
  const { emails, missing, openSeats } = React.useMemo(
    () => collectOrganogramAudienceEmails(picked),
    [picked],
  );
  const exportRows = React.useMemo(() => buildOrganogramExportRows(picked), [picked]);
  // Numbers are pulled at export time so the dialog never holds them — see the header of
  // organogram-audience.ts. The server answers for the whole chart; only the picked rows
  // ever look themselves up in it.
  const resolveExportRows = React.useCallback(async () => {
    const mobileByHrId = await fetchOrganogramMobileNumbers();
    return buildOrganogramExportRows(picked, mobileByHrId);
  }, [picked]);

  const tickedCount = React.useMemo(
    () => filtered.filter((row) => selectedKeys.has(organogramAudienceKey(row))).length,
    [filtered, selectedKeys],
  );
  const usingTicks = tickedCount > 0;

  // The clipboard text IS the identity of what was copied, so the "Copied" flash is
  // DERIVED during render instead of reset from an effect: change the pick and the text
  // no longer matches, so the button returns to idle on its own. Deliberately not a
  // useEffect — `react-hooks/set-state-in-effect` rejects that as a cascading render,
  // and this version is also more truthful, since filtering away and straight back to
  // the same people leaves the same addresses genuinely still on the clipboard.
  const emailText = React.useMemo(() => formatOrganogramEmailList(emails), [emails]);
  const copyResult = copied && copied.text === emailText ? copied : null;
  const copyFailed = copyResult?.ok === false;
  const copySucceeded = copyResult?.ok === true;

  const toggleFacet = React.useCallback((facet: OrganogramAudienceFacet, value: string) => {
    setFilters((previous) => {
      const current = previous[facet];
      const next = current.includes(value)
        ? current.filter((entry) => entry !== value)
        : [...current, value];
      return { ...previous, [facet]: next };
    });
  }, []);

  const toggleRow = React.useCallback((key: string) => {
    setSelectedKeys((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const selectAllFiltered = React.useCallback(() => {
    setSelectedKeys(new Set(filtered.map((row) => organogramAudienceKey(row))));
  }, [filtered]);

  const clearAll = React.useCallback(() => {
    setSelectedKeys(new Set());
    setFilters(EMPTY_ORGANOGRAM_AUDIENCE_FILTERS);
  }, []);

  const handleCopy = React.useCallback(async () => {
    if (!emailText) return;
    setCopying(true);
    const ok = await writeToClipboard(emailText);
    setCopying(false);
    setCopied({ ok, text: emailText });
  }, [emailText]);

  if (typeof document === "undefined") return null;

  const peopleInPick = picked.filter((row) => row.type === "employee").length;

  const dialog = (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-[#020617]/65 p-3 backdrop-blur-sm sm:p-4">
      <div
        aria-label={`Select people — ${scopeLabel}`}
        aria-modal="true"
        className="flex max-h-[90vh] w-full max-w-6xl flex-col overflow-hidden rounded-lg border border-phx-line bg-white shadow-[0_28px_90px_rgba(15,23,42,0.3)]"
        ref={dialogRef}
        role="dialog"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4 border-b border-phx-line bg-gradient-to-br from-slate-800 to-slate-950 px-5 py-4 text-white">
          <div className="flex min-w-0 items-center gap-3">
            <span
              aria-hidden
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-white/10 ring-1 ring-white/20"
            >
              <Users className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <p className="whitespace-nowrap text-sm font-bold leading-tight">Select people</p>
              <p className="mt-0.5 break-words text-phx-xs font-medium text-orange-200">
                {scopeLabel}
              </p>
            </div>
          </div>
          <button
            aria-label="Close"
            className="rounded-md p-1 text-white/70 transition hover:bg-white/10 hover:text-white"
            onClick={onClose}
            type="button"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Filters — one horizontally scrolling chip row per facet, so a long area list
            never wraps into a wall and never truncates a name. */}
        <div className="space-y-2 border-b border-phx-line bg-slate-50/70 px-5 py-3">
          {ORGANOGRAM_AUDIENCE_FACETS.map((facet) => {
            const values = options[facet];
            if (values.length === 0) return null;
            return (
              <div className="flex items-center gap-3" key={facet}>
                <span className="w-14 shrink-0 whitespace-nowrap text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-400">
                  {ORGANOGRAM_AUDIENCE_FACET_LABELS[facet]}
                </span>
                {/*
                  Fits-the-screen golden rule (AGENTS.md §4). This was `flex-nowrap
                  overflow-x-auto`, so on a phone the Area row — the longest, one chip per area —
                  hid most of its own filters behind a sideways scroll the viewer had to discover.
                  Wrapping is the rule's permitted answer.
                */}
                <div className="flex flex-wrap items-center gap-1.5 py-0.5">
                  {values.map((value) => (
                    <FacetChip
                      active={filters[facet].includes(value)}
                      key={value}
                      label={value}
                      onToggle={() => toggleFacet(facet, value)}
                    />
                  ))}
                </div>
              </div>
            );
          })}

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <input
              aria-label="Search people"
              className={`${phxFieldClassName} min-w-0 flex-1`}
              onChange={(event) =>
                setFilters((previous) => ({ ...previous, search: event.target.value }))
              }
              placeholder="Search by name, HR ID, email, area…"
              type="search"
              value={filters.search}
            />
            <label className="inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap border border-phx-line bg-white px-2.5 text-phx-xs font-bold text-slate-600">
              <input
                checked={filters.includeOpenSeats}
                className="h-3.5 w-3.5 accent-phx-accent"
                onChange={(event) =>
                  setFilters((previous) => ({
                    ...previous,
                    includeOpenSeats: event.target.checked,
                  }))
                }
                type="checkbox"
              />
              Include open seats
            </label>
            <button
              className="inline-flex h-8 shrink-0 items-center whitespace-nowrap border border-phx-line bg-white px-2.5 text-phx-xs font-bold text-slate-600 transition hover:border-phx-accent-line hover:text-phx-accent"
              onClick={selectAllFiltered}
              type="button"
            >
              Tick all {filtered.length}
            </button>
            <button
              className="inline-flex h-8 shrink-0 items-center whitespace-nowrap border border-phx-line bg-white px-2.5 text-phx-xs font-bold text-slate-600 transition hover:border-phx-accent-line hover:text-phx-accent"
              onClick={clearAll}
              type="button"
            >
              Reset
            </button>
          </div>
        </div>

        {/* People — a table on desktop, cards on mobile. */}
        <div className="flex-1 overflow-auto">
          {filtered.length === 0 ? (
            <p className="px-5 py-10 text-center text-phx-md font-medium text-slate-500">
              No one matches these filters.
            </p>
          ) : (
            <>
              {/*
                Desktop — `table-fixed` with a `<colgroup>`, per the fits-the-screen golden rule.
                Every cell here carried `whitespace-nowrap` inside an `overflow-auto` parent, so
                a full work email beside a long name pushed the table past the dialog and the
                whole thing scrolled sideways at the narrower desktop widths. Fixed columns share
                the dialog's width instead, and the cells wrap.
              */}
              <table className="hidden w-full table-fixed border-collapse text-left md:table">
                <colgroup>
                  <col className="w-10" />
                  <col className="w-[26%]" />
                  <col className="w-[22%]" />
                  <col className="w-[18%]" />
                  <col className="w-[34%]" />
                </colgroup>
                <thead className="sticky top-0 z-10 bg-white">
                  <tr className="border-b border-phx-line">
                    {["", "Name", "Role", "Area", "Work Email"].map((label, index) => (
                      <th
                        className="break-words px-3 py-2 text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-400"
                        key={label || `col-${index}`}
                        scope="col"
                      >
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((row) => {
                    const key = organogramAudienceKey(row);
                    const isOpenSeat = row.type !== "employee";
                    const email = row.workEmail?.trim() ?? "";
                    return (
                      <tr
                        className={cn(
                          "border-b border-slate-100 transition hover:bg-phx-accent-soft",
                          selectedKeys.has(key) ? "bg-phx-accent-soft" : "",
                        )}
                        key={key}
                      >
                        <td className="px-3 py-1.5">
                          <input
                            aria-label={`Select ${organogramAudienceName(row)}`}
                            checked={selectedKeys.has(key)}
                            className="h-3.5 w-3.5 accent-phx-accent"
                            onChange={() => toggleRow(key)}
                            type="checkbox"
                          />
                        </td>
                        <td className="break-words px-3 py-1.5 text-phx-sm font-bold text-slate-800">
                          {isOpenSeat ? "Open Vacancy" : organogramAudienceName(row)}
                        </td>
                        <td className="break-words px-3 py-1.5 text-phx-sm font-medium text-slate-600">
                          {organogramAudienceRole(row)}
                        </td>
                        <td className="break-words px-3 py-1.5 text-phx-sm font-medium text-slate-600">
                          {row.areaName ?? row.regionName ?? row.lineName ?? "—"}
                        </td>
                        {/* `break-all`, not `break-words`: an email address has no space to break at. */}
                        <td className="break-all px-3 py-1.5 text-phx-sm font-medium">
                          {isOpenSeat ? (
                            <span className="text-slate-400">No occupant</span>
                          ) : email && isOrganogramCompanyEmail(email) ? (
                            <span className="text-slate-600">{email}</span>
                          ) : email ? (
                            <span className="font-bold text-rose-600">
                              Not a company address — {email}
                            </span>
                          ) : (
                            <span className="font-bold text-rose-600">No work email</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              {/* Mobile */}
              <ul className="divide-y divide-slate-100 md:hidden">
                {filtered.map((row) => {
                  const key = organogramAudienceKey(row);
                  const isOpenSeat = row.type !== "employee";
                  const email = row.workEmail?.trim() ?? "";
                  return (
                    <li key={key}>
                      <label
                        className={cn(
                          "flex cursor-pointer items-start gap-3 px-4 py-3",
                          selectedKeys.has(key) ? "bg-phx-accent-soft" : "",
                        )}
                      >
                        <input
                          checked={selectedKeys.has(key)}
                          className="mt-0.5 h-4 w-4 shrink-0 accent-phx-accent"
                          onChange={() => toggleRow(key)}
                          type="checkbox"
                        />
                        {/*
                          Each recipient row was its own horizontal scroller (`overflow-x-auto`
                          over `whitespace-nowrap` name and role), so a long Arabic name or a
                          title like "Group Product Manager" could only be read by dragging that
                          one row sideways. Both now wrap; nothing is truncated.
                        */}
                        <span className="min-w-0 flex-1">
                          <span className="block break-words text-phx-md font-bold text-slate-800">
                            {isOpenSeat ? "Open Vacancy" : organogramAudienceName(row)}
                          </span>
                          <span className="block break-words text-phx-xs font-medium text-slate-500">
                            {organogramAudienceRole(row)}
                            {row.areaName ? ` · ${row.areaName}` : ""}
                          </span>
                          <span
                            className={cn(
                              // `break-all`: this line is usually an email, which has no space to break at.
                              "block break-all text-phx-xs font-medium",
                              isOpenSeat
                                ? "text-slate-400"
                                : email && isOrganogramCompanyEmail(email)
                                  ? "text-slate-500"
                                  : "font-bold text-rose-600",
                            )}
                          >
                            {isOpenSeat
                              ? "No occupant"
                              : email && !isOrganogramCompanyEmail(email)
                                ? `Not a company address — ${email}`
                                : email || "No work email"}
                          </span>
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>

        {/* Actions */}
        <div className="space-y-2 border-t border-phx-line bg-slate-50/70 px-5 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="break-words text-phx-xs font-bold text-slate-500">
              {usingTicks
                ? `${tickedCount} ticked · ${emails.length} email${emails.length === 1 ? "" : "s"}`
                : `All ${peopleInPick} filtered · ${emails.length} email${emails.length === 1 ? "" : "s"}`}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <ExportXlsxButton
                columns={ORGANOGRAM_EXPORT_COLUMNS}
                label={`Export ${picked.length} to XLSX`}
                resolveRows={resolveExportRows}
                rows={exportRows}
                sheetName="Organogram"
                subtitle={`${scopeLabel} · ${picked.length} rows`}
                title={`Organogram — ${scopeLabel}`}
              />
              <button
                className={cn(
                  "inline-flex h-9 items-center gap-2 whitespace-nowrap border px-3 text-xs font-bold shadow-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phx-accent/40 disabled:opacity-50",
                  copySucceeded
                    ? "border-emerald-500 bg-emerald-50 text-emerald-700"
                    : "border-phx-accent bg-phx-accent text-white hover:bg-phx-accent-hover",
                )}
                disabled={emails.length === 0 || copying}
                onClick={handleCopy}
                type="button"
              >
                {copying ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : copySucceeded ? (
                  <Check className="h-3.5 w-3.5" />
                ) : (
                  <ClipboardCopy className="h-3.5 w-3.5" />
                )}
                {copySucceeded
                  ? `Copied ${emails.length}`
                  : `Copy ${emails.length} email${emails.length === 1 ? "" : "s"}`}
              </button>
            </div>
          </div>

          {/* Never a silent subset: say who was left out and why. */}
          {copyFailed ? (
            <p className="break-words text-phx-xs font-bold text-rose-600">
              The browser blocked the clipboard. Export the sheet instead.
            </p>
          ) : missing.length > 0 || openSeats > 0 ? (
            <p className="break-words text-phx-xs font-medium text-amber-700">
              Not in the copy:
              {missing.length > 0
                ? ` ${missing.length} with no company email (${missing
                    .slice(0, 3)
                    .map((person) => person.name)
                    .join(", ")}${missing.length > 3 ? ` and ${missing.length - 3} more` : ""})`
                : ""}
              {missing.length > 0 && openSeats > 0 ? " ·" : ""}
              {openSeats > 0 ? ` ${openSeats} open seat${openSeats === 1 ? "" : "s"}` : ""}
            </p>
          ) : (
            <p className="break-words text-phx-xs font-medium text-slate-400">
              Addresses are separated by a semicolon — paste straight into the To or Bcc field.
            </p>
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(dialog, document.body);
}
