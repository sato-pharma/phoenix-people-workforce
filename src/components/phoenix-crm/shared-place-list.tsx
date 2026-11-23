"use client";

/**
 * Phoenix CRM — the polyclinics and centres, and the administrator's decision on each.
 *
 * Owner, 2026-10-09 in chat (Arabic): "من حق الادمنستريتور ان هو يراجع الجدول ويبص" — the
 * administrator has the right to review the schedule and look. This is that review for the VENUE: the
 * live photo of the sign on the building, the two readings taken at its door, where it resolved to,
 * who captured it and when, and how many customers are seated behind it.
 *
 * 🔴 NO GOOGLE COLUMN, DELIBERATELY. The listing check compares a listing against the name on a
 * customer's LIST row, and a venue has no list name at all — so there is nothing to compare and
 * nothing is shown. The owner was asked this directly the same day and answered that the live photo
 * and the location are the gate: "even if no Google check, he must validate by a live photo and
 * location." This section is the human gate behind them.
 *
 * Rejecting one is the heavy decision on this page, so what it costs is written above the button
 * rather than after it: the venue is retired, every customer seated in it is retired with it, and each
 * of them goes back to To validate. The rep is told what is wrong with the photo from the same closed
 * list every other refusal uses, and never that a person looked at him.
 *
 * Desktop draws the module's `CrmTable` (`table-fixed` with a colgroup, never a min-width in a
 * scroller); a phone draws the same rows as cards. Square corners throughout. On the Super Admin's page
 * only ONE of the two is drawn (`usePlaceCheckLayout`); every other screen draws both, as before.
 *
 * The building's pieces live beside this file since the split of 23 Nov 2026: what is read in
 * `shared-place-list-evidence.tsx`, the decision in `shared-place-list-decision.tsx`. This file keeps the
 * bulk answers, the table and its phone cards.
 */

import { Fragment, useMemo } from "react";

import { crmPost } from "@/components/phoenix-crm/api";
import { usePlaceCheckDecides } from "@/components/phoenix-crm/place-check-decides";
import { BulkDecideBar, BulkPick, useRowPicks, type BulkAction } from "@/components/phoenix-crm/place-check-bulk";
import { useCanRestoreValidation } from "@/components/phoenix-crm/place-check-restore";
import type { PlaceCheckNotesMode } from "@/components/phoenix-crm/place-check-notes";
import { usePlaceCheckLayout } from "@/components/phoenix-crm/place-checks/layout";
import { PhoneFold } from "@/components/phoenix-crm/place-checks/phone-fold";
import { SeatedCustomers } from "@/components/phoenix-crm/shared-place-customers";
import { Decision, LastColumn } from "@/components/phoenix-crm/shared-place-list-decision";
import { SignPhoto, signboardText, TimetablePhoto, VenueHeader, Where } from "@/components/phoenix-crm/shared-place-list-evidence";
import { CrmCardsOnPhone, CrmTable, crmTdClassName, crmThClassName } from "@/components/phoenix-crm/ui";
import { adviseOnBuilding } from "@/lib/phoenix-crm/place-check-advice";
import type { VenueGroup } from "@/lib/phoenix-crm/shared-place-groups";
import type { PlaceNoteIndex, SharedPlaceBoardRow } from "@/lib/phoenix-crm/view-types";

/**
 * Deciding several venues at once (owner, 2026-10-15: "also make me able to multiple select and
 * response") — the row's own request per venue, nothing new; see `place-check-bulk.tsx`. The warning
 * says what a bulk rejection costs, because here it reaches every customer seated behind each door.
 */
const VENUE_ACTIONS: ReadonlyArray<BulkAction<SharedPlaceBoardRow>> = [
  {
    key: "approve",
    label: "Approve",
    busyLabel: "Approving",
    variant: "primary",
    needsReason: false,
    takes: (row) => !row.restorable,
    run: (row, answer) =>
      crmPost<unknown>("/api/phoenix-crm/validation-reviews/shared-place", { sharedPlaceId: row.sharedPlaceId, decision: "approve", note: answer.note }, "decided"),
    // The row's own control: an approved building reads "Approved", held or already standing.
    outcomeOf: () => "approved",
  },
  {
    key: "reject",
    label: "Reject",
    busyLabel: "Rejecting",
    variant: "danger",
    needsReason: true,
    warning: (count) =>
      `This retires ${count === 1 ? "that building" : `those ${count} buildings`} and everybody seated in ${count === 1 ? "it" : "them"}; each of those customers goes back to To validate and must capture the building again at its door.`,
    takes: (row) => !row.restorable && !row.lockedBySuperAdmin,
    run: (row, answer) =>
      crmPost<unknown>(
        "/api/phoenix-crm/validation-reviews/shared-place",
        { sharedPlaceId: row.sharedPlaceId, decision: "reject", note: answer.note, refusalReason: answer.reason },
        "decided",
      ),
    outcomeOf: () => "rejected",
  },
  {
    key: "restore",
    label: "Approve after all",
    busyLabel: "Bringing back",
    variant: "primary",
    needsReason: false,
    takes: (row) => row.restorable,
    run: (row, answer) =>
      crmPost<unknown>("/api/phoenix-crm/validation-reviews/shared-place/restore", { sharedPlaceId: row.sharedPlaceId, note: answer.note }, "restored"),
    outcomeOf: () => "restored",
  },
];

