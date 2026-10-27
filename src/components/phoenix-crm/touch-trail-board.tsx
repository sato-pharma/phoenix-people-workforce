"use client";

/**
 * Phoenix CRM — the touch trail, as the Super Admin reads it.
 *
 * Owner, 2026-10-04: "build the touch trail reader for the Super Admin."
 *
 * Two views in one board: a DAY, grouped into the page loads that made it, and one PAGE LOAD, event
 * by event in the order they happened. The day is chosen from a picker, a person narrows it, and a
 * page load opens from its own row.
 *
 * FOUR THINGS THIS SCREEN WILL NOT DO.
 *
 *   1. 🔴 IT NEVER ROUNDS A HOLE DOWN. A day past the read ceiling says so, a session longer than the
 *      stream cap names its true length, and rows the reader could not parse are counted out loud.
 *      The whole table exists because nothing is ever lost; a reader that quietly showed less would
 *      undo that in one screen.
 *
 *   2. 🔴 IT NAMES THE PERSON, NEVER HIS CODE, AND THE TERRITORY, NEVER ITS SEAT ID. The ELEMENT
 *      identity is the one technical string kept, under the human label, because it is the only part
 *      of a row a restyle cannot rename — and the label above it is what a person actually read.
 *
 *   3. IT FITS THE SCREEN. `CrmTable` is `table-fixed` with named widths on desktop; a phone draws
 *      the same rows as cards. No `overflow-x`, no `min-width`, no ellipsis — a long typed value
 *      wraps, because what the rep typed is the evidence.
 *
 *   4. 🔴 IT IS ITSELF ON THE TRAIL. The admin layout mounts the collector over this subtree, so
 *      reading the trail writes to it: the Super Admin's own page loads appear in the list. That is
 *      deliberate (every pair of hands on the module is recorded) and it is said on the screen, so
 *      nobody reads his own sessions as a rep's.
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import {
  CrmCard,
  CrmCardsOnPhone,
  CrmEmpty,
  CrmFacts,
  CrmField,
  CrmPill,
  CrmSelect,
  CrmShowMore,
  CrmTable,
  crmTdClassName,
  crmThClassName,
} from "@/components/phoenix-crm/ui";
import { formatPhoenixLongDate } from "@/lib/i18n/format";
import {
  STREAM_PAGE,
  cairoClock,
  deviceClockNote,
  durationText,
  kindWords,
  sinceLoadText,
} from "@/lib/phoenix-crm/touch-trail-reader";
import type { TouchTrailDayView, TouchTrailEventRow, TouchTrailSessionCard, TouchTrailSessionView } from "@/lib/phoenix-crm/view-types";

/**
 * ONE array per table carries both the width and the words, so the <colgroup> and the header row are
 * built from the same thing and cannot disagree by construction — the shape
 * `tests/phoenix-crm-fits-the-screen.test.ts` asks for where the widths come from a spread. The
 * percentages sum to exactly 100: under `table-fixed` anything over it leaves the box, and
 * `.admin-shell`'s `overflow-x: clip` CUTS the excess rather than scrolling it, so the reader never
 * sees what went missing. My own test asserts the sum.
 */
const SESSION_COLUMNS = [
  { head: "Whose hands", width: "28%" },
  { head: "On screen", width: "20%" },
  { head: "Events", width: "14%" },
  { head: "Screens", width: "22%" },
  { head: "Device", width: "16%" },
] as const;

const EVENT_COLUMNS = [
  { head: "Cairo clock", width: "16%" },
  { head: "What", width: "16%" },
  { head: "Where", width: "22%" },
  { head: "On what", width: "26%" },
  { head: "Typed", width: "20%" },
] as const;

/** The header row and the colgroup, from one array. */
function ColumnHeads({ columns }: { columns: ReadonlyArray<{ head: string; width: string }> }) {
  return (
    <thead>
      <tr>
        {columns.map((column) => (
          <th className={crmThClassName} key={column.head}>
            {column.head}
          </th>
        ))}
      </tr>
    </thead>
  );
}

/** Where a page load's own screen lives: the same day, narrowed to one session. */
function sessionHref(day: string, personHrId: string | null, sessionId: string): string {
  const query = new URLSearchParams({ day, session: sessionId });
  if (personHrId) query.set("person", personHrId);
  return `/admin/field-crm/touch-trail?${query.toString()}`;
}

function dayHref(day: string, personHrId: string | null): string {
  const query = new URLSearchParams({ day });
  if (personHrId) query.set("person", personHrId);
  return `/admin/field-crm/touch-trail?${query.toString()}`;
}

function kindsText(kinds: TouchTrailSessionCard["kinds"]): string {
  return kinds.map((entry) => `${kindWords(entry.kind)} ${entry.count}`).join(" · ");
}

