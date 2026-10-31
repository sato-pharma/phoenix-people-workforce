"use client";

/**
 * Phoenix CRM — the customer sections of the List tab, given the board's own treatment.
 *
 * Owner, 2026-09-25: "make all the list tabs have the same features and tweaks." The list opens on
 * "The list" board — bricks in colour, collapsible, six filters and an export — and the other parts
 * of the list (To validate, Your list, Outside the list, the Archive) read the same customers a plainer
 * way. This renders those the board's way instead: grouped by brick with the same eight hues and the
 * same open/shut headings, the same filter row, and the same XLSX export.
 *
 * WHY A SECOND COMPONENT RATHER THAN THE BOARD ITSELF. The board (`RepsListContacts`) reads the
 * iReports360 mirror — rows keyed on a contact's CRM id, pharmacies and all — while these three read
 * the CRM's own customer list (`ListCustomer`): new customers the rep added with no iReports360 row,
 * customers with no place yet, dropped customers the board no longer carries. Neither population is a
 * subset of the other, so the look is shared here rather than the data being forced through one pipe.
 * The palette, the square edges and the 1px rules are copied verbatim so the two read as one board.
 *
 * ONE BUTTON PER ROW (owner, 2026-09-29): Validate while the customer is not validated, Open once he
 * is — never "Add visit", which starts only from Visits, Today or the portal's "+". The row renders
 * its button itself from `listRowAction` (src/lib/phoenix-crm/list-request-rules.ts), so no section
 * can hand it a second one.
 */

import { Fragment, useCallback, useId, useMemo, useState, type ReactNode } from "react";
import { SlidersHorizontal } from "lucide-react";

import { ExportXlsxButton } from "@/components/ui/export-xlsx-button";
import { TableSearchInput } from "@/components/ui/sortable-table";
import { cairoStamp, dayLabelWithYear } from "@/components/phoenix-crm/format";
import {
  listText,
  monthStanding,
  monthVisitsText,
  pendingVisitsText,
  referenceLastVisitText,
} from "@/components/phoenix-crm/labels";
import { placesDaysText } from "@/components/phoenix-crm/list-screens";
import {
  CrmBareSelect,
  CrmButton,
  CrmCard,
  CrmCardsOnPhone,
  CrmPill,
  CrmTable,
  crmTdClassName,
  crmThClassName,
} from "@/components/phoenix-crm/ui";
import {
  buildGroups,
  displayOrder,
  distinct,
  gradeOf,
  matchesActivity,
  matchesQuery,
  specialityOf,
  type CustomerGroup,
} from "@/lib/phoenix-crm/customer-list-grouping";
import { clusterRows, describeSharing, findNeighbours, type NearbyContact } from "@/lib/crm/location-confidence";
import { factInk, gradeInk, listRowFacts, rowPoint } from "@/lib/phoenix-crm/list-row-facts";
import { validateFirstIn } from "@/lib/phoenix-crm/validate-next";
import { planPatternRows } from "@/lib/phoenix-crm/plan-pattern";
import { LOCATION_CHECKING_PILL, LOCATION_NOT_CONFIRMED_PILL } from "@/lib/phoenix-crm/google-place-rules";
import { listRowAction, requestKindLabel, type ListRowAction } from "@/lib/phoenix-crm/list-request-rules";
import type { ListCustomer } from "@/lib/phoenix-crm/view-types";
import { brickTintMap, neighbourTint, type BrickTint } from "@/components/phoenix-crm/brick-tints";

/**
 * BRICK COLOUR — the same eight hues, in the same order, as the board (reps-list-tables.tsx) and now
 * as the Visits picker, which groups a day by brick too. They live in brick-tints.ts precisely because
 * there are three readers: a brick that is teal here and indigo at the door is no use as a landmark.
 * The wash lands on the block heading, never on a row: a mapped brick gets a left bar and a light
 * fill, an unmapped locality stays amber, exactly as the board draws them.
 */

/**
 * The board's field-surface controls (reps-list-tables.tsx, FIELD_*_CLASS): a thumb's 44px on a phone
 * and 36px from `md`, labels at the house 10px floor, and a square edge written out because a phone's
 * native select draws its own.
 *
 * The five filters below are `CrmBareSelect`, so they keep exactly this look and become COMBO BOXES
 * on an admin account (owner, 2026-10-03) — the Brick filter is the one that needed it: a long list's
 * brick names are the hardest thing on this board to find by scrolling.
 */
const LABEL_CLASS = "block text-phx-2xs font-black uppercase tracking-[0.16em] text-slate-400";
const SELECT_CLASS =
  "h-11 w-full rounded-none border border-slate-200 bg-white px-2 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400 md:h-9";

/**
 * Which part of the list this is drawing — it decides the row's detail line, its pills and headers.
 * "pending" is To validate, "active" is Your list, "outside" is Outside the list, "dropped" the Archive.
 */
export type CustomerListVariant = "pending" | "active" | "outside" | "dropped";

/**
 * The one button a customer's row carries, for THIS viewer.
 *
 * `listRowAction` decides it (Validate while not validated, Open once he is), and only the territory's
 * rep validates — anyone else is offered Open, which is exactly what they can do.
 *
 * 🔴 IT NO LONGER ASKS FOR AN iREPORTS360 CONTACT. It used to fall back to Open for a pending row
 * with `referenceContactCrmId === null`, because the Validate screen could only open on a live vendor
 * entry. Since 2026-10-02 a customer can reach the list from the SFE's own sheet, with no vendor row
 * anywhere — and that customer must be validated at the door like any other, through the `listed`
 * subject. Falling back to Open there left him on the list with no way off it, which is the shape of
 * defect the owner's rule 1 forbids.
 */
export function rowActionFor(customer: ListCustomer, canValidate: boolean): ListRowAction | null {
  const action = listRowAction(customer);
  if (action === "validate" && !canValidate) return "open";
  return action;
}

