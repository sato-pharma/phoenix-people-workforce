import Link from "next/link";

import { listLabel, RepsListListBody } from "@/components/crm/reps-list-board";
import { cairoStamp, Section } from "@/components/crm/reps-list-chrome";
import { RepsListFilters } from "@/components/crm/reps-list-filters";
import type { VacantArea, VacantAreasBoard } from "@/lib/crm/reps-list-vacant-areas";

// Reps List — tab three, Vacant Areas. The owner's words, 2026-09-14: "showing the doctors list in
// vacant areas exactly as the other tab". So it is the contact tab's two screens with an AREA where
// the rep was: pick a vacant area, then read the list its last rep left behind, through the very
// same `RepsListListBody`. What a vacant area inherits, and why three of its four states show no
// list, is written up in src/lib/crm/reps-list-vacant-areas.ts.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `2026-08-31` -> `31 Aug 2026`. String arithmetic — a date-only value must never pass through a
 * timezone, or the day it prints can move. */
function dayLabel(iso: string | null): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  if (!match) return null;
  return `${Number(match[3])} ${MONTHS[Number(match[2]) - 1]} ${match[1]}`;
}

function hrefWithVacancy(basePath: string, board: VacantAreasBoard, seatId: string | null): string {
  const query = new URLSearchParams();
  query.set("tab", "vacant");
  if (board.selection.line) query.set("line", board.selection.line);
  if (board.selection.region) query.set("region", board.selection.region);
  if (board.selection.area) query.set("area", board.selection.area);
  if (seatId) query.set("vacancy", seatId);
  query.set("month", board.activityMonth);
  return `${basePath}?${query.toString()}`;
}

/** Who held the seat last, and until when, in one line. */
function heldBy(area: VacantArea): string | null {
  if (!area.holder) return null;
  const until = dayLabel(area.holder.heldUntil);
  return until ? `Last held by ${area.holder.name} until ${until}` : `Last held by ${area.holder.name}`;
}

/** What each state says on a card. Every state but `list` is amber: it is a gap in the gap. */
function statusLine(area: VacantArea): string {
  switch (area.status) {
    case "list":
      return listLabel(area.holder?.contactCount ?? 0, area.holder?.pharmacyCount ?? 0);
    case "list_closed":
      return "No open list left behind";
    case "holder_reseated":
      return "Their list moved with them to another seat";
    case "never_held":
      return "No rep on record for this seat";
  }
}

function VacancyCard({ area, href }: { area: VacantArea; href: string }) {
  const hasList = area.status === "list";
  const holder = heldBy(area);
  return (
    <Link
      className="block border border-slate-200 bg-white px-4 py-3 transition-colors hover:border-orange-400 hover:bg-orange-50"
      href={href}
    >
      <p className="text-sm font-black text-slate-900">{area.areaName}</p>
      <p className="mt-0.5 text-phx-2xs font-semibold text-slate-500">
        {area.lineName} · {area.regionName}
      </p>
      {holder ? <p className="mt-0.5 text-phx-2xs font-semibold text-slate-500">{holder}</p> : null}
      <p className={`mt-1 text-phx-2xs font-black uppercase tracking-[0.1em] ${hasList ? "text-slate-400" : "text-amber-700"}`}>
        {statusLine(area)}
      </p>
    </Link>
  );
}

/** Why an opened vacant area shows no list, in words — never an empty table. */
function NoListExplanation({ area }: { area: VacantArea }) {
  const name = area.holder?.name ?? "";
  const copy: Record<Exclude<VacantArea["status"], "list">, { body: string; title: string }> = {
    holder_reseated: {
      body: `${name} now holds another seat, so the list they carry is the one for the territory they work today and is shown under their name on the Contact list tab, not here.`,
      title: `The last rep here, ${name}, has moved to another seat.`,
    },
    list_closed: {
      body: "Their contact list has been closed or handed over, so this area has no doctors on anyone's list until the seat is filled.",
      title: `${name} left no open contact list for ${area.areaName}.`,
    },
    never_held: {
      body: "No record names a rep for this area: not the seat's history, not an earlier seat that covered it, and not an HR vacancy opened to replace someone. It was created as a new seat, so there is no earlier list for it to inherit.",
      title: `Nobody has held the ${area.areaName} seat on ${area.lineName}.`,
    },
  };
  if (area.status === "list") return null;
  const { body, title } = copy[area.status];
  return (
    <div className="px-5 py-6">
      <p className="text-sm font-semibold text-slate-700">{title}</p>
      <p className="mt-1 text-phx-xs text-slate-500">{body}</p>
    </div>
  );
}

