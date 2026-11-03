"use client";

/**
 * Phoenix CRM — an OUT-OF-LIST visit: someone who is not on the rep's list at all.
 *
 * Owner, 2026-09-29:
 *   1. First, the customers he already met outside his list, waiting to be added — a second visit to
 *      one of them is another out-of-list visit to the SAME customer, never a second customer.
 *   2. Otherwise "Someone new": AM or PM chosen BY HAND ("it is not AM because he entered it in the
 *      morning; let him choose it"), the full name and the speciality — and he MUST validate on the
 *      spot, exactly as the List's Validate does: a live photo of the sign or door (with the photo's
 *      own reading), the location, and the days and hours.
 *   3. The customer then waits outside his list, where he chooses Request to add or Drop. The visit
 *      counts only once the customer is admitted, in the month it happened.
 *
 * The save is POST /api/phoenix-crm/list/validate with mode "outside"; on success the visit form opens
 * straight on the new customer.
 */

import { useEffect, useState } from "react";
import { UserPlus } from "lucide-react";

import { crmGet, crmPost, crmUrl, errorCodeOf, messageOf } from "@/components/phoenix-crm/api";
import { CustomerPhoneField } from "@/components/phoenix-crm/customer-phone";
import { customerMetaText, listText } from "@/components/phoenix-crm/labels";
import { releaseCapturedPhoto } from "@/components/phoenix-crm/captured-photo";
import { useLocationWarmUp } from "@/components/phoenix-crm/location-receiver";
import { emptyPlaceDraft, PlaceEditor, placeDraftProblem, placePayload, type PlaceDraftState } from "@/components/phoenix-crm/place-editor";
import { CrmBackBar, CrmBlock, CrmButton, CrmChoice, CrmField, CrmNote, CrmPanel, CrmPill, crmInputClassName } from "@/components/phoenix-crm/ui";
import { useBrowserNamed } from "@/components/phoenix-crm/use-browser-name";
import { CUSTOMER_NAME_MAX, PLACE_PHOTO_NEEDED, parseCustomerPhone } from "@/lib/phoenix-crm/entry-rules";
import type { PhoenixCrmListType } from "@/lib/phoenix-crm/types";
import type { TerritoryListView, ValidateResult, VisitCustomerOption } from "@/lib/phoenix-crm/view-types";
import { VISIT_WAITING_PILL } from "@/lib/phoenix-crm/visit-resend-rules";

/** The server keeps a speciality to this length (entry-rules.ts parseOutsideCustomer). */
const SPECIALITY_TEXT_MAX = 80;

const PHOTO_NEEDED = PLACE_PHOTO_NEEDED;
const UNCHECKED = "The save may have gone through, but Phoenix could not check. Check the connection, then press Save again.";

/**
 * Answers a save can get when an earlier press landed and only its answer was lost: no answer at all,
 * a server failure, or a refusal the landed save itself caused. The photo is used once, so the list is
 * read again and the place saved with it is looked for before he is asked to do anything twice.
 */
const MAY_HAVE_SAVED = new Set(["offline", "failed", "internal_error", "statement_timeout", "phoenix_crm_photo_used", "phoenix_crm_same_name"]);

