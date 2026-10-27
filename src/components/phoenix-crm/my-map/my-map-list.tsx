"use client";

/**
 * Phoenix CRM — the list under My map: each customer the map is showing, once, however many places he has.
 *
 * Cards on a phone, a fixed-width table from `md` up — the same rows drawn once per layout, never a table that
 * scrolls sideways. A page of 25 at a time; "Show on map" brings his pin into view and opens its card.
 *
 * A row reads the way the pin card does: the layer's own colour square and name, then this month's visits with
 * their standing beside them, so a phone card and a table row say the same thing in the same order.
 */

import { useState } from "react";

import { DirectionsLink } from "@/components/phoenix-crm/directions-link";
import { countText, plural } from "@/components/phoenix-crm/format";
import { customerMeta, MY_MAP_LAYER_ACCENT, MY_MAP_TIER_TONE, MyMapLayerTag, visitsText } from "@/components/phoenix-crm/my-map/my-map-pin-card";
import {
  CrmButton,
  CrmCard,
  CrmCardsOnPhone,
  CrmEmpty,
  CrmPill,
  CrmShowMore,
  CrmTable,
  crmTdClassName,
  crmThClassName,
} from "@/components/phoenix-crm/ui";
import { directionsUrl } from "@/lib/phoenix-crm/directions";
import { myMapTierLabel, type MyMapCustomer, type MyMapPin, type MyMapTerritory } from "@/lib/phoenix-crm/my-map-rules";

const PAGE = 25;

export type MyMapListRow = { customer: MyMapCustomer; pin: MyMapPin; territory: MyMapTerritory | null };

function Pills({ row }: { row: MyMapListRow }) {
  return (
    <>
      <MyMapLayerTag layer={row.pin.layer} />
      {row.customer.isNew ? <CrmPill tone="orange">New this week</CrmPill> : null}
      {row.customer.plannedToday ? <CrmPill tone="good">Today</CrmPill> : null}
    </>
  );
}

function territoryText(territory: MyMapTerritory): string {
  return [territory.name, territory.people].filter(Boolean).join(" · ");
}

export function MyMapList({
  onShow,
  rows,
  showTerritory,
}: {
  onShow: (pinId: string) => void;
  rows: ReadonlyArray<MyMapListRow>;
  /** A manager's list names whose territory each customer is on; a rep's is all his own. */
  showTerritory: boolean;
}) {
  const [shown, setShown] = useState(PAGE);
  const page = rows.slice(0, shown);

  if (rows.length === 0) {
    return <CrmEmpty message="Move the map, or change what it shows, to list the customers there." title="No customer in this part of the map" />;
  }

  return (
    <div className="min-w-0">
      <CrmCardsOnPhone>
        {page.map((row) => (
          <CrmCard
            accent={MY_MAP_LAYER_ACCENT[row.pin.layer]}
            actions={
              <>
                <CrmButton onClick={() => onShow(row.pin.id)} size="sm">
                  Show on map
                </CrmButton>
                <DirectionsLink customerName={row.customer.name} href={directionsUrl({ lat: row.pin.lat, lon: row.pin.lon })} />
              </>
            }
            key={row.pin.id}
            meta={
              <>
                {customerMeta(row.customer, row.pin) || null}
                <span className="block">{row.pin.brick ?? "Brick not named"}</span>
                {showTerritory && row.territory ? <span className="block">{territoryText(row.territory)}</span> : null}
              </>
            }
            status={<Pills row={row} />}
            title={row.customer.name}
          >
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <p className="break-words text-xs font-bold text-slate-600">{`Visits this month: ${visitsText(row.customer)}`}</p>
              <CrmPill tone={MY_MAP_TIER_TONE[row.customer.tier]}>{myMapTierLabel(row.customer.tier, row.customer.listType)}</CrmPill>
            </div>
          </CrmCard>
        ))}
      </CrmCardsOnPhone>
      <CrmTable columns={["30%", "14%", "22%", "16%", "18%"]}>
        <thead>
          <tr>
            <th className={crmThClassName}>Customer</th>
            <th className={crmThClassName}>List</th>
            <th className={crmThClassName}>{showTerritory ? "Brick and territory" : "Brick"}</th>
            <th className={crmThClassName}>Visits this month</th>
            <th className={crmThClassName}>Open</th>
          </tr>
        </thead>
        <tbody>
          {page.map((row) => (
            <tr key={row.pin.id}>
              <td className={crmTdClassName}>
                <p className="break-words font-black text-slate-950">{row.customer.name}</p>
                <p className="mt-0.5 break-words text-xs font-semibold text-slate-500">{customerMeta(row.customer, row.pin)}</p>
              </td>
              <td className={crmTdClassName}>
                <div className="flex flex-wrap gap-1">
                  <Pills row={row} />
                </div>
              </td>
              <td className={crmTdClassName}>
                <p className="break-words">{row.pin.brick ?? "Not named"}</p>
                {showTerritory && row.territory ? <p className="mt-0.5 break-words text-xs font-semibold text-slate-500">{territoryText(row.territory)}</p> : null}
              </td>
              <td className={crmTdClassName}>
                <p className="font-black text-slate-950">{visitsText(row.customer)}</p>
                <div className="mt-1">
                  <CrmPill tone={MY_MAP_TIER_TONE[row.customer.tier]}>{myMapTierLabel(row.customer.tier, row.customer.listType)}</CrmPill>
                </div>
              </td>
              <td className={crmTdClassName}>
                <div className="flex flex-wrap gap-1.5">
                  <CrmButton onClick={() => onShow(row.pin.id)} size="sm">
                    Show on map
                  </CrmButton>
                  <DirectionsLink customerName={row.customer.name} href={directionsUrl({ lat: row.pin.lat, lon: row.pin.lon })} />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </CrmTable>
      <CrmShowMore left={rows.length - page.length} onMore={() => setShown((count) => count + PAGE)} page={PAGE} />
      <p className="px-4 pb-3 pt-2 text-xs font-semibold text-slate-500 sm:px-5">
        {page.length === rows.length ? plural(rows.length, "customer", "customers") : `${countText(page.length)} of ${countText(rows.length)} customers shown`}
      </p>
    </div>
  );
}
