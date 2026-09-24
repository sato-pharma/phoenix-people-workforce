import type { RepAreaDirectOrdersReport } from "@/lib/direct-orders/rep-area-view-service";

type Props = { report: RepAreaDirectOrdersReport };

const money = (value: number) => `${Math.round(value).toLocaleString("en-US")} EGP`;
const units = (value: number) => value.toLocaleString("en-US");

/** "2026-08" → "Aug 2026". Falls back to the raw month if it is not YYYY-MM. */
function monthLabel(month: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return month || "—";
  const date = new Date(Number(match[1]), Number(match[2]) - 1, 1);
  return new Intl.DateTimeFormat("en-GB", { month: "short", year: "numeric", timeZone: "Africa/Cairo" }).format(date);
}

/** A collection date (YYYY-MM-DD) or an ISO stamp → "12 Aug 2026", Cairo. */
function dayLabel(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value.length <= 10 ? `${value}T00:00:00` : value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "Africa/Cairo",
  }).format(date);
}

/**
 * Direct Orders in my area — the Medical Rep's read-only view (owner, 2026-09-24).
 *
 * One row per product line, showing the pharmacy it was booked on, when it was collected, the
 * month Finance counted it to sales, and its units and value. No actions: the rep can only watch
 * their District Manager's direct-order spend land in their territory.
 */
export function RepAreaDirectOrders({ report }: Props) {
  const { rows, areaNames, totalUnits, totalValue } = report;
  const areaLabel = areaNames.length > 0 ? areaNames.join(" · ") : "your area";

  if (rows.length === 0) {
    return (
      <section className="border border-phx-line bg-white px-4 py-8 text-center">
        <p className="text-sm font-bold text-slate-600">No direct orders counted to sales in {areaLabel} yet.</p>
        <p className="mt-1 text-phx-sm text-slate-400">
          An order appears here once it is approved and Finance books it to a sales month.
        </p>
      </section>
    );
  }

  return (
    <section className="border border-phx-line bg-white">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-phx-line bg-slate-900 px-4 py-2.5">
        <h3 className="text-phx-xs font-black uppercase tracking-[0.14em] text-white">
          {areaLabel} — {rows.length} {rows.length === 1 ? "order line" : "order lines"}
        </h3>
        <span className="text-phx-xs font-bold uppercase tracking-wider text-slate-400">
          {units(totalUnits)} units · {money(totalValue)}
        </span>
      </header>

      {/* Desktop: the full table. table-fixed + colgroup so it always fits, never a sideways scroll. */}
      <div className="hidden md:block">
        <table className="w-full table-fixed text-left text-sm">
          <colgroup>
            <col style={{ width: "26%" }} />
            <col style={{ width: "22%" }} />
            <col style={{ width: "16%" }} />
            <col style={{ width: "16%" }} />
            <col style={{ width: "8%" }} />
            <col style={{ width: "12%" }} />
          </colgroup>
          <thead>
            <tr className="border-b border-phx-line text-phx-xs font-black uppercase tracking-wider text-slate-500">
              <th className="px-3 py-2">Pharmacy</th>
              <th className="px-3 py-2">Product</th>
              <th className="px-3 py-2">Order date</th>
              <th className="px-3 py-2">Counted in</th>
              <th className="px-3 py-2 text-right">Units</th>
              <th className="px-3 py-2 text-right">Value</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr
                key={`${row.requestId}-${row.productName}-${index}`}
                className="border-b border-[#f1f4f6] align-top hover:bg-orange-50/40"
              >
                <td className="px-3 py-2">
                  <p className="font-bold text-slate-900">{row.pharmacyName}</p>
                  <p className="text-phx-xs text-slate-500">{row.areaName}</p>
                </td>
                <td className="px-3 py-2 text-slate-700">{row.productName}</td>
                <td className="px-3 py-2 text-slate-700">{dayLabel(row.orderDate)}</td>
                <td className="px-3 py-2 font-bold text-slate-900">{monthLabel(row.salesMonth)}</td>
                <td className="px-3 py-2 text-right font-bold text-slate-900">{units(row.units)}</td>
                <td className="px-3 py-2 text-right font-bold text-slate-900">{money(row.salesValue)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-phx-line bg-slate-50 text-phx-sm font-black text-slate-900">
              <td className="px-3 py-2 uppercase tracking-wider" colSpan={4}>
                Total
              </td>
              <td className="px-3 py-2 text-right">{units(totalUnits)}</td>
              <td className="px-3 py-2 text-right">{money(totalValue)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      {/* Mobile: cards. The owner's rule is that mobile never gets a table. */}
      <div className="space-y-2 p-3 md:hidden">
        {rows.map((row, index) => (
          <article key={`${row.requestId}-${row.productName}-${index}`} className="block border border-phx-line p-3">
            <p className="text-sm font-black text-slate-900">{row.pharmacyName}</p>
            <p className="text-phx-xs text-slate-500">{row.areaName}</p>
            <p className="mt-2 text-sm font-bold text-slate-900">{row.productName}</p>
            <p className="mt-1 text-sm font-bold text-slate-900">
              {units(row.units)} units · {money(row.salesValue)}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-phx-xs text-slate-500">
              <span>ordered {dayLabel(row.orderDate)}</span>
              <span className="font-black text-slate-700">counted in {monthLabel(row.salesMonth)}</span>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
