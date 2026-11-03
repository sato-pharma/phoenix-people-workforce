import { stableCurrencyFormatter } from "@/lib/format/stable-currency";

/** One drive of a journey, as every screen shows it. */
export type JourneyRouteLeg = {
  distanceKm: number | null;
  from: string;
  fuelAmount: number;
  paid: boolean;
  reason: string;
  ticketAmount: number;
  to: string;
};

const EGP = stableCurrencyFormatter("en-EG", {
  currency: "EGP",
  maximumFractionDigits: 2,
  minimumFractionDigits: 0,
  style: "currency",
});

/** Why a drive reads the way it does, in the words a person uses. */
const LEG_DETAIL: Record<string, string> = {
  different_governorates: "paid one way",
  distance_unknown: "no road distance yet, someone will check it",
  governorate_unknown: "governorate unknown, someone will check it",
  same_governorate: "same governorate, not paid",
  ticket_leg: "by ticket",
  ticket_on_claim: "ticket on the claim",
  under_minimum_km: "40 km or less, not paid",
};

function kilometres(value: number | null): string | null {
  return value === null ? null : `${value.toLocaleString("en-US", { maximumFractionDigits: 1 })} km`;
}

function legAmount(leg: JourneyRouteLeg): string {
  if (leg.ticketAmount > 0) return EGP.format(leg.ticketAmount);
  if (leg.paid) return EGP.format(leg.fuelAmount);
  return "—";
}

/** The line under a drive's route: how far, and why it reads as it does. */
function legDetail(leg: JourneyRouteLeg): string {
  return [kilometres(leg.distanceKm), LEG_DETAIL[leg.reason] ?? ""].filter(Boolean).join(" · ");
}

/**
 * Home → Sohag → Assiut → Home, one row a drive, with the money beside it (owner, 2026-11-03). A table
 * on a desktop and a card a drive on a phone, so a long place name wraps and nothing scrolls sideways.
 */
export function JourneyRouteLine({ legs }: { legs: JourneyRouteLeg[] }) {
  return (
    <>
      <ul className="divide-y divide-slate-200 border-y border-slate-200 text-sm md:hidden">
        {legs.map((leg, index) => (
          <li className="flex items-start justify-between gap-3 py-2" key={`${index}-${leg.from}`}>
            <span className="min-w-0">
              <span className="block break-words font-bold text-slate-900">
                {leg.from} → {leg.to}
              </span>
              <span className="block break-words text-xs leading-5 text-slate-500">{legDetail(leg)}</span>
            </span>
            <span className="shrink-0 font-black text-slate-900">{legAmount(leg)}</span>
          </li>
        ))}
      </ul>
      <table className="hidden w-full table-fixed border-collapse text-sm md:table">
        <colgroup>
          <col />
          <col className="w-28" />
        </colgroup>
        <thead>
          <tr className="border-b border-slate-200 text-left text-phx-2xs font-black uppercase tracking-wider text-slate-500">
            <th className="py-1.5 pr-3 font-black" scope="col">
              Drive
            </th>
            <th className="py-1.5 text-right font-black" scope="col">
              Paid
            </th>
          </tr>
        </thead>
        <tbody>
          {legs.map((leg, index) => (
            <tr className="border-b border-slate-200 align-top" key={`${index}-${leg.from}`}>
              <td className="py-2 pr-3">
                <span className="block break-words font-bold text-slate-900">
                  {leg.from} → {leg.to}
                </span>
                <span className="block break-words text-xs leading-5 text-slate-500">{legDetail(leg)}</span>
              </td>
              <td className="py-2 text-right font-black text-slate-900">{legAmount(leg)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
