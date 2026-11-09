import Link from "next/link";

import { RepsListContacts } from "@/components/crm/reps-list-tables";
import { RepsListFilters, RepsListMonthPicker } from "@/components/crm/reps-list-filters";
import {
  BackToAllReps,
  cairoStamp,
  CardMeter,
  countOf,
  EmptyNote,
  ExportRowBar,
  GroupedCardGrid,
  RankedBars,
  RepCardFrame,
  RepProfileBand,
  Section,
  ShareBar,
  StatusMark,
  Swatch,
  TeamRollup,
  TeamTable,
  TeamTableName,
  Tile,
  tileColumns,
  TileRow,
  type TeamColumn,
} from "@/components/crm/reps-list-chrome";
import { ExportXlsxButton } from "@/components/ui/export-xlsx-button";
import type { RepsListForRep } from "@/lib/crm/reps-list";
import { awaitingBrickSub } from "@/lib/crm/reps-list-labels";
import type { RepsListBoard, RepsListRep } from "@/lib/crm/reps-list-board";
import { groupRepsByTeam, listMix, teamHeading } from "@/lib/crm/reps-list-groups";

// Server half of Reps List. The Section/Tile vocabulary comes from reps-list-chrome.tsx, shared by all
// three tabs — flat borders, slate-900 header bar with its orange keyline, KPI tiles with a tone rule,
// orange accent. Never a one-off look (owner's standing rule). The rep cards are grouped by region and
// district manager (owner, 2026-11-09: "group reps by district manager").
//
// THE BOARD HAS TWO STATES AND THEY ARE DELIBERATELY DIFFERENT SCREENS: choose a rep, then read that
// rep's list. The owner described it that way ("...he has appearing the area, the medical rep. When he
// clicks on the medical rep, all his contact list appears"), and it is also the only honest layout —
// a company-scoped viewer reaches ~73 reps, so a picker plus a list on one screen would either
// default to an arbitrary rep or render nothing under a full page of chrome.

/** The current filters as a query string, with `rep` replaced (or dropped when null). */
function hrefWithRep(basePath: string, board: RepsListBoard, repKey: string | null): string {
  const query = new URLSearchParams();
  if (board.selection.line) query.set("line", board.selection.line);
  if (board.selection.region) query.set("region", board.selection.region);
  if (board.selection.area) query.set("area", board.selection.area);
  if (repKey) query.set("rep", repKey);
  // Carried across every rep card and across Back to all reps. A manager comparing two reps over
  // August is doing one piece of work, and dropping the month between them would silently re-score
  // the second over a different window while the page said nothing about it.
  query.set("month", board.activityMonth);
  const search = query.toString();
  return search ? `${basePath}?${search}` : basePath;
}

/**
 * "84 contacts · 12 pharmacies", or just the contacts when the rep holds no pharmacies.
 *
 * A PHARMACY IS NOT A CONTACT (owner, 2026-09-01), so the two are never added together and the word
 * "contacts" never covers both. A rep with pharmacies and no doctors then reads honestly —
 * "0 contacts · 12 pharmacies" is a real statement about that list, not an empty one.
 */
export function listLabel(contactCount: number, pharmacyCount: number): string {
  const contacts = `${contactCount} ${contactCount === 1 ? "contact" : "contacts"}`;
  if (pharmacyCount === 0) return contacts;
  return `${contacts} · ${pharmacyCount} ${pharmacyCount === 1 ? "pharmacy" : "pharmacies"}`;
}

function RepCard({ href, largest, rep }: { href: string; largest: number; rep: RepsListRep }) {
  // Pharmacies count towards HAVING a list even though they are not contacts: a rep holding only
  // pharmacies does have a list, and calling that "no list" would be a false finding.
  // NOT gated on a CRM account. A rep hired after the cutover has none, and his list is found by his
  // HR id — requiring `agentCrmId` here labelled every such rep "no list" whatever he held.
  const hasList = rep.contactCount + rep.pharmacyCount > 0;
  return (
    <RepCardFrame
      href={href}
      monogramMuted={!hasList}
      name={rep.name}
      // The area is the second thing the owner asked to see beside the rep. A seat spanning several
      // areas prints all of them rather than the first, which would be a quiet untruth.
      places={rep.areaNames.length > 0 ? rep.areaNames.join(" · ") : "No area on the seat"}
      tone={hasList ? "slate" : "amber"}
    >
      {/* "No list in the CRM" and "an empty list" are the same on screen only if you let them be.
          Saying it in words is the finding — this rep exists in the organogram and the CRM mirror
          holds nothing for them, which is a sync or account problem, not a rep with no doctors. */}
      {hasList ? (
        <>
          <p className="text-phx-2xs font-black uppercase tracking-[0.1em] text-slate-600 tabular-nums">
            {listLabel(rep.contactCount, rep.pharmacyCount)}
          </p>
          {/* The list's size against the largest list in view — contacts only, a pharmacy is not a contact. */}
          <CardMeter max={largest} value={rep.contactCount} />
        </>
      ) : (
        <StatusMark text="No list mirrored from the CRM" tone="amber" />
      )}
    </RepCardFrame>
  );
}

