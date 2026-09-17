"use client";

/**
 * Phoenix CRM — the Visits tab: a territory's visits of a day, and Add Visit.
 *
 * Owner, 2026-09-16:
 *   - the rep enters visits; a district manager normally goes out on a double visit that the rep
 *     enters, and it counts for the manager too; a chain visit adds a senior manager (regional or
 *     national); both count straight away, with no confirmation step;
 *   - each visit records who was on it, the products discussed, a comment, and a live photo of the
 *     clinic sign or door with the location, checked against the customer's validated place;
 *   - a visit saved far from the validated place still saves, flagged for the manager.
 *
 * Visits are entered on the day, at the clinic, so earlier days are read only. Doctors (PM) and
 * accounts (AM) are counted apart on every figure and never added together (owner rule: the call rate
 * is never combined).
 */

import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Plus, Search } from "lucide-react";

import { crmPost, crmUrl, errorCodeOf, messageOf, newClientId, useCrmGet } from "@/components/phoenix-crm/api";
import { cairoClock, cairoStamp, dayLabelLong, plural, shiftIsoDay } from "@/components/phoenix-crm/format";
import { customerMetaText, listText, monthVisitsText, territoryLine } from "@/components/phoenix-crm/labels";
import { LivePhotoCapture, releaseCapturedPhoto, type CapturedPhoto } from "@/components/phoenix-crm/live-photo-capture";
import { CrmPhotoThumb } from "@/components/phoenix-crm/photo";
import {
  CrmBackBar,
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
  crmTextareaClassName,
  crmThClassName,
  type CrmChoiceOption,
  type PillTone,
} from "@/components/phoenix-crm/ui";
import { ZoomablePhoto } from "@/components/ui/zoomable-photo";
import { isIsoDay } from "@/lib/phoenix-crm/calendar";
import { VISIT_COMMENT_MAX, VISIT_PRODUCTS_MAX } from "@/lib/phoenix-crm/entry-rules";
import { PHOENIX_CRM_LIST_LABEL, type PhoenixCrmListType, type PhoenixCrmVisitKind } from "@/lib/phoenix-crm/types";
import type {
  SavedVisit,
  VisitCustomerOption,
  VisitDayView,
  VisitFormView,
  VisitLocationFlag,
  VisitPerson,
  VisitRow,
} from "@/lib/phoenix-crm/view-types";
import { cn } from "@/lib/utils";

/**
 * A customer just validated on the List tab, handed to Add Visit with the photo it was validated
 * with: the rep is standing at the clinic, so that photo stands for today's visit.
 */
export type PendingVisit = {
  seatId: string;
  test: boolean;
  customerId: string;
  customerName: string;
  photo: CapturedPhoto;
  /** The phone's Date.now() when the validation saved. */
  validatedAtMs: number;
};

/**
 * The database lets a validation photo stand for a visit for 30 minutes after the place is saved; the
 * phone stops offering it two minutes sooner, so a save sent at minute 29 is not refused in flight.
 */
const REUSE_WINDOW_MS = 28 * 60 * 1000;

/** The sentence describeDayWindows gives a place that does not receive on the day. */
const NOT_RECEIVING = "Does not receive this day";

const LOCATION_PILL: Record<VisitLocationFlag, { label: string; tone: PillTone }> = {
  ok: { label: "At the place", tone: "good" },
  far: { label: "Far from the place", tone: "warn" },
  weak_gps: { label: "Weak location", tone: "warn" },
  no_place: { label: "No place to compare", tone: "neutral" },
};

function isFlagged(flag: VisitLocationFlag): boolean {
  return flag === "far" || flag === "weak_gps";
}

// ── A day's visits ──────────────────────────────────────────────────────────────────────────────

function visitPeople(visit: VisitRow): Array<{ name: string; role: string }> {
  const people: Array<{ name: string; role: string }> = [];
  if (visit.repName) people.push({ name: visit.repName, role: "Rep" });
  if (visit.managerName) people.push({ name: visit.managerName, role: "Manager" });
  if (visit.seniorName) people.push({ name: visit.seniorName, role: "Senior manager" });
  return people;
}

/** A visit a manager entered for the rep's territory says so; the rep's own entries need no line. */
function enteredByOther(visit: VisitRow): boolean {
  return visit.repName !== null && visit.enteredByName !== visit.repName;
}

