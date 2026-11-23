"use client";

/**
 * Phoenix CRM — Place checks: Not confirmed. The clinics in use whose photograph the system could not
 * confirm and nobody has looked at, narrowed by one chip (owner, 2026-10-17: "make me see what is the
 * unreadable — the photos").
 *
 * 🔴 THE SCORECARD COUNTS A CUSTOMER SEATED IN A POLYCLINIC TOO, and this list is the single clinics: the
 * seated ones are named and pointed to on their building's card, never repeated here.
 */

import { AdminCallout } from "@/components/admin/admin-design-system";
import { PlaceCheckSection } from "@/components/phoenix-crm/place-checks/section";
import type { PlaceCheckBoard } from "@/components/phoenix-crm/place-checks/use-place-check-board";
import { CrmButton } from "@/components/phoenix-crm/ui";
import { ValidatedPlaceList } from "@/components/phoenix-crm/validated-place-list";
import { chipTakes, type UnconfirmedChip } from "@/lib/phoenix-crm/place-checks-on-demand";
import { cn } from "@/lib/utils";

const CHIP_LABELS: Record<UnconfirmedChip, string> = {
  open: "Not confirmed",
  notReadable: "Not readable",
  wrongPhoto: "No sign in the photo",
  anotherName: "Another name",
  notRead: "Never read",
  all: "Every place in use",
};

const CHIP_TITLES: Record<UnconfirmedChip, string> = {
  open: "In use, not confirmed by the reader, and nobody has looked",
  notReadable: "In use, and the sign could not be read",
  wrongPhoto: "In use, and no sign in the photo",
  anotherName: "In use, and the sign names somebody else",
  notRead: "In use, and the sign was never read",
  all: "Every clinic in use",
};

export function PlaceChecksInUsePanel({ board }: { board: PlaceCheckBoard }) {
  const { anyFilter, bulkRunning, chip, filteredValidated, inUse, mode, noteIndex, seatedInChip, selectView, setChip, showValidated, team, validatedKey } = board;
  return (
    <>
      <div aria-label="Narrow the places in use" className="flex min-w-0 flex-wrap gap-2" role="group">
        {(Object.keys(CHIP_LABELS) as UnconfirmedChip[]).map((key) => {
          const total = inUse.filter((row) => chipTakes(key, row)).length;
          return (
            <button
              key={key}
              aria-pressed={chip === key}
              className={cn(
                "inline-flex min-h-10 min-w-0 items-center gap-2 rounded-none border px-3 py-1.5 text-left text-xs font-black",
                chip === key ? "border-orange-500 bg-orange-50 text-orange-800" : "border-slate-200 bg-white text-slate-600 hover:border-slate-300",
              )}
              disabled={bulkRunning}
              onClick={() => setChip(key)}
              type="button"
            >
              <span className="break-words">{CHIP_LABELS[key]}</span>
              <span className="tabular-nums">{total}</span>
            </button>
          );
        })}
      </div>
      {seatedInChip > 0 ? (
        <div className="flex min-w-0 flex-wrap items-center gap-3 border-l-4 border-orange-500 bg-white px-4 py-3">
          <p className="min-w-0 flex-1 basis-60 break-words text-sm text-slate-700">
            {seatedInChip} more {seatedInChip === 1 ? "is a customer" : "are customers"} seated in a polyclinic. Their photo is the
            building&apos;s timetable, shown once on its card.
          </p>
          <CrmButton onClick={() => selectView("polyclinics")} size="sm">
            Open Polyclinics and hospitals
          </CrmButton>
        </div>
      ) : null}
      {showValidated ? (
        <PlaceCheckSection
          title={`${CHIP_TITLES[chip]} (${filteredValidated.length})`}
          description={
            team
              ? "Single clinics still in use whose photograph the system could not confirm: the sign could not be read, it is not a sign, it names somebody else, or it was never read. Turn a sideways photo with the arrows on it, and open it to zoom."
              : "Single clinics still in use whose photograph the system could not confirm, and that nobody has looked at: the sign could not be read, it is not a sign, it names somebody else, or it was never read. Turn a sideways photo with the arrows on it, and open it to zoom. Rejecting one retires the place and, when it is the customer's only place, sends them back to To validate; the rep is told what is wrong with the photo and never that a person looked at them."
          }
        >
          {filteredValidated.length === 0 ? (
            <div className="px-4 py-4">
              <AdminCallout tone="success">
                <span>{anyFilter ? "Nothing in use matches these filters." : "Nothing here: every clinic in use has been confirmed by its sign or looked at."}</span>
              </AdminCallout>
            </div>
          ) : (
            <ValidatedPlaceList key={validatedKey} mode={mode} noteIndex={noteIndex} rows={filteredValidated} showSearch={false} />
          )}
        </PlaceCheckSection>
      ) : (
        <AdminCallout tone="neutral">
          <span>The outcome selected above holds no place in use.</span>
        </AdminCallout>
      )}
    </>
  );
}
