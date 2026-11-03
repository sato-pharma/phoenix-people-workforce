"use client";

/**
 * The HR Operations Specialist's landing page. The owner, 2026-11-03: "in aya the office coordinator
 * account design it to be identical in design and identy to the talnt acqyuisition and godmode premium
 * polish it and add hr calen dars and interview calendar".
 *
 * THE SAME PAGE, BUILT FROM HER OWN WORK. Every part is the Talent Acquisition page's own, imported and
 * never copied, so the two cannot drift: section for section,
 *
 *   1. The identity strip         untouched, with the scoreboard in its reserve, beside her portrait
 *   2. The command rail           Needs attention. There is no Hired window on this seat.
 *   3. The figures                Review · People · Follow-ups, six across
 *   4. Today                      today's interviews · joiners arriving · people leaving
 *   5. The calendar               the real interview calendar as a VIEWER, then the doors to the others
 *   6. On a vacation today · My record
 *
 * THE GENERIC PAGE'S CHARTS ARE NOT HERE, as they are not on the Talent Acquisition page: every number
 * in them is a card.
 *
 * SHE VIEWS THE INTERVIEW CALENDAR AND NOTHING MORE (owner, 2026-10-20), so no word on this page tells
 * her to book, to press a free time or to ask for an interview. The server refuses all three anyway.
 *
 * NEVER A HORIZONTAL SCROLL, SQUARE EDGES, NO ELLIPSIS, PHOENIX TONES ONLY: the same rules as that page.
 * Every column count follows the CONTAINER, not the window.
 */

