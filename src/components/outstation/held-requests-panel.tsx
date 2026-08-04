"use client";

import { AlertTriangle, Loader2, RefreshCw, Send } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { formatDateValue, formatDateTimeValue } from "@/lib/i18n/format";

type HeldRequest = {
  blocker: string;
  destination: string;
  employeeHrId: string;
  employeeName: string;
  employeeRole: string;
  id: number;
  lastAttemptAt: string | null;
  lastAttemptError: string | null;
  message: string;
  tripEndDate: string;
  tripStartDate: string;
  workloadCaptureAttempts: number;
};

const BLOCKER_LABEL: Record<string, string> = {
  arrival_photo: "Waiting for the arrival photo",
  departure_photo: "Waiting for the departure photo",
  inconsistent: "Data fault — needs a system administrator",
  workload: "Waiting for the CRM workload",
};

/**
 * Every outstation request the evidence gate is holding out of payroll, and the two ways out:
 * re-run the CRM workload grab, or enter the workload by hand.
 *
 * This panel is what stops a held request being invisible. Without it the employee sees only
 * that his money has not arrived and nobody is told the grab failed — which is why the gate is
 * not safe to switch on in production until this exists.
 *
 * Self-fetching (like TripAttachments) so it can be dropped into the admin workspace without
 * threading props through the server page.
 */