/**
 * A team's lists beside its heading: the typical list its reps hold, and how many reps the CRM mirrors no list for.
 * Counted from the cards in the group, so the heading and its line never disagree.
 */
function TeamListLine({ reps }: { reps: readonly RepsListRep[] }) {
  const withList = reps.filter((rep) => rep.contactCount + rep.pharmacyCount > 0);
  const missing = reps.length - withList.length;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="inline-flex items-center gap-1.5">
        <Swatch tone="slate" />
        <span className="font-black text-slate-900 tabular-nums">{median(withList.map((rep) => rep.contactCount))}</span>{" "}
        contacts a rep
      </span>
      {missing > 0 ? (
        <span className="inline-flex items-center gap-1.5">
          <Swatch tone="amber" />
          <span className="font-black text-slate-900 tabular-nums">{missing}</span> with no list
        </span>
      ) : null}
    </span>
  );
}

/** The median of a list of counts, or 0 for none — the typical list, which one very long list cannot drag. */
function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

/**
 * A list's share of the CONTACTS, so a count is readable without doing the arithmetic.
 *
 * The denominator is contacts (AM + PM), never the row total: PM and AM are the two halves of the
 * contact list and must add to 100%. Folding pharmacies into the denominator would make them add
 * to less than that and quietly restate the very thing the owner separated on 2026-09-01.
 */
function shareOf(count: number, contacts: number): string {
  if (contacts <= 0) return "no contacts";
  return `${Math.round((count / contacts) * 100)}% of contacts`;
}

/** The same share as a number, 0–100, for the tile's meter. */
function sharePercent(count: number, contacts: number): number {
  return contacts > 0 ? Math.round((count / contacts) * 100) : 0;
}

/**
 * Where the list sits: each brick's CONTACTS as a bar, largest first, so a manager sees in one look whether a rep's
 * list is spread over the bricks or piled into two of them. Contacts only — a pharmacy is not a contact (owner,
 * 2026-09-01). A locality nobody has mapped to a brick yet is kept, in amber and said in words, because it is part of
 * the list and the mapping backlog is a finding.
 */
function BrickBars({ list }: { list: RepsListForRep }) {
  const bricks = list.groups
    .map((group) => ({
      key: group.brickId ?? `region:${group.heading}`,
      label: group.heading,
      mapped: group.mapped,
      value: group.rows.filter((row) => row.listType !== "Pharmacy").length,
    }))
    .filter((brick) => brick.value > 0)
    .sort((left, right) => right.value - left.value || left.label.localeCompare(right.label));
  if (bricks.length < 2) return null;
  return (
    <RankedBars
      caption="Contacts by brick"
      items={bricks.map((brick) => ({
        key: brick.key,
        label: brick.label,
        note: brick.mapped ? undefined : "not yet mapped",
        tone: brick.mapped ? "slate" : "amber",
        value: brick.value,
      }))}
      total={`${countOf(list.counts.contacts, "contact")} over ${countOf(bricks.length, "place")}`}
    />
  );
}

/**
 * What the list is made of (`listMix`): its contacts by grade as one bar, and its largest specialties as ranked bars
 * with the rest folded into one line, so each chart adds up to the Contacts tile. Contacts only — a pharmacy is not a
 * contact. A chart with a single entry says nothing a tile does not, so it is not drawn.
 */
