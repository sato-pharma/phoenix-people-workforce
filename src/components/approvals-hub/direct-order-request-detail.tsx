import Link from "next/link";

import { DecisionActions } from "@/components/approvals-hub/decision-actions";
import { DirectOrderSalesMonthControl } from "@/components/direct-orders/direct-order-sales-month-control";
import {
  buildDirectOrderDetailFields,
  dealFieldLabel,
  formatDealValue,
} from "@/lib/direct-orders/approval-fields";
import type { DirectOrderApprovalDetail } from "@/lib/direct-orders/types";

const money = (value: number) => `${Math.round(value).toLocaleString("en-US")} EGP`;

const cairoStamp = (iso: string | null | undefined) =>
  iso
    ? new Intl.DateTimeFormat("en-GB", {
        timeZone: "Africa/Cairo",
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(iso))
    : null;

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[10px] font-black uppercase tracking-wider text-slate-400">{label}</dt>
      {/* Never wrap (owner rule). The grid sits inside an overflow-x-auto wrapper, so a long
          value scrolls rather than clipping. */}
      <dd className="mt-0.5 whitespace-nowrap text-sm font-semibold text-slate-900">{value}</dd>
    </div>
  );
}

const STEP_TONE: Record<string, string> = {
  approved: "bg-emerald-500",
  rejected: "bg-rose-500",
  pending: "bg-amber-400",
};

