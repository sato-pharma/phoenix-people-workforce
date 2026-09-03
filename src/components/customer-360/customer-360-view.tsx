import Link from "next/link";
import { Ban, Building2, Eye, Info, Landmark, MapPin, Receipt, ShoppingCart, Sparkles, User } from "lucide-react";

import { validationStatusLabel, venueTypeLabel } from "@/lib/customer-360/labels";
import type { Customer360Profile } from "@/lib/customer-360/service";
import { customerRegisterLabel } from "@/lib/customer-360/subject";

const money = new Intl.NumberFormat("en-EG", { maximumFractionDigits: 0 });
const whole = new Intl.NumberFormat("en-EG", { maximumFractionDigits: 0 });

function Section({
  children,
  icon,
  subtitle,
  title,
}: {
  children: React.ReactNode;
  icon: React.ReactNode;
  subtitle?: string;
  title: string;
}) {
  return (
    <section className="rounded-[18px] border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
      <div className="mb-3 flex items-start gap-2">
        <span aria-hidden className="mt-0.5 text-slate-400">
          {icon}
        </span>
        <div className="min-w-0">
          <h2 className="text-[14px] font-black text-slate-900">{title}</h2>
          {subtitle ? <p className="mt-0.5 break-words text-[12px] font-medium text-slate-500">{subtitle}</p> : null}
        </div>
      </div>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-[14px] border border-dashed border-slate-300 bg-slate-50 p-4 text-[12px] font-semibold text-slate-500">
      {children}
    </p>
  );
}

