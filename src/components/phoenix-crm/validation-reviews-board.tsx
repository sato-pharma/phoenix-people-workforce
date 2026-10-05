"use client";

/**
 * Phoenix CRM — Place checks, with one filter bar over every section (owner, 2026-10-05: "I want to be
 * able to filter by rep by line by region by period by field by rejected by accepted by any single
 * thing").
 *
 * The page hands this board all three sets at once — the places waiting for a decision, the ones
 * decided in the last two weeks, and the validations the system never questioned. The filter bar is
 * shared: rep, line, region, list and period narrow whichever sections are shown, a free-text box
 * searches the names, and an outcome selector narrows to just the waiting / approved / rejected / in-use
 * rows. Every count in a section heading is the filtered count.
 *
 * It is an admin screen, so the dropdowns are combo boxes the Super Admin types into (the module's
 * surface rule): the board declares `surface="admin"` around itself, which is what turns `CrmSelect`
 * into the searchable control.
 */

import { useMemo, useState } from "react";

import { AdminCallout, AdminTableShell } from "@/components/admin/admin-design-system";
import { CrmSurfaceProvider } from "@/components/phoenix-crm/surface";
import { CrmButton, CrmField, CrmSearchField, CrmSelect } from "@/components/phoenix-crm/ui";
import { ValidatedPlaceList } from "@/components/phoenix-crm/validated-place-list";
import { ValidationReviewQueue } from "@/components/phoenix-crm/validation-review-queue";
import {
  distinctValues,
  EMPTY_VALIDATION_REVIEW_FILTERS,
  hasActiveValidationReviewFilter,
  matchesValidationReviewFilters,
  validationReviewPeriodCutoff,
  withinValidationReviewPeriod,
  type ValidationReviewFilterable,
  type ValidationReviewFilters,
  type ValidationReviewOutcome,
  type ValidationReviewPeriod,
} from "@/lib/phoenix-crm/validation-review-filters";
import type { ValidatedPlaceRow, ValidationReviewRow } from "@/lib/phoenix-crm/view-types";

const OUTCOME_LABELS: Record<ValidationReviewOutcome, string> = {
  all: "Every outcome",
  pending: "Waiting",
  approved: "Approved",
  rejected: "Rejected",
  validated: "In use",
};

const PERIOD_LABELS: Record<ValidationReviewPeriod, string> = {
  all: "Any time",
  today: "Today",
  "7": "Last 7 days",
  "14": "Last 14 days",
  "30": "Last 30 days",
};

