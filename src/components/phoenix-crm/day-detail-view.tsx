"use client";

import { cairoClock, dayLabelLong } from "@/components/phoenix-crm/format";
import { listText } from "@/components/phoenix-crm/labels";
import {
  CrmBlock,
  CrmCard,
  CrmEmpty,
  CrmNote,
  CrmPanel,
  CrmPill,
  CrmStat,
  CrmStatGrid,
} from "@/components/phoenix-crm/ui";
import { CrmVoiceNotePlayer } from "@/components/phoenix-crm/voice-playback";
// Through `view-types`, never `server/day-detail`: a component may not import server code, and an
// `import type` counts — the boundary test caught exactly this on the first run.
import type { PhoenixCrmDayDetail } from "@/lib/phoenix-crm/view-types";

/**
 * Phoenix CRM — one person's day, in full, on its own page.
 *
 * Owner, 2026-09-30, of the team calendar: *"when I press on any day that have activity, I am
 * redirected to a new tab with the full detail of this day, with location, timing, everything."*
 *
 * 🔴 IT IS NOT THE VISITS TAB'S CARD, AND THAT IS DELIBERATE. The Visits tab shows NO location, to
 * anyone, by its own standing decision. This page carries the location line he asked for — and it
 * is safe to, because the server blanked it already for the one audience that must never read it:
 * a rep opening his own day gets "Visit saved", with no distance and no flag (Golden rule #1,
 * `isLocationBlind`). The screen makes no such decision of its own, and must never start.
 *
 * 🔴 THE THREE FIGURES STAY APART — AM · PM · Pharmacies, never a total, and a pharmacy is a
 * DISTINCT NAME rather than a row (`day-detail.ts`).
 *
 * Reached only by a link from the calendar, in a new tab, so nothing here navigates away: it is a
 * leaf, and the way back is the tab the reader came from.
 */

function timeOf(visit: { capturedAt: string }): string {
  return cairoClock(visit.capturedAt);
}