function ListMixCharts({ list }: { list: RepsListForRep }) {
  const mix = listMix(list.groups.flatMap((group) => group.rows));
  const gradeTone = (grade: string): "emerald" | "sky" | "slate" | "amber" =>
    grade === "A" ? "emerald" : grade === "B" ? "sky" : grade === "No grade" ? "amber" : "slate";
  return (
    <>
      {mix.grades.length > 1 ? (
        <ShareBar
          caption="Contacts by grade"
          segments={mix.grades.map((entry) => ({
            key: entry.grade,
            label: entry.grade === "No grade" ? "No grade" : `Grade ${entry.grade}`,
            tone: gradeTone(entry.grade),
            value: entry.count,
          }))}
        />
      ) : null}
      {mix.specialties.length > 1 ? (
        <RankedBars
          caption="Contacts by specialty"
          items={mix.specialties.map((entry) => ({
            key: entry.label,
            label: entry.label,
            tone: entry.other ? "sky" : "slate",
            value: entry.count,
          }))}
          total={countOf(list.counts.contacts, "contact")}
        />
      ) : null}
    </>
  );
}

/** Whether the CRM mirrors a list for the rep — pharmacies count towards HAVING one, as on the card. */
function hasListOf(rep: RepsListRep): boolean {
  return rep.contactCount + rep.pharmacyCount > 0;
}

/** The team table's columns on the Contact list tab — the same facts the cards print, one column each. */
function contactColumns(basePath: string, board: RepsListBoard, largest: number): TeamColumn<RepsListRep>[] {
  return [
    {
      cell: (rep) => (
        <TeamTableName href={hrefWithRep(basePath, board, rep.repKey)} muted={!hasListOf(rep)} name={rep.name} />
      ),
      key: "rep",
      label: "Medical rep",
      width: "w-[30%]",
    },
    {
      cell: (rep) => (
        <span className="text-phx-xs font-semibold text-slate-600 [overflow-wrap:anywhere]">
          {rep.areaNames.length > 0 ? rep.areaNames.join(" · ") : "No area on the seat"}
        </span>
      ),
      key: "area",
      label: "Area",
      width: "w-[22%]",
    },
    {
      align: "right",
      cell: (rep) => (
        <>
          <span className="font-black text-slate-900 tabular-nums">{rep.contactCount}</span>
          <CardMeter max={largest} value={rep.contactCount} />
        </>
      ),
      key: "contacts",
      label: "Contacts",
      width: "w-[16%]",
    },
    {
      align: "right",
      cell: (rep) => <span className="font-black text-slate-900 tabular-nums">{rep.pharmacyCount}</span>,
      key: "pharmacies",
      label: "Pharmacies",
      width: "w-[12%]",
    },
    {
      cell: (rep) =>
        hasListOf(rep) ? <StatusMark text="Mirrored" tone="emerald" /> : <StatusMark text="No list in the CRM" tone="amber" />,
      key: "list",
      label: "List",
      width: "w-[20%]",
    },
  ];
}

/**
 * One opened list — the month window, the tiles and the brick-grouped contacts.
 *
 * SHARED BY THE CONTACT TAB AND THE VACANT AREAS TAB. The owner asked for the vacant areas' doctors
 * "exactly as the other tab", and two copies of this block are two screens that disagree the first
 * time one is edited — about what counts as a contact, of all things.
 */
