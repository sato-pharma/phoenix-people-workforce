"use client";

import * as React from "react";

import { AdminSectionHeader } from "@/components/admin/admin-design-system";
import { adminPanelClassName } from "@/components/admin/admin-design-tokens";
import {
  PortalDesktopTable,
  PortalEmptyState,
  PortalResponsiveDataList,
} from "@/components/employee-portal/portal-primitives";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  SortableTh,
  TableSearchInput,
  useSortableTable,
  type SortableColumn,
} from "@/components/ui/sortable-table";
import {
  ResignationDaysCell,
  ResignationStatusBadge,
} from "@/components/resignations/resignation-badges";
import {
  PayrollCandidateRecordCard,
  ResignationRecordCard,
} from "@/components/resignations/resignation-cards";
import {
  ResignationWorkflowActions,
  type ResignationActionHandlers,
} from "@/components/resignations/resignation-workflow-actions";
import {
  formatPayoutMonth,
  formatPayrollCandidateSystemId,
  formatResignationDate,
  isTerminatedResignation,
  queueRowEffectiveDate,
  queueRowEmployeeName,
  queueRowLineName,
  queueRowSearchText,
  queueRowStatus,
  queueRowSubmittedDate,
  resignationActorLabel,
  resignationDaysState,
  type ResignationQueueRow,
} from "@/lib/resignations/view-model";
import { formatEmployeeDisplayName } from "@/lib/utils";

// "Days Left" sorts by the effective DATE, not by a freshly computed day count: the two orderings
// are identical (days-left decreases monotonically with the date), and keeping the clock out of
// the sort accessor means the server render and the browser render can never disagree on row order.
const queueColumns: SortableColumn<ResignationQueueRow>[] = [
  { accessor: queueRowEmployeeName, key: "employee", type: "string" },
  { accessor: queueRowLineName, key: "line", type: "string" },
  { accessor: queueRowSubmittedDate, key: "submitted", type: "date" },
  { accessor: queueRowEffectiveDate, key: "effective", type: "date" },
  { accessor: queueRowEffectiveDate, key: "daysLeft", type: "date" },
  { accessor: queueRowStatus, key: "status", type: "string" },
];

const searchAccessors = [queueRowSearchText];

function EmployeeCell({
  hrId,
  jobTitle,
  name,
}: {
  hrId: string;
  jobTitle: string | null;
  name: string;
}) {
  return (
    <td className="px-3 py-4">
      <p className="whitespace-nowrap font-medium text-[#0F172A]">
        {formatEmployeeDisplayName(name)}
      </p>
      <p className="mt-1 whitespace-nowrap font-mono text-xs text-[#64748B]">{hrId || "No HR ID"}</p>
      <p className="mt-1 whitespace-nowrap text-xs text-[#64748B]">{jobTitle ?? "-"}</p>
    </td>
  );
}

