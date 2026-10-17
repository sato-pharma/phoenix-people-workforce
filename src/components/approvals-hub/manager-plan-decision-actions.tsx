"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarX2, CheckCircle2, CornerUpLeft, XCircle } from "lucide-react";

import { adminPanelClassName, adminPanelHeaderClassName } from "@/components/admin/admin-design-tokens";
import {
  phxButtonApproveClassName,
  phxButtonGhostClassName,
  phxLabelClassName,
  phxRequiredMarkClassName,
  phxSelectClassName,
  phxTextareaClassName,
} from "@/components/ui/form-tokens";

/**
 * The decision on a district manager's Phoenix CRM week, his ask to edit it, or his ask to take a customer
 * off his own list (owner, 2026-10-16: decided in the Approvals Hub — Approve, Return the week, Return one
 * day). The server decides who may press each button; this panel is rendered only for the viewer the page
 * already found to be the step's holder or the Administrator.
 *
 * 🔴 After a regional manager approves, the national sales manager above him approves too — the week, the
 * ask to edit it and the removal alike (owner, 2026-10-17). `thenName` names him, so the regional manager
 * reads that his approval passes it on, and an ask or a removal sends back the step it showed.
 */
type Target =
  | { kind: "plan"; planId: string; version: number; returnableDays: Array<{ date: string; dateText: string }>; thenName: string | null }
  | { kind: "edit"; requestId: string; version: number; stage: "first" | "second" | null; thenName: string | null }
  | { kind: "removal"; customerId: string; requestedAt: string | null; stage: "first" | "second" | null; thenName: string | null };

type Choice = "approve" | "return_week" | "return_day" | "reopen" | "refuse_edit" | "approve_removal" | "refuse_removal";

const NOTE_REQUIRED: Record<Choice, boolean> = {
  approve: false,
  return_week: true,
  return_day: true,
  reopen: false,
  refuse_edit: true,
  approve_removal: false,
  refuse_removal: true,
};

const CONFIRM_LABEL: Record<Choice, string> = {
  approve: "Approve the week",
  return_week: "Return the week",
  return_day: "Return this day",
  reopen: "Reopen the week",
  refuse_edit: "Keep it as sent",
  approve_removal: "Remove from Manager's own list",
  refuse_removal: "Keep it on Manager's own list",
};

