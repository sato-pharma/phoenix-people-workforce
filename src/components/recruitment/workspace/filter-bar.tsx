"use client";

// Recruitment workspace — every filter, the one search box, and the export of what they show.
//
// The owner, 20 Oct 2026: filters for "all possible varieties", combinable (every one ANDs with the
// rest); a received-date range that is free — any from, any to, an optional time — beside the quick
// picks; one search box for name, phone, email and the CV's own text across every tab he can see;
// and filters that START CLEAN on every visit. So nothing here is remembered in the browser: the URL
// is the only state (`serializeWorkspaceFilters`), and a fresh visit to the page has no query.
//
// The same evening: "a filter to exclude, for example, exclude shortlisted, exclude rejected, and do a
// premium God mood polish to the filters area". So status, source and call result each take TWO
// presses per value — the value itself shows ONLY it, the eye beside it HIDES it — and the status line
// sits open on the bar with its counts, because hiding a status is the filter he reaches for most.
// What a filter MEANS is decided in the database (`workspaceDbParams` -> `ats_workspace_filter`); this
// file only edits the shape.
//
// The tray, top to bottom: search and the total · Show (the decided toggle) and Received · Status, every
// status with its count, show-only or hide · the More filters panel · what is applied, in words.
// Everything opens IN the bar — a panel that floats near the right edge is how a page grows a sideways
// scroll — and every line wraps on a phone.

import { CalendarRange, Check, Download, EyeOff, FilterX, Search, SlidersHorizontal, X } from "lucide-react";
import { useRef, useState, type ReactNode, type RefObject } from "react";

