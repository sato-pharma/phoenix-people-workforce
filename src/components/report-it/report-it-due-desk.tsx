"use client";

import { useState } from "react";
import { CalendarClock } from "lucide-react";

import {
  phxButtonGhostClassName,
  phxButtonPrimaryClassName,
  phxFormErrorClassName,
  phxFormPanelClassName,
} from "@/components/ui/form-tokens";
import { cairoDate, cairoDateTime12h } from "@/lib/format/cairo-datetime";
import type { OpenReportItem } from "@/lib/report-it/service";
import { REPORT_IT_STATUS_LABELS, type ReportItStatus } from "@/lib/report-it/types";

/** The button for each open status: what it says, and the status it moves the report to. */
const NEXT_STEP: Partial<Record<ReportItStatus, { label: string; to: ReportItStatus }>> = {
  received: { label: "Start assessment", to: "under_assessment" },
  under_assessment: { label: "Close report", to: "closed" },
};

function StatusChip({ status }: { status: ReportItStatus }) {
  const tone = status === "under_assessment"
    ? "border-orange-300 bg-orange-50 text-orange-700"
    : "border-slate-300 bg-slate-50 text-slate-700";
  return (
    <span className={`inline-block border px-2 py-0.5 text-phx-xs font-bold ${tone}`}>
      {REPORT_IT_STATUS_LABELS[status]}
    </span>
  );
}

function DueText({ item }: { item: OpenReportItem }) {
  return (
    <span className={item.overdue ? "font-bold text-rose-700" : "text-slate-700"}>
      {cairoDate(item.dueAt)}
      {item.overdue ? <span className="ml-1 border border-rose-300 bg-rose-50 px-1.5 py-0.5 text-phx-xs font-bold text-rose-700">Overdue</span> : null}
    </span>
  );
}

function StatusDetail({ item }: { item: OpenReportItem }) {
  return (
    <span className="block">
      <StatusChip status={item.status} />
      {item.status === "under_assessment" && (item.assessorName || item.assessmentStartedAt) ? (
        <span className="mt-1 block text-xs text-slate-500">
          {item.assessorName ? `by ${item.assessorName}` : ""}
          {item.assessorName && item.assessmentStartedAt ? " · " : ""}
          {item.assessmentStartedAt ? `since ${cairoDate(item.assessmentStartedAt)}` : ""}
        </span>
      ) : null}
    </span>
  );
}

/**
 * The due-date view on the Report It desk (audit REC-033): every open report — received or under
 * assessment — with its status and due date, oldest due first, an overdue one marked, and the button
 * for its next step. A serious report is due 15 calendar days after it was received, any other 90.
 * Desktop reads a table, a phone reads cards; nothing scrolls sideways.
 */
