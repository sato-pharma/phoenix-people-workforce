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
 *
 * Owner, 2026-10-02: the page also carries the customer's own timeline — his past Phoenix visits, newest
 * first, with what was discussed and what comes next (customer-timeline.tsx) — instead of only the
 * month's count. It carries no location, distance or flag, so it is the same for the rep and his managers.
 *
 * Owner, 2026-10-02 — and the rep's one action here for a visit with somebody: "Ask for a visit with…"
 * his manager, a product manager of his line, or his manager and the one above (visit-asks.tsx). His
 * asks show with their answers in plain words; they are his requests, never a check on him.
 */

import { useState } from "react";

import { crmPost, errorCodeOf, messageOf } from "@/components/phoenix-crm/api";
import { CustomerPhoneLink } from "@/components/phoenix-crm/customer-phone";
import { CustomerTimeline } from "@/components/phoenix-crm/customer-timeline";
import { DirectionsLink } from "@/components/phoenix-crm/directions-link";
import { PharmacyLocationFacts } from "@/components/phoenix-crm/pharmacy-details";
import { CustomerDoubleVisitRequests } from "@/components/phoenix-crm/double-visit-requests";
import { CustomerVisitAsks } from "@/components/phoenix-crm/visit-asks";
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
import { useBrowserNamed } from "@/components/phoenix-crm/use-browser-name";
import { pointSourceText } from "@/components/phoenix-crm/place-move-screen";
import { RequestCard, sortRequests } from "@/components/phoenix-crm/request-card";
import { TimingsReadout } from "@/components/phoenix-crm/timings-editor";
import {
  CrmBackBar,
  CrmBlock,
  CrmButton,
  CrmFacts,
  CrmField,
  CrmNote,
  CrmPanel,
  CrmPill,
  CrmSelect,
  crmTextareaClassName,
} from "@/components/phoenix-crm/ui";
import { directionsUrl } from "@/lib/phoenix-crm/directions";
import { DROP_REASONS } from "@/lib/phoenix-crm/entry-rules";
import { formatDistance } from "@/lib/phoenix-crm/geo";
import {
  LOCATION_CHECKING_TEXT,
  LOCATION_CHECKING_TITLE,
  LOCATION_NOT_CONFIRMED_TEXT,
  LOCATION_NOT_CONFIRMED_TITLE,
  NOT_VALIDATED_YET_TITLE,
} from "@/lib/phoenix-crm/google-place-rules";
import { validationRefusalRepText } from "@/lib/phoenix-crm/validation-feedback";
import { awaitsValidation, neverAdmitted, onTheList, requestKindLabel, type ListMove } from "@/lib/phoenix-crm/list-request-rules";
import { isPharmacyListType } from "@/lib/phoenix-crm/pharmacy-call-rules";
import type { CustomerPharmacy, ListCustomer, ListPlace, TerritoryListView } from "@/lib/phoenix-crm/view-types";

const PLACE_RELOAD = new Set(["phoenix_crm_last_place", "phoenix_crm_place_not_found", "phoenix_crm_place_retired"]);
/** The written reason removing a clinic needs — the same bounds a move has (place-move.ts). */
const PLACE_REASON_MIN = 10;
const PLACE_REASON_MAX = 500;
const MOVE_RELOAD = new Set(["phoenix_crm_not_outside", "phoenix_crm_customer_not_found"]);
/** The written reason moving a customer to another rep needs — the same bounds the server holds it to
 * (CUSTOMER_MOVE_REASON_MIN/MAX, server/list.ts) and the database repeats (phoenix_crm_move_customer). */
const MOVE_CUSTOMER_REASON_MIN = 10;
const MOVE_CUSTOMER_REASON_MAX = 500;

/**
 * Whether this viewer may see a clinic's measurements (its coordinates, their accuracy, the phone's
 * clock): the Super Admin and the SFE Manager alone (owner, 2026-10-02 — the district manager sees the
 * distance only, and the territory's rep sees nothing, Golden Rule #1). The SERVER decides it
 * (`readsLocationDetail`) and sends nobody else the fields at all (`placeWithoutMeasurements`,
 * server/blind-payloads.ts), because a field a browser receives counts as shown.
 */
