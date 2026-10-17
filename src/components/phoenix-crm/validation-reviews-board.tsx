"use client";

/**
 * Phoenix CRM — Place checks, with one filter bar over every section (owner, 2026-10-05: "I want to be
 * able to filter by rep by line by region by period by field by rejected by accepted by any single
 * thing").
 *
 * The page hands this board all three sets at once — the places waiting for a decision, the ones
 * decided in the last two weeks, and the validations the system never questioned. The filter bar is
 * shared: rep, line, region, area, list and period narrow whichever sections are shown, a free-text box
 * searches the names, and an outcome selector narrows to just the waiting / approved / rejected / in-use
 * rows. Region is the top-level region (Alex-BHR, Cairo, Delta, …); Area is the governorate-level seat
 * below it (Qalubeya, Gharbia 2, …). Every count in a section heading is the filtered count.
 *
 * It is an admin screen, so the dropdowns are combo boxes the Super Admin types into (the module's
 * surface rule): the board declares `surface="admin"` around itself, which is what turns `CrmSelect`
 * into the searchable control.
 *
 * 🔴 ONE BOARD, TWO MODES, AND NEVER A SECOND COPY (owner, 2026-10-13: a district manager gets this
 * board for his own team). `mode="company"` is the Super Admin's — every decision control he has had
 * since 2026-10-03, plus what the managers have written. `mode="team"` renders NO decision control at
 * all and no sentence about one: not "waiting for your decision", not who decided a settled row, not
 * what approving or refusing would do. He comments and he recommends, and his screen says nothing
 * about who decides — his own instruction the same day was "don't show this on the screen". A second
 * board file would have been the easy shape and is exactly how one of two copies drifts; the portal
 * mirrors removed in 2026-08 are the repo's own account of that.
 */

import { useMemo, useState } from "react";

