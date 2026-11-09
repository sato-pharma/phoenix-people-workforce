"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { planStatusClass, planStatusLabel } from "@/lib/crm/plan-verification";
import type { PlanSummary } from "@/lib/crm/plan-board";
import type { PhoenixCrmPlanStatus } from "@/lib/phoenix-crm/types";

/**
 * The plan's Approve button and the status word beside it — ONE implementation, two screens.
 *
 * Lifted out of plan-verification-tables.tsx on 2026-09-01 when the Reps Weekly Plans tab needed the
 * same control. It is deliberately not imported from that file: everything in there is one "use
 * client" module that also pulls in the sortable-table hook, the XLSX export button and the portal
 * table primitives, so importing a single button from it would drag all of that into the tab's
 * browser bundle for nothing.
 *
 * iReports360 was retired on 6 November 2026, and the Verify and Unverify that wrote into it went with
 * it. An old-CRM plan (positive id) is read-only now: its status in words, as the old CRM last held it.
 * A plan filed in Phoenix CRM (negative id) is approved through Phoenix CRM's own decide route, the one
 * the Team tab posts to (owner, 2026-11-06: "phx crm replaced the old crm so any module was wired with
 * old crm must wire with phx crm"). Approve only: a return carries a note and a day, which the Team tab
 * asks for.
 */

/** A Phoenix plan's status in words, and the colour it is printed in. */
const PHOENIX_STATUS: Record<PhoenixCrmPlanStatus, { className: string; words: string }> = {
  approved: { className: "text-emerald-700", words: "Approved in Phoenix" },
  draft: { className: "text-slate-500", words: "Draft, not sent" },
  returned: { className: "text-rose-700", words: "Returned to the rep" },
  submitted: { className: "text-amber-700", words: "Sent, awaiting approval" },
};

/**
 * TWO CLICKS, ON PURPOSE. The first click arms and the second commits, and the armed state says what
 * is about to happen rather than just "Confirm?", on a board where the plan under the cursor changes
 * with every click of the rep picker. A native `confirm()` dialog was not used because the admin shell
 * has none anywhere else.
 *
 * Hiding the button is UX. The decide route asks `phoenix_crm:approve` again, re-reads the plan, checks
 * the viewer reviews that territory and refuses a stale version — that is the boundary, and its own
 * refusal is what the screen shows.
 */
export function PlanApproveButton({ canApprove, plan }: { canApprove: boolean; plan: PlanSummary }) {
  const router = useRouter();
  const [armed, setArmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);

  const phoenixPlan = plan.crmPlanId < 0;
  const phoenixStatus = phoenixPlan ? plan.phoenixStatus : undefined;
  const approvable =
    canApprove &&
    phoenixStatus === "submitted" &&
    typeof plan.phoenixPlanId === "string" &&
    typeof plan.phoenixVersion === "number";

  async function commit() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/phoenix-crm/plans/decide", {
        body: JSON.stringify({ action: "approve", expectedVersion: plan.phoenixVersion, planId: plan.phoenixPlanId }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => ({}))) as { message?: string };
      if (!response.ok) {
        setError(payload.message ?? `Phoenix refused the approval (HTTP ${response.status}).`);
      }
      setArmed(false);
      // A refusal is often a plan that moved on (sent again, or decided by someone else), so the board
      // is re-read either way and the status beside the message is the plan's current one.
      startTransition(() => router.refresh());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The request could not be sent.");
      setArmed(false);
    } finally {
      setBusy(false);
    }
  }

  if (!approvable) {
    const words = phoenixStatus ? PHOENIX_STATUS[phoenixStatus] : null;
    return (
      <div className="space-y-1">
        {words ? (
          <span className={`text-phx-sm font-black uppercase tracking-[0.1em] ${words.className}`}>{words.words}</span>
        ) : (
          <span className={`text-phx-sm font-black uppercase tracking-[0.1em] ${planStatusClass(plan.status)}`}>
            {planStatusLabel(plan.status)}
          </span>
        )}
        {error ? <p className="text-phx-sm font-semibold text-rose-700">{error}</p> : null}
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <button
          className={
            armed
              ? "h-8 border border-orange-500 bg-orange-500 px-3 text-phx-sm font-black uppercase tracking-[0.1em] text-white disabled:opacity-60"
              : "h-8 border border-slate-300 bg-white px-3 text-phx-sm font-black uppercase tracking-[0.1em] text-slate-700 hover:border-orange-400 disabled:opacity-60"
          }
          disabled={busy || pending}
          onClick={() => {
            if (armed) void commit();
            else setArmed(true);
          }}
          type="button"
        >
          {busy ? "Sending" : armed ? "Confirm — approves the week in Phoenix" : "Approve"}
        </button>
        {armed && !busy ? (
          <button
            className="h-8 px-2 text-phx-sm font-bold uppercase tracking-[0.1em] text-slate-400 hover:text-slate-700"
            onClick={() => setArmed(false)}
            type="button"
          >
            Cancel
          </button>
        ) : null}
      </div>
      {error ? <p className="text-phx-sm font-semibold text-rose-700">{error}</p> : null}
    </div>
  );
}
