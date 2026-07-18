import Link from "next/link";

import { DecisionActions } from "@/components/approvals-hub/decision-actions";
import type { DirectOrderApprovalDetail } from "@/lib/direct-orders/types";

const money = (value: number) => `${Math.round(value).toLocaleString("en-US")} EGP`;

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[10px] font-black uppercase tracking-wider text-slate-400">{label}</dt>
      <dd className="mt-0.5 text-sm font-semibold text-slate-900">{value}</dd>
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
}: {
  detail: DirectOrderApprovalDetail | null;
  backHref: string;
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

  const { request, requesterName, pharmacy, steps, availableActions, bonusOverCap } = detail;

  return (
    <div className="space-y-5">
      <Link href={backHref} className="text-sm font-bold text-orange-600 hover:text-orange-700">
        ← Back to Direct Orders Approvals
      </Link>

      <section className="border border-[#e4e9ec] bg-white">
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-[#e4e9ec] bg-slate-900 px-4 py-3">
          <h2 className="text-base font-black text-white">
            {request.productName} × {request.qty.toLocaleString("en-US")}
          </h2>
          <span className="text-lg font-black text-orange-400">{money(request.salesValue)}</span>
        </header>

        <dl className="grid grid-cols-2 gap-4 px-4 py-4 md:grid-cols-4">
          <Field label="Requester" value={`${requesterName} · ${request.requesterRole}`} />
          <Field label="Line" value={request.line} />
          <Field label="Factory price" value={money(request.factoryPriceSnapshot)} />
          <Field label="Status" value={request.status.replace(/_/g, " ")} />
          <Field
            label="Pharmacy"
            value={pharmacy ? `${pharmacy.pharmacyName} (${pharmacy.phoenixPharmacyCode})` : "—"}
          />
          <Field label="Brick / Area" value={pharmacy ? `${pharmacy.brickId ?? "—"} / ${pharmacy.areaCode ?? "—"}` : "—"} />
          <Field label="Pharmacy address" value={pharmacy?.pharmacyAddress || "—"} />
          <Field label="Collection date" value={request.collectionDate ?? "—"} />
          <Field
            label="Bonus"
            value={
              <span className={bonusOverCap ? "text-rose-600" : undefined}>
                {request.bonus.toLocaleString("en-US")}
                {bonusOverCap ? " · over cap (CEO override)" : ""}
              </span>
            }
          />
          <Field label="Sales month" value={request.salesMonth ?? "— (set on final approval)"} />
        </dl>
        {request.bonusOverrideReason ? (
          <p className="border-t border-[#eef1f3] px-4 py-2 text-xs text-slate-500">
            Note: {request.bonusOverrideReason}
          </p>
        ) : null}
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
