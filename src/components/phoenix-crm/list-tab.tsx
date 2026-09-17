"use client";

/**
 * Phoenix CRM — the List tab: a territory's customer list.
 *
 * Owner, 2026-09-16:
 *   - the territory's iReports360 list is shown as a reference only; a customer is real once the rep
 *     validates it at the clinic with a live photo, the location and at least one timing;
 *   - the list stays with the territory; accounts (AM) and doctors in their clinics (PM), no pharmacies;
 *   - the list is ready, and weekly plans start, when every reference customer is validated or has
 *     left the list with the district manager's approval;
 *   - a timetable shows who receives on each day, the way the rep's own sheet did.
 */

import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { Plus, Search } from "lucide-react";

import { useCrmGet } from "@/components/phoenix-crm/api";
import { cairoStamp, countText, dayLabelWithYear, plural } from "@/components/phoenix-crm/format";
import { customerMetaText, monthStanding, monthVisitsText, placeName, territoryLine } from "@/components/phoenix-crm/labels";
import { CustomerScreen } from "@/components/phoenix-crm/list-customer";
import {
  AddPlaceScreen,
  DropScreen,
  EditPlaceScreen,
  GradeScreen,
  listUrl,
  placesDaysText,
  SavedScreen,
  ValidateScreen,
  type ListNotice,
  type ListScreen,
  type ListScreenBase,
  type SavedPlace,
} from "@/components/phoenix-crm/list-screens";
import { releaseCapturedPhoto, type CapturedPhoto } from "@/components/phoenix-crm/live-photo-capture";
import type { PlaceDraftState } from "@/components/phoenix-crm/place-editor";
import { RequestCard, sortRequests } from "@/components/phoenix-crm/request-card";
import {
  CrmBlock,
  CrmButton,
  CrmCard,
  CrmCardsOnPhone,
  CrmChoice,
  CrmEmpty,
  CrmField,
  CrmLoadError,
  CrmLoading,
  CrmNote,
  CrmPanel,
  CrmPill,
  CrmStat,
  CrmStatGrid,
  CrmTable,
  crmInputClassName,
  crmTdClassName,
  crmThClassName,
} from "@/components/phoenix-crm/ui";
import type { PendingVisit } from "@/components/phoenix-crm/visits-tab";
import { weekdayOfIsoDay } from "@/lib/phoenix-crm/calendar";
import {
  formatTimingWindow,
  PHOENIX_CRM_WEEKDAY_NAMES,
  PHOENIX_CRM_WEEKDAY_ORDER,
  PHOENIX_CRM_WEEKDAY_SHORT,
  windowsForWeekday,
} from "@/lib/phoenix-crm/timings";
import { PHOENIX_CRM_LIST_LABEL, type PhoenixCrmListType, type PhoenixCrmSeason, type PhoenixCrmTiming } from "@/lib/phoenix-crm/types";
import type { ListCustomer, ListPlace, ListReferenceEntry, TerritoryListView } from "@/lib/phoenix-crm/view-types";
import { cn } from "@/lib/utils";

type ListSection = "validate" | "customers" | "timetable" | "requests" | "left";
type TypeFilter = "all" | PhoenixCrmListType;

/** Accounts first, then doctors, the way the rep's day starts. */
const LIST_TYPES: readonly PhoenixCrmListType[] = ["AM", "PM"];

function matchesQuery(query: string, parts: ReadonlyArray<string | null>): boolean {
  if (!query) return true;
  return parts.some((part) => part !== null && part.toLowerCase().includes(query));
}

function byTypeThenName<T extends { listType: PhoenixCrmListType; name: string }>(left: T, right: T): number {
  if (left.listType !== right.listType) return left.listType.localeCompare(right.listType);
  return left.name.localeCompare(right.name);
}

function countByType<T extends { listType: PhoenixCrmListType }>(rows: ReadonlyArray<T>): Record<PhoenixCrmListType, number> {
  return {
    AM: rows.filter((row) => row.listType === "AM").length,
    PM: rows.filter((row) => row.listType === "PM").length,
  };
}

