"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import {
  PLAN_STATUS_NEW,
  PLAN_STATUS_SUPERVISOR_VERIFIED,
  planStatusClass,
  planStatusLabel,
  type PlanVerificationAction,
} from "@/lib/crm/plan-verification";
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
 * The words on the button, and the sentence its armed state shows, for each direction.
 *
 * UNVERIFY IS ARMED EXACTLY AS HEAVILY AS VERIFY, and that is not symmetry for its own sake. It is
 * the same write, to the same customer's CRM, seen by the same people, and it also emails the rep —
 * so an "undo" that took one click would be the easier of the two to fire by accident on a board
 * where the plan under the cursor changes with every click of the rep picker.
 */
const WORDING: Record<PlanVerificationAction, { armed: string; idle: string; past: string }> = {
  unverify: {
    armed: "Confirm — clears it in the CRM",
    idle: "Unverify",
    past: "Unverified",
  },
  verify: {
    armed: "Confirm — writes to the CRM",
    idle: "Verify",
    past: "Verified",
  },
};

/**
 * TWO CLICKS, ON PURPOSE. This writes into the customer's CRM and emails the medical rep. So the
 * first click arms and the second commits, and the armed state says what is about to happen rather
 * than just "Confirm?". A native `confirm()` dialog was not used because the admin shell has none
 * anywhere else.
 *
 * ONE BUTTON, TWO DIRECTIONS, decided by the plan's own status — the owner, 2026-09-01: "I want to
 * be able to verify and unverify from Phoenix." A pending plan offers Verify; a plan this feature
 * verified offers Unverify. They are never both on screen, because a plan is only ever in one of
 * those states and offering the impossible one would invite a click that the route then refuses.
 *
 * A PLAN AN AREA MANAGER SIGNED OFFERS NEITHER. Phoenix never wrote that signature, so it is not
 * Phoenix's to take back; the status is printed in words instead, exactly as before. The rule lives
 * in `decidePlanVerification` and the route enforces it independently — this is the UI agreeing
 * with the boundary, not the boundary itself.
 */
export function VerifyButton({ canVerify, plan }: { canVerify: boolean; plan: PlanSummary }) {
  const router = useRouter();
  const [armed, setArmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);

  // Which direction this plan can move, or null when it can move neither.
  const action: PlanVerificationAction | null =
    plan.status === PLAN_STATUS_NEW
      ? "verify"
      : plan.status === PLAN_STATUS_SUPERVISOR_VERIFIED
        ? "unverify"
        : null;

  async function commit(direction: PlanVerificationAction) {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const response = await fetch("/api/crm/plan-verification/verify", {
        body: JSON.stringify({ action: direction, crmPlanId: plan.crmPlanId }),
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
      // A change whose rep could not be told still happened in the CRM. Saying so beats both hiding
      // it and reporting the whole action as failed.
      if (payload.repNotified === false) {
        setNote(
          `${WORDING[direction].past}. The rep could not be notified: ${payload.repNotifyReason ?? "unknown reason"}.`,
        );
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

  // A plan that can move in neither direction, and a viewer who may not act, both render the same
  // thing: the status in words. Hiding the button is UX — the route refuses the POST independently,
  // which is the boundary.
  if (action === null || !canVerify) {
    return (
      <span className={`text-phx-2xs font-black uppercase tracking-[0.1em] ${planStatusClass(plan.status)}`}>
        {planStatusLabel(plan.status)}
      </span>
    );
  }

  const words = WORDING[action];
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        {/* An unverify keeps the same shape but takes the rose accent rather than the orange one.
            Orange is this shell's "go" colour and sits on every primary action; a button that
            REMOVES a signature should not be wearing it, or the two directions become one habit. */}
        <button
          className={
            armed
              ? action === "unverify"
                ? "h-8 border border-rose-600 bg-rose-600 px-3 text-phx-2xs font-black uppercase tracking-[0.1em] text-white disabled:opacity-60"
                : "h-8 border border-orange-500 bg-orange-500 px-3 text-phx-2xs font-black uppercase tracking-[0.1em] text-white disabled:opacity-60"
              : action === "unverify"
                ? "h-8 border border-slate-300 bg-white px-3 text-phx-2xs font-black uppercase tracking-[0.1em] text-slate-700 hover:border-rose-400 disabled:opacity-60"
                : "h-8 border border-slate-300 bg-white px-3 text-phx-2xs font-black uppercase tracking-[0.1em] text-slate-700 hover:border-orange-400 disabled:opacity-60"
          }
          disabled={busy || pending}
          onClick={() => {
            if (armed) void commit(action);
            else setArmed(true);
          }}
          type="button"
        >
          {busy ? "Sending" : armed ? words.armed : words.idle}
        </button>
        {/* The status stays visible beside an Unverify button. Without it the only word on screen
            would be the verb, and "Unverify" alone reads as an instruction rather than as an offer
            to change a state the reader can see. */}
        {action === "unverify" && !armed ? (
          <span className={`text-phx-2xs font-black uppercase tracking-[0.1em] ${planStatusClass(plan.status)}`}>
            {planStatusLabel(plan.status)}
          </span>
        ) : null}
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
