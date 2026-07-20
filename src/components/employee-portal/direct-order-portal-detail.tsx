"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Check, Undo2, X } from "lucide-react";

import {
  PortalEmptyState,
  PortalRecordFields,
  PortalSection,
  portalInputClassName,
} from "@/components/employee-portal/portal-primitives";
import type { DirectOrderApprovalDetail } from "@/lib/direct-orders/types";

const money = (value: number) => `${Math.round(value).toLocaleString("en-US")} EGP`;

const STEP_TONE: Record<string, string> = {
  approved: "bg-emerald-500",
  rejected: "bg-rose-500",
  pending: "bg-amber-400",
};

type DecisionAction = "approve" | "reject" | "return";
type Pending = DecisionAction | null;

const LABEL: Record<DecisionAction, string> = {
  approve: "Approve",
  reject: "Reject",
  return: "Return with comment",
};
const REASON_REQUIRED: Record<DecisionAction, boolean> = {
  approve: false,
  reject: true,
  return: true,
};

function DirectOrderPortalDecisionActions({
  requestId,
  actions,
  backHref,
}: {
  requestId: string;
  actions: { approve?: boolean; reject?: boolean; return?: boolean };
  backHref: string;
}) {
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true);
  }, []);

  const [pending, setPending] = useState<Pending>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const available = (["approve", "return", "reject"] as DecisionAction[]).filter((action) => actions[action]);
  if (available.length === 0) return null;

  function start(action: DecisionAction) {
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
      const res = await fetch(`/api/direct-orders/${encodeURIComponent(requestId)}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: pending, comment: reason.trim() || null }),
      });
      const data = (await res.json().catch(() => ({}))) as { success?: boolean; message?: string };
      if (!res.ok || !data.success) {
        setError(data.message || "This request could not be updated. It may have already been decided.");
        setBusy(false);
        return;
      }
      router.push(backHref);
      router.refresh();
    } catch {
      setError("Network error. Please try again.");
      setBusy(false);
    }
  }

  const toneClass: Record<DecisionAction, string> = {
    approve: "bg-emerald-600 hover:bg-emerald-700 text-white",
    return: "border border-amber-400 text-amber-700 hover:bg-amber-50",
    reject: "border border-rose-400 text-rose-700 hover:bg-rose-50",
  };
  const icon: Record<DecisionAction, typeof Check> = { approve: Check, reject: X, return: Undo2 };

  const primaryButtons = (compact: boolean) =>
    available.map((action) => {
      const Icon = icon[action];
      return (
        <button
          key={action}
          type="button"
          onClick={() => start(action)}
          className={`flex h-11 flex-1 items-center justify-center gap-2 rounded text-sm font-bold transition ${toneClass[action]}`}
        >
          <Icon className="h-4 w-4" />
          {compact ? action[0].toUpperCase() + action.slice(1) : LABEL[action]}
        </button>
      );
    });

  return (
    <>
      <PortalSection eyebrow="Decision" title="Your response">
        <div className="space-y-3 p-4 sm:p-5">
          {pending === null ? (
            <div className="flex flex-wrap gap-2">{primaryButtons(false)}</div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm font-bold text-slate-900">
                {pending === "approve" ? `Confirm: ${LABEL[pending]} this request?` : `${LABEL[pending]} -- provide a reason`}
              </p>
              {REASON_REQUIRED[pending] ? (
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={3}
                  autoFocus
                  placeholder="Type the reason the requester will see..."
                  className={portalInputClassName + " h-auto py-2"}
                />
              ) : null}
              {error ? <p className="text-sm font-semibold text-rose-600">{error}</p> : null}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={confirm}
                  disabled={busy}
                  className="h-11 flex-1 rounded bg-orange-600 text-sm font-bold text-white transition hover:bg-orange-700 disabled:opacity-60"
                >
                  {busy ? "Submitting..." : `Confirm ${LABEL[pending].split(" ")[0]}`}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setPending(null);
                    setError(null);
                  }}
                  disabled={busy}
                  className="h-11 flex-1 rounded border border-slate-300 text-sm font-bold text-slate-600 transition hover:bg-slate-50 disabled:opacity-60"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
          {error && pending === null ? <p className="text-sm font-semibold text-rose-600">{error}</p> : null}
        </div>
      </PortalSection>

      {/* Sticky mobile action bar -- same state machine, thumb-reachable on a phone. */}
      {mounted
        ? createPortal(
            <div
              className="fixed inset-x-0 z-30 flex gap-2 border-t border-slate-200 bg-white/95 px-4 pb-3 pt-3 backdrop-blur md:hidden"
              style={{ bottom: "calc(56px + env(safe-area-inset-bottom))" }}
            >
              {pending === null ? (
                primaryButtons(true)
              ) : (
                <>
                  <button
                    type="button"
                    onClick={confirm}
                    disabled={busy}
                    className="h-12 flex-1 rounded bg-orange-600 text-sm font-black text-white transition disabled:opacity-60"
                  >
                    {busy ? "Submitting..." : `Confirm`}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setPending(null);
                      setError(null);
                    }}
                    disabled={busy}
                    className="h-12 flex-1 rounded border border-slate-300 bg-white text-sm font-black text-slate-600 disabled:opacity-60"
                  >
                    Cancel
                  </button>
                </>
              )}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

export function DirectOrderPortalDetail({
  detail,
  backHref,
}: {
  detail: DirectOrderApprovalDetail | null;
  backHref: string;
}) {
  if (!detail) {
    return (
      <div className="space-y-4">
        <Link href={backHref} className="inline-flex items-center gap-1 text-sm font-bold text-orange-600 hover:text-orange-700">
          <ArrowLeft className="h-4 w-4" /> Back
        </Link>
        <PortalEmptyState title="Request not found" message="This direct order request was not found, or you do not have access to it." />
      </div>
    );
  }

  const { request, requesterName, pharmacy, steps, availableActions, bonusOverCap } = detail;

  return (
    <div className="space-y-5 pb-24 md:pb-0">
      <Link href={backHref} className="inline-flex items-center gap-1 text-sm font-bold text-orange-600 hover:text-orange-700">
        <ArrowLeft className="h-4 w-4" /> Back to Direct Orders Approvals
      </Link>

      <PortalSection>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-slate-900 px-4 py-3.5 sm:px-5">
          <h2 className="text-base font-black text-white">
            {request.productName} x {request.qty.toLocaleString("en-US")}
          </h2>
          <span className="text-lg font-black text-orange-400">{money(request.salesValue)}</span>
        </div>
        <div className="p-4 sm:p-5">
          <PortalRecordFields
            fields={[
              { label: "Requester", value: `${requesterName} - ${request.requesterRole}` },
              { label: "Line", value: request.line },
              { label: "Factory price", value: money(request.factoryPriceSnapshot) },
              { label: "Status", value: request.status.replace(/_/g, " ") },
              { label: "Pharmacy", value: pharmacy ? `${pharmacy.pharmacyName} (${pharmacy.phoenixPharmacyCode})` : "-" },
              { label: "Brick / Area", value: pharmacy ? `${pharmacy.brickId ?? "-"} / ${pharmacy.areaCode ?? "-"}` : "-" },
              { label: "Pharmacy address", value: pharmacy?.pharmacyAddress || "-" },
              { label: "Collection date", value: request.collectionDate ?? "-" },
              {
                label: "Bonus",
                value: (
                  <span className={bonusOverCap ? "text-rose-600" : undefined}>
                    {request.bonus.toLocaleString("en-US")}
                    {bonusOverCap ? " - over cap (CEO override)" : ""}
                  </span>
                ),
              },
              { label: "Sales month", value: request.salesMonth ?? "- (set on final approval)" },
            ]}
          />
          {request.bonusOverrideReason ? (
            <p className="mt-3 border-t border-slate-100 pt-3 text-xs text-slate-500">Note: {request.bonusOverrideReason}</p>
          ) : null}
        </div>
      </PortalSection>

      <PortalSection eyebrow="Chain" title="Approval chain">
        <ol className="divide-y divide-slate-100">
          {steps.map((step) => (
            <li key={step.order} className="flex items-center gap-3 px-4 py-3 sm:px-5">
              <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${STEP_TONE[step.status] ?? "bg-slate-300"}`} />
              <span className="w-6 shrink-0 text-xs font-bold text-slate-400">{step.order}</span>
              <span className="min-w-0 flex-1 text-sm font-semibold text-slate-800">
                {step.approverName ?? step.label}
                <span className="ml-2 text-[11px] font-normal text-slate-400">{step.label}</span>
              </span>
              <span className="shrink-0 text-[11px] font-black uppercase tracking-wider text-slate-500">{step.status}</span>
            </li>
          ))}
        </ol>
      </PortalSection>

      <DirectOrderPortalDecisionActions requestId={request.id} actions={availableActions} backHref={backHref} />
    </div>
  );
}
