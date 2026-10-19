"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";

import { adminPanelClassName, adminPanelHeaderClassName, adminSoftPanelClassName } from "@/components/admin/admin-design-tokens";
import type { StuckApprovalManagerOption } from "@/lib/approvals-hub/service";
import type { WeeklyPlanManagerGapRecord } from "@/lib/weekly-planning/drift-check";
import type { ExcuseManagerGapRecord } from "@/lib/excuses/drift-check";
import { describeDirectOrderBasketUnits } from "@/lib/direct-orders/basket-label";
import type { StrandedDirectOrderRow } from "@/lib/direct-orders/service";
import type { StrandedVacationRow } from "@/lib/vacation/service";
import {
  phxButtonDangerClassName,
  phxFieldClassName,
  phxSelectClassName,
} from "@/components/ui/form-tokens";
// A form-token override goes through cn(), never a template literal: a template concatenates
// without tailwind-merging, so the token's own h-10/px-3/w-* wins and the override renders as
// nothing. Pinned by tests/form-design-system.test.ts.
import { cn } from "@/lib/utils";
// Dates come from the shared Cairo formatter and nothing else. A bespoke
// `toLocaleDateString("en-GB", { month: "short" })` in a "use client" file asks the READER's ICU
// build for the month abbreviation, and CLDR 42 renamed en-GB September from "Sep" to "Sept" — so
// the server renders one spelling, an older browser hydrates the other, and that is React error
// #418 for every reader, in September only. Pinned repo-wide by
// tests/react-418-hydration-safe-text.test.ts.
import { cairoDate } from "@/lib/format/cairo-datetime";

type StuckApprovalsPanelProps = {
  weeklyPlans: WeeklyPlanManagerGapRecord[];
  excuses: ExcuseManagerGapRecord[];
  strandedDirectOrders: StrandedDirectOrderRow[];
  canCloseStrandedDirectOrders: boolean;
  strandedVacations: StrandedVacationRow[];
  managerOptions: StuckApprovalManagerOption[];
};

