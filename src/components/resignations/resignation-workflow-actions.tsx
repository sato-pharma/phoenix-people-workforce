"use client";

import { CalendarDays, Pencil, Save } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { adminInsetPanelClassName } from "@/components/admin/admin-design-tokens";
import type { ResignationRecord, ResignationWorkflowAction } from "@/lib/resignations/types";

export type ResignationDateEdit = {
  effectiveDate: string;
  recordId: string;
  submittedDate: string;
};

export type ResignationActionHandlers = {
  busyAction: string | null;
  editingDates: ResignationDateEdit | null;
  onCancelDateEdit: () => void;
  onRunAction: (
    record: ResignationRecord,
    action: ResignationWorkflowAction,
    options?: { note?: string; rejectedReason?: string },
  ) => Promise<void>;
  /** Opens the rejection dialog. Rejection reasons are captured in a real modal, never a prompt(). */
  onRequestReject: (record: ResignationRecord) => void;
  onSaveDateEdit: (record: ResignationRecord) => Promise<void>;
  onStartDateEdit: (record: ResignationRecord) => void;
  onUpdateEditingDate: (key: "effectiveDate" | "submittedDate", value: string) => void;
};

const dateFieldLabelClassName =
  "mb-1 block text-[10px] font-black uppercase tracking-[0.12em] text-[#64748B]";

/**
 * Workflow buttons + the inline date-edit panel for one resignation row. Rendered by BOTH the
 * desktop table's Workflow column and the mobile card's actions slot, so the two surfaces can
 * never drift apart on which action is offered for which status.
 */
export function ResignationWorkflowActions({
  busyAction,
  editingDates,
  onCancelDateEdit,
  onRequestReject,
  onRunAction,
  onSaveDateEdit,
  onStartDateEdit,
  onUpdateEditingDate,
  record,
}: ResignationActionHandlers & { record: ResignationRecord }) {
  const isBusy = Boolean(busyAction?.startsWith(`${record.id}:`));
  const isEditingDates = editingDates?.recordId === record.id;
  const canDecide = record.status === "submitted" || record.status === "under_review";
  const canReopen =
    record.status === "approved" || record.status === "rejected" || record.status === "cancelled";
  const canCancel = record.status !== "completed" && record.status !== "cancelled";

  return (
    <>
      {isEditingDates && editingDates ? (
        <div className={`${adminInsetPanelClassName} mb-3 min-w-[260px] p-3`}>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="block">
              <span className={dateFieldLabelClassName}>Submitted</span>
              <Input
                className="h-9 px-2 text-xs"
                onChange={(event) => onUpdateEditingDate("submittedDate", event.target.value)}
                type="date"
                value={editingDates.submittedDate}
              />
            </label>
            <label className="block">
              <span className={dateFieldLabelClassName}>Effective</span>
              <Input
                className="h-9 px-2 text-xs"
                onChange={(event) => onUpdateEditingDate("effectiveDate", event.target.value)}
                type="date"
                value={editingDates.effectiveDate}
              />
            </label>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              className="h-8 gap-1.5 px-3 text-xs"
              disabled={isBusy}
              onClick={() => void onSaveDateEdit(record)}
            >
              <Save className="h-3.5 w-3.5" />
              Save
            </Button>
            <Button
              className="h-8 px-3 text-xs"
              disabled={isBusy}
              onClick={onCancelDateEdit}
              variant="secondary"
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button
          className="h-9 gap-1.5 whitespace-nowrap px-3 text-xs"
          disabled={isBusy}
          onClick={() => onStartDateEdit(record)}
          variant="secondary"
        >
          {isEditingDates ? (
            <CalendarDays className="h-3.5 w-3.5" />
          ) : (
            <Pencil className="h-3.5 w-3.5" />
          )}
          Edit Dates
        </Button>

        {record.status === "submitted" ? (
          <Button
            className="h-9 whitespace-nowrap px-3 text-xs"
            disabled={isBusy}
            onClick={() => void onRunAction(record, "mark_review")}
            variant="secondary"
          >
            Review
          </Button>
        ) : null}

        {canDecide ? (
          <>
            <Button
              className="h-9 whitespace-nowrap px-3 text-xs"
              disabled={isBusy}
              onClick={() => void onRunAction(record, "approve")}
            >
              Approve
            </Button>
            <Button
              className="h-9 whitespace-nowrap px-3 text-xs"
              disabled={isBusy}
              onClick={() => onRequestReject(record)}
              variant="destructive"
            >
              Reject
            </Button>
          </>
        ) : null}

        {record.status === "approved" ? (
          <Button
            className="h-9 whitespace-nowrap px-3 text-xs"
            disabled={isBusy}
            onClick={() => void onRunAction(record, "complete")}
          >
            Complete
          </Button>
        ) : null}

        {canReopen ? (
          <Button
            className="h-9 whitespace-nowrap px-3 text-xs"
            disabled={isBusy}
            onClick={() => void onRunAction(record, "reopen")}
            variant="secondary"
          >
            Reopen
          </Button>
        ) : null}

        {canCancel ? (
          <Button
            className="h-9 whitespace-nowrap px-3 text-xs"
            disabled={isBusy}
            onClick={() => void onRunAction(record, "cancel")}
            variant="secondary"
          >
            Cancel
          </Button>
        ) : null}
      </div>
    </>
  );
}