/** The row's one button. Nothing else is ever drawn beside it. */
export function CustomerRowAction({
  canValidate,
  customer,
  onAction,
}: {
  canValidate: boolean;
  customer: ListCustomer;
  onAction: (customer: ListCustomer, action: ListRowAction) => void;
}) {
  const action = rowActionFor(customer, canValidate);
  if (!action) return null;
  return (
    <CrmButton onClick={() => onAction(customer, action)} size="sm" variant={action === "validate" ? "primary" : "secondary"}>
      {action === "validate" ? "Validate" : "Open"}
    </CrmButton>
  );
}

/** A request waiting on the customer, and the step it is on: "Drop from the list · Waiting for SFE". */
function waitingPills(customer: ListCustomer): ReactNode {
  const steps = customer.waiting.filter((entry) => entry.kind !== "grade");
  if (steps.length === 0) return null;
  return steps.map((entry) => (
    <CrmPill key={entry.requestId} tone="info">
      {entry.stageLabel ? `${requestKindLabel(entry.kind)} · ${entry.stageLabel}` : requestKindLabel(entry.kind)}
    </CrmPill>
  ));
}

/**
 * A brick's colour, keyed off its place in the WHOLE list rather than the filtered or sorted one — a
 * brick that changes hue as you search, or as the display order changes, is not a brick anyone can
 * learn. Only mapped bricks are tinted; an unmapped locality keeps amber, which is a statement.
 */
function tintsFor(groups: readonly CustomerGroup[]): Map<string, BrickTint> {
  return brickTintMap(groups.filter((group) => group.mapped).map((group) => group.key));
}

function GroupCaret({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden
      className={`h-3 w-3 shrink-0 self-center text-slate-500 transition-transform ${open ? "rotate-90" : ""}`}
      fill="none"
      stroke="currentColor"
      strokeLinecap="square"
      strokeLinejoin="miter"
      strokeWidth="2.5"
      viewBox="0 0 24 24"
    >
      <polyline points="9 6 15 12 9 18" />
    </svg>
  );
}

/** The block heading — the board's heading shape, so the two read as one board. */
function GroupHeading({
  collapsed,
  group,
  onToggle,
  shown,
  tint,
}: {
  collapsed: boolean;
  group: CustomerGroup;
  onToggle: () => void;
  shown: number;
  tint: BrickTint | null;
}) {
  const mappedTone = tint ? `border-slate-200 border-l-4 ${tint.bar} ${tint.fill}` : "border-slate-200 bg-slate-50";
  const tone = group.mapped ? mappedTone : "border-amber-200 bg-amber-50";
  return (
    <button
      aria-expanded={!collapsed}
      className={`flex w-full flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-y px-4 py-2.5 text-left sm:px-5 ${tone}`}
      onClick={onToggle}
      type="button"
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <GroupCaret open={!collapsed} />
        <h3 className="text-phx-xs font-black uppercase tracking-[0.14em] text-slate-900" dir="auto">
          {group.heading}
        </h3>
        {group.mapped && group.areaName ? (
          <span className="text-phx-2xs font-semibold text-slate-500">{group.areaName}</span>
        ) : group.mapped ? null : (
          <span className="text-phx-2xs font-black uppercase tracking-[0.1em] text-amber-700">
            Locality not yet mapped to a brick
          </span>
        )}
      </div>
      <span className="text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-400">
        {shown === group.customers.length ? `${group.customers.length}` : `${shown} of ${group.customers.length} shown`}
      </span>
    </button>
  );
}

/** The row's pills — the same standing chip an active customer carries on the board, or the pending mark. */
function rowPills(customer: ListCustomer, variant: CustomerListVariant, marked = false): ReactNode {
  if (variant === "pending") {
    // 🔴 NO "Not validated yet" PILL HERE (owner, 2026-09-30): "you don't have to show the column of
    // not-validated-yet, because since it has a Validate button beside it, then for sure it is not
    // validated. Be smart." The button IS the status — a pill repeating it is a second thing to read
    // that says nothing the row did not already say. It stays on the screens that have NO button to
    // say it: the visit form's customer card and the pending strip, where PENDING_PILL still lives.
    //
    // 🔴 ONE PILL DOES EARN ITS PLACE HERE, AND ONLY ON A MARKED ROW: why this row is first and
    // amber. It says what validating BUYS him — visits he has already made start counting — in plain
    // words about his own work, never a count of what he has not done (Golden rule #1). It reads the
    // brick's `marked` set rather than the customer, so it can never spread to every row again.
    // The Google check (2026-10-03), in the SYSTEM's words: while his place is being checked the row
    // offers Open rather than Validate, so this pill is the only thing saying why.
    return (
      <>
        {customer.locationCheck === "checking" ? <CrmPill tone="info">{LOCATION_CHECKING_PILL}</CrmPill> : null}
        {customer.locationCheck === "not_confirmed" ? <CrmPill tone="orange">{LOCATION_NOT_CONFIRMED_PILL}</CrmPill> : null}
        {marked && customer.locationCheck !== "checking" ? <CrmPill tone="orange">Validate first</CrmPill> : null}
        {waitingPills(customer)}
      </>
    );
  }
  if (variant === "outside") {
    // Met and validated at the door, not on the list: he counts once the add is approved.
    return (
      <>
        <CrmPill tone="orange">Outside the list</CrmPill>
        {customer.locationCheck === "checking" ? <CrmPill tone="info">{LOCATION_CHECKING_PILL}</CrmPill> : null}
        {customer.waiting.some((entry) => entry.kind === "add") ? waitingPills(customer) : <CrmPill>Not asked to add yet</CrmPill>}
      </>
    );
  }
  if (variant === "dropped") return waitingPills(customer);
  const standing = monthStanding(customer.visitsThisMonth, customer.target);
  return (
    <>
      <CrmPill tone={standing.tone}>{standing.label}</CrmPill>
      {customer.origin === "new" ? <CrmPill tone="orange">New customer</CrmPill> : null}
      {customer.pendingGradeRequestId ? (
        <CrmPill tone="info">{customer.pendingGrade ? `Grade ${customer.pendingGrade} proposed` : "Grade proposed"}</CrmPill>
      ) : null}
      {waitingPills(customer)}
    </>
  );
}

