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
 * 🔴 ON A DESKTOP EACH CUSTOMER IS A ROW OF THE BUILDING'S OWN TABLE, UNDER THE BUILDING (owner, 23 Nov
 * 2026: "Fix them", after the re-score gave a building's row 5 of 10). They used to be stacked inside the
 * building's first cell, 34% of the table: each customer's name, timetable and decision ran one under the
 * other in 381 px and stood 693 px tall, so a building with seven customers was 8,410 px on a 1440 page
 * and 9,956 px on his own screen, with seven Approve buttons a screen apart. Now the customer's name is
 * under the building, the timetable under the two photographs and the decision under the decision, side
 * by side in one row. A phone draws the same customers as cards. Square corners throughout.
 *
 * The customer's pieces live beside this file since the split of 23 Nov 2026: what is read in
 * `shared-place-customers-evidence.tsx`, the decision in `shared-place-customers-decision.tsx`. This file
 * keeps the block itself — the phone cards and the desktop stack.
 */

import type { PlaceCheckNotesMode } from "@/components/phoenix-crm/place-check-notes";
import { LastColumn } from "@/components/phoenix-crm/shared-place-customers-decision";
import { Timetable, Who } from "@/components/phoenix-crm/shared-place-customers-evidence";
import { CrmCardsOnPhone, crmTdClassName } from "@/components/phoenix-crm/ui";
import type { SeatedCustomer } from "@/lib/phoenix-crm/shared-place-groups";
import type { PlaceNoteIndex } from "@/lib/phoenix-crm/view-types";

/** The columns of the building's table (`SharedPlaceList`): a customer's row spans them 1 · 2 · 2. */
export const SEATED_TABLE_COLUMNS = 5;

export function SeatedCustomers({
  customers,
  layout,
  mode,
  noTimetable,
  noteIndex,
  total,
  venueTimetablePath,
}: {
  customers: SeatedCustomer[];
  /**
   * Which of the two layouts to draw. The polyclinic list draws a phone block and a desktop table, and
   * hands each one the matching layout, so a control's label always points at the control the reader can
   * see. "table" draws table ROWS: it stands inside the building table's own body, never in a cell.
   */
  layout: "cards" | "table";
  mode: PlaceCheckNotesMode;
  /** The administrator declared this building has no timetable — see `SharedPlaceBoardRow.timetableExempt`. */
  noTimetable: boolean;
  noteIndex: PlaceNoteIndex;
  /** How many are seated in the building before the filters, so a narrowed list says so. */
  total: number;
  /** The building's one timetable, so a customer's own copy is drawn only when it is a different photograph. */
  venueTimetablePath: string | null;
}) {
  const nobody = total === 0 ? "Nobody is seated in this building yet." : `${total} ${total === 1 ? "customer is" : "customers are"} seated here; none match these filters.`;
  const heading = customers.length === total ? `Customers seated here (${total})` : `Customers seated here (${customers.length} of ${total})`;
  if (layout === "table") {
    // Rows of the building's table, tinted so they read as the building's own: one line of who is seated,
    // then a row each. The cells keep the table's own class, so they wrap as every other cell does.
    return (
      <>
        <tr className="bg-slate-50" data-seated-heading>
          {/* A header cell: it heads the group of rows under it, it is not a panel a row opens. */}
          <th className="break-words border-b border-slate-100 px-3 py-1.5 text-left text-xs font-black uppercase tracking-[0.12em] text-slate-500" colSpan={SEATED_TABLE_COLUMNS} scope="rowgroup">
            {customers.length === 0 ? <span className="font-semibold normal-case tracking-normal">{nobody}</span> : heading}
          </th>
        </tr>
        {customers.map((customer) => (
          <tr key={customer.key} className="bg-slate-50/60" data-seated-row>
            <td className={crmTdClassName}>
              <Who customer={customer} mode={mode} />
            </td>
            <td className={crmTdClassName} colSpan={2}>
              <Timetable customer={customer} mode={mode} noTimetable={noTimetable} venueTimetablePath={venueTimetablePath} />
            </td>
            <td className={crmTdClassName} colSpan={2}>
              <LastColumn customer={customer} mode={mode} noTimetable={noTimetable} noteIndex={noteIndex} scope="table" />
            </td>
          </tr>
        ))}
      </>
    );
  }
  if (customers.length === 0) return <p className="break-words px-4 py-3 text-xs text-slate-500">{nobody}</p>;
  return (
    <div className="min-w-0">
      <p className="break-words px-4 pt-3 text-xs font-black uppercase tracking-[0.12em] text-slate-500">{heading}</p>
      <CrmCardsOnPhone>
        {customers.map((customer) => (
          <div key={customer.key} className="space-y-3 px-4 py-4">
            <Who customer={customer} mode={mode} />
            <Timetable customer={customer} mode={mode} noTimetable={noTimetable} venueTimetablePath={venueTimetablePath} />
            <LastColumn customer={customer} mode={mode} noTimetable={noTimetable} noteIndex={noteIndex} scope="cards" />
          </div>
        ))}
      </CrmCardsOnPhone>
    </div>
  );
}

/**
 * The pieces the one-by-one review draws each seated customer with (owner, 2026-10-18: "approve or
 * reject the timetable or schedule alone … per customer"), exported as they are — the same evidence and
 * the same controls, never a copy.
 */
export { LastColumn as SeatedLastColumn, Timetable as SeatedTimetableEvidence, Who as SeatedWho };
