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

import { crmPost, crmUrl, errorCodeOf, messageOf, newClientId, useCrmAction, useCrmGet, type CrmResource } from "@/components/phoenix-crm/api";
import { PHOENIX_CRM_DAY_ACTIVITIES } from "@/lib/phoenix-crm/day-activities";
import { brickTintMap } from "@/components/phoenix-crm/brick-tints";
import { CrmSpeak, type VoiceNoteValue } from "@/components/phoenix-crm/speak";
import { CrmVoiceNotePlayer } from "@/components/phoenix-crm/voice-playback";
import { cairoClock, cairoStamp, countText, dayLabel, dayLabelLong, plural, shiftIsoDay } from "@/components/phoenix-crm/format";
import {
  customerMetaText,
  listText,
  monthVisitsText,
  PENDING_COUNTS_NOTE,
  PENDING_PILL,
  pendingVisitsText,
  territoryLine,
} from "@/components/phoenix-crm/labels";
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
  CrmSelect,
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
import { appendDictated } from "@/lib/phoenix-crm/dictation";
import { PHARMACY_NAME_MAX, VISIT_COMMENT_MAX, VISIT_PRODUCTS_MAX, type ProductAvailability } from "@/lib/phoenix-crm/entry-rules";
import type { PhoenixCrmListType, PhoenixCrmVisitKind } from "@/lib/phoenix-crm/types";
import { UNPLANNED_REASON_MAX, UNPLANNED_REASON_MIN, type VisitTypeChoice } from "@/lib/phoenix-crm/unplanned-rules";
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
  /**
   * The photo the place was just validated with, which may stand for this visit. Null when the rep
   * came straight from a customer's row — he takes the visit's own photo at the door.
   */
  photo: CapturedPhoto | null;
  /** The phone's Date.now() when the validation saved. */
  validatedAtMs: number;
};

/**
 * The other direction: a visit just saved on a customer who is not validated yet, handed BACK to the
 * List tab's Validate screen. It carries no photo by design — validating takes its own live photo of
 * the door, and the visit's photo is the visit's proof, not the place's.
 */
export type PendingValidate = {
  seatId: string;
  test: boolean;
  /** His entry on the territory's iReports360 list: what the Validate screen opens on. */
  contactCrmId: number;
  customerName: string;
};

/**
 * The database lets a validation photo stand for a visit for 30 minutes after the place is saved; the
 * phone stops offering it two minutes sooner, so a save sent at minute 29 is not refused in flight.
 */
const REUSE_WINDOW_MS = 28 * 60 * 1000;

/**
 * Whether the validation photo can no longer stand for the visit, on the phone's clock. Save reads it;
 * it sits outside the screen because the React Compiler counts a clock read inside a screen's
 * handlers as a read during render.
 */
function reuseWindowOver(validatedAtMs: number): boolean {
  return Date.now() - validatedAtMs > REUSE_WINDOW_MS;
}

/** The sentence describeDayWindows gives a place that does not receive on the day. */
const NOT_RECEIVING = "Does not receive this day";

/** Customers the Add Visit picker shows at a time. */
const PICKER_PAGE = 25;

/**
 * The pill on the rep's own visit — the owner's polite sign, 2026-09-26.
 *
 * Neutral, never amber. An alarm colour on a rep's own day is a count of offences he cannot act on,
 * and the usual cause of a distance is a place saved from the wrong doorway, not a rep in the wrong
 * clinic. The sentence beside it (`visit.locationLabel`) carries the metres.
 */
const LOCATION_PILL: Record<VisitLocationFlag, { label: string; tone: PillTone }> = {
  ok: { label: "At the place", tone: "good" },
  far: { label: "Take care", tone: "neutral" },
  weak_gps: { label: "Location was rough", tone: "neutral" },
  no_place: { label: "No place to compare", tone: "neutral" },
};

/*
 * There is no `isFlagged` here any more, and no count of one anywhere on the rep's screen (2026-09-26).
 * The two "AM flagged / PM flagged" tiles are gone, the saved note no longer reads "the visit is
 * saved with this flag", and the word itself does not appear in the app — pinned by
 * tests/phoenix-crm-blind-half.test.ts. The evidence is UNCHANGED and still reaches the Super Admin
 * and the SFE Manager in full. What left is the scoreboard he was being shown of himself.
 */

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

  return {
    pm: count("PM", any),
    am: count("AM", any),
    pairedPm: count("PM", paired),
    pairedAm: count("AM", paired),
  };
}

function LocationPills({ visit }: { visit: VisitRow }) {
  const location = LOCATION_PILL[visit.locationFlag];
  return (
    <>
      <CrmPill tone={location.tone}>{location.label}</CrmPill>
      {visit.unplanned ? (
        <CrmPill tone={visit.unplanned.status === "approved" ? "good" : visit.unplanned.status === "refused" ? "warn" : "orange"}>
          {visit.unplanned.statusLabel}
        </CrmPill>
      ) : null}
      {visit.clockOff ? <CrmPill tone="warn">Phone clock off</CrmPill> : null}
    </>
  );
}

