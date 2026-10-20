"use client";

/**
 * Phoenix CRM — a district sales manager asks for a second or third day of single visits (owner, 2026-10-20:
 * "one per week with no approval … if you need to do the second or the third day maximum, he need to send an
 * approval from his manager"). He asks FIRST, for ONE named date; his regional manager and then the national
 * sales manager above him decide it in the Approvals Hub (the national sales manager alone where there is no
 * regional manager). Once approved, the date holds single visits — planned and logged — on both its halves.
 *
 * Shown under the board's Single visit part and on "My single visits", and to a district manager only: the
 * server answers an empty view to anyone else, and this renders nothing for it.
 */

import { useId, useState } from "react";

import { crmPost, crmUrl, messageOf, useCrmGet } from "@/components/phoenix-crm/api";
import { CrmButton, CrmField, CrmNote, CrmPill, CrmSelect, crmTextareaClassName, type PillTone } from "@/components/phoenix-crm/ui";
import { MANAGER_PLAN_REASON_MAX, type SingleVisitDayAskStatus } from "@/lib/phoenix-crm/manager-plan-rules";
import type { SingleVisitDaysView } from "@/lib/phoenix-crm/view-types";

const DAYS = "/api/phoenix-crm/manager-plans/single-visit-days";

const STATUS_TONE: Record<SingleVisitDayAskStatus, PillTone> = {
  pending: "warn",
  first_approved: "warn",
  approved: "good",
  refused: "bad",
  expired: "neutral",
};

export function ManagerSingleVisitDayAsk({ test, preferDate = null }: { test: boolean; preferDate?: string | null }) {
  const days = useCrmGet<SingleVisitDaysView>(crmUrl(DAYS, { test }), "days");
  const [asking, setAsking] = useState(false);
  const [date, setDate] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dateId = useId();
  const reasonId = useId();
  const view = days.data;
  if (!view || (!view.canAsk && view.asks.length === 0)) return null;

  function open() {
    if (!view) return;
    const preferred = preferDate && view.askable.some((entry) => entry.date === preferDate) ? preferDate : (view.askable[0]?.date ?? "");
    setDate(preferred);
    setReason("");
    setError(null);
    setAsking(true);
  }

  async function send() {
    if (!date) {
      setError("Choose the day you need.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const next = await crmPost<SingleVisitDaysView>(DAYS, { date, reason: reason.trim() || null, test }, "days");
      days.replace(next);
      setAsking(false);
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-w-0 gap-2 border border-slate-200 p-3">
      <p className="text-sm font-black text-slate-900">Another day of single visits</p>
      <p className="break-words text-xs font-medium leading-5 text-slate-500">
        Ask your managers for one named day; writing why is optional. Once they approve it, that day holds single visits — planned and logged — on both its halves.
      </p>
      {view.asks.length > 0 ? (
        <ul className="grid min-w-0 gap-1.5">
          {view.asks.map((ask) => (
            <li className="grid min-w-0 gap-1 border-l-4 border-slate-200 pl-2.5" key={ask.requestId}>
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                <span className="break-words text-sm font-bold text-slate-900">{ask.dateText}</span>
                <CrmPill tone={STATUS_TONE[ask.status]}>{ask.statusLabel}</CrmPill>
              </div>
              {ask.reason ? (
                <p className="break-words text-xs font-medium leading-5 text-slate-600" dir="auto">
                  {ask.reason}
                </p>
              ) : null}
              {ask.decisionNote ? (
                <p className="break-words text-xs font-semibold leading-5 text-slate-700" dir="auto">
                  Note: {ask.decisionNote}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {asking ? (
        <div className="grid min-w-0 gap-3">
          <CrmField htmlFor={dateId} label="Day">
            <CrmSelect id={dateId} onChange={(event) => setDate(event.target.value)} value={date}>
              {view.askable.map((entry) => (
                <option key={entry.date} value={entry.date}>
                  {entry.dateText}
                </option>
              ))}
            </CrmSelect>
          </CrmField>
          <CrmField htmlFor={reasonId} label="Why you need it (optional)">
            <textarea
              className={crmTextareaClassName}
              id={reasonId}
              maxLength={MANAGER_PLAN_REASON_MAX}
              onChange={(event) => setReason(event.target.value)}
              rows={3}
              value={reason}
            />
          </CrmField>
          {error ? <CrmNote tone="bad">{error}</CrmNote> : null}
          <div className="flex min-w-0 flex-wrap gap-2">
            <CrmButton busy={busy} onClick={send} size="sm" variant="primary">
              Send the ask
            </CrmButton>
            <CrmButton disabled={busy} onClick={() => setAsking(false)} size="sm" variant="ghost">
              Cancel
            </CrmButton>
          </div>
        </div>
      ) : view.canAsk && view.askable.length > 0 ? (
        <div>
          <CrmButton onClick={open} size="sm">
            Ask for another day
          </CrmButton>
        </div>
      ) : view.canAsk ? (
        <p className="break-words text-xs font-semibold leading-5 text-slate-500">
          No day is left to ask for: each week holds two more days at most, and only today or a later field day can be asked.
        </p>
      ) : null}
    </div>
  );
}
