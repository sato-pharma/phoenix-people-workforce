"use client";

import { Search, UserPlus, X } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";

import { phxButtonGhostClassName, phxButtonPrimaryClassName, phxCheckInputClassName, phxCheckTileClassName, phxFieldClassName, phxLabelTextClassName, phxSelectClassName } from "@/components/ui/form-tokens";
import { SYSTEM_AUDIT_SCOPE_LABELS, SYSTEM_AUDIT_SORT_LABELS } from "@/lib/system-audit/incidents-display";
import type { SystemAuditQuery } from "@/lib/system-audit/page-query";
import {
  ROOT_CAUSE_LEVELS,
  ROOT_CAUSE_LEVEL_LABELS,
  SYSTEM_AUDIT_FAMILIES,
  SYSTEM_AUDIT_FAMILY_LABELS,
  SYSTEM_AUDIT_SORTS,
  SYSTEM_AUDIT_STATUSES,
  SYSTEM_AUDIT_STATUS_LABELS,
  type SharedScope,
  type SystemAuditSort,
} from "@/lib/system-audit/types";
import { cn } from "@/lib/utils";

/**
 * The Incidents filters. Every choice applies at once (the list refetches through
 * /api/admin/system-audit); the two typed boxes — the free search and the person finder — apply on
 * Enter or their button, so a half-typed word never fires a query.
 *
 * Dense `h-9` filter controls are the owner's own exemption from the 40px form field; everything
 * else is the shared form token. Choice lists open IN PLACE (a <details> in the flow), never as a
 * floating panel that could cross the screen edge.
 */

export type IncidentFilters = SystemAuditQuery["filters"];

export type PersonOption = { hrKey: string; hrId: string; name: string };

const denseField = cn(phxFieldClassName, "h-9 px-2");
const denseSelect = cn(phxSelectClassName, "h-9 px-2");
const denseLabel = cn("mb-1 block", phxLabelTextClassName);

function ChoiceList<T extends string>({
  label,
  options,
  selected,
  onChange,
  disabled,
  emptyNote,
}: {
  label: string;
  options: ReadonlyArray<{ value: T; label: string }>;
  selected: readonly T[];
  onChange: (next: T[]) => void;
  disabled?: boolean;
  emptyNote?: ReactNode;
}) {
  const summary = selected.length === 0 ? "All" : `${selected.length} chosen`;
  return (
    <details className="min-w-0 border border-slate-300 bg-white">
      <summary className="flex cursor-pointer items-center justify-between gap-2 px-2 py-2 text-xs font-bold text-slate-700">
        <span className="min-w-0 break-words">
          <span className={phxLabelTextClassName}>{label}</span> · {summary}
        </span>
      </summary>
      <div className="max-h-72 space-y-1 overflow-y-auto border-t border-slate-200 p-2">
        {options.length === 0 ? <p className="text-xs text-slate-500">{emptyNote ?? "Nothing to choose from."}</p> : null}
        {options.map((option) => {
          const checked = selected.includes(option.value);
          return (
            <label className={cn(phxCheckTileClassName(checked), "py-1.5 text-xs")} key={option.value}>
              <input
                checked={checked}
                className={phxCheckInputClassName}
                disabled={disabled}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? [...selected, option.value]
                      : selected.filter((value) => value !== option.value),
                  )
                }
                type="checkbox"
              />
              <span className="min-w-0 break-words">{option.label}</span>
            </label>
          );
        })}
        {selected.length > 0 ? (
          <button className="text-xs font-bold text-orange-700 underline-offset-2 hover:underline" onClick={() => onChange([])} type="button">
            Clear {label.toLowerCase()}
          </button>
        ) : null}
      </div>
    </details>
  );
}

const STATUS_OPTIONS = SYSTEM_AUDIT_STATUSES.map((value) => ({ value, label: SYSTEM_AUDIT_STATUS_LABELS[value] }));
const LEVEL_OPTIONS = ROOT_CAUSE_LEVELS.map((value) => ({ value, label: ROOT_CAUSE_LEVEL_LABELS[value] }));
const FAMILY_OPTIONS = SYSTEM_AUDIT_FAMILIES.map((value) => ({ value, label: SYSTEM_AUDIT_FAMILY_LABELS[value] }));

