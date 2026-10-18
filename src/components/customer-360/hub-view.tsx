import Link from "next/link";
import { MapPin } from "lucide-react";
import type { ReactNode } from "react";

import { adminPanelDepthClassName } from "@/components/admin/admin-design-tokens";
import { VerdictBadge } from "@/components/customer-360/hub-list";
import { hubLineLabel, LINKED_PHARMACY_SOURCE_LABELS, type HubVisitRow } from "@/lib/customer-360/hub";
import type { HubView } from "@/lib/customer-360/report";
import { encodeCustomerSubjectId } from "@/lib/customer-360/subject";
import { egp, monthLabel } from "@/lib/customer-360/verdict";
import { actualResultStatusLabel, marketingRequestStatusLabel } from "@/lib/marketing-requests/roi-labels";
import { cairoDate } from "@/lib/format/cairo-datetime";
import { cn } from "@/lib/utils";

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className={cn("border border-slate-200 bg-white", adminPanelDepthClassName)}>
      <header className="border-b border-slate-200 bg-slate-50 px-4 py-2.5">
        <h2 className="text-phx-xs font-black uppercase tracking-[0.15em] text-slate-600">{title}</h2>
        {note ? <p className="mt-0.5 text-xs text-slate-500">{note}</p> : null}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

/** The pharmacy's own Customer 360 page, when it is a row in the marketing or direct-order register. */
function pharmacyPageHref(pharmacy: HubView["pharmacies"][number]): string | null {
  if (pharmacy.marketingPharmacyId) return `/customer-360/${encodeCustomerSubjectId({ recordId: pharmacy.marketingPharmacyId, register: "marketing" })}`;
  if (pharmacy.directOrderPharmacyId) return `/customer-360/${encodeCustomerSubjectId({ recordId: pharmacy.directOrderPharmacyId, register: "direct-order" })}`;
  return null;
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="text-sm text-slate-500">{children}</p>;
}

