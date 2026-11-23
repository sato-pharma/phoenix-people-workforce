"use client";

/**
 * Phoenix CRM — Place checks: what was decided.
 *
 * - **History** — the decisions of the last 14 days (or every one of a chosen decider's), and the
 *   customers sent back and not captured again since.
 * - **Approved by the system** — the Super Admin's board alone: the places the rule approved by itself
 *   (`sign-wins-rules.ts`), each with the same take-back any approval has. On his board they are listed
 *   here and left out of History, so History is what a person decided.
 *
 * 🔴 A DISTRICT MANAGER'S BOARD NAMES NOBODY WHO DECIDED: its sentences say "settled".
 */

import { AdminCallout } from "@/components/admin/admin-design-system";
import { SIGN_WINS_UNREAD } from "@/components/phoenix-crm/place-checks/desk-header";
import { PAGE_ROWS, Paged } from "@/components/phoenix-crm/place-checks/paged";
import { PlaceCheckSection } from "@/components/phoenix-crm/place-checks/section";
import type { PlaceCheckBoard } from "@/components/phoenix-crm/place-checks/use-place-check-board";
import { ReopenedCustomerList } from "@/components/phoenix-crm/reopened-customer-list";
import { ValidationReviewQueue } from "@/components/phoenix-crm/validation-review-queue";
import { signWinsSentence } from "@/lib/phoenix-crm/sign-wins-rules";

export function PlaceChecksHistoryPanel({ board }: { board: PlaceCheckBoard }) {
  const { anyFilter, decidedTitle, filterKey, filteredReopened, historyDecided, mode, noteIndex, pageKey, rowsShown, setRowsShown, showDecided, showReopened, team } = board;
  return (
    <>
      {showDecided ? (
        <PlaceCheckSection
          title={`${decidedTitle} (${historyDecided.length})`}
          description={
            team
              ? "What has been settled, the one sentence the rep was told about the photograph, and any comment on it."
              : "What was approved or rejected, by whom, with the comment the rep and their manager read."
          }
        >
          {historyDecided.length === 0 ? (
            <div className="px-4 py-4">
              <AdminCallout tone="neutral">
                <span>
                  {anyFilter
                    ? `Nothing ${team ? "settled" : "decided"} matches these filters.`
                    : `Nothing has been ${team ? "settled" : "decided"} in the last 14 days.`}
                </span>
              </AdminCallout>
            </div>
          ) : (
            <Paged key={pageKey} initial={rowsShown} noun="places" onLimit={setRowsShown} rows={historyDecided} size={PAGE_ROWS}>
              {(rows) => <ValidationReviewQueue mode={mode} noteIndex={noteIndex} rows={rows} section="decided" />}
            </Paged>
          )}
        </PlaceCheckSection>
      ) : null}

      {showReopened ? (
        <PlaceCheckSection
          title={`Waiting to be captured again (${filteredReopened.length})`}
          description="Customers sent back to To validate because their place was rejected, and not validated again since — the longest wait first. The rep was told what is wrong with the photo and nothing else."
        >
          {filteredReopened.length === 0 ? (
            <div className="px-4 py-4">
              <AdminCallout tone="success">
                <span>{anyFilter ? "Nobody waiting matches these filters." : "Nobody is waiting to be captured again."}</span>
              </AdminCallout>
            </div>
          ) : (
            <Paged key={filterKey} noun="customers" rows={filteredReopened} size={PAGE_ROWS}>
              {(rows) => <ReopenedCustomerList mode={mode} rows={rows} />}
            </Paged>
          )}
        </PlaceCheckSection>
      ) : null}
    </>
  );
}

export function PlaceChecksBySystemPanel({ board }: { board: PlaceCheckBoard }) {
  const { anyFilter, bySystemRows, mode, noteIndex, pageKey, rowsShown, setRowsShown, showDecided, signWins } = board;
  return (
    <>
      <p className="min-w-0 break-words border-l-4 border-orange-500 bg-white px-4 py-3 text-sm text-slate-700">
        {signWins ? signWinsSentence(signWins) : SIGN_WINS_UNREAD}
      </p>
      {showDecided ? (
        <PlaceCheckSection
          title={`Approved by the system (${bySystemRows.length})`}
          description="Only the Google check had held each of these, and the sign in its photo names the customer. Rejecting one here takes the approval back: the place is retired and the rep reads the reason you choose."
        >
          {bySystemRows.length === 0 ? (
            <div className="px-4 py-4">
              <AdminCallout tone="neutral">
                <span>{anyFilter ? "Nothing the system approved matches these filters." : "The system has approved nothing by itself in the last 14 days."}</span>
              </AdminCallout>
            </div>
          ) : (
            <Paged key={pageKey} initial={rowsShown} noun="places" onLimit={setRowsShown} rows={bySystemRows} size={PAGE_ROWS}>
              {(rows) => <ValidationReviewQueue mode={mode} noteIndex={noteIndex} rows={rows} section="decided" />}
            </Paged>
          )}
        </PlaceCheckSection>
      ) : (
        <AdminCallout tone="neutral">
          <span>The outcome selected above holds no approval.</span>
        </AdminCallout>
      )}
    </>
  );
}
