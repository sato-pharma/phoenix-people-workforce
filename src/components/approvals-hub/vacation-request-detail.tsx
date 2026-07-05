import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import type { VacationApprovalDetail } from "@/lib/approvals-hub/service";
import { RequestTracker } from "@/components/approvals-hub/request-tracker";
import { DecisionActions } from "@/components/approvals-hub/decision-actions";
import { VacationAttachmentLinks } from "@/components/approvals-hub/vacation-attachment-links";

type Props = {
  detail: VacationApprovalDetail;
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

export function VacationRequestDetail({ detail, backHref }: Props) {
  const r = detail.record;
  if (detail.notFound || !r) {
    return (
      <div className="space-y-4">
        <Link href={backHref} className="inline-flex items-center gap-1.5 text-sm font-bold text-orange-600 hover:text-orange-700">
          <ArrowLeft className="h-4 w-4" /> Back to list
        </Link>
        <p className="border border-[#e4e9ec] bg-white px-4 py-6 text-sm text-slate-600">
          This request could not be found, or you do not have access to it.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Link href={backHref} className="inline-flex items-center gap-1.5 text-sm font-bold text-orange-600 hover:text-orange-700">
        <ArrowLeft className="h-4 w-4" /> Back to list
      </Link>

      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-[#e4e9ec] pb-3">
        <div>
          <h2 className="text-lg font-black text-slate-900">{r.employeeName}</h2>
          <p className="text-sm text-slate-600">
            {detail.typeLabel} · {Number(r.durationDays)} day{r.durationDays === 1 ? "" : "s"}
          </p>
        </div>
        <span className="whitespace-nowrap border border-slate-300 px-2.5 py-1 text-xs font-bold uppercase tracking-wide text-slate-700">
          {String(r.status).replace(/_/g, " ")}
        </span>
      </div>

      {detail.readOnly && detail.readOnlyReason ? (
        <p className="border-l-4 border-slate-400 bg-slate-50 px-4 py-2.5 text-sm font-semibold text-slate-700">
          {detail.readOnlyReason}
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="border border-[#e4e9ec] bg-white">
          <header className="border-b border-[#e4e9ec] bg-slate-900 px-4 py-2.5">
            <h3 className="text-[11px] font-black uppercase tracking-[0.14em] text-white">Request details</h3>
          </header>
          <dl className="px-4 py-2">
            <Row label="Employee" value={`${r.employeeName} (${r.employeeHrId})`} />
            <Row label="Leave type" value={detail.typeLabel} />
            <Row label="From" value={r.startDate} />
            <Row label="To" value={r.endDate} />
            <Row label="Duration" value={`${Number(r.durationDays)} day${r.durationDays === 1 ? "" : "s"}`} />
            <Row label="Payment" value={r.paymentStatus} />
            <Row label="Balance before" value={`${Number(r.balanceBeforeDays)} days`} />
            <Row label="Line" value={r.lineName} />
            <Row label="Department" value={r.departmentName} />
            <Row label="Manager" value={r.managerName} />
            <Row label="Employee note" value={r.employeeNote} />
            <Row label="Notes" value={r.notes} />
          </dl>
          {detail.canReviewAttachments && (r.sickAttachmentObjectPath || r.compensatoryAttachmentObjectPath) ? (
            <div className="border-t border-slate-100 px-4 py-3">
              <p className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-500">Evidence</p>
              <VacationAttachmentLinks canReviewAttachments={detail.canReviewAttachments} row={r} />
            </div>
          ) : null}
        </section>

        <div className="space-y-4">
          <RequestTracker
            steps={detail.steps}
            stageLabel={detail.stageLabel}
            ageDays={detail.slaAgeDays}
            slaModule="leave"
            fallbackStatusLabel={`Status: ${String(r.status).replace(/_/g, " ")}`}
          />
          {!detail.readOnly ? (
            <DecisionActions
              endpoint={`/api/vacations/requests/${encodeURIComponent(r.id)}/decision`}
              commentField="decisionComment"
              actions={detail.actions}
              backHref={backHref}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