function normalizedName(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * The customer a place with this photo was saved on: a customer id when found, null when the list read
 * but holds no such place, undefined when the list could not be read at all.
 */
async function customerSavedWith(seatId: string, test: boolean, photoPath: string): Promise<string | null | undefined> {
  try {
    const view = await crmGet<TerritoryListView>(crmUrl("/api/phoenix-crm/list", { seatId, test }), "list");
    const customer = view.customers.find((entry) => entry.places.some((place) => place.photoPath === photoPath));
    return customer ? customer.customerId : null;
  } catch {
    return undefined;
  }
}

/** The specialities already on his list, offered while typing. */
function knownSpecialities(customers: ReadonlyArray<VisitCustomerOption>): string[] {
  const names = new Set<string>();
  for (const customer of customers) if (customer.speciality) names.add(customer.speciality);
  return [...names].sort((left, right) => left.localeCompare(right));
}

export function OutOfListEntry({
  canAddNew,
  customers,
  onBack,
  onPick,
  onValidated,
  seatId,
  test,
}: {
  /** Validating a new customer is the territory's own rep's; a manager entering a visit picks from the waiting ones. */
  canAddNew: boolean;
  /** The form's customers; the ones waiting outside the list are offered first. */
  customers: ReadonlyArray<VisitCustomerOption>;
  onBack: () => void;
  /** A customer met before and waiting outside the list. */
  onPick: (customerId: string) => void;
  /** A new customer validated on the spot: the visit form opens on him. */
  onValidated: (customerId: string) => void;
  seatId: string;
  test: boolean;
}) {
  const browserNamed = useBrowserNamed();
  const [adding, setAdding] = useState(false);
  const [listType, setListType] = useState<PhoenixCrmListType | null>(null);
  const [name, setName] = useState("");
  const [speciality, setSpeciality] = useState("");
  // Optional, saved with the validation, exactly as on the List's Validate (owner, 2026-09-30).
  const [phone, setPhone] = useState("");
  const [draft, setDraft] = useState<PlaceDraftState>(emptyPlaceDraft);
  const [sameName, setSameName] = useState(false);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // A new customer is validated here with a photo and a pin: warm the receiver while he is being added.
  useLocationWarmUp(adding);

  // Every way out lets the photo's preview go — this screen's own Back, the step form's Back (which
  // never passes through `close`), a saved validation — and so does a photo taken again.
  useEffect(() => () => releaseCapturedPhoto(draft.photo), [draft.photo]);

  const waiting = customers.filter((customer) => customer.outside);
  const cleanName = normalizedName(name);

  function close() {
    if (saving) return;
    releaseCapturedPhoto(draft.photo);
    onBack();
  }

  function stopAdding() {
    if (saving) return;
    releaseCapturedPhoto(draft.photo);
    setDraft(emptyPlaceDraft());
    setSameName(false);
    setProblem(null);
    setAdding(false);
  }

  function clientProblem(): string | null {
    if (!listType) return "Choose AM or PM.";
    if (cleanName.length < 3) return "Write the customer's full name.";
    const phoneCheck = parseCustomerPhone(phone);
    if (!phoneCheck.ok) return phoneCheck.error;
    return placeDraftProblem(draft, { needsPhoto: true });
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
    setSameName(false);
    try {
      const result = await crmPost<ValidateResult>(
        "/api/phoenix-crm/list/validate",
        {
          seatId,
          test,
          mode: "outside",
          customer: { listType, name: cleanName, speciality: normalizedName(speciality) || null },
          allowSameName,
          phone: phone.trim() || null,
          // The List's own place body (place-editor.tsx): the pin, and the photo's own reading under
          // the `shutter*` keys the server reads — sent as measured, never filled in from the pin.
          place: placePayload(photo, draft),
        },
        "result",
      );
      releaseCapturedPhoto(photo);
      onValidated(result.customerId);
    } catch (error) {
      const code = errorCodeOf(error);
      const found = code && MAY_HAVE_SAVED.has(code) ? await customerSavedWith(seatId, test, photo.path) : null;
      if (typeof found === "string") {
        releaseCapturedPhoto(photo);
        onValidated(found);
        return;
      }
      setSaving(false);
      if (code === "phoenix_crm_same_name") {
        setSameName(true);
        return;
      }
      if (found === undefined && code === "phoenix_crm_photo_used") {
        setProblem(UNCHECKED);
        return;
      }
      if (code?.startsWith("phoenix_crm_photo_")) {
        releaseCapturedPhoto(photo);
        setDraft((current) => (current.photo?.path === photo.path ? { ...current, photo: null } : current));
      }
      setProblem(messageOf(error));
    }
  }

  if (!adding) {
    return (
      <CrmPanel>
        <CrmBackBar backLabel="Unplanned visit" onBack={close} title="Out of list" />
        <CrmBlock title="Met before — waiting to be added">
          {waiting.length === 0 ? (
            <p className="text-sm font-semibold text-slate-500">Nobody you met outside your list is waiting to be added.</p>
          ) : (
            <ul className="grid gap-1.5">
              {waiting.map((customer) => (
                <li key={customer.customerId}>
                  <button
                    className="block w-full min-w-0 rounded-none border border-slate-200 bg-white px-3 py-3 text-left transition hover:border-orange-300 disabled:cursor-not-allowed disabled:opacity-60"
                    disabled={customer.visitedToday || customer.waitingToSend === true}
                    onClick={() => onPick(customer.customerId)}
                    type="button"
                  >
                    <span className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                      {/* A floor, not `min-w-0` — see visit-customer-picker.tsx for the measurement. */}
                      <span className="min-w-[9rem] flex-1">
                        <span className="block break-words text-sm font-black text-slate-950">{customer.name}</span>
                        <span className="mt-0.5 block break-words text-xs font-semibold text-slate-500">{customerMetaText(customer)}</span>
                      </span>
                      <span className="flex max-w-full flex-wrap gap-1">
                        {customer.visitedToday ? <CrmPill tone="good">Visited today</CrmPill> : customer.waitingToSend ? <CrmPill tone="orange">{VISIT_WAITING_PILL}</CrmPill> : <CrmPill tone="orange">Waiting to be added</CrmPill>}
                      </span>
                    </span>
                    {customer.brickName ? <span className="mt-1 block break-words text-xs font-semibold text-slate-600">{customer.brickName}</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CrmBlock>
        <CrmBlock className="border-t border-slate-100" title="Someone new">
          <p className="text-sm font-medium leading-6 text-slate-600">
            Not on your list and not met before: enter the customer and validate the place now — a live photo of the customer&apos;s own nameplate, and the days and hours.
            The visit counts once the customer is added to your list.
          </p>
          {canAddNew ? (
            <CrmButton className="mt-3" onClick={() => setAdding(true)} variant="primary">
              <UserPlus aria-hidden className="h-4 w-4" />
              Someone new
            </CrmButton>
          ) : (
            <p className="mt-2 text-xs font-semibold text-slate-500">A new customer is entered by the territory&apos;s own rep.</p>
          )}
        </CrmBlock>
      </CrmPanel>
    );
  }

  return (
    <CrmPanel>
      <CrmBackBar backLabel="Out of list" onBack={stopAdding} title="Someone new" />
      <CrmBlock title="1 · Customer">
        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          <CrmField className="sm:col-span-2" label="AM or PM">
            <CrmChoice
              columns={2}
              label="AM or PM"
              onChange={(next) => {
                setListType(next);
                setSameName(false);
                setProblem(null);
              }}
              options={[
                { value: "AM", label: listText("AM"), note: "A hospital or a center", disabled: saving },
                { value: "PM", label: listText("PM"), note: "In a clinic", disabled: saving },
              ]}
              value={listType}
            />
          </CrmField>
          <CrmField className="sm:col-span-2" hint="As written on the sign." htmlFor="phoenix-crm-outside-name" label="Full name">
            <input
              autoComplete="off"
              className={crmInputClassName}
              dir="auto"
              disabled={saving}
              id="phoenix-crm-outside-name"
              maxLength={CUSTOMER_NAME_MAX}
              onChange={(event) => {
                setName(event.target.value);
                setSameName(false);
                setProblem(null);
              }}
              value={name}
            />
          </CrmField>
          <CrmField className="sm:col-span-2" hint="Optional. Pick one from the list or write it." htmlFor="phoenix-crm-outside-speciality" label="Speciality">
            <input
              autoComplete="off"
              className={crmInputClassName}
              disabled={saving}
              id="phoenix-crm-outside-speciality"
              list="phoenix-crm-outside-specialities"
              maxLength={SPECIALITY_TEXT_MAX}
              onChange={(event) => setSpeciality(event.target.value)}
              value={speciality}
            />
            <datalist id="phoenix-crm-outside-specialities">
              {knownSpecialities(customers).map((option) => (
                <option key={option} value={option} />
              ))}
            </datalist>
          </CrmField>
          <CustomerPhoneField
            className="sm:col-span-2"
            disabled={saving}
            id="phoenix-crm-outside-phone"
            onChange={(next) => {
              setPhone(next);
              setProblem(null);
            }}
            value={phone}
          />
        </div>
      </CrmBlock>

      <PlaceEditor
        capture
        customerName={cleanName}
        disabled={saving}
        firstStep={2}
        idPrefix="phoenix-crm-outside"
        onChange={setDraft}
        photoBlockedReason={cleanName ? null : "Write the customer's full name first. It is printed on the photo."}
        ramadanNote={null}
        seatId={seatId}
        test={test}
        value={draft}
      />

      <CrmBlock className="border-t border-slate-100">
        {sameName ? (
          <CrmNote className="mb-3" title="A customer with this name is already on your list" tone="warn">
            <p>If it is the same person, go back and choose Out of plan — the customer is on your list already.</p>
            <p className="mt-1">Is this a different person?</p>
            <div className="mt-3 grid gap-2 sm:flex sm:flex-wrap">
              <CrmButton busy={saving} onClick={() => void save(true)}>
                Yes, a different person
              </CrmButton>
              <CrmButton disabled={saving} onClick={close}>
                Go back
              </CrmButton>
            </div>
          </CrmNote>
        ) : null}
        {problem ? (
          <CrmNote className="mb-3" tone="bad">
            {browserNamed(problem)}
          </CrmNote>
        ) : null}
        <div className="grid gap-2 sm:flex sm:flex-wrap">
          <CrmButton busy={saving} onClick={() => void save(false)} variant="primary">
            Save the customer
          </CrmButton>
          <CrmButton disabled={saving} onClick={stopAdding}>
            Cancel
          </CrmButton>
        </div>
      </CrmBlock>
    </CrmPanel>
  );
}
