"use client";

/**
 * Phoenix CRM — the customers seated in one polyclinic, drawn under the building itself (owner,
 * 2026-10-17: "make sure every polyclinic is grouped with the customers in it, showing … the customers'
 * timetable, and make the option for the admin to reject a customer who is not in the timetable").
 *
 * A seated customer has no sign and no reading of his own — the building holds both — so what stands
 * behind his name is the TIMETABLE inside it, photographed once for everybody. Each row therefore says
 * what the system read beside his name on that timetable (it names him, names somebody else, or there
 * is no timetable in the photo), shows his own copy of the photo only when it is not the building's, and
 * gives the Super Admin the one control the request names: reject him because he is not on it.
 *
 * A desktop stacks the customers inside their building's own first cell (the list is one row per
 * building); a phone draws the same customers as cards. Square corners throughout.
 *
 * The customer's pieces live beside this file since the split of 23 Nov 2026: what is read in
 * `shared-place-customers-evidence.tsx`, the decision in `shared-place-customers-decision.tsx`. This file
 * keeps the block itself — the phone cards and the desktop stack.
 */

import type { PlaceCheckNotesMode } from "@/components/phoenix-crm/place-check-notes";
import { LastColumn } from "@/components/phoenix-crm/shared-place-customers-decision";
import { Timetable, Who } from "@/components/phoenix-crm/shared-place-customers-evidence";
import { CrmCardsOnPhone } from "@/components/phoenix-crm/ui";
import type { SeatedCustomer } from "@/lib/phoenix-crm/shared-place-groups";
import type { PlaceNoteIndex } from "@/lib/phoenix-crm/view-types";

export function SeatedCustomers({
  customers,
  layout = "both",
  mode,
  noTimetable,
  noteIndex,
  total,
  venueTimetablePath,
}: {
  customers: SeatedCustomer[];
  /**
   * Which of the two layouts to draw. The polyclinic list already draws a phone block and a desktop
   * block, and hands each one the matching layout, so a customer is on the page once per screen size
   * and a control's label always points at the control the reader can see.
   */
  layout?: "both" | "cards" | "table";
  mode: PlaceCheckNotesMode;
  /** The administrator declared this building has no timetable — see `SharedPlaceBoardRow.timetableExempt`. */
  noTimetable: boolean;
  noteIndex: PlaceNoteIndex;
  /** How many are seated in the building before the filters, so a narrowed list says so. */
  total: number;
  /** The building's one timetable, so a customer's own copy is drawn only when it is a different photograph. */
  venueTimetablePath: string | null;
}) {
  if (customers.length === 0) {
    return (
      <p className="break-words px-4 py-3 text-xs text-slate-500">
        {total === 0 ? "Nobody is seated in this building yet." : `${total} ${total === 1 ? "customer is" : "customers are"} seated here; none match these filters.`}
      </p>
    );
  }
  return (
    <div className="min-w-0">
      <p className="break-words px-4 pt-3 text-xs font-black uppercase tracking-[0.12em] text-slate-500">
        {customers.length === total ? `Customers seated here (${total})` : `Customers seated here (${customers.length} of ${total})`}
      </p>
      {layout !== "table" ? (
        <CrmCardsOnPhone>
          {customers.map((customer) => (
            <div key={customer.key} className="space-y-3 px-4 py-4">
              <Who customer={customer} mode={mode} />
              <Timetable customer={customer} mode={mode} noTimetable={noTimetable} venueTimetablePath={venueTimetablePath} />
              <LastColumn customer={customer} mode={mode} noTimetable={noTimetable} noteIndex={noteIndex} scope="cards" />
            </div>
          ))}
        </CrmCardsOnPhone>
      ) : null}
      {/* On a desktop the customers sit in their building's own first cell, one block each: a table
          inside a table cell would be a second row for the same building. */}
      {layout !== "cards" ? (
        <div className="hidden min-w-0 md:block">
          {customers.map((customer) => (
            <div key={customer.key} className="space-y-3 border-t border-slate-100 px-4 py-3 first:border-t-0">
              <Who customer={customer} mode={mode} />
              <Timetable customer={customer} mode={mode} noTimetable={noTimetable} venueTimetablePath={venueTimetablePath} />
              <LastColumn customer={customer} mode={mode} noTimetable={noTimetable} noteIndex={noteIndex} scope="table" />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The pieces the one-by-one review draws each seated customer with (owner, 2026-10-18: "approve or
 * reject the timetable or schedule alone … per customer"), exported as they are — the same evidence and
 * the same controls, never a copy.
 */
export { LastColumn as SeatedLastColumn, Timetable as SeatedTimetableEvidence, Who as SeatedWho };
