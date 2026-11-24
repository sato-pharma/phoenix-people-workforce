"use client";

/**
 * Phoenix CRM — validations the system never held, and the Super Admin's power to refuse one — or,
 * since 2026-10-17, to approve one the system could not read (`Approve`, in
 * `validated-place-list-decision.tsx`).
 *
 * The Google check covers AM customers only (`googleCheckApplies`), so a doctor's validation is never
 * held and never appears in the queue above; an AM one that matched its listing does not either. Before
 * this list there was no way to take one back — it had to be undone in SQL.
 *
 * Rejecting writes the same review the automatic check would have written and runs the same reject, so
 * the rep reads the system's own wording ("The system could not confirm this place") and never that
 * a person looked at him. Since 2026-10-08 the Super Admin also picks WHAT IS WRONG WITH THE PHOTO from
 * a closed list, and that one sentence is what the rep is told about the photo. The comment beside it is
 * OPTIONAL since 2026-10-15 ("admin comment is optional"), and since 2026-11-01 the rep and their manager
 * read it, from the System Administrator and with no name on it (`tellDecisionComment`).
 *
 * Desktop draws the module's `CrmTable` (`table-fixed` with a colgroup, never a min-width in a
 * scroller); a phone draws the same rows as cards. Square corners throughout.
 *
 * The row's pieces live beside this file since the split of 23 Nov 2026: what is read in
 * `validated-place-list-evidence.tsx`, the two controls in `validated-place-list-decision.tsx`. This file
 * keeps the bulk answers, the search, the table and its phone cards.
 */

import { useMemo, useState } from "react";

import { crmPost } from "@/components/phoenix-crm/api";
import { usePlaceCheckDecides } from "@/components/phoenix-crm/place-check-decides";
import { BulkDecideBar, BulkPick, useRowPicks, type BulkAction } from "@/components/phoenix-crm/place-check-bulk";
import type { PlaceCheckNotesMode } from "@/components/phoenix-crm/place-check-notes";
import { useCanRestoreValidation } from "@/components/phoenix-crm/place-check-restore";
import { usePlaceCheckLayout } from "@/components/phoenix-crm/place-checks/layout";
import { CrmPhotoThumb } from "@/components/phoenix-crm/photo";
import {
  CrmCardsOnPhone,
  CrmEmpty,
  CrmSearchField,
  CrmShowMore,
  CrmTable,
  crmTdClassName,
  crmThClassName,
} from "@/components/phoenix-crm/ui";
import { Approve, LastColumn, RejectInUse } from "@/components/phoenix-crm/validated-place-list-decision";
import { PHOTO_CLASS, photoAlt, Place, readingText, SCHEDULE_TEXT, signboardText, Who } from "@/components/phoenix-crm/validated-place-list-evidence";
import { adviseOnPlaceInUse } from "@/lib/phoenix-crm/place-check-advice";
import { TRUSTED_POINT_NO_PHOTO } from "@/lib/phoenix-crm/trusted-point-rules";
import { refusalTakeBack } from "@/lib/phoenix-crm/validation-feedback";
import type { PlaceNoteIndex, ValidatedPlaceRow } from "@/lib/phoenix-crm/view-types";

/**
 * The empty index, for the callers that use this list on its own and know nothing about comments. A
 * module-level constant rather than an inline `{}` default: a fresh object every render would remount
 * nothing here but would defeat any memo a later caller adds.
 */
const EMPTY_INDEX: PlaceNoteIndex = { integrity: {}, notes: {}, recommendations: {} };

const PAGE = 25;

/**
 * Answering several at once (owner, 2026-10-15: "also make me able to multiple select and response";
 * Approve added 2026-10-17). Each runs the row's OWN request per place — same route, same reason, same
 * note — so there is no second decision path; see `place-check-bulk.tsx`. The refusal's warning says who
 * can take it back by who is reading (`refusalTakeBack`), as one row's does.
 */
const inUseActions = (canRestore: boolean): ReadonlyArray<BulkAction<ValidatedPlaceRow>> => [
  {
    key: "approve",
    label: "Approve",
    busyLabel: "Approving",
    variant: "primary",
    needsReason: false,
    // Every row, a short name included: the Super Admin is never blocked (owner, 24 Nov 2026).
    takes: () => true,
    run: (row, answer) => crmPost<unknown>("/api/phoenix-crm/validation-reviews/approve", { placeId: row.placeId, note: answer.note }, "approved"),
    outcomeOf: () => "approved",
  },
  {
    key: "refuse",
    label: "Reject",
    busyLabel: "Rejecting",
    variant: "danger",
    needsReason: true,
    warning: (count) =>
      `This retires ${count === 1 ? "that place" : `those ${count} places`}; each customer left without one validates again from their own list. ${refusalTakeBack(canRestore, count)}`,
    // What the administrator approved, only he refuses (owner, 2026-11-16).
    takes: (row) => !row.lockedBySuperAdmin,
    run: (row, answer) =>
      crmPost<unknown>("/api/phoenix-crm/validation-reviews/refuse", { placeId: row.placeId, note: answer.note, refusalReason: answer.reason }, "refused"),
    outcomeOf: () => "refused",
  },
];

/**
 * `showSearch` is false when the board above owns the filtering (the Place checks page) — the list is
 * then handed rows that are already narrowed, and its own search box would be a second, confusing one.
 * It stays true by default so the component keeps its own search anywhere it is used on its own.
 */
