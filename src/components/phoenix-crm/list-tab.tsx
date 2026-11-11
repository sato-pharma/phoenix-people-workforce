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
 * Owner, 2026-09-30 — "the best-appearing and easiest CRM, yet controlled", and then, of what that
 * first produced: "I want the page of the list to contain the list only."
 *
 * 🔴 SO THE PAGE OPENS ON THE CHOOSER AND THE LIST, WITH NOTHING IN FRONT OF THEM. A readiness
 * figures block and a three-card "Validate next" strip used to stand there — about half the first
 * screen between a rep and his own customers, and the figures repeated three of the chooser's own
 * parts besides. Both are deleted. The ranking they used is not: `validate-next.ts` still decides
 * which customer is most worth the next stop, and that belongs on the To validate ROWS, never in a
 * band above them. Do not put a summary, a strip or a banner back here.
 */

import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { Plus, Search } from "lucide-react";

import { RepsListTiles } from "@/components/crm/reps-list-board";
import { RepsListContacts } from "@/components/crm/reps-list-tables";
import { AddPharmacyScreen } from "@/components/phoenix-crm/add-pharmacy";
import { useCrmGet, type CrmResource } from "@/components/phoenix-crm/api";
import { CustomerListBoard, CustomerRowAction, type CustomerListVariant } from "@/components/phoenix-crm/customer-list-board";
import { countText, dayLabel, dayLabelWithYear } from "@/components/phoenix-crm/format";
import { placeName, territoryLine } from "@/components/phoenix-crm/labels";
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
import { releaseCapturedPhoto } from "@/components/phoenix-crm/captured-photo";
import type { CapturedPhoto } from "@/components/phoenix-crm/live-photo-capture";
import { PharmacyDetailsScreen } from "@/components/phoenix-crm/pharmacy-details";
import { PlaceMoveScreen } from "@/components/phoenix-crm/place-move-screen";
import { VenueTimetableScreen } from "@/components/phoenix-crm/venue-timetable-screen";
import { SignboardRetakeScreen } from "@/components/phoenix-crm/signboard-retake-screen";
import { SeatInVenueScreen } from "@/components/phoenix-crm/seat-in-venue-screen";
import { TrustedPointScreen } from "@/components/phoenix-crm/trusted-point-screen";
import type { PlaceDraftState } from "@/components/phoenix-crm/place-editor";
import type { SeatedDraftState } from "@/components/phoenix-crm/shared-place-screens";
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
import { needsAddRequest, needsGradeText, type ListRowAction } from "@/lib/phoenix-crm/list-request-rules";
import { addedPharmacyNote } from "@/lib/phoenix-crm/pharmacy-call-rules";
import {
  formatTimingWindow,
  PHOENIX_CRM_WEEKDAY_NAMES,
  PHOENIX_CRM_WEEKDAY_ORDER,
  PHOENIX_CRM_WEEKDAY_SHORT,
  windowsForWeekday,
} from "@/lib/phoenix-crm/timings";
import type { PhoenixCrmDoctorListType, PhoenixCrmListType, PhoenixCrmSeason, PhoenixCrmTiming } from "@/lib/phoenix-crm/types";
import type { ListCustomer, ListPlace, TerritoryListView } from "@/lib/phoenix-crm/view-types";
import { cn } from "@/lib/utils";

/** The parts of the list home, in the order the owner named them (2026-09-29). */
type HomeSection = "board" | "to_validate" | "your_list" | "outside" | "requests" | "archive" | "timetable";
type TypeFilter = "all" | PhoenixCrmListType;

/**
 * The part of the list home on screen: the one he picked, else the one waiting on him, else the board.
 *
 * One function for its two readers — ListHome draws the part, and ListTab reads from it when the
 * board is on screen and so when the board's own request is wanted — so the two can never disagree.
 */
function homeSectionFor(view: TerritoryListView, section: HomeSection | null): HomeSection {
  const pendingCount = view.customers.filter((customer) => customer.section === "to_validate").length;
  const decidableCount = view.requests.filter((request) => request.status === "pending" && request.canDecide).length;
  const hasReference = view.reference.length > 0 || pendingCount > 0;
  // The board is where the list opens (owner, 2026-09-24: "I don't need the My List separated, I need
  // it in Phoenix CRM"), unless something is actually waiting on the viewer — a validation to finish or
  // a request to decide outranks a reading view, as it did before the board arrived.
  // A manager who may validate here lands on the same section his rep does (owner, 2026-10-02) — on a
  // vacant territory he is the only one who can work through it.
  const defaultSection: HomeSection = view.canValidateReference && pendingCount > 0 ? "to_validate" : decidableCount > 0 ? "requests" : "board";
  return section === "to_validate" && !hasReference ? "board" : (section ?? defaultSection);
}