export function RepsListListBody({
  basePath,
  board,
  exportTitle,
  list,
  listName,
  monthPreserve,
  activityUnavailableNote,
}: {
  /**
   * What to say when no activity is shown and the reason is KNOWN rather than a failed read. A
   * vacant area's list belongs to a departed rep, whom every CRM read excludes by standing rule, so
   * "could not be read" there would blame an outage for a rule.
   */
  activityUnavailableNote?: string;
  basePath: string;
  board: Pick<
    RepsListBoard,
    "activityAsOf" | "activityAvailable" | "activityMonth" | "activityMonthLabel" | "activityUnvisited" | "monthOptions"
  >;
  /** The download's sheet and title. Reps List unless the page calls itself something else. */
  exportTitle?: string;
  list: RepsListForRep;
  /** Heads the contact table and its export. */
  listName: string;
  /** Everything the month picker must carry — the cascade, the open tab, the selected rep or area. */
  monthPreserve: Record<string, string | undefined>;
}) {
  return (
    <>
      {/* THE WINDOW, PRINTED ABOVE THE NUMBERS IT SCORES. On the 2nd of a month almost every
          contact is legitimately unvisited, so the span is stated rather than implied — a board
          showing only "Not visited 84" would read as a collapse in coverage instead of as a
          month that has barely started. The picker is separate from the cascade above because
          it answers a different question: those four say whose list, this says over what window.

          The contact list itself is NOT scoped by it and never becomes so. Changing the month
          re-scores the annotation beside each name and can never add or remove a contact. */}
      <div className="flex flex-wrap items-end gap-x-4 gap-y-2 border-b border-slate-100 px-5 py-4">
        <RepsListMonthPicker
          basePath={basePath}
          month={board.activityMonth}
          options={board.monthOptions}
          preserve={monthPreserve}
        />
        <p className="max-w-[80ch] pb-2 text-phx-2xs font-semibold leading-relaxed text-slate-500">
          {board.activityAvailable
            ? `Visits and plan counted from ${board.activityMonth}-01 to ${board.activityAsOf} Cairo.`
            : (activityUnavailableNote ??
              "The plan and visits for this month could not be read, so no activity is shown beside the contacts. The list below is complete and unaffected by that.")}
        </p>
      </div>
      <RepsListTiles board={board} list={list} />
      {/* The two halves of the contact list as one bar — PM against AM, which add to 100%. Pharmacies are NOT on it:
          a pharmacy is not a contact (owner, 2026-09-01), and a bar is a share of one whole. */}
      {list.counts.contacts > 0 ? (
        <ShareBar
          caption="Contacts by list"
          segments={[
            { key: "pm", label: "PM list", tone: "sky", value: list.counts.pm },
            { key: "am", label: "AM list", tone: "emerald", value: list.counts.am },
          ]}
        />
      ) : null}
      <BrickBars list={list} />
      <ListMixCharts list={list} />
      <div aria-hidden className="h-5" />
      <RepsListContacts
        activityAvailable={board.activityAvailable}
        activityMonthLabel={board.activityMonthLabel}
        brickCoverage
        exportTitle={exportTitle}
        groups={list.groups}
        repName={listName}
        validationRead={list.validationRead}
      />
    </>
  );
}

/**
 * The breakdown above the list — Contacts · PM · AM · Pharmacies · Bricks · Awaiting a brick, and
 * Not visited when the month could be read.
 *
 * ONE DEFINITION, because Phoenix CRM's List tab shows the same breakdown (owner, 2026-09-24: "the
 * breakdown of the PM list and the AM, pharmacies and bricks... when there are visits I need the
 * breakdown to be also not visited"). A second copy next door would agree on the day it was written
 * and disagree on the first change to any one of these counts — about what a contact is, of all
 * things, which is the one arithmetic this board exists to keep straight.
 */
