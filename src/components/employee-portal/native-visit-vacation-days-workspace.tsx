"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { CheckCircle2, RefreshCcw, Send, Undo2, XCircle } from "lucide-react";

import { adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";
import { approvalActionClassName } from "@/components/approvals-hub/approval-action-kit";
import { LANDING_FOCUS, LandingRailLine, landingActionClassName } from "@/components/employee-portal/landing-kit";
import {
  PortalEmptyState,
  PortalRecordCard,
  PortalRecordFields,
  PortalSection,
  PortalSkeleton,
} from "@/components/employee-portal/portal-primitives";
import { FormField } from "@/components/ui/form-kit";
import { phxButtonAccentClassName, phxFieldClassName, phxTextareaClassName } from "@/components/ui/form-tokens";
import type { NativeVacationDayRequestRow, NativeVacationDayView } from "@/lib/crm/native-visits/types";
import { stableEnGbFormatter } from "@/lib/format/cairo-datetime";
import { cn } from "@/lib/utils";

/**
 * Working on an approved vacation day (CRM phase 6, rule 9). A rep asks; his manager and HR each
 * answer with their own click, and the day opens for visits only when both approved. Nothing here
 * answers for anyone, and rows a viewer may not answer arrive without the buttons — the server decides.
 * Shared by the employee portal (reps and managers) and the admin shell (HR).
 */

const ENDPOINT = "/api/crm/native-visits/vacation-day-requests";

const DAY_FORMAT = stableEnGbFormatter({
  day: "numeric",
  month: "long",
  timeZone: "Africa/Cairo",
  weekday: "long",
  year: "numeric",
});
const TIME_FORMAT = stableEnGbFormatter({
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  month: "short",
  timeZone: "Africa/Cairo",
});

function dayLabel(isoDay: string) {
  return DAY_FORMAT.format(new Date(`${isoDay}T12:00:00Z`));
}

function decisionLabel(decision: NativeVacationDayRequestRow["managerDecision"]) {
  if (decision === "approved") return "Approved";
  if (decision === "rejected") return "Refused";
  return "Waiting";
}

function statusLabel(status: NativeVacationDayRequestRow["status"]) {
  if (status === "approved") return "Approved: visits open";
  if (status === "rejected") return "Refused";
  if (status === "cancelled") return "Withdrawn";
  return "Waiting";
}

function accentFor(status: NativeVacationDayRequestRow["status"]) {
  if (status === "approved") return "emerald" as const;
  if (status === "rejected") return "rose" as const;
  if (status === "cancelled") return "slate" as const;
  return "amber" as const;
}

function answeredAt(value: string | null) {
  return value ? ` · ${TIME_FORMAT.format(new Date(value))}` : "";
}

/** The extra classes every decision button carries: the keyboard ring, and no motion when asked. */
const DECISION_EXTRA = `flex-1 sm:flex-none ${LANDING_FOCUS} motion-reduce:transition-none`;

/** A page-level message: a white sheet with the tone's rail at the left. */
function RailSheet({ children, rail, role }: { children: string; rail: string; role: "alert" | "status" }) {
  return (
    <div className={`border border-slate-200 bg-white ${adminSoftDepthClassName}`} role={role}>
      <LandingRailLine rail={rail}>{children}</LandingRailLine>
    </div>
  );
}

/** A message inside a card or form: coloured small text on a thin rail. */
function RailNote({ children, tone }: { children: string; tone: "rose" | "emerald" }) {
  return (
    <p
      className={cn(
        "border-l-2 pl-3 text-sm font-semibold",
        tone === "rose" ? "border-rose-500 text-rose-700" : "border-emerald-500 text-emerald-800",
      )}
      role={tone === "rose" ? "alert" : "status"}
    >
      {children}
    </p>
  );
}

function requestFields(row: NativeVacationDayRequestRow, withRep: boolean) {
  return [
    ...(withRep ? [{ label: "Rep", value: row.repName }] : []),
    { label: "Reason", value: row.reason },
    { label: "Manager", value: `${row.managerName} · ${decisionLabel(row.managerDecision)}${answeredAt(row.managerDecidedAt)}` },
    { label: "Manager note", value: row.managerNote ?? "None" },
    { label: "HR", value: `${row.hrDeciderName ?? "HR"} · ${decisionLabel(row.hrDecision)}${answeredAt(row.hrDecidedAt)}` },
    { label: "HR note", value: row.hrNote ?? "None" },
  ];
}

export function NativeVisitVacationDaysWorkspace() {
  const [view, setView] = useState<NativeVacationDayView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [visitDate, setVisitDate] = useState("");
  const [reason, setReason] = useState("");
  const [formBusy, setFormBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [formNote, setFormNote] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const fieldId = useId();

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const response = await fetch(ENDPOINT, { cache: "no-store" });
      const body = (await response.json().catch(() => null)) as { view?: NativeVacationDayView; message?: string } | null;
      if (!response.ok || !body?.view) throw new Error(body?.message ?? "Could not load vacation-day requests.");
      setView(body.view);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Could not load vacation-day requests.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function post(payload: Record<string, unknown>, fallback: string) {
    const response = await fetch(ENDPOINT, {
      body: JSON.stringify(payload),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    if (!response.ok) throw new Error(body?.message ?? fallback);
  }

  async function submitRequest() {
    setFormBusy(true);
    setFormError(null);
    setFormNote(null);
    try {
      await post({ action: "request", reason, visitDate }, "Could not send your request.");
      setReason("");
      setVisitDate("");
      setFormNote("Sent to your manager and HR. The day opens for visits once both approve.");
      await load();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Could not send your request.");
    } finally {
      setFormBusy(false);
    }
  }

  async function act(row: NativeVacationDayRequestRow, payload: Record<string, unknown>, fallback: string) {
    setBusyId(row.id);
    setRowError((current) => ({ ...current, [row.id]: "" }));
    try {
      await post(payload, fallback);
      await load();
    } catch (error) {
      setRowError((current) => ({ ...current, [row.id]: error instanceof Error ? error.message : fallback }));
    } finally {
      setBusyId(null);
    }
  }

  const refresh = (
    <button className={landingActionClassName("outline")} onClick={() => void load()} type="button">
      <RefreshCcw aria-hidden="true" className="h-3.5 w-3.5" />
      Refresh
    </button>
  );

  if (!view) {
    return loadError ? (
      <RailSheet rail="bg-rose-500" role="alert">
        {loadError}
      </RailSheet>
    ) : (
      <div aria-busy="true" className="grid min-w-0 gap-3">
        <span className="sr-only">Loading vacation-day requests</span>
        <PortalSkeleton className="h-28 w-full" />
        <PortalSkeleton className="h-40 w-full" />
      </div>
    );
  }

  if (!view.ruleInForce) {
    return (
      <PortalSection>
        <PortalEmptyState
          message="Once Phoenix becomes the visit record, a visit on a day HR approved as vacation needs a request that the rep's manager and HR both approve. Until then nothing here is needed."
          title="Not in force yet"
        />
      </PortalSection>
    );
  }

  const waiting = view.toDecide.filter((row) => row.decideAs);
  const answered = view.toDecide.filter((row) => !row.decideAs);

  return (
    <div className="grid min-w-0 gap-3">
      {loadError ? (
        <RailSheet rail="bg-rose-500" role="alert">
          {loadError}
        </RailSheet>
      ) : null}

      {view.canRequest ? (
        <PortalSection title="Ask to work on a vacation day">
          <div className="grid min-w-0 gap-4 px-3 py-4 sm:px-4">
            {/* One date needs no full-width bar on a desk; a phone keeps the whole width. */}
            <FormField htmlFor={`${fieldId}-day`} label="Day">
              <input
                className={cn(phxFieldClassName, "sm:max-w-xs")}
                id={`${fieldId}-day`}
                onChange={(event) => setVisitDate(event.target.value)}
                type="date"
                value={visitDate}
              />
            </FormField>
            <FormField htmlFor={`${fieldId}-reason`} label="Why you need to work">
              <textarea
                className={cn(phxTextareaClassName, "min-h-24")}
                id={`${fieldId}-reason`}
                maxLength={1000}
                onChange={(event) => setReason(event.target.value)}
                value={reason}
              />
            </FormField>
            {formError ? <RailNote tone="rose">{formError}</RailNote> : null}
            {formNote ? <RailNote tone="emerald">{formNote}</RailNote> : null}
            <div className="border-t border-slate-200 pt-3">
              <button
                className={cn(phxButtonAccentClassName, LANDING_FOCUS, "motion-reduce:transition-none")}
                disabled={formBusy || !visitDate || !reason.trim()}
                onClick={() => void submitRequest()}
                type="button"
              >
                <Send aria-hidden="true" className="h-4 w-4" />
                Send to my manager and HR
              </button>
            </div>
          </div>
        </PortalSection>
      ) : null}

      {view.canRequest ? (
        <PortalSection actions={refresh} title="Your requests">
          {view.mine.length === 0 ? (
            <PortalEmptyState message="You have not asked to work on a vacation day." title="No requests" />
          ) : (
            <div className="grid gap-px bg-slate-200">
              {view.mine.map((row) => (
                <PortalRecordCard
                  accent={accentFor(row.status)}
                  actions={
                    row.canCancel ? (
                      <div className="grid w-full gap-2">
                        <div>
                          <button
                            className={landingActionClassName("outline")}
                            disabled={busyId === row.id}
                            onClick={() => void act(row, { action: "cancel", requestId: row.id }, "Could not withdraw it.")}
                            type="button"
                          >
                            <Undo2 aria-hidden="true" className="h-3.5 w-3.5" />
                            Withdraw
                          </button>
                        </div>
                        {rowError[row.id] ? <RailNote tone="rose">{rowError[row.id]}</RailNote> : null}
                      </div>
                    ) : undefined
                  }
                  key={row.id}
                  meta={statusLabel(row.status)}
                  title={dayLabel(row.visitDate)}
                >
                  <PortalRecordFields fields={requestFields(row, false)} />
                </PortalRecordCard>
              ))}
            </div>
          )}
        </PortalSection>
      ) : null}

      {view.canDecideAsManager || view.canDecideAsHr ? (
        <PortalSection actions={view.canRequest ? undefined : refresh} title="Waiting for your answer">
          {waiting.length === 0 ? (
            <PortalEmptyState message="No request is waiting for your answer." title="Nothing waiting" />
          ) : (
            <div className="grid gap-px bg-slate-200">
              {waiting.map((row) => (
                <PortalRecordCard
                  accent="amber"
                  actions={
                    <div className="grid w-full gap-2">
                      <input
                        aria-label="Note (needed to refuse)"
                        className={phxFieldClassName}
                        maxLength={500}
                        onChange={(event) => setNotes((current) => ({ ...current, [row.id]: event.target.value }))}
                        placeholder="Note (needed to refuse)"
                        value={notes[row.id] ?? ""}
                      />
                      <div className="flex flex-wrap gap-2">
                        <button
                          className={approvalActionClassName("approve", "regular", DECISION_EXTRA)}
                          disabled={busyId === row.id}
                          onClick={() =>
                            void act(
                              row,
                              { action: "decide", as: row.decideAs, decision: "approved", note: notes[row.id] ?? "", requestId: row.id },
                              "Could not record your answer.",
                            )
                          }
                          type="button"
                        >
                          <CheckCircle2 aria-hidden="true" className="h-4 w-4" />
                          {row.decideAs === "hr" ? "Approve as HR" : "Approve as manager"}
                        </button>
                        <button
                          className={approvalActionClassName("reject", "regular", DECISION_EXTRA)}
                          disabled={busyId === row.id}
                          onClick={() =>
                            void act(
                              row,
                              { action: "decide", as: row.decideAs, decision: "rejected", note: notes[row.id] ?? "", requestId: row.id },
                              "Could not record your answer.",
                            )
                          }
                          type="button"
                        >
                          <XCircle aria-hidden="true" className="h-4 w-4" />
                          Refuse
                        </button>
                      </div>
                      {rowError[row.id] ? <RailNote tone="rose">{rowError[row.id]}</RailNote> : null}
                    </div>
                  }
                  key={row.id}
                  meta={dayLabel(row.visitDate)}
                  title={row.repName}
                >
                  <PortalRecordFields fields={requestFields(row, false)} />
                </PortalRecordCard>
              ))}
            </div>
          )}
        </PortalSection>
      ) : null}

      {answered.length > 0 ? (
        <PortalSection title="Answered">
          <div className="grid gap-px bg-slate-200">
            {answered.map((row) => (
              <PortalRecordCard
                accent={accentFor(row.status)}
                key={row.id}
                meta={`${dayLabel(row.visitDate)} · ${statusLabel(row.status)}`}
                title={row.repName}
              >
                <PortalRecordFields fields={requestFields(row, false)} />
              </PortalRecordCard>
            ))}
          </div>
        </PortalSection>
      ) : null}
    </div>
  );
}
