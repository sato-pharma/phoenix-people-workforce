import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { adminPanelClassName, adminPanelHeaderClassName, adminSoftPanelClassName } from "@/components/admin/admin-design-tokens";
import type { VacationApprovalDetail } from "@/lib/approvals-hub/service";
import { RequestTracker } from "@/components/approvals-hub/request-tracker";
import { DecisionActions } from "@/components/approvals-hub/decision-actions";
import { VacationAdminControls } from "@/components/approvals-hub/vacation-admin-controls";
import { VacationAttachmentLinks } from "@/components/approvals-hub/vacation-attachment-links";
import { VacationAttachmentHistory } from "@/components/vacation/vacation-attachment-history";
import { VacationEvidenceReviewActions } from "@/components/approvals-hub/vacation-evidence-review";
import { WhoElseIsOffPanel } from "@/components/approvals-hub/who-else-is-off-panel";
import { requestStatusLabel } from "@/lib/approvals-hub/request-status-label";
import type { WhoElseIsOff } from "@/lib/vacation/who-else-is-off";

type Props = {
  detail: VacationApprovalDetail;
  backHref: string;
  /** Who else on the team is off on these dates. Null when there is no decision for it to inform. */
  whoElseIsOff?: WhoElseIsOff | null;
};

function Row({ label, value }: { label: string; value: string | number | null | undefined }) {
  return (
    <div className="flex flex-col gap-0.5 border-b border-slate-100 py-2">
      <dt className="text-phx-xs font-bold uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="text-sm font-semibold text-slate-900">{value === null || value === undefined || value === "" ? "—" : value}</dd>
    </div>
  );
}

export function VacationRequestDetail({ detail, backHref, whoElseIsOff }: Props) {
  const r = detail.record;
  if (detail.notFound || !r) {
    return (
      <div className="space-y-4">
        <Link href={backHref} className="inline-flex items-center gap-1.5 text-sm font-bold text-orange-600 hover:text-orange-700">
          <ArrowLeft className="h-4 w-4" /> Back to list
        </Link>
        <p className={`${adminSoftPanelClassName} px-4 py-6 text-sm text-slate-600`}>
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

      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-phx-line pb-3">
        <div>
          <h2 className="text-lg font-black text-slate-900">{r.employeeName}</h2>
          <p className="text-sm text-slate-600">
            {detail.typeLabel} · {Number(r.durationDays)} day{r.durationDays === 1 ? "" : "s"}
          </p>
        </div>
        <span className="whitespace-nowrap border border-slate-300 px-2.5 py-1 text-xs font-bold uppercase tracking-wide text-slate-700">
          {requestStatusLabel(r.status)}
        </span>
      </div>

      {detail.readOnly && detail.readOnlyReason ? (
        <p className="border-l-4 border-slate-400 bg-slate-50 px-4 py-2.5 text-sm font-semibold text-slate-700 shadow-[inset_0_1px_2px_rgba(15,23,42,0.05)]">
          {detail.readOnlyReason}
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <section className={adminPanelClassName}>
          <header className={`${adminPanelHeaderClassName} px-4 py-2.5`}>
            <h3 className="text-phx-xs font-black uppercase tracking-[0.14em] text-white">Request details</h3>
          </header>
          <dl className="px-4 py-2">
            <Row label="From" value={r.startDate} />
            <Row label="To" value={r.endDate} />
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
              <p className="mb-1.5 text-phx-xs font-bold uppercase tracking-wide text-slate-500">
                Evidence{r.attachments.length > 1 ? ` — ${r.attachments.length} documents` : ""}
              </p>
              {/* Every uploaded file with the date IT arrived, so a document sent days after the
                  request reads as its own dated line instead of replacing the first one. Falls back
                  to the single legacy link when the history is empty — an older request, or an
                  environment the migration has not reached yet. */}
              {r.attachments.length > 0 ? (
                <VacationAttachmentHistory
                  attachments={r.attachments}
                  // HR/Super Admin may add a document on the employee's behalf; an assigned manager
                  // reviewing the note may not, and the route refuses it either way.
                  canUpload={detail.canReviewEvidence}
                  kind={r.vacationType === "compensatory" ? "compensatory" : "sick"}
                  requestId={r.id}
                />
              ) : (
                <VacationAttachmentLinks canReviewAttachments={detail.canReviewAttachments} row={r} />
              )}
              {detail.canReviewEvidence ? (
                <VacationEvidenceReviewActions
                  evidenceType={r.vacationType === "compensatory" ? "compensatory" : "sick"}
                  existingReview={
                    r.evidenceReviews.find(
                      (review) => review.evidenceType === (r.vacationType === "compensatory" ? "compensatory" : "sick"),
                    ) ?? null
                  }
                  requestId={r.id}
                />
              ) : null}
            </div>
          ) : null}
        </section>

        <div className="space-y-4">
          <RequestTracker
            steps={detail.steps}
            stageLabel={detail.stageLabel}
            ageDays={detail.slaAgeDays}
            slaModule="leave"
            fallbackStatusLabel={`Status: ${requestStatusLabel(r.status)}`}
          />
          {whoElseIsOff ? <WhoElseIsOffPanel data={whoElseIsOff} /> : null}
          {!detail.readOnly ? (
            <DecisionActions
              endpoint={`/api/vacations/requests/${encodeURIComponent(r.id)}/decision`}
              commentField="decisionComment"
              actions={detail.actions}
              backHref={backHref}
              // Two returns on every vacation approval, any type, manager or HR (owner, 2026-10-08):
              // "Return for edit" needs no comment; "Return for edit with comment" demands one.
              returnWithoutComment
              // The four the owner asked for, as one set (2026-09-10). Only an HR viewer gets the
              // "as HR" naming — a manager deciding a vacation is not HR and must not read as it.
              labelOverrides={
                detail.viewerStepKind === "hr"
                  ? { acknowledge: "Acknowledge as HR", reject: "Reject as HR", return: "Return for edit with comment" }
                  : { return: "Return for edit with comment" }
              }
              disabledReasons={detail.viewerStepKind === "hr" ? detail.actionReasons : undefined}
              overrideNotice={
                detail.adminOverride?.available
                  // Whole days on screen. The exact fraction is what the rule measures and what
                  // the audit event keeps; "2.48 days" in a sentence just reads like a machine.
                  ? `This request has not been responded to for ${Math.floor(detail.adminOverride.daysPending)} days, so its approval has transferred to you as System Administrator. The record will show you as the responder. The request then continues to the next approver as normal.`
                  : null
              }
            />
          ) : null}
          {detail.canAdminManage ? <VacationAdminControls backHref={backHref} row={r} /> : null}
          {detail.adminOverride && !detail.adminOverride.available && detail.adminOverride.reason && detail.adminOverride.availableAt ? (
            // The wait, visible before it unlocks. Without this the button simply is not there and
            // HR cannot tell a request that is merely young from one the rule refuses to touch.
            <p className={`${adminSoftPanelClassName} px-4 py-3 text-phx-xs font-semibold text-slate-600`}>
              {detail.adminOverride.reason}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