/** The detail line under a row — where he is (or was), said the way that part of the list says it. */
/**
 * 🔴 ONLY THE ARCHIVE STILL USES THIS. Every other variant's address now comes from `listRowFacts`,
 * which prefers what the rep CAPTURED over what iReports360 carried (owner, 2026-09-30: "when the
 * rep validates it, the validation will override the iReports360 data"). Before that, a pending row
 * read the vendor's address ONLY and a validated row read its places ONLY — so neither ever fell
 * back to the other, and a validated customer whose place had no street printed nothing.
 */
function detailText(customer: ListCustomer, variant: CustomerListVariant): string {
  if (variant === "dropped") return customer.droppedReason ?? "Reason not recorded";
  return placesDaysText(customer);
}

/** The phone card's one meta line: the list and the grade, the two the table gives their own ink. */
function cardMetaText(customer: ListCustomer): string {
  return `${listText(customer.listType)} · ${listRowFacts(customer).grade.text}`;
}

/**
 * 🔴 DOCTORS WHO STAND NEAR EACH OTHER SHARE A COLOUR (owner, 2026-09-30: "sort the addresses to be
 * near each other, give them colours, then sort by distance and by colour").
 *
 * FIVE HUES, WIDELY SPACED, AND NONE OF THEM ALREADY MEANS SOMETHING HERE — lifted verbatim from the
 * old Reps List, where the reasoning is written out: violet is the shared customer, emerald and
 * amber are the month's standing, amber is also "no brick yet" and orange is a link. Reusing any of
 * those would make one colour answer two questions. Clusters beyond the fifth wrap round, which is
 * safe because a repeat can only meet its twin with four other blocks in between.
 *
 * The wash lands on the ADDRESS cell and nowhere else: that is the thing being compared. The five
 * hues are NEIGHBOUR_TINTS in brick-tints.ts, one copy shared with the Reps List and the plan day.
 */

type Neighbourhood = { cluster: number | null; nearby: NearbyContact[] };

/**
 * Who stands beside whom inside ONE brick group, and which block each row belongs to.
 *
 * 🔴 PER GROUP, which is what makes "near each other" structural: a group already IS one brick, so
 * the comparison can never reach across a heading and call two people neighbours when the page has
 * just told the reader they are in different places. `findNeighbours` and `clusterRows` are the old
 * board's own — the owner asked that this not be built twice.
 *
 * The same pass REORDERS the rows so a block sits together ("sort them by distance and by colour"),
 * and NUMBERS each block so it can have a colour of its own rather than all sharing one tint.
 */
function neighbourhoodsIn(rows: readonly ListCustomer[]): { rows: ListCustomer[]; of: Map<string, Neighbourhood> } {
  const keyed = rows.map((customer) => {
    const point = rowPoint(customer);
    return { contactCrmId: rowKey(customer), customer, lat: point?.lat ?? null, lon: point?.lon ?? null, name: customer.name };
  });
  const found = findNeighbours(keyed);
  const clustered = clusterRows(keyed, found);
  const of = new Map<string, Neighbourhood>();
  for (const row of clustered.rows) {
    of.set(row.customer.customerId, {
      cluster: clustered.clusterOf.get(row.contactCrmId) ?? null,
      nearby: found.get(row.contactCrmId) ?? [],
    });
  }
  return { of, rows: clustered.rows.map((row) => row.customer) };
}

/**
 * A numeric key for a Phoenix CRM customer, because the old board's helpers are keyed on the CRM's
 * own contact id and a Phoenix customer's id is a UUID. A customer the rep added himself has no CRM
 * id at all, so the index is used — unique within one render, which is all these helpers need.
 */
const rowKeys = new WeakMap<ListCustomer, number>();
let nextRowKey = 1;
function rowKey(customer: ListCustomer): number {
  const found = rowKeys.get(customer);
  if (found != null) return found;
  const key = customer.referenceContactCrmId ?? -(nextRowKey += 1);
  rowKeys.set(customer, key);
  return key;
}

/**
 * "Also at this address: Ahmed Samir, Mona Fouad" — the names, not just a count.
 *
 * The USE of the highlight is a rep planning ONE stop instead of three, and for that he needs to know
 * WHICH ones. Long lists are trimmed to three and the rest counted: the point is "there is a cluster
 * here", not a roster. Tinted with its own block's hue so the words and the colour are one signal.
 */
function NearbyLine({ neighbourhood }: { neighbourhood: Neighbourhood | null }) {
  const nearby = neighbourhood?.nearby ?? [];
  if (nearby.length === 0) return null;
  const shown = nearby.slice(0, 3);
  const rest = nearby.length - shown.length;
  const tint = neighbourTint(neighbourhood?.cluster);
  return (
    <span className={`mt-0.5 block break-words text-phx-2xs font-semibold ${tint?.ink ?? "text-slate-500"}`} dir="auto">
      {`Also here: ${shown.map((entry) => entry.name).join(", ")}${rest > 0 ? ` and ${rest} more` : ""}`}
    </span>
  );
}

/**
 * 🔴 THE FULL ADDRESS, AND IT IS CLICKABLE (owner, 2026-09-30: "you were writing the full address
 * and the full address was clickable"). It opens Google Maps in a new tab — a pin on the captured
 * place's own point, or a search on the words when nothing has been captured yet.
 *
 * A placeholder is never a link: there is nothing to drive to, and a link that searches the words
 * "Set when you validate" would send him to the middle of nowhere.
 *
 * 🔴 IT NEVER RETURNS A <p>. The phone card wraps it in a <p> to carry the ink, and a <p> inside a
 * <p> is invalid HTML: the browser closes the outer one early, the server's markup no longer matches
 * React's tree, and every pending customer's card raised a hydration error (seen live 2026-10-03).
 * A BLOCK span looks exactly as the <p> did — preflight already zeroes a <p>'s margins, and `dir`
 * still aligns the line — and it is legal inside the phone's <p> and the table's <td> alike.
 */
