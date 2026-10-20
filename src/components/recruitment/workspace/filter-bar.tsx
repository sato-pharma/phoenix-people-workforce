"use client";

// Recruitment workspace — every filter, the one search box, and the export of what they show.
//
// The owner, 20 Oct 2026: filters for "all possible varieties", combinable (every one ANDs with the
// rest); a received-date range that is free — any from, any to, an optional time — beside the quick
// picks; one search box for name, phone, email and the CV's own text across every tab he can see;
// and filters that START CLEAN on every visit. So nothing here is remembered in the browser: the URL
// is the only state (`serializeWorkspaceFilters`), and a fresh visit to the page has no query.
//
// What the filters MEAN is decided on the server (`workspaceDbParams`); this file only edits the
// shape. The answer filters are the tab's own WhatsApp questions, option by option, so they change
// with the tab and are cleared when the tab changes.
//
// Everything opens IN the bar — a panel that floats near the right edge is how a page grows a
// sideways scroll — and wraps on a phone.

import { CalendarRange, Download, FilterX, Search, SlidersHorizontal, X } from "lucide-react";
import { useRef, useState, type ReactNode, type RefObject } from "react";

import { adminChipDepthClassName, adminRecessedDepthClassName } from "@/components/admin/admin-design-tokens";
import {
  phxCheckInputClassName,
  phxCheckTileClassName,
  phxFieldClassName,
  phxLabelTextClassName,
  phxSelectClassName,
} from "@/components/ui/form-tokens";
import { candidateStatusLabels, candidateStatuses } from "@/lib/recruitment/candidate-status";
import { flattenCvFolderTree, type CvFolderNode } from "@/lib/recruitment/cv-folder-tree";
import {
  MISSING_ANSWER,
  activeFilterCount,
  emptyWorkspaceFilters,
  quickDatePickLabels,
  quickDatePicks,
  type ArchivedMode,
  type QuickDatePick,
  type WorkspaceFilters,
} from "@/lib/recruitment/workspace/filters";
import type { WorkspaceAnswerFilter } from "@/lib/recruitment/workspace/types";
import {
  callResultLabels,
  callResults,
  candidateSourceLabels,
  candidateSources,
  type CallResult,
  type CandidateSourceKey,
} from "@/lib/recruitment/workspace/vocabulary";
import { cn } from "@/lib/utils";

const NUMBER = new Intl.NumberFormat("en-US");
const SEARCH_DELAY_MS = 350;

const denseButton =
  "inline-flex h-9 items-center gap-1.5 border px-3 text-xs font-bold transition disabled:pointer-events-none disabled:opacity-50";

function toggle<T extends string>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

function FilterGroup({ children, legend }: { children: ReactNode; legend: string }) {
  return (
    <fieldset className="min-w-0 border-0 p-0">
      <legend className={cn(phxLabelTextClassName, "mb-1.5")}>{legend}</legend>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </fieldset>
  );
}

function CheckTile({ checked, children, onChange }: { checked: boolean; children: ReactNode; onChange: () => void }) {
  return (
    <label className={cn(phxCheckTileClassName(checked), "gap-1.5 px-2 py-1.5 text-xs")}>
      <input checked={checked} className={phxCheckInputClassName} onChange={onChange} type="checkbox" />
      <span className="break-words" dir="auto">
        {children}
      </span>
    </label>
  );
}

