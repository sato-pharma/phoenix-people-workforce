"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, CornerUpLeft, Flag, ListChecks, MessageSquarePlus, XCircle } from "lucide-react";

import { adminPanelClassName, adminPanelHeaderClassName } from "@/components/admin/admin-design-tokens";
import type { PlanReturnableActivity } from "@/lib/approvals-hub/service";
import { formatStableEnGb } from "@/lib/format/cairo-datetime";
import {
  phxButtonApproveClassName,
  phxTextareaClassName,
} from "@/components/ui/form-tokens";

export type PlanDecisionActionsProps = {
  planId: string;
  // Which decide gate the viewer's approve/reject/return map to. null when the only available
  // standard action is HR acknowledge (a different endpoint) or the plan is read-only.
  decisionStage: "manager" | "ceo" | null;
  canAcknowledge: boolean;
  // The employee asked to reopen a submitted plan — the manager decides that edit request.
  isEditRequestDecision: boolean;
  // Manager may ask the employee to add per-doctor visit details (Field days only).
  canRequestVisitDetails: boolean;
  // Activities the return composer can attach per-activity notes to.
  returnableActivities: PlanReturnableActivity[];
  backHref: string;
};

type Mode =
  | { kind: "menu" }
  | { kind: "confirm"; action: SimpleAction }
  | { kind: "return" };

// Simple (single-step) actions that resolve through a confirm panel.
type SimpleAction = "approve" | "reject" | "acknowledge" | "approve_edit" | "reject_edit" | "request_details";

const SIMPLE_LABEL: Record<SimpleAction, string> = {
  approve: "Approve",
  reject: "Reject",
  acknowledge: "Acknowledge (HR)",
  approve_edit: "Allow edits",
  reject_edit: "Keep locked",
  request_details: "Request visit details",
};

const SIMPLE_REASON_REQUIRED: Record<SimpleAction, boolean> = {
  approve: false,
  reject: true,
  acknowledge: false,
  approve_edit: false,
  reject_edit: true,
  request_details: false,
};

// DATE-ONLY (a plan day's `activity_date`, a `date` column), which `new Date` parses as UTC midnight.
// UTC here is CORRECT and must stay: it is what stops the calendar day being shifted by a zone offset.
// Not an instant — do not "fix" this one to Cairo.
function dayLabel(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y) return iso;
  const dt = new Date(Date.UTC(y, (m || 1) - 1, d || 1));
  return formatStableEnGb(dt, { weekday: "short", day: "2-digit", month: "short", timeZone: "UTC" });
}

