"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import {
  PortalDesktopTable,
  PortalRecordCard,
  PortalRecordFields,
  PortalResponsiveDataList,
} from "@/components/employee-portal/portal-primitives";
import { PlanApproveButton } from "@/components/crm/plan-verify-button";
import { ExportXlsxButton } from "@/components/ui/export-xlsx-button";
import { SortableTh, TableSearchInput } from "@/components/ui/sortable-table";
import { useSortableTable } from "@/components/ui/use-sortable-table";
import {
  PLAN_DOCTORS_ANCHOR_ID,
  PLAN_STATUS_NEW,
  planPeriodText,
  planStatusClass,
  planStatusLabel,
  type PlanKind,
} from "@/lib/crm/plan-verification";
import type { PlanEntryRow, PlanMissingRep, PlanSummary } from "@/lib/crm/plan-board";
import { phxSelectClassName } from "@/components/ui/form-tokens";
import { cn } from "@/lib/utils";

// Client half of Plan Verification. Styling copies reps-list-tables.tsx verbatim — flat borders,
// slate-900 header rows, orange accent — because that board sits beside this one in the same shell
// and neither must read as a one-off (owner's standing rule). The reference was doctor-list-tables.tsx
// until 2026-08-31, when that board and the District Manager tab strip were retired; Reps List
// carries the same vocabulary forward, so nothing about the look changed with it.
//
// The period, the kind and the chosen plan all ride in the URL, so every change re-runs the
// server-side scope gate rather than filtering a payload already in the browser. That is the
// sibling's rule and the reason is stronger here: this board carries a button that approves a plan
// in Phoenix CRM, so what a viewer may act on has to be a server decision every time.

const THEAD = "px-3 py-2.5 text-phx-sm font-black uppercase tracking-[0.12em] text-white";
const SELECT_CLASS = cn(phxSelectClassName, "h-9 w-full px-2");
const LABEL_CLASS = "block text-phx-xs font-black uppercase tracking-[0.16em] text-slate-400";

function gradeClass(grade: string | null): string {
  if (grade === "A" || grade === "A+") return "text-rose-700";
  if (grade === "B") return "text-amber-700";
  if (!grade) return "text-slate-300";
  return "text-slate-500";
}

