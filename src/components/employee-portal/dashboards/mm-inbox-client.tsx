"use client";

import { useState } from "react";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";

import type { MarketingApproverInboxRow } from "@/lib/marketing-requests/service";
import { stableCurrencyFormatter } from "@/lib/format/stable-currency";
import { phxTextareaClassName } from "@/components/ui/form-tokens";
import {
  APPROVAL_ACTION_LABEL,
  ApprovalConfirmButtons,
  approvalActionClassName,
} from "@/components/approvals-hub/approval-action-kit";
import { LANDING_FOCUS, LandingEmpty, LandingMeta, LandingPanel } from "@/components/employee-portal/landing-kit";

function egp(n: number) {
  return stableCurrencyFormatter("en-EG", { style: "currency", currency: "EGP", maximumFractionDigits: 0 }).format(n);
}

function ageInDays(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now - t) / 86_400_000));
}

/**
 * How long a request has waited, said twice: as the 2px rail down the row's left edge and as the
 * small words under its cost. A week or more is rose, three days amber, anything younger slate —
 * flat colour on a rail and on words, never a tinted chip.
 */
function ageTone(days: number | null): { rail: string; text: string } {
  if (days == null) return { rail: "bg-slate-200", text: "text-slate-400" };
  if (days >= 7) return { rail: "bg-rose-500", text: "text-rose-700" };
  if (days >= 3) return { rail: "bg-amber-400", text: "text-amber-700" };
  return { rail: "bg-slate-200", text: "text-slate-500" };
}

type InlineAction = { id: string; kind: "return" | "reject" } | null;
type RowOutcome = { id: string; ok: boolean; message: string } | null;

