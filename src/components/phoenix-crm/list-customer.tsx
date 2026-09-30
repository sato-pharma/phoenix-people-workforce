"use client";

/**
 * Phoenix CRM — one customer, opened from the list: the validation record (the signboard photo, the
 * fixed location, the days and hours of each clinic), the grade and its potential, where the customer
 * stands this month, the requests waiting on the customer, and what the rep may do next.
 *
 * This is also the customer data view the owner asked for on 2026-09-22: the captured location, the live
 * photo and who validated, on the one screen a manager already reaches through the Team tab.
 *
 * Owner, 2026-09-29 — the rep's flow rebuilt:
 *   - the location is FIXED: address · brick · area · region, read only, and the rep is never shown a
 *     coordinate or an accuracy (Golden Rule #1). The days and hours stay his to edit, the name and the
 *     speciality his to correct, and another clinic is validated the same way as the first;
 *   - only the Super Admin and the SFE Manager move a clinic or remove one (`view.canMovePlaces`), on
 *     their own screen, with a written reason;
 *   - what the page offers about the list itself — ask to drop, ask to add, drop to the Archive, ask to
 *     bring back — comes from `listMovesFor` (src/lib/phoenix-crm/list-request-rules.ts), never from a
 *     rule re-derived here;
 *   - there is no "Add visit" here: a visit starts from Visits, Today or the portal's "+".
 */

import { useState } from "react";

import { crmPost, errorCodeOf, messageOf } from "@/components/phoenix-crm/api";
import { CustomerPhoneLink } from "@/components/phoenix-crm/customer-phone";
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
import { ListGone, movesOf, twoStepText, type ListNotice, type ListScreen, type ListScreenBase } from "@/components/phoenix-crm/list-screens";
import { CrmPhotoThumb } from "@/components/phoenix-crm/photo";
import { pointSourceText } from "@/components/phoenix-crm/place-move-screen";
import { RequestCard, sortRequests } from "@/components/phoenix-crm/request-card";
import { TimingsReadout } from "@/components/phoenix-crm/timings-editor";
import { CrmBackBar, CrmBlock, CrmButton, CrmFacts, CrmNote, CrmPanel, CrmPill } from "@/components/phoenix-crm/ui";
import { formatDistance } from "@/lib/phoenix-crm/geo";
import { neverAdmitted, requestKindLabel, type ListMove } from "@/lib/phoenix-crm/list-request-rules";
import type { CustomerPharmacy, ListCustomer, ListPlace, TerritoryListView } from "@/lib/phoenix-crm/view-types";

const PLACE_RELOAD = new Set(["phoenix_crm_last_place", "phoenix_crm_place_not_found", "phoenix_crm_place_retired"]);
const MOVE_RELOAD = new Set(["phoenix_crm_not_outside", "phoenix_crm_customer_not_found"]);

/**
 * Whether this viewer may see a clinic's measurements (its coordinates, their accuracy, the phone's
 * clock). The territory's rep never does (Golden Rule #1); his managers, the SFE Manager and the Super
 * Admin do, on this shared page. In test mode the Super Admin is both the rep and a mover, and sees them.
 */
function seesMeasurements(view: TerritoryListView): boolean {
  return !view.canEdit || view.canMovePlaces;
}

