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

import { adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";
import {
  LANDING_INK,
  LANDING_NAVY_TILE,
  LandingFigure,
  LandingNavyBoard,
} from "@/components/employee-portal/landing-kit";
import {
  Fact,
  STATUS_TEXT_CLASS,
  SectionTitle,
  TONE_CLASSES,
  buildStages,
  headlineStatus,
  money,
} from "@/components/outstation/my-expense-submissions";
import { formatPhoenixLongDate } from "@/lib/i18n/format";
import { cn } from "@/lib/utils";
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
  const sheet = `border border-slate-200 bg-white p-4 sm:p-5 ${adminSoftDepthClassName}`;
  const tile = `relative flex min-w-0 flex-col border border-white/[0.08] p-3 pl-3.5 ${LANDING_NAVY_TILE}`;

  return (
    <div className="space-y-3">
      <section className={sheet}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="break-words text-phx-xs font-bold uppercase tracking-[0.08em] text-slate-500">
              <span dir="auto">{submission.employeeName}</span> · {submission.employeeHrId}
            </p>
            <h2 className={`mt-1 break-words text-lg font-bold leading-tight ${LANDING_INK}`} dir="auto">
              {submission.destination}
            </h2>
          </div>
          <span className={cn(STATUS_TEXT_CLASS, TONE_CLASSES[headline.tone], "shrink-0")}>{headline.label}</span>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-4 border-t border-slate-200 pt-4 sm:grid-cols-4">
          <Fact
            icon={<CalendarDays aria-hidden="true" className="h-3.5 w-3.5" />}
            label="Trip start"
            value={formatPhoenixLongDate(submission.tripStartDate)}
          />
          <Fact
            icon={<CalendarDays aria-hidden="true" className="h-3.5 w-3.5" />}
            label="Trip end"
            value={formatPhoenixLongDate(submission.tripEndDate)}
          />
          <Fact icon={<Route aria-hidden="true" className="h-3.5 w-3.5" />} label="Transportation" value={normalizeTransportation(submission.transportationType, null, null) || submission.transportationType} />
          <Fact icon={<MapPin aria-hidden="true" className="h-3.5 w-3.5" />} label="Origin" value={submission.origin} />
        </div>

        {submission.notes ? (
          <p className="mt-4 break-words border-l-2 border-slate-300 pl-3 text-sm text-slate-700" dir="auto">
            {submission.notes}
          </p>
        ) : null}
      </section>

      {/* The page's one navy board: the three money figures, tabular. */}
      <LandingNavyBoard label="Amount">
        <div className="@container">
          <div className="grid grid-cols-1 gap-2 @xl:grid-cols-3">
            <div className={tile}>
              <span aria-hidden="true" className="absolute inset-y-0 left-0 w-0.5 bg-white/30" />
              <p className="flex items-center gap-1.5 text-phx-xs font-bold uppercase tracking-[0.08em] text-white/65">
                <Wallet aria-hidden="true" className="h-3.5 w-3.5" />
                Claimed
              </p>
              <div className="mt-1.5">
                <LandingFigure onNavy size="md">{money(submission.claimedTotalAmount)}</LandingFigure>
              </div>
            </div>
            <div className={tile}>
              <span aria-hidden="true" className="absolute inset-y-0 left-0 w-0.5 bg-emerald-400" />
              <p className="flex items-center gap-1.5 text-phx-xs font-bold uppercase tracking-[0.08em] text-white/65">
                <CircleDollarSign aria-hidden="true" className="h-3.5 w-3.5" />
                Approved
              </p>
              <div className="mt-1.5">
                <LandingFigure onNavy size="md" tone="text-emerald-300">
                  {decision?.approvedAmount != null ? money(decision.approvedAmount) : "Pending"}
                </LandingFigure>
              </div>
            </div>
            <div className={tile}>
              <span aria-hidden="true" className="absolute inset-y-0 left-0 w-0.5 bg-white/30" />
              <p className="text-phx-xs font-bold uppercase tracking-[0.08em] text-white/65">Allowance</p>
              <div className="mt-1.5">
                <LandingFigure onNavy size="md">{money(submission.allowanceAmount)}</LandingFigure>
              </div>
            </div>
          </div>
        </div>
        {decision?.hrComment ? (
          <p className="break-words px-1.5 pb-1 pt-2.5 text-phx-sm text-white/70">
            <span className="font-bold text-white">HR comment: </span>
            <span dir="auto">{decision.hrComment}</span>
          </p>
        ) : null}
      </LandingNavyBoard>

      <section className={sheet}>
        <SectionTitle>Status</SectionTitle>
        <ol className="mt-3 space-y-3">
          {stages.map((stage) => (
            <li key={stage.key} className="flex items-start gap-3">
              <span
                aria-hidden="true"
                className={cn(
                  "mt-1 h-2.5 w-2.5 shrink-0",
                  stage.state === "done"
                    ? "bg-emerald-500"
                    : stage.state === "current"
                      ? "border-2 border-amber-500 bg-white"
                      : "border border-slate-300 bg-white",
                )}
              />
              <div className="min-w-0">
                <p className={`text-sm font-bold ${LANDING_INK}`}>{stage.label}</p>
                <p className="break-words text-phx-md text-slate-500">{stage.detail}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <p className="border-l-2 border-slate-300 pl-3 text-phx-md text-slate-500">
        Read-only summary. Outstation claims auto-approve on submission — only a Super Admin can
        review, approve, or reject one afterward in the Expense Command Center.
      </p>
    </div>
  );
}
