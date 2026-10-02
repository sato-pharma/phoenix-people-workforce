"use client";

/**
 * Phoenix CRM — the List tab's entry screens: validating a customer (one carried over from iReports360,
 * or a new one), the screen after a place is saved, adding another clinic and changing a clinic's days
 * and hours, and the requests that move a customer on or off the list.
 *
 * Owner, 2026-09-16:
 *   - a customer is real only with a live photo of the clinic sign or door, the location captured on
 *     the spot and at least one timing; timings belong to the place, so a second clinic is a second
 *     entry with its own photo;
 *   - the Super Admin's entries are test entries, and in test mode the Super Admin decides them too.
 *
 * Owner, 2026-09-29 — the rep's flow rebuilt (src/lib/phoenix-crm/list-request-rules.ts holds the
 * customer's whole life on the list; these screens only lay it out):
 *   - Validate is a live signboard photo, the Capture-location pin and the days and hours, once and for
 *     good. The photo's own reading is the fixed point. The rep is told "Location captured" and never
 *     how well (Golden Rule #1);
 *   - "Add new customer" is AM/PM chosen by hand, the full name, the speciality and a proposed A/B/C,
 *     validated on the spot. He then WAITS outside the list for the district manager, then SFE;
 *   - dropping a listed customer, adding one waiting outside and bringing one back from the Archive
 *     are two-step requests (district manager, then SFE). A grade change stays the district manager's.
 *   - There is no "Add visit" on the List. A visit starts from Visits, Today or the portal's "+".
 *
 * A save whose answer is lost (the phone lost signal after sending) may still have landed. A photo is
 * used once, so before asking the rep to do anything again the screen reads the list and looks for the
 * place saved with that photo: found means saved.
 */

import type { ReactNode } from "react";
import { useState } from "react";

import { crmGet, crmPost, crmUrl, errorCodeOf, messageOf } from "@/components/phoenix-crm/api";
import { CustomerPhoneField } from "@/components/phoenix-crm/customer-phone";
import { cairoStamp, dayLabelWithYear, plural } from "@/components/phoenix-crm/format";
import {
  customerMetaText,
  listText,
  monthVisitsText,
  PENDING_PILL,
  pendingVisitsText,
  placeName,
  referenceAddressText,
  referenceLastVisitText,
  territoryLine,
} from "@/components/phoenix-crm/labels";
import { releaseCapturedPhoto } from "@/components/phoenix-crm/captured-photo";
import { capturedLocationText, type CapturedPhoto } from "@/components/phoenix-crm/live-photo-capture";
import { CrmPhotoThumb } from "@/components/phoenix-crm/photo";
import {
  emptyPlaceDraft,
  PlaceEditor,
  placeDraftProblem,
  placePayload,
  ramadanHoursNote,
  type PlaceDraftState,
} from "@/components/phoenix-crm/place-editor";
import { timingsToDrafts } from "@/components/phoenix-crm/timings-editor";
import {
  CrmBackBar,
  CrmBlock,
  CrmButton,
  CrmChoice,
  CrmField,
  CrmLoading,
  CrmNote,
  CrmPanel,
  CrmPill,
  crmInputClassName,
  crmTextareaClassName,
  type NoteTone,
} from "@/components/phoenix-crm/ui";
import { CUSTOMER_NAME_MAX, DROP_REASON_MAX, DROP_REASONS, parseCustomerPhone, type DropReason } from "@/lib/phoenix-crm/entry-rules";
import { listMovesFor, type ListMove } from "@/lib/phoenix-crm/list-request-rules";
import { receivingDaysLabel } from "@/lib/phoenix-crm/timings";
import type { PhoenixCrmGrade, PhoenixCrmListType, PhoenixCrmRequestKind } from "@/lib/phoenix-crm/types";
import type { ListCustomer, ListPlace, ListReferenceEntry, TerritoryListView, ValidateResult } from "@/lib/phoenix-crm/view-types";

/** The server keeps a speciality to this length (entry-rules.ts parseNewCustomer). */
const SPECIALITY_TEXT_MAX = 80;
/** The server keeps a request's note to this length (list.ts createListRequest). */
const REQUEST_NOTE_MAX = 500;
const GRADES = ["A", "B", "C"] as const;

const PHOTO_NEEDED = "Take a live photo of the clinic's signboard.";
const EDIT_ONLY = "Only the territory's rep changes this list.";
const NOT_ON_LIST = "This customer is no longer on the territory's list.";
const UNCHECKED =
  "The save may have gone through, but Phoenix could not check. Check the connection, then press Save again.";

/**
 * Answers a save can get when an earlier press of Save landed and only its answer was lost: no answer
 * at all, a server failure, or a refusal that the landed save itself caused.
 */
const MAY_HAVE_SAVED = new Set([
  "offline",
  "failed",
  "internal_error",
  "statement_timeout",
  "phoenix_crm_photo_used",
  "phoenix_crm_already_validated",
  "phoenix_crm_same_name",
]);

/** Refusals that mean the list moved on under the screen: read it again. */
const REQUEST_RELOAD = new Set([
  "phoenix_crm_already_pending",
  "phoenix_crm_archived",
  "phoenix_crm_customer_dropped",
  "phoenix_crm_customer_not_found",
  "phoenix_crm_not_archived",
  "phoenix_crm_not_on_list",
  "phoenix_crm_not_on_reference_list",
  "phoenix_crm_not_outside",
  "phoenix_crm_not_validated",
  "phoenix_crm_same_grade",
]);

export type ListNotice = { tone: NoteTone; title: string; message?: string | null };

/**
 * A place just saved with a live photo: a customer validated onto the list, a new customer waiting
 * outside it for the district manager and SFE, or another clinic added to a customer.
 */
export type SavedPlace = {
  kind: "validated" | "waiting" | "added";
  customerId: string;
  customerName: string;
  listType: PhoenixCrmListType;
};

/** Where the List tab is. Only the screen that took a photo holds it, and "saved" hands it on. */
export type ListScreen =
  | { name: "home" }
  | { name: "customer"; customerId: string }
  | { name: "validate"; contactCrmId: number }
  | { name: "new" }
  | { name: "restore"; customerId: string; from: "customer" | "list" }
  | { name: "add-request"; customerId: string }
  | { name: "add-place"; customerId: string; draft: PlaceDraftState | null }
  | { name: "edit-place"; customerId: string; placeId: string }
  | { name: "move-place"; customerId: string; placeId: string }
  | { name: "grade"; customerId: string }
  | { name: "edit-details"; customerId: string }
  | { name: "drop"; customerId: string | null; contactCrmId: number | null }
  | { name: "saved"; saved: SavedPlace; photo: CapturedPhoto };

/** What every List screen reads. */
export type ListScreenBase = {
  cairoToday: string;
  /** A read of the list is on its way, so a customer missing now may arrive with it. */
  refreshing: boolean;
  seatId: string;
  test: boolean;
  view: TerritoryListView;
  /** Put a list read while checking a save straight on screen. */
  onView: (next: TerritoryListView) => void;
  reload: () => void;
};

export function listUrl(seatId: string, test: boolean): string {
  return crmUrl("/api/phoenix-crm/list", { seatId, test });
}

/**
 * The same seat's list as the Reps List / My List board holds it — grouped by brick, with the
 * AM · PM · Pharmacies breakdown and this month's activity on each row.
 *
 * It is a SECOND read of the same territory, not a replacement for `listUrl`: the CRM list carries
 * what a rep can act on (places, timings, pending validations, requests), the board carries how the
 * list is shaped (bricks, coverage, who has not been visited). The two are joined on screen by the
 * contact's CRM id. `month` is left off unless a month is being chosen, so the server picks the
 * current one in Cairo rather than the browser's idea of today.
 */
export function listBoardUrl(seatId: string, test: boolean, month?: string): string {
  return crmUrl("/api/phoenix-crm/list/board", { month, seatId, test });
}