import {
  ArrowUpRight,
  CalendarCheck2,
  CalendarClock,
  CalendarDays,
  CalendarFold,
  CalendarHeart,
  CalendarRange,
  ClipboardCheck,
  DoorOpen,
  FileCheck2,
  IdCard,
  UserPlus,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { HrMyRecord } from "@/components/hr/hr-my-record";
import { HrOnVacationToday } from "@/components/hr/hr-on-vacation-today";
import { HrTodayPanel } from "@/components/hr/hr-today-panel";
import { TalentAcquisitionCalendar } from "@/components/hr/talent-acquisition-calendar";
import {
  GROUP_CARDS_BY_COUNT,
  GROUP_GRID_BY_TOTAL,
  GROUP_SPAN_BY_COUNT,
  MetricTile,
  TASK_ICONS,
  TaScoreboard,
  UnavailableNotice,
  useOverviewRefresh,
  type TalentAcquisitionIdentity,
} from "@/components/hr/talent-acquisition-overview";
import { TaCommandRail } from "@/components/hr/talent-acquisition/command-rail";
import { TaDatedPeople } from "@/components/hr/talent-acquisition/joiners-arriving";
import { TaCaption, TA_CAPS_CLASS } from "@/components/hr/talent-acquisition/panel";
import { TaTodayInterviews } from "@/components/hr/talent-acquisition/today-interviews";
import { PushOptInNudge } from "@/components/notifications/push-opt-in-nudge";
import { PhoenixIdentityStrip } from "@/components/phoenix-signature-card/PhoenixIdentityStrip";
import type { HrOperationsOverviewData } from "@/lib/hr/hr-operations-overview";
import { HIRING_DOCUMENTS_HREF, RESIGNATIONS_HREF } from "@/lib/hr/hr-operations-overview-logic";
import { longDayLabel } from "@/lib/hr/talent-acquisition-logic";

const PENDINGS_PANEL_ID = "hr-operations-pendings";

/** The scoreboard's watermark icons, one per measure. */
const SCOREBOARD_ICONS: Readonly<Record<string, LucideIcon>> = {
  "papers-confirmed": FileCheck2,
  "records-complete": IdCard,
  "reports-answered": ClipboardCheck,
};

/** The full calendars. Each is a row on her sidebar; `tests/hr-operations-overview.test.ts` holds that true. */
export const HR_OPERATIONS_CALENDAR_DOORS: readonly {
  href: string;
  icon: LucideIcon;
  label: string;
  line: string;
}[] = [
  { href: "/hr/hr-calendar", icon: CalendarDays, label: "Company Calendar", line: "Holidays and HR dates" },
  { href: "/hr/admin/company-calendar", icon: CalendarHeart, label: "Events Calendar", line: "Company events" },
  { href: "/hr/recruitment/interview-calendar", icon: CalendarClock, label: "Interview Calendar", line: "To view" },
  { href: "/hr/admin/private-calendars", icon: CalendarFold, label: "Private Calendars", line: "Any employee's month" },
  { href: "/hr/admin/weekly-plans/calendar", icon: CalendarRange, label: "Planning Calendar", line: "The field force's plans" },
];

function CalendarDoors() {
  return (
    <section aria-label="HR calendars" className="@container border-t border-slate-100 px-5 py-5">
      <TaCaption caption="Each one in full" label="HR calendars" />
      <div className="grid grid-cols-1 gap-2 @min-[480px]:grid-cols-2 @min-[720px]:grid-cols-3 @min-[1080px]:grid-cols-5">
        {HR_OPERATIONS_CALENDAR_DOORS.map((door) => {
          const Icon = door.icon;
          return (
            <Link
              className="group/tile relative flex min-w-0 items-center gap-3 border border-slate-200/90 bg-white px-3 py-3 transition-colors duration-200 hover:border-orange-200 hover:bg-orange-50/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
              href={door.href}
              key={door.href}
            >
              <Icon aria-hidden="true" className="h-4 w-4 shrink-0 text-orange-600" />
              <span className="min-w-0 flex-1">
                <span className={`${TA_CAPS_CLASS} block break-words text-slate-900`}>{door.label}</span>
                <span className="mt-0.5 block break-words text-[11px] font-semibold text-slate-500">{door.line}</span>
              </span>
              <ArrowUpRight
                aria-hidden="true"
                className="h-3.5 w-3.5 shrink-0 text-orange-400 opacity-0 transition-opacity duration-200 group-focus-visible/tile:opacity-100 group-hover/tile:opacity-100"
              />
            </Link>
          );
        })}
      </div>
    </section>
  );
}

export function HrOperationsOverview({
  data,
  identity,
}: {
  data: HrOperationsOverviewData;
  identity: TalentAcquisitionIdentity;
}) {
  const [showPendings, setShowPendings] = useState(false);
  useOverviewRefresh();

  const pendingCount = data.tasks.reduce((total, task) => total + task.count, 0);
  const overdueCount = data.tasks
    .filter((task) => task.urgency === "overdue")
    .reduce((total, task) => total + task.count, 0);
  const groupedTotal = data.groups.reduce((total, group) => total + group.tiles.length, 0);

  const scoreboard =
    data.scoreboard.length > 0 ? (
      <TaScoreboard
        caption="As of now · each figure names what it divides by"
        icons={SCOREBOARD_ICONS}
        kpis={data.scoreboard}
        label="Your desk"
      />
    ) : null;

  return (
    <div className="min-w-0 max-w-full overflow-x-hidden">
      {/* The identity strip takes the same four props as every HR landing page, and `reserve`. */}
      <PhoenixIdentityStrip
        employeeCode={identity.employeeCode}
        name={identity.displayName}
        photoSrc={identity.photoUrl}
        reserve={scoreboard}
        title={identity.roleLabel}
      />

      <PushOptInNudge />

      <TaCommandRail
        hiredWindow={null}
        onToggle={() => setShowPendings((previous) => !previous)}
        open={showPendings}
        overdueCount={overdueCount}
        panelId={PENDINGS_PANEL_ID}
        pendingCount={pendingCount}
      />

      <div hidden={!showPendings} id={PENDINGS_PANEL_ID}>
        {showPendings ? <HrTodayPanel icons={TASK_ICONS} openAll tasks={data.tasks} /> : null}
      </div>

      {data.unavailableSources.length > 0 ? <UnavailableNotice sources={data.unavailableSources} /> : null}

      <div className="@container relative overflow-hidden border-b border-slate-200/70 bg-[linear-gradient(180deg,#FFFFFF_0%,#FAF8F5_100%)] px-5 pb-6 pt-5">
        <span aria-hidden="true" className="pointer-events-none absolute -left-32 top-72 h-80 w-80 bg-orange-300/20 blur-[110px]" />
        <span aria-hidden="true" className="pointer-events-none absolute -right-24 bottom-0 h-80 w-80 bg-amber-300/20 blur-[110px]" />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 opacity-[0.35] [background-image:linear-gradient(rgba(148,163,184,.12)_1px,transparent_1px),linear-gradient(90deg,rgba(148,163,184,.12)_1px,transparent_1px)] [background-size:32px_32px] [mask-image:linear-gradient(180deg,transparent_0%,black_30%,black_70%,transparent_100%)]"
        />
        <div className="relative grid gap-5">
          {data.groups.length > 0 ? (
            <div className={`grid grid-cols-1 gap-x-2 gap-y-4 ${GROUP_GRID_BY_TOTAL[groupedTotal] ?? ""}`}>
              {data.groups.map((group) => (
                <section
                  aria-label={group.label}
                  className={`flex min-w-0 flex-col ${GROUP_SPAN_BY_COUNT[group.tiles.length] ?? ""}`}
                  key={group.key}
                >
                  <TaCaption caption={group.caption} label={group.label} />
                  <div className={`grid flex-1 gap-2 ${GROUP_CARDS_BY_COUNT[group.tiles.length] ?? "grid-cols-2"}`}>
                    {group.tiles.map((tile) => (
                      <MetricTile key={tile.key} tile={tile} />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          ) : null}

          <section aria-label="Today">
            <TaCaption caption={longDayLabel(data.calendar.todayKey)} label="Today" />
            <div className="grid grid-cols-1 items-stretch gap-3 @min-[720px]:grid-cols-2 @min-[1080px]:grid-cols-3">
              <TaTodayInterviews readOnly today={data.today} />
              <TaDatedPeople
                couldNotLoad="The joiners"
                emptyAction="Open Hiring Documents"
                emptyIcon={CalendarCheck2}
                emptyLine="Nobody starts in the next fourteen days."
                emptyTitle="Nobody is due to join"
                footerNote={
                  data.joiners.papers
                    ? `${data.joiners.papers.confirmed.toLocaleString("en-US")} of ${data.joiners.papers.total.toLocaleString("en-US")} papers confirmed`
                    : "accepted offers only"
                }
                href={HIRING_DOCUMENTS_HREF}
                hrefLabel="Open Hiring Documents"
                icon={UserPlus}
                id="hr-operations-joiners"
                people={data.joiners}
                title="Joiners arriving"
                verb="joins"
              />
              <TaDatedPeople
                className="@min-[720px]:col-span-2 @min-[1080px]:col-span-1"
                couldNotLoad="The resignations"
                emptyAction="Open Resignations"
                emptyIcon={CalendarCheck2}
                emptyLine="No open resignation ends in the next fourteen days."
                emptyTitle="Nobody is due to leave"
                footerNote="open resignations only"
                href={RESIGNATIONS_HREF}
                hrefLabel="Open Resignations"
                icon={DoorOpen}
                id="hr-operations-leaving"
                people={data.leaving}
                title="Leaving soon"
                verb="leaves"
              />
            </div>
          </section>
        </div>
      </div>

      <TalentAcquisitionCalendar
        calendar={data.calendar}
        description="The Interview Calendar, to view — move between weeks and open an interview — then your own next three weeks, and the company month with its holidays and events and the days your joiners arrive."
      />

      <CalendarDoors />

      {/* The Vacation Report this panel would link to shows her own leave, so its names stay and its
          links go, as on the Talent Acquisition page. The company report has its own sidebar row. */}
      <HrOnVacationToday linked={false} rows={data.onVacationToday} />

      <HrMyRecord record={data.personal} />
    </div>
  );
}
