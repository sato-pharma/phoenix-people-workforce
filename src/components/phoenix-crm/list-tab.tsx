"use client";

/**
 * Phoenix CRM — the List tab: a territory's customer list.
 *
 * Owner, 2026-09-16, amended 2026-09-22:
 *   - the rep keeps his whole iReports360 list from day one. Every customer on it is a real customer,
 *     PENDING until he validates it at the clinic with a live photo, the location and at least one
 *     timing — once per customer, forever;
 *   - a pending customer is planned and visited exactly like any other. Nothing about the list ever
 *     stops the rep. He simply counts in no metric until he is validated, and the visits already saved
 *     against him start counting the moment he is;
 *   - the list stays with the territory; AM and PM, no pharmacies;
 *   - a timetable shows who receives on each day, the way the rep's own sheet did.
 *
 * Owner, 2026-09-29 — the rep's flow rebuilt (src/lib/phoenix-crm/list-request-rules.ts):
 *   - there is NO "Add visit" anywhere on the List. A visit starts from Visits, Today or the portal's "+";
 *   - every customer row carries ONE button: Validate while the customer is not validated, Open once he
 *     is (`listRowAction`);
 *   - the list reads in sections — The list (the board) · To validate · Your list · Outside the list ·
 *     Requests · Archive · Timetable — each customer in the section the server put him in
 *     (`ListCustomer.section`, from `listSectionOf`).
 *
 * Owner, 2026-09-30 — "the best-appearing and easiest CRM, yet controlled":
 *   - the figure the rep acts on, what is still to validate, leads the block above the list; the rest
 *     is context a size down, and AM and PM are always said apart;
 *   - "Validate next" puts the three customers most worth his next stop above the list, ranked by the
 *     pure `rankValidateNext` (src/lib/phoenix-crm/validate-next.ts), each with its one Validate button.
 */

import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { Plus, Search } from "lucide-react";

import { RepsListTiles } from "@/components/crm/reps-list-board";
import { RepsListContacts } from "@/components/crm/reps-list-tables";
import { useCrmGet } from "@/components/phoenix-crm/api";
import { CustomerListBoard, CustomerRowAction, type CustomerListVariant } from "@/components/phoenix-crm/customer-list-board";
import { cairoStamp, countText, dayLabel, dayLabelWithYear, plural } from "@/components/phoenix-crm/format";
import { listText, placeName, territoryLine } from "@/components/phoenix-crm/labels";
import { CustomerScreen } from "@/components/phoenix-crm/list-customer";
import {
  AddPlaceScreen,
  AddRequestScreen,
  DropScreen,
  EditDetailsScreen,
  EditPlaceScreen,
  GradeScreen,
  listBoardUrl,
  listUrl,
  RestoreRequestScreen,
  SavedScreen,
  ValidateScreen,
  type ListNotice,
  type ListScreen,
  type ListScreenBase,
  type SavedPlace,
} from "@/components/phoenix-crm/list-screens";
import { releaseCapturedPhoto, type CapturedPhoto } from "@/components/phoenix-crm/live-photo-capture";
import { PlaceMoveScreen } from "@/components/phoenix-crm/place-move-screen";
import type { PlaceDraftState } from "@/components/phoenix-crm/place-editor";
import { RequestCard, sortRequests } from "@/components/phoenix-crm/request-card";
import {
  CrmBlock,
  CrmButton,
  CrmChoice,
  CrmEmpty,
  CrmField,
  CrmLoadError,
  CrmLoading,
  CrmNote,
  CrmPanel,
  CrmPill,
  crmInputClassName,
} from "@/components/phoenix-crm/ui";
import type { RepsListContact } from "@/lib/crm/reps-list";
import type { RepsListBoard } from "@/lib/crm/reps-list-board";
import { weekdayOfIsoDay } from "@/lib/phoenix-crm/calendar";
import type { ListRowAction } from "@/lib/phoenix-crm/list-request-rules";
import {
  formatTimingWindow,
  PHOENIX_CRM_WEEKDAY_NAMES,
  PHOENIX_CRM_WEEKDAY_ORDER,
  PHOENIX_CRM_WEEKDAY_SHORT,
  windowsForWeekday,
} from "@/lib/phoenix-crm/timings";
import type { PhoenixCrmListType, PhoenixCrmSeason, PhoenixCrmTiming } from "@/lib/phoenix-crm/types";
import { isValidateNextCandidate, validateNextTop } from "@/lib/phoenix-crm/validate-next";
import type { ListCustomer, ListPlace, TerritoryListView } from "@/lib/phoenix-crm/view-types";
import { cn } from "@/lib/utils";

/** The parts of the list home, in the order the owner named them (2026-09-29). */
type HomeSection = "board" | "to_validate" | "your_list" | "outside" | "requests" | "archive" | "timetable";
type TypeFilter = "all" | PhoenixCrmListType;

/**
 * A visit just saved on a customer who is not validated yet, handed back to this tab's Validate screen
 * (the page passes it on). It carries no photo by design: validating takes its own signboard photo.
 */
type ValidateHandoff = { seatId: string; test: boolean; contactCrmId: number };

/** AM first, then PM, the way the rep's day starts. */
const LIST_TYPES: readonly PhoenixCrmListType[] = ["AM", "PM"];

function matchesQuery(query: string, parts: ReadonlyArray<string | null>): boolean {
  if (!query) return true;
  return parts.some((part) => part !== null && part.toLowerCase().includes(query));
}

function countByType<T extends { listType: PhoenixCrmListType }>(rows: ReadonlyArray<T>): Record<PhoenixCrmListType, number> {
  return {
    AM: rows.filter((row) => row.listType === "AM").length,
    PM: rows.filter((row) => row.listType === "PM").length,
  };
}

/** "3 AM · 41 PM" — AM and PM side by side, never added together. */
function pairText(counts: Record<PhoenixCrmListType, number>): string {
  return `${countText(counts.AM)} AM · ${countText(counts.PM)} PM`;
}