// planPeriodText used to live here. It moved to @/lib/crm/plan-verification because the SERVER half
// of this page calls it too, and a function exported from a "use client" module cannot be called on
// the server — it arrives there as a client reference and throws. See the note at its new home.

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export function PlanVerificationFilters({
  basePath,
  kind,
  month,
  year,
  years,
}: {
  basePath: string;
  kind: PlanKind;
  month: number;
  year: number;
  years: number[];
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  function go(next: { kind?: PlanKind; month?: number; year?: number }) {
    setPending(true);
    const params = new URLSearchParams({
      kind: next.kind ?? kind,
      month: String(next.month ?? month),
      year: String(next.year ?? year),
    });
    // The chosen plan is deliberately dropped when the period changes — a plan id from August is
    // not in September's list, and carrying it over would render an empty detail panel that reads
    // like a permission problem.
    router.push(`${basePath}?${params.toString()}`);
  }

  // w-full below `sm` so the filters take their own line under the title on a phone rather than
  // sharing the row — the same measurement that drove the sibling board's picker.
  return (
    <div className="grid w-full grid-cols-2 gap-2 sm:w-auto sm:grid-cols-3">
      <label className="block space-y-1">
        <span className={LABEL_CLASS}>Plan type</span>
        <select
          className={SELECT_CLASS}
          disabled={pending}
          onChange={(event) => go({ kind: event.target.value as PlanKind })}
          value={kind}
        >
          <option value="weekly">Weekly plans</option>
          <option value="monthly">Monthly plans</option>
        </select>
      </label>
      <label className="block space-y-1">
        <span className={LABEL_CLASS}>Month</span>
        <select
          className={SELECT_CLASS}
          disabled={pending}
          onChange={(event) => go({ month: Number(event.target.value) })}
          value={String(month)}
        >
          {MONTH_NAMES.map((name, index) => (
            <option key={name} value={String(index + 1)}>
              {name}
            </option>
          ))}
        </select>
      </label>
      <label className="block space-y-1">
        <span className={LABEL_CLASS}>Year</span>
        <select
          className={SELECT_CLASS}
          disabled={pending}
          onChange={(event) => go({ year: Number(event.target.value) })}
          value={String(year)}
        >
          {years.map((value) => (
            <option key={value} value={String(value)}>
              {value}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

const PLAN_COLS = [
  { accessor: (r: PlanSummary) => r.repName, defaultDir: "asc" as const, key: "repName", type: "string" as const },
  { accessor: (r: PlanSummary) => r.firstDate ?? "", key: "firstDate", type: "string" as const },
  { accessor: (r: PlanSummary) => r.contacts, key: "contacts", type: "number" as const },
  { accessor: (r: PlanSummary) => r.entries, key: "entries", type: "number" as const },
  { accessor: (r: PlanSummary) => r.status ?? -1, key: "status", type: "number" as const },
];

export function PlanListTable({
  basePath,
  canApprove,
  kind,
  month,
  plans,
  selectedPlanId,
  year,
}: {
  basePath: string;
  canApprove: boolean;
  kind: PlanKind;
  month: number;
  plans: PlanSummary[];
  selectedPlanId: number | null;
  year: number;
}) {
  const router = useRouter();
  const table = useSortableTable(plans, {
    columns: PLAN_COLS,
    // Pending first is the whole point of the board, so the default sort is by status, not by name.
    initialSort: { dir: "asc", key: "status" },
    searchAccessors: [(r) => r.repName, (r) => planPeriodText(r), (r) => planStatusLabel(r.status)],
  });

  function open(plan: PlanSummary) {
    const params = new URLSearchParams({
      kind,
      month: String(month),
      plan: String(plan.crmPlanId),
      year: String(year),
    });
    router.push(`${basePath}?${params.toString()}`);
  }

  const exportRows = table.rows.map((plan) => ({
    doctors: plan.contacts,
    period: planPeriodText(plan),
    plan_id: plan.crmPlanId,
    planned_calls: plan.entries,
    rep: plan.repName,
    status: planStatusLabel(plan.status),
  }));

  return (
    <div className="space-y-3 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <TableSearchInput
          onChange={table.setQuery}
          onClear={table.clearQuery}
          placeholder="Search rep, period or status…"
          value={table.query}
        />
        <ExportXlsxButton
          columns={[
            { key: "rep", label: "Medical rep" },
            { key: "period", label: "Period" },
            { key: "doctors", label: "Doctors" },
            { key: "planned_calls", label: "Planned calls" },
            { key: "status", label: "Status" },
            { key: "plan_id", label: "CRM plan id" },
          ]}
          rows={exportRows}
          sheetName="Plans"
          subtitle={`${kind === "weekly" ? "Weekly" : "Monthly"} plans · ${MONTH_NAMES[month - 1]} ${year}`}
          title="Plan Verification"
        />
      </div>
      <PortalResponsiveDataList
        empty={
          <p className="px-3 py-6 text-center text-xs text-slate-400">
            No {kind} plans for this period.
          </p>
        }
        getKey={(plan) => String(plan.crmPlanId)}
        items={table.rows}
        renderCard={(plan) => (
          <PortalRecordCard
            accent={plan.status === PLAN_STATUS_NEW ? "amber" : "slate"}
            meta={`${planPeriodText(plan)} · ${plan.contacts} doctors`}
            status={
              <span className={`text-phx-sm font-black uppercase tracking-[0.1em] ${planStatusClass(plan.status)}`}>
                {planStatusLabel(plan.status)}
              </span>
            }
            title={plan.repName}
          >
            <PortalRecordFields
              fields={[
                { label: "Planned calls", value: String(plan.entries) },
              ]}
            />
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                className="h-8 border border-slate-300 bg-white px-3 text-phx-sm font-black uppercase tracking-[0.1em] text-slate-700 hover:border-orange-400"
                onClick={() => open(plan)}
                type="button"
              >
                {selectedPlanId === plan.crmPlanId ? "Showing doctors" : "Show doctors"}
              </button>
              <PlanApproveButton canApprove={canApprove} plan={plan} />
            </div>
          </PortalRecordCard>
        )}
        renderTable={() => (
          <PortalDesktopTable
            className="text-xs"
            cols={
              <colgroup>
                <col className="w-[22%]" />
                <col className="w-[16%]" />
                <col className="w-[10%]" />
                <col className="w-[13%]" />
                <col className="w-[15%]" />
                <col className="w-[24%]" />
              </colgroup>
            }
          >
            {/* The Action column carries two buttons, so it gets the widest share after the rep name;
                the table is table-fixed and wraps to fit main rather than side-scrolling. */}
            <thead>
              <tr className="bg-slate-900 text-left">
                <SortableTh className={THEAD} label="Medical rep" onSort={table.toggleSort} sort={table.sort} sortKey="repName" />
                <SortableTh className={THEAD} label="Period" onSort={table.toggleSort} sort={table.sort} sortKey="firstDate" />
                <SortableTh className={THEAD} label="Doctors" onSort={table.toggleSort} sort={table.sort} sortKey="contacts" />
                <SortableTh className={THEAD} label="Planned calls" onSort={table.toggleSort} sort={table.sort} sortKey="entries" />
                <SortableTh className={THEAD} label="Status" onSort={table.toggleSort} sort={table.sort} sortKey="status" />
                <th className={THEAD}>Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {table.rows.map((plan) => {
                const showing = selectedPlanId === plan.crmPlanId;
                return (
                  <tr
                    className={`hover:bg-slate-50 ${showing ? "bg-orange-50" : "bg-white"}`}
                    key={plan.crmPlanId}
                  >
                    {/* The accent bar is on the cell, not the row: a border on a <tr> does not paint in
                        a border-collapse table. It is transparent when unselected rather than absent,
                        so opening a plan never shifts the column by 4px. */}
                    <td
                      className={`border-l-4 px-3 py-2 font-semibold text-slate-900 ${
                        showing ? "border-orange-500" : "border-transparent"
                      }`}
                    >
                      {/* Underlined and pointer-cursored because it is the primary way into a plan and
                          a bare <button> renders as plain text with a default arrow — nothing about it
                          said "press me". */}
                      <button
                        className="cursor-pointer text-left underline decoration-slate-300 underline-offset-4 hover:text-orange-600 hover:decoration-orange-500"
                        onClick={() => open(plan)}
                        type="button"
                      >
                        {plan.repName}
                      </button>
                    </td>
                    <td className="px-3 py-2 text-slate-600">{planPeriodText(plan)}</td>
                    <td className="px-3 py-2 font-black text-slate-900">{plan.contacts}</td>
                    <td className="px-3 py-2 text-slate-600">{plan.entries}</td>
                    <td className={`px-3 py-2 font-black ${planStatusClass(plan.status)}`}>{planStatusLabel(plan.status)}</td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap items-center gap-2">
                        {/* The same button the mobile card has always carried. Desktop had none, so the
                            only way in was to guess that the rep's name was pressable. */}
                        <button
                          className={`h-8 border px-3 text-phx-sm font-black uppercase tracking-[0.1em] ${
                            showing
                              ? "border-orange-400 bg-orange-500 text-white"
                              : "border-slate-300 bg-white text-slate-700 hover:border-orange-400"
                          }`}
                          onClick={() => open(plan)}
                          type="button"
                        >
                          {showing ? "Showing doctors" : "Show doctors"}
                        </button>
                        <PlanApproveButton canApprove={canApprove} plan={plan} />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </PortalDesktopTable>
        )}
      />
    </div>
  );
}

const MISSING_COLS = [
  { accessor: (r: PlanMissingRep) => r.name, defaultDir: "asc" as const, key: "name", type: "string" as const },
  { accessor: (r: PlanMissingRep) => r.pmCount, key: "pmCount", type: "number" as const },
];

/**
 * The reps in the viewer's reach who filed NO plan for the period.
 *
 * A separate table rather than rows in the plans table on purpose: these have no plan id, no status
 * and nothing to verify, so every column that table sorts and searches on would be blank for them,
 * and a verify button beside a plan that does not exist is worse than no row at all.
 *
 * `rosterKnown` false means the CRM contact mirror came back empty, which is a different statement
 * from "everybody filed" — see the note on the field. The board renders the unavailable message
 * instead of an all-clear.
 */
export function PlanMissingRepsTable({
  kind,
  month,
  reps,
  rosterKnown,
  year,
}: {
  kind: PlanKind;
  month: number;
  reps: PlanMissingRep[];
  rosterKnown: boolean;
  year: number;
}) {
  const table = useSortableTable(reps, {
    columns: MISSING_COLS,
    initialSort: { dir: "asc", key: "name" },
    searchAccessors: [(r) => r.name],
  });

  if (!rosterKnown) {
    return (
      <div className="px-5 py-6">
        <p className="text-sm font-semibold text-slate-700">The rep roster could not be read.</p>
        <p className="mt-1 text-phx-xs text-slate-500">
          This list is built from the CRM&rsquo;s own assigned-doctor mirror, and it returned nobody. That is not
          the same as every rep having filed — until the mirror refreshes, this board cannot tell you who is
          missing.
        </p>
      </div>
    );
  }

  const exportRows = table.rows.map((rep) => ({
    doctors: rep.pmCount,
    rep: rep.name,
    status: "No plan filed",
  }));

  return (
    <div className="space-y-3 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <TableSearchInput
          onChange={table.setQuery}
          onClear={table.clearQuery}
          placeholder="Search rep…"
          value={table.query}
        />
        <ExportXlsxButton
          columns={[
            { key: "rep", label: "Medical rep" },
            { key: "doctors", label: "Doctors on their list" },
            { key: "status", label: "Status" },
          ]}
          rows={exportRows}
          sheetName="Filed nothing"
          subtitle={`${kind === "weekly" ? "Weekly" : "Monthly"} plans · ${MONTH_NAMES[month - 1]} ${year}`}
          title="Reps with no plan"
        />
      </div>
      <PortalResponsiveDataList
        empty={
          <p className="px-3 py-6 text-center text-xs text-emerald-700">
            Every rep in your reach filed a {kind} plan for this period.
          </p>
        }
        getKey={(rep) => String(rep.agentCrmId)}
        items={table.rows}
        renderCard={(rep) => (
          <PortalRecordCard
            accent="rose"
            meta={`${rep.pmCount} doctors on their list`}
            status={
              <span className="text-phx-sm font-black uppercase tracking-[0.1em] text-rose-700">No plan filed</span>
            }
            title={rep.name}
          >
          </PortalRecordCard>
        )}
        renderTable={() => (
          <PortalDesktopTable
            className="text-xs"
            cols={
              <colgroup>
                <col className="w-[45%]" />
                <col className="w-[30%]" />
                <col className="w-[25%]" />
              </colgroup>
            }
          >
            <thead>
              <tr className="bg-slate-900 text-left">
                <SortableTh className={THEAD} label="Medical rep" onSort={table.toggleSort} sort={table.sort} sortKey="name" />
                <SortableTh
                  className={THEAD}
                  label="Doctors on their list"
                  onSort={table.toggleSort}
                  sort={table.sort}
                  sortKey="pmCount"
                />
                <th className={THEAD}>Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {table.rows.map((rep) => (
                <tr className="bg-white hover:bg-slate-50" key={rep.agentCrmId}>
                  <td className="border-l-4 border-rose-400 px-3 py-2 font-semibold text-slate-900">{rep.name}</td>
                  {/* The list size is here as evidence the account is a working one. A rep carrying 0
                      doctors has nothing to plan against, so his silence means something different
                      from the silence of a rep carrying 118. */}
                  <td className="px-3 py-2 font-black text-slate-900">{rep.pmCount}</td>
                  <td className="px-3 py-2 font-black text-rose-700">No plan filed</td>
                </tr>
              ))}
            </tbody>
          </PortalDesktopTable>
        )}
      />
      {/* Said out loud because the alternative is a manager reading this as a complete census. It is
          built from the reps whose doctor list the CRM has mirrored, and the CRM plans for more reps
          than that — so this is a floor. Nobody here is falsely accused; some may be absent. */}
      <p className="text-phx-sm text-slate-400">
        Built from the reps whose doctor list the CRM has mirrored. A rep the mirror does not hold yet cannot
        appear here, so treat this as the reps it can prove, not as every rep alive.
      </p>
    </div>
  );
}

/**
 * What the Address cell says, including when there is no address.
 *
 * THREE outcomes, not two, because the two empty cases are different facts and the owner's standing
 * rule is that a screen never shows nothing where a value is missing. Measured in production
 * 2026-08-28 across August's weekly plans: of 9,769 doctor-plan pairs, 78.7% carry an address, 2.9%
 * are on the rep's list with none recorded, and 18.4% are planned against a doctor who is NOT on his
 * current list — the last being exactly the sort of thing a manager verifying the plan wants to see,
 * and it would have been a dash indistinguishable from a CRM data gap.
 *
 * One function so the table, the mobile card and the exported sheet can never word it differently.
 */
function addressText(row: PlanEntryRow): string {
  if (row.address) return row.address;
  return row.onRepList ? "No address recorded" : "Not on their list";
}

const ENTRY_COLS = [
  { accessor: (r: PlanEntryRow) => r.contactName, defaultDir: "asc" as const, key: "contactName", type: "string" as const },
  { accessor: (r: PlanEntryRow) => r.planDate ?? "", key: "planDate", type: "string" as const },
  { accessor: (r: PlanEntryRow) => r.grade, key: "grade", type: "string" as const },
  { accessor: (r: PlanEntryRow) => r.speciality, key: "speciality", type: "string" as const },
  { accessor: (r: PlanEntryRow) => r.region, key: "region", type: "string" as const },
  // Sorting by address groups a day's calls by street, which is how a manager reads a route.
  { accessor: (r: PlanEntryRow) => addressText(r), key: "address", type: "string" as const },
  { accessor: (r: PlanEntryRow) => r.frequency ?? 0, key: "frequency", type: "number" as const },
];

/** How much of the page above the doctors section stays visible when a plan opens. */
const PLAN_LANDING_GAP = 12;

export function PlanDoctorsTable({ kind, plan, rows }: { kind: PlanKind; plan: PlanSummary; rows: PlanEntryRow[] }) {
  const landingRef = useRef<HTMLDivElement | null>(null);
  /**
   * Bring the doctors into view when a plan opens.
   *
   * Without this the board looked broken rather than merely awkward. This section renders BELOW the
   * whole plans list, so pressing a rep sent the manager to content already off the bottom of the
   * screen while the viewport never moved — and the only cue at the click site was a bg-orange-50
   * row, which is #fff7ed and reads as white. The owner's entire report was "I press on the rep name
   * nothing happens". The click had always worked; there was nothing on screen to say so.
   *
   * Instant, and computed from the section's own box, both copied deliberately from the identical fix
   * in recruitment-workspace.tsx (2026-08-21): Chrome ABANDONS a programmatic smooth scroll over a
   * long distance, which is exactly this case — a manager with forty reps has a very tall table above
   * this point. A smooth call would reproduce the original bug on the boards that suffer most, while
   * looking perfect on any small one.
   *
   * Keyed on the plan id, so it fires when a plan is opened or switched — not on every re-render,
   * which would yank the page back each time he sorted or searched the doctors below.
   */
  useEffect(() => {
    if (typeof window === "undefined") return;
    // The anchor is the whole SECTION, which the server half wraps — landing on this component's own
    // box would scroll the "<rep> — <period>" heading off the top, and that heading is the only thing
    // naming which plan just opened. The ref is the fallback and cannot be null, so the scroll still
    // happens if that wrapper is ever removed.
    const section = document.getElementById(PLAN_DOCTORS_ANCHOR_ID) ?? landingRef.current;
    if (!section) return;
    // After paint — the box is only real once the new section has been laid out.
    const frame = requestAnimationFrame(() => {
      const top = section.getBoundingClientRect().top + window.scrollY;
      window.scrollTo({ behavior: "auto", top: Math.max(0, top - PLAN_LANDING_GAP) });
    });
    return () => cancelAnimationFrame(frame);
  }, [plan.crmPlanId]);

  const table = useSortableTable(rows, {
    columns: ENTRY_COLS,
    initialSort: kind === "weekly" ? { dir: "asc", key: "planDate" } : { dir: "asc", key: "contactName" },
    searchAccessors: [
      (r) => r.contactName,
      (r) => r.speciality ?? "",
      (r) => r.region ?? "",
      // Searchable because a manager checking a day's route asks it geographically — "is he really
      // crossing the city twice on Tuesday" — and that question is asked of the address.
      (r) => addressText(r),
    ],
  });

  const exportRows = table.rows.map((row) => ({
    address: addressText(row),
    ampm: row.ampm ?? "",
    day: row.planDate ?? "",
    doctor: row.contactName,
    frequency: row.frequency ?? "",
    grade: row.grade ?? "",
    locality: row.region ?? "",
    speciality: row.speciality ?? "",
  }));

  return (
    <div className="space-y-3 p-5" ref={landingRef}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <TableSearchInput
          onChange={table.setQuery}
          onClear={table.clearQuery}
          placeholder="Search doctor, specialty, locality or address…"
          value={table.query}
        />
        <ExportXlsxButton
          columns={
            kind === "weekly"
              ? [
                  { key: "day", label: "Day" },
                  { key: "ampm", label: "AM/PM" },
                  { key: "doctor", label: "Doctor" },
                  { key: "grade", label: "Grade" },
                  { key: "speciality", label: "Specialty" },
                  { key: "locality", label: "Locality" },
                  { key: "address", label: "Address" },
                ]
              : [
                  { key: "doctor", label: "Doctor" },
                  { key: "frequency", label: "Planned calls" },
                  { key: "grade", label: "Grade" },
                  { key: "speciality", label: "Specialty" },
                  { key: "locality", label: "Locality" },
                  { key: "address", label: "Address" },
                ]
          }
          rows={exportRows}
          sheetName="Plan doctors"
          subtitle={`${plan.repName} · ${planPeriodText(plan)}`}
          title="Plan doctors"
        />
      </div>
      <PortalResponsiveDataList
        empty={<p className="px-3 py-6 text-center text-xs text-slate-400">No doctors match this filter.</p>}
        getKey={(row, index) => `${row.contactCrmId ?? "none"}:${row.planDate ?? "nodate"}:${index}`}
        items={table.rows}
        renderCard={(row) => (
          <PortalRecordCard
            accent="slate"
            meta={`${row.speciality ?? "Unspecified"} · ${row.region ?? "No locality"}`}
            status={
              <span className={`text-phx-sm font-black uppercase tracking-[0.1em] ${gradeClass(row.grade)}`}>
                {row.grade ?? "No grade"}
              </span>
            }
            title={row.contactName}
          >
            <PortalRecordFields
              fields={
                kind === "weekly"
                  ? [
                      { label: "Day", value: row.planDate ?? "—" },
                      { label: "AM/PM", value: row.ampm ?? "—" },
                      { label: "Address", value: addressText(row) },
                    ]
                  : [
                      { label: "Planned calls", value: row.frequency == null ? "—" : String(row.frequency) },
                      { label: "Address", value: addressText(row) },
                    ]
              }
            />
          </PortalRecordCard>
        )}
        renderTable={() => (
          <PortalDesktopTable
            className="text-xs"
            cols={
              <colgroup>
                {kind === "weekly" ? (
                  <>
                    <col className="w-[9%]" />
                    <col className="w-[8%]" />
                  </>
                ) : (
                  <col className="w-[13%]" />
                )}
                <col className="w-[20%]" />
                <col className="w-[8%]" />
                <col className="w-[15%]" />
                <col className="w-[13%]" />
                <col className="w-[27%]" />
              </colgroup>
            }
          >
            <thead>
              <tr className="bg-slate-900 text-left">
                {kind === "weekly" ? (
                  <>
                    <SortableTh className={THEAD} label="Day" onSort={table.toggleSort} sort={table.sort} sortKey="planDate" />
                    <th className={THEAD}>AM/PM</th>
                  </>
                ) : (
                  <SortableTh
                    className={THEAD}
                    label="Planned calls"
                    onSort={table.toggleSort}
                    sort={table.sort}
                    sortKey="frequency"
                  />
                )}
                <SortableTh className={THEAD} label="Doctor" onSort={table.toggleSort} sort={table.sort} sortKey="contactName" />
                <SortableTh className={THEAD} label="Grade" onSort={table.toggleSort} sort={table.sort} sortKey="grade" />
                <SortableTh className={THEAD} label="Specialty" onSort={table.toggleSort} sort={table.sort} sortKey="speciality" />
                <SortableTh className={THEAD} label="Locality" onSort={table.toggleSort} sort={table.sort} sortKey="region" />
                <SortableTh className={THEAD} label="Address" onSort={table.toggleSort} sort={table.sort} sortKey="address" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {table.rows.map((row, index) => (
                <tr
                  className="bg-white hover:bg-slate-50"
                  key={`${row.contactCrmId ?? "none"}:${row.planDate ?? "nodate"}:${index}`}
                >
                  {kind === "weekly" ? (
                    <>
                      <td className="px-3 py-2 text-slate-600">{row.planDate ?? "—"}</td>
                      <td className="px-3 py-2 text-slate-400">{row.ampm ?? "—"}</td>
                    </>
                  ) : (
                    <td className="px-3 py-2 font-black text-slate-900">{row.frequency == null ? "—" : row.frequency}</td>
                  )}
                  <td className="px-3 py-2 font-semibold text-slate-900">{row.contactName}</td>
                  <td className={`px-3 py-2 font-black ${gradeClass(row.grade)}`}>{row.grade ?? "—"}</td>
                  <td className="px-3 py-2 text-slate-600">{row.speciality ?? "Unspecified"}</td>
                  <td className="px-3 py-2 text-slate-400">{row.region ?? "—"}</td>
                  {/* Same treatment as tab one: the address is long and genuinely needed, and is
                      never truncated with an ellipsis (owner's standing rule) — its column gets the
                      widest share of the table-fixed colgroup and long values wrap to fit main. */}
                  <td className={`px-3 py-2 ${row.address ? "text-slate-600" : "text-slate-400"}`}>
                    {addressText(row)}
                  </td>
                </tr>
              ))}
            </tbody>
          </PortalDesktopTable>
        )}
      />
    </div>
  );
}