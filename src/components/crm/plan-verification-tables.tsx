"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import {
  PortalDesktopTable,
  PortalRecordCard,
  PortalRecordFields,
  PortalResponsiveDataList,
} from "@/components/employee-portal/portal-primitives";
import { ExportXlsxButton } from "@/components/ui/export-xlsx-button";
import { SortableTh, TableSearchInput } from "@/components/ui/sortable-table";
import { useSortableTable } from "@/components/ui/use-sortable-table";
import {
  PLAN_STATUS_AREA_MANAGER_VERIFIED,
  PLAN_STATUS_NEW,
  planStatusLabel,
  type PlanKind,
} from "@/lib/crm/plan-verification";
import type { PlanEntryRow, PlanSummary } from "@/lib/crm/plan-board";

// Client half of Plan Verification. Styling copies doctor-list-tables.tsx verbatim — flat borders,
// slate-900 header rows, orange accent — because this is tab two of the same District Manager page
// and must not read as a one-off (owner's standing rule).
//
// The period, the kind and the chosen plan all ride in the URL, so every change re-runs the
// server-side scope gate rather than filtering a payload already in the browser. That is the
// sibling's rule and the reason is stronger here: this board carries a button that writes into the
// customer's CRM, so what a viewer may act on has to be a server decision every time.

const THEAD = "px-3 py-2.5 text-phx-2xs font-black uppercase tracking-[0.12em] text-white";
const SELECT_CLASS =
  "h-9 w-full border border-slate-200 bg-white px-2 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400";
const LABEL_CLASS = "block text-phx-3xs font-black uppercase tracking-[0.16em] text-slate-400";

function statusClass(status: number | null): string {
  if (status === PLAN_STATUS_NEW) return "text-amber-700";
  if (status === PLAN_STATUS_AREA_MANAGER_VERIFIED) return "text-sky-700";
  return "text-emerald-700";
}

function gradeClass(grade: string | null): string {
  if (grade === "A" || grade === "A+") return "text-rose-700";
  if (grade === "B") return "text-amber-700";
  if (!grade) return "text-slate-300";
  return "text-slate-500";
}

/** The period a plan covers, written out. Weekly plans have a span; monthly plans have a month. */
export function planPeriodText(plan: PlanSummary): string {
  if (plan.kind === "monthly") {
    if (plan.month && plan.year) {
      return new Intl.DateTimeFormat("en-GB", { month: "long", timeZone: "UTC", year: "numeric" }).format(
        new Date(Date.UTC(plan.year, plan.month - 1, 1)),
      );
    }
    return "No month recorded";
  }
  if (plan.firstDate && plan.lastDate && plan.firstDate !== plan.lastDate) {
    return `${plan.firstDate} to ${plan.lastDate}`;
  }
  return plan.firstDate ?? plan.lastDate ?? "No dates recorded";
}

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

/**
 * The Verify button.
 *
 * TWO CLICKS, ON PURPOSE. This writes into the customer's CRM and emails the medical rep, and
 * neither can be taken back from here — there is no unverify. So the first click arms and the
 * second commits, and the armed state says what is about to happen rather than just "Confirm?".
 * A native `confirm()` dialog was not used because the admin shell has none anywhere else.
 */
