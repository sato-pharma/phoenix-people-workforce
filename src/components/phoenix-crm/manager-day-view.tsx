import { dayLabelLong } from "@/components/phoenix-crm/format";
import { ManagerPlanActualTable } from "@/components/phoenix-crm/manager-plan-actual-table";
import { CrmBlock, CrmEmpty, CrmNote, CrmPanel, CrmStat, CrmStatGrid } from "@/components/phoenix-crm/ui";
import { awaitingValidationNote } from "@/lib/crm/call-rate";
import { buildPlanVsActual } from "@/lib/phoenix-crm/manager-day-plan";
import { LEAVE_UNREAD_NOTE } from "@/lib/phoenix-crm/plan-leave";
// Through `view-types`, never `server/manager-day-detail`: a component may not import server code.
import type { PhoenixCrmManagerDayDetail } from "@/lib/phoenix-crm/view-types";

/**
 * Phoenix CRM — one MANAGER'S day, in full, on its own page.
 *
 * Owner, 2026-10-20: a district manager's visits appeared as a bare count on the team calendar; he asked for
 * "name, address, brick, type, AM/PM, when, single, double — every single detail, in a very premium, polished
 * way". The manager's row on the calendar now opens here, in a new tab, and this page is a leaf — the way back
 * is the tab the reader came from.
 *
 * 🔴 THE FIGURES ARE THE CALENDAR CELL'S OWN, and AM · PM · Pharmacies stay three figures apart: there is no
 *    combined number on this page. His own single visits count in his own report only — said here in words, so
 *    nobody reads a manager's "3" as three more calls on a territory.
 * 🔴 The day is the SAME table the private calendar draws (`ManagerPlanActualTable`), so the two never describe one
 *    visit two ways.
 */
export function ManagerDayView({ view }: { view: PhoenixCrmManagerDayDetail }) {
  const { figures, manager, visits } = view;
  const waiting = awaitingValidationNote({ awaitingValidation: figures.awaitingValidation });
  const { rows, summary } = buildPlanVsActual(view.plan, visits);

  return (
    <div className="grid min-w-0 gap-3">
      <CrmPanel
        description={`${manager.title}${manager.reportsTo ? ` · under ${manager.reportsTo}` : ""}`}
        eyebrow="Phoenix CRM · the manager's day in full"
        title={`${manager.name} · ${dayLabelLong(view.date)}`}
      >
        <CrmBlock title="The day">
          <CrmStatGrid>
            <CrmStat label="AM" note="Counted in the calendar cell" value={figures.am} />
            <CrmStat label="PM" note="Counted in the calendar cell" value={figures.pm} />
            <CrmStat label="Pharmacies" note="Counted apart, never inside AM or PM" value={figures.pharmacies} />
            <CrmStat label="Visits listed below" note="Every visit logged for this manager on this day" value={visits.length} />
          </CrmStatGrid>
          {visits.length > 0 ? (
            <CrmStatGrid className="mt-2 md:grid-cols-3">
              <CrmStat label="Own single visits" note="Made alone, counted in the manager's own report only" value={figures.ownSingle} />
              <CrmStat label="Double visits" note="With a rep, logged by the rep" value={figures.doubles} />
              <CrmStat label="Chain visits" note="With a rep and a senior manager" value={figures.chains} />
            </CrmStatGrid>
          ) : null}
          {waiting ? (
            <CrmNote title="Some of this day is not scored yet" tone="info">
              <p>{waiting}</p>
            </CrmNote>
          ) : null}
          {view.onLeave ? (
            <CrmNote title="HR has approved leave covering this day" tone="info">
              <p>Anything below was still logged on the day.</p>
            </CrmNote>
          ) : null}
          {view.leaveUnread ? (
            <p className="mt-2 break-words text-sm font-semibold leading-6 text-amber-800">{LEAVE_UNREAD_NOTE}</p>
          ) : null}
        </CrmBlock>

        <CrmBlock title="Plan against actual, with the detail of every visit">
          {rows.length === 0 ? (
            <CrmEmpty
              message="Nothing was planned for this day and no single visit of their own or ride-along with a rep was recorded."
              title="Nothing planned, nothing logged"
            />
          ) : (
            <ManagerPlanActualTable plan={view.plan} planUnread={view.planUnread} rows={rows} summary={summary} />
          )}
        </CrmBlock>
      </CrmPanel>
    </div>
  );
}
