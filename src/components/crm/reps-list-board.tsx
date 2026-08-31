import Link from "next/link";

import { RepsListContacts } from "@/components/crm/reps-list-tables";
import { RepsListFilters } from "@/components/crm/reps-list-filters";
import type { RepsListBoard, RepsListRep } from "@/lib/crm/reps-list-board";

// Server half of Reps List. The Section/Tile vocabulary is copied verbatim from
// doctor-list-board.tsx, the board this one replaces — flat borders, slate-900 header bar, KPI
// tiles, orange accent. Never a one-off look (owner's standing rule).
//
// THE BOARD HAS TWO STATES AND THEY ARE DELIBERATELY DIFFERENT SCREENS: choose a rep, then read that
// rep's list. The owner described it that way ("...he has appearing the area, the medical rep. When he
// clicks on the medical rep, all his contact list appears"), and it is also the only honest layout —
// a company-scoped viewer reaches ~73 reps, so a picker plus a list on one screen would either
// default to an arbitrary rep or render nothing under a full page of chrome.

function Section({
  action,
  children,
  description,
  title,
}: {
  action?: React.ReactNode;
  children: React.ReactNode;
  description?: string;
  title: string;
}) {
  return (
    <div className="border-b border-slate-200 bg-white last:border-b-0">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 bg-slate-900 px-5 py-3.5">
        <div className="min-w-0 flex-1">
          <h2 className="text-phx-xs font-black uppercase tracking-[0.14em] text-white">{title}</h2>
          {description ? <p className="mt-0.5 text-phx-2xs text-slate-400">{description}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

function Tile({
  label,
  sub,
  tone,
  value,
}: {
  label: string;
  sub?: string;
  tone?: "amber" | "emerald" | "rose";
  value: string;
}) {
  const valueClass =
    tone === "emerald"
      ? "text-emerald-700"
      : tone === "amber"
        ? "text-amber-700"
        : tone === "rose"
          ? "text-rose-700"
          : "text-slate-900";
  return (
    <div className="border border-slate-200 px-3 py-2.5">
      <p className="text-phx-3xs font-black uppercase tracking-[0.14em] text-slate-400">{label}</p>
      <p className={`text-lg font-black ${valueClass}`}>{value}</p>
      {sub ? <p className="text-phx-2xs text-slate-400">{sub}</p> : null}
    </div>
  );
}

/** Cairo wall-clock, per the owner's standing rule that no raw UTC is ever shown. */
function cairoStamp(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    timeZone: "Africa/Cairo",
    year: "numeric",
  }).format(new Date(iso));
}

/** The current filters as a query string, with `rep` replaced (or dropped when null). */
function hrefWithRep(basePath: string, board: RepsListBoard, repKey: string | null): string {
  const query = new URLSearchParams();
  if (board.selection.line) query.set("line", board.selection.line);
  if (board.selection.region) query.set("region", board.selection.region);
  if (board.selection.area) query.set("area", board.selection.area);
  if (repKey) query.set("rep", repKey);
  const search = query.toString();
  return search ? `${basePath}?${search}` : basePath;
}

function RepCard({ href, rep }: { href: string; rep: RepsListRep }) {
  const hasList = rep.agentCrmId != null && rep.contactCount > 0;
  return (
    <Link
      className="block border border-slate-200 bg-white px-4 py-3 transition-colors hover:border-orange-400 hover:bg-orange-50"
      href={href}
    >
      <p className="text-sm font-black text-slate-900">{rep.name}</p>
      {/* The area is the second thing the owner asked to see beside the rep. A seat spanning several
          areas prints all of them rather than the first, which would be a quiet untruth. */}
      <p className="mt-0.5 text-phx-2xs font-semibold text-slate-500">
        {rep.areaNames.length > 0 ? rep.areaNames.join(" · ") : "No area on the seat"}
      </p>
      {/* "No list in the CRM" and "an empty list" are the same on screen only if you let them be.
          Saying it in words is the finding — this rep exists in the organogram and the CRM mirror
          holds nothing for them, which is a sync or account problem, not a rep with no doctors. */}
      <p className={`mt-1 text-phx-2xs font-black uppercase tracking-[0.1em] ${hasList ? "text-slate-400" : "text-amber-700"}`}>
        {hasList ? `${rep.contactCount} contacts` : "No list mirrored from the CRM"}
      </p>
    </Link>
  );
}

/** A tile's share of the whole list, so a count is readable without doing the arithmetic. */
function shareOf(count: number, total: number): string {
  if (total <= 0) return "no contacts";
  return `${Math.round((count / total) * 100)}% of the list`;
}

export function RepsListBoardView({ basePath, board }: { basePath: string; board: RepsListBoard }) {
  const { list, options, reps, scopeLabel, scopeReason, selected, selection, syncedAt } = board;

  // A viewer who reaches nobody is told so in words. An empty picker would read as "the CRM holds
  // no lists", which is a completely different statement and the one a manager would act on.
  if (scopeReason) {
    return (
      <div className="border border-slate-200">
        <Section description="No reps are in your reach." title="Reps List">
          <div className="px-5 py-6">
            <p className="text-sm font-semibold text-slate-700">{scopeReason}</p>
            <p className="mt-1 text-phx-xs text-slate-500">
              This board shows the CRM contact list of the reps who report to you, grouped by brick. Until the
              organogram places reps under your seat there is nothing here — which is not the same as the CRM
              holding no lists.
            </p>
          </div>
        </Section>
      </div>
    );
  }

  const description = [
    "Filter to a line, region and area, then open a rep to see that rep's own CRM contact list grouped by brick",
    "the list the CRM says they were given, not their visits",
    `your reach: ${scopeLabel}`,
    syncedAt ? `last refreshed ${cairoStamp(syncedAt)} Cairo` : "never refreshed",
  ].join(" · ");

  return (
    <div className="border border-slate-200">
      <Section description={description} title="Reps List">
        <RepsListFilters basePath={basePath} options={options} selection={selection} />
      </Section>

      {selected ? (
        <Section
          action={
            <Link
              className="border border-slate-600 px-3 py-1.5 text-phx-2xs font-black uppercase tracking-[0.12em] text-white transition-colors hover:border-orange-400 hover:text-orange-300"
              href={hrefWithRep(basePath, board, null)}
            >
              Back to all reps
            </Link>
          }
          description={
            selected.areaNames.length > 0
              ? `${selected.areaNames.join(" · ")} · their own CRM contact list, grouped by the brick each contact sits in`
              : "Their own CRM contact list, grouped by the brick each contact sits in"
          }
          title={`Reps List — ${selected.name}`}
        >
          {list == null ? (
            <div className="px-5 py-6">
              <p className="text-sm font-semibold text-slate-700">
                The CRM holds no contact list for {selected.name}.
              </p>
              <p className="mt-1 text-phx-xs text-slate-500">
                They are seated in the organogram, so this is a CRM account or sync gap rather than a rep with no
                doctors. The daily sync fills this board from the CRM&apos;s own contact list.
              </p>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2 p-5 pb-0 sm:grid-cols-3 lg:grid-cols-6">
                {/* The three list names are the CRM's own and the owner's own — PM list, AM list,
                    Pharmacist. The sub-line carries each one's share rather than a description,
                    because naming what a list "is" invents a meaning the CRM never stated. */}
                <Tile label="Contacts" sub="all three lists" value={String(list.counts.total)} />
                <Tile label="PM list" sub={shareOf(list.counts.pm, list.counts.total)} value={String(list.counts.pm)} />
                <Tile label="AM list" sub={shareOf(list.counts.am, list.counts.total)} value={String(list.counts.am)} />
                <Tile
                  label="Pharmacists"
                  sub={shareOf(list.counts.pharmacy, list.counts.total)}
                  value={String(list.counts.pharmacy)}
                />
                {/* The VALUE is the mapped bricks alone. Counting the unmapped localities here
                    too would have this tile report bricks that do not exist — on a rep whose whole
                    area is unmapped it read "Bricks 8 / 0 mapped", which is a contradiction. */}
                <Tile
                  label="Bricks"
                  sub="mapped territories"
                  value={String(list.groups.length - list.unmappedRegionCount)}
                />
                {/* Stated on screen rather than left to be noticed: an unmapped locality is a
                    mapping backlog, and the board is the punch-list for it. */}
                <Tile
                  label="Awaiting a brick"
                  sub={
                    list.unmappedContactCount > 0
                      ? `${list.unmappedRegionCount} localities not yet mapped`
                      : "every locality is mapped"
                  }
                  tone={list.unmappedContactCount > 0 ? "amber" : "emerald"}
                  value={String(list.unmappedContactCount)}
                />
              </div>
              <RepsListContacts groups={list.groups} repName={selected.name} syncedAt={syncedAt} />
            </>
          )}
        </Section>
      ) : (
        <Section
          description="Pick a rep to open their contact list. Narrow with the filters above first if the list is long."
          title={`Medical reps — ${reps.length}`}
        >
          {reps.length === 0 ? (
            <div className="px-5 py-6">
              <p className="text-sm font-semibold text-slate-700">No reps match these filters.</p>
              <p className="mt-1 text-phx-xs text-slate-500">
                Clear a level of the cascade to widen it. An empty result here means no seated rep works that
                combination — not that the CRM is missing data.
              </p>
            </div>
          ) : (
            <div className="grid gap-2 p-5 sm:grid-cols-2 lg:grid-cols-3">
              {reps.map((rep) => (
                <RepCard href={hrefWithRep(basePath, board, rep.repKey)} key={rep.repKey} rep={rep} />
              ))}
            </div>
          )}
        </Section>
      )}
    </div>
  );
}