export function DirectOrderRequestDetail({
  detail,
  backHref,
  // The same component serves an APPROVER (reached from the approvals queue) and the REQUESTER
  // tracking their own order (reached from "My direct orders"). Only the return path differs —
  // sending a requester back to an approvals queue they may not even have would be a dead end.
  backLabel = "Back to Direct Orders Approvals",
}: {
  detail: DirectOrderApprovalDetail | null;
  backHref: string;
  backLabel?: string;
}) {
  if (!detail) {
    return (
      <div className="space-y-4">
        <Link href={backHref} className="text-sm font-bold text-orange-600 hover:text-orange-700">
          ← Back
        </Link>
        <p className="border border-[#e4e9ec] bg-white px-4 py-6 text-sm text-slate-500">
          This direct order request was not found, or you do not have access to it.
        </p>
      </div>
    );
  }

  const {
    request,
    pharmacy,
    distributors,
    pharmacyHistory,
    retailHistory,
    retailUnmatchable,
    pharmacyStanding,
    canSetSalesMonth,
    steps,
    availableActions,
    bonusOverCap,
  } = detail;
  // ONE shared field list, built in the domain. The admin screen and the portal screen each
  // used to hand-maintain their own copy, which is how both ended up printing raw brick/area
  // codes — fixing it in one place could never have fixed the other.
  const allFields = buildDirectOrderDetailFields(detail);
  const gridFields = allFields.filter((field) => field.layout !== "full");
  const fullFields = allFields.filter((field) => field.layout === "full" && field.label !== "Distributor codes");

  return (
    <div className="space-y-5">
      <Link href={backHref} className="text-sm font-bold text-orange-600 hover:text-orange-700">
        ← {backLabel}
      </Link>

      <section className="border border-[#e4e9ec] bg-white">
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-[#e4e9ec] bg-slate-900 px-4 py-3">
          <h2 className="text-base font-black text-white">
            {request.productName} × {request.qty.toLocaleString("en-US")}
          </h2>
          <span className="text-lg font-black text-orange-400">{money(request.salesValue)}</span>
        </header>

        {request.status === "held" ? (
          <div className="border-b border-[#eef1f3] bg-orange-50 px-4 py-2.5">
            <p className="text-[12px] font-bold text-orange-900">
              HELD — this request stands outside the approval flow. Its pharmacy is not in the
              master database, so no approver has it as work and nothing can be approved here. It
              moves only when the pharmacy passes validation, and an untouched held request
              expires after 14 days.
            </p>
          </div>
        ) : request.status === "expired" ? (
          <div className="border-b border-[#eef1f3] bg-slate-100 px-4 py-2.5">
            <p className="text-[12px] font-bold text-slate-700">
              EXPIRED — this request stayed held for 14 days without its pharmacy passing
              validation, and closed automatically. Resubmit with a pharmacy from the master
              database.
            </p>
          </div>
        ) : pharmacy?.verificationStatus === "rejected" ? (
          /* Proven false, not merely unreviewed. An approver must never see this as "awaiting a
             look" — the pharmacy was refused, and the strongest thing this screen can do is say so
             before anyone considers acting on the order. */
          <div className="border-b border-[#eef1f3] bg-rose-100 px-4 py-2.5">
            <p className="text-[12px] font-black text-rose-900">
              REJECTED PHARMACY — this pharmacy was examined and found not to be real. The order
              behind it must not be approved, and the pharmacy cannot be used again.
            </p>
          </div>
        ) : pharmacy?.verificationStatus === "pending_review" ? (
          <div className="border-b border-[#eef1f3] bg-rose-50 px-4 py-2.5">
            <p className="text-[12px] font-bold text-rose-900">
              New pharmacy — Phoenix has not confirmed it yet. It was typed in by hand instead of
              being picked from the list, so nobody has checked that its distributor code is real.
              That code is what Phoenix uses to find this pharmacy&apos;s sales at the distributor,
              and a wrong one would pull another pharmacy&apos;s sales in here. The SFE Manager
              confirms the pharmacy at their own rung; until then this order cannot be finalized.
            </p>
          </div>
        ) : null}

        {/* The golden rule, stated where the money is judged (spec C2): CEO approval is a
            commercial decision, not an accounting event. Until Finance books a month, this
            order sits in NO month's numbers — and that absence must be readable, not implied. */}
        {request.status === "approved" && !request.salesMonth ? (
          <div className="border-b border-[#eef1f3] bg-amber-50 px-4 py-2.5">
            <p className="text-[12px] font-bold text-amber-900">
              Approved — awaiting Finance month. The sales are NOT in any month&apos;s numbers yet:
              they inject only when the Finance Manager books this order into a month.
            </p>
          </div>
        ) : null}

        {bonusOverCap ? (
          <div className="space-y-1 border-b border-[#eef1f3] bg-amber-50 px-4 py-2.5">
            {bonusOverCap ? (
              <p className="text-[12px] font-bold text-amber-900">
                Over cap — this {request.dealType} exceeds its product cap. Flagged for your attention, not blocked.
              </p>
            ) : null}
          </div>
        ) : null}

        <div className="overflow-x-auto">
          <dl className="grid grid-cols-2 gap-4 px-4 py-4 md:grid-cols-4">
            {gridFields.map((field) => (
              <Field key={field.label} label={field.label} value={field.value} />
            ))}
            {/* The one field the component still owns: it needs an over-cap colour treatment. */}
            <Field
              label={dealFieldLabel(request)}
              value={
                <span className={bonusOverCap ? "text-rose-600" : undefined}>
                  {formatDealValue(request)}
                  {bonusOverCap ? " · over cap" : ""}
                </span>
              }
            />
          </dl>
        </div>

        {fullFields.map((field) => (
          <dl key={field.label} className="border-t border-[#eef1f3] px-4 py-3">
            <dt className="text-[10px] font-black uppercase tracking-wider text-slate-400">{field.label}</dt>
            <dd className="mt-0.5 text-sm font-semibold text-slate-900">{field.value}</dd>
          </dl>
        ))}

        {/* Distributors get a row each rather than one joined string: three pairs runs ~80
            characters, which would either wrap or blow the grid. This mirrors the layout the
            pharmacy-variance table already uses for exactly this data, and the mapped-brick
            column surfaces a geography variance right inside the approval window. */}
        <div className="border-t border-[#eef1f3] px-4 py-3">
          <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">Distributors</p>
          {distributors.length === 0 ? (
            // A bare dash here read as "the screen failed to load the distributor", not as "there
            // is nothing on file" — and the two demand opposite reactions from an approver. Codes
            // became optional on 2026-08-04, so an empty list is now a NORMAL state that has to
            // say what it costs, because nothing else on this page reveals it.
            <div className="mt-1 border border-amber-200 bg-amber-50 px-3 py-2">
              <p className="text-[12px] font-bold text-amber-900">
                No distributor customer code on file for this pharmacy.
              </p>
              <p className="mt-0.5 text-[12px] text-amber-800">
                Nothing is missing from this screen — none was entered. Phoenix matches a
                pharmacy&apos;s distributor sales on that code, so until one is added this
                pharmacy&apos;s distributor sales cannot be linked to it. The direct order itself is
                unaffected. Add the code in Direct Orders → Pharmacy Registry.
              </p>
            </div>
          ) : (
            <>
              <div className="mt-1.5 hidden overflow-x-auto md:block">
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-[#eef1f3] text-left text-[11px] font-black uppercase tracking-wider text-slate-500">
                      <th className="whitespace-nowrap px-2 py-1">Distributor</th>
                      <th className="whitespace-nowrap px-2 py-1">Distributor code</th>
                      <th className="whitespace-nowrap px-2 py-1">Customer code</th>
                      <th className="whitespace-nowrap px-2 py-1">Mapped brick</th>
                      <th className="whitespace-nowrap px-2 py-1">Mapped area</th>
                      <th className="whitespace-nowrap px-2 py-1">Mapped region</th>
                    </tr>
                  </thead>
                  <tbody>
                    {distributors.map((row) => (
                      <tr key={`${row.distributorCode}-${row.customerCode}`} className="border-b border-[#eef1f3]">
                        <td className="whitespace-nowrap px-2 py-1.5 font-semibold text-slate-900">{row.distributorName}</td>
                        <td className="whitespace-nowrap px-2 py-1.5 text-slate-700">{row.distributorCode || "—"}</td>
                        <td className="whitespace-nowrap px-2 py-1.5 text-slate-700">{row.customerCode}</td>
                        <td className="whitespace-nowrap px-2 py-1.5 text-slate-500">{row.mappedBrickName ?? "not mapped"}</td>
                        <td className="whitespace-nowrap px-2 py-1.5 text-slate-500">{row.mappedAreaName ?? "not mapped"}</td>
                        <td className="whitespace-nowrap px-2 py-1.5 text-slate-500">{row.mappedRegionName ?? "not mapped"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Mobile: the same six fields as a card. The mapped geography stays on the card
                  rather than being dropped as "detail" — a variance between the pharmacy's area and
                  the distributor's mapping is the single most useful thing in this block, and an
                  approver on a phone is exactly the one who cannot go and look it up. */}
              <div className="mt-1.5 space-y-2 md:hidden">
                {distributors.map((row) => (
                  <article
                    key={`${row.distributorCode}-${row.customerCode}`}
                    className="block border border-[#e4e9ec] p-3"
                  >
                    <p className="text-sm font-black text-slate-900">{row.distributorName}</p>
                    <p className="mt-0.5 text-[11px] text-slate-500">
                      {row.distributorCode || "—"} · customer {row.customerCode}
                    </p>
                    <dl className="mt-2 space-y-0.5 text-[12px]">
                      {(
                        [
                          ["Mapped brick", row.mappedBrickName],
                          ["Mapped area", row.mappedAreaName],
                          ["Mapped region", row.mappedRegionName],
                        ] as const
                      ).map(([label, value]) => (
                        <div key={label} className="flex items-baseline justify-between gap-3">
                          <dt className="text-slate-400">{label}</dt>
                          <dd className="font-semibold text-slate-600">{value ?? "not mapped"}</dd>
                        </div>
                      ))}
                    </dl>
                  </article>
                ))}
              </div>
            </>
          )}
        </div>

        <DirectOrderSalesMonthControl
          requestId={request.id}
          salesMonth={request.salesMonth}
          canEdit={canSetSalesMonth}
          status={request.status}
        />

        {request.bonusOverrideReason ? (
          <p className="border-t border-[#eef1f3] px-4 py-2 text-xs text-slate-500">
            Note: {request.bonusOverrideReason}
          </p>
        ) : null}
      </section>

      {/* RETAIL — what the distributors invoiced this pharmacy. Kept strictly separate from the
          direct-order history below: they are different channels and summing them would double
          count. Matched on (distributor code + customer code) together, because a customer code
          alone is not unique across distributors. */}
      <section className="border border-[#e4e9ec] bg-white">
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-[#e4e9ec] bg-slate-100 px-4 py-2.5">
          <h3 className="text-[11px] font-black uppercase tracking-[0.14em] text-slate-600">
            Retail sales — from the distributors
          </h3>
          <span className="text-[11px] font-bold text-slate-500">all months on record</span>
        </header>
        {retailUnmatchable ? (
          <p className="px-4 py-4 text-sm text-slate-500">
            This pharmacy has no distributor customer code on file, so its retail sales cannot be
            matched. Register it against the distributor that actually supplies it to see them here.
          </p>
        ) : retailHistory.length === 0 ? (
          /* Spec D2: WHY it is empty, not just that it is. A provisional pharmacy and an
             established one that simply has not bought both produce zero rows, and they are
             opposite risks — so the sentence comes from the domain, never from a count here. */
          <p
            className={`px-4 py-4 text-sm ${
              pharmacyStanding && pharmacyStanding.trustState !== "trusted"
                ? "font-semibold text-amber-700"
                : "text-slate-500"
            }`}
          >
            {pharmacyStanding?.noHistoryNote ??
              "No distributor sales found for this pharmacy's customer codes."}
          </p>
        ) : (
          <>
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full min-w-[820px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-[#eef1f3] bg-slate-50 text-left text-[11px] font-black uppercase tracking-wider text-slate-500">
                  <th className="whitespace-nowrap px-3 py-2">Month</th>
                  <th className="whitespace-nowrap px-3 py-2">Product</th>
                  <th className="whitespace-nowrap px-3 py-2">Distributor</th>
                  <th className="whitespace-nowrap px-3 py-2">Customer code</th>
                  <th className="whitespace-nowrap px-3 py-2 text-right">Qty</th>
                  <th className="whitespace-nowrap px-3 py-2 text-right">Bonus</th>
                  <th className="whitespace-nowrap px-3 py-2 text-right">Value</th>
                </tr>
              </thead>
              <tbody>
                {retailHistory.map((row) => (
                  <tr key={`${row.month}-${row.productCode}-${row.distributorCode}`} className="border-b border-[#eef1f3]">
                    <td className="whitespace-nowrap px-3 py-1.5 font-semibold text-slate-900">{row.month}</td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-slate-800">
                      {row.productName} <span className="text-slate-400">({row.productCode})</span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-slate-700">
                      {row.distributorName} <span className="text-slate-400">({row.distributorCode})</span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-slate-500">{row.customerCode}</td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-slate-900">
                      {row.qty.toLocaleString("en-US")}
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-slate-700">
                      {row.bonus.toLocaleString("en-US")}
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-right font-bold tabular-nums text-slate-900">
                      {money(row.salesValue)}
                    </td>
                  </tr>
                ))}
              </tbody>
              {/* The judgement line: what this pharmacy is actually worth across all months on
                  record, so the approver weighs THIS order against THAT total at a glance. */}
              <tfoot>
                <tr className="bg-slate-50">
                  <td colSpan={4} className="whitespace-nowrap px-3 py-2 text-[11px] font-black uppercase tracking-wider text-slate-500">
                    Total — {retailHistory.length.toLocaleString("en-US")} row{retailHistory.length === 1 ? "" : "s"}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right font-black tabular-nums text-slate-900">
                    {retailHistory.reduce((sum, row) => sum + row.qty, 0).toLocaleString("en-US")}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right font-bold tabular-nums text-slate-700">
                    {retailHistory.reduce((sum, row) => sum + row.bonus, 0).toLocaleString("en-US")}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right font-black tabular-nums text-slate-900">
                    {money(retailHistory.reduce((sum, row) => sum + row.salesValue, 0))}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* Mobile: one card per month/product/distributor. The TOTAL is a card of its own at the
              end rather than a dropped "footer" — it is the judgement line the approver weighs this
              order against, and it is the first thing lost when a table is squeezed onto a phone. */}
          <div className="space-y-2 p-3 md:hidden">
            {retailHistory.map((row) => (
              <article
                key={`${row.month}-${row.productCode}-${row.distributorCode}`}
                className="block border border-[#e4e9ec] p-3"
              >
                <p className="text-sm font-black text-slate-900">
                  {row.month} · {row.productName}{" "}
                  <span className="font-semibold text-slate-400">({row.productCode})</span>
                </p>
                <p className="mt-0.5 text-[11px] text-slate-500">
                  {row.distributorName} ({row.distributorCode}) · customer {row.customerCode}
                </p>
                <p className="mt-2 text-sm font-bold tabular-nums text-slate-900">
                  {row.qty.toLocaleString("en-US")} qty
                  <span className="ml-2 font-semibold text-slate-500">
                    {row.bonus.toLocaleString("en-US")} bonus
                  </span>
                  <span className="ml-2">{money(row.salesValue)}</span>
                </p>
              </article>
            ))}
            <article className="block border border-slate-300 bg-slate-50 p-3">
              <p className="text-[10px] font-black uppercase tracking-wider text-slate-500">
                Total — {retailHistory.length.toLocaleString("en-US")} row
                {retailHistory.length === 1 ? "" : "s"}
              </p>
              <p className="mt-1 text-sm font-black tabular-nums text-slate-900">
                {retailHistory.reduce((sum, row) => sum + row.qty, 0).toLocaleString("en-US")} qty
                <span className="ml-2 font-bold text-slate-600">
                  {retailHistory.reduce((sum, row) => sum + row.bonus, 0).toLocaleString("en-US")} bonus
                </span>
                <span className="ml-2">
                  {money(retailHistory.reduce((sum, row) => sum + row.salesValue, 0))}
                </span>
              </p>
            </article>
          </div>
          </>
        )}
      </section>

      {/* DIRECT — what Phoenix booked from approved direct orders. The request being decided is
          excluded, so the baseline never contains the number under judgement. */}
      <section className="border border-[#e4e9ec] bg-white">
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-[#e4e9ec] bg-slate-100 px-4 py-2.5">
          <h3 className="text-[11px] font-black uppercase tracking-[0.14em] text-slate-600">
            Direct sales — from Phoenix direct orders
          </h3>
          <span className="text-[11px] font-bold text-slate-500">excludes this request</span>
        </header>
        {pharmacyHistory.length === 0 ? (
          <p className="px-4 py-4 text-sm text-slate-500">
            No other direct orders recorded for this pharmacy yet — this is its first.
          </p>
        ) : (
          <>
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full min-w-[760px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-[#eef1f3] bg-slate-50 text-left text-[11px] font-black uppercase tracking-wider text-slate-500">
                  <th className="whitespace-nowrap px-3 py-2">Month</th>
                  <th className="whitespace-nowrap px-3 py-2">Product</th>
                  <th className="whitespace-nowrap px-3 py-2">Distributor</th>
                  <th className="whitespace-nowrap px-3 py-2 text-right">Orders</th>
                  <th className="whitespace-nowrap px-3 py-2 text-right">Qty</th>
                  <th className="whitespace-nowrap px-3 py-2 text-right">Bonus</th>
                  <th className="whitespace-nowrap px-3 py-2 text-right">Value</th>
                </tr>
              </thead>
              <tbody>
                {pharmacyHistory.map((row) => (
                  <tr
                    key={`${row.month}-${row.productCode}-${row.distributorCode}`}
                    className="border-b border-[#eef1f3]"
                  >
                    <td className="whitespace-nowrap px-3 py-1.5 font-semibold text-slate-900">
                      {row.month}
                      {row.monthIsProvisional ? (
                        <span className="ml-1.5 text-[10px] font-bold uppercase tracking-wide text-amber-700">
                          not final
                        </span>
                      ) : null}
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-slate-800">
                      {row.productName} <span className="text-slate-400">({row.productCode})</span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-slate-700">
                      {row.distributorName}
                      {row.distributorCode ? <span className="text-slate-400"> ({row.distributorCode})</span> : null}
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-slate-700">{row.orders}</td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-slate-900">
                      {row.qty.toLocaleString("en-US")}
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-slate-700">
                      {row.bonus.toLocaleString("en-US")}
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-right font-bold tabular-nums text-slate-900">
                      {money(row.salesValue)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-slate-50">
                  <td colSpan={3} className="whitespace-nowrap px-3 py-2 text-[11px] font-black uppercase tracking-wider text-slate-500">
                    Total
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right font-bold tabular-nums text-slate-700">
                    {pharmacyHistory.reduce((sum, row) => sum + row.orders, 0).toLocaleString("en-US")}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right font-black tabular-nums text-slate-900">
                    {pharmacyHistory.reduce((sum, row) => sum + row.qty, 0).toLocaleString("en-US")}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right font-bold tabular-nums text-slate-700">
                    {pharmacyHistory.reduce((sum, row) => sum + row.bonus, 0).toLocaleString("en-US")}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right font-black tabular-nums text-slate-900">
                    {money(pharmacyHistory.reduce((sum, row) => sum + row.salesValue, 0))}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* Mobile. The "not final" flag rides the card exactly as it rides the row: a month that
              Finance has not closed must never be read as settled, and that warning is worth more
              on a phone than any of the numbers beside it. */}
          <div className="space-y-2 p-3 md:hidden">
            {pharmacyHistory.map((row) => (
              <article
                key={`${row.month}-${row.productCode}-${row.distributorCode}`}
                className="block border border-[#e4e9ec] p-3"
              >
                <p className="text-sm font-black text-slate-900">
                  {row.month}
                  {row.monthIsProvisional ? (
                    <span className="ml-1.5 text-[10px] font-bold uppercase tracking-wide text-amber-700">
                      not final
                    </span>
                  ) : null}
                  <span className="font-bold"> · {row.productName}</span>{" "}
                  <span className="font-semibold text-slate-400">({row.productCode})</span>
                </p>
                <p className="mt-0.5 text-[11px] text-slate-500">
                  {row.distributorName}
                  {row.distributorCode ? ` (${row.distributorCode})` : ""}
                </p>
                <p className="mt-2 text-sm font-bold tabular-nums text-slate-900">
                  {row.orders.toLocaleString("en-US")} order{row.orders === 1 ? "" : "s"}
                  <span className="ml-2">{row.qty.toLocaleString("en-US")} qty</span>
                  <span className="ml-2 font-semibold text-slate-500">
                    {row.bonus.toLocaleString("en-US")} bonus
                  </span>
                  <span className="ml-2">{money(row.salesValue)}</span>
                </p>
              </article>
            ))}
            <article className="block border border-slate-300 bg-slate-50 p-3">
              <p className="text-[10px] font-black uppercase tracking-wider text-slate-500">Total</p>
              <p className="mt-1 text-sm font-black tabular-nums text-slate-900">
                {pharmacyHistory.reduce((sum, row) => sum + row.orders, 0).toLocaleString("en-US")} orders
                <span className="ml-2">
                  {pharmacyHistory.reduce((sum, row) => sum + row.qty, 0).toLocaleString("en-US")} qty
                </span>
                <span className="ml-2 font-bold text-slate-600">
                  {pharmacyHistory.reduce((sum, row) => sum + row.bonus, 0).toLocaleString("en-US")} bonus
                </span>
                <span className="ml-2">
                  {money(pharmacyHistory.reduce((sum, row) => sum + row.salesValue, 0))}
                </span>
              </p>
            </article>
          </div>
          </>
        )}
      </section>

      <section className="border border-[#e4e9ec] bg-white">
        <header className="border-b border-[#e4e9ec] bg-slate-100 px-4 py-2.5">
          <h3 className="text-[11px] font-black uppercase tracking-[0.14em] text-slate-600">Approval chain</h3>
        </header>
        {steps.length === 0 ? (
          <p className="px-4 py-4 text-sm text-slate-500">
            {request.status === "held" || request.status === "expired"
              ? "No approval chain — a held request enters the chain only after its pharmacy passes validation."
              : "No approval steps recorded for this request."}
          </p>
        ) : (
          <ol className="divide-y divide-[#eef1f3]">
            {steps.map((step) => (
              <li key={step.order} className="px-4 py-2.5">
                <div className="flex items-center gap-3">
                  <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${STEP_TONE[step.status] ?? "bg-slate-300"}`} />
                  <span className="w-6 shrink-0 text-xs font-bold text-slate-400">{step.order}</span>
                  <span className="flex-1 text-sm font-semibold text-slate-800">
                    {step.approverName ?? step.label}
                    <span className="ml-2 text-[11px] font-normal text-slate-400">{step.label}</span>
                  </span>
                  <span className="text-[11px] font-black uppercase tracking-wider text-slate-500">{step.status}</span>
                </div>
                {/* The decision record (spec D1): who, when — Cairo — and what they wrote. A rung
                    decided by someone other than its named approver (a role rung, or an override)
                    credits the actual decider, never the label. */}
                {step.decidedAt || step.decidedByName || step.decisionComment ? (
                  <div className="mt-1 pl-[42px]">
                    <p className="text-[11px] text-slate-500">
                      {step.decidedByName ? <span className="font-bold text-slate-600">{step.decidedByName}</span> : null}
                      {step.decidedAt ? <span>{step.decidedByName ? " · " : ""}{cairoStamp(step.decidedAt)}</span> : null}
                    </p>
                    {step.decisionComment ? (
                      <p className="mt-0.5 border-l-2 border-slate-200 pl-2 text-[12px] italic text-slate-600" dir="auto">
                        “{step.decisionComment}”
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </section>

      <DecisionActions
        endpoint={`/api/direct-orders/${encodeURIComponent(request.id)}/decision`}
        commentField="comment"
        actions={availableActions}
        backHref={backHref}
      />
    </div>
  );
}