export function ValidationReviewsBoard({
  pending,
  decided,
  validated,
}: {
  pending: ValidationReviewRow[];
  decided: ValidationReviewRow[];
  validated: ValidatedPlaceRow[];
}) {
  const [filters, setFilters] = useState<ValidationReviewFilters>(EMPTY_VALIDATION_REVIEW_FILTERS);
  const set = <Key extends keyof ValidationReviewFilters>(key: Key, value: ValidationReviewFilters[Key]) =>
    setFilters((current) => ({ ...current, [key]: value }));

  const everyRow = useMemo<ValidationReviewFilterable[]>(() => [...pending, ...decided, ...validated], [pending, decided, validated]);
  const reps = useMemo(() => distinctValues(everyRow.map((row) => row.repName)), [everyRow]);
  const lines = useMemo(() => distinctValues(everyRow.map((row) => row.line)), [everyRow]);
  const regions = useMemo(() => distinctValues(everyRow.map((row) => row.region)), [everyRow]);
  const lists = useMemo(() => distinctValues(everyRow.map((row) => row.listType)), [everyRow]);

  const cutoff = validationReviewPeriodCutoff(filters.period);
  const filteredPending = useMemo(
    () => pending.filter((row) => matchesValidationReviewFilters(row, filters) && withinValidationReviewPeriod(row.createdAt, cutoff)),
    [pending, filters, cutoff],
  );
  const filteredDecided = useMemo(
    () =>
      decided.filter((row) => {
        if (filters.outcome === "approved" && row.status !== "approved") return false;
        if (filters.outcome === "rejected" && row.status !== "rejected") return false;
        return matchesValidationReviewFilters(row, filters) && withinValidationReviewPeriod(row.createdAt, cutoff);
      }),
    [decided, filters, cutoff],
  );
  const filteredValidated = useMemo(
    () => validated.filter((row) => matchesValidationReviewFilters(row, filters) && withinValidationReviewPeriod(row.validatedAt, cutoff)),
    [validated, filters, cutoff],
  );

  const anyFilter = hasActiveValidationReviewFilter(filters);
  const showWaiting = filters.outcome === "all" || filters.outcome === "pending";
  const showDecided = filters.outcome === "all" || filters.outcome === "approved" || filters.outcome === "rejected";
  const showValidated = filters.outcome === "all" || filters.outcome === "validated";
  const decidedTitle = filters.outcome === "approved" ? "Approved in the last 14 days" : filters.outcome === "rejected" ? "Rejected in the last 14 days" : "Decided in the last 14 days";

  // The filter signature remounts the paged validated list so "Show more" starts over when a filter
  // changes, rather than keeping a page offset from the wider set.
  const validatedKey = `${filters.outcome}|${filters.rep}|${filters.line}|${filters.region}|${filters.list}|${filters.period}|${filters.text}`;

  return (
    <CrmSurfaceProvider surface="admin">
      <div className="space-y-5">
        <div className="min-w-0 border border-slate-200 bg-white px-4 py-4">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-black uppercase tracking-[0.12em] text-slate-500">Filters</h2>
            {anyFilter || filters.outcome !== "all" ? (
              <CrmButton onClick={() => setFilters(EMPTY_VALIDATION_REVIEW_FILTERS)} size="sm" variant="ghost">
                Clear filters
              </CrmButton>
            ) : null}
          </div>
          <div className="mt-3 grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-3">
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

        {showWaiting ? (
          <AdminTableShell
            title={`Waiting for your decision (${filteredPending.length})`}
            description="Approve validates the customer in the rep's name and their visits start counting. Reject retires the place; when it was their only one, the customer goes back to To validate. The rep reads either as the system's answer."
          >
            {filteredPending.length === 0 ? (
              <div className="px-4 py-4">
                <AdminCallout tone="success">
                  <span>{anyFilter ? "Nothing waiting matches these filters." : "Nothing is waiting — every place has matched its listing, been refused at the door, or been decided by you."}</span>
                </AdminCallout>
              </div>
            ) : (
              <ValidationReviewQueue rows={filteredPending} />
            )}
          </AdminTableShell>
        ) : null}

        {showDecided ? (
          <AdminTableShell title={`${decidedTitle} (${filteredDecided.length})`} description="What was approved or rejected, by whom, with the note kept on the record.">
            {filteredDecided.length === 0 ? (
              <div className="px-4 py-4">
                <AdminCallout tone="neutral">
                  <span>{anyFilter ? "Nothing decided matches these filters." : "Nothing has been decided in the last 14 days."}</span>
                </AdminCallout>
              </div>
            ) : (
              <ValidationReviewQueue rows={filteredDecided} />
            )}
          </AdminTableShell>
        ) : null}

        {showValidated ? (
          <AdminTableShell
            title={`Validations the system did not question (${filteredValidated.length})`}
            description="Only AM customers are checked against Google, so a PM customer's validation is never held — and an AM one that matched its listing is not either. These are the places validated in the last 30 days and still in use. Refusing one retires the place and, when it is the customer's only place, sends them back to To validate; the rep reads the system's own wording and never that a person looked at them."
          >
            {filteredValidated.length === 0 ? (
              <div className="px-4 py-4">
                <AdminCallout tone="neutral">
                  <span>{anyFilter ? "Nothing validated matches these filters." : "Nothing has been validated in the last 30 days."}</span>
                </AdminCallout>
              </div>
            ) : (
              <ValidatedPlaceList key={validatedKey} rows={filteredValidated} showSearch={false} />
            )}
          </AdminTableShell>
        ) : null}
      </div>
    </CrmSurfaceProvider>
  );
}
