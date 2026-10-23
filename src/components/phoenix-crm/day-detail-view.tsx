"use client";

import { cairoClock, dayLabelLong } from "@/components/phoenix-crm/format";
import { listText } from "@/components/phoenix-crm/labels";
import { ManagerPlanActual } from "@/components/phoenix-crm/manager-plan-actual-table";
import { AdminDelete } from "@/components/phoenix-crm/admin-delete";
import { MissedRecordPanel } from "@/components/phoenix-crm/missed-record-panel";
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
import { visitDetailEditedText } from "@/components/phoenix-crm/visit-detail-panel";
import { EditVisit } from "@/components/phoenix-crm/visit-edit-panel";
import { CrmVisitRecordingPlayer, CrmVoiceNotePlayer } from "@/components/phoenix-crm/voice-playback";
import { awaitingValidationNote } from "@/lib/crm/call-rate";
import { DAY_START_READ_LABEL, dayStartReadLine } from "@/lib/phoenix-crm/day-start-rules";
import { MISSED_RECORD_MARK } from "@/lib/phoenix-crm/missed-records";
import { LEAVE_UNREAD_NOTE } from "@/lib/phoenix-crm/plan-leave";
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
  const { awaitingApproval, awaitingValidation, counts, dayActivity, dayStart, onLeave, pharmacies, territory, visits } = view;

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
          {/* 🔴 Three figures apart. There is no combined number on this page. And they are the
              CALENDAR CELL's own figures — only the visits that count in a KPI — so the grid and the
              page the grid links to can never print two different numbers for one Tuesday. */}
          <CrmStatGrid>
            <CrmStat label="AM" note="Counted in the KPIs" value={counts.am} />
            <CrmStat label="PM" note="Counted in the KPIs" value={counts.pm} />
            <CrmStat label="Pharmacies" note="Counted apart, never inside AM or PM" value={counts.pharmacies} />
            <CrmStat label="Territory" value={territory.name} />
          </CrmStatGrid>
          {/* 🔴 WHEN HE SAID HE STARTED — and nothing at all when he did not press it (owner,
              2026-10-03: "show the day start time on the manager's team day screen too"). The press
              never blocks a visit and was never required, so a missing one is a missing line rather
              than "not confirmed" written against him; `dayStartReadLine` holds that rule, and every
              day before the feature existed has none. */}
          {dayStart ? (
            <p className="mt-2 break-words text-sm font-semibold leading-6 text-slate-700">
              <span className="font-black text-slate-900">{DAY_START_READ_LABEL}: </span>
              {dayStartReadLine(dayStart, cairoClock(dayStart.startedAt))}
            </p>
          ) : null}
          {/* 🔴 Saved, real, and in no figure yet — so a 0 above a list of visits says WHY. The same
              sentence both call-rate boards and the calendar print, and the two reasons stay apart. */}
          {awaitingValidationNote({ awaitingValidation }) ? (
            <CrmNote title="Some of this day is not scored yet" tone="info">
              <p>{awaitingValidationNote({ awaitingValidation })}</p>
            </CrmNote>
          ) : null}
          {awaitingApproval > 0 ? (
            <CrmNote title="Off the plan, still with the approvers" tone="info">
              <p>
                {awaitingApproval === 1
                  ? "1 off-plan visit is waiting for a decision, so it is in none of the figures above."
                  : `${awaitingApproval} off-plan visits are waiting for a decision, so they are in none of the figures above.`}
              </p>
            </CrmNote>
          ) : null}
          {view.isTest ? (
            <CrmNote title="Test entries" tone="info">
              <p>This day is being read in test mode, so it shows test entries and not the field force&apos;s own.</p>
            </CrmNote>
          ) : null}
        </CrmBlock>

        {dayActivity || onLeave || view.leaveUnread ? (
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
                {dayActivity.enteredByAdmin ? ` · ${MISSED_RECORD_MARK}` : ""}
              </p>
            ) : null}
            {dayActivity && view.adminDeletes && dayActivity.id ? (
              <div className="mt-2">
                <AdminDelete id={dayActivity.id} isTest={view.isTest} kind="day_activity" subject={`the record "${dayActivity.activityLabel}"`} />
              </div>
            ) : null}
            {onLeave ? (
              <p className="mt-1 break-words text-sm font-semibold leading-6 text-slate-700">
                HR has approved leave covering this day.
              </p>
            ) : null}
            {/* 🔴 Said, never swallowed: without it a day of approved leave reads exactly like a day
                the rep worked and logged nothing. */}
            {view.leaveUnread ? (
              <p className="mt-1 break-words text-sm font-semibold leading-6 text-amber-800">{LEAVE_UNREAD_NOTE}</p>
            ) : null}
          </CrmBlock>
        ) : null}

        {/* Every visit in full, as the same table a manager's day page draws (owner, 2026-10-21: "everyone's visits in
            details … exactly as Mina Farouk"). The cards below keep what only they carry: products left behind, the
            voice note, the write-up, and the Super Admin's corrections. */}
        <CrmBlock title="Plan against actual, with the detail of every visit">
          {view.visitsInFullUnread ? (
            <CrmNote title="The visits in full could not be read" tone="warn">
              <p>Every visit of the day is still listed below. Reload the page in a minute to see them in full here.</p>
            </CrmNote>
          ) : view.visitsInFull.length === 0 ? (
            <CrmEmpty message="No visit was recorded on this day." title="Nothing was logged" />
          ) : (
            <ManagerPlanActual plan={null} planUnread={false} visits={view.visitsInFull} />
          )}
        </CrmBlock>

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
                  // The Super Admin takes back a visit HE entered by mistake (owner, 2026-10-01) — drawn
                  // only on his own entries; the database refuses every other visit anyway.
                  // And corrects one a rep submitted (owner, 2026-10-06) — who was on it, its products, its
                  // comment — on any visit of the day, his own entries included.
                  // And, since 2026-10-23, deletes ANY visit as if it never happened — his own entries
                  // included, which is why the older "remove what I entered" button is gone.
                  actions={
                    view.editsVisits || view.adminDeletes ? (
                      <>
                        {view.editsVisits ? <EditVisit isTest={view.isTest} seatId={territory.seatId} visitId={visit.visitId} /> : null}
                        {view.adminDeletes ? (
                          <AdminDelete id={visit.visitId} isTest={view.isTest} kind="visit" subject={`the visit to ${visit.customerName}`} />
                        ) : null}
                      </>
                    ) : undefined
                  }
                  key={visit.visitId}
                  meta={`${timeOf(visit)} · ${listText(visit.listType)} · ${visit.kindLabel}`}
                  status={
                    <span className="flex min-w-0 flex-wrap gap-1.5">
                      {visit.unplanned ? <CrmPill tone="warn">{visit.unplanned.statusLabel}</CrmPill> : null}
                      {visit.outOfList ? <CrmPill tone="warn">{visit.outOfList.label}</CrmPill> : null}
                      {/* 🔴 The row's own answer to the question the headline figures ask, so a
                          reader counting the cards can see which ones the numbers above are made of.
                          It is a fact about the LIST — the customer has not been admitted yet — and
                          never a mark against the rep. An out-of-list visit already says it in its
                          own words above, so it is not said twice. */}
                      {!visit.customerValidated && !visit.outOfList ? (
                        <CrmPill tone="neutral">Not scored yet — the customer is not validated</CrmPill>
                      ) : null}
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
                    {visit.repName || visit.managerName || visit.seniorName || visit.productManagerName ? (
                      <p className="break-words">
                        <span className="font-black text-slate-800">On the visit: </span>
                        {[visit.repName, visit.managerName, visit.seniorName, visit.productManagerName].filter(Boolean).join(", ")}
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
                    {typeof visit.recordingSeconds === "number" ? (
                      <CrmVisitRecordingPlayer seconds={visit.recordingSeconds} visitId={visit.visitId} />
                    ) : null}
                    {/* What the rep came back and wrote up afterwards, and when (owner, 2026-10-15).
                        It sits BESIDE the door comment above, never instead of it. */}
                    {visit.detailComment ? (
                      <p className="whitespace-pre-line break-words">
                        <span className="font-black text-slate-800">The visit in full: </span>
                        <span dir="auto">{visit.detailComment}</span>
                      </p>
                    ) : null}
                    {visitDetailEditedText(visit.detailEditedAt) ? (
                      <p className="break-words text-slate-500">{visitDetailEditedText(visit.detailEditedAt)}</p>
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
                    {/* The REASON, as the Visits tab shows it — `note` is the status sentence, which
                        the pill above already says, and printing it after "because" hid the reason. */}
                    {visit.unplanned?.clarification ? (
                      <p className="break-words">
                        <span className="font-black text-slate-800">Off the plan because: </span>
                        <span dir="auto">{visit.unplanned.clarification}</span>
                      </p>
                    ) : null}
                    {/* A visit the rep missed logging, entered for him by the Super Admin, says so in the
                        owner's words (2026-10-01); a manager's entry says his name, as before. */}
                    {visit.enteredByAdmin ? (
                      <p className="break-words">{MISSED_RECORD_MARK}</p>
                    ) : visit.enteredByName && visit.enteredByName !== visit.repName ? (
                      <p className="break-words">Entered by {visit.enteredByName}</p>
                    ) : null}
                  </div>
                </CrmCard>
              ))}
            </div>
          )}
        </CrmBlock>

        {/* The Super Admin's own: enter what the rep missed on this day (owner, 2026-10-01). The server
            decided it — `missedRecords` is null for everyone else. */}
        {view.missedRecords ? (
          <MissedRecordPanel
            date={view.date}
            isTest={view.isTest}
            repName={territory.repName}
            seatId={view.missedRecords.seatId}
          />
        ) : null}

        {pharmacies.length > 0 ? (
          <CrmBlock title="Pharmacies they took feedback from">
            {/* Each one once, whatever the spelling, and beside the visits rather than inside them.
                🔴 EVERY pharmacy is listed — the feedback was really taken — while the FIGURE above
                counts the ones a scored visit named, which is what the calendar cell counts. The
                difference is said on the line rather than left as two numbers that disagree. */}
            <div className="grid min-w-0 gap-1.5">
              {pharmacies.map((pharmacy) => (
                <p className="break-words text-xs font-semibold leading-5 text-slate-600" key={pharmacy.name}>
                  <span className="font-black text-slate-800" dir="auto">
                    {pharmacy.name}
                  </span>
                  {` · from ${cairoClock(pharmacy.firstCapturedAt)}`}
                  {/* Visited in its own right, it was named on no doctor's visit (owner, 2026-10-03). */}
                  {pharmacy.fromCustomers.length > 0 ? ` · on the visit to ${pharmacy.fromCustomers.join(", ")}` : " · a pharmacy visit"}
                  {pharmacy.counted ? "" : " · not in the figure above yet"}
                </p>
              ))}
            </div>
          </CrmBlock>
        ) : null}
      </CrmPanel>
    </div>
  );
}
