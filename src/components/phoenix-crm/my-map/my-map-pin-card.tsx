"use client";

/**
 * Phoenix CRM — the card a tapped pin opens on My map: who the customer is, where this place is, this month's
 * visits, and the Directions button (owner, 2026-10-27: "the rep can press and got directions from his current
 * location").
 *
 * 🔴 DIRECTIONS START FROM WHERE THE PHONE IS, AND PHOENIX NEVER LEARNS IT. `directionsUrl` opens Google Maps'
 * own route to the place with no starting point, so the phone's map app starts from the phone. Nothing about
 * where he is comes back here, and no distance is shown on this card.
 *
 * The facts come in the order a rep standing in the street needs them — this month's visits first, then where
 * the place is — and every one is said in words: a fact with no value names why, never a dash. A manager's card
 * adds the territory and its rep, so the facts stay an even grid either way.
 */

import { X } from "lucide-react";

import { DirectionsLink } from "@/components/phoenix-crm/directions-link";
import { countText, dayLabel } from "@/components/phoenix-crm/format";
import { CrmButton, CrmCard, CrmFacts, CrmPill, type PillTone } from "@/components/phoenix-crm/ui";
import { directionsUrl } from "@/lib/phoenix-crm/directions";
import { MY_MAP_LAYER_COLOUR, MY_MAP_LAYER_LABEL, myMapTierLabel, type MyMapCustomer, type MyMapPin, type MyMapTerritory } from "@/lib/phoenix-crm/my-map-rules";

export const MY_MAP_TIER_TONE: Record<MyMapCustomer["tier"], PillTone> = { 0: "neutral", 1: "warn", 2: "good" };

/** Each layer's colour as a card's left edge: the same flat colours as `MY_MAP_LAYER_COLOUR`. */
export const MY_MAP_LAYER_ACCENT: Record<MyMapPin["layer"], string> = {
  AM: "border-l-amber-600",
  PM: "border-l-indigo-800",
  Pharmacy: "border-l-teal-700",
};

/** "2 of 3", "1" for a customer with no grade number. */
export function visitsText(customer: MyMapCustomer): string {
  return customer.target === null ? countText(customer.visits) : `${countText(customer.visits)} of ${countText(customer.target)}`;
}

/** Speciality, grade and the place's own name, in one line. */
export function customerMeta(customer: MyMapCustomer, pin: MyMapPin | null): string {
  return [customer.speciality, customer.grade ? `Grade ${customer.grade}` : null, pin?.label ?? null, customer.places > 1 ? `${countText(customer.places)} places` : null]
    .filter(Boolean)
    .join(" · ");
}

/** The layer a pin is drawn in: its colour square, then its name — the same tag on the card and in the list. */
export function MyMapLayerTag({ layer }: { layer: MyMapPin["layer"] }) {
  return (
    <>
      <span aria-hidden className="inline-block h-2.5 w-2.5 shrink-0 self-center" style={{ backgroundColor: MY_MAP_LAYER_COLOUR[layer] }} />
      <CrmPill tone="info">{MY_MAP_LAYER_LABEL[layer]}</CrmPill>
    </>
  );
}

export function MyMapPinCard({
  customer,
  onClose,
  pin,
  showTerritory,
  territory,
}: {
  customer: MyMapCustomer;
  onClose: () => void;
  pin: MyMapPin;
  /** A manager's card names the territory and its rep; a rep's is all his own. */
  showTerritory: boolean;
  territory: MyMapTerritory | null;
}) {
  const facts = [
    { label: "Visits this month", value: visitsText(customer) },
    { label: "Last visit this month", value: customer.lastVisitOn ? dayLabel(customer.lastVisitOn) : "None yet" },
    { label: "Brick", value: pin.brick ?? "Not named" },
    { label: "Validated", value: customer.validatedOn ? dayLabel(customer.validatedOn) : "Date not recorded" },
  ];
  if (showTerritory) {
    facts.push(
      { label: "Territory", value: territory?.name || "Not named" },
      { label: "Rep", value: territory?.people || "Not named" },
    );
  }
  return (
    <div className="border border-l-0 border-slate-200">
      <CrmCard
        accent={MY_MAP_LAYER_ACCENT[pin.layer]}
        actions={
          <>
            <DirectionsLink customerName={customer.name} href={directionsUrl({ lat: pin.lat, lon: pin.lon })} />
            <CrmButton onClick={onClose} size="sm" variant="ghost">
              <X aria-hidden className="h-4 w-4" />
              Close
            </CrmButton>
          </>
        }
        meta={customerMeta(customer, pin) || null}
        status={
          <>
            <MyMapLayerTag layer={pin.layer} />
            {customer.isNew ? <CrmPill tone="orange">New this week</CrmPill> : null}
            {customer.plannedToday ? <CrmPill tone="good">In today&apos;s plan</CrmPill> : null}
            <CrmPill tone={MY_MAP_TIER_TONE[customer.tier]}>{myMapTierLabel(customer.tier, customer.listType)}</CrmPill>
          </>
        }
        title={customer.name}
      >
        <CrmFacts facts={facts} />
      </CrmCard>
    </div>
  );
}