export function ManagerPlanDecisionActions({ target, byAdministrator, backHref }: { target: Target; byAdministrator: boolean; backHref: string }) {
  const router = useRouter();
  const [choice, setChoice] = useState<Choice | null>(null);
  const [note, setNote] = useState("");
  const [day, setDay] = useState(target.kind === "plan" ? (target.returnableDays[0]?.date ?? "") : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function open(next: Choice) {
    setChoice(next);
    setNote("");
    setError(null);
  }

  async function send() {
    if (!choice) return;
    if (NOTE_REQUIRED[choice] && !note.trim()) {
      setError("Write a note — the district manager reads it.");
      return;
    }
    let endpoint = "";
    let body: Record<string, unknown> = {};
    const text = note.trim() || null;
    if (target.kind === "plan") {
      endpoint = "/api/phoenix-crm/manager-plans/decide";
      body = {
        planId: target.planId,
        version: target.version,
        action: choice === "approve" ? "approve" : "return",
        note: text,
        day: choice === "return_day" ? day : null,
      };
    } else if (target.kind === "edit") {
      endpoint = "/api/phoenix-crm/manager-plans/edit-requests/decide";
      body = { requestId: target.requestId, version: target.version, stage: target.stage ?? undefined, decision: choice === "reopen" ? "reopen" : "refuse", note: text };
    } else {
      endpoint = "/api/phoenix-crm/manager-plans/customers/removal/decide";
      body = {
        id: target.customerId,
        requestedAt: target.requestedAt,
        stage: target.stage ?? undefined,
        decision: choice === "approve_removal" ? "approve" : "refuse",
        note: text,
      };
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = (await response.json().catch(() => ({}))) as { success?: boolean; message?: string };
      if (!response.ok || !data.success) {
        setError(data.message || "This could not be saved — it may already have moved on.");
        setBusy(false);
        router.refresh();
        return;
      }
      router.push(backHref);
      router.refresh();
    } catch {
      setError("The network did not answer. Try again.");
      setBusy(false);
    }
  }

  const headerBar = `${adminPanelHeaderClassName} px-4 py-2.5`;
  const headerText = "text-phx-xs font-black uppercase tracking-[0.14em] text-white";
  const outline = "inline-flex items-center gap-1.5 border px-4 py-2 text-sm font-bold";
  // The regional manager's approval passes it on: name who decides after him, and what waits until then.
  const passesOn = target.thenName
    ? target.kind === "plan"
      ? `After you, ${target.thenName} approves the week too.`
      : target.kind === "edit"
        ? `After you, ${target.thenName} approves too. The week reopens only then.`
        : `After you, ${target.thenName} approves too. The customer stays on the list until then.`
    : null;
  const confirmLabel = (value: Choice): string =>
    target.thenName && value === "reopen" ? "Approve the reopening" : target.thenName && value === "approve_removal" ? "Approve the removal" : CONFIRM_LABEL[value];
  const passesOnNote = passesOn ? <p className="border-l-4 border-orange-400 bg-orange-50 px-3 py-2 text-xs font-semibold text-slate-700">{passesOn}</p> : null;

  if (choice) {
    return (
      <section className={adminPanelClassName}>
        <header className={headerBar}>
          <h3 className={headerText}>{confirmLabel(choice)}</h3>
        </header>
        <div className="space-y-3 px-4 py-4">
          {byAdministrator ? (
            <p className="border-l-4 border-slate-400 bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-700">
              You are deciding in place of the approver. It is recorded and shown as decided by the Administrator.
            </p>
          ) : null}
          {choice === "approve" || choice === "reopen" || choice === "approve_removal" ? passesOnNote : null}
          {choice === "return_day" && target.kind === "plan" ? (
            <label className="block">
              <span className={phxLabelClassName}>
                Day to return<span className={phxRequiredMarkClassName}>*</span>
              </span>
              <select value={day} onChange={(event) => setDay(event.target.value)} className={phxSelectClassName}>
                {target.returnableDays.map((entry) => (
                  <option key={entry.date} value={entry.date}>
                    {entry.dateText}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="block">
            <span className={phxLabelClassName}>
              Note to the district manager{NOTE_REQUIRED[choice] ? <span className={phxRequiredMarkClassName}>*</span> : " (optional)"}
            </span>
            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              rows={3}
              maxLength={500}
              autoFocus
              placeholder={NOTE_REQUIRED[choice] ? "What should change, or why" : "Anything the district manager should know"}
              className={phxTextareaClassName}
            />
          </label>
          {error ? <p className="text-sm font-semibold text-rose-600">{error}</p> : null}
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={send} disabled={busy || (choice === "return_day" && !day)} className={phxButtonApproveClassName}>
              {busy ? "Saving…" : confirmLabel(choice)}
            </button>
            <button type="button" onClick={() => setChoice(null)} disabled={busy} className={phxButtonGhostClassName}>
              Cancel
            </button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className={adminPanelClassName}>
      <header className={headerBar}>
        <h3 className={headerText}>Your decision</h3>
      </header>
      {passesOnNote ? <div className="px-4 pt-4">{passesOnNote}</div> : null}
      <div className="flex flex-wrap gap-2 px-4 py-4">
        {target.kind === "plan" ? (
          <>
            <button type="button" onClick={() => open("approve")} className={phxButtonApproveClassName}>
              <CheckCircle2 className="h-4 w-4" /> Approve
            </button>
            <button type="button" onClick={() => open("return_week")} className={`${outline} border-amber-500 text-amber-700 hover:bg-amber-50`}>
              <CornerUpLeft className="h-4 w-4" /> Return the week
            </button>
            {target.returnableDays.length > 0 ? (
              <button type="button" onClick={() => open("return_day")} className={`${outline} border-amber-500 text-amber-700 hover:bg-amber-50`}>
                <CalendarX2 className="h-4 w-4" /> Return one day
              </button>
            ) : null}
          </>
        ) : null}
        {target.kind === "edit" ? (
          <>
            <button type="button" onClick={() => open("reopen")} className={phxButtonApproveClassName}>
              <CheckCircle2 className="h-4 w-4" /> {target.thenName ? "Approve the reopening" : "Reopen for editing"}
            </button>
            <button type="button" onClick={() => open("refuse_edit")} className={`${outline} border-rose-500 text-rose-700 hover:bg-rose-50`}>
              <XCircle className="h-4 w-4" /> Keep it as sent
            </button>
          </>
        ) : null}
        {target.kind === "removal" ? (
          <>
            <button type="button" onClick={() => open("approve_removal")} className={phxButtonApproveClassName}>
              <CheckCircle2 className="h-4 w-4" /> Approve the removal
            </button>
            <button type="button" onClick={() => open("refuse_removal")} className={`${outline} border-rose-500 text-rose-700 hover:bg-rose-50`}>
              <XCircle className="h-4 w-4" /> Keep it on Manager&apos;s own list
            </button>
          </>
        ) : null}
      </div>
    </section>
  );
}
