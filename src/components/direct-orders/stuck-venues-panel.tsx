import type { DirectOrderStuckVenue } from "@/lib/direct-orders/stuck-venues";
import { humanizeCode } from "@/lib/format/code-label";
import { venueTypeLabel } from "@/lib/venues/venue-type";
import { adminPanelClassName, adminRecessedDepthClassName } from "@/components/admin/admin-design-tokens";

/**
 * "Waiting for a capture nobody has filed" — the panel under the validation desk's real work.
 *
 * Owner, 2026-09-29: "add a stuck-venues list to the validation desk." The desk lists CLAIMS, so a
 * venue nobody ever captured has no row there at all — not unflagged, structurally invisible, on the
 * one screen built to look at venue evidence. Three of them sat that way until a hand-written query
 * found them.
 *
 * A LIST, NOT A QUEUE, and deliberately buttonless. What is missing is a rep standing in front of
 * the venue with a phone, and nobody reading this desk can supply that — only the order's own
 * requester may capture, because the GPS check runs against THEIR area. A control here would invite
 * a photograph of a place the admin never stood.
 *
 * Money first, because the panel's whole job is to put the largest thing nobody is looking at at the
 * top. Names, never HR ids. Square edges, wrapping cells, no ellipsis, and a `table-fixed` grid with
 * its own `colgroup` so it fits a phone without a horizontal scroll — the house rules.
 */

const money = (value: number) =>
  `${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} EGP`;

const cairoDay = (iso: string | null) =>
  iso
    ? new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Cairo", day: "2-digit", month: "short", year: "numeric" }).format(
        new Date(iso),
      )
    : "—";

export function StuckVenuesPanel({ venues }: { venues: DirectOrderStuckVenue[] }) {
  // Nothing stuck is genuinely good news and worth saying, rather than rendering an empty frame that
  // reads like a screen that failed to load.
  if (venues.length === 0) {
    return (
      <section className={adminPanelClassName}>
        <header className={`border-b border-phx-line bg-slate-50 px-4 py-2.5 ${adminRecessedDepthClassName}`}>
          <h3 className="text-phx-xs font-black uppercase tracking-[0.14em] text-slate-700">
            Waiting for a capture
          </h3>
        </header>
        <p className="px-4 py-3 text-phx-sm text-slate-600">
          Every venue still awaiting validation has a claim in front of you. Nothing is sitting here
          uncaptured.
        </p>
      </section>
    );
  }

  const total = venues.reduce((sum, venue) => sum + venue.ordersValue, 0);

  return (
    <section className={adminPanelClassName}>
      <header className={`flex flex-wrap items-center justify-between gap-2 border-b border-phx-line bg-slate-50 px-4 py-2.5 ${adminRecessedDepthClassName}`}>
        <h3 className="text-phx-xs font-black uppercase tracking-[0.14em] text-slate-700">
          Waiting for a capture · {venues.length}
        </h3>
        <span className="text-phx-xs font-bold text-slate-600">{money(total)} of orders behind them</span>
      </header>

      <p className="border-b border-phx-line px-4 py-2.5 text-phx-sm text-slate-600">
        These venues are still awaiting validation and have no claim in front of you — nobody has
        stood in front of them with a phone yet, so there is nothing here to decide. Only the rep who
        raised the order can capture one, from that order. Listed so they stop being invisible.
      </p>

      {/* Desktop: one fixed grid, fitted by merging what belongs together rather than shrinking type. */}
      <table className="hidden w-full table-fixed md:table">
        <colgroup>
          <col className="w-[38%]" />
          <col className="w-[20%]" />
          <col className="w-[22%]" />
          <col className="w-[20%]" />
        </colgroup>
        <thead>
          <tr className="border-b border-phx-line text-left text-phx-2xs font-black uppercase tracking-wider text-slate-500">
            <th className="px-4 py-2">Venue</th>
            <th className="px-4 py-2">Raised by</th>
            <th className="px-4 py-2">Orders behind it</th>
            <th className="px-4 py-2">Added</th>
          </tr>
        </thead>
        <tbody>
          {venues.map((venue) => (
            <tr key={venue.id} className="border-b border-[#eef1f3] align-top">
              <td className="px-4 py-2.5">
                <p className="text-phx-sm font-bold text-slate-900" dir="auto">
                  {venue.pharmacyName}
                </p>
                <p className="text-phx-xs text-slate-500">
                  {venueTypeLabel(venue.venueType)}
                </p>
              </td>
              <td className="px-4 py-2.5 text-phx-sm text-slate-700" dir="auto">
                {venue.raisedByName ?? "—"}
              </td>
              <td className="px-4 py-2.5">
                <p className="text-phx-sm font-bold text-slate-900">
                  {venue.orders === 0 ? "None yet" : money(venue.ordersValue)}
                </p>
                {venue.orderStates.length > 0 ? (
                  <p className="text-phx-xs text-slate-500">
                    {venue.orders} · {venue.orderStates.map(humanizeCode).join(", ")}
                  </p>
                ) : null}
              </td>
              <td className="px-4 py-2.5 text-phx-sm text-slate-700">{cairoDay(venue.createdAtIso)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Phone: cards, per the admin shell's rule — desktop gets tables, mobile gets cards. */}
      <div className="divide-y divide-[#eef1f3] md:hidden">
        {venues.map((venue) => (
          <div key={venue.id} className="space-y-1 px-4 py-3">
            <p className="text-phx-sm font-bold text-slate-900" dir="auto">
              {venue.pharmacyName}
            </p>
            <p className="text-phx-xs text-slate-500">
              {venueTypeLabel(venue.venueType)}
            </p>
            <p className="text-phx-sm text-slate-700" dir="auto">
              Raised by {venue.raisedByName ?? "—"} · {cairoDay(venue.createdAtIso)}
            </p>
            <p className="text-phx-sm font-bold text-slate-900">
              {venue.orders === 0 ? "No orders yet" : money(venue.ordersValue)}
              {venue.orderStates.length > 0 ? (
                <span className="font-normal text-slate-500">
                  {" "}
                  · {venue.orders} · {venue.orderStates.map(humanizeCode).join(", ")}
                </span>
              ) : null}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
