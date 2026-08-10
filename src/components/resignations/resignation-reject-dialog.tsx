"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { ResignationDialog } from "@/components/resignations/resignation-dialog";
import { formatResignationDate } from "@/lib/resignations/view-model";
import type { ResignationRecord } from "@/lib/resignations/types";
import { formatEmployeeDisplayName } from "@/lib/utils";

/**
 * Rejection reason capture. Replaces the browser's native prompt dialog, which ignored the admin
 * shell entirely, could not show which person was being rejected, and offered no way to require a
 * reason — every rejection reason on production is currently blank.
 */
export function ResignationRejectDialog({
  busy,
  onCancel,
  onConfirm,
  record,
}: {
  busy: boolean;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
  record: ResignationRecord;
}) {
  const [reason, setReason] = React.useState(record.rejectedReason ?? "");
  const trimmed = reason.trim();

  return (
    <ResignationDialog
      ariaLabel={`Reject resignation — ${record.employeeName}`}
      footer={
        <>
          <Button className="h-9 px-4 text-xs" disabled={busy} onClick={onCancel} variant="secondary">
            Cancel
          </Button>
          <Button
            className="h-9 px-4 text-xs"
            disabled={busy || trimmed.length === 0}
            onClick={() => onConfirm(trimmed)}
            variant="destructive"
          >
            Reject Resignation
          </Button>
        </>
      }
      onClose={onCancel}
      subtitle={
        <span className="whitespace-nowrap">
          {formatEmployeeDisplayName(record.employeeName)} · {record.employeeHrId} · effective{" "}
          {formatResignationDate(record.effectiveDate)}
        </span>
      }
      title="Reject resignation"
    >
      <label className="block">
        <span className="mb-1.5 block text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]">
          Why is this resignation being rejected?
        </span>
        <textarea
          className="min-h-28 w-full border border-[#D8E0EA] bg-white px-3 py-2 text-sm text-[#0F172A] outline-none transition focus:border-[#FDBA74] focus:ring-2 focus:ring-[#F97316]/15"
          onChange={(event) => setReason(event.target.value)}
          placeholder="This is stored on the record and shown to whoever reviews it next."
          value={reason}
        />
      </label>
      <p className="mt-2 text-xs font-semibold text-slate-500">
        A reason is required — it becomes the permanent audit note for this rejection.
      </p>
    </ResignationDialog>
  );
}