/** Who decides a grade change — the district manager's one step — as a sentence. */
export function deciderText(view: Pick<TerritoryListView, "isTest" | "territory">): string {
  if (view.isTest) return "In test mode it is decided under Requests.";
  return view.territory.reviewerName ? `${view.territory.reviewerName} decides it.` : "The manager above this territory decides it.";
}

/**
 * Who decides a drop, an add or a bring-back — the district manager, then SFE (owner, 2026-09-29) — as
 * the sentence the rep reads, e.g. "Waiting for your district manager, then SFE, to add him to your
 * list." A territory with no manager seat above it starts at SFE, exactly as the server files it
 * (`firstRequestStage`).
 */
export function twoStepText(view: Pick<TerritoryListView, "isTest" | "territory">, goal: string): string {
  if (view.isTest) return `Waiting for the district manager, then SFE, to ${goal}. In test mode both steps are decided under Requests.`;
  return view.territory.reviewerHrId ? `Waiting for your district manager, then SFE, to ${goal}.` : `Waiting for SFE to ${goal}.`;
}

/** "Evening clinic: Sat, Mon, Tue · Al Salam Hospital: Sun" — each place and the days it receives. */
export function placesDaysText(customer: Pick<ListCustomer, "places">): string {
  if (customer.places.length === 0) return "No place on the list";
  return customer.places
    .map((place, index) => `${placeName(place, index)}: ${receivingDaysLabel(place.timings) || "no normal days"}`)
    .join(" · ");
}

/** The kinds of the requests waiting on a customer, which `listMovesFor` reads. */
export function waitingKinds(customer: Pick<ListCustomer, "waiting">): Set<PhoenixCrmRequestKind> {
  return new Set(customer.waiting.map((entry) => entry.kind));
}

/** The list moves this customer's page offers the rep (owner, 2026-09-29), from the one pure rule. */
export function movesOf(customer: ListCustomer): ListMove[] {
  return listMovesFor(customer, waitingKinds(customer));
}

type PhotoLookup =
  | { found: true; view: TerritoryListView; customer: ListCustomer; place: ListPlace }
  | { found: false; view: TerritoryListView };

/** Reads the list again and finds the place saved with this photo. Null when the list could not be read. */
async function lookUpPhoto(seatId: string, test: boolean, photoPath: string): Promise<PhotoLookup | null> {
  try {
    const view = await crmGet<TerritoryListView>(listUrl(seatId, test), "list");
    for (const customer of view.customers) {
      const place = customer.places.find((entry) => entry.photoPath === photoPath);
      if (place) return { found: true, view, customer, place };
    }
    return { found: false, view };
  } catch {
    return null;
  }
}

/** Clears the draft's photo, unless the rep already took another one. */
function withoutPhoto(photo: CapturedPhoto) {
  return (current: PlaceDraftState): PlaceDraftState => (current.photo?.path === photo.path ? { ...current, photo: null } : current);
}

