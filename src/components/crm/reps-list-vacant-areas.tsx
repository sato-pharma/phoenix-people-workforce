import Link from "next/link";

import { listLabel, RepsListListBody } from "@/components/crm/reps-list-board";
import {
  BackToAllReps,
  cairoStamp,
  countOf,
  EmptyNote,
  ExportRowBar,
  GroupedCardGrid,
  RepCardFrame,
  RepProfileBand,
  Section,
  ShareBar,
  StatusMark,
  Swatch,
  TeamTable,
  TeamTableName,
  Tile,
  TileRow,
  type ChromeTone,
  type TeamColumn,
} from "@/components/crm/reps-list-chrome";
import { ExportXlsxButton } from "@/components/ui/export-xlsx-button";
import { RepsListFilters } from "@/components/crm/reps-list-filters";
import { groupRepsByTeam, teamHeading } from "@/lib/crm/reps-list-groups";
import type { VacantArea, VacantAreasBoard } from "@/lib/crm/reps-list-vacant-areas";

// Reps List — tab three, Vacant Areas. The owner's words, 2026-09-14: "showing the doctors list in
// vacant areas exactly as the other tab". So it is the contact tab's two screens with an AREA where
// the rep was: pick a vacant area, then read the list its last rep left behind, through the very
// same `RepsListListBody`. What a vacant area inherits, and why three of its four states show no
// list, is written up in src/lib/crm/reps-list-vacant-areas.ts.
//
// The cards wear the same frame as a rep's card on the other two tabs, with the monogram drawn as a
// DASHED empty square — the seat is the thing missing — and they are grouped under the region and
// district manager the empty seat sits under, exactly as the rep cards are (owner, 2026-11-09: "group
// reps by district manager").

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

/** The tone each state reads in: a list left on the seat is the ordinary case; every other state is a gap. */
function statusTone(area: VacantArea): ChromeTone {
  return area.status === "list" ? "slate" : "amber";
}

function VacancyCard({ area, href }: { area: VacantArea; href: string }) {
  const holder = heldBy(area);
  const tone = statusTone(area);
  return (
    <RepCardFrame href={href} monogramMuted name={area.areaName} places={`${area.lineName} · ${area.regionName}`} tone={tone}>
      {holder ? <p className="text-phx-2xs font-semibold text-slate-500 [overflow-wrap:anywhere]">{holder}</p> : null}
      {area.status === "list" ? (
        <p className="mt-1 text-phx-2xs font-black uppercase tracking-[0.1em] text-slate-600 tabular-nums">{statusLine(area)}</p>
      ) : (
        <div className="mt-1">
          <StatusMark text={statusLine(area)} tone={tone} />
        </div>
      )}
    </RepCardFrame>
  );
}

/** The vacant areas as a desktop table — the card's facts, one column each, in the card's own words and colours. */
function vacancyColumns(basePath: string, board: VacantAreasBoard): TeamColumn<VacantArea>[] {
  return [
    {
      cell: (area) => (
        <TeamTableName
          href={hrefWithVacancy(basePath, board, area.seatId)}
          muted
          name={area.areaName}
          sub={`${area.lineName} · ${area.regionName}`}
        />
      ),
      key: "area",
      label: "Vacant area",
      width: "w-[30%]",
    },
    {
      cell: (area) => (
        <span className="text-phx-xs font-semibold text-slate-600 [overflow-wrap:anywhere]">
          {area.holder ? area.holder.name : "Nobody on record"}
        </span>
      ),
      key: "holder",
      label: "Last held by",
      width: "w-[22%]",
    },
    {
      cell: (area) => (
        <span className="text-phx-xs font-semibold text-slate-600 tabular-nums">{dayLabel(area.holder?.heldUntil ?? null) ?? "–"}</span>
      ),
      key: "until",
      label: "Until",
      width: "w-[14%]",
    },
    {
      cell: (area) =>
        area.status === "list" ? (
          <span className="text-phx-2xs font-black uppercase tracking-[0.1em] text-slate-600 tabular-nums">{statusLine(area)}</span>
        ) : (
          <StatusMark text={statusLine(area)} tone={statusTone(area)} />
        ),
      key: "list",
      label: "What the seat holds",
      width: "w-[34%]",
    },
  ];
}

/** A team's empty seats beside its heading: how many still carry a list, and how many are a gap in the gap. */
function TeamVacancyLine({ areas }: { areas: readonly VacantArea[] }) {
  const withList = areas.filter((area) => area.status === "list").length;
  const without = areas.length - withList;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="inline-flex items-center gap-1.5">
        <Swatch tone="slate" />
        <span className="font-black text-slate-900 tabular-nums">{withList}</span> with a list
      </span>
      {without > 0 ? (
        <span className="inline-flex items-center gap-1.5">
          <Swatch tone="amber" />
          <span className="font-black text-slate-900 tabular-nums">{without}</span> with none
        </span>
      ) : null}
    </span>
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
  return <EmptyNote detail={body} title={title} />;
}

