"use client";

/**
 * Phoenix CRM — "Before you go", the rep's own prep for his next planned day.
 *
 * Four facts per planned customer, all of which already existed and none of which he could read
 * without standing at the clinic with the visit form open: when he last saw him, what the customer
 * pushed back on, what HE said he would do, and what he discussed (src/lib/phoenix-crm/call-prep.ts).
 *
 * 🔴 READ ONLY, AND OFF THE PLAN-CHANGE PATH. There is no tick, no "move this stop", no link into the
 * planner and no mention of "Ask to edit this week": the plan is weekly and a SENT week changes only
 * through that one request — the district manager, then SFE (owner, 2026-10-01; 2026-10-08) — and a
 * read-only prep list is exactly where a second door into it would get built by accident.
 *
 * 🔴 NO FIGURE. No count of stops, no coverage, no call rate, no "x of y planned". His own plan and
 * his own notes, in the order he will drive them, and nothing that scores him.
 *
 * Desktop a table, phone cards; `table-fixed` with a colgroup summing to 100%, square edges, every
 * cell wraps and nothing is ever cut with an ellipsis.
 */

import { crmUrl, type CrmResource, useCrmGet } from "@/components/phoenix-crm/api";
import { dayLabel, dayLabelLong } from "@/components/phoenix-crm/format";
import { listText } from "@/components/phoenix-crm/labels";
import {
  CrmBlock,
  CrmCard,
  CrmCardsOnPhone,
  CrmLoadError,
  CrmLoading,
  CrmPanel,
  CrmPill,
  CrmTable,
  crmTdClassName,
  crmThClassName,
} from "@/components/phoenix-crm/ui";
import type { CallPrepLine } from "@/lib/phoenix-crm/call-prep";
import type { CallPrepView } from "@/lib/phoenix-crm/view-types";

const FIRST_TIME = "You have not seen them yet.";

/** When he last saw him. Absent, never a zero — "never seen" and "not read" are different sentences. */
function lastSeenText(line: CallPrepLine): string {
  return line.lastSeenOn ? `Last seen ${dayLabel(line.lastSeenOn)}` : FIRST_TIME;
}

/** What he said he would do, with the day he set for it when he set one. */
function nextStepText(line: CallPrepLine): string | null {
  if (!line.nextStepLabel) return null;
  return line.nextStepDueOn ? `${line.nextStepLabel} · for ${dayLabel(line.nextStepDueOn)}` : line.nextStepLabel;
}

function PrepCards({ lines }: { lines: ReadonlyArray<CallPrepLine> }) {
  return (
    <CrmCardsOnPhone>
      {lines.map((line) => {
        const next = nextStepText(line);
        return (
          <CrmCard
            accent="border-l-emerald-500"
            key={line.customerId}
            meta={lastSeenText(line)}
            status={<CrmPill tone="neutral">{listText(line.listType)}</CrmPill>}
            title={line.customerName}
          >
            <div className="grid min-w-0 gap-1.5 text-xs font-semibold leading-5 text-slate-600">
              {line.objectionLabel ? (
                <p className="break-words">
                  <span className="font-black text-slate-800">They pushed back on: </span>
                  {line.objectionLabel}
                </p>
              ) : null}
              {next ? (
                <p className="break-words">
                  <span className="font-black text-slate-800">You said you would: </span>
                  {next}
                </p>
              ) : null}
              {line.products.length > 0 ? (
                <p className="break-words">
                  <span className="font-black text-slate-800">Last discussed: </span>
                  {line.products.join(", ")}
                </p>
              ) : null}
            </div>
          </CrmCard>
        );
      })}
    </CrmCardsOnPhone>
  );
}

/** Four columns totalling 100%: the customer, when, what was said, what was discussed. */
function PrepTable({ lines }: { lines: ReadonlyArray<CallPrepLine> }) {
  return (
    <CrmTable columns={["24%", "20%", "30%", "26%"]}>
      <thead>
        <tr>
          <th className={crmThClassName} scope="col">
            Customer
          </th>
          <th className={crmThClassName} scope="col">
            Last seen
          </th>
          <th className={crmThClassName} scope="col">
            What was said
          </th>
          <th className={crmThClassName} scope="col">
            Last discussed
          </th>
        </tr>
      </thead>
      <tbody>
        {lines.map((line) => {
          const next = nextStepText(line);
          return (
            <tr key={line.customerId}>
              <td className={crmTdClassName}>
                <span className="block font-black text-slate-900">{line.customerName}</span>
                <span className="mt-0.5 block text-xs text-slate-500">{listText(line.listType)}</span>
              </td>
              <td className={crmTdClassName}>{lastSeenText(line)}</td>
              <td className={crmTdClassName}>
                {line.objectionLabel ? <span className="block">They pushed back on: {line.objectionLabel}</span> : null}
                {next ? <span className="mt-1 block">You said you would: {next}</span> : null}
                {!line.objectionLabel && !next ? <span className="block text-slate-500">—</span> : null}
              </td>
              <td className={crmTdClassName}>{line.products.length > 0 ? line.products.join(", ") : <span className="text-slate-500">—</span>}</td>
            </tr>
          );
        })}
      </tbody>
    </CrmTable>
  );
}

/** Handed in by the Visits tab, which starts it beside the day's own read (see `useCommitments`). */
export function useCallPrep(url: string | null): CrmResource<CallPrepView> {
  return useCrmGet<CallPrepView>(url, "prep");
}

export function callPrepUrl(seatId: string, test: boolean): string {
  return crmUrl("/api/phoenix-crm/call-prep", { seatId, test });
}

export function CallPrepPanel({ prep }: { prep: CrmResource<CallPrepView> }) {
  const view = prep.data;

  return (
    <CrmPanel
      // The DAY is named rather than called "tomorrow": Thursday's next field day is the Saturday,
      // and a rep reading "tomorrow" over Saturday's stops would prepare the wrong day.
      description={view ? dayLabelLong(view.date) : null}
      eyebrow="Before you go"
      title="Your next day's stops"
    >
      {!view && prep.error ? <CrmLoadError message={prep.error} onRetry={prep.reload} /> : null}
      {!view && !prep.error ? <CrmLoading label="Loading your next day's stops" /> : null}
      {view ? (
        <>
          {prep.error ? <CrmLoadError message={prep.error} onRetry={prep.reload} /> : null}
          {view.emptyNote ? (
            <CrmBlock>
              <p className="break-words text-sm font-semibold leading-6 text-slate-600">{view.emptyNote}</p>
            </CrmBlock>
          ) : (
            <div className="border-t border-slate-100">
              <PrepCards lines={view.lines} />
              <PrepTable lines={view.lines} />
            </div>
          )}
        </>
      ) : null}
    </CrmPanel>
  );
}