export function ListTab({
  cairoToday,
  onPendingValidateDone,
  onWorkChange,
  pendingValidate,
  seatId,
  test,
}: {
  cairoToday: string;
  /** The Validate hand-off was opened, saved, or left behind: the page may let it go. */
  onPendingValidateDone?: () => void;
  /**
   * Accepted and ignored since 2026-09-29, so the page that renders this tab still compiles: the List
   * starts no visit (owner — a visit starts from Visits, Today or the portal's "+").
   */
  onStartVisit?: unknown;
  /** A customer entry opened or closed: the page keeps this tab as it is while another tab is open. */
  onWorkChange?: (working: boolean) => void;
  /** A visit was just saved on a pending customer and he chose to validate him now. */
  pendingValidate?: ValidateHandoff | null;
  seatId: string;
  test: boolean;
}) {
  const resource = useCrmGet<TerritoryListView>(listUrl(seatId, test), "list");
  const [screen, setScreen] = useState<ListScreen>({ name: "home" });
  const [notice, setNotice] = useState<ListNotice | null>(null);
  const [section, setSection] = useState<HomeSection | null>(null);
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [weekday, setWeekday] = useState<number | null>(null);
  const [season, setSeason] = useState<PhoenixCrmSeason | null>(null);
  const topRef = useRef<HTMLDivElement>(null);

  // A hand-off belongs to one territory in one mode, exactly as the visit form's does.
  const validateHandoff = pendingValidate && pendingValidate.seatId === seatId && pendingValidate.test === test ? pendingValidate : null;
  // He saved a visit on a pending customer and pressed Validate now: that outranks whatever screen this
  // tab was left on, because the hand-off is the only reason the tab was opened. Every screen below is
  // dispatched from `current`, never from `screen` — including the held-work guard, which would
  // otherwise let the page swap the tab away from a validation he is standing at the door to finish.
  const current: ListScreen = validateHandoff ? { name: "validate", contactCrmId: validateHandoff.contactCrmId } : screen;

  // The list, a customer and the saved screen hold nothing unsaved; every other screen is an entry under way.
  const working = current.name !== "home" && current.name !== "customer" && current.name !== "saved";
  const savedPhoto = current.name === "saved" ? current.photo : null;

  useEffect(() => {
    onWorkChange?.(working);
  }, [onWorkChange, working]);

  // Leaving the saved screen, or the tab closing on it, lets its photo go: the List hands it to nothing.
  useEffect(() => {
    if (!savedPhoto) return;
    return () => releaseCapturedPhoto(savedPhoto);
  }, [savedPhoto]);

  function scrollToTop() {
    const top = topRef.current;
    if (top && top.getBoundingClientRect().top < 0) top.scrollIntoView({ block: "start" });
  }

  /** Opens a screen. Deliberately moving anywhere is also the end of a Validate hand-off. */
  function go(next: ListScreen, nextNotice: ListNotice | null = null) {
    if (validateHandoff) onPendingValidateDone?.();
    setScreen(next);
    setNotice(nextNotice);
    scrollToTop();
  }

  const home = () => go({ name: "home" });
  const openCustomer = (customerId: string, nextNotice: ListNotice | null = null) => go({ name: "customer", customerId }, nextNotice);

  function placeSaved(saved: SavedPlace, photo: CapturedPhoto) {
    resource.reload();
    go({ name: "saved", saved, photo });
  }

  function customerChanged(customerId: string, next: ListNotice) {
    resource.reload();
    openCustomer(customerId, next);
  }

  function listChanged(next: ListNotice) {
    resource.reload();
    go({ name: "home" }, next);
  }

  function showNotice(next: ListNotice) {
    setNotice(next);
    resource.reload();
    scrollToTop();
  }

  function addPlaceInstead(customerId: string, draft: PlaceDraftState) {
    go({ name: "add-place", customerId, draft });
  }

  /** The one button on a customer's row: Validate, or Open. */
  function rowAction(customer: ListCustomer, action: ListRowAction) {
    if (action === "validate" && customer.referenceContactCrmId !== null) {
      go({ name: "validate", contactCrmId: customer.referenceContactCrmId });
      return;
    }
    openCustomer(customer.customerId);
  }

  const view = resource.data;
  let body: ReactNode;

  if (!view) {
    body = (
      <CrmPanel eyebrow="List" title="Customer list">
        {resource.error ? <CrmLoadError message={resource.error} onRetry={resource.reload} /> : <CrmLoading label="Loading the customer list" />}
      </CrmPanel>
    );
  } else {
    const base: ListScreenBase = {
      cairoToday,
      refreshing: resource.loading,
      seatId,
      test,
      view,
      onView: resource.replace,
      reload: resource.reload,
    };

    switch (current.name) {
      case "customer":
        body = (
          <CustomerScreen
            {...base}
            customerId={current.customerId}
            notice={notice}
            onBack={home}
            onLeave={listChanged}
            onNotice={showNotice}
            onOpen={(next) => go(next)}
          />
        );
        break;
      case "validate": {
        const { contactCrmId } = current;
        body = (
          <ValidateScreen
            {...base}
            key={`validate-${contactCrmId}`}
            onAddPlaceInstead={addPlaceInstead}
            onAskToDrop={(customerId) => go({ name: "drop", customerId, contactCrmId: null })}
            onBack={home}
            onSaved={placeSaved}
            subject={{ mode: "reference", contactCrmId }}
          />
        );
        break;
      }
      case "new":
        body = <ValidateScreen {...base} key="new" onAddPlaceInstead={addPlaceInstead} onBack={home} onSaved={placeSaved} subject={{ mode: "new" }} />;
        break;
      case "restore": {
        const { customerId, from } = current;
        body = (
          <RestoreRequestScreen
            {...base}
            customerId={customerId}
            key={`restore-${customerId}`}
            onBack={from === "customer" ? () => openCustomer(customerId) : home}
            onDone={(next) => customerChanged(customerId, next)}
          />
        );
        break;
      }
      case "add-request": {
        const { customerId } = current;
        body = (
          <AddRequestScreen
            {...base}
            customerId={customerId}
            key={`add-request-${customerId}`}
            onBack={() => openCustomer(customerId)}
            onDone={(next) => customerChanged(customerId, next)}
          />
        );
        break;
      }
      case "add-place": {
        const { customerId } = current;
        body = (
          <AddPlaceScreen
            {...base}
            customerId={customerId}
            initialDraft={current.draft}
            key={`add-place-${customerId}`}
            onBack={() => {
              // The draft may hold a photo taken on Add new customer; this screen let it go already.
              openCustomer(customerId);
            }}
            onSaved={placeSaved}
          />
        );
        break;
      }
      case "edit-place": {
        const { customerId, placeId } = current;
        body = (
          <EditPlaceScreen
            {...base}
            customerId={customerId}
            key={`edit-place-${placeId}`}
            onBack={() => openCustomer(customerId)}
            onDone={(next) => customerChanged(customerId, next)}
            placeId={placeId}
          />
        );
        break;
      }
      case "move-place": {
        // The Super Admin's and the SFE Manager's alone: the customer's page offers it only where
        // `view.canMovePlaces`, and the screen refuses to draw for anyone else.
        const { customerId, placeId } = current;
        body = (
          <PlaceMoveScreen
            {...base}
            customerId={customerId}
            key={`move-place-${placeId}`}
            onBack={() => openCustomer(customerId)}
            onDone={(next) => customerChanged(customerId, next)}
            placeId={placeId}
          />
        );
        break;
      }
      case "grade": {
        const { customerId } = current;
        body = (
          <GradeScreen
            {...base}
            customerId={customerId}
            key={`grade-${customerId}`}
            onBack={() => openCustomer(customerId)}
            onDone={(next) => customerChanged(customerId, next)}
          />
        );
        break;
      }
      case "edit-details": {
        const { customerId } = current;
        body = (
          <EditDetailsScreen
            {...base}
            customerId={customerId}
            key={`edit-details-${customerId}`}
            onBack={() => openCustomer(customerId)}
            onDone={(next) => customerChanged(customerId, next)}
          />
        );
        break;
      }
      case "drop": {
        const { contactCrmId, customerId } = current;
        body = (
          <DropScreen
            {...base}
            contactCrmId={contactCrmId}
            customerId={customerId}
            key={`drop-${customerId ?? contactCrmId}`}
            onBack={customerId ? () => openCustomer(customerId) : home}
            onDone={customerId ? (next) => customerChanged(customerId, next) : listChanged}
          />
        );
        break;
      }
      case "saved": {
        const { photo, saved } = current;
        body = <SavedScreen onBack={home} onOpenCustomer={() => openCustomer(saved.customerId)} photo={photo} saved={saved} view={view} />;
        break;
      }
      default:
        body = (
          <ListHome
            cairoToday={cairoToday}
            error={resource.error}
            notice={notice}
            onOpen={(next) => go(next)}
            onRequestChanged={(message) => showNotice({ tone: "info", title: message })}
            onRetry={resource.reload}
            onRowAction={rowAction}
            query={query}
            season={season}
            section={section}
            seatId={seatId}
            setQuery={setQuery}
            setSeason={setSeason}
            setSection={setSection}
            setTypeFilter={setTypeFilter}
            setWeekday={setWeekday}
            test={test}
            typeFilter={typeFilter}
            view={view}
            weekday={weekday}
          />
        );
    }
  }

  return (
    <div className="min-w-0 scroll-mt-24" ref={topRef}>
      {body}
    </div>
  );
}