export function RepsListTiles({
  board,
  gutter = "px-5",
  list,
}: {
  board: Pick<RepsListBoard, "activityAvailable" | "activityMonthLabel" | "activityUnvisited">;
  /**
   * The side padding, so the tiles line up with the blocks around them. Reps List keeps its own
   * `px-5`; Phoenix CRM passes its `px-4 sm:px-5`, or the tiles sit 4px off its left edge on a phone.
   */
  gutter?: string;
  list: RepsListForRep;
}) {
  // Sized by how many tiles there are, so Not visited joins the row as a seventh rather than sitting
  // alone under six.
  const count = board.activityAvailable ? 7 : 6;
  return (
    <div className={`grid gap-2 pt-5 ${tileColumns(count)} ${gutter}`}>
      {/* The list names are the CRM's own and the owner's own — PM list, AM list,
          Pharmacist. The sub-line carries each one's share rather than a description,
          because naming what a list "is" invents a meaning the CRM never stated.

          A PHARMACY IS NOT A CONTACT. Owner, 2026-09-01: "you will not count the
          pharmacies as contacts... the contacts is divided into AM and PM, and the
          pharmacies are separate." So the Contacts tile is PM + AM, the two beneath it
          are its halves and add to 100%, and Pharmacies stands apart with its own count
          and no share — a share would only re-imply the total he separated them out of. */}
      <Tile label="Contacts" sub="PM and AM lists" value={String(list.counts.contacts)} />
      <Tile
        label="PM list"
        share={sharePercent(list.counts.pm, list.counts.contacts)}
        sub={shareOf(list.counts.pm, list.counts.contacts)}
        tone="sky"
        value={String(list.counts.pm)}
      />
      <Tile
        label="AM list"
        share={sharePercent(list.counts.am, list.counts.contacts)}
        sub={shareOf(list.counts.am, list.counts.contacts)}
        tone="emerald"
        value={String(list.counts.am)}
      />
      <Tile label="Pharmacies" sub="counted apart from contacts" value={String(list.counts.pharmacy)} />
      {/* The VALUE is the mapped bricks alone. Counting the unmapped localities here
          too would have this tile report bricks that do not exist — on a rep whose whole
          area is unmapped it read "Bricks 8 / 0 mapped", which is a contradiction. */}
      <Tile label="Bricks" sub="mapped territories" value={String(list.groups.length - list.unmappedRegionCount)} />
      {/* Stated on screen rather than left to be noticed: an unmapped locality is a
          mapping backlog, and the board is the punch-list for it. */}
      <Tile
        label="Awaiting a brick"
        sub={
          list.unmappedContactCount > 0 ? awaitingBrickSub(list) : "every locality is mapped"
        }
        tone={list.unmappedContactCount > 0 ? "amber" : "emerald"}
        value={String(list.unmappedContactCount)}
      />
      {/* THE REASON THIS COLUMN EXISTS, AS A NUMBER. It counts ROWS and is deliberately never
          labelled "contacts": a pharmacy is not a contact (owner, 2026-09-01) and this figure
          spans both tabs, so that word would restate the very total he separated.

          `untouched` PLUS `missed`, and nothing else — see UNVISITED_STATUSES. A doctor planned
          for next Tuesday has not been neglected, and counting him here would put a manager on
          the phone about nothing.

          It takes a seventh column when the screen has room for one and wraps on a narrower
          one — the golden rule forbids buying width from a neighbour. */}
      {board.activityAvailable ? (
        <Tile
          label="Not visited"
          sub={`no visit in ${board.activityMonthLabel}`}
          tone={board.activityUnvisited > 0 ? "amber" : "emerald"}
          value={String(board.activityUnvisited)}
        />
      ) : null}
    </div>
  );
}

