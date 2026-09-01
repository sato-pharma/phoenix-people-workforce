"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { PLAN_STATUS_NEW, planStatusClass, planStatusLabel } from "@/lib/crm/plan-verification";
import type { PlanSummary } from "@/lib/crm/plan-board";

/**
 * The Verify button and the status word beside it — ONE implementation, two screens.
 *
 * Lifted out of plan-verification-tables.tsx on 2026-09-01, unchanged, when the Reps Weekly Plans
 * tab needed the same control. It is deliberately not imported from that file: everything in there
 * is one "use client" module that also pulls in the sortable-table hook, the XLSX export button and
 * the portal table primitives, so importing a single button from it would drag all of that into the
 * new tab's browser bundle for nothing.
 *
 * Sharing it rather than writing a second one is the point. This is the ONLY control in Phoenix that
 * writes into the customer's CRM; two copies of it is two arming rules, two error messages and two
 * places for one of them to start treating a refusal as a success.
 */

/**
 * TWO CLICKS, ON PURPOSE. This writes into the customer's CRM and emails the medical rep, and
 * neither can be taken back from here — there is no unverify. So the first click arms and the
 * second commits, and the armed state says what is about to happen rather than just "Confirm?".
 * A native `confirm()` dialog was not used because the admin shell has none anywhere else.
 */
export function VerifyButton({ canVerify, plan }: { canVerify: boolean; plan: PlanSummary }) {
  const router = useRouter();
  const [armed, setArmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);

  async function commit() {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const response = await fetch("/api/crm/plan-verification/verify", {
        body: JSON.stringify({ crmPlanId: plan.crmPlanId }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        repNotified?: boolean;
        repNotifyReason?: string | null;
      };
      if (!response.ok) {
        setError(payload.error ?? `The CRM refused the change (HTTP ${response.status}).`);
        setArmed(false);
        return;
      }
      // A verified plan whose rep could not be told is still verified. Saying so beats both hiding
      // it and reporting the whole action as failed.
      if (payload.repNotified === false) {
        setNote(`Verified. The rep could not be notified: ${payload.repNotifyReason ?? "unknown reason"}.`);
      }
      setArmed(false);
      startTransition(() => router.refresh());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The request could not be sent.");
      setArmed(false);
    } finally {
      setBusy(false);
    }
  }

  // A plan that is not pending, and a viewer who may not verify, both render the same thing: the
  // status in words. Hiding the button is UX — the route refuses the POST independently, which is
  // the boundary.
  if (plan.status !== PLAN_STATUS_NEW || !canVerify) {
    return (
      <span className={`text-phx-2xs font-black uppercase tracking-[0.1em] ${planStatusClass(plan.status)}`}>
        {planStatusLabel(plan.status)}
      </span>
    );
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <button
          className={
            armed
              ? "h-8 border border-orange-500 bg-orange-500 px-3 text-phx-2xs font-black uppercase tracking-[0.1em] text-white disabled:opacity-60"
              : "h-8 border border-slate-300 bg-white px-3 text-phx-2xs font-black uppercase tracking-[0.1em] text-slate-700 hover:border-orange-400 disabled:opacity-60"
          }
          disabled={busy || pending}
          onClick={() => {
            if (armed) void commit();
            else setArmed(true);
          }}
          type="button"
        >
          {busy ? "Sending" : armed ? "Confirm — writes to the CRM" : "Verify"}
        </button>
        {armed && !busy ? (
          <button
            className="h-8 px-2 text-phx-2xs font-bold uppercase tracking-[0.1em] text-slate-400 hover:text-slate-700"
            onClick={() => setArmed(false)}
            type="button"
          >
            Cancel
          </button>
        ) : null}
      </div>
      {error ? <p className="text-phx-2xs font-semibold text-rose-700">{error}</p> : null}
      {note ? <p className="text-phx-2xs font-semibold text-amber-700">{note}</p> : null}
    </div>
  );
}