// ── The list's home ─────────────────────────────────────────────────────────────────────────────

function ListHome({
  cairoToday,
  error,
  notice,
  onOpen,
  onRequestChanged,
  onRetry,
  onRowAction,
  query,
  season,
  section,
  seatId,
  setQuery,
  setSeason,
  setSection,
  setTypeFilter,
  setWeekday,
  test,
  typeFilter,
  view,
  weekday,
}: {
  cairoToday: string;
  /** A reload failed while the last list stayed on screen. */
  error: string | null;
  notice: ListNotice | null;
  onOpen: (screen: ListScreen) => void;
  onRequestChanged: (message: string) => void;
  onRetry: () => void;
  /** A customer row's one button: Validate, or Open. */
  onRowAction: (customer: ListCustomer, action: ListRowAction) => void;
  query: string;
  season: PhoenixCrmSeason | null;
  section: HomeSection | null;
  seatId: string;
  setQuery: (next: string) => void;
  setSeason: (next: PhoenixCrmSeason) => void;
  setSection: (next: HomeSection) => void;
  setTypeFilter: (next: TypeFilter) => void;
  setWeekday: (next: number) => void;
  test: boolean;
  typeFilter: TypeFilter;
  view: TerritoryListView;
  weekday: number | null;
}) {
  // Each customer sits in the section the server put him in — `listSectionOf`, the one place that
  // decision is made. A carried-over customer is pending until the rep validates him at the clinic:
  // planned and visited like anyone else, counting in nothing yet.
  const pending = view.customers.filter((customer) => customer.section === "to_validate");
  const active = view.customers.filter((customer) => customer.section === "your_list");
  const outside = view.customers.filter((customer) => customer.section === "outside");
  const archived = view.customers.filter((customer) => customer.section === "archive");
  const waiting = view.requests.filter((request) => request.status === "pending");
  const decidable = waiting.filter((request) => request.canDecide);
  const hasReference = view.reference.length > 0 || pending.length > 0;

  // The board is where the list opens (owner, 2026-09-24: "I don't need the My List separated, I need
  // it in Phoenix CRM"), unless something is actually waiting on the viewer — a validation to finish or
  // a request to decide outranks a reading view, as it did before the board arrived.
  const defaultSection: HomeSection = view.canEdit && pending.length > 0 ? "to_validate" : decidable.length > 0 ? "requests" : "board";
  const current: HomeSection = section === "to_validate" && !hasReference ? "board" : (section ?? defaultSection);

  const needle = query.trim().toLowerCase();
  const typeMatches = (listType: PhoenixCrmListType) => typeFilter === "all" || typeFilter === listType;

  const sectionOptions = [
    { value: "board" as const, label: "The list", note: "By brick · AM · PM · pharmacies" },
    ...(hasReference
      ? [{ value: "to_validate" as const, label: "To validate", note: pending.length > 0 ? `${countText(pending.length)} to go` : "All done" }]
      : []),
    { value: "your_list" as const, label: "Your list", note: pairText(countByType(active)) },
    { value: "outside" as const, label: "Outside the list", note: outside.length > 0 ? `${countText(outside.length)} waiting` : "None waiting" },
    {
      value: "requests" as const,
      label: "Requests",
      note: decidable.length > 0 ? `${countText(decidable.length)} for you to decide` : waiting.length > 0 ? `${countText(waiting.length)} waiting` : "None waiting",
    },
    { value: "archive" as const, label: "Archive", note: countText(archived.length) },
    { value: "timetable" as const, label: "Timetable", note: "Who receives when" },
  ];

  return (
    <CrmPanel
      actions={
        view.canEdit ? (
          <CrmButton onClick={() => onOpen({ name: "new" })} variant="primary">
            <Plus aria-hidden className="h-4 w-4" />
            Add new customer
          </CrmButton>
        ) : null
      }
      description={territoryLine(view.territory)}
      eyebrow="List"
      title="Customer list"
    >
      {notice ? (
        <div className="px-4 pt-4 sm:px-5">
          <CrmNote title={notice.title} tone={notice.tone}>
            {notice.message}
          </CrmNote>
        </div>
      ) : null}
      {error ? <CrmLoadError message={error} onRetry={onRetry} /> : null}

      {/* Where he chooses what to do next — To validate, and The list he opens on — the three worth his
          next stop sit above the chooser, which would otherwise push them below a phone's first
          screen. The rep's alone: he is the one who validates. */}
      {current === "to_validate" || current === "board" ? (
        <ValidateNextStrip canValidate={view.canEdit} customers={view.customers} onRowAction={onRowAction} />
      ) : null}

      <CrmBlock className="border-t border-slate-100" title="Which part of the list">
        <CrmChoice columns={7} label="Which part of the list" onChange={setSection} options={sectionOptions} value={current} />
      </CrmBlock>

      {/* Only the Timetable reads this pair. The board and the customer parts (To validate, Your list,
          Outside the list, Archive) each carry their own filter row — brick, list, grade, specialty,
          activity and a search box — so this shared pair would be a second search box asking which one
          is live. The Timetable is a weekly grid, not a customer list, so it keeps the simple pair. */}
      {current === "timetable" ? (
        <CrmBlock className="border-t border-slate-100">
          <div className="grid min-w-0 gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] md:items-end">
            <CrmField htmlFor="phoenix-crm-list-search" label="Find a customer">
              <div className="relative min-w-0">
                <Search aria-hidden className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-slate-400" />
                <input
                  autoComplete="off"
                  className={cn(crmInputClassName, "appearance-none pl-9")}
                  id="phoenix-crm-list-search"
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Name, speciality, address or zone"
                  type="search"
                  value={query}
                />
              </div>
            </CrmField>
            <CrmField label="Show">
              <CrmChoice
                columns={3}
                label="Show"
                onChange={setTypeFilter}
                options={[
                  { value: "all", label: "All" },
                  { value: "PM", label: "PM" },
                  { value: "AM", label: "AM" },
                ]}
                value={typeFilter}
              />
            </CrmField>
          </div>
        </CrmBlock>
      ) : null}

      {current === "board" ? <BoardSection onRowAction={onRowAction} seatId={seatId} test={test} view={view} /> : null}

      {/* 🔴 THE FIGURES SIT UNDER THE CHOOSER, NOT OVER IT (owner, 2026-09-30: "I don't recommend to
          put it above them"). They used to open the screen, above the chooser — but three of the four
          say what three of the chooser's own parts already say, in his own words: "the list is the
          full list, To validate is who are not validated, Your list is which are validated." A
          summary stacked on top of the thing it summarises is one screen of duplication before a rep
          reaches anything he can act on. Here they belong to the part they measure. */}
      {current === "to_validate" ? <ReadinessBlock pending={pending} view={view} /> : null}

      {current === "to_validate" ? (
        <CustomerSection
          customers={pending}
          empty={{ title: "Every customer is validated", message: "Every customer carried over from iReports360 is validated or in the Archive." }}
          exportTitle="To validate"
          onRowAction={onRowAction}
          variant="pending"
          view={view}
        />
      ) : null}

      {current === "your_list" ? (
        <CustomerSection
          customers={active}
          empty={{
            title: "No customers validated yet",
            message: view.canEdit
              ? "A customer shows here once validated at the clinic with a signboard photo, the location and the days and hours."
              : "A customer shows here once the rep validates it at the clinic.",
          }}
          exportTitle="Your list"
          onRowAction={onRowAction}
          variant="active"
          view={view}
        />
      ) : null}

      {current === "outside" ? (
        <CustomerSection
          customers={outside}
          empty={{
            title: "Nobody is waiting outside the list",
            message:
              "A customer met on an out-of-list visit, or added with Add new customer, waits here — validated at the door — until the district manager and SFE add the customer to the list.",
          }}
          exportTitle="Outside the list"
          onRowAction={onRowAction}
          variant="outside"
          view={view}
        />
      ) : null}

      {current === "timetable" ? (
        <TimetableSection
          cairoToday={cairoToday}
          customers={active.filter((customer) => typeMatches(customer.listType) && customerMatches(needle, customer))}
          onOpen={onOpen}
          season={season}
          setSeason={setSeason}
          setWeekday={setWeekday}
          typeFilter={typeFilter}
          view={view}
          weekday={weekday}
        />
      ) : null}

      {current === "requests" ? <RequestsSection onChanged={onRequestChanged} seatId={seatId} test={test} view={view} /> : null}

      {current === "archive" ? (
        <CustomerSection
          customers={archived}
          empty={{
            title: "The Archive is empty",
            message: "A customer dropped from the list, or dropped instead of added to it, is kept here. SFE manages the Archive.",
          }}
          exportTitle="Archive"
          onRowAction={onRowAction}
          variant="dropped"
          view={view}
        />
      ) : null}
    </CrmPanel>
  );
}

