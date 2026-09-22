"use client";

/**
 * Phoenix CRM — one customer on the territory's list: where it stands this month, its places with the
 * photo, location and days and hours of each, its grade and drop requests, and what the rep can do
 * next (another place, a grade proposal, a drop request, or bringing a customer back).
 *
 * This is also the doctor data view the owner asked for on 2026-09-22: the captured location, the live
 * photo and who validated, on the one screen a manager already reaches through the Team tab. A customer
 * carried over from iReports360 and not validated yet shows what iReports360 holds on him and a single
 * Validate button — never "Left the list", which he has not.
 */

import { useState } from "react";

import { crmPost, errorCodeOf, messageOf } from "@/components/phoenix-crm/api";
import { cairoStamp, plural } from "@/components/phoenix-crm/format";
import {
  customerMetaText,
  monthStanding,
  monthVisitsText,
  PENDING_COUNTS_NOTE,
  PENDING_PILL,
  pendingVisitsText,
  placeName,
  referenceAddressText,
  referenceLastVisitText,
} from "@/components/phoenix-crm/labels";
import { accuracyText, ListGone, type ListNotice, type ListScreen, type ListScreenBase } from "@/components/phoenix-crm/list-screens";
import { CrmPhotoThumb } from "@/components/phoenix-crm/photo";
import { RequestCard, sortRequests } from "@/components/phoenix-crm/request-card";
import { TimingsReadout } from "@/components/phoenix-crm/timings-editor";
import { CrmBackBar, CrmBlock, CrmButton, CrmFacts, CrmNote, CrmPanel, CrmPill } from "@/components/phoenix-crm/ui";
import type { ListCustomer, ListPlace, TerritoryListView } from "@/lib/phoenix-crm/view-types";

const PLACE_RELOAD = new Set(["phoenix_crm_last_place", "phoenix_crm_place_not_found", "phoenix_crm_place_retired"]);

