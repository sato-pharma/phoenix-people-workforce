"use client";

/**
 * Phoenix CRM — "What you said you would do", on the rep's own Visits tab.
 *
 * READ ONLY. There is no tick, no dismiss and no button of any kind: a commitment closes when he goes
 * back to the customer (src/lib/phoenix-crm/commitments.ts), and a completion input would be a step
 * added to his day — which needs the owner's word first (Golden rule #1, the EASY half).
 *
 * 🔴 NO FIGURE, ANYWHERE ON IT. No count of what is open, no kept/missed split, no percentage, no
 * streak. The rep's surfaces were deliberately stripped of meters, and this is his own notebook read
 * back to him, not a scoreboard. The only numbers it prints are inside the one sentence naming what is
 * open but NOT listed — and that sentence exists so nothing of his is silently dropped.
 *
 * Desktop a table, phone cards (`CrmCardsOnPhone` + `CrmTable`), `table-fixed` with a colgroup summing
 * to 100% so nothing scrolls sideways at 375px, square edges, and no ellipsis — every cell wraps.
 */

import { crmUrl, type CrmResource, useCrmGet } from "@/components/phoenix-crm/api";
import { dayLabel } from "@/components/phoenix-crm/format";
import {
  CrmBlock,
  CrmCard,
  CrmCardsOnPhone,
  CrmLoadError,
  CrmLoading,
  CrmPanel,
  CrmTable,
  crmTdClassName,
  crmThClassName,
} from "@/components/phoenix-crm/ui";
import {
  COMMITMENTS_EMPTY_NOTE,
  commitmentsNotListedNote,
  type CommitmentGroup,
  type RepCommitment,
} from "@/lib/phoenix-crm/commitments";
import type { RepCommitmentsView } from "@/lib/phoenix-crm/view-types";

/** "Promised Tue 29 Sept", and the day he set for it when he set one. Never an ellipsis, never a code. */
function promiseLine(commitment: RepCommitment): string {
  const promised = `You said this on ${dayLabel(commitment.promisedOn)}`;
  return commitment.dueOn ? `${promised} · for ${dayLabel(commitment.dueOn)}` : promised;
}

function CommitmentCards({ group }: { group: CommitmentGroup }) {
  return (
    <CrmCardsOnPhone>
      {group.commitments.map((commitment) => (
        <CrmCard accent="border-l-sky-500" key={commitment.customerId} meta={promiseLine(commitment)} title={commitment.customerName}>
          <p className="break-words text-xs font-bold leading-5 text-slate-700">{commitment.label}</p>
        </CrmCard>
      ))}
    </CrmCardsOnPhone>
  );
}

/** Three columns totalling 100%. The customer, what he said, and when — merged rather than shrunk. */
function CommitmentTable({ group }: { group: CommitmentGroup }) {
  return (
    <CrmTable columns={["34%", "34%", "32%"]}>
      <thead>
        <tr>
          <th className={crmThClassName} scope="col">
            Customer
          </th>
          <th className={crmThClassName} scope="col">
            What you said
          </th>
          <th className={crmThClassName} scope="col">
            When
          </th>
        </tr>
      </thead>
      <tbody>
        {group.commitments.map((commitment) => (
          <tr key={commitment.customerId}>
            <td className={crmTdClassName}>
              <span className="block font-black text-slate-900">{commitment.customerName}</span>
            </td>
            <td className={crmTdClassName}>{commitment.label}</td>
            <td className={crmTdClassName}>{promiseLine(commitment)}</td>
          </tr>
        ))}
      </tbody>
    </CrmTable>
  );
}

/**
 * The read is handed in, not made here: the Visits tab starts it beside the day's own read on the
 * rep's own territory (`useCommitments`), so the panel no longer waits for the day to answer first.
 */
export function useCommitments(url: string | null): CrmResource<RepCommitmentsView> {
  return useCrmGet<RepCommitmentsView>(url, "commitments");
}

export function commitmentsUrl(seatId: string, test: boolean): string {
  return crmUrl("/api/phoenix-crm/commitments", { seatId, test });
}

export function CommitmentsPanel({ commitments }: { commitments: CrmResource<RepCommitmentsView> }) {
  const view = commitments.data;
  const notListed = view ? commitmentsNotListedNote(view) : null;

  return (
    <CrmPanel
      description="What you told a customer you would do, until you are next with them. Nothing here is a score."
      eyebrow="Your own notes"
      title="What you said you would do"
    >
      {!view && commitments.error ? <CrmLoadError message={commitments.error} onRetry={commitments.reload} /> : null}
      {!view && !commitments.error ? <CrmLoading label="Loading what you said you would do" /> : null}
      {view ? (
        <>
          {commitments.error ? <CrmLoadError message={commitments.error} onRetry={commitments.reload} /> : null}
          {view.groups.length === 0 ? (
            <CrmBlock>
              <p className="break-words text-sm font-semibold leading-6 text-slate-600">{COMMITMENTS_EMPTY_NOTE}</p>
            </CrmBlock>
          ) : (
            view.groups.map((group) => (
              <CrmBlock className="border-t border-slate-100" key={group.key} title={group.title}>
                <div className="-mx-4 min-w-0 sm:-mx-5">
                  <CommitmentCards group={group} />
                  <CommitmentTable group={group} />
                </div>
              </CrmBlock>
            ))
          )}
          {notListed ? (
            <CrmBlock className="border-t border-slate-100">
              <p className="break-words text-xs font-semibold leading-5 text-slate-500">{notListed}</p>
            </CrmBlock>
          ) : null}
        </>
      ) : null}
    </CrmPanel>
  );
}