function AddressText({ href, text }: { href: string | null; text: string }) {
  if (!href) {
    return (
      <span className="block break-words" dir="auto">
        {text}
      </span>
    );
  }
  return (
    <a
      className="break-words font-semibold text-orange-800 underline decoration-orange-300 underline-offset-2 hover:decoration-orange-600"
      dir="auto"
      href={href}
      rel="noreferrer"
      target="_blank"
    >
      {text}
    </a>
  );
}

/**
 * 🔴 WHEN HE IS USUALLY PLANNED, from the iReports360 reference plans (owner, 2026-09-30: "add
 * another column and tell him that, based on the reference weekly plans from iReports360, you are
 * visiting this doctor — Sunday and Tuesday, in the first and the fourth week").
 *
 * It states what the plans ALREADY SAY. It is not a target, not a frequency and not an instruction,
 * and it carries no count of whether the rep actually went — nothing on his own List judges him.
 * With no plan in the mirror it says so plainly rather than inventing a pattern or leaving a blank.
 */
/**
 * 🔴 EVERY COLUMN THE SAME WIDTH, AND EVERY CELL RULED (owner, 2026-09-30: "the table is fucked up,
 * must be symmetric — the columns at the same size, the height and the width of the one cell").
 *
 * The widths were hand-tuned per column — 22 / 13 / 7 / 13 / 21 / 14 / 10 — so no two cells were the
 * same size and the grid read as seven different boxes in a row. Seven equal tracks on the same
 * `table-fixed` layout still total 100%, so the fits-the-screen rule is untouched: the row fits its
 * column at every size and never scrolls sideways.
 */
const EQUAL_COLUMNS = ["14.28%", "14.28%", "14.28%", "14.29%", "14.29%", "14.28%", "14.30%"];

/**
 * The rule between two columns. A table with no vertical rules is a set of paragraphs that happen to
 * line up; with them, a cell is visibly a cell. `first:border-l-0` keeps the outer edge clean, and
 * `align-top` starts every cell in a row at the same y so a tall one never floats its neighbours.
 */
const GRID_CELL = "border-l border-slate-200 align-top";

/** No brick marks anything outside To validate, so every other variant shares one empty set. */
const EMPTY_MARKS: ReadonlySet<string> = new Set();

function PlanPatternCell({ customer }: { customer: ListCustomer }) {
  const rows = planPatternRows(customer.planPattern ?? []);
  if (rows.length === 0) return <span className="text-phx-2xs font-semibold italic text-slate-400">No plan recorded</span>;
  return (
    // 🔴 THE CELL IS ITSELF A LITTLE TABLE (owner, 2026-09-30: "it is a table: put day, put week
    // corresponding — make it a table, make it more tidy than this"). It was day chips that wrapped,
    // with the weeks they belonged to on the line BELOW them, so a reader paired day and week by
    // position and a four-day customer wrapped into a block. Two fixed tracks — the day, then its
    // weeks — put every pairing on one line, start every day at the same x down the whole column,
    // and let the weeks text wrap on its own without ever moving a day.
    // 🔴 AND IT IS RULED, NOT JUST ALIGNED (owner, same day: "I told you to add borders between the
    // Usually planned — add borders"). Alignment alone still read as loose text in a column: without
    // a rule between one day and the next, four days ran together as a paragraph. The wrapper draws
    // the top and left edges and every cell draws its own bottom and right, so the lines meet exactly
    // once and no edge is drawn twice.
    <span className="grid grid-cols-[auto_minmax(0,1fr)] border-l border-t border-slate-200">
      {rows.map((row) => (
        <Fragment key={row.day}>
          <span className="border-b border-r border-slate-200 bg-slate-50 px-1.5 py-1 text-center text-phx-3xs font-black uppercase tracking-[0.06em] text-slate-700">
            {row.day}
          </span>
          <span className="break-words border-b border-r border-slate-200 px-1.5 py-1 text-phx-2xs font-semibold text-slate-500">{row.weeksLabel}</span>
        </Fragment>
      ))}
    </span>
  );
}

/**
 * The small line under a shared customer's name — who else carries them, and how that was judged.
 *
 * The owner asked for the reason to be stated, not implied ("add in a small line why is he
 * highlighted, who is he shared with", and again on 2026-09-30 for this board). Naming the basis
 * matters because this is an INFERENCE, not a record: iReports360 gives every rep their own row for
 * one doctor, so the match is worked out from the name and the pin, or from a shared phone. A reader
 * who can see why can overrule it.
 */
function SharedLine({ customer }: { customer: ListCustomer }) {
  const shared = customer.sharedWith ?? null;
  if (!shared || shared.length === 0) return null;
  return (
    <span className="mt-1 block break-words text-phx-2xs font-semibold text-violet-700" dir="auto">
      {describeSharing(shared)}
    </span>
  );
}

/**
 * The history line beside a row.
 *
 * 🔴 A CARRIED-OVER ROW NEVER SAYS "no visits saved here yet" (owner, 2026-09-30: "that phrase is
 * totally wrong — of course this rep visited this doctor on iReports360 before. Either you grab the
 * visit history or remove the line"). It reported the PHOENIX count, which is zero for every
 * carried-over customer by definition — their Phoenix history starts at validation — and it printed
 * directly under "Last visit in iReports360: Tue 29 Sept", so one row said he was there last week
 * and that he has never been.
 *
 * It now states what the mirror actually holds: "14 visits in iReports360 · last Tue 29 Sept". Until
 * validation that IS the whole history of this doctor, so it replaces the vendor's date line too
 * rather than sitting beside it saying the same thing twice. Once he is validated and on the list,
 * the Phoenix month takes over — which is the point at which the Phoenix count starts meaning
 * something. `pendingVisitsText` stays for the screens with no iReports360 history to show.
 */
