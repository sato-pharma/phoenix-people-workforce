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
import {
  buildDirectOrderDetailFields,
  dealFieldLabel,
  formatDealValue,
} from "@/lib/direct-orders/approval-fields";
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

  const { request, distributors, pharmacyHistory, steps, availableActions, bonusOverCap, missingPharmacyPrice } = detail;
  // Same shared field list the admin approval screen renders — see approval-fields.ts for why
  // it lives in the domain rather than being hand-maintained twice.
  const allFields = buildDirectOrderDetailFields(detail);
  const gridFields = allFields.filter((field) => field.layout !== "full");
  const addressField = allFields.find((field) => field.label === "Pharmacy address");

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
        {bonusOverCap || missingPharmacyPrice ? (
          <div className="space-y-1 border-b border-slate-100 bg-amber-50 px-4 py-2.5 sm:px-5">
            {bonusOverCap ? (
              <p className="text-[12px] font-bold text-amber-900">
                Over cap -- this {request.dealType} exceeds its product cap. Flagged for your attention, not blocked.
              </p>
            ) : null}
            {missingPharmacyPrice ? (
              <p className="text-[12px] font-bold text-amber-900">
                No pharmacy price was set for this product -- the value above uses the factory price.
              </p>
            ) : null}
          </div>
        ) : null}
        <div className="p-4 sm:p-5">
          {/* PortalRecordFields wraps by design (break-words). That is the deliberate mobile
              exception to the never-wrap rule: forcing nowrap here would give a phone a
              horizontally-scrolling screen. Desktop tables never wrap; mobile cards do. */}
          <PortalRecordFields
            fields={[
              ...gridFields
                .filter((field) => field.label !== "Pharmacy address")
                .map((field) => ({ label: field.label, value: field.value })),
              {
                label: dealFieldLabel(request),
                value: (
                  <span className={bonusOverCap ? "text-rose-600" : undefined}>
                    {formatDealValue(request)}
                    {bonusOverCap ? " - over cap" : ""}
                  </span>
                ),
              },
            ]}
          />
          {addressField ? (
            <div className="mt-3 border-t border-slate-100 pt-3">
              <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">Pharmacy address</p>
              <p className="mt-0.5 text-sm font-semibold text-slate-800">{addressField.value}</p>
            </div>
          ) : null}
          {/* One row per distributor pair — byte-identical treatment to the distributor block
              on the sibling portal submit page, so this matches the portal's established look. */}
          <div className="mt-3 border-t border-slate-100 pt-3">
            <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">Distributors</p>
            {distributors.length === 0 ? (
              <p className="mt-0.5 text-sm font-semibold text-slate-800">-</p>
            ) : (
              <div className="mt-1.5 space-y-2 rounded border border-slate-100 bg-slate-50 p-3">
                {distributors.map((row) => (
                  <div key={`${row.distributorCode}-${row.customerCode}`} className="space-y-0.5">
                    <div className="text-xs font-bold text-slate-800">
                      {row.distributorName}
                      {row.distributorCode ? ` (${row.distributorCode})` : ""}
                    </div>
                    <div className="text-[11px] text-slate-600">Customer code: {row.customerCode}</div>
                    <div className="text-[11px] text-slate-500">
                      Mapped: {row.mappedBrickName ?? "not mapped"} / {row.mappedAreaName ?? "not mapped"} /{" "}
                      {row.mappedRegionName ?? "not mapped"}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
          {request.bonusOverrideReason ? (
            <p className="mt-3 border-t border-slate-100 pt-3 text-xs text-slate-500">Note: {request.bonusOverrideReason}</p>
          ) : null}
        </div>
      </PortalSection>

      {/* What this pharmacy normally takes. The request being decided is excluded, so the
          baseline never contains the number under judgement. Card-per-bucket on a phone,
          matching the portal's list idiom rather than forcing a wide table onto it. */}
      <PortalSection eyebrow="Context" title="Pharmacy history">
        <div className="p-4 sm:p-5">
          {pharmacyHistory.length === 0 ? (
            <p className="text-sm text-slate-500">
              No other direct orders recorded for this pharmacy yet - this is its first.
            </p>
          ) : (
            <div className="space-y-2">
              <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                By month, product and distributor - excludes this request
              </p>
              {pharmacyHistory.map((row) => (
                <div
                  key={`${row.month}-${row.productCode}-${row.distributorCode}`}
                  className="rounded border border-slate-100 bg-slate-50 p-3"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-xs font-black text-slate-900">
                      {row.month}
                      {row.monthIsProvisional ? (
                        <span className="ml-1.5 text-[10px] font-bold uppercase text-amber-700">not final</span>
                      ) : null}
                    </span>
                    <span className="text-xs font-black text-slate-900">{money(row.salesValue)}</span>
                  </div>
                  <div className="mt-0.5 text-[11px] font-bold text-slate-700">
                    {row.productName} ({row.productCode})
                  </div>
                  <div className="text-[11px] text-slate-500">
                    {row.distributorName}
                    {row.distributorCode ? ` (${row.distributorCode})` : ""}
                  </div>
                  <div className="mt-1 text-[11px] text-slate-600">
                    {row.orders} order{row.orders === 1 ? "" : "s"} - qty {row.qty.toLocaleString("en-US")} - bonus{" "}
                    {row.bonus.toLocaleString("en-US")}
                  </div>
                </div>
              ))}
            </div>
          )}
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