import {
  adminChipDepthClassName,
  adminControlDepthClassName,
  adminRecessedDepthClassName,
  adminSoftDepthClassName,
} from "@/components/admin/admin-design-tokens";
import { recruitmentStackedToolbarClassName } from "@/components/recruitment/recruitment-premium";
import { statusEdgeClassName } from "@/components/recruitment/workspace/workspace-format";
import {
  phxCheckInputClassName,
  phxCheckTileClassName,
  phxFieldClassName,
  phxLabelTextClassName,
  phxSelectClassName,
} from "@/components/ui/form-tokens";
import { candidateStatusLabels, candidateStatuses, type CandidateStatus } from "@/lib/recruitment/candidate-status";
import { flattenCvFolderTree, type CvFolderNode } from "@/lib/recruitment/cv-folder-tree";
import {
  MISSING_ANSWER,
  activeFilterCount,
  decisionModeCount,
  decisionModeLabels,
  decisionModeOf,
  decisionModes,
  emptyWorkspaceFilters,
  keepOrHideOf,
  pressHide,
  pressKeep,
  statusesForDecisionMode,
  quickDatePickLabels,
  quickDatePicks,
  type ArchivedMode,
  type DecisionMode,
  type KeepOrHide,
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

/** A segmented group's tray and one of its presses — the decided toggle, Received and the three-way choices. */
const segmentTray = `inline-flex max-w-full flex-wrap border border-slate-200 bg-white p-0.5 ${adminChipDepthClassName}`;
function segmentPress(on: boolean): string {
  return cn(
    "inline-flex items-baseline gap-1.5 px-2.5 py-1.5 text-xs font-bold transition",
    on ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-50 hover:text-slate-900",
  );
}

function toggle<T extends string>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

/** A micro-caps label on the left of a line, so each line of the tray says what it is. */
function LineLabel({ children }: { children: ReactNode }) {
  return <span className={cn(phxLabelTextClassName, "w-[4.75rem] shrink-0")}>{children}</span>;
}

function FilterGroup({ children, hint, legend }: { children: ReactNode; hint?: string; legend: string }) {
  return (
    <fieldset className={`min-w-0 border border-slate-200 bg-white p-3 ${adminSoftDepthClassName}`}>
      <legend className="sr-only">{legend}</legend>
      <div aria-hidden className="mb-2 flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
        <span className={phxLabelTextClassName}>{legend}</span>
        {hint ? <span className="text-phx-xs font-semibold text-slate-400">{hint}</span> : null}
      </div>
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

/**
 * One value with its two presses: the value shows ONLY it (orange, ticked), the eye HIDES it (rose,
 * struck through). Pressing either again takes it back to any.
 */
function KeepHideTile({
  count,
  label,
  onHide,
  onKeep,
  state,
  swatch,
}: {
  count?: number | null;
  label: string;
  onHide: () => void;
  onKeep: () => void;
  state: KeepOrHide;
  swatch?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-stretch border text-xs font-bold transition",
        adminChipDepthClassName,
        state === "only"
          ? "border-orange-500 bg-orange-50 text-slate-900"
          : state === "hide"
            ? "border-rose-300 bg-rose-50 text-rose-800"
            : "border-slate-200 bg-white text-slate-700 hover:border-slate-400",
      )}
    >
      <button
        aria-pressed={state === "only"}
        className="inline-flex min-w-0 items-center gap-1.5 py-1.5 pl-2 pr-2 text-left"
        onClick={onKeep}
        title={state === "only" ? `Stop showing only ${label}` : `Show only ${label}`}
        type="button"
      >
        <span
          aria-hidden
          className={cn(
            "flex h-3.5 w-3.5 shrink-0 items-center justify-center border",
            state === "only" ? "border-orange-600 bg-orange-600 text-white" : "border-slate-300 bg-white",
          )}
        >
          {state === "only" ? <Check className="h-3 w-3" strokeWidth={3} /> : null}
        </span>
        {swatch ? <span aria-hidden className={cn("h-2.5 w-1 shrink-0", swatch, state === "hide" && "opacity-40")} /> : null}
        <span className={cn("break-words", state === "hide" && "line-through decoration-rose-400 decoration-2")} dir="auto">
          {label}
        </span>
        {count !== undefined && count !== null ? (
          <span className={cn("shrink-0 tabular-nums font-semibold", state === "hide" ? "text-rose-500" : "text-slate-400")}>{NUMBER.format(count)}</span>
        ) : null}
      </button>
      <button
        aria-label={state === "hide" ? `Stop hiding ${label}` : `Hide ${label}`}
        aria-pressed={state === "hide"}
        className={cn(
          "flex shrink-0 items-center border-l px-1.5 transition",
          state === "hide"
            ? "border-rose-300 bg-rose-600 text-white hover:bg-rose-700"
            : state === "only"
              ? "border-orange-200 text-slate-400 hover:bg-rose-50 hover:text-rose-700"
              : "border-slate-200 text-slate-400 hover:bg-rose-50 hover:text-rose-700",
        )}
        onClick={onHide}
        title={state === "hide" ? `Stop hiding ${label}` : `Hide ${label}`}
        type="button"
      >
        <EyeOff aria-hidden className="h-3.5 w-3.5" />
      </button>
    </span>
  );
}

function Choice<T extends string>({
  label,
  onChange,
  options,
  value,
}: {
  label: string;
  onChange: (value: T) => void;
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
}) {
  return (
    <div aria-label={label} className={segmentTray} role="group">
      {options.map((option) => (
        <button aria-pressed={value === option.value} className={segmentPress(value === option.value)} key={option.value} onClick={() => onChange(option.value)} type="button">
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** A labelled three-way choice inside the Flags card. */
function FlagLine({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="flex w-full flex-wrap items-center justify-between gap-x-3 gap-y-1">
      <span className="text-xs font-bold text-slate-700">{label}</span>
      {children}
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

type Applied = { key: string; label: string; remove: () => void; hiding?: boolean };

/** One applied filter as a removable chip — what is narrowing the list, said in words. Hiding reads rose. */
function AppliedChip({ chip }: { chip: Applied }) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1 border py-0.5 pl-2 pr-0.5 text-xs font-bold",
        chip.hiding ? "border-rose-200 bg-rose-50 text-rose-900" : "border-orange-200 bg-orange-50 text-orange-900",
        adminChipDepthClassName,
      )}
    >
      {chip.hiding ? <EyeOff aria-hidden className="h-3 w-3 shrink-0 text-rose-600" /> : null}
      <span className="break-words" dir="auto">
        {chip.label}
      </span>
      <button
        aria-label={`Remove: ${chip.label}`}
        className={cn("p-0.5 transition", chip.hiding ? "text-rose-600 hover:text-rose-950" : "text-orange-700 hover:text-orange-950")}
        onClick={chip.remove}
        type="button"
      >
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
  // A search cleared from OUTSIDE the bar (the empty list's "Clear the search and filters") empties the
  // box too, so it never shows text the list no longer searches for.
  const [seenSearch, setSeenSearch] = useState(filters.search);
  if (filters.search !== seenSearch) {
    setSeenSearch(filters.search);
    if (!filters.search && searchDraft) setSearchDraft("");
  }
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
  const statusLabel = (status: string) => candidateStatusLabels[status as CandidateStatus] ?? status;

  // The three keep-or-hide pairs, each press moving a value out of the other list.
  const keepStatus = (status: string) => {
    const next = pressKeep(filters.statuses, filters.excludeStatuses, status);
    set({ statuses: next.keep, excludeStatuses: next.hide });
  };
  const hideStatus = (status: string) => {
    const next = pressHide(filters.statuses, filters.excludeStatuses, status);
    set({ statuses: next.keep, excludeStatuses: next.hide });
  };
  const keepSource = (source: CandidateSourceKey) => {
    const next = pressKeep(filters.sources, filters.excludeSources, source);
    set({ sources: next.keep, excludeSources: next.hide });
  };
  const hideSource = (source: CandidateSourceKey) => {
    const next = pressHide(filters.sources, filters.excludeSources, source);
    set({ sources: next.keep, excludeSources: next.hide });
  };
  const keepCall = (result: CallResult) => {
    const next = pressKeep(filters.callResults, filters.excludeCallResults, result);
    set({ callResults: next.keep, excludeCallResults: next.hide });
  };
  const hideCall = (result: CallResult) => {
    const next = pressHide(filters.callResults, filters.excludeCallResults, result);
    set({ callResults: next.keep, excludeCallResults: next.hide });
  };

  const applied: Applied[] = [];
  const decision = decisionModeOf(filters.statuses, filters.excludeStatuses);
  // A press of the decided toggle reads back as the one word he pressed, not five status chips.
  if (decision === "decided" || decision === "undecided") {
    applied.push({ key: "decision", label: decisionModeLabels[decision], remove: () => set({ statuses: [] }) });
  } else {
    for (const status of filters.statuses) {
      applied.push({ key: `status-${status}`, label: `Only ${statusLabel(status)}`, remove: () => keepStatus(status) });
    }
  }
  for (const status of filters.excludeStatuses) {
    applied.push({ hiding: true, key: `not-status-${status}`, label: `Hiding ${statusLabel(status)}`, remove: () => hideStatus(status) });
  }
  for (const source of filters.sources) {
    applied.push({ key: `source-${source}`, label: `Only from ${candidateSourceLabels[source]}`, remove: () => keepSource(source) });
  }
  for (const source of filters.excludeSources) {
    applied.push({ hiding: true, key: `not-source-${source}`, label: `Hiding ${candidateSourceLabels[source]}`, remove: () => hideSource(source) });
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
    applied.push({ key: `call-${result}`, label: `Only latest call ${callResultLabels[result]}`, remove: () => keepCall(result) });
  }
  for (const result of filters.excludeCallResults) {
    applied.push({ hiding: true, key: `not-call-${result}`, label: `Hiding latest call ${callResultLabels[result]}`, remove: () => hideCall(result) });
  }
  if (filters.returned !== null) applied.push({ key: "returned", label: filters.returned ? "Returned by a manager" : "Not returned", remove: () => set({ returned: null }) });
  if (filters.overdue !== null) applied.push({ key: "overdue", label: filters.overdue ? "Overdue" : "Not overdue", remove: () => set({ overdue: null }) });
  for (const id of filters.folderIds) {
    applied.push({ key: `folder-${id}`, label: `Folder: ${folderName(id)}`, remove: () => set({ folderIds: filters.folderIds.filter((item) => item !== id) }) });
  }
  if (filters.archived !== "exclude") {
    applied.push({ key: "archived", label: filters.archived === "only" ? "Archived only" : "Archived included", remove: () => set({ archived: "exclude" }) });
  }

  // How many "More filters" are set — the panel's own badge, so a closed panel still says it holds something.
  const moreCount =
    (filters.sources.length || filters.excludeSources.length ? 1 : 0) +
    (filters.callResults.length || filters.excludeCallResults.length ? 1 : 0) +
    Object.values(filters.answers).filter((values) => values.length).length +
    (filters.missing !== null ? 1 : 0) +
    (filters.returned !== null ? 1 : 0) +
    (filters.overdue !== null ? 1 : 0) +
    (filters.folderIds.length ? 1 : 0) +
    (filters.archived !== "exclude" ? 1 : 0);

  return (
    <div className={recruitmentStackedToolbarClassName}>
      {/* 1 · Search, and what the filters leave */}
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative min-w-[13rem] grow basis-72">
          <span className="sr-only">Search every tab by name, phone, email or the CV&apos;s text</span>
          <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            className={cn(phxFieldClassName, "h-10 pl-9 pr-9 text-sm sm:pr-16")}
            dir="auto"
            onChange={(event) => typeSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && searchDraft) typeSearch("");
            }}
            placeholder="Search name, phone, email, CV"
            ref={searchRef}
            title="Searches every tab"
            type="search"
            value={searchDraft}
          />
          {searchDraft ? (
            <button
              aria-label="Clear the search"
              className="absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 text-slate-400 transition hover:text-slate-700"
              onClick={() => typeSearch("")}
              type="button"
            >
              <X aria-hidden className="h-4 w-4" />
            </button>
          ) : (
            <kbd
              aria-hidden
              className={`pointer-events-none absolute right-2.5 top-1/2 hidden -translate-y-1/2 border border-slate-200 bg-slate-50 px-1.5 text-phx-xs font-bold text-slate-400 sm:block ${adminRecessedDepthClassName}`}
              title="Press / to search"
            >
              /
            </kbd>
          )}
        </label>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {count > 0 ? (
            <button className={cn(denseButton, "border-slate-300 bg-white text-slate-700 hover:bg-slate-100", adminControlDepthClassName)} onClick={clearAll} type="button">
              <FilterX aria-hidden className="h-3.5 w-3.5" />
              {`Clear all (${count})`}
            </button>
          ) : null}
          {exportHref ? (
            <a className={cn(denseButton, "border-slate-900 bg-slate-900 text-white hover:bg-slate-800", adminControlDepthClassName)} download href={exportHref}>
              <Download aria-hidden className="h-3.5 w-3.5" />
              Excel
            </a>
          ) : null}
          {total !== null ? (
            <span aria-live="polite" className={`inline-flex h-9 items-baseline gap-1.5 border border-slate-200 bg-white px-3 leading-9 ${adminChipDepthClassName}`}>
              <span className="text-base font-black tabular-nums text-slate-950">{NUMBER.format(total)}</span>
              <span className="text-xs font-bold text-slate-500">{total === 1 ? "CV" : "CVs"}</span>
            </span>
          ) : null}
        </div>
      </div>

      {/* 2 · Show (the decided toggle) and Received */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <LineLabel>Show</LineLabel>
          <div aria-label="Decided or not" className={segmentTray} role="group">
            {decisionModes.map((mode: DecisionMode) => {
              const n = decisionModeCount(mode, byStatus);
              return (
                <button
                  aria-pressed={decision === mode}
                  className={segmentPress(decision === mode)}
                  key={mode}
                  onClick={() => set({ statuses: statusesForDecisionMode(mode), excludeStatuses: [] })}
                  type="button"
                >
                  {decisionModeLabels[mode]}
                  {n !== null ? <span className={cn("tabular-nums", decision === mode ? "text-white/70" : "text-slate-400")}>{NUMBER.format(n)}</span> : null}
                </button>
              );
            })}
          </div>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <LineLabel>Received</LineLabel>
          <div aria-label="Received" className={segmentTray} role="group">
            <button
              aria-pressed={!filters.datePick && !customRange}
              className={segmentPress(!filters.datePick && !customRange)}
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
                className={segmentPress(filters.datePick === pick)}
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
              className={cn(segmentPress(customRange && !filters.datePick), "items-center")}
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
        </div>
      </div>

      {customRange && !filters.datePick ? (
        <div className={`flex flex-wrap items-end gap-2 border border-slate-200 bg-white p-3 ${adminSoftDepthClassName}`}>
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

      {/* 3 · Status — every status with its count; the name shows only it, the eye hides it */}
      <div className="flex flex-wrap items-center gap-2">
        <LineLabel>Status</LineLabel>
        {/* basis-64: on a phone the group wants a whole line, so "More filters" drops under it instead of
            squeezing every tile into a sliver where the count slides under the eye. */}
        <div aria-label="Status — show only or hide" className="flex min-w-0 flex-1 basis-64 flex-wrap items-center gap-1.5" role="group">
          {candidateStatuses.map((status) => (
            <KeepHideTile
              count={byStatus ? (byStatus[status] ?? 0) : null}
              key={status}
              label={candidateStatusLabels[status]}
              onHide={() => hideStatus(status)}
              onKeep={() => keepStatus(status)}
              state={keepOrHideOf(filters.statuses, filters.excludeStatuses, status)}
              swatch={statusEdgeClassName[status]}
            />
          ))}
          <span className="inline-flex items-center gap-1 whitespace-nowrap text-phx-xs font-semibold text-slate-400">
            Name = show only · <EyeOff aria-hidden className="h-3 w-3" /> = hide
          </span>
        </div>
        <button
          aria-expanded={expanded}
          className={cn(
            denseButton,
            adminControlDepthClassName,
            "ml-auto",
            expanded ? "border-orange-400 bg-orange-50 text-orange-900" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-100",
          )}
          onClick={() => setExpanded((open) => !open)}
          type="button"
        >
          <SlidersHorizontal aria-hidden className="h-3.5 w-3.5" />
          {expanded ? "Fewer filters" : "More filters"}
          {moreCount > 0 ? <span className="border border-orange-300 bg-white px-1 text-phx-xs font-black tabular-nums text-orange-800">{moreCount}</span> : null}
        </button>
      </div>

      {expanded ? (
        <div className="grid grid-cols-1 gap-2.5 border-t border-slate-200 pt-3 @min-[640px]:grid-cols-2 @min-[1100px]:grid-cols-3">
          <FilterGroup hint="Name = only · eye = hide" legend="Source">
            {candidateSources.map((source: CandidateSourceKey) => (
              <KeepHideTile
                key={source}
                label={candidateSourceLabels[source]}
                onHide={() => hideSource(source)}
                onKeep={() => keepSource(source)}
                state={keepOrHideOf(filters.sources, filters.excludeSources, source)}
              />
            ))}
          </FilterGroup>
          <FilterGroup hint="A CV never called is never hidden" legend="Latest call">
            {callResults.map((result: CallResult) => (
              <KeepHideTile
                key={result}
                label={callResultLabels[result]}
                onHide={() => hideCall(result)}
                onKeep={() => keepCall(result)}
                state={keepOrHideOf(filters.callResults, filters.excludeCallResults, result)}
              />
            ))}
          </FilterGroup>
          <FilterGroup legend="Flags">
            <div className="flex w-full flex-col gap-2">
              <FlagLine label="Missing answers">
                <Choice<Tri>
                  label="Missing answers"
                  onChange={(value) => set({ missing: triValue(value) })}
                  options={[
                    { label: "Any", value: "any" },
                    { label: "Missing some", value: "yes" },
                    { label: "All answered", value: "no" },
                  ]}
                  value={triOf(filters.missing)}
                />
              </FlagLine>
              <FlagLine label="Returned by a manager">
                <Choice<Tri>
                  label="Returned by a manager"
                  onChange={(value) => set({ returned: triValue(value) })}
                  options={[
                    { label: "Any", value: "any" },
                    { label: "Returned", value: "yes" },
                    { label: "Not returned", value: "no" },
                  ]}
                  value={triOf(filters.returned)}
                />
              </FlagLine>
              <FlagLine label="Overdue">
                <Choice<Tri>
                  label="Overdue"
                  onChange={(value) => set({ overdue: triValue(value) })}
                  options={[
                    { label: "Any", value: "any" },
                    { label: "Overdue", value: "yes" },
                    { label: "Not overdue", value: "no" },
                  ]}
                  value={triOf(filters.overdue)}
                />
              </FlagLine>
              <FlagLine label="Archived">
                <Choice<ArchivedMode>
                  label="Archived"
                  onChange={(value) => set({ archived: value })}
                  options={[
                    { label: "Hide", value: "exclude" },
                    { label: "Include", value: "include" },
                    { label: "Only", value: "only" },
                  ]}
                  value={filters.archived}
                />
              </FlagLine>
            </div>
          </FilterGroup>
          <FilterGroup legend="Folder">
            <select
              aria-label="Folder"
              className={cn(phxSelectClassName, "h-9 w-full text-sm")}
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

      {/* 4 · What is applied, in words */}
      {applied.length > 0 ? (
        <div aria-label="Filters in use" className="flex flex-wrap items-center gap-1.5 border-t border-slate-200 pt-2.5">
          <span className={cn(phxLabelTextClassName, "mr-1")}>In use</span>
          {applied.map((chip) => (
            <AppliedChip chip={chip} key={chip.key} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
