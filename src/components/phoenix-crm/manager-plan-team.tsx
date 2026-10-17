"use client";

/**
 * Phoenix CRM — the Team tab's two district-manager sections (owner, 2026-10-16).
 *
 * "Manager plans" — a district manager's week, planned against what happened ("separate report …
 * actual versus planned"). A customer ticked with a rep reads Done only when the REP logged the visit and
 * named him (the double visit's own rule); a single-visit customer reads Done when he logged it himself.
 * Admin half-days are not checkable. Visits he made without a plan are listed apart. Read by him, his RSM,
 * his NSM, SFE, the CEO and the Super Admin ("him rsm dsm sfe nsm admin ceo") — never a rep.
 *
 * "Manager's own list" — the customers he visits alone, kept apart from his reps' lists and never merged
 * into them. He adds one himself (no validation step); taking one off needs his RSM/NSM's approval, in
 * the Approvals Hub.
 */

import { useId, useState } from "react";

import { crmPost, crmUrl, messageOf, useCrmGet } from "@/components/phoenix-crm/api";
import { ManagerCustomerForm } from "@/components/phoenix-crm/manager-customer-form";
import {
  CrmBlock,
  CrmButton,
  CrmCard,
  CrmChoice,
  CrmEmpty,
  CrmLoadError,
  CrmLoading,
  CrmNote,
  CrmPill,
  crmTextareaClassName,
  type CrmChoiceOption,
  type PillTone,
} from "@/components/phoenix-crm/ui";
import { MANAGER_PLAN_REASON_MAX, type ManagerOutcome } from "@/lib/phoenix-crm/manager-plan-rules";
import type { ManagerCustomerView, ManagerOwnListView, ManagerPlanReportView } from "@/lib/phoenix-crm/view-types";

const OUTCOME_TONE: Record<ManagerOutcome, PillTone> = {
  done: "good",
  not_done: "bad",
  open: "neutral",
  ahead: "info",
  not_checkable: "neutral",
};

/** One district manager among those he reads — a choice, never a code. */
function ManagerPicker({
  label,
  managers,
  onPick,
  value,
}: {
  label: string;
  managers: ReadonlyArray<{ hrId: string; name: string; place: string; summaryText?: string }>;
  onPick: (hrId: string) => void;
  value: string | null;
}) {
  if (managers.length === 0) return <CrmEmpty message="No district manager sits beneath you right now." title="No district managers" />;
  const options: Array<CrmChoiceOption<string>> = managers.map((manager) => ({
    value: manager.hrId,
    label: manager.name,
    note: manager.summaryText ? `${manager.place} · ${manager.summaryText}` : manager.place,
  }));
  return <CrmChoice columns={2} label={label} onChange={onPick} options={options} value={value} />;
}

// ── Manager plans ───────────────────────────────────────────────────────────────────────────────

export function ManagerPlansSection({ test }: { test: boolean }) {
  const [week, setWeek] = useState<string | null>(null);
  const [manager, setManager] = useState<string | null>(null);
  const report = useCrmGet<ManagerPlanReportView>(crmUrl("/api/phoenix-crm/manager-plans/report", { week, manager, test }), "report");
  // A new week or manager is a new address, and the old answer must never sit under the new choice — so
  // the pickers keep the answer they were chosen FROM while the report below them loads, rather than the
  // whole section blanking to a spinner on every pick.
  const [chosenFrom, setChosenFrom] = useState<ManagerPlanReportView | null>(null);
  const view = report.data;
  const pickers = view ?? chosenFrom;

  if (!pickers) {
    return report.error ? <CrmLoadError message={report.error} onRetry={report.reload} /> : <CrmLoading label="Loading the district managers' plans" />;
  }
  const weekOptions: Array<CrmChoiceOption<string>> = pickers.weeks.map((entry) => ({ value: entry.weekStart, label: entry.name }));
  const pickWeek = (next: string) => {
    setChosenFrom(pickers);
    setWeek(next);
  };
  const pickManager = (next: string) => {
    setChosenFrom(pickers);
    setManager(next);
  };

  return (
    <>
      <CrmBlock className="border-t border-slate-100" title="Week">
        <CrmChoice columns={3} label="Week" onChange={pickWeek} options={weekOptions} value={view ? view.weekStart : (week ?? pickers.weekStart)} />
      </CrmBlock>
      {pickers.mode === "pick" && pickers.managers ? (
        <CrmBlock className="border-t border-slate-100" title="District manager">
          <ManagerPicker
            label="District manager"
            managers={pickers.managers}
            onPick={pickManager}
            value={view ? (view.manager?.hrId ?? null) : (manager ?? pickers.manager?.hrId ?? null)}
          />
        </CrmBlock>
      ) : null}
      {view ? <ManagerPlanReportBody view={view} /> : (
        <CrmBlock className="border-t border-slate-100">
          {report.error ? <CrmLoadError message={report.error} onRetry={report.reload} /> : <CrmLoading label="Loading the week" />}
        </CrmBlock>
      )}
    </>
  );
}