export function HeldRequestsPanel() {
  const [requests, setRequests] = useState<HeldRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [manualFor, setManualFor] = useState<number | null>(null);
  const [manual, setManual] = useState({ am: "", pm: "", reason: "" });

  const load = useCallback(async () => {
    // Yield a microtask before touching state. Same idiom as trip-attachments.tsx: without it
    // the first setState is reachable synchronously from the effect body below, which the
    // react-hooks rule (correctly) rejects as a cascading render.
    await Promise.resolve();
    try {
      const response = await fetch("/api/admin/outstation/held-requests", {
        headers: { accept: "application/json" },
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message || `Request failed (${response.status})`);
      setRequests(payload.requests ?? []);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load held requests.");
      setRequests([]);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    // Declared INSIDE the effect, exactly like trip-attachments.tsx. The react-hooks rule does
    // not trace through a useCallback, so calling `load()` directly from the effect body reads
    // to it as a synchronous setState however many awaits the callback actually contains.
    async function run() {
      await Promise.resolve();
      if (cancelled) return;
      await load();
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [load]);

  const act = useCallback(
    async (id: number, body: Record<string, unknown>) => {
      setBusyId(id);
      setNotice(null);
      try {
        const response = await fetch(`/api/admin/outstation/${id}/workload`, {
          body: JSON.stringify(body),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload?.message || `Request failed (${response.status})`);
        setNotice(payload.message ?? "Done.");
        setManualFor(null);
        setManual({ am: "", pm: "", reason: "" });
        // Re-read rather than mutate locally: a released request must leave this list, and the
        // server is the only thing that knows whether it actually did.
        await load();
      } catch (actionError) {
        setNotice(actionError instanceof Error ? actionError.message : "That did not work.");
      } finally {
        setBusyId(null);
      }
    },
    [load],
  );

  if (requests === null) {
    return (
      <p className="flex items-center gap-2 text-xs text-slate-500">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking for held requests…
      </p>
    );
  }
  if (error) {
    return <p className="text-xs text-rose-600">Couldn&apos;t load held requests: {error}</p>;
  }
  if (requests.length === 0) return null;

  return (
    <section className="overflow-hidden rounded-lg border border-rose-200 bg-rose-50/60 p-4 shadow-[0_1px_3px_rgba(15,23,42,0.06)] sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-rose-600" />
          <span className="rounded-md bg-rose-100 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-rose-700">
            Held out of payroll
          </span>
        </div>
        <button
          className="inline-flex items-center gap-1.5 rounded-xl border border-rose-200 bg-white px-3 py-1.5 text-xs font-black text-rose-700 hover:bg-rose-50"
          onClick={() => void load()}
          type="button"
        >
          <RefreshCw className="h-3.5 w-3.5" /> Refresh list
        </button>
      </div>
      <p className="mt-2 max-w-3xl text-[13px] leading-relaxed text-rose-900">
        {requests.length} accepted request{requests.length === 1 ? " is" : "s are"} waiting on evidence
        and {requests.length === 1 ? "has" : "have"} not been added to payroll. The employee is not paid
        until each one clears.
      </p>

      {notice ? (
        <p className="mt-3 rounded-md border border-slate-200 bg-white px-3 py-2 text-[13px] text-slate-700">
          {notice}
        </p>
      ) : null}

      <div className="mt-4 space-y-3">
        {requests.map((request) => (
          <div className="rounded-md border border-rose-200 bg-white p-3 sm:p-4" key={request.id}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-bold text-slate-900">
                  {request.employeeName} ({request.employeeHrId}) · {request.employeeRole}
                </p>
                <p className="mt-0.5 text-xs font-semibold text-slate-500">
                  {request.destination} · {formatDateValue(request.tripStartDate)} –{" "}
                  {formatDateValue(request.tripEndDate)}
                </p>
              </div>
              <span className="inline-flex shrink-0 items-center rounded-full bg-rose-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-rose-700 ring-1 ring-rose-200">
                {BLOCKER_LABEL[request.blocker] ?? request.blocker}
              </span>
            </div>

            <p className="mt-2 text-[13px] leading-relaxed text-slate-600">{request.message}</p>

            {/* The grab's own failure text. Shown verbatim so the admin decides from what actually
                happened, not from a generic "it failed". */}
            {request.lastAttemptError ? (
              <p className="mt-2 rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-600">
                Last CRM attempt{" "}
                {request.lastAttemptAt ? `at ${formatDateTimeValue(request.lastAttemptAt)}` : ""} (
                {request.workloadCaptureAttempts} tried): {request.lastAttemptError}
              </p>
            ) : null}

            {/* Only a workload block is repairable here. A missing PHOTO cannot be fixed from an
                admin desk — only the employee can take it — so no button is offered that would
                imply otherwise. */}
            {request.blocker === "workload" ? (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-slate-900 px-3 text-xs font-black text-white hover:bg-slate-800 disabled:opacity-60"
                  disabled={busyId === request.id}
                  onClick={() => void act(request.id, { action: "retry" })}
                  type="button"
                >
                  {busyId === request.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3.5 w-3.5" />
                  )}
                  Retry the CRM grab
                </button>
                <button
                  className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-slate-300 bg-white px-3 text-xs font-black text-slate-700 hover:bg-slate-50"
                  onClick={() => setManualFor(manualFor === request.id ? null : request.id)}
                  type="button"
                >
                  Enter it by hand
                </button>
              </div>
            ) : null}

            {manualFor === request.id ? (
              <div className="mt-3 rounded-md border border-slate-200 bg-slate-50 p-3">
                <p className="text-xs font-bold text-slate-700">
                  This is recorded as a manual override, never as CRM evidence.
                </p>
                <div className="mt-2 grid gap-2 sm:grid-cols-3">
                  <input
                    className="min-h-10 rounded-lg border border-slate-300 px-3 text-sm"
                    inputMode="numeric"
                    onChange={(event) => setManual((prev) => ({ ...prev, am: event.target.value }))}
                    placeholder="AM visits"
                    value={manual.am}
                  />
                  <input
                    className="min-h-10 rounded-lg border border-slate-300 px-3 text-sm"
                    inputMode="numeric"
                    onChange={(event) => setManual((prev) => ({ ...prev, pm: event.target.value }))}
                    placeholder="PM visits"
                    value={manual.pm}
                  />
                  <input
                    className="min-h-10 rounded-lg border border-slate-300 px-3 text-sm sm:col-span-1"
                    onChange={(event) => setManual((prev) => ({ ...prev, reason: event.target.value }))}
                    placeholder="Reason (required)"
                    value={manual.reason}
                  />
                </div>
                <button
                  className="mt-2 inline-flex min-h-10 items-center gap-2 rounded-xl bg-orange-500 px-3 text-xs font-black text-white hover:bg-orange-600 disabled:opacity-60"
                  disabled={busyId === request.id || !manual.reason.trim()}
                  onClick={() =>
                    void act(request.id, {
                      action: "manual",
                      amWorkload: Number(manual.am || 0),
                      pmWorkload: Number(manual.pm || 0),
                      reason: manual.reason,
                    })
                  }
                  type="button"
                >
                  <Send className="h-3.5 w-3.5" /> Save and release
                </button>
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}