/**
 * The polyclinics and centres, each as ONE group: the building's name and where it is, the sign on its
 * door and its timetable side by side and large enough to read (owner, 2026-10-17: "every polyclinic
 * should crystal clear show me the name of the polyclinic and its data and the customer the rep added to
 * this polyclinic and the captured timetable crystal clear"), then the customers seated in it with what
 * that timetable says about each. The customers are drawn by `SeatedCustomers`, directly under their
 * building, so a polyclinic is never read apart from the people behind its door.
 */
export function SharedPlaceList({
  groups,
  mode,
  noteIndex,
}: {
  groups: VenueGroup[];
  mode: PlaceCheckNotesMode;
  noteIndex: PlaceNoteIndex;
}) {
  const decides = usePlaceCheckDecides();
  const bulk = mode === "company" && decides;
  const rows = useMemo(() => groups.map((group) => group.venue), [groups]);
  // A rejected building is ticked and brought back by the Super Admin alone (owner, 2026-11-10).
  const canRestore = useCanRestoreValidation();
  const canPick = (row: SharedPlaceBoardRow) => canRestore || !row.restorable;
  const picks = useRowPicks<SharedPlaceBoardRow>(bulk ? rows : [], (row) => row.sharedPlaceId, canPick);
  const venueActions = canRestore ? VENUE_ACTIONS : VENUE_ACTIONS.filter((action) => action.key !== "restore");
  const layout = usePlaceCheckLayout();
  return (
    <>
      {bulk ? (
        <BulkDecideBar
          actions={venueActions}
          kind="building"
          adviceOf={(row) => (row.restorable ? null : adviseOnBuilding(row).kind)}
          nameOf={(row) => row.name}
          picks={picks}
        />
      ) : null}
      {layout === "table" ? null : (
      <CrmCardsOnPhone>
        {groups.map(({ customers, total, venue: row }) => (
          // Closed until pressed: the building's name, its state and who captured it; its photographs, its
          // decision and everybody seated in it open under it (one building ran 14,000 px drawn whole).
          <PhoneFold key={row.sharedPlaceId} summary={<VenueHeader mode={mode} part="summary" row={row} />}>
            <div className="space-y-4 px-4 pt-1">
              {/* What the closed card leaves out: when it was captured and where it stands. */}
              <VenueHeader mode={mode} part="rest" row={row} />
              {bulk && canPick(row) ? <BulkPick picks={picks} row={row} /> : null}
              <div className="grid min-w-0 gap-4 sm:grid-cols-2">
                <SignPhoto headed row={row} />
                <TimetablePhoto customers={customers} headed mode={mode} row={row} />
              </div>
              <Where row={row} />
              <LastColumn mode={mode} noteIndex={noteIndex} row={row} scope="cards" />
            </div>
            <div className="mt-3 border-t border-slate-100 bg-slate-50/60 pb-2">
              <SeatedCustomers customers={customers} layout="cards" mode={mode} noTimetable={row.timetableExempt !== null} noteIndex={noteIndex} total={total} venueTimetablePath={row.schedulePhotoPath} />
            </div>
          </PhoneFold>
        ))}
      </CrmCardsOnPhone>
      )}
      {layout === "cards" ? null : (
      <CrmTable columns={["34%", "17%", "17%", "15%", "17%"]}>
        <thead>
          <tr>
            <th className={crmThClassName}>The building and who is seated in it</th>
            <th className={crmThClassName}>The sign on the building</th>
            <th className={crmThClassName}>The timetable inside</th>
            <th className={crmThClassName}>Where it was captured</th>
            <th className={crmThClassName}>{mode === "team" ? "Your comment" : bulk ? "Decision" : "Your recommendation"}</th>
          </tr>
        </thead>
        <tbody>
          {groups.map(({ customers, total, venue: row }) => (
            // The building's own row, then a row for each customer seated in it (`SeatedCustomers`): the
            // heavier line above marks where the next building starts.
            <Fragment key={row.sharedPlaceId}>
            <tr className="border-t-2 border-slate-200" data-building-row>
              <td className={crmTdClassName}>
                <div className="flex min-w-0 items-start gap-3">
                  {bulk && canPick(row) ? <BulkPick picks={picks} row={row} /> : null}
                  <VenueHeader mode={mode} row={row} />
                </div>
              </td>
              <td className={crmTdClassName}>
                <SignPhoto headed={false} row={row} />
              </td>
              <td className={crmTdClassName}>
                <TimetablePhoto customers={customers} headed={false} mode={mode} row={row} />
              </td>
              <td className={crmTdClassName}>
                <Where row={row} />
              </td>
              <td className={crmTdClassName}>
                <LastColumn mode={mode} noteIndex={noteIndex} row={row} scope="table" />
              </td>
            </tr>
            <SeatedCustomers customers={customers} layout="table" mode={mode} noTimetable={row.timetableExempt !== null} noteIndex={noteIndex} total={total} venueTimetablePath={row.schedulePhotoPath} />
            </Fragment>
          ))}
        </tbody>
      </CrmTable>
      )}
    </>
  );
}

/**
 * The pieces the one-by-one review draws a polyclinic with (owner, 2026-10-18: "the polyclinic
 * validation itself and the timetable … in the same screen"), exported as they are — the building's
 * own evidence and its own decision, never a copy.
 */
export { Decision as VenueDecision, VenueHeader, signboardText as venueSignboardText, Where as VenueWhere };