/**
 * Interactive inbox for the MM landing. Renders "Needs Your Decision" with 1-click approve
 * and inline return/reject (reason required). Optimistically removes a row on success.
 * Error and forbidden responses are surfaced inline; the guarded server endpoint
 * (assertMarketingStepAssignedToActor) is never bypassed.
 *
 * Its look is the landing kit's white panel, and its decision buttons wear the one approvals
 * interface (`approval-action-kit.tsx`, REC-032) — the same Approve, Return and Reject an approver
 * meets on every other decision screen. Only the look is shared: which buttons a step offers
 * (`allowReturn`, `allowReject`) and where the decision posts stay this inbox's own.
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
    <LandingPanel
      right={visibleRows.length > 0 && oldestAge > 0 ? <LandingMeta items={[`oldest ${oldestAge}d waiting`]} /> : null}
      title="Needs Your Decision"
    >
      {sortedRows.length > 0 ? (
        <ul>
          {sortedRows.map((row) => {
            const age = ageInDays(row.submittedAt, now);
            const tone = ageTone(age);
            const isBusy = submitting === row.id;
            const rowOutcome = outcome?.id === row.id ? outcome : null;
            const expandedKind = inline?.id === row.id ? inline.kind : null;
            const reasonId = `mm-inbox-reason-${row.id}`;

            return (
              <li key={row.id} aria-busy={isBusy} className={`relative border-b border-slate-200 last:border-b-0 ${isBusy ? "opacity-60" : ""}`}>
                <span aria-hidden="true" className={`absolute inset-y-0 left-0 w-0.5 ${tone.rail}`} />

                {/* Summary — who and what on the left, wrapping; the cost and its wait on the right */}
                <div className="flex min-w-0 items-start gap-3 px-3 pt-3 sm:px-4">
                  <div className="min-w-0 flex-1">
                    <p className="break-words text-phx-md font-bold leading-snug text-[#08111f]">
                      {row.requestCode} · {row.requesterName}
                    </p>
                    <p className="mt-0.5 break-words text-phx-xs leading-snug text-slate-500">
                      {row.requestType} — {row.currentStepName}
                    </p>
                  </div>
                  <div className="min-w-0 max-w-[45%] text-right">
                    <p className="break-words text-phx-md font-bold tabular-nums text-[#08111f]">{egp(row.estimatedCost)}</p>
                    <p className={`mt-0.5 text-phx-xs font-bold tabular-nums ${tone.text}`}>{age == null ? "no date" : `${age}d waiting`}</p>
                  </div>
                </div>

                {/* Error notice */}
                {rowOutcome && !rowOutcome.ok ? (
                  <div className="mx-3 mt-3 flex items-start gap-2 border-l-2 border-amber-500 bg-amber-50 px-3 py-2 text-phx-sm text-amber-900 sm:mx-4" role="alert">
                    <AlertTriangle aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
                    <span className="min-w-0 flex-1 break-words">{rowOutcome.message}</span>
                    <button
                      className={`shrink-0 text-phx-xs font-bold uppercase tracking-[0.08em] text-slate-500 hover:text-[#08111f] ${LANDING_FOCUS}`}
                      onClick={() => setOutcome(null)}
                      type="button"
                    >
                      Dismiss
                    </button>
                  </div>
                ) : null}

                {/* Inline reason input (return / reject) */}
                {expandedKind ? (
                  <div className="mx-3 mt-3 space-y-2 border-t border-slate-200 pt-3 sm:mx-4">
                    <label className="block text-phx-xs font-bold uppercase tracking-[0.08em] text-slate-500" htmlFor={reasonId}>
                      {expandedKind === "return" ? row.decisionLabels.return : row.decisionLabels.reject} — reason required
                    </label>
                    <textarea
                      id={reasonId}
                      rows={2}
                      placeholder="Enter reason…"
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      autoFocus
                      className={phxTextareaClassName}
                    />
                    <ApprovalConfirmButtons
                      busy={isBusy}
                      confirmLabel={`Confirm ${expandedKind}`}
                      disabled={!reason.trim()}
                      onCancel={() => {
                        setInline(null);
                        setReason("");
                      }}
                      onConfirm={() => decide(row.id, expandedKind, reason.trim())}
                    />
                  </div>
                ) : null}

                {/* Action bar — the one approvals interface's buttons, wrapping on a phone */}
                <div className="flex flex-wrap items-center gap-2 px-3 py-3 sm:px-4">
                  <button
                    disabled={isBusy}
                    onClick={() => decide(row.id, "approve")}
                    className={approvalActionClassName("approve", "regular", `grow sm:grow-0 ${LANDING_FOCUS}`)}
                    type="button"
                  >
                    {isBusy && !expandedKind ? APPROVAL_ACTION_LABEL.working : row.decisionLabels.approve}
                  </button>
                  {row.allowReturn ? (
                    <button
                      aria-expanded={expandedKind === "return"}
                      disabled={isBusy}
                      onClick={() => toggleInline(row.id, "return")}
                      className={approvalActionClassName("return", "regular", `grow aria-expanded:bg-amber-50 sm:grow-0 ${LANDING_FOCUS}`)}
                      type="button"
                    >
                      {row.decisionLabels.return}
                    </button>
                  ) : null}
                  {row.allowReject ? (
                    <button
                      aria-expanded={expandedKind === "reject"}
                      disabled={isBusy}
                      onClick={() => toggleInline(row.id, "reject")}
                      className={approvalActionClassName("reject", "regular", `grow aria-expanded:bg-rose-50 sm:grow-0 ${LANDING_FOCUS}`)}
                      type="button"
                    >
                      {row.decisionLabels.reject}
                    </button>
                  ) : null}
                  <Link
                    href={`/employee-portals/marketing-requests/decision/${row.id}`}
                    className={approvalActionClassName("neutral", "regular", `grow sm:ml-auto sm:grow-0 ${LANDING_FOCUS}`)}
                  >
                    Full view
                  </Link>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <LandingEmpty>No pending marketing approvals. You&apos;re all caught up.</LandingEmpty>
      )}
    </LandingPanel>
  );
}