function Choice<T extends string>({
  onChange,
  options,
  value,
}: {
  onChange: (value: T) => void;
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
}) {
  return (
    <div className={`inline-flex flex-wrap border border-slate-200 bg-slate-100/80 p-0.5 ${adminRecessedDepthClassName}`}>
      {options.map((option) => (
        <button
          aria-pressed={value === option.value}
          className={cn(
            "px-2.5 py-1 text-xs font-bold transition",
            value === option.value ? cn("bg-white text-slate-950", adminChipDepthClassName) : "text-slate-600 hover:text-slate-900",
          )}
          key={option.value}
          onClick={() => onChange(option.value)}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

type Tri = "any" | "yes" | "no";
function triOf(value: boolean | null): Tri {
  return value === null ? "any" : value ? "yes" : "no";
}
function triValue(value: Tri): boolean | null {
  return value === "any" ? null : value === "yes";
}

/** One applied filter as a removable chip — what is narrowing the list, said in words. */
function AppliedChip({ children, onRemove }: { children: ReactNode; onRemove: () => void }) {
  return (
    <span className={cn("inline-flex max-w-full items-center gap-1 border border-orange-200 bg-orange-50 py-0.5 pl-2 pr-0.5 text-xs font-bold text-orange-900", adminChipDepthClassName)}>
      <span className="break-words" dir="auto">
        {children}
      </span>
      <button aria-label="Remove this filter" className="p-0.5 text-orange-700 transition hover:text-orange-950" onClick={onRemove} type="button">
        <X aria-hidden className="h-3.5 w-3.5" />
      </button>
    </span>
  );
}

export function FilterBar({
  answerFilters,
  byStatus,
  exportHref,
  filters,
  folders,
  onChange,
  onSearch,
  rangeProblem,
  searchRef,
  total,
}: {
  answerFilters: readonly WorkspaceAnswerFilter[] | null;
  byStatus: Partial<Record<string, number>> | undefined;
  exportHref: string | null;
  filters: WorkspaceFilters;
  folders: readonly CvFolderNode[];
  onChange: (next: WorkspaceFilters) => void;
  /** The search box, a beat after the last key — merged by the caller into its newest filters. */
  onSearch: (value: string) => void;
  rangeProblem: string | null;
  searchRef: RefObject<HTMLInputElement | null>;
  total: number | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const [customRange, setCustomRange] = useState(Boolean(filters.fromDate || filters.toDate));
  const [searchDraft, setSearchDraft] = useState(filters.search);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const count = activeFilterCount(filters);
  const set = (patch: Partial<WorkspaceFilters>) => onChange({ ...filters, ...patch, candidate: filters.candidate });

  const typeSearch = (value: string) => {
    setSearchDraft(value);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => onSearch(value.trim()), SEARCH_DELAY_MS);
  };

  const clearAll = () => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    setSearchDraft("");
    setCustomRange(false);
    onChange({ ...emptyWorkspaceFilters(), area: filters.area, region: filters.region, tab: filters.tab });
  };

  const answerLabel = (key: string, value: string) => {
    const filter = answerFilters?.find((entry) => entry.key === key);
    const label = value === MISSING_ANSWER ? "Not answered" : filter?.options.find((option) => option.value === value)?.label ?? value;
    return `${filter?.label ?? key}: ${label}`;
  };

  const flatFolders = flattenCvFolderTree(folders);
  const folderName = (id: string) => flatFolders.find((folder) => folder.id === id)?.path.join(" / ") ?? "A folder";

  const applied: Array<{ key: string; label: string; remove: () => void }> = [];
  for (const status of filters.statuses) {
    applied.push({
      key: `status-${status}`,
      label: `Status: ${candidateStatusLabels[status as keyof typeof candidateStatusLabels] ?? status}`,
      remove: () => set({ statuses: filters.statuses.filter((item) => item !== status) }),
    });
  }
  for (const source of filters.sources) {
    applied.push({ key: `source-${source}`, label: `Source: ${candidateSourceLabels[source]}`, remove: () => set({ sources: filters.sources.filter((item) => item !== source) }) });
  }
  if (filters.datePick) applied.push({ key: "date", label: `Received: ${quickDatePickLabels[filters.datePick]}`, remove: () => set({ datePick: null }) });
  if (!filters.datePick && (filters.fromDate || filters.toDate)) {
    const from = filters.fromDate ? `${filters.fromDate}${filters.fromTime ? ` ${filters.fromTime}` : ""}` : "the start";
    const to = filters.toDate ? `${filters.toDate}${filters.toTime ? ` ${filters.toTime}` : ""}` : "now";
    applied.push({
      key: "range",
      label: `Received: ${from} to ${to}`,
      remove: () => set({ fromDate: null, fromTime: null, toDate: null, toTime: null }),
    });
  }
  for (const [key, values] of Object.entries(filters.answers)) {
    for (const value of values) {
      applied.push({
        key: `a-${key}-${value}`,
        label: answerLabel(key, value),
        remove: () => {
          const rest = values.filter((item) => item !== value);
          const answers = { ...filters.answers };
          if (rest.length) answers[key] = rest;
          else delete answers[key];
          set({ answers });
        },
      });
    }
  }
  if (filters.missing !== null) applied.push({ key: "missing", label: filters.missing ? "Missing answers" : "Every answer given", remove: () => set({ missing: null }) });
  for (const result of filters.callResults) {
    applied.push({ key: `call-${result}`, label: `Call: ${callResultLabels[result]}`, remove: () => set({ callResults: filters.callResults.filter((item) => item !== result) }) });
  }
  if (filters.returned !== null) applied.push({ key: "returned", label: filters.returned ? "Returned by a manager" : "Not returned", remove: () => set({ returned: null }) });
  if (filters.overdue !== null) applied.push({ key: "overdue", label: filters.overdue ? "Overdue" : "Not overdue", remove: () => set({ overdue: null }) });
  for (const id of filters.folderIds) {
    applied.push({ key: `folder-${id}`, label: `Folder: ${folderName(id)}`, remove: () => set({ folderIds: filters.folderIds.filter((item) => item !== id) }) });
  }
  if (filters.archived !== "exclude") {
    applied.push({ key: "archived", label: filters.archived === "only" ? "Archived only" : "Archived included", remove: () => set({ archived: "exclude" }) });
  }

  return (
    <div className={`space-y-2.5 border border-slate-200 bg-slate-50/80 px-3 py-2.5 sm:px-3.5 ${adminRecessedDepthClassName}`}>
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative min-w-[14rem] grow basis-64">
          <span className="sr-only">Search every tab by name, phone, email or the CV&apos;s text</span>
          <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            className={cn(phxFieldClassName, "h-9 pl-8 pr-8 text-sm")}
            dir="auto"
            onChange={(event) => typeSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && searchDraft) typeSearch("");
            }}
            placeholder="Search every tab — name, phone, email, CV text"
            ref={searchRef}
            type="search"
            value={searchDraft}
          />
          {searchDraft ? (
            <button
              aria-label="Clear the search"
              className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 text-slate-400 transition hover:text-slate-700"
              onClick={() => typeSearch("")}
              type="button"
            >
              <X aria-hidden className="h-4 w-4" />
            </button>
          ) : null}
        </label>

        <div aria-label="Received" className={`flex flex-wrap border border-slate-200 bg-white p-0.5 ${adminChipDepthClassName}`} role="group">
          <button
            aria-pressed={!filters.datePick && !customRange}
            className={cn("px-2.5 py-1.5 text-xs font-bold transition", !filters.datePick && !customRange ? "bg-slate-900 text-white" : "text-slate-600 hover:text-slate-900")}
            onClick={() => {
              setCustomRange(false);
              set({ datePick: null, fromDate: null, fromTime: null, toDate: null, toTime: null });
            }}
            type="button"
          >
            Any time
          </button>
          {quickDatePicks.map((pick: QuickDatePick) => (
            <button
              aria-pressed={filters.datePick === pick}
              className={cn("px-2.5 py-1.5 text-xs font-bold transition", filters.datePick === pick ? "bg-slate-900 text-white" : "text-slate-600 hover:text-slate-900")}
              key={pick}
              onClick={() => {
                setCustomRange(false);
                set({ datePick: pick, fromDate: null, fromTime: null, toDate: null, toTime: null });
              }}
              type="button"
            >
              {quickDatePickLabels[pick]}
            </button>
          ))}
          <button
            aria-pressed={customRange && !filters.datePick}
            className={cn(
              "inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-bold transition",
              customRange && !filters.datePick ? "bg-slate-900 text-white" : "text-slate-600 hover:text-slate-900",
            )}
            onClick={() => {
              setCustomRange(true);
              if (filters.datePick) set({ datePick: null });
            }}
            type="button"
          >
            <CalendarRange aria-hidden className="h-3.5 w-3.5" />
            From – to
          </button>
        </div>

        <button
          aria-expanded={expanded}
          className={cn(
            denseButton,
            expanded ? "border-orange-400 bg-orange-50 text-orange-900" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-100",
          )}
          onClick={() => setExpanded((open) => !open)}
          type="button"
        >
          <SlidersHorizontal aria-hidden className="h-3.5 w-3.5" />
          Filters
          {count > 0 ? <span className="border border-orange-300 bg-white px-1 text-phx-xs font-black tabular-nums text-orange-800">{count}</span> : null}
        </button>
        {count > 0 ? (
          <button className={cn(denseButton, "border-slate-300 bg-white text-slate-700 hover:bg-slate-100")} onClick={clearAll} type="button">
            <FilterX aria-hidden className="h-3.5 w-3.5" />
            {`Clear filters (${count})`}
          </button>
        ) : null}
        {exportHref ? (
          <a className={cn(denseButton, "border-slate-900 bg-slate-900 text-white hover:bg-slate-800")} download href={exportHref}>
            <Download aria-hidden className="h-3.5 w-3.5" />
            Excel
          </a>
        ) : null}
        {total !== null ? (
          <span className="ml-auto text-xs font-bold tabular-nums text-slate-600">{total === 1 ? "1 CV" : `${NUMBER.format(total)} CVs`}</span>
        ) : null}
      </div>

      {customRange && !filters.datePick ? (
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1">
            <span className={phxLabelTextClassName}>From</span>
            <input className={cn(phxFieldClassName, "h-9 w-40 text-sm")} onChange={(event) => set({ fromDate: event.target.value || null, fromTime: event.target.value ? filters.fromTime : null })} type="date" value={filters.fromDate ?? ""} />
          </label>
          <label className="flex flex-col gap-1">
            <span className={phxLabelTextClassName}>At (optional)</span>
            <input className={cn(phxFieldClassName, "h-9 w-32 text-sm")} disabled={!filters.fromDate} onChange={(event) => set({ fromTime: event.target.value || null })} type="time" value={filters.fromTime ?? ""} />
          </label>
          <label className="flex flex-col gap-1">
            <span className={phxLabelTextClassName}>To</span>
            <input className={cn(phxFieldClassName, "h-9 w-40 text-sm")} onChange={(event) => set({ toDate: event.target.value || null, toTime: event.target.value ? filters.toTime : null })} type="date" value={filters.toDate ?? ""} />
          </label>
          <label className="flex flex-col gap-1">
            <span className={phxLabelTextClassName}>At (optional)</span>
            <input className={cn(phxFieldClassName, "h-9 w-32 text-sm")} disabled={!filters.toDate} onChange={(event) => set({ toTime: event.target.value || null })} type="time" value={filters.toTime ?? ""} />
          </label>
          <p className="pb-2 text-xs font-semibold text-slate-500">Cairo time. Without a time, the whole day counts.</p>
          {rangeProblem ? (
            <p className="basis-full text-xs font-bold text-rose-700" role="alert">
              {rangeProblem}
            </p>
          ) : null}
        </div>
      ) : null}

      {expanded ? (
        <div className="grid grid-cols-1 gap-x-5 gap-y-3.5 border-t border-slate-200 pt-3 md:grid-cols-2 2xl:grid-cols-3">
          <FilterGroup legend="Status">
            {candidateStatuses.map((status) => (
              <CheckTile checked={filters.statuses.includes(status)} key={status} onChange={() => set({ statuses: toggle(filters.statuses, status) })}>
                {candidateStatusLabels[status]}
                {byStatus && byStatus[status] !== undefined ? <span className="ml-1 tabular-nums text-slate-500">{NUMBER.format(byStatus[status] ?? 0)}</span> : null}
              </CheckTile>
            ))}
          </FilterGroup>
          <FilterGroup legend="Source">
            {candidateSources.map((source: CandidateSourceKey) => (
              <CheckTile checked={filters.sources.includes(source)} key={source} onChange={() => set({ sources: toggle(filters.sources, source) })}>
                {candidateSourceLabels[source]}
              </CheckTile>
            ))}
          </FilterGroup>
          <FilterGroup legend="Call result">
            {callResults.map((result: CallResult) => (
              <CheckTile checked={filters.callResults.includes(result)} key={result} onChange={() => set({ callResults: toggle(filters.callResults, result) })}>
                {callResultLabels[result]}
              </CheckTile>
            ))}
          </FilterGroup>
          <FilterGroup legend="Missing answers">
            <Choice<Tri>
              onChange={(value) => set({ missing: triValue(value) })}
              options={[
                { label: "Any", value: "any" },
                { label: "Missing some", value: "yes" },
                { label: "All answered", value: "no" },
              ]}
              value={triOf(filters.missing)}
            />
          </FilterGroup>
          <FilterGroup legend="Returned by a manager">
            <Choice<Tri>
              onChange={(value) => set({ returned: triValue(value) })}
              options={[
                { label: "Any", value: "any" },
                { label: "Returned", value: "yes" },
                { label: "Not returned", value: "no" },
              ]}
              value={triOf(filters.returned)}
            />
          </FilterGroup>
          <FilterGroup legend="Overdue">
            <Choice<Tri>
              onChange={(value) => set({ overdue: triValue(value) })}
              options={[
                { label: "Any", value: "any" },
                { label: "Overdue", value: "yes" },
                { label: "Not overdue", value: "no" },
              ]}
              value={triOf(filters.overdue)}
            />
          </FilterGroup>
          <FilterGroup legend="Archived">
            <Choice<ArchivedMode>
              onChange={(value) => set({ archived: value })}
              options={[
                { label: "Hide archived", value: "exclude" },
                { label: "Include archived", value: "include" },
                { label: "Archived only", value: "only" },
              ]}
              value={filters.archived}
            />
          </FilterGroup>
          <FilterGroup legend="Folder">
            <select
              aria-label="Folder"
              className={cn(phxSelectClassName, "h-9 w-full max-w-sm text-sm")}
              onChange={(event) => set({ folderIds: event.target.value ? [event.target.value] : [] })}
              value={filters.folderIds[0] ?? ""}
            >
              <option value="">Any folder</option>
              {flatFolders.map((folder) => (
                <option key={folder.id} value={folder.id}>
                  {`${"— ".repeat(folder.depth - 1)}${folder.name} (${folder.totalCount})`}
                </option>
              ))}
            </select>
          </FilterGroup>
          {(answerFilters ?? []).map((filter) => {
            const chosen = filters.answers[filter.key] ?? [];
            const flip = (value: string) => {
              const next = toggle(chosen, value);
              const answers = { ...filters.answers };
              if (next.length) answers[filter.key] = next;
              else delete answers[filter.key];
              set({ answers });
            };
            return (
              <FilterGroup key={filter.key} legend={filter.label}>
                {filter.options.map((option) => (
                  <CheckTile checked={chosen.includes(option.value)} key={option.value} onChange={() => flip(option.value)}>
                    {option.label}
                  </CheckTile>
                ))}
                <CheckTile checked={chosen.includes(MISSING_ANSWER)} onChange={() => flip(MISSING_ANSWER)}>
                  Not answered
                </CheckTile>
              </FilterGroup>
            );
          })}
          {answerFilters === null ? (
            <p className="text-xs font-semibold text-slate-500">This tab&apos;s answer filters could not be loaded.</p>
          ) : null}
        </div>
      ) : null}

      {applied.length > 0 ? (
        <div aria-label="Filters in use" className="flex flex-wrap items-center gap-1.5">
          {applied.map((chip) => (
            <AppliedChip key={chip.key} onRemove={chip.remove}>
              {chip.label}
            </AppliedChip>
          ))}
        </div>
      ) : null}
    </div>
  );
}