function customerMatches(needle: string, customer: ListCustomer): boolean {
  return matchesQuery(needle, [
    customer.name,
    customer.speciality,
    // Before he is validated the only address he has is the one iReports360 holds.
    customer.reference?.address ?? null,
    customer.reference?.city ?? null,
    customer.reference?.zone ?? null,
    ...customer.places.flatMap((place) => [place.label, place.address, place.zone, place.brickName]),
  ]);
}

// ── The list, as the board holds it ─────────────────────────────────────────────────────────────

/**
 * My List, inside Phoenix CRM — grouped by brick, AM, PM and pharmacies on their own tabs.
 *
 * Owner, 2026-09-24: "I don't need the My List separated, I need it in Phoenix CRM. The same, exactly
 * the same … the breakdown of the PM list and the AM, pharmacies and bricks … when there are visits I
 * need the breakdown to be also not visited … the tabs coloured the same bricks … the insights showing.
 * I don't need the confidence column." Kept by the owner on 2026-09-29, when its customer rows lost
 * every button but one: Validate while not validated, Open once validated. Its pharmacy rows stay
 * read-only.
 *
 * TWO READS OF ONE TERRITORY, JOINED ON THE CONTACT'S CRM ID. The board (`/list/board`) is the
 * iReports360 mirror: it knows the bricks, the pharmacies, and who has not been visited this month.
 * The CRM list (`/list`, already loaded above) is what a rep can act on: which customers are pending,
 * which are validated, and the ids the Validate and Open screens take. Neither can answer the other's
 * question, which is why both are read rather than one being taught to do both jobs.
 */