export function PlanDecisionActions({
  planId,
  decisionStage,
  canAcknowledge,
  isEditRequestDecision,
  canRequestVisitDetails,
  returnableActivities,
  backHref,
}: PlanDecisionActionsProps) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>({ kind: "menu" });
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Per-activity return notes: which activities are flagged + their note text.
  const [openNotes, setOpenNotes] = useState<Set<string>>(new Set());
  const [noteText, setNoteText] = useState<Record<string, string>>({});

  const activitiesByDay = useMemo(() => {
    const map = new Map<string, PlanReturnableActivity[]>();
    for (const a of returnableActivities) {
      const bucket = map.get(a.date);
      if (bucket) bucket.push(a);
      else map.set(a.date, [a]);
    }
    return Array.from(map.entries()).sort((x, y) => x[0].localeCompare(y[0]));
  }, [returnableActivities]);

  const flaggedCount = useMemo(
    () => Array.from(openNotes).filter((id) => (noteText[id] ?? "").trim()).length,
    [openNotes, noteText],
  );

  const hasStandard = Boolean(decisionStage);

  function reset() {
    setReason("");
    setError(null);
    setBusy(false);
  }

  function toMenu() {
    reset();
    setOpenNotes(new Set());
    setNoteText({});
    setMode({ kind: "menu" });
  }

  async function post(endpoint: string, body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as { success?: boolean; message?: string };
      if (!res.ok || !data.success) {
        setError(data.message || "This plan could not be updated — it may have already moved on.");
        setBusy(false);
        // Refresh so a stale card self-corrects to its real current state (refresh-on-conflict).
        router.refresh();
        return;
      }
      router.push(backHref);
      router.refresh();
    } catch {
      setError("Network error. Please try again.");
      setBusy(false);
    }
  }

  async function submitSimple(action: SimpleAction) {
    if (SIMPLE_REASON_REQUIRED[action] && !reason.trim()) {
      setError("A reason is required for this action.");
      return;
    }
    const comment = reason.trim() || null;
    if (action === "acknowledge") {
      await post(`/api/weekly-plans/${encodeURIComponent(planId)}/acknowledge`, { comment });
    } else if (action === "approve_edit" || action === "reject_edit") {
      await post(`/api/weekly-plans/${encodeURIComponent(planId)}/edit-request-decision`, {
        decision: action === "approve_edit" ? "approve" : "reject",
        comment,
      });
    } else if (action === "request_details") {
      await post(`/api/weekly-plans/${encodeURIComponent(planId)}/request-visit-details`, {});
    } else if (decisionStage) {
      // approve / reject on the current stage
      await post(`/api/weekly-plans/${encodeURIComponent(planId)}/decision`, {
        action: `${decisionStage}_${action}`,
        comment,
        returnNotes: [],
      });
    }
  }

  async function submitReturn() {
    if (!decisionStage) return;
    if (!reason.trim()) {
      setError("Add an overall reason so the employee knows why the plan came back.");
      return;
    }
    const returnNotes = Array.from(openNotes)
      .map((itemId) => ({ itemId, note: (noteText[itemId] ?? "").trim() }))
      .filter((n) => n.note);
    await post(`/api/weekly-plans/${encodeURIComponent(planId)}/decision`, {
      action: `${decisionStage}_return`,
      comment: reason.trim(),
      returnNotes,
    });
  }

  function toggleNote(id: string) {
    setOpenNotes((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        setNoteText((t) => {
          const { [id]: _removed, ...rest } = t;
          return rest;
        });
      } else {
        next.add(id);
      }
      return next;
    });
  }

  // Nothing actionable → render nothing (the page shows a read-only banner instead).
  if (!hasStandard && !canAcknowledge && !isEditRequestDecision && !canRequestVisitDetails) return null;

  const shell = adminPanelClassName;
  const headerBar = `${adminPanelHeaderClassName} px-4 py-2.5`;
  const headerText = "text-phx-xs font-black uppercase tracking-[0.14em] text-white";

  // ── Premium per-activity return composer ─────────────────────────────────────
  if (mode.kind === "return") {
    return (
      <section className={shell}>
        <header className={`flex items-center justify-between ${headerBar}`}>
          <h3 className={headerText}>Return plan — flag what to fix</h3>
          <span className="inline-flex items-center gap-1 rounded-full bg-phx-warn px-2 py-0.5 text-phx-2xs font-black text-white">
            <Flag className="h-3 w-3" /> {flaggedCount} flagged
          </span>
        </header>

        <div className="space-y-4 px-4 py-4">
          <div>
            <label className="mb-1 block text-phx-xs font-black uppercase tracking-wide text-slate-500">
              Overall reason <span className="text-orange-600">*</span>
            </label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              autoFocus
              placeholder="Why is this plan coming back? The employee sees this."
              className={phxTextareaClassName}
            />
          </div>

          <div>
            <p className="mb-2 flex items-center gap-1.5 text-phx-xs font-black uppercase tracking-wide text-slate-500">
              <MessageSquarePlus className="h-3.5 w-3.5" /> Per-activity notes (optional)
            </p>
            <p className="mb-2 text-xs text-slate-500">Flag any specific day the employee should change — each note shows next to that activity.</p>

            {activitiesByDay.length === 0 ? (
              <p className="border border-dashed border-slate-300 px-3 py-4 text-center text-xs text-slate-400">
                This plan has no activities to annotate.
              </p>
            ) : (
              <div className="space-y-3">
                {activitiesByDay.map(([date, acts]) => (
                  <div key={date} className="border border-slate-200">
                    <div className="border-b border-slate-100 bg-slate-50 px-3 py-1.5 text-phx-xs font-black uppercase tracking-wide text-slate-600">
                      {dayLabel(date)}
                    </div>
                    <div className="divide-y divide-slate-100">
                      {acts.map((a) => {
                        const flagged = openNotes.has(a.id);
                        return (
                          <div key={a.id} className={flagged ? "border-l-2 border-orange-500 bg-orange-50/40" : "border-l-2 border-transparent"}>
                            <button
                              type="button"
                              onClick={() => toggleNote(a.id)}
                              className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition-colors hover:bg-slate-50"
                            >
                              <span className="min-w-0">
                                <span className="block break-words text-sm font-bold text-slate-800">{a.label}</span>
                                {a.timeLabel ? <span className="text-phx-xs text-slate-500">{a.timeLabel}</span> : null}
                              </span>
                              <span
                                className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-phx-2xs font-bold ${
                                  flagged ? "bg-orange-500 text-white" : "border border-slate-300 text-slate-500"
                                }`}
                              >
                                <Flag className="h-3 w-3" /> {flagged ? "Flagged" : "Flag"}
                              </span>
                            </button>
                            {flagged ? (
                              <div className="px-3 pb-3">
                                <textarea
                                  value={noteText[a.id] ?? ""}
                                  onChange={(e) => setNoteText((t) => ({ ...t, [a.id]: e.target.value }))}
                                  rows={2}
                                  placeholder="What should change on this day?"
                                  className={phxTextareaClassName}
                                />
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {error ? <p className="text-sm font-semibold text-rose-600">{error}</p> : null}

          <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-3">
            <button
              type="button"
              onClick={submitReturn}
              disabled={busy}
              className="inline-flex items-center gap-1.5 bg-orange-500 px-4 py-2 text-sm font-bold text-white hover:bg-orange-600 disabled:opacity-60"
            >
              <CornerUpLeft className="h-4 w-4" />
              {busy ? "Returning…" : `Return${flaggedCount ? ` with ${flaggedCount} note${flaggedCount === 1 ? "" : "s"}` : ""}`}
            </button>
            <button
              type="button"
              onClick={toMenu}
              disabled={busy}
              className="border border-slate-300 px-4 py-2 text-sm font-bold text-slate-600 hover:bg-slate-50 disabled:opacity-60"
            >
              Cancel
            </button>
          </div>
        </div>
      </section>
    );
  }

  // ── Simple confirm panel (approve / reject / acknowledge / edit-request / details) ─
  if (mode.kind === "confirm") {
    const action = mode.action;
    const needsReason = SIMPLE_REASON_REQUIRED[action];
    return (
      <section className={shell}>
        <header className={headerBar}>
          <h3 className={headerText}>Your response</h3>
        </header>
        <div className="space-y-3 px-4 py-4">
          <p className="text-sm font-bold text-slate-900">
            {needsReason ? `${SIMPLE_LABEL[action]} — provide a reason` : `Confirm: ${SIMPLE_LABEL[action]}?`}
          </p>
          {action === "request_details" ? (
            <p className="text-xs text-slate-500">The employee will be asked to add per-doctor details for their Single Visit (Field) days before this plan can be approved.</p>
          ) : null}
          {needsReason ? (
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              autoFocus
              placeholder="Type the reason the employee will see…"
              className={phxTextareaClassName}
            />
          ) : null}
          {error ? <p className="text-sm font-semibold text-rose-600">{error}</p> : null}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => submitSimple(action)}
              disabled={busy}
              className="bg-orange-500 px-4 py-2 text-sm font-bold text-white hover:bg-orange-600 disabled:opacity-60"
            >
              {busy ? "Submitting…" : `Confirm ${SIMPLE_LABEL[action]}`}
            </button>
            <button
              type="button"
              onClick={toMenu}
              disabled={busy}
              className="border border-slate-300 px-4 py-2 text-sm font-bold text-slate-600 hover:bg-slate-50 disabled:opacity-60"
            >
              Cancel
            </button>
          </div>
        </div>
      </section>
    );
  }

  // ── Action menu ──────────────────────────────────────────────────────────────
  return (
    <section className={shell}>
      <header className={headerBar}>
        <h3 className={headerText}>Your response</h3>
      </header>
      <div className="flex flex-wrap gap-2 px-4 py-4">
        {isEditRequestDecision ? (
          <>
            <button type="button" onClick={() => { reset(); setMode({ kind: "confirm", action: "approve_edit" }); }} className={phxButtonApproveClassName}>
              <CheckCircle2 className="h-4 w-4" /> Allow edits
            </button>
            <button type="button" onClick={() => { reset(); setMode({ kind: "confirm", action: "reject_edit" }); }} className="inline-flex items-center gap-1.5 border border-rose-500 px-4 py-2 text-sm font-bold text-rose-700 hover:bg-rose-50">
              <XCircle className="h-4 w-4" /> Keep locked
            </button>
          </>
        ) : null}

        {hasStandard ? (
          <>
            <button type="button" onClick={() => { reset(); setMode({ kind: "confirm", action: "approve" }); }} className={phxButtonApproveClassName}>
              <CheckCircle2 className="h-4 w-4" /> Approve
            </button>
            <button type="button" onClick={() => { reset(); setMode({ kind: "return" }); }} className="inline-flex items-center gap-1.5 border border-amber-500 px-4 py-2 text-sm font-bold text-amber-700 hover:bg-amber-50">
              <CornerUpLeft className="h-4 w-4" /> Return with notes
            </button>
            <button type="button" onClick={() => { reset(); setMode({ kind: "confirm", action: "reject" }); }} className="inline-flex items-center gap-1.5 border border-rose-500 px-4 py-2 text-sm font-bold text-rose-700 hover:bg-rose-50">
              <XCircle className="h-4 w-4" /> Reject
            </button>
          </>
        ) : null}

        {canRequestVisitDetails ? (
          <button type="button" onClick={() => { reset(); setMode({ kind: "confirm", action: "request_details" }); }} className="inline-flex items-center gap-1.5 border border-slate-300 px-4 py-2 text-sm font-bold text-slate-700 hover:bg-slate-50">
            <ListChecks className="h-4 w-4" /> Request visit details
          </button>
        ) : null}

        {canAcknowledge ? (
          <button type="button" onClick={() => { reset(); setMode({ kind: "confirm", action: "acknowledge" }); }} className="inline-flex items-center gap-1.5 bg-slate-900 px-4 py-2 text-sm font-bold text-white shadow-[0_1px_2px_rgba(15,23,42,0.2),0_8px_18px_rgba(15,23,42,0.16)] transition-shadow hover:bg-black">
            <CheckCircle2 className="h-4 w-4" /> Acknowledge (HR)
          </button>
        ) : null}
      </div>
      {error ? <p className="px-4 pb-3 text-sm font-semibold text-rose-600">{error}</p> : null}
    </section>
  );
}