/**
 * A visit just saved on a customer who is not validated yet, handed back to this tab's Validate screen
 * (the page passes it on). It carries no photo by design: validating takes its own signboard photo.
 */
type ValidateHandoff = { seatId: string; test: boolean; contactCrmId: number };

/**
 * Add visit's "Write the full name" on a clinic customer with one or two names (owner, 2026-11-09): the
 * tab opens on his Change the details screen, released through `go()` exactly like the Validate hand-off.
 */
type FullNameHandoff = { seatId: string; test: boolean; customerId: string };

/** AM first, then PM, the way the rep's day starts. */
const LIST_TYPES: readonly PhoenixCrmListType[] = ["AM", "PM"];

function matchesQuery(query: string, parts: ReadonlyArray<string | null>): boolean {
  if (!query) return true;
  return parts.some((part) => part !== null && part.toLowerCase().includes(query));
}

function countByType<T extends { listType: PhoenixCrmListType }>(rows: ReadonlyArray<T>): Record<PhoenixCrmDoctorListType, number> {
  return {
    AM: rows.filter((row) => row.listType === "AM").length,
    PM: rows.filter((row) => row.listType === "PM").length,
  };
}

/** "3 AM · 41 PM" — AM and PM side by side, never added together. */
function pairText(counts: Record<PhoenixCrmDoctorListType, number>): string {
  return `${countText(counts.AM)} AM · ${countText(counts.PM)} PM`;
}

