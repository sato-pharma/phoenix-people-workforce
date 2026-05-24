"use client";

import {
  CalendarDays,
  Camera,
  CheckCircle2,
  Clock,
  Edit2,
  Eye,
  ExternalLink,
  FileText,
  Loader2,
  MapPinned,
  PlusCircle,
  Search,
  ShieldAlert,
  Trash2,
  XCircle,
} from "lucide-react";
import { useSearchParams } from "next/navigation";
import type { ReactNode } from "react";
import { startTransition, useEffect, useMemo, useState } from "react";

import { AdminManagerExpenseModal } from "@/components/outstation/admin-manager-expense-modal";

import { AdminCallout } from "@/components/admin/admin-design-system";
import { OutstationReviewMap } from "@/components/outstation/outstation-review-map";
import { TerritoryValidationPanel } from "@/components/outstation/territory-validation-panel";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { OutstationExpenseRequest } from "@/lib/outstation/types";
import { formatEmployeeDisplayName } from "@/lib/utils";

type AdminAction = "approve" | "delete" | "reject";

type ActionPayload = {
  linkedPayroll?: {
    deletedRows?: number;
    expenseTripId?: string;
  };
  message?: string;
  request?: OutstationExpenseRequest;
};

function formatCurrency(value: number) {
  return new Intl.NumberFormat("en-US", {
    currency: "EGP",
    maximumFractionDigits: 0,
    style: "currency",
  }).format(Number.isFinite(value) ? value : 0);
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "N/A";
  return date.toLocaleDateString();
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "N/A";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "N/A";
  return date.toLocaleString();
}

function formatEvidenceDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "N/A";
  return date.toLocaleString();
}

function formatKm(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "N/A";
  return `${value.toFixed(2)} KM`;
}

function formatStatus(value: string) {
  return value.replace(/_/g, " ");
}

function parseRequestId(value: string | null) {
  if (!value) return null;
  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : null;
}

function statusTone(status: string) {
  const normalized = status.toLowerCase();
  if (normalized === "eligible") return "bg-[#ECFDF5] text-[#047857] ring-[#A7F3D0]";
  if (normalized === "not_eligible") return "bg-[#FEF2F2] text-[#B91C1C] ring-[#FECACA]";
  return "bg-[#FFF7ED] text-[#C2410C] ring-[#FED7AA]";
}

function requestStatusTone(status: string) {
  const normalized = status.toLowerCase();
  if (normalized === "approved") return "bg-[#ECFDF5] text-[#047857] ring-[#A7F3D0]";
  if (normalized === "rejected") return "bg-[#FEF2F2] text-[#B91C1C] ring-[#FECACA]";
  return "bg-[#FFF7ED] text-[#C2410C] ring-[#FED7AA]";
}

function recommendationTone(value: string) {
  const normalized = value.toLowerCase();
  if (normalized === "auto_approve") return "text-[#047857]";
  if (normalized === "finance_review") return "text-[#1D4ED8]";
  if (normalized === "reject") return "text-[#B91C1C]";
  return "text-[#C2410C]";
}

const panelClassName =
  "rounded-none border border-[#D8E0EA]/90 bg-white/90 shadow-[0_22px_60px_rgba(15,23,42,0.09)] ring-1 ring-white/70 backdrop-blur-xl";
const adminTableHeaderClassName = "px-4 py-3 text-[10px] font-black uppercase tracking-[0.18em] text-[#64748B]";
const stickyEmployeeHeaderClassName = `${adminTableHeaderClassName} sticky left-0 z-30 w-[260px] min-w-[260px] bg-[#F8FAFC] shadow-[10px_0_18px_rgba(15,23,42,0.06)]`;
const stickyTripHeaderClassName = `${adminTableHeaderClassName} sticky left-[260px] z-30 w-[220px] min-w-[220px] bg-[#F8FAFC] shadow-[10px_0_18px_rgba(15,23,42,0.04)]`;
const stickyEmployeeCellClassName = "sticky left-0 z-20 w-[260px] min-w-[260px] px-4 py-3 shadow-[10px_0_18px_rgba(15,23,42,0.05)]";
const stickyTripCellClassName = "sticky left-[260px] z-20 w-[220px] min-w-[220px] px-4 py-3 shadow-[10px_0_18px_rgba(15,23,42,0.04)]";

