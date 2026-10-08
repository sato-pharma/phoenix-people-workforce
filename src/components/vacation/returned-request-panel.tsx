"use client";

import { useState } from "react";

import {
  phxButtonAccentClassName,
  phxButtonGhostClassName,
  phxFieldClassName,
  phxLabelClassName,
  phxSelectClassName,
  phxTextareaClassName,
} from "@/components/ui/form-tokens";
import { VACATION_DAY_PARTS } from "@/lib/vacation/types";
import type { VacationDayPart, VacationRequestRecord } from "@/lib/vacation/types";

/** What the employee sends back. Every field is the value to store; the server keeps what is unchanged. */
export type ReturnedRequestEdits = {
  dayPart: VacationDayPart;
  employeeNote: string;
  endDate: string;
  otherReason?: string;
  startDate: string;
};

/**
 * A request an approver sent back for editing, as the employee who filed it sees it: what the
 * approver said, then two ways forward — resubmit as it stands, or change it first. The leave type
 * is not offered: it decides the evidence and the approval chain, so a wrong one is a new request.
 */
export function ReturnedRequestPanel({
  busy,
  onResubmit,
  row,
}: {
  busy: boolean;
  onResubmit: (row: VacationRequestRecord, edits: ReturnedRequestEdits | null) => void;
  row: VacationRequestRecord;
}) {
  const [editing, setEditing] = useState(false);
  const [startDate, setStartDate] = useState(row.startDate);
  const [endDate, setEndDate] = useState(row.endDate);
  const [dayPart, setDayPart] = useState<VacationDayPart>(row.dayPart);
  const [employeeNote, setEmployeeNote] = useState(row.employeeNote ?? "");
  const [otherReason, setOtherReason] = useState(row.notes ?? "");
  const isOther = row.vacationType === "other";
  const comment = row.managerDecisionComment?.trim();
  const fieldId = `returned-${row.id}`;

  return (
    <div className="mt-2.5 space-y-2 border border-amber-200 bg-amber-50 p-2.5">
      <p className="text-phx-xs font-bold text-amber-900">
        Sent back for editing{comment ? ` — "${comment}"` : ". No comment was left; see the timeline for who returned it."}
      </p>
      {editing ? (
        <div className="space-y-3 border-t border-amber-200 pt-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className={phxLabelClassName} htmlFor={`${fieldId}-start`}>From</label>
              <input
                className={phxFieldClassName}
                id={`${fieldId}-start`}
                onChange={(event) => setStartDate(event.target.value)}
                type="date"
                value={startDate}
              />
            </div>
            <div>
              <label className={phxLabelClassName} htmlFor={`${fieldId}-end`}>To</label>
              <input
                className={phxFieldClassName}
                id={`${fieldId}-end`}
                min={startDate || undefined}
                onChange={(event) => setEndDate(event.target.value)}
                type="date"
                value={endDate}
              />
            </div>
          </div>
          <div>
            <label className={phxLabelClassName} htmlFor={`${fieldId}-part`}>Day part</label>
            <select
              className={phxSelectClassName}
              id={`${fieldId}-part`}
              onChange={(event) => setDayPart(event.target.value as VacationDayPart)}
              value={dayPart}
            >
              {VACATION_DAY_PARTS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </div>
          {isOther ? (
            <div>
              <label className={phxLabelClassName} htmlFor={`${fieldId}-reason`}>Reason for HR</label>
              <textarea
                className={phxTextareaClassName}
                id={`${fieldId}-reason`}
                onChange={(event) => setOtherReason(event.target.value)}
                rows={3}
                value={otherReason}
              />
            </div>
          ) : null}
          <div>
            <label className={phxLabelClassName} htmlFor={`${fieldId}-note`}>Note to your approvers</label>
            <textarea
              className={phxTextareaClassName}
              id={`${fieldId}-note`}
              onChange={(event) => setEmployeeNote(event.target.value)}
              rows={2}
              value={employeeNote}
            />
          </div>
          <p className="text-phx-xs font-medium text-amber-900">
            Changing the dates starts the approval again from the first approver.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              className={phxButtonAccentClassName}
              disabled={busy || !startDate || !endDate}
              onClick={() =>
                onResubmit(row, {
                  dayPart,
                  employeeNote,
                  endDate,
                  ...(isOther ? { otherReason } : {}),
                  startDate,
                })
              }
              type="button"
            >
              Save changes and resubmit
            </button>
            <button className={phxButtonGhostClassName} disabled={busy} onClick={() => setEditing(false)} type="button">
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button
            className={phxButtonAccentClassName}
            disabled={busy}
            onClick={() => setEditing(true)}
            type="button"
          >
            Edit and resubmit
          </button>
          <button
            className={phxButtonGhostClassName}
            disabled={busy}
            onClick={() => onResubmit(row, null)}
            type="button"
          >
            Resubmit without changes
          </button>
        </div>
      )}
    </div>
  );
}
