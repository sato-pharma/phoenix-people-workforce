"use client";

import { PortalRecordCard, PortalRecordFields } from "@/components/employee-portal/portal-primitives";
import { Badge } from "@/components/ui/badge";
import {
  ResignationDaysCell,
  ResignationStatusBadge,
  resignationCardAccent,
} from "@/components/resignations/resignation-badges";
import {
  ResignationWorkflowActions,
  type ResignationActionHandlers,
} from "@/components/resignations/resignation-workflow-actions";
import {
  formatPayoutMonth,
  formatPayrollCandidateSystemId,
  formatResignationDate,
  isTerminatedResignation,
  resignationActorLabel,
  resignationDaysState,
} from "@/lib/resignations/view-model";
import type {
  PayrollResignationCandidateRecord,
  ResignationRecord,
} from "@/lib/resignations/types";
import { formatEmployeeDisplayName } from "@/lib/utils";

function EmployeeMeta({ hrId, jobTitle }: { hrId: string; jobTitle: string | null }) {
  return (
    <>
      <span className="block whitespace-nowrap font-mono">{hrId || "No HR ID"}</span>
      <span className="mt-0.5 block whitespace-nowrap">{jobTitle ?? "-"}</span>
    </>
  );
}

function NoteBlock({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-2 border border-slate-100 bg-slate-50 px-2.5 py-2 text-xs font-semibold leading-5 text-slate-600">
      {children}
    </p>
  );
}

/** Mobile card for a payroll-upload resignation candidate row in the Workflow Queue. */
export function PayrollCandidateRecordCard({
  candidate,
}: {
  candidate: PayrollResignationCandidateRecord;
}) {
  const candidateSystemId = formatPayrollCandidateSystemId(candidate.id);

  return (
    <PortalRecordCard
      accent="slate"
      meta={<EmployeeMeta hrId={candidate.hrId} jobTitle={candidate.jobTitle} />}
      status={<Badge variant="neutral">Payroll candidate</Badge>}
      title={formatEmployeeDisplayName(candidate.employeeName)}
    >
      <PortalRecordFields
        fields={[
          { label: "Line", value: candidate.lineName ?? "-" },
          { label: "Area", value: candidate.areaName ?? "-" },
          { label: "Last seen", value: formatResignationDate(candidate.lastSeenAt.slice(0, 10)) },
          {
            label: "Last payout",
            value: formatPayoutMonth(candidate.lastPayoutMonth, candidate.lastPayoutYear),
          },
        ]}
      />
      <NoteBlock>
        Payroll upload generated a resignation candidate. Hiring:{" "}
        {formatResignationDate(candidate.hireDate)}.
      </NoteBlock>
      <p className="mt-2 text-[11px] font-semibold text-slate-500">
        System ID {candidateSystemId} · Source {candidate.sourceFileName ?? "-"} · Row{" "}
        {candidate.sourceRow ?? "-"}
      </p>
      <p className="mt-1 text-[11px] font-semibold text-slate-400">
        Updated {formatResignationDate(candidate.updatedAt.slice(0, 10))} · No manual HR ID
        generation required.
      </p>
    </PortalRecordCard>
  );
}

/** Mobile card for a resignation workflow row in the Workflow Queue. */
export function ResignationRecordCard({
  record,
  ...handlers
}: ResignationActionHandlers & { record: ResignationRecord }) {
  const daysState = resignationDaysState(record);
  // Terminated exits are highlighted in place — same queue, rose accent — instead of living in a
  // separate table (owner decision, 2026-08-10).
  const terminated = isTerminatedResignation(record);

  return (
    <PortalRecordCard
      accent={terminated ? "rose" : resignationCardAccent(record.status)}
      actions={<ResignationWorkflowActions record={record} {...handlers} />}
      className={terminated ? "bg-rose-50/70" : undefined}
      meta={<EmployeeMeta hrId={record.employeeHrId} jobTitle={record.jobTitle} />}
      status={
        <div className="flex flex-col items-end gap-1">
          <ResignationStatusBadge status={record.status} />
          {terminated ? <Badge variant="danger">Terminated</Badge> : null}
        </div>
      }
      title={formatEmployeeDisplayName(record.employeeName)}
    >
      <PortalRecordFields
        fields={[
          { label: "Line", value: record.lineName ?? "-" },
          { label: "Submitted", value: formatResignationDate(record.submittedDate) },
          { label: "Effective", value: formatResignationDate(record.effectiveDate) },
          {
            label: "Days Left",
            value: <ResignationDaysCell state={daysState} />,
          },
        ]}
      />
      <NoteBlock>{record.reason ?? "-"}</NoteBlock>
      {record.rejectedReason ? (
        <p className="mt-2 border border-rose-100 bg-rose-50 px-2.5 py-2 text-xs font-semibold leading-5 text-rose-700">
          Rejection: {record.rejectedReason}
        </p>
      ) : null}
      <p className="mt-2 text-[11px] font-semibold text-slate-400">
        Created by {resignationActorLabel(record)} · Updated{" "}
        {formatResignationDate(record.updatedAt.slice(0, 10))}
      </p>
      {record.workflowNotes ? (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs font-bold text-orange-600">View notes</summary>
          <pre className="mt-2 whitespace-pre-wrap border border-slate-100 bg-slate-50 p-2 text-[11px] text-slate-700">
            {record.workflowNotes}
          </pre>
        </details>
      ) : null}
    </PortalRecordCard>
  );
}