export function ResignationWorkflowQueue({
  rows,
  ...handlers
}: ResignationActionHandlers & { rows: readonly ResignationQueueRow[] }) {
  const source = React.useMemo(() => [...rows], [rows]);
  const table = useSortableTable(source, {
    columns: queueColumns,
    initialSort: { dir: "desc", key: "submitted" },
    searchAccessors,
    secondarySort: { accessor: queueRowEmployeeName, key: "employee", type: "string" },
  });

  const candidateCount = table.rows.filter((row) => row.kind === "payrollCandidate").length;
  const resignationCount = table.rows.length - candidateCount;
  const terminatedCount = table.rows.filter(
    (row) => row.kind === "resignation" && isTerminatedResignation(row.record),
  ).length;

  return (
    <Card className={`${adminPanelClassName} overflow-hidden p-0`}>
      <AdminSectionHeader
        action={
          <div className="flex flex-wrap items-center gap-2">
            <TableSearchInput
              className="w-full sm:w-64"
              onChange={table.setQuery}
              onClear={table.clearQuery}
              placeholder="Search employee, HR ID, reason…"
              size="md"
              value={table.query}
            />
            <Badge variant="neutral">{table.visible} visible</Badge>
            <Badge variant="neutral">{candidateCount} payroll candidates</Badge>
            {terminatedCount > 0 ? (
              <Badge variant="danger">{terminatedCount} terminated</Badge>
            ) : null}
          </div>
        }
        description={`Showing ${resignationCount} workflow records and ${candidateCount} payroll upload candidates in one queue. Terminated Employees — exits that came through probation or another lifecycle path — are highlighted in place rather than split into a separate table.`}
        title="Workflow Queue"
      />

      <PortalResponsiveDataList
        empty={
          <PortalEmptyState
            message={
              table.isFiltered
                ? "No resignation or payroll candidate rows match your search."
                : "No resignation or payroll candidate rows match the current filters."
            }
            title="No workflow rows"
          />
        }
        getKey={(row) => row.key}
        items={table.rows}
        renderCard={(row) =>
          row.kind === "payrollCandidate" ? (
            <PayrollCandidateRecordCard candidate={row.candidate} />
          ) : (
            <ResignationRecordCard record={row.record} {...handlers} />
          )
        }
        renderTable={() => (
          <PortalDesktopTable minWidth="1280px">
            <thead>
              <tr>
                <SortableTh label="Employee" onSort={table.toggleSort} sort={table.sort} sortKey="employee" />
                <SortableTh label="Line" onSort={table.toggleSort} sort={table.sort} sortKey="line" />
                <SortableTh label="Submitted" onSort={table.toggleSort} sort={table.sort} sortKey="submitted" />
                <SortableTh label="Effective" onSort={table.toggleSort} sort={table.sort} sortKey="effective" />
                <SortableTh label="Days Left" onSort={table.toggleSort} sort={table.sort} sortKey="daysLeft" />
                <SortableTh label="Status" onSort={table.toggleSort} sort={table.sort} sortKey="status" />
                <SortableTh label="Reason" />
                <SortableTh label="Audit" />
                <SortableTh label="Workflow" />
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row) => {
                if (row.kind === "payrollCandidate") {
                  const { candidate } = row;
                  const candidateSystemId = formatPayrollCandidateSystemId(candidate.id);

                  return (
                    <tr className="align-top" key={row.key}>
                      <EmployeeCell
                        hrId={candidate.hrId}
                        jobTitle={candidate.jobTitle}
                        name={candidate.employeeName}
                      />
                      <td className="whitespace-nowrap px-3 py-4 text-[#64748B]">
                        {candidate.lineName ?? "-"}
                      </td>
                      <td className="whitespace-nowrap px-3 py-4 text-[#64748B]">
                        <p>{formatResignationDate(candidate.lastSeenAt.slice(0, 10))}</p>
                        <p className="mt-1 text-xs">Last seen in payroll</p>
                      </td>
                      <td className="whitespace-nowrap px-3 py-4 text-[#64748B]">
                        <p>{formatPayoutMonth(candidate.lastPayoutMonth, candidate.lastPayoutYear)}</p>
                        <p className="mt-1 text-xs">Last payout</p>
                      </td>
                      <td className="whitespace-nowrap px-3 py-4">
                        <Badge variant="neutral">System generated</Badge>
                      </td>
                      <td className="whitespace-nowrap px-3 py-4">
                        <Badge variant="neutral">Payroll candidate</Badge>
                      </td>
                      <td className="px-3 py-4 text-[#64748B]">
                        <p className="whitespace-nowrap font-medium text-text">
                          Payroll upload generated a resignation candidate.
                        </p>
                        <p className="mt-1 whitespace-nowrap text-xs">
                          Area: {candidate.areaName ?? "-"} | Hiring:{" "}
                          {formatResignationDate(candidate.hireDate)}
                        </p>
                      </td>
                      <td className="px-3 py-4 text-xs text-[#64748B]">
                        <p className="whitespace-nowrap">System ID: {candidateSystemId}</p>
                        <p className="whitespace-nowrap">Source: {candidate.sourceFileName ?? "-"}</p>
                        <p className="mt-1 whitespace-nowrap">Row: {candidate.sourceRow ?? "-"}</p>
                        <p className="mt-1 whitespace-nowrap">
                          Updated: {formatResignationDate(candidate.updatedAt.slice(0, 10))}
                        </p>
                      </td>
                      <td className="px-3 py-4 text-xs font-semibold text-[#475569]">
                        System resignation candidate ID: {candidateSystemId}. No manual HR ID
                        generation is required.
                      </td>
                    </tr>
                  );
                }

                const { record } = row;
                const daysState = resignationDaysState(record);
                const terminated = isTerminatedResignation(record);

                return (
                  <tr
                    className={`align-top ${terminated ? "bg-rose-50/70" : ""}`}
                    key={row.key}
                  >
                    <EmployeeCell
                      hrId={record.employeeHrId}
                      jobTitle={record.jobTitle}
                      name={record.employeeName}
                    />
                    <td className="whitespace-nowrap px-3 py-4 text-[#64748B]">
                      {record.lineName ?? "-"}
                    </td>
                    <td className="whitespace-nowrap px-3 py-4 text-[#64748B]">
                      {formatResignationDate(record.submittedDate)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-4 text-[#64748B]">
                      {formatResignationDate(record.effectiveDate)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-4">
                      <ResignationDaysCell state={daysState} />
                    </td>
                    <td className="whitespace-nowrap px-3 py-4">
                      <ResignationStatusBadge status={record.status} />
                      {terminated ? (
                        <p className="mt-1">
                          <Badge variant="danger">Terminated</Badge>
                        </p>
                      ) : null}
                    </td>
                    <td className="px-3 py-4 text-[#64748B]">
                      <p className="whitespace-nowrap font-medium text-text">
                        {record.reason ?? "-"}
                      </p>
                      {record.rejectedReason ? (
                        <p className="mt-2 whitespace-nowrap bg-[#FEF2F2] px-2 py-1 text-xs text-[#991B1B]">
                          Rejection: {record.rejectedReason}
                        </p>
                      ) : null}
                    </td>
                    <td className="px-3 py-4 text-xs text-[#64748B]">
                      <p className="whitespace-nowrap">
                        Created by: {resignationActorLabel(record)}
                      </p>
                      <p className="mt-1 whitespace-nowrap">
                        Updated: {formatResignationDate(record.updatedAt.slice(0, 10))}
                      </p>
                      {record.workflowNotes ? (
                        <details className="mt-2">
                          <summary className="cursor-pointer text-[#C2410C]">View notes</summary>
                          <pre className="mt-2 overflow-x-auto whitespace-pre border border-[#E2E8F0] bg-[#F8FAFC] p-2 text-[11px] text-[#0F172A]">
                            {record.workflowNotes}
                          </pre>
                        </details>
                      ) : null}
                    </td>
                    <td className="px-3 py-4">
                      <ResignationWorkflowActions record={record} {...handlers} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </PortalDesktopTable>
        )}
      />
    </Card>
  );
}