export function Customer360View({ profile }: { profile: Customer360Profile }) {
  const { sales } = profile;

  return (
    <div className="space-y-4">
      <Section
        icon={<Building2 className="h-4 w-4" />}
        title="Identity"
        subtitle={`On record in the ${customerRegisterLabel(profile.register).toLowerCase()} register`}
      >
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
          {[
            { label: "Area", value: profile.areaName },
            { label: "Region", value: profile.regionName },
            { label: "Line", value: profile.lineName },
            { label: "Venue type", value: venueTypeLabel(profile.venueType) },
            { label: "Owner", value: profile.ownerName },
            { label: "Manager", value: profile.managerName },
            { label: "Validation", value: validationStatusLabel(profile.validationStatus) },
            { label: "Address", value: profile.address },
          ].map((entry) => (
            <div key={entry.label} className="min-w-0">
              <dt className="text-[11px] font-black uppercase tracking-wide text-slate-400">{entry.label}</dt>
              <dd dir="auto" className="break-words text-[13px] font-semibold text-slate-800">{entry.value || "—"}</dd>
            </div>
          ))}
        </dl>
      </Section>

      <Section
        icon={<Landmark className="h-4 w-4" />}
        title="Sales"
        subtitle={
          sales.periods.length > 0
            ? `${sales.periods.length} ${sales.periods.length === 1 ? "month" : "months"} on record · ${sales.periods[0]} to ${sales.periods[sales.periods.length - 1]}`
            : undefined
        }
      >
        {sales.trackedLines.length === 0 && sales.confidentialLines.length === 0 ? (
          <Empty>
            No sales are recorded against this customer&rsquo;s distributor codes.
            {sales.confidentialWithheld ? " Some of its sales are on a line your role cannot see." : ""}
          </Empty>
        ) : (
          <div className="space-y-3">
            <div className="rounded-[14px] bg-slate-900 p-4 text-white">
              <p className="text-[11px] font-black uppercase tracking-wide text-white/60">Tracked lines</p>
              <p className="mt-0.5 text-2xl font-black tabular-nums">{money.format(sales.trackedValue)}</p>
              <p className="text-[12px] font-semibold text-white/70">
                {whole.format(sales.trackedUnits)} units · CNS, Anti Infective and Pedia
              </p>
            </div>

            <table className="w-full table-fixed border-collapse">
              <colgroup>
                <col className="w-[46%]" />
                <col className="w-[27%]" />
                <col className="w-[27%]" />
              </colgroup>
              <thead>
                <tr className="border-b border-slate-200 text-left">
                  <th className="py-1.5 text-[11px] font-black uppercase tracking-wide text-slate-400">Line</th>
                  <th className="py-1.5 text-right text-[11px] font-black uppercase tracking-wide text-slate-400">Units</th>
                  <th className="py-1.5 text-right text-[11px] font-black uppercase tracking-wide text-slate-400">Value</th>
                </tr>
              </thead>
              <tbody>
                {sales.trackedLines.map((line) => (
                  <tr key={line.line} className="border-b border-slate-100 last:border-0">
                    <td className="break-words py-1.5 text-[13px] font-semibold text-slate-800">{line.line}</td>
                    <td className="py-1.5 text-right text-[13px] font-semibold tabular-nums text-slate-600">
                      {whole.format(line.units)}
                    </td>
                    <td className="py-1.5 text-right text-[13px] font-bold tabular-nums text-slate-900">
                      {money.format(line.value)}
                    </td>
                  </tr>
                ))}
                {sales.confidentialLines.map((line) => (
                  <tr key={line.line} className="border-b border-slate-100 bg-amber-50/60 last:border-0">
                    <td className="break-words py-1.5 text-[13px] font-semibold text-amber-800">
                      {line.line}
                      <span className="ml-1.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-black uppercase tracking-wide text-amber-800">
                        Confidential
                      </span>
                    </td>
                    <td className="py-1.5 text-right text-[13px] font-semibold tabular-nums text-amber-800">
                      {whole.format(line.units)}
                    </td>
                    <td className="py-1.5 text-right text-[13px] font-bold tabular-nums text-amber-900">
                      {money.format(line.value)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {sales.confidentialLines.length > 0 ? (
              <p className="flex items-start gap-1.5 text-[11px] font-semibold text-amber-700">
                <Eye aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  Head Office is confidential and is deliberately kept out of the tracked total above. It is shown to
                  you because your role may see it.
                </span>
              </p>
            ) : null}
            {sales.confidentialWithheld ? (
              <p className="flex items-start gap-1.5 text-[11px] font-semibold text-slate-500">
                <Ban aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>This customer also has sales on a confidential line, which your role cannot see.</span>
              </p>
            ) : null}
          </div>
        )}
      </Section>

      <Section
        icon={<MapPin className="h-4 w-4" />}
        title="Distributor codes"
        subtitle="How this pharmacy is identified in each distributor's file, and the territory that resolves to"
      >
        {profile.codes.length === 0 ? (
          <Empty>
            No distributor code is recorded, so this customer cannot be matched to any sales. Its requests and orders
            still appear below.
          </Empty>
        ) : (
          <table className="w-full table-fixed border-collapse">
            <colgroup>
              <col className="w-[52%]" />
              <col className="w-[24%]" />
              <col className="w-[24%]" />
            </colgroup>
            <thead>
              <tr className="border-b border-slate-200 text-left">
                <th className="py-1.5 text-[11px] font-black uppercase tracking-wide text-slate-400">Distributor &amp; code</th>
                <th className="py-1.5 text-[11px] font-black uppercase tracking-wide text-slate-400">Territory</th>
                <th className="py-1.5 text-[11px] font-black uppercase tracking-wide text-slate-400">Known to sales</th>
              </tr>
            </thead>
            <tbody>
              {profile.codes.map((code) => (
                <tr key={`${code.distributorCode}-${code.customerCode}`} className="border-b border-slate-100 last:border-0">
                  <td className="py-2 align-top">
                    <span className="block break-words text-[13px] font-bold text-slate-900">
                      {code.distributorName || code.distributorCode}
                    </span>
                    <span className="block break-words text-[12px] font-semibold tabular-nums text-slate-500">
                      {code.customerCode}
                    </span>
                    {code.alsoInOtherRegister ? (
                      <span className="mt-1 inline-block rounded-full bg-violet-50 px-1.5 py-0.5 text-[10px] font-black uppercase tracking-wide text-violet-700 ring-1 ring-violet-200">
                        Also in the other register
                      </span>
                    ) : null}
                  </td>
                  <td className="break-words py-2 align-top text-[12px] font-semibold text-slate-700">
                    {code.areaCode || "—"}
                    {code.brickId ? (
                      <span className="block text-[11px] font-medium text-slate-400">Brick {code.brickId}</span>
                    ) : null}
                  </td>
                  <td className="py-2 align-top text-[12px] font-bold">
                    {code.knownToSales ? (
                      <span className="text-emerald-700">Yes</span>
                    ) : (
                      <span className="text-amber-700">Not yet</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      {profile.register === "marketing" ? (
        <Section
          icon={<Sparkles className="h-4 w-4" />}
          title="Marketing requests"
          subtitle="Campaigns raised for this pharmacy"
        >
          {profile.marketingRequests.length === 0 ? (
            <Empty>No marketing request has been raised for this pharmacy.</Empty>
          ) : (
            <ul className="space-y-2">
              {profile.marketingRequests.map((request) => (
                <li key={request.id} className="rounded-[14px] border border-slate-200 p-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="break-words text-[13px] font-bold text-slate-900">
                      {request.requestCode || "Request"}
                    </span>
                    {request.status ? (
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-black uppercase tracking-wide text-slate-600">
                        {request.status}
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 break-words text-[12px] font-semibold text-slate-500">
                    {[
                      request.requestDate,
                      request.requesterName,
                      request.estimatedCost == null ? null : `${money.format(request.estimatedCost)} estimated`,
                    ]
                      .filter(Boolean)
                      .join(" · ") || "—"}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Section>
      ) : (
        <Section
          icon={<ShoppingCart className="h-4 w-4" />}
          title="Direct orders"
          subtitle="Orders placed on this pharmacy"
        >
          {profile.directOrders.length === 0 ? (
            <Empty>No direct order has been placed on this pharmacy.</Empty>
          ) : (
            <ul className="space-y-2">
              {profile.directOrders.map((order) => (
                <li key={order.id} className="rounded-[14px] border border-slate-200 p-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="break-words text-[13px] font-bold text-slate-900">
                      {order.productName || "Order"}
                    </span>
                    {order.status ? (
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-black uppercase tracking-wide text-slate-600">
                        {order.status}
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 break-words text-[12px] font-semibold text-slate-500">
                    {[
                      order.line,
                      order.qty == null ? null : `${whole.format(order.qty)} units`,
                      order.salesValue == null ? null : money.format(order.salesValue),
                      order.salesMonth,
                      order.requesterName,
                    ]
                      .filter(Boolean)
                      .join(" · ") || "—"}
                  </p>
                  {order.fromMarketingRequestId ? (
                    <p className="mt-1 flex flex-wrap items-center gap-1 text-[11px] font-bold text-orange-700">
                      <Receipt aria-hidden className="h-3.5 w-3.5 shrink-0" />
                      <span>Raised from a marketing campaign</span>
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}

      <Section
        icon={<Info className="h-4 w-4" />}
        title="What this page cannot show"
        subtitle="Stated openly, because an empty panel reads like a quiet month rather than a missing link"
      >
        <ul className="space-y-2 text-[12px] font-medium leading-5 text-slate-600">
          <li className="flex items-start gap-2">
            <User aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
            <span>
              <span className="font-bold text-slate-800">CRM visits.</span> The CRM keeps pharmacies as their own kind
              of contact, and its names do not meet ours &mdash; one name in 330 matches. Visits can be reported for
              this pharmacy&rsquo;s <span className="font-bold">area</span>, never for the pharmacy itself, so this page
              does not claim to.
            </span>
          </li>
          <li className="flex items-start gap-2">
            <User aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
            <span>
              <span className="font-bold text-slate-800">Weekly sales.</span> Weekly is depot data and carries no
              customer at all. A weekly figure for one pharmacy cannot exist.
            </span>
          </li>
        </ul>
      </Section>
    </div>
  );
}