export function CustomerScreen({
  customerId,
  notice,
  onBack,
  onNotice,
  onOpen,
  onVisitCustomer,
  refreshing,
  reload,
  seatId,
  test,
  view,
}: ListScreenBase & {
  customerId: string;
  notice: ListNotice | null;
  onBack: () => void;
  /** Something on this page was saved: show the notice and read the list again. */
  onNotice: (notice: ListNotice) => void;
  onOpen: (screen: ListScreen) => void;
  /** Add a visit on this customer. Absent where visits are not entered from this page. */
  onVisitCustomer?: (customer: ListCustomer) => void;
}) {
  const customer = view.customers.find((entry) => entry.customerId === customerId) ?? null;
  if (!customer) {
    return <ListGone backLabel="List" message="This customer is no longer on the territory's list." onBack={onBack} refreshing={refreshing} title="Customer" />;
  }

  const active = customer.status === "active";
  // Carried over from iReports360 and not validated yet: a real customer the rep plans and visits, who
  // counts in nothing until he validates him at the clinic. Validating is once, and it is forever.
  const pending = customer.status === "pending";
  const standing = monthStanding(customer.visitsThisMonth, customer.target);
  const full = customer.places.length >= view.rules.placesMax;
  const requests = sortRequests(
    view.requests.filter(
      (request) =>
        request.customerId === customer.customerId ||
        (request.customerId === null && customer.referenceContactCrmId !== null && request.referenceContactCrmId === customer.referenceContactCrmId),
    ),
  );
  const waiting = requests.filter((request) => request.status === "pending");
  const earlier = requests.filter((request) => request.status !== "pending");
  const requestChanged = (message: string) => onNotice({ tone: "info", title: message });

  // A customer who is not validated yet has no place, no validation and no month standing. What he
  // does have is what iReports360 says, which is all the rep has to find him by until he is at the door.
  const facts = pending
    ? [
        { label: "This month", value: pendingVisitsText(customer.visitsThisMonth) },
        { label: "Validated", value: "Not yet" },
        { label: "Address in iReports360", value: referenceAddressText(customer.reference) ?? "None recorded" },
        { label: "Last visit in iReports360", value: referenceLastVisitText(customer.reference) },
      ]
    : [
        { label: "This month", value: monthVisitsText(customer.visitsThisMonth, customer.target) },
        active
          ? { label: "Validated", value: cairoStamp(customer.validatedAt) }
          : { label: "Left the list", value: cairoStamp(customer.statusChangedAt) },
        ...(active ? [{ label: "Validated by", value: customer.validatedByName ?? "Not on record" }] : []),
        ...(active ? [{ label: "Places", value: `${customer.places.length} of ${view.rules.placesMax}` }] : []),
        { label: "On the list from", value: customer.origin === "reference" ? "The iReports360 list" : "Added in Phoenix" },
      ];

  return (
    <CrmPanel>
      <CrmBackBar backLabel="List" onBack={onBack} title={customer.name} />
      {notice ? (
        <div className="px-4 pt-4 sm:px-5">
          <CrmNote title={notice.title} tone={notice.tone}>
            {notice.message}
          </CrmNote>
        </div>
      ) : null}

      <CrmBlock>
        <p className="break-words text-sm font-semibold text-slate-600">{customerMetaText(customer)}</p>
        <div className="mt-2 flex flex-wrap gap-1">
          {pending ? <CrmPill tone="orange">{PENDING_PILL}</CrmPill> : null}
          {active ? <CrmPill tone={standing.tone}>{standing.label}</CrmPill> : null}
          {!active && !pending ? <CrmPill>Left the list</CrmPill> : null}
          {customer.origin === "new" ? <CrmPill tone="orange">New customer</CrmPill> : null}
          {customer.pendingGradeRequestId ? (
            <CrmPill tone="info">{customer.pendingGrade ? `Grade ${customer.pendingGrade} proposed` : "Grade proposed"}</CrmPill>
          ) : null}
          {customer.pendingDropRequestId ? <CrmPill tone="warn">Drop waiting</CrmPill> : null}
        </div>
        <div className="mt-3">
          <CrmFacts facts={facts} />
        </div>
        {pending ? (
          <CrmNote className="mt-3" title="Not validated yet" tone="info">
            {PENDING_COUNTS_NOTE} Validating captures this customer&apos;s real location, a live photo of the door, and its days and
            hours. It happens once.
          </CrmNote>
        ) : null}
        {/* Owner, 2026-09-22: two buttons on a customer he has not validated yet — Validate, and Add a
            visit. He is never made to validate before he may log the visit he has just made. */}
        {pending && view.canEdit ? (
          <div className="mt-3 grid gap-2 sm:flex sm:flex-wrap">
            {customer.referenceContactCrmId !== null ? (
              <CrmButton onClick={() => onOpen({ name: "validate", contactCrmId: customer.referenceContactCrmId as number })} variant="primary">
                Validate this customer
              </CrmButton>
            ) : null}
            {onVisitCustomer ? <CrmButton onClick={() => onVisitCustomer(customer)}>Add a visit</CrmButton> : null}
            <CrmButton
              disabled={customer.pendingDropRequestId !== null}
              onClick={() => onOpen({ name: "drop", customerId: customer.customerId, contactCrmId: null })}
              variant="danger"
            >
              Ask to drop
            </CrmButton>
          </div>
        ) : null}
        {active && view.canEdit ? (
          <div className="mt-3 grid gap-2 sm:flex sm:flex-wrap">
            <CrmButton
              disabled={full}
              onClick={() => onOpen({ name: "add-place", customerId: customer.customerId, draft: null })}
              variant="primary"
            >
              {full ? `${view.rules.placesMax} places, the most a customer can have` : "Add another place"}
            </CrmButton>
            <CrmButton disabled={customer.pendingGradeRequestId !== null} onClick={() => onOpen({ name: "grade", customerId: customer.customerId })}>
              Propose a grade
            </CrmButton>
            {/* Owner, 2026-09-22: the name and the speciality are corrected here, after validating — never
                inside it. The grade keeps its proposal flow above, because it sets the rep's own target. */}
            <CrmButton onClick={() => onOpen({ name: "edit-details", customerId: customer.customerId })}>Change the details</CrmButton>
            <CrmButton
              disabled={customer.pendingDropRequestId !== null}
              onClick={() => onOpen({ name: "drop", customerId: customer.customerId, contactCrmId: null })}
              variant="danger"
            >
              Ask to drop
            </CrmButton>
          </div>
        ) : null}
      </CrmBlock>

      {waiting.length > 0 ? (
        <CrmBlock className="border-t border-slate-100" title="Waiting for a decision">
          <div className="divide-y divide-slate-100 border border-slate-200">
            {waiting.map((request) => (
              <RequestCard
                canDecide={view.canReview}
                canWithdraw={view.canEdit}
                key={request.requestId}
                onChanged={requestChanged}
                request={request}
                seatId={seatId}
                test={test}
              />
            ))}
          </div>
        </CrmBlock>
      ) : null}

      {active ? (
        <CrmBlock className="border-t border-slate-100" title={plural(customer.places.length, "Place", "Places")}>
          {customer.places.length === 0 ? (
            <p className="text-sm font-medium text-slate-500">No place is on the list for this customer.</p>
          ) : (
            <div className="grid min-w-0 gap-3">
              {customer.places.map((place, index) => (
                <PlaceCard
                  customer={customer}
                  index={index}
                  key={place.placeId}
                  onNotice={onNotice}
                  onOpen={onOpen}
                  place={place}
                  reload={reload}
                  seatId={seatId}
                  test={test}
                  view={view}
                />
              ))}
            </div>
          )}
        </CrmBlock>
      ) : pending ? (
        <CrmBlock className="border-t border-slate-100" title="Places">
          <p className="break-words text-sm font-medium text-slate-500">
            No place saved yet. Validating captures the location and the photo.
          </p>
        </CrmBlock>
      ) : (
        <CrmBlock className="border-t border-slate-100">
          <CrmNote title={`Left the list · ${customer.droppedReason ?? "Reason not recorded"}`}>
            {customer.droppedNote ? <span className="block whitespace-pre-line">{customer.droppedNote}</span> : null}
            <span className="block">Since {cairoStamp(customer.statusChangedAt)}</span>
          </CrmNote>
          {view.canEdit ? (
            <div className="mt-3 grid gap-2 sm:flex sm:flex-wrap">
              <CrmButton onClick={() => onOpen({ name: "restore", customerId: customer.customerId, from: "customer" })} variant="primary">
                Bring back to the list
              </CrmButton>
            </div>
          ) : null}
        </CrmBlock>
      )}

      {earlier.length > 0 ? (
        <CrmBlock className="border-t border-slate-100" title="Earlier requests">
          <div className="divide-y divide-slate-100 border border-slate-200">
            {earlier.map((request) => (
              <RequestCard
                canDecide={false}
                canWithdraw={false}
                key={request.requestId}
                onChanged={requestChanged}
                request={request}
                seatId={seatId}
                test={test}
              />
            ))}
          </div>
        </CrmBlock>
      ) : null}
    </CrmPanel>
  );
}