function OutstationAdminShell({ children }: { children: ReactNode }) {
  return (
    <div className="relative isolate min-h-[calc(100vh-8rem)] overflow-hidden rounded-none border border-[#D8E0EA] bg-[radial-gradient(circle_at_8%_0%,rgba(249,115,22,0.18),transparent_30%),radial-gradient(circle_at_86%_12%,rgba(15,23,42,0.10),transparent_26%),linear-gradient(135deg,#FFF9F3_0%,#FFFFFF_46%,#F3F7FB_100%)] p-4 shadow-[0_28px_80px_rgba(15,23,42,0.12)] sm:p-6">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-24 -top-28 h-72 w-72 rotate-12 bg-[#F97316]/12 blur-3xl"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute bottom-10 left-1/4 h-64 w-64 -rotate-12 bg-[#0F172A]/6 blur-3xl"
      />
      <div className="relative z-10 space-y-5">{children}</div>
    </div>
  );
}

function Metric({
  label,
  tone = "slate",
  value,
}: {
  label: string;
  tone?: "blue" | "green" | "orange" | "red" | "slate";
  value: string;
}) {
  const toneClassName = {
    blue: "from-[#EFF6FF] to-white text-[#1D4ED8] ring-[#BFDBFE]",
    green: "from-[#ECFDF5] to-white text-[#047857] ring-[#A7F3D0]",
    orange: "from-[#FFF7ED] to-white text-[#EA580C] ring-[#FED7AA]",
    red: "from-[#FEF2F2] to-white text-[#B91C1C] ring-[#FECACA]",
    slate: "from-[#F8FAFC] to-white text-[#0F172A] ring-[#DDE6F1]",
  }[tone];

  return (
    <Card className={`${panelClassName} relative overflow-hidden bg-gradient-to-br ${toneClassName} p-4 transition duration-200 hover:-translate-y-0.5 hover:shadow-[0_26px_70px_rgba(15,23,42,0.12)]`}>
      <div aria-hidden="true" className="absolute -right-8 -top-8 h-20 w-20 rotate-12 bg-current opacity-[0.07]" />
      <p className="relative text-[10px] font-black uppercase tracking-[0.18em] text-[#64748B]">{label}</p>
      <p className="relative mt-2 truncate text-xl font-black text-[#0F172A]">{value}</p>
    </Card>
  );
}

function SharpPageHero({
  actions,
  badges,
  description,
  eyebrow,
  icon,
  title,
}: {
  actions?: ReactNode;
  badges?: ReactNode;
  description: string;
  eyebrow: string;
  icon?: ReactNode;
  title: string;
}) {
  return (
    <Card className={`${panelClassName} overflow-hidden p-0`}>
      <div className="border-l-4 border-[#EA580C] bg-[linear-gradient(135deg,#FFFFFF_0%,#FFF7ED_42%,#F8FAFC_100%)] px-4 py-4 sm:px-5 lg:px-6">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0 space-y-3">
            <div className="inline-flex w-fit items-center gap-2 border border-[#FED7AA] bg-[#FFF7ED] px-3 py-1 text-[10px] font-black uppercase tracking-[0.24em] text-[#C2410C]">
              {icon}
              {eyebrow}
            </div>
            <div className="space-y-2">
              <h1 className="max-w-4xl text-[1.45rem] font-black tracking-[-0.04em] text-[#0F172A] sm:text-[1.7rem] lg:text-[1.9rem]">
                {title}
              </h1>
              <p className="max-w-3xl text-sm leading-6 text-[#475569]">{description}</p>
            </div>
          </div>
          {actions ? (
            <div className="flex w-full flex-wrap items-stretch gap-2 sm:w-auto sm:items-center xl:max-w-[46%] xl:justify-end">{actions}</div>
          ) : null}
        </div>
        {badges ? <div className="mt-4 flex flex-wrap gap-2 text-xs text-[#475569]">{badges}</div> : null}
      </div>
    </Card>
  );
}

function SharpTableShell({
  action,
  children,
  description,
  title,
}: {
  action?: ReactNode;
  children: ReactNode;
  description: string;
  title: string;
}) {
  return (
    <Card className={`${panelClassName} overflow-hidden p-0`}>
      <div className="flex flex-col gap-4 border-b border-[#D8E0EA] bg-[linear-gradient(180deg,#FFFFFF_0%,#F8FAFC_100%)] px-5 py-5 sm:flex-row sm:items-start sm:justify-between sm:px-6">
        <div>
          <div className="flex items-center gap-2.5">
            <span className="h-7 w-1 bg-[#EA580C] shadow-[0_0_12px_rgba(249,115,22,0.35)]" />
            <h2 className="text-lg font-black tracking-tight text-[#0F172A]">{title}</h2>
          </div>
          <p className="mt-2 text-sm leading-6 text-[#64748B]">{description}</p>
        </div>
        {action ? <div className="w-full shrink-0 sm:w-auto">{action}</div> : null}
      </div>
      {children}
    </Card>
  );
}

function Info({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-none border border-[#E2E8F0] bg-[#F8FAFC]/85 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.75)]">
      <p className="text-[11px] font-black uppercase tracking-[0.16em] text-[#64748B]">{label}</p>
      <p className="mt-2 text-sm font-semibold text-[#0F172A]">{value}</p>
    </div>
  );
}

function RequestActionButtons({
  actionMessage,
  acting,
  actionError,
  onApprove,
  onDelete,
  onReject,
  request,
}: {
  actionError: string | null;
  actionMessage: string | null;
  acting: { action: AdminAction; id: number } | null;
  onApprove: (request: OutstationExpenseRequest) => void;
  onDelete: (request: OutstationExpenseRequest) => void;
  onReject: (request: OutstationExpenseRequest) => void;
  request: OutstationExpenseRequest;
}) {
  const busy = acting?.id === request.id;
  const approving = busy && acting?.action === "approve";
  const deleting = busy && acting?.action === "delete";
  const rejecting = busy && acting?.action === "reject";
  const terminal = request.status === "approved" || request.status === "rejected";

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          className="gap-2 rounded-none bg-[#047857] px-4 py-2 text-xs font-black text-white hover:bg-[#065F46]"
          disabled={busy || terminal || request.eligibilityStatus === "not_eligible"}
          onClick={() => onApprove(request)}
          type="button"
        >
          {approving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
          Approve for payroll
        </Button>
        <Button
          className="gap-2 rounded-none bg-[#B91C1C] px-4 py-2 text-xs font-black text-white hover:bg-[#991B1B]"
          disabled={busy || terminal}
          onClick={() => onReject(request)}
          type="button"
        >
          {rejecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />}
          Reject
        </Button>
        <Button
          className="gap-2 rounded-none border border-[#FECACA] bg-white px-4 py-2 text-xs font-black text-[#B91C1C] hover:bg-[#FEF2F2]"
          disabled={busy}
          onClick={() => onDelete(request)}
          type="button"
        >
          {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
          Delete expense
        </Button>
      </div>
      {request.status === "approved" ? (
        <p className="text-xs font-black uppercase tracking-[0.12em] text-[#047857]">Approved for payroll</p>
      ) : null}
      {request.status === "rejected" ? (
        <p className="text-xs font-black uppercase tracking-[0.12em] text-[#B91C1C]">Rejected by admin review</p>
      ) : null}
      {actionMessage && busy ? <p className="text-sm font-semibold text-[#047857]">{actionMessage}</p> : null}
      {actionError && busy ? <p className="text-sm font-semibold text-[#B91C1C]">{actionError}</p> : null}
    </div>
  );
}

function RequestDetailsModal({
  actionError,
  actionMessage,
  acting,
  onApprove,
  onClose,
  onDelete,
  onReject,
  request,
}: {
  actionError: string | null;
  actionMessage: string | null;
  acting: { action: AdminAction; id: number } | null;
  onApprove: (request: OutstationExpenseRequest) => void;
  onClose: () => void;
  onDelete: (request: OutstationExpenseRequest) => void;
  onReject: (request: OutstationExpenseRequest) => void;
  request: OutstationExpenseRequest;
}) {
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center overflow-hidden bg-[#020617]/72 p-3 backdrop-blur-md sm:p-6">
      <div className="flex max-h-[calc(100dvh-1.5rem)] w-full max-w-7xl flex-col overflow-hidden rounded-none border border-[#D8E0EA] bg-white shadow-[0_28px_90px_rgba(15,23,42,0.3)] sm:max-h-[calc(100dvh-3rem)]">
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-[#E2E8F0] bg-white/98 px-5 py-4 backdrop-blur">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`inline-flex rounded-none px-3 py-1 text-xs font-bold ring-1 ${requestStatusTone(request.status)}`}>
                {formatStatus(request.status)}
              </span>
              <span className="rounded-none border border-[#FED7AA] bg-[#FFF7ED] px-3 py-1 text-xs font-black text-[#C2410C]">
                Request #{request.id}
              </span>
            </div>
            <h2 className="mt-2 text-2xl font-black text-[#0F172A]">
              {formatEmployeeDisplayName(request.employeeName)}
            </h2>
            <p className="mt-1 text-sm font-semibold text-[#64748B]">
              {request.employeeHrId} - {request.employeeRole} - {request.employeeLine ?? "No line"}
            </p>
          </div>
          <button
            className="shrink-0 rounded-none border border-[#E2E8F0] bg-white px-4 py-2 text-xs font-black text-[#64748B] hover:bg-[#F8FAFC]"
            onClick={onClose}
            type="button"
          >
            Close
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain p-5">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Info label="Trip date" value={`${formatDate(request.tripStartDate)} to ${formatDate(request.tripEndDate)}`} />
            <Info label="Submitted" value={formatDateTime(request.submittedAt ?? request.createdAt)} />
            <Info label="Captured time" value={formatDateTime(request.capturedAt)} />
            <Info label="GPS accuracy" value={`${request.capturedAccuracyMeters.toFixed(0)} meters`} />
            <Info label="Destination" value={request.toLabel ?? request.toCity ?? request.toArea ?? "N/A"} />
            <Info label="Residence" value={[request.residenceAddress, request.residenceArea, request.residenceCity].filter(Boolean).join(", ") || "Not saved"} />
            <Info label="Captured coordinates" value={`${request.capturedLatitude.toFixed(5)}, ${request.capturedLongitude.toFixed(5)}`} />
            <Info label="Residence coordinates" value={request.residenceLatitude != null && request.residenceLongitude != null ? `${request.residenceLatitude.toFixed(5)}, ${request.residenceLongitude.toFixed(5)}` : "N/A"} />
            <Info label="Distance" value={formatKm(request.distanceFromResidenceKm)} />
            <Info label="Duration" value={request.durationMinutes != null ? `${request.durationMinutes.toFixed(0)} mins` : "N/A"} />
            <Info label="Expected amount" value={formatCurrency(request.expectedTotalAmount)} />
            <Info label="Claimed amount" value={formatCurrency(request.claimedTotalAmount)} />
            <Info label="Variance" value={`${formatCurrency(request.varianceAmount)} (${request.variancePercent.toFixed(1)}%)`} />
            <Info label="Transportation" value={formatStatus(request.transportationType)} />
            <Info label="Expense type" value={formatStatus(request.expenseType)} />
            <Info label="Offline capture" value={request.offlineCaptured ? "Yes" : "No"} />
          </div>

          <div className="grid gap-5 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
            <Card className={`${panelClassName} p-5`}>
              <div className="mb-4 flex items-start gap-3">
                <span className="flex h-11 w-11 items-center justify-center rounded-none bg-[#FFF7ED] text-[#EA580C]">
                  <Camera className="h-5 w-5" />
                </span>
                <div>
                  <p className="text-xs font-black uppercase tracking-[0.16em] text-[#EA580C]">Evidence</p>
                  <h3 className="mt-1 text-lg font-black text-[#0F172A]">Photo and attachments</h3>
                </div>
              </div>

              {request.carEvidenceImageUrl ? (
                <div className="overflow-hidden rounded-none border border-[#E2E8F0] bg-[#F8FAFC]">
                  {/* eslint-disable-next-line @next/next/no-img-element -- Private signed Supabase URLs are not configured for Next image optimization. */}
                  <img
                    alt={`Car evidence for outstation request ${request.id}`}
                    className="max-h-[420px] w-full object-contain"
                    src={request.carEvidenceImageUrl}
                  />
                </div>
              ) : (
                <div className="rounded-none border border-dashed border-[#CBD5E1] bg-[#F8FAFC] p-5 text-sm font-semibold text-[#64748B]">
                  No signed evidence photo is available for this request.
                </div>
              )}

              <div className="mt-4 grid gap-3">
                <Info
                  label="Evidence capture"
                  value={request.carEvidenceMetadata?.capturedAt ? formatEvidenceDateTime(request.carEvidenceMetadata.capturedAt) : "N/A"}
                />
                <Info
                  label="Evidence location"
                  value={request.carEvidenceMetadata?.capturedLocationLabel ?? "N/A"}
                />
                {request.carEvidenceImageUrl ? (
                  <a
                    className="inline-flex w-fit items-center gap-2 rounded-none bg-[#EA580C] px-4 py-2 text-xs font-black text-white hover:bg-[#C2410C]"
                    href={request.carEvidenceImageUrl}
                    rel="noreferrer"
                    target="_blank"
                  >
                    <ExternalLink className="h-4 w-4" />
                    Open image
                  </a>
                ) : null}
              </div>

              <div className="mt-5 rounded-none border border-[#E2E8F0] bg-[#F8FAFC]/85 p-4">
                <p className="text-[11px] font-black uppercase tracking-[0.16em] text-[#64748B]">Ticket attachments</p>
                {request.ticketAttachmentMetadata.length > 0 ? (
                  <div className="mt-3 space-y-2">
                    {request.ticketAttachmentMetadata.map((attachment) => (
                      <div className="flex items-center justify-between gap-3 rounded-none bg-white px-3 py-2 text-sm" key={attachment.path}>
                        <div className="min-w-0">
                          <p className="truncate font-bold text-[#0F172A]">{attachment.name}</p>
                          <p className="text-xs text-[#64748B]">{attachment.contentType} - {(attachment.size / 1024).toFixed(1)} KB</p>
                        </div>
                        <FileText className="h-4 w-4 shrink-0 text-[#EA580C]" />
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="mt-2 text-sm font-semibold text-[#64748B]">No ticket attachments were uploaded.</p>
                )}
              </div>
            </Card>

            <div className="space-y-5">
              <OutstationReviewMap request={request} />
              <TerritoryValidationPanel
                reason={request.territoryValidationReason}
                status={request.territoryValidationStatus}
              />
            </div>
          </div>

          <Card className={`${panelClassName} p-5`}>
            <div className="grid gap-4 lg:grid-cols-3">
              <div className="flex items-start gap-3">
                <CalendarDays className="mt-1 h-5 w-5 text-[#EA580C]" />
                <div>
                  <p className="text-xs font-black uppercase tracking-[0.16em] text-[#64748B]">Eligibility</p>
                  <p className="mt-1 text-sm font-semibold text-[#0F172A]">{request.eligibilityReason}</p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <Clock className="mt-1 h-5 w-5 text-[#EA580C]" />
                <div>
                  <p className="text-xs font-black uppercase tracking-[0.16em] text-[#64748B]">Approval reason</p>
                  <p className="mt-1 text-sm font-semibold text-[#0F172A]">{request.approvalReason}</p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <MapPinned className="mt-1 h-5 w-5 text-[#EA580C]" />
                <div>
                  <p className="text-xs font-black uppercase tracking-[0.16em] text-[#64748B]">Notes</p>
                  <p className="mt-1 whitespace-pre-wrap text-sm font-semibold text-[#0F172A]">{request.notes ?? "No notes"}</p>
                </div>
              </div>
            </div>
          </Card>
        </div>
        <div className="shrink-0 border-t border-[#E2E8F0] bg-white/98 px-5 py-4 backdrop-blur">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <p className="text-xs font-black uppercase tracking-[0.16em] text-[#64748B]">Admin decision</p>
              <p className="mt-1 text-sm font-semibold text-[#475569]">Approve, reject, or permanently delete this outstation expense.</p>
            </div>
            <RequestActionButtons
              actionError={actionError}
              actionMessage={actionMessage}
              acting={acting}
              onApprove={onApprove}
              onDelete={onDelete}
              onReject={onReject}
              request={request}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

export function OutstationRequestsAdmin({
  initialRequestId = null,
  requests,
  canManageManagerExpenses,
}: {
  initialRequestId?: number | null;
  requests: OutstationExpenseRequest[];
  canManageManagerExpenses: boolean;
}) {
  const initialSelectedId = requests.some((request) => request.id === initialRequestId)
    ? initialRequestId
    : requests[0]?.id ?? null;
  const [localRequests, setLocalRequests] = useState(requests);
  const searchParams = useSearchParams();
  const [search, setSearch] = useState("");
  const [eligibility, setEligibility] = useState("");
  const [role, setRole] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(initialSelectedId);
  const [detailRequestId, setDetailRequestId] = useState<number | null>(
    requests.some((request) => request.id === initialRequestId) ? initialRequestId : null,
  );
  const [acting, setActing] = useState<{ action: AdminAction; id: number } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [managerExpenseModal, setManagerExpenseModal] = useState<
    | { mode: "create"; targetHrId?: string; targetName?: string }
    | { mode: "edit"; request: OutstationExpenseRequest }
    | null
  >(
    canManageManagerExpenses && searchParams.get("action") === "create-manager-expense"
      ? { mode: "create" }
      : null,
  );

  useEffect(() => {
    if (detailRequestId === null) return;

    const previousBodyOverflow = document.body.style.overflow;
    const previousHtmlOverflow = document.documentElement.style.overflow;

    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previousBodyOverflow;
      document.documentElement.style.overflow = previousHtmlOverflow;
    };
  }, [detailRequestId]);

  const requestedRequestId = useMemo(() => parseRequestId(searchParams.get("requestId")), [searchParams]);
  const activeRequestedRequestId = useMemo(() => {
    if (requestedRequestId === null) return null;
    return localRequests.some((request) => request.id === requestedRequestId) ? requestedRequestId : null;
  }, [localRequests, requestedRequestId]);

  useEffect(() => {
    if (activeRequestedRequestId === null) return;

    startTransition(() => {
      setSelectedId(activeRequestedRequestId);
      setDetailRequestId(activeRequestedRequestId);
    });
  }, [activeRequestedRequestId]);

  const roles = useMemo(
    () => [...new Set(localRequests.map((request) => request.employeeRole).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    [localRequests],
  );

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return localRequests.filter((request) => {
      const matchesSearch =
        !term ||
        request.employeeName.toLowerCase().includes(term) ||
        request.employeeHrId.toLowerCase().includes(term) ||
        (request.residenceCity ?? "").toLowerCase().includes(term) ||
        (request.residenceArea ?? "").toLowerCase().includes(term) ||
        (request.toLabel ?? "").toLowerCase().includes(term) ||
        (request.toCity ?? "").toLowerCase().includes(term) ||
        (request.toArea ?? "").toLowerCase().includes(term);

      return (
        matchesSearch &&
        (!eligibility || request.eligibilityStatus === eligibility) &&
        (!role || request.employeeRole === role)
      );
    });
  }, [eligibility, localRequests, role, search]);

  const selectedRequest =
    filtered.find((request) => request.id === selectedId) ??
    localRequests.find((request) => request.id === selectedId) ??
    filtered[0] ??
    null;
  const detailRequest =
    localRequests.find((request) => request.id === detailRequestId) ??
    filtered.find((request) => request.id === detailRequestId) ??
    null;

  const totals = useMemo(() => {
    return filtered.reduce(
      (accumulator, request) => {
        accumulator.approved += request.status === "approved" ? 1 : 0;
        accumulator.claimed += request.claimedTotalAmount;
        accumulator.expected += request.expectedTotalAmount;
        accumulator.rejected += request.status === "rejected" ? 1 : 0;
        accumulator.submitted += request.status === "submitted" ? 1 : 0;
        accumulator.variance += request.varianceAmount;
        return accumulator;
      },
      { approved: 0, claimed: 0, expected: 0, rejected: 0, submitted: 0, variance: 0 },
    );
  }, [filtered]);

  function clearFilters() {
    setSearch("");
    setEligibility("");
    setRole("");
  }

  function selectRequest(request: OutstationExpenseRequest) {
    setSelectedId(request.id);
  }

  function openDetails(request: OutstationExpenseRequest) {
    setSelectedId(request.id);
    setDetailRequestId(request.id);
    setActionError(null);
    setActionMessage(null);
  }

  function updateRequestInState(updated: OutstationExpenseRequest) {
    setLocalRequests((current) =>
      current.map((request) => request.id === updated.id ? updated : request),
    );
  }

  function handleManagerExpenseSaved(saved: OutstationExpenseRequest) {
    setManagerExpenseModal(null);
    const exists = localRequests.some((request) => request.id === saved.id);
    if (exists) {
      updateRequestInState(saved);
    } else {
      setLocalRequests((current) => [saved, ...current]);
    }
    setActionMessage(
      managerExpenseModal?.mode === "edit"
        ? `Manager expense #${saved.id} updated.`
        : `Manager expense #${saved.id} created for ${saved.employeeName}.`,
    );
  }

  async function approveRequest(selectedRequest: OutstationExpenseRequest) {
    setActing({ action: "approve", id: selectedRequest.id });
    setActionError(null);
    setActionMessage(null);
    try {
      const response = await fetch(`/api/admin/outstation/${selectedRequest.id}`, {
        body: JSON.stringify({ comment: "Approved from admin outstation review." }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json().catch(() => null) as ActionPayload | null;
      if (!response.ok || !payload?.request) {
        throw new Error(payload?.message ?? "Unable to approve outstation request.");
      }
      updateRequestInState(payload.request);
      setActionMessage(payload.message ?? "Outstation request approved for payroll.");
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Unable to approve outstation request.");
    } finally {
      setActing(null);
    }
  }

  async function rejectRequest(request: OutstationExpenseRequest) {
    const comment = window.prompt("Rejection reason");
    if (comment === null) return;
    if (!comment.trim()) {
      setActionError("A rejection reason is required.");
      return;
    }

    setActing({ action: "reject", id: request.id });
    setActionError(null);
    setActionMessage(null);
    try {
      const response = await fetch(`/api/admin/outstation/${request.id}`, {
        body: JSON.stringify({ comment }),
        headers: { "Content-Type": "application/json" },
        method: "PATCH",
      });
      const payload = await response.json().catch(() => null) as ActionPayload | null;
      if (!response.ok || !payload?.request) {
        throw new Error(payload?.message ?? "Unable to reject outstation request.");
      }
      updateRequestInState(payload.request);
      setActionMessage(payload.message ?? "Outstation request rejected.");
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Unable to reject outstation request.");
    } finally {
      setActing(null);
    }
  }

  async function deleteRequest(request: OutstationExpenseRequest) {
    const confirmed = window.confirm(
      `Delete outstation request ${request.id}? This permanently removes the request, stored evidence files, and any linked payroll expense row.`,
    );
    if (!confirmed) return;

    setActing({ action: "delete", id: request.id });
    setActionError(null);
    setActionMessage(null);
    try {
      const response = await fetch(`/api/admin/outstation/${request.id}`, { method: "DELETE" });
      const payload = await response.json().catch(() => null) as ActionPayload | null;
      if (!response.ok) {
        throw new Error(payload?.message ?? "Unable to delete outstation request.");
      }

      const remaining = localRequests.filter((candidate) => candidate.id !== request.id);
      setLocalRequests(remaining);
      if (selectedId === request.id) setSelectedId(remaining[0]?.id ?? null);
      if (detailRequestId === request.id) setDetailRequestId(null);
      const payrollNote = payload?.linkedPayroll?.deletedRows
        ? ` Linked payroll row ${payload.linkedPayroll.expenseTripId ?? ""} was also removed.`
        : "";
      setActionMessage(`${payload?.message ?? "Outstation request deleted."}${payrollNote}`);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Unable to delete outstation request.");
    } finally {
      setActing(null);
    }
  }

  async function createManagerExpense(request: OutstationExpenseRequest) {
    setManagerExpenseModal({
      mode: "create",
      targetHrId: request.employeeHrId,
      targetName: request.employeeName,
    });
  }

  async function deleteManagerExpense(request: OutstationExpenseRequest) {
    const confirmed = window.confirm(
      `Delete admin-created manager expense ${request.id}? This permanently removes only the manager-expense record.`,
    );
    if (!confirmed) return;

    setActing({ action: "delete", id: request.id });
    setActionError(null);
    setActionMessage(null);
    try {
      const response = await fetch(`/api/admin/outstation/manager-expenses/${request.id}`, {
        method: "DELETE",
      });
      const payload = await response.json().catch(() => null) as ActionPayload | null;
      if (!response.ok) {
        throw new Error(payload?.message ?? "Unable to delete manager expense.");
      }

      const remaining = localRequests.filter((candidate) => candidate.id !== request.id);
      setLocalRequests(remaining);
      if (selectedId === request.id) setSelectedId(remaining[0]?.id ?? null);
      if (detailRequestId === request.id) setDetailRequestId(null);
      setActionMessage(payload?.message ?? "Manager expense deleted.");
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Unable to delete manager expense.");
    } finally {
      setActing(null);
    }
  }

  const hasActiveFilters = Boolean(search || eligibility || role);

  if (localRequests.length === 0) {
    return (
      <OutstationAdminShell>
        <SharpPageHero
          description="No residence-validated outstation request data is currently available. You can still create a manager expense manually."
          eyebrow="Outstation requests"
          icon={<ShieldAlert className="h-3.5 w-3.5" />}
          title="Residence-validated expense review"
          actions={(
            canManageManagerExpenses ? (
              <Button
                className="gap-2 rounded-none bg-[#EA580C] px-4 py-2 text-xs font-black text-white hover:bg-[#C2410C]"
                onClick={() => setManagerExpenseModal({ mode: "create" })}
                type="button"
              >
                <PlusCircle className="h-4 w-4" />
                Create manager expense
              </Button>
            ) : null
          )}
        />
        <AdminCallout tone="neutral">
          <ShieldAlert className="mt-0.5 h-5 w-5 text-[#EA580C]" />
          <p className="font-semibold text-[#334155]">No requests were returned from the data source.</p>
        </AdminCallout>
        {managerExpenseModal ? (
          managerExpenseModal.mode === "create" ? (
            <AdminManagerExpenseModal
              mode="create"
              onClose={() => setManagerExpenseModal(null)}
              onSaved={handleManagerExpenseSaved}
              targetHrId={managerExpenseModal.targetHrId}
              targetName={managerExpenseModal.targetName}
            />
          ) : (
            <AdminManagerExpenseModal
              mode="edit"
              onClose={() => setManagerExpenseModal(null)}
              onSaved={handleManagerExpenseSaved}
              request={managerExpenseModal.request}
            />
          )
        ) : null}
      </OutstationAdminShell>
    );
  }

  return (
    <OutstationAdminShell>
      <div className="space-y-6">
        <SharpPageHero
          description="A command-center view for captured distance, eligibility, expected payout, claimed amount, route evidence, and final admin decisions."
          eyebrow="Outstation review"
          icon={<ShieldAlert className="h-3.5 w-3.5" />}
          title="Residence-validated expense requests"
          actions={(
            canManageManagerExpenses ? (
              <Button
                className="gap-2 rounded-none bg-[#EA580C] px-4 py-2.5 text-xs font-black text-white shadow-[0_14px_34px_rgba(234,88,12,0.28)] hover:bg-[#C2410C]"
                onClick={() => setManagerExpenseModal({ mode: "create" })}
                type="button"
              >
                <PlusCircle className="h-4 w-4" />
                Create manager expense
              </Button>
            ) : null
          )}
          badges={(
            <div className="flex flex-wrap gap-2 text-xs">
              <span className="border border-[#FED7AA] bg-[#FFF7ED] px-3 py-2 font-black text-[#EA580C] shadow-sm">Requests: {filtered.length}</span>
              <span className="border border-[#DDE6F1] bg-white/90 px-3 py-2 font-black text-[#475569] shadow-sm">Expected: {formatCurrency(totals.expected)}</span>
              <span className="border border-[#DDE6F1] bg-white/90 px-3 py-2 font-black text-[#475569] shadow-sm">Claimed: {formatCurrency(totals.claimed)}</span>
              <span className="border border-[#A7F3D0] bg-[#ECFDF5] px-3 py-2 font-black text-[#047857] shadow-sm">Approved: {totals.approved}</span>
            </div>
          )}
        />

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
          <Metric label="Requests" tone="orange" value={String(filtered.length)} />
          <Metric label="Submitted" tone="blue" value={String(totals.submitted)} />
          <Metric label="Approved" tone="green" value={String(totals.approved)} />
          <Metric label="Rejected" tone="red" value={String(totals.rejected)} />
          <Metric label="Expected" value={formatCurrency(totals.expected)} />
          <Metric label="Claimed" tone="orange" value={formatCurrency(totals.claimed)} />
        </div>

        <SharpTableShell
          action={hasActiveFilters ? (
            <button
              className="inline-flex rounded-none border border-[#FED7AA] bg-[#FFF7ED] px-3 py-2 text-xs font-black text-[#EA580C] shadow-sm transition hover:border-[#F97316] hover:bg-[#FFEDD5]"
              onClick={clearFilters}
              type="button"
            >
              Clear filters
            </button>
          ) : null}
          description="Quickly narrow the queue without losing the premium page rhythm."
          title="Smart filters"
        >
          <div className="grid gap-4 bg-[linear-gradient(135deg,rgba(255,247,237,0.72),rgba(255,255,255,0.92)_42%,rgba(248,250,252,0.92))] p-4 sm:p-5 md:grid-cols-2 xl:grid-cols-3">
            <label className="block">
              <span className="mb-1.5 block text-[10px] font-black uppercase tracking-[0.18em] text-[#64748B]">Search</span>
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#94A3B8]" />
                <Input
                  className="h-12 rounded-none border-[#DDE6F1] bg-white/95 pl-9 font-semibold shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_10px_22px_rgba(15,23,42,0.04)] focus-visible:ring-[#FED7AA]"
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Employee, HR ID, area, city"
                  value={search}
                />
              </div>
            </label>

            <label className="block">
              <span className="mb-1.5 block text-[10px] font-black uppercase tracking-[0.18em] text-[#64748B]">Eligibility</span>
              <select
                className="h-12 w-full rounded-none border border-[#DDE6F1] bg-white/95 px-3 text-sm font-semibold text-[#0F172A] shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_10px_22px_rgba(15,23,42,0.04)] focus:outline-none focus:ring-2 focus:ring-[#FED7AA]"
                onChange={(event) => setEligibility(event.target.value)}
                value={eligibility}
              >
                <option value="">All</option>
                <option value="eligible">Eligible</option>
                <option value="not_eligible">Not Eligible</option>
                <option value="needs_review">Needs Review</option>
              </select>
            </label>

            <label className="block">
              <span className="mb-1.5 block text-[10px] font-black uppercase tracking-[0.18em] text-[#64748B]">Role</span>
              <select
                className="h-12 w-full rounded-none border border-[#DDE6F1] bg-white/95 px-3 text-sm font-semibold text-[#0F172A] shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_10px_22px_rgba(15,23,42,0.04)] focus:outline-none focus:ring-2 focus:ring-[#FED7AA]"
                onChange={(event) => setRole(event.target.value)}
                value={role}
              >
                <option value="">All</option>
                {roles.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </SharpTableShell>

        <Card className={`${panelClassName} overflow-hidden p-0`}>
            <div className="relative overflow-hidden border-b border-[#1F2937]/80 bg-[radial-gradient(circle_at_top_right,rgba(249,115,22,0.28),transparent_34%),radial-gradient(circle_at_12%_10%,rgba(255,255,255,0.10),transparent_24%),linear-gradient(135deg,#070A0F_0%,#111827_58%,#2A170B_100%)] px-5 py-5 text-white sm:px-6">
              <div
                aria-hidden="true"
                className="pointer-events-none absolute -right-16 -top-20 h-44 w-44 rotate-12 bg-[#F97316]/20 blur-3xl"
              />
              <div
                aria-hidden="true"
                className="pointer-events-none absolute -bottom-20 left-10 h-36 w-36 -rotate-12 bg-white/10 blur-3xl"
              />
              <div className="relative z-10 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                <div className="space-y-1.5">
                  <p className="inline-flex border border-[#F97316]/35 bg-[#F97316]/12 px-3 py-1 text-xs font-black uppercase tracking-[0.16em] text-[#FDBA74] shadow-[inset_0_1px_0_rgba(255,255,255,0.16)]">Request queue</p>
                  <h2 className="text-2xl font-black text-white">Submitted outstation requests</h2>
                  <p className="max-w-2xl text-sm leading-6 text-[#CBD5E1]">Open any row to inspect evidence, route metrics, location validation, and admin decisions in one clean review flow.</p>
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs sm:flex">
                  <span className="border border-white/10 bg-white/10 px-3 py-2 font-black text-white backdrop-blur">Visible {filtered.length}</span>
                  <span className="border border-[#F97316]/25 bg-[#F97316]/15 px-3 py-2 font-black text-[#FDBA74] backdrop-blur">Selected #{selectedRequest?.id ?? "N/A"}</span>
                </div>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full min-w-[1240px] border-separate border-spacing-0 text-left text-sm">
                <thead className="bg-[#F8FAFC] text-[11px] uppercase tracking-[0.16em] text-[#64748B]">
                  <tr>
                    <th className={stickyEmployeeHeaderClassName}>Employee</th>
                    <th className={stickyTripHeaderClassName}>Trip</th>
                    <th className={adminTableHeaderClassName}>Distance</th>
                    <th className={adminTableHeaderClassName}>Eligibility</th>
                    <th className={adminTableHeaderClassName}>Status</th>
                    <th className={adminTableHeaderClassName}>Expected</th>
                    <th className={adminTableHeaderClassName}>Claimed</th>
                    <th className={adminTableHeaderClassName}>Variance</th>
                    <th className={adminTableHeaderClassName}>Recommendation</th>
                    <th className={adminTableHeaderClassName}>Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#E2E8F0] bg-white">
                  {filtered.map((request) => {
                    const selected = request.id === selectedRequest?.id;
                    const stickyCellBg = selected ? "bg-[#FFF7ED]" : "bg-white group-hover:bg-[#FFF7ED]/65";
                    return (
                      <tr
                        className={`group cursor-pointer ${selected ? "bg-[#FFF7ED] ring-1 ring-inset ring-[#FDBA74]/60" : "transition-colors hover:bg-[#FFF7ED]/65"}`}
                        key={request.id}
                        onClick={() => selectRequest(request)}
                      >
                        <td className={`${stickyEmployeeCellClassName} ${stickyCellBg}`}>
                          <div className="font-black text-[#0F172A]">{formatEmployeeDisplayName(request.employeeName)}</div>
                          <div className="text-xs text-[#64748B]">{`${request.employeeHrId} - ${request.employeeRole}`}</div>
                        </td>
                        <td className={`${stickyTripCellClassName} ${stickyCellBg} text-[#64748B]`}>
                          {formatDate(request.tripStartDate)} to {formatDate(request.tripEndDate)}
                        </td>
                        <td className="px-4 py-3 font-semibold text-[#0F172A]">
                          {formatKm(request.distanceFromResidenceKm)}
                        </td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex rounded-none px-3 py-1 text-xs font-bold ring-1 ${statusTone(request.eligibilityStatus)}`}>
                            {formatStatus(request.eligibilityStatus)}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex rounded-none px-3 py-1 text-xs font-bold ring-1 ${requestStatusTone(request.status)}`}>
                            {formatStatus(request.status)}
                          </span>
                        </td>
                        <td className="px-4 py-3 font-semibold text-[#64748B]">
                          {formatCurrency(request.expectedTotalAmount)}
                        </td>
                        <td className="px-4 py-3 font-semibold text-[#64748B]">
                          {formatCurrency(request.claimedTotalAmount)}
                        </td>
                        <td className="px-4 py-3 font-semibold text-[#64748B]">
                          {formatCurrency(request.varianceAmount)} ({request.variancePercent.toFixed(1)}%)
                        </td>
                        <td className={`px-4 py-3 text-[11px] font-black uppercase tracking-[0.14em] ${recommendationTone(request.approvalRecommendation)}`}>
                          {formatStatus(request.approvalRecommendation)}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1.5">
                            <Button
                              className="gap-1.5 rounded-none border border-[#DDE6F1] bg-white px-3 py-2 text-xs font-black text-[#0F172A] hover:bg-[#FFF7ED]"
                              onClick={(event) => {
                                event.stopPropagation();
                                openDetails(request);
                              }}
                              type="button"
                            >
                              <Eye className="h-3.5 w-3.5" />
                              View
                            </Button>
                            {canManageManagerExpenses ? (
                              request.capturedLocationSource === "admin_manager_expense" ||
                              request.capturedLocationSource === "admin_manager_expense_edit" ? (
                                <>
                                  <Button
                                    className="gap-1.5 rounded-none border border-[#FED7AA] bg-[#FFF7ED] px-3 py-2 text-xs font-black text-[#EA580C] hover:bg-[#FFEDD5]"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      setManagerExpenseModal({ mode: "edit", request });
                                    }}
                                    title="Edit manager expense destination and recalculate distance"
                                    type="button"
                                  >
                                    <Edit2 className="h-3.5 w-3.5" />
                                    Edit
                                  </Button>
                                  <Button
                                    className="gap-1.5 rounded-none border border-[#FECACA] bg-[#FEF2F2] px-3 py-2 text-xs font-black text-[#B91C1C] hover:bg-[#FEE2E2]"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      void deleteManagerExpense(request);
                                    }}
                                    title="Delete manager expense"
                                    type="button"
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                    Delete
                                  </Button>
                                </>
                              ) : (
                                <Button
                                  className="gap-1.5 rounded-none border border-[#FCA5A5] bg-[#FFF1F2] px-3 py-2 text-xs font-black text-[#B91C1C] hover:bg-[#FECDD3]"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    void createManagerExpense(request);
                                  }}
                                  title="Create manager expense from this employee row"
                                  type="button"
                                >
                                  <PlusCircle className="h-3.5 w-3.5" />
                                  Create
                                </Button>
                              )
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
        </Card>
      </div>

      {actionMessage && !acting ? (
        <div className="fixed bottom-4 right-4 z-40 max-w-md rounded-none border border-[#A7F3D0] bg-[#ECFDF5] px-4 py-3 text-sm font-semibold text-[#047857] shadow-xl">
          {actionMessage}
        </div>
      ) : null}
      {actionError && !acting ? (
        <div className="fixed bottom-4 right-4 z-40 max-w-md rounded-none border border-[#FECACA] bg-[#FEF2F2] px-4 py-3 text-sm font-semibold text-[#B91C1C] shadow-xl">
          {actionError}
        </div>
      ) : null}
      {detailRequest ? (
        <RequestDetailsModal
          actionError={actionError}
          actionMessage={actionMessage}
          acting={acting}
          onApprove={(request) => void approveRequest(request)}
          onClose={() => setDetailRequestId(null)}
          onDelete={(request) => void deleteRequest(request)}
          onReject={(request) => void rejectRequest(request)}
          request={detailRequest}
        />
      ) : null}

      {managerExpenseModal ? (
        managerExpenseModal.mode === "create" ? (
          <AdminManagerExpenseModal
            mode="create"
            onClose={() => setManagerExpenseModal(null)}
            onSaved={handleManagerExpenseSaved}
            targetHrId={managerExpenseModal.targetHrId}
            targetName={managerExpenseModal.targetName}
          />
        ) : (
          <AdminManagerExpenseModal
            mode="edit"
            onClose={() => setManagerExpenseModal(null)}
            onSaved={handleManagerExpenseSaved}
            request={managerExpenseModal.request}
          />
        )
      ) : null}
    </OutstationAdminShell>
  );
}
