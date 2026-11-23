"use client";

/**
 * Phoenix CRM — Place checks: the one filter bar over every tab (owner, 2026-10-05: "I want to be able to
 * filter by rep by line by region by period by field by rejected by accepted by any single thing").
 *
 * The eight boxes fold away under a one-line summary of what is narrowing the board (owner, 17 Nov 2026:
 * "simple to decide"). It is an admin surface, so each dropdown is a combo box he types into.
 */

import type { PlaceCheckBoard } from "@/components/phoenix-crm/place-checks/use-place-check-board";
import { CrmButton, CrmField, CrmSearchField, CrmSelect } from "@/components/phoenix-crm/ui";
import {
  EMPTY_VALIDATION_REVIEW_FILTERS,
  type ValidationReviewFilters,
  type ValidationReviewOutcome,
  type ValidationReviewPeriod,
} from "@/lib/phoenix-crm/validation-review-filters";

const OUTCOME_LABELS: Record<ValidationReviewOutcome, string> = {
  all: "Every outcome",
  pending: "Waiting",
  approved: "Approved",
  rejected: "Rejected",
  validated: "In use",
  unseen: "Never looked at",
};

const PERIOD_LABELS: Record<ValidationReviewPeriod, string> = {
  all: "Any time",
  today: "Today",
  "7": "Last 7 days",
  "14": "Last 14 days",
  "30": "Last 30 days",
};

/**
 * What is narrowing the board, one short label each, for the folded Filters line (owner, 17 Nov 2026:
 * "simple to decide"). The boxes fold away; what they hold stays on screen, so a rep picked from the
 * scorecard or a period left on is never hidden behind the fold.
 */
export function filterSummary(filters: ValidationReviewFilters): string[] {
  const labels: string[] = [];
  if (filters.outcome !== "all") labels.push(OUTCOME_LABELS[filters.outcome]);
  if (filters.rep) labels.push(`Rep: ${filters.rep}`);
  if (filters.line) labels.push(`Line: ${filters.line}`);
  if (filters.region) labels.push(`Region: ${filters.region}`);
  if (filters.area) labels.push(`Area: ${filters.area}`);
  if (filters.list) labels.push(`List: ${filters.list}`);
  if (filters.period !== "all") labels.push(PERIOD_LABELS[filters.period]);
  if (filters.decider) labels.push(`Decided by ${filters.decider}`);
  if (filters.text.trim()) labels.push(`Search: ${filters.text.trim()}`);
  return labels;
}

export function PlaceCheckFilterBar({ board }: { board: PlaceCheckBoard }) {
  const { anyFilter, areas, deciders, filters, filtersOpen, lines, lists, narrowedBy, regions, reps, set, setFilters, setFiltersOpen, team } = board;
  return (
    <div className="min-w-0 border border-slate-200 bg-white">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
        <h2 className="text-sm font-black uppercase tracking-[0.12em] text-slate-500">Filters</h2>
        <div className="flex min-w-0 flex-1 basis-60 flex-wrap items-center gap-1.5">
          {narrowedBy.length === 0 ? (
            <span className="break-words text-xs font-semibold text-slate-500">Showing everything</span>
          ) : (
            narrowedBy.map((label) => (
              <span key={label} className="break-words border border-orange-200 bg-orange-50 px-2 py-0.5 text-xs font-black text-orange-800" dir="auto">
                {label}
              </span>
            ))
          )}
        </div>
        <div className="flex min-w-0 flex-wrap gap-2">
          {anyFilter || filters.outcome !== "all" ? (
            <CrmButton onClick={() => setFilters(EMPTY_VALIDATION_REVIEW_FILTERS)} size="sm" variant="ghost">
              Clear filters
            </CrmButton>
          ) : null}
          <CrmButton aria-controls={filtersOpen ? "vr-filter-fields" : undefined} aria-expanded={filtersOpen} onClick={() => setFiltersOpen((current) => !current)} size="sm">
            {filtersOpen ? "Hide filters" : "Show filters"}
          </CrmButton>
        </div>
      </div>
      {filtersOpen ? (
        <div className="border-t border-slate-100 px-4 pb-4 pt-3" id="vr-filter-fields">
          <div className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <CrmField htmlFor="vr-outcome" label="Outcome">
              <CrmSelect id="vr-outcome" onChange={(event) => set("outcome", event.target.value as ValidationReviewOutcome)} value={filters.outcome}>
                {(Object.keys(OUTCOME_LABELS) as ValidationReviewOutcome[]).map((value) => (
                  <option key={value} value={value}>
                    {OUTCOME_LABELS[value]}
                  </option>
                ))}
              </CrmSelect>
            </CrmField>

            <CrmField htmlFor="vr-rep" label="Rep">
              <CrmSelect id="vr-rep" onChange={(event) => set("rep", event.target.value)} value={filters.rep}>
                <option value="">Every rep</option>
                {reps.map((rep) => (
                  <option key={rep} value={rep}>
                    {rep}
                  </option>
                ))}
              </CrmSelect>
            </CrmField>

            <CrmField htmlFor="vr-line" label="Line">
              <CrmSelect id="vr-line" onChange={(event) => set("line", event.target.value)} value={filters.line}>
                <option value="">Every line</option>
                {lines.map((line) => (
                  <option key={line} value={line}>
                    {line}
                  </option>
                ))}
              </CrmSelect>
            </CrmField>

            <CrmField htmlFor="vr-region" label="Region">
              <CrmSelect id="vr-region" onChange={(event) => set("region", event.target.value)} value={filters.region}>
                <option value="">Every region</option>
                {regions.map((region) => (
                  <option key={region} value={region}>
                    {region}
                  </option>
                ))}
              </CrmSelect>
            </CrmField>

            <CrmField htmlFor="vr-area" label="Area">
              <CrmSelect id="vr-area" onChange={(event) => set("area", event.target.value)} value={filters.area}>
                <option value="">Every area</option>
                {areas.map((area) => (
                  <option key={area} value={area}>
                    {area}
                  </option>
                ))}
              </CrmSelect>
            </CrmField>

            <CrmField htmlFor="vr-list" label="List">
              <CrmSelect id="vr-list" onChange={(event) => set("list", event.target.value)} value={filters.list}>
                <option value="">Every list</option>
                {lists.map((list) => (
                  <option key={list} value={list}>
                    {list}
                  </option>
                ))}
              </CrmSelect>
            </CrmField>

            <CrmField htmlFor="vr-period" label="Period">
              <CrmSelect id="vr-period" onChange={(event) => set("period", event.target.value as ValidationReviewPeriod)} value={filters.period}>
                {(Object.keys(PERIOD_LABELS) as ValidationReviewPeriod[]).map((value) => (
                  <option key={value} value={value}>
                    {PERIOD_LABELS[value]}
                  </option>
                ))}
              </CrmSelect>
            </CrmField>

            {team ? null : (
              <CrmField htmlFor="vr-decider" label="Decided by">
                <CrmSelect id="vr-decider" onChange={(event) => set("decider", event.target.value)} value={filters.decider}>
                  <option value="">Anyone</option>
                  {deciders.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </CrmSelect>
              </CrmField>
            )}
          </div>
          <div className="mt-3 min-w-0 lg:max-w-md">
            <CrmSearchField
              id="vr-search"
              label="Search"
              onChange={(next) => set("text", next)}
              placeholder="Customer, rep, territory, brick or area"
              value={filters.text}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