function dayFigures(visits: ReadonlyArray<VisitRow>) {
  const count = (listType: PhoenixCrmListType, match: (visit: VisitRow) => boolean) =>
    visits.filter((visit) => visit.listType === listType && match(visit)).length;
  const any = () => true;
  const paired = (visit: VisitRow) => visit.kind !== "single";
  const flagged = (visit: VisitRow) => isFlagged(visit.locationFlag);
  return {
    pm: count("PM", any),
    am: count("AM", any),
    pairedPm: count("PM", paired),
    pairedAm: count("AM", paired),
    flaggedPm: count("PM", flagged),
    flaggedAm: count("AM", flagged),
  };
}

function LocationPills({ visit }: { visit: VisitRow }) {
  const location = LOCATION_PILL[visit.locationFlag];
  return (
    <>
      <CrmPill tone={location.tone}>{location.label}</CrmPill>
      {visit.clockOff ? <CrmPill tone="warn">Phone clock off</CrmPill> : null}
    </>
  );
}

function VisitDetails({ visit }: { visit: VisitRow }) {
  const people = visitPeople(visit);
  return (
    <div className="grid min-w-0 flex-1 gap-1.5 text-xs font-semibold leading-5 text-slate-600">
      {people.length > 0 ? (
        <p className="break-words">
          <span className="font-black text-slate-800">On the visit: </span>
          {people.map((person) => `${person.name} (${person.role})`).join(", ")}
        </p>
      ) : null}
      <p className="break-words">
        <span className="font-black text-slate-800">Products: </span>
        {visit.products.join(", ") || "—"}
      </p>
      {visit.comment ? (
        <p className="whitespace-pre-line break-words">
          <span className="font-black text-slate-800">Comment: </span>
          {visit.comment}
        </p>
      ) : null}
      <p className="break-words">{visit.locationLabel}</p>
      {enteredByOther(visit) ? <p className="break-words">Entered by {visit.enteredByName}</p> : null}
    </div>
  );
}

function VisitCard({ visit }: { visit: VisitRow }) {
  return (
    <CrmCard
      accent={isFlagged(visit.locationFlag) ? "border-l-amber-500" : "border-l-orange-500"}
      meta={`${cairoClock(visit.capturedAt)} · ${listText(visit.listType)} · ${visit.kindLabel}`}
      status={<LocationPills visit={visit} />}
      title={visit.customerName}
    >
      <div className="flex min-w-0 items-start gap-3">
        <CrmPhotoThumb
          alt={`Visit photo: ${visit.customerName}`}
          caption={`${visit.customerName} · ${cairoStamp(visit.capturedAt)}`}
          path={visit.photoPath}
        />
        <VisitDetails visit={visit} />
      </div>
    </CrmCard>
  );
}

function VisitTable({ visits }: { visits: ReadonlyArray<VisitRow> }) {
  return (
    <CrmTable columns={["11%", "21%", "22%", "22%", "14%", "10%"]}>
      <thead>
        <tr>
          <th className={crmThClassName} scope="col">
            Time
          </th>
          <th className={crmThClassName} scope="col">
            Customer
          </th>
          <th className={crmThClassName} scope="col">
            On the visit
          </th>
          <th className={crmThClassName} scope="col">
            Products and comment
          </th>
          <th className={crmThClassName} scope="col">
            Location
          </th>
          <th className={crmThClassName} scope="col">
            Photo
          </th>
        </tr>
      </thead>
      <tbody>
        {visits.map((visit) => {
          const people = visitPeople(visit);
          return (
            <tr key={visit.visitId}>
              <td className={crmTdClassName}>
                <span className="block font-black text-slate-900">{cairoClock(visit.capturedAt)}</span>
                <span className="mt-0.5 block text-xs text-slate-500">{visit.kindLabel}</span>
              </td>
              <td className={crmTdClassName}>
                <span className="block font-black text-slate-900">{visit.customerName}</span>
                <span className="mt-0.5 block text-xs text-slate-500">{listText(visit.listType)}</span>
              </td>
              <td className={crmTdClassName}>
                {people.map((person) => (
                  <span className="block" key={`${person.role}-${person.name}`}>
                    {person.name}
                    <span className="text-xs text-slate-500"> · {person.role}</span>
                  </span>
                ))}
                {enteredByOther(visit) ? <span className="mt-1 block text-xs text-slate-500">Entered by {visit.enteredByName}</span> : null}
              </td>
              <td className={crmTdClassName}>
                <span className="block">{visit.products.join(", ") || "—"}</span>
                {visit.comment ? <span className="mt-1 block whitespace-pre-line text-xs text-slate-500">{visit.comment}</span> : null}
              </td>
              <td className={crmTdClassName}>
                <span className="flex flex-wrap gap-1">
                  <LocationPills visit={visit} />
                </span>
                <span className="mt-1 block text-xs text-slate-500">{visit.locationLabel}</span>
              </td>
              <td className={crmTdClassName}>
                <CrmPhotoThumb
                  alt={`Visit photo: ${visit.customerName}`}
                  caption={`${visit.customerName} · ${cairoStamp(visit.capturedAt)}`}
                  className="h-14 w-14"
                  path={visit.photoPath}
                />
              </td>
            </tr>
          );
        })}
      </tbody>
    </CrmTable>
  );
}

