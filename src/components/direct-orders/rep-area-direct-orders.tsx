"use client";

import { PackageSearch } from "lucide-react";

import { PortalEmptyState } from "@/components/employee-portal/portal-primitives";
import {
  SURFACE_CLASS,
  SectionCard,
  TABLE_HEAD_CLASS,
  TABLE_ROW_CLASS,
  formatEgpFull,
  formatPeriod,
} from "@/components/sales/target-visuals";
import type { RepAreaDirectOrderRow, RepAreaDirectOrdersReport } from "@/lib/direct-orders/rep-area-view-service";
import { stableEnGbFormatter } from "@/lib/format/cairo-datetime";
import { adminPanelDepthClassName } from "@/components/admin/admin-design-tokens";

type Props = { report: RepAreaDirectOrdersReport };

/** Units exactly as the service returns them — never rounded. */
const units = (value: number) => value.toLocaleString("en-US");

/** The colour the sales pages already give the Direct Orders channel (Sales vs Target's split). */
const DIRECT_ORDERS_RAIL = "#8B5CF6";

/** A card's figure row: label and value side by side, wrapping rather than cutting. */
const CARD_FACT_CLASS = "flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5";

function lineCount(count: number): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? "order line" : "order lines"}`;
}

/**
 * An order stamp → "12 Aug 2026", Cairo. A bare date (YYYY-MM-DD) is read at noon UTC so it is the
 * same calendar day on the server and in every browser that renders this client component.
 */
function dayLabel(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value.length <= 10 ? `${value}T12:00:00Z` : value);
  if (Number.isNaN(date.getTime())) return value;
  // stableEnGbFormatter, never a bare Intl en-GB: CLDR 42 changed the September abbreviation from
  // "Sep" to "Sept", so server and browser disagree and React throws hydration error #418.
  return stableEnGbFormatter({
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "Africa/Cairo",
  }).format(date);
}

type MonthGroup = { month: string; rows: RepAreaDirectOrderRow[]; units: number; value: number };

/**
 * The rows under the month Finance counted them in, newest month first as the service sorts them.
 * Display only: each subtotal is the plain sum of the rows printed under it.
 */
function groupByCountedMonth(rows: RepAreaDirectOrderRow[]): MonthGroup[] {
  const groups = new Map<string, MonthGroup>();
  for (const row of rows) {
    const group = groups.get(row.salesMonth) ?? { month: row.salesMonth, rows: [], units: 0, value: 0 };
    group.rows.push(row);
    group.units += row.units;
    group.value += row.salesValue;
    groups.set(row.salesMonth, group);
  }
  return [...groups.values()];
}

/**
 * Direct Orders in my area — the Medical Rep's read-only view (owner, 2026-09-24).
 *
 * One row per product line, grouped under the month Finance counted it to sales, showing the
 * pharmacy it was booked on, when it was ordered, and its units and value. No actions: the rep can
 * only watch their District Manager's direct-order spend land in their territory.
 *
 * It speaks the sales pages' visual language (`target-visuals.tsx`): the same section card, table
 * head, row and "EGP 1,234" money as Sales vs Target and Targets.
 */
export function RepAreaDirectOrders({ report }: Props) {
  const { rows, areaNames, totalUnits, totalValue } = report;
  const areaLabel = areaNames.length > 0 ? areaNames.join(" · ") : "your area";

  if (rows.length === 0) {
    return (
      <div className={SURFACE_CLASS}>
        <PortalEmptyState
          title={`No direct orders counted to sales in ${areaLabel} yet.`}
          message="An order appears here once it is approved and Finance books it to a sales month."
        />
      </div>
    );
  }

  const groups = groupByCountedMonth(rows);

  return (
    <SectionCard
      surface="portal"
      icon={PackageSearch}
      title={areaLabel}
      subtitle={`${lineCount(rows.length)} · ${units(totalUnits)} units · ${formatEgpFull(totalValue)}`}
    >
      {/* Tablet and desktop: table-fixed + colgroup, so it always fits — never a sideways scroll. Five
          columns, not six: the counted month heads each group, so a row carries only its order date,
          and the width that freed went to Units and Value, which cannot wrap. */}
      <div className="hidden md:block">
        <table className="w-full table-fixed text-left text-sm">
          <colgroup>
            <col style={{ width: "27%" }} />
            <col style={{ width: "23%" }} />
            <col style={{ width: "18%" }} />
            <col style={{ width: "12%" }} />
            <col style={{ width: "20%" }} />
          </colgroup>
          <thead>
            <tr className={TABLE_HEAD_CLASS}>
              <th className="px-3 py-2.5">Pharmacy</th>
              <th className="px-3 py-2.5">Product</th>
              <th className="px-3 py-2.5">Order date</th>
              <th className="px-3 py-2.5 text-right">Units</th>
              <th className="px-3 py-2.5 text-right">Value</th>
            </tr>
          </thead>
          {groups.map((group) => (
            <tbody key={group.month}>
              <tr className="border-b border-slate-200 bg-slate-50">
                <td className="px-3 py-2" colSpan={3}>
                  <span className="font-black text-slate-900">Counted in {formatPeriod(group.month)}</span>
                  <span className="text-phx-xs font-semibold text-slate-500">{` · ${lineCount(group.rows.length)}`}</span>
                </td>
                <td className="break-words px-3 py-2 text-right font-black tabular-nums text-slate-900">
                  {units(group.units)}
                </td>
                <td className="break-words px-3 py-2 text-right font-black tabular-nums text-slate-900">
                  {formatEgpFull(group.value)}
                </td>
              </tr>
              {group.rows.map((row, index) => (
                <tr key={`${row.requestId}-${row.productName}-${index}`} className={`${TABLE_ROW_CLASS} align-top`}>
                  <td className="px-3 py-2.5">
                    <p dir="auto" className="break-words font-bold text-slate-900">
                      {row.pharmacyName}
                    </p>
                    <p dir="auto" className="break-words text-phx-xs text-slate-500">
                      {row.areaName}
                    </p>
                  </td>
                  <td className="break-words px-3 py-2.5 text-slate-700">{row.productName}</td>
                  <td className="px-3 py-2.5 text-slate-700">{dayLabel(row.orderDate)}</td>
                  <td className="break-words px-3 py-2.5 text-right font-bold tabular-nums text-slate-900">
                    {units(row.units)}
                  </td>
                  <td className="break-words px-3 py-2.5 text-right font-bold tabular-nums text-slate-900">
                    {formatEgpFull(row.salesValue)}
                  </td>
                </tr>
              ))}
            </tbody>
          ))}
          <tfoot>
            <tr className="border-t-2 border-slate-200 bg-slate-50/70">
              <td className="px-3 py-3 font-black text-slate-900" colSpan={3}>
                All months
              </td>
              <td className="break-words px-3 py-3 text-right font-black tabular-nums text-slate-900">{units(totalUnits)}</td>
              <td className="break-words px-3 py-3 text-right font-black tabular-nums text-slate-900">
                {formatEgpFull(totalValue)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      {/* Phone: cards under the same month headings. The owner's rule is that a phone never gets a table. */}
      <div className="md:hidden">
        {groups.map((group) => (
          <section key={group.month} className="border-b border-slate-100 last:border-b-0">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 bg-slate-50 px-3 py-2">
              <p className="min-w-0 text-xs font-black text-slate-900">
                Counted in {formatPeriod(group.month)}
                <span className="block text-phx-xs font-semibold text-slate-500">
                  {`${lineCount(group.rows.length)} · ${units(group.units)} units`}
                </span>
              </p>
              <p className="whitespace-nowrap text-sm font-black tabular-nums text-slate-900">{formatEgpFull(group.value)}</p>
            </div>
            <div className="space-y-2 p-3">
              {group.rows.map((row, index) => (
                <article key={`${row.requestId}-${row.productName}-${index}`} className={`flex border border-slate-200 bg-white ${adminPanelDepthClassName}`}>
                  <span className="w-1 shrink-0" style={{ backgroundColor: DIRECT_ORDERS_RAIL }} aria-hidden />
                  <div className="min-w-0 flex-1 p-3">
                    <p dir="auto" className="break-words text-sm font-black text-slate-900">
                      {row.pharmacyName}
                    </p>
                    <p dir="auto" className="break-words text-phx-xs text-slate-500">
                      {row.areaName}
                    </p>
                    <p className="mt-2 break-words text-sm font-bold text-slate-800">{row.productName}</p>
                    <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 border-t border-slate-100 pt-2 text-xs">
                      <div className={CARD_FACT_CLASS}>
                        <dt className="text-slate-500">Units</dt>
                        <dd className="whitespace-nowrap font-bold tabular-nums text-slate-900">{units(row.units)}</dd>
                      </div>
                      <div className={CARD_FACT_CLASS}>
                        <dt className="text-slate-500">Value</dt>
                        <dd className="whitespace-nowrap font-black tabular-nums text-slate-900">{formatEgpFull(row.salesValue)}</dd>
                      </div>
                    </dl>
                    <p className="mt-2 text-phx-xs text-slate-500">Ordered {dayLabel(row.orderDate)}</p>
                  </div>
                </article>
              ))}
            </div>
          </section>
        ))}
      </div>
    </SectionCard>
  );
}
