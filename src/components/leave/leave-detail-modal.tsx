"use client";

import type { ReactNode } from "react";
import { useState } from "react";
import { FileText, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import type { LeaveRequest } from "@/lib/leave/types";

import {
  formatDate,
  isRenderableLeaveAttachmentReference,
  prettyStatus,
  statusVariant,
} from "./leave-ui-primitives";

function paymentStatusLabel(status: LeaveRequest["paymentStatus"]) {
  if (status === "paid") return "Paid";
  if (status === "unpaid") return "Unpaid";
  if (status === "non_deducted") return "Non-Deducted";
  return "In Review";
}

export function LeaveDetailModal({
  actions,
  onClose,
  request,
}: {
  actions?: ReactNode;
  onClose: () => void;
  request: LeaveRequest | null;
}) {
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [isOpeningAttachment, setIsOpeningAttachment] = useState(false);
  if (!request) return null;
  const selectedRequest = request;
  const hasLocalAttachment = isRenderableLeaveAttachmentReference(selectedRequest.attachmentUrl);
  const hasPrivateAttachment = Boolean(selectedRequest.attachmentUrl && !hasLocalAttachment);

  async function openAttachment() {
    setAttachmentError(null);
    setIsOpeningAttachment(true);
    try {
      const response = await fetch(`/api/leave/requests/${selectedRequest.id}/attachment`);
      const payload = await response.json();
      if (!response.ok || !payload.url) throw new Error(payload.error ?? "Unable to prepare attachment link.");
      window.open(payload.url, "_blank", "noopener,noreferrer");
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : "Unable to open attachment.");
    } finally {
      setIsOpeningAttachment(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/40 p-3 backdrop-blur-sm sm:items-center">
      <div className="max-h-[92vh] w-full max-w-3xl overflow-hidden rounded-[22px] border border-slate-200 bg-white shadow-[0_24px_70px_rgba(15,23,42,0.28)]">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4">
          <div>
            <p className="text-[10px] font-black uppercase tracking-[0.18em] text-orange-600">{selectedRequest.leaveType?.name ?? "Leave"}</p>
            <h3 className="mt-1 text-xl font-black tracking-tight text-slate-950">{selectedRequest.employee?.fullName ?? selectedRequest.employeeHrId}</h3>
          </div>
          <button className="flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 text-slate-500 hover:bg-slate-50" onClick={onClose} type="button">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="max-h-[72vh] overflow-y-auto p-5">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              ["HR ID", selectedRequest.employeeHrId],
              ["From", formatDate(selectedRequest.startDate)],
              ["To", formatDate(selectedRequest.endDate)],
              ["Working Days", selectedRequest.totalWorkingDays],
              ["Day Portion", selectedRequest.durationUnit === "full_day" ? "Full Day" : selectedRequest.durationUnit.toUpperCase()],
              ["Payment", paymentStatusLabel(selectedRequest.paymentStatus)],
              ["Manager", prettyStatus(selectedRequest.managerStatus)],
              ["HR", prettyStatus(selectedRequest.hrStatus)],
              ["Payroll", prettyStatus(selectedRequest.payrollStatus)],
              ["Status", prettyStatus(selectedRequest.status)],
            ].map(([label, value]) => (
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3" key={String(label)}>
                <p className="text-[10px] font-black uppercase tracking-[0.14em] text-slate-400">{label}</p>
                <p className="mt-1 text-sm font-black text-slate-900">{value}</p>
              </div>
            ))}
          </div>
          <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
            <p className="text-[10px] font-black uppercase tracking-[0.14em] text-slate-400">Reason / Comment</p>
            <p className="mt-2 text-sm leading-6 text-slate-700">{selectedRequest.reason || "No reason provided."}</p>
            {selectedRequest.paymentReason ? (
              <p className="mt-3 rounded-xl border border-orange-100 bg-orange-50 px-3 py-2 text-sm font-bold text-orange-700">{selectedRequest.paymentReason}</p>
            ) : null}
            {selectedRequest.attachmentUrl ? (
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <button className="inline-flex items-center gap-2 rounded-xl border border-orange-200 bg-orange-50 px-3 py-2 text-sm font-black text-orange-700 hover:bg-orange-100" disabled={isOpeningAttachment} onClick={openAttachment} type="button">
                  <FileText className="h-4 w-4" />
                  {isOpeningAttachment ? "Preparing..." : "Open attachment"}
                </button>
                <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-black text-slate-500">
                  {hasPrivateAttachment ? "Private File" : "Local File"}
                </span>
              </div>
            ) : null}
            {attachmentError ? <p className="mt-2 rounded-xl border border-rose-100 bg-rose-50 px-3 py-2 text-sm font-bold text-rose-700">{attachmentError}</p> : null}
            {hasPrivateAttachment ? <p className="mt-3 text-sm font-bold text-slate-500">Attachment is stored privately; Phoenix creates a short-lived signed URL after access validation.</p> : null}
          </div>
          {actions ? (
            <div className="mt-4 rounded-xl border border-orange-100 bg-orange-50 p-4">
              <p className="text-[10px] font-black uppercase tracking-[0.14em] text-orange-600">Decision Controls</p>
              <div className="mt-3 flex flex-wrap gap-2">{actions}</div>
            </div>
          ) : null}
          <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
            <p className="text-[10px] font-black uppercase tracking-[0.14em] text-slate-400">Approval History</p>
            <div className="mt-3 space-y-3">
              {selectedRequest.approvalHistory?.length ? selectedRequest.approvalHistory.map((approval) => (
                <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3" key={approval.id}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-black text-slate-900">{approval.approverRole} - {approval.approverHrId}</p>
                    <Badge variant={statusVariant(approval.status)}>{approval.status}</Badge>
                  </div>
                  <p className="mt-1 text-xs font-semibold text-slate-500">{new Date(approval.actionDate).toLocaleString()}</p>
                  {approval.comment ? <p className="mt-2 text-sm text-slate-700">{approval.comment}</p> : null}
                </div>
              )) : (
                <p className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-center text-sm font-semibold text-slate-500">No decisions recorded yet.</p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