function monthText(customer: ListCustomer, variant: CustomerListVariant): string {
  if (variant === "pending" || variant === "outside") {
    const history = customer.referenceHistory ?? null;
    if (history && history.visits > 0) {
      const last = history.lastVisitedOn ? ` · last ${dayLabelWithYear(history.lastVisitedOn)}` : "";
      return `${history.visits} ${history.visits === 1 ? "visit" : "visits"} in iReports360${last}`;
    }
    // No history in the mirror either — then "nothing saved here yet" is true, and says so.
    return pendingVisitsText(customer.visitsThisMonth);
  }
  if (variant === "dropped") return `In the Archive since ${cairoStamp(customer.statusChangedAt)}`;
  return monthVisitsText(customer.visitsThisMonth, customer.target);
}

/** True once the history line already names the last iReports360 visit, so nothing repeats it. */
function historyNamesLastVisit(customer: ListCustomer): boolean {
  return (customer.referenceHistory?.visits ?? 0) > 0 && customer.referenceHistory?.lastVisitedOn != null;
}

/**
 * The address column's heading.
 *
 * It said "Address in iReports360" on a row waiting to be validated and "Places and days" on a
 * validated one, because each read one source. It now reads BOTH, capture first (owner, 2026-09-30),
 * so a single word is the only honest heading: the column holds the best address there is for that
 * customer, and the cell itself shows in lighter italics when nothing has filled it yet.
 */
const DETAIL_HEADER: Record<CustomerListVariant, string> = {
  pending: "Address",
  active: "Address",
  outside: "Address",
  dropped: "Why it is in the Archive",
};

