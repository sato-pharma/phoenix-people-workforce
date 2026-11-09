"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, RefreshCcw, Send, Undo2, XCircle } from "lucide-react";

import {
  PortalEmptyState,
  PortalRecordCard,
  PortalRecordFields,
  PortalSection,
  PortalSkeleton,
  portalInputClassName,
} from "@/components/employee-portal/portal-primitives";
import { Button } from "@/components/ui/button";
import type { NativeVacationDayRequestRow, NativeVacationDayView } from "@/lib/crm/native-visits/types";
import { stableEnGbFormatter } from "@/lib/format/cairo-datetime";

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
    <Button onClick={() => void load()} size="sm" type="button" variant="outline">
      <RefreshCcw />
      Refresh
    </Button>
  );

  if (!view) {
    return loadError ? (
      <p className="border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{loadError}</p>
    ) : (
      <div aria-busy="true" className="grid min-w-0 gap-4">
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
    <div className="grid min-w-0 gap-4">
      {loadError ? <p className="border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{loadError}</p> : null}

      {view.canRequest ? (
        <PortalSection
          description="Use this only for a day HR already approved as your vacation. Visits on that day save once your manager and HR both approve."
          title="Ask to work on a vacation day"
        >
          <div className="grid min-w-0 gap-4 px-4 py-4 sm:px-5">
            <label className="grid gap-1">
              <span className="text-phx-sm font-black uppercase tracking-[0.12em] text-slate-500">Day</span>
              {/* One date needs no full-width bar on a desk; a phone keeps the whole width. */}
              <input
                className={`${portalInputClassName} sm:max-w-xs`}
                onChange={(event) => setVisitDate(event.target.value)}
                type="date"
                value={visitDate}
              />
            </label>
            <label className="grid gap-1">
              <span className="text-phx-sm font-black uppercase tracking-[0.12em] text-slate-500">Why you need to work</span>
              <textarea
                className={`${portalInputClassName} min-h-24`}
                maxLength={1000}
                onChange={(event) => setReason(event.target.value)}
                value={reason}
              />
            </label>
            {formError ? <p className="border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</p> : null}
            {formNote ? (
              <p className="border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{formNote}</p>
            ) : null}
            <div>
              <Button disabled={formBusy || !visitDate || !reason.trim()} onClick={() => void submitRequest()} type="button">
                <Send />
                Send to my manager and HR
              </Button>
            </div>
          </div>
        </PortalSection>
      ) : null}

      {view.canRequest ? (
        <PortalSection actions={refresh} description="Your requests from the last 30 days." title="Your requests">
          {view.mine.length === 0 ? (
            <PortalEmptyState message="You have not asked to work on a vacation day." title="No requests" />
          ) : (
            <div className="grid gap-px bg-slate-100">
              {view.mine.map((row) => (
                <PortalRecordCard
                  accent={accentFor(row.status)}
                  actions={
                    row.canCancel ? (
                      <div className="grid w-full gap-2">
                        <div>
                          <Button
                            disabled={busyId === row.id}
                            onClick={() => void act(row, { action: "cancel", requestId: row.id }, "Could not withdraw it.")}
                            type="button"
                            variant="outline"
                          >
                            <Undo2 />
                            Withdraw
                          </Button>
                        </div>
                        {rowError[row.id] ? <p className="text-sm text-red-700">{rowError[row.id]}</p> : null}
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
        <PortalSection
          actions={view.canRequest ? undefined : refresh}
          description="Approve only when the rep really has to work that day. A refusal must say why."
          title="Waiting for your answer"
        >
          {waiting.length === 0 ? (
            <PortalEmptyState message="No request is waiting for your answer." title="Nothing waiting" />
          ) : (
            <div className="grid gap-px bg-slate-100">
              {waiting.map((row) => (
                <PortalRecordCard
                  accent="amber"
                  actions={
                    <div className="grid w-full gap-2">
                      <input
                        aria-label="Note (needed to refuse)"
                        className={portalInputClassName}
                        maxLength={500}
                        onChange={(event) => setNotes((current) => ({ ...current, [row.id]: event.target.value }))}
                        placeholder="Note (needed to refuse)"
                        value={notes[row.id] ?? ""}
                      />
                      <div className="flex flex-wrap gap-2">
                        <Button
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
                          <CheckCircle2 />
                          {row.decideAs === "hr" ? "Approve as HR" : "Approve as manager"}
                        </Button>
                        <Button
                          disabled={busyId === row.id}
                          onClick={() =>
                            void act(
                              row,
                              { action: "decide", as: row.decideAs, decision: "rejected", note: notes[row.id] ?? "", requestId: row.id },
                              "Could not record your answer.",
                            )
                          }
                          type="button"
                          variant="destructive"
                        >
                          <XCircle />
                          Refuse
                        </Button>
                      </div>
                      {rowError[row.id] ? <p className="text-sm text-red-700">{rowError[row.id]}</p> : null}
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
        <PortalSection description="Requests you have answered, or that are no longer waiting for you." title="Answered">
          <div className="grid gap-px bg-slate-100">
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