function normalizedName(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** A screen whose customer is gone (dropped, decided, or read again) — or still on its way. */
export function ListGone({
  backLabel,
  message,
  onBack,
  refreshing,
  title,
}: {
  backLabel: "Customer" | "List";
  message: string;
  onBack: () => void;
  refreshing: boolean;
  title: string;
}) {
  return (
    <CrmPanel>
      <CrmBackBar backLabel={backLabel} onBack={onBack} title={title} />
      {refreshing ? (
        <CrmLoading label="Loading the list" />
      ) : (
        <CrmBlock>
          <CrmNote tone="info">{message}</CrmNote>
          <div className="mt-3 grid gap-2 sm:flex sm:flex-wrap">
            <CrmButton onClick={onBack}>{backLabel === "List" ? "Back to the list" : "Back to the customer"}</CrmButton>
          </div>
        </CrmBlock>
      )}
    </CrmPanel>
  );
}

function SaveBar({
  busy,
  children,
  label,
  onCancel,
  onSave,
  problem,
}: {
  busy: boolean;
  children?: ReactNode;
  label: string;
  onCancel: () => void;
  onSave: () => void;
  problem: string | null;
}) {
  return (
    <CrmBlock className="border-t border-slate-100">
      {problem ? (
        <CrmNote className="mb-3" tone="bad">
          {problem}
        </CrmNote>
      ) : null}
      {children}
      <div className="grid gap-2 sm:flex sm:flex-wrap">
        <CrmButton busy={busy} onClick={onSave} variant="primary">
          {label}
        </CrmButton>
        <CrmButton disabled={busy} onClick={onCancel}>
          Cancel
        </CrmButton>
      </div>
    </CrmBlock>
  );
}

function CustomerHeading({
  children,
  customer,
}: {
  children?: ReactNode;
  customer: Pick<ListCustomer, "name" | "listType" | "grade" | "speciality">;
}) {
  return (
    <>
      <p className="break-words text-base font-black text-slate-950">{customer.name}</p>
      <p className="mt-0.5 break-words text-xs font-semibold text-slate-500">{customerMetaText(customer)}</p>
      {children}
    </>
  );
}

function Detail({ children, label }: { children: ReactNode; label: string }) {
  return (
    <p className="mt-1 break-words text-sm font-medium leading-6 text-slate-600">
      <span className="font-black text-slate-800">{label}: </span>
      {children}
    </p>
  );
}

/** An optional note for a request, with its count. */
function RequestNoteField({ disabled, id, onChange, value }: { disabled: boolean; id: string; onChange: (next: string) => void; value: string }) {
  return (
    <CrmField hint={`Optional · ${value.trim().length} of ${REQUEST_NOTE_MAX} characters`} htmlFor={id} label="Note">
      <textarea
        className={crmTextareaClassName}
        disabled={disabled}
        id={id}
        maxLength={REQUEST_NOTE_MAX}
        onChange={(event) => onChange(event.target.value)}
        value={value}
      />
    </CrmField>
  );
}

// ── Validating a customer ───────────────────────────────────────────────────────────────────────

/** A customer carried over from iReports360, or "Add new customer" (validated on the spot). */
export type ValidateSubject = { mode: "reference"; contactCrmId: number } | { mode: "new" };

function validateGone(view: TerritoryListView, subject: ValidateSubject, reference: ListReferenceEntry | null): string | null {
  // A manager of the territory validates a CARRIED-OVER customer beside its rep (owner, 2026-10-02);
  // "Add new customer" stays the rep's, because the request it files is the manager's to decide.
  if (subject.mode === "reference" ? !view.canValidateReference : !view.canEdit) return EDIT_ONLY;
  if (subject.mode === "reference") {
    if (!reference) return "This customer is no longer on the territory's reference list.";
    if (reference.state === "validated") return "This customer is already validated. Find it under Your list.";
    if (reference.state === "dropped") return "This customer is in the Archive. Open it there to ask to bring it back to your list.";
  }
  return null;
}

/** What a validation answered, as the saved screen reads it. */
function savedFromResult(result: ValidateResult): SavedPlace {
  return {
    kind: result.status === "outside" ? "waiting" : "validated",
    customerId: result.customerId,
    customerName: result.customerName,
    listType: result.listType,
  };
}

export function ValidateScreen({
  backLabel = "List",
  cairoToday,
  onAddPlaceInstead,
  onAskToDrop,
  onBack,
  onSaved,
  onView,
  refreshing,
  reload,
  seatId,
  subject,
  test,
  view,
}: ListScreenBase & {
  /** Where Back leads: the customer's page, or the list. */
  backLabel?: "Customer" | "List";
  /** The customer turned out to be on the list already: the place entered here goes to that customer. */
  onAddPlaceInstead: (customerId: string, draft: PlaceDraftState) => void;
  /**
   * A carried-over customer who is no longer his to see: ask to drop him instead of validating. The
   * list row carries Validate alone (owner, 2026-09-29), so this is where the drop is reached from.
   */
  onAskToDrop?: (customerId: string) => void;
  onBack: () => void;
  onSaved: (saved: SavedPlace, photo: CapturedPhoto) => void;
  subject: ValidateSubject;
}) {
  const [draft, setDraft] = useState<PlaceDraftState>(emptyPlaceDraft);
  const [listType, setListType] = useState<PhoenixCrmListType | null>(null);
  const [name, setName] = useState("");
  const [speciality, setSpeciality] = useState("");
  // Optional, and saved with the validation itself (owner, 2026-09-30).
  const [phone, setPhone] = useState("");
  const [grade, setGrade] = useState<PhoenixCrmGrade | null>(null);
  const [sameName, setSameName] = useState<ListCustomer[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const reference = subject.mode === "reference" ? (view.reference.find((entry) => entry.contactCrmId === subject.contactCrmId) ?? null) : null;
  // The carried-over customer this entry was minted as, while he waits to be validated.
  const pendingCustomer =
    subject.mode === "reference"
      ? (view.customers.find((customer) => customer.referenceContactCrmId === subject.contactCrmId && customer.status === "pending") ?? null)
      : null;
  const title = subject.mode === "new" ? "Add new customer" : "Validate a customer";

  function close() {
    if (saving) return;
    releaseCapturedPhoto(draft.photo);
    onBack();
  }

  const gone = validateGone(view, subject, reference);
  if (gone) {
    return <ListGone backLabel={backLabel} message={gone} onBack={close} refreshing={refreshing} title={title} />;
  }

  const cleanName = normalizedName(name);
  const customerName = reference?.name ?? cleanName;
  const specialityOptions = subject.mode === "new" ? knownSpecialities(view) : [];
  const canAskToDrop = Boolean(onAskToDrop && pendingCustomer && movesOf(pendingCustomer).includes("ask_to_drop"));

  function clientProblem(): string | null {
    if (subject.mode === "new") {
      if (!listType) return "Choose AM or PM.";
      if (cleanName.length < 3) return "Write the customer's full name.";
      if (!grade) return "Propose a grade (A, B or C).";
    }
    const phoneCheck = parseCustomerPhone(phone);
    if (!phoneCheck.ok) return phoneCheck.error;
    return placeDraftProblem(draft, { needsPhoto: true });
  }

  function payloadFor(photo: CapturedPhoto, allowSameName: boolean): Record<string, unknown> {
    const place = placePayload(photo, draft);
    const phoneValue = phone.trim() || null;
    if (subject.mode === "reference") return { seatId, test, mode: "reference", referenceContactCrmId: subject.contactCrmId, phone: phoneValue, place };
    return {
      seatId,
      test,
      mode: "new",
      customer: { listType, name: cleanName, speciality: normalizedName(speciality) || null, proposedGrade: grade },
      allowSameName,
      phone: phoneValue,
      place,
    };
  }

  /** Customers of the same kind whose name matches, the way the database compares them. */
  function sameNameIn(list: TerritoryListView): ListCustomer[] {
    const needle = cleanName.toLowerCase();
    return list.customers.filter(
      (customer) =>
        (customer.status === "active" || customer.status === "outside" || customer.status === "pending") &&
        customer.listType === listType &&
        customer.name.toLowerCase() === needle,
    );
  }

  async function save(allowSameName: boolean) {
    if (saving) return;
    const gap = clientProblem();
    const photo = draft.photo;
    if (gap || !photo) {
      setProblem(gap ?? PHOTO_NEEDED);
      return;
    }
    setSaving(true);
    setProblem(null);
    setSameName(null);
    try {
      const result = await crmPost<ValidateResult>("/api/phoenix-crm/list/validate", payloadFor(photo, allowSameName), "result");
      onSaved(savedFromResult(result), photo);
    } catch (error) {
      const code = errorCodeOf(error);
      const lookup = code && MAY_HAVE_SAVED.has(code) ? await lookUpPhoto(seatId, test, photo.path) : null;
      if (lookup?.found) {
        onView(lookup.view);
        onSaved(
          {
            kind: lookup.customer.status === "outside" ? "waiting" : "validated",
            customerId: lookup.customer.customerId,
            customerName: lookup.customer.name,
            listType: lookup.customer.listType,
          },
          photo,
        );
        return;
      }
      if (lookup) onView(lookup.view);
      setSaving(false);
      if (code === "phoenix_crm_same_name") {
        setSameName(sameNameIn(lookup?.view ?? view));
        return;
      }
      if (!lookup && (code === "phoenix_crm_photo_used" || code === "phoenix_crm_already_validated")) {
        setProblem(UNCHECKED);
        return;
      }
      if (code?.startsWith("phoenix_crm_photo_")) {
        releaseCapturedPhoto(photo);
        setDraft(withoutPhoto(photo));
      } else if (code === "phoenix_crm_not_on_reference_list" || code === "phoenix_crm_customer_not_found" || code === "phoenix_crm_archived") {
        reload();
      }
      setProblem(messageOf(error));
    }
  }

  const referenceAddress = referenceAddressText(reference);

  return (
    <CrmPanel>
      <CrmBackBar backLabel={backLabel} onBack={close} title={title} />
      <CrmBlock>
        <p className="break-words text-sm font-semibold text-slate-600">{territoryLine(view.territory)}</p>
      </CrmBlock>

      {reference ? (
        <CrmBlock className="border-t border-slate-100" title="Customer">
          <CustomerHeading customer={reference}>
            <div className="mt-2">
              {referenceAddress ? <Detail label="Address in iReports360">{referenceAddress}</Detail> : null}
              <Detail label="Last visit in iReports360">{referenceLastVisitText(reference)}</Detail>
            </div>
          </CustomerHeading>
          {reference.state === "drop_pending" ? (
            <CrmNote className="mt-3" tone="info">
              You asked for this customer to leave the list. Validating withdraws that request.
            </CrmNote>
          ) : null}
          {/* Owner, 2026-09-22, kept 2026-09-29: validating is the captures and nothing else, once and for
              good. The name and the grade are changed later, from the customer's own page. */}
          <p className="mt-3 text-xs font-semibold leading-5 text-slate-500">
            The name and grade are iReports360&apos;s for now — you can change them later from the customer&apos;s page. The signboard photo,
            the location and the days and hours become this customer&apos;s real record, and its visits start counting. You validate a customer
            once.
          </p>
          {/* Owner, 2026-09-30: the phone is asked for here, optional, and saved with the validation. */}
          <CustomerPhoneField
            className="mt-3 sm:max-w-sm"
            disabled={saving}
            hint="Optional. You can add or change it later from the customer's page."
            id="phoenix-crm-validate-phone"
            onChange={(next) => {
              setPhone(next);
              setProblem(null);
            }}
            value={phone}
          />
        </CrmBlock>
      ) : null}

      {subject.mode === "new" ? (
        <CrmBlock className="border-t border-slate-100" title="1 · Customer">
          <div className="grid min-w-0 gap-3 sm:grid-cols-2">
            <CrmField className="sm:col-span-2" label="AM or PM">
              <CrmChoice
                columns={2}
                label="AM or PM"
                onChange={(next) => {
                  setListType(next);
                  setSameName(null);
                  setProblem(null);
                }}
                options={[
                  { value: "PM", label: listText("PM"), note: "In a clinic", disabled: saving },
                  { value: "AM", label: listText("AM"), note: "A hospital or a center", disabled: saving },
                ]}
                value={listType}
              />
            </CrmField>
            <CrmField className="sm:col-span-2" hint="As written on the sign." htmlFor="phoenix-crm-new-name" label="Full name">
              <input
                autoComplete="off"
                className={crmInputClassName}
                disabled={saving}
                id="phoenix-crm-new-name"
                maxLength={CUSTOMER_NAME_MAX}
                onChange={(event) => {
                  setName(event.target.value);
                  setSameName(null);
                  setProblem(null);
                }}
                value={name}
              />
            </CrmField>
            <CrmField hint="Optional. Pick one from the list or write it." htmlFor="phoenix-crm-new-speciality" label="Speciality">
              <input
                autoComplete="off"
                className={crmInputClassName}
                disabled={saving}
                id="phoenix-crm-new-speciality"
                list="phoenix-crm-new-specialities"
                maxLength={SPECIALITY_TEXT_MAX}
                onChange={(event) => setSpeciality(event.target.value)}
                value={speciality}
              />
              <datalist id="phoenix-crm-new-specialities">
                {specialityOptions.map((option) => (
                  <option key={option} value={option} />
                ))}
              </datalist>
            </CrmField>
            <CustomerPhoneField
              disabled={saving}
              id="phoenix-crm-new-phone"
              onChange={(next) => {
                setPhone(next);
                setProblem(null);
              }}
              value={phone}
            />
            <CrmField
              className="sm:col-span-2"
              hint="Your district manager confirms it or changes it, then SFE approves adding the customer to your list."
              label="Proposed grade"
            >
              <CrmChoice
                columns={3}
                label="Proposed grade"
                onChange={(next) => {
                  setGrade(next);
                  setProblem(null);
                }}
                options={GRADES.map((option) => ({ value: option, label: `Grade ${option}`, disabled: saving }))}
                value={grade}
              />
            </CrmField>
          </div>
        </CrmBlock>
      ) : null}

      <PlaceEditor
        capture
        customerName={customerName}
        disabled={saving}
        firstStep={subject.mode === "new" ? 2 : 1}
        idPrefix="phoenix-crm-validate"
        onChange={setDraft}
        photoBlockedReason={subject.mode === "new" && !cleanName ? "Write the customer's full name first. It is printed on the photo." : null}
        ramadanNote={ramadanHoursNote(view.ramadan, cairoToday)}
        seatId={seatId}
        test={test}
        value={draft}
      />

      <SaveBar
        busy={saving}
        label={subject.mode === "new" ? "Save the customer" : "Validate the customer"}
        onCancel={close}
        onSave={() => void save(false)}
        problem={problem}
      >
        {subject.mode === "new" ? (
          <p className="mb-3 text-sm font-medium leading-6 text-slate-600">
            {twoStepText(view, "add him to your list")} Until then the customer waits under Outside the list, and the visits you
            save count once the customer is on your list.
          </p>
        ) : null}
        {sameName ? (
          <CrmNote className="mb-3" title="A customer with this name is already on the list" tone="warn">
            {sameName.length > 0 ? (
              <ul className="mt-2 grid gap-2">
                {sameName.map((match) => {
                  const full = match.places.length >= view.rules.placesMax;
                  // Another clinic goes to a customer who has a place already: on the list, or waiting outside it.
                  const takesPlace = match.status === "active" || match.status === "outside";
                  return (
                    <li className="grid min-w-0 gap-2 border border-amber-200 bg-white px-3 py-2.5 text-slate-700" key={match.customerId}>
                      <span className="min-w-0">
                        <span className="block break-words font-black text-slate-950">{match.name}</span>
                        <span className="block break-words text-xs font-semibold text-slate-500">{customerMetaText(match)}</span>
                        <span className="block break-words text-xs font-semibold text-slate-600">{placesDaysText(match)}</span>
                      </span>
                      {takesPlace ? (
                        <span className="flex flex-wrap gap-2">
                          <CrmButton
                            disabled={saving || full}
                            onClick={() => onAddPlaceInstead(match.customerId, draft)}
                            size="sm"
                            variant="primary"
                          >
                            {full ? `Has ${view.rules.placesMax} clinics already` : "Add this clinic to this customer"}
                          </CrmButton>
                        </span>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : null}
            <p className="mt-2">
              The same customer at another clinic: add this clinic to that customer, and the photo and the days and hours you entered go with it. A
              different person with the same name: save as a different person.
            </p>
            <div className="mt-3 grid gap-2 sm:flex sm:flex-wrap">
              <CrmButton busy={saving} onClick={() => void save(true)}>
                Save as a different person
              </CrmButton>
            </div>
          </CrmNote>
        ) : null}
      </SaveBar>

      {canAskToDrop && pendingCustomer && onAskToDrop ? (
        <CrmBlock className="border-t border-slate-100" title="Not your customer any more?">
          <p className="text-sm font-medium leading-6 text-slate-600">
            A customer who moved, retired or closed is not validated. Ask to drop the customer from your list instead.
          </p>
          <div className="mt-3 grid gap-2 sm:flex sm:flex-wrap">
            <CrmButton disabled={saving} onClick={() => onAskToDrop(pendingCustomer.customerId)} variant="danger">
              Ask to drop
            </CrmButton>
          </div>
        </CrmBlock>
      ) : null}
    </CrmPanel>
  );
}

/** The specialities already on this territory's lists, offered while typing a new one. */
function knownSpecialities(view: TerritoryListView): string[] {
  const names = new Set<string>();
  for (const entry of view.reference) if (entry.speciality) names.add(entry.speciality);
  for (const customer of view.customers) if (customer.speciality) names.add(customer.speciality);
  return [...names].sort((left, right) => left.localeCompare(right));
}

// ── After a place is saved ──────────────────────────────────────────────────────────────────────

/**
 * The screen after a save. It offers no visit: a visit starts from Visits, Today or the portal's "+"
 * (owner, 2026-09-29), never from the List.
 */
export function SavedScreen({
  onBack,
  onOpenCustomer,
  photo,
  saved,
  view,
}: {
  onBack: () => void;
  onOpenCustomer: () => void;
  photo: CapturedPhoto;
  saved: SavedPlace;
  view: TerritoryListView;
}) {
  const heading =
    saved.kind === "added" ? `Clinic added: ${saved.customerName}` : saved.kind === "waiting" ? `Saved: ${saved.customerName}` : `Validated: ${saved.customerName}`;
  return (
    <CrmPanel>
      <CrmBackBar backLabel="List" onBack={onBack} title={saved.kind === "added" ? "Clinic added" : "Customer saved"} />
      <CrmBlock>
        <CrmNote title={heading} tone="good">
          {listText(saved.listType)} · {capturedLocationText(photo.address)}
        </CrmNote>
        {saved.kind === "waiting" ? (
          <CrmNote className="mt-3" title="Waiting outside your list" tone="info">
            {twoStepText(view, "add him to your list")} You find the customer under Outside the list.
          </CrmNote>
        ) : null}
        {saved.kind === "validated" ? (
          <p className="mt-3 text-sm font-medium leading-6 text-slate-600">
            The customer is on your list, and the visits already saved here count from now on.
          </p>
        ) : null}
      </CrmBlock>
      <CrmBlock className="border-t border-slate-100">
        <div className="grid gap-2 sm:flex sm:flex-wrap">
          <CrmButton onClick={onOpenCustomer} variant="primary">
            Open the customer
          </CrmButton>
          <CrmButton onClick={onBack}>Back to the list</CrmButton>
        </div>
      </CrmBlock>
    </CrmPanel>
  );
}

// ── Another clinic ──────────────────────────────────────────────────────────────────────────────

export function AddPlaceScreen({
  cairoToday,
  customerId,
  initialDraft,
  onBack,
  onSaved,
  onView,
  refreshing,
  reload,
  seatId,
  test,
  view,
}: ListScreenBase & {
  customerId: string;
  /** A clinic entered on Add new customer, when that customer turned out to be on the list already. */
  initialDraft: PlaceDraftState | null;
  onBack: () => void;
  onSaved: (saved: SavedPlace, photo: CapturedPhoto) => void;
}) {
  const [draft, setDraft] = useState<PlaceDraftState>(() => initialDraft ?? emptyPlaceDraft());
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  function close() {
    if (saving) return;
    releaseCapturedPhoto(draft.photo);
    onBack();
  }

  const customer = view.customers.find((entry) => entry.customerId === customerId) ?? null;
  const gone = !view.canEdit
    ? EDIT_ONLY
    : !customer
      ? NOT_ON_LIST
      : customer.status === "dropped"
        ? "This customer is in the Archive."
        : customer.status === "pending"
          ? "Validate this customer first. Validating takes the first clinic."
          : customer.places.length >= view.rules.placesMax
            ? `A customer can have at most ${view.rules.placesMax} clinics.`
            : null;
  if (!customer || gone) {
    return <ListGone backLabel="Customer" message={gone ?? NOT_ON_LIST} onBack={close} refreshing={refreshing} title="Add another clinic" />;
  }

  async function save() {
    if (saving || !customer) return;
    const gap = placeDraftProblem(draft, { needsPhoto: true });
    const photo = draft.photo;
    if (gap || !photo) {
      setProblem(gap ?? PHOTO_NEEDED);
      return;
    }
    const saved: SavedPlace = {
      kind: "added",
      customerId: customer.customerId,
      customerName: customer.name,
      listType: customer.listType,
    };
    setSaving(true);
    setProblem(null);
    try {
      await crmPost<unknown>("/api/phoenix-crm/list/places", { seatId, test, customerId: customer.customerId, place: placePayload(photo, draft) }, "place");
      onSaved(saved, photo);
    } catch (error) {
      const code = errorCodeOf(error);
      const lookup = code && MAY_HAVE_SAVED.has(code) ? await lookUpPhoto(seatId, test, photo.path) : null;
      if (lookup?.found) {
        onView(lookup.view);
        onSaved(saved, photo);
        return;
      }
      if (lookup) onView(lookup.view);
      setSaving(false);
      if (!lookup && code === "phoenix_crm_photo_used") {
        setProblem(UNCHECKED);
        return;
      }
      if (code?.startsWith("phoenix_crm_photo_")) {
        releaseCapturedPhoto(photo);
        setDraft(withoutPhoto(photo));
      } else if (code === "phoenix_crm_customer_dropped" || code === "phoenix_crm_customer_not_found" || code === "phoenix_crm_too_many_places") {
        reload();
      }
      setProblem(messageOf(error));
    }
  }

  return (
    <CrmPanel>
      <CrmBackBar backLabel="Customer" onBack={close} title="Add another clinic" />
      <CrmBlock title="Customer">
        <CustomerHeading customer={customer}>
          <Detail label="Clinics now">{placesDaysText(customer)}</Detail>
        </CustomerHeading>
        <p className="mt-3 text-xs font-semibold leading-5 text-slate-500">
          A clinic is where the customer receives visits. It is validated the same way — its own signboard photo, location and days and hours — and
          its location is fixed once saved.
        </p>
      </CrmBlock>

      <PlaceEditor
        capture
        customerName={customer.name}
        disabled={saving}
        firstStep={1}
        idPrefix="phoenix-crm-add-place"
        onChange={setDraft}
        ramadanNote={ramadanHoursNote(view.ramadan, cairoToday)}
        seatId={seatId}
        test={test}
        value={draft}
      />

      <SaveBar busy={saving} label="Save the clinic" onCancel={close} onSave={() => void save()} problem={problem} />
    </CrmPanel>
  );
}

// ── A clinic's days and hours ───────────────────────────────────────────────────────────────────

export function EditPlaceScreen(
  props: ListScreenBase & {
    customerId: string;
    onBack: () => void;
    onDone: (notice: ListNotice) => void;
    placeId: string;
  },
) {
  const { customerId, onBack, placeId, refreshing, view } = props;
  const customer = view.customers.find((entry) => entry.customerId === customerId) ?? null;
  const index = customer ? customer.places.findIndex((place) => place.placeId === placeId) : -1;
  const place = customer && index >= 0 ? customer.places[index] : null;
  const gone = !view.canEdit ? EDIT_ONLY : !customer ? NOT_ON_LIST : !place ? "This clinic is no longer on the list." : null;
  if (!customer || !place || gone) {
    return <ListGone backLabel="Customer" message={gone ?? NOT_ON_LIST} onBack={onBack} refreshing={refreshing} title="Change days and hours" />;
  }
  // Keyed by the place, so the form starts from that place's saved days and hours.
  return <EditPlaceForm {...props} customer={customer} index={index} key={place.placeId} place={place} />;
}

function EditPlaceForm({
  cairoToday,
  customer,
  index,
  onBack,
  onDone,
  place,
  reload,
  seatId,
  test,
  view,
}: ListScreenBase & {
  customer: ListCustomer;
  index: number;
  onBack: () => void;
  onDone: (notice: ListNotice) => void;
  place: ListPlace;
}) {
  // The location is not in the draft: it was resolved from the captured readings and is fixed (owner,
  // 2026-09-23, 2026-09-29). An edit reaches the clinic's NAME and its days and hours, nothing else.
  const [draft, setDraft] = useState<PlaceDraftState>(() => ({
    photo: null,
    pin: null,
    label: place.label ?? "",
    timings: place.timings,
  }));
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const name = placeName(place, index);

  async function save() {
    if (saving) return;
    const gap = placeDraftProblem(draft, { needsPhoto: false });
    if (gap) {
      setProblem(gap);
      return;
    }
    setSaving(true);
    setProblem(null);
    const label = draft.label.trim() || null;
    try {
      await crmPost<unknown>(
        "/api/phoenix-crm/list/places/update",
        {
          seatId,
          test,
          placeId: place.placeId,
          action: "edit",
          timings: timingsToDrafts(draft.timings),
          label,
        },
        "place",
      );
      onDone({ tone: "good", title: `Days and hours saved: ${placeName({ label, zone: place.zone, brickName: place.brickName }, index)}`, message: customer.name });
    } catch (error) {
      const code = errorCodeOf(error);
      if (code === "phoenix_crm_place_not_found" || code === "phoenix_crm_place_retired") reload();
      setProblem(messageOf(error));
      setSaving(false);
    }
  }

  return (
    <CrmPanel>
      <CrmBackBar backLabel="Customer" onBack={onBack} title={`Change ${name}`} />
      <CrmBlock>
        <CustomerHeading customer={customer} />
        <div className="mt-3 flex min-w-0 flex-wrap items-start gap-3">
          <CrmPhotoThumb alt={`Signboard photo: ${customer.name}`} caption={`${customer.name} · ${name} · ${cairoStamp(place.capturedAt)}`} path={place.photoPath} />
          <p className="min-w-0 flex-1 break-words text-xs font-semibold leading-5 text-slate-600">
            Signboard photo and location taken {cairoStamp(place.capturedAt)}. They are this clinic&apos;s fixed record; the days and hours and the
            clinic&apos;s name are yours to change.
          </p>
        </div>
      </CrmBlock>

      <PlaceEditor
        capture={false}
        customerName={customer.name}
        disabled={saving}
        firstStep={1}
        idPrefix={`phoenix-crm-place-${place.placeId}`}
        location={{
          address: place.address,
          areaName: place.areaName,
          brickName: place.brickName,
          lat: place.lat,
          lon: place.lon,
          regionName: place.regionName,
          zone: place.zone,
        }}
        onChange={setDraft}
        ramadanNote={ramadanHoursNote(view.ramadan, cairoToday)}
        seatId={seatId}
        test={test}
        value={draft}
      />

      <SaveBar busy={saving} label="Save the days and hours" onCancel={onBack} onSave={() => void save()} problem={problem} />
    </CrmPanel>
  );
}

// ── The grade: one step, the district manager ───────────────────────────────────────────────────

function gradeGone(customer: ListCustomer): string | null {
  if (customer.status === "pending") return "Validate this customer first. The grade is proposed once the customer is on your list.";
  if (customer.status === "outside") return "The grade is set when the customer is added to your list.";
  if (customer.status === "dropped") return "This customer is in the Archive.";
  return null;
}

export function GradeScreen({
  customerId,
  onBack,
  onDone,
  refreshing,
  reload,
  seatId,
  test,
  view,
}: ListScreenBase & {
  customerId: string;
  onBack: () => void;
  onDone: (notice: ListNotice) => void;
}) {
  const [grade, setGrade] = useState<PhoenixCrmGrade | null>(null);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const customer = view.customers.find((entry) => entry.customerId === customerId) ?? null;
  const gone = !view.canEdit ? EDIT_ONLY : !customer ? NOT_ON_LIST : gradeGone(customer);
  if (!customer || gone) {
    return <ListGone backLabel="Customer" message={gone ?? NOT_ON_LIST} onBack={onBack} refreshing={refreshing} title="Propose a grade" />;
  }

  async function save() {
    if (saving || !customer) return;
    if (!grade) {
      setProblem("Choose the grade you propose (A, B or C).");
      return;
    }
    setSaving(true);
    setProblem(null);
    try {
      await crmPost<unknown>("/api/phoenix-crm/list/requests", { seatId, test, kind: "grade", customerId: customer.customerId, proposedGrade: grade }, "request");
      onDone({ tone: "good", title: `Grade ${grade} proposed: ${customer.name}`, message: deciderText(view) });
    } catch (error) {
      const code = errorCodeOf(error);
      if (code && REQUEST_RELOAD.has(code)) reload();
      setProblem(messageOf(error));
      setSaving(false);
    }
  }

  return (
    <CrmPanel>
      <CrmBackBar backLabel="Customer" onBack={onBack} title="Propose a grade" />
      <CrmBlock>
        <CustomerHeading customer={customer}>
          <Detail label="This month">{monthVisitsText(customer.visitsThisMonth, customer.target)}</Detail>
        </CustomerHeading>
      </CrmBlock>
      {customer.pendingGradeRequestId ? (
        <CrmBlock className="border-t border-slate-100">
          <CrmNote title={customer.pendingGrade ? `Grade ${customer.pendingGrade} is proposed and waiting for a decision` : "A grade is proposed and waiting for a decision"} tone="info">
            {deciderText(view)} To propose another grade, withdraw that request first.
          </CrmNote>
          <div className="mt-3 grid gap-2 sm:flex sm:flex-wrap">
            <CrmButton onClick={onBack}>Back to the customer</CrmButton>
          </div>
        </CrmBlock>
      ) : (
        <>
          <CrmBlock className="border-t border-slate-100" title="The grade you propose">
            <CrmChoice
              columns={3}
              label="The grade you propose"
              onChange={(next) => {
                setGrade(next);
                setProblem(null);
              }}
              options={GRADES.map((option) => ({
                value: option,
                label: `Grade ${option}`,
                note: option === customer.grade ? "Current grade" : undefined,
                disabled: saving || option === customer.grade,
              }))}
              value={grade}
            />
            <p className="mt-3 text-sm font-medium leading-6 text-slate-600">
              {deciderText(view)} Until then the customer keeps {customer.grade ? `grade ${customer.grade}` : "no grade"}.
            </p>
          </CrmBlock>
          <SaveBar busy={saving} label="Send the proposal" onCancel={onBack} onSave={() => void save()} problem={problem} />
        </>
      )}
    </CrmPanel>
  );
}

/**
 * The customer's name, speciality and phone, corrected later.
 *
 * Owner, 2026-09-22: "later can change his name, can change his grade". Validating is the captures and
 * nothing else, so the name arrives from iReports360 as it was typed there — often a title, a short
 * form or a misspelling. The grade is not here: it keeps its proposal flow, because it sets the number
 * of visits this customer is owed, and therefore the rep's own target.
 *
 * Owner, 2026-09-30: the phone is corrected here too — numbers change. Emptying the box clears it.
 */
export function EditDetailsScreen({
  customerId,
  onBack,
  onDone,
  refreshing,
  reload,
  seatId,
  test,
  view,
}: ListScreenBase & {
  customerId: string;
  onBack: () => void;
  onDone: (notice: ListNotice) => void;
}) {
  const customer = view.customers.find((entry) => entry.customerId === customerId) ?? null;
  const [name, setName] = useState(customer?.name ?? "");
  const [speciality, setSpeciality] = useState(customer?.speciality ?? "");
  const [phone, setPhone] = useState(customer?.phone ?? "");
  const [sameName, setSameName] = useState(false);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const gone = !view.canEdit ? EDIT_ONLY : !customer ? NOT_ON_LIST : customer.status === "dropped" ? "This customer is in the Archive." : null;
  if (!customer || gone) {
    return <ListGone backLabel="Customer" message={gone ?? NOT_ON_LIST} onBack={onBack} refreshing={refreshing} title="Change the details" />;
  }

  const cleanName = normalizedName(name);
  const cleanSpeciality = normalizedName(speciality);
  // Compared the way it is saved, so "010 1234 5678" against a saved 01012345678 is no change at all.
  const phoneCheck = parseCustomerPhone(phone);
  const unchanged =
    cleanName === customer.name &&
    cleanSpeciality === (customer.speciality ?? "") &&
    phoneCheck.ok &&
    phoneCheck.value === (customer.phone ?? null);

  async function save(allowSameName: boolean) {
    if (saving || !customer) return;
    if (cleanName.length < 3) {
      setProblem("Write the customer's full name.");
      return;
    }
    if (!phoneCheck.ok) {
      setProblem(phoneCheck.error);
      return;
    }
    if (unchanged) {
      setProblem("Change the name, the speciality or the phone first.");
      return;
    }
    setSaving(true);
    setProblem(null);
    setSameName(false);
    try {
      await crmPost<unknown>(
        "/api/phoenix-crm/list/rename",
        {
          seatId,
          test,
          customerId: customer.customerId,
          name: cleanName,
          speciality: cleanSpeciality || null,
          // Always sent from here, so emptying the box clears the phone.
          phone: phoneCheck.value,
          allowSameName,
        },
        "result",
      );
      onDone({ tone: "good", title: `Details changed: ${cleanName}` });
    } catch (error) {
      const code = errorCodeOf(error);
      if (code === "phoenix_crm_same_name") {
        setSameName(true);
        setSaving(false);
        return;
      }
      if (code && REQUEST_RELOAD.has(code)) reload();
      setProblem(messageOf(error));
      setSaving(false);
    }
  }

  return (
    <CrmPanel>
      <CrmBackBar backLabel="Customer" onBack={onBack} title="Change the details" />
      <CrmBlock>
        <CustomerHeading customer={customer}>
          <Detail label="On the list from">{customer.origin === "reference" ? "The iReports360 list" : "Added in Phoenix"}</Detail>
        </CustomerHeading>
      </CrmBlock>
      <CrmBlock className="border-t border-slate-100" title="Name, speciality and phone">
        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          <CrmField className="sm:col-span-2" hint="As written on the sign." htmlFor="phoenix-crm-details-name" label="Full name">
            <input
              autoComplete="off"
              className={crmInputClassName}
              disabled={saving}
              id="phoenix-crm-details-name"
              maxLength={CUSTOMER_NAME_MAX}
              onChange={(event) => {
                setName(event.target.value);
                setSameName(false);
                setProblem(null);
              }}
              value={name}
            />
          </CrmField>
          <CrmField className="sm:col-span-2" hint="Optional. Pick one from the list or write it." htmlFor="phoenix-crm-details-speciality" label="Speciality">
            <input
              autoComplete="off"
              className={crmInputClassName}
              disabled={saving}
              id="phoenix-crm-details-speciality"
              list="phoenix-crm-details-specialities"
              maxLength={SPECIALITY_TEXT_MAX}
              onChange={(event) => {
                setSpeciality(event.target.value);
                setProblem(null);
              }}
              value={speciality}
            />
            <datalist id="phoenix-crm-details-specialities">
              {knownSpecialities(view).map((option) => (
                <option key={option} value={option} />
              ))}
            </datalist>
          </CrmField>
          <CustomerPhoneField
            disabled={saving}
            hint="Optional. Empty the box to remove it."
            id="phoenix-crm-details-phone"
            onChange={(next) => {
              setPhone(next);
              setProblem(null);
            }}
            value={phone}
          />
        </div>
        <p className="mt-3 text-sm font-medium leading-6 text-slate-600">
          The grade is not changed here. Propose it from the customer&apos;s page. {deciderText(view)}
        </p>
      </CrmBlock>
      {sameName ? (
        <CrmBlock className="border-t border-slate-100">
          <CrmNote title="A customer with this name is already on the list" tone="warn">
            Two customers called {cleanName} are hard to tell apart on a plan. Check the list first; save it anyway only if they really are two
            different customers.
          </CrmNote>
          <div className="mt-3 grid gap-2 sm:flex sm:flex-wrap">
            <CrmButton busy={saving} onClick={() => void save(true)} variant="primary">
              Save it anyway
            </CrmButton>
            <CrmButton disabled={saving} onClick={() => setSameName(false)}>
              Change the name
            </CrmButton>
          </div>
        </CrmBlock>
      ) : (
        <SaveBar busy={saving} label="Save the details" onCancel={onBack} onSave={() => void save(false)} problem={problem} />
      )}
    </CrmPanel>
  );
}

// ── Leaving the list: two steps, the district manager then SFE ──────────────────────────────────

export function DropScreen({
  contactCrmId,
  customerId,
  onBack,
  onDone,
  refreshing,
  reload,
  seatId,
  test,
  view,
}: ListScreenBase & {
  /** A reference customer not validated yet. */
  contactCrmId: number | null;
  /** A customer on the list. */
  customerId: string | null;
  onBack: () => void;
  onDone: (notice: ListNotice) => void;
}) {
  const [reason, setReason] = useState<DropReason | null>(null);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const customer = customerId ? (view.customers.find((entry) => entry.customerId === customerId) ?? null) : null;
  const reference = !customerId && contactCrmId !== null ? (view.reference.find((entry) => entry.contactCrmId === contactCrmId) ?? null) : null;
  const backLabel = customerId ? "Customer" : "List";

  let gone: string | null = null;
  if (!view.canEdit) gone = EDIT_ONLY;
  else if (customerId)
    gone = !customer
      ? NOT_ON_LIST
      : customer.status === "dropped"
        ? "This customer is already in the Archive."
        : customer.status === "outside"
          ? "This customer is not on your list. Drop the customer from its own page, under Outside the list."
          : null;
  else if (!reference) gone = "This customer is no longer on the territory's reference list.";
  else if (reference.state === "validated") gone = "This customer is validated now. Ask to drop it from the customer's page, under Your list.";
  else if (reference.state === "dropped") gone = "This customer is already in the Archive.";

  const subject = customer ?? reference;
  if (!subject || gone) {
    return <ListGone backLabel={backLabel} message={gone ?? NOT_ON_LIST} onBack={onBack} refreshing={refreshing} title="Ask to drop a customer" />;
  }

  // Two different "pending"s meet on this one screen, and they are never the same thing: `pending`
  // below is a drop request already waiting for a decision, while `notValidated` is the customer's own
  // status — carried over from iReports360 and not validated at the door yet. A rep may ask to drop
  // such a customer, so this screen has to read him the way every other screen does.
  const pending = customer ? customer.pendingDropRequestId !== null : reference?.state === "drop_pending";
  const notValidated = customer !== null && customer.status === "pending";
  const waitingStage = customer?.waiting.find((entry) => entry.kind === "drop")?.stageLabel ?? null;
  const noteLength = note.trim().length;
  const until = customer ? "Until then the customer stays on your list." : "Until then the customer stays under To validate.";
  const steps = twoStepText(view, "take him off your list");

  async function save() {
    if (saving || !subject) return;
    if (!reason) {
      setProblem("Choose why this customer should leave your list.");
      return;
    }
    const trimmed = note.trim();
    if (reason === "other" && !trimmed) {
      setProblem("Write why this customer should leave your list.");
      return;
    }
    setSaving(true);
    setProblem(null);
    try {
      await crmPost<unknown>(
        "/api/phoenix-crm/list/requests",
        {
          seatId,
          test,
          kind: "drop",
          customerId: customer?.customerId ?? null,
          referenceContactCrmId: customer ? null : (reference?.contactCrmId ?? null),
          reason,
          note: trimmed || null,
        },
        "request",
      );
      onDone({ tone: "good", title: `Drop requested: ${subject.name}`, message: `${steps} ${until}` });
    } catch (error) {
      const code = errorCodeOf(error);
      if (code && REQUEST_RELOAD.has(code)) reload();
      setProblem(messageOf(error));
      setSaving(false);
    }
  }

  return (
    <CrmPanel>
      <CrmBackBar backLabel={backLabel} onBack={onBack} title="Ask to drop a customer" />
      <CrmBlock>
        <CustomerHeading customer={subject}>
          {/* A customer who is not validated yet has no place and no target, so neither a places line
              nor a month standing is true of him — printing "1 of 3 visits this month" here would
              charge him against a target he does not have. He gets what he has instead: the visits
              saved on him, which count once he is validated, and what iReports360 knows. */}
          {customer && notValidated ? (
            <>
              <Detail label="This month">{pendingVisitsText(customer.visitsThisMonth)}</Detail>
              <Detail label="Last visit in iReports360">{referenceLastVisitText(customer.reference)}</Detail>
            </>
          ) : customer ? (
            <>
              <Detail label="Clinics">{placesDaysText(customer)}</Detail>
              <Detail label="This month">{monthVisitsText(customer.visitsThisMonth, customer.target)}</Detail>
            </>
          ) : reference?.lastVisitedOn ? (
            <Detail label="Last visit in iReports360">{dayLabelWithYear(reference.lastVisitedOn)}</Detail>
          ) : null}
        </CustomerHeading>
        {notValidated ? (
          <div className="mt-2 flex flex-wrap gap-1">
            <CrmPill tone="orange">{PENDING_PILL}</CrmPill>
          </div>
        ) : null}
      </CrmBlock>
      {pending ? (
        <CrmBlock className="border-t border-slate-100">
          <CrmNote title="A drop request for this customer is waiting for a decision" tone="info">
            {waitingStage ? `${waitingStage}. ` : null}
            {until}
          </CrmNote>
          <div className="mt-3 grid gap-2 sm:flex sm:flex-wrap">
            <CrmButton onClick={onBack}>{customer ? "Back to the customer" : "Back to the list"}</CrmButton>
          </div>
        </CrmBlock>
      ) : (
        <>
          <CrmBlock className="border-t border-slate-100" title="1 · Why should the customer leave the list?">
            <CrmChoice
              columns={2}
              label="Why should the customer leave the list?"
              onChange={(next) => {
                setReason(next);
                setProblem(null);
              }}
              options={DROP_REASONS.map((option) => ({ value: option.key, label: option.label, disabled: saving }))}
              value={reason}
            />
          </CrmBlock>
          <CrmBlock className="border-t border-slate-100" title="2 · Note">
            <CrmField
              hint={`${reason === "other" ? "Needed for Other" : "Optional"} · ${noteLength} of ${DROP_REASON_MAX} characters`}
              htmlFor="phoenix-crm-drop-note"
              label="What happened"
            >
              <textarea
                className={crmTextareaClassName}
                disabled={saving}
                id="phoenix-crm-drop-note"
                maxLength={DROP_REASON_MAX}
                onChange={(event) => {
                  setNote(event.target.value);
                  setProblem(null);
                }}
                value={note}
              />
            </CrmField>
          </CrmBlock>
          <CrmBlock className="border-t border-slate-100">
            <p className="text-sm font-medium leading-6 text-slate-600">
              {steps} {until}{" "}
              {customer
                ? `Once approved, the customer moves to the Archive and keeps ${customer.places.length === 1 ? "its clinic" : `its ${plural(customer.places.length, "clinic", "clinics")}`}, so bringing the customer back needs no new photo. A waiting grade request is withdrawn.`
                : "Once approved, the customer counts as done for the list."}
            </p>
          </CrmBlock>
          <SaveBar busy={saving} label="Send the request" onCancel={onBack} onSave={() => void save()} problem={problem} />
        </>
      )}
    </CrmPanel>
  );
}

// ── Onto the list: asking to add a customer met outside it ──────────────────────────────────────

/**
 * "Request to add" (owner, 2026-09-29): a customer the rep validated at the door and who waits outside
 * his list — or one in the Archive who was never admitted — goes to the district manager, who confirms
 * or changes the A/B/C grade and sets the potential, then to SFE. His visits count once he is added, in
 * the month they happened.
 */
export function AddRequestScreen({
  customerId,
  onBack,
  onDone,
  refreshing,
  reload,
  seatId,
  test,
  view,
}: ListScreenBase & {
  customerId: string;
  onBack: () => void;
  onDone: (notice: ListNotice) => void;
}) {
  const customer = view.customers.find((entry) => entry.customerId === customerId) ?? null;
  const [grade, setGrade] = useState<PhoenixCrmGrade | null>(customer?.grade ?? null);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const gone = !view.canEdit
    ? EDIT_ONLY
    : !customer
      ? NOT_ON_LIST
      : movesOf(customer).includes("request_add")
        ? null
        : customer.status === "active"
          ? "This customer is already on your list."
          : customer.waiting.some((entry) => entry.kind === "add")
            ? "Adding this customer is already waiting for a decision."
            : "This customer is not waiting to be added.";
  if (!customer || gone) {
    return <ListGone backLabel="Customer" message={gone ?? NOT_ON_LIST} onBack={onBack} refreshing={refreshing} title="Ask to add to your list" />;
  }
  const steps = twoStepText(view, "add him to your list");

  async function save() {
    if (saving || !customer) return;
    if (!grade) {
      setProblem("Propose a grade (A, B or C).");
      return;
    }
    setSaving(true);
    setProblem(null);
    try {
      await crmPost<unknown>(
        "/api/phoenix-crm/list/requests",
        { seatId, test, kind: "add", customerId: customer.customerId, proposedGrade: grade, note: note.trim() || null },
        "request",
      );
      onDone({ tone: "good", title: `Asked to add: ${customer.name}`, message: steps });
    } catch (error) {
      const code = errorCodeOf(error);
      if (code && REQUEST_RELOAD.has(code)) reload();
      setProblem(messageOf(error));
      setSaving(false);
    }
  }

  return (
    <CrmPanel>
      <CrmBackBar backLabel="Customer" onBack={onBack} title="Ask to add to your list" />
      <CrmBlock>
        <CustomerHeading customer={customer}>
          <Detail label="Clinics">{placesDaysText(customer)}</Detail>
          <Detail label="Visits">{pendingVisitsText(customer.visitsThisMonth)}</Detail>
        </CustomerHeading>
      </CrmBlock>
      <CrmBlock className="border-t border-slate-100" title="1 · The grade you propose">
        <CrmChoice
          columns={3}
          label="The grade you propose"
          onChange={(next) => {
            setGrade(next);
            setProblem(null);
          }}
          options={GRADES.map((option) => ({ value: option, label: `Grade ${option}`, disabled: saving }))}
          value={grade}
        />
      </CrmBlock>
      <CrmBlock className="border-t border-slate-100" title="2 · Note">
        <RequestNoteField disabled={saving} id="phoenix-crm-add-note" onChange={setNote} value={note} />
      </CrmBlock>
      <CrmBlock className="border-t border-slate-100">
        <p className="text-sm font-medium leading-6 text-slate-600">
          {steps} Your district manager confirms the grade or changes it. The visits you saved count once the customer is on your list, in the
          month they happened.
        </p>
      </CrmBlock>
      <SaveBar busy={saving} label="Send the request" onCancel={onBack} onSave={() => void save()} problem={problem} />
    </CrmPanel>
  );
}

// ── Back from the Archive: two steps, the district manager then SFE ─────────────────────────────

/**
 * "Ask to bring back" (owner, 2026-09-29): a customer who left the list returns with his clinics as
 * they were — no new photo — once the district manager and then SFE approve. A customer who was never
 * on the list is asked for with "Ask to add to your list" instead (`listMovesFor`).
 */
export function RestoreRequestScreen({
  customerId,
  onBack,
  onDone,
  refreshing,
  reload,
  seatId,
  test,
  view,
}: ListScreenBase & {
  customerId: string;
  onBack: () => void;
  onDone: (notice: ListNotice) => void;
}) {
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const customer = view.customers.find((entry) => entry.customerId === customerId) ?? null;
  const gone = !view.canEdit
    ? EDIT_ONLY
    : !customer
      ? NOT_ON_LIST
      : movesOf(customer).includes("ask_to_bring_back")
        ? null
        : customer.status !== "dropped"
          ? "This customer is not in the Archive."
          : customer.waiting.some((entry) => entry.kind === "restore")
            ? "Bringing this customer back is already waiting for a decision."
            : "This customer was never on your list. Ask to add the customer instead.";
  if (!customer || gone) {
    return <ListGone backLabel="Customer" message={gone ?? NOT_ON_LIST} onBack={onBack} refreshing={refreshing} title="Ask to bring back" />;
  }
  const steps = twoStepText(view, "bring him back to your list");

  async function save() {
    if (saving || !customer) return;
    setSaving(true);
    setProblem(null);
    try {
      await crmPost<unknown>("/api/phoenix-crm/list/requests", { seatId, test, kind: "restore", customerId: customer.customerId, note: note.trim() || null }, "request");
      onDone({ tone: "good", title: `Asked to bring back: ${customer.name}`, message: steps });
    } catch (error) {
      const code = errorCodeOf(error);
      if (code && REQUEST_RELOAD.has(code)) reload();
      setProblem(messageOf(error));
      setSaving(false);
    }
  }

  return (
    <CrmPanel>
      <CrmBackBar backLabel="Customer" onBack={onBack} title="Ask to bring back" />
      <CrmBlock>
        <CustomerHeading customer={customer} />
        <CrmNote className="mt-3" title={`In the Archive · ${customer.droppedReason ?? "Reason not recorded"}`}>
          {customer.droppedNote ? <span className="block whitespace-pre-line">{customer.droppedNote}</span> : null}
          <span className="block">Since {cairoStamp(customer.statusChangedAt)}</span>
        </CrmNote>
      </CrmBlock>
      <CrmBlock className="border-t border-slate-100" title="Note">
        <RequestNoteField disabled={saving} id="phoenix-crm-restore-note" onChange={setNote} value={note} />
      </CrmBlock>
      <CrmBlock className="border-t border-slate-100">
        <p className="text-sm font-medium leading-6 text-slate-600">
          {steps}{" "}
          {customer.validatedAt === null || customer.places.length === 0
            ? "The customer comes back under To validate, and is validated at the clinic as before."
            : `The customer comes back with ${customer.places.length === 1 ? "its clinic" : `its ${plural(customer.places.length, "clinic", "clinics")}`} as they were, so no new photo is needed.`}
        </p>
      </CrmBlock>
      <SaveBar busy={saving} label="Send the request" onCancel={onBack} onSave={() => void save()} problem={problem} />
    </CrmPanel>
  );
}
