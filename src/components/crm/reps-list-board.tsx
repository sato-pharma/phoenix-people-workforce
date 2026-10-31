import Link from "next/link";

import { RepsListContacts } from "@/components/crm/reps-list-tables";
import { RepsListFilters, RepsListMonthPicker } from "@/components/crm/reps-list-filters";
import { cairoStamp, Section, Tile } from "@/components/crm/reps-list-chrome";
import type { RepsListForRep } from "@/lib/crm/reps-list";
import { awaitingBrickSub } from "@/lib/crm/reps-list-labels";
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

function RepCard({ href, rep }: { href: string; rep: RepsListRep }) {
  // Pharmacies count towards HAVING a list even though they are not contacts: a rep holding only
  // pharmacies does have a list, and calling that "no list" would be a false finding.
  // NOT gated on a CRM account. A rep hired after the cutover has none, and his list is found by his
  // HR id — requiring `agentCrmId` here labelled every such rep "no list" whatever he held.
  const hasList = rep.contactCount + rep.pharmacyCount > 0;
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
        {hasList ? listLabel(rep.contactCount, rep.pharmacyCount) : "No list mirrored from the CRM"}
      </p>
    </Link>
  );
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
      <div className="flex flex-wrap items-end gap-3 px-5 pt-5">
        <RepsListMonthPicker
          basePath={basePath}
          month={board.activityMonth}
          options={board.monthOptions}
          preserve={monthPreserve}
        />
        <p className="pb-2 text-phx-2xs font-semibold text-slate-500">
          {board.activityAvailable
            ? `Visits and plan counted from ${board.activityMonth}-01 to ${board.activityAsOf} Cairo.`
            : (activityUnavailableNote ??
              "The plan and visits for this month could not be read, so no activity is shown beside the contacts. The list below is complete and unaffected by that.")}
        </p>
      </div>
      <RepsListTiles board={board} list={list} />
      <RepsListContacts
        activityAvailable={board.activityAvailable}
        activityMonthLabel={board.activityMonthLabel}
        exportTitle={exportTitle}
        groups={list.groups}
        repName={listName}
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
  // Six a row from `md`: a tablet (768–1023px) has more room than a 1024px screen with the sidebar
  // open, so it gets the same row rather than three narrower ones.
  return (
    <div className={`grid grid-cols-2 gap-2 pt-3 sm:grid-cols-3 md:grid-cols-6 ${gutter}`}>
      {/* The list names are the CRM's own and the owner's own — PM list, AM list,
          Pharmacist. The sub-line carries each one's share rather than a description,
          because naming what a list "is" invents a meaning the CRM never stated.

          A PHARMACY IS NOT A CONTACT. Owner, 2026-09-01: "you will not count the
          pharmacies as contacts... the contacts is divided into AM and PM, and the
          pharmacies are separate." So the Contacts tile is PM + AM, the two beneath it
          are its halves and add to 100%, and Pharmacies stands apart with its own count
          and no share — a share would only re-imply the total he separated them out of. */}
      <Tile label="Contacts" sub="PM and AM lists" value={String(list.counts.contacts)} />
      <Tile label="PM list" sub={shareOf(list.counts.pm, list.counts.contacts)} value={String(list.counts.pm)} />
      <Tile label="AM list" sub={shareOf(list.counts.am, list.counts.contacts)} value={String(list.counts.am)} />
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

          It wraps onto a second row rather than squeezing the six above it. The golden rule
          forbids buying width from a neighbour, and a lone tile under the others reads as the
          summary line it is. */}
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
        <RepsListFilters basePath={basePath} options={options} preserve={preserve} selection={selection} />
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
