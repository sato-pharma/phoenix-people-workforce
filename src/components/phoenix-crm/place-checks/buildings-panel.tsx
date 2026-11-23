"use client";

/**
 * Phoenix CRM — Place checks: Polyclinics and hospitals. Every building, one card each, with its sign,
 * its timetable and the customers seated in it.
 *
 * 🔴 A REJECTED BUILDING IS BEHIND ITS OWN SWITCH, and a building opened from "Timetables that keep
 * failing" is read past the filters (`use-board-rows.ts`). That list is the deciders' board's alone.
 */

import { AdminCallout } from "@/components/admin/admin-design-system";
import { FailingTimetablesPanel } from "@/components/phoenix-crm/failing-timetables-panel";
import { PAGE_BUILDINGS, Paged } from "@/components/phoenix-crm/place-checks/paged";
import { PlaceCheckSection } from "@/components/phoenix-crm/place-checks/section";
import type { PlaceCheckBoard } from "@/components/phoenix-crm/place-checks/use-place-check-board";
import { SharedPlaceList } from "@/components/phoenix-crm/shared-place-list";
import { CrmButton, CrmCheck } from "@/components/phoenix-crm/ui";
import { rejectedBuildingsSwitchLabel } from "@/lib/phoenix-crm/validation-feedback";

export function PlaceChecksBuildingsPanel({ board }: { board: PlaceCheckBoard }) {
  const {
    anyFilter,
    bulkRunning,
    canRestore,
    failingTimetables,
    filterKey,
    filteredVenueGroups,
    filters,
    listedBuildings,
    mode,
    noteIndex,
    onlyBuilding,
    openedBuilding,
    rejectedBuildings,
    setOnlyBuilding,
    setShowRejectedBuildings,
    showRejectedBuildings,
    team,
  } = board;
  return (
    <>
      {!team && failingTimetables ? (
        <fieldset className="m-0 min-w-0 border-0 p-0" disabled={bulkRunning}>
        <FailingTimetablesPanel
          onOpen={(sharedPlaceId) => {
            setOnlyBuilding(sharedPlaceId);
            window.setTimeout(() => document.getElementById("vr-building-list")?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
          }}
          opened={onlyBuilding}
          view={failingTimetables}
        />
        </fieldset>
      ) : null}
      {openedBuilding ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="break-words text-sm text-slate-700">Showing the one building you opened, whatever the filters say.</span>
          <CrmButton disabled={bulkRunning} onClick={() => setOnlyBuilding(null)} size="sm">
            Show every building
          </CrmButton>
        </div>
      ) : null}
      {!openedBuilding && rejectedBuildings > 0 && filters.outcome !== "rejected" ? (
        <CrmCheck checked={showRejectedBuildings} disabled={bulkRunning} onChange={setShowRejectedBuildings}>
          {rejectedBuildingsSwitchLabel(rejectedBuildings, { team, canRestore })}
        </CrmCheck>
      ) : null}
      <div className="scroll-mt-4" id="vr-building-list" />
      <PlaceCheckSection
        title={`Polyclinics and hospitals (${listedBuildings.length})`}
        description={
          team
            ? "A polyclinic, medical centre or hospital outpatient suite is validated ONCE, at its own door — a live photo of the sign on the building and both readings inside the place line — and every customer who receives behind that door is then seated in it against the building's one timetable. Each building is one card: its name and where it is, the sign on its door and its timetable, then the customers seated in it with what that timetable says about each. The buildings with something open or wrong come first."
            : "A polyclinic, medical centre or hospital outpatient suite is validated ONCE, at its own door — a live photo of the sign on the building and both readings inside the place line — and every customer who receives behind that door is then seated in it against the building's one timetable. Each building is one card: its name and where it is, the sign on its door and its timetable, then the customers seated in it with what that timetable says about each. The buildings with something open or wrong come first. Rejecting a building retires it, retires everybody seated in it, and sends each of them back to To validate. A customer the timetable does not name is rejected on their own row, which leaves the building and everybody else seated in it alone."
        }
      >
        {listedBuildings.length === 0 ? (
          <div className="px-4 py-4">
            <AdminCallout tone="neutral">
              <span>
                {openedBuilding
                  ? "This building is no longer on the board. Show every building to see the rest."
                  : anyFilter || filters.outcome !== "all"
                    ? "No polyclinic or hospital matches these filters."
                    : "No polyclinic or centre has been captured yet."}
              </span>
            </AdminCallout>
          </div>
        ) : (
          <Paged key={`${filterKey}|${showRejectedBuildings}|${onlyBuilding ?? ""}`} noun="buildings" rows={listedBuildings} size={PAGE_BUILDINGS}>
            {(groups) => <SharedPlaceList groups={groups} mode={mode} noteIndex={noteIndex} />}
          </Paged>
        )}
      </PlaceCheckSection>
      <p className="break-words text-xs text-slate-500">
        {filteredVenueGroups.length} {filteredVenueGroups.length === 1 ? "building" : "buildings"} on the board in all.
      </p>
    </>
  );
}