function BoardSection({
  onRowAction,
  seatId,
  test,
  view,
}: {
  onRowAction: (customer: ListCustomer, action: ListRowAction) => void;
  seatId: string;
  test: boolean;
  view: TerritoryListView;
}) {
  const resource = useCrmGet<RepsListBoard | null>(listBoardUrl(seatId, test), "board");
  const board = resource.data;

  // The join. A pending customer carries the iReports360 contact id he was minted from, and that is
  // the same id the board rows are keyed on — so a board row finds its CRM customer, or finds none
  // and says so rather than showing a button that would open nothing.
  const byContact = new Map<number, ListCustomer>();
  for (const customer of view.customers) {
    if (customer.referenceContactCrmId !== null) byContact.set(customer.referenceContactCrmId, customer);
  }

  if (!board?.list) {
    return (
      <CrmBlock className="border-t border-slate-100">
        {resource.error ? (
          <CrmLoadError message={resource.error} onRetry={resource.reload} />
        ) : resource.loading ? (
          <CrmLoading label="Loading the list" />
        ) : (
          // Not an error and not an empty list: the seat has nobody in it, so there is no rep whose
          // list this would be. Saying that is the finding — "no contacts" would blame the CRM.
          <CrmEmpty
            message="The brick view belongs to the rep holding the seat. Nobody holds this one, so there is no list to group. The customers themselves are under Your list, unchanged."
            title="No rep in this territory"
          />
        )}
      </CrmBlock>
    );
  }

  /**
   * The row's one button.
   *
   * A PHARMACY IS READ-ONLY (owner's choice, 2026-09-24, kept 2026-09-29). The CRM's list is AM and PM
   * customers — it holds no pharmacies at all — so there is nothing to validate or open; the cell says
   * where the row came from instead. The pharmacies are on the board because the owner asked to see them.
   */
  const rowActions = (row: RepsListContact) => {
    const customer = byContact.get(row.contactCrmId);
    if (!customer) {
      return (
        <p className="text-phx-2xs font-semibold text-slate-400">
          {row.listType === "Pharmacy" ? "Pharmacy · not on the CRM list" : "Not on the CRM list yet"}
        </p>
      );
    }
    // Side by side on a phone card; the column's full width in the table's Actions column.
    return (
      <div className="flex flex-wrap gap-1.5 md:grid md:[&>button]:w-full">
        <CustomerRowAction canValidate={view.canEdit} customer={customer} onAction={onRowAction} />
      </div>
    );
  };

  return (
    <div className="border-t border-slate-100">
      {/* THE WINDOW, PRINTED ABOVE THE NUMBERS IT SCORES — the same sentence the board prints, for
          the same reason: on the 2nd of a month almost every contact is legitimately unvisited, and
          "Not visited 84" with no window under it reads as a collapse in coverage. */}
      <p className="px-4 pt-4 text-phx-2xs font-semibold text-slate-500 sm:px-5">
        {board.activityAvailable
          ? `Visits and plan counted from ${dayLabel(`${board.activityMonth}-01`)} to ${dayLabelWithYear(board.activityAsOf)} Cairo.`
          : "The plan and visits for this month could not be read, so no activity is shown beside the contacts. The list below is complete and unaffected by that."}
      </p>
      <RepsListTiles board={board} gutter="px-4 sm:px-5" list={board.list} />
      <RepsListContacts
        activityAvailable={board.activityAvailable}
        activityMonthLabel={board.activityMonthLabel}
        brickColor
        collapsible
        exportTitle="Customer list"
        groups={board.list.groups}
        // The name heading the download, by NAME and never a seat code (owner's standing rule). The
        // territory is the fallback for a seat whose occupant could not be named, so the file always
        // says whose list it is.
        repName={view.territory.repName ?? view.territory.name}
        rowActions={rowActions}
      />
    </div>
  );
}