export function DayDetailView({ view }: { view: PhoenixCrmDayDetail }) {
  const { counts, dayActivity, onLeave, pharmacies, territory, visits } = view;

  return (
    <div className="grid min-w-0 gap-3">
      <CrmPanel
        // The title already names the person, so the line under it names the PLACE and the manager
        // above — `territoryLine` would repeat the name back at the reader.
        description={`${territory.name}${territory.reviewerName ? ` · under ${territory.reviewerName}` : ""}`}
        eyebrow="Phoenix CRM · the day in full"
        title={`${territory.repName ?? "Seat is vacant"} · ${dayLabelLong(view.date)}`}
      >
        <CrmBlock title="The day">
          {/* 🔴 Three figures apart. There is no combined number on this page. */}
          <CrmStatGrid>
            <CrmStat label="AM" value={counts.am} />
            <CrmStat label="PM" value={counts.pm} />
            <CrmStat label="Pharmacies" note="Counted apart, never inside AM or PM" value={counts.pharmacies} />
            <CrmStat label="Territory" value={territory.name} />
          </CrmStatGrid>
          {view.isTest ? (
            <CrmNote title="Test entries" tone="info">
              <p>This day is being read in test mode, so it shows test entries and not the field force&apos;s own.</p>
            </CrmNote>
          ) : null}
        </CrmBlock>

        {dayActivity || onLeave ? (
          <CrmBlock title="What else this day was">
            {dayActivity ? (
              <p className="break-words text-sm font-semibold leading-6 text-slate-700">
                <span className="font-black text-slate-900">Recorded as: </span>
                {dayActivity.activityLabel}
                {dayActivity.halfDay ? " (half day)" : ""}
                {dayActivity.note ? (
                  <>
                    {" — "}
                    <span dir="auto">{dayActivity.note}</span>
                  </>
                ) : null}
              </p>
            ) : null}
            {onLeave ? (
              <p className="mt-1 break-words text-sm font-semibold leading-6 text-slate-700">
                HR has approved leave covering this day.
              </p>
            ) : null}
          </CrmBlock>
        ) : null}

        <CrmBlock title="The visits, in the order they happened">
          {visits.length === 0 ? (
            <CrmEmpty
              message="No visit was recorded on this day. A recorded activity or approved leave, where there is one, is above."
              title="Nothing was logged"
            />
          ) : (
            <div className="grid min-w-0 gap-2">
              {visits.map((visit) => (
                <CrmCard
                  accent="border-l-orange-500"
                  key={visit.visitId}
                  meta={`${timeOf(visit)} · ${listText(visit.listType)} · ${visit.kindLabel}`}
                  status={
                    <span className="flex min-w-0 flex-wrap gap-1.5">
                      {visit.unplanned ? <CrmPill tone="warn">{visit.unplanned.statusLabel}</CrmPill> : null}
                      {visit.outOfList ? <CrmPill tone="warn">{visit.outOfList.label}</CrmPill> : null}
                      {visit.clockOff ? <CrmPill tone="warn">The phone&apos;s clock was off</CrmPill> : null}
                    </span>
                  }
                  title={visit.customerName}
                >
                  <div className="grid min-w-0 gap-1.5 text-xs font-semibold leading-5 text-slate-600">
                    {/* 🔴 The location, as the SERVER decided this reader may read it. A rep's own
                        copy says "Visit saved" and nothing else. */}
                    <p className="break-words">
                      <span className="font-black text-slate-800">Where: </span>
                      {visit.locationLabel}
                    </p>
                    {visit.repName || visit.managerName || visit.seniorName ? (
                      <p className="break-words">
                        <span className="font-black text-slate-800">On the visit: </span>
                        {[visit.repName, visit.managerName, visit.seniorName].filter(Boolean).join(", ")}
                      </p>
                    ) : null}
                    <p className="break-words">
                      <span className="font-black text-slate-800">Products: </span>
                      {visit.products.join(", ") || "—"}
                    </p>
                    {visit.pharmacyName ? (
                      <p className="break-words">
                        <span className="font-black text-slate-800">Pharmacy: </span>
                        <span dir="auto">{visit.pharmacyName}</span>
                      </p>
                    ) : null}
                    {visit.samples.length > 0 ? (
                      <p className="break-words">
                        <span className="font-black text-slate-800">Left behind: </span>
                        {visit.samples.map((sample) => `${sample.label} × ${sample.quantity}`).join(", ")}
                      </p>
                    ) : null}
                    {visit.comment ? (
                      <p className="whitespace-pre-line break-words">
                        <span className="font-black text-slate-800">Comment: </span>
                        <span dir="auto">{visit.comment}</span>
                      </p>
                    ) : null}
                    {visit.voiceNotePath ? (
                      <CrmVoiceNotePlayer path={visit.voiceNotePath} seconds={visit.voiceNoteSeconds} />
                    ) : null}
                    {visit.outcome?.objectionLabel ? (
                      <p className="break-words">
                        <span className="font-black text-slate-800">Objection: </span>
                        {visit.outcome.objectionLabel}
                        {visit.outcome.objectionNote ? (
                          <>
                            {" — "}
                            <span dir="auto">{visit.outcome.objectionNote}</span>
                          </>
                        ) : null}
                      </p>
                    ) : null}
                    {visit.outcome?.nextStepLabel ? (
                      <p className="break-words">
                        <span className="font-black text-slate-800">Next step: </span>
                        {visit.outcome.nextStepLabel}
                        {visit.outcome.nextStepOn ? ` · ${dayLabelLong(visit.outcome.nextStepOn)}` : ""}
                      </p>
                    ) : null}
                    {visit.unplanned?.note ? (
                      <p className="break-words">
                        <span className="font-black text-slate-800">Off the plan because: </span>
                        <span dir="auto">{visit.unplanned.note}</span>
                      </p>
                    ) : null}
                    {visit.enteredByName && visit.enteredByName !== visit.repName ? (
                      <p className="break-words">Entered by {visit.enteredByName}</p>
                    ) : null}
                  </div>
                </CrmCard>
              ))}
            </div>
          )}
        </CrmBlock>

        {pharmacies.length > 0 ? (
          <CrmBlock title="Pharmacies he took feedback from">
            {/* Each one once, whatever the spelling, and beside the visits rather than inside them. */}
            <div className="grid min-w-0 gap-1.5">
              {pharmacies.map((pharmacy) => (
                <p className="break-words text-xs font-semibold leading-5 text-slate-600" key={pharmacy.name}>
                  <span className="font-black text-slate-800" dir="auto">
                    {pharmacy.name}
                  </span>
                  {` · from ${cairoClock(pharmacy.firstCapturedAt)} · on the visit to ${pharmacy.fromCustomers.join(", ")}`}
                </p>
              ))}
            </div>
          </CrmBlock>
        ) : null}
      </CrmPanel>
    </div>
  );
}