export function IncidentsFilters({
  filters,
  sort,
  moduleOptions,
  modulesError,
  peopleNames,
  disabled,
  onApply,
  onRememberPeople,
  onReset,
}: {
  filters: IncidentFilters;
  sort: SystemAuditSort;
  moduleOptions: string[] | null;
  modulesError: string | null;
  /** hrKey → name, from the lookups and the rows already on screen. */
  peopleNames: Record<string, string>;
  disabled?: boolean;
  onApply: (filters: IncidentFilters, sort: SystemAuditSort) => void;
  onRememberPeople: (people: PersonOption[]) => void;
  onReset: () => void;
}) {
  const [searchDraft, setSearchDraft] = useState(filters.search ?? "");
  const [personDraft, setPersonDraft] = useState("");
  const [personResults, setPersonResults] = useState<PersonOption[] | null>(null);
  const [personStatus, setPersonStatus] = useState<string | null>(null);
  const [personBusy, setPersonBusy] = useState(false);

  const set = (patch: Partial<IncidentFilters>) => onApply({ ...filters, ...patch }, sort);

  function submitSearch(event: FormEvent) {
    event.preventDefault();
    const text = searchDraft.trim();
    set({ search: text ? text : null });
  }

  async function findPeople(event: FormEvent) {
    event.preventDefault();
    const text = personDraft.trim();
    if (text.length < 2) {
      setPersonStatus("Type at least two letters of a name or an HR ID.");
      setPersonResults(null);
      return;
    }
    setPersonBusy(true);
    setPersonStatus(null);
    try {
      const response = await fetch(`/api/admin/system-audit?view=people&q=${encodeURIComponent(text)}`, { cache: "no-store" });
      const payload = (await response.json().catch(() => null)) as { people?: PersonOption[]; message?: string } | null;
      if (!response.ok || !payload?.people) {
        setPersonResults(null);
        setPersonStatus(`Unavailable — ${payload?.message ?? `the lookup answered ${response.status}`}`);
        return;
      }
      setPersonResults(payload.people);
      onRememberPeople(payload.people);
      setPersonStatus(payload.people.length === 0 ? "Nobody by that name or HR ID appears in the audit." : null);
    } catch (error) {
      setPersonResults(null);
      setPersonStatus(`Unavailable — ${error instanceof Error ? error.message : "the lookup did not answer"}`);
    } finally {
      setPersonBusy(false);
    }
  }

  const hrKeys = filters.hrKeys ?? [];
  const modules = filters.modules ?? [];
  // A module chosen earlier stays listed even when the new period has no row for it.
  const moduleList = Array.from(new Set([...(moduleOptions ?? []), ...modules])).sort((a, b) => a.localeCompare(b));

  return (
    <div className="space-y-3 border border-slate-200 bg-white p-3 @container">
      <div className="grid grid-cols-1 gap-3 @min-[520px]:grid-cols-2 @min-[900px]:grid-cols-4">
        <label className="min-w-0">
          <span className={denseLabel}>From (Cairo)</span>
          <input
            className={denseField}
            disabled={disabled}
            max={filters.to ?? undefined}
            onChange={(event) => set({ from: event.target.value || null })}
            type="date"
            value={filters.from ?? ""}
          />
        </label>
        <label className="min-w-0">
          <span className={denseLabel}>To (Cairo)</span>
          <input
            className={denseField}
            disabled={disabled}
            min={filters.from ?? undefined}
            onChange={(event) => set({ to: event.target.value || null })}
            type="date"
            value={filters.to ?? ""}
          />
        </label>
        <label className="min-w-0">
          <span className={denseLabel}>Scope</span>
          <select
            className={denseSelect}
            disabled={disabled}
            onChange={(event) => set({ scope: (event.target.value || null) as SharedScope | null })}
            value={filters.scope ?? ""}
          >
            <option value="">Every row</option>
            {(Object.keys(SYSTEM_AUDIT_SCOPE_LABELS) as SharedScope[]).map((scope) => (
              <option key={scope} value={scope}>
                {SYSTEM_AUDIT_SCOPE_LABELS[scope]}
              </option>
            ))}
          </select>
        </label>
        <label className="min-w-0">
          <span className={denseLabel}>Sort</span>
          <select
            className={denseSelect}
            disabled={disabled}
            onChange={(event) => onApply(filters, event.target.value as SystemAuditSort)}
            value={sort}
          >
            {SYSTEM_AUDIT_SORTS.map((value) => (
              <option key={value} value={value}>
                {SYSTEM_AUDIT_SORT_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="grid grid-cols-1 gap-3 @min-[720px]:grid-cols-2">
        <form className="min-w-0" onSubmit={submitSearch}>
          <span className={denseLabel}>Search</span>
          <div className="flex gap-2">
            <input
              aria-label="Search incidents"
              className={denseField}
              disabled={disabled}
              maxLength={200}
              onChange={(event) => setSearchDraft(event.target.value)}
              placeholder="Title, message, code, module, name or HR ID"
              type="search"
              value={searchDraft}
            />
            <button className={cn(phxButtonGhostClassName, "h-9 px-3")} disabled={disabled} type="submit">
              <Search className="h-3.5 w-3.5" />
              Apply
            </button>
          </div>
        </form>
        <form className="min-w-0" onSubmit={findPeople}>
          <span className={denseLabel}>Person</span>
          <div className="flex gap-2">
            <input
              aria-label="Find a person by name or HR ID"
              className={denseField}
              disabled={disabled || personBusy}
              maxLength={80}
              onChange={(event) => setPersonDraft(event.target.value)}
              placeholder="Name or HR ID"
              type="search"
              value={personDraft}
            />
            <button className={cn(phxButtonGhostClassName, "h-9 px-3")} disabled={disabled || personBusy} type="submit">
              <UserPlus className="h-3.5 w-3.5" />
              {personBusy ? "Finding" : "Find"}
            </button>
          </div>
          {personStatus ? <p className="mt-1 break-words text-xs font-semibold text-slate-600">{personStatus}</p> : null}
          {personResults && personResults.length > 0 ? (
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {personResults.map((person) => {
                const chosen = hrKeys.includes(person.hrKey);
                return (
                  <li key={person.hrKey}>
                    <button
                      className={cn(
                        "border px-2 py-1 text-left text-xs font-semibold transition",
                        chosen ? "border-orange-500 bg-orange-50 text-slate-900" : "border-slate-300 bg-white text-slate-700 hover:border-slate-500",
                      )}
                      disabled={disabled || chosen}
                      onClick={() => set({ hrKeys: [...hrKeys, person.hrKey] })}
                      type="button"
                    >
                      <span className="break-words">{person.name}</span>
                      <span className="ml-1 text-slate-500">{person.hrId}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </form>
      </div>

      {hrKeys.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={phxLabelTextClassName}>People</span>
          {hrKeys.map((key) => (
            <button
              aria-label={`Remove ${peopleNames[key] ?? key.toUpperCase()} from the filter`}
              className="inline-flex items-center gap-1 border border-orange-500 bg-orange-50 px-2 py-1 text-xs font-semibold text-slate-900"
              disabled={disabled}
              key={key}
              onClick={() => set({ hrKeys: hrKeys.filter((value) => value !== key) })}
              type="button"
            >
              <span className="break-words">{peopleNames[key] ?? key.toUpperCase()}</span>
              <X className="h-3 w-3 shrink-0" />
            </button>
          ))}
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-2 @min-[640px]:grid-cols-2 @min-[1000px]:grid-cols-4">
        <ChoiceList
          disabled={disabled}
          emptyNote={modulesError ? `Unavailable — ${modulesError}` : "No module has an incident in this period."}
          label="Module"
          onChange={(next) => set({ modules: next })}
          options={moduleList.map((value) => ({ value, label: value }))}
          selected={modules}
        />
        <ChoiceList
          disabled={disabled}
          label="Fixed status"
          onChange={(next) => set({ statuses: next })}
          options={STATUS_OPTIONS}
          selected={filters.statuses ?? []}
        />
        <ChoiceList
          disabled={disabled}
          label="Why"
          onChange={(next) => set({ rootCauseLevels: next })}
          options={LEVEL_OPTIONS}
          selected={filters.rootCauseLevels ?? []}
        />
        <ChoiceList
          disabled={disabled}
          label="Source"
          onChange={(next) => set({ families: next })}
          options={FAMILY_OPTIONS}
          selected={filters.families ?? []}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label className={cn(phxCheckTileClassName(filters.includeSilent), "py-1.5 text-xs")}>
          <input
            checked={filters.includeSilent}
            className={phxCheckInputClassName}
            disabled={disabled}
            onChange={(event) => set({ includeSilent: event.target.checked })}
            type="checkbox"
          />
          Include silent data findings
        </label>
        <label className={cn(phxCheckTileClassName(filters.includeTest), "py-1.5 text-xs")}>
          <input
            checked={filters.includeTest}
            className={phxCheckInputClassName}
            disabled={disabled}
            onChange={(event) => set({ includeTest: event.target.checked })}
            type="checkbox"
          />
          Include test accounts
        </label>
        <button
          className={cn(phxButtonPrimaryClassName, "h-9 px-3 py-1 text-xs")}
          disabled={disabled}
          onClick={() => {
            setSearchDraft("");
            setPersonDraft("");
            setPersonResults(null);
            setPersonStatus(null);
            onReset();
          }}
          type="button"
        >
          Clear all filters
        </button>
      </div>
    </div>
  );
}
