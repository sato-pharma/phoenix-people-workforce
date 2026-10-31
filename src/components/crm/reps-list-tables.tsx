"use client";

import { createContext, Fragment, useCallback, useContext, useId, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import {
  PortalRecordCard,
  PortalRecordFields,
  PortalResponsiveDataList,
} from "@/components/employee-portal/portal-primitives";
import { ExportXlsxButton } from "@/components/ui/export-xlsx-button";
import { useDialogA11y } from "@/components/ui/use-dialog-a11y";
import { useHydrated } from "@/hooks/use-hydrated";
import {
  ACTIVITY_CLASS,
  ACTIVITY_FILTER_ORDER,
  ACTIVITY_LABEL,
  ACTIVITY_MEANING,
  UNVISITED_STATUSES,
  activityCountLabel,
  type RepsListActivity,
} from "@/lib/crm/reps-list-activity";
import { TableSearchInput } from "@/components/ui/sortable-table";
import { polishAddress, polishAddressText } from "@/lib/crm/address-polish";
import type { DoctorListRow } from "@/lib/crm/contact-lists";
import {
  PLAN_VERDICT_LABEL,
  PLAN_VERDICT_MEANING,
  type PlanRowVerdict,
} from "@/lib/crm/plan-actuals";
import type { PlanDoctorDay, PlanDoctorRow } from "@/lib/crm/plan-doctors";
import { classifyCrmContactSpeciality, type CrmContactKind } from "@/lib/crm/contact-taxonomy";
import {
  confidenceLabel,
  describeSharing,
  NEIGHBOUR_M,
  sharedWithCell,
  type ConfidenceBand,
} from "@/lib/crm/location-confidence";
import type { PhoenixInsight } from "@/lib/crm/phoenix-insights";
import type { RepsListContact, RepsListGroup } from "@/lib/crm/reps-list";
import { REPS_LIST_NO_LOCATION, unmappedBrickLabel } from "@/lib/crm/reps-list-labels";
import { formatStableEnGb } from "@/lib/format/cairo-datetime";

// Client half of Reps List — the rep's contacts, one block per brick.
//
// Styling copies doctor-list-tables.tsx verbatim (flat borders, slate-900 header rows, orange
// accent, the same THEAD/grade vocabulary) because this board replaces it in the same shell.
//
// THE FILTER AND SEARCH ARE CLIENT-SIDE HERE, unlike the cascade next door, and deliberately so:
// the cascade decides WHICH REP a viewer may open, which is an access decision and therefore the
// server's; narrowing one already-authorised rep's own list to pharmacies is a view preference and
// costs a round trip for nothing.
//
// ONE SEARCH AND ONE EXPORT FOR THE WHOLE REP, NOT ONE PER BRICK. A per-brick search would mean a
// hook per group and a different number of hooks on every render, which React forbids outright; it
// would also make "find this doctor" a hunt through fifteen boxes. Group headings stay visible while
// a filter is active, minus any group the filter empties.

const THEAD = "px-3 py-2.5 text-phx-2xs font-black uppercase tracking-[0.12em] text-white";
const LABEL_CLASS = "block text-phx-3xs font-black uppercase tracking-[0.16em] text-slate-400";
const SELECT_CLASS =
  "h-9 w-full border border-slate-200 bg-white px-2 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400";

/**
 * The same two controls on Phoenix CRM's List tab, where a rep filters with a thumb: 44px on a phone
 * (36px from `md`, as above), labels at the house 10px floor, and a square edge written out because a
 * phone's native select draws its own. My List, the manager Reps List and the admin board keep the
 * two classes above byte for byte.
 */
const FIELD_LABEL_CLASS = "block text-phx-2xs font-black uppercase tracking-[0.16em] text-slate-400";
const FIELD_SELECT_CLASS =
  "h-11 w-full rounded-none border border-slate-200 bg-white px-2 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400 md:h-9";

/**
 * True inside Phoenix CRM's List tab (the `collapsible` board). Read where a prop cannot reach without
 * changing a call site the tests pin — the insights chip is drawn from three places.
 */
const FieldSurface = createContext(false);

/**
 * The three list names, in the owner's own words — corrected by him on 2026-09-01: PM list, AM list,
 * Pharmacist. The first build renamed `PM` to something friendlier because that is what it holds,
 * and that is exactly what he refused: the CRM says PM, the reps and the managers say PM, so a
 * prettier name on this one screen only makes Phoenix and the CRM disagree out loud in front of a
 * user. Pinned in tests/reps-list.test.ts, because a rename reads as a harmless copy tidy-up.
 */
const LIST_LABEL: Record<DoctorListRow["listType"], string> = {
  AM: "AM list",
  PM: "PM list",
  Pharmacy: "Pharmacist",
};

/**
 * The board is split into two TABS, not one list with a filter — the owner, 2026-09-01: "make two
 * tabs, a tab for contacts which are AM and PM lists, and another tab corresponding to it with
 * pharmacies, to avoid misleading."
 *
 * That phrase is the requirement. A pharmacy is not a contact, so a single scrollable list mixing
 * them means every count, every filter and every glance down the page silently blends two different
 * kinds of work — which is exactly the overstatement corrected earlier the same day, where "157
 * contacts" turned out to be 114 contacts and 43 pharmacies. A tab cannot be forgotten the way a
 * dropdown left on "All" can.
 */
const TABS = [
  { key: "contacts", label: "Contacts", sub: "PM and AM lists" },
  { key: "pharmacies", label: "Pharmacies", sub: "counted apart from contacts" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

const inTab = (row: DoctorListRow, tab: TabKey): boolean =>
  tab === "pharmacies" ? row.listType === "Pharmacy" : row.listType !== "Pharmacy";

/**
 * BRICK COLOUR — Phoenix CRM's List tab only, never Reps List or My List.
 *
 * The owner, 2026-09-24, asked for the bricks and the two tabs to carry colour so a long list is
 * readable as blocks rather than one grey run. It is OFF by default (`brickColor`) precisely because
 * this file's colour budget is deliberately tiny — see "The colour budget" below — and the boards
 * that already spend it must not gain a tenth hue.
 *
 * WHAT IS EXCLUDED, AND WHY: amber (an unmapped locality, and the B grade), violet (a shared
 * customer), orange (a link), rose (the A grade). Each already means something on a row, and a block
 * wash in the same hue would give one colour two meanings — the exact fault the budget note warns
 * about. Confidence's emerald/amber pair is free here only because a board that spends brick colour
 * is a board with NO confidence column (`rowActions` replaces it).
 *
 * It lands on the block HEADING and the tab, never on a row: the row already carries the shared and
 * neighbourhood washes, and a third background there would answer no question at all.
 */
const BRICK_TINTS = [
  { bar: "border-l-sky-500", fill: "bg-sky-50", tab: "border-sky-500" },
  { bar: "border-l-emerald-500", fill: "bg-emerald-50", tab: "border-emerald-500" },
  { bar: "border-l-indigo-500", fill: "bg-indigo-50", tab: "border-indigo-500" },
  { bar: "border-l-teal-500", fill: "bg-teal-50", tab: "border-teal-500" },
  { bar: "border-l-fuchsia-500", fill: "bg-fuchsia-50", tab: "border-fuchsia-500" },
  { bar: "border-l-cyan-500", fill: "bg-cyan-50", tab: "border-cyan-500" },
  { bar: "border-l-lime-500", fill: "bg-lime-50", tab: "border-lime-500" },
  { bar: "border-l-stone-500", fill: "bg-stone-100", tab: "border-stone-500" },
] as const;

type BrickTint = (typeof BRICK_TINTS)[number];

/**
 * The List filter now lives INSIDE the Contacts tab and offers only the two lists that tab holds.
 * Leaving "Pharmacists only" in it would let a viewer select an option that empties the tab by
 * definition — a control whose only effect is to produce "nothing matches" is a trap, not a filter.
 */
const LIST_FILTERS = [
  { label: "PM and AM lists", value: "" },
  { label: "PM list only", value: "PM" },
  { label: "AM list only", value: "AM" },
] as const;

function gradeClass(grade: string | null): string {
  if (grade === "A" || grade === "A+") return "text-rose-700";
  if (grade === "B") return "text-amber-700";
  if (!grade) return "text-slate-300";
  return "text-slate-500";
}

/** What the pickers and the table show when the CRM left the field empty. */
const NO_GRADE = "No grade";
const UNSPECIFIED = "Unspecified";

const gradeOf = (row: DoctorListRow): string => row.grade?.trim() || NO_GRADE;

/**
 * The phone, or null when the CRM has none.
 *
 * The CRM writes a literal "0" for an absent number — it is not a phone, and printed under a
 * doctor's name it reads as one. Filled on about a third of rows either way.
 */
const phoneOf = (row: DoctorListRow): string | null => {
  const value = row.phone?.trim();
  return !value || value === "0" ? null : value;
};
const specialityOf = (row: DoctorListRow): string => row.speciality?.trim() || UNSPECIFIED;

/** A group's stable key — the brick id when it has one, else its locality name. */
const groupKey = (group: RepsListGroup): string => group.brickId ?? `region:${group.heading}`;

/**
 * A brick's colour, keyed off its place in the WHOLE list rather than the filtered one.
 *
 * Indexing the visible groups would repaint every block as a filter narrows the board — a brick that
 * changes colour as you search is not a brick anyone can learn.
 */
function brickTintsFor(groups: readonly RepsListGroup[]): Map<string, BrickTint> {
  const tints = new Map<string, BrickTint>();
  groups.forEach((group, index) => {
    tints.set(groupKey(group), BRICK_TINTS[index % BRICK_TINTS.length]);
  });
  return tints;
}

/**
 * "12 contacts · 3 pharmacies", or just the contacts when a group holds no pharmacies.
 *
 * A PHARMACY IS NOT A CONTACT — the owner's rule, 2026-09-01: "you will not count the pharmacies as
 * contacts... the contacts is divided into AM and PM, and the pharmacies are separate." Every place
 * this board prints a size therefore goes through here, so the two can never be silently re-added.
 * A bare `rows.length` beside the word "contacts" is the bug this replaced.
 */
function describeMix(rows: readonly RepsListContact[], emptyNoun: "contacts" | "pharmacies" = "contacts"): string {
  const pharmacies = rows.filter((row) => row.listType === "Pharmacy").length;
  const contacts = rows.length - pharmacies;
  const parts: string[] = [];
  if (contacts > 0) parts.push(`${contacts} ${contacts === 1 ? "contact" : "contacts"}`);
  if (pharmacies > 0) parts.push(`${pharmacies} ${pharmacies === 1 ? "pharmacy" : "pharmacies"}`);
  // Nothing at all still has to be SAID, and said in the noun of whatever is being looked at. "No
  // pharmacies on this rep's list" is an answer; "0 contacts" over an empty pharmacy table is a
  // sentence about the wrong thing, which is how an empty state gets read as a broken screen.
  if (parts.length === 0) return emptyNoun === "pharmacies" ? "no pharmacies" : "no contacts";
  return parts.join(" · ");
}

/**
 * Distinct values for one picker, in the order a reader expects.
 *
 * Built from THIS REP'S OWN CONTACTS rather than from a company-wide vocabulary, for the same
 * reason the cascade next door is built from real cells: a picker that offers a specialty this rep
 * does not carry is a dead end, and a dead end reads as "the filter is broken".
 */
function distinct(rows: readonly DoctorListRow[], read: (row: DoctorListRow) => string): string[] {
  const seen = new Set<string>();
  for (const row of rows) seen.add(read(row));
  // The two placeholders sort last wherever they appear — an absent value is not a category.
  return [...seen].sort((left, right) => {
    const placeholder = (value: string) => (value === NO_GRADE || value === UNSPECIFIED ? 1 : 0);
    return placeholder(left) - placeholder(right) || left.localeCompare(right);
  });
}

/**
 * The Specialty picker's options, grouped by what each value actually IS.
 *
 * The owner asked for this on 2026-09-01: "in the specialty filter you must separate the — for
 * example — hospital, pharmacy, private hospital, then the real specialities." The vendor ships ONE
 * free-text `speciality` column holding three different kinds of thing, so an alphabetical list
 * files "Private Hospital" between "Pediatrics" and "Psychiatry" as though a building were a
 * discipline. Roughly a fifth of CRM contacts are such a value.
 *
 * `classifyCrmContactSpeciality` DECIDES, and this file does not get a vote. That module is the
 * single authority, it carries the owner's own earlier rule verbatim ("all specialities SP,
 * pharmacy and hospitals contract and insurance HCP", 2026-08-08), and it exists precisely because
 * a previous session measured the same phenomenon and wrote a private speciality list beside it.
 * Adding a value belongs THERE, where every board that classifies gets the fix at once.
 *
 * A value the authority has never seen goes to its own group rather than into either real one —
 * the vendor adds labels without notice, and guessing is the defect that module was written for.
 */
const SPECIALITY_GROUP_LABEL: Record<CrmContactKind, string> = {
  hcp: "Places and accounts",
  sp: "Specialties",
  unclassified: "Not classified",
};

function groupedSpecialities(rows: readonly DoctorListRow[]): { kind: CrmContactKind; options: string[] }[] {
  const byKind = new Map<CrmContactKind, Set<string>>();
  for (const row of rows) {
    const value = specialityOf(row);
    // An absent speciality is reported as absent, never classified — `specialityOf` has already
    // turned it into the "Unspecified" placeholder and the authority reads that as unclassified.
    const kind = value === UNSPECIFIED ? "unclassified" : classifyCrmContactSpeciality(value);
    const bucket = byKind.get(kind) ?? new Set<string>();
    bucket.add(value);
    byKind.set(kind, bucket);
  }
  // Specialties first — they are what this board is for. The placeholder sorts last inside its own
  // group, because an absent value is not a category.
  return (["sp", "hcp", "unclassified"] as const)
    .map((kind) => ({
      kind,
      options: [...(byKind.get(kind) ?? [])].sort(
        (left, right) =>
          (left === UNSPECIFIED ? 1 : 0) - (right === UNSPECIFIED ? 1 : 0) || left.localeCompare(right),
      ),
    }))
    .filter((group) => group.options.length > 0);
}

function matches(row: RepsListContact, needle: string): boolean {
  if (!needle) return true;
  const haystack = [
    row.name,
    row.nameAr,
    row.speciality,
    row.region,
    row.address,
    row.place?.address,
    row.seenAt?.address,
    row.grade,
    row.phone,
    // Searchable because the sharing line is the answer to a real question — "what do I share with
    // Ahmed?" — and a highlight you cannot filter down to is a colour, not a tool.
    ...(row.sharedWith ?? []).map((entry) => entry.repName),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(needle);
}

/**
 * The collapse caret. A chevron drawn with SQUARE line caps and mitred joins, never a rounded one —
 * the square-edge golden rule reaches a 12px icon exactly as it reaches a card. It points right when
 * the block is shut and rotates down when it is open, so the shape itself says which way the click
 * goes rather than relying on colour.
 */
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

function GroupHeading({
  collapsed = false,
  collapsible = false,
  group,
  onToggle,
  shown,
  tint,
}: {
  /** Phoenix CRM only. When true, the heading is a button that opens and shuts its own block. */
  collapsible?: boolean;
  collapsed?: boolean;
  group: RepsListGroup;
  onToggle?: () => void;
  shown: number;
  tint?: BrickTint | null;
}) {
  // A mapped brick and an unmapped locality are visually distinct because they mean different
  // things: the first is a real territory, the second is a locality nobody has mapped to one yet.
  // Same shape, different tone — never a hidden row and never an identical-looking one.
  //
  // THE BRICK COLOUR NEVER REACHES AN UNMAPPED BLOCK. Amber here is a statement — "nobody has mapped
  // this locality yet" — and painting it the next hue in the rotation would delete that statement to
  // make the page prettier. A tinted block keeps the same square edges and the same 1px rules; the
  // colour is a left bar and a wash, never a new shape.
  const mappedTone = tint ? `border-slate-200 border-l-4 ${tint.bar} ${tint.fill}` : "border-slate-200 bg-slate-50";
  const tone = group.mapped ? mappedTone : "border-amber-200 bg-amber-50";
  // Phoenix CRM's blocks use the module's `px-4 sm:px-5`, so a heading lines up with the rows around
  // it on a phone; every other surface keeps its `px-5`.
  const layout = `flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-y ${collapsible ? "px-4 sm:px-5" : "px-5"} py-2.5`;
  const body = (
    <>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        {/* The caret rides at the head of the block name so a rep collapses a brick from the same
            place they read it. Only in the collapsible surface, so nothing else grows an icon. */}
        {collapsible ? <GroupCaret open={!collapsed} /> : null}
        {/* dir="auto" on the heading: brick names in production are single-language Arabic locality
            names, which is the case where block-level auto is house style and correct. */}
        <h3 className="text-phx-xs font-black uppercase tracking-[0.14em] text-slate-900" dir="auto">
          {group.heading}
        </h3>
        {/* The brick's area and the area's region, from the sales master (owner, 2026-10-31: "get the
            brick area and region"). */}
        {group.mapped && (group.areaName || group.regionName) ? (
          <span className="text-phx-2xs font-semibold text-slate-500">
            {[group.areaName, group.regionName].filter(Boolean).join(" · ")}
          </span>
        ) : null}
        {/* "No location yet" already says it all; a named locality says which step is missing. */}
        {group.mapped || group.heading === REPS_LIST_NO_LOCATION ? null : (
          <span className="text-phx-2xs font-black uppercase tracking-[0.1em] text-amber-700">
            Locality not yet mapped to a brick
          </span>
        )}
      </div>
      <span className="text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-400">
        {shown === group.rows.length ? describeMix(group.rows) : `${shown} of ${group.rows.length} shown`}
      </span>
    </>
  );
  // A button only where it does something — everywhere else the heading is the exact div it always
  // was, so My List, the manager Reps List and the Weekly Plans tab render byte-for-byte unchanged.
  if (!collapsible) {
    return <div className={`${layout} ${tone}`}>{body}</div>;
  }
  return (
    <button aria-expanded={!collapsed} className={`${layout} w-full text-left ${tone}`} onClick={onToggle} type="button">
      {body}
    </button>
  );
}

/**
 * The Google Maps URL for an exact fix. `?api=1&query=lat,lon` drops a pin at the coordinate and is
 * the documented cross-platform form — on a phone it hands off to the Maps app, on a desktop it
 * opens the web map. No key, no embed, no third-party script on the page.
 */
const pinHref = (point: { lat: number; lon: number }): string =>
  `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${point.lat},${point.lon}`)}`;

/**
 * The Maps URL for an address we have no fix for — a SEARCH, not a pin.
 *
 * The locality is appended because a bare Egyptian street name resolves almost anywhere: "برج
 * الصيرفي" alone is a coin toss between governorates, and a rep who drives to the wrong one has
 * been actively misled. Used only for the 1,468 contacts nobody has ever checked in on, where the
 * CRM's own address is all there is.
 */
const searchHref = (address: string, locality: string | null): string =>
  `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([address, locality].filter(Boolean).join(", "))}`;

/**
 * The check-in's date in Africa/Cairo — the owner's standing rule for every time this system shows.
 *
 * An observed address without its date is worse than none: "current" reads as today when it may be
 * from March. Day precision only; the hour of a check-in is noise on this board.
 */
function cairoDay(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "";
  return formatStableEnGb(parsed, { day: "2-digit", month: "short", timeZone: "Africa/Cairo", year: "numeric" });
}

const LINK_CLASS =
  "font-semibold text-orange-700 underline decoration-orange-300 underline-offset-2 hover:text-orange-900";

/**
 * ## The colour budget, and why it is this small
 *
 * The owner's constraint when he asked for these three markings, 2026-09-01: "every colour to be
 * used lightly, so I don't want to make the page noisy." Three features arrived at once that each
 * want to stand out, which is exactly how a board turns into a highlighter drawing. So the page adds
 * THREE tints and no more, each at the palette's lightest step, and each one carries a word beside
 * it — the colour finds the row, the words say what it means:
 *
 *  - VIOLET, row level, for a customer shared with another rep. Rare by construction (214 real pairs
 *    company-wide), so it genuinely marks rather than washes.
 *  - SKY, for contacts standing at the same address inside one brick — since grown into five
 *    neighbourhood hues (NEIGHBOUR_TINTS). It started on the address cell only; on 2026-10-31 the
 *    owner moved it to the WHOLE ROW, and a shared row takes it too (neighbourhoodRowClass).
 *  - EMERALD/AMBER, on the confidence bar and its number only. A bar's WIDTH does the work; the hue
 *    only separates "confirmed" from "doubtful", and the good case is the one that gets no ink.
 *
 * Amber already means "not mapped yet" on this board and orange already means "a link". Neither was
 * reused for a new meaning — a page where one colour means two things is worse than a plain one.
 *
 * ## The fourth signal has no colour at all, and that is the point
 *
 * Phoenix insights arrived later the same day, and by then the page had run out of hues: violet is
 * the shared customer, sky/rose/teal/lime/indigo are the five neighbourhoods, emerald and amber are
 * the confidence bands, amber is also "no brick yet", orange is a link, and rose and amber are also
 * the A and B grades. A tenth colour would not have been a new meaning — it would have been a
 * SECOND meaning for a colour that already had one, which is the exact thing the paragraph above
 * forbids.
 *
 * So the insight chip spends the one axis still free: SHAPE. It is the only filled dark pill on the
 * board, in the same slate-900 the table headers and the popup headers already use, so it reads as
 * Phoenix speaking rather than as data. Unmistakable at a glance, and it costs the palette nothing.
 */
const BAND_BAR: Record<ConfidenceBand, string> = {
  high: "bg-emerald-500",
  low: "bg-amber-500",
  medium: "bg-slate-400",
  unverified: "bg-slate-200",
};

const BAND_TEXT: Record<ConfidenceBand, string> = {
  high: "text-emerald-700",
  low: "text-amber-700",
  medium: "text-slate-700",
  unverified: "text-slate-400",
};

/** The one-word verdict beside the number, so the percentage is never left to be guessed at. */
const BAND_WORD: Record<ConfidenceBand, string> = {
  high: "Confirmed",
  low: "Doubtful",
  medium: "Fair",
  unverified: "Seen once",
};

/**
 * The clickable confidence chip — a percentage, a word, and a bar whose width is the score.
 *
 * A BUTTON, NOT A LINK, because the owner asked for "a pop up, not a new page". A link would offer a
 * new tab on middle-click and promise a destination that does not exist.
 */
function ConfidenceChip({ onOpen, row }: { onOpen: () => void; row: RepsListContact }) {
  const confidence = row.confidence ?? null;
  if (!confidence) {
    // No check-in has ever been made, so there is nothing to score. Said in words: a 0% here would
    // read as "this location is wrong", when the truth is that nobody has been to it yet.
    return <span className="text-phx-2xs font-semibold text-slate-400">No visit yet</span>;
  }
  return (
    <button
      className="w-full text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-400"
      onClick={onOpen}
      title="How this score was worked out"
      type="button"
    >
      <span className={`block font-bold underline decoration-dotted underline-offset-2 ${BAND_TEXT[confidence.band]}`}>
        {confidenceLabel(confidence)}
      </span>
      <span className="mt-0.5 block text-phx-3xs font-semibold uppercase tracking-[0.1em] text-slate-400">
        {BAND_WORD[confidence.band]}
      </span>
      <span aria-hidden className="mt-1 block h-1 w-full bg-slate-100">
        <span className={`block h-1 ${BAND_BAR[confidence.band]}`} style={{ width: `${confidence.score}%` }} />
      </span>
    </button>
  );
}

/**
 * The popup shell both dialogs share — backdrop, Escape, close button, and the phone/desktop shape.
 *
 * EXTRACTED RATHER THAN COPIED when the second popup arrived (Phoenix insights, 2026-09-01). Two
 * dialogs that close differently is the kind of divergence nobody notices until one of them traps a
 * reader on a phone with no way out — and there are three ways out of this one on purpose: the
 * backdrop, the ×, and Escape.
 *
 * PORTALED TO THE BODY. The portal's page-transition wrapper keeps a `transform` after it animates in,
 * and a `position: fixed` element inside a transformed ancestor is placed against THAT ancestor, not
 * the screen: the sheet landed at the foot of the whole page, off-screen once the reader had scrolled,
 * under the bottom navigation, and the reader saw a dimmed page and nothing else. Mounted on
 * `document.body` it is placed against the screen again. Out there no shell rule squares its corners,
 * so `rounded-none` is written on the sheet itself. `useDialogA11y` holds the focus inside it, closes
 * it on Escape and stops the page scrolling behind it.
 */
function DialogShell({
  children,
  eyebrow,
  onClose,
  subject,
}: {
  children: ReactNode;
  /** The small uppercase line above the name, saying which popup this is. */
  eyebrow: string;
  onClose: () => void;
  /** The contact the popup is about. */
  subject: string;
}) {
  const dialogRef = useDialogA11y<HTMLDivElement>({ onClose, open: true });
  // A portal needs a document; the server render (and the first client pass) draws nothing.
  const mounted = useHydrated();
  if (!mounted) return null;

  return createPortal(
    <div
      aria-label={`${eyebrow}: ${subject}`}
      aria-modal="true"
      className="fixed inset-0 z-[300] flex items-end justify-center bg-slate-900/40 p-0 sm:items-center sm:p-4"
      onClick={onClose}
      ref={dialogRef}
      role="dialog"
    >
      {/* Bottom sheet on a phone, centred card on a desktop. `max-h` plus vertical scroll keeps a
          long explanation inside the viewport — the golden rule bans a SIDEWAYS scroll, and this
          never has one: every line wraps. The bottom padding clears a phone's home indicator. */}
      <div
        className="max-h-[85svh] w-full max-w-lg overflow-y-auto rounded-none border border-slate-200 bg-white pb-[env(safe-area-inset-bottom)] shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 bg-slate-900 px-4 py-3">
          <div className="min-w-0">
            <p className="text-phx-3xs font-black uppercase tracking-[0.16em] text-slate-400">{eyebrow}</p>
            <p className="break-words text-sm font-bold text-white" dir="auto">
              {subject}
            </p>
          </div>
          <button
            aria-label="Close"
            className="-my-2 -mr-2 inline-flex h-10 w-10 shrink-0 items-center justify-center text-lg font-bold leading-none text-slate-300 hover:text-white"
            onClick={onClose}
            type="button"
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

/**
 * The popup that explains a score — the owner asked for it by name: "if anyone clicks on it, a pop
 * up, not a new page, appears showing from where did you get the score."
 *
 * It states the arithmetic in words rather than showing a formula, because the reader is a manager
 * deciding whether to trust a pin, not an engineer auditing a weighting. Every line names what was
 * checked and what it was worth, and the lines add up to the number on the chip.
 */
function ConfidenceDialog({ onClose, row }: { onClose: () => void; row: RepsListContact }) {
  const confidence = row.confidence;
  if (!confidence) return null;
  return (
    <DialogShell eyebrow="Location confidence" onClose={onClose} subject={row.name}>
      <div className="flex items-baseline gap-2 border-b border-slate-100 px-4 py-3">
        <span className={`text-3xl font-black ${BAND_TEXT[confidence.band]}`}>{confidence.score}%</span>
        <span className="text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-400">
          {BAND_WORD[confidence.band]}
        </span>
      </div>

      <p className="px-4 pt-3 text-xs text-slate-500">
        {/* "customer", not "contact". Once a shared customer's rows are scored together the visits
            come from more than one contact record, and saying "this contact" would describe the
            wrong thing to the one reader most likely to notice — the manager looking at a row that
            names a second rep. */}
        {`Worked out from the ${confidence.total} check-in${confidence.total === 1 ? "" : "s"} `}
        {`${confidence.observers > 1 ? `${confidence.observers} reps have` : "a rep has"} made on this customer, `}
        {"each one compared against the pin shown in the Address column."}
      </p>

      <ul className="space-y-2 p-4">
        {confidence.reasons.map((reason) => (
          <li className="border border-slate-100 bg-slate-50/60 px-3 py-2" key={reason.label}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-phx-2xs font-black uppercase tracking-[0.1em] text-slate-500">{reason.label}</span>
              {reason.points == null ? null : (
                <span className="shrink-0 text-phx-2xs font-black text-slate-700">
                  {reason.points > 0 ? `+${reason.points}` : reason.points} pts
                </span>
              )}
            </div>
            <p className="mt-1 break-words text-xs text-slate-600">{reason.detail}</p>
          </li>
        ))}
      </ul>
    </DialogShell>
  );
}

/**
 * "Phoenix insights" — the label, and nothing else, on the rows that have something odd about them.
 *
 * The owner's words, 2026-09-01: "you can put beside each contact name Phoenix insights. Show only
 * Phoenix insights. And when anyone presses on it, you show the insights."  So the chip carries the
 * name of the thing and no preview of it: the row stays as quiet as it was, and the finding is one
 * press away. A row with nothing odd renders NOTHING here, which is most rows.
 */
function InsightsChip({ onOpen, row }: { onOpen: () => void; row: RepsListContact }) {
  // On the rep's field surface the chip is pressed at a clinic door, so it is a real target there
  // (32px, the 10px label floor). Everywhere else it stays the compact chip it always was.
  const field = useContext(FieldSurface);
  const insights = row.insights ?? null;
  if (!insights || insights.length === 0) return null;
  return (
    <button
      className={`mt-1 bg-slate-900 font-black uppercase tracking-[0.08em] text-white hover:bg-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 ${
        field ? "inline-flex min-h-8 items-center px-2 text-phx-2xs" : "inline-block px-1.5 py-0.5 text-phx-3xs"
      }`}
      onClick={onOpen}
      title="Something about this record looks wrong"
      type="button"
    >
      Phoenix insights
    </button>
  );
}

/**
 * What Phoenix noticed about one record, one short sentence each.
 *
 * "Be simple. Use clear English, be to the point, and don't prolong." — the owner, specifying this
 * popup. So there is no score, no arithmetic and no advice column: a heading of three words and one
 * sentence saying what is odd. Each sentence begins in English even when it names an Arabic rep,
 * which is why no `dir` is set here — an English sentence with a name inside it is single-language
 * text that the browser already lays out correctly, and a `dir="auto"` block would flip the whole
 * line right-to-left the moment a name came first (AGENTS.md 2.1).
 */
function InsightsDialog({ onClose, row }: { onClose: () => void; row: RepsListContact }) {
  const insights = row.insights ?? [];
  if (insights.length === 0) return null;
  return (
    <DialogShell eyebrow="Phoenix insights" onClose={onClose} subject={row.name}>
      <p className="px-4 pt-3 text-xs text-slate-500">
        {insights.length === 1
          ? "One thing about this record looks wrong."
          : `${insights.length} things about this record look wrong.`}
      </p>
      <ul className="space-y-2 p-4">
        {insights.map((insight: PhoenixInsight) => (
          <li className="border border-slate-200 bg-slate-50/60 px-3 py-2" key={insight.kind}>
            <span className="text-phx-2xs font-black uppercase tracking-[0.1em] text-slate-500">{insight.title}</span>
            <p className="mt-1 break-words text-xs text-slate-600">{insight.detail}</p>
          </li>
        ))}
      </ul>
    </DialogShell>
  );
}

/**
 * The small line under a shared customer's name — who else carries them, and how that was judged.
 *
 * The owner asked for the reason to be stated, not implied: "add in a small line why is he
 * highlighted, who is he shared with." Naming the basis matters because this is an inference, not a
 * record: the CRM gives every rep their own contact id even for one doctor, so Phoenix works the
 * identity out from the name and the pin, or from a shared phone. A reader who can see WHY can
 * overrule it.
 */
function SharedLine({ row }: { row: RepsListContact }) {
  const shared = row.sharedWith ?? null;
  if (!shared || shared.length === 0) return null;
  return (
    <span className="mt-1 block break-words text-phx-3xs font-semibold text-violet-700" dir="auto">
      {describeSharing(shared)}
    </span>
  );
}

/** "2 direct orders, 1 approved" — count first, because the count is what was asked for. */
function describeTrade(noun: string, total: number, approved: number): string {
  const head = `${total} ${total === 1 ? noun : `${noun}s`}`;
  if (approved === 0) return `${head}, none approved`;
  if (approved === total) return total === 1 ? `${head}, approved` : `${head}, all approved`;
  return `${head}, ${approved} approved`;
}

/**
 * Business Phoenix has actually done with this row — the owner's ask, 2026-09-01: "if a pharmacy in
 * the contact list and we meet direct order, show", and when asked what to show, "my objective is
 * two quantity ... I don't need the value now."
 *
 * So this line carries COUNTS and no money, and it states the approved figure beside the total
 * because the two diverge sharply in production: of the 89 direct orders raised through Phoenix only
 * 47 are approved, and of the 27 marketing requests NONE is — 15 sit in `pending_approval`. A bare
 * "3 marketing requests" on a doctor's row would read to a rep as three things the company bought
 * for them, when so far it is three things nobody has yet agreed to.
 *
 * Emerald, and deliberately the only positive-toned line on a row: the slate chip above it says
 * something looks wrong and the violet line says a customer is shared, while this one says the
 * company has a trading relationship here. A reader should not have to decode which is which.
 *
 * It is rare BY CONSTRUCTION, not by accident — see `contact-trade.ts` for why a name alone cannot
 * establish this. A row with no line means Phoenix has no record of trading with that contact, which
 * on the overwhelming majority of a 9,518-row list is simply true.
 */
function TradeLine({ row }: { row: RepsListContact }) {
  const trade = row.trade ?? null;
  if (!trade) return null;
  const parts: string[] = [];
  if (trade.directOrders > 0) {
    parts.push(describeTrade("direct order", trade.directOrders, trade.directOrdersApproved));
  }
  if (trade.marketingRequests > 0) {
    parts.push(describeTrade("marketing request", trade.marketingRequests, trade.marketingRequestsApproved));
  }
  if (parts.length === 0) return null;
  // No `dir` — this is an English sentence made of digits and English words, and a `dir="auto"`
  // block here would take its direction from whatever followed it in the DOM (AGENTS.md §2.1).
  return (
    <span className="mt-1 block break-words text-phx-3xs font-semibold text-emerald-700">
      {parts.join(" · ")}
    </span>
  );
}

/**
 * ONE address, polished and clickable — the owner's shape as of 2026-09-01.
 *
 * The board briefly showed two, labelled "Current" and "Old". He removed the second the same day
 * ("remove the old, doesn't make any relevance") and asked for what remains to be polished rather
 * than shown raw. So: the OBSERVED address where a rep last checked in — pinned to its exact
 * coordinate — and, only for a contact nobody has ever checked in on, the CRM's own address as a
 * map SEARCH. Never both on one row.
 *
 * THE VALIDATED PHOTO OUTRANKS THE CHECK-IN (owner, 2026-10-31: "use the validation pin"). A doctor
 * validated with a live photo is pinned where that photo was taken and dated "validated", because that
 * is a deliberate capture at his door; the last check-in is used only for a doctor not validated yet.
 * It is the same precedence his neighbours are found by (`groupContactsByBrick`), so the colour a row
 * is painted and the map its address opens always agree about where he stands.
 *
 * EACH SEGMENT IS ITS OWN `<bdi>`, and that is load-bearing, not decoration. 18.2% of these
 * addresses mix Arabic and English in one value (20,313 of 111,912, measured 2026-09-01). Under a
 * single `dir="auto"` the whole string takes its direction from the first strong character, so a
 * bilingual address flips wholly RTL and the English half renders backwards — the trap recorded in
 * AGENTS.md §2.1, whose fix is direction per line. `<bdi>` isolates each segment, which is exactly
 * that. Do not collapse this back to one `dir="auto"` string.
 */
function AddressCell({ locality, row }: { locality: string | null; row: RepsListContact }) {
  const place = row.place ?? null;
  const observed = place ? null : (row.seenAt ?? null);
  const point = place ?? observed;
  const segments = polishAddress(point?.address ?? row.address);

  // Nothing observed and nothing recorded: 117 contacts company-wide. Said in words, because an
  // em-dash in an address column reads as a rendering fault rather than as a fact about the data.
  if (!point && segments.length === 0) return <span className="text-slate-400">No address on record</span>;

  const href = point ? pinHref(point) : searchHref(segments.join(", "), locality);
  return (
    <div className="break-words">
      <a className={LINK_CLASS} href={href} rel="noreferrer" target="_blank">
        {segments.length > 0
          ? segments.map((segment, index) => (
              <Fragment key={`${index}:${segment}`}>
                {index > 0 ? <span className="font-normal text-slate-400">, </span> : null}
                <bdi>{segment}</bdi>
              </Fragment>
            ))
          : "Open the location on the map"}
      </a>
      {/* An observed address without its date is worse than none: "current" reads as today when the
          check-in may be from March. Its absence is also the only thing separating an observation
          from the CRM's own record now that the "Old" label is gone. */}
      {place?.validatedAt ? (
        <span className="ml-1.5 text-phx-3xs font-semibold text-slate-400">validated {cairoDay(place.validatedAt)}</span>
      ) : observed?.at ? (
        <span className="ml-1.5 text-phx-3xs font-semibold text-slate-400">seen {cairoDay(observed.at)}</span>
      ) : null}
      <NearbyLine row={row} />
    </div>
  );
}

/**
 * ONE COLOUR PER NEIGHBOURHOOD, and a different colour for the next one.
 *
 * The owner's instruction, 2026-09-01: "in the address column, I want you to colour each
 * neighbourhood address even if you're gonna use more than one colour. I mean, you are not stuck to
 * only one colour. Stick to one colour per neighbourhood, but every neighbourhood should have its
 * own colour." A single shared tint could only ever say "this row has neighbours somewhere"; it
 * cannot say WHICH block, so two adjacent clusters read as one. A colour per cluster is what makes
 * the blocks countable, and pairs with the reordering that put each block's rows together.
 *
 * TWO CUES, PITCHED TO STAY PASTEL — his other standing instruction was that the colours be light
 * and the page not become noisy, and around 45% of located rows are in some neighbourhood, so
 * anything heavy repaints half the board. The fill is the `100` step and the sentence naming the
 * neighbours takes the same hue at `800`. Because the clusters now sit on consecutive rows, a fill
 * covers the whole block in one colour and the grouping is DRAWN rather than merely tagged.
 *
 * On the main list the fill now covers the whole row rather than the address cell (owner,
 * 2026-10-31 — see neighbourhoodRowClass); the plan-day table below still tints its address cell,
 * because its rows are ordered by day and a group's members are not consecutive there.
 *
 * THE FILL HAS TO CARRY THE HUE ALONE ON DESKTOP, WHICH IS WHY IT IS `100` AND NOT `50`. The first
 * attempt put the colour in a 2px left edge and left the fill at `50`; measured in the browser, the
 * edge never appeared. `app/globals.css` gives every `.admin-shell th, td` a 1px orange hairline
 * with `!important` — an owner-level rule that draws the uniform grid on every table in the shell,
 * written in CSS precisely so component files never have to know about it. A border utility on a
 * cell cannot win against it, and SHOULD not: beating it would carve this one column out of the
 * house grid, which is the one-off look the owner forbids. So the border is gone from the table and
 * the fill moved one step up, where the five hues are actually told apart. On a phone the address
 * block is a plain div rather than a cell, the hairline rule does not reach it, and the edge is kept
 * there because it costs nothing. Do not "restore" the desktop border — it is unreachable.
 *
 * FIVE HUES, WIDELY SPACED, AND NONE OF THEM ALREADY MEANS SOMETHING HERE: violet is the shared
 * customer, emerald and amber are the confidence bands, amber is also "no brick yet" and orange is a
 * link. Reusing any of those would make a colour answer two questions at once. Clusters beyond the
 * fifth wrap around, which is safe because a repeat can only meet its twin with four other blocks in
 * between — adjacent blocks always differ.
 */
const NEIGHBOUR_TINTS = [
  { bar: "border-sky-400", fill: "bg-sky-100", ink: "text-sky-800" },
  { bar: "border-rose-400", fill: "bg-rose-100", ink: "text-rose-800" },
  { bar: "border-teal-400", fill: "bg-teal-100", ink: "text-teal-800" },
  { bar: "border-lime-400", fill: "bg-lime-100", ink: "text-lime-800" },
  { bar: "border-indigo-400", fill: "bg-indigo-100", ink: "text-indigo-800" },
] as const;

/**
 * The tint for this row's neighbourhood, or null when it stands alone.
 *
 * Keyed on `cluster` — the number the server assigned to the connected component — and never on
 * "does this row have a neighbour". The second question has no answer for "which block", so a page
 * asking it can only ever paint one colour.
 */
const tintFor = (row: RepsListContact): (typeof NEIGHBOUR_TINTS)[number] | null =>
  row.cluster == null ? null : NEIGHBOUR_TINTS[row.cluster % NEIGHBOUR_TINTS.length];

/**
 * The background of a whole contact row: its neighbourhood's colour first, violet second, white last.
 *
 * THE WHOLE ROW, NOT THE ADDRESS CELL — the owner, 2026-10-31, looking at the Phoenix CRM list:
 * "color all drs near to each other by a group color and if another group near each other then
 * another color". A fill on one cell out of six did not read as "these doctors are one group"; a fill
 * on the row does, and because `clusterRows` already puts each group on consecutive rows, every
 * block is now one solid run of a single colour.
 *
 * A SHARED ROW TAKES ITS GROUP'S COLOUR TOO. His word was "all" doctors near each other, and a
 * violet row in the middle of a blue run broke the block in two — exactly what made it unreadable.
 * The shared signal is not lost: `SharedLine` still prints "Also on another rep's list" under the
 * name in violet ink. Violet stays as the row colour only for a shared customer who stands alone.
 */
const neighbourhoodRowClass = (tint: (typeof NEIGHBOUR_TINTS)[number] | null, shared: boolean): string => {
  if (tint) return tint.fill;
  return shared ? "bg-violet-50 hover:bg-violet-100" : "bg-white hover:bg-slate-50";
};

/**
 * "Also at this address: Ahmed Samir, Mona Fouad" — the names, not just a count.
 *
 * The owner asked to highlight doctors in one brick who are very near each other. The USE of that is
 * a rep planning one stop instead of three, and for that the reader needs to know WHICH ones, so the
 * neighbours are named. Long lists are trimmed to three and the rest counted, because the point is
 * "there is a cluster here", not a roster.
 */
function NearbyLine({ row }: { row: RepsListContact }) {
  const nearby = row.nearby ?? null;
  if (!nearby || nearby.length === 0) return null;
  const shown = nearby.slice(0, 3);
  const rest = nearby.length - shown.length;
  const names = shown.map((entry) => entry.name).join(", ");
  // Same hue as this neighbourhood's fill and edge, so the words and the colour are visibly one
  // signal. Falls back to slate rather than to a colour, because a sentence tinted with a hue the
  // row does not carry would claim a block that is not there.
  const tint = tintFor(row);
  return (
    <span
      className={`mt-1 block break-words text-phx-3xs font-semibold ${tint?.ink ?? "text-slate-500"}`}
      dir="auto"
    >
      {`Same address (within ${NEIGHBOUR_M} m): ${names}${rest > 0 ? ` and ${rest} more` : ""}`}
    </span>
  );
}

/**
 * What happened to this contact in the month being scored.
 *
 * NOTHING IS RENDERED WHEN THE ACTIVITY IS ABSENT, and that is the important case. `undefined` is a
 * caller that never asked; `null` is a read that failed. Neither may print "No activity", because
 * that is a statement about the REP, and making it on the strength of a failed query would accuse
 * every doctor on the list at once. The board says the column is unavailable, once, above.
 */
function ActivityChip({ activity }: { activity: RepsListActivity | null | undefined }) {
  if (!activity) return null;
  const count = activityCountLabel(activity);
  return (
    <span
      className={`mt-0.5 inline-flex flex-wrap items-center gap-1 px-1.5 py-0.5 text-phx-3xs font-black uppercase tracking-[0.08em] ring-1 ring-inset ${ACTIVITY_CLASS[activity.status]}`}
      title={ACTIVITY_MEANING[activity.status]}
    >
      {ACTIVITY_LABEL[activity.status]}
      {/* The count is what makes the word actionable — "Behind plan" alone does not say by how
          much. Normal weight against the chip's black label so the two read as one phrase rather
          than as two competing signals. */}
      {count ? <span className="font-semibold opacity-80">{count}</span> : null}
    </span>
  );
}

/**
 * The combined "nobody has been here" choice — `untouched` plus `missed`.
 *
 * It is the reason this filter exists: a manager wants the call list, not a taxonomy lesson. The two
 * statuses stay separately selectable below because they are different problems (see
 * reps-list-activity.ts), but neither alone is the question anybody actually asks first.
 */
const UNVISITED_CHOICE = "unvisited";

/**
 * A row with NO activity never matches a filter, including the "all" case's siblings.
 *
 * Deliberate: filtering by a status the board could not read must return nothing rather than
 * everything. Returning everything would let a failed read present the whole list as, say, "Missed".
 */
function matchesActivity(row: RepsListContact, choice: string): boolean {
  if (!choice) return true;
  const status = row.activity?.status;
  if (!status) return false;
  if (choice === UNVISITED_CHOICE) return UNVISITED_STATUSES.has(status);
  return status === choice;
}

/** Name, then grade and phone beneath it — one cell, so neither needs a column of its own. */
function ContactCell({ onOpenInsights, row }: { onOpenInsights: () => void; row: RepsListContact }) {
  const phone = phoneOf(row);
  return (
    <div className="break-words">
      <span className="block font-semibold text-slate-900" dir="auto">
        {row.name}
      </span>
      {/* Directly UNDER the name rather than inline beside it. The Contact column is 21% of the
          table and an Arabic name fills most of that, so an inline pill would wrap to this exact
          position on nearly every flagged row anyway — and an LTR pill inside a `dir="auto"` span
          is a bidi hazard bought for nothing. It sits ABOVE the grade and phone because it is the
          only line on the row that says something may be wrong. */}
      <InsightsChip onOpen={onOpenInsights} row={row} />
      {/* MERGED INTO THIS CELL FOR THE REASON TradeLine IS, below: the table is `table-fixed` across
          six columns totalling 100%, and the owner's golden rule forbids a horizontal scroll on any
          screen, so a seventh column could only be bought by squeezing the other six. He has already
          settled that collision — fit by MERGING columns, never by shrinking type. It sits directly
          under the name, above grade and phone, because on this board it is the line a manager is
          scanning for. */}
      <ActivityChip activity={row.activity} />
      <span className="mt-0.5 block text-phx-2xs font-semibold">
        <span className={gradeClass(row.grade)}>{row.grade ?? "No grade"}</span>
        <span className="text-slate-400">{phone ? ` · ${phone}` : " · no phone"}</span>
      </span>
      <SharedLine row={row} />
      {/* MERGED INTO THIS CELL RATHER THAN GIVEN A COLUMN. The table is `table-fixed` across six
          columns totalling 100% and the owner's golden rule forbids a horizontal scroll on any
          screen, so a seventh column could only be bought by squeezing the other six — and he has
          already settled how to resolve exactly this collision: fit by MERGING columns, never by
          shrinking type. Grade and phone are here for the same reason. */}
      <TradeLine row={row} />
    </div>
  );
}

function GroupTable({
  group,
  onOpenConfidence,
  onOpenInsights,
  rowActions,
  rows,
  showConfidence,
  showList,
}: {
  group: RepsListGroup;
  onOpenConfidence: (row: RepsListContact) => void;
  onOpenInsights: (row: RepsListContact) => void;
  /**
   * Phoenix CRM only. The CRM's own row buttons — Validate, Add a visit, Open — rendered in the
   * column Confidence otherwise occupies. It is a swap, never an extra column: the golden rule is
   * that this table never scrolls sideways, and the colgroup below is measured to the pixel, so an
   * Actions column that ADDED width would be the exact bug those measurements exist to stop.
   */
  rowActions?: (row: RepsListContact) => ReactNode;
  rows: RepsListContact[];
  /** False in the CRM, where the owner asked for the confidence column to go (2026-09-24). */
  showConfidence: boolean;
  /** False on the Pharmacies tab, where every row's list is "Pharmacist" and the column says nothing. */
  showList: boolean;
}) {
  // The owner asked for the Locality column to become the BRICK (2026-09-01), and the HEADING SAYS
  // BRICK ON EVERY GROUP — a column that renames itself block by block is not a column. Every row in
  // a group shares one brick by construction, so the cell repeats the heading, which is the point:
  // it makes the brick filterable and exportable per row rather than only per block.
  //
  // An unmapped group has no brick to name, so its cell carries the locality in AMBER, the same tone
  // as the heading above it that already says the locality is not mapped to a brick yet.
  const brickCell = group.heading;

  return (
    <PortalResponsiveDataList
      empty={<p className="px-3 py-6 text-center text-xs text-slate-400">Nothing matches this filter.</p>}
      getKey={(row) => `${row.agentCrmId}:${row.contactCrmId}:${row.listType}`}
      items={rows}
      renderCard={(row) => (
        <PortalRecordCard
          accent={row.listType === "Pharmacy" ? "sky" : "slate"}
          // The whole card wears its neighbourhood's colour, the phone half of the row rule in
          // neighbourhoodRowClass, so a group reads as one run of cards in one colour.
          className={tintFor(row)?.fill}
          // Grade and phone sit directly under the name, exactly as they do in the desktop cell —
          // the owner's shape, 2026-09-01: "the phone and the grade under the contact name in the
          // same cell". The card is the mobile half of the same instruction, so it reads the same.
          meta={
            <>
              <span className={gradeClass(row.grade)}>{row.grade ?? "No grade"}</span>
              <span>{phoneOf(row) ? ` · ${phoneOf(row)}` : " · no phone"}</span>
            </>
          }
          status={
            <span className="text-phx-2xs font-black uppercase tracking-[0.1em] text-slate-400">
              {LIST_LABEL[row.listType]}
            </span>
          }
          title={row.name}
        >
          {/* The insight pill and the shared line ride directly under the title on a card too,
              because on a phone the violet edge is the only other signal and a colour with no
              words is a riddle. */}
          <InsightsChip onOpen={() => onOpenInsights(row)} row={row} />
          <SharedLine row={row} />
          {/* The mobile half of the same instruction — "always mobile friendly and desktop
              friendly". A trade record a rep can only see on a laptop is one they cannot check
              while standing in the pharmacy, which is the whole occasion for this board. */}
          <TradeLine row={row} />
          {/* On a card there is room for it on its own line — the phone gets the same signal as the
              laptop, which is the standing rule for this board (a rep switching between the two must
              not have to learn two languages). */}
          <div className="mt-1">
            <ActivityChip activity={row.activity} />
          </div>
          <PortalRecordFields
            fields={[
              { label: "Specialty", value: row.speciality ?? "Unspecified" },
              { label: "Brick", value: group.mapped ? brickCell : unmappedBrickLabel(brickCell) },
            ]}
          />
          <div className="mt-2 text-xs">
            <AddressCell locality={row.region} row={row} />
          </div>
          <div className="mt-2">
            {showConfidence ? (
              <ConfidenceChip onOpen={() => onOpenConfidence(row)} row={row} />
            ) : (
              rowActions?.(row)
            )}
          </div>
        </PortalRecordCard>
      )}
      renderTable={() => (
        // GOLDEN RULE, owner 2026-09-01: NEVER a horizontal scroll, on any screen. So this board
        // does NOT use PortalDesktopTable — that primitive hard-codes `overflow-x-auto` and a
        // 980px floor, which is exactly the scroll being forbidden. `table-fixed` plus a colgroup
        // makes the six columns share whatever width there is, and cells wrap instead of pushing.
        // Wrapping is not the ellipsis the owner's older rule forbids: nothing is hidden here.
        <div className="hidden md:block">
          <table className="w-full table-fixed border-collapse text-left text-sm">
            {/* Widths measured, not guessed: at a 938px viewport the table has ~845px to share, and
                "Pharmacist" plus its padding needs 104px of that — 13%. A 9% List column clipped it
                by 4px, which is the shape of bug this golden rule exists to stop.

                Confidence needs 16%, and the 11% it shipped with on 2026-09-01 was too little.
                Measured in the browser the day after: the header is the single unbreakable word
                "Confidence", which at this uppercase tracking needs 106px whatever the viewport,
                while 11% gave it 95px at 1280 and 74px at 768 — so it hung 11px and then 32px past
                its own column. Nothing was hidden (the cell is overflow-visible, so it bled into
                Address's padding rather than clipping) and the page never scrolled, but a header
                sitting outside its column is the same measurement failure this comment warns about,
                one breakpoint away from touching the next heading. A single word cannot wrap, so
                width is the only fix. The 5% comes from Address, the one column that can spare it:
                it is the widest, it wraps at spaces, and it holds no unbreakable token.

                On the Pharmacies tab the List column is dropped rather than left reading
                "Pharmacist" 40 times, and its 13% goes to Address — the column carrying the long
                bilingual strings and the neighbours sentence, and so the one that actually spends
                width. Nothing is hidden by the drop: the tab heading already says what the list is.

                Both tabs total 100%: 21+13+13+11+16+26 with List, 21+13+11+16+39 without.

                IN PHOENIX CRM THE CONFIDENCE COLUMN BECOMES ACTIONS, IN PLACE. The owner asked for
                the confidence column to go and for Validate · Add a visit · Open to be there instead
                (2026-09-24). Reusing its 16% rather than appending a seventh column is deliberate:
                every percentage here was measured in a browser, they total exactly 100, and adding a
                column would reopen the arithmetic on both tabs at once. "Actions" is also a shorter
                unbreakable word than "Confidence", so the header that forced 16% in the first place
                is the one being removed — the column cannot be tighter than it already is. */}
            <colgroup>
              <col className="w-[21%]" />
              <col className="w-[13%]" />
              {showList ? <col className="w-[13%]" /> : null}
              <col className="w-[11%]" />
              {/* IN PHOENIX CRM ADDRESS SITS RIGHT AFTER THE BRICK AND ACTIONS IS LAST (owner,
                  2026-09-25). It is the same two widths in the other order — 16% and 26%/39% just
                  swap seats — so both tabs still total exactly 100% and the golden rule holds; only
                  the board reorders, every other surface keeps Confidence then Address. */}
              {showConfidence ? (
                <>
                  <col className="w-[16%]" />
                  <col className={showList ? "w-[26%]" : "w-[39%]"} />
                </>
              ) : (
                <>
                  <col className={showList ? "w-[26%]" : "w-[39%]"} />
                  <col className="w-[16%]" />
                </>
              )}
            </colgroup>
            <thead>
              <tr className="bg-slate-900 text-left">
                <th className={THEAD}>Contact</th>
                <th className={THEAD}>Specialty</th>
                {showList ? <th className={THEAD}>List</th> : null}
                <th className={THEAD}>Brick</th>
                {showConfidence ? (
                  <>
                    <th className={THEAD}>Confidence</th>
                    <th className={THEAD}>Address</th>
                  </>
                ) : (
                  <>
                    <th className={THEAD}>Address</th>
                    <th className={THEAD}>Actions</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row) => {
                const shared = (row.sharedWith?.length ?? 0) > 0;
                const tint = tintFor(row);
                return (
                  <tr
                    className={`align-top ${neighbourhoodRowClass(tint, shared)}`}
                    key={`${row.agentCrmId}:${row.contactCrmId}:${row.listType}`}
                  >
                    <td className="px-3 py-2">
                      <ContactCell onOpenInsights={() => onOpenInsights(row)} row={row} />
                    </td>
                    <td className="break-words px-3 py-2 text-slate-600">{row.speciality ?? "Unspecified"}</td>
                    {showList ? (
                      <td className="break-words px-3 py-2 text-slate-400">{LIST_LABEL[row.listType]}</td>
                    ) : null}
                    <td
                      className={`break-words px-3 py-2 font-semibold ${group.mapped ? "text-slate-600" : "text-amber-700"}`}
                      dir="auto"
                    >
                      {brickCell}
                    </td>
                    {/* The neighbourhood colour is on the WHOLE ROW, set on the <tr> above — see
                        neighbourhoodRowClass for why it moved off the address cell.

                        In Phoenix CRM the address cell moves left, right after the brick, so the
                        neighbourhood wash reads directly beside the block it belongs to and the
                        clustered same-address rows read as one coloured run; the CRM's own buttons
                        take the last column. Every other surface keeps Confidence then Address. */}
                    {showConfidence ? (
                      <>
                        <td className="px-3 py-2">
                          <ConfidenceChip onOpen={() => onOpenConfidence(row)} row={row} />
                        </td>
                        <td className="px-3 py-2 text-slate-600">
                          <AddressCell locality={row.region} row={row} />
                        </td>
                      </>
                    ) : (
                      <>
                        <td className="px-3 py-2 text-slate-600">
                          <AddressCell locality={row.region} row={row} />
                        </td>
                        <td className="px-3 py-2">{rowActions?.(row)}</td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    />
  );
}

export function RepsListContacts({
  activityAvailable,
  activityMonthLabel,
  brickColor = false,
  collapsible = false,
  exportTitle = "Reps List",
  groups,
  repName,
  rowActions,
}: {
  /** False when the month's plan and visits could not be read. The chip, the filter and the export
   * columns all disappear together — a half-present column is worse than an absent one. */
  activityAvailable: boolean;
  /** "August 2026". Names the window in the filter label and in the export header, so a saved file
   * can never be read against the wrong month. */
  activityMonthLabel: string;
  /**
   * Phoenix CRM only. Gives each brick block, and the two tabs, their own hue — the owner asked for
   * "the tabs coloured the same bricks" (2026-09-24). OFF everywhere else, so My List, the manager
   * Reps List and the Weekly Plans tab are untouched by it.
   */
  brickColor?: boolean;
  /**
   * Phoenix CRM only — the rep's field surface. Each brick block opens and shuts on its heading
   * (owner, 2026-09-25); on a phone the filter row folds behind one "Filters" toggle, so the first
   * customer is not a screen of selects away; and the filter controls take the field sizes (44px on
   * a phone, 10px labels, a labelled search box). OFF everywhere else, so every other surface keeps
   * its headings, its filter row and its control sizes exactly as they were.
   */
  collapsible?: boolean;
  /** The download's sheet name and title — "My List" on a rep's own page, so the file says what it is. */
  exportTitle?: string;
  groups: RepsListGroup[];
  repName: string;
  /**
   * Phoenix CRM only. Renders the CRM's own buttons on a row — Validate, Add a visit, Open. PASSING
   * IT REMOVES THE CONFIDENCE COLUMN, which is the owner's instruction on the same day and not a
   * side effect worth hiding: the actions take that column's place rather than being added beside
   * it, so the table's measured widths never move. The confidence dialog and the three confidence
   * export columns go with it — a download that still scored every row would contradict the screen.
   */
  rowActions?: (row: RepsListContact) => ReactNode;
}) {
  const showConfidence = !rowActions;
  // Five filters, all client-side: brick, list, grade, specialty and free text. The owner asked for
  // them on 2026-09-01 — "filter by grade, or by specialty, or by AM or PM or pharmacist, or by
  // brick". They compose rather than replace each other, so "grade A neurologists in Smouha" is one
  // question, not three passes.
  const [brick, setBrick] = useState("");
  const [grade, setGrade] = useState("");
  const [listType, setListType] = useState("");
  const [speciality, setSpeciality] = useState("");
  // The sixth filter, added with the activity column. It survives a tab change, unlike List: a
  // pharmacy is visited or not visited exactly as a doctor is, so the choice stays meaningful on
  // both sides of the split and clearing it would be the surprise.
  const [activity, setActivity] = useState("");
  const [query, setQuery] = useState("");
  // Phoenix CRM, phones only: whether the filter row is unfolded. Shut by default — the toggle names
  // how many filters are on, so a narrowed list never passes for the whole one.
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filtersId = useId();
  // Which brick blocks the reader has shut. A SET of the collapsed keys, not the open ones, so the
  // default — nothing in the set — is every block open, which is what a list is for. Keyed on the
  // group's stable key, the same one the colour and the Brick filter use, so a block keeps its state
  // as a filter narrows the board. Only ever populated in the collapsible surface (Phoenix CRM).
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(() => new Set());
  const toggleGroup = useCallback((key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // ONE dialog for the whole board, opened with whichever row was clicked. A dialog per row would be
  // hundreds of mounted overlays; a dialog per group would put a hook count inside a map, which
  // React forbids for the same reason the search box is not per-brick.
  const [confidenceFor, setConfidenceFor] = useState<RepsListContact | null>(null);
  const openConfidence = useCallback((row: RepsListContact) => setConfidenceFor(row), []);
  const closeConfidence = useCallback(() => setConfidenceFor(null), []);
  const [insightsFor, setInsightsFor] = useState<RepsListContact | null>(null);
  const openInsights = useCallback((row: RepsListContact) => setInsightsFor(row), []);
  const closeInsights = useCallback(() => setInsightsFor(null), []);

  const [tab, setTab] = useState<TabKey>("contacts");
  // Switching tab clears the List choice, because "PM list only" cannot survive a move to the
  // pharmacy side — it would silently empty the tab and read as "this rep has no pharmacies". Done
  // in the handler rather than an effect: a `setState` inside `useEffect` is a lint error here.
  const chooseTab = useCallback((next: TabKey) => {
    setTab(next);
    setListType("");
  }, []);

  const allRows = useMemo(() => groups.flatMap((group) => group.rows), [groups]);
  // Built from ALL the groups, never from the visible ones: a brick must keep the same hue when a
  // filter narrows the board or the tab changes, or the colour stops naming the brick and starts
  // naming its position in whatever is on screen — which is worse than no colour at all.
  const tints = useMemo(() => (brickColor ? brickTintsFor(groups) : new Map<string, BrickTint>()), [brickColor, groups]);
  // THE TAB IS A PARTITION, NOT A FILTER, and everything below reads from `tabRows` because of it.
  // Picker options are still built from the whole of what the tab holds rather than from the
  // currently narrowed rows — options that vanish as you narrow make the controls feel broken — but
  // they must not offer a value from the other side of the split, which is a guaranteed dead end.
  const tabRows = useMemo(() => allRows.filter((row) => inTab(row, tab)), [allRows, tab]);
  const tabGroups = useMemo(() => groups.filter((group) => group.rows.some((row) => inTab(row, tab))), [groups, tab]);
  const gradeOptions = useMemo(() => distinct(tabRows, gradeOf), [tabRows]);
  const specialityOptions = useMemo(() => groupedSpecialities(tabRows), [tabRows]);
  const tabCounts = useMemo(
    () => ({
      contacts: allRows.filter((row) => inTab(row, "contacts")).length,
      pharmacies: allRows.filter((row) => inTab(row, "pharmacies")).length,
    }),
    [allRows],
  );

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return groups
      .filter((group) => !brick || groupKey(group) === brick)
      .map((group) => ({
        group,
        rows: group.rows.filter(
          (row) =>
            inTab(row, tab) &&
            (!listType || row.listType === listType) &&
            (!grade || gradeOf(row) === grade) &&
            (!speciality || specialityOf(row) === speciality) &&
            matchesActivity(row, activity) &&
            matches(row, needle),
        ),
      }))
      .filter((entry) => entry.rows.length > 0);
  }, [activity, brick, grade, groups, listType, query, speciality, tab]);

  // The export carries the brick and the area on every row, because the grouping IS the finding
  // here — a flat contact export would throw away the one thing this board adds. Unmapped rows
  // export with an explicit note rather than an empty cell, so a blank never reads as a data gap.
  const exportRows = visible.flatMap((entry) =>
    entry.rows.map((row) => ({
      // ONE address, the same one and in the same polished form the screen shows — an export must
      // match the screen (owner's standing rule). `Last seen` and the coordinate pair are not extra
      // data: they are what the link on screen carries, written out. The pair is what makes the
      // file usable away from the board — it pastes straight into a map, a street name does not.
      // The validated photo's point first, else the last check-in's — the screen's own precedence.
      address: polishAddressText((row.place ?? row.seenAt)?.address ?? row.address),
      area: entry.group.mapped ? (entry.group.areaName ?? "") : "",
      brick: entry.group.mapped ? entry.group.heading : unmappedBrickLabel(entry.group.heading, "(not yet mapped to a brick)"),
      // The three judgements go out with the rows. An export must match the screen, and these are
      // the columns a manager would actually sort on — "show me every doubtful pin" is the whole
      // point of scoring them. The score is a NUMBER so it sorts; the word beside it says what the
      // number means without needing the popup.
      // The activity columns go out with the rows and are EMPTY STRINGS when the read failed, never
      // a word — a spreadsheet cell reading "No activity" on a row nobody scored is the same false
      // accusation the screen refuses to print. The count columns are numbers so they sort.
      activity: row.activity ? ACTIVITY_LABEL[row.activity.status] : "",
      activity_meaning: row.activity ? ACTIVITY_MEANING[row.activity.status] : "",
      confidence: row.confidence ? row.confidence.score : "",
      confidence_verdict: row.confidence ? BAND_WORD[row.confidence.band] : "No visit yet",
      confidence_visits: row.confidence ? row.confidence.total : "",
      contact: row.name,
      contact_ar: row.nameAr ?? "",
      grade: row.grade ?? "",
      last_seen: row.seenAt?.at ? cairoDay(row.seenAt.at) : "",
      validated: row.place?.validatedAt ? cairoDay(row.place.validatedAt) : "",
      // The plan's own ask, TO DATE — the denominator the screen shows. Exporting the whole month's
      // ask instead would make every mid-month row look behind.
      last_visit: row.activity?.lastVisitDate ?? "",
      planned_to_date: row.activity ? row.activity.plannedCallsToDate : "",
      list: LIST_LABEL[row.listType],
      locality: row.region ?? "",
      map: row.place ? `${row.place.lat}, ${row.place.lon}` : row.seenAt ? `${row.seenAt.lat}, ${row.seenAt.lon}` : "",
      nearby: (row.nearby ?? []).map((entry_) => entry_.name).join(", "),
      phone: phoneOf(row) ?? "",
      shared_with: sharedWithCell((row.sharedWith ?? []).map((entry_) => entry_.repName)),
      speciality: row.speciality ?? "",
      visits: row.activity ? row.activity.visits : "",
    })),
  );

  const shownCount = exportRows.length;
  // Scoped to the TAB, so the line under the controls describes the list actually on screen. Reading
  // these off `allRows` while a tab is showing half of them is the same overstatement the tabs were
  // added to prevent, just moved into the summary.
  const totalCount = tabRows.length;
  // Contacts and pharmacies counted apart, via the one helper — see describeMix. `totalCount` is
  // rows and is deliberately never printed under the word "contacts".
  const held = describeMix(tabRows, tab === "pharmacies" ? "pharmacies" : "contacts");
  // Bricks and unmapped localities are counted apart in the summary line for the same reason the
  // headings are coloured apart: calling a locality a brick states that Phoenix knows where it is.
  //
  // Counted over the groups that hold something IN THIS TAB. A brick carrying only contacts is not
  // somewhere this rep has a pharmacy, so counting it on the Pharmacies tab overstates the spread
  // and — worse — the same list feeds the Brick picker, where it becomes a choice that empties the
  // table with no explanation.
  const brickCount = tabGroups.filter((group) => group.mapped).length;
  const localityCount = tabGroups.length - brickCount;
  const bricks = `${brickCount} ${brickCount === 1 ? "brick" : "bricks"}`;
  const localities = `${localityCount} ${localityCount === 1 ? "locality" : "localities"}`;
  const spread =
    localityCount === 0
      ? bricks
      : brickCount === 0
        ? `${localities} awaiting a brick`
        : `${bricks} and ${localities} awaiting one`;

  // The field surface's controls; every other surface keeps its own two classes.
  const labelClass = collapsible ? FIELD_LABEL_CLASS : LABEL_CLASS;
  const selectClass = collapsible ? FIELD_SELECT_CLASS : SELECT_CLASS;
  // What the folded toggle says, so a phone showing a narrowed list says so before it is opened.
  const filtersOn = [brick, listType, activity, grade, speciality, query.trim()].filter(Boolean).length;
  // `hidden` and `flex` are never written together: they set one property, and which of two display
  // utilities wins is the stylesheet's order, not the class list's.
  const filterRowClass =
    collapsible && !filtersOpen ? "hidden flex-wrap items-end gap-3 md:flex" : "flex flex-wrap items-end gap-3";

  return (
    <div className={collapsible ? "space-y-3 px-4 py-5 sm:px-5" : "space-y-3 p-5"}>
      {/* The two tabs, and the split the owner asked for "to avoid misleading". Each carries its own
          count so the separation is legible before either is opened — the pharmacy figure beside the
          contact figure is the whole point, not a subtitle. `flex-wrap` keeps them side by side on a
          phone at 375px rather than introducing the sideways scroll the golden rule bans. */}
      <div className="flex flex-wrap gap-2 border-b border-slate-200" role="tablist">
        {TABS.map((entry, index) => {
          const active = tab === entry.key;
          // "I need the tabs to be coloured the same bricks" (owner, 2026-09-24) — the tabs take
          // their hue from the SAME palette the brick blocks use, so the two halves of the screen
          // speak one colour language. It is the palette that is shared, not a particular brick's
          // colour: a tab holds many bricks, so borrowing one brick's hue would say something false
          // about the other forty. Off everywhere but Phoenix CRM, where orange stays the accent.
          const tabTint = brickColor ? BRICK_TINTS[index % BRICK_TINTS.length] : null;
          const activeTone = tabTint ? `${tabTint.tab} ${tabTint.fill} text-slate-900` : "border-orange-500 text-slate-900";
          return (
            <button
              aria-selected={active}
              className={`-mb-px border-b-2 px-3 py-2 text-left ${
                active ? activeTone : "border-transparent text-slate-400 hover:border-slate-300 hover:text-slate-600"
              }`}
              key={entry.key}
              onClick={() => chooseTab(entry.key)}
              role="tab"
              type="button"
            >
              <span className="block text-phx-2xs font-black uppercase tracking-[0.12em]">
                {`${entry.label} · ${tabCounts[entry.key]}`}
              </span>
              <span className="block text-phx-3xs font-semibold text-slate-400">{entry.sub}</span>
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-end justify-between gap-3">
        {/* Phoenix CRM on a phone: the filter row folds behind this one toggle, which says how many
            filters are on. From `md` up the row is always open and the toggle is gone. */}
        {collapsible ? (
          <button
            aria-controls={filtersId}
            aria-expanded={filtersOpen}
            className="flex min-h-11 min-w-0 flex-1 items-center justify-between gap-2 rounded-none border border-slate-200 bg-white px-3 text-left text-phx-2xs font-black uppercase tracking-[0.16em] text-slate-600 md:hidden"
            onClick={() => setFiltersOpen((open) => !open)}
            type="button"
          >
            <span className="min-w-0 break-words">{filtersOn > 0 ? `Filters · ${filtersOn} on` : "Filters"}</span>
            <GroupCaret open={filtersOpen} />
          </button>
        ) : null}
        <div className={filterRowClass} id={collapsible ? filtersId : undefined}>
          <label className="block w-full sm:w-56">
            <span className={labelClass}>Brick</span>
            <select className={`mt-1 ${selectClass}`} onChange={(event) => setBrick(event.target.value)} value={brick}>
              <option value="">All bricks</option>
              {tabGroups.map((group) => (
                <option key={groupKey(group)} value={groupKey(group)}>
                  {group.mapped ? group.heading : unmappedBrickLabel(group.heading)}
                </option>
              ))}
            </select>
          </label>
          {/* The List filter belongs to the Contacts tab alone. Its whole content is "PM list" and
              "AM list", and the Pharmacies tab holds neither by definition — leaving it on that tab
              would offer two choices that both empty the table, which is the misleading the tabs
              were added to remove. `chooseTab` clears the selection on the way across, so the
              control never disappears while still filtering. */}
          {tab === "contacts" ? (
            <label className="block w-full sm:w-48">
              <span className={labelClass}>List</span>
              <select
                className={`mt-1 ${selectClass}`}
                onChange={(event) => setListType(event.target.value)}
                value={listType}
              >
                {LIST_FILTERS.map((option) => (
                  <option key={option.value || "all"} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {/* Hidden entirely when the activity could not be read, rather than offered and inert.
              An empty result from a filter reads as "this rep has none of those", which is a claim
              about the rep; a missing control reads as what it is. */}
          {activityAvailable ? (
            <label className="block w-full sm:w-56">
              <span className={labelClass}>{`Activity · ${activityMonthLabel}`}</span>
              <select
                className={`mt-1 ${selectClass}`}
                onChange={(event) => setActivity(event.target.value)}
                value={activity}
              >
                <option value="">All activity</option>
                {/* The combined choice leads, because "who has nobody been to" is the question this
                    column was added to answer. The individual statuses follow it in
                    ACTIVITY_FILTER_ORDER — action first, then the rest. */}
                <option value={UNVISITED_CHOICE}>Not visited at all</option>
                {ACTIVITY_FILTER_ORDER.map((status) => (
                  <option key={status} value={status}>
                    {ACTIVITY_LABEL[status]}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="block w-full sm:w-40">
            <span className={labelClass}>Grade</span>
            <select className={`mt-1 ${selectClass}`} onChange={(event) => setGrade(event.target.value)} value={grade}>
              <option value="">All grades</option>
              {gradeOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
          <label className="block w-full sm:w-56">
            <span className={labelClass}>Specialty</span>
            <select
              className={`mt-1 ${selectClass}`}
              onChange={(event) => setSpeciality(event.target.value)}
              value={speciality}
            >
              <option value="">All specialties</option>
              {/* `<optgroup>` rather than a divider row: the browser renders the heading as a real
                  non-selectable group on every platform including a phone's native picker, so a
                  hospital can never be picked by mistake while reading down the specialties. */}
              {specialityOptions.map((group) => (
                <optgroup key={group.kind} label={SPECIALITY_GROUP_LABEL[group.kind]}>
                  {group.options.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          {/* On the field surface the search box is labelled like its neighbours, sized for a thumb
              and given a width of its own; everywhere else it is the compact box it always was. */}
          {collapsible ? (
            <label className="block w-full sm:w-64">
              <span className={labelClass}>Search</span>
              <TableSearchInput
                className="mt-1"
                onChange={setQuery}
                onClear={() => setQuery("")}
                placeholder="Contact, specialty or address"
                size="md"
                value={query}
              />
            </label>
          ) : (
            <TableSearchInput
              onChange={setQuery}
              onClear={() => setQuery("")}
              placeholder="Search contact, specialty or address…"
              value={query}
            />
          )}
        </div>
        <ExportXlsxButton
          columns={[
            { key: "brick", label: "Brick" },
            { key: "area", label: "Area" },
            { key: "contact", label: "Contact" },
            { key: "contact_ar", label: "Contact (Arabic)" },
            { key: "grade", label: "Grade" },
            { key: "speciality", label: "Specialty" },
            { key: "list", label: "List" },
            { key: "locality", label: "Locality" },
            { key: "phone", label: "Phone" },
            { key: "address", label: "Address" },
            { key: "last_seen", label: "Last seen" },
            { key: "validated", label: "Validated" },
            // Dropped from the file when the read failed, exactly as they are dropped from the
            // screen. An export must match the screen (owner's standing rule), and that includes
            // matching it when a column is not there.
            ...(activityAvailable
              ? [
                  { key: "activity", label: `Activity · ${activityMonthLabel}` },
                  { key: "activity_meaning", label: "What that means" },
                  { key: "visits", label: "Visits", numeric: true },
                  { key: "planned_to_date", label: "Planned to date", numeric: true },
                  { key: "last_visit", label: "Last visit" },
                ]
              : []),
            { key: "map", label: "Map (lat, lon)" },
            // Dropped in Phoenix CRM for the same reason the column is: the owner asked for the
            // confidence judgement to go, and a download that still carried it would contradict the
            // screen it was taken from.
            ...(showConfidence
              ? [
                  { key: "confidence", label: "Location confidence %" },
                  { key: "confidence_verdict", label: "Confidence verdict" },
                  { key: "confidence_visits", label: "Check-ins behind the score" },
                ]
              : []),
            { key: "shared_with", label: "Shared with" },
            { key: "nearby", label: "Same address as" },
          ]}
          rows={exportRows}
          sheetName={exportTitle}
          subtitle={
            activityAvailable
              ? `${repName} · grouped by brick, as held by the CRM · activity for ${activityMonthLabel}`
              : `${repName} · grouped by brick, as held by the CRM`
          }
          title={exportTitle}
        />
      </div>

      <p className="text-phx-2xs font-semibold text-slate-400">
        {totalCount === 0
          ? held
          : shownCount === totalCount
            ? `${held} across ${spread}`
            : `${shownCount} of ${totalCount} shown · ${visible.length} of ${tabGroups.length} groups`}
      </p>

      {/* AN EMPTY TAB AND AN EMPTY FILTER ARE DIFFERENT ANSWERS AND MUST NOT SHARE A SENTENCE.
          "Nothing matches this filter" tells a reader to go and clear a filter; on a rep who simply
          carries no pharmacies there is no filter to clear, and following that advice ends in the
          same empty table with no idea why. State which of the two it is. */}
      {visible.length === 0 ? (
        <p className="px-3 py-6 text-center text-xs text-slate-400">
          {totalCount === 0
            ? tab === "pharmacies"
              ? "This rep carries no pharmacies. The CRM gives some reps a pharmacy list and some none, so an empty tab here is an answer, not a fault."
              : "This rep carries no contacts in the CRM at all."
            : "Nothing matches this filter."}
        </p>
      ) : (
        // The rows below read whether they are on the field surface (the insights chip's size).
        <FieldSurface.Provider value={collapsible}>
          <div className="border border-slate-200">
            {visible.map((entry) => {
              const key = groupKey(entry.group);
              const isCollapsed = collapsible && collapsedGroups.has(key);
              return (
                <div key={key}>
                  <GroupHeading
                    collapsed={isCollapsed}
                    collapsible={collapsible}
                    group={entry.group}
                    onToggle={collapsible ? () => toggleGroup(key) : undefined}
                    shown={entry.rows.length}
                    tint={tints.get(key)}
                  />
                  {isCollapsed ? null : (
                    <GroupTable
                      group={entry.group}
                      onOpenConfidence={openConfidence}
                      onOpenInsights={openInsights}
                      rowActions={rowActions}
                      rows={entry.rows}
                      showConfidence={showConfidence}
                      showList={tab === "contacts"}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </FieldSurface.Provider>
      )}

      {showConfidence && confidenceFor ? <ConfidenceDialog onClose={closeConfidence} row={confidenceFor} /> : null}
      {insightsFor ? <InsightsDialog onClose={closeInsights} row={insightsFor} /> : null}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------
 * The same rows, on the Reps Weekly Plans tab.
 *
 * The owner, 2026-09-01: "you will show the address exactly as the contact list, exactly as the
 * contact list, as we are showing in the contact list. You will make the table exactly as in the
 * contact list."
 *
 * IT LIVES IN THIS FILE FOR THAT SENTENCE. Everything that decides how a contact row LOOKS is
 * already here — the six columns and their measured widths, ContactCell, AddressCell with its
 * per-segment <bdi>, the confidence chip, the insight chip, the neighbourhood tints, LIST_LABEL.
 * A second table written next door could match all of that on the day it was written and silently
 * stop matching on the next change to any one of them, which is precisely the drift the instruction
 * is about. Here, a change to a cell reaches both tabs or neither.
 *
 * WHAT DIFFERS, AND ONLY THIS: the blocks are DAYS rather than bricks, because a plan is read a day
 * at a time ("differentiate day by day, group day by day"); the shift rides inside the Contact cell
 * for the same reason grade and phone do; and a doctor who is not on the rep's list still gets a
 * row, saying so in the four columns his contact record would have filled.
 * ---------------------------------------------------------------------------------------------- */

/** The day's own heading — the brick heading's shape, so the two tabs read as one board. */
/**
 * WHAT THE REP ACTUALLY DID about one planned call.
 *
 * Renders NOTHING for `upcoming` and `unknown`, which is the whole discipline of this mark. A grey
 * "unknown" badge on a row nothing can be said about reads as a data fault and sends somebody
 * looking for one; a red mark on a day that has not happened yet is simply a lie. Silence is the
 * honest rendering of both, and it is also what this board showed before the mark existed.
 *
 * "Seen another day" is deliberately not a failure colour. Reps reshuffle a week's route constantly
 * and the work was still done — calling that a miss is the fastest way to make managers stop
 * believing the red ones.
 */
const VERDICT_CLASS: Record<PlanRowVerdict, string> = {
  missed: "border-rose-300 bg-rose-50 text-rose-700",
  moved: "border-amber-300 bg-amber-50 text-amber-700",
  unknown: "",
  upcoming: "",
  visited: "border-emerald-300 bg-emerald-50 text-emerald-700",
};

function VerdictChip({ verdict }: { verdict: PlanRowVerdict }) {
  const label = PLAN_VERDICT_LABEL[verdict];
  if (!label) return null;
  return (
    <span
      className={`mt-0.5 inline-block border px-1.5 py-0.5 text-phx-3xs font-black uppercase tracking-[0.1em] ${VERDICT_CLASS[verdict]}`}
      title={PLAN_VERDICT_MEANING[verdict] ?? undefined}
    >
      {label}
    </span>
  );
}

function PlanDayHeading({ day }: { day: PlanDoctorDay }) {
  const dated = day.date != null;
  const doctors = new Set(day.rows.map((row) => row.entry.contactCrmId ?? row.entry.contactName)).size;
  return (
    <div
      className={`flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-y px-5 py-2.5 ${
        dated ? "border-slate-200 bg-slate-50" : "border-amber-200 bg-amber-50"
      }`}
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-phx-xs font-black uppercase tracking-[0.14em] text-slate-900">{day.label}</h3>
        {dated ? null : (
          <span className="text-phx-2xs font-black uppercase tracking-[0.1em] text-amber-700">
            The CRM recorded no date on these rows
          </span>
        )}
      </div>
      {/* Calls and doctors are counted apart: a doctor planned AM and PM is one doctor and two
          calls, and a single number here would have to be wrong about one of them.

          HOW THE DAY WENT sits beside them, and only once the day has ended. `day.actual` is null
          when the visits could not be read at all — an unreachable mirror must not be able to
          summarise a week as unworked — and `upcoming` covers today and every day still ahead,
          where there is nothing yet to report.

          The CAMPAIGN count is printed whenever there is one, because a campaign call names no
          doctor and can therefore satisfy no planned row: without it, a rep who spent the whole day
          on a campaign reads as a rep who did nothing. */}
      <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-400">
        <span>
          {`${day.rows.length} ${day.rows.length === 1 ? "call" : "calls"} · ${doctors} ${
            doctors === 1 ? "doctor" : "doctors"
          }`}
        </span>
        {day.actual && !day.actual.upcoming ? (
          <span className={day.actual.missed > 0 ? "text-rose-600" : "text-emerald-700"}>
            {`${day.actual.visited + day.actual.moved} of ${day.actual.planned} kept`}
            {day.actual.moved > 0 ? ` · ${day.actual.moved} another day` : ""}
            {day.actual.missed > 0 ? ` · ${day.actual.missed} not seen` : ""}
          </span>
        ) : null}
        {day.actual && day.actual.campaignCalls > 0 ? (
          <span className="text-sky-700">
            {`${day.actual.campaignCalls} campaign ${day.actual.campaignCalls === 1 ? "call" : "calls"}`}
          </span>
        ) : null}
      </span>
    </div>
  );
}

/** AM / PM, where the contact list puts nothing. Absent on a plan row the CRM left without one. */
function ShiftLine({ ampm }: { ampm: string | null }) {
  if (!ampm?.trim()) return null;
  return (
    <span className="mt-0.5 block text-phx-3xs font-black uppercase tracking-[0.12em] text-slate-400">
      {ampm.trim()}
    </span>
  );
}

/**
 * A doctor the rep planned who is NOT on his current list — 18.4% of August's doctor-plan pairs.
 *
 * The plan carries his name, his grade and his speciality and nothing else, so the four columns the
 * contact record would fill say what is missing rather than sitting blank. It is amber, not rose:
 * planning off-list is a thing to ASK about, not a fault — the doctor may have moved list last week
 * — and it is one of the more useful things a verifying manager can be shown.
 */
function OffListContactCell({ row }: { row: PlanDoctorRow }) {
  return (
    <div className="break-words">
      <span className="block font-semibold text-slate-900" dir="auto">
        {row.entry.contactName}
      </span>
      <span className="mt-0.5 block text-phx-2xs font-semibold">
        <span className={gradeClass(row.entry.grade)}>{row.entry.grade ?? NO_GRADE}</span>
        <span className="text-slate-400"> · not on their list</span>
      </span>
      <ShiftLine ampm={row.ampm} />
    </div>
  );
}

/** One day's calls, in the contact list's own six columns. */
function PlanDayTable({
  day,
  onOpenConfidence,
  onOpenInsights,
}: {
  day: PlanDoctorDay;
  onOpenConfidence: (row: RepsListContact) => void;
  onOpenInsights: (row: RepsListContact) => void;
}) {
  const offListBrick = (row: PlanDoctorRow) => row.entry.region?.trim() || REPS_LIST_NO_LOCATION;
  const speciality = (row: PlanDoctorRow) =>
    row.contact?.contact.speciality?.trim() || row.entry.speciality?.trim() || UNSPECIFIED;

  return (
    <PortalResponsiveDataList
      empty={<p className="px-3 py-6 text-center text-xs text-slate-400">Nothing planned on this day.</p>}
      getKey={(row) => row.key}
      items={day.rows}
      renderCard={(row) => {
        const joined = row.contact;
        if (!joined) {
          return (
            <PortalRecordCard
              accent="slate"
              meta={
                <>
                  <span className={gradeClass(row.entry.grade)}>{row.entry.grade ?? NO_GRADE}</span>
                  {row.ampm?.trim() ? <span>{` · ${row.ampm.trim()}`}</span> : null}
                </>
              }
              status={
                <span className="flex flex-col items-end gap-1">
                  <span className="text-phx-2xs font-black uppercase tracking-[0.1em] text-amber-700">
                    Not on their list
                  </span>
                  <VerdictChip verdict={row.verdict} />
                </span>
              }
              title={row.entry.contactName}
            >
              <PortalRecordFields
                fields={[
                  { label: "Specialty", value: speciality(row) },
                  { label: "Brick", value: offListBrick(row) },
                ]}
              />
              <p className="mt-2 text-xs text-amber-700">
                This doctor is not on the rep&apos;s current contact list, so Phoenix holds no address, brick
                or check-in history for them.
              </p>
            </PortalRecordCard>
          );
        }
        const contact = joined.contact;
        const tint = tintFor(contact);
        return (
          <PortalRecordCard
            accent={contact.listType === "Pharmacy" ? "sky" : "slate"}
            meta={
              <>
                <span className={gradeClass(contact.grade)}>{contact.grade ?? NO_GRADE}</span>
                <span>{phoneOf(contact) ? ` · ${phoneOf(contact)}` : " · no phone"}</span>
                {row.ampm?.trim() ? <span>{` · ${row.ampm.trim()}`}</span> : null}
              </>
            }
            status={
              <span className="flex flex-col items-end gap-1">
                <span className="text-phx-2xs font-black uppercase tracking-[0.1em] text-slate-400">
                  {LIST_LABEL[contact.listType]}
                </span>
                <VerdictChip verdict={row.verdict} />
              </span>
            }
            title={contact.name}
          >
            <InsightsChip onOpen={() => onOpenInsights(contact)} row={contact} />
            <SharedLine row={contact} />
            <TradeLine row={contact} />
            <PortalRecordFields
              fields={[
                { label: "Specialty", value: speciality(row) },
                {
                  label: "Brick",
                  value: joined.brick.mapped ? joined.brick.heading : unmappedBrickLabel(joined.brick.heading),
                },
              ]}
            />
            <div className={`mt-2 text-xs ${tint ? `${tint.fill} ${tint.bar} border-l-2 p-2` : ""}`}>
              <AddressCell locality={contact.region} row={contact} />
            </div>
            <div className="mt-2">
              <ConfidenceChip onOpen={() => onOpenConfidence(contact)} row={contact} />
            </div>
          </PortalRecordCard>
        );
      }}
      renderTable={() => (
        // The contact list's table, verbatim: no PortalDesktopTable, no min-width floor, a colgroup
        // summing to exactly 100%. The widths are the measured ones from GroupTable above — see the
        // long comment there for why Confidence is 16% and List is 13%.
        <div className="hidden md:block">
          <table className="w-full table-fixed border-collapse text-left text-sm">
            <colgroup>
              <col className="w-[21%]" />
              <col className="w-[13%]" />
              <col className="w-[13%]" />
              <col className="w-[11%]" />
              <col className="w-[16%]" />
              <col className="w-[26%]" />
            </colgroup>
            <thead>
              <tr className="bg-slate-900 text-left">
                <th className={THEAD}>Contact</th>
                <th className={THEAD}>Specialty</th>
                <th className={THEAD}>List</th>
                <th className={THEAD}>Brick</th>
                <th className={THEAD}>Confidence</th>
                <th className={THEAD}>Address</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {day.rows.map((row) => {
                const contact = row.contact?.contact ?? null;
                const shared = (contact?.sharedWith?.length ?? 0) > 0;
                const tint = contact ? tintFor(contact) : null;
                return (
                  <tr
                    className={`align-top ${shared ? "bg-violet-50 hover:bg-violet-100" : "bg-white hover:bg-slate-50"}`}
                    key={row.key}
                  >
                    <td className="px-3 py-2">
                      {contact ? (
                        <>
                          <ContactCell onOpenInsights={() => onOpenInsights(contact)} row={contact} />
                          <ShiftLine ampm={row.ampm} />
                        </>
                      ) : (
                        <OffListContactCell row={row} />
                      )}
                      <VerdictChip verdict={row.verdict} />
                    </td>
                    <td className="break-words px-3 py-2 text-slate-600">{speciality(row)}</td>
                    <td
                      className={`break-words px-3 py-2 ${contact ? "text-slate-400" : "font-semibold text-amber-700"}`}
                    >
                      {contact ? LIST_LABEL[contact.listType] : "Not on their list"}
                    </td>
                    <td
                      className={`break-words px-3 py-2 font-semibold ${
                        row.contact?.brick.mapped ? "text-slate-600" : "text-amber-700"
                      }`}
                      dir="auto"
                    >
                      {row.contact ? row.contact.brick.heading : offListBrick(row)}
                    </td>
                    <td className="px-3 py-2">
                      {contact ? (
                        <ConfidenceChip onOpen={() => onOpenConfidence(contact)} row={contact} />
                      ) : (
                        <span className="text-phx-2xs font-semibold text-slate-400">No contact record</span>
                      )}
                    </td>
                    <td className={`px-3 py-2 text-slate-600 ${tint && !shared ? tint.fill : ""}`}>
                      {contact ? (
                        <AddressCell locality={contact.region} row={contact} />
                      ) : (
                        <span className="font-semibold text-amber-700">
                          Not on their list, so no address is recorded
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    />
  );
}

/**
 * The plan's doctors, one block per day, in the contact list's own table.
 *
 * ONE dialog pair for the whole plan, opened with whichever row was clicked — the same reason
 * RepsListContacts has one: a dialog per row is hundreds of mounted overlays, and a dialog per day
 * would put a hook count inside a map, which React forbids outright.
 */
export function PlanDoctorsTable({ days }: { days: PlanDoctorDay[] }) {
  const [confidenceFor, setConfidenceFor] = useState<RepsListContact | null>(null);
  const [insightsFor, setInsightsFor] = useState<RepsListContact | null>(null);
  const closeConfidence = useCallback(() => setConfidenceFor(null), []);
  const closeInsights = useCallback(() => setInsightsFor(null), []);
  const openConfidence = useCallback((row: RepsListContact) => setConfidenceFor(row), []);
  const openInsights = useCallback((row: RepsListContact) => setInsightsFor(row), []);

  return (
    <div>
      <div className="border border-slate-200">
        {days.map((day) => (
          <div key={day.date ?? "undated"}>
            <PlanDayHeading day={day} />
            <PlanDayTable day={day} onOpenConfidence={openConfidence} onOpenInsights={openInsights} />
          </div>
        ))}
      </div>
      {confidenceFor ? <ConfidenceDialog onClose={closeConfidence} row={confidenceFor} /> : null}
      {insightsFor ? <InsightsDialog onClose={closeInsights} row={insightsFor} /> : null}
    </div>
  );
}