function seesMeasurements(view: TerritoryListView): boolean {
  return view.seesMeasurements;
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

  // On the list — and a pharmacy is on it validated or not, because it needs no validation (owner,
  // 2026-10-03, `awaitsValidation`).
  const active = onTheList(customer);
  // Carried over from iReports360 and not validated yet: a real customer the rep plans and visits, who
  // counts in nothing until he validates him at the clinic. Validating is once, and it is forever.
  const pending = awaitsValidation(customer);
  // Validated at the door. The clinic, grade and details screens are a validated customer's, so a
  // pharmacy that is on the list without ever being validated is offered none of them.
  const validated = customer.status === "active";
  // Met outside the list and validated at the door: waiting for the rep to ask to add him, or for the
  // district manager and SFE once he has.
  const outside = customer.status === "outside";
  const archived = customer.status === "dropped";
  const standing = monthStanding(customer.visitsThisMonth, customer.target);
  const full = customer.places.length >= view.rules.placesMax;
  const moves = view.canEdit ? movesOf(customer) : [];
  // A manager of the territory validates a carried-over customer beside its rep (owner, 2026-10-02) and
  // does NOTHING else on this screen: no drop, no grade, no hours, no add — those are the rep's own work
  // (`canValidateReference` is deliberately narrower than `canEdit`).
  // Not while the system is checking the place he already captured (2026-10-03): there is nothing to
  // validate until the check answers.
  const checking = customer.locationCheck === "checking";
  const notConfirmed = customer.locationCheck === "not_confirmed";
  // 🔴 A customer the Super Admin moved into a polyclinic is waiting for the BUILDING's timetable, never
  // for a photo of his own door: offering Validate would capture a second place and undo the move.
  const seatedPending = pending && !checking && !notConfirmed && customer.places.some((place) => place.sharedPlaceId);
  const seatedBoardOnFile = customer.places.some((place) => place.sharedPlaceId && place.venueTimetableOnFile);
  // 🔴 THE BUILDING ITSELF IS NOT CONFIRMED YET (owner, 2026-10-14): the customer is saved and visited like
  // any other and joins the KPIs when it is. There is no timetable to photograph — his own seating already
  // brought the building's board — so the button below is not offered, and the words are about the building.
  const seatedVenueHeld = customer.places.some((place) => place.sharedPlaceId && place.venueHeld);
  const canValidateThis = pending && !checking && customer.referenceContactCrmId !== null && view.canValidateReference;
  const offerValidate = canValidateThis && !seatedPending;
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
  // A customer the SFE loaded from a sheet has no iReports360 row at all, so those two lines would both
  // read "None recorded" on him. What he has instead is what the SFE wrote for the rep: which door.
  const intakeFacts = [
    ...(customer.intake?.where ? [{ label: "Where to find them", value: customer.intake.where }] : []),
    ...(customer.intake?.note ? [{ label: "Note", value: customer.intake.note }] : []),
  ];
  const facts = pending
    ? [
        { label: "This month", value: pendingVisitsText(customer.visitsThisMonth) },
        { label: "Validated", value: "Not yet" },
        ...(customer.reference || intakeFacts.length === 0
          ? [
              { label: "Address in iReports360", value: referenceAddressText(customer.reference) ?? "None recorded" },
              { label: "Last visit in iReports360", value: referenceLastVisitText(customer.reference) },
            ]
          : []),
        ...intakeFacts,
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
            // A pharmacy never validated has nothing to say here, and "Validated: not recorded" would
            // read as something still owed.
            ...(customer.validatedAt === null
              ? []
              : [
                  { label: "Validated", value: cairoStamp(customer.validatedAt) },
                  { label: "Validated by", value: customer.validatedByName ?? "Not on record" },
                ]),
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

        {/* The place check, in the system's words — never a person's (owner, 2026-10-03). 🔴 EXACTLY ONE
            of the next three notices can show (2026-10-08): "Validate again" and "Not validated yet" both
            tested `pending && !checking` for five live days, so a refused rep read both, one under the
            other, the second written for somebody never validated at all. */}
        {checking ? (
          <CrmNote className="mt-3" title={LOCATION_CHECKING_TITLE} tone="info">
            {LOCATION_CHECKING_TEXT}
          </CrmNote>
        ) : null}
        {pending && !checking && notConfirmed ? (
          <CrmNote className="mt-3" title={LOCATION_NOT_CONFIRMED_TITLE} tone="warn">
            {/* What is wrong with HIS PHOTO, from the closed list — never the note, never who decided. A
                refusal from before the list existed falls back to the impersonal sentence. */}
            {validationRefusalRepText(customer.validateAgainReason) ?? LOCATION_NOT_CONFIRMED_TEXT}
          </CrmNote>
        ) : null}
        {/* A comment somebody chose to show him about this customer (owner, 2026-10-13). It is the ONE
            thing in his app that comes from a person rather than the system, and it is exactly this
            wide: the writer's ROLE — "From the System Administrator" or "From your manager" — the
            words, and when. Never a name, never a recommendation, and nothing pinged him about it: the
            server sends only the comments marked visible (`loadRepVisiblePlaceNotes`), so this cannot
            render one he may not read. */}
        {customer.notes.map((note) => (
          <CrmNote className="mt-3" key={note.noteId} title={note.authorText} tone="info">
            <span className="block break-words" dir="auto">
              {note.body}
            </span>
            <span className="mt-0.5 block text-xs font-semibold text-slate-500">{note.writtenAtText}</span>
          </CrmNote>
        ))}
        {seatedPending && seatedVenueHeld ? (
          <CrmNote className="mt-3" title="Waiting for this polyclinic to be confirmed" tone="info">
            This customer is in a polyclinic that is not confirmed yet. Their visits are saved, and they join the KPIs once the polyclinic is confirmed.
          </CrmNote>
        ) : null}
        {seatedPending && !seatedVenueHeld ? (
          <CrmNote className="mt-3" title="Waiting for this building's timetable" tone="info">
            {seatedBoardOnFile
              ? "This customer is in a polyclinic whose timetable does not name them yet. Their visits are counted, and they join the KPIs once the timetable names them."
              : "This customer is in a polyclinic with no timetable photo yet. Their visits are counted, and they join the KPIs once the timetable is photographed and names them."}
          </CrmNote>
        ) : null}
        {seatedPending && !seatedVenueHeld && (view.canEdit || view.canValidateReference) ? (
          <div className="mt-3 grid gap-2 sm:flex sm:flex-wrap">
            <CrmButton
              onClick={() => {
                const seated = customer.places.find((place) => place.sharedPlaceId);
                if (seated?.sharedPlaceId) onOpen({ name: "venue-timetable", customerId: customer.customerId, sharedPlaceId: seated.sharedPlaceId });
              }}
              variant="primary"
            >
              {seatedBoardOnFile ? "The timetable changed — photograph it again" : "Photograph the timetable"}
            </CrmButton>
          </div>
        ) : null}
        {pending && !checking && !notConfirmed && !seatedPending ? (
          <CrmNote className="mt-3" title={NOT_VALIDATED_YET_TITLE} tone="info">
            {PENDING_COUNTS_NOTE} Validating captures this customer&apos;s signboard photo, the location and the days and hours. It happens once.
          </CrmNote>
        ) : null}
        {outside ? (
          <CrmNote className="mt-3" title="Outside your list" tone="info">
            {proposedAdd
              ? twoStepText(view, "add them to your list")
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

        {view.canEdit || offerValidate ? (
          <div className="mt-3 grid gap-2 sm:flex sm:flex-wrap">
            {offerValidate ? (
              <CrmButton onClick={() => onOpen({ name: "validate", contactCrmId: customer.referenceContactCrmId as number })} variant="primary">
                Validate this customer
              </CrmButton>
            ) : null}
            {view.canEdit && (validated || outside) ? (
              <CrmButton disabled={full} onClick={() => onOpen({ name: "add-place", customerId: customer.customerId, draft: null })}>
                {full ? `${view.rules.placesMax} clinics, the most a customer can have` : "Add another clinic"}
              </CrmButton>
            ) : null}
            {view.canEdit && validated ? (
              <CrmButton disabled={customer.pendingGradeRequestId !== null} onClick={() => onOpen({ name: "grade", customerId: customer.customerId })}>
                Propose a grade
              </CrmButton>
            ) : null}
            {/* Owner, 2026-09-22: the name and the speciality are corrected here, after validating — never
                inside it. The grade keeps its proposal flow above, because it sets the rep's own target. */}
            {view.canEdit && (validated || outside) ? (
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
        {/* The SFE Manager reaches into the list from outside it (owner, 2026-10-06): he drops an
            irrelevant customer himself, or hands him to another rep. On the list only — a customer in
            the Archive has already left it, and one waiting outside it is on nobody's list to hand on. */}
        {/* The Super Admin seats a customer entered on his own into a validated polyclinic (owner,
            2026-10-10). On the customer's page, never a second button on a list row. */}
        {view.canSeatInVenue && customer.listType !== "Pharmacy" && (active || pending) && customer.places.some((place) => !place.sharedPlaceId) ? (
          <div className="mt-3 grid min-w-0 gap-2 border-t border-slate-100 pt-3">
            <p className="break-words text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500">Super Admin · polyclinics</p>
            <div className="grid gap-2 sm:flex sm:flex-wrap">
              <CrmButton onClick={() => onOpen({ name: "seat-in-venue", customerId: customer.customerId })}>Move into a polyclinic</CrmButton>
            </div>
          </div>
        ) : null}
        {view.canCurateList && (active || pending) ? (
          <CurateFromList customer={customer} onLeave={onLeave ?? onNotice} seatId={seatId} test={test} view={view} />
        ) : null}
      </CrmBlock>

      {/* 🔴 A PHARMACY'S OWN LOCATION AND ITS RESPONSIBLE PERSON'S PHONE (owner, 2026-10-09), both
          optional. It is a RECORD of where the shop is — the governorate, the area and the brick the
          server read off the rep's pin — and never a check: no visit of his is measured against it. A
          doctor's location is a validated place and is drawn by `ListPlaces` below, never here. */}
      {isPharmacyListType(customer.listType) ? (
        <CrmBlock className="border-t border-slate-100" title="Where it is">
          {customer.pharmacyPin ? (
            <div className="grid min-w-0 gap-2">
              <PharmacyLocationFacts pin={customer.pharmacyPin} />
              <DirectionsLink customerName={customer.name} href={directionsUrl(customer.pharmacyPin)} />
              {customer.pharmacyPin.capturedAt ? (
                <p className="min-w-0 break-words text-phx-xs font-semibold text-slate-500">
                  Captured {cairoStamp(customer.pharmacyPin.capturedAt)}
                  {customer.pharmacyPin.capturedByName ? ` by ${customer.pharmacyPin.capturedByName}` : ""}
                </p>
              ) : null}
            </div>
          ) : (
            <p className="min-w-0 break-words text-sm font-medium leading-6 text-slate-600">
              Its location is not saved. Saving it is optional — stand in the pharmacy and capture it the next time you are there, and Phoenix works
              out its governorate, area and brick by itself.
            </p>
          )}
          {view.canEdit && !archived ? (
            <div className="mt-3 grid gap-2 sm:flex sm:flex-wrap">
              <CrmButton onClick={() => onOpen({ name: "pharmacy-details", customerId: customer.customerId })}>
                {customer.pharmacyPin ? "Change its location or phone" : "Save its location or phone"}
              </CrmButton>
            </div>
          ) : null}
        </CrmBlock>
      ) : null}

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

      {/* A visit asked of his manager, a product manager of his line, or his manager and the one above
          (owner, 2026-10-02): his own requests, each with its answer. Read on its own, like the timeline,
          and the key starts a fresh read for another customer. */}
      <CustomerVisitAsks
        customerId={customer.customerId}
        customerName={customer.name}
        key={`asks:${seatId}:${customer.customerId}`}
        seatId={seatId}
        test={test}
      />

      {/* A double visit the rep asked for in his last answer of Add visit (owner, 2026-10-16): who was
          asked and how each answered, with a way to change the days and none to cancel. Drawn only
          when the customer has one. */}
      <CustomerDoubleVisitRequests
        customerId={customer.customerId}
        key={`double:${seatId}:${customer.customerId}`}
        seatId={seatId}
        test={test}
      />

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

      {/* A doctor's block. A pharmacy's own visits carry its own name (owner, 2026-10-03), so on a
          pharmacy it would list the pharmacy as the pharmacy it took feedback from. */}
      {!archived && !isPharmacyListType(customer.listType) ? (
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

      {/* What happened at each visit, newest first (owner, 2026-10-02) — read on its own, so the list is
          never held up by it. The key starts a fresh read for another customer. */}
      <CustomerTimeline customerId={customer.customerId} key={`${seatId}:${customer.customerId}`} seatId={seatId} test={test} />

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
  // A location refusal names HIS browser, never "Phoenix" (use-browser-name.ts); anything else is untouched.
  const browserNamed = useBrowserNamed();

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
          {twoStepText(view, moves.includes("ask_to_drop") ? "take them off your list" : moves.includes("request_add") ? "add them to your list" : "bring them back to your list")}
        </p>
      ) : null}
      {problem ? <CrmNote tone="bad">{browserNamed(problem)}</CrmNote> : null}
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
  // A location refusal names HIS browser, never "Phoenix" (use-browser-name.ts); anything else is untouched.
  const browserNamed = useBrowserNamed();

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
            Bring {customer.name} back to the rep&apos;s list? The customer returns with their grade and their clinics.
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
      {problem ? <CrmNote tone="bad">{browserNamed(problem)}</CrmNote> : null}
    </div>
  );
}

/**
 * The SFE Manager's own two acts on a rep's list, from outside it (owner, 2026-10-06: "make the sfe
 * able to enter on any med rep list and delete or drop from it any irrelevant customer or move this
 * customer to and choose where").
 *
 * Both are shown only when the SERVER says so (`view.canCurateList`) and both carry what they are
 * written down with: the drop its reason from the module's own list, the move the rep it goes to and a
 * sentence saying why. Neither replaces the rep's own path — a rep still asks, and his district manager
 * and then SFE answer — which is why this sits apart from `ListMoves` above rather than inside it.
 */
function CurateFromList({
  customer,
  onLeave,
  seatId,
  test,
  view,
}: {
  customer: ListCustomer;
  /**
   * Both acts take the customer off THIS list, so both end on the list behind it with the notice —
   * there is no card left to show. The caller passes its own `onNotice` where it has no `onLeave`.
   */
  onLeave: (notice: ListNotice) => void;
  seatId: string;
  test: boolean;
  view: TerritoryListView;
}) {
  const [open, setOpen] = useState<"drop" | "move" | null>(null);
  const [dropReason, setDropReason] = useState("");
  const [dropNote, setDropNote] = useState("");
  const [toSeatId, setToSeatId] = useState("");
  const [moveReason, setMoveReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // A location refusal names HIS browser, never "Phoenix" (use-browser-name.ts); anything else is untouched.
  const browserNamed = useBrowserNamed();

  function close() {
    setOpen(null);
    setProblem(null);
    setDropReason("");
    setDropNote("");
    setToSeatId("");
    setMoveReason("");
  }

  async function drop() {
    setBusy(true);
    setProblem(null);
    try {
      await crmPost<unknown>(
        "/api/phoenix-crm/list/curate/drop",
        { seatId, test, customerId: customer.customerId, reason: dropReason, note: dropNote },
        "dropped",
      );
      onLeave({
        tone: "good",
        title: `Off the list: ${customer.name}`,
        message: `In the Archive, with your reason on the record. ${view.territory.repName ?? "The rep"} no longer plans or visits this customer.`,
      });
    } catch (error) {
      setProblem(messageOf(error));
      setBusy(false);
    }
  }

  async function move() {
    setBusy(true);
    setProblem(null);
    const target = view.moveTargets.find((entry) => entry.seatId === toSeatId) ?? null;
    try {
      await crmPost<unknown>(
        "/api/phoenix-crm/list/curate/move",
        { seatId, test, customerId: customer.customerId, toSeatId, reason: moveReason },
        "moved",
      );
      onLeave({
        tone: "good",
        title: `Moved: ${customer.name}`,
        message: `Now on ${target?.repName ?? target?.territoryName ?? "the chosen rep"}'s list, with the grade, the clinics and the validation they already had.`,
      });
    } catch (error) {
      setProblem(messageOf(error));
      setBusy(false);
    }
  }

  const moveReady = toSeatId !== "" && moveReason.trim().length >= MOVE_CUSTOMER_REASON_MIN;

  return (
    <div className="mt-3 grid min-w-0 gap-2 border-t border-slate-100 pt-3">
      <p className="break-words text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500">SFE · this rep&apos;s list</p>
      {open === null ? (
        <div className="grid gap-2 sm:flex sm:flex-wrap">
          <CrmButton onClick={() => setOpen("move")}>Move to another rep</CrmButton>
          <CrmButton onClick={() => setOpen("drop")} variant="danger">
            Drop from this list
          </CrmButton>
        </div>
      ) : null}
      {open === "drop" ? (
        <div className="grid min-w-0 gap-2 border border-rose-200 bg-rose-50 px-3 py-3">
          <p className="break-words text-sm font-bold text-rose-900">
            Take {customer.name} off {view.territory.repName ?? "this rep"}&apos;s list and put them in the Archive?
          </p>
          <CrmField htmlFor="curate-drop-reason" label="Why this customer leaves the list">
            <CrmSelect id="curate-drop-reason" onChange={(event) => setDropReason(event.target.value)} value={dropReason}>
              <option value="">Choose a reason</option>
              {DROP_REASONS.map((reason) => (
                <option key={reason.key} value={reason.key}>
                  {reason.label}
                </option>
              ))}
            </CrmSelect>
          </CrmField>
          <CrmField
            hint={dropReason === "other" ? "Required for “Other”." : "Optional."}
            htmlFor="curate-drop-note"
            label="Note"
          >
            <textarea
              className={crmTextareaClassName}
              id="curate-drop-note"
              maxLength={500}
              onChange={(event) => setDropNote(event.target.value)}
              value={dropNote}
            />
          </CrmField>
          <div className="flex min-w-0 flex-wrap gap-2">
            <CrmButton
              busy={busy}
              disabled={!dropReason || (dropReason === "other" && !dropNote.trim())}
              onClick={() => void drop()}
              size="sm"
              variant="danger"
            >
              Drop from the list
            </CrmButton>
            <CrmButton disabled={busy} onClick={close} size="sm">
              Keep on the list
            </CrmButton>
          </div>
        </div>
      ) : null}
      {open === "move" ? (
        <div className="grid min-w-0 gap-2 border border-slate-200 px-3 py-3">
          <p className="break-words text-sm font-bold text-slate-800">
            Move {customer.name} to another rep&apos;s list. The grade, the potential, the clinics and the validation go with them; every
            visit already recorded stays with {view.territory.repName ?? "this rep"}.
          </p>
          {view.moveTargets.length === 0 ? (
            <CrmNote tone="warn">There is no other rep seat you can move this customer to.</CrmNote>
          ) : (
            <>
              <CrmField htmlFor="curate-move-to" label="Move to">
                <CrmSelect id="curate-move-to" onChange={(event) => setToSeatId(event.target.value)} value={toSeatId}>
                  <option value="">Choose a rep</option>
                  {/* The line is written INTO each label, never an optgroup: the admin combo box flattens
                      groups, so a grouped picker loses its headings silently (CrmSelect). */}
                  {view.moveTargets.map((target) => (
                    <option key={target.seatId} value={target.seatId}>
                      {[target.repName ?? "Seat with no rep today", target.lineName, target.territoryName].filter(Boolean).join(" · ")}
                    </option>
                  ))}
                </CrmSelect>
              </CrmField>
              <CrmField
                hint={`At least ${MOVE_CUSTOMER_REASON_MIN} characters. It stays on the record of the move.`}
                htmlFor="curate-move-reason"
                label="Why the customer is moving"
              >
                <textarea
                  className={crmTextareaClassName}
                  id="curate-move-reason"
                  maxLength={MOVE_CUSTOMER_REASON_MAX}
                  onChange={(event) => setMoveReason(event.target.value)}
                  value={moveReason}
                />
              </CrmField>
              <div className="flex min-w-0 flex-wrap gap-2">
                <CrmButton busy={busy} disabled={!moveReady} onClick={() => void move()} size="sm" variant="primary">
                  Move the customer
                </CrmButton>
                <CrmButton disabled={busy} onClick={close} size="sm">
                  Leave on this list
                </CrmButton>
              </div>
            </>
          )}
        </div>
      ) : null}
      {problem ? <CrmNote tone="bad">{browserNamed(problem)}</CrmNote> : null}
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
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // A location refusal names HIS browser, never "Phoenix" (use-browser-name.ts); anything else is untouched.
  const browserNamed = useBrowserNamed();

  const reasonLength = reason.trim().length;
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
      // Removing a clinic changes where the customer is, so it is the movers' alone (owner, 2026-09-29)
      // and, like a move, it carries a written reason onto the record.
      await crmPost<unknown>(
        "/api/phoenix-crm/list/places/move",
        { seatId, test, placeId: place.placeId, action: "retire", reason: reason.trim() },
        "place",
      );
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
              {typeof place.accuracyMeters === "number" ? `within ${formatDistance(Math.round(place.accuracyMeters))}` : "accuracy unknown"}
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

      {place.signboardRetake ? (
        // The system sent this place back for a new photo of its nameplate (2026-10-18): the reason is
        // HIS to read, because it says what to photograph differently.
        <div className="mt-3 border-t border-slate-100 pt-3">
          <CrmNote title="New signboard photo needed" tone="warn">
            {place.signboardRetake}
          </CrmNote>
          {view.canEdit ? (
            <div className="mt-2 grid gap-2 sm:flex sm:flex-wrap">
              <CrmButton
                onClick={() => onOpen({ name: "retake-signboard", customerId: customer.customerId, placeId: place.placeId })}
                size="sm"
                variant="primary"
              >
                Retake the signboard photo
              </CrmButton>
            </div>
          ) : null}
        </div>
      ) : null}

      {editsHours || view.canMovePlaces ? (
        <div className="mt-3 flex min-w-0 flex-wrap items-center gap-2">
          {confirming ? (
            // A removal is a change of where the customer is, exactly as a move is, so it is kept on
            // record the same way: a written reason, and every visit to him measured again afterwards.
            <div className="min-w-0 basis-full">
              <CrmField
                hint={`Needed · at least ${PLACE_REASON_MIN} characters · ${reasonLength} of ${PLACE_REASON_MAX}`}
                htmlFor={`phoenix-crm-retire-reason-${place.placeId}`}
                label={`Why this clinic is removed from ${customer.name}`}
              >
                <textarea
                  className={crmTextareaClassName}
                  disabled={busy}
                  id={`phoenix-crm-retire-reason-${place.placeId}`}
                  maxLength={PLACE_REASON_MAX}
                  onChange={(event) => {
                    setReason(event.target.value);
                    setProblem(null);
                  }}
                  value={reason}
                />
              </CrmField>
              <div className="mt-3 flex min-w-0 flex-wrap items-center gap-2">
                <CrmButton busy={busy} disabled={reasonLength < PLACE_REASON_MIN} onClick={() => void retire()} size="sm" variant="danger">
                  Remove
                </CrmButton>
                <CrmButton disabled={busy} onClick={() => setConfirming(false)} size="sm">
                  Keep it
                </CrmButton>
              </div>
            </div>
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
          {browserNamed(problem)}
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
  // A location refusal names HIS browser, never "Phoenix" (use-browser-name.ts); anything else is untouched.
  const browserNamed = useBrowserNamed();
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
          {browserNamed(problem)}
        </CrmNote>
      ) : null}
    </article>
  );
}