/** The day and person pickers. A change navigates at once — no apply button to forget to press. */
function TrailFilters({ view }: { view: TouchTrailDayView }) {
  const router = useRouter();
  return (
    <div className="grid gap-3 border-b border-slate-200/80 bg-slate-50/60 px-4 py-4 sm:grid-cols-2 sm:px-5">
      <CrmField htmlFor="trail-day" label="Field day">
        <CrmSelect
          id="trail-day"
          onChange={(event) => router.push(dayHref(event.target.value, view.personHrId))}
          value={view.day}
        >
          {view.days.map((day) => (
            <option key={day} value={day}>
              {formatPhoenixLongDate(day)}
            </option>
          ))}
          {view.days.includes(view.day) ? null : <option value={view.day}>{formatPhoenixLongDate(view.day)}</option>}
        </CrmSelect>
      </CrmField>
      <CrmField
        hint={view.people.length === 0 ? "Nobody touched the module on this day." : undefined}
        htmlFor="trail-person"
        label="Whose hands"
      >
        <CrmSelect
          id="trail-person"
          onChange={(event) => router.push(dayHref(view.day, event.target.value || null))}
          value={view.personHrId ?? ""}
        >
          <option value="">Everyone on this day</option>
          {view.people.map((person) => (
            <option key={person.hrId} value={person.hrId}>
              {person.name}
            </option>
          ))}
        </CrmSelect>
      </CrmField>
    </div>
  );
}

function SessionPills({ session }: { session: TouchTrailSessionCard }) {
  const clock = deviceClockNote(session.deviceClockOffMs);
  return (
    <>
      {session.isTest ? <CrmPill tone="warn">Test persona</CrmPill> : null}
      {clock ? <CrmPill tone="bad">{clock}</CrmPill> : null}
      {session.typed > 0 ? <CrmPill tone="info">Typed {session.typed}</CrmPill> : null}
    </>
  );
}