function ReadinessBlock({ pending, view }: { pending: ReadonlyArray<ListCustomer>; view: TerritoryListView }) {
  const { readiness } = view;
  const toGo = pending.length;

  if (view.reference.length === 0 && pending.length === 0) {
    return (
      <CrmBlock>
        <CrmNote title="No iReports360 list for this territory" tone="info">
          {view.canEdit
            ? "Add the territory's customers with Add new customer: a signboard photo at the clinic, the location and the days and hours. Your district manager, then SFE, add each one to your list."
            : "The rep adds the territory's customers with Add new customer, each validated at the clinic; the district manager, then SFE, add each one to the list."}
        </CrmNote>
      </CrmBlock>
    );
  }

  const reference = countByType(view.reference);
  const validated = countByType(view.reference.filter((entry) => entry.state === "validated"));
  // How much of the reference list is validated, for the bar under the lead figure. Capped, so a list
  // re-read mid-change can never draw a bar past its own end.
  const donePercent = readiness.total > 0 ? Math.min(100, Math.round((readiness.validated / readiness.total) * 100)) : 0;
  const allDone = toGo === 0;

  return (
    <CrmBlock title="The list">
      {/* 🔴 FOUR EQUAL TILES, THEN THE PROGRESS ON ITS OWN LINE (owner, 2026-09-30, of the row as it
          stood: "this part is awful"). It was a 5fr lead box beside three 7fr ones, and the lead
          carried the bar, the percentage AND a three-line sentence — so it stood about three times
          the height of its neighbours, and because a grid row is as tall as its tallest cell the
          other three each ended in roughly 120px of white nothing. Worse, the rhythm inside them
          disagreed: the lead put its AM · PM beside the figure, the other three put it underneath,
          which is two families pretending to be one.

          So the four figures are now one row of identical tiles — same label, same figure size, same
          meta line, in that order — and everything that belongs to the LIST rather than to one tile
          moved out from under "To validate" into the strip below, which is where a bar measuring the
          whole list belonged in the first place. Nothing is lost and the void is gone.

          What still marks the figure he acts on is the ORANGE RAIL, not extra size: a bigger number
          in one cell would sit on a different baseline from the other three, which is the same
          not-lining-up he has objected to before. AM and PM are said apart in every tile
          (`pairText`), never added into one. */}
      <div className="grid min-w-0 grid-cols-2 gap-2 lg:grid-cols-4">
        <ListFigure
          label="To validate"
          note={allDone ? "Every customer is validated" : pairText(countByType(pending))}
          tone={allDone ? "good" : "act"}
          value={countText(toGo)}
        />
        <ListFigure label="Reference list" note={pairText(reference)} value={countText(readiness.total)} />
        <ListFigure
          label="Validated"
          note={pairText(validated)}
          tone={readiness.validated > 0 ? "good" : undefined}
          value={countText(readiness.validated)}
        />
        <ListFigure
          label="Drops waiting"
          note={`${plural(readiness.dropped, "customer", "customers")} in the Archive`}
          value={countText(readiness.dropPending)}
        />
      </div>

      <div className="mt-2 min-w-0 border border-slate-200/80 bg-white px-4 py-3">
        {readiness.total > 0 ? (
          <>
            <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <p className="text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500">Validated so far</p>
              <p className="text-phx-2xs font-black uppercase tracking-[0.12em] tabular-nums text-slate-500">{`${donePercent}% of the list`}</p>
            </div>
            <div
              aria-label="Validated so far"
              aria-valuemax={readiness.total}
              aria-valuemin={0}
              aria-valuenow={readiness.validated}
              className="mt-1.5 h-1.5 w-full bg-slate-100"
              role="progressbar"
            >
              <div className="h-full bg-emerald-500 transition-[width]" style={{ width: `${donePercent}%` }} />
            </div>
          </>
        ) : null}
        <p className={cn("break-words text-xs font-semibold leading-5 text-slate-600", readiness.total > 0 && "mt-2")}>
          {allDone
            ? `${readiness.readyAt ? `Ready since ${cairoStamp(readiness.readyAt)}. ` : ""}Customers who appear on the iReports360 list later show under To validate, and can be planned and visited straight away.`
            : view.canEdit
              ? "Plan and visit them as normal. Validate each one at the clinic — signboard photo, location, days and hours — and the visits already saved start counting."
              : "The rep plans and visits them as normal. Each one starts counting once the rep validates it at the clinic."}
        </p>
      </div>

      {view.referenceSource && !view.referenceSource.isCurrent ? (
        <p className="mt-2 break-words text-xs font-semibold leading-5 text-slate-500">
          This reference list is the one {view.referenceSource.name ?? "the previous rep"} worked in iReports360. The list stays with the territory.
        </p>
      ) : null}
    </CrmBlock>
  );
}

/**
 * A context figure beside the lead one.
 *
 * 🔴 ONE FAMILY, NOT A LEAD BOX AND THREE LEFTOVERS (owner, 2026-09-30: "the part of the To validate
 * and the Reference list is awful — the polish of the page is awful, all in all"). They were three
 * different shapes at once: the lead figure 4xl over a progress bar, these three a smaller box with
 * a grey stub, and the label tracking, the figure size and the meta type all differed between them,
 * so the row read as one thing plus three offcuts rather than as a set.
 *
 * 🔴 AND ALL FOUR ARE NOW THE SAME TILE, INCLUDING "To validate" (owner again, same day: "this part
 * is awful"). The first pass kept the lead as a separate, much taller box, which is what left the
 * other three sitting in ~120px of white nothing; the block above explains the move. What is left
 * here is the one shape they all wear: the same small-caps label at the same tracking, the figure on
 * its own line in tabular numerals so all four line up, the meta beneath it, and a rail that MEANS
 * something rather than a decorative stub. Square edges, as everything here is.
 *
 * `tone` is the ONLY thing that varies, and never the type scale: `act` is the figure he does
 * something about, `good` is a figure worth being pleased by, and no tone at all is plain context.
 * Sizing one tile up instead would put its number on a different baseline from its neighbours'.
 */