export function ReportItDueDesk({ initial }: { initial: OpenReportItem[] }) {
  const [items, setItems] = useState<OpenReportItem[]>(initial);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const overdueCount = items.filter((item) => item.overdue).length;

  async function advance(item: OpenReportItem) {
    const step = NEXT_STEP[item.status];
    if (!step) return;
    setBusyId(item.id);
    setError(null);
    try {
      const response = await fetch(`/api/report-it/${encodeURIComponent(item.id)}/status`, {
        body: JSON.stringify({ status: step.to }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string; status?: ReportItStatus };
      if (!response.ok) {
        setError(payload.error ?? "The status was not changed.");
        return;
      }
      const now = new Date().toISOString();
      setItems((current) =>
        step.to === "closed"
          ? current.filter((entry) => entry.id !== item.id)
          : current.map((entry) => (entry.id === item.id ? { ...entry, assessmentStartedAt: now, status: step.to } : entry)),
      );
    } catch {
      setError("The status was not changed. Check the connection and try again.");
    } finally {
      setBusyId(null);
    }
  }

  function stepButton(item: OpenReportItem, dense = false) {
    const step = NEXT_STEP[item.status];
    if (!step) return null;
    const className = step.to === "closed" ? phxButtonGhostClassName : phxButtonPrimaryClassName;
    return (
      <button
        className={`${className}${dense ? " w-full justify-center" : ""}`}
        disabled={busyId !== null}
        onClick={() => void advance(item)}
        type="button"
      >
        {busyId === item.id ? "Saving" : step.label}
      </button>
    );
  }

  return (
    <section className={`mb-6 min-w-0 ${phxFormPanelClassName}`} id="open-reports">
      <header className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-4 py-3">
        <CalendarClock aria-hidden="true" className="h-4 w-4 shrink-0 text-orange-600" />
        <h2 className="text-sm font-black text-slate-900">Open reports — oldest due first</h2>
        <span className="text-xs font-semibold text-slate-500">
          {items.length} open{overdueCount > 0 ? ` · ${overdueCount} overdue` : ""}
        </span>
      </header>
      <p className="px-4 pt-3 text-xs leading-relaxed text-slate-600">
        A serious report is due 15 calendar days after it was received, any other report 90. Start the assessment,
        then close the report when it is done. Every change is logged.
      </p>
      {error ? (
        <p className={`mx-4 mt-3 ${phxFormErrorClassName}`} role="alert">
          {error}
        </p>
      ) : null}

      <div className="p-4">
        {items.length === 0 ? (
          <p className="border border-slate-200 px-3 py-6 text-center text-sm font-semibold text-slate-500">
            No open reports. Every report has been closed.
          </p>
        ) : (
          <>
            <table className="hidden w-full table-fixed border-collapse border border-slate-200 text-sm md:table">
              <colgroup>
                <col className="w-[22%]" />
                <col className="w-[22%]" />
                <col className="w-[28%]" />
                <col className="w-[28%]" />
              </colgroup>
              <thead>
                <tr className="bg-slate-900 text-left text-phx-xs font-black uppercase tracking-wide text-white">
                  <th className="px-3 py-2.5">Report · Received</th>
                  <th className="px-3 py-2.5">Due</th>
                  <th className="px-3 py-2.5">Status</th>
                  <th className="px-3 py-2.5">Next step</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id} className={`border-t border-orange-100 ${item.overdue ? "bg-rose-50/40" : "bg-white"}`}>
                    <td className="break-words px-3 py-2 align-top">
                      <span className="block font-mono text-xs font-bold text-orange-600">{item.reportNumber}</span>
                      <span className="block text-xs text-slate-500">{cairoDateTime12h(item.submittedAt)}</span>
                      {item.isSerious ? <span className="block text-xs font-bold text-rose-700">Serious</span> : null}
                    </td>
                    <td className="break-words px-3 py-2 align-top text-xs">
                      <DueText item={item} />
                    </td>
                    <td className="break-words px-3 py-2 align-top">
                      <StatusDetail item={item} />
                    </td>
                    <td className="px-3 py-2 align-top">
                      {stepButton(item)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <ul className="divide-y divide-orange-100 border border-slate-200 md:hidden">
              {items.map((item) => (
                <li key={item.id} className={`min-w-0 break-words px-3 py-3 text-xs ${item.overdue ? "bg-rose-50/40" : "bg-white"}`}>
                  <span className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-mono font-bold text-orange-600">{item.reportNumber}</span>
                    <StatusChip status={item.status} />
                  </span>
                  <span className="mt-1 block text-slate-500">
                    Received {cairoDateTime12h(item.submittedAt)}
                    {item.isSerious ? <span className="ml-1 font-bold text-rose-700">· Serious</span> : null}
                  </span>
                  <span className="mt-1 block">
                    Due <DueText item={item} />
                  </span>
                  {item.status === "under_assessment" && item.assessorName ? (
                    <span className="mt-1 block text-slate-500">Assessed by {item.assessorName}</span>
                  ) : null}
                  <span className="mt-2 block">
                    {stepButton(item, true)}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </section>
  );
}