export function CustomerListBoard({
  canValidate,
  customers,
  exportTitle,
  onRowAction,
  repName,
  variant,
}: {
  /** The viewer is the territory's rep, who validates. Anyone else is offered Open on every row. */
  canValidate: boolean;
  /** The whole status subset for this part of the list, unfiltered — the board does its own filtering. */
  customers: readonly ListCustomer[];
  /** The download's sheet name and title, e.g. "Your list". */
  exportTitle: string;
  /** The row's one button was pressed: Validate or Open (`rowActionFor`). */
  onRowAction: (customer: ListCustomer, action: ListRowAction) => void;
  /** Whose list this is, by name — heads the export (owner's standing rule: names, never seat codes). */
  repName: string;
  variant: CustomerListVariant;
}) {
  const rowAction = (customer: ListCustomer) => <CustomerRowAction canValidate={canValidate} customer={customer} onAction={onRowAction} />;
  const [brick, setBrick] = useState("");
  const [listType, setListType] = useState("");
  const [grade, setGrade] = useState("");
  const [speciality, setSpeciality] = useState("");
  const [activity, setActivity] = useState("");
  const [query, setQuery] = useState("");
  // Phones only: whether the filter row is unfolded. Shut by default, as on the board — the toggle
  // names how many filters are on, so a narrowed list never passes for the whole one.
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filtersId = useId();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const toggleGroup = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // Built from ALL the customers, in appearance order, so a brick keeps its hue as a filter narrows
  // the board — the same discipline the board itself keeps.
  const allGroups = useMemo(() => buildGroups(customers), [customers]);
  const tints = useMemo(() => tintsFor(allGroups), [allGroups]);
  const gradeOptions = useMemo(() => distinct(customers.map(gradeOf)), [customers]);
  const specialityOptions = useMemo(() => distinct(customers.map(specialityOf)), [customers]);

  const needle = query.trim().toLowerCase();
  const visible = useMemo(
    () =>
      displayOrder(allGroups)
        .filter((group) => !brick || group.key === brick)
        .map((group) => ({
          group,
          rows: group.customers.filter(
            (customer) =>
              (!listType || customer.listType === listType) &&
              (!grade || gradeOf(customer) === grade) &&
              (!speciality || specialityOf(customer) === speciality) &&
              matchesActivity(customer, activity) &&
              matchesQuery(customer, needle),
          ),
        }))
        .filter((entry) => entry.rows.length > 0),
    [activity, allGroups, brick, grade, listType, needle, speciality],
  );

  // Each shown group's order and marks, worked out ONCE per list and filter (2026-10-16 Phoenix CRM
  // performance audit). Folding a brick, opening the phone's Filters or anything else that redraws the
  // board used to compare every doctor in every group against every other again; the answer depends
  // on the shown rows and the section alone, so it is kept until one of them changes.
  const arranged = useMemo(
    () =>
      visible.map((rawEntry) => {
        // 🔴 Gather the doctors who stand together, colour each block, and put a block's rows
        // under each other (owner, 2026-09-30). Scoped to THIS group, so numbering — and
        // therefore colour — restarts in every brick, and a comparison never crosses a heading.
        const neighbourhoods = neighbourhoodsIn(rawEntry.rows);
        // 🔴 Only the few with the MOST visits waiting are marked, per brick (owner, 2026-09-30:
        // "mark only the ones with the most visits waiting, not all 88"). A brick whose
        // candidates all carry the same count marks none — there is no "most" to point at.
        // 🔴 AND A CUSTOMER WAITING TO BE CAPTURED AGAIN COMES BEFORE ALL OF THEM, oldest wait
        // first, in rose (owner, 2026-10-08) — `validateFirstIn`. His own "Validate again" pill
        // says why; the rose rail only puts him where the rep looks first.
        const waitingFirst = variant === "pending" ? validateFirstIn(neighbourhoods.rows) : null;
        return {
          entry: { ...rawEntry, rows: waitingFirst?.rows ?? neighbourhoods.rows },
          neighbourhoods,
          markedForValidating: waitingFirst?.marked ?? EMPTY_MARKS,
          captureAgain: waitingFirst?.again ?? EMPTY_MARKS,
        };
      }),
    [variant, visible],
  );

  const shownCount = visible.reduce((sum, entry) => sum + entry.rows.length, 0);
  const brickCount = visible.filter((entry) => entry.group.mapped).length;
  const localityCount = visible.length - brickCount;

  const exportRows = visible.flatMap((entry) =>
    entry.rows.map((customer) => ({
      brick: entry.group.mapped ? entry.group.heading : `${entry.group.heading} (not yet mapped to a brick)`,
      area: entry.group.areaName ?? "",
      customer: customer.name,
      grade: customer.grade ?? "",
      speciality: customer.speciality ?? "",
      // His phone as the rep typed it (owner, 2026-09-30, "Excel is enough"). Empty until he gives
      // one, like the grade and specialty above — never a dash, which this sheet uses nowhere.
      phone: customer.phone ?? "",
      list: customer.listType,
      detail: detailText(customer, variant),
      visits: customer.visitsThisMonth,
      target: customer.target ?? "",
      standing: variant === "active" ? monthStanding(customer.visitsThisMonth, customer.target).label : "",
      archived_on: variant === "dropped" ? cairoStamp(customer.statusChangedAt) : "",
    })),
  );

  // The toggle counts only what it hides. The search stays in sight on a phone, so what it holds is
  // already on screen and is not counted twice.
  const filtersOn = [brick, listType, activity, grade, speciality].filter(Boolean).length;
  const clearAll = () => {
    setBrick("");
    setListType("");
    setActivity("");
    setGrade("");
    setSpeciality("");
    setQuery("");
  };

  return (
    <div className="space-y-3 border-t border-slate-100 px-4 py-5 sm:px-5">
      {/* ONE ROW OF CONTROLS, IN TWO ORDERS. On a phone the search leads — it is what a rep reaches for
          standing in the street — with the Filters toggle and the export beside it, and the five selects
          fold behind the toggle, which says how many are on so a narrowed list never passes for the
          whole one. From `md` up the selects are always open and come first, as they always did.
          The selects' wrapper is `contents` from `md`, so they wrap in the same row as the search
          without the search being drawn twice; `md:order-first` is what puts them ahead of it. */}
      <div className="flex flex-wrap items-end gap-3">
        <label className="block w-full sm:w-64">
          <span className={LABEL_CLASS}>Search</span>
          <TableSearchInput
            className="mt-1"
            onChange={setQuery}
            onClear={() => setQuery("")}
            placeholder="Customer, specialty or address"
            size="md"
            value={query}
          />
        </label>
        <button
          aria-controls={filtersId}
          aria-expanded={filtersOpen}
          className="flex min-h-11 min-w-0 flex-1 items-center justify-between gap-2 rounded-none border border-slate-200 bg-white px-3 text-left text-phx-2xs font-black uppercase tracking-[0.16em] text-slate-600 md:hidden"
          onClick={() => setFiltersOpen((open) => !open)}
          type="button"
        >
          <span className="flex min-w-0 items-center gap-2">
            <SlidersHorizontal aria-hidden className="h-3.5 w-3.5 shrink-0 text-slate-500" />
            <span className="min-w-0 break-words">{filtersOn > 0 ? `Filters · ${filtersOn} on` : "Filters"}</span>
          </span>
          <GroupCaret open={filtersOpen} />
        </button>
        <ExportXlsxButton
          className="h-11 md:ml-auto md:h-9"
          columns={[
            { key: "brick", label: "Brick" },
            { key: "area", label: "Area" },
            { key: "customer", label: "Customer" },
            { key: "grade", label: "Grade" },
            { key: "speciality", label: "Specialty" },
            // Beside the specialty, where the daily plan sheet puts it too. `text` because a phone is
            // an identifier, not a quantity: without it one retype turns 01012345678 into the number
            // 1012345678, which is how 124 employee mobile numbers lost their leading zero.
            { key: "phone", label: "Phone", text: true, width: 15 },
            { key: "list", label: "List" },
            { key: "detail", label: DETAIL_HEADER[variant] },
            { key: "visits", label: "Visits this month", numeric: true },
            { key: "target", label: "Target", numeric: true },
            ...(variant === "active" ? [{ key: "standing", label: "Standing" }] : []),
            ...(variant === "dropped" ? [{ key: "archived_on", label: "In the Archive since" }] : []),
          ]}
          rows={exportRows}
          sheetName={exportTitle}
          subtitle={`${repName} · grouped by brick, as held by the CRM`}
          title={exportTitle}
        />
        {/* `hidden` and `contents` are never written together: which of two display utilities wins is
            the stylesheet's order, not the class list's. */}
        <div className={filtersOpen ? "contents" : "hidden md:contents"} id={filtersId}>
          <label className="block w-full sm:w-56 md:order-first">
            <span className={LABEL_CLASS}>Brick</span>
            <CrmBareSelect className={`mt-1 ${SELECT_CLASS}`} onChange={(event) => setBrick(event.target.value)} value={brick}>
              <option value="">All bricks</option>
              {displayOrder(allGroups).map((group) => (
                <option key={group.key} value={group.key}>
                  {group.mapped ? group.heading : `${group.heading} — no brick yet`}
                </option>
              ))}
            </CrmBareSelect>
          </label>
          <label className="block w-full sm:w-44 md:order-first">
            <span className={LABEL_CLASS}>List</span>
            <CrmBareSelect className={`mt-1 ${SELECT_CLASS}`} onChange={(event) => setListType(event.target.value)} value={listType}>
              <option value="">PM and AM lists</option>
              <option value="PM">PM list only</option>
              <option value="AM">AM list only</option>
            </CrmBareSelect>
          </label>
          <label className="block w-full sm:w-52 md:order-first">
            <span className={LABEL_CLASS}>This month</span>
            <CrmBareSelect className={`mt-1 ${SELECT_CLASS}`} onChange={(event) => setActivity(event.target.value)} value={activity}>
              <option value="">All activity</option>
              <option value="unvisited">Not visited this month</option>
              <option value="visited">Visited this month</option>
            </CrmBareSelect>
          </label>
          <label className="block w-full sm:w-40 md:order-first">
            <span className={LABEL_CLASS}>Grade</span>
            <CrmBareSelect className={`mt-1 ${SELECT_CLASS}`} onChange={(event) => setGrade(event.target.value)} value={grade}>
              <option value="">All grades</option>
              {gradeOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </CrmBareSelect>
          </label>
          <label className="block w-full sm:w-56 md:order-first">
            <span className={LABEL_CLASS}>Specialty</span>
            <CrmBareSelect className={`mt-1 ${SELECT_CLASS}`} onChange={(event) => setSpeciality(event.target.value)} value={speciality}>
              <option value="">All specialties</option>
              {specialityOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </CrmBareSelect>
          </label>
        </div>
      </div>

      <p className="text-phx-2xs font-semibold text-slate-400">
        {`${shownCount} shown across ${brickCount} ${brickCount === 1 ? "brick" : "bricks"}`}
        {localityCount > 0 ? ` and ${localityCount} ${localityCount === 1 ? "locality" : "localities"} awaiting one` : ""}
      </p>

      {visible.length === 0 ? (
        // One press back to the whole list: a filter the rep set on a phone is folded out of sight, so
        // the way out of "nothing matches" sits where he is looking rather than behind the toggle.
        <div className="grid justify-items-center gap-2 px-3 py-6 text-center">
          <p className="text-xs font-semibold text-slate-500">Nothing matches this filter.</p>
          <CrmButton onClick={clearAll} size="sm">
            Clear the filters
          </CrmButton>
        </div>
      ) : (
        <div className="border border-slate-200">
          {arranged.map(({ entry, neighbourhoods, markedForValidating, captureAgain }) => {
            const isCollapsed = collapsed.has(entry.group.key);
            return (
              <div key={entry.group.key}>
                <GroupHeading
                  collapsed={isCollapsed}
                  group={entry.group}
                  onToggle={() => toggleGroup(entry.group.key)}
                  shown={entry.rows.length}
                  tint={tints.get(entry.group.key) ?? null}
                />
                {isCollapsed ? null : (
                  <>
                    <CrmCardsOnPhone>
                      {entry.rows.map((customer) => (
                        // The phone says the same thing the row does: the card carries the amber
                        // rail and tint when validating this customer starts visits counting. The
                        // order is already the row order — both read `entry.rows`.
                        <CrmCard
                          accent={
                            captureAgain.has(customer.customerId)
                              ? "border-l-rose-500"
                              : markedForValidating.has(customer.customerId)
                                ? "border-l-amber-500"
                                : undefined
                          }
                          actions={rowAction(customer)}
                          className={
                            captureAgain.has(customer.customerId)
                              ? "bg-rose-50"
                              : markedForValidating.has(customer.customerId)
                                ? "bg-amber-50"
                                : undefined
                          }
                          key={customer.customerId}
                          meta={cardMetaText(customer)}
                          status={rowPills(customer, variant, markedForValidating.has(customer.customerId) && !captureAgain.has(customer.customerId))}
                          title={<span dir="auto">{customer.name}</span>}
                        >
                          {/* The same facts the table prints, folded to a phone's one column — and
                              through the SAME resolver, so a row cannot say one thing on a desktop
                              and another in a pocket. The address is the clickable one here too;
                              on a phone the Maps link hands off to the Maps app. */}
                          <SharedLine customer={customer} />
                          <p className={`text-xs font-semibold leading-5 ${factInk(listRowFacts(customer).address)}`}>
                            <AddressText
                              href={listRowFacts(customer).mapsHref}
                              text={variant === "dropped" ? detailText(customer, variant) : listRowFacts(customer).address.text}
                            />
                          </p>
                          <p className="break-words text-xs font-semibold leading-5 text-slate-500" dir="auto">
                            {listRowFacts(customer).brick.text}
                          </p>
                          {/* The same two the table gained: who stands beside him, and when the
                              iReports360 plans say he is seen. */}
                          <NearbyLine neighbourhood={neighbourhoods.of.get(customer.customerId) ?? null} />
                          <p className="break-words text-xs font-semibold leading-5 text-slate-500">
                            <PlanPatternCell customer={customer} />
                          </p>
                          {variant === "active" || variant === "outside" ? (
                            <p className="break-words text-xs font-semibold leading-5 text-slate-500">{placesDaysText(customer)}</p>
                          ) : null}
                          {variant === "pending" && !historyNamesLastVisit(customer) ? (
                            <p className="break-words text-xs font-semibold leading-5 text-slate-500">
                              Last visit in iReports360: {referenceLastVisitText(customer.reference)}
                            </p>
                          ) : null}
                          {variant === "dropped" && customer.droppedNote ? (
                            <p className="whitespace-pre-line break-words text-xs font-semibold leading-5 text-slate-600">{customer.droppedNote}</p>
                          ) : null}
                          <p className="break-words text-xs font-semibold leading-5 text-slate-500">{monthText(customer, variant)}</p>
                        </CrmCard>
                      ))}
                    </CrmCardsOnPhone>
                    {/* 🔴 THE OLD REPS LIST'S COLUMNS, on the owner's instruction of 2026-09-30:
                        "the rep list in Phoenix CRM will be exactly the same" — Contact · Specialty ·
                        List · Brick · Address, and the Validate button we already have beside them.
                        They were one grey meta line under the name until then, which is not a board.

                        🔴 THE OLD BOARD'S SIXTH COLUMN, CONFIDENCE, IS DELIBERATELY NOT HERE. It
                        scored how well a rep's check-in matched the brick — a check on him — and
                        golden rule #1 keeps every such signal off his own screens. `ListPlace` still
                        carries `brickDistanceKm` for the Super Admin's board; it must never reach a
                        cell here. The old board dropped Confidence whenever it spent brick colour
                        anyway, and this board always spends brick colour.

                        The widths total 100% on a `table-fixed` grid, so the row fits its column at
                        every size rather than scrolling sideways (the fits-the-screen golden rule);
                        the phone gets the cards above instead. */}
                    <CrmTable columns={EQUAL_COLUMNS}>
                      <thead>
                        <tr>
                          <th className={`${crmThClassName} ${GRID_CELL} first:border-l-0`} scope="col">
                            Customer
                          </th>
                          <th className={`${crmThClassName} ${GRID_CELL} first:border-l-0`} scope="col">
                            Specialty
                          </th>
                          <th className={`${crmThClassName} ${GRID_CELL} first:border-l-0`} scope="col">
                            List
                          </th>
                          <th className={`${crmThClassName} ${GRID_CELL} first:border-l-0`} scope="col">
                            Brick
                          </th>
                          <th className={`${crmThClassName} ${GRID_CELL} first:border-l-0`} scope="col">
                            {DETAIL_HEADER[variant]}
                          </th>
                          {/* 🔴 What the iReports360 plans already say about him — not a target and
                              not an instruction, which is why the heading is "Usually planned" and
                              never "Frequency". */}
                          <th className={`${crmThClassName} ${GRID_CELL} first:border-l-0`} scope="col">
                            Usually planned
                          </th>
                          <th className={`${crmThClassName} ${GRID_CELL} first:border-l-0`} scope="col">
                            <span className="sr-only">Actions</span>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {entry.rows.map((customer) => {
                          const facts = listRowFacts(customer);
                          const shared = (customer.sharedWith?.length ?? 0) > 0;
                          const again = captureAgain.has(customer.customerId);
                          const ready = markedForValidating.has(customer.customerId) && !again;
                          const near = neighbourhoods.of.get(customer.customerId) ?? null;
                          const nearTint = neighbourTint(near?.cluster);
                          return (
                            // 🔴 A CUSTOMER SHARED WITH ANOTHER REP IS HIGHLIGHTED — the old board's
                            // violet, row level, on the owner's instruction of 2026-09-30 ("if a
                            // doctor is shared between this rep and another rep it was highlighted").
                            // Violet is reserved for exactly this across both boards; it can sit on
                            // a row here with nothing to fight, because this board spends its brick
                            // colour on the HEADING and never on a row.
                            // 🔴 AND ONE WITH VISITS ALREADY SAVED IS HIGHLIGHTED TOO, IN AMBER
                            // ("put the already-visited first and highlight them"). Two marks can
                            // land on one row, so they are given two different things to hold: the
                            // shared rule keeps the row's violet, which it has had since this board
                            // was built, and ready-to-count takes the amber RAIL on the first cell
                            // plus its own pill. A row that is both still says both, and neither
                            // colour is ever painted over the other.
                            <tr className={shared ? "bg-violet-50" : again ? "bg-rose-50" : ready ? "bg-amber-50" : undefined} key={customer.customerId}>
                              <td
                                className={`${crmTdClassName} ${GRID_CELL} first:border-l-0 ${again ? "border-l-[3px] border-l-rose-500 first:border-l-[3px]" : ready ? "border-l-[3px] border-l-amber-500 first:border-l-[3px]" : ""}`}
                              >
                                <p className="font-black text-slate-950">
                                  <span dir="auto">{customer.name}</span>
                                </p>
                                {/* The grade keeps its own ink, as the old board painted it. */}
                                <p className={`mt-0.5 text-phx-2xs font-black uppercase tracking-[0.08em] ${gradeInk(customer.grade)}`}>{facts.grade.text}</p>
                                {/* WHY it is highlighted, and who with — the owner asked for the
                                    reason to be stated rather than implied, because the match is an
                                    inference a reader must be able to overrule. */}
                                <SharedLine customer={customer} />
                                <div className="mt-1 flex flex-wrap gap-1">{rowPills(customer, variant, ready)}</div>
                              </td>
                              <td className={`${crmTdClassName} ${GRID_CELL} ${factInk(facts.speciality)}`}>
                                <span className="break-words" dir="auto">
                                  {facts.speciality.text}
                                </span>
                              </td>
                              <td className={`${crmTdClassName} ${GRID_CELL} first:border-l-0`}>
                                {/* 🔴 AM and PM are the two lists, printed apart and never summed. */}
                                <span className="text-phx-2xs font-black uppercase tracking-[0.08em] text-slate-500">
                                  {listText(customer.listType)}
                                </span>
                              </td>
                              <td className={`${crmTdClassName} ${GRID_CELL} ${factInk(facts.brick)}`}>
                                {/* 🔴 THE BRICK ONLY. Its AREA is NOT repeated here (owner,
                                    2026-09-30: "you duplicated the wrong areas and regions"): the
                                    group heading this row sits under already names brick AND area,
                                    and the address carries the vendor's own region words, which are
                                    a different vocabulary again — "Monofia III · Delta West" over a
                                    heading reading "Menoufia 2". Three namings of one place, two of
                                    them disagreeing, is what he was looking at. */}
                                <p className="break-words" dir="auto">
                                  {facts.brick.text}
                                </p>
                              </td>
                              {/* 🔴 The neighbourhood wash lands on the ADDRESS cell and nowhere
                                  else — that is the thing being compared. A row standing alone
                                  carries no colour, which is itself the answer. */}
                              <td className={`${crmTdClassName} ${GRID_CELL} ${nearTint?.fill ?? ""} ${factInk(facts.address)}`}>
                                <AddressText href={facts.mapsHref} text={variant === "dropped" ? detailText(customer, variant) : facts.address.text} />
                                <NearbyLine neighbourhood={near} />
                                {variant === "active" || variant === "outside" ? (
                                  <p className="mt-0.5 break-words text-phx-2xs font-semibold leading-4 text-slate-500">{placesDaysText(customer)}</p>
                                ) : null}
                                {variant === "pending" && !historyNamesLastVisit(customer) ? (
                                  <p className="mt-0.5 text-xs text-slate-500">
                                    Last visit in iReports360: {referenceLastVisitText(customer.reference)}
                                  </p>
                                ) : null}
                                {variant === "dropped" && customer.droppedNote ? (
                                  <p className="mt-0.5 whitespace-pre-line break-words text-phx-2xs font-semibold leading-4 text-slate-500">{customer.droppedNote}</p>
                                ) : null}
                                <p className="mt-0.5 break-words text-phx-2xs font-semibold leading-4 text-slate-500">{monthText(customer, variant)}</p>
                              </td>
                              <td className={`${crmTdClassName} ${GRID_CELL} first:border-l-0`}>
                                <PlanPatternCell customer={customer} />
                              </td>
                              <td className={`${crmTdClassName} ${GRID_CELL} first:border-l-0`}>
                                {/* The column's full width — the board's Actions column does the same. */}
                                <div className="grid gap-1.5 [&>button]:w-full">{rowAction(customer)}</div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </CrmTable>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
