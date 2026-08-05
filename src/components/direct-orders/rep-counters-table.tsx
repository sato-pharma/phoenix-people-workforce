import type { DirectOrderRepCountersResult } from "@/lib/direct-orders/rep-counters";

type Props = { data: DirectOrderRepCountersResult };

const money = (value: number) => `${Math.round(value).toLocaleString("en-US")} EGP`;

const cairoStamp = (iso: string | null) =>
  iso
    ? new Intl.DateTimeFormat("en-GB", {
        timeZone: "Africa/Cairo",
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(iso))
    : "—";

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
      <section className="border border-[#e4e9ec] bg-white px-4 py-8 text-center">
        <p className="text-sm font-bold text-slate-600">{emptyReason}</p>
        <p className="mt-1 text-[12px] text-slate-400">
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
      refusedAsFalse: acc.refusedAsFalse + r.refusedAsFalse,
      refusedAsFalseValue: acc.refusedAsFalseValue + r.refusedAsFalseValue,
      falsePharmacies: acc.falsePharmacies + r.falsePharmacies,
    }),
    {
      held: 0,
      heldValue: 0,
      expired: 0,
      matchedExisting: 0,
      refusedAsFalse: 0,
      refusedAsFalseValue: 0,
      falsePharmacies: 0,
    },
  );

  return (
    <section className="border border-[#e4e9ec] bg-white">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[#e4e9ec] bg-slate-900 px-4 py-2.5">
        <h3 className="text-[11px] font-black uppercase tracking-[0.14em] text-white">
          Per-rep counters — {rows.length} {rows.length === 1 ? "person" : "people"}
        </h3>
        <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
          {companyWide ? "Company-wide" : "Your team"} · {money(totals.heldValue)} held
          {totals.refusedAsFalseValue > 0 ? ` · ${money(totals.refusedAsFalseValue)} refused as false` : ""}
        </span>
      </header>

      {/* Desktop: the full table. */}
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-[#e4e9ec] text-[11px] font-black uppercase tracking-wider text-slate-500">
              <th className="px-3 py-2">Rep</th>
              <th className="px-3 py-2">Area</th>
              <th className="px-3 py-2">Held</th>
              <th className="px-3 py-2">Held value</th>
              <th className="px-3 py-2">Expired</th>
              {/* The proven outcome, next to the pending ones. Before this existed, a module that
                  had been cleaned up read as a module where nothing had ever happened. */}
              <th className="px-3 py-2">False pharmacies</th>
              <th className="px-3 py-2">Refused as false</th>
              <th className="px-3 py-2">Evidence sent</th>
              <th className="px-3 py-2">Existed after all</th>
              <th className="px-3 py-2">Refused a match</th>
              <th className="px-3 py-2">Last held</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.hrId} className="border-b border-[#f1f4f6] align-top hover:bg-orange-50/40">
                <td className="px-3 py-2">
                  {/* Owner's rule: human-readable names, never raw codes. */}
                  <p className="font-bold text-slate-900">{row.name}</p>
                  <p className="text-[11px] text-slate-500">{row.role}</p>
                </td>
                <td className="px-3 py-2 text-slate-700">{row.areaName || "—"}</td>
                <td className="px-3 py-2">{count(row.held)}</td>
                <td className="px-3 py-2 font-bold text-slate-900">{money(row.heldValue)}</td>
                <td className="px-3 py-2">{count(row.expired)}</td>
                <td className="px-3 py-2">{count(row.falsePharmacies, "signal")}</td>
                <td className="px-3 py-2">
                  {count(row.refusedAsFalse, "signal")}
                  {row.refusedAsFalseValue > 0 ? (
                    <span className="ml-1 text-[11px] text-slate-500">{money(row.refusedAsFalseValue)}</span>
                  ) : null}
                </td>
                <td className="px-3 py-2">{count(row.validationsSubmitted)}</td>
                <td className="px-3 py-2">{count(row.matchedExisting, "signal")}</td>
                <td className="px-3 py-2">{count(row.suggestionsRefused, "signal")}</td>
                <td className="px-3 py-2 text-[12px] text-slate-500">{cairoStamp(row.lastHeldAt)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-[#e4e9ec] bg-slate-50 text-[12px] font-black text-slate-900">
              <td className="px-3 py-2 uppercase tracking-wider">Total</td>
              <td className="px-3 py-2" />
              <td className="px-3 py-2">{totals.held}</td>
              <td className="px-3 py-2">{money(totals.heldValue)}</td>
              <td className="px-3 py-2">{totals.expired}</td>
              <td className="px-3 py-2">{totals.falsePharmacies}</td>
              <td className="px-3 py-2">
                {totals.refusedAsFalse}
                {totals.refusedAsFalseValue > 0 ? (
                  <span className="ml-1 font-bold">{money(totals.refusedAsFalseValue)}</span>
                ) : null}
              </td>
              <td className="px-3 py-2" />
              <td className="px-3 py-2">{totals.matchedExisting}</td>
              <td className="px-3 py-2" />
              <td className="px-3 py-2" />
            </tr>
          </tfoot>
        </table>
      </div>

      {/* Mobile: cards. The owner's rule is that mobile never gets a table. */}
      <div className="space-y-2 p-3 md:hidden">
        {rows.map((row) => (
          <article key={row.hrId} className="block border border-[#e4e9ec] p-3">
            <p className="text-sm font-black text-slate-900">{row.name}</p>
            <p className="text-[11px] text-slate-500">
              {row.role}
              {row.areaName ? ` · ${row.areaName}` : ""}
            </p>
            <p className="mt-2 text-sm font-bold text-slate-900">
              {row.held} held · {money(row.heldValue)}
            </p>
            {/* Rose, not amber: refused-as-false is a proven outcome, not a signal to look into.
                Given its own line rather than a chip, because on a cleaned-up module it is the only
                thing on the card with a number on it. */}
            {row.refusedAsFalse > 0 ? (
              <p className="mt-1 bg-rose-100 px-1.5 py-0.5 text-[12px] font-black text-rose-900">
                {row.refusedAsFalse} refused as false · {money(row.refusedAsFalseValue)}
                {row.falsePharmacies > 0
                  ? ` · ${row.falsePharmacies} false ${row.falsePharmacies === 1 ? "pharmacy" : "pharmacies"}`
                  : ""}
              </p>
            ) : null}
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
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
        ))}
      </div>
    </section>
  );
}