export function CustomerScreen({
  customerId,
  notice,
  onBack,
  onLeave,
  onNotice,
  onOpen,
  refreshing,
  reload,
  seatId,
  test,
  view,
}: ListScreenBase & {
  customerId: string;
  notice: ListNotice | null;
  onBack: () => void;
  /** Something on this page moved the customer off it (dropped to the Archive): back to the list with this notice. */
  onLeave?: (notice: ListNotice) => void;
  /** Something on this page was saved: show the notice and read the list again. */
  onNotice: (notice: ListNotice) => void;
  onOpen: (screen: ListScreen) => void;
}) {
  const customer = view.customers.find((entry) => entry.customerId === customerId) ?? null;
  if (!customer) {
    return <ListGone backLabel="List" message="This customer is no longer on the territory's list." onBack={onBack} refreshing={refreshing} title="Customer" />;
  }

  const active = customer.status === "active";
  // Carried over from iReports360 and not validated yet: a real customer the rep plans and visits, who
  // counts in nothing until he validates him at the clinic. Validating is once, and it is forever.
  const pending = customer.status === "pending";
  // Met outside the list and validated at the door: waiting for the rep to ask to add him, or for the
  // district manager and SFE once he has.
  const outside = customer.status === "outside";
  const archived = customer.status === "dropped";
  const standing = monthStanding(customer.visitsThisMonth, customer.target);
  const full = customer.places.length >= view.rules.placesMax;
  const moves = view.canEdit ? movesOf(customer) : [];
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
  const proposedAdd = waiting.find((request) => request.kind === "add")?.proposedGrade ?? null;

  // His phone as the rep typed it at validation or corrected since (owner, 2026-09-30). A customer not
  // validated yet has none: the old list's phones are never shown ("only what the rep types").
  const phoneFact = { label: "Phone", value: customer.phone ? <CustomerPhoneLink phone={customer.phone} /> : "Not given" };

  // What each part of the list knows about the customer. A customer who is not validated yet has no
  // place, no validation and no month standing: what he does have is what iReports360 says.
  const facts = pending
    ? [
        { label: "This month", value: pendingVisitsText(customer.visitsThisMonth) },
        { label: "Validated", value: "Not yet" },
        { label: "Address in iReports360", value: referenceAddressText(customer.reference) ?? "None recorded" },
        { label: "Last visit in iReports360", value: referenceLastVisitText(customer.reference) },
      ]
    : outside
      ? [
          { label: "Visits", value: pendingVisitsText(customer.visitsThisMonth) },
          { label: "Validated at the door", value: cairoStamp(customer.statusChangedAt) },
          { label: "Clinics", value: `${customer.places.length} of ${view.rules.placesMax}` },
          { label: "Proposed grade", value: proposedAdd ? `Grade ${proposedAdd}` : "Not asked to add yet" },
          phoneFact,
        ]
      : archived
        ? [
            { label: "In the Archive since", value: cairoStamp(customer.statusChangedAt) },
            { label: "Why", value: customer.droppedReason ?? "Reason not recorded" },
            { label: "Clinics kept", value: String(customer.places.length) },
            { label: "On the list from", value: customer.origin === "reference" ? "The iReports360 list" : "Added in Phoenix" },
            phoneFact,
          ]
        : [
            { label: "This month", value: monthVisitsText(customer.visitsThisMonth, customer.target) },
            { label: "Validated", value: cairoStamp(customer.validatedAt) },
            { label: "Validated by", value: customer.validatedByName ?? "Not on record" },
            { label: "Clinics", value: `${customer.places.length} of ${view.rules.placesMax}` },
            { label: "Grade", value: customer.grade ? `Grade ${customer.grade}` : "No grade" },
            // The district manager's read of the customer's potential: shown, and it changes nothing else.
            ...(customer.potentialGrade ? [{ label: "Potential", value: `${customer.potentialGrade} · shown only` }] : []),
            { label: "On the list from", value: customer.origin === "reference" ? "The iReports360 list" : "Added in Phoenix" },
            phoneFact,
          ];

  return (
    <CrmPanel>
      {/* `dir="auto"` so an Arabic name reads right to left inside the English bar, and punctuation beside
          it stays where it belongs. */}
      <CrmBackBar backLabel="List" onBack={onBack} title={<span dir="auto">{customer.name}</span>} />
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
          {outside ? <CrmPill tone="orange">Outside the list</CrmPill> : null}
          {archived ? <CrmPill>In the Archive</CrmPill> : null}
          {active && customer.origin === "new" ? <CrmPill tone="orange">New customer</CrmPill> : null}
          {customer.pendingGradeRequestId ? (
            <CrmPill tone="info">{customer.pendingGrade ? `Grade ${customer.pendingGrade} proposed` : "Grade proposed"}</CrmPill>
          ) : null}
          {customer.waiting
            .filter((entry) => entry.kind !== "grade")
            .map((entry) => (
              <CrmPill key={entry.requestId} tone="info">
                {entry.stageLabel ? `${requestKindLabel(entry.kind)} · ${entry.stageLabel}` : requestKindLabel(entry.kind)}
              </CrmPill>
            ))}
        </div>
        <div className="mt-3">
          <CrmFacts facts={facts} />
        </div>

        {pending ? (
          <CrmNote className="mt-3" title="Not validated yet" tone="info">
            {PENDING_COUNTS_NOTE} Validating captures this customer&apos;s signboard photo, the location and the days and hours. It happens once.
          </CrmNote>
        ) : null}
        {outside ? (
          <CrmNote className="mt-3" title="Outside your list" tone="info">
            {proposedAdd
              ? twoStepText(view, "add him to your list")
              : "Validated at the door and not on your list. Ask to add the customer to your list, or drop the customer to the Archive."}{" "}
            The visits saved here count once the customer is on your list, in the month they happened.
          </CrmNote>
        ) : null}
        {archived ? (
          <CrmNote className="mt-3" title={`In the Archive · ${customer.droppedReason ?? "Reason not recorded"}`}>
            {customer.droppedNote ? <span className="block whitespace-pre-line">{customer.droppedNote}</span> : null}
            <span className="block">Since {cairoStamp(customer.statusChangedAt)}</span>
          </CrmNote>
        ) : null}

        {view.canEdit ? (
          <div className="mt-3 grid gap-2 sm:flex sm:flex-wrap">
            {pending && customer.referenceContactCrmId !== null ? (
              <CrmButton onClick={() => onOpen({ name: "validate", contactCrmId: customer.referenceContactCrmId as number })} variant="primary">
                Validate this customer
              </CrmButton>
            ) : null}
            {active || outside ? (
              <CrmButton disabled={full} onClick={() => onOpen({ name: "add-place", customerId: customer.customerId, draft: null })}>
                {full ? `${view.rules.placesMax} clinics, the most a customer can have` : "Add another clinic"}
              </CrmButton>
            ) : null}
            {active ? (
              <CrmButton disabled={customer.pendingGradeRequestId !== null} onClick={() => onOpen({ name: "grade", customerId: customer.customerId })}>
                Propose a grade
              </CrmButton>
            ) : null}
            {/* Owner, 2026-09-22: the name and the speciality are corrected here, after validating — never
                inside it. The grade keeps its proposal flow above, because it sets the rep's own target. */}
            {active || outside ? (
              <CrmButton onClick={() => onOpen({ name: "edit-details", customerId: customer.customerId })}>Change the details</CrmButton>
            ) : null}
          </div>
        ) : null}

        {moves.length > 0 ? (
          <ListMoves customer={customer} moves={moves} onLeave={onLeave ?? onNotice} onOpen={onOpen} reload={reload} seatId={seatId} test={test} view={view} />
        ) : null}
        {/* The SFE manages the Archive (owner, 2026-09-29): the SFE Manager — the Super Admin in test mode —
            brings a customer back himself. `view.canBringBack` is the server's own "decides the SFE step",
            never `canMovePlaces`, which is a different set of people. A customer who was never admitted
            comes back through "Request to add" instead, where his grade and potential are set. */}
        {archived && view.canBringBack && !neverAdmitted(customer) && !customer.waiting.some((entry) => entry.kind === "restore" || entry.kind === "add") ? (
          <BringBackNow customer={customer} onNotice={onNotice} seatId={seatId} test={test} />
        ) : null}
      </CrmBlock>

      {waiting.length > 0 ? (
        <CrmBlock className="border-t border-slate-100" title="Waiting for a decision">
          <div className="divide-y divide-slate-100 border border-slate-200">
            {waiting.map((request) => (
              <RequestCard
                canDecide
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

      {pending ? (
        <CrmBlock className="border-t border-slate-100" title="Clinics">
          <p className="break-words text-sm font-medium text-slate-500">
            No clinic saved yet. Validating captures the signboard photo, the location and the days and hours.
          </p>
        </CrmBlock>
      ) : (
        <CrmBlock className="border-t border-slate-100" title={plural(customer.places.length, "Clinic", "Clinics")}>
          {customer.places.length === 0 ? (
            <p className="text-sm font-medium text-slate-500">No clinic is on record for this customer.</p>
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
      )}

      {!archived ? (
        <CrmBlock className="border-t border-slate-100" title="Pharmacies feedback came from">
          {customer.pharmacies.length === 0 ? (
            <p className="break-words text-sm font-medium text-slate-500">
              No pharmacy feedback yet. When a visit records the pharmacy it took feedback from, that pharmacy appears here.
            </p>
          ) : (
            <div className="grid min-w-0 gap-3">
              {customer.pharmacies.map((pharmacy) => (
                <PharmacyCard
                  canEdit={view.canEdit}
                  customer={customer}
                  key={pharmacy.name}
                  onNotice={onNotice}
                  pharmacy={pharmacy}
                  seatId={seatId}
                  test={test}
                />
              ))}
            </div>
          )}
        </CrmBlock>
      ) : null}

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

/**
 * What the page offers about the list itself, exactly as `listMovesFor` decides it: ask to drop a
 * listed customer, ask to add one waiting outside, drop one waiting outside to the Archive (the rep's
 * own call — the customer was never on the list), or ask to bring one back from the Archive.
 */
function ListMoves({
  customer,
  moves,
  onLeave,
  onOpen,
  reload,
  seatId,
  test,
  view,
}: {
  customer: ListCustomer;
  moves: ReadonlyArray<ListMove>;
  onLeave: (notice: ListNotice) => void;
  onOpen: (screen: ListScreen) => void;
  reload: () => void;
  seatId: string;
  test: boolean;
  view: TerritoryListView;
}) {
  const [confirmDrop, setConfirmDrop] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function dropOutside() {
    setBusy(true);
    setProblem(null);
    try {
      await crmPost<unknown>("/api/phoenix-crm/list/outside/drop", { seatId, test, customerId: customer.customerId }, "archived");
      onLeave({
        tone: "good",
        title: `Moved to the Archive: ${customer.name}`,
        message: "Dropped instead of added to your list. The visits saved there never count.",
      });
    } catch (error) {
      if (MOVE_RELOAD.has(errorCodeOf(error) ?? "")) reload();
      setProblem(messageOf(error));
      setBusy(false);
      setConfirmDrop(false);
    }
  }

  return (
    <div className="mt-3 grid min-w-0 gap-2">
      {confirmDrop ? (
        <div className="grid min-w-0 gap-2 border border-rose-200 bg-rose-50 px-3 py-3">
          <p className="break-words text-sm font-bold text-rose-900">
            Drop {customer.name} to the Archive? The customer is not added to your list, and the visits saved there never count.
          </p>
          <div className="flex min-w-0 flex-wrap gap-2">
            <CrmButton busy={busy} onClick={() => void dropOutside()} size="sm" variant="danger">
              Drop
            </CrmButton>
            <CrmButton disabled={busy} onClick={() => setConfirmDrop(false)} size="sm">
              Keep waiting
            </CrmButton>
          </div>
        </div>
      ) : (
        <div className="grid gap-2 sm:flex sm:flex-wrap">
          {moves.includes("request_add") ? (
            <CrmButton onClick={() => onOpen({ name: "add-request", customerId: customer.customerId })} variant="primary">
              Ask to add to your list
            </CrmButton>
          ) : null}
          {moves.includes("ask_to_bring_back") ? (
            <CrmButton onClick={() => onOpen({ name: "restore", customerId: customer.customerId, from: "customer" })} variant="primary">
              Ask to bring back
            </CrmButton>
          ) : null}
          {moves.includes("drop_outside") ? (
            <CrmButton onClick={() => setConfirmDrop(true)} variant="danger">
              Drop
            </CrmButton>
          ) : null}
          {moves.includes("ask_to_drop") ? (
            <CrmButton onClick={() => onOpen({ name: "drop", customerId: customer.customerId, contactCrmId: null })} variant="danger">
              Ask to drop
            </CrmButton>
          ) : null}
        </div>
      )}
      {moves.includes("ask_to_drop") || moves.includes("ask_to_bring_back") || moves.includes("request_add") ? (
        <p className="break-words text-xs font-semibold leading-5 text-slate-500">
          {twoStepText(view, moves.includes("ask_to_drop") ? "take him off your list" : moves.includes("request_add") ? "add him to your list" : "bring him back to your list")}
        </p>
      ) : null}
      {problem ? <CrmNote tone="bad">{problem}</CrmNote> : null}
    </div>
  );
}

/**
 * The SFE Manager's own "Bring back to the list" on an archived customer. Filed and decided as a
 * bring-back at the SFE step in one press on the server, so the Archive's history reads the same whoever
 * moved him. Asked once before it runs — a customer brought back is on the rep's list and plan again.
 */
function BringBackNow({
  customer,
  onNotice,
  seatId,
  test,
}: {
  customer: ListCustomer;
  onNotice: (notice: ListNotice) => void;
  seatId: string;
  test: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function bringBack() {
    setBusy(true);
    setProblem(null);
    try {
      await crmPost<unknown>("/api/phoenix-crm/list/archive/bring-back", { seatId, test, customerId: customer.customerId }, "restored");
      onNotice({ tone: "good", title: `Back on the list: ${customer.name}` });
    } catch (error) {
      setProblem(messageOf(error));
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <div className="mt-3 grid min-w-0 gap-2">
      {confirming ? (
        <div className="grid min-w-0 gap-2 border border-slate-200 px-3 py-3">
          <p className="break-words text-sm font-bold text-slate-800">
            Bring {customer.name} back to the rep&apos;s list? The customer returns with his grade and his clinics.
          </p>
          <div className="flex min-w-0 flex-wrap gap-2">
            <CrmButton busy={busy} onClick={() => void bringBack()} size="sm" variant="primary">
              Bring back
            </CrmButton>
            <CrmButton disabled={busy} onClick={() => setConfirming(false)} size="sm">
              Keep in the Archive
            </CrmButton>
          </div>
        </div>
      ) : (
        <div className="grid gap-2 sm:flex sm:flex-wrap">
          <CrmButton onClick={() => setConfirming(true)} variant="primary">
            Bring back to the list
          </CrmButton>
        </div>
      )}
      {problem ? <CrmNote tone="bad">{problem}</CrmNote> : null}
    </div>
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
  // The FIXED location, as it was separated at capture: clean address, part of town, then the Phoenix
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
  const measured = seesMeasurements(view);
  const editsHours = view.canEdit && (customer.status === "active" || customer.status === "outside");

  async function retire() {
    setBusy(true);
    setProblem(null);
    try {
      // Removing a clinic changes where the customer is, so it is the movers' alone (owner, 2026-09-29).
      await crmPost<unknown>("/api/phoenix-crm/list/places/move", { seatId, test, placeId: place.placeId, action: "retire" }, "place");
      onNotice({ tone: "good", title: `Clinic removed: ${name}`, message: `${customer.name} keeps ${plural(remaining, "clinic", "clinics")}.` });
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
          alt={`Signboard photo: ${customer.name}, ${name}`}
          caption={`${customer.name} · ${name} · ${cairoStamp(place.capturedAt)}`}
          path={place.photoPath}
        />
        <div className="min-w-0 flex-1 basis-56">
          <h4 className="break-words text-sm font-black text-slate-950">
            <span dir="auto">{name}</span>
          </h4>
          <p className="mt-0.5 break-words text-xs font-semibold leading-5 text-slate-600">
            {details.length > 0 ? details.join(" · ") : "No street address or brick was found for this location."}
          </p>
          <p className="mt-1 break-words text-xs font-semibold leading-5 text-slate-500">
            Signboard photo taken {cairoStamp(place.capturedAt)} · fixed location
          </p>
          {measured ? (
            // The managers', the SFE Manager's and the Super Admin's. toFixed, never toLocaleString: the
            // module renders the same string on the server and in the browser.
            <p className="mt-0.5 break-words text-xs font-semibold leading-5 text-slate-500">
              Fixed point {place.lat.toFixed(5)}, {place.lon.toFixed(5)} ·{" "}
              {place.accuracyMeters === null ? "accuracy unknown" : `within ${formatDistance(Math.round(place.accuracyMeters))}`}
            </p>
          ) : null}
          {view.canMovePlaces ? <p className="mt-0.5 break-words text-xs font-semibold leading-5 text-slate-500">{pointSourceText(place)}</p> : null}
          {measured && place.clockOff ? (
            <div className="mt-1.5">
              <CrmPill tone="warn">Phone clock was off</CrmPill>
            </div>
          ) : null}
        </div>
      </div>

      <div className="mt-3 border-t border-slate-100 pt-3">
        <TimingsReadout timings={place.timings} />
      </div>

      {editsHours || view.canMovePlaces ? (
        <div className="mt-3 flex min-w-0 flex-wrap items-center gap-2">
          {confirming ? (
            <>
              <span className="min-w-0 break-words text-sm font-bold text-slate-700">Remove this clinic from {customer.name}?</span>
              <CrmButton busy={busy} onClick={() => void retire()} size="sm" variant="danger">
                Remove
              </CrmButton>
              <CrmButton disabled={busy} onClick={() => setConfirming(false)} size="sm">
                Keep it
              </CrmButton>
            </>
          ) : (
            <>
              {editsHours ? (
                <CrmButton onClick={() => onOpen({ name: "edit-place", customerId: customer.customerId, placeId: place.placeId })} size="sm">
                  Change days and hours
                </CrmButton>
              ) : null}
              {view.canMovePlaces ? (
                <CrmButton onClick={() => onOpen({ name: "move-place", customerId: customer.customerId, placeId: place.placeId })} size="sm">
                  Move this place
                </CrmButton>
              ) : null}
              {/* A customer keeps his last clinic: he leaves the list by a drop, never by losing it. */}
              {view.canMovePlaces && customer.places.length > 1 ? (
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

function availabilitySplit(products: CustomerPharmacy["products"]): { has: string[]; missing: string[] } {
  const has: string[] = [];
  const missing: string[] = [];
  for (const entry of products) (entry.answer === "has" ? has : missing).push(entry.product);
  return { has, missing };
}

/**
 * One pharmacy the customer's feedback came from — derived from the visits, not maintained. The rep pins
 * one as primary; pinning another moves the star, and clearing removes it.
 */
function PharmacyCard({
  canEdit,
  customer,
  onNotice,
  pharmacy,
  seatId,
  test,
}: {
  canEdit: boolean;
  customer: ListCustomer;
  onNotice: (notice: ListNotice) => void;
  pharmacy: CustomerPharmacy;
  seatId: string;
  test: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const { has, missing } = availabilitySplit(pharmacy.products);

  async function pin(pharmacyName: string) {
    setBusy(true);
    setProblem(null);
    try {
      await crmPost<unknown>("/api/phoenix-crm/list/primary-pharmacy", { seatId, test, customerId: customer.customerId, pharmacyName }, "result");
      onNotice(
        pharmacyName
          ? { tone: "good", title: `Primary pharmacy set`, message: `${pharmacy.name} for ${customer.name}.` }
          : { tone: "info", title: `Primary pharmacy cleared`, message: `${customer.name} has no primary pharmacy now.` },
      );
    } catch (error) {
      setProblem(messageOf(error));
      setBusy(false);
    }
  }

  return (
    <article className="min-w-0 border border-slate-200 bg-white px-3.5 py-3.5">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h4 className="break-words text-sm font-black text-slate-950">
            <span dir="auto">{pharmacy.name}</span>
          </h4>
          <p className="mt-0.5 break-words text-xs font-semibold leading-5 text-slate-500">
            {plural(pharmacy.visits, "visit", "visits")} · last {cairoStamp(pharmacy.lastFeedbackAt)}
          </p>
        </div>
        {pharmacy.isPrimary ? <CrmPill tone="good">Primary</CrmPill> : null}
      </div>

      {has.length > 0 || missing.length > 0 ? (
        <div className="mt-3 grid gap-2">
          {has.length > 0 ? (
            <div className="flex min-w-0 flex-wrap items-center gap-1">
              <span className="text-phx-2xs font-black uppercase tracking-wider text-slate-500">Has</span>
              {has.map((product) => (
                <CrmPill key={product} tone="good">
                  {product}
                </CrmPill>
              ))}
            </div>
          ) : null}
          {missing.length > 0 ? (
            <div className="flex min-w-0 flex-wrap items-center gap-1">
              <span className="text-phx-2xs font-black uppercase tracking-wider text-slate-500">Doesn&apos;t have</span>
              {missing.map((product) => (
                <CrmPill key={product} tone="bad">
                  {product}
                </CrmPill>
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <p className="mt-2 break-words text-xs font-medium text-slate-400">No product answers recorded here yet.</p>
      )}

      {canEdit ? (
        <div className="mt-3 flex min-w-0 flex-wrap items-center gap-2">
          {pharmacy.isPrimary ? (
            <CrmButton busy={busy} onClick={() => void pin("")} size="sm">
              Clear primary
            </CrmButton>
          ) : (
            <CrmButton busy={busy} onClick={() => void pin(pharmacy.name)} size="sm" variant="primary">
              Set as primary
            </CrmButton>
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
