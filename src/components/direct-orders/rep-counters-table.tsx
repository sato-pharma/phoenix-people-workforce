"use client";

import type { DirectOrderRepCountersResult } from "@/lib/direct-orders/rep-counters";
import { PortalDesktopTable, PortalResponsiveDataList } from "@/components/employee-portal/portal-primitives";
import { adminPanelClassName, adminPanelHeaderClassName, adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";
import { stableEnGbFormatter } from "@/lib/format/cairo-datetime";

type Props = { data: DirectOrderRepCountersResult };

const money = (value: number) => `${Math.round(value).toLocaleString("en-US")} EGP`;

// Built once, through the helper whose bytes the server and the browser agree on (React #418).
const cairoStampFormatter = stableEnGbFormatter({
  timeZone: "Africa/Cairo",
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

const cairoStamp = (iso: string | null) => (iso ? cairoStampFormatter.format(new Date(iso)) : "—");

/**
 * A count that means something gets weight; a zero stays quiet.
 *
 * Painting every cell would make the table decorative and the eye would stop reading it. Only
 * `matchedExisting` and `suggestionsRefused` turn amber, because those two are the deterrence
 * signals — the rest are context.
 */
function count(value: number, emphasis: "plain" | "signal" = "plain") {
  if (value === 0) return <span className="text-slate-400">0</span>;
  if (emphasis === "signal") {
    return <span className="bg-amber-100 px-1.5 py-0.5 font-black text-amber-800">{value}</span>;
  }
  return <span className="font-bold text-slate-900">{value}</span>;
}

/**
 * Per-rep Direct Orders counters (spec E1) — the deterrence half of the design.
 *
 * Everything else in this module makes a phantom pharmacy hard to CREATE. This makes the pattern
 * visible: who keeps parking orders on pharmacies the master database has never heard of, who lets
 * them rot until the 14-day clock kills them, and who is shown the customer they meant and files
 * "it is new" anyway.
 *
 * Sorted by money parked, worst first — the service does that, deliberately, because an
 * alphabetical counter table buries exactly what it exists to surface.
 */
export function RepCountersTable({ data }: Props) {
  const { rows, companyWide, emptyReason } = data;

  if (emptyReason) {
    // Says WHY in words. An empty grid that renders as a row of zeros is the failure this module
    // keeps hitting: "zero validation requests" read as reps ignoring the process, when in fact
    // they had never been shown a button.
    return (
      <section className={`border border-phx-line bg-white px-4 py-8 text-center ${adminSoftDepthClassName}`}>
        <p className="text-sm font-bold text-slate-600">{emptyReason}</p>
        <p className="mt-1 text-phx-sm text-slate-400">
          Counters appear here as soon as a direct order is held or expires.
        </p>
      </section>
    );
  }

  const totals = rows.reduce(
    (acc, r) => ({
      held: acc.held + r.held,
      heldValue: acc.heldValue + r.heldValue,
      expired: acc.expired + r.expired,
      matchedExisting: acc.matchedExisting + r.matchedExisting,
      ordersRejected: acc.ordersRejected + r.ordersRejected,
      ordersRejectedValue: acc.ordersRejectedValue + r.ordersRejectedValue,
      rejectedPharmacies: acc.rejectedPharmacies + r.rejectedPharmacies,
    }),
    {
      held: 0,
      heldValue: 0,
      expired: 0,
      matchedExisting: 0,
      ordersRejected: 0,
      ordersRejectedValue: 0,
      rejectedPharmacies: 0,
    },
  );

  return (
    <section className={adminPanelClassName}>
      <header className={`${adminPanelHeaderClassName} flex flex-wrap items-center justify-between gap-3 px-4 py-2.5`}>
        <h3 className="text-phx-xs font-black uppercase tracking-[0.14em] text-white">
          Per-rep counters — {rows.length} {rows.length === 1 ? "person" : "people"}
        </h3>
        <span className="text-phx-xs font-bold uppercase tracking-wider text-slate-400">
          {companyWide ? "Company-wide" : "Your team"} · {money(totals.heldValue)} held
          {totals.ordersRejectedValue > 0 ? ` · ${money(totals.ordersRejectedValue)} on rejected pharmacies` : ""}
        </span>
      </header>

      <PortalResponsiveDataList
        empty={null}
        getKey={(row) => row.hrId}
        items={rows}
        renderCard={(row) => (
          <article className="block p-3">
            <p className="break-words text-sm font-black text-slate-900">{row.name}</p>
            <p className="break-words text-phx-xs text-slate-500">
              {row.role}
              {row.areaName ? ` · ${row.areaName}` : ""}
            </p>
            <p className="mt-2 text-sm font-bold text-slate-900">
              {row.held} held · {money(row.heldValue)}
            </p>
            {/* Rose, not amber: a rejection is a settled outcome, not a signal to look into.
                Given its own line rather than a chip, because on a cleaned-up module it is the only
                thing on the card with a number on it. */}
            {row.ordersRejected > 0 ? (
              <p className="mt-1 bg-rose-100 px-1.5 py-0.5 text-phx-sm font-black text-rose-900">
                {row.ordersRejected} rejected · {money(row.ordersRejectedValue)}
                {row.rejectedPharmacies > 0
                  ? ` · ${row.rejectedPharmacies} rejected ${row.rejectedPharmacies === 1 ? "pharmacy" : "pharmacies"}`
                  : ""}
              </p>
            ) : null}
            <div className="mt-2 flex flex-wrap items-center gap-2 text-phx-xs text-slate-500">
              {row.expired > 0 ? <span>{row.expired} expired</span> : null}
              {row.validationsSubmitted > 0 ? <span>{row.validationsSubmitted} evidence sent</span> : null}
              {row.matchedExisting > 0 ? (
                <span className="bg-amber-100 px-1.5 py-0.5 font-black text-amber-800">
                  {row.matchedExisting} existed after all
                </span>
              ) : null}
              {row.suggestionsRefused > 0 ? (
                <span className="bg-amber-100 px-1.5 py-0.5 font-black text-amber-800">
                  {row.suggestionsRefused} refused a match
                </span>
              ) : null}
              <span>last held {cairoStamp(row.lastHeldAt)}</span>
            </div>
          </article>
        )}
        renderTable={() => (
          <PortalDesktopTable
            cols={
              <colgroup>
                <col className="w-[20%]" />
                <col className="w-[13%]" />
                <col className="w-[8%]" />
                <col className="w-[10%]" />
                <col className="w-[15%]" />
                <col className="w-[8%]" />
                <col className="w-[9%]" />
                <col className="w-[9%]" />
                <col className="w-[8%]" />
              </colgroup>
            }
          >
            <thead>
              <tr className="border-b border-phx-line text-phx-xs font-black uppercase tracking-wider text-slate-500">
                <th className="px-3 py-2">Rep</th>
                <th className="px-3 py-2">Held</th>
                <th className="px-3 py-2">Expired</th>
                {/* The proven outcome, next to the pending ones. Before this existed, a module that
                    had been cleaned up read as a module where nothing had ever happened. */}
                <th className="px-3 py-2">Rejected venues</th>
                <th className="px-3 py-2">Orders rejected</th>
                <th className="px-3 py-2">Evidence sent</th>
                <th className="px-3 py-2">Existed after all</th>
                <th className="px-3 py-2">Refused a match</th>
                <th className="px-3 py-2">Last held</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.hrId} className="border-b border-[#f1f4f6] align-top hover:bg-orange-50/40">
                  <td className="break-words px-3 py-2">
                    {/* Owner's rule: human-readable names, never raw codes. The area rides in the
                        same cell as the role, so the table fits without a column of its own. */}
                    <p className="font-bold text-slate-900">{row.name}</p>
                    <p className="text-phx-xs text-slate-500">
                      {row.role}
                      {row.areaName ? ` · ${row.areaName}` : ""}
                    </p>
                  </td>
                  <td className="break-words px-3 py-2">
                    <p>{count(row.held)}</p>
                    <p className="font-bold text-slate-900">{money(row.heldValue)}</p>
                  </td>
                  <td className="px-3 py-2">{count(row.expired)}</td>
                  <td className="px-3 py-2">{count(row.rejectedPharmacies, "signal")}</td>
                  <td className="break-words px-3 py-2">
                    {count(row.ordersRejected, "signal")}
                    {/* An explicit separator, not just a margin: between an amber count badge and
                        grey money a bare gap reads as one number — "2266,112 EGP". */}
                    {row.ordersRejectedValue > 0 ? (
                      <span className="ml-2 text-phx-xs text-slate-500">· {money(row.ordersRejectedValue)}</span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2">{count(row.validationsSubmitted)}</td>
                  <td className="px-3 py-2">{count(row.matchedExisting, "signal")}</td>
                  <td className="px-3 py-2">{count(row.suggestionsRefused, "signal")}</td>
                  <td className="break-words px-3 py-2 text-phx-sm text-slate-500">{cairoStamp(row.lastHeldAt)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-phx-line bg-slate-50 text-phx-sm font-black text-slate-900">
                <td className="px-3 py-2 uppercase tracking-wider">Total</td>
                <td className="break-words px-3 py-2">
                  <p>{totals.held}</p>
                  <p>{money(totals.heldValue)}</p>
                </td>
                <td className="px-3 py-2">{totals.expired}</td>
                <td className="px-3 py-2">{totals.rejectedPharmacies}</td>
                <td className="break-words px-3 py-2">
                  {totals.ordersRejected}
                  {totals.ordersRejectedValue > 0 ? (
                    <span className="ml-2 font-bold">· {money(totals.ordersRejectedValue)}</span>
                  ) : null}
                </td>
                <td className="px-3 py-2" />
                <td className="px-3 py-2">{totals.matchedExisting}</td>
                <td className="px-3 py-2" />
                <td className="px-3 py-2" />
              </tr>
            </tfoot>
          </PortalDesktopTable>
        )}
      />
    </section>
  );
}