export function ListTab({
  cairoToday,
  onPendingFullNameDone,
  onPendingValidateDone,
  onWorkChange,
  pendingFullName,
  pendingValidate,
  seatId,
  test,
}: {
  cairoToday: string;
  /** The full-name hand-off was opened, saved, or left behind: the page may let it go. */
  onPendingFullNameDone?: () => void;
  /** The Validate hand-off was opened, saved, or left behind: the page may let it go. */
  onPendingValidateDone?: () => void;
  /**
   * Accepted and ignored since 2026-09-29, so the page that renders this tab still compiles: the List
   * starts no visit (owner — a visit starts from Visits, Today or the portal's "+").
   */
  onStartVisit?: unknown;
  /** A customer entry opened or closed: the page keeps this tab as it is while another tab is open. */
  onWorkChange?: (working: boolean) => void;
  /** Add visit sent a clinic customer with one or two names here to have the full name written. */
  pendingFullName?: FullNameHandoff | null;
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
  const fullNameHandoff =
    pendingFullName && pendingFullName.seatId === seatId && pendingFullName.test === test ? pendingFullName : null;
  const current: ListScreen = validateHandoff
    ? { name: "validate", contactCrmId: validateHandoff.contactCrmId }
    : fullNameHandoff
      ? { name: "edit-details", customerId: fullNameHandoff.customerId }
      : screen;

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
    if (fullNameHandoff) onPendingFullNameDone?.();
    setScreen(next);
    setNotice(nextNotice);
    scrollToTop();
  }

  const home = () => go({ name: "home" });
  const openCustomer = (customerId: string, nextNotice: ListNotice | null = null) => go({ name: "customer", customerId }, nextNotice);

  function placeSaved(saved: SavedPlace, photo: CapturedPhoto | null) {
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

  /** The same hand-off for a seating in a polyclinic: the venue, the timetable photo and the hours. */
  function seatInstead(customerId: string, seated: SeatedDraftState) {
    go({ name: "add-place", customerId, draft: null, seated });
  }

  /** The one button on a customer's row: Validate, or Open. */
  function rowAction(customer: ListCustomer, action: ListRowAction) {
    if (action === "validate" && customer.referenceContactCrmId !== null) {
      go({ name: "validate", contactCrmId: customer.referenceContactCrmId });
      return;
    }
    // A customer the SFE loaded from a sheet: on the list, waiting to be validated, and carrying no
    // iReports360 contact at all. He is validated at the door exactly like a carried-over one.
    if (action === "validate" && customer.status === "pending") {
      go({ name: "validate-listed", customerId: customer.customerId });
      return;
    }
    openCustomer(customer.customerId);
  }

  const view = resource.data;

  // 🔴 THE BOARD'S REQUEST LIVES HERE, NOT IN ITS SECTION (2026-10-01, "slow to transfer between page
  // and page", Phoenix CRM first). It was `useCrmGet` inside BoardSection, which unmounts whenever he
  // picks another part of the list or opens a customer, so every return to "The list" asked for the
  // heaviest read in the module all over again. Now it is asked for the first time the board is on
  // screen and kept for the life of the tab. Nothing it shows goes stale by that: the board is the
  // iReports360 mirror, and the rows join to `view.customers` at render time, so a save that reloads
  // the list still reaches the board's buttons at once.
  //
  // And it is asked for WITH the list, not after it (performance work, 24 Oct 2026): the board is where
  // the list opens unless something is waiting on him (`homeSectionFor`), so a tab opening on its home
  // starts both reads together instead of waiting out the list (p50 1,211 ms on production) before even
  // asking for the board. Only the REQUEST moves — what is drawn is still decided by `boardOnScreen`.
  // A tab opened on a Validate hand-off is not on its home, so it waits for the board to be shown.
  const boardOnScreen = view !== null && current.name === "home" && homeSectionFor(view, section) === "board";
  const [boardWanted, setBoardWanted] = useState(() => validateHandoff === null && fullNameHandoff === null);
  // State derived while rendering, never in an effect — the same shape the page uses for its address.
  if (boardOnScreen && !boardWanted) setBoardWanted(true);
  const board = useCrmGet<RepsListBoard | null>(boardWanted ? listBoardUrl(seatId, test) : null, "board");

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
            onSeatInstead={seatInstead}
            subject={{ mode: "reference", contactCrmId }}
          />
        );
        break;
      }
      case "validate-listed": {
        const { customerId } = current;
        body = (
          <ValidateScreen
            {...base}
            key={`validate-listed-${customerId}`}
            onAddPlaceInstead={addPlaceInstead}
            onAskToDrop={(id) => go({ name: "drop", customerId: id, contactCrmId: null })}
            onBack={home}
            onSaved={placeSaved}
            onSeatInstead={seatInstead}
            subject={{ mode: "listed", customerId }}
          />
        );
        break;
      }
      case "new":
        body = (
          <ValidateScreen
            {...base}
            key="new"
            onAddPlaceInstead={addPlaceInstead}
            onBack={home}
            onSaved={placeSaved}
            onSeatInstead={seatInstead}
            subject={{ mode: "new" }}
          />
        );
        break;
      case "add-pharmacy":
        // By its name, with no photo and no approval (owner, 2026-10-03): it opens on his list at once.
        body = (
          <AddPharmacyScreen
            backLabel="List"
            from="list"
            key="add-pharmacy"
            onAdded={(added) => customerChanged(added.customerId, { tone: "good", title: addedPharmacyNote(added) })}
            onBack={home}
            seatId={seatId}
            test={test}
          />
        );
        break;
      case "pharmacy-details": {
        // A pharmacy already on his list: its location and its responsible person's phone, both
        // optional (owner, 2026-10-09). The pharmacy's own page opens it.
        const { customerId } = current;
        const pharmacy = view.customers.find((customer) => customer.customerId === customerId);
        body = pharmacy ? (
          <PharmacyDetailsScreen
            backLabel="Pharmacy"
            key={`pharmacy-details-${customerId}`}
            onBack={() => openCustomer(customerId)}
            onSaved={(saved) =>
              customerChanged(customerId, {
                tone: "good",
                title: saved.pinned ? `${saved.customerName} is saved with its location.` : `${saved.customerName} is saved.`,
              })
            }
            pharmacy={{
              customerId,
              name: pharmacy.name,
              phone: pharmacy.phone,
              pin: pharmacy.pharmacyPin,
            }}
            seatId={seatId}
            test={test}
          />
        ) : (
          <CrmPanel eyebrow="List" title="Pharmacy">
            <CrmBlock>
              <CrmNote tone="warn">This pharmacy is no longer on your list. Go back to the list and open it again.</CrmNote>
              <div className="mt-3">
                <CrmButton onClick={home}>Back to the list</CrmButton>
              </div>
            </CrmBlock>
          </CrmPanel>
        );
        break;
      }
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
            initialSeated={current.seated ?? null}
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
      case "retake-signboard": {
        const { customerId, placeId } = current;
        body = (
          <SignboardRetakeScreen
            {...base}
            customerId={customerId}
            key={`retake-signboard-${placeId}`}
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
      case "seat-in-venue": {
        // The Super Admin's alone: the customer's page offers it only where `view.canSeatInVenue`, and
        // the screen refuses to draw for anyone else. 🔴 The `default:` branch below renders ListHome, so
        // a variant with no case here silently shows the list.
        const { customerId } = current;
        body = (
          <SeatInVenueScreen
            {...base}
            customerId={customerId}
            key={`seat-in-venue-${customerId}`}
            onBack={() => openCustomer(customerId)}
            onDone={(next) => customerChanged(customerId, next)}
          />
        );
        break;
      }
      case "trusted-point": {
        // The Super Admin's alone: the customer's page offers it only where `view.canPlaceOnTrustedPoint`,
        // and the screen refuses to draw for anyone else.
        const { customerId } = current;
        body = (
          <TrustedPointScreen
            {...base}
            customerId={customerId}
            key={`trusted-point-${customerId}`}
            onBack={() => openCustomer(customerId)}
            onDone={(next) => customerChanged(customerId, next)}
          />
        );
        break;
      }
      case "venue-timetable": {
        const { customerId, sharedPlaceId } = current;
        body = (
          <VenueTimetableScreen
            {...base}
            key={`venue-timetable-${sharedPlaceId}`}
            onBack={() => openCustomer(customerId)}
            onDone={(next) => customerChanged(customerId, next)}
            sharedPlaceId={sharedPlaceId}
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
            board={board}
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
  board,
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
  /** The board part's request, held by the tab so it survives this home unmounting (see ListTab). */
  board: CrmResource<RepsListBoard | null>;
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
  // Outside the list with no add request: nobody's queue holds them until the rep proposes a grade.
  const needGrade = view.canEdit ? outside.filter(needsAddRequest).length : 0;
  const archived = view.customers.filter((customer) => customer.section === "archive");
  const waiting = view.requests.filter((request) => request.status === "pending");
  const decidable = waiting.filter((request) => request.canDecide);
  const hasReference = view.reference.length > 0 || pending.length > 0;

  // Where the list opens, and why, is `homeSectionFor` — the tab reads the same answer to know when
  // the board's request is wanted.
  const current: HomeSection = homeSectionFor(view, section);

  const needle = query.trim().toLowerCase();
  const typeMatches = (listType: PhoenixCrmListType) => typeFilter === "all" || typeFilter === listType;

  const sectionOptions = [
    { value: "board" as const, label: "The list", note: "By brick · AM · PM · pharmacies" },
    ...(hasReference
      ? [{ value: "to_validate" as const, label: "To validate", note: pending.length > 0 ? `${countText(pending.length)} to go` : "All done" }]
      : []),
    { value: "your_list" as const, label: "Your list", note: pairText(countByType(active)) },
    {
      value: "outside" as const,
      label: "Outside the list",
      note: needGrade > 0 ? `${countText(needGrade)} need your grade` : outside.length > 0 ? `${countText(outside.length)} waiting` : "None waiting",
    },
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
          <>
            <CrmButton onClick={() => onOpen({ name: "new" })} variant="primary">
              <Plus aria-hidden className="h-4 w-4" />
              Add new customer
            </CrmButton>
            {/* A pharmacy by its name alone, with no approval (owner, 2026-10-03). */}
            <CrmButton onClick={() => onOpen({ name: "add-pharmacy" })}>
              <Plus aria-hidden className="h-4 w-4" />
              Add a pharmacy
            </CrmButton>
          </>
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

      {/* 🔴 THE LIST PAGE HOLDS THE LIST, AND NOTHING ELSE (owner, 2026-09-30: "I want the page of
          the list to contain the list only"). A figures block and a three-card "Validate next" strip
          used to stand between the rep and his own list — together about half the first screen — and
          the figures repeated three of the chooser's own parts besides. Both are gone. Do not put a
          summary, a strip or a banner back above the chooser: what ranks a customer for validating
          belongs INSIDE To validate, on its rows. */}
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

      {current === "board" ? <BoardSection onRowAction={onRowAction} resource={board} view={view} /> : null}

      {/* A comment on a polyclinic or centre nobody is seated in has no customer card to sit on. It goes
          here, under the chooser and only in this part (owner, 2026-09-30: no strip above the list). */}
      {current === "to_validate" && view.emptyBuildingNotes.length > 0 ? (
        <CrmBlock className="border-t border-slate-100">
          <div className="min-w-0 space-y-3">
            {view.emptyBuildingNotes.map((note) => (
              <CrmNote key={note.noteId} title={note.authorText} tone="info">
                {note.aboutBuilding ? (
                  <span className="block break-words text-xs font-semibold text-slate-500" dir="auto">
                    About the polyclinic or centre: {note.aboutBuilding}
                  </span>
                ) : null}
                <span className="block break-words" dir="auto">
                  {note.body}
                </span>
                <span className="mt-0.5 block text-xs font-semibold text-slate-500">{note.writtenAtText}</span>
              </CrmNote>
            ))}
          </div>
        </CrmBlock>
      ) : null}

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

      {current === "outside" && needGrade > 0 ? (
        <div className="px-4 pt-4 sm:px-5">
          <CrmNote title="Waiting for your grade" tone="warn">
            {needsGradeText(needGrade)}
          </CrmNote>
        </div>
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
  resource,
  view,
}: {
  onRowAction: (customer: ListCustomer, action: ListRowAction) => void;
  /** The board's request, held by the tab so it survives this section unmounting (see ListTab). */
  resource: CrmResource<RepsListBoard | null>;
  view: TerritoryListView;
}) {
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
        <p className="text-phx-sm font-semibold text-slate-400">
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
      <p className="px-4 pt-4 text-phx-sm font-semibold text-slate-500 sm:px-5">
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