function SavedNote({ customerName, visit }: { customerName: string; visit: SavedVisit }) {
  if (visit.duplicate) {
    return (
      <CrmNote title={customerName} tone="info">
        This visit was already saved, at {cairoClock(visit.capturedAt)}.
      </CrmNote>
    );
  }
  const flagged = isFlagged(visit.locationFlag);
  return (
    <CrmNote title={`Visit saved: ${customerName}`} tone={flagged ? "warn" : "good"}>
      {cairoClock(visit.capturedAt)} · {visit.locationLabel}
      {flagged ? ". The visit is saved with this flag." : ""}
    </CrmNote>
  );
}

export function VisitsTab({
  cairoToday,
  onPendingVisitDone,
  onWorkChange,
  pendingVisit,
  seatId,
  test,
}: {
  cairoToday: string;
  /** The hand-off from the List tab was used or abandoned. */
  onPendingVisitDone: () => void;
  /** Add Visit opened or closed: the page keeps this tab as it is while another tab is open. */
  onWorkChange?: (working: boolean) => void;
  pendingVisit: PendingVisit | null;
  seatId: string;
  test: boolean;
}) {
  const [date, setDate] = useState(cairoToday);
  const [adding, setAdding] = useState(false);
  const [saved, setSaved] = useState<{ visit: SavedVisit; customerName: string } | null>(null);
  const day = useCrmGet<VisitDayView>(crmUrl("/api/phoenix-crm/visits", { date, seatId, test }), "day");

  const handoff = pendingVisit && pendingVisit.seatId === seatId && pendingVisit.test === test ? pendingVisit : null;
  const working = adding || handoff !== null;

  useEffect(() => {
    onWorkChange?.(working);
  }, [onWorkChange, working]);

  function moveTo(next: string) {
    if (!isIsoDay(next) || next > cairoToday) return;
    setSaved(null);
    setDate(next);
  }

  if (adding || handoff) {
    return (
      <AddVisit
        handoff={handoff}
        onClose={() => {
          setAdding(false);
          if (handoff) onPendingVisitDone();
        }}
        onSaved={(visit, customerName) => {
          setAdding(false);
          if (handoff) onPendingVisitDone();
          setSaved({ visit, customerName });
          setDate(visit.visitDate);
          day.reload();
        }}
        seatId={seatId}
        test={test}
      />
    );
  }

  const view = day.data;
  const visits = view?.visits ?? [];
  const figures = dayFigures(visits);
  const isToday = date === cairoToday;
  const addButton = view?.canAdd ? (
    <CrmButton
      onClick={() => {
        setSaved(null);
        setAdding(true);
      }}
      variant="primary"
    >
      <Plus aria-hidden className="h-4 w-4" />
      Add a visit
    </CrmButton>
  ) : null;

  return (
    <CrmPanel
      actions={addButton}
      description={view ? territoryLine(view.territory) : null}
      eyebrow="Visits"
      title={
        <span className="inline-flex flex-wrap items-center gap-2">
          <span>{dayLabelLong(date)}</span>
          {isToday ? <CrmPill tone="orange">Today</CrmPill> : null}
        </span>
      }
    >
      <CrmBlock className="border-b border-slate-100">
        <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 sm:max-w-md">
          <CrmButton aria-label="Previous day" onClick={() => moveTo(shiftIsoDay(date, -1))}>
            <ChevronLeft aria-hidden className="h-4 w-4" />
          </CrmButton>
          <input
            aria-label="Day"
            className={cn(crmInputClassName, "appearance-none")}
            max={cairoToday}
            onChange={(event) => moveTo(event.target.value)}
            type="date"
            value={date}
          />
          <CrmButton aria-label="Next day" disabled={isToday} onClick={() => moveTo(shiftIsoDay(date, 1))}>
            <ChevronRight aria-hidden className="h-4 w-4" />
          </CrmButton>
        </div>
        {isToday ? null : (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <CrmButton onClick={() => moveTo(cairoToday)} size="sm">
              Back to today
            </CrmButton>
            <span className="text-xs font-semibold text-slate-500">Visits are added on the day, at the clinic.</span>
          </div>
        )}
      </CrmBlock>

      {saved ? (
        <div className="px-4 pt-4 sm:px-5">
          <SavedNote customerName={saved.customerName} visit={saved.visit} />
        </div>
      ) : null}

      {!view && day.error ? <CrmLoadError message={day.error} onRetry={day.reload} /> : null}
      {!view && !day.error ? <CrmLoading label="Loading the day's visits" /> : null}

      {view ? (
        <>
          {day.error ? <CrmLoadError message={day.error} onRetry={day.reload} /> : null}
          <CrmBlock>
            <CrmStatGrid>
              <CrmStat label="Doctors visited · PM" note={plural(figures.pairedPm, "double or chain visit", "double or chain visits")} value={figures.pm} />
              <CrmStat label="Accounts visited · AM" note={plural(figures.pairedAm, "double or chain visit", "double or chain visits")} value={figures.am} />
              <CrmStat
                label="Doctors flagged · PM"
                note="Far from the place or weak location"
                tone={figures.flaggedPm > 0 ? "warn" : "neutral"}
                value={figures.flaggedPm}
              />
              <CrmStat
                label="Accounts flagged · AM"
                note="Far from the place or weak location"
                tone={figures.flaggedAm > 0 ? "warn" : "neutral"}
                value={figures.flaggedAm}
              />
            </CrmStatGrid>
          </CrmBlock>
          {visits.length === 0 ? (
            <CrmEmpty
              action={addButton}
              message={view.canAdd ? "Add each visit at the clinic, with a live photo of the sign or door." : null}
              title={isToday ? "No visits yet today" : "No visits this day"}
            />
          ) : (
            <div className="border-t border-slate-100">
              <CrmCardsOnPhone>
                {visits.map((visit) => (
                  <VisitCard key={visit.visitId} visit={visit} />
                ))}
              </CrmCardsOnPhone>
              <VisitTable visits={visits} />
            </div>
          )}
        </>
      ) : null}
    </CrmPanel>
  );
}

