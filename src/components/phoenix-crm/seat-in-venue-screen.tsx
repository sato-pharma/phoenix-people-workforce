"use client";

/**
 * Phoenix CRM — moving standalone customers INTO a validated polyclinic: the Super Admin's screen alone.
 *
 * Owner, 2026-10-10: "only the super admin can move a customer in one list … to a polyclinic. For
 * example, a doctor is entered as a separate customer, but actually he is in this polyclinic. So add
 * the option to the admin to move this doctor to — and the validated polyclinics of the rep I am
 * standing in his account appears. And I move the doctors to the polyclinic."
 *
 * Shaped as he asked: pick the building, tick the customers, write one reason. Nothing about the
 * location is offered to choose — each customer takes the building's point exactly ("since he is in the
 * polyclinic, he's already in the polyclinic"). The server refuses everyone but the Super Admin
 * (`seatPlacesInVenue`, `canDecideSharedPlaces`) and this screen refuses to draw for anyone else.
 */

import { useMemo, useState } from "react";

import { crmPost, crmUrl, errorCodeOf, messageOf, useCrmGet } from "@/components/phoenix-crm/api";
import { customerMetaText } from "@/components/phoenix-crm/labels";
import { ListGone, type ListNotice, type ListScreenBase } from "@/components/phoenix-crm/list-screens";
import { seatedNote, venueWhere, type SharedPlaceChoice } from "@/components/phoenix-crm/shared-place-screens";
import {
  CrmBackBar,
  CrmBlock,
  CrmButton,
  CrmCheck,
  CrmChoice,
  CrmField,
  CrmNote,
  CrmPanel,
  CrmSearchField,
  crmTextareaClassName,
} from "@/components/phoenix-crm/ui";
import type { ListCustomer, SeatedInVenueResult } from "@/lib/phoenix-crm/view-types";

/** The written reason a move needs — the bounds place-move.ts and the database hold. */
const REASON_MIN = 10;
const REASON_MAX = 500;
/** One hand-ticked list — the ceiling the server repeats. */
const PICK_MAX = 60;

const GONE_NOT_ADMIN = "Only the Super Admin moves a customer into a polyclinic.";

/** The customers that can still go in: on the list, and every active place of theirs stands alone. */
function standaloneCustomers(customers: ReadonlyArray<ListCustomer>): ListCustomer[] {
  return customers.filter(
    (customer) =>
      (customer.status === "active" || customer.status === "pending") &&
      // A pharmacy follows neither the AM nor the PM list, and a place inside a building carries one of the two.
      customer.listType !== "Pharmacy" &&
      customer.places.length > 0 &&
      customer.places.every((place) => !place.sharedPlaceId),
  );
}

export function SeatInVenueScreen(
  props: ListScreenBase & {
    customerId: string;
    onBack: () => void;
    onDone: (notice: ListNotice) => void;
  },
) {
  const { onBack, refreshing, view } = props;
  if (!view.canSeatInVenue) {
    return <ListGone backLabel="Customer" message={GONE_NOT_ADMIN} onBack={onBack} refreshing={refreshing} title="Move into a polyclinic" />;
  }
  return <SeatInVenueForm {...props} />;
}

