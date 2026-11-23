"use client";

/**
 * Phoenix CRM — the Super Admin's queue of places the Google Maps check could not confirm.
 *
 * Owner, 2026-10-03: "held for review and only system admin can approve or reject". Each row is one
 * place the rep captured at the door: his photo, where his phone put him, and every listing Google
 * returned for the customer's name — the same evidence the system judged on. Approve validates the
 * PLACE in the rep's own name — it never adds the customer to his list, which is a separate request; Reject retires the place and sends him back to To validate. Either
 * way the rep reads it as the system's answer: nothing he receives names who decided.
 *
 * Desktop draws the module's own `CrmTable` (`table-fixed` with a colgroup, never a min-width in a
 * scroller); a phone draws the same rows as cards. Square corners throughout.
 *
 * The row's pieces live beside this file since the split of 23 Nov 2026: what is read in
 * `validation-review-queue-evidence.tsx`, the controls in `validation-review-queue-decision.tsx`. This
 * file keeps the bulk answers, the table and its phone cards.
 */

import { crmPost } from "@/components/phoenix-crm/api";
import { usePlaceCheckDecides } from "@/components/phoenix-crm/place-check-decides";
import { BulkDecideBar, BulkPick, useRowPicks, type BulkAction } from "@/components/phoenix-crm/place-check-bulk";
import { approvalOutcome } from "@/components/phoenix-crm/place-check-done";
import type { PlaceCheckNotesMode } from "@/components/phoenix-crm/place-check-notes";
import { restoreRequest, useCanRestoreValidation } from "@/components/phoenix-crm/place-check-restore";
import { CrmPhotoThumb } from "@/components/phoenix-crm/photo";
import { usePlaceCheckLayout } from "@/components/phoenix-crm/place-checks/layout";
import { PhoneFold } from "@/components/phoenix-crm/place-checks/phone-fold";
import { CrmCardsOnPhone, CrmPill, CrmTable, crmTdClassName, crmThClassName, type PillTone } from "@/components/phoenix-crm/ui";
import { Decision, LastColumn } from "@/components/phoenix-crm/validation-review-queue-decision";
import { Evidence, PHOTO_CLASS, photoAlt, Who } from "@/components/phoenix-crm/validation-review-queue-evidence";
import { adviseOnReview, PLACE_CHECK_ADVICE_LABEL, type PlaceCheckAdviceKind } from "@/lib/phoenix-crm/place-check-advice";
import { approvalNeedsFullName } from "@/lib/phoenix-crm/pm-name-rules";
import type { PlaceNoteIndex, ValidationReviewRow } from "@/lib/phoenix-crm/view-types";

/**
 * Answering several rows at once (owner, 2026-10-15: "also make me able to multiple select and
 * response"). Each action is the request the row's own buttons make, so there is no second decision
 * path — see `place-check-bulk.tsx`.
 *
 * 🔴 WHICH ACTIONS A SECTION OFFERS IS WHAT THE SECTION HOLDS: `waiting` answers pending rows, and
 * `decided` takes a settled decision BACK — each action filtered to the rows the server says it can
 * still reach (`refusable` / `restorable`), with the count it will answer in the button.
 */
/** The colour of the system's word on a closed phone card: the same three the full advice block wears. */
const ADVICE_TONE: Record<PlaceCheckAdviceKind, PillTone> = { approve: "good", look: "warn", reject: "bad" };

const bulkDecide = (row: ValidationReviewRow, decision: "approve" | "reject", note: string, reason: string) =>
  crmPost<unknown>(
    "/api/phoenix-crm/validation-reviews",
    { reviewId: row.reviewId, decision, note, ...(decision === "reject" ? { refusalReason: reason } : {}) },
    "decided",
  );

const WAITING_ACTIONS: ReadonlyArray<BulkAction<ValidationReviewRow>> = [
  {
    key: "approve",
    label: "Approve",
    busyLabel: "Approving",
    variant: "primary",
    needsReason: false,
    // Never a clinic customer with one or two names: he is sent back for all three (owner, 2026-11-07).
    takes: (row) => row.status === "pending" && !approvalNeedsFullName(row),
    run: (row, answer) => bulkDecide(row, "approve", answer.note, ""),
    outcomeOf: (answer) => approvalOutcome(answer, "approved"),
  },
  {
    key: "reject",
    label: "Reject",
    busyLabel: "Rejecting",
    variant: "danger",
    needsReason: true,
    warning: (count) =>
      `This retires ${count === 1 ? "that place" : `those ${count} places`}; each customer left without one goes back to To validate, told what is wrong with the photo and nothing else.`,
    takes: (row) => row.status === "pending",
    run: (row, answer) => bulkDecide(row, "reject", answer.note, answer.reason),
    outcomeOf: () => "rejected",
  },
];

const DECIDED_ACTIONS: ReadonlyArray<BulkAction<ValidationReviewRow>> = [
  {
    key: "reject-after-all",
    label: "Reject after all",
    busyLabel: "Rejecting",
    variant: "danger",
    needsReason: true,
    warning: (count) =>
      `This takes back ${count === 1 ? "an approval" : `${count} approvals`} and retires the place each one let stand; a customer left without one goes back to To validate.`,
    takes: (row) => row.refusable,
    run: (row, answer) => bulkDecide(row, "reject", answer.note, answer.reason),
    outcomeOf: () => "rejected",
  },
  {
    key: "approve-after-all",
    label: "Approve after all",
    busyLabel: "Bringing back",
    variant: "primary",
    needsReason: false,
    // The Super Admin's alone (the board leaves this action out for anybody else), and never held back for a
    // short name: his approval goes through as it stands (owner, 2026-11-10, "the administrator is never blocked").
    takes: (row) => row.restorable,
    run: (row, answer) => crmPost<unknown>("/api/phoenix-crm/validation-reviews/restore", restoreRequest(row.reviewId, answer.note), "restored"),
    outcomeOf: (answer) => approvalOutcome(answer, "restored"),
  },
];