function SessionList({ view }: { view: TouchTrailDayView }) {
  if (view.sessions.length === 0 && view.archived) {
    return (
      <CrmEmpty
        message="This day is older than 30 days. Its taps were moved out of the database into the touch trail archive, where they are kept in full."
        title="This day is archived"
      />
    );
  }
  if (view.sessions.length === 0) {
    return (
      <CrmEmpty
        message="Nothing was recorded for this day and this person. The trail began at 23:02 on 3 October 2026 and cannot look back past it."
        title="No taps on this day"
      />
    );
  }

  return (
    <>
      <CrmCardsOnPhone>
        {view.sessions.map((session) => (
          <CrmCard
            key={session.sessionId}
            meta={`${cairoClock(session.firstAt)} — ${cairoClock(session.lastAt)} · ${durationText(session.onScreenMs)} open`}
            status={<SessionPills session={session} />}
            title={
              <Link className="text-phx-accent-press underline-offset-2 hover:underline" href={sessionHref(view.day, view.personHrId, session.sessionId)}>
                {session.person}
              </Link>
            }
          >
            <CrmFacts
              facts={[
                { label: "Territory", value: session.territory ?? "No territory on this screen" },
                { label: "Events", value: session.events },
                { label: "Screens", value: session.screens.length > 0 ? session.screens.join(" → ") : "—" },
                { label: "Viewport", value: session.viewports.length > 0 ? session.viewports.join(", ") : "—" },
                { label: "What they did", value: kindsText(session.kinds) },
              ]}
            />
          </CrmCard>
        ))}
      </CrmCardsOnPhone>

      <CrmTable columns={[...SESSION_COLUMNS.map((column) => column.width)]}>
        <ColumnHeads columns={SESSION_COLUMNS} />
        <tbody>
          {view.sessions.map((session) => {
            const clock = deviceClockNote(session.deviceClockOffMs);
            return (
              <tr key={session.sessionId}>
                <td className={crmTdClassName}>
                  <Link
                    className="font-black text-phx-accent-press underline-offset-2 hover:underline"
                    href={sessionHref(view.day, view.personHrId, session.sessionId)}
                  >
                    {session.person}
                  </Link>
                  <div className="mt-1 text-xs font-semibold text-slate-500">{session.territory ?? "No territory on this screen"}</div>
                  {session.isTest ? (
                    <div className="mt-1">
                      <CrmPill tone="warn">Test persona</CrmPill>
                    </div>
                  ) : null}
                </td>
                <td className={crmTdClassName}>
                  {cairoClock(session.firstAt)} — {cairoClock(session.lastAt)}
                  <div className="mt-1 text-xs font-semibold text-slate-500">{durationText(session.onScreenMs)} open</div>
                </td>
                <td className={crmTdClassName}>
                  {session.events}
                  {session.typed > 0 ? <div className="mt-1 text-xs font-semibold text-slate-500">{session.typed} typed</div> : null}
                </td>
                <td className={crmTdClassName}>
                  {session.screens.length > 0 ? session.screens.join(" → ") : "—"}
                  <div className="mt-1 text-xs font-semibold text-slate-500">{kindsText(session.kinds)}</div>
                </td>
                <td className={crmTdClassName}>
                  {session.viewports.length > 0 ? session.viewports.join(", ") : "—"}
                  {clock ? <div className="mt-1 text-xs font-bold text-rose-700">{clock}</div> : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </CrmTable>
    </>
  );
}

function typedText(event: TouchTrailEventRow): string {
  if (event.value !== null) return event.value;
  if ((event.valueLength ?? 0) > 0) return `${event.valueLength} characters, not stored`;
  return "—";
}

function whereText(event: TouchTrailEventRow): string {
  return event.screen ?? event.route ?? "—";
}

function EventStream({ session }: { session: TouchTrailSessionView }) {
  const [shown, setShown] = useState(STREAM_PAGE);
  const events = useMemo(() => session.events.slice(0, shown), [session.events, shown]);
  const left = session.events.length - events.length;

  return (
    <>
      <CrmCardsOnPhone>
        {events.map((event) => (
          <CrmCard
            key={event.id}
            meta={`${cairoClock(event.deviceAt ?? event.occurredAt)} · ${sinceLoadText(event.msSinceLoad)} in`}
            title={kindWords(event.kind)}
          >
            <CrmFacts
              facts={[
                { label: "Where", value: whereText(event) },
                { label: "On what", value: event.label ?? "—" },
                { label: "Element", value: event.element ?? "—" },
                { label: "Typed", value: typedText(event) },
              ]}
            />
          </CrmCard>
        ))}
      </CrmCardsOnPhone>

      <CrmTable columns={[...EVENT_COLUMNS.map((column) => column.width)]}>
        <ColumnHeads columns={EVENT_COLUMNS} />
        <tbody>
          {events.map((event) => (
            <tr key={event.id}>
              <td className={crmTdClassName}>
                {cairoClock(event.deviceAt ?? event.occurredAt)}
                <div className="mt-1 text-xs font-semibold text-slate-500">{sinceLoadText(event.msSinceLoad)} in</div>
              </td>
              <td className={crmTdClassName}>{kindWords(event.kind)}</td>
              <td className={crmTdClassName}>
                {whereText(event)}
                {event.route && event.route !== event.screen ? (
                  <div className="mt-1 text-xs font-semibold text-slate-500">{event.route}</div>
                ) : null}
              </td>
              <td className={crmTdClassName}>
                {event.label ?? "—"}
                {event.element ? <div className="mt-1 text-xs font-semibold text-slate-500">{event.element}</div> : null}
              </td>
              <td className={crmTdClassName}>{typedText(event)}</td>
            </tr>
          ))}
        </tbody>
      </CrmTable>

      <CrmShowMore left={left} onMore={() => setShown((current) => current + STREAM_PAGE)} page={STREAM_PAGE} />
    </>
  );
}

export function TouchTrailBoard({ session, view }: { session: TouchTrailSessionView | null; view: TouchTrailDayView }) {
  const streamCapped = session ? session.total > session.events.length : false;
  return (
    <div className="grid gap-5">
      <section className="rounded-none border border-slate-200/90 bg-white">
        <TrailFilters view={view} />
        <div className="border-b border-slate-200/80 px-4 py-3 text-sm font-semibold text-slate-600 sm:px-5">
          {view.totals.events} events in {view.totals.sessions} page loads, from {view.totals.people}{" "}
          {view.totals.people === 1 ? "person" : "people"}, across {view.totals.screens}{" "}
          {view.totals.screens === 1 ? "screen" : "screens"}.
          {view.partial ? " THIS DAY IS LONGER THAN ONE READ — what is below is the earliest part of it." : ""}
          {view.unreadable > 0 ? ` ${view.unreadable} row(s) could not be read back and are not counted above.` : ""}
        </div>
        <SessionList view={view} />
      </section>

      {session ? (
        <section className="rounded-none border border-slate-200/90 bg-white">
          <div className="border-b border-slate-200/80 bg-slate-50/60 px-4 py-4 sm:px-5">
            <h2 className="text-base font-black text-slate-950">{session.person}, one page load</h2>
            <p className="mt-1 text-sm font-medium leading-6 text-slate-600">
              {session.territory ? `${session.territory}. ` : ""}
              {session.total} events over {durationText(session.onScreenMs)}
              {session.day ? ` on ${formatPhoenixLongDate(session.day)}` : ""}.
              {streamCapped ? ` Showing the first ${session.events.length} of them, in order.` : ""}
            </p>
            <div className="mt-2 flex flex-wrap gap-1">
              {session.isTest ? <CrmPill tone="warn">Test persona</CrmPill> : null}
              {deviceClockNote(session.deviceClockOffMs) ? <CrmPill tone="bad">{deviceClockNote(session.deviceClockOffMs)}</CrmPill> : null}
            </div>
            <p className="mt-2 text-xs font-semibold leading-5 text-slate-500">
              The clock is the device&apos;s own stamp where it sent one; &ldquo;in&rdquo; is how far into the page load the event
              fell, which is what orders the forty events that share one arrival.
            </p>
          </div>
          <EventStream session={session} />
        </section>
      ) : null}
    </div>
  );
}