function SeatInVenueForm({
  customerId,
  onBack,
  onDone,
  reload,
  seatId,
  test,
  view,
}: ListScreenBase & {
  customerId: string;
  onBack: () => void;
  onDone: (notice: ListNotice) => void;
}) {
  const venues = useCrmGet<{ sharedPlaces: SharedPlaceChoice[] }>(crmUrl("/api/phoenix-crm/shared-places", { seatId, test }), "sharedPlaces");
  const [venueId, setVenueId] = useState<string | null>(null);
  // The customer whose page he came from starts ticked — the likely reason he opened this screen.
  const [picked, setPicked] = useState<string[]>([customerId]);
  const [search, setSearch] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const list = venues.data?.sharedPlaces ?? [];
  const chosen = list.find((venue) => venue.sharedPlaceId === venueId) ?? null;
  const candidates = useMemo(() => standaloneCustomers(view.customers), [view.customers]);
  const shown = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return needle ? candidates.filter((customer) => customer.name.toLowerCase().includes(needle)) : candidates;
  }, [candidates, search]);
  const reasonLength = reason.trim().length;

  function toggle(id: string, on: boolean) {
    setProblem(null);
    setPicked((current) => (on ? (current.includes(id) ? current : [...current, id]) : current.filter((entry) => entry !== id)));
  }

  function clientProblem(): string | null {
    if (!chosen) return "Choose the polyclinic the customers are in.";
    if (picked.length === 0) return "Tick at least one customer to move into the polyclinic.";
    if (reasonLength < REASON_MIN) return `Write why they are moved (at least ${REASON_MIN} characters).`;
    return null;
  }

  async function save() {
    if (saving) return;
    const gap = clientProblem();
    if (gap || !chosen) {
      setProblem(gap);
      return;
    }
    // The place ids behind the ticked customers: every one of their places stands alone (the filter above).
    const placeIds = candidates
      .filter((customer) => picked.includes(customer.customerId))
      .flatMap((customer) => customer.places.map((place) => place.placeId));
    setSaving(true);
    setProblem(null);
    try {
      const result = await crmPost<SeatedInVenueResult>(
        "/api/phoenix-crm/list/places/seat",
        { seatId, test, sharedPlaceId: chosen.sharedPlaceId, placeIds, reason: reason.trim() },
        "seated",
      );
      const count = result.seated.length;
      onDone({
        tone: "good",
        title: `${count === 1 ? "1 customer" : `${count} customers`} moved into ${chosen.name}`,
        message: result.timetableOnFile
          ? "Each took the building's location exactly. The building's timetable is read for each of them, and a customer it names stays validated."
          : "Each took the building's location exactly. This building has no timetable yet, so their visits are counted but stay out of the KPIs until the rep photographs it.",
      });
    } catch (error) {
      const code = errorCodeOf(error);
      if (code === "phoenix_crm_place_not_found" || code === "phoenix_crm_place_retired" || code === "phoenix_crm_already_in_a_venue") reload();
      setProblem(messageOf(error));
      setSaving(false);
    }
  }

  return (
    <CrmPanel>
      <CrmBackBar backLabel="Customer" onBack={onBack} title="Move into a polyclinic" />

      <CrmBlock title="1 · The polyclinic">
        {venues.error ? (
          <CrmNote className="mb-3" tone="bad">
            {venues.error}
          </CrmNote>
        ) : null}
        {list.length === 0 ? (
          <p className="text-sm font-medium leading-6 text-slate-600">
            {venues.loading ? "Loading the polyclinics." : `No polyclinic or centre is validated on ${view.territory.repName ?? "this rep"}'s territory yet.`}
          </p>
        ) : (
          <CrmChoice
            columns={2}
            label="Polyclinics and centres on this territory"
            onChange={(next: string) => {
              setVenueId(next);
              setProblem(null);
            }}
            options={list.map((venue) => ({
              value: venue.sharedPlaceId,
              label: venue.name,
              note: `${venue.kindLabel} · ${venueWhere(venue)} · ${seatedNote(venue)}`,
              disabled: saving || venue.status !== "active",
            }))}
            value={venueId}
          />
        )}
        {chosen ? (
          <p className="mt-3 break-words text-xs font-semibold leading-5 text-slate-600">
            {chosen.schedulePhotoPath
              ? `This building's timetable is on file (${chosen.schedulePhotoCapturedAtText ?? "photographed"}). Each customer is read against it.`
              : "This building has no timetable photo yet. The customers are moved and their visits are counted, but they stay out of the KPIs until the rep photographs the timetable."}
          </p>
        ) : null}
      </CrmBlock>

      <CrmBlock className="border-t border-slate-100" title="2 · The customers">
        <CrmSearchField id="phoenix-crm-seat-search" label="Find a customer" onChange={setSearch} placeholder="Type a name" value={search} />
        <div className="mt-3">
          <CrmField hint={`${picked.length} chosen · at most ${PICK_MAX} · ${candidates.length} on this list stand alone`} label="Customers to move">
            {shown.length === 0 ? (
              <p className="text-sm font-medium leading-6 text-slate-600">
                {candidates.length === 0 ? "Every customer on this list is already inside a polyclinic." : "No customer matches that name."}
              </p>
            ) : (
              <div className="grid min-w-0 gap-1.5 sm:grid-cols-2">
                {shown.map((customer) => {
                  const on = picked.includes(customer.customerId);
                  return (
                    <CrmCheck
                      checked={on}
                      disabled={saving || (!on && picked.length >= PICK_MAX)}
                      key={customer.customerId}
                      onChange={(next) => toggle(customer.customerId, next)}
                    >
                      <span className="font-black text-slate-950">{customer.name}</span>
                      <span className="block text-xs font-semibold text-slate-500">{customerMetaText(customer)}</span>
                    </CrmCheck>
                  );
                })}
              </div>
            )}
          </CrmField>
        </div>
      </CrmBlock>

      <CrmBlock className="border-t border-slate-100" title="3 · Why">
        <CrmField
          hint={`Needed · at least ${REASON_MIN} characters · ${reasonLength} of ${REASON_MAX}`}
          htmlFor="phoenix-crm-seat-reason"
          label="Why they are moved"
        >
          <textarea
            className={crmTextareaClassName}
            disabled={saving}
            id="phoenix-crm-seat-reason"
            maxLength={REASON_MAX}
            onChange={(event) => {
              setReason(event.target.value);
              setProblem(null);
            }}
            value={reason}
          />
        </CrmField>
      </CrmBlock>

      <CrmBlock className="border-t border-slate-100">
        <CrmNote tone="info">
          Each customer takes the polyclinic&apos;s location exactly, and their hours stay as they are. Their visits are measured against the
          building again. Where the building&apos;s timetable does not name a customer, or there is no timetable yet, their visits are still
          counted but stay out of the KPIs until it does. The move is kept on record with who moved them, when and why.
        </CrmNote>
        {problem ? (
          <CrmNote className="mt-3" tone="bad">
            {problem}
          </CrmNote>
        ) : null}
        <div className="mt-3 grid gap-2 sm:flex sm:flex-wrap">
          <CrmButton busy={saving} onClick={() => void save()} variant="primary">
            Move into the polyclinic
          </CrmButton>
          <CrmButton disabled={saving} onClick={onBack}>
            Cancel
          </CrmButton>
        </div>
      </CrmBlock>
    </CrmPanel>
  );
}
