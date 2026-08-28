import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import type { ExcuseApprovalDetail } from "@/lib/approvals-hub/service";
import { DecisionActions } from "@/components/approvals-hub/decision-actions";

type Props = {
  detail: ExcuseApprovalDetail;
  backHref: string;
};

function Row({ label, value }: { label: string; value: string | number | null | undefined }) {
  return (
    <div className="flex flex-col gap-0.5 border-b border-slate-100 py-2">
      <dt className="text-[11px] font-bold uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="text-sm font-semibold text-slate-900">{value === null || value === undefined || value === "" ? "—" : value}</dd>
    </div>
  );
}

export function ExcuseRequestDetail({ detail, backHref }: Props) {
  const req = detail.request;
  if (detail.notFound || !req) {
    return (
      <div className="space-y-4">
        <Link href={backHref} className="inline-flex items-center gap-1.5 text-sm font-bold text-orange-600 hover:text-orange-700">
          <ArrowLeft className="h-4 w-4" /> Back to list
        </Link>
        <p className="border border-phx-line bg-white px-4 py-6 text-sm text-slate-600">
          This excuse request could not be found, or you do not have access to it.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Link href={backHref} className="inline-flex items-center gap-1.5 text-sm font-bold text-orange-600 hover:text-orange-700">
        <ArrowLeft className="h-4 w-4" /> Back to list
      </Link>

      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-phx-line pb-3">
        <div>
          <h2 className="text-lg font-black text-slate-900">{req.employeeName}</h2>
          <p className="text-sm text-slate-600">
            {req.excuseType === "morning" ? "Morning" : "Afternoon"} excuse · {req.excuseDate}
          </p>
        </div>
        <span className="whitespace-nowrap border border-slate-300 px-2.5 py-1 text-xs font-bold uppercase tracking-wide text-slate-700">
          {String(req.status).replace(/_/g, " ")}
        </span>
      </div>

      {detail.readOnlyReason ? (
        <p className="border-l-4 border-slate-400 bg-slate-50 px-4 py-2.5 text-sm font-semibold text-slate-700">
          {detail.readOnlyReason}
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="border border-phx-line bg-white">
          <header className="border-b border-phx-line bg-slate-900 px-4 py-2.5">
            <h3 className="text-[11px] font-black uppercase tracking-[0.14em] text-white">Request details</h3>
          </header>
          <dl className="px-4 py-2">
            <Row label="Employee" value={`${req.employeeName} (${req.employeeHrId})`} />
            <Row label="Excuse type" value={req.excuseType === "morning" ? "Morning" : "Afternoon"} />
            <Row label="Date" value={req.excuseDate} />
            <Row label="Duration" value={`${req.durationHours} hours`} />
            <Row label="Line" value={req.lineName} />
            <Row label="Department" value={req.departmentName} />
            <Row label="Manager" value={req.managerName} />
            <Row label="Manager reply" value={req.managerDecisionComment} />
          </dl>
        </section>

        {detail.canAct ? (
          <DecisionActions
            endpoint={`/api/excuses/${encodeURIComponent(req.id)}/decision`}
            commentField="comment"
            actions={{ approve: true, reject: true, return: true }}
            backHref={backHref}
          />
        ) : null}
      </div>
    </div>
  );
}