function ListFigure({ label, note, tone, value }: { label: string; note: string; tone?: "act" | "good"; value: string }) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col border border-l-[3px] border-slate-200/80 bg-white px-3 py-3 transition hover:border-slate-300",
        tone === "good" ? "border-l-emerald-500" : tone === "act" ? "border-l-orange-500" : "border-l-slate-300",
      )}
    >
      <p className="break-words text-phx-2xs font-black uppercase tracking-[0.16em] text-slate-500">{label}</p>
      <p
        className={cn(
          "mt-1.5 break-words text-2xl font-black leading-none tracking-tight tabular-nums",
          tone === "good" ? "text-emerald-700" : "text-slate-950",
        )}
      >
        {value}
      </p>
      <p className="mt-1.5 break-words text-phx-2xs font-semibold leading-4 text-slate-500">{note}</p>
    </div>
  );
}

/**
 * VALIDATE NEXT — the three customers most worth the rep's next stop.
 *
 * Owner, 2026-09-30 ("the best-appearing and easiest CRM, yet controlled"). A carried-over list can
 * hold dozens still to validate, and the board below groups them by brick and name, which says nothing
 * about which one is worth going to first. `validateNextTop` (src/lib/phoenix-crm/validate-next.ts)
 * answers it from the list the screen already holds: visits already saved first — they start counting
 * the moment he validates — then grade A, then the brick where one trip validates the most. Each card
 * says which of those put it there, in plain words about his own work, never a distance, a reading or
 * a check (Golden rule #1).
 *
 * ONE BUTTON PER CARD, and it is the row's own `CustomerRowAction`, so the strip can never offer what
 * the list itself would not — no "Add visit", no second action. The ranking only ever returns
 * customers the Validate screen opens on, so that button reads Validate.
 */
function ValidateNextStrip({
  canValidate,
  customers,
  onRowAction,
}: {
  /** The viewer is the territory's rep. Nobody else validates, so nobody else is shown the strip. */
  canValidate: boolean;
  customers: ReadonlyArray<ListCustomer>;
  onRowAction: (customer: ListCustomer, action: ListRowAction) => void;
}) {
  const picks = canValidate ? validateNextTop(customers) : [];
  if (picks.length === 0) return null;
  // Out of the customers the ranking could offer — not every one To validate: one he already asked to
  // drop is not waiting on him, and "Top 1 of 3" over two of those would read as two he forgot.
  const offered = customers.filter(isValidateNextCandidate).length;
  const heading = picks.length < offered ? `Top ${picks.length} of ${countText(offered)}` : `${plural(picks.length, "customer", "customers")} to go`;

  return (
    <CrmBlock
      actions={<span className="text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-400">{heading}</span>}
      className="border-t border-slate-100"
      title="Validate next"
    >
      <p className="-mt-1 mb-3 break-words text-xs font-semibold leading-5 text-slate-500">
        Visits already saved first, then grade A, then the brick where one trip validates the most.
      </p>
      <ol aria-label="Validate next" className="grid min-w-0 gap-2 md:grid-cols-3">
        {picks.map((pick, index) => (
          <li className="flex min-w-0 flex-col border border-l-[3px] border-slate-200 border-l-orange-500 bg-white px-3.5 py-3" key={pick.customer.customerId}>
            <div className="flex min-w-0 items-start gap-2.5">
              <span
                aria-hidden
                className="flex h-6 w-6 shrink-0 items-center justify-center border border-orange-200 bg-orange-50 text-xs font-black text-orange-700"
              >
                {index + 1}
              </span>
              <div className="min-w-0 flex-1">
                <h4 className="break-words text-sm font-black text-slate-950" dir="auto">
                  {pick.customer.name}
                </h4>
                <p className="mt-0.5 break-words text-xs font-semibold leading-5 text-slate-500">
                  {listText(pick.customer.listType)} · {pick.customer.grade ? `Grade ${pick.customer.grade}` : "No grade"}
                  {pick.brickName ? (
                    <>
                      {" · Brick "}
                      <bdi>{pick.brickName}</bdi>
                    </>
                  ) : null}
                </p>
              </div>
            </div>
            <p className="mt-2.5 break-words text-xs font-black leading-5 text-orange-800">{pick.reasons[0]}</p>
            {pick.reasons.length > 1 ? (
              <p className="break-words text-xs font-semibold leading-5 text-slate-500">{pick.reasons.slice(1).join(" · ")}</p>
            ) : null}
            <div className="mt-auto grid pt-3 [&>button]:w-full">
              <CustomerRowAction canValidate={canValidate} customer={pick.customer} onAction={onRowAction} />
            </div>
          </li>
        ))}
      </ol>
    </CrmBlock>
  );
}

/**
 * One customer part of the list — To validate, Your list, Outside the list or the Archive — drawn the
 * board's way, each row carrying its one button (Validate or Open).
 */
function CustomerSection({
  customers,
  empty,
  exportTitle,
  onRowAction,
  variant,
  view,
}: {
  customers: ReadonlyArray<ListCustomer>;
  empty: { title: string; message: string };
  exportTitle: string;
  onRowAction: (customer: ListCustomer, action: ListRowAction) => void;
  variant: CustomerListVariant;
  view: TerritoryListView;
}) {
  if (customers.length === 0) {
    return (
      <div className="border-t border-slate-100">
        <CrmEmpty message={empty.message} title={empty.title} />
      </div>
    );
  }
  return (
    <CustomerListBoard
      canValidate={view.canEdit}
      customers={customers}
      exportTitle={exportTitle}
      onRowAction={onRowAction}
      repName={view.territory.repName ?? view.territory.name}
      variant={variant}
    />
  );
}

type TimetableRow = {
  customer: ListCustomer;
  place: ListPlace;
  index: number;
  windows: PhoenixCrmTiming[];
  noRamadanTime: boolean;
};

