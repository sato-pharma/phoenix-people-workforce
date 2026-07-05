"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export type DecisionActionsProps = {
  // API endpoint that accepts { decision, [commentField] }.
  endpoint: string;
  // Field name for the reason/comment ("decisionComment" for leave, "comment" for excuse).
  commentField: "decisionComment" | "comment";
  // Which buttons are enabled for this viewer/step.
  actions: { approve?: boolean; reject?: boolean; return?: boolean; acknowledge?: boolean };
  // Where to return after a successful decision.
  backHref: string;
};

type Pending = "approve" | "reject" | "return" | "acknowledge" | null;

const LABEL: Record<Exclude<Pending, null>, string> = {
  approve: "Approve",
  reject: "Reject",
  return: "Return with comment",
  acknowledge: "Acknowledge (HR)",
};

const REASON_REQUIRED: Record<Exclude<Pending, null>, boolean> = {
  approve: false,
  reject: true,
  return: true,
  acknowledge: false,
};

// The API decision token for each action (acknowledge is an HR approve).
const DECISION_TOKEN: Record<Exclude<Pending, null>, string> = {
  approve: "approve",
  reject: "reject",
  return: "return",
  acknowledge: "approve",
};

export function DecisionActions({ endpoint, commentField, actions, backHref }: DecisionActionsProps) {
  const router = useRouter();
  const [pending, setPending] = useState<Pending>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const available = (
    [
      ["approve", actions.approve],
      ["acknowledge", actions.acknowledge],
      ["return", actions.return],
      ["reject", actions.reject],
    ] as Array<[Exclude<Pending, null>, boolean | undefined]>
  ).filter(([, on]) => on);

  if (available.length === 0) return null;

  function start(action: Exclude<Pending, null>) {
    setError(null);
    setReason("");
    setPending(action);
  }

  async function confirm() {
    if (!pending) return;
    if (REASON_REQUIRED[pending] && !reason.trim()) {
      setError("A reason is required for this action.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: DECISION_TOKEN[pending], [commentField]: reason.trim() || null }),
      });
      const data = (await res.json().catch(() => ({}))) as { success?: boolean; message?: string };
      if (!res.ok || !data.success) {
        setError(data.message || "This request could not be updated. It may have already been decided.");
        setBusy(false);
        return;
      }
      // Success — leave the request and return to the list; the item moves to history.
      router.push(backHref);
      router.refresh();
    } catch {
      setError("Network error. Please try again.");
      setBusy(false);
    }
  }

  const toneClass: Record<Exclude<Pending, null>, string> = {
    approve: "bg-emerald-600 hover:bg-emerald-700 text-white",
    acknowledge: "bg-slate-900 hover:bg-black text-white",
    return: "border border-amber-500 text-amber-700 hover:bg-amber-50",
    reject: "border border-rose-500 text-rose-700 hover:bg-rose-50",
  };

  return (
    <section className="border border-[#e4e9ec] bg-white">
      <header className="border-b border-[#e4e9ec] bg-slate-900 px-4 py-2.5">
        <h3 className="text-[11px] font-black uppercase tracking-[0.14em] text-white">Your response</h3>
      </header>

      <div className="px-4 py-4">
        {pending === null ? (
          <div className="flex flex-wrap gap-2">
            {available.map(([action]) => (
              <button
                key={action}
                type="button"
                onClick={() => start(action)}
                className={`px-4 py-2 text-sm font-bold transition-colors ${toneClass[action]}`}
              >
                {LABEL[action]}
              </button>
            ))}
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm font-bold text-slate-900">
              {pending === "approve" || pending === "acknowledge"
                ? `Confirm: ${LABEL[pending]} this request?`
                : `${LABEL[pending]} — provide a reason`}
            </p>
            {REASON_REQUIRED[pending] ? (
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
                autoFocus
                placeholder="Type the reason the employee will see…"
                className="w-full border border-slate-300 px-3 py-2 text-sm focus:border-orange-500 focus:outline-none"
              />
            ) : null}
            {error ? <p className="text-sm font-semibold text-rose-600">{error}</p> : null}
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={confirm}
                disabled={busy}
                className="bg-orange-500 px-4 py-2 text-sm font-bold text-white hover:bg-orange-600 disabled:opacity-60"
              >
                {busy ? "Submitting…" : `Confirm ${LABEL[pending].split(" ")[0]}`}
              </button>
              <button
                type="button"
                onClick={() => {
                  setPending(null);
                  setError(null);
                }}
                disabled={busy}
                className="border border-slate-300 px-4 py-2 text-sm font-bold text-slate-600 hover:bg-slate-50 disabled:opacity-60"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
        {error && pending === null ? <p className="mt-3 text-sm font-semibold text-rose-600">{error}</p> : null}
      </div>
    </section>
  );
}