export function ValidatedPlaceList({
  mode = "company",
  noteIndex = EMPTY_INDEX,
  rows,
  showSearch = true,
}: {
  mode?: PlaceCheckNotesMode;
  noteIndex?: PlaceNoteIndex;
  rows: ValidatedPlaceRow[];
  showSearch?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const decides = usePlaceCheckDecides();
  const bulk = mode === "company" && decides;
  const canRestore = useCanRestoreValidation();

  const found = useMemo(() => {
    const wanted = query.trim().toLowerCase();
    if (!wanted) return rows;
    return rows.filter((row) =>
      [row.customerName, row.repName, row.territory, row.placeLabel, row.brickName, row.areaName, row.address]
        .filter((value): value is string => typeof value === "string" && value.length > 0)
        .some((value) => value.toLowerCase().includes(wanted)),
    );
  }, [query, rows]);
  const shown = found.slice(0, page * PAGE);
  // The PAGE is what can be picked, never the whole filtered set: a tick box is only honest about a
  // row on screen, and "Pick all" that reached 600 places behind a Show more would be a trap.
  const picks = useRowPicks<ValidatedPlaceRow>(bulk ? shown : [], (row) => row.placeId);
  const kind = picks.picked.length > 0 && picks.picked.every((row) => row.photoKind === "schedule") ? "schedule" : "signboard";
  // One of the two layouts on the Super Admin's page, both everywhere else (place-checks/layout.tsx).
  const layout = usePlaceCheckLayout();

  return (
    <div className="min-w-0 space-y-3">
      {showSearch ? (
        <div className="px-4 pt-4 md:max-w-md">
          <CrmSearchField
            id="validated-place-search"
            label="Find a customer, a rep or a territory"
            onChange={(next) => {
              setQuery(next);
              setPage(1);
            }}
            placeholder="Name, rep, brick or area"
            value={query}
          />
        </div>
      ) : null}

      {found.length === 0 ? (
        <div className="px-4 pb-4">
          <CrmEmpty message={showSearch ? "Nothing here matches what you typed." : "Nothing here matches these filters."} title="No validation found" />
        </div>
      ) : (
        <>
          {bulk ? (
            <BulkDecideBar
              actions={inUseActions(canRestore)}
              // Both answers are here since 2026-10-17, so both quick picks are offered; "look yourself" is neither.
              adviceOf={(row) => {
                const advice = adviseOnPlaceInUse(row).kind;
                return advice === "look" ? null : advice;
              }}
              kind={kind}
              nameOf={(row) => row.customerName}
              picks={picks}
            />
          ) : null}
          {layout === "table" ? null : (
          <CrmCardsOnPhone>
            {shown.map((row) => (
              <div key={row.placeId} className="space-y-3 px-4 py-4">
                {bulk ? <BulkPick picks={picks} row={row} /> : null}
                {/* The photograph IS the question on this list, so on a phone it takes the card's whole width. */}
                <CrmPhotoThumb alt={photoAlt(row)} className={PHOTO_CLASS} lazy missingText={row.trustedPoint ? TRUSTED_POINT_NO_PHOTO : undefined} path={row.photoPath} rotatable />
                <Who mode={mode} row={row} />
                <Place row={row} />
                <LastColumn mode={mode} noteIndex={noteIndex} row={row} scope="card-" />
              </div>
            ))}
          </CrmCardsOnPhone>
          )}
          {layout === "cards" ? null : (
          <CrmTable columns={["36%", "20%", "24%", "20%"]}>
            <thead>
              <tr>
                <th className={crmThClassName}>Photo</th>
                <th className={crmThClassName}>Customer and rep</th>
                <th className={crmThClassName}>The place they saved</th>
                <th className={crmThClassName}>{mode === "team" ? "Your comment" : bulk ? "Approve or reject" : "Your recommendation"}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => (
                <tr key={row.placeId} className="even:bg-slate-50/60">
                  <td className={crmTdClassName}>
                    <div className="min-w-0 space-y-2">
                      <CrmPhotoThumb alt={photoAlt(row)} className={PHOTO_CLASS} lazy missingText={row.trustedPoint ? TRUSTED_POINT_NO_PHOTO : undefined} path={row.photoPath} rotatable />
                      {bulk ? <BulkPick picks={picks} row={row} /> : null}
                    </div>
                  </td>
                  <td className={crmTdClassName}>
                    <Who mode={mode} row={row} />
                  </td>
                  <td className={crmTdClassName}>
                    <Place row={row} />
                  </td>
                  <td className={crmTdClassName}>
                    <LastColumn mode={mode} noteIndex={noteIndex} row={row} scope="" />
                  </td>
                </tr>
              ))}
            </tbody>
          </CrmTable>
          )}
          <div className="px-4 pb-4">
            <CrmShowMore left={found.length - shown.length} onMore={() => setPage((current) => current + 1)} page={PAGE} />
          </div>
        </>
      )}
    </div>
  );
}

/**
 * The pieces the one-by-one review draws a place in use with (owner, 2026-10-18), exported as they are
 * — the same evidence and the same two controls, never a copy. `scope` keeps the review's field ids
 * apart from this list's own.
 */
export {
  Approve as PlaceInUseApprove,
  Place as PlaceInUseEvidence,
  PHOTO_CLASS as PLACE_CHECK_PHOTO_CLASS,
  RejectInUse as PlaceInUseReject,
  photoAlt as placeInUsePhotoAlt,
  readingText as placeReadingText,
  SCHEDULE_TEXT as PLACE_SCHEDULE_TEXT,
  signboardText as placeSignboardText,
};