/** EGP with separators and two decimals — never an abbreviated or rounded figure. */
const egp = new Intl.NumberFormat("en-EG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// A single reassignable row: current (dead) approver + a picker for the new active manager. The
// row calls the module's reassign route — reassignment only, it never decides the request.
function ReassignRow(props: {
  primary: string;
  secondary: string;
  currentApprover: string;
  endpoint: string;
  managerOptions: StuckApprovalManagerOption[];
}) {
  const router = useRouter();
  const [newManagerHrId, setNewManagerHrId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function reassign() {
    if (!newManagerHrId) {
      setError("Choose a new manager first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(props.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newManagerHrId }),
      });
      const data = (await res.json().catch(() => ({}))) as { success?: boolean; message?: string };
      if (!res.ok || !data.success) {
        setError(data.message || "Could not reassign this request. It may have already moved on.");
        setBusy(false);
        return;
      }
      setDone(true);
      router.refresh();
    } catch {
      setError("Network error. Please try again.");
      setBusy(false);
    }
  }

  return (
    <div className={`${adminSoftPanelClassName} px-4 py-3`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          {/* `primary` is "<employee record name> (<HR id>)", so it is the longest line here. */}
          <p className="break-words text-sm font-bold text-slate-900">{props.primary}</p>
          <p className="break-words text-xs text-slate-500">{props.secondary}</p>
          <p className="mt-0.5 text-xs text-rose-600">Stuck on: {props.currentApprover}</p>
        </div>
        {done ? (
          <p className="text-sm font-bold text-emerald-600">Reassigned ✓</p>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={newManagerHrId}
              onChange={(e) => setNewManagerHrId(e.target.value)}
              disabled={busy}
              className={`${phxSelectClassName} max-w-[220px]`}
            >
              <option value="">Select new manager…</option>
              {props.managerOptions.map((option) => (
                <option key={option.hrId} value={option.hrId}>
                  {option.name} ({option.hrId})
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={reassign}
              disabled={busy}
              className="bg-orange-500 px-4 py-1.5 text-sm font-bold text-white hover:bg-orange-600 disabled:opacity-60"
            >
              {busy ? "Reassigning…" : "Reassign"}
            </button>
          </div>
        )}
      </div>
      {error ? <p className="mt-2 text-sm font-semibold text-rose-600">{error}</p> : null}
    </div>
  );
}

/**
 * One stranded direct order: everything needed to judge it, a reason box, and a close button.
 *
 * This row is NOT a ReassignRow in another colour, and the copy says so. The stuck actor here is
 * the REQUESTER, not an approver: a return is a question addressed to the person who raised the
 * order, so once they leave nobody can answer it. Re-addressing it to a live manager would hand
 * them a money edit — a resubmit reprices on today's basis and resumes at the rung that returned
 * it — so the remedy is to retire the dead question. That decides the request, which is why this
 * one asks for a written reason and wears the destructive button.
 */
function CloseStrandedOrderRow(props: { order: StrandedDirectOrderRow }) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const { order } = props;

  async function close() {
    if (!reason.trim()) {
      setError("Say why this order is being closed — it is the only record of the decision.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/direct-orders/${encodeURIComponent(order.id)}/close-orphaned`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason.trim() }),
      });
      const data = (await res.json().catch(() => ({}))) as { success?: boolean; message?: string };
      if (!res.ok || !data.success) {
        setError(data.message || "Could not close this order. It may have already moved on.");
        setBusy(false);
        return;
      }
      setDone(true);
      router.refresh();
    } catch {
      setError("Network error. Please try again.");
      setBusy(false);
    }
  }

  return (
    <div className={`${adminSoftPanelClassName} px-4 py-3`}>
      <div className="min-w-0">
        <p className="break-words text-sm font-bold text-slate-900">{order.pharmacyName}</p>
        <p className="break-words text-xs text-slate-500">
          {describeDirectOrderBasketUnits(order, order.items)} · {egp.format(order.salesValue)} EGP
        </p>
        <p className="mt-0.5 break-words text-xs text-rose-600">
          Raised by {order.requesterName}, who is {(order.requesterEmploymentStatus ?? "no longer active").replace(/_/g, " ")}
          {" — "}nobody can answer the return
        </p>
        <p className="mt-0.5 break-words text-xs text-slate-500">
          {order.returnedAt
            ? `Sent back ${cairoDate(order.returnedAt)}, ${order.daysWaiting} days ago`
            : "Sent back on a date the event log does not record"}
          {/* The approver's own words, NEVER truncated — it is the question that went unanswered. */}
          {order.returnReason ? `: “${order.returnReason}”` : " with no reason recorded"}
        </p>
      </div>
      {done ? (
        <p className="mt-2 text-sm font-bold text-slate-900">Closed ✓</p>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            disabled={busy}
            placeholder="Why is this being closed?"
            aria-label={`Reason for closing the ${order.pharmacyName} order`}
            className={cn(phxFieldClassName, "w-full sm:w-auto sm:min-w-[260px] sm:flex-1")}
          />
          <button
            type="button"
            onClick={close}
            disabled={busy}
            className={cn(phxButtonDangerClassName, "w-full justify-center sm:w-auto")}
          >
            {busy ? "Closing…" : "Close order"}
          </button>
        </div>
      )}
      {error ? <p className="mt-2 text-sm font-semibold text-rose-600">{error}</p> : null}
    </div>
  );
}

/**
 * One stranded vacation request: who, which dates, the approver's own words, a reason box and a
 * close button. Like the direct-order row this DECIDES the request (it ends it), so it asks for a
 * written reason and wears the destructive button — unlike ReassignRow, which only changes who owns
 * a pending step. Nothing is deleted and nothing is rejected: the request stays on record as Closed.
 */
function CloseStrandedVacationRow(props: { vacation: StrandedVacationRow }) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const { vacation } = props;

  async function close() {
    if (!reason.trim()) {
      setError("Say why this request is being closed — it is the only record of the decision.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/vacations/requests/${encodeURIComponent(vacation.id)}/close-orphaned`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason.trim() }),
      });
      const data = (await res.json().catch(() => ({}))) as { success?: boolean; message?: string };
      if (!res.ok || !data.success) {
        setError(data.message || "Could not close this request. It may have already moved on.");
        setBusy(false);
        return;
      }
      setDone(true);
      router.refresh();
    } catch {
      setError("Network error. Please try again.");
      setBusy(false);
    }
  }

  return (
    <div className={`${adminSoftPanelClassName} px-4 py-3`}>
      <div className="min-w-0">
        <p className="break-words text-sm font-bold text-slate-900">
          {vacation.employeeName} ({vacation.employeeHrId})
        </p>
        <p className="break-words text-xs text-slate-500">
          {vacation.vacationType} · {vacation.startDate} to {vacation.endDate} · {vacation.requestCode}
        </p>
        <p className="mt-0.5 break-words text-xs text-rose-600">
          {vacation.employeeName} is {(vacation.employeeEmploymentStatus ?? "no longer active").replace(/_/g, " ")}
          {" — "}nobody can resubmit it
        </p>
        <p className="mt-0.5 break-words text-xs text-slate-500">
          {vacation.returnedAt ? `Sent back ${cairoDate(vacation.returnedAt)}` : "Sent back on a date the request does not record"}
          {/* The approver's own words, NEVER truncated — it is the question that went unanswered. */}
          {vacation.returnReason ? `: “${vacation.returnReason}”` : " with no reason recorded"}
        </p>
      </div>
      {done ? (
        <p className="mt-2 text-sm font-bold text-slate-900">Closed ✓</p>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            disabled={busy}
            placeholder="Why is this being closed?"
            aria-label={`Reason for closing ${vacation.employeeName}'s vacation request`}
            className={cn(phxFieldClassName, "w-full sm:w-auto sm:min-w-[260px] sm:flex-1")}
          />
          <button
            type="button"
            onClick={close}
            disabled={busy}
            className={cn(phxButtonDangerClassName, "w-full justify-center sm:w-auto")}
          >
            {busy ? "Closing…" : "Close request"}
          </button>
        </div>
      )}
      {error ? <p className="mt-2 text-sm font-semibold text-rose-600">{error}</p> : null}
    </div>
  );
}

function Section(props: { title: string; count: number; children: ReactNode }) {
  return (
    <section className={adminPanelClassName}>
      <header className={`flex items-center justify-between ${adminPanelHeaderClassName} px-4 py-2.5`}>
        <h3 className="text-phx-xs font-black uppercase tracking-[0.14em] text-white">{props.title}</h3>
        <span className="text-phx-xs font-bold text-slate-300">{props.count}</span>
      </header>
      <div className="space-y-2 p-3">{props.children}</div>
    </section>
  );
}

export function StuckApprovalsPanel({
  weeklyPlans,
  excuses,
  strandedDirectOrders,
  canCloseStrandedDirectOrders,
  strandedVacations,
  managerOptions,
}: StuckApprovalsPanelProps) {
  const empty =
    weeklyPlans.length === 0 &&
    excuses.length === 0 &&
    strandedDirectOrders.length === 0 &&
    strandedVacations.length === 0;
  if (empty) {
    return (
      <section className={`${adminSoftPanelClassName} px-4 py-8 text-center`}>
        <p className="text-sm font-bold text-slate-900">No stuck approvals.</p>
        <p className="mt-1 text-xs text-slate-500">
          Every pending plan and excuse currently has an active approver, and no returned direct
          order is waiting on someone who has left. This surface fills in when somebody resigns
          mid-workflow.
        </p>
        {canCloseStrandedDirectOrders ? null : (
          <p className="mt-2 text-xs text-slate-400">
            Stranded direct orders and vacation requests are listed for a Super Admin only, because
            closing one decides the request rather than re-routing it.
          </p>
        )}
      </section>
    );
  }

  return (
    <div className="space-y-5">
      <Section title="Weekly / Monthly plans" count={weeklyPlans.length}>
        {weeklyPlans.length === 0 ? (
          <p className="px-1 py-2 text-xs text-slate-500">No stuck plans.</p>
        ) : (
          weeklyPlans.map((plan) => (
            <ReassignRow
              key={plan.planId}
              primary={`${plan.employeeName} (${plan.employeeHrId})`}
              secondary={`Status: ${plan.status.replace(/_/g, " ")}`}
              currentApprover={plan.managerName || plan.managerHrId || "no manager on record"}
              endpoint={`/api/weekly-plans/${encodeURIComponent(plan.planId)}/reassign`}
              managerOptions={managerOptions}
            />
          ))
        )}
      </Section>

      <Section title="Excuses" count={excuses.length}>
        {excuses.length === 0 ? (
          <p className="px-1 py-2 text-xs text-slate-500">No stuck excuses.</p>
        ) : (
          excuses.map((excuse) => (
            <ReassignRow
              key={excuse.requestId}
              primary={`${excuse.employeeName} (${excuse.employeeHrId})`}
              secondary={`Excuse date: ${excuse.excuseDate ?? "n/a"}`}
              currentApprover={excuse.managerName || excuse.managerHrId || "no manager on record"}
              endpoint={`/api/excuses/${encodeURIComponent(excuse.requestId)}/reassign`}
              managerOptions={managerOptions}
            />
          ))
        )}
      </Section>

      {/* Super Admin only, so HR never sees a section it cannot act on. */}
      {canCloseStrandedDirectOrders ? (
        <Section title="Direct orders — nobody can answer the return" count={strandedDirectOrders.length}>
          {strandedDirectOrders.length === 0 ? (
            <p className="px-1 py-2 text-xs text-slate-500">No stranded direct orders.</p>
          ) : (
            <>
              <p className="px-1 pb-1 text-xs leading-relaxed text-slate-500">
                These were sent back for correction, and the manager who raised each one has left.
                A return can only be answered by the person who raised the order, so none of them
                can move. Closing one retires it; it is not a rejection, and it changes no sales
                figure — nothing here was ever approved or booked to a month. If the volume is
                still wanted, it is raised fresh by whoever holds that territory now, at the
                discount the approver asked for.
              </p>
              {strandedDirectOrders.map((order) => (
                <CloseStrandedOrderRow key={order.id} order={order} />
              ))}
            </>
          )}
        </Section>
      ) : null}

      {/* Super Admin only, for the same reason: closing decides the request. */}
      {canCloseStrandedDirectOrders ? (
        <Section title="Vacation requests — nobody can resubmit" count={strandedVacations.length}>
          {strandedVacations.length === 0 ? (
            <p className="px-1 py-2 text-xs text-slate-500">No stranded vacation requests.</p>
          ) : (
            <>
              <p className="px-1 pb-1 text-xs leading-relaxed text-slate-500">
                These were sent back to the employee for editing, and the employee has since left.
                Only the employee who submitted a request can resubmit it, so none of them can move.
                Closing one retires it and keeps it on record as Closed; it is not a rejection, no
                approver is counted as having turned it down, and no leave balance changes because
                nothing here was ever approved.
              </p>
              {strandedVacations.map((vacation) => (
                <CloseStrandedVacationRow key={vacation.id} vacation={vacation} />
              ))}
            </>
          )}
        </Section>
      ) : null}
    </div>
  );
}