function mapUrl(lat: number | null | undefined, lon: number | null | undefined): string | null {
  if (lat == null || lon == null || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return `https://www.google.com/maps?q=${lat},${lon}`;
}

/** One visit row per month × line × rep, newest month first. */
function visitMonths(visits: readonly HubVisitRow[]): string[] {
  return [...new Set(visits.map((visit) => visit.month))].sort().reverse();
}

/**
 * One validated doctor or account, linked to everything the system knows about it: the lines that
 * visit, the pharmacies tied to it, the marketing money and its return, the direct orders, and the
 * verdict with its reasons.
 */
export function HubDetail({
  hub,
  lastMonths,
  closedMonths,
  distributorNames,
}: {
  hub: HubView;
  lastMonths: string[];
  closedMonths: string[];
  distributorNames: Record<string, string>;
}) {
  const place = hub.place;
  const placeUrl = mapUrl(place?.lat, place?.lon);
  const months = visitMonths(hub.visits);
  const recentMonths = lastMonths;

  return (
    <div className="space-y-4">
      <header className={cn("border border-slate-200 bg-white p-5", adminPanelDepthClassName)}>
        <p className="text-phx-2xs font-black uppercase tracking-[0.18em] text-slate-400">
          {hub.kind === "doctor" ? "Validated doctor" : "Validated account"}
        </p>
        <h1 dir="auto" className="mt-1 break-words text-2xl font-black tracking-tight text-slate-950">
          {hub.name}
        </h1>
        <p className="mt-1 break-words text-sm font-semibold text-slate-500">
          {[hub.speciality, hub.grade ? `Grade ${hub.grade}` : null].filter(Boolean).join(" · ") || "No speciality recorded"}
        </p>
        <p className="mt-2 flex flex-wrap items-center gap-1.5 break-words text-sm text-slate-600">
          <MapPin aria-hidden className="h-4 w-4 shrink-0 text-slate-400" />
          <span dir="auto">{place?.address || "No address on the validated place"}</span>
          {placeUrl ? (
            <a href={placeUrl} target="_blank" rel="noreferrer" className="font-bold text-orange-700 hover:underline">
              Open the validated location
            </a>
          ) : null}
        </p>
        <p className="mt-1 break-words text-xs font-semibold text-slate-500">
          {[place?.brickName ? `Brick ${place.brickName}` : null, place?.areaName, place?.regionName].filter(Boolean).join(" · ") || "No territory recorded"}
        </p>
        <p className="mt-1 break-words text-xs font-semibold text-slate-500">
          {hub.validatedOnLines.length > 0
            ? `Validated on the ${hub.validatedOnLines.map(hubLineLabel).join(", ")} ${hub.validatedOnLines.length === 1 ? "list" : "lists"}`
            : "Validated in the marketing customer register"}
          {hub.dropped ? " · Dropped from the list" : ""}
        </p>
      </header>

      <Section
        title="Verdict"
        note={`Advisory only — it never blocks a marketing request. Sales are the Monthly Closing's, closed months only${closedMonths.length > 0 ? ` (${monthLabel(closedMonths[0]!)} to ${monthLabel(closedMonths[closedMonths.length - 1]!)})` : ""}.`}
      >
        <VerdictBadge verdict={hub.verdict.verdict} early={hub.verdict.early} />
        {hub.verdict.early ? (
          <p className="mt-2 text-xs font-bold text-amber-700">Early: only one month has closed since the request, so this can still change.</p>
        ) : null}
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-slate-700">
          {hub.verdict.reasons.map((reason, index) => (
            <li key={index} className="break-words">
              {reason}
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Lines visiting" note="Visits by month, line and rep. Pharmacy calls are counted apart from doctor visits.">
        {months.length === 0 ? (
          <Empty>No visit on record since January.</Empty>
        ) : (
          // Cards in a narrow column, the table once the section itself is wide enough: it switches on its
          // own width, so it fits a phone and a split screen alike.
          <div className="@container">
            <ul className="space-y-2 @min-[560px]:hidden">
              {months.flatMap((month) =>
                hub.visits
                  .filter((visit) => visit.month === month)
                  .map((visit, index) => (
                    <li key={`${month}-${index}`} className="border border-slate-200 p-2.5 text-xs">
                      <p className="break-words font-semibold text-slate-800">
                        {monthLabel(month)} · {visit.line ? hubLineLabel(visit.line) : "Line not recorded"}
                      </p>
                      <p dir="auto" className="break-words text-slate-700">
                        {visit.repName} <span className="text-slate-400">· {visit.source === "phoenix" ? "Phoenix CRM" : "iReports360"}</span>
                      </p>
                      <p className="mt-1 break-words tabular-nums text-slate-600">
                        AM {visit.am} · PM {visit.pm} · Pharmacies {visit.pharmacies} · Campaign {visit.campaign}
                      </p>
                    </li>
                  )),
              )}
            </ul>
            <table className="hidden w-full table-fixed text-left text-xs @min-[560px]:table">
              <colgroup>
                <col className="w-[22%]" />
                <col className="w-[30%]" />
                <col className="w-[12%]" />
                <col className="w-[12%]" />
                <col className="w-[24%]" />
              </colgroup>
              <thead className="border-b border-slate-200 text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500">
                <tr>
                  <th className="break-words py-1.5 pr-2">Month · line</th>
                  <th className="break-words py-1.5 pr-2">Rep</th>
                  <th className="break-words py-1.5 pr-2 text-right">AM</th>
                  <th className="break-words py-1.5 pr-2 text-right">PM</th>
                  <th className="break-words py-1.5 text-right">Pharmacies · campaign</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {months.flatMap((month) =>
                  hub.visits
                    .filter((visit) => visit.month === month)
                    .map((visit, index) => (
                      <tr key={`${month}-${index}`} className="align-top">
                        <td className="break-words py-1.5 pr-2 font-semibold text-slate-800">
                          {monthLabel(month)}
                          <span className="block font-normal text-slate-500">{visit.line ? hubLineLabel(visit.line) : "Line not recorded"}</span>
                        </td>
                        <td dir="auto" className="break-words py-1.5 pr-2 text-slate-700">
                          {visit.repName}
                          <span className="block text-slate-400">{visit.source === "phoenix" ? "Phoenix CRM" : "iReports360"}</span>
                        </td>
                        <td className="py-1.5 pr-2 text-right tabular-nums">{visit.am}</td>
                        <td className="py-1.5 pr-2 text-right tabular-nums">{visit.pm}</td>
                        <td className="py-1.5 text-right tabular-nums">
                          {visit.pharmacies} · {visit.campaign}
                        </td>
                      </tr>
                    )),
                )}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section
        title="Linked pharmacies"
        note={`Each pharmacy's Monthly Closing value. "Last 3 months" is ${recentMonths.map(monthLabel).join(", ") || "not yet available"}.`}
      >
        {hub.pharmacies.length === 0 ? (
          <Empty>No pharmacy is linked yet.</Empty>
        ) : (
          <ul className="divide-y divide-slate-100">
            {hub.pharmacies.map((pharmacy) => {
              const sales = hub.pharmacySales[pharmacy.key];
              const recent = recentMonths.reduce((sum, month) => sum + (sales?.byMonth[month] ?? 0), 0);
              const pageHref = pharmacyPageHref(pharmacy);
              return (
                <li key={pharmacy.key} className="grid grid-cols-1 gap-2 py-3 text-xs text-slate-600 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                  <div className="min-w-0 space-y-0.5">
                    {pageHref ? (
                      <Link dir="auto" href={pageHref} className="block break-words text-sm font-bold text-slate-900 hover:text-orange-700 hover:underline">
                        {pharmacy.name}
                      </Link>
                    ) : (
                      <p dir="auto" className="break-words text-sm font-bold text-slate-900">
                        {pharmacy.name}
                      </p>
                    )}
                    <p className="break-words font-semibold text-slate-500">
                      {pharmacy.sources.map((source) => LINKED_PHARMACY_SOURCE_LABELS[source]).join(" · ")}
                      {pharmacy.matchStatus === "auto" ? " · tied by the rule" : pharmacy.matchStatus === "confirmed" ? " · confirmed by the administrator" : ""}
                    </p>
                    {pharmacy.typedAs.length > 0 ? (
                      <p className="break-words">
                        Typed as <span dir="auto">{pharmacy.typedAs.map((typed) => `“${typed}”`).join(", ")}</span>
                        {pharmacy.namedByLines.length > 0 ? ` by ${pharmacy.namedByLines.map(hubLineLabel).join(", ")}` : ""}
                      </p>
                    ) : null}
                    <p dir="auto" className="break-words">
                      {pharmacy.address || "No address recorded"}
                    </p>
                    <p className="break-words">{[pharmacy.brickName ? `Brick ${pharmacy.brickName}` : null, pharmacy.areaName].filter(Boolean).join(" · ") || "No brick recorded"}</p>
                    <p className="break-words">
                      {pharmacy.pairs.length === 0
                        ? "No distributor code — its sales cannot be found yet"
                        : pharmacy.pairs.map((pair) => `${distributorNames[pair.distributorCode] ?? "Unnamed distributor"} · customer ${pair.customerCode}`).join(" — ")}
                    </p>
                  </div>
                  <div className="space-y-0.5 sm:text-right">
                    <p className="font-bold text-slate-900">Last 3 months: {egp(recent)}</p>
                    <p>Since January: {egp(sales?.total ?? 0)}</p>
                    <p className="break-words text-slate-500">
                      {closedMonths
                        .filter((month) => (sales?.byMonth[month] ?? 0) > 0)
                        .map((month) => `${monthLabel(month).slice(0, 3)} ${egp(sales?.byMonth[month] ?? 0)}`)
                        .join(" · ") || "No sales in a closed month"}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <Section title="Marketing requests and their return" note="The Marketing ROI engine's own figures. Ten times the cost is the target.">
        {hub.requests.length === 0 ? (
          <Empty>No marketing request names this customer.</Empty>
        ) : (
          <ul className="divide-y divide-slate-100">
            {hub.requests.map((request) => (
              <li key={request.id} className="space-y-0.5 py-3 text-xs text-slate-600">
                <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <Link href={`/marketing-requests/${request.id}`} className="break-words text-sm font-bold text-slate-900 hover:text-orange-700 hover:underline">
                    {request.typeName ?? "Marketing request"}
                  </Link>
                  <span className="font-semibold text-slate-500">{marketingRequestStatusLabel(request.status)}</span>
                </p>
                <p className="break-words">
                  For <span dir="auto">{request.marketingCustomerName}</span>
                  {request.payDate ? ` · paid ${cairoDate(request.payDate)}` : " · not paid yet"}
                  {request.windowLabel ? ` · return window ${request.windowLabel}` : ""}
                </p>
                {hub.moneyVisible ? (
                  <p className="break-words font-semibold text-slate-800">
                    Cost {egp(request.cost)} · target {egp(request.requiredRoi)} · returned {egp(request.actualRoi)} · {actualResultStatusLabel(request.roiResult)}
                  </p>
                ) : (
                  <p className="break-words font-semibold text-slate-800">{actualResultStatusLabel(request.roiResult)}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Direct orders" note="Approved CNS, Pedia and Anti Infective orders on the trusted direct-order pharmacies tied to this customer, by Finance's month, in closed months only.">
        {hub.directOrders.venues === 0 ? (
          <Empty>No trusted direct-order pharmacy is tied to this customer.</Empty>
        ) : (
          <div className="space-y-1 text-sm text-slate-700">
            <p className="font-bold text-slate-900">
              {hub.directOrders.orders} {hub.directOrders.orders === 1 ? "order" : "orders"} · {egp(hub.directOrders.value)} · {hub.directOrders.venues}{" "}
              {hub.directOrders.venues === 1 ? "pharmacy" : "pharmacies"}
            </p>
            <p className="break-words text-xs text-slate-500">
              {Object.entries(hub.directOrders.byMonth)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([month, value]) => `${monthLabel(month)} ${egp(value)}`)
                .join(" · ") || "No approved order in a closed month yet"}
            </p>
          </div>
        )}
      </Section>

      {hub.notLinked.length > 0 ? (
        <Section title="Not linked" note="What could not be joined to this customer, and why.">
          <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700">
            {hub.notLinked.map((note, index) => (
              <li key={index} className="break-words">
                {note.reason}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </div>
  );
}