/** "3 AM · 41 PM" — accounts and doctors side by side, never added together. */
function pairText(counts: Record<PhoenixCrmListType, number>): string {
  return `${countText(counts.AM)} AM · ${countText(counts.PM)} PM`;
}

export function ListTab({
  cairoToday,
  onStartVisit,
  onWorkChange,
  seatId,
  test,
}: {
  cairoToday: string;
  /** Add Visit with the photo a place was just saved with. Absent where visits are not entered. */
  onStartVisit?: (visit: PendingVisit) => void;
  /** A customer entry opened or closed: the page keeps this tab as it is while another tab is open. */
  onWorkChange?: (working: boolean) => void;
  seatId: string;
  test: boolean;
}) {
  const resource = useCrmGet<TerritoryListView>(listUrl(seatId, test), "list");
  const [screen, setScreen] = useState<ListScreen>({ name: "home" });
  const [notice, setNotice] = useState<ListNotice | null>(null);
  const [section, setSection] = useState<ListSection | null>(null);
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [weekday, setWeekday] = useState<number | null>(null);
  const [season, setSeason] = useState<PhoenixCrmSeason | null>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const handedOffPhoto = useRef<CapturedPhoto | null>(null);

  // The list, a customer and the saved screen hold nothing unsaved; every other screen is an entry under way.
  const working = screen.name !== "home" && screen.name !== "customer" && screen.name !== "saved";
  const savedPhoto = screen.name === "saved" ? screen.photo : null;

  useEffect(() => {
    onWorkChange?.(working);
  }, [onWorkChange, working]);

  // Leaving the saved screen, or the tab closing on it, lets its photo go, unless it went on to a visit.
  useEffect(() => {
    if (!savedPhoto) return;
    return () => {
      if (handedOffPhoto.current !== savedPhoto) releaseCapturedPhoto(savedPhoto);
    };
  }, [savedPhoto]);

  function scrollToTop() {
    const top = topRef.current;
    if (top && top.getBoundingClientRect().top < 0) top.scrollIntoView({ block: "start" });
  }

  /** Opens a screen. */
  function go(next: ListScreen, nextNotice: ListNotice | null = null) {
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

  function startVisit(saved: SavedPlace, photo: CapturedPhoto) {
    if (!onStartVisit) return;
    // The photo goes on to Add Visit; the page lets it go when the visit is saved or put aside.
    handedOffPhoto.current = photo;
    setScreen({ name: "home" });
    setNotice(null);
    onStartVisit({ seatId, test, customerId: saved.customerId, customerName: saved.customerName, photo, validatedAtMs: saved.savedAtMs });
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

    switch (screen.name) {
      case "customer":
        body = (
          <CustomerScreen
            {...base}
            customerId={screen.customerId}
            notice={notice}
            onBack={home}
            onNotice={showNotice}
            onOpen={(next) => go(next)}
          />
        );
        break;
      case "validate":
        body = (
          <ValidateScreen
            {...base}
            key={`validate-${screen.contactCrmId}`}
            onAddPlaceInstead={addPlaceInstead}
            onBack={home}
            onSaved={placeSaved}
            subject={{ mode: "reference", contactCrmId: screen.contactCrmId }}
          />
        );
        break;
      case "new":
        body = <ValidateScreen {...base} key="new" onAddPlaceInstead={addPlaceInstead} onBack={home} onSaved={placeSaved} subject={{ mode: "new" }} />;
        break;
      case "restore": {
        const { customerId, from } = screen;
        body = (
          <ValidateScreen
            {...base}
            backLabel={from === "customer" ? "Customer" : "List"}
            key={`restore-${customerId}`}
            onAddPlaceInstead={addPlaceInstead}
            onBack={from === "customer" ? () => openCustomer(customerId) : home}
            onSaved={placeSaved}
            subject={{ mode: "restore", customerId }}
          />
        );
        break;
      }
      case "add-place": {
        const { customerId } = screen;
        body = (
          <AddPlaceScreen
            {...base}
            customerId={customerId}
            initialDraft={screen.draft}
            key={`add-place-${customerId}`}
            onBack={() => {
              // The draft may hold a photo taken on Add a new customer; this screen let it go already.
              openCustomer(customerId);
            }}
            onSaved={placeSaved}
          />
        );
        break;
      }
      case "edit-place": {
        const { customerId, placeId } = screen;
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
      case "grade": {
        const { customerId } = screen;
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
      case "drop": {
        const { contactCrmId, customerId } = screen;
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
        const { photo, saved } = screen;
        body = (
          <SavedScreen
            onBack={home}
            onOpenCustomer={() => openCustomer(saved.customerId)}
            onStartVisit={onStartVisit ? () => startVisit(saved, photo) : null}
            photo={photo}
            saved={saved}
            view={view}
          />
        );
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
  query: string;
  season: PhoenixCrmSeason | null;
  section: ListSection | null;
  seatId: string;
  setQuery: (next: string) => void;
  setSeason: (next: PhoenixCrmSeason) => void;
  setSection: (next: ListSection) => void;
  setTypeFilter: (next: TypeFilter) => void;
  setWeekday: (next: number) => void;
  test: boolean;
  typeFilter: TypeFilter;
  view: TerritoryListView;
  weekday: number | null;
}) {
  const toValidate = view.reference.filter((entry) => entry.state === "open" || entry.state === "drop_pending");
  const active = view.customers.filter((customer) => customer.status === "active");
  const dropped = view.customers.filter((customer) => customer.status === "dropped");
  const waiting = view.requests.filter((request) => request.status === "pending");
  const hasReference = view.reference.length > 0;

  const defaultSection: ListSection =
    view.canEdit && hasReference && toValidate.length > 0 ? "validate" : view.canReview && waiting.length > 0 ? "requests" : "customers";
  const current: ListSection = section === "validate" && !hasReference ? "customers" : (section ?? defaultSection);

  const needle = query.trim().toLowerCase();
  const typeMatches = (listType: PhoenixCrmListType) => typeFilter === "all" || typeFilter === listType;

  const sectionOptions = [
    ...(hasReference
      ? [{ value: "validate" as const, label: "To validate", note: toValidate.length > 0 ? `${countText(toValidate.length)} to go` : "All done" }]
      : []),
    { value: "customers" as const, label: "Customers", note: pairText(countByType(active)) },
    { value: "timetable" as const, label: "Timetable", note: "Who receives when" },
    { value: "requests" as const, label: "Requests", note: waiting.length > 0 ? `${countText(waiting.length)} waiting` : "None waiting" },
    { value: "left" as const, label: "Left the list", note: countText(dropped.length) },
  ];

  return (
    <CrmPanel
      actions={
        view.canEdit ? (
          <CrmButton onClick={() => onOpen({ name: "new" })} variant="primary">
            <Plus aria-hidden className="h-4 w-4" />
            Add a new customer
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

      <ReadinessBlock toValidate={toValidate} view={view} />

      <CrmBlock className="border-t border-slate-100" title="Which part of the list">
        <CrmChoice columns={3} label="Which part of the list" onChange={setSection} options={sectionOptions} value={current} />
      </CrmBlock>

      {current !== "requests" ? (
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
                  { value: "PM", label: "Doctors" },
                  { value: "AM", label: "Accounts" },
                ]}
                value={typeFilter}
              />
            </CrmField>
          </div>
        </CrmBlock>
      ) : null}

      {current === "validate" ? (
        <ToValidateSection
          entries={toValidate
            .filter((entry) => typeMatches(entry.listType) && matchesQuery(needle, [entry.name, entry.speciality, entry.address, entry.zone, entry.city]))
            .sort(byTypeThenName)}
          filtered={Boolean(needle) || typeFilter !== "all"}
          onOpen={onOpen}
          view={view}
        />
      ) : null}

      {current === "customers" ? (
        <CustomersSection
          customers={active.filter((customer) => typeMatches(customer.listType) && customerMatches(needle, customer)).sort(byTypeThenName)}
          filtered={Boolean(needle) || typeFilter !== "all"}
          onOpen={onOpen}
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

      {current === "left" ? (
        <LeftSection
          customers={dropped
            .filter((customer) => typeMatches(customer.listType) && customerMatches(needle, customer))
            .sort((left, right) => right.statusChangedAt.localeCompare(left.statusChangedAt))}
          filtered={Boolean(needle) || typeFilter !== "all"}
          onOpen={onOpen}
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
    ...customer.places.flatMap((place) => [place.label, place.address, place.zone, place.brickName]),
  ]);
}

function ReadinessBlock({ toValidate, view }: { toValidate: ReadonlyArray<ListReferenceEntry>; view: TerritoryListView }) {
  const { readiness } = view;
  const toGo = readiness.open + readiness.dropPending;

  if (view.reference.length === 0) {
    return (
      <CrmBlock>
        <CrmNote title="No iReports360 list for this territory" tone="info">
          {view.canEdit
            ? "Add the territory's customers as new customers: a live photo at the clinic, the location and the days and hours. Weekly plans use the customers on this list."
            : "The rep adds the territory's customers as new customers, each with a live photo at the clinic, the location and the days and hours."}
        </CrmNote>
      </CrmBlock>
    );
  }

  const reference = countByType(view.reference);
  return (
    <CrmBlock title="The list">
      <CrmStatGrid>
        <CrmStat label="Reference list" note={pairText(reference)} value={countText(readiness.total)} />
        <CrmStat label="Validated" note={`of ${countText(readiness.total)}`} tone={readiness.validated > 0 ? "good" : "neutral"} value={countText(readiness.validated)} />
        <CrmStat
          label="To validate"
          note={pairText(countByType(toValidate))}
          tone={toGo > 0 ? "warn" : "good"}
          value={countText(toGo)}
        />
        <CrmStat label="Drops waiting" note={`${plural(readiness.dropped, "customer", "customers")} dropped`} value={countText(readiness.dropPending)} />
      </CrmStatGrid>

      <div className="mt-3 grid gap-2">
        {readiness.ready ? (
          <CrmNote title="The list is ready" tone="good">
            {readiness.readyAt ? `Ready since ${cairoStamp(readiness.readyAt)}. ` : null}
            Weekly plans can start. Customers who appear on the reference list later show under To validate.
          </CrmNote>
        ) : (
          <CrmNote title="Weekly plans start when the list is ready" tone="warn">
            {view.canEdit
              ? "Validate each reference customer at the clinic, or ask to drop the ones who should not stay."
              : "The rep validates each reference customer at the clinic, or asks to drop the ones who should not stay."}{" "}
            {plural(toGo, "customer", "customers")} to go
            {readiness.dropPending > 0 ? `, ${countText(readiness.dropPending)} of them waiting for a drop decision` : ""}.
          </CrmNote>
        )}
        {view.referenceSource && !view.referenceSource.isCurrent ? (
          <CrmNote tone="info">
            This reference list is the one {view.referenceSource.name ?? "the previous rep"} worked in iReports360. The list stays with the territory.
          </CrmNote>
        ) : null}
      </div>
    </CrmBlock>
  );
}

function referenceAddress(entry: ListReferenceEntry): string | null {
  const parts = [entry.address, entry.zone, entry.city].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" · ") : null;
}

function lastVisitText(entry: ListReferenceEntry): string {
  return entry.lastVisitedOn ? dayLabelWithYear(entry.lastVisitedOn) : "None recorded";
}

function ToValidateSection({
  entries,
  filtered,
  onOpen,
  view,
}: {
  entries: ReadonlyArray<ListReferenceEntry>;
  filtered: boolean;
  onOpen: (screen: ListScreen) => void;
  view: TerritoryListView;
}) {
  if (entries.length === 0) {
    return (
      <div className="border-t border-slate-100">
        {filtered ? (
          <CrmEmpty message="Clear the search or show all customers." title="No customer to validate matches" />
        ) : (
          <CrmEmpty message="Every reference customer is validated or has left the list." title="Every reference customer is done" />
        )}
      </div>
    );
  }

  const actions = (entry: ListReferenceEntry) =>
    view.canEdit ? (
      <>
        <CrmButton onClick={() => onOpen({ name: "validate", contactCrmId: entry.contactCrmId })} size="sm" variant="primary">
          Validate
        </CrmButton>
        {entry.state === "open" ? (
          <CrmButton onClick={() => onOpen({ name: "drop", customerId: null, contactCrmId: entry.contactCrmId })} size="sm">
            Ask to drop
          </CrmButton>
        ) : null}
      </>
    ) : null;

  return (
    <div className="border-t border-slate-100">
      <CrmCardsOnPhone>
        {entries.map((entry) => (
          <CrmCard
            accent={entry.state === "drop_pending" ? "border-l-slate-300" : "border-l-amber-500"}
            actions={actions(entry)}
            key={entry.contactCrmId}
            meta={customerMetaText(entry)}
            status={entry.state === "drop_pending" ? <CrmPill tone="warn">Drop waiting</CrmPill> : null}
            title={entry.name}
          >
            <p className="break-words text-xs font-semibold leading-5 text-slate-600">{referenceAddress(entry) ?? "No address in iReports360"}</p>
            <p className="break-words text-xs font-semibold leading-5 text-slate-500">Last visit in iReports360: {lastVisitText(entry)}</p>
          </CrmCard>
        ))}
      </CrmCardsOnPhone>
      <CrmTable columns={["34%", "30%", "14%", "22%"]}>
        <thead>
          <tr>
            <th className={crmThClassName} scope="col">
              Customer
            </th>
            <th className={crmThClassName} scope="col">
              Address in iReports360
            </th>
            <th className={crmThClassName} scope="col">
              Last visit
            </th>
            <th className={crmThClassName} scope="col">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.contactCrmId}>
              <td className={crmTdClassName}>
                <p className="font-black text-slate-950">{entry.name}</p>
                <p className="mt-0.5 text-xs text-slate-500">{customerMetaText(entry)}</p>
                {entry.state === "drop_pending" ? (
                  <div className="mt-1">
                    <CrmPill tone="warn">Drop waiting</CrmPill>
                  </div>
                ) : null}
              </td>
              <td className={crmTdClassName}>{referenceAddress(entry) ?? "—"}</td>
              <td className={crmTdClassName}>{lastVisitText(entry)}</td>
              <td className={crmTdClassName}>
                <div className="flex flex-wrap gap-2">{actions(entry)}</div>
              </td>
            </tr>
          ))}
        </tbody>
      </CrmTable>
    </div>
  );
}

function CustomerPills({ customer }: { customer: ListCustomer }) {
  const standing = monthStanding(customer.visitsThisMonth, customer.target);
  return (
    <>
      <CrmPill tone={standing.tone}>{standing.label}</CrmPill>
      {customer.origin === "new" ? <CrmPill tone="orange">New customer</CrmPill> : null}
      {customer.pendingGradeRequestId ? (
        <CrmPill tone="info">{customer.pendingGrade ? `Grade ${customer.pendingGrade} proposed` : "Grade proposed"}</CrmPill>
      ) : null}
      {customer.pendingDropRequestId ? <CrmPill tone="warn">Drop waiting</CrmPill> : null}
    </>
  );
}

function CustomersSection({
  customers,
  filtered,
  onOpen,
  view,
}: {
  customers: ReadonlyArray<ListCustomer>;
  filtered: boolean;
  onOpen: (screen: ListScreen) => void;
  view: TerritoryListView;
}) {
  if (customers.length === 0) {
    return (
      <div className="border-t border-slate-100">
        {filtered ? (
          <CrmEmpty message="Clear the search or show all customers." title="No customer matches" />
        ) : (
          <CrmEmpty
            message={
              view.canEdit
                ? "A customer shows here once validated at the clinic with a live photo, the location and the days and hours."
                : "A customer shows here once the rep validates it at the clinic."
            }
            title="No customers validated yet"
          />
        )}
      </div>
    );
  }

  const open = (customer: ListCustomer) => onOpen({ name: "customer", customerId: customer.customerId });

  return (
    <div className="border-t border-slate-100">
      <ul className="divide-y divide-slate-100 md:hidden">
        {customers.map((customer) => (
          <li key={customer.customerId}>
            <button className="block w-full min-w-0 px-4 py-3.5 text-left transition hover:bg-slate-50" onClick={() => open(customer)} type="button">
              <span className="block break-words text-sm font-black text-slate-950">{customer.name}</span>
              <span className="mt-0.5 block break-words text-xs font-semibold text-slate-500">{customerMetaText(customer)}</span>
              <span className="mt-1.5 flex flex-wrap gap-1">
                <CustomerPills customer={customer} />
              </span>
              <span className="mt-1.5 block break-words text-xs font-semibold leading-5 text-slate-600">{placesDaysText(customer)}</span>
              <span className="mt-0.5 block text-xs font-semibold text-slate-500">{monthVisitsText(customer.visitsThisMonth, customer.target)}</span>
            </button>
          </li>
        ))}
      </ul>
      <CrmTable columns={["32%", "36%", "20%", "12%"]}>
        <thead>
          <tr>
            <th className={crmThClassName} scope="col">
              Customer
            </th>
            <th className={crmThClassName} scope="col">
              Places and days
            </th>
            <th className={crmThClassName} scope="col">
              This month
            </th>
            <th className={crmThClassName} scope="col">
              <span className="sr-only">Open</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {customers.map((customer) => (
            <tr key={customer.customerId}>
              <td className={crmTdClassName}>
                <p className="font-black text-slate-950">{customer.name}</p>
                <p className="mt-0.5 text-xs text-slate-500">{customerMetaText(customer)}</p>
              </td>
              <td className={crmTdClassName}>{placesDaysText(customer)}</td>
              <td className={crmTdClassName}>
                <div className="flex flex-wrap gap-1">
                  <CustomerPills customer={customer} />
                </div>
                <p className="mt-1 text-xs text-slate-500">{monthVisitsText(customer.visitsThisMonth, customer.target)}</p>
              </td>
              <td className={crmTdClassName}>
                <CrmButton onClick={() => open(customer)} size="sm">
                  Open
                </CrmButton>
              </td>
            </tr>
          ))}
        </tbody>
      </CrmTable>
    </div>
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
                  option === day ? "border-orange-500 bg-orange-600 text-white" : "border-slate-200 bg-white text-slate-700 hover:border-slate-300",
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
          title={`${PHOENIX_CRM_LIST_LABEL[group.listType]} · ${group.listType} · ${dayName}${ramadan ? " in Ramadan" : ""}`}
        >
          {group.rows.length === 0 ? (
            <p className="text-sm font-medium text-slate-500">
              No {PHOENIX_CRM_LIST_LABEL[group.listType].toLowerCase()} receive on {dayName}
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
          canDecide={view.canReview}
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

function LeftSection({
  customers,
  filtered,
  onOpen,
  view,
}: {
  customers: ReadonlyArray<ListCustomer>;
  filtered: boolean;
  onOpen: (screen: ListScreen) => void;
  view: TerritoryListView;
}) {
  if (customers.length === 0) {
    return (
      <div className="border-t border-slate-100">
        {filtered ? (
          <CrmEmpty message="Clear the search or show all customers." title="No customer matches" />
        ) : (
          <CrmEmpty message="A customer shows here after the district manager approves its drop." title="No customer has left the list" />
        )}
      </div>
    );
  }
  return (
    <div className="divide-y divide-slate-100 border-t border-slate-100">
      {customers.map((customer) => (
        <CrmCard
          actions={
            <>
              {view.canEdit ? (
                <CrmButton onClick={() => onOpen({ name: "restore", customerId: customer.customerId, from: "list" })} size="sm" variant="primary">
                  Bring back to the list
                </CrmButton>
              ) : null}
              <CrmButton onClick={() => onOpen({ name: "customer", customerId: customer.customerId })} size="sm">
                Open
              </CrmButton>
            </>
          }
          key={customer.customerId}
          meta={customerMetaText(customer)}
          title={customer.name}
        >
          <p className="break-words text-xs font-semibold leading-5 text-slate-700">
            <span className="font-black text-slate-800">Reason: </span>
            {customer.droppedReason ?? "Not recorded"}
          </p>
          {customer.droppedNote ? <p className="whitespace-pre-line break-words text-xs font-semibold leading-5 text-slate-600">{customer.droppedNote}</p> : null}
          <p className="break-words text-xs font-semibold leading-5 text-slate-500">Left the list {cairoStamp(customer.statusChangedAt)}</p>
        </CrmCard>
      ))}
    </div>
  );
}