function availabilitySplit(map: Record<string, ProductAvailability>): { has: string[]; missing: string[] } {
  const has: string[] = [];
  const missing: string[] = [];
  for (const [product, answer] of Object.entries(map)) (answer === "has" ? has : missing).push(product);
  return { has, missing };
}

// One product's Has / Doesn't-have answer in the pharmacy-stock check. Tapping the answer it already
// carries clears it back to unanswered, so a mistaken tap is undone without a third button.
function AvailabilityRow({
  product,
  answer,
  disabled,
  onSet,
}: {
  product: string;
  answer: ProductAvailability | undefined;
  disabled: boolean;
  onSet: (product: string, answer: ProductAvailability) => void;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 border border-slate-200 bg-white px-3 py-2">
      <span className="min-w-0 flex-1 break-words text-sm font-black text-slate-700">{product}</span>
      <div className="flex shrink-0 flex-wrap gap-1.5">
        <button
          aria-pressed={answer === "has"}
          className={cn(
            "min-h-11 min-w-0 break-words rounded-none border px-3 py-1 text-sm font-black transition disabled:cursor-not-allowed disabled:opacity-50",
            answer === "has" ? "border-emerald-600 bg-emerald-600 text-white" : "border-slate-200 bg-white text-slate-600 hover:border-emerald-300",
          )}
          disabled={disabled}
          onClick={() => onSet(product, "has")}
          type="button"
        >
          Has
        </button>
        <button
          aria-pressed={answer === "missing"}
          className={cn(
            "min-h-11 min-w-0 break-words rounded-none border px-3 py-1 text-sm font-black transition disabled:cursor-not-allowed disabled:opacity-50",
            answer === "missing" ? "border-rose-500 bg-rose-500 text-white" : "border-slate-200 bg-white text-slate-600 hover:border-rose-300",
          )}
          disabled={disabled}
          onClick={() => onSet(product, "missing")}
          type="button"
        >
          Doesn&apos;t have
        </button>
      </div>
    </div>
  );
}

function PharmacyLines({ visit }: { visit: VisitRow }) {
  const { has, missing } = availabilitySplit(visit.productAvailability);
  if (!visit.pharmacyName && has.length === 0 && missing.length === 0) return null;
  return (
    <>
      {visit.pharmacyName ? (
        <p className="break-words">
          <span className="font-black text-slate-800">Pharmacy: </span>
          {visit.pharmacyName}
        </p>
      ) : null}
      {has.length > 0 ? (
        <p className="break-words">
          <span className="font-black text-slate-800">Has: </span>
          {has.join(", ")}
        </p>
      ) : null}
      {missing.length > 0 ? (
        <p className="break-words">
          <span className="font-black text-slate-800">Doesn&apos;t have: </span>
          {missing.join(", ")}
        </p>
      ) : null}
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
      <PharmacyLines visit={visit} />
      {visit.comment ? (
        <p className="whitespace-pre-line break-words">
          <span className="font-black text-slate-800">Comment: </span>
          {/* The label stays left-to-right; only the comment itself takes the reader's direction. */}
          <span dir="auto">{visit.comment}</span>
        </p>
      ) : null}
      {/* The note sits beside the comment because that is what it is — the same thing said rather than
          typed. It is NOT beside the photo, which is where the eye goes for evidence of presence: a
          recording can be made in a car afterwards and proves nothing about where anybody stood. */}
      {visit.voiceNotePath ? <CrmVoiceNotePlayer path={visit.voiceNotePath} seconds={visit.voiceNoteSeconds} /> : null}
      <p className="break-words">{visit.locationLabel}</p>
      {/* Off the plan: what he wrote, and where it has got to. He is TOLD this deliberately — it is his
          own visit, it is not counting yet, and the only way he can chase it is to know. */}
      {visit.unplanned ? (
        <p className="break-words">
          <span className="font-black text-slate-800">Off the plan: </span>
          <span dir="auto">{visit.unplanned.clarification}</span>
          <span className="block">{visit.unplanned.note}</span>
        </p>
      ) : null}
      {enteredByOther(visit) ? <p className="break-words">Entered by {visit.enteredByName}</p> : null}
    </div>
  );
}

