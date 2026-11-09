"use client";

import { useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowRight, CheckCircle, Clock, RefreshCw, X } from "lucide-react";

import type { MarketingApproverInboxRow } from "@/lib/marketing-requests/service";
import { stableCurrencyFormatter } from "@/lib/format/stable-currency";
import { phxTextareaClassName } from "@/components/ui/form-tokens";

function egp(n: number) {
  return stableCurrencyFormatter("en-EG", { style: "currency", currency: "EGP", maximumFractionDigits: 0 }).format(n);
}

function ageInDays(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now - t) / 86_400_000));
}

function AgeBadge({ days }: { days: number | null }) {
  if (days == null)
    return <span className="shrink-0 text-phx-xs font-medium text-slate-400 whitespace-nowrap">no date</span>;
  const tone =
    days >= 7 ? "bg-rose-100 text-rose-700" : days >= 3 ? "bg-amber-100 text-amber-700" : "bg-slate-100 text-slate-600";
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 px-2 py-0.5 text-phx-xs font-semibold whitespace-nowrap ${tone}`}>
      <Clock className="h-3 w-3" />
      {days}d
    </span>
  );
}

type InlineAction = { id: string; kind: "return" | "reject" } | null;
type RowOutcome = { id: string; ok: boolean; message: string } | null;

/**
 * Interactive inbox for the MM landing. Renders "Needs Your Decision" with 1-click approve
 * and inline return/reject (reason required). Optimistically removes a row on success.
 * Error and forbidden responses are surfaced inline; the guarded server endpoint
 * (assertMarketingStepAssignedToActor) is never bypassed.
 */
export function MmInboxClient({ rows, now }: { rows: MarketingApproverInboxRow[]; now: number }) {
  const [visible, setVisible] = useState<string[]>(() => rows.map((r) => r.id));
  const [inline, setInline] = useState<InlineAction>(null);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<RowOutcome>(null);

  const visibleRows = rows.filter((r) => visible.includes(r.id));

  const oldestAge = visibleRows.reduce<number>((max, row) => {
    const d = ageInDays(row.submittedAt, now);
    return d != null && d > max ? d : max;
  }, 0);

  const sortedRows = [...visibleRows].sort((a, b) => {
    const at = a.submittedAt ? new Date(a.submittedAt).getTime() : Number.POSITIVE_INFINITY;
    const bt = b.submittedAt ? new Date(b.submittedAt).getTime() : Number.POSITIVE_INFINITY;
    return at - bt;
  });

  async function decide(id: string, action: "approve" | "return" | "reject", comment?: string) {
    setSubmitting(id);
    setOutcome(null);
    try {
      const res = await fetch(`/api/marketing-requests/${id}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: action, comment: comment ?? null }),
      });
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      if (!res.ok) {
        const msg =
          res.status === 403
            ? "You are not assigned to this step — reload if the request moved."
            : (body.message ?? "Decision failed. Please try again.");
        setOutcome({ id, ok: false, message: msg });
        return;
      }
      setVisible((prev) => prev.filter((x) => x !== id));
      setInline(null);
      setReason("");
    } catch {
      setOutcome({ id, ok: false, message: "Network error — check your connection and try again." });
    } finally {
      setSubmitting(null);
    }
  }

  function toggleInline(id: string, kind: "return" | "reject") {
    if (inline?.id === id && inline.kind === kind) {
      setInline(null);
      setReason("");
    } else {
      setInline({ id, kind });
      setReason("");
      setOutcome(null);
    }
  }

  return (
    <div className="overflow-hidden border border-slate-200">
      <div className="flex items-center justify-between bg-slate-900 px-5 py-3">
        <h2 className="text-phx-sm font-bold uppercase tracking-widest text-slate-300">Needs Your Decision</h2>
        {visibleRows.length > 0 && oldestAge > 0 ? (
          <span className="text-phx-sm font-semibold uppercase tracking-wider text-orange-400 whitespace-nowrap">
            oldest {oldestAge}d waiting
          </span>
        ) : (
          <div className="h-1.5 w-12 bg-orange-500" />
        )}
      </div>

      {sortedRows.length > 0 ? (
        <div className="divide-y divide-slate-100 bg-white">
          {sortedRows.map((row) => {
            const age = ageInDays(row.submittedAt, now);
            const isBusy = submitting === row.id;
            const rowOutcome = outcome?.id === row.id ? outcome : null;
            const expandedKind = inline?.id === row.id ? inline.kind : null;

            return (
              <div key={row.id}>
                {/* Summary row */}
                <div className={`flex items-center gap-3 px-5 py-3 ${isBusy ? "opacity-60" : ""}`}>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-slate-900 whitespace-nowrap">
                      {row.requestCode} · {row.requesterName}
                    </p>
                    <p className="text-phx-xs text-slate-500 whitespace-nowrap">
                      {row.requestType} — {row.currentStepName}
                    </p>
                  </div>
                  <AgeBadge days={age} />
                  <span className="shrink-0 text-sm font-bold text-slate-700 whitespace-nowrap">{egp(row.estimatedCost)}</span>
                </div>

                {/* Error notice */}
                {rowOutcome && !rowOutcome.ok ? (
                  <div className="flex items-center gap-2 border-t border-amber-100 bg-amber-50 px-5 py-2 text-phx-sm text-amber-800">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-600" />
                    <span className="flex-1">{rowOutcome.message}</span>
                    <button
                      className="text-phx-xs text-slate-400 hover:text-slate-600 whitespace-nowrap"
                      onClick={() => setOutcome(null)}
                    >
                      dismiss
                    </button>
                  </div>
                ) : null}

                {/* Inline reason input (return / reject) */}
                {expandedKind ? (
                  <div className="space-y-2 border-t border-slate-100 bg-slate-50 px-5 py-3">
                    <p className="text-phx-xs font-semibold uppercase tracking-wider text-slate-500">
                      {expandedKind === "return" ? row.decisionLabels.return : row.decisionLabels.reject} — reason required
                    </p>
                    <textarea
                      rows={2}
                      placeholder="Enter reason…"
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      autoFocus
                      className={phxTextareaClassName}
                    />
                    <div className="flex items-center gap-2">
                      <button
                        disabled={isBusy || !reason.trim()}
                        onClick={() => decide(row.id, expandedKind, reason.trim())}
                        className={`px-4 py-1.5 text-phx-sm font-semibold uppercase tracking-wider text-white transition-colors
                          ${expandedKind === "reject"
                            ? "bg-rose-600 hover:bg-rose-700 disabled:bg-rose-300"
                            : "bg-amber-600 hover:bg-amber-700 disabled:bg-amber-300"
                          }`}
                      >
                        {isBusy ? "Sending…" : `Confirm ${expandedKind}`}
                      </button>
                      <button
                        onClick={() => { setInline(null); setReason(""); }}
                        className="px-3 py-1.5 text-phx-sm font-medium text-slate-500 hover:text-slate-700"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : null}

                {/* Action bar */}
                <div className="flex items-center gap-2 border-t border-slate-100 bg-white px-5 py-2">
                  <button
                    disabled={isBusy}
                    onClick={() => decide(row.id, "approve")}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-phx-xs font-semibold uppercase tracking-wider text-white bg-slate-800 hover:bg-orange-600 disabled:bg-slate-300 transition-colors"
                  >
                    <CheckCircle className="h-3 w-3" />
                    {isBusy && !expandedKind ? "…" : row.decisionLabels.approve}
                  </button>
                  {row.allowReturn ? (
                    <button
                      disabled={isBusy}
                      onClick={() => toggleInline(row.id, "return")}
                      className={`flex items-center gap-1.5 px-3 py-1.5 text-phx-xs font-semibold uppercase tracking-wider transition-colors
                        ${expandedKind === "return"
                          ? "bg-amber-600 text-white"
                          : "bg-amber-50 text-amber-700 hover:bg-amber-100 disabled:opacity-50"
                        }`}
                    >
                      <RefreshCw className="h-3 w-3" />
                      {row.decisionLabels.return}
                    </button>
                  ) : null}
                  {row.allowReject ? (
                    <button
                      disabled={isBusy}
                      onClick={() => toggleInline(row.id, "reject")}
                      className={`flex items-center gap-1.5 px-3 py-1.5 text-phx-xs font-semibold uppercase tracking-wider transition-colors
                        ${expandedKind === "reject"
                          ? "bg-rose-600 text-white"
                          : "bg-rose-50 text-rose-600 hover:bg-rose-100 disabled:opacity-50"
                        }`}
                    >
                      <X className="h-3 w-3" />
                      {row.decisionLabels.reject}
                    </button>
                  ) : null}
                  <Link
                    href={`/employee-portals/marketing-requests/decision/${row.id}`}
                    className="ml-auto flex items-center gap-1 text-phx-xs text-slate-400 hover:text-orange-500 transition-colors whitespace-nowrap"
                  >
                    Full view <ArrowRight className="h-3 w-3" />
                  </Link>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="bg-white px-5 py-6 text-sm text-slate-500">No pending marketing approvals. You&apos;re all caught up.</p>
      )}
    </div>
  );
}