export function RepsListBoardView({ basePath, board }: { basePath: string; board: RepsListBoard }) {
  const { list, options, reps, scopeLabel, scopeReason, selected, selection, syncedAt } = board;
  // Everything that is NOT a cascade level and must survive a cascade pick. Without it, choosing a
  // line while reading August would bounce the window silently back to the current month.
  const preserve = { month: board.activityMonth };

  // A viewer who reaches nobody is told so in words. An empty picker would read as "the CRM holds
  // no lists", which is a completely different statement and the one a manager would act on.
  if (scopeReason) {
    return (
      <div className="border border-slate-200">
        <Section description="No reps are in your reach." title="Reps List">
          <EmptyNote
            detail="This board shows the CRM contact list of the reps who report to you, grouped by brick. Until the organogram places reps under your seat there is nothing here — which is not the same as the CRM holding no lists."
            title={scopeReason}
          />
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

  // The grid's figures, counted from the same reps the cards draw — so the tiles and the grid can never disagree.
  const withList = reps.filter(hasListOf);
  const missingLists = reps.length - withList.length;
  const largest = reps.reduce((most, rep) => Math.max(most, rep.contactCount), 0);
  const groups = groupRepsByTeam(reps);

  return (
    <div className="border border-slate-200">
      <Section description={description} title="Reps List">
        <RepsListFilters basePath={basePath} options={options} preserve={preserve} selection={selection} />
      </Section>

      {selected ? <BackToAllReps href={hrefWithRep(basePath, board, null)} /> : null}
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
          <RepProfileBand
            facts={[
              { label: "Contacts", value: String(selected.contactCount) },
              { label: "Pharmacies", value: String(selected.pharmacyCount) },
              list == null
                ? { label: "List", tone: "amber", value: "Not in the CRM" }
                : { label: "Bricks", value: String(list.groups.length - list.unmappedRegionCount) },
            ]}
            name={selected.name}
            places={selected.areaNames.length > 0 ? selected.areaNames.join(" · ") : "No area on the seat"}
            team={teamHeading(selected.team)}
          />
          {list == null ? (
            <EmptyNote
              detail="They are seated in the organogram, so this is a CRM account or sync gap rather than a rep with no doctors. The daily sync fills this board from the CRM's own contact list."
              title={`The CRM holds no contact list for ${selected.name}.`}
            />
          ) : (
            <RepsListListBody
              basePath={basePath}
              board={board}
              list={list}
              listName={selected.name}
              monthPreserve={{
                area: selection.area,
                line: selection.line,
                region: selection.region,
                rep: selection.rep,
              }}
            />
          )}
        </Section>
      ) : (
        <Section
          description="Pick a rep to open their contact list. The reps are grouped by region and district manager; narrow with the filters above first if the list is long."
          meta={countOf(reps.length, "rep")}
          title={`Medical reps — ${reps.length}`}
        >
          <TileRow count={4}>
            {/* The team's lists in four figures. No contact total: two reps can share a customer, and adding
                their lists would count that doctor twice. */}
            <Tile label="Reps" sub="in these filters" value={String(reps.length)} />
            <Tile
              label="Lists mirrored"
              share={reps.length > 0 ? Math.round((withList.length / reps.length) * 100) : 0}
              sub="a list in the CRM"
              tone="emerald"
              value={String(withList.length)}
            />
            <Tile
              label="No list mirrored"
              sub={missingLists > 0 ? "a CRM account or sync gap" : "every rep has a list"}
              tone={missingLists > 0 ? "amber" : "emerald"}
              value={String(missingLists)}
            />
            <Tile
              label="Typical list"
              sub="contacts a rep, the median"
              value={String(median(withList.map((rep) => rep.contactCount)))}
            />
          </TileRow>
          {/* Every team on one screen: who has lists mirrored and who has none, team against team. */}
          <TeamRollup
            caption="The teams at a glance"
            groups={groups}
            noun="rep"
            segments={(members) => [
              { key: "list", label: "With a list", tone: "emerald", value: members.filter(hasListOf).length },
              { key: "none", label: "No list mirrored", tone: "amber", value: members.filter((rep) => !hasListOf(rep)).length },
            ]}
          />
          {reps.length > 0 ? (
            <ExportRowBar note="The reps in these filters, by region and district manager, with the size of each list.">
              <ExportXlsxButton
                columns={[
                  { key: "region", label: "Region" },
                  { key: "manager", label: "District manager" },
                  { key: "rep", label: "Medical rep" },
                  { key: "area", label: "Area" },
                  // Never summed: two reps can share a doctor, so a total would count that doctor twice.
                  { excludeFromTotal: true, key: "contacts", label: "Contacts", numeric: true },
                  { excludeFromTotal: true, key: "pharmacies", label: "Pharmacies", numeric: true },
                  { key: "list", label: "List" },
                ]}
                label="Download the team"
                rows={groups.flatMap((group) =>
                  group.reps.map((rep) => ({
                    area: rep.areaNames.join(" · "),
                    contacts: rep.contactCount,
                    list: hasListOf(rep) ? "Mirrored" : "No list in the CRM",
                    manager: rep.team.managerName ?? "",
                    pharmacies: rep.pharmacyCount,
                    region: rep.team.regionName,
                    rep: rep.name,
                  })),
                )}
                sheetName="Reps List"
                subtitle={`Your reach: ${scopeLabel}`}
                title="Reps List — the team"
              />
            </ExportRowBar>
          ) : null}
          {reps.length === 0 ? (
            <EmptyNote
              detail="Clear a level of the cascade to widen it. An empty result here means no seated rep works that combination — not that the CRM is missing data."
              title="No reps match these filters."
            />
          ) : (
            // Grouped by region and district manager (owner, 2026-11-09: "group reps by district manager").
            <>
              <GroupedCardGrid
                groups={groups}
                noun="rep"
                phoneOnly
                renderCard={(rep) => (
                  <RepCard href={hrefWithRep(basePath, board, rep.repKey)} key={rep.repKey} largest={largest} rep={rep} />
                )}
                renderGroupMeta={(members) => <TeamListLine reps={members} />}
              />
              {/* A desktop reads the team as a table, a phone as cards (owner's standing rule). */}
              <TeamTable
                caption="The medical reps in these filters, by region and district manager"
                columns={contactColumns(basePath, board, largest)}
                groups={groups}
                noun="rep"
                renderGroupMeta={(members) => <TeamListLine reps={members} />}
                rowKey={(rep) => rep.repKey}
              />
            </>
          )}
        </Section>
      )}
    </div>
  );
}