export function RepsListVacantAreasView({ basePath, board }: { basePath: string; board: VacantAreasBoard }) {
  const { areas, list, options, scopeLabel, scopeReason, selected, selection, syncedAt } = board;
  // The tab and the month survive a cascade pick; without the tab a pick lands on the contact list.
  const preserve = { month: board.activityMonth, tab: "vacant" };

  if (scopeReason) {
    return (
      <div className="border border-slate-200">
        <Section description="No areas are in your reach." title="Vacant Areas">
          <EmptyNote
            detail="This board shows the doctors of the vacant areas beside your own team. Until the organogram places reps under your seat there is nothing here — which is not the same as there being no vacant areas."
            title={scopeReason}
          />
        </Section>
      </div>
    );
  }

  const withList = areas.filter((area) => area.status === "list").length;
  const moved = areas.filter((area) => area.status === "holder_reseated").length;
  const closed = areas.filter((area) => area.status === "list_closed").length;
  const neverHeld = areas.filter((area) => area.status === "never_held").length;
  const share = (value: number) => (areas.length > 0 ? Math.round((value / areas.length) * 100) : 0);
  const groups = groupRepsByTeam(areas);
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

      {/* The same back bar a rep's screen starts with, so every opened card on the three tabs has its way back
          in the same place (owner, 2026-11-09). The small outlined link in the title bar stays. */}
      {selected ? <BackToAllReps href={hrefWithVacancy(basePath, board, null)} label="Back to all vacant areas" /> : null}
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
          <RepProfileBand
            facts={[
              { label: "Status", tone: statusTone(selected), value: selected.status === "list" ? "List left behind" : "No list here" },
              { label: "Last held by", value: selected.holder?.name ?? "Nobody on record" },
              { label: "Until", value: dayLabel(selected.holder?.heldUntil ?? null) ?? "–" },
            ]}
            muted
            name={selected.areaName}
            places={`${selected.lineName} · ${selected.regionName}`}
            team={teamHeading(selected.team)}
          />
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
          meta={countOf(areas.length, "empty seat")}
          title={`Vacant areas — ${areas.length}`}
        >
          {/* The empty seats in four figures, each a state the library resolves (`resolveVacantAreaStatus`) — so the
              four add up to the seats below, and the bar under them is the same four as one whole. */}
          <TileRow count={4}>
            <Tile label="Vacant areas" sub="no rep in the seat" tone={areas.length > 0 ? "amber" : "emerald"} value={String(areas.length)} />
            <Tile label="List left behind" share={share(withList)} sub="open it to read the doctors" value={String(withList)} />
            <Tile
              label="List moved on"
              share={share(moved + closed)}
              sub={moved + closed > 0 ? "reseated, closed or handed over" : "none"}
              tone={moved + closed > 0 ? "amber" : undefined}
              value={String(moved + closed)}
            />
            <Tile
              label="Never held"
              share={share(neverHeld)}
              sub={neverHeld > 0 ? "a new seat, nothing to inherit" : "none"}
              tone={neverHeld > 0 ? "amber" : undefined}
              value={String(neverHeld)}
            />
          </TileRow>
          {areas.length > 0 ? (
            <ShareBar
              caption="The empty seats at a glance"
              segments={[
                { key: "list", label: "List left behind", tone: "slate", value: withList },
                { key: "moved", label: "Moved with the rep", tone: "amber", value: moved },
                { key: "closed", label: "Closed or handed over", tone: "rose", value: closed },
                { key: "never", label: "Never held", tone: "sky", value: neverHeld },
              ]}
            />
          ) : null}
          {areas.length > 0 ? (
            <ExportRowBar note="The vacant areas in these filters, by region and district manager, with who held each seat last.">
              <ExportXlsxButton
                columns={[
                  { key: "region", label: "Region" },
                  { key: "manager", label: "District manager" },
                  { key: "area", label: "Vacant area" },
                  { key: "line", label: "Line" },
                  { key: "holder", label: "Last held by" },
                  { key: "until", label: "Until" },
                  { key: "status", label: "What the seat holds" },
                ]}
                label="Download the vacant areas"
                rows={groups.flatMap((group) =>
                  group.reps.map((area) => ({
                    area: area.areaName,
                    holder: area.holder?.name ?? "",
                    line: area.lineName,
                    manager: area.team.managerName ?? "",
                    region: area.team.regionName,
                    status: statusLine(area),
                    until: dayLabel(area.holder?.heldUntil ?? null) ?? "",
                  })),
                )}
                sheetName="Vacant Areas"
                subtitle={`Your reach: ${scopeLabel}`}
                title="Reps List — vacant areas"
              />
            </ExportRowBar>
          ) : null}
          {areas.length === 0 ? (
            <EmptyNote
              detail="Every area in this selection has a rep in the seat. Clear a level of the cascade to widen it."
              title="No vacant areas match these filters."
            />
          ) : (
            <>
              <GroupedCardGrid
                groups={groups}
                noun="empty seat"
                phoneOnly
                renderCard={(area) => (
                  <VacancyCard area={area} href={hrefWithVacancy(basePath, board, area.seatId)} key={area.seatId} />
                )}
                renderGroupMeta={(members) => <TeamVacancyLine areas={members} />}
              />
              {/* A desktop reads the empty seats as a table, a phone as cards (owner's standing rule). */}
              <TeamTable
                caption="The vacant areas in these filters, by region and district manager"
                columns={vacancyColumns(basePath, board)}
                groups={groups}
                noun="empty seat"
                renderGroupMeta={(members) => <TeamVacancyLine areas={members} />}
                rowKey={(area) => area.seatId}
              />
            </>
          )}
        </Section>
      )}
    </div>
  );
}
