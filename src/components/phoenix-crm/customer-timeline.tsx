"use client";

/**
 * Phoenix CRM — the customer's own timeline, on his page (owner, 2026-10-02): his past Phoenix visits,
 * newest first — the day, AM or PM, the products discussed, what the customer objected to, the rep's
 * own comment and the next step he committed to. Before it, the page said only how many times he was
 * seen this month.
 *
 * The rep reads it, and so does everyone else who can open the customer; the server reads it through
 * the list's own seat gate. It carries NO location, distance, accuracy or flag — the server never even
 * reads them for it — so it is the same page whoever opens it (Golden Rule #1).
 */

import { useState } from "react";

import { crmUrl, useCrmGet } from "@/components/phoenix-crm/api";
import { dayLabel, dayLabelWithYear, plural } from "@/components/phoenix-crm/format";
import { listText } from "@/components/phoenix-crm/labels";
import { CrmBlock, CrmButton, CrmLoadError, CrmLoading, CrmPill } from "@/components/phoenix-crm/ui";
import type { TimelineEntry } from "@/lib/phoenix-crm/customer-timeline";
import { MISSED_RECORD_MARK } from "@/lib/phoenix-crm/missed-records";
import type { CustomerTimelineView } from "@/lib/phoenix-crm/view-types";

/** Shown a few at a time: a customer seen three times a month for a year is a long page. */
const PAGE = 10;

function TimelineFact({ label, children }: { label: string; children: string }) {
  return (
    <p className="break-words">
      <span className="font-black text-slate-800">{`${label}: `}</span>
      <span dir="auto">{children}</span>
    </p>
  );
}

function TimelineItem({ entry }: { entry: TimelineEntry }) {
  const objection = entry.objectionLabel
    ? entry.objectionNote
      ? `${entry.objectionLabel} — “${entry.objectionNote}”`
      : entry.objectionLabel
    : null;
  const nextStep = entry.nextStepLabel ? (entry.nextStepOn ? `${entry.nextStepLabel} · by ${dayLabel(entry.nextStepOn)}` : entry.nextStepLabel) : null;
  return (
    <li className="grid min-w-0 gap-1 px-3 py-2.5 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)] sm:gap-3">
      <div className="min-w-0">
        <p className="break-words text-xs font-black leading-6 text-slate-700">{dayLabelWithYear(entry.visitDate)}</p>
        <div className="mt-0.5 flex min-w-0 flex-wrap gap-1">
          <CrmPill>{listText(entry.listType)}</CrmPill>
          {entry.offPlanLabel ? <CrmPill tone="orange">{entry.offPlanLabel}</CrmPill> : null}
        </div>
      </div>
      <div className="grid min-w-0 gap-0.5 text-sm font-semibold leading-6 text-slate-700">
        <TimelineFact label="Products">{entry.products.length > 0 ? entry.products.join(" · ") : "None recorded"}</TimelineFact>
        {objection ? <TimelineFact label="Objection">{objection}</TimelineFact> : null}
        {entry.comment ? <TimelineFact label="Comment">{entry.comment}</TimelineFact> : null}
        {nextStep ? <TimelineFact label="Next step">{nextStep}</TimelineFact> : null}
        {entry.enteredByAdmin ? <p className="break-words text-xs font-semibold text-slate-500">{MISSED_RECORD_MARK}</p> : null}
      </div>
    </li>
  );
}

export function CustomerTimeline({ customerId, seatId, test }: { customerId: string; seatId: string; test: boolean }) {
  const resource = useCrmGet<CustomerTimelineView>(crmUrl("/api/phoenix-crm/list/timeline", { customerId, seatId, test }), "timeline");
  const [limit, setLimit] = useState(PAGE);
  const view = resource.data;

  if (!view) {
    return (
      <div className="border-t border-slate-100">
        {resource.error ? <CrmLoadError message={resource.error} onRetry={resource.reload} /> : <CrmLoading label="Loading the visits" />}
      </div>
    );
  }

  const shown = view.entries.slice(0, limit);
  const left = view.entries.length - shown.length;
  return (
    <CrmBlock className="border-t border-slate-100" title={view.entries.length > 0 ? `Visits so far · ${plural(view.entries.length, "visit", "visits")}` : "Visits so far"}>
      {view.entries.length === 0 ? (
        <p className="break-words text-sm font-medium text-slate-500">
          No visit saved here yet. Each one shows here once it is saved, newest first: the day, AM or PM, the products discussed, the customer&apos;s objection, the comment and the next step.
        </p>
      ) : (
        <>
          <ol className="divide-y divide-slate-100 border border-slate-200 bg-white">
            {shown.map((entry) => (
              <TimelineItem entry={entry} key={entry.visitId} />
            ))}
          </ol>
          {left > 0 ? (
            <div className="mt-3">
              <CrmButton onClick={() => setLimit((value) => value + PAGE)} size="sm">
                {`Show ${Math.min(PAGE, left)} more of the ${left} left`}
              </CrmButton>
            </div>
          ) : null}
          {view.more && left === 0 ? (
            <p className="mt-2 break-words text-xs font-semibold text-slate-500">The most recent visits are shown; older ones are kept on file.</p>
          ) : null}
        </>
      )}
    </CrmBlock>
  );
}