function ManagerPlanReportBody({ view }: { view: ManagerPlanReportView }) {
  const current = view.report;
  return (
    <>
      {current && view.manager ? (
        <CrmBlock className="border-t border-slate-100" title={`${view.manager.name} · ${view.manager.place}`}>
          <CrmNote title={current.summaryText} tone={current.summary.notDone > 0 ? "warn" : "neutral"}>
            {current.statusLine}
          </CrmNote>
          {current.days.length === 0 ? (
            <div className="mt-3">
              <CrmEmpty message="Nothing was planned for this week." title="No plan" />
            </div>
          ) : (
            <div className="mt-3 grid min-w-0 gap-2">
              {current.days.map((day) => (
                <div className="min-w-0 border border-slate-200" key={day.date}>
                  <p className="border-b border-slate-100 bg-slate-50 px-3 py-1.5 text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-600">{day.dateText}</p>
                  {day.halves.map((half) => (
                    <div className="min-w-0 border-b border-slate-100 px-3 py-2 last:border-b-0" key={half.half}>
                      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                        <span className="text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500">{half.half}</span>
                        <span className="min-w-0 break-words text-sm font-bold text-slate-900">{half.title}</span>
                      </div>
                      {half.note ? <p className="mt-1 break-words text-xs font-semibold text-slate-600">{half.note}</p> : null}
                      {half.customers.length > 0 ? (
                        <ul className="mt-1.5 grid min-w-0 gap-1">
                          {half.customers.map((customer, index) => (
                            <li className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm" key={`${customer.name}-${index}`}>
                              <span className="min-w-0 break-words font-semibold text-slate-800" dir="auto">
                                {customer.name}
                              </span>
                              {customer.own ? <CrmPill tone="orange">Own list</CrmPill> : null}
                              {customer.flagLabel ? <CrmPill tone="warn">{customer.flagLabel}</CrmPill> : null}
                              <CrmPill tone={OUTCOME_TONE[customer.outcome]}>{customer.outcomeLabel}</CrmPill>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
          {current.unplanned.length > 0 ? (
            <div className="mt-4 grid min-w-0 gap-2">
              <p className="text-phx-2xs font-black uppercase tracking-[0.16em] text-slate-500">Visited without a plan</p>
              <ul className="grid min-w-0 gap-1">
                {current.unplanned.map((visit, index) => (
                  <li className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm" key={`${visit.date}-${visit.name}-${index}`}>
                    <span className="text-xs font-bold text-slate-500">{visit.dateText}</span>
                    <span className="min-w-0 break-words font-semibold text-slate-800" dir="auto">
                      {visit.name}
                    </span>
                    {visit.own ? <CrmPill tone="orange">Own list</CrmPill> : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </CrmBlock>
      ) : view.mode === "pick" ? null : (
        <CrmBlock className="border-t border-slate-100">
          <CrmEmpty message="Nothing was planned for this week." title="No plan" />
        </CrmBlock>
      )}
    </>
  );
}

// ── Manager's own list ──────────────────────────────────────────────────────────────────────────

export function ManagerOwnListSection({ test }: { test: boolean }) {
  const idPrefix = useId();
  const [manager, setManager] = useState<string | null>(null);
  const list = useCrmGet<ManagerOwnListView>(crmUrl("/api/phoenix-crm/manager-plans/customers", { manager, test }), "list");
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // As the plans section: the picker keeps the list it was chosen from while the next one loads.
  const [chosenFrom, setChosenFrom] = useState<ManagerOwnListView | null>(null);
  const view = list.data;

  if (!view) {
    const loading = list.error ? <CrmLoadError message={list.error} onRetry={list.reload} /> : <CrmLoading label="Loading Manager's own list" />;
    if (!chosenFrom || chosenFrom.mode !== "pick" || !chosenFrom.managers) return loading;
    return (
      <>
        <CrmBlock className="border-t border-slate-100" title="District manager">
          <ManagerPicker label="District manager" managers={chosenFrom.managers} onPick={setManager} value={manager} />
        </CrmBlock>
        <CrmBlock className="border-t border-slate-100">{loading}</CrmBlock>
      </>
    );
  }
  const pickManager = (next: string) => {
    setChosenFrom(view);
    setManager(next);
  };

  async function askRemoval(customer: ManagerCustomerView) {
    setBusy(true);
    setError(null);
    try {
      await crmPost<ManagerCustomerView>("/api/phoenix-crm/manager-plans/customers/removal", { id: customer.id, reason: reason.trim(), test }, "customer");
      setRemoving(null);
      setReason("");
      list.reload();
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  }

  const active = view.customers.filter((customer) => customer.status !== "removed");

  return (
    <>
      {view.mode === "pick" && view.managers ? (
        <CrmBlock className="border-t border-slate-100" title="District manager">
          <ManagerPicker label="District manager" managers={view.managers} onPick={pickManager} value={view.manager?.hrId ?? null} />
        </CrmBlock>
      ) : null}
      {view.manager ? (
        <CrmBlock
          actions={
            view.canWrite && !adding ? (
              <CrmButton onClick={() => setAdding(true)} size="sm" variant="primary">
                Add a customer
              </CrmButton>
            ) : undefined
          }
          className="border-t border-slate-100"
          title={view.mode === "own" ? "Your own list" : `${view.manager.name}'s own list`}
        >
          <p className="mb-3 text-xs font-semibold leading-5 text-slate-500">
            {`Customers visited alone, kept apart from the reps' lists. Taking one off needs ${view.approverName ?? "the manager above"}'s approval.`}
          </p>
          {adding ? (
            <div className="mb-3">
              <ManagerCustomerForm
                areas={view.areas}
                onAdded={() => {
                  setAdding(false);
                  list.reload();
                }}
                onCancel={() => setAdding(false)}
                test={test}
              />
            </div>
          ) : null}
          {error ? (
            <CrmNote className="mb-3" tone="bad">
              {error}
            </CrmNote>
          ) : null}
          {active.length === 0 ? (
            <CrmEmpty message={view.canWrite ? "Add the customers you visit on your own." : "No customer is on this list yet."} title="No customers yet" />
          ) : (
            <div className="grid min-w-0 gap-2">
              {active.map((customer) => (
                <CrmCard
                  accent={customer.status === "removal_pending" ? "border-l-amber-500" : "border-l-orange-400"}
                  actions={
                    view.canWrite && customer.status === "active" && removing !== customer.id ? (
                      <CrmButton
                        onClick={() => {
                          setRemoving(customer.id);
                          setReason("");
                          setError(null);
                        }}
                        size="sm"
                        variant="danger"
                      >
                        Ask to remove
                      </CrmButton>
                    ) : undefined
                  }
                  key={customer.id}
                  meta={[`Grade ${customer.grade}`, customer.potentialGrade, customer.speciality, customer.areaName].filter(Boolean).join(" · ")}
                  status={<CrmPill tone={customer.status === "removal_pending" ? "warn" : "neutral"}>{customer.statusLabel}</CrmPill>}
                  title={
                    <span className="break-words" dir="auto">
                      {customer.name}
                    </span>
                  }
                >
                  {customer.address || customer.brickName || customer.phone || customer.comment ? (
                    <p className="break-words text-xs font-semibold leading-5 text-slate-600" dir="auto">
                      {[customer.phone, customer.address ?? customer.brickName, customer.comment].filter(Boolean).join(" · ")}
                    </p>
                  ) : null}
                  {customer.status === "removal_pending" && customer.removalReason ? (
                    <p className="mt-1 break-words text-xs font-semibold text-amber-800">{`Asked to remove: ${customer.removalReason}`}</p>
                  ) : null}
                  {removing === customer.id ? (
                    <div className="mt-3 grid min-w-0 gap-2">
                      <label className="grid min-w-0 gap-1.5" htmlFor={`${idPrefix}-${customer.id}-reason`}>
                        <span className="text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500">Why should this customer come off your list? *</span>
                        <textarea
                          className={crmTextareaClassName}
                          dir="auto"
                          id={`${idPrefix}-${customer.id}-reason`}
                          maxLength={MANAGER_PLAN_REASON_MAX}
                          onChange={(event) => setReason(event.target.value)}
                          value={reason}
                        />
                      </label>
                      <div className="flex flex-wrap gap-2">
                        <CrmButton busy={busy} disabled={reason.trim().length < 3} onClick={() => void askRemoval(customer)} size="sm" variant="primary">
                          Send the ask
                        </CrmButton>
                        <CrmButton disabled={busy} onClick={() => setRemoving(null)} size="sm" variant="ghost">
                          Cancel
                        </CrmButton>
                      </div>
                    </div>
                  ) : null}
                </CrmCard>
              ))}
            </div>
          )}
        </CrmBlock>
      ) : null}
    </>
  );
}
