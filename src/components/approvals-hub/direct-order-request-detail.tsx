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
    canSetSalesMonth,
    steps,
    availableActions,
    bonusOverCap,
    missingPharmacyPrice,
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

        {pharmacy?.verificationStatus === "pending_review" ? (
          <div className="border-b border-[#eef1f3] bg-rose-50 px-4 py-2.5">
            <p className="text-[12px] font-bold text-rose-900">
              New pharmacy — Phoenix has not confirmed it yet. It was typed in by hand instead of being
              picked from the list, so nobody has checked that its distributor code is real. That code is
              what Phoenix uses to find this pharmacy&apos;s sales at the distributor, and a wrong one
              would pull another pharmacy&apos;s sales in here. This order waits for SFE, then a System
              Admin, before it can be finalized.
            </p>
          </div>
        ) : null}

        {bonusOverCap || missingPharmacyPrice ? (
          <div className="space-y-1 border-b border-[#eef1f3] bg-amber-50 px-4 py-2.5">
            {bonusOverCap ? (
              <p className="text-[12px] font-bold text-amber-900">
                Over cap — this {request.dealType} exceeds its product cap. Flagged for your attention, not blocked.
              </p>
            ) : null}
            {missingPharmacyPrice ? (
              <p className="text-[12px] font-bold text-amber-900">
                No pharmacy price was set for this product — the value above uses the factory price.
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
            <div className="mt-1.5 overflow-x-auto">
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
          <p className="px-4 py-4 text-sm text-slate-500">
            No distributor sales found for this pharmacy&apos;s customer codes.
          </p>
        ) : (
          <div className="overflow-x-auto">
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
            </table>
          </div>
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
          <div className="overflow-x-auto">
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
            </table>
          </div>
        )}
      </section>

      <section className="border border-[#e4e9ec] bg-white">
        <header className="border-b border-[#e4e9ec] bg-slate-100 px-4 py-2.5">
          <h3 className="text-[11px] font-black uppercase tracking-[0.14em] text-slate-600">Approval chain</h3>
        </header>
        <ol className="divide-y divide-[#eef1f3]">
          {steps.map((step) => (
            <li key={step.order} className="flex items-center gap-3 px-4 py-2.5">
              <span className={`h-2.5 w-2.5 rounded-full ${STEP_TONE[step.status] ?? "bg-slate-300"}`} />
              <span className="w-6 text-xs font-bold text-slate-400">{step.order}</span>
              <span className="flex-1 text-sm font-semibold text-slate-800">
                {step.approverName ?? step.label}
                <span className="ml-2 text-[11px] font-normal text-slate-400">{step.label}</span>
              </span>
              <span className="text-[11px] font-black uppercase tracking-wider text-slate-500">{step.status}</span>
            </li>
          ))}
        </ol>
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