function VerifyButton({ canVerify, plan }: { canVerify: boolean; plan: PlanSummary }) {
  const router = useRouter();
  const [armed, setArmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);

  async function commit() {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const response = await fetch("/api/crm/plan-verification/verify", {
        body: JSON.stringify({ crmPlanId: plan.crmPlanId }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        repNotified?: boolean;
        repNotifyReason?: string | null;
      };
      if (!response.ok) {
        setError(payload.error ?? `The CRM refused the change (HTTP ${response.status}).`);
        setArmed(false);
        return;
      }
      // A verified plan whose rep could not be told is still verified. Saying so beats both hiding
      // it and reporting the whole action as failed.
      if (payload.repNotified === false) {
        setNote(`Verified. The rep could not be notified: ${payload.repNotifyReason ?? "unknown reason"}.`);
      }
      setArmed(false);
      startTransition(() => router.refresh());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The request could not be sent.");
      setArmed(false);
    } finally {
      setBusy(false);
    }
  }

  // A plan that is not pending, and a viewer who may not verify, both render the same thing: the
  // status in words. Hiding the button is UX — the route refuses the POST independently, which is
  // the boundary.
  if (plan.status !== PLAN_STATUS_NEW || !canVerify) {
    return (
      <span className={`text-phx-2xs font-black uppercase tracking-[0.1em] ${statusClass(plan.status)}`}>
        {planStatusLabel(plan.status)}
      </span>
    );
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <button
          className={
            armed
              ? "h-8 border border-orange-500 bg-orange-500 px-3 text-phx-2xs font-black uppercase tracking-[0.1em] text-white disabled:opacity-60"
              : "h-8 border border-slate-300 bg-white px-3 text-phx-2xs font-black uppercase tracking-[0.1em] text-slate-700 hover:border-orange-400 disabled:opacity-60"
          }
          disabled={busy || pending}
          onClick={() => {
            if (armed) void commit();
            else setArmed(true);
          }}
          type="button"
        >
          {busy ? "Sending" : armed ? "Confirm — writes to the CRM" : "Verify"}
        </button>
        {armed && !busy ? (
          <button
            className="h-8 px-2 text-phx-2xs font-bold uppercase tracking-[0.1em] text-slate-400 hover:text-slate-700"
            onClick={() => setArmed(false)}
            type="button"
          >
            Cancel
          </button>
        ) : null}
      </div>
      {error ? <p className="text-phx-2xs font-semibold text-rose-700">{error}</p> : null}
      {note ? <p className="text-phx-2xs font-semibold text-amber-700">{note}</p> : null}
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
  canVerify,
  kind,
  month,
  plans,
  selectedPlanId,
  year,
}: {
  basePath: string;
  canVerify: boolean;
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
              <span className={`text-phx-2xs font-black uppercase tracking-[0.1em] ${statusClass(plan.status)}`}>
                {planStatusLabel(plan.status)}
              </span>
            }
            title={plan.repName}
          >
            <PortalRecordFields
              fields={[
                { label: "Planned calls", value: String(plan.entries) },
                { label: "CRM plan", value: String(plan.crmPlanId) },
              ]}
            />
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                className="h-8 border border-slate-300 bg-white px-3 text-phx-2xs font-black uppercase tracking-[0.1em] text-slate-700 hover:border-orange-400"
                onClick={() => open(plan)}
                type="button"
              >
                {selectedPlanId === plan.crmPlanId ? "Showing doctors" : "Show doctors"}
              </button>
              <VerifyButton canVerify={canVerify} plan={plan} />
            </div>
          </PortalRecordCard>
        )}
        renderTable={() => (
          <PortalDesktopTable className="text-xs" minWidth="1080px">
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
              {table.rows.map((plan) => (
                <tr
                  className={`whitespace-nowrap hover:bg-slate-50 ${
                    selectedPlanId === plan.crmPlanId ? "bg-orange-50" : "bg-white"
                  }`}
                  key={plan.crmPlanId}
                >
                  <td className="px-3 py-2 font-semibold text-slate-900">
                    <button className="text-left hover:text-orange-600" onClick={() => open(plan)} type="button">
                      {plan.repName}
                    </button>
                  </td>
                  <td className="px-3 py-2 text-slate-600">{planPeriodText(plan)}</td>
                  <td className="px-3 py-2 font-black text-slate-900">{plan.contacts}</td>
                  <td className="px-3 py-2 text-slate-600">{plan.entries}</td>
                  <td className={`px-3 py-2 font-black ${statusClass(plan.status)}`}>{planStatusLabel(plan.status)}</td>
                  <td className="px-3 py-2">
                    <VerifyButton canVerify={canVerify} plan={plan} />
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

const ENTRY_COLS = [
  { accessor: (r: PlanEntryRow) => r.contactName, defaultDir: "asc" as const, key: "contactName", type: "string" as const },
  { accessor: (r: PlanEntryRow) => r.planDate ?? "", key: "planDate", type: "string" as const },
  { accessor: (r: PlanEntryRow) => r.grade, key: "grade", type: "string" as const },
  { accessor: (r: PlanEntryRow) => r.speciality, key: "speciality", type: "string" as const },
  { accessor: (r: PlanEntryRow) => r.region, key: "region", type: "string" as const },
  { accessor: (r: PlanEntryRow) => r.frequency ?? 0, key: "frequency", type: "number" as const },
];

export function PlanDoctorsTable({ kind, plan, rows }: { kind: PlanKind; plan: PlanSummary; rows: PlanEntryRow[] }) {
  const table = useSortableTable(rows, {
    columns: ENTRY_COLS,
    initialSort: kind === "weekly" ? { dir: "asc", key: "planDate" } : { dir: "asc", key: "contactName" },
    searchAccessors: [(r) => r.contactName, (r) => r.speciality ?? "", (r) => r.region ?? ""],
  });

  const exportRows = table.rows.map((row) => ({
    ampm: row.ampm ?? "",
    day: row.planDate ?? "",
    doctor: row.contactName,
    frequency: row.frequency ?? "",
    grade: row.grade ?? "",
    locality: row.region ?? "",
    speciality: row.speciality ?? "",
  }));

  return (
    <div className="space-y-3 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <TableSearchInput
          onChange={table.setQuery}
          onClear={table.clearQuery}
          placeholder="Search doctor, specialty or locality…"
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
                ]
              : [
                  { key: "doctor", label: "Doctor" },
                  { key: "frequency", label: "Planned calls" },
                  { key: "grade", label: "Grade" },
                  { key: "speciality", label: "Specialty" },
                  { key: "locality", label: "Locality" },
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
              <span className={`text-phx-2xs font-black uppercase tracking-[0.1em] ${gradeClass(row.grade)}`}>
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
                    ]
                  : [{ label: "Planned calls", value: row.frequency == null ? "—" : String(row.frequency) }]
              }
            />
          </PortalRecordCard>
        )}
        renderTable={() => (
          <PortalDesktopTable className="text-xs" minWidth="980px">
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
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {table.rows.map((row, index) => (
                <tr
                  className="whitespace-nowrap bg-white hover:bg-slate-50"
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
                </tr>
              ))}
            </tbody>
          </PortalDesktopTable>
        )}
      />
    </div>
  );
}