function TimetableSection({
  cairoToday,
  customers,
  onOpen,
  season,
  setSeason,
  setWeekday,
  typeFilter,
  view,
  weekday,
}: {
  cairoToday: string;
  customers: ReadonlyArray<ListCustomer>;
  onOpen: (screen: ListScreen) => void;
  season: PhoenixCrmSeason | null;
  setSeason: (next: PhoenixCrmSeason) => void;
  setWeekday: (next: number) => void;
  typeFilter: TypeFilter;
  view: TerritoryListView;
  weekday: number | null;
}) {
  const inRamadan = Boolean(view.ramadan && cairoToday >= view.ramadan.startsOn && cairoToday <= view.ramadan.endsOn);
  const day = weekday ?? weekdayOfIsoDay(cairoToday);
  const hours = season ?? (inRamadan ? "ramadan" : "normal");
  const ramadan = hours === "ramadan";

  const rows: TimetableRow[] = [];
  for (const customer of customers) {
    customer.places.forEach((place, index) => {
      const { windows, noRamadanTime } = windowsForWeekday(place.timings, day, ramadan);
      if (windows.length > 0) rows.push({ customer, place, index, windows, noRamadanTime });
    });
  }
  rows.sort(
    (left, right) =>
      Math.min(...left.windows.map((window) => window.startMinute)) - Math.min(...right.windows.map((window) => window.startMinute)) ||
      left.customer.name.localeCompare(right.customer.name),
  );

  const groups = LIST_TYPES.filter((listType) => typeFilter === "all" || typeFilter === listType).map((listType) => ({
    listType,
    rows: rows.filter((row) => row.customer.listType === listType),
  }));
  const dayName = PHOENIX_CRM_WEEKDAY_NAMES[day];

  return (
    <div className="border-t border-slate-100">
      <CrmBlock>
        <div className="grid min-w-0 gap-3">
          <div aria-label="Day" className="grid grid-cols-4 gap-1.5 sm:grid-cols-7" role="radiogroup">
            {PHOENIX_CRM_WEEKDAY_ORDER.map((option) => (
              <button
                aria-checked={option === day}
                aria-label={PHOENIX_CRM_WEEKDAY_NAMES[option]}
                className={cn(
                  "min-h-10 rounded-none border px-1 text-sm font-black transition",
                  // One day of seven is a choice, so it wears the choice buttons' selected look — the
                  // solid orange is for toggles where several can be on at once.
                  option === day ? "border-orange-500 bg-orange-50 text-orange-800" : "border-slate-200 bg-white text-slate-700 hover:border-slate-300",
                )}
                key={option}
                onClick={() => setWeekday(option)}
                role="radio"
                type="button"
              >
                {PHOENIX_CRM_WEEKDAY_SHORT[option]}
              </button>
            ))}
          </div>
          <CrmChoice
            columns={2}
            label="Which hours"
            onChange={setSeason}
            options={[
              { value: "normal", label: "Normal hours" },
              {
                value: "ramadan",
                label: "Ramadan hours",
                note: view.ramadan ? `${dayLabelWithYear(view.ramadan.startsOn)} to ${dayLabelWithYear(view.ramadan.endsOn)}` : undefined,
              },
            ]}
            value={hours}
          />
        </div>
      </CrmBlock>

      {groups.map((group) => (
        <CrmBlock
          className="border-t border-slate-100"
          key={group.listType}
          title={`${group.listType} · ${dayName}${ramadan ? " in Ramadan" : ""}`}
        >
          {group.rows.length === 0 ? (
            <p className="text-sm font-medium text-slate-500">
              No {group.listType} customer receives on {dayName}
              {ramadan ? " in Ramadan" : ""}.
            </p>
          ) : (
            <ul className="divide-y divide-slate-100 border border-slate-200">
              {group.rows.map((row) => (
                <li key={row.place.placeId}>
                  <button
                    className="grid w-full min-w-0 gap-1 px-3 py-2.5 text-left transition hover:bg-slate-50 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-3"
                    onClick={() => onOpen({ name: "customer", customerId: row.customer.customerId })}
                    type="button"
                  >
                    <span className="block break-words text-sm font-black text-orange-700">{row.windows.map(formatTimingWindow).join(", ")}</span>
                    <span className="block min-w-0">
                      <span className="block break-words text-sm font-black text-slate-950">{row.customer.name}</span>
                      <span className="mt-0.5 block break-words text-xs font-semibold text-slate-500">
                        {[
                          row.customer.grade ? `Grade ${row.customer.grade}` : "No grade",
                          row.customer.speciality,
                          row.customer.places.length > 1 ? placeName(row.place, row.index) : null,
                        ]
                          .filter((part): part is string => Boolean(part))
                          .join(" · ")}
                      </span>
                      {row.noRamadanTime ? (
                        <span className="mt-1 flex flex-wrap gap-1">
                          <CrmPill tone="warn">No Ramadan hours, normal hours shown</CrmPill>
                        </span>
                      ) : null}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CrmBlock>
      ))}
    </div>
  );
}

/**
 * The territory's requests — a grade change (the district manager's one step), and the drops, adds and
 * bring-backs that go to the district manager, then SFE — each with the step it is on. Deciding is
 * offered where the server says this viewer decides that step (`request.canDecide`).
 */
function RequestsSection({
  onChanged,
  seatId,
  test,
  view,
}: {
  onChanged: (message: string) => void;
  seatId: string;
  test: boolean;
  view: TerritoryListView;
}) {
  const requests = sortRequests(view.requests);
  if (requests.length === 0) {
    return (
      <div className="border-t border-slate-100">
        <CrmEmpty message="Waiting requests, and the ones decided in the last 45 days, show here." title="No requests" />
      </div>
    );
  }
  return (
    <div className="divide-y divide-slate-100 border-t border-slate-100">
      {requests.map((request) => (
        <RequestCard
          canDecide
          canWithdraw={view.canEdit}
          key={request.requestId}
          onChanged={onChanged}
          request={request}
          seatId={seatId}
          test={test}
        />
      ))}
    </div>
  );
}
