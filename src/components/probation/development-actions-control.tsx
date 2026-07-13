"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

// Development-actions "mark improvement" control (module completion C5). The report already lists
// development actions read-only; this adds the write control to advance an action's status and record a
// follow-up outcome. PATCHes /api/probation/development-actions/[id] (updateDevelopmentAction).

type DevAction = {
  id: string;
  title: string;
  ownerHrId: string | null;
  ownerName: string | null;
  dueDate: string | null;
  status: "open" | "in_progress" | "done" | "cancelled";
  followUpOutcome: string | null;
};

const STATUSES: Array<{ value: DevAction["status"]; label: string }> = [
  { value: "open", label: "Open" },
  { value: "in_progress", label: "In progress" },
  { value: "done", label: "Done" },
  { value: "cancelled", label: "Cancelled" },
];

const STATUS_STYLE: Record<DevAction["status"], string> = {
  open: "bg-slate-100 text-slate-600",
  in_progress: "bg-amber-50 text-amber-700",
  done: "bg-emerald-50 text-emerald-700",
  cancelled: "bg-slate-100 text-slate-400 line-through",
};

function ActionRow({ action }: { action: DevAction }) {
  const router = useRouter();
  const [status, setStatus] = useState<DevAction["status"]>(action.status);
  const [outcome, setOutcome] = useState(action.followUpOutcome ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const dirty = status !== action.status || outcome !== (action.followUpOutcome ?? "");

  async function save() {
    if (busy || !dirty) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch(`/api/probation/development-actions/${encodeURIComponent(action.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, followUpOutcome: outcome.trim() || null }),
      });
      if (res.ok) {
        setSaved(true);
        router.refresh();
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Failed to update the action.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded border border-slate-100 p-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-slate-800">{action.title}</span>
            <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${STATUS_STYLE[action.status]}`}>{action.status.replace("_", " ")}</span>
          </div>
          <div className="text-[11px] text-slate-400">
            {action.ownerHrId ? `Owner ${action.ownerName ?? action.ownerHrId}` : "No owner"}{action.dueDate ? ` · due ${action.dueDate}` : ""}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <select value={status} onChange={(e) => setStatus(e.target.value as DevAction["status"])} className="h-8 rounded border border-slate-200 px-2 text-xs">
            {STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
          <button disabled={busy || !dirty} onClick={save} className="rounded bg-slate-800 px-3 py-1 text-xs font-medium text-white disabled:opacity-40">
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
      <input
        value={outcome}
        onChange={(e) => setOutcome(e.target.value)}
        placeholder="Follow-up outcome (e.g. 'objection handling improved on next DV')…"
        className="mt-2 w-full rounded border border-slate-200 px-3 py-1.5 text-sm"
      />
      {saved && <p className="mt-1 text-[11px] text-emerald-600">Saved.</p>}
      {error && <p className="mt-1 text-[11px] text-rose-600">{error}</p>}
    </div>
  );
}

export function DevelopmentActionsControl({ actions }: { actions: DevAction[] }) {
  if (actions.length === 0) return null;
  return (
    <section className="rounded-lg border border-slate-300 bg-white p-4">
      <h2 className="text-sm font-semibold text-slate-900">Development actions — track improvement</h2>
      <p className="mt-0.5 text-xs text-slate-500">Advance each action and record whether the improvement was seen on a later Double-Visit.</p>
      <div className="mt-3 flex flex-col gap-2">
        {actions.map((a) => <ActionRow key={a.id} action={a} />)}
      </div>
    </section>
  );
}