function VisitCard({ visit }: { visit: VisitRow }) {
  return (
    <CrmCard
      accent="border-l-orange-500"
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

/**
 * Five columns totalling 100%. The photo rides in the Customer cell, under the name, rather than in a
 * column of its own: a 10% column could not hold a 56px thumbnail at 1024px with the sidebar open, and
 * the fits-the-screen rule fits by merging columns, never by squeezing what is in them.
 */
function VisitTable({ visits }: { visits: ReadonlyArray<VisitRow> }) {
  return (
    <CrmTable columns={["11%", "25%", "22%", "26%", "16%"]}>
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
                <div className="mt-2">
                  <CrmPhotoThumb
                    alt={`Visit photo: ${visit.customerName}`}
                    caption={`${visit.customerName} · ${cairoStamp(visit.capturedAt)}`}
                    className="h-14 w-14"
                    path={visit.photoPath}
                  />
                </div>
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
                {visit.pharmacyName ? <span className="mt-1 block text-xs text-slate-600">Pharmacy: {visit.pharmacyName}</span> : null}
                {(() => {
                  const { has, missing } = availabilitySplit(visit.productAvailability);
                  return (
                    <>
                      {has.length > 0 ? <span className="mt-1 block text-xs text-slate-500">Has: {has.join(", ")}</span> : null}
                      {missing.length > 0 ? <span className="block text-xs text-slate-500">Doesn&apos;t have: {missing.join(", ")}</span> : null}
                    </>
                  );
                })()}
                {visit.comment ? (
                  <span className="mt-1 block whitespace-pre-line text-xs text-slate-500" dir="auto">
                    {visit.comment}
                  </span>
                ) : null}
                {visit.voiceNotePath ? (
                  <div className="mt-1.5">
                    <CrmVoiceNotePlayer path={visit.voiceNotePath} seconds={visit.voiceNoteSeconds} />
                  </div>
                ) : null}
              </td>
              <td className={crmTdClassName}>
                <span className="flex flex-wrap gap-1">
                  <LocationPills visit={visit} />
                </span>
                <span className="mt-1 block text-xs text-slate-500">{visit.locationLabel}</span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </CrmTable>
  );
}

/** What the day screen shows after a visit is saved, and — for a pending customer — what to do next. */
type SavedState = {
  visit: SavedVisit;
  customerName: string;
  /** His iReports360 entry, when he is pending and has one: what Validate opens on. */
  validate: number | null;
};

function SavedNote({ onValidate, saved }: { onValidate: (() => void) | null; saved: SavedState }) {
  const { customerName, visit } = saved;
  const note = visit.duplicate ? (
    <CrmNote title={customerName} tone="info">
      This visit was already saved, at {cairoClock(visit.capturedAt)}.
    </CrmNote>
  ) : (
    <CrmNote title={`Visit saved: ${customerName}`} tone="good">
      {cairoClock(visit.capturedAt)} · {visit.locationLabel}
      {/* The tone stays "good" whatever the distance says: the visit IS saved, and it counts. The
          sentence above carries the owner's polite sign; "the visit is saved with this flag" left
          on 2026-09-26 — it told a rep he had been marked, which is the one thing he is never told. */}
      {/* The server's own verdict, not what he chose on the first step — so a rep who picked Planned
          for a doctor his plan no longer holds finds out here rather than a month later. */}
      {visit.unplannedNote ? <span className="mt-1 block">{visit.unplannedNote}</span> : null}
    </CrmNote>
  );
  if (!onValidate) return note;
  // The one moment he is certainly at the door with the phone in his hand. An offer, never a gate:
  // the visit is already saved either way, and nothing here can undo it.
  return (
    <div className="grid min-w-0 gap-2">
      {note}
      <CrmNote title={PENDING_PILL} tone="info">
        <span className="block">{PENDING_COUNTS_NOTE} It takes the location, one photo and the opening hours, once.</span>
        <CrmButton className="mt-2" onClick={onValidate} variant="primary">
          Validate now
        </CrmButton>
      </CrmNote>
    </div>
  );
}

/**
 * What this day was, when it was not a call — a meeting, training, a conference, admin work,
 * travelling, a health day (owner, 2026-09-26).
 *
 * A RECORD ONLY, and the copy says so out loud: it changes no call rate, no coverage and no
 * plan-against-actual. A rep at a training day currently looks like a rep who did nothing, and this
 * is what lets his manager see the difference — not what excuses the day.
 *
 * There is no leave here. HR's vacation module is the only leave record, and a second one in the CRM
 * would be a truth nothing reconciles.
 */
function DayActivityBlock({ day, view }: { day: CrmResource<VisitDayView>; view: VisitDayView }) {
  const action = useCrmAction();
  const current = view.dayActivity;

  async function choose(next: string) {
    const body =
      next === ""
        ? { clear: true, seatId: view.territory.seatId, test: view.isTest }
        : { activityType: next, seatId: view.territory.seatId, test: view.isTest };
    const ok = await action.run("day-activity", () => crmPost("/api/phoenix-crm/day-activities", body, "saved"));
    if (ok !== undefined) day.reload();
  }

  if (!view.canSetDayActivity) {
    return current ? (
      <CrmBlock className="border-t border-slate-100" title="This day">
        <p className="text-sm font-semibold text-slate-700">
          {current.activityLabel}
          {current.halfDay ? " · half day" : ""}
        </p>
      </CrmBlock>
    ) : null;
  }

  return (
    <CrmBlock className="border-t border-slate-100" title="Was today a field day?">
      <CrmSelect
        aria-label="What today was"
        disabled={action.busy !== null}
        onChange={(event) => void choose(event.target.value)}
        value={current?.activityType ?? ""}
      >
        <option value="">A field day — visits only</option>
        {PHOENIX_CRM_DAY_ACTIVITIES.map((entry) => (
          <option key={entry.key} value={entry.key}>
            {entry.label}
          </option>
        ))}
      </CrmSelect>
      <p className="mt-2 text-xs font-semibold text-slate-500">
        Recorded so your manager can see the day. It changes none of your figures.
      </p>
      {action.error ? <CrmNote title="Not saved" tone="warn">{action.error}</CrmNote> : null}
    </CrmBlock>
  );
}

export function VisitsTab({
  cairoToday,
  onPendingVisitDone,
  onStartValidate,
  onWorkChange,
  pendingVisit,
  seatId,
  test,
}: {
  cairoToday: string;
  /** The hand-off from the List tab was used or abandoned. */
  onPendingVisitDone: () => void;
  /** Validate the customer this visit was just saved on. Absent where this page cannot edit the list. */
  onStartValidate?: (validate: PendingValidate) => void;
  /** Add Visit opened or closed: the page keeps this tab as it is while another tab is open. */
  onWorkChange?: (working: boolean) => void;
  pendingVisit: PendingVisit | null;
  seatId: string;
  test: boolean;
}) {
  const [date, setDate] = useState(cairoToday);
  const [adding, setAdding] = useState(false);
  const [saved, setSaved] = useState<SavedState | null>(null);
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
        onSaved={(visit, customerName, validate) => {
          setAdding(false);
          if (handoff) onPendingVisitDone();
          setSaved({ visit, customerName, validate });
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
          <SavedNote
            onValidate={
              onStartValidate && saved.validate !== null
                ? () => {
                    const contactCrmId = saved.validate;
                    if (contactCrmId === null) return;
                    setSaved(null);
                    onStartValidate({ seatId, test, contactCrmId, customerName: saved.customerName });
                  }
                : null
            }
            saved={saved}
          />
        </div>
      ) : null}

      {!view && day.error ? <CrmLoadError message={day.error} onRetry={day.reload} /> : null}
      {!view && !day.error ? <CrmLoading label="Loading the day's visits" /> : null}

      {view ? (
        <>
          {day.error ? <CrmLoadError message={day.error} onRetry={day.reload} /> : null}
          <DayActivityBlock day={day} view={view} />
          <CrmBlock>
            {/* AM first, as every sentence and the Day screen say it; the figures are unchanged. */}
            <CrmStatGrid>
              <CrmStat label="AM visited" note={plural(figures.pairedAm, "double or chain visit", "double or chain visits")} value={figures.am} />
              <CrmStat label="PM visited" note={plural(figures.pairedPm, "double or chain visit", "double or chain visits")} value={figures.pm} />
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

/** The brick a customer is grouped under in the picker. A customer with no place yet has none. */
const NO_BRICK = "__no_brick__";
const NO_BRICK_LABEL = "Not mapped yet";

type PickerGroup = { key: string; name: string; customers: VisitCustomerOption[] };

function CustomerPicker({
  customers,
  disabled,
  onPick,
  selectedId,
  visitType,
}: {
  customers: ReadonlyArray<VisitCustomerOption>;
  disabled: boolean;
  onPick: (customerId: string) => void;
  selectedId: string | null;
  visitType: VisitTypeChoice;
}) {
  const [query, setQuery] = useState("");
  const [listType, setListType] = useState<"all" | PhoenixCrmListType>("all");
  // A page at a time, as the planner's suggestions are: a territory's whole list is hundreds of
  // buttons, and today's plan (which sorts first) is what the rep is almost always looking for.
  const [limit, setLimit] = useState(PICKER_PAGE);
  const needle = query.trim().toLowerCase();
  // A PLANNED visit offers only the doctors on a plan he has sent for today (owner, 2026-09-26); an
  // UNPLANNED one opens his whole list. This is the door, not the gate: the server decides which kind
  // the visit really was from the plan's own history, and refuses a mismatch with a named refusal.
  const offered = visitType === "planned" ? customers.filter((customer) => customer.plannedToday) : customers;
  const shown = offered.filter(
    (customer) =>
      (listType === "all" || customer.listType === listType) &&
      (!needle || customer.name.toLowerCase().includes(needle) || (customer.speciality ?? "").toLowerCase().includes(needle)),
  );
  const left = shown.length - limit;
  // The hue is keyed off each brick's place in the WHOLE list, never this filtered one: a brick that
  // changes colour as the rep searches is a brick he cannot learn.
  const tints = brickTintMap(customers.map((customer) => customer.brickId).filter((brickId): brickId is string => Boolean(brickId)));
  // Grouped in the order the bricks first appear. Customers already sort planned-first, so the bricks
  // he is planned in lead: his day laid out geographically before he taps anything.
  const groups: PickerGroup[] = [];
  const groupByKey = new Map<string, PickerGroup>();
  for (const customer of shown.slice(0, limit)) {
    const key = customer.brickId ?? NO_BRICK;
    let group = groupByKey.get(key);
    if (!group) {
      group = { key, name: customer.brickName ?? NO_BRICK_LABEL, customers: [] };
      groupByKey.set(key, group);
      groups.push(group);
    }
    group.customers.push(customer);
  }

  return (
    <div className="grid min-w-0 gap-3">
      <div className="relative min-w-0">
        <Search aria-hidden className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-slate-400" />
        <input
          aria-label="Search customers"
          className={cn(crmInputClassName, "appearance-none pl-9")}
          disabled={disabled}
          onChange={(event) => {
            setQuery(event.target.value);
            setLimit(PICKER_PAGE);
          }}
          placeholder="Search by name or speciality"
          type="search"
          value={query}
        />
      </div>
      <CrmChoice
        columns={3}
        label="Which customers"
        onChange={(next) => {
          setListType(next);
          setLimit(PICKER_PAGE);
        }}
        options={[
          { value: "all", label: "All" },
          { value: "PM", label: "PM" },
          { value: "AM", label: "AM" },
        ]}
        value={listType}
      />
      <p className="text-xs font-semibold text-slate-500">
        {visitType === "planned" ? "Today’s plan, grouped by brick." : "Your whole list, grouped by brick."}
      </p>
      {shown.length === 0 ? (
        <p className="border border-dashed border-slate-200 px-3 py-4 text-center text-sm font-semibold text-slate-500">
          {offered.length === 0 && visitType === "planned"
            ? "No customer is on a plan you have sent for today. Choose Unplanned visit above to visit anyone on your list."
            : "No customer matches."}
        </p>
      ) : (
        <div className="grid min-w-0 gap-3">
          {groups.map((group) => {
            const tint = tints.get(group.key);
            return (
              <div className="min-w-0" key={group.key}>
                {/* The wash is on the heading, never on a row — the same way the List tab and the
                    Reps List board draw a brick, from the one shared palette. */}
                <p
                  className={cn(
                    "mb-1.5 break-words border-l-4 px-2 py-1 text-phx-2xs font-black uppercase tracking-[0.16em]",
                    tint ? `${tint.bar} ${tint.fill} text-slate-600` : "border-l-amber-500 bg-amber-50 text-amber-800",
                  )}
                >
                  {group.name} · {countText(group.customers.length)}
                </p>
                <ul className="grid gap-1.5">
                  {group.customers.map((customer) => {
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
                              {customer.pending ? <CrmPill tone="orange">{PENDING_PILL}</CrmPill> : null}
                              {customer.plannedToday ? <CrmPill tone="orange">On today&apos;s plan</CrmPill> : null}
                              {customer.visitedToday ? <CrmPill tone="good">Visited today</CrmPill> : null}
                            </span>
                          </span>
                          <PlaceWindows customer={customer} />
                          {/* A customer not validated yet has no month standing to report: "2 of 3 visits this
                              month" would be read as progress on a figure his visits do not move. */}
                          <span className="mt-1 block text-xs font-semibold text-slate-600">
                            {customer.pending ? pendingVisitsText(customer.visitsThisMonth) : monthVisitsText(customer.visitsThisMonth, customer.target)}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>
      )}
      {/* The same words as every "show more" in the module (CrmShowMore); inline here, because the
          picker already sits inside the step's padded block. */}
      {left > 0 ? (
        <div>
          <CrmButton onClick={() => setLimit((current) => current + PICKER_PAGE)} size="sm">
            Show {countText(Math.min(PICKER_PAGE, left))} more of the {countText(left)} left
          </CrmButton>
        </div>
      ) : null}
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
  // `validate` is his iReports360 entry when the customer he just visited is still pending and has
  // one — the id the Validate screen opens on. Null whenever there is nothing to offer.
  onSaved: (visit: SavedVisit, customerName: string, validate: number | null) => void;
  seatId: string;
  test: boolean;
}) {
  const resource = useCrmGet<VisitFormView>(crmUrl("/api/phoenix-crm/visits/form", { seatId, test }), "form");
  const form = resource.data;

  const [customerId, setCustomerId] = useState<string | null>(handoff?.customerId ?? null);
  const [picking, setPicking] = useState(!handoff);
  // The first thing he chooses (owner, 2026-09-26). Planned shows today's plan; unplanned opens the
  // whole list and asks why. A handoff comes from validating a customer at the door, which is by
  // definition someone he went to see — so it opens on unplanned and he writes the reason there.
  const [visitType, setVisitType] = useState<VisitTypeChoice>("planned");
  const [unplannedReason, setUnplannedReason] = useState("");
  const [kind, setKind] = useState<PhoenixCrmVisitKind>("single");
  const [managerHrId, setManagerHrId] = useState<string | null>(null);
  const [seniorHrId, setSeniorHrId] = useState<string | null>(null);
  const [products, setProducts] = useState<string[]>([]);
  const [pharmacyName, setPharmacyName] = useState("");
  const [availability, setAvailability] = useState<Record<string, ProductAvailability>>({});
  // Which families in the pharmacy-stock check are expanded to show their concentrations. A family
  // with a single product is never a group, so it is never in here; the rest start collapsed.
  const [openFamilies, setOpenFamilies] = useState<Set<string>>(() => new Set());
  const [comment, setComment] = useState("");
  const [photo, setPhoto] = useState<CapturedPhoto | null>(null);
  // The spoken note, already uploaded by the control. Null is the normal case: it was never required.
  const [voiceNote, setVoiceNote] = useState<VoiceNoteValue | null>(null);
  const [usePlacePhoto, setUsePlacePhoto] = useState(Boolean(handoff?.photo));
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
  const plannedToday = loaded.customers.filter((option) => option.plannedToday).length;
  const placePhoto = handoff?.photo && usePlacePhoto && customer && customer.customerId === handoff.customerId ? handoff.photo : null;
  const who = participantsOf(loaded, kind, managerHrId, seniorHrId);
  const commentLength = comment.trim().length;

  /**
   * Changing the kind changes which customers are on offer, so a customer already chosen who is no
   * longer offered is dropped rather than left sitting there with a picker that cannot show him.
   */
  function chooseVisitType(next: VisitTypeChoice) {
    setProblem(null);
    setVisitType(next);
    if (next === "planned" && customer && !customer.plannedToday) {
      releaseCapturedPhoto(photo);
      setPhoto(null);
      setCustomerId(null);
      setPicking(true);
    }
    if (next === "planned") setUnplannedReason("");
  }

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
    // GOLDEN RULE #1, the EASY half (owner, 2026-09-26): nothing is asked twice. He sees the same
    // doctor every few weeks and re-taps the same three products every time, and the answer is
    // already in his own last visit. Filled in silently rather than behind a button — a button to
    // avoid typing is still a tap — and the line under the grid says which day it came from, so he
    // can see what he is agreeing to and change any of it.
    const carried = loaded.customers.find((option) => option.customerId === nextId)?.lastVisit ?? null;
    setProducts(carried ? [...carried.products] : []);
  }

  function toggleProduct(product: string) {
    setProblem(null);
    setProducts((current) =>
      current.includes(product) ? current.filter((entry) => entry !== product) : current.length >= VISIT_PRODUCTS_MAX ? current : [...current, product],
    );
  }

  // The pharmacy stock answer for one product. Tapping the answer it already has clears it back to
  // unanswered, so a mistaken tap is undone without a third button.
  function setStock(product: string, answer: ProductAvailability) {
    setProblem(null);
    setAvailability((current) => {
      const next = { ...current };
      if (next[product] === answer) delete next[product];
      else next[product] = answer;
      return next;
    });
  }

  function toggleFamily(family: string) {
    setOpenFamilies((current) => {
      const next = new Set(current);
      if (next.has(family)) next.delete(family);
      else next.add(family);
      return next;
    });
  }

  function draft(visitId: string): Draft {
    if (!customer) return { ok: false, problem: "Choose the customer you visited." };
    if (customer.visitedToday) return { ok: false, problem: "This customer's visit for today is already saved." };
    if (visitType === "unplanned" && unplannedReason.trim().length < UNPLANNED_REASON_MIN) {
      return { ok: false, problem: "Write why you visited this customer off your plan." };
    }
    if (kind !== "single" && !who.manager) {
      return {
        ok: false,
        problem: loaded.enteredAs === "manager" ? "You are not a manager of this territory. Reload the page." : "Choose the manager who was on the visit.",
      };
    }
    if (kind === "chain" && !who.senior) return { ok: false, problem: "Choose the senior manager who was on the visit." };
    if (products.length === 0) return { ok: false, problem: "Choose the products you discussed." };
    if (!pharmacyName.trim()) return { ok: false, problem: "Write the pharmacy you took feedback from." };
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
        // What he chose. The server re-decides it from the plan's own history, so this only settles
        // whether the reason travels with the visit.
        visitType,
        unplannedReason: visitType === "unplanned" ? unplannedReason.trim() : null,
        kind,
        managerHrId: kind === "single" ? null : (who.manager?.hrId ?? null),
        seniorHrId: kind === "chain" ? (who.senior?.hrId ?? null) : null,
        products,
        pharmacyName: pharmacyName.trim(),
        productAvailability: availability,
        comment: comment.trim() || null,
        photoPath: evidence.path,
        // Beside the photo and deliberately not one of its fields: the photo's slot dates the visit
        // and this one dates nothing, so it carries no time of its own.
        voiceNotePath: voiceNote?.path ?? null,
        voiceNoteSeconds: voiceNote?.seconds ?? null,
        voiceNoteBytes: voiceNote?.bytes ?? null,
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
    if (placePhoto && handoff && reuseWindowOver(handoff.validatedAtMs)) {
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
      onSaved(saved, next.customerName, customer?.pending ? customer.referenceContactCrmId : null);
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
      } else if (code && code.startsWith("phoenix_crm_voice_")) {
        // The slot was already spent, has expired, or never received the audio. Keeping the note would
        // send the rep into the same refusal on every press of Save; dropping it lets them record again.
        // The photo is deliberately left alone — the visit itself is still good.
        setVoiceNote(null);
      } else if (code === "phoenix_crm_clarification_required") {
        // The server's own test says this customer was not on a plan sent for today — the rep's plan
        // moved under him, or he chose Planned for someone who was not. Open the reason box and keep
        // the photo and the visit id: he writes one line and saves the SAME visit again.
        setVisitType("unplanned");
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
        {/* The kind of visit comes FIRST, above the picker: it decides which customers the picker
            offers at all (owner, 2026-09-26). Unplanned is what replaces the old CRM's "Campaign
            (Prospection)" — the same idea, with a reason attached and an approval behind it. */}
        <CrmChoice
          className="mb-3"
          columns={2}
          label="Kind of visit"
          onChange={chooseVisitType}
          options={[
            { value: "planned", label: "Planned visit", note: `${countText(plannedToday)} on today’s plan`, disabled: saving },
            { value: "unplanned", label: "Unplanned visit", note: "Anyone on your list · needs approval", disabled: saving },
          ]}
          value={visitType}
        />
        {visitType === "unplanned" ? (
          <CrmNote className="mb-3" title="It counts once it is approved" tone="info">
            Write why you went. {loaded.managers[0] ? `${loaded.managers[0].name} decides it first, then SFE.` : "SFE decides it."} Until then it
            counts in nothing — not your call rate, not coverage, not frequency.
          </CrmNote>
        ) : null}
        {customer && !picking ? (
          <div className="flex min-w-0 flex-wrap items-start justify-between gap-3 border border-orange-200 bg-orange-50/50 px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <p className="break-words text-sm font-black text-slate-950">{customer.name}</p>
              <p className="mt-0.5 break-words text-xs font-semibold text-slate-500">{customerMetaText(customer)}</p>
              <PlaceWindows customer={customer} />
              <p className="mt-1 text-xs font-semibold text-slate-600">
                {customer.pending ? pendingVisitsText(customer.visitsThisMonth) : monthVisitsText(customer.visitsThisMonth, customer.target)}
              </p>
              {/* Never a warning and never a gate: he saves this visit exactly as he would any other.
                  The one thing worth saying is what validating buys him. */}
              {customer.pending ? (
                <CrmNote className="mt-2" title={PENDING_PILL} tone="info">
                  {PENDING_COUNTS_NOTE}
                </CrmNote>
              ) : null}
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
            <CustomerPicker customers={loaded.customers} disabled={saving} onPick={pickCustomer} selectedId={customerId} visitType={visitType} />
          </>
        )}
        {visitType === "unplanned" ? (
          <CrmField className="mt-3" label="Why you went">
            <textarea
              className={crmTextareaClassName}
              disabled={saving}
              maxLength={UNPLANNED_REASON_MAX}
              onChange={(event) => {
                setProblem(null);
                setUnplannedReason(event.target.value);
              }}
              placeholder="A sentence your manager can act on — what took you there."
              rows={3}
              value={unplannedReason}
            />
            <p className="mt-1 text-xs font-semibold text-slate-500">
              {unplannedReason.trim().length < UNPLANNED_REASON_MIN
                ? `At least ${UNPLANNED_REASON_MIN} characters.`
                : `${countText(UNPLANNED_REASON_MAX - unplannedReason.length)} left.`}
            </p>
          </CrmField>
        ) : null}
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
        {customer?.lastVisit ? (
          <p className="mt-2 text-xs font-semibold text-slate-500">
            Filled in from your last visit on {dayLabel(customer.lastVisit.date)}. Change any of them.
          </p>
        ) : null}
        <p className="mt-2 text-xs font-semibold text-slate-500">
          {products.length === 0 ? `Choose up to ${VISIT_PRODUCTS_MAX}.` : `${products.length} chosen, up to ${VISIT_PRODUCTS_MAX}.`}
        </p>
      </CrmBlock>

      <CrmBlock className="border-t border-slate-100" title="4 · Pharmacy you took feedback from">
        <CrmField
          hint="Type the pharmacy. Ones you entered before appear as you type; a new one is saved for next time."
          htmlFor="phoenix-crm-visit-pharmacy"
          label="Pharmacy name"
        >
          <input
            autoComplete="off"
            className={crmInputClassName}
            disabled={saving}
            id="phoenix-crm-visit-pharmacy"
            list="phoenix-crm-pharmacies"
            maxLength={PHARMACY_NAME_MAX}
            onChange={(event) => {
              setProblem(null);
              setPharmacyName(event.target.value);
            }}
            placeholder="e.g. El Ezaby — Nasr City"
            value={pharmacyName}
          />
          {loaded.pharmacies.length > 0 ? (
            <datalist id="phoenix-crm-pharmacies">
              {loaded.pharmacies.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          ) : null}
        </CrmField>

        <div className="mt-3 min-w-0">
          <p className="text-sm font-black text-slate-800">Does this pharmacy have these products?</p>
          <p className="mt-0.5 text-xs font-semibold text-slate-500">Answer the ones you checked — leave the rest blank.</p>
          <div className="mt-2 grid min-w-0 gap-1.5">
            {loaded.productFamilies.map((family) => {
              // A family with one product is answered directly — nothing to expand.
              if (family.products.length <= 1) {
                const product = family.products[0] ?? family.family;
                return <AvailabilityRow answer={availability[product]} disabled={saving} key={family.family} onSet={setStock} product={product} />;
              }
              // A family with several concentrations is a group: a header that expands to its products,
              // with a badge of how many of them have been answered so far.
              const open = openFamilies.has(family.family);
              const answered = family.products.filter((product) => availability[product]).length;
              return (
                <div className="min-w-0 border border-slate-200 bg-white" key={family.family}>
                  <button
                    aria-expanded={open}
                    className="flex min-h-11 w-full min-w-0 items-center justify-between gap-2 rounded-none px-3 py-2 text-left disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={saving}
                    onClick={() => toggleFamily(family.family)}
                    type="button"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <ChevronRight className={cn("h-4 w-4 shrink-0 text-slate-400 transition-transform", open && "rotate-90")} />
                      <span className="min-w-0 break-words text-sm font-black text-slate-700">{family.family}</span>
                    </span>
                    <span className="shrink-0 text-xs font-black text-slate-500">
                      {answered > 0 ? `${answered}/${family.products.length}` : `${family.products.length}`}
                    </span>
                  </button>
                  {open ? (
                    <div className="grid min-w-0 gap-1.5 border-t border-slate-100 p-2">
                      {family.products.map((product) => (
                        <AvailabilityRow answer={availability[product]} disabled={saving} key={product} onSet={setStock} product={product} />
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      </CrmBlock>

      <CrmBlock className="border-t border-slate-100" title="5 · Comment">
        <CrmField
          error={commentLength > VISIT_COMMENT_MAX ? `Keep the comment under ${VISIT_COMMENT_MAX} characters.` : null}
          hint={`Optional · ${commentLength} of ${VISIT_COMMENT_MAX} characters`}
          htmlFor="phoenix-crm-visit-comment"
          label="What happened on the visit"
        >
          {/* dir="auto" so a comment spoken or typed in Arabic reads right-to-left. This is single-
              language free text, which is the case block-level dir="auto" is house style for. */}
          <textarea
            className={crmTextareaClassName}
            dir="auto"
            disabled={saving}
            id="phoenix-crm-visit-comment"
            maxLength={VISIT_COMMENT_MAX}
            onChange={(event) => setComment(event.target.value)}
            value={comment}
          />
        </CrmField>
        {/* ONE control, both outcomes (owner, 2026-09-25): the rep speaks once, the words are written
            here as they settle and the audio is kept with the visit. The cap is applied here, not by
            the textarea: `maxLength` constrains TYPING and does nothing to a programmatic append, so a
            long spoken comment would push the field past VISIT_COMMENT_MAX and the server would refuse
            the save. The text is the engine's live reading, never a transcript of the stored audio. */}
        <CrmSpeak
          disabled={saving}
          onAppend={(spoken) => setComment((current) => appendDictated(current, spoken, VISIT_COMMENT_MAX))}
          onChange={setVoiceNote}
          seatId={seatId}
          test={test}
          value={voiceNote}
        />
      </CrmBlock>

      <CrmBlock className="border-t border-slate-100" title="6 · Live photo">
        {placePhoto ? (
          <div className="grid gap-2">
            <span className="block w-full overflow-hidden rounded-none border border-slate-200 bg-slate-950">
              <ZoomablePhoto alt="The photo taken to validate this customer" className="block max-h-[50svh] w-full object-contain" src={placePhoto.previewUrl} />
            </span>
            <p className="break-words text-xs font-semibold text-slate-600">{placePhoto.locationLabel}</p>
            <CrmNote tone="info">The photo you took to validate this customer stands for this visit when you save within 30 minutes of validating.</CrmNote>
            <CrmButton disabled={saving} onClick={() => setUsePlacePhoto(false)} size="sm">
              Take a new photo instead
            </CrmButton>
          </div>
        ) : customer ? (
          // No hint under the camera (owner, 2026-09-23): the rep is at the door with the phone up,
          // and a sentence about his location being compared with the validated place — and about the
          // metres that would flag it — is not something he can act on there. The check itself is
          // unchanged: a visit further than `visitFarMeters` still saves and is still flagged.
          <LivePhotoCapture
            disabled={saving}
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