export function RepsListVacantAreasView({ basePath, board }: { basePath: string; board: VacantAreasBoard }) {
  const { areas, list, options, scopeLabel, scopeReason, selected, selection, syncedAt } = board;
  // The tab and the month survive a cascade pick; without the tab a pick lands on the contact list.
  const preserve = { month: board.activityMonth, tab: "vacant" };

  if (scopeReason) {
    return (
      <div className="border border-slate-200">
        <Section description="No areas are in your reach." title="Vacant Areas">
          <div className="px-5 py-6">
            <p className="text-sm font-semibold text-slate-700">{scopeReason}</p>
            <p className="mt-1 text-phx-xs text-slate-500">
              This board shows the doctors of the vacant areas beside your own team. Until the organogram places
              reps under your seat there is nothing here — which is not the same as there being no vacant areas.
            </p>
          </div>
        </Section>
      </div>
    );
  }

  const withList = areas.filter((area) => area.status === "list").length;
  const description = [
    "Filter to a line, region and area, then open a vacant area to see the CRM contact list its last rep left behind, grouped by brick",
    `your reach: ${scopeLabel}`,
    syncedAt ? `last refreshed ${cairoStamp(syncedAt)} Cairo` : "never refreshed",
  ].join(" · ");

  return (
    <div className="border border-slate-200">
      <Section description={description} title="Vacant Areas">
        <RepsListFilters basePath={basePath} options={options} preserve={preserve} selection={selection} withRep={false} />
      </Section>

      {selected ? (
        <Section
          action={
            <Link
              className="border border-slate-600 px-3 py-1.5 text-phx-2xs font-black uppercase tracking-[0.12em] text-white transition-colors hover:border-orange-400 hover:text-orange-300"
              href={hrefWithVacancy(basePath, board, null)}
            >
              Back to all vacant areas
            </Link>
          }
          description={[
            `${selected.lineName} · ${selected.regionName}`,
            heldBy(selected),
            // Only an area that HAS an inherited list may say so; the other three explain themselves below.
            selected.status === "list" ? "the contact list left on the seat, grouped by the brick each contact sits in" : null,
          ]
            .filter(Boolean)
            .join(" · ")}
          title={`Vacant Areas — ${selected.areaName}`}
        >
          {selected.status === "list" && list ? (
            <RepsListListBody
              // A departed rep is excluded from every CRM read by standing rule (reps-list-activity-data.ts),
              // so reading his month would score every doctor `missed`. Say the rule, not an outage.
              activityUnavailableNote={`Nobody works ${selected.areaName} now, so no plan or visits are shown beside these contacts. This is the list ${selected.holder?.name ?? "the last rep"} left on the seat; it is complete.`}
              basePath={basePath}
              board={board}
              list={list}
              listName={`${selected.areaName} (vacant)`}
              monthPreserve={{
                area: selection.area,
                line: selection.line,
                region: selection.region,
                tab: "vacant",
                vacancy: selected.seatId,
              }}
            />
          ) : (
            <NoListExplanation area={selected} />
          )}
        </Section>
      ) : (
        <Section
          description={`${withList} of ${areas.length} still carry the contact list of the rep who last held the seat. Pick one to open it.`}
          title={`Vacant areas — ${areas.length}`}
        >
          {areas.length === 0 ? (
            <div className="px-5 py-6">
              <p className="text-sm font-semibold text-slate-700">No vacant areas match these filters.</p>
              <p className="mt-1 text-phx-xs text-slate-500">
                Every area in this selection has a rep in the seat. Clear a level of the cascade to widen it.
              </p>
            </div>
          ) : (
            <div className="grid gap-2 p-5 sm:grid-cols-2 lg:grid-cols-3">
              {areas.map((area) => (
                <VacancyCard area={area} href={hrefWithVacancy(basePath, board, area.seatId)} key={area.seatId} />
              ))}
            </div>
          )}
        </Section>
      )}
    </div>
  );
}