export function ValidationReviewQueue({
  mode,
  noteIndex,
  rows,
  section,
}: {
  mode: PlaceCheckNotesMode;
  noteIndex: PlaceNoteIndex;
  rows: ValidationReviewRow[];
  /** Which set this is drawing — it decides what a bulk answer can be. */
  section: "waiting" | "decided";
}) {
  // No bulk bar for the SFE Manager: every answer it gives is a decision (owner, 2026-11-19).
  const decides = usePlaceCheckDecides();
  const bulk = mode === "company" && decides;
  // Taking a rejection back is the Super Admin's alone (owner, 2026-11-10: "the SFE cannot") — the SFE
  // Manager's board neither ticks a rejected row nor offers "Approve after all".
  const canRestore = useCanRestoreValidation();
  const canPick = (row: ValidationReviewRow) => (section === "waiting" ? row.status === "pending" : row.refusable || (canRestore && row.restorable));
  const decidedActions = canRestore ? DECIDED_ACTIONS : DECIDED_ACTIONS.filter((action) => action.key !== "approve-after-all");
  const picks = useRowPicks<ValidationReviewRow>(bulk ? rows : [], (row) => row.reviewId, canPick);
  // 🔴 THE PICK-LIST FOLLOWS THE PHOTOGRAPHS IN THE PICK. All timetables → the timetable reasons; a
  // mixed pick takes the signboard list, whose reasons are all sayable about a building's sign.
  const kind = picks.picked.length > 0 && picks.picked.every((row) => row.photoKind === "schedule") ? "schedule" : "signboard";
  // One of the two layouts on the Super Admin's page, both everywhere else (place-checks/layout.tsx).
  const layout = usePlaceCheckLayout();

  return (
    <>
      {bulk ? (
        <BulkDecideBar
          actions={section === "waiting" ? WAITING_ACTIONS : decidedActions}
          // Only the waiting rows: a settled row's quick pick would tick rows no action can answer.
          adviceOf={section === "waiting" ? (row) => adviseOnReview(row).kind : undefined}
          kind={kind}
          nameOf={(row) => row.customerName}
          picks={picks}
        />
      ) : null}
      {layout === "table" ? null : (
      <CrmCardsOnPhone>
        {rows.map((row) => (
          // Closed until pressed: who and what, then the photograph, the evidence and the controls under it.
          <PhoneFold
            key={row.reviewId}
            summary={
              <>
                <Who row={row} />
                {/* The system's word is the Super Admin's alone, and only on a row that still waits. */}
                {bulk && section === "waiting" ? (
                  <div className="mt-1.5">
                    <CrmPill tone={ADVICE_TONE[adviseOnReview(row).kind]}>System: {PLACE_CHECK_ADVICE_LABEL[adviseOnReview(row).kind]}</CrmPill>
                  </div>
                ) : null}
              </>
            }
          >
            <div className="space-y-3 px-4 pb-4">
              {bulk && canPick(row) ? <BulkPick picks={picks} row={row} /> : null}
              <CrmPhotoThumb alt={photoAlt(row)} className={PHOTO_CLASS} lazy path={row.photoPath} rotatable />
              <Evidence row={row} />
              <LastColumn mode={mode} noteIndex={noteIndex} row={row} scope="card-" />
            </div>
          </PhoneFold>
        ))}
      </CrmCardsOnPhone>
      )}
      {layout === "cards" ? null : (
      <CrmTable columns={["30%", "18%", "28%", "24%"]}>
        <thead>
          <tr>
            <th className={crmThClassName}>Photo</th>
            <th className={crmThClassName}>Customer and rep</th>
            <th className={crmThClassName}>Where they stood, and Google</th>
            <th className={crmThClassName}>{mode === "team" ? "Your comment" : bulk ? "Decision" : "Your recommendation"}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.reviewId} className="even:bg-slate-50/60">
              <td className={crmTdClassName}>
                <div className="min-w-0 space-y-2">
                  <CrmPhotoThumb alt={photoAlt(row)} className={PHOTO_CLASS} lazy path={row.photoPath} rotatable />
                  {bulk && canPick(row) ? <BulkPick picks={picks} row={row} /> : null}
                </div>
              </td>
              <td className={crmTdClassName}>
                <Who row={row} />
              </td>
              <td className={crmTdClassName}>
                <Evidence row={row} />
              </td>
              <td className={crmTdClassName}>
                <LastColumn mode={mode} noteIndex={noteIndex} row={row} scope="" />
              </td>
            </tr>
          ))}
        </tbody>
      </CrmTable>
      )}
    </>
  );
}

/**
 * The pieces the one-by-one review draws a held place with (owner, 2026-10-18), exported as they are
 * so the review shows the same evidence and posts through the same controls as this table — never a
 * copy of either. `scope` keeps the review's field ids apart from this table's own.
 */
export { Decision as ReviewDecision, Evidence as ReviewEvidence, photoAlt as reviewPhotoAlt };