function PlaceCard({
  customer,
  index,
  onNotice,
  onOpen,
  place,
  reload,
  seatId,
  test,
  view,
}: {
  customer: ListCustomer;
  index: number;
  onNotice: (notice: ListNotice) => void;
  onOpen: (screen: ListScreen) => void;
  place: ListPlace;
  reload: () => void;
  seatId: string;
  test: boolean;
  view: TerritoryListView;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const name = placeName(place, index);
  // The location as it was separated at capture: clean address, part of town, then the Phoenix
  // territory the point fell in — brick, area, region (owner, 2026-09-23). None of it is editable, so
  // this is a record, not a summary of something the rep typed.
  const details = [
    place.address,
    place.zone,
    place.brickName ? `Brick ${place.brickName}` : null,
    place.areaName,
    place.regionName,
  ].filter((part): part is string => Boolean(part) && part !== name);
  const remaining = customer.places.length - 1;

  async function retire() {
    setBusy(true);
    setProblem(null);
    try {
      await crmPost<unknown>("/api/phoenix-crm/list/places/update", { seatId, test, placeId: place.placeId, action: "retire" }, "place");
      onNotice({ tone: "good", title: `Place removed: ${name}`, message: `${customer.name} keeps ${plural(remaining, "place", "places")}.` });
    } catch (error) {
      if (PLACE_RELOAD.has(errorCodeOf(error) ?? "")) reload();
      setProblem(messageOf(error));
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <article className="min-w-0 border border-slate-200 bg-white px-3.5 py-3.5">
      <div className="flex min-w-0 flex-wrap items-start gap-3">
        <CrmPhotoThumb
          alt={`Place photo: ${customer.name}, ${name}`}
          caption={`${customer.name} · ${name} · ${cairoStamp(place.capturedAt)}`}
          path={place.photoPath}
        />
        <div className="min-w-0 flex-1 basis-56">
          <h4 className="break-words text-sm font-black text-slate-950">{name}</h4>
          {details.length > 0 ? <p className="mt-0.5 break-words text-xs font-semibold leading-5 text-slate-600">{details.join(" · ")}</p> : null}
          <p className="mt-1 break-words text-xs font-semibold leading-5 text-slate-500">
            Photo taken {cairoStamp(place.capturedAt)} · {accuracyText(place.accuracyMeters)}
          </p>
          {/* The captured location itself, as proof. toFixed, never toLocaleString: the module renders the
              same string on the server and in the browser. */}
          <p className="mt-0.5 break-words text-xs font-semibold leading-5 text-slate-500">
            Location captured {place.lat.toFixed(5)}, {place.lon.toFixed(5)}
          </p>
          {place.clockOff ? (
            <div className="mt-1.5">
              <CrmPill tone="warn">Phone clock was off</CrmPill>
            </div>
          ) : null}
        </div>
      </div>

      <div className="mt-3 border-t border-slate-100 pt-3">
        <TimingsReadout timings={place.timings} />
      </div>

      {view.canEdit ? (
        <div className="mt-3 flex min-w-0 flex-wrap items-center gap-2">
          {confirming ? (
            <>
              <span className="min-w-0 break-words text-sm font-bold text-slate-700">Remove this place from {customer.name}?</span>
              <CrmButton busy={busy} onClick={() => void retire()} size="sm" variant="danger">
                Remove
              </CrmButton>
              <CrmButton disabled={busy} onClick={() => setConfirming(false)} size="sm">
                Keep it
              </CrmButton>
            </>
          ) : (
            <>
              <CrmButton onClick={() => onOpen({ name: "edit-place", customerId: customer.customerId, placeId: place.placeId })} size="sm">
                Change days and hours
              </CrmButton>
              {customer.places.length > 1 ? (
                <CrmButton onClick={() => setConfirming(true)} size="sm" variant="danger">
                  Remove this place
                </CrmButton>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      {problem ? (
        <CrmNote className="mt-3" tone="bad">
          {problem}
        </CrmNote>
      ) : null}
    </article>
  );
}