import { AdminCallout, AdminTableShell } from "@/components/admin/admin-design-system";
import { CrmSurfaceProvider } from "@/components/phoenix-crm/surface";
import { cn } from "@/lib/utils";
import { CrmButton, CrmField, CrmPill, CrmSearchField, CrmSelect } from "@/components/phoenix-crm/ui";
import { ReopenedCustomerList } from "@/components/phoenix-crm/reopened-customer-list";
import { SharedPlaceList } from "@/components/phoenix-crm/shared-place-list";
import { ValidatedPlaceList } from "@/components/phoenix-crm/validated-place-list";
import { ValidationReviewQueue } from "@/components/phoenix-crm/validation-review-queue";
import {
  distinctValues,
  EMPTY_VALIDATION_REVIEW_FILTERS,
  hasActiveValidationReviewFilter,
  matchesValidationReviewFilters,
  validatedPassesOutcome,
  validationReviewPeriodCutoff,
  withinValidationReviewPeriod,
  type ValidationReviewFilterable,
  type ValidationReviewFilters,
  type ValidationReviewOutcome,
  type ValidationReviewPeriod,
} from "@/lib/phoenix-crm/validation-review-filters";
import { narrowVenueGroups, seatedCustomersByVenue, venueNeedsDecision, withoutSeated } from "@/lib/phoenix-crm/shared-place-groups";
import type { PlaceCheckNotesMode } from "@/components/phoenix-crm/place-check-notes";
import type { PlaceNoteIndex, ReopenedCustomerRow, SharedPlaceBoardRow, ValidatedPlaceRow, ValidationReviewRow } from "@/lib/phoenix-crm/view-types";

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
 * The two kinds of check (owner, 2026-10-17: "separate the polyclinics/hospitals checks than normal
 * clinic steps"). A single clinic is judged on its own sign; a polyclinic or hospital is judged as a
 * building with a timetable and the customers seated behind it.
 */
type PlaceCheckView = "clinics" | "polyclinics";

/** A row the shared filters can read, for a reopened customer who has no place on file any more. */
function filterableReopened(row: ReopenedCustomerRow): ValidationReviewFilterable {
  return { ...row, speciality: null, placeLabel: null, address: null, brickName: null, areaName: null };
}

export function ValidationReviewsBoard({
  pending,
  decided,
  validated,
  reopened,
  sharedPlaces,
  capped,
  mode,
  noteIndex,
}: {
  /** Whose board this is — see the header. "company" is the Super Admin's, "team" a district manager's. */
  mode: PlaceCheckNotesMode;
  /** Every comment and recommendation on this page's subjects, keyed by `placeNoteSubjectKey`. */
  noteIndex: PlaceNoteIndex;
  pending: ValidationReviewRow[];
  decided: ValidationReviewRow[];
  validated: ValidatedPlaceRow[];
  /** Customers sent back to To validate and not captured again since — oldest wait first. */
  reopened: ReopenedCustomerRow[];
  /** Every polyclinic and centre in use or waiting for a decision, newest first. */
  sharedPlaces: SharedPlaceBoardRow[];
  /** Which reads stopped at their ceiling, so the page says "showing the newest" instead of lying. */
  capped: { reviews: boolean; validated: boolean; reopened: boolean; sharedPlaces: boolean };
}) {
  const [filters, setFilters] = useState<ValidationReviewFilters>(EMPTY_VALIDATION_REVIEW_FILTERS);
  const [view, setView] = useState<PlaceCheckView>("clinics");
  const set = <Key extends keyof ValidationReviewFilters>(key: Key, value: ValidationReviewFilters[Key]) =>
    setFilters((current) => ({ ...current, [key]: value }));

  const everyRow = useMemo<ValidationReviewFilterable[]>(() => [...pending, ...decided, ...validated], [pending, decided, validated]);
  // A venue's own rep, line, region and area belong in the dropdowns too: a rep who has captured a
  // polyclinic and nothing else would otherwise be unreachable from the Rep box, and his venue could
  // only be found by typing in the search field.
  const reps = useMemo(
    () => distinctValues([...everyRow.map((row) => row.repName), ...sharedPlaces.map((row) => row.repName)]),
    [everyRow, sharedPlaces],
  );
  const lines = useMemo(() => distinctValues([...everyRow.map((row) => row.line), ...sharedPlaces.map((row) => row.line)]), [everyRow, sharedPlaces]);
  const regions = useMemo(
    () => distinctValues([...everyRow.map((row) => row.region), ...sharedPlaces.map((row) => row.region)]),
    [everyRow, sharedPlaces],
  );
  const areas = useMemo(
    () => distinctValues([...everyRow.map((row) => row.areaName), ...sharedPlaces.map((row) => row.areaName)]),
    [everyRow, sharedPlaces],
  );
  const lists = useMemo(() => distinctValues(everyRow.map((row) => row.listType)), [everyRow]);

  const cutoff = validationReviewPeriodCutoff(filters.period);

  // 🔴 A ROW IS TAKEN OUT OF THE CLINICS VIEW ONLY WHEN ITS BUILDING IS ON THIS BOARD, so a customer whose
  // building has aged out of the venue read stays among the clinics where he can still be found.
  const venueIds = useMemo(() => new Set(sharedPlaces.map((row) => row.sharedPlaceId)), [sharedPlaces]);
  const clinicPending = useMemo(() => withoutSeated(pending, venueIds), [pending, venueIds]);
  const clinicDecided = useMemo(() => withoutSeated(decided, venueIds), [decided, venueIds]);
  const clinicValidated = useMemo(() => withoutSeated(validated, venueIds), [validated, venueIds]);
  const clinicReopened = useMemo(() => withoutSeated(reopened, venueIds), [reopened, venueIds]);
  const seated = useMemo(
    () => seatedCustomersByVenue({ pending, decided, validated, reopened, venueIds }),
    [pending, decided, validated, reopened, venueIds],
  );

  const filteredPending = useMemo(
    () => clinicPending.filter((row) => matchesValidationReviewFilters(row, filters) && withinValidationReviewPeriod(row.createdAt, cutoff)),
    [clinicPending, filters, cutoff],
  );
  const filteredDecided = useMemo(
    () =>
      clinicDecided.filter((row) => {
        if (filters.outcome === "approved" && row.status !== "approved") return false;
        if (filters.outcome === "rejected" && row.status !== "rejected") return false;
        return matchesValidationReviewFilters(row, filters) && withinValidationReviewPeriod(row.createdAt, cutoff);
      }),
    [clinicDecided, filters, cutoff],
  );
  const filteredValidated = useMemo(
    () =>
      clinicValidated.filter(
        (row) =>
          validatedPassesOutcome(row, filters.outcome) &&
          matchesValidationReviewFilters(row, filters) &&
          withinValidationReviewPeriod(row.validatedAt, cutoff),
      ),
    [clinicValidated, filters, cutoff],
  );
  const filteredReopened = useMemo(
    () =>
      clinicReopened.filter(
        (row) => matchesValidationReviewFilters(filterableReopened(row), filters) && withinValidationReviewPeriod(row.reopenedAt, cutoff),
      ),
    [clinicReopened, filters, cutoff],
  );
  // One group per building: the building itself, then the customers seated in it that pass the filters.
  const filteredVenueGroups = useMemo(
    () => narrowVenueGroups({ venues: sharedPlaces, seated, filters, cutoff }),
    [sharedPlaces, seated, filters, cutoff],
  );

  const anyFilter = hasActiveValidationReviewFilter(filters);
  // 🔴 EVERY SENTENCE BELOW THAT NAMES A DECISION IS BEHIND THIS FLAG. A manager's board must not say
  // "waiting for your decision", must not explain what approving or refusing does, and must not name
  // who settled a row — the three places this board used to state the decision out loud.
  const team = mode === "team";
  const showWaiting = filters.outcome === "all" || filters.outcome === "pending";
  const showDecided = filters.outcome === "all" || filters.outcome === "approved" || filters.outcome === "rejected";
  const showValidated = filters.outcome === "all" || filters.outcome === "validated" || filters.outcome === "unseen";
  const showReopened = filters.outcome === "all" || filters.outcome === "rejected";
  const movedToPolyclinics = pending.length + decided.length + validated.length + reopened.length - (clinicPending.length + clinicDecided.length + clinicValidated.length + clinicReopened.length);
  const clinicsShown =
    (showWaiting ? filteredPending.length : 0) +
    (showDecided ? filteredDecided.length : 0) +
    (showReopened ? filteredReopened.length : 0) +
    (showValidated ? filteredValidated.length : 0);
  const clinicsOpen = showWaiting ? filteredPending.length : 0;
  const polyclinicsOpen = filteredVenueGroups.filter((group) => venueNeedsDecision(group)).length;
  const validatedTitle = filters.outcome === "unseen" ? "Validations nobody has looked at" : "Validations the system did not question";
  const decidedTitle = filters.outcome === "approved" ? "Approved in the last 14 days" : filters.outcome === "rejected" ? "Rejected in the last 14 days" : team ? "Settled in the last 14 days" : "Decided in the last 14 days";

  // The filter signature remounts the paged validated list so "Show more" starts over when a filter
  // changes, rather than keeping a page offset from the wider set.
  const validatedKey = `${filters.outcome}|${filters.rep}|${filters.line}|${filters.region}|${filters.area}|${filters.list}|${filters.period}|${filters.text}`;

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

        {capped.reviews || capped.validated || capped.reopened || capped.sharedPlaces ? (
          <AdminCallout tone="warning">
            <span>
              This page is showing the newest rows only: there are more than it can hold in one read. Narrow the period or the
              filters to reach the older ones.
            </span>
          </AdminCallout>
        ) : null}

        <div aria-label="Kind of place" className="flex min-w-0 flex-wrap border-b border-slate-200" role="tablist">
          {(
            [
              ["clinics", "Clinics", clinicsShown, clinicsOpen],
              ["polyclinics", "Polyclinics and hospitals", filteredVenueGroups.length, polyclinicsOpen],
            ] as const
          ).map(([key, label, count, open]) => (
            <button
              key={key}
              aria-controls={`vr-panel-${key}`}
              aria-selected={view === key}
              className={cn(
                "inline-flex min-h-11 min-w-0 flex-wrap items-center gap-2 border-b-2 px-4 py-2.5 text-left text-sm font-black",
                view === key ? "border-slate-900 text-slate-900" : "border-transparent text-slate-500 hover:text-slate-700",
              )}
              id={`vr-tab-${key}`}
              onClick={() => setView(key)}
              role="tab"
              type="button"
            >
              <span className="break-words">
                {label} ({count})
              </span>
              {open > 0 ? <CrmPill tone="warn">{open} {team ? "being checked" : "waiting"}</CrmPill> : null}
            </button>
          ))}
        </div>

        {view === "clinics" ? (
          <div aria-labelledby="vr-tab-clinics" className="space-y-5" id="vr-panel-clinics" role="tabpanel">
            {movedToPolyclinics > 0 ? (
              <p className="break-words text-xs text-slate-500">
                {movedToPolyclinics} {movedToPolyclinics === 1 ? "row belongs" : "rows belong"} to a polyclinic or hospital and {movedToPolyclinics === 1 ? "is" : "are"} on the Polyclinics and hospitals tab, under their building.
              </p>
            ) : null}
            {showWaiting ? (
              <AdminTableShell
                title={team ? `Still being checked (${filteredPending.length})` : `Waiting for your decision (${filteredPending.length})`}
                description={
                  team
                    ? "The places the system could not settle by itself: Google has no listing it is sure is the customer, its pin is far from where the rep stood, or the signboard names somebody else — or nobody. Each one's evidence is below, and the rep knows only that the system is checking."
                    : "Approve validates the customer in the rep's name and their visits start counting. Reject retires the place; when it was their only one, the customer goes back to To validate. The rep reads either as the system's answer."
                }
              >
                {filteredPending.length === 0 ? (
                  <div className="px-4 py-4">
                    <AdminCallout tone="success">
                      <span>
                        {anyFilter
                          ? "Nothing waiting matches these filters."
                          : team
                            ? "Nothing of your team's is still being checked — every place has matched its listing, been refused at the door, or been settled."
                            : "Nothing is waiting — every place has matched its listing, been refused at the door, or been decided by you."}
                      </span>
                    </AdminCallout>
                  </div>
                ) : (
                  <ValidationReviewQueue mode={mode} noteIndex={noteIndex} rows={filteredPending} section="waiting" />
                )}
              </AdminTableShell>
            ) : null}

            {showDecided ? (
              <AdminTableShell
                title={`${decidedTitle} (${filteredDecided.length})`}
                description={
                  team
                    ? "What has been settled, and the one sentence the rep was told about the photograph."
                    : "What was approved or rejected, by whom, with the note kept on the record."
                }
              >
                {filteredDecided.length === 0 ? (
                  <div className="px-4 py-4">
                    <AdminCallout tone="neutral">
                      <span>
                        {anyFilter
                          ? `Nothing ${team ? "settled" : "decided"} matches these filters.`
                          : `Nothing has been ${team ? "settled" : "decided"} in the last 14 days.`}
                      </span>
                    </AdminCallout>
                  </div>
                ) : (
                  <ValidationReviewQueue mode={mode} noteIndex={noteIndex} rows={filteredDecided} section="decided" />
                )}
              </AdminTableShell>
            ) : null}

            {showReopened ? (
              <AdminTableShell
                title={`Waiting to be captured again (${filteredReopened.length})`}
                description="Customers sent back to To validate because their place was refused, and not validated again since — the longest wait first. The rep was told what is wrong with the photo and nothing else."
              >
                {filteredReopened.length === 0 ? (
                  <div className="px-4 py-4">
                    <AdminCallout tone="success">
                      <span>{anyFilter ? "Nobody waiting matches these filters." : "Nobody is waiting to be captured again."}</span>
                    </AdminCallout>
                  </div>
                ) : (
                  <ReopenedCustomerList rows={filteredReopened} />
                )}
              </AdminTableShell>
            ) : null}

            {showValidated ? (
              <AdminTableShell
                title={`${validatedTitle} (${filteredValidated.length})`}
                description={
                  team
                    ? "Only AM customers are checked against Google, and every new place has its signboard read before it is accepted; a place whose sign named the customer is never held. These are your team's places still in use, whenever they were validated, each with what the system read on its signboard and whether anybody has looked at it yet."
                    : "Only AM customers are checked against Google, and since 8 October every new place has its signboard read before it is accepted; a place whose sign named the customer is not held. These are the places still in use, whenever they were validated, each with what the system read on its signboard and whether anybody has looked at it. Refusing one retires the place and, when it is the customer's only place, sends them back to To validate; the rep is told what is wrong with the photo and never that a person looked at them."
                }
              >
                {filteredValidated.length === 0 ? (
                  <div className="px-4 py-4">
                    <AdminCallout tone="neutral">
                      <span>{anyFilter || filters.outcome === "unseen" ? "Nothing validated matches these filters." : "Nothing is validated and in use."}</span>
                    </AdminCallout>
                  </div>
                ) : (
                  <ValidatedPlaceList key={validatedKey} mode={mode} noteIndex={noteIndex} rows={filteredValidated} showSearch={false} />
                )}
              </AdminTableShell>
            ) : null}
          </div>
        ) : null}
        {view === "polyclinics" ? (
          <div aria-labelledby="vr-tab-polyclinics" id="vr-panel-polyclinics" role="tabpanel">
            <AdminTableShell
              title={`Polyclinics and hospitals (${filteredVenueGroups.length})`}
              description={
                team
                  ? "A polyclinic, medical centre or hospital outpatient suite is validated ONCE, at its own door — a live photo of the sign on the building and both readings inside the place line — and every customer who receives behind that door is then seated in it without a second capture. Each building is one block here: the sign on its door and its timetable, then the customers seated in it with what that timetable says about each. It is a venue only: it is on nobody's list, takes no visit and counts in no KPI, and the customer seated in it stays the one who is planned, visited and counted. It is not looked up in Google, because that check reads a customer's own name and a building has none."
                  : "A polyclinic, medical centre, medical tower or hospital outpatient suite is validated ONCE, at its own door — a live photo of the sign on the building and both readings inside the place line — and every customer who receives behind that door is then seated in it without a second capture. Each building is one block here: the sign on its door and its timetable, then the customers seated in it with what that timetable says about each. It is a venue only: it is on nobody's list, takes no visit and counts in no KPI, and the customer seated in it stays the one who is planned, visited and counted. It is not looked up in Google, because that check reads a customer's own name and a building has none. Rejecting a building retires it, retires everybody seated in it, and sends each of them back to To validate. A customer the timetable does not name is rejected on their own row, which leaves the building and everybody else seated in it alone."
              }
            >
              {filteredVenueGroups.length === 0 ? (
                <div className="px-4 py-4">
                  <AdminCallout tone="neutral">
                    <span>{anyFilter || filters.outcome !== "all" ? "No polyclinic or hospital matches these filters." : "No polyclinic or centre has been captured yet."}</span>
                  </AdminCallout>
                </div>
              ) : (
                <SharedPlaceList groups={filteredVenueGroups} mode={mode} noteIndex={noteIndex} />
              )}
            </AdminTableShell>
          </div>
        ) : null}
      </div>
    </CrmSurfaceProvider>
  );
}