// ── Add Visit ───────────────────────────────────────────────────────────────────────────────────

function PlaceWindows({ customer }: { customer: VisitCustomerOption }) {
  return (
    <span className="mt-1 grid gap-0.5">
      {customer.places.map((place, index) => {
        const where = customer.places.length > 1 ? `${place.label ?? place.address ?? `Place ${index + 1}`}: ` : "";
        const receiving = place.todayWindows !== NOT_RECEIVING;
        return (
          <span className={cn("block break-words text-xs font-semibold", receiving ? "text-emerald-700" : "text-slate-500")} key={place.placeId}>
            {where}
            {receiving ? `Receives today ${place.todayWindows}` : place.todayWindows}
          </span>
        );
      })}
    </span>
  );
}

function CustomerPicker({
  customers,
  disabled,
  onPick,
  selectedId,
}: {
  customers: ReadonlyArray<VisitCustomerOption>;
  disabled: boolean;
  onPick: (customerId: string) => void;
  selectedId: string | null;
}) {
  const [query, setQuery] = useState("");
  const [listType, setListType] = useState<"all" | PhoenixCrmListType>("all");
  const needle = query.trim().toLowerCase();
  const shown = customers.filter(
    (customer) =>
      (listType === "all" || customer.listType === listType) &&
      (!needle || customer.name.toLowerCase().includes(needle) || (customer.speciality ?? "").toLowerCase().includes(needle)),
  );
  const planned = customers.filter((customer) => customer.plannedToday).length;

  return (
    <div className="grid min-w-0 gap-3">
      <div className="relative min-w-0">
        <Search aria-hidden className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-slate-400" />
        <input
          aria-label="Search customers"
          className={cn(crmInputClassName, "appearance-none pl-9")}
          disabled={disabled}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search by name or speciality"
          type="search"
          value={query}
        />
      </div>
      <CrmChoice
        columns={3}
        label="Which customers"
        onChange={setListType}
        options={[
          { value: "all", label: "All" },
          { value: "PM", label: PHOENIX_CRM_LIST_LABEL.PM },
          { value: "AM", label: PHOENIX_CRM_LIST_LABEL.AM },
        ]}
        value={listType}
      />
      {planned > 0 ? <p className="text-xs font-semibold text-slate-500">Customers on today&apos;s plan come first.</p> : null}
      {shown.length === 0 ? (
        <p className="border border-dashed border-slate-200 px-3 py-4 text-center text-sm font-semibold text-slate-500">No customer matches.</p>
      ) : (
        <ul className="grid gap-1.5">
          {shown.map((customer) => {
            const selected = customer.customerId === selectedId;
            return (
              <li key={customer.customerId}>
                <button
                  aria-pressed={selected}
                  className={cn(
                    "block w-full min-w-0 rounded-none border px-3 py-2.5 text-left transition disabled:cursor-not-allowed disabled:opacity-60",
                    selected ? "border-orange-500 bg-orange-50" : "border-slate-200 bg-white hover:border-slate-300",
                  )}
                  disabled={disabled || customer.visitedToday}
                  onClick={() => onPick(customer.customerId)}
                  type="button"
                >
                  <span className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                    <span className="min-w-0 flex-1">
                      <span className="block break-words text-sm font-black text-slate-950">{customer.name}</span>
                      <span className="mt-0.5 block break-words text-xs font-semibold text-slate-500">{customerMetaText(customer)}</span>
                    </span>
                    <span className="flex max-w-full flex-wrap gap-1">
                      {customer.plannedToday ? <CrmPill tone="orange">On today&apos;s plan</CrmPill> : null}
                      {customer.visitedToday ? <CrmPill tone="good">Visited today</CrmPill> : null}
                    </span>
                  </span>
                  <PlaceWindows customer={customer} />
                  <span className="mt-1 block text-xs font-semibold text-slate-600">{monthVisitsText(customer.visitsThisMonth, customer.target)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

type Participants = {
  options: Array<CrmChoiceOption<PhoenixCrmVisitKind>>;
  /** Entering for the territory as its rep: the managers to choose from. Empty when entering as a manager. */
  managerOptions: VisitPerson[];
  manager: VisitPerson | null;
  seniorOptions: VisitPerson[];
  senior: VisitPerson | null;
};

/** The chosen person, or the only one there is. */
function pickPerson(options: ReadonlyArray<VisitPerson>, hrId: string | null): VisitPerson | null {
  return options.find((person) => person.hrId === hrId) ?? (options.length === 1 ? options[0] : null);
}

/**
 * Who can be on the visit, by the same rule the save applies (resolveVisitParticipants): a rep picks
 * a manager of the territory, and for a chain a senior manager above that manager; a manager entering
 * is the visit's manager, goes with the territory's rep, and for a chain picks a manager above
 * themself.
 */
function participantsOf(form: VisitFormView, kind: PhoenixCrmVisitKind, managerHrId: string | null, seniorHrId: string | null): Participants {
  const people = form.managers;
  if (form.enteredAs === "manager") {
    const me = people.find((person) => person.position === form.viewerPosition) ?? null;
    const rep = form.territory.repHrId && form.territory.repHrId !== me?.hrId ? form.territory.repName : null;
    const seniorOptions = me ? people.filter((person) => person.position > me.position) : [];
    return {
      options: [
        { value: "single", label: "My own visit", note: "Without the rep" },
        { value: "double", label: "Double visit", note: rep ? `With ${rep}` : "This territory has no rep", disabled: !rep },
        {
          value: "chain",
          label: "Chain visit",
          note: !rep ? "This territory has no rep" : seniorOptions.length === 0 ? "No senior manager above you" : `With ${rep} and a senior manager`,
          disabled: !rep || seniorOptions.length === 0,
        },
      ],
      managerOptions: [],
      manager: me,
      seniorOptions,
      senior: pickPerson(seniorOptions, seniorHrId),
    };
  }

  const managerOptions = kind === "chain" ? people.filter((person) => people.some((other) => other.position > person.position)) : people;
  const manager = pickPerson(managerOptions, managerHrId);
  const seniorOptions = manager ? people.filter((person) => person.position > manager.position) : [];
  return {
    options: [
      { value: "single", label: "Single visit", note: "On my own" },
      {
        value: "double",
        label: "Double visit",
        note: people.length > 0 ? "With a manager" : "No manager above this territory",
        disabled: people.length === 0,
      },
      {
        value: "chain",
        label: "Chain visit",
        note: people.length > 1 ? "With a manager and a senior manager" : "Needs a manager and a senior manager above this territory",
        disabled: people.length < 2,
      },
    ],
    managerOptions,
    manager,
    seniorOptions,
    senior: pickPerson(seniorOptions, seniorHrId),
  };
}

function personOptions(people: ReadonlyArray<VisitPerson>): Array<CrmChoiceOption<string>> {
  return people.map((person) => ({ value: person.hrId, label: person.name, note: person.title }));
}

type Draft = { ok: true; payload: Record<string, unknown>; customerName: string } | { ok: false; problem: string };

function AddVisit({
  handoff,
  onClose,
  onSaved,
  seatId,
  test,
}: {
  handoff: PendingVisit | null;
  onClose: () => void;
  onSaved: (visit: SavedVisit, customerName: string) => void;
  seatId: string;
  test: boolean;
}) {
  const resource = useCrmGet<VisitFormView>(crmUrl("/api/phoenix-crm/visits/form", { seatId, test }), "form");
  const form = resource.data;

  const [customerId, setCustomerId] = useState<string | null>(handoff?.customerId ?? null);
  const [picking, setPicking] = useState(!handoff);
  const [kind, setKind] = useState<PhoenixCrmVisitKind>("single");
  const [managerHrId, setManagerHrId] = useState<string | null>(null);
  const [seniorHrId, setSeniorHrId] = useState<string | null>(null);
  const [products, setProducts] = useState<string[]>([]);
  const [comment, setComment] = useState("");
  const [photo, setPhoto] = useState<CapturedPhoto | null>(null);
  const [usePlacePhoto, setUsePlacePhoto] = useState(Boolean(handoff));
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // The visit's id, made on the first press of Save and kept until the visit is saved, so a save sent
  // again after a dropped connection returns the saved visit instead of a second one.
  const visitIdRef = useRef<string | null>(null);

  function close() {
    if (saving) return;
    releaseCapturedPhoto(photo);
    onClose();
  }

  const back = <CrmBackBar backLabel="Visits" onBack={close} title="Add a visit" />;

  if (!form) {
    return (
      <CrmPanel>
        {back}
        {resource.error ? <CrmLoadError message={resource.error} onRetry={resource.reload} /> : <CrmLoading label="Opening Add Visit" />}
      </CrmPanel>
    );
  }

  if (form.blockedReason) {
    return (
      <CrmPanel>
        {back}
        <CrmBlock>
          <CrmNote title="A visit cannot be added here yet" tone="warn">
            {form.blockedReason}
          </CrmNote>
        </CrmBlock>
      </CrmPanel>
    );
  }

  const loaded = form;
  const customer = customerId ? loaded.customers.find((option) => option.customerId === customerId) ?? null : null;
  const placePhoto = handoff && usePlacePhoto && customer && customer.customerId === handoff.customerId ? handoff.photo : null;
  const who = participantsOf(loaded, kind, managerHrId, seniorHrId);
  const commentLength = comment.trim().length;

  function pickCustomer(nextId: string) {
    setProblem(null);
    setPicking(false);
    if (nextId === customerId) return;
    if (photo) {
      // The customer's name is burned into the photo, so a photo taken for another customer is retaken.
      releaseCapturedPhoto(photo);
      setPhoto(null);
    }
    setCustomerId(nextId);
  }

  function toggleProduct(product: string) {
    setProblem(null);
    setProducts((current) =>
      current.includes(product) ? current.filter((entry) => entry !== product) : current.length >= VISIT_PRODUCTS_MAX ? current : [...current, product],
    );
  }

  function draft(visitId: string): Draft {
    if (!customer) return { ok: false, problem: "Choose the customer you visited." };
    if (customer.visitedToday) return { ok: false, problem: "This customer's visit for today is already saved." };
    if (kind !== "single" && !who.manager) {
      return {
        ok: false,
        problem: loaded.enteredAs === "manager" ? "You are not a manager of this territory. Reload the page." : "Choose the manager who was on the visit.",
      };
    }
    if (kind === "chain" && !who.senior) return { ok: false, problem: "Choose the senior manager who was on the visit." };
    if (products.length === 0) return { ok: false, problem: "Choose the products you discussed." };
    const evidence = placePhoto ?? photo;
    if (!evidence) return { ok: false, problem: "Take a live photo of the clinic sign or door." };
    return {
      ok: true,
      customerName: customer.name,
      payload: {
        id: visitId,
        seatId,
        test,
        customerId: customer.customerId,
        kind,
        managerHrId: kind === "single" ? null : (who.manager?.hrId ?? null),
        seniorHrId: kind === "chain" ? (who.senior?.hrId ?? null) : null,
        products,
        comment: comment.trim() || null,
        photoPath: evidence.path,
        lat: evidence.lat,
        lon: evidence.lon,
        accuracyMeters: evidence.accuracyMeters,
        deviceCapturedAt: evidence.deviceCapturedAt,
        ...(placePhoto ? { reusePlacePhoto: true } : {}),
      },
    };
  }

  async function save() {
    if (saving) return;
    if (placePhoto && handoff && Date.now() - handoff.validatedAtMs > REUSE_WINDOW_MS) {
      setUsePlacePhoto(false);
      setProblem("The validation photo stands for a visit only in the first 30 minutes. Take a new photo of the clinic sign or door.");
      return;
    }
    const visitId = visitIdRef.current ?? newClientId();
    const next = draft(visitId);
    if (!next.ok) {
      setProblem(next.problem);
      return;
    }
    visitIdRef.current = visitId;
    setSaving(true);
    setProblem(null);
    try {
      const saved = await crmPost<SavedVisit>("/api/phoenix-crm/visits", next.payload, "visit");
      releaseCapturedPhoto(photo);
      onSaved(saved, next.customerName);
    } catch (error) {
      const code = errorCodeOf(error);
      let message = messageOf(error);
      if (code === "phoenix_crm_photo_not_issued" && placePhoto) {
        setUsePlacePhoto(false);
        message = "The validation photo stands for a visit only in the first 30 minutes. Take a new photo of the clinic sign or door.";
      } else if (code === "phoenix_crm_photo_used" && placePhoto) {
        setUsePlacePhoto(false);
      } else if (code && code.startsWith("phoenix_crm_photo_")) {
        releaseCapturedPhoto(photo);
        setPhoto(null);
      } else if (code === "phoenix_crm_id_conflict") {
        visitIdRef.current = null;
      } else if (
        code === "phoenix_crm_already_visited" ||
        code === "phoenix_crm_customer_dropped" ||
        code === "phoenix_crm_customer_not_found" ||
        code === "phoenix_crm_place_changed"
      ) {
        resource.reload();
      }
      setProblem(message);
      setSaving(false);
    }
  }

  return (
    <CrmPanel>
      {back}
      <CrmBlock>
        <p className="break-words text-sm font-semibold text-slate-600">{territoryLine(loaded.territory)}</p>
      </CrmBlock>

      <CrmBlock className="border-t border-slate-100" title="1 · Customer">
        {customer && !picking ? (
          <div className="flex min-w-0 flex-wrap items-start justify-between gap-3 border border-orange-200 bg-orange-50/50 px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <p className="break-words text-sm font-black text-slate-950">{customer.name}</p>
              <p className="mt-0.5 break-words text-xs font-semibold text-slate-500">{customerMetaText(customer)}</p>
              <PlaceWindows customer={customer} />
              <p className="mt-1 text-xs font-semibold text-slate-600">{monthVisitsText(customer.visitsThisMonth, customer.target)}</p>
              {customer.visitedToday ? (
                <CrmNote className="mt-2" tone="info">
                  This customer&apos;s visit for today is already saved.
                </CrmNote>
              ) : null}
            </div>
            <CrmButton disabled={saving || Boolean(placePhoto)} onClick={() => setPicking(true)} size="sm">
              Change
            </CrmButton>
          </div>
        ) : (
          <>
            {handoff && !customer ? (
              <CrmNote className="mb-3" tone="warn">
                {handoff.customerName} is not on the list of customers to visit. Reload the page, or choose the customer below.
              </CrmNote>
            ) : null}
            <CustomerPicker customers={loaded.customers} disabled={saving} onPick={pickCustomer} selectedId={customerId} />
          </>
        )}
      </CrmBlock>

      <CrmBlock className="border-t border-slate-100" title="2 · Who was on the visit">
        <div className="grid min-w-0 gap-3">
          <CrmChoice
            columns={3}
            label="Who was on the visit"
            onChange={(next) => {
              setProblem(null);
              setKind(next);
            }}
            options={who.options.map((option) => ({ ...option, disabled: option.disabled || saving }))}
            value={kind}
          />
          {kind !== "single" && loaded.enteredAs === "rep" ? (
            <CrmField label="The manager">
              {who.managerOptions.length > 0 ? (
                <CrmChoice
                  columns={2}
                  label="The manager"
                  onChange={(next) => {
                    setProblem(null);
                    setManagerHrId(next);
                    setSeniorHrId(null);
                  }}
                  options={personOptions(who.managerOptions).map((option) => ({ ...option, disabled: saving }))}
                  value={who.manager?.hrId ?? null}
                />
              ) : (
                <p className="text-sm font-semibold text-slate-500">No manager sits above this territory.</p>
              )}
            </CrmField>
          ) : null}
          {kind === "chain" && (loaded.enteredAs === "manager" || who.manager) ? (
            <CrmField label="The senior manager">
              {who.seniorOptions.length > 0 ? (
                <CrmChoice
                  columns={2}
                  label="The senior manager"
                  onChange={(next) => {
                    setProblem(null);
                    setSeniorHrId(next);
                  }}
                  options={personOptions(who.seniorOptions).map((option) => ({ ...option, disabled: saving }))}
                  value={who.senior?.hrId ?? null}
                />
              ) : (
                <p className="text-sm font-semibold text-slate-500">No senior manager sits above the manager you chose.</p>
              )}
            </CrmField>
          ) : null}
        </div>
      </CrmBlock>

      <CrmBlock className="border-t border-slate-100" title="3 · Products discussed">
        <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
          {loaded.products.map((product) => {
            const chosen = products.includes(product);
            return (
              <button
                aria-pressed={chosen}
                className={cn(
                  "min-h-11 min-w-0 break-words rounded-none border px-3 py-2 text-left text-sm font-black transition disabled:cursor-not-allowed disabled:opacity-50",
                  chosen ? "border-orange-500 bg-orange-600 text-white" : "border-slate-200 bg-white text-slate-700 hover:border-slate-300",
                )}
                disabled={saving || (!chosen && products.length >= VISIT_PRODUCTS_MAX)}
                key={product}
                onClick={() => toggleProduct(product)}
                type="button"
              >
                {product}
              </button>
            );
          })}
        </div>
        <p className="mt-2 text-xs font-semibold text-slate-500">
          {products.length === 0 ? `Choose up to ${VISIT_PRODUCTS_MAX}.` : `${products.length} chosen, up to ${VISIT_PRODUCTS_MAX}.`}
        </p>
      </CrmBlock>

      <CrmBlock className="border-t border-slate-100" title="4 · Comment">
        <CrmField
          error={commentLength > VISIT_COMMENT_MAX ? `Keep the comment under ${VISIT_COMMENT_MAX} characters.` : null}
          hint={`Optional · ${commentLength} of ${VISIT_COMMENT_MAX} characters`}
          htmlFor="phoenix-crm-visit-comment"
          label="What happened on the visit"
        >
          <textarea
            className={crmTextareaClassName}
            disabled={saving}
            id="phoenix-crm-visit-comment"
            maxLength={VISIT_COMMENT_MAX}
            onChange={(event) => setComment(event.target.value)}
            value={comment}
          />
        </CrmField>
      </CrmBlock>

      <CrmBlock className="border-t border-slate-100" title="5 · Live photo">
        {placePhoto ? (
          <div className="grid gap-2">
            <span className="block w-full overflow-hidden rounded-none border border-slate-200 bg-slate-950">
              <ZoomablePhoto alt="The photo taken to validate this customer" className="block max-h-[50vh] w-full object-contain" src={placePhoto.previewUrl} />
            </span>
            <p className="break-words text-xs font-semibold text-slate-600">{placePhoto.locationLabel}</p>
            <CrmNote tone="info">The photo you took to validate this customer stands for this visit when you save within 30 minutes of validating.</CrmNote>
            <CrmButton disabled={saving} onClick={() => setUsePlacePhoto(false)} size="sm">
              Take a new photo instead
            </CrmButton>
          </div>
        ) : customer ? (
          <LivePhotoCapture
            disabled={saving}
            hint={`Your location is checked against the customer's validated place. A visit more than ${loaded.rules.visitFarMeters} m away still saves, flagged.`}
            onChange={(next) => {
              setProblem(null);
              setPhoto(next);
            }}
            purpose="visit"
            seatId={seatId}
            test={test}
            title={`Phoenix CRM visit: ${customer.name}`}
            value={photo}
            weakGpsMeters={loaded.rules.weakGpsMeters}
          />
        ) : (
          <p className="text-sm font-semibold text-slate-500">Choose the customer first.</p>
        )}
      </CrmBlock>

      <CrmBlock className="border-t border-slate-100">
        {problem ? (
          <CrmNote className="mb-3" tone="bad">
            {problem}
          </CrmNote>
        ) : null}
        <div className="grid gap-2 sm:flex sm:flex-wrap">
          <CrmButton busy={saving} onClick={() => void save()} variant="primary">
            Save the visit
          </CrmButton>
          <CrmButton disabled={saving} onClick={close}>
            Cancel
          </CrmButton>
        </div>
      </CrmBlock>
    </CrmPanel>
  );
}
