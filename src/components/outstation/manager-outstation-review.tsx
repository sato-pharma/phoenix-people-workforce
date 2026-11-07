"use client";

// The directive above is REQUIRED here, and is not a style choice. This file imports four plain
// values — TONE_CLASSES, buildStages, headlineStatus, money — from my-expense-submissions.tsx,
// which carries the same directive, and it CALLS three of them while rendering. Next turns every
// export of a client module into a client reference, so without this the server would receive
// markers rather than functions and the page would throw "Attempted to call headlineStatus() from
// the server but headlineStatus is on the client" — the identical failure that took
// /admin/plan-verification down on 2026-08-29. The parent
// (app/employee-portals/outstation-review/[id]/page.tsx) IS a server component and passes one
// serialisable prop, so a client boundary here costs nothing.
//
// Found by tests/rsc-client-function-props.test.ts while fixing the plan-verification instance of
// the same defect. Never observed failing in production, because nothing reaches the log until a
// manager actually opens the page — an unexercised path is untested, not proven.

import { CalendarDays, CircleDollarSign, MapPin, Route, Wallet } from "lucide-react";

import {
  Fact,
  SectionTitle,
  TONE_CLASSES,
  buildStages,
  headlineStatus,
  money,
} from "@/components/outstation/my-expense-submissions";
import { formatPhoenixLongDate } from "@/lib/i18n/format";
import { normalizeTransportation } from "@/lib/outstation/expense-taxonomy";
import type { ManagerOutstationSubmissionView } from "@/lib/outstation/service";

/**
 * A manager's read-only view of ONE direct/indirect report's outstation submission — reached
 * only from the "request submitted" notification (see notifyOutstationSubmitted in
 * src/lib/outstation/service.ts). Deliberately built on the SAME stage/status logic as the
 * employee's own MyExpenseSubmissions view (buildStages/headlineStatus, imported rather than
 * re-derived) so the two never disagree about what state a trip is in.
 *
 * Owner rule: no approve/reject control belongs here. Outstation claims auto-approve on
 * submission; only Super Admin/HR review or reject afterward in the Expense Command Center. This
 * page exists to answer "what did he submit," not to add a second approval surface.
 */
export function ManagerOutstationReview({
  submission,
}: {
  submission: ManagerOutstationSubmissionView;
}) {
  const headline = headlineStatus(submission);
  const stages = buildStages(submission);
  const decision = submission.decision;

  return (
    <div className="space-y-5">
      <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-[0_1px_3px_rgba(15,23,42,0.08)] sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-phx-2xs font-bold uppercase tracking-wider text-slate-500">
              {submission.employeeName} · {submission.employeeHrId}
            </p>
            <h2 className="mt-1 text-lg font-black text-slate-900">{submission.destination}</h2>
          </div>
          <span
            className={`inline-flex flex-shrink-0 items-center rounded-full px-3 py-1 text-xs font-bold ${TONE_CLASSES[headline.tone]}`}
          >
            {headline.label}
          </span>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Fact
            icon={<CalendarDays className="h-3.5 w-3.5" />}
            label="Trip start"
            value={formatPhoenixLongDate(submission.tripStartDate)}
          />
          <Fact
            icon={<CalendarDays className="h-3.5 w-3.5" />}
            label="Trip end"
            value={formatPhoenixLongDate(submission.tripEndDate)}
          />
          <Fact icon={<Route className="h-3.5 w-3.5" />} label="Transportation" value={normalizeTransportation(submission.transportationType, null, null) || submission.transportationType} />
          <Fact icon={<MapPin className="h-3.5 w-3.5" />} label="Origin" value={submission.origin} />
        </div>

        {submission.notes ? (
          <p className="mt-4 rounded-md bg-slate-50 p-3 text-sm text-slate-700">{submission.notes}</p>
        ) : null}
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-[0_1px_3px_rgba(15,23,42,0.08)] sm:p-6">
        <SectionTitle>Amount</SectionTitle>
        <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-3">
          <Fact icon={<Wallet className="h-3.5 w-3.5" />} label="Claimed" value={money(submission.claimedTotalAmount)} />
          <Fact
            icon={<CircleDollarSign className="h-3.5 w-3.5" />}
            label="Approved"
            value={decision?.approvedAmount != null ? money(decision.approvedAmount) : "Pending"}
          />
          <Fact label="Allowance" value={money(submission.allowanceAmount)} />
        </div>
        {decision?.hrComment ? (
          <p className="mt-4 text-sm text-slate-600">
            <span className="font-bold text-slate-900">HR comment: </span>
            {decision.hrComment}
          </p>
        ) : null}
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-[0_1px_3px_rgba(15,23,42,0.08)] sm:p-6">
        <SectionTitle>Status</SectionTitle>
        <ol className="mt-4 space-y-3">
          {stages.map((stage) => (
            <li key={stage.key} className="flex items-start gap-3">
              <span
                className={`mt-1 h-2.5 w-2.5 flex-shrink-0 rounded-full ${
                  stage.state === "done"
                    ? "bg-emerald-500"
                    : stage.state === "current"
                      ? "bg-amber-500"
                      : "bg-slate-300"
                }`}
              />
              <div className="min-w-0">
                <p className="text-sm font-bold text-slate-900">{stage.label}</p>
                <p className="text-phx-md text-slate-500">{stage.detail}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <p className="rounded-md border border-slate-200 bg-slate-50 p-3 text-phx-md text-slate-500">
        Read-only summary. Outstation claims auto-approve on submission — only a Super Admin can
        review, approve, or reject one afterward in the Expense Command Center.
      </p>
    </div>
  );
}
